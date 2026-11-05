import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { replayTimelineItem, toolDetail } from "./timeline.ts";
import {
  applyNativeLogLine, beginBusinessTurn, beginCompact, byStep, emptyCompactionState,
  finishCompact, parseCompactionState, validCompactionState,
  type CompactionState, type NativeObservation,
} from "./compaction.ts";
import { isRecord } from "./wire.ts";

export type StoredTimelineRecord = {
  id: string;
  item: ProviderTimelineItem;
  seq: number;
  timestamp: string;
};

export type ConversationSnapshot = {
  conversationId: string;
  items: StoredTimelineRecord[];
  updatedAt: string;
  version: 1;
};

export type StoreFsOps = {
  appendFileSync: typeof appendFileSync;
  closeSync: typeof closeSync;
  copyFileSync: typeof copyFileSync;
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  readFileSync: typeof readFileSync;
  readSync: typeof readSync;
  renameSync: typeof renameSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

export const DEFAULT_FS_OPS: StoreFsOps = {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
};

/** Bytes compared at the file head and just before the read offset to detect
 * a transcript that was replaced or rewritten rather than appended to. */
const TRANSCRIPT_FINGERPRINT_BYTES = 256;
const TRANSCRIPT_READ_CHUNK_BYTES = 1 << 20;
const NO_OBSERVATIONS: readonly NativeObservation[] = Object.freeze([]);

/** Incremental view of one append-only native `transcript.jsonl`. */
type TranscriptCursor = {
  file: string;
  ino: number;
  size: number;
  mtimeMs: number;
  /** End of the last complete (newline-terminated) line consumed. */
  offset: number;
  head: Buffer;
  anchor: Buffer;
  steps: Map<number, NativeObservation>;
  snapshot: readonly NativeObservation[];
};

export const DEFAULT_MAX_JOURNAL_ENTRIES_BEFORE_COMPACT = 128;

export type ConversationStoreOptions = {
  brainDir?: string;
  fsOps?: Partial<StoreFsOps>;
  maxJournalEntriesBeforeCompact?: number;
  storeDir?: string;
};

let tempFileCounter = 0;

export function defaultStoreDir(): string {
  const legacyDir = path.join(
    homedir(),
    ".paseo",
    "antigravity-resilient",
    "conversations",
  );
  const envHome = process.env.PASEO_HOME?.trim();
  if (!envHome) {
    return legacyDir;
  }
  const envDir = path.join(envHome, "antigravity-resilient", "conversations");
  if (path.resolve(envDir) === path.resolve(legacyDir)) {
    return legacyDir;
  }
  if (!existsSync(envDir) && existsSync(legacyDir)) {
    return legacyDir;
  }
  return envDir;
}

export function defaultBrainDir(): string {
  return path.join(homedir(), ".gemini", "antigravity-cli", "brain");
}

export function safeConversationKey(conversationId: string): string {
  const trimmed = conversationId.trim();
  if (/^[A-Za-z0-9._-]{1,120}$/.test(trimmed) && !trimmed.includes("..")) {
    return trimmed;
  }
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
  const prefix = trimmed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "conv";
  return `${prefix}-${digest}`;
}

export function sanitizeString(value: string): string {
  return value
    .replace(/ya29\.[A-Za-z0-9._-]{16,}/g, "<REDACTED_OAUTH_TOKEN>")
    .replace(/1\/\/[A-Za-z0-9._-]{16,}/g, "<REDACTED_REFRESH_TOKEN>")
    .replace(/AIza[A-Za-z0-9._-]{16,}/g, "<REDACTED_API_KEY>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, "$1<REDACTED_BEARER>");
}

export function sanitizeValue<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry)) as unknown as T;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(env|credentials|accessToken|refreshToken|apiKey|password|secret)$/i.test(k)) {
        continue;
      }
      out[k] = sanitizeValue(v);
    }
    return out as unknown as T;
  }
  return value;
}

export function sanitizeTimelineItem(
  item: ProviderTimelineItem,
): ProviderTimelineItem {
  return sanitizeValue(JSON.parse(JSON.stringify(item)) as ProviderTimelineItem);
}

function isValidTimelineItem(value: unknown): value is ProviderTimelineItem {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.type === "string" &&
    value.type.length > 0
  );
}

function isValidRecord(value: unknown): value is StoredTimelineRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.seq === "number" &&
    Number.isFinite(value.seq) &&
    typeof value.timestamp === "string" &&
    isValidTimelineItem(value.item)
  );
}

type StepOrderKey = {
  turnIndex: number;
  stepIndex: number;
  subOrder: number;
};

function extractStepOrderKey(record: StoredTimelineRecord): StepOrderKey | null {
  const match =
    /^turn-(\d+):(?:step:(\d+)(:reasoning)?|auto-compact:(\d+)|(reasoning|message):step-(\d+))$/.exec(
      record.id,
    );
  if (!match) {
    return null;
  }
  const turnIndex = Number.parseInt(match[1]!, 10);
  const stepRaw = match[2] ?? match[4] ?? match[6];
  if (!stepRaw) {
    return null;
  }
  const stepIndex = Number.parseInt(stepRaw, 10);
  if (!Number.isSafeInteger(turnIndex) || !Number.isSafeInteger(stepIndex)) {
    return null;
  }
  const isReasoning =
    Boolean(match[3]) ||
    match[5] === "reasoning" ||
    record.item.type === "reasoning";
  return {
    turnIndex,
    stepIndex,
    subOrder: isReasoning ? 0 : 1,
  };
}

/**
 * Normalizes `seq` ordering across native step-indexed items within each turn
 * so `turn-T:step:S:reasoning` always precedes `turn-T:step:S` and `turn-T:step:S+1`
 * even when stdout `step_update` frames and `transcript.jsonl` reasoning flushes
 * arrive out of order.
 */
function normalizeTimelineStepOrder(
  map: Map<string, StoredTimelineRecord>,
): boolean {
  if (map.size <= 1) {
    return false;
  }
  const bySeq = [...map.values()].sort((a, b) => a.seq - b.seq);
  const groups = new Map<
    number,
    Array<{ record: StoredTimelineRecord; key: StepOrderKey; origSeq: number }>
  >();

  for (const record of bySeq) {
    const key = extractStepOrderKey(record);
    if (!key) {
      continue;
    }
    let group = groups.get(key.turnIndex);
    if (!group) {
      group = [];
      groups.set(key.turnIndex, group);
    }
    group.push({ record, key, origSeq: record.seq });
  }

  let changed = false;
  for (const group of groups.values()) {
    if (group.length <= 1) {
      continue;
    }
    const seqSlots = group.map((entry) => entry.origSeq).sort((a, b) => a - b);
    const sorted = [...group].sort((a, b) => {
      if (a.key.stepIndex !== b.key.stepIndex) {
        return a.key.stepIndex - b.key.stepIndex;
      }
      if (a.key.subOrder !== b.key.subOrder) {
        return a.key.subOrder - b.key.subOrder;
      }
      return a.origSeq - b.origSeq;
    });
    for (let i = 0; i < sorted.length; i++) {
      const targetSeq = seqSlots[i]!;
      const entry = sorted[i]!;
      if (entry.record.seq !== targetSeq) {
        const updated: StoredTimelineRecord = {
          ...entry.record,
          seq: targetSeq,
        };
        map.set(updated.id, updated);
        changed = true;
      }
    }
  }
  return changed;
}

function extractUserRequestText(raw: string): string {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  if (match && match[1]?.trim()) {
    return match[1].trim();
  }
  return raw.trim();
}

export type NativeTurnToolCall = {
  stepIndex: number;
  callId?: string;
  name: string;
  args: unknown;
  output?: string;
  status: "completed" | "failed";
  timestamp?: string;
};

export type NativeTurnPlannerStep = {
  stepIndex: number;
  timestamp?: string;
  thinking?: string;
  content?: string;
  toolCalls: NativeTurnToolCall[];
};

export type NativeSingleStep = {
  stepIndex: number;
  timestamp?: string;
  thinking?: string;
  content?: string;
};

export function matchesNativeFinalContent(
  response: string,
  finalContent: string,
): boolean {
  const trimmedResponse = response.trim();
  const trimmedFinal = finalContent.trim();
  if (!trimmedResponse || !trimmedFinal) {
    return false;
  }
  if (trimmedResponse.endsWith(trimmedFinal)) {
    return true;
  }
  // In `agy`, an unclosed literal `<thought>` tag in markdown causes the stdout
  // filter to strip from the chunk containing `<thought` to the end of the
  // streamed text and `result.response`, while `transcript_full.jsonl` records
  // the complete `content`.
  let searchFrom = 0;
  while (searchFrom < trimmedFinal.length) {
    const idx = trimmedFinal.indexOf("<thought", searchFrom);
    if (idx === -1) break;
    if (idx >= 8) {
      const minCut = Math.max(1, idx - 2);
      const maxCut = Math.min(trimmedFinal.length, idx + "<thought>".length);
      for (let cut = minCut; cut <= maxCut; cut++) {
        const prefix = trimmedFinal.slice(0, cut).trimEnd();
        if (prefix.length >= 8 && trimmedResponse.endsWith(prefix)) {
          return true;
        }
      }
    }
    searchFrom = idx + 8;
  }
  return false;
}

export function parseNativeTranscript(
  transcriptPath: string,
): StoredTimelineRecord[] {
  const candidateFull =
    path.basename(transcriptPath) === "transcript.jsonl"
      ? path.join(path.dirname(transcriptPath), "transcript_full.jsonl")
      : transcriptPath;
  const resolvedPath = existsSync(candidateFull) ? candidateFull : transcriptPath;
  if (!existsSync(resolvedPath)) {
    return [];
  }
  let raw = "";
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch {
    return [];
  }

  const parsedSteps: Record<string, unknown>[] = [];
  const genericByStep = new Map<
    number,
    { content?: string; status?: string; timestamp?: string }
  >();
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        continue;
      }
      parsedSteps.push(parsed);
      if (
        parsed.type === "GENERIC" &&
        typeof parsed.step_index === "number" &&
        Number.isSafeInteger(parsed.step_index)
      ) {
        genericByStep.set(parsed.step_index, {
          content: typeof parsed.content === "string" ? parsed.content : undefined,
          status: typeof parsed.status === "string" ? parsed.status : undefined,
          timestamp:
            typeof parsed.created_at === "string" ? parsed.created_at : undefined,
        });
      }
    } catch {
      continue;
    }
  }

  const records: StoredTimelineRecord[] = [];
  let seq = 0;
  let turnNumber = 0;

  for (const step of parsedSteps) {
    const stepIndex =
      typeof step.step_index === "number" ? step.step_index : seq;
    const timestamp =
      typeof step.created_at === "string" && step.created_at
        ? step.created_at
        : new Date(0).toISOString();
    const stepType = typeof step.type === "string" ? step.type : "";

    if (stepType === "USER_INPUT" && typeof step.content === "string") {
      const text = extractUserRequestText(step.content);
      if (!text) {
        continue;
      }
      turnNumber += 1;
      const id = `user:turn-${turnNumber}:step-${stepIndex}`;
      records.push({
        id,
        seq: ++seq,
        timestamp,
        item: sanitizeTimelineItem({
          id,
          type: "user_message",
          text,
        }),
      });
      continue;
    }

    if (stepType === "PLANNER_RESPONSE" || stepType === "AGENT_RESPONSE") {
      if (turnNumber === 0) {
        turnNumber = 1;
      }
      if (typeof step.thinking === "string" && step.thinking.trim()) {
        const id = `turn-${turnNumber}:reasoning:step-${stepIndex}`;
        records.push({
          id,
          seq: ++seq,
          timestamp,
          item: sanitizeTimelineItem({
            id,
            type: "reasoning",
            text: step.thinking,
          }),
        });
      }
      if (Array.isArray(step.tool_calls)) {
        for (let idx = 0; idx < step.tool_calls.length; idx++) {
          const tc = step.tool_calls[idx];
          if (!isRecord(tc)) {
            continue;
          }
          const name = typeof tc.name === "string" && tc.name ? tc.name : "tool";
          const toolStep = stepIndex + 1 + idx;
          const generic = genericByStep.get(toolStep);
          const callId =
            typeof tc.id === "string" && tc.id
              ? tc.id
              : `turn-${turnNumber}:tool:step-${stepIndex}-${idx + 1}`;
          const id = `tool:${callId}`;
          const failed = generic?.status === "ERROR";
          records.push({
            id,
            seq: ++seq,
            timestamp: generic?.timestamp ?? timestamp,
            item: sanitizeTimelineItem(
              failed
                ? {
                    id,
                    type: "tool_call",
                    callId,
                    name,
                    status: "failed",
                    detail: toolDetail(name, tc.args ?? tc.arguments, generic?.content),
                    error: generic?.content || "Antigravity tool failed",
                  }
                : {
                    id,
                    type: "tool_call",
                    callId,
                    name,
                    status: "completed",
                    detail: toolDetail(name, tc.args ?? tc.arguments, generic?.content),
                    error: null,
                  },
            ),
          });
        }
      }
      if (typeof step.content === "string" && step.content.trim()) {
        const id = `turn-${turnNumber}:message:step-${stepIndex}`;
        records.push({
          id,
          seq: ++seq,
          timestamp,
          item: sanitizeTimelineItem({
            id,
            type: "assistant_message",
            text: step.content,
          }),
        });
      }
    }
  }

  return records;
}

export class ConversationStore {
  readonly storeDir: string;
  readonly brainDir: string;
  readonly maxJournalEntriesBeforeCompact: number;
  private readonly fsOps: StoreFsOps;
  private readonly cache = new Map<string, Map<string, StoredTimelineRecord>>();
  private readonly seqCounters = new Map<string, number>();
  private readonly uncompactedJournalCounts = new Map<string, number>();
  private readonly dirtyConversations = new Set<string>();
  private readonly sessionKeyBindings = new Map<string, string>();
  private readonly transcriptCursors = new Map<string, TranscriptCursor>();

  constructor(options: ConversationStoreOptions = {}) {
    this.storeDir = options.storeDir ?? defaultStoreDir();
    this.brainDir = options.brainDir ?? defaultBrainDir();
    this.maxJournalEntriesBeforeCompact =
      typeof options.maxJournalEntriesBeforeCompact === "number" &&
      options.maxJournalEntriesBeforeCompact > 0
        ? Math.floor(options.maxJournalEntriesBeforeCompact)
        : DEFAULT_MAX_JOURNAL_ENTRIES_BEFORE_COMPACT;
    this.fsOps = {
      ...DEFAULT_FS_OPS,
      ...options.fsOps,
    };
  }

  snapshotPath(conversationId: string): string {
    return path.join(this.storeDir, `${safeConversationKey(conversationId)}.json`);
  }

  backupPath(conversationId: string): string {
    return path.join(this.storeDir, `${safeConversationKey(conversationId)}.json.bak`);
  }

  journalPath(conversationId: string): string {
    return path.join(this.storeDir, `${safeConversationKey(conversationId)}.jsonl`);
  }

  compactionPath(conversationId: string): string {
    return path.join(this.storeDir, `${safeConversationKey(conversationId)}.compaction.json`);
  }

  loadCompaction(conversationId: string): CompactionState {
    const target = this.compactionPath(conversationId);
    for (const file of [target, `${target}.bak`]) {
      try {
        const value = parseCompactionState(JSON.parse(this.fsOps.readFileSync(file, "utf8")));
        if (value) return value;
      } catch { /* Missing legacy state or damaged primary: try verified backup. */ }
    }
    const state = emptyCompactionState();
    // Upgrade legacy timeline-only stores without rewriting any user messages.
    // Failures were not recorded by old builds and cannot be reconstructed.
    for (const record of this.load(conversationId)) {
      const item = replayTimelineItem(record.item);
      if (item.type === "user_message" && !/^\s*\/compact(?:\s|$)/i.test(item.text)) beginBusinessTurn(state);
      if (item.type !== "compaction" || item.status !== "completed") continue;
      const at = Date.parse(record.timestamp);
      const event = beginCompact(state, item.id, item.trigger === "auto" ? "idle" : "manual", Number.isFinite(at) ? at : 0);
      event.legacyCompletedAt = event.at;
      event.preTokens = typeof item.preTokens === "number" ? item.preTokens : null;
      finishCompact(state, item.id, true, event.at);
    }
    return state;
  }

  nativeTranscriptPath(conversationId: string): string {
    // Use the same safe key boundary as the store; never traverse outside brainDir.
    return path.join(this.brainDir, safeConversationKey(conversationId), ".system_generated", "logs", "transcript.jsonl");
  }

  nativeFullTranscriptPath(conversationId: string): string {
    return path.join(this.brainDir, safeConversationKey(conversationId), ".system_generated", "logs", "transcript_full.jsonl");
  }

  nativeConversationsDir(): string {
    return path.join(path.dirname(this.brainDir), "conversations");
  }

  /**
   * Returns false only when the native `conversations/` directory exists on
   * disk (real `agy` installation or explicit test fixture) and neither
   * `<conversationId>.db` nor `<conversationId>.pb` exists in it or in the
   * legacy `~/.gemini/antigravity/conversations` import directory.
   *
   * `agy` enforces a hard 500-conversation cap in `conversations/` and
   * deletes older `.db` files during startup summary reconciliation while
   * Paseo's durable timeline store (`~/.paseo/antigravity-resilient/conversations/`)
   * and `brain/<conversationId>/` still retain the full conversation history.
   */
  hasNativeConversationDb(conversationId: string): boolean {
    const key = safeConversationKey(conversationId);
    const brainConvDir = path.join(this.brainDir, key);
    const dir = this.nativeConversationsDir();
    if (!this.fsOps.existsSync(brainConvDir) || !this.fsOps.existsSync(dir)) {
      return true;
    }
    for (const ext of [".db", ".pb"]) {
      if (this.fsOps.existsSync(path.join(dir, `${key}${ext}`))) {
        return true;
      }
    }
    const fallbackDir = path.join(homedir(), ".gemini", "antigravity", "conversations");
    if (this.fsOps.existsSync(fallbackDir)) {
      for (const ext of [".db", ".pb"]) {
        if (this.fsOps.existsSync(path.join(fallbackDir, `${key}${ext}`))) {
          return true;
        }
      }
    }
    return false;
  }

  hasRecoverableHistory(conversationId: string, excludeItemId?: string): boolean {
    const records = this.load(conversationId).filter(
      (rec) => rec.id !== excludeItemId,
    );
    if (records.length > 0) {
      return true;
    }
    return (
      this.fsOps.existsSync(this.nativeFullTranscriptPath(conversationId)) ||
      this.fsOps.existsSync(this.nativeTranscriptPath(conversationId))
    );
  }

  buildRecoveryPreamble(
    conversationId: string,
    excludeItemId?: string,
  ): string | null {
    const records = this.load(conversationId).filter(
      (rec) => rec.id !== excludeItemId,
    );
    let latestCheckpointSummary = "";
    for (const file of [
      this.nativeFullTranscriptPath(conversationId),
      this.nativeTranscriptPath(conversationId),
    ]) {
      if (!this.fsOps.existsSync(file)) continue;
      try {
        const raw = this.fsOps.readFileSync(file, "utf8");
        for (const line of raw.split(/\r?\n/u)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            const parsed: unknown = JSON.parse(trimmed);
            if (
              isRecord(parsed) &&
              parsed.type === "CHECKPOINT" &&
              parsed.status === "DONE" &&
              typeof parsed.content === "string" &&
              parsed.content.trim()
            ) {
              latestCheckpointSummary = parsed.content.trim();
            }
          } catch {
            continue;
          }
        }
        if (latestCheckpointSummary) break;
      } catch {
        continue;
      }
    }

    const entries: string[] = [];
    for (const rec of records) {
      const item = rec.item;
      if (item.type === "user_message" && item.text.trim()) {
        entries.push(`[User]: ${item.text.trim()}`);
      } else if (item.type === "assistant_message" && item.text.trim()) {
        entries.push(`[Assistant]: ${item.text.trim()}`);
      } else if (item.type === "tool_call") {
        entries.push(`[Tool ${item.name}]: ${item.status}`);
      }
    }

    if (!latestCheckpointSummary && entries.length === 0) {
      return null;
    }

    const maxEntriesChars = 28_000;
    const selectedEntries: string[] = [];
    let usedChars = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      const cappedEntry =
        entry.length > 8_000 ? `${entry.slice(0, 8_000)}\n...[truncated]` : entry;
      if (usedChars + cappedEntry.length > maxEntriesChars && selectedEntries.length > 0) {
        break;
      }
      selectedEntries.unshift(cappedEntry);
      usedChars += cappedEntry.length + 2;
    }

    const sections: string[] = [
      "<CONVERSATION_HISTORY_RECOVERY>",
      `Antigravity CLI evicted the local SQLite state for prior conversation \`${conversationId}\`, so this session is continuing in a new CLI trajectory. Use the recovered conversation history below as your prior context and respond directly to the user's new request that follows.`,
    ];
    if (latestCheckpointSummary) {
      const cappedSummary =
        latestCheckpointSummary.length > 20_000
          ? `${latestCheckpointSummary.slice(0, 20_000)}\n...[truncated]`
          : latestCheckpointSummary;
      sections.push(`## Prior Checkpoint Summary\n${cappedSummary}`);
    }
    if (selectedEntries.length > 0) {
      sections.push(`## Recent Conversation Timeline\n${selectedEntries.join("\n\n")}`);
    }
    sections.push("</CONVERSATION_HISTORY_RECOVERY>");
    return sections.join("\n\n");
  }

  migrateConversation(
    fromConversationId: string,
    toConversationId: string,
    sessionKey?: string,
  ): void {
    const cleanFrom = fromConversationId.trim();
    const cleanTo = toConversationId.trim();
    if (!cleanFrom || !cleanTo || cleanFrom === cleanTo) {
      return;
    }
    const fromRecords = this.load(cleanFrom);
    const toMap = this.ensureLoaded(cleanTo);
    let maxSeq = this.seqCounters.get(cleanTo) ?? 0;
    for (const rec of fromRecords) {
      const existing = toMap.get(rec.id);
      const seq = existing ? existing.seq : rec.seq;
      if (seq > maxSeq) {
        maxSeq = seq;
      }
      toMap.set(rec.id, {
        id: rec.id,
        seq,
        timestamp: existing?.timestamp || rec.timestamp,
        item: sanitizeTimelineItem(rec.item),
      });
    }
    this.seqCounters.set(cleanTo, maxSeq);
    if (toMap.size > 0) {
      this.dirtyConversations.add(cleanTo);
      this.flush(cleanTo);
    }
    if (sessionKey) {
      this.bindSessionKey(sessionKey, cleanTo);
    }
  }

  /** Positive completion proof when stdout has no terminal response state.
   * Require a fresh request and the final, tool-free DONE in this conversation;
   * text length and an earlier completed model/tool step are not proof. */
  hasCompletedNativeResponse(
    conversationId: string,
    afterStep: number,
    response: string,
    responseStep?: number,
    lastStreamedStepIndex?: number,
  ): boolean {
    return (
      this.completedNativeResponseStep(
        conversationId,
        afterStep,
        response,
        responseStep,
        lastStreamedStepIndex,
      ) !== null
    );
  }

  completedNativeResponseStep(
    conversationId: string,
    afterStep: number,
    response: string,
    responseStep?: number,
    lastStreamedStepIndex?: number,
  ): number | null {
    const finalResponse = (file: string): Record<string, unknown> | null => {
      let fd: number | undefined;
      try {
        fd = this.fsOps.openSync(file, "r");
        const size = this.fsOps.statSync(file).size;
        if (size <= 0) return null;
        let windowBytes = 256 * 1024;
        while (true) {
          const start = Math.max(0, size - windowBytes);
          const raw = this.readRange(fd, start, size - start).toString("utf8");
          // A partial last row may be a new error or an unfinished request.
          if (!raw.endsWith("\n")) return null;
          const lines = raw.split(/\r?\n/u);
          if (start > 0) lines.shift();
          const rows = new Map<number, Record<string, unknown>>();
          let minStep = Infinity;
          for (const line of lines) {
            if (!line.trim()) continue;
            const row: unknown = JSON.parse(line);
            if (!isRecord(row) || typeof row.step_index !== "number" || !Number.isSafeInteger(row.step_index)) return null;
            if (row.step_index < minStep) minStep = row.step_index;
            if (row.step_index <= afterStep) continue;
            if ((row.conversation_id !== undefined && row.conversation_id !== conversationId) ||
                (row.conversationId !== undefined && row.conversationId !== conversationId)) return null;
            rows.set(row.step_index, row);
          }
          const ordered = [...rows.values()].sort((a, b) => Number(a.step_index) - Number(b.step_index));
          const last = ordered.at(-1);
          if (!last) {
            if (start > 0 && minStep === Infinity) {
              windowBytes *= 2;
              continue;
            }
            return null;
          }
          const lastStep = Number(last.step_index);
          const minRequiredStep = Math.max(responseStep ?? -1, lastStreamedStepIndex ?? -1);
          if (minRequiredStep !== -1 && lastStep < minRequiredStep) return null;
          if (
            responseStep !== undefined &&
            lastStep !== responseStep &&
            (lastStreamedStepIndex === undefined || lastStep <= lastStreamedStepIndex)
          ) {
            return null;
          }
          if (last.status !== "DONE" ||
              !["PLANNER_RESPONSE", "AGENT_RESPONSE"].includes(String(last.type)) ||
              typeof last.content !== "string" || !last.content.trim()) return null;
          if (last.tool_calls != null && (!Array.isArray(last.tool_calls) || last.tool_calls.length !== 0)) return null;
          if (!ordered.some(row => row.type === "USER_INPUT" && row.status === "DONE" &&
              Number(row.step_index) < lastStep)) {
            if (start > 0 && minStep > afterStep + 1) {
              windowBytes *= 2;
              continue;
            }
            return null;
          }
          return last;
        }
      } catch { return null; }
      finally { if (fd !== undefined) this.fsOps.closeSync(fd); }
    };
    const file = this.nativeTranscriptPath(conversationId);
    let final = finalResponse(file);
    if (!final) return null;
    if (Array.isArray(final.truncated_fields) && final.truncated_fields.includes("content")) {
      const full = finalResponse(path.join(path.dirname(file), "transcript_full.jsonl"));
      if (!full || full.step_index !== final.step_index ||
          (Array.isArray(full.truncated_fields) && full.truncated_fields.includes("content"))) return null;
      final = full;
    }
    return matchesNativeFinalContent(response, String(final.content))
      ? Number(final.step_index)
      : null;
  }

  /**
   * Reads completed `PLANNER_RESPONSE` / `AGENT_RESPONSE` steps and their
   * associated `GENERIC` tool outputs for the current turn (`step_index > afterStep`),
   * preferring `transcript_full.jsonl` over `transcript.jsonl` so `<thought>`-truncated
   * stdout messages, compact-truncated thoughts, and steps omitted when `agy`'s
   * stdout `stepTracker` stalls behind a `RUNNING` background tool are recovered.
   */
  readNativeTurnSteps(
    conversationId: string,
    afterStep: number,
  ): NativeTurnPlannerStep[] {
    const readTurnRows = (file: string): Map<number, Record<string, unknown>> | null => {
      let fd: number | undefined;
      try {
        if (!this.fsOps.existsSync(file)) return null;
        const size = this.fsOps.statSync(file).size;
        if (size <= 0) return null;
        fd = this.fsOps.openSync(file, "r");
        let windowBytes = 256 * 1024;
        while (true) {
          const start = Math.max(0, size - windowBytes);
          const raw = this.readRange(fd, start, size - start).toString("utf8");
          if (!raw.endsWith("\n")) return null;
          const lines = raw.split(/\r?\n/u);
          if (start > 0) lines.shift();
          const rows = new Map<number, Record<string, unknown>>();
          let minStep = Infinity;
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{")) continue;
            const row: unknown = JSON.parse(trimmed);
            if (!isRecord(row) || typeof row.step_index !== "number" || !Number.isSafeInteger(row.step_index)) {
              continue;
            }
            if (row.step_index < minStep) minStep = row.step_index;
            if (row.step_index <= afterStep) continue;
            if (
              (row.conversation_id !== undefined && row.conversation_id !== conversationId) ||
              (row.conversationId !== undefined && row.conversationId !== conversationId)
            ) {
              return null;
            }
            rows.set(row.step_index, row);
          }
          if (start > 0 && minStep > afterStep + 1) {
            windowBytes *= 2;
            continue;
          }
          return rows;
        }
      } catch {
        return null;
      } finally {
        if (fd !== undefined) {
          try { this.fsOps.closeSync(fd); } catch { /* already closed */ }
        }
      }
    };

    const compactFile = this.nativeTranscriptPath(conversationId);
    const fullFile = this.nativeFullTranscriptPath(conversationId);
    const compactRows = readTurnRows(compactFile);
    const fullRows = readTurnRows(fullFile);
    if (!compactRows && !fullRows) {
      return [];
    }
    const merged = new Map<number, Record<string, unknown>>();
    if (compactRows) {
      for (const [step, row] of compactRows) {
        merged.set(step, row);
      }
    }
    if (fullRows) {
      for (const [step, row] of fullRows) {
        merged.set(step, row);
      }
    }

    const ordered = [...merged.values()].sort(
      (a, b) => Number(a.step_index) - Number(b.step_index),
    );
    const firstUser = ordered.find(
      (row) => row.type === "USER_INPUT" && row.status === "DONE",
    );
    if (!firstUser) {
      return [];
    }
    const minTurnStep = Number(firstUser.step_index);

    const genericByStep = new Map<
      number,
      { status: string; content?: string; timestamp?: string }
    >();
    for (const row of ordered) {
      const stepIndex = Number(row.step_index);
      if (stepIndex <= minTurnStep) continue;
      if (
        row.type === "GENERIC" &&
        (row.status === "DONE" || row.status === "ERROR")
      ) {
        genericByStep.set(stepIndex, {
          status: String(row.status),
          ...(typeof row.content === "string" ? { content: row.content } : {}),
          ...(typeof row.created_at === "string" ? { timestamp: row.created_at } : {}),
        });
      }
    }

    const plannerSteps: NativeTurnPlannerStep[] = [];
    for (const row of ordered) {
      const stepIndex = Number(row.step_index);
      if (stepIndex <= minTurnStep) continue;
      const type = String(row.type ?? "");
      if (
        (type !== "PLANNER_RESPONSE" && type !== "AGENT_RESPONSE") ||
        row.status !== "DONE"
      ) {
        continue;
      }
      const timestamp =
        typeof row.created_at === "string" && row.created_at
          ? row.created_at
          : undefined;
      const thinking =
        typeof row.thinking === "string" && row.thinking.trim()
          ? row.thinking
          : undefined;
      const content =
        typeof row.content === "string" && row.content.trim()
          ? row.content
          : undefined;
      const toolCalls: NativeTurnToolCall[] = [];
      if (Array.isArray(row.tool_calls)) {
        for (let idx = 0; idx < row.tool_calls.length; idx++) {
          const tc = row.tool_calls[idx];
          if (!isRecord(tc)) continue;
          const toolStep = stepIndex + 1 + idx;
          const generic = genericByStep.get(toolStep);
          if (!generic) continue;
          const name =
            typeof tc.name === "string" && tc.name.trim()
              ? tc.name.trim()
              : "Antigravity tool";
          toolCalls.push({
            stepIndex: toolStep,
            ...(typeof tc.id === "string" && tc.id.trim()
              ? { callId: tc.id.trim() }
              : {}),
            name,
            args: tc.args ?? tc.arguments ?? {},
            ...(generic.content !== undefined ? { output: generic.content } : {}),
            status: generic.status === "ERROR" ? "failed" : "completed",
            timestamp: generic.timestamp ?? timestamp,
          });
        }
      }
      plannerSteps.push({
        stepIndex,
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(content !== undefined ? { content } : {}),
        toolCalls,
      });
    }
    return plannerSteps;
  }

  readNativeStep(
    conversationId: string,
    stepIndex: number,
  ): NativeSingleStep | null {
    const findInFile = (file: string): NativeSingleStep | null => {
      let fd: number | undefined;
      try {
        if (!this.fsOps.existsSync(file)) return null;
        const size = this.fsOps.statSync(file).size;
        if (size <= 0) return null;
        fd = this.fsOps.openSync(file, "r");
        let windowBytes = 256 * 1024;
        while (true) {
          const start = Math.max(0, size - windowBytes);
          const raw = this.readRange(fd, start, size - start).toString("utf8");
          if (!raw.endsWith("\n")) return null;
          const lines = raw.split(/\r?\n/u);
          if (start > 0) lines.shift();
          let minStep = Infinity;
          let matched: Record<string, unknown> | null = null;
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{")) continue;
            const row: unknown = JSON.parse(trimmed);
            if (!isRecord(row) || typeof row.step_index !== "number" || !Number.isSafeInteger(row.step_index)) {
              continue;
            }
            if (row.step_index < minStep) minStep = row.step_index;
            if (row.step_index === stepIndex) {
              matched = row;
            }
          }
          if (matched) {
            const type = String(matched.type ?? "");
            if (
              (type !== "PLANNER_RESPONSE" && type !== "AGENT_RESPONSE") ||
              matched.status !== "DONE"
            ) {
              return null;
            }
            const truncated = Array.isArray(matched.truncated_fields)
              ? matched.truncated_fields
              : [];
            if (
              file === this.nativeTranscriptPath(conversationId) &&
              (truncated.includes("content") || truncated.includes("thinking"))
            ) {
              return null;
            }
            const timestamp =
              typeof matched.created_at === "string" && matched.created_at
                ? matched.created_at
                : undefined;
            const thinking =
              typeof matched.thinking === "string" && matched.thinking.trim()
                ? matched.thinking
                : undefined;
            const content =
              typeof matched.content === "string" && matched.content.trim()
                ? matched.content
                : undefined;
            return {
              stepIndex,
              ...(timestamp !== undefined ? { timestamp } : {}),
              ...(thinking !== undefined ? { thinking } : {}),
              ...(content !== undefined ? { content } : {}),
            };
          }
          if (start > 0 && minStep > stepIndex) {
            windowBytes *= 2;
            continue;
          }
          return null;
        }
      } catch {
        return null;
      } finally {
        if (fd !== undefined) {
          try { this.fsOps.closeSync(fd); } catch { /* already closed */ }
        }
      }
    };
    return (
      findInFile(this.nativeFullTranscriptPath(conversationId)) ??
      findInFile(this.nativeTranscriptPath(conversationId))
    );
  }

  /**
   * Mirrors `agy` `printmode.postResponseFailure(turnSteps)` and
   * `steps.LastRunErrorDetails`: returns true when the native `transcript.jsonl`
   * records an `ERROR_MESSAGE` (or non-tool `ERROR`-status) step at an index
   * greater than both `afterStep` and the last completed response-bearing step
   * (`PLANNER_RESPONSE`, `AGENT_RESPONSE`, `CHECKPOINT`).
   */
  hasTrailingNativeError(conversationId: string, afterStep = -1): boolean {
    const file = this.nativeTranscriptPath(conversationId);
    let fd: number | undefined;
    try {
      const stat = this.fsOps.statSync(file);
      if (stat.size <= 0) return false;
      fd = this.fsOps.openSync(file, "r");
      let windowBytes = 256 * 1024;
      while (true) {
        const tailBytes = Math.min(stat.size, windowBytes);
        const start = stat.size - tailBytes;
        const raw = this.readRange(fd, start, tailBytes).toString("utf8");
        const lines = raw.split(/\r?\n/u);
        if (start > 0 && lines.length > 1) lines.shift();
        let minStep = Infinity;
        let lastResponseStep = -1;
        let lastErrorStep = -1;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          let row: unknown;
          try { row = JSON.parse(trimmed); } catch { continue; }
          if (!isRecord(row)) continue;
          const step = row.step_index;
          if (typeof step !== "number" || !Number.isSafeInteger(step)) continue;
          if (step < minStep) minStep = step;
          if (step <= afterStep) continue;
          const type = String(row.type ?? "").toUpperCase();
          const status = String(row.status ?? row.state ?? "").toUpperCase();
          if (type === "ERROR_MESSAGE" || (type !== "GENERIC" && status === "ERROR")) {
            if (step > lastErrorStep) lastErrorStep = step;
          } else if (
            (type === "PLANNER_RESPONSE" || type === "AGENT_RESPONSE" || type === "CHECKPOINT") &&
            status === "DONE"
          ) {
            if (step > lastResponseStep) lastResponseStep = step;
          }
        }
        if (start > 0 && lastResponseStep === -1 && lastErrorStep === -1 && minStep > afterStep + 1) {
          windowBytes *= 2;
          continue;
        }
        return lastErrorStep > afterStep && lastErrorStep > lastResponseStep;
      }
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try { this.fsOps.closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  /**
   * Returns true when `errorText` matches an `ERROR_MESSAGE` (or non-tool `ERROR`)
   * step recorded in `transcript.jsonl` that was superseded by a later completed
   * response-bearing step (`PLANNER_RESPONSE`, `AGENT_RESPONSE`, `CHECKPOINT`).
   * Because `agy` `steps.BuildJSONOutput(allSteps)` calls `steps.LastStepError(allSteps)`
   * across the entire conversation history, any historical error (e.g. `503 UNAVAILABLE`,
   * `Malformed function call`, `model output error`, or an earlier failed turn)
   * stays attached to `result.error` on every subsequent turn in that conversation.
   */
  isRecoveredNativeError(conversationId: string, errorText: string): boolean {
    const normalizeErr = (value: string): string =>
      value.trim().replace(/^Error:\s*/i, "");
    const needle = normalizeErr(errorText);
    if (!needle) return false;
    const file = this.nativeTranscriptPath(conversationId);
    let fd: number | undefined;
    try {
      const stat = this.fsOps.statSync(file);
      if (stat.size <= 0) return false;
      fd = this.fsOps.openSync(file, "r");
      let windowBytes = 256 * 1024;
      while (true) {
        const tailBytes = Math.min(stat.size, windowBytes);
        const start = stat.size - tailBytes;
        const raw = this.readRange(fd, start, tailBytes).toString("utf8");
        const lines = raw.split(/\r?\n/u);
        if (start > 0 && lines.length > 1) lines.shift();
        let lastResponseStep = -1;
        let lastErrorStep = -1;
        let matchedErrorStep = -1;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          let row: unknown;
          try { row = JSON.parse(trimmed); } catch { continue; }
          if (!isRecord(row)) continue;
          const step = row.step_index;
          if (typeof step !== "number" || !Number.isSafeInteger(step)) continue;
          const type = String(row.type ?? "").toUpperCase();
          const status = String(row.status ?? row.state ?? "").toUpperCase();
          if (type === "ERROR_MESSAGE" || (type !== "GENERIC" && status === "ERROR")) {
            if (step > lastErrorStep) lastErrorStep = step;
            const candidates = [
              typeof row.error === "string" ? row.error : "",
              typeof row.content === "string" ? row.content : "",
            ];
            if (
              candidates.some(
                (c) => c && (normalizeErr(c) === needle || c.trim() === errorText.trim()),
              )
            ) {
              if (step > matchedErrorStep) matchedErrorStep = step;
            }
          } else if (
            (type === "PLANNER_RESPONSE" || type === "AGENT_RESPONSE" || type === "CHECKPOINT") &&
            status === "DONE"
          ) {
            if (step > lastResponseStep) lastResponseStep = step;
          }
        }
        if (lastErrorStep > lastResponseStep && lastResponseStep !== -1) {
          return false;
        }
        if (
          matchedErrorStep !== -1 &&
          lastResponseStep > matchedErrorStep &&
          lastResponseStep > lastErrorStep
        ) {
          return true;
        }
        if (start > 0) {
          windowBytes *= 2;
          continue;
        }
        return false;
      }
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try { this.fsOps.closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  /**
   * Compaction metadata from the native transcript, sorted by step. The
   * transcript is append-only and can reach tens of MB, so each call reads
   * only bytes appended since the previous call: unchanged size/mtime returns
   * the cached (frozen) snapshot without reading, growth reads just the new
   * range, and truncation, replacement or a rewritten prefix falls back to a
   * full reread. An unterminated final line is parsed but not consumed, so a
   * torn row heals once its newline arrives.
   */
  readNativeCompaction(conversationId: string): readonly NativeObservation[] {
    const file = this.nativeTranscriptPath(conversationId);
    let stat: { ino: number; size: number; mtimeMs: number };
    try { stat = this.fsOps.statSync(file); }
    catch { this.transcriptCursors.delete(conversationId); return NO_OBSERVATIONS; }
    const previous = this.transcriptCursors.get(conversationId);
    const sameFile = previous !== undefined && previous.file === file && previous.ino === stat.ino;
    if (sameFile && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
      return previous.snapshot;
    }
    let fd: number | undefined;
    try {
      fd = this.fsOps.openSync(file, "r");
      const resumable = sameFile && stat.size > previous.size && this.fingerprintMatches(fd, previous);
      const cursor: TranscriptCursor = resumable ? previous : {
        file, ino: stat.ino, size: 0, mtimeMs: 0, offset: 0,
        head: Buffer.alloc(0), anchor: Buffer.alloc(0), steps: new Map(), snapshot: NO_OBSERVATIONS,
      };
      const changed = this.scanTranscript(fd, cursor, stat.size);
      cursor.size = stat.size;
      cursor.mtimeMs = stat.mtimeMs;
      if (cursor.head.length < TRANSCRIPT_FINGERPRINT_BYTES) {
        cursor.head = this.readRange(fd, 0, Math.min(cursor.offset, TRANSCRIPT_FINGERPRINT_BYTES));
      }
      const anchorStart = Math.max(0, cursor.offset - TRANSCRIPT_FINGERPRINT_BYTES);
      cursor.anchor = this.readRange(fd, anchorStart, cursor.offset - anchorStart);
      if (changed || !resumable) cursor.snapshot = Object.freeze([...cursor.steps.values()].sort(byStep));
      this.transcriptCursors.set(conversationId, cursor);
      return cursor.snapshot;
    } catch {
      this.transcriptCursors.delete(conversationId);
      return NO_OBSERVATIONS;
    } finally {
      if (fd !== undefined) {
        try { this.fsOps.closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  private readRange(fd: number, position: number, length: number): Buffer {
    const buffer = Buffer.alloc(Math.max(0, length));
    let filled = 0;
    while (filled < buffer.length) {
      const read = this.fsOps.readSync(fd, buffer, filled, buffer.length - filled, position + filled);
      if (read <= 0) break;
      filled += read;
    }
    return filled === buffer.length ? buffer : buffer.subarray(0, filled);
  }

  /** True when the bytes already consumed are still the same file prefix. */
  private fingerprintMatches(fd: number, cursor: TranscriptCursor): boolean {
    return this.readRange(fd, 0, cursor.head.length).equals(cursor.head) &&
      this.readRange(fd, cursor.offset - cursor.anchor.length, cursor.anchor.length).equals(cursor.anchor);
  }

  /** Applies lines in [cursor.offset, end) and advances the offset past the
   * last complete line. Returns whether any observation was added/replaced. */
  private scanTranscript(fd: number, cursor: TranscriptCursor, end: number): boolean {
    let changed = false;
    let pending: Buffer[] = [];
    let position = cursor.offset;
    const chunk = Buffer.allocUnsafe(Math.min(TRANSCRIPT_READ_CHUNK_BYTES, Math.max(1, end - position)));
    while (position < end) {
      const read = this.fsOps.readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
      if (read <= 0) break;
      const view = chunk.subarray(0, read);
      let lineStart = 0;
      for (let newline = view.indexOf(0x0a); newline !== -1; newline = view.indexOf(0x0a, lineStart)) {
        const piece = view.subarray(lineStart, newline);
        const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
        pending = [];
        if (applyNativeLogLine(cursor.steps, line.toString("utf8"))) changed = true;
        lineStart = newline + 1;
        cursor.offset = position + lineStart;
      }
      // The chunk buffer is reused: keep a private copy of a partial line.
      if (lineStart < read) pending.push(Buffer.from(view.subarray(lineStart)));
      position += read;
    }
    if (pending.length && applyNativeLogLine(cursor.steps, Buffer.concat(pending).toString("utf8"))) changed = true;
    return changed;
  }

  saveCompaction(conversationId: string, state: CompactionState): boolean {
    const target = this.compactionPath(conversationId);
    const suffix = `${process.pid}.${++tempFileCounter}`;
    const tmp = `${target}.${suffix}.tmp`;
    const displaced = `${target}.${suffix}.prev.tmp`;
    const backupTmp = `${target}.${suffix}.bak.tmp`;
    const backupDisplaced = `${target}.${suffix}.bak.prev.tmp`;
    try {
      this.ensureStoreDir();
      this.fsOps.writeFileSync(tmp, JSON.stringify(state) + "\n", "utf8");
      try {
        const previous: unknown = JSON.parse(this.fsOps.readFileSync(target, "utf8"));
        if (validCompactionState(previous)) {
          this.fsOps.copyFileSync(target, backupTmp);
          this.atomicReplaceFile(backupTmp, `${target}.bak`, backupDisplaced);
        }
      } catch { /* Keep the last valid backup if the primary is missing/damaged. */ }
      this.atomicReplaceFile(tmp, target, displaced);
      return true;
    } catch (err) {
      console.warn(`[antigravity-resilient] Failed to persist compaction state: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.safeUnlink(tmp);
      // Keep a displaced valid state if even the rollback rename failed.
      if (this.fsOps.existsSync(target)) this.safeUnlink(displaced);
      this.safeUnlink(backupTmp);
      if (this.fsOps.existsSync(`${target}.bak`)) this.safeUnlink(backupDisplaced);
    }
  }

  sessionKeyPath(sessionKey: string): string {
    return path.join(
      this.storeDir,
      "session-keys",
      `${safeConversationKey(sessionKey)}.json`,
    );
  }

  bindSessionKey(sessionKey: string, conversationId: string): void {
    const cleanKey = sessionKey.trim();
    const cleanConv = conversationId.trim();
    if (!cleanKey || !cleanConv) {
      return;
    }
    if (this.sessionKeyBindings.get(cleanKey) === cleanConv) {
      return;
    }
    this.sessionKeyBindings.set(cleanKey, cleanConv);
    const targetFile = this.sessionKeyPath(cleanKey);
    const targetDir = path.dirname(targetFile);
    const key = safeConversationKey(cleanKey);
    const idSuffix = `${process.pid}.${++tempFileCounter}`;
    const tmpFile = path.join(targetDir, `${key}.${idSuffix}.tmp`);
    const displacedFile = path.join(targetDir, `${key}.${idSuffix}.prev.tmp`);
    try {
      if (!this.fsOps.existsSync(targetDir)) {
        this.fsOps.mkdirSync(targetDir, { recursive: true });
      }
      const payload = `${JSON.stringify(
        {
          version: 1,
          sessionKey: cleanKey,
          conversationId: cleanConv,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`;
      this.fsOps.writeFileSync(tmpFile, payload, "utf8");
      this.atomicReplaceFile(tmpFile, targetFile, displacedFile);
    } catch (err) {
      console.warn(
        `[antigravity-resilient] Failed to bind sessionKey ${cleanKey} -> ${cleanConv}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.safeUnlink(tmpFile);
      this.safeUnlink(displacedFile);
    }
  }

  resolveConversationId(sessionKey: string): string | undefined {
    const cleanKey = sessionKey.trim();
    if (!cleanKey) {
      return undefined;
    }
    const cached = this.sessionKeyBindings.get(cleanKey);
    if (cached) {
      return cached;
    }
    const targetFile = this.sessionKeyPath(cleanKey);
    if (!this.fsOps.existsSync(targetFile)) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(this.fsOps.readFileSync(targetFile, "utf8"));
      if (
        isRecord(parsed) &&
        parsed.version === 1 &&
        typeof parsed.conversationId === "string" &&
        parsed.conversationId.trim().length > 0
      ) {
        const resolved = parsed.conversationId.trim();
        this.sessionKeyBindings.set(cleanKey, resolved);
        return resolved;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  uncompactedJournalCount(conversationId: string): number {
    this.ensureLoaded(conversationId);
    return this.uncompactedJournalCounts.get(conversationId) ?? 0;
  }

  load(conversationId: string): StoredTimelineRecord[] {
    const map = this.ensureLoaded(conversationId);
    normalizeTimelineStepOrder(map);
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }

  maxTurnIndex(conversationId: string): number {
    const records = this.load(conversationId);
    let maxTurn = 0;
    for (const record of records) {
      const match = /(?:^|:)turn-(\d+)(?::|$)/.exec(record.id);
      if (match && match[1]) {
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isFinite(parsed) && parsed > maxTurn) {
          maxTurn = parsed;
        }
      }
    }
    return maxTurn;
  }

  upsert(
    conversationId: string,
    rawItem: ProviderTimelineItem,
    timestamp?: string,
  ): StoredTimelineRecord {
    const map = this.ensureLoaded(conversationId);
    const sanitized = sanitizeTimelineItem(rawItem);
    const existing = map.get(sanitized.id);
    const nowIso = timestamp ?? new Date().toISOString();

    if (existing) {
      if (JSON.stringify(existing.item) === JSON.stringify(sanitized)) {
        return existing;
      }
      const updated: StoredTimelineRecord = {
        id: existing.id,
        seq: existing.seq,
        timestamp: existing.timestamp || nowIso,
        item: sanitized,
      };
      map.set(updated.id, updated);
      this.appendJournalRecord(conversationId, updated, map);
      return updated;
    }

    const nextSeq = (this.seqCounters.get(conversationId) ?? 0) + 1;
    this.seqCounters.set(conversationId, nextSeq);
    const created: StoredTimelineRecord = {
      id: sanitized.id,
      seq: nextSeq,
      timestamp: nowIso,
      item: sanitized,
    };
    map.set(created.id, created);
    normalizeTimelineStepOrder(map);
    const stored = map.get(created.id) ?? created;
    this.appendJournalRecord(conversationId, stored, map);
    return stored;
  }

  /**
   * Flushes the full normalized snapshot for `conversationId` atomically and,
   * once the primary `.json` snapshot is durably replaced on disk, compacts
   * the `.jsonl` write-ahead journal.
   */
  flush(conversationId: string): boolean {
    const map = this.ensureLoaded(conversationId);
    if (map.size === 0) {
      return true;
    }
    const snapFile = this.snapshotPath(conversationId);
    const isDirty = this.dirtyConversations.has(conversationId);
    const journalCount = this.uncompactedJournalCounts.get(conversationId) ?? 0;
    if (!isDirty && journalCount === 0 && this.fsOps.existsSync(snapFile)) {
      return true;
    }

    const snapshotWritten = this.writeSnapshotAtomically(conversationId, map);
    if (!snapshotWritten) {
      return false;
    }

    this.compactJournalAtomically(conversationId);
    this.dirtyConversations.delete(conversationId);
    return true;
  }

  flushAll(): void {
    for (const conversationId of this.cache.keys()) {
      this.flush(conversationId);
    }
  }

  private readSnapshotFile(filePath: string): StoredTimelineRecord[] | null {
    if (!this.fsOps.existsSync(filePath)) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(this.fsOps.readFileSync(filePath, "utf8"));
      if (
        isRecord(parsed) &&
        parsed.version === 1 &&
        Array.isArray(parsed.items) &&
        parsed.items.every((entry) => isValidRecord(entry))
      ) {
        return parsed.items as StoredTimelineRecord[];
      }
      return null;
    } catch {
      return null;
    }
  }

  private ensureLoaded(
    conversationId: string,
  ): Map<string, StoredTimelineRecord> {
    const cached = this.cache.get(conversationId);
    if (cached) {
      return cached;
    }

    const map = new Map<string, StoredTimelineRecord>();
    let maxSeq = 0;
    let needsHeal = false;
    let journalEntryCount = 0;

    const snapFile = this.snapshotPath(conversationId);
    const bakFile = this.backupPath(conversationId);
    const journalFile = this.journalPath(conversationId);

    const applyRecords = (records: StoredTimelineRecord[]) => {
      for (const rec of records) {
        if (!isValidRecord(rec)) {
          continue;
        }
        const cleanItem = sanitizeTimelineItem(rec.item);
        const existing = map.get(rec.id);
        const seq = existing ? existing.seq : rec.seq;
        if (seq > maxSeq) {
          maxSeq = seq;
        }
        map.set(rec.id, {
          id: rec.id,
          seq,
          timestamp: existing?.timestamp || rec.timestamp,
          item: cleanItem,
        });
      }
    };

    const primaryRecords = this.readSnapshotFile(snapFile);
    if (primaryRecords !== null) {
      applyRecords(primaryRecords);
    } else {
      if (this.fsOps.existsSync(snapFile)) {
        needsHeal = true;
      }
      const backupRecords = this.readSnapshotFile(bakFile);
      if (backupRecords !== null) {
        applyRecords(backupRecords);
        needsHeal = true;
      }
    }

    if (this.fsOps.existsSync(journalFile)) {
      try {
        const lines = this.fsOps.readFileSync(journalFile, "utf8").split(/\r?\n/u);
        const journalRecords: StoredTimelineRecord[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          journalEntryCount += 1;
          try {
            const parsed: unknown = JSON.parse(trimmed);
            if (isValidRecord(parsed)) {
              journalRecords.push(parsed);
            } else {
              needsHeal = true;
            }
          } catch {
            needsHeal = true;
          }
        }
        if (journalRecords.length > 0) {
          applyRecords(journalRecords);
          needsHeal = true;
        }
      } catch {
        needsHeal = true;
      }
    }

    if (map.size === 0) {
      const nativeTranscript = path.join(
        this.brainDir,
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      const seeded = parseNativeTranscript(nativeTranscript);
      if (seeded.length > 0) {
        applyRecords(seeded);
        needsHeal = true;
      }
    }

    this.seqCounters.set(conversationId, maxSeq);
    this.uncompactedJournalCounts.set(conversationId, journalEntryCount);
    this.cache.set(conversationId, map);

    if (needsHeal && map.size > 0) {
      this.dirtyConversations.add(conversationId);
      const healed = this.writeSnapshotAtomically(conversationId, map);
      if (healed) {
        this.compactJournalAtomically(conversationId);
        this.dirtyConversations.delete(conversationId);
      }
    }

    return map;
  }

  private ensureStoreDir(): void {
    if (!this.fsOps.existsSync(this.storeDir)) {
      this.fsOps.mkdirSync(this.storeDir, { recursive: true });
    }
  }

  private safeUnlink(filePath: string): void {
    try {
      if (this.fsOps.existsSync(filePath)) {
        this.fsOps.unlinkSync(filePath);
      }
    } catch {
      // Best-effort cleanup of temporary files.
    }
  }

  /**
   * Replaces `targetFile` with `stagedTmpFile` without ever writing in-place to
   * `targetFile` or destroying the previous valid `targetFile` if replacement fails.
   *
   * Sequence:
   * 1. Try direct `renameSync(stagedTmpFile, targetFile)`.
   * 2. If that fails and `targetFile` exists (e.g. Windows lock/permission quirk on
   *    existing destination), move `targetFile` to `displacedTmpFile`, then rename
   *    `stagedTmpFile` -> `targetFile`.
   * 3. If the second rename fails, roll back by renaming `displacedTmpFile` -> `targetFile`.
   */
  private atomicReplaceFile(
    stagedTmpFile: string,
    targetFile: string,
    displacedTmpFile: string,
  ): boolean {
    try {
      this.fsOps.renameSync(stagedTmpFile, targetFile);
      return true;
    } catch (directErr) {
      if (!this.fsOps.existsSync(targetFile)) {
        throw directErr;
      }
    }

    this.safeUnlink(displacedTmpFile);
    this.fsOps.renameSync(targetFile, displacedTmpFile);
    try {
      this.fsOps.renameSync(stagedTmpFile, targetFile);
    } catch (replaceErr) {
      try {
        if (!this.fsOps.existsSync(targetFile) && this.fsOps.existsSync(displacedTmpFile)) {
          this.fsOps.renameSync(displacedTmpFile, targetFile);
        }
      } catch {
        // Backup file (.json.bak) still preserves the last valid snapshot.
      }
      throw replaceErr;
    }

    this.safeUnlink(displacedTmpFile);
    return true;
  }

  private appendJournalRecord(
    conversationId: string,
    record: StoredTimelineRecord,
    map: Map<string, StoredTimelineRecord>,
  ): void {
    this.dirtyConversations.add(conversationId);
    try {
      this.ensureStoreDir();
      const journalFile = this.journalPath(conversationId);
      this.fsOps.appendFileSync(journalFile, `${JSON.stringify(record)}\n`, "utf8");
      const nextCount = (this.uncompactedJournalCounts.get(conversationId) ?? 0) + 1;
      this.uncompactedJournalCounts.set(conversationId, nextCount);
      if (nextCount >= this.maxJournalEntriesBeforeCompact) {
        this.flush(conversationId);
      }
    } catch (err) {
      console.warn(
        `[antigravity-resilient] Failed to append timeline journal for ${conversationId}, falling back to atomic snapshot: ${err instanceof Error ? err.message : String(err)}`,
      );
      const written = this.writeSnapshotAtomically(conversationId, map);
      if (written) {
        this.dirtyConversations.delete(conversationId);
      }
    }
  }

  private compactJournalAtomically(conversationId: string): boolean {
    const journalFile = this.journalPath(conversationId);
    if (!this.fsOps.existsSync(journalFile)) {
      this.uncompactedJournalCounts.set(conversationId, 0);
      return true;
    }
    const key = safeConversationKey(conversationId);
    const idSuffix = `${process.pid}.${++tempFileCounter}`;
    const journalTmpFile = path.join(
      this.storeDir,
      `${key}.${idSuffix}.journal.tmp`,
    );
    const journalDisplacedFile = path.join(
      this.storeDir,
      `${key}.${idSuffix}.journal.prev.tmp`,
    );
    try {
      this.ensureStoreDir();
      this.fsOps.writeFileSync(journalTmpFile, "", "utf8");
      this.atomicReplaceFile(journalTmpFile, journalFile, journalDisplacedFile);
      this.uncompactedJournalCounts.set(conversationId, 0);
      return true;
    } catch (err) {
      console.warn(
        `[antigravity-resilient] Failed to compact journal for ${conversationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      this.safeUnlink(journalTmpFile);
      this.safeUnlink(journalDisplacedFile);
    }
  }

  private writeSnapshotAtomically(
    conversationId: string,
    map: Map<string, StoredTimelineRecord>,
  ): boolean {
    const key = safeConversationKey(conversationId);
    const idSuffix = `${process.pid}.${++tempFileCounter}`;
    const snapFile = this.snapshotPath(conversationId);
    const bakFile = this.backupPath(conversationId);
    const tmpFile = path.join(this.storeDir, `${key}.${idSuffix}.tmp`);
    const displacedSnapFile = path.join(
      this.storeDir,
      `${key}.${idSuffix}.snap.prev.tmp`,
    );
    const bakTmpFile = path.join(this.storeDir, `${key}.${idSuffix}.bak.tmp`);
    const displacedBakFile = path.join(
      this.storeDir,
      `${key}.${idSuffix}.bak.prev.tmp`,
    );

    try {
      this.ensureStoreDir();

      normalizeTimelineStepOrder(map);
      const sorted = [...map.values()].sort((a, b) => a.seq - b.seq);
      const snapshot: ConversationSnapshot = {
        version: 1,
        conversationId,
        updatedAt: new Date().toISOString(),
        items: sorted,
      };

      const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
      this.fsOps.writeFileSync(tmpFile, payload, "utf8");

      // Stage a verified backup of the current valid primary snapshot before
      // touching snapFile, using atomic replacement so bakFile is never half-written.
      if (this.readSnapshotFile(snapFile) !== null) {
        try {
          this.fsOps.copyFileSync(snapFile, bakTmpFile);
          this.atomicReplaceFile(bakTmpFile, bakFile, displacedBakFile);
        } catch {
          // Keep existing bakFile intact if staging a new backup fails.
        } finally {
          this.safeUnlink(bakTmpFile);
          this.safeUnlink(displacedBakFile);
        }
      }

      this.atomicReplaceFile(tmpFile, snapFile, displacedSnapFile);
      return true;
    } catch (err) {
      console.warn(
        `[antigravity-resilient] Failed to write snapshot for ${conversationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      this.safeUnlink(tmpFile);
      this.safeUnlink(displacedSnapFile);
      this.safeUnlink(bakTmpFile);
      this.safeUnlink(displacedBakFile);
    }
  }
}
