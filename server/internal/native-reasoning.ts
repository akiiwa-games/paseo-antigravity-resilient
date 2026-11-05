import { openSync, closeSync, readSync, statSync } from "node:fs";
import path from "node:path";

type ParsedThoughtRow = {
  step: number;
  text: string;
  timestamp?: string;
  truncated: boolean;
};

class TranscriptTailCursor {
  private offset = 0;
  private pending = Buffer.alloc(0);
  private ino: number | undefined;
  readonly file: string;

  constructor(file: string, startAtEnd = true) {
    this.file = file;
    if (!startAtEnd) return;
    try {
      const stat = statSync(file);
      this.offset = stat.size;
      this.ino = stat.ino;
    } catch { /* the new conversation has not created its transcript yet */ }
  }

  readRows(): ParsedThoughtRow[] {
    const rows: ParsedThoughtRow[] = [];
    let fd: number | undefined;
    try {
      const stat = statSync(this.file);
      if (stat.size < this.offset || (this.ino !== undefined && stat.ino !== this.ino)) {
        // Replacement is not append-only progress. Start at the new EOF so
        // historical thoughts cannot leak into the active turn.
        this.offset = stat.size;
        this.pending = Buffer.alloc(0);
      }
      this.ino = stat.ino;
      if (stat.size === this.offset) return rows;
      fd = openSync(this.file, "r");
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - this.offset));
      while (this.offset < stat.size) {
        const size = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - this.offset), this.offset);
        if (!size) break;
        this.offset += size;
        const bytes = Buffer.concat([this.pending, chunk.subarray(0, size)]);
        let start = 0;
        for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
          try {
            const row = JSON.parse(bytes.subarray(start, end).toString("utf8"));
            if (
              row.type === "PLANNER_RESPONSE" &&
              Number.isInteger(row.step_index) &&
              typeof row.thinking === "string" &&
              row.thinking.trim()
            ) {
              const truncated =
                Array.isArray(row.truncated_fields) &&
                row.truncated_fields.includes("thinking");
              rows.push({
                step: row.step_index,
                text: row.thinking,
                truncated,
                ...(typeof row.created_at === "string" ? { timestamp: row.created_at } : {}),
              });
            }
          } catch { /* ignore a malformed native row; the JSON stream remains authoritative */ }
          start = end + 1;
        }
        this.pending = Buffer.from(bytes.subarray(start));
      }
    } catch { /* optional local transcript may not exist on this CLI build */ }
    finally { if (fd !== undefined) closeSync(fd); }
    return rows;
  }
}

function readStepThinkingFromFullTail(
  fullFile: string,
  targetStep: number,
): { text: string; timestamp?: string } | null {
  let fd: number | undefined;
  try {
    const stat = statSync(fullFile);
    if (stat.size <= 0) return null;
    fd = openSync(fullFile, "r");
    let windowBytes = 256 * 1024;
    while (true) {
      const start = Math.max(0, stat.size - windowBytes);
      const length = stat.size - start;
      const buf = Buffer.allocUnsafe(length);
      const read = readSync(fd, buf, 0, length, start);
      const raw = buf.subarray(0, read).toString("utf8");
      const lines = raw.split(/\r?\n/u);
      if (start > 0 && lines.length > 1) lines.shift();
      let minStep = Infinity;
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i]!.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const row = JSON.parse(trimmed);
          if (!Number.isInteger(row.step_index)) continue;
          if (row.step_index < minStep) minStep = row.step_index;
          if (
            row.step_index === targetStep &&
            row.type === "PLANNER_RESPONSE" &&
            typeof row.thinking === "string" &&
            row.thinking.trim()
          ) {
            return {
              text: row.thinking,
              ...(typeof row.created_at === "string" ? { timestamp: row.created_at } : {}),
            };
          }
        } catch { /* ignore partial or malformed line */ }
      }
      if (start > 0 && minStep > targetStep) {
        windowBytes *= 2;
        continue;
      }
      return null;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** agy 1.4.12 omits thinking from stream-json but writes it to its native
 * transcript when a model request finishes, truncating `thinking` > ~4,116 chars
 * in `transcript.jsonl` (`truncated_fields: ["thinking"]`) while writing the
 * full text to `transcript_full.jsonl`. Tail only this turn's additions and
 * resolve truncated thoughts from `transcript_full.jsonl`. */
export class NativeReasoningTail {
  private readonly compactCursor: TranscriptTailCursor;
  private readonly fullCursor: TranscriptTailCursor | null;
  private readonly fullFile: string | null;
  private readonly emittedByStep = new Map<number, { text: string; truncated: boolean }>();

  constructor(file: string) {
    let compactExisted = false;
    try {
      statSync(file);
      compactExisted = true;
    } catch { /* not created yet */ }
    this.compactCursor = new TranscriptTailCursor(file, true);
    if (path.basename(file) === "transcript_full.jsonl") {
      this.fullFile = file;
      this.fullCursor = null;
    } else {
      this.fullFile = path.join(path.dirname(file), "transcript_full.jsonl");
      let fullExisted = false;
      try {
        statSync(this.fullFile);
        fullExisted = true;
      } catch { /* not created yet */ }
      this.fullCursor = new TranscriptTailCursor(this.fullFile, fullExisted || !compactExisted);
    }
  }

  read(): Array<{ step: number; text: string; timestamp?: string }> {
    const fullByStep = new Map<number, ParsedThoughtRow>();
    if (this.fullCursor) {
      for (const row of this.fullCursor.readRows()) {
        fullByStep.set(row.step, row);
      }
    }
    const candidates = new Map<number, ParsedThoughtRow>();
    for (const row of this.compactCursor.readRows()) {
      let resolved = row;
      const fromCursor = fullByStep.get(row.step);
      if (fromCursor && (!fromCursor.truncated || fromCursor.text.length >= row.text.length)) {
        resolved = fromCursor;
      } else if (this.fullFile) {
        const fromTail = readStepThinkingFromFullTail(this.fullFile, row.step);
        if (fromTail && (row.truncated || fromTail.text.length > row.text.length)) {
          resolved = {
            step: row.step,
            text: fromTail.text,
            timestamp: fromTail.timestamp ?? row.timestamp,
            truncated: false,
          };
        }
      }
      candidates.set(row.step, resolved);
    }
    for (const [step, row] of fullByStep) {
      const existing = candidates.get(step);
      if (!existing || (existing.truncated && !row.truncated) || row.text.length > existing.text.length) {
        candidates.set(step, row);
      }
    }

    const thoughts: Array<{ step: number; text: string; timestamp?: string }> = [];
    for (const row of [...candidates.values()].sort((a, b) => a.step - b.step)) {
      const prev = this.emittedByStep.get(row.step);
      if (
        prev &&
        prev.text === row.text &&
        (!prev.truncated || row.truncated)
      ) {
        continue;
      }
      if (prev && !prev.truncated && prev.text.length >= row.text.length) {
        continue;
      }
      this.emittedByStep.set(row.step, { text: row.text, truncated: row.truncated });
      thoughts.push({
        step: row.step,
        text: row.text,
        ...(row.timestamp !== undefined ? { timestamp: row.timestamp } : {}),
      });
    }
    return thoughts;
  }
}
