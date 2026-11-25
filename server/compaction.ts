import type { ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { isRecord } from "./legacy.ts";

/**
 * Compaction policy ported from the stream-json fork (commits cc2aaee, b8d90c2,
 * fedeef2, a64107a):
 * - Hot prompt cache nominal TTL: 5 minutes (300,000 ms).
 * - Idle compaction lead time: 150,000 ms before expiry -> runs 2.5 minutes
 *   after the model request that wrote the cache (`a64107a` + `fedeef2`).
 * - Late tolerance after target fire time: 60,000 ms.
 * - Idle compaction context threshold: 150,000 tokens (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`
 *   env override floored at 100,000).
 * - Pre-turn compaction threshold: runs before a non-command business turn when
 *   context >= 150,000 and the prompt cache is already cold, OR when context >=
 *   200,000 even while warm (`cc2aaee`).
 * - Post-compaction suppression: `/compact` does not lower `usage_update.used`
 *   until the next real model request; `compacted` stays true until a real
 *   business turn observes a fresh model request (`b8d90c2`).
 * - Circuit breakers: 3 consecutive compaction failures, or 3 consecutive auto
 *   compactions refilling within <10 model requests each.
 */
export const DEFAULT_HOT_CACHE_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_AUTO_COMPACT_LEAD_MS = 150 * 1_000;
export const DEFAULT_AUTO_COMPACT_MAX_LATE_MS = 60 * 1_000;
export const DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD = 150_000;
export const DEFAULT_PRE_TURN_COMPACT_TOKEN_THRESHOLD = 200_000;
export const MIN_ENV_AUTO_COMPACT_TOKEN_THRESHOLD = 100_000;

export const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;
export const RAPID_REFILL_REQUEST_WINDOW = 10;
export const RAPID_REFILL_BREAKER_LIMIT = 3;

export const AUTO_COMPACT_COMMAND = "/compact";
export const AUTOCOMPACT_THRASHING_MESSAGE = `Autocompact is thrashing: the context refilled to the limit within ${RAPID_REFILL_REQUEST_WINDOW} model requests of the previous compact, ${RAPID_REFILL_BREAKER_LIMIT} times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or start a fresh session.`;

export type IdleCompactSkipReason =
  | "compaction_off"
  | "stopping"
  | "busy"
  | "no_session"
  | "already_compacted"
  | "failure_breaker_open"
  | "rapid_refill_breaker_open"
  | "no_cache_activity"
  | "newer_request"
  | "lapsed"
  | "small";

export interface CompactorConfigOptions {
  autoCompactEnabled?: boolean;
  autoCompactLeadMs?: number;
  autoCompactMaxLateMs?: number;
  autoCompactTokenThreshold?: number;
  preTurnCompactTokenThreshold?: number;
  hotCacheTtlMs?: number;
  now?: () => number;
}

function booleanOption(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function parseEnvFlagDisabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveEnvIdleCompactMinTokens(envValue: string | undefined): number | undefined {
  if (!envValue || !envValue.trim()) return undefined;
  const parsed = Number(envValue.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(MIN_ENV_AUTO_COMPACT_TOKEN_THRESHOLD, Math.round(parsed));
}

export function isSlashCommandPrompt(prompt: Pick<ProviderPrompt, "input">): boolean {
  if (prompt.input.type === "command") return true;
  const text = prompt.input.content
    .filter((part): part is Extract<typeof part, { text: string }> => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return /^\/\S+/.test(text);
}

export function isManualCompactPrompt(prompt: Pick<ProviderPrompt, "input">): boolean {
  if (prompt.input.type === "command") {
    return prompt.input.name.trim().toLowerCase() === "compact";
  }
  const text = prompt.input.content
    .filter((part): part is Extract<typeof part, { text: string }> => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return /^\/compact(?:\s|$)/i.test(text);
}

export class SessionCompactor {
  readonly autoCompactEnabled: boolean;
  readonly autoCompactLeadMs: number;
  readonly autoCompactMaxLateMs: number;
  readonly autoCompactTokenThreshold: number;
  readonly preTurnCompactTokenThreshold: number;
  readonly hotCacheTtlMs: number;
  private readonly now: () => number;

  private contextTokens = 0;
  private stepBoundaryAt: number | null = null;
  private lastRequestStartedAt: number | null = null;
  private lastRequestObservedAt: number | null = null;
  private lastHandledRequestAt: number | null = null;
  private cacheExpiresAt: number | null = null;

  private compacted = false;
  private nativeCompactedInTurn = false;
  private hasCompactedInSession = false;
  private consecutiveFailures = 0;
  private consecutiveRapidRefills = 0;
  private rapidRefillBreakerTripped = false;
  private modelRequests = 0;
  private lastCompactRequestIndex: number | null = null;
  private lastIdleSkipReason: IdleCompactSkipReason | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: {
    sessionEnv?: Readonly<Record<string, string>>;
    launchEnv?: Readonly<Record<string, string>>;
    providerOptions?: Readonly<Record<string, unknown>>;
    overrides?: CompactorConfigOptions;
  }) {
    const providerOpts = isRecord(input.providerOptions) ? input.providerOptions : {};
    const disableEnv =
      input.sessionEnv?.DISABLE_COMPACT ??
      input.launchEnv?.DISABLE_COMPACT ??
      process.env.DISABLE_COMPACT;

    this.autoCompactEnabled = parseEnvFlagDisabled(disableEnv)
      ? false
      : (input.overrides?.autoCompactEnabled ??
        booleanOption(providerOpts.autoCompactEnabled, true));

    const envMinTokens = resolveEnvIdleCompactMinTokens(
      input.sessionEnv?.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS ??
        input.launchEnv?.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS ??
        process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS,
    );

    this.autoCompactTokenThreshold =
      input.overrides?.autoCompactTokenThreshold ??
      numberOption(
        providerOpts.autoCompactTokenThreshold,
        envMinTokens ?? DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD,
      );
    this.preTurnCompactTokenThreshold =
      input.overrides?.preTurnCompactTokenThreshold ??
      numberOption(
        providerOpts.preTurnCompactTokenThreshold,
        DEFAULT_PRE_TURN_COMPACT_TOKEN_THRESHOLD,
      );
    this.hotCacheTtlMs =
      input.overrides?.hotCacheTtlMs ??
      numberOption(providerOpts.hotCacheTtlMs, DEFAULT_HOT_CACHE_TTL_MS);
    this.autoCompactLeadMs =
      input.overrides?.autoCompactLeadMs ??
      numberOption(providerOpts.autoCompactLeadMs, DEFAULT_AUTO_COMPACT_LEAD_MS);
    this.autoCompactMaxLateMs =
      input.overrides?.autoCompactMaxLateMs ??
      numberOption(providerOpts.autoCompactMaxLateMs, DEFAULT_AUTO_COMPACT_MAX_LATE_MS);
    this.now = input.overrides?.now ?? Date.now;
  }

  getContextTokens(): number {
    return this.contextTokens;
  }

  isCompacted(): boolean {
    return this.compacted;
  }

  getLastIdleSkipReason(): IdleCompactSkipReason | null {
    return this.lastIdleSkipReason;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getConsecutiveRapidRefills(): number {
    return this.consecutiveRapidRefills;
  }

  isRapidRefillBreakerTripped(): boolean {
    return this.rapidRefillBreakerTripped;
  }

  clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  withinRapidRefillWindow(): boolean {
    if (this.lastCompactRequestIndex === null) return false;
    return this.modelRequests - this.lastCompactRequestIndex < RAPID_REFILL_REQUEST_WINDOW;
  }

  /**
   * Seeded on `session/load` replay when `usage_update` arrives before ready.
   * Does not start an idle timer because the historical cache timestamp is unknown.
   */
  noteReplayedUsage(usedTokens: number | undefined): void {
    if (typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens > 0) {
      this.contextTokens = usedTokens;
    }
  }

  /** Marks when a business turn starts so rapid-refill window can release if enough requests passed. */
  noteBusinessTurnStart(now = this.now()): void {
    this.clearIdleTimer();
    this.nativeCompactedInTurn = false;
    this.stepBoundaryAt = now;
    if (!this.withinRapidRefillWindow()) {
      this.consecutiveRapidRefills = 0;
      this.rapidRefillBreakerTripped = false;
    }
  }

  /** Marks when a tool step finishes so the next model request's start time is anchored accurately. */
  noteStepBoundary(now = this.now()): void {
    this.stepBoundaryAt = now;
  }

  /** Records a native ACP `compaction_update` during a business turn (`b8d90c2`). */
  noteNativeCompactionCompleted(): void {
    this.nativeCompactedInTurn = true;
    this.hasCompactedInSession = true;
    this.lastCompactRequestIndex = this.modelRequests;
    this.compacted = true;
  }

  /**
   * Records `session.usage` (`contextWindowUsedTokens`) from a real business
   * model request. Clears post-compaction suppression because `agy` now reports
   * the true post-compact (or regrown) context window size, and anchors cache
   * expiry at `stepBoundaryAt` (`fedeef2`), not when streaming ended.
   */
  noteBusinessModelUsage(usedTokens: number | undefined, now = this.now()): void {
    if (typeof usedTokens !== "number" || !Number.isFinite(usedTokens) || usedTokens <= 0) {
      return;
    }
    const requestStartedAt =
      this.stepBoundaryAt !== null ? Math.min(this.stepBoundaryAt, now) : now;
    this.contextTokens = usedTokens;
    this.modelRequests += 1;
    // A real model request after `/compact` updates `usedTokens` to actual context;
    // if a native checkpoint happened earlier in the same turn and regrew, `compacted`
    // is re-evaluated here and at turn end (`b8d90c2`).
    this.compacted = false;
    this.lastRequestStartedAt = requestStartedAt;
    this.lastRequestObservedAt = now;
    this.cacheExpiresAt = requestStartedAt + this.hotCacheTtlMs;
    this.stepBoundaryAt = now;
  }

  /** Finalizes business turn state (`b8d90c2`) and returns whether idle compaction was scheduled. */
  noteBusinessTurnCompleted(
    context: {
      hasNativeSession: boolean;
      isBusy: () => boolean;
      isClosed: () => boolean;
      onFire: () => void;
    },
    now = this.now(),
  ): void {
    if (this.nativeCompactedInTurn && this.contextTokens < this.autoCompactTokenThreshold) {
      this.compacted = true;
    }
    this.nativeCompactedInTurn = false;
    this.scheduleIdleIfNeeded(context, now);
  }

  /**
   * Checks rapid-refill breaker before starting an automatic `/compact`.
   * Returns `{ allowed: false, thrashingMessage }` when the breaker trips.
   */
  checkAutoCompactBreaker(): { allowed: true; pendingRapidRefills: number } | {
    allowed: false;
    thrashingMessage: string;
  } {
    const nextRapidRefills =
      this.hasCompactedInSession && this.withinRapidRefillWindow()
        ? this.consecutiveRapidRefills + 1
        : 0;
    if (nextRapidRefills >= RAPID_REFILL_BREAKER_LIMIT) {
      this.consecutiveRapidRefills = nextRapidRefills;
      this.rapidRefillBreakerTripped = true;
      this.lastIdleSkipReason = "rapid_refill_breaker_open";
      return { allowed: false, thrashingMessage: AUTOCOMPACT_THRASHING_MESSAGE };
    }
    return { allowed: true, pendingRapidRefills: nextRapidRefills };
  }

  /** Settles an auto or manual `/compact` outcome. */
  noteCompactFinished(input: {
    source: "auto" | "manual";
    outcome: "completed" | "failed" | "canceled";
    pendingRapidRefills?: number;
  }): void {
    this.clearIdleTimer();
    if (input.outcome === "completed") {
      if (input.source === "manual") {
        this.consecutiveRapidRefills = 0;
        this.rapidRefillBreakerTripped = false;
      } else if (typeof input.pendingRapidRefills === "number") {
        this.consecutiveRapidRefills = input.pendingRapidRefills;
        this.rapidRefillBreakerTripped =
          this.consecutiveRapidRefills >= RAPID_REFILL_BREAKER_LIMIT;
      }
      this.consecutiveFailures = 0;
      this.hasCompactedInSession = true;
      this.lastCompactRequestIndex = this.modelRequests;
      this.compacted = true;
      this.lastRequestStartedAt = null;
      this.lastRequestObservedAt = null;
      this.cacheExpiresAt = null;
      return;
    }

    if (input.outcome === "failed") {
      this.consecutiveFailures += 1;
      if (input.source === "auto") {
        // Suppress repeated auto-compact retries until the next real business turn.
        this.compacted = true;
      }
    }
  }

  needsPreTurnCompact(hasNativeSession: boolean, now = this.now()): boolean {
    if (!this.autoCompactEnabled || !hasNativeSession) return false;
    if (this.compacted) return false;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) return false;
    if (this.rapidRefillBreakerTripped && this.withinRapidRefillWindow()) return false;
    if (this.contextTokens < this.autoCompactTokenThreshold) return false;
    const cacheCold = this.cacheExpiresAt === null || now >= this.cacheExpiresAt;
    const hardThreshold = Math.max(
      this.preTurnCompactTokenThreshold,
      this.autoCompactTokenThreshold,
    );
    return cacheCold || this.contextTokens >= hardThreshold;
  }

  evaluateIdleGate(input: {
    armedRequestObservedAt: number | null;
    armedFireAt: number | null;
    hasNativeSession: boolean;
    isBusy: boolean;
    isClosed: boolean;
    now?: number;
  }): IdleCompactSkipReason | null {
    const now = input.now ?? this.now();
    if (!this.autoCompactEnabled) return "compaction_off";
    if (input.isClosed) return "stopping";
    if (input.isBusy) return "busy";
    if (!input.hasNativeSession) return "no_session";
    if (this.compacted) return "already_compacted";
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
      return "failure_breaker_open";
    }
    if (this.rapidRefillBreakerTripped && this.withinRapidRefillWindow()) {
      return "rapid_refill_breaker_open";
    }
    if (
      this.lastRequestObservedAt === null ||
      this.lastRequestStartedAt === null ||
      this.cacheExpiresAt === null
    ) {
      return "no_cache_activity";
    }
    if (input.armedRequestObservedAt !== null) {
      if (
        this.lastRequestObservedAt > input.armedRequestObservedAt ||
        this.lastHandledRequestAt === input.armedRequestObservedAt
      ) {
        return "newer_request";
      }
    } else if (this.lastHandledRequestAt === this.lastRequestObservedAt) {
      return "newer_request";
    }
    const lateMs = input.armedFireAt !== null ? Math.max(0, now - input.armedFireAt) : 0;
    const cacheWarm = now < this.cacheExpiresAt;
    if (!cacheWarm || lateMs > this.autoCompactMaxLateMs) {
      return "lapsed";
    }
    if (this.contextTokens < this.autoCompactTokenThreshold) {
      return "small";
    }
    return null;
  }

  scheduleIdleIfNeeded(
    context: {
      hasNativeSession: boolean;
      isBusy: () => boolean;
      isClosed: () => boolean;
      onFire: () => void;
    },
    now = this.now(),
  ): void {
    this.clearIdleTimer();
    const skip = this.evaluateIdleGate({
      armedRequestObservedAt: null,
      armedFireAt: null,
      hasNativeSession: context.hasNativeSession,
      isBusy: context.isBusy(),
      isClosed: context.isClosed(),
      now,
    });
    if (skip !== null) {
      this.lastIdleSkipReason = skip;
      return;
    }

    const armedObservedAt = this.lastRequestObservedAt!;
    const fireAt = this.cacheExpiresAt! - this.autoCompactLeadMs;
    const delayMs = Math.max(0, fireAt - now);
    const timer = setTimeout(() => {
      this.idleTimer = null;
      const fireNow = this.now();
      const gate = this.evaluateIdleGate({
        armedRequestObservedAt: armedObservedAt,
        armedFireAt: fireAt,
        hasNativeSession: context.hasNativeSession,
        isBusy: context.isBusy(),
        isClosed: context.isClosed(),
        now: fireNow,
      });
      if (gate !== null) {
        this.lastIdleSkipReason = gate;
        if (gate !== "busy" && gate !== "newer_request") {
          this.lastHandledRequestAt = armedObservedAt;
        }
        return;
      }
      this.lastHandledRequestAt = armedObservedAt;
      this.lastIdleSkipReason = null;
      context.onFire();
    }, delayMs);

    if (delayMs >= 1_000 && typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.idleTimer = timer;
  }
}
