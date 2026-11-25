import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  runAcpProvider,
  type AcpOptions,
  type AcpStreamMessage,
  type AcpTransformer,
} from "@getpaseo/plugin/server/acp";
import {
  PROVIDER_PROTOCOL_VERSION,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConfigState,
  type ProviderConnectRequest,
  type ProviderConnection,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderModel,
  type ProviderPersistence,
  type ProviderPrompt,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import {
  isManualCompactPrompt,
  isSlashCommandPrompt,
  SessionCompactor,
  type CompactorConfigOptions,
} from "./compaction.ts";
import {
  defaultAgyCommand,
  isSupportedAgyVersion,
  isTransientLaunchError,
  LAUNCH_RETRY_DELAYS_MS,
  LaunchRateGuard,
  type LaunchRateLimit,
  MIN_AGY_VERSION,
  type OwnedAcpChild,
  parseSemver,
  readAgyVersion,
  resolveCommandFingerprint,
  resolveEffectiveLaunch,
  spawnAcpChildStream,
  type SpawnProcessLike,
  unsupportedVersionMessage,
} from "./launch.ts";
import {
  applyLegacyModelConfigure,
  decodeSavedSessionId,
  enrichCatalogModels,
  enrichPersistence,
  isRecord,
  parseLegacyModelEffort,
  withLegacyModelAliases,
} from "./legacy.ts";
import {
  buildInvalidModelError,
  classifyTurnFailure,
  CONTINUE_INTERRUPTED_TURN_PROMPT,
  emptyRetryCounts,
  formatDiagnostic,
  isPermanentAuthError,
  isQuotaExhaustedError,
  isStreamInterruption,
  MODEL_REJECTION_RETRY_DELAY_MS,
  parseModelRejection,
  parseThinkingLevelRejection,
  ProviderActionError,
  type RecoveryPolicyOptions,
  sanitizeDiagnosticText,
  type TurnRetryCounts,
} from "./recovery.ts";
import { mapToolCall } from "./tool-calls.ts";

export const PROVIDER_ID = "antigravity-resilient";
export const PLUGIN_ID = "antigravity-resilient-provider";
export const PROVIDER_LABEL = "Antigravity (Resilient)";

export const CATALOG_TTL_MS = 30 * 60_000;
export const CATALOG_RETRY_BASE_MS = 2 * 60_000;
export const CATALOG_FAILURES_BEFORE_UNAVAILABLE = 3;
export const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
export const DEFAULT_DISCOVERY_RETRY_DELAY_MS = 1_500;
export const DEFAULT_CANCEL_FALLBACK_TIMEOUT_MS = 5_000;
export const DEFAULT_POST_LOAD_USAGE_WINDOW_MS = 300;

const systemPromptCapability = z.object({
  antigravity: z.object({ systemPrompt: z.object({ append: z.literal(true) }) }),
});

// agy 1.5.13+ advertises these built-in commands alongside invocable skills in one ACP list.
const builtInCommands = new Set([
  "goal",
  "compact",
  "schedule",
  "browser",
  "plan",
  "grill-me",
  "teamwork",
  "learn",
  "boost",
]);

// agy 1.5.14+ reads sign-in from a token file when any SSH env var is set, else OS keyring.
const sshSessionVariables = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];

export function describeSignIn(env: Readonly<Record<string, string>>): string {
  const variable = sshSessionVariables.find((name) => env[name]);
  return variable
    ? `SSH session: yes (${variable})\nSign-in: can differ from agy outside SSH`
    : "SSH session: no\nSign-in: can differ from agy over SSH";
}

export interface AntigravityResilientOptions {
  spawn?: SpawnProcessLike;
  launchRetryDelaysMs?: readonly number[];
  launchRateLimit?: Partial<LaunchRateLimit>;
  startupTimeoutMs?: number;
  loadReplayQuietPeriodMs?: number;
  postLoadUsageWindowMs?: number;
  cancelFallbackTimeoutMs?: number;
  discoveryRetryDelayMs?: number;
  minAgyVersion?: string;
  legacyStoreDir?: string;
  compaction?: CompactorConfigOptions;
  recovery?: RecoveryPolicyOptions;
  now?: () => number;
}

interface CatalogCacheState {
  generation: number;
  rejected: Set<string>;
  lastGood: ProviderCatalog | null;
  failures: number;
  retryAt: number | null;
}

const catalogStates = new Map<string, CatalogCacheState>();

function launchIdentity(launch: ProviderLaunch): string {
  const fingerprint = resolveCommandFingerprint(launch.command, launch.env);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "antigravity-resilient-acp-v1",
        launch.command,
        fingerprint,
        launch.args,
        Object.entries(launch.env).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
}

function getCatalogState(launch: ProviderLaunch): CatalogCacheState {
  const key = launchIdentity(launch);
  let state = catalogStates.get(key);
  if (!state) {
    state = {
      generation: 0,
      rejected: new Set(),
      lastGood: null,
      failures: 0,
      retryAt: null,
    };
    catalogStates.set(key, state);
  }
  return state;
}

export function catalogRetryDelayMs(failures: number): number {
  return Math.min(CATALOG_RETRY_BASE_MS * 2 ** Math.max(failures - 1, 0), CATALOG_TTL_MS);
}

export function computeCatalogCacheKey(launch: ProviderLaunch, now = Date.now()): string {
  const identity = launchIdentity(launch);
  const state = getCatalogState(launch);
  if (state.retryAt !== null && now >= state.retryAt) {
    state.retryAt = null;
    state.generation += 1;
  }
  return createHash("sha256")
    .update(JSON.stringify([identity, Math.floor(now / CATALOG_TTL_MS), state.generation]))
    .digest("hex");
}

function excludeRejectedModels(
  catalog: ProviderCatalog,
  rejected: ReadonlySet<string>,
): ProviderCatalog {
  if (rejected.size === 0) return catalog;
  if (!catalog.models.some((model) => rejected.has(model.id))) return catalog;
  const kept = catalog.models.filter((model) => !rejected.has(model.id));
  const defaultModel =
    catalog.defaultModel && !rejected.has(catalog.defaultModel)
      ? catalog.defaultModel
      : kept[0]?.id;
  return {
    ...catalog,
    models: kept,
    defaultModel,
  };
}

function markCatalogStale(catalog: ProviderCatalog): ProviderCatalog {
  return {
    ...catalog,
    models: catalog.models.map((model) => ({
      ...model,
      metadata: { ...(model.metadata ?? {}), catalogStale: true },
    })),
  };
}

function catalogOffersModel(catalog: ProviderCatalog, requested: string): boolean {
  const trimmed = requested.trim();
  if (!trimmed) return true;
  return catalog.models.some(
    (model) => model.id === trimmed || (model.aliases ?? []).includes(trimmed),
  );
}

function promptDisplayText(prompt: ProviderPrompt): string {
  if (prompt.input.type === "command") {
    const suffix = prompt.input.arguments ? ` ${prompt.input.arguments}` : "";
    return `/${prompt.input.name}${suffix}`;
  }
  return prompt.input.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return "";
      return JSON.stringify(part);
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

interface ConnectorContext {
  purpose: string;
  session?: ManagedSession;
  sessionId?: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  onChild?: (child: OwnedAcpChild) => void;
}

interface CancelDeadline {
  startedAt: number;
  lastTickAt: number;
  timeoutMs: number;
  timer: ReturnType<typeof setInterval>;
}

type AttemptOutcome = {
  state: "completed" | "failed" | "canceled";
  error?: ProviderError;
  processExited: boolean;
};

interface ActiveAttempt {
  attemptClientMsgId: string;
  attemptTurnId: string;
  innerTurnStarted: boolean;
  crossedWireEndTurn: boolean;
  notifyInnerStarted: () => void;
  innerStartedOrSettled: Promise<void>;
  resolve: (outcome: AttemptOutcome) => void;
  cancelDeadline: CancelDeadline | null;
}

interface ActiveCompaction {
  kind: "idle" | "pre_turn";
  compactId: string;
  internalClientMsgId: string;
  internalTurnId: string;
  promise: Promise<"completed" | "failed" | "canceled">;
  resolveOutcome: (outcome: "completed" | "failed" | "canceled", error?: ProviderError) => void;
  cancelRequested: boolean;
  cancelDeadline: CancelDeadline | null;
}

interface ActiveForegroundTurn {
  publicTurnId: string;
  clientMessageId: string;
  hadProgress: boolean;
  ranForegroundTools: boolean;
  hasTrailingAssistantText: boolean;
  cancelRequested: boolean;
  cancelAbort: AbortController;
  cancelDeadline: CancelDeadline | null;
  recovering: boolean;
  retryCounts: TurnRetryCounts;
  openTools: Map<string, Extract<ProviderTimelineItem, { type: "tool_call" }>>;
  abortedTools: Map<string, Extract<ProviderTimelineItem, { type: "tool_call" }>>;
  activeAttempt: ActiveAttempt | null;
  sleepAbort: AbortController | null;
  done: Promise<void>;
}

interface QueuedTurnEntry {
  prompt: ProviderPrompt;
  canceled: boolean;
}

interface PostLoadUsageWaiter {
  promise: Promise<void>;
  settle: () => void;
}

interface ManagedSession {
  readonly sessionId: string;
  readonly externalOpenRequestId: string;
  currentConfig: ProviderSessionConfig;
  latestConfigState: ProviderConfigState | null;
  capabilities: readonly string[];
  nativeSessionId: string | undefined;
  readyEmitted: boolean;
  openingBuffer: ProviderEvent[] | null;
  openAbort: AbortController | null;
  reopenAbort: AbortController | null;
  reopenPromise: Promise<void> | null;
  activeOpenReqId: string | null;
  activeLifecycleOpen: Promise<void> | null;
  waitingOnPriorClose: boolean;
  closingPromise: Promise<void> | null;
  closedByHost: boolean;
  closedEmitted: boolean;
  innerOpen: boolean;
  innerDead: boolean;
  suppressInternalOpenClose: boolean;
  runtimeEpoch: number;
  currentChild: OwnedAcpChild | null;
  inFlightPromptRpcIds: Set<string | number>;
  sawUsageSinceOpen: boolean;
  sentPromptSinceOpen: boolean;
  postLoadUsageWaiter: PostLoadUsageWaiter | null;
  readonly compactor: SessionCompactor;
  activeCompaction: ActiveCompaction | null;
  activeTurn: ActiveForegroundTurn | null;
  queuedTurns: QueuedTurnEntry[];
  turnLane: Promise<void>;
  sequence: number;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isDetachedTool(item: Extract<ProviderTimelineItem, { type: "tool_call" }>): boolean {
  const detail = item.detail;
  if (detail.type === "unknown" && isRecord(detail.input)) {
    if (detail.input.IsDaemon === true) return true;
    if (
      item.name === "schedule" &&
      typeof detail.input.CronExpression === "string" &&
      detail.input.CronExpression.trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}

function isSyntheticTurnAbortToolError(error: unknown): boolean {
  if (error === "ACP turn failed" || error === "Turn failed") return true;
  return (
    isRecord(error) &&
    (error.message === "Turn failed" || error.message === "ACP turn failed")
  );
}

export function createAntigravityResilientProvider(
  options: AntigravityResilientOptions = {},
): ProviderRegistration {
  const now = options.now ?? Date.now;
  const minAgyVersion = options.minAgyVersion ?? MIN_AGY_VERSION;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const loadReplayQuietPeriodMs = options.loadReplayQuietPeriodMs ?? 0;
  const postLoadUsageWindowMs =
    options.postLoadUsageWindowMs ?? DEFAULT_POST_LOAD_USAGE_WINDOW_MS;
  const cancelFallbackTimeoutMs =
    options.cancelFallbackTimeoutMs ?? DEFAULT_CANCEL_FALLBACK_TIMEOUT_MS;
  const discoveryRetryDelayMs = options.discoveryRetryDelayMs ?? DEFAULT_DISCOVERY_RETRY_DELAY_MS;

  const launchRateGuard = new LaunchRateGuard({
    limit: options.launchRateLimit,
    isolatedProcessCounter: options.spawn !== undefined,
    now,
  });

  const acpOptions: AcpOptions = {
    startupTimeoutMs,
    // agy 1.5.14+ lists thinking options for the selected model only, and none for Orchestrator.
    perModelThinkingOptions: true,
    waitForInitialCommands: true,
    // agy >=1.5.15 finishes history replay before resolving `session/load`.
    loadReplayQuietPeriodMs,
    deferTurnOnRunningTools: {
      keepsTurnOpen(toolCall) {
        const input = toolCall.input;
        if (typeof input !== "object" || input === null || Array.isArray(input)) return true;
        if (input.IsDaemon === true) return false;
        const recurringSchedule =
          toolCall.name === "schedule" &&
          typeof input.CronExpression === "string" &&
          input.CronExpression.trim().length > 0;
        return !recurringSchedule;
      },
    },
    autoAcceptMode: {
      mode: {
        id: "full-access",
        label: "Full access",
        description: "Approve tool requests without asking.",
        icon: "ShieldOff",
        colorTier: "dangerous",
      },
      nativeMode: "default",
      default: true,
    },
  };

  async function connectInternal(
    request: ProviderConnectRequest,
    optionsOverride?: { skipConnectRetry?: boolean },
  ): Promise<ProviderConnection> {
    const launch = resolveEffectiveLaunch(request.launch);
    const catalogState = getCatalogState(launch);
    const contextStore = new AsyncLocalStorage<ConnectorContext>();
    const sessions = new Map<string, ManagedSession>();
    const activeChildren = new Set<OwnedAcpChild>();
    const pendingAbortedCleanups = new Set<Promise<void>>();
    let lastUtilityChild = null as OwnedAcpChild | null;
    let connectionClosed = false;
    let closeConnectionPromise: Promise<void> | null = null;

    const transformer: AcpTransformer = {
      command(command) {
        return { ...command, kind: builtInCommands.has(command.name) ? "command" : "skill" };
      },
      toolCall: mapToolCall,
      sessionOpen({ persistence, systemPrompt, agentMetadata }) {
        const savedSessionId = decodeSavedSessionId(persistence, {
          storeDir: options.legacyStoreDir,
          env: launch.env,
        });
        return {
          sessionId: savedSessionId,
          metadata:
            systemPrompt && systemPromptCapability.safeParse(agentMetadata).success
              ? { antigravity: { systemPrompt: { append: systemPrompt } } }
              : undefined,
        };
      },
      discover(catalog) {
        return enrichCatalogModels(catalog);
      },
      configure: applyLegacyModelConfigure,
      config(state) {
        const filtered =
          catalogState.rejected.size > 0
            ? state.models.filter((model) => !catalogState.rejected.has(model.id))
            : state.models;
        return {
          ...state,
          models: withLegacyModelAliases(filtered),
        };
      },
    };

    const innerRegistration = runAcpProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      description:
        "Resilient Antigravity (agy acp) provider with automatic context compaction and bounded transient recovery",
      icon: "icon.svg",
      acpOptions,
      transformers: [transformer],
      connector: async () => {
        const ctx = contextStore.getStore();
        const session =
          ctx?.session ?? (ctx?.sessionId ? sessions.get(ctx.sessionId) : undefined);
        if (connectionClosed || session?.closedByHost || ctx?.signal?.aborted) {
          throw new Error("Antigravity ACP launch aborted");
        }

        if (session) {
          launchRateGuard.recordLaunch(session.sessionId, ctx?.purpose ?? "session");
        }
        const owned = await spawnAcpChildStream({
          launch,
          cwd: ctx?.cwd,
          env: ctx?.env,
          spawn: options.spawn,
          retryDelaysMs: options.launchRetryDelaysMs ?? LAUNCH_RETRY_DELAYS_MS,
          minAgyVersion,
          signal: ctx?.signal,
          shouldStopRetry: () =>
            connectionClosed || Boolean(session?.closedByHost) || Boolean(ctx?.signal?.aborted),
          onAbortedCleanup: (cleanup) => {
            pendingAbortedCleanups.add(cleanup);
            void cleanup.finally(() => pendingAbortedCleanups.delete(cleanup));
          },
        });
        activeChildren.add(owned);
        void owned.closed.finally(() => {
          activeChildren.delete(owned);
        });
        ctx?.onChild?.(owned);
        if (connectionClosed || session?.closedByHost || ctx?.signal?.aborted) {
          await owned.close({ force: true }).catch(() => undefined);
          throw new Error("Antigravity ACP launch aborted");
        }

        if (session) {
          session.currentChild = owned;
          session.inFlightPromptRpcIds.clear();
          session.sentPromptSinceOpen = false;
          const wrappedStream = {
            readable: owned.stream.readable.pipeThrough(
              new TransformStream<AcpStreamMessage, AcpStreamMessage>({
                transform(frame, controller) {
                  const raw = frame as Record<string, unknown>;
                  if (
                    !("method" in raw) &&
                    ("result" in raw || "error" in raw) &&
                    (typeof raw.id === "string" || typeof raw.id === "number") &&
                    session.inFlightPromptRpcIds.delete(raw.id)
                  ) {
                    if (
                      "result" in raw &&
                      isRecord(raw.result) &&
                      raw.result.stopReason === "end_turn" &&
                      session.inFlightPromptRpcIds.size === 0 &&
                      session.activeTurn?.activeAttempt
                    ) {
                      session.activeTurn.activeAttempt.crossedWireEndTurn = true;
                    }
                  }
                  controller.enqueue(frame);
                },
              }),
            ),
            writable: new WritableStream<AcpStreamMessage>({
              write(frame) {
                const raw = frame as Record<string, unknown>;
                if (raw.method === "session/prompt") {
                  session.sentPromptSinceOpen = true;
                  session.postLoadUsageWaiter?.settle();
                  if (typeof raw.id === "string" || typeof raw.id === "number") {
                    session.inFlightPromptRpcIds.add(raw.id);
                    if (session.activeTurn?.activeAttempt) {
                      session.activeTurn.activeAttempt.crossedWireEndTurn = false;
                    }
                  }
                }
                const writer = owned.stream.writable.getWriter();
                return writer.write(frame).finally(() => writer.releaseLock());
              },
              close() {
                return owned.stream.writable.close();
              },
              abort(reason) {
                return owned.stream.writable.abort(reason);
              },
            }),
          };
          return wrappedStream;
        }

        lastUtilityChild = owned;
        return owned.stream;
      },
    });

    let inner: ProviderConnection;
    try {
      inner = await contextStore.run({ purpose: "capability-probe" }, () =>
        innerRegistration.connect({
          launch,
          versions: request.versions,
          capabilities: request.capabilities,
        }),
      );
    } catch (error) {
      const utilityFailure = lastUtilityChild?.describeFailure(
        error instanceof Error ? error.message : String(error),
      );
      await Promise.all(
        [...activeChildren].map((child) => child.close({ force: true }).catch(() => undefined)),
      );
      await (lastUtilityChild as OwnedAcpChild | null)?.close({ force: true }).catch(() => undefined);
      const message =
        utilityFailure ??
        formatDiagnostic(error instanceof Error ? error.message : String(error));
      const nonRetryable =
        optionsOverride?.skipConnectRetry ||
        error instanceof ProviderActionError ||
        /is unsupported\. Update agy/i.test(message) ||
        /Unknown command:\s*acp/i.test(message) ||
        isPermanentAuthError(message);

      if (!nonRetryable) {
        await abortableSleep(discoveryRetryDelayMs);
        return connectInternal(request, { skipConnectRetry: true });
      }
      throw error instanceof ProviderActionError ? error : new Error(message);
    }

    const listeners = new Set<(event: ProviderEvent) => void>();
    const pendingInternalRequests = new Map<
      string,
      {
        resolve: (event: ProviderEvent) => void;
        reject: (error: ProviderError) => void;
      }
    >();
    const pendingExternalOpenRequests = new Map<string, string>();
    const interceptedClientRequests = new Set<string>();

    const isInternalProviderRequestId = (requestId: string): boolean =>
      requestId.startsWith("__open_") ||
      requestId.startsWith("__internal_") ||
      requestId.startsWith("__close_") ||
      requestId.startsWith("__late_close_") ||
      requestId.startsWith("__interrupt_") ||
      requestId.startsWith("__cfg_");

    const markInternalRequestIntercepted = (requestId: string): void => {
      interceptedClientRequests.add(requestId);
      if (interceptedClientRequests.size > 512) {
        const oldest = interceptedClientRequests.values().next().value;
        if (oldest !== undefined) {
          interceptedClientRequests.delete(oldest);
        }
      }
    };

    const emitToHost = (event: ProviderEvent): void => {
      if (connectionClosed) return;
      for (const listener of listeners) {
        listener(event);
      }
    };

    const namespaceSessionEvent = (
      session: ManagedSession,
      event: ProviderEvent,
    ): ProviderEvent => {
      if (event.type !== "timeline.item" || session.runtimeEpoch <= 1) {
        return event;
      }
      const item = event.item;
      if (
        (item.type === "assistant_message" ||
          item.type === "reasoning" ||
          item.type === "user_message") &&
        /^(?:agent_message_chunk|agent_thought_chunk|user_message_chunk):\d+$/.test(item.id)
      ) {
        return {
          ...event,
          item: {
            ...item,
            id: `epoch-${session.runtimeEpoch}:${item.id}`,
          },
        };
      }
      return event;
    };

    const emitSessionEvent = (session: ManagedSession, event: ProviderEvent): void => {
      if (session.closedByHost || session.closedEmitted || connectionClosed) return;
      const normalized = namespaceSessionEvent(session, event);
      if (session.openingBuffer !== null) {
        session.openingBuffer.push(normalized);
        return;
      }
      emitToHost(normalized);
    };

    const armPostLoadUsageWindow = (session: ManagedSession, timeoutMs = 50): void => {
      session.postLoadUsageWaiter?.settle();
      let settled = false;
      let resolvePromise!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });
      const timer = setTimeout(() => {
        settle();
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (session.postLoadUsageWaiter === waiter) {
          session.postLoadUsageWaiter = null;
        }
        resolvePromise();
      };
      const waiter: PostLoadUsageWaiter = { promise, settle };
      session.postLoadUsageWaiter = waiter;
    };

    const isDeferredBackgroundToolWait = (session: ManagedSession): boolean => {
      const turn = session.activeTurn;
      const attempt = turn?.activeAttempt ?? null;
      return Boolean(
        turn &&
          !turn.recovering &&
          attempt &&
          attempt.crossedWireEndTurn &&
          session.inFlightPromptRpcIds.size === 0 &&
          turn.openTools.size > 0,
      );
    };

    const callInnerRequest = (
      input: ProviderInput & { requestId: string },
      ctx: ConnectorContext,
    ): Promise<ProviderEvent> =>
      new Promise<ProviderEvent>((resolve, reject) => {
        if (connectionClosed) {
          reject({
            message: "ACP provider connection is closed",
            diagnostic: "ACP provider connection is closed",
          });
          return;
        }
        pendingInternalRequests.set(input.requestId, { resolve, reject });
        contextStore
          .run(ctx, () => inner.send(input))
          .catch((error) => {
            if (!pendingInternalRequests.delete(input.requestId)) return;
            const sessionRef =
              ctx.session ?? (ctx.sessionId ? sessions.get(ctx.sessionId) : undefined);
            const child = sessionRef ? sessionRef.currentChild : lastUtilityChild;
            const message =
              child?.describeFailure(error instanceof Error ? error.message : String(error)) ??
              formatDiagnostic(error instanceof Error ? error.message : String(error));
            reject({
              ...(error instanceof ProviderActionError ? { code: error.code } : {}),
              message,
              diagnostic: message,
            });
          });
      });

    const armCancelDeadline = (
      onTimeout: () => void,
    ): CancelDeadline => {
      const startedAt = now();
      const deadline: CancelDeadline = {
        startedAt,
        lastTickAt: startedAt,
        timeoutMs: cancelFallbackTimeoutMs,
        timer: setInterval(() => {
          const tick = now();
          // Rebase pre-sleep deadline if system clock jumped across suspend/wake (>5s drift).
          if (tick - deadline.lastTickAt > 5_250 || tick < deadline.lastTickAt) {
            deadline.startedAt = tick;
          }
          deadline.lastTickAt = tick;
          if (tick - deadline.startedAt >= deadline.timeoutMs) {
            clearInterval(deadline.timer);
            onTimeout();
          }
        }, Math.min(200, Math.max(20, Math.floor(cancelFallbackTimeoutMs / 5)))),
      };
      if (typeof deadline.timer === "object" && "unref" in deadline.timer) {
        deadline.timer.unref();
      }
      return deadline;
    };

    const clearCancelDeadline = (deadline: CancelDeadline | null): void => {
      if (deadline) clearInterval(deadline.timer);
    };

    const abortPendingSessionOpen = (
      session: ManagedSession,
      reason: string,
      optionsAbort?: { killChild?: boolean },
    ): void => {
      session.openAbort?.abort();
      session.reopenAbort?.abort();
      if (session.activeOpenReqId) {
        const reqId = session.activeOpenReqId;
        session.activeOpenReqId = null;
        const pending = pendingInternalRequests.get(reqId);
        if (pending) {
          pendingInternalRequests.delete(reqId);
          markInternalRequestIntercepted(reqId);
          pending.reject({ message: reason, diagnostic: reason });
        }
      }
      if (optionsAbort?.killChild ?? true) {
        session.innerDead = true;
        void session.currentChild?.close({ force: true }).catch(() => undefined);
      }
    };

    const awaitOpenReadyWithTimeout = async (
      session: ManagedSession,
      internalReqId: string,
      readyPromise: Promise<unknown>,
      signal: AbortSignal,
    ): Promise<void> => {
      let startupTimer: ReturnType<typeof setTimeout> | null = null;
      if (startupTimeoutMs > 0) {
        startupTimer = setTimeout(() => {
          if (pendingInternalRequests.has(internalReqId)) {
            abortPendingSessionOpen(
              session,
              `Antigravity session did not become ready within ${startupTimeoutMs}ms`,
              { killChild: true },
            );
          }
        }, startupTimeoutMs);
        if (typeof startupTimer === "object" && "unref" in startupTimer) {
          startupTimer.unref();
        }
      }
      const onAbort = () => {
        if (pendingInternalRequests.has(internalReqId)) {
          abortPendingSessionOpen(session, "Antigravity session open aborted", { killChild: true });
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await readyPromise;
      } finally {
        if (startupTimer !== null) clearTimeout(startupTimer);
        signal.removeEventListener("abort", onAbort);
        if (session.activeOpenReqId === internalReqId) {
          session.activeOpenReqId = null;
        }
      }
    };

    const invalidateModel = (model: string): void => {
      const clean = model.trim();
      if (!clean) return;
      catalogState.rejected.add(clean);
      const parsed = parseLegacyModelEffort(clean);
      if (parsed) catalogState.rejected.add(parsed.baseModel);
      catalogState.generation += 1;
    };

    const probeCatalogOnce = async (
      cwd?: string,
      signal?: AbortSignal,
    ): Promise<ProviderCatalog> => {
      const reqId = `__internal_catalog_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      let catalogChild: OwnedAcpChild | null = null;
      let startupTimer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        const pending = pendingInternalRequests.get(reqId);
        if (pending) {
          pendingInternalRequests.delete(reqId);
          markInternalRequestIntercepted(reqId);
          void catalogChild?.close({ force: true }).catch(() => undefined);
          pending.reject({
            message: "Antigravity catalog probe aborted",
            diagnostic: "Antigravity catalog probe aborted",
          });
        }
      };
      if (startupTimeoutMs > 0) {
        startupTimer = setTimeout(() => {
          const pending = pendingInternalRequests.get(reqId);
          if (pending) {
            pendingInternalRequests.delete(reqId);
            markInternalRequestIntercepted(reqId);
            void catalogChild?.close({ force: true }).catch(() => undefined);
            const msg = `Antigravity catalog discovery timed out after ${startupTimeoutMs}ms`;
            pending.reject({ message: msg, diagnostic: msg });
          }
        }, startupTimeoutMs);
        if (typeof startupTimer === "object" && "unref" in startupTimer) {
          startupTimer.unref();
        }
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const event = await callInnerRequest(
          { type: "catalog", requestId: reqId, ...(cwd ? { cwd } : {}) },
          {
            purpose: "catalog",
            cwd,
            signal,
            onChild: (c) => {
              catalogChild = c;
            },
          },
        );
        if (event.type !== "catalog") {
          throw new Error("Invalid catalog event from ACP provider");
        }
        return event.catalog;
      } catch (err) {
        const childRef = catalogChild ?? lastUtilityChild;
        const message =
          childRef?.describeFailure(
            isRecord(err) && typeof err.message === "string" ? err.message : String(err),
          ) ??
          (isRecord(err) && typeof err.message === "string"
            ? err.message
            : formatDiagnostic(String(err)));
        throw new ProviderActionError(
          isRecord(err) && typeof err.code === "string" ? err.code : "DISCOVERY_FAILED",
          message,
          message,
        );
      } finally {
        if (startupTimer !== null) clearTimeout(startupTimer);
        signal?.removeEventListener("abort", onAbort);
      }
    };

    const fetchCatalogWithResilience = async (
      cwd: string | undefined,
      optionsFetch?: { allowStale?: boolean; countFailure?: boolean; signal?: AbortSignal },
    ): Promise<ProviderCatalog> => {
      const allowStale = optionsFetch?.allowStale ?? true;
      const countFailure = optionsFetch?.countFailure ?? true;
      const signal = optionsFetch?.signal;
      try {
        let catalog: ProviderCatalog;
        try {
          catalog = await probeCatalogOnce(cwd, signal);
        } catch (firstErr) {
          const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
          if (
            !signal?.aborted &&
            !connectionClosed &&
            !isPermanentAuthError(msg) &&
            (isStreamInterruption(msg) || isTransientLaunchError(firstErr))
          ) {
            await abortableSleep(discoveryRetryDelayMs, signal);
            catalog = await probeCatalogOnce(cwd, signal);
          } else {
            throw firstErr;
          }
        }
        // Fresh catalog from `agy acp` is authoritative; clear stale rejections it lists again.
        for (const model of catalog.models) {
          catalogState.rejected.delete(model.id);
        }
        catalogState.lastGood = catalog;
        if (catalogState.failures > 0 || catalogState.retryAt !== null) {
          catalogState.generation += 1;
        }
        catalogState.failures = 0;
        catalogState.retryAt = null;
        return catalog;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const currentNow = now();
        const retryPending = catalogState.retryAt !== null && currentNow < catalogState.retryAt;
        if (countFailure && !retryPending && !isPermanentAuthError(message)) {
          catalogState.failures += 1;
          catalogState.retryAt = currentNow + catalogRetryDelayMs(catalogState.failures);
        }
        if (
          allowStale &&
          !isPermanentAuthError(message) &&
          catalogState.lastGood &&
          catalogState.failures < CATALOG_FAILURES_BEFORE_UNAVAILABLE
        ) {
          return markCatalogStale(
            excludeRejectedModels(catalogState.lastGood, catalogState.rejected),
          );
        }
        throw error;
      }
    };

    const ensureInnerSessionAlive = async (session: ManagedSession): Promise<void> => {
      if (session.closedByHost || connectionClosed) {
        throw new Error("Antigravity session is closed");
      }
      if (session.reopenPromise) {
        await session.reopenPromise;
        if (session.closedByHost || connectionClosed) {
          throw new Error("Antigravity session is closed");
        }
        return;
      }
      if (session.innerOpen && !session.innerDead) return;
      if (!session.nativeSessionId) {
        throw new Error("Cannot reopen Antigravity session without a native session ID");
      }

      const reopenAbort = new AbortController();
      session.reopenAbort = reopenAbort;
      session.suppressInternalOpenClose = true;

      let reopenChild: OwnedAcpChild | null = null;
      let reopenTask: Promise<void> | null = null;
      let tracked: Promise<void> | null = null;
      reopenTask = (async () => {
        try {
          if (session.innerOpen) {
            await session.currentChild?.close({ force: true }).catch(() => undefined);
            const closeId = `__internal_close_${++session.sequence}`;
            await callInnerRequest(
              { type: "session.close", requestId: closeId, sessionId: session.sessionId },
              { purpose: "recovery-close", session, sessionId: session.sessionId },
            ).catch(() => undefined);
            session.innerOpen = false;
          }

          if (session.closedByHost || connectionClosed || reopenAbort.signal.aborted) {
            throw new Error("Antigravity session reopen aborted");
          }

          session.runtimeEpoch += 1;
          session.sawUsageSinceOpen = false;
          session.sentPromptSinceOpen = false;
          session.postLoadUsageWaiter?.settle();
          const openId = `__internal_reopen_${++session.sequence}`;
          session.activeOpenReqId = openId;
          const readyPromise = new Promise<void>((resolve, reject) => {
            pendingInternalRequests.set(openId, {
              resolve: () => resolve(),
              reject: (err) => reject(new Error(err.message)),
            });
          });

          await contextStore.run(
            {
              purpose: "recovery-reopen",
              session,
              sessionId: session.sessionId,
              cwd: session.currentConfig.cwd,
              env: session.currentConfig.env,
              signal: reopenAbort.signal,
              onChild: (child) => {
                reopenChild = child;
              },
            },
            () =>
              inner.send({
                type: "session.open",
                requestId: openId,
                sessionId: session.sessionId,
                history: "skip",
                persistence: { version: 1, data: { sessionId: session.nativeSessionId! } },
                config: session.currentConfig,
              }),
          );
          await awaitOpenReadyWithTimeout(session, openId, readyPromise, reopenAbort.signal);
          session.innerOpen = true;
          session.innerDead = false;
        } catch (err) {
          session.innerOpen = false;
          session.innerDead = true;
          await Promise.all([
            (reopenChild as OwnedAcpChild | null)?.close({ force: true }).catch(() => undefined),
            session.currentChild?.close({ force: true }).catch(() => undefined),
            ...[...pendingAbortedCleanups],
          ]);
          throw err;
        } finally {
          if (session.reopenAbort === reopenAbort) {
            session.reopenAbort = null;
          }
          session.suppressInternalOpenClose = false;
          if (session.reopenPromise === reopenTask) {
            session.reopenPromise = null;
          }
          if (session.activeLifecycleOpen === tracked) {
            session.activeLifecycleOpen = null;
          }
        }
      })();

      session.reopenPromise = reopenTask;
      tracked = reopenTask.then(
        () => undefined,
        () => undefined,
      );
      session.activeLifecycleOpen = tracked;
      await reopenTask;
    };

    const scheduleSessionIdleCompact = (session: ManagedSession): void => {
      session.compactor.scheduleIdleIfNeeded({
        hasNativeSession: Boolean(session.nativeSessionId),
        isBusy: () =>
          session.activeTurn !== null ||
          session.activeCompaction !== null ||
          session.inFlightPromptRpcIds.size > 0,
        isClosed: () => session.closedByHost || connectionClosed,
        onFire: () => {
          void runAutoCompaction(session, "idle");
        },
      });
    };

    const runAutoCompaction = async (
      session: ManagedSession,
      kind: "idle" | "pre_turn",
    ): Promise<"completed" | "failed" | "canceled" | "skipped"> => {
      if (session.closedByHost || connectionClosed || !session.nativeSessionId) {
        return "skipped";
      }
      if (session.activeCompaction) {
        return session.activeCompaction.promise;
      }

      const breaker = session.compactor.checkAutoCompactBreaker();
      if (!breaker.allowed) {
        emitSessionEvent(session, {
          type: "timeline.item",
          sessionId: session.sessionId,
          item: {
            id: `autocompact-thrashing:${++session.sequence}`,
            type: "notification",
            level: "warning",
            message: breaker.thrashingMessage,
          },
        });
        return "skipped";
      }

      const seq = ++session.sequence;
      const compactId = `compaction:auto:${seq}`;
      const internalClientMsgId = `__internal_compact_${seq}`;
      const internalTurnId = `acp:${internalClientMsgId}`;
      const preTokens = session.compactor.getContextTokens();

      let resolvePromise!: (outcome: "completed" | "failed" | "canceled") => void;
      const promise = new Promise<"completed" | "failed" | "canceled">((resolve) => {
        resolvePromise = resolve;
      });

      let settled = false;
      const active: ActiveCompaction = {
        kind,
        compactId,
        internalClientMsgId,
        internalTurnId,
        promise,
        cancelRequested: false,
        cancelDeadline: null,
        resolveOutcome: (outcome, error) => {
          if (settled) return;
          settled = true;
          clearCancelDeadline(active.cancelDeadline);
          active.cancelDeadline = null;
          if (session.activeCompaction === active) {
            session.activeCompaction = null;
          }

          // Settle the loading compaction marker cleanly (ProviderEventSchema only permits
          // "loading" | "completed", matching upstream AcpRuntime.terminalizeTransientItems so
          // Paseo's spinner stops; only stamp `trigger: "auto"` + `preTokens` on actual success).
          emitSessionEvent(session, {
            type: "timeline.item",
            sessionId: session.sessionId,
            item:
              outcome === "completed"
                ? {
                    id: compactId,
                    type: "compaction",
                    status: "completed",
                    trigger: "auto",
                    ...(preTokens > 0 ? { preTokens } : {}),
                  }
                : {
                    id: compactId,
                    type: "compaction",
                    status: "completed",
                  },
          });

          if (outcome === "failed") {
            const detail =
              session.currentChild?.describeFailure(error?.message) ??
              formatDiagnostic(error?.message ?? "Auto-compaction failed");
            emitSessionEvent(session, {
              type: "timeline.item",
              sessionId: session.sessionId,
              item: {
                id: `${compactId}:failed`,
                type: "notification",
                level: "warning",
                message: `Automatic context compaction failed: ${detail}`,
              },
            });
          } else if (outcome === "canceled") {
            emitSessionEvent(session, {
              type: "timeline.item",
              sessionId: session.sessionId,
              item: {
                id: `${compactId}:canceled`,
                type: "notification",
                level: "info",
                message: "Automatic context compaction canceled.",
              },
            });
          }

          session.compactor.noteCompactFinished({
            source: "auto",
            outcome,
            pendingRapidRefills: breaker.pendingRapidRefills,
          });
          resolvePromise(outcome);
        },
      };

      session.activeCompaction = active;
      emitSessionEvent(session, {
        type: "timeline.item",
        sessionId: session.sessionId,
        item: {
          id: compactId,
          type: "compaction",
          status: "loading",
          trigger: "auto",
          ...(preTokens > 0 ? { preTokens } : {}),
        },
      });

      try {
        await ensureInnerSessionAlive(session);
        if (active.cancelRequested || session.closedByHost || connectionClosed) {
          active.resolveOutcome("canceled");
          return await promise;
        }
        await contextStore.run(
          {
            purpose: `${kind}-compact`,
            sessionId: session.sessionId,
            cwd: session.currentConfig.cwd,
            env: session.currentConfig.env,
          },
          () =>
            inner.send({
              type: "session.prompt",
              sessionId: session.sessionId,
              prompt: {
                clientMessageId: internalClientMsgId,
                delivery: "auto",
                input: {
                  type: "message",
                  content: [{ type: "text", text: "/compact" }],
                },
              },
            }),
        );
      } catch (error) {
        if (active.cancelRequested || session.closedByHost || connectionClosed) {
          active.resolveOutcome("canceled");
        } else {
          active.resolveOutcome("failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return promise;
    };

    const runForegroundPrompt = async (
      session: ManagedSession,
      prompt: ProviderPrompt,
    ): Promise<void> => {
      session.compactor.clearIdleTimer();
      const publicTurnId = `acp:${prompt.clientMessageId}`;
      const isCommand = isSlashCommandPrompt(prompt);
      const isManualCompact = isManualCompactPrompt(prompt);
      const preManualTokens = session.compactor.getContextTokens();

      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      const turn: ActiveForegroundTurn = {
        publicTurnId,
        clientMessageId: prompt.clientMessageId,
        hadProgress: false,
        ranForegroundTools: false,
        hasTrailingAssistantText: false,
        cancelRequested: false,
        cancelAbort: new AbortController(),
        cancelDeadline: null,
        recovering: false,
        retryCounts: emptyRetryCounts(),
        openTools: new Map(),
        abortedTools: new Map(),
        activeAttempt: null,
        sleepAbort: null,
        done,
      };
      session.activeTurn = turn;

      // Announce turn immediately so prompts arriving during background compaction
      // are admitted and queued without rejection or host RPC timeout.
      emitToHost({
        type: "timeline.item",
        sessionId: session.sessionId,
        item: {
          type: "user_message",
          id: prompt.clientMessageId,
          text: promptDisplayText(prompt),
          clientMessageId: prompt.clientMessageId,
        },
      });
      emitToHost({
        type: "session.prompt_result",
        sessionId: session.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "turn", turnId: publicTurnId },
      });
      emitToHost({
        type: "session.turn",
        sessionId: session.sessionId,
        turnId: publicTurnId,
        state: "started",
      });

      const finishTurn = (
        state: "completed" | "failed" | "canceled",
        error?: ProviderError,
      ): void => {
        clearCancelDeadline(turn.cancelDeadline);
        turn.cancelDeadline = null;
        clearCancelDeadline(turn.activeAttempt?.cancelDeadline ?? null);
        turn.activeAttempt = null;
        if (session.activeTurn === turn) {
          session.activeTurn = null;
        }
        if (!session.closedEmitted) {
          emitToHost({
            type: "session.turn",
            sessionId: session.sessionId,
            turnId: publicTurnId,
            state,
            ...(state === "failed" && error ? { error } : {}),
          });
        }
        resolveDone();
      };

      try {
        // 1. Wait if an idle background compaction is currently running.
        if (session.activeCompaction) {
          await session.activeCompaction.promise;
        }
        if (turn.cancelRequested || session.closedByHost || connectionClosed) {
          finishTurn("canceled");
          return;
        }

        // Wait briefly if `session/load` just completed and `agy` is pushing its post-load `usage_update`.
        if (session.postLoadUsageWaiter) {
          await session.postLoadUsageWaiter.promise;
        }
        if (turn.cancelRequested || session.closedByHost || connectionClosed) {
          finishTurn("canceled");
          return;
        }

        // 2. Run pre-turn compaction when context is cold (>=150K) or over 200K (`cc2aaee`).
        if (
          !isCommand &&
          session.compactor.needsPreTurnCompact(Boolean(session.nativeSessionId))
        ) {
          await runAutoCompaction(session, "pre_turn");
          if (turn.cancelRequested || session.closedByHost || connectionClosed) {
            finishTurn("canceled");
            return;
          }
        }

        if (!isCommand && !isManualCompact) {
          session.compactor.noteBusinessTurnStart();
        }

        // 3. Execute foreground prompt with bounded transient error recovery.
        for (let attemptIndex = 1; ; attemptIndex += 1) {
          if (turn.cancelRequested || session.closedByHost || connectionClosed) {
            for (const tool of [...turn.openTools.values(), ...turn.abortedTools.values()]) {
              emitSessionEvent(session, {
                type: "timeline.item",
                sessionId: session.sessionId,
                item: { ...tool, status: "canceled", error: null },
              });
            }
            turn.openTools.clear();
            turn.abortedTools.clear();
            if (isManualCompact) {
              session.compactor.noteCompactFinished({ source: "manual", outcome: "canceled" });
            }
            finishTurn("canceled");
            return;
          }

          const attemptSeq = ++session.sequence;
          const attemptClientMsgId = `__attempt_${attemptSeq}_${prompt.clientMessageId}`;
          const attemptTurnId = `acp:${attemptClientMsgId}`;
          const useContinuePrompt = attemptIndex > 1 && turn.hadProgress && !isManualCompact;
          const wirePrompt: ProviderPrompt = useContinuePrompt
            ? {
                clientMessageId: attemptClientMsgId,
                delivery: "auto",
                input: {
                  type: "message",
                  content: [{ type: "text", text: CONTINUE_INTERRUPTED_TURN_PROMPT }],
                },
              }
            : {
                ...prompt,
                clientMessageId: attemptClientMsgId,
              };

          turn.abortedTools.clear();
          let outcome: AttemptOutcome;
          try {
            await ensureInnerSessionAlive(session);
            if (turn.cancelRequested || session.closedByHost || connectionClosed) {
              continue;
            }
            outcome = await new Promise<AttemptOutcome>((resolveAttempt) => {
              let attemptSettled = false;
              let notifyInnerStarted!: () => void;
              const innerStartedOrSettled = new Promise<void>((resolveStarted) => {
                notifyInnerStarted = resolveStarted;
              });
              const activeAttempt: ActiveAttempt = {
                attemptClientMsgId,
                attemptTurnId,
                innerTurnStarted: false,
                crossedWireEndTurn: false,
                notifyInnerStarted,
                innerStartedOrSettled,
                cancelDeadline: null,
                resolve: (res) => {
                  if (attemptSettled) return;
                  attemptSettled = true;
                  notifyInnerStarted();
                  clearCancelDeadline(activeAttempt.cancelDeadline);
                  activeAttempt.cancelDeadline = null;
                  if (turn.activeAttempt === activeAttempt) {
                    turn.activeAttempt = null;
                  }
                  resolveAttempt(res);
                },
              };
              turn.activeAttempt = activeAttempt;

              contextStore
                .run(
                  {
                    purpose: `prompt-attempt-${attemptIndex}`,
                    sessionId: session.sessionId,
                    cwd: session.currentConfig.cwd,
                    env: session.currentConfig.env,
                  },
                  () =>
                    inner.send({
                      type: "session.prompt",
                      sessionId: session.sessionId,
                      prompt: wirePrompt,
                    }),
                )
                .catch((sendErr) => {
                  activeAttempt.resolve({
                    state: "failed",
                    error: {
                      ...(sendErr instanceof ProviderActionError ? { code: sendErr.code } : {}),
                      message: sendErr instanceof Error ? sendErr.message : String(sendErr),
                    },
                    processExited: session.innerDead || session.currentChild?.exitInfo() !== null,
                  });
                });
            });
          } catch (reopenErr) {
            outcome = {
              state: "failed",
              error: {
                ...(reopenErr instanceof ProviderActionError ? { code: reopenErr.code } : {}),
                message: reopenErr instanceof Error ? reopenErr.message : String(reopenErr),
              },
              processExited: true,
            };
          }

          if (outcome.state === "completed") {
            if (isManualCompact) {
              emitSessionEvent(session, {
                type: "timeline.item",
                sessionId: session.sessionId,
                item: {
                  id: `${publicTurnId}:manual-compact`,
                  type: "compaction",
                  status: "completed",
                  trigger: "manual",
                  ...(preManualTokens > 0 ? { preTokens: preManualTokens } : {}),
                },
              });
              session.compactor.noteCompactFinished({ source: "manual", outcome: "completed" });
            } else if (!isCommand && turn.ranForegroundTools && !turn.hasTrailingAssistantText) {
              emitSessionEvent(session, {
                type: "session.notice",
                sessionId: session.sessionId,
                notice: {
                  id: `${publicTurnId}:tool-only`,
                  severity: "info",
                  title: "Turn finished without a final message",
                  description:
                    "Antigravity completed tool execution and ended the turn without summary text.",
                },
              });
            }

            finishTurn("completed");
            if (!isCommand && !isManualCompact) {
              session.compactor.noteBusinessTurnCompleted({
                hasNativeSession: Boolean(session.nativeSessionId),
                isBusy: () =>
                  session.activeTurn !== null ||
                  session.activeCompaction !== null ||
                  session.inFlightPromptRpcIds.size > 0,
                isClosed: () => session.closedByHost || connectionClosed,
                onFire: () => {
                  void runAutoCompaction(session, "idle");
                },
              });
            }
            return;
          }

          if (outcome.state === "canceled" || turn.cancelRequested || session.closedByHost) {
            for (const tool of [...turn.openTools.values(), ...turn.abortedTools.values()]) {
              emitSessionEvent(session, {
                type: "timeline.item",
                sessionId: session.sessionId,
                item: { ...tool, status: "canceled", error: null },
              });
            }
            turn.openTools.clear();
            turn.abortedTools.clear();
            if (isManualCompact) {
              session.compactor.noteCompactFinished({ source: "manual", outcome: "canceled" });
            }
            finishTurn("canceled");
            return;
          }

          // Outcome is "failed": diagnose and classify for bounded recovery.
          const explicitRpcError = session.currentChild?.lastRpcError() ?? null;
          const rawMessage =
            outcome.error?.code === "LAUNCH_RATE_LIMITED"
              ? outcome.error.message
              : (session.currentChild?.describeFailure(outcome.error?.message) ??
                formatDiagnostic(outcome.error?.message ?? "ACP turn failed"));

          if (outcome.error?.code === "LAUNCH_RATE_LIMITED") {
            finishTurn("failed", outcome.error);
            return;
          }

          const processExited =
            outcome.processExited ||
            session.innerDead ||
            session.currentChild?.exitInfo() !== null;
          if (processExited) {
            session.innerDead = true;
          }

          const decision = classifyTurnFailure({
            rawError: rawMessage,
            processExited: processExited && explicitRpcError === null,
            hadProgress: turn.hadProgress,
            configuredModel: session.currentConfig.model,
            counts: turn.retryCounts,
            policy: options.recovery,
          });

          if (decision.action === "check_model") {
            turn.recovering = true;
            const checkDelay =
              decision.explicitRejection !== null
                ? (options.recovery?.modelRejectionRetryDelayMs ?? MODEL_REJECTION_RETRY_DELAY_MS)
                : 0;
            if (checkDelay > 0) {
              const abort = new AbortController();
              turn.sleepAbort = abort;
              await abortableSleep(checkDelay, abort.signal);
              turn.sleepAbort = null;
            }
            if (turn.cancelRequested || session.closedByHost || connectionClosed) {
              turn.recovering = false;
              continue;
            }

            let freshCatalog: ProviderCatalog | null = null;
            try {
              freshCatalog = await fetchCatalogWithResilience(session.currentConfig.cwd, {
                allowStale: false,
                countFailure: false,
                signal: turn.cancelAbort.signal,
              });
            } catch {
              freshCatalog = null;
            }
            if (turn.cancelRequested || session.closedByHost || connectionClosed) {
              turn.recovering = false;
              continue;
            }

            const stillListed =
              freshCatalog !== null && catalogOffersModel(freshCatalog, decision.model);

            if (decision.explicitRejection !== null && stillListed) {
              turn.retryCounts.modelRejection += 1;
              turn.retryCounts.total += 1;
              session.innerDead = true;
              emitToHost({
                type: "session.notice",
                sessionId: session.sessionId,
                notice: {
                  id: `${publicTurnId}:model-recheck:${turn.retryCounts.total}`,
                  severity: "warning",
                  title: "Retrying after transient model list mismatch",
                  description: `Antigravity rejected ${decision.model}, which is still offered in the live catalog; reopening session once.`,
                },
              });
              turn.recovering = false;
              continue;
            }

            turn.recovering = false;
            if (decision.explicitRejection !== null || (freshCatalog !== null && !stillListed)) {
              invalidateModel(decision.model);
              const available =
                freshCatalog?.models.map((m) => m.id) ??
                decision.explicitRejection?.available ??
                [];
              if (session.latestConfigState) {
                const updatedModels = session.latestConfigState.models.filter(
                  (m) => !catalogState.rejected.has(m.id),
                );
                session.latestConfigState = {
                  ...session.latestConfigState,
                  models: withLegacyModelAliases(updatedModels),
                };
                emitToHost({
                  type: "session.config",
                  sessionId: session.sessionId,
                  config: session.latestConfigState,
                });
              }
              finishTurn(
                "failed",
                buildInvalidModelError(decision.model, available, decision.rawError),
              );
              return;
            }

            finishTurn("failed", {
              message: formatDiagnostic(decision.rawError),
              diagnostic: decision.rawError,
            });
            return;
          }

          if (decision.action === "retry") {
            turn.recovering = true;
            turn.retryCounts[decision.category] += 1;
            turn.retryCounts.total += 1;

            // Clear only open or synthetically-aborted tool spinners from the interrupted attempt
            // to canceled before starting the recovery attempt (never touch completed tools!).
            for (const tool of [...turn.openTools.values(), ...turn.abortedTools.values()]) {
              emitSessionEvent(session, {
                type: "timeline.item",
                sessionId: session.sessionId,
                item: { ...tool, status: "canceled", error: null },
              });
            }
            turn.openTools.clear();
            turn.abortedTools.clear();

            emitSessionEvent(session, {
              type: "session.notice",
              sessionId: session.sessionId,
              notice: {
                id: `${publicTurnId}:recovery:${turn.retryCounts.total}`,
                severity: "warning",
                title: decision.noticeTitle,
                description: decision.noticeDescription,
              },
            });

            if (decision.delayMs > 0) {
              const abort = new AbortController();
              turn.sleepAbort = abort;
              await abortableSleep(decision.delayMs, abort.signal);
              turn.sleepAbort = null;
            }
            turn.recovering = false;
            continue;
          }

          // Permanent / exhausted failure: update only open/aborted tool spinners with real cause.
          for (const tool of [...turn.openTools.values(), ...turn.abortedTools.values()]) {
            emitSessionEvent(session, {
              type: "timeline.item",
              sessionId: session.sessionId,
              item: { ...tool, status: "failed", error: decision.error.message },
            });
          }
          turn.openTools.clear();
          turn.abortedTools.clear();
          if (isManualCompact) {
            session.compactor.noteCompactFinished({ source: "manual", outcome: "failed" });
          }
          finishTurn("failed", decision.error);
          return;
        }
      } finally {
        resolveDone();
      }
    };

    const handleInnerEvent = (event: ProviderEvent): void => {
      // 1. Intercept internal request replies BEFORE looking up `sessions`, so aborted/closed
      // opens and utility probes always settle `pendingInternalRequests`.
      if (
        (event.type === "catalog" ||
          event.type === "sessions" ||
          event.type === "request.completed" ||
          event.type === "session.can_stop_runtime") &&
        pendingInternalRequests.has(event.requestId)
      ) {
        const pending = pendingInternalRequests.get(event.requestId)!;
        pendingInternalRequests.delete(event.requestId);
        pending.resolve(event);
        return;
      }

      if (event.type === "session.ready" && event.requestId) {
        if (pendingInternalRequests.has(event.requestId)) {
          const targetSession = sessions.get(event.sessionId);
          if (targetSession && !targetSession.waitingOnPriorClose) {
            targetSession.innerOpen = true;
            targetSession.innerDead = false;
            if (targetSession.activeOpenReqId === event.requestId) {
              targetSession.activeOpenReqId = null;
            }
          }
          const pending = pendingInternalRequests.get(event.requestId)!;
          pendingInternalRequests.delete(event.requestId);
          pending.resolve(event);
          return;
        }
        if (
          event.requestId.startsWith("__open_") ||
          event.requestId.startsWith("__internal_reopen_")
        ) {
          // Late `session.ready` for an already-aborted internal open: evict from `inner` immediately.
          const lateCloseId = `__late_close_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          markInternalRequestIntercepted(lateCloseId);
          void inner
            .send({
              type: "session.close",
              requestId: lateCloseId,
              sessionId: event.sessionId,
            })
            .catch(() => undefined);
          return;
        }
      }

      if (event.type === "request.failed") {
        if (pendingInternalRequests.has(event.requestId)) {
          const pending = pendingInternalRequests.get(event.requestId)!;
          pendingInternalRequests.delete(event.requestId);
          pending.reject(event.error);
          return;
        }
        if (
          interceptedClientRequests.delete(event.requestId) ||
          isInternalProviderRequestId(event.requestId)
        ) {
          return;
        }
        const openingSessionId = pendingExternalOpenRequests.get(event.requestId);
        if (openingSessionId) {
          pendingExternalOpenRequests.delete(event.requestId);
          const session = sessions.get(openingSessionId);
          sessions.delete(openingSessionId);
          const realMessage =
            session?.currentChild?.describeFailure(event.error.message) ??
            formatDiagnostic(event.error.message);
          emitToHost({
            type: "request.failed",
            requestId: event.requestId,
            error: {
              ...event.error,
              message: realMessage,
              diagnostic: realMessage,
            },
          });
          return;
        }
        const realMessage =
          lastUtilityChild?.describeFailure(event.error.message) ??
          formatDiagnostic(event.error.message);
        emitToHost({
          type: "request.failed",
          requestId: event.requestId,
          error: {
            ...event.error,
            message: realMessage,
            diagnostic: realMessage,
          },
        });
        return;
      }

      if (
        (event.type === "request.completed" ||
          event.type === "catalog" ||
          event.type === "sessions" ||
          event.type === "session.can_stop_runtime") &&
        (interceptedClientRequests.delete(event.requestId) ||
          isInternalProviderRequestId(event.requestId))
      ) {
        return;
      }

      if (!("sessionId" in event)) {
        emitToHost(event);
        return;
      }

      const session = sessions.get(event.sessionId);
      if (!session || session.waitingOnPriorClose) {
        // Drop events from internal temporary ACP sessions ("catalog", "sessions",
        // "capability-probe"), sessions already closed by the host, or a prior
        // closing generation of the same sessionId before the replacement opens in `inner`.
        return;
      }

      // 2. Session lifecycle events (`session.opened`, `session.ready`, `session.persistence`, `session.config`, `session.closed`, `session.runtime_failed`).
      if (event.type === "session.opened") {
        const enriched = enrichPersistence(event.persistence);
        const decoded = decodeSavedSessionId(enriched, {
          storeDir: options.legacyStoreDir,
          env: launch.env,
        });
        if (decoded) session.nativeSessionId = decoded;
        session.capabilities = event.capabilities;
        session.innerDead = false;
        if (session.suppressInternalOpenClose) return;
        emitSessionEvent(session, {
          ...event,
          ...(typeof event.requestId === "string" && isInternalProviderRequestId(event.requestId)
            ? { requestId: session.externalOpenRequestId }
            : {}),
          ...(enriched ? { persistence: enriched } : {}),
        });
        return;
      }

      if (event.type === "session.persistence") {
        const enriched = enrichPersistence(event.persistence) ?? event.persistence;
        const decoded = decodeSavedSessionId(enriched, {
          storeDir: options.legacyStoreDir,
          env: launch.env,
        });
        if (decoded) session.nativeSessionId = decoded;
        emitSessionEvent(session, { ...event, persistence: enriched });
        return;
      }

      if (event.type === "session.ready") {
        if (event.requestId && pendingInternalRequests.has(event.requestId)) {
          const pending = pendingInternalRequests.get(event.requestId)!;
          pendingInternalRequests.delete(event.requestId);
          pending.resolve(event);
          return;
        }
        if (event.requestId) {
          pendingExternalOpenRequests.delete(event.requestId);
        }
        session.readyEmitted = true;
        if (session.suppressInternalOpenClose) return;
        emitToHost(event);
        return;
      }

      if (event.type === "session.config") {
        session.latestConfigState = event.config;
        session.currentConfig = {
          ...session.currentConfig,
          ...(event.config.model !== undefined ? { model: event.config.model } : {}),
          ...(event.config.mode !== undefined ? { mode: event.config.mode } : {}),
          thinkingOption: event.config.thinkingOption,
        };
        emitSessionEvent(session, event);
        return;
      }

      if (event.type === "session.runtime_failed") {
        session.innerDead = true;
        // Suppress during active foreground turn or internal compaction so recovery can reopen.
        if (
          session.suppressInternalOpenClose ||
          session.activeTurn !== null ||
          session.activeCompaction !== null
        ) {
          return;
        }
        const realMessage =
          session.currentChild?.describeFailure(event.error.message) ??
          formatDiagnostic(event.error.message);
        emitToHost({
          ...event,
          error: {
            ...event.error,
            message: realMessage,
            diagnostic: realMessage,
          },
        });
        return;
      }

      if (event.type === "session.closed") {
        session.innerOpen = false;
        if (session.suppressInternalOpenClose) return;
        if (!session.closedByHost) {
          session.innerDead = true;
          return;
        }
        sessions.delete(session.sessionId);
        launchRateGuard.clearSession(session.sessionId);
        emitToHost(event);
        return;
      }

      // 3. Filter events belonging to an internal `/compact` prompt.
      const activeCompaction = session.activeCompaction;
      if (activeCompaction) {
        if (
          event.type === "session.prompt_result" &&
          event.clientMessageId === activeCompaction.internalClientMsgId
        ) {
          if (event.result.type === "failed") {
            activeCompaction.resolveOutcome("failed", event.result.error);
          }
          return;
        }
        if (
          event.type === "session.turn" &&
          event.turnId === activeCompaction.internalTurnId
        ) {
          if (event.state === "started") return;
          activeCompaction.resolveOutcome(event.state, event.error);
          return;
        }
        if (event.type === "session.usage") {
          // `/compact` summarization reads pre-compact context; suppress from meter.
          return;
        }
        if (
          event.type === "timeline.item" &&
          (event.item.type === "user_message" ||
            event.item.type === "assistant_message" ||
            event.item.type === "reasoning")
        ) {
          return;
        }
      }

      // 4. Route events belonging to an active foreground turn attempt.
      const activeTurn = session.activeTurn;
      const attempt = activeTurn?.activeAttempt ?? null;
      if (activeTurn && attempt) {
        if (event.type === "session.prompt_result") {
          if (event.clientMessageId === attempt.attemptClientMsgId) {
            if (event.result.type === "failed") {
              attempt.resolve({
                state: "failed",
                error: event.result.error,
                processExited: session.innerDead || session.currentChild?.exitInfo() !== null,
              });
            }
            return;
          }
          // Steer prompt result: map inner turnId to publicTurnId.
          if (event.result.type === "steer" && event.result.turnId === attempt.attemptTurnId) {
            emitToHost({
              ...event,
              result: { type: "steer", turnId: activeTurn.publicTurnId },
            });
            return;
          }
        }

        if (event.type === "session.turn" && event.turnId === attempt.attemptTurnId) {
          if (event.state === "started") {
            attempt.innerTurnStarted = true;
            attempt.notifyInnerStarted();
            return;
          }
          attempt.resolve({
            state: event.state,
            error: event.error,
            processExited: session.innerDead || session.currentChild?.exitInfo() !== null,
          });
          return;
        }

        if (event.type === "timeline.item") {
          const item = event.item;
          if (item.type === "user_message" && item.id === attempt.attemptClientMsgId) {
            return;
          }
          if (item.type === "assistant_message" && item.text.trim().length > 0) {
            activeTurn.hadProgress = true;
            activeTurn.hasTrailingAssistantText = true;
          } else if (item.type === "reasoning" && item.text.trim().length > 0) {
            activeTurn.hadProgress = true;
          } else if (item.type === "tool_call") {
            activeTurn.hadProgress = true;
            const detached = isDetachedTool(item);
            if (item.status === "running") {
              activeTurn.openTools.set(item.id, item);
              activeTurn.abortedTools.delete(item.id);
              emitSessionEvent(session, event);
              return;
            }
            activeTurn.openTools.delete(item.id);
            if (!detached) {
              activeTurn.ranForegroundTools = true;
              activeTurn.hasTrailingAssistantText = false;
            }
            session.compactor.noteStepBoundary();
            if (item.status === "failed" && isSyntheticTurnAbortToolError(item.error)) {
              // Hold SDK's synthetic turn-abort tool update until recovery/cancel/final-fail settles it.
              activeTurn.abortedTools.set(item.id, item);
              return;
            }
            activeTurn.abortedTools.delete(item.id);
            emitSessionEvent(session, event);
            return;
          } else if (item.type === "compaction" && item.status === "completed") {
            session.compactor.noteNativeCompactionCompleted();
          }
          emitSessionEvent(session, event);
          return;
        }

        if (event.type === "session.usage") {
          session.sawUsageSinceOpen = true;
          if (event.turnId === undefined) {
            if (!session.sentPromptSinceOpen) {
              session.compactor.noteReplayedUsage(event.usage.contextWindowUsedTokens);
              session.postLoadUsageWaiter?.settle();
            } else {
              session.compactor.noteBusinessModelUsage(event.usage.contextWindowUsedTokens);
            }
          }
          emitSessionEvent(session, {
            ...event,
            ...(event.turnId === attempt.attemptTurnId
              ? { turnId: activeTurn.publicTurnId }
              : {}),
          });
          return;
        }
      }

      // 5. Drop any late internal attempt/compaction turn envelopes after early settlement.
      if (
        event.type === "session.turn" &&
        (event.turnId.startsWith("acp:__attempt_") ||
          event.turnId.startsWith("acp:__internal_compact_"))
      ) {
        return;
      }
      if (
        event.type === "session.prompt_result" &&
        (event.clientMessageId.startsWith("__attempt_") ||
          event.clientMessageId.startsWith("__internal_compact_"))
      ) {
        return;
      }
      if (
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        (event.item.id.startsWith("__attempt_") ||
          event.item.id.startsWith("__internal_compact_"))
      ) {
        return;
      }

      // 6. Replay / post-ready / idle `session.usage` updates: only treat as cold replay
      // if no `session/prompt` has been sent to this child since open.
      if (event.type === "session.usage") {
        session.sawUsageSinceOpen = true;
        if (!session.sentPromptSinceOpen) {
          session.compactor.noteReplayedUsage(event.usage.contextWindowUsedTokens);
          session.postLoadUsageWaiter?.settle();
        } else if (event.turnId === undefined) {
          session.compactor.noteBusinessModelUsage(event.usage.contextWindowUsedTokens);
        }
      }

      emitSessionEvent(session, event);
    };

    inner.onEvent(handleInnerEvent);

    const openManagedSessionWithModelRecheck = async (
      input: Extract<ProviderInput, { type: "session.open" }>,
      priorClosingPromise: Promise<void> | null = null,
    ): Promise<void> => {
      // Synchronously register the new `ManagedSession` in `sessions` BEFORE awaiting
      // `priorClosingPromise` so an immediate `session.close` for `open-2` cancels `open-2`
      // instead of awaiting the already-closing `sessionA.closingPromise`.
      const openAbort = new AbortController();
      const session: ManagedSession = {
        sessionId: input.sessionId,
        externalOpenRequestId: input.requestId,
        currentConfig: input.config,
        latestConfigState: null,
        capabilities: inner.capabilities,
        nativeSessionId: decodeSavedSessionId(input.persistence, {
          storeDir: options.legacyStoreDir,
          env: launch.env,
        }),
        readyEmitted: false,
        openingBuffer: [],
        openAbort,
        reopenAbort: null,
        reopenPromise: null,
        activeOpenReqId: null,
        activeLifecycleOpen: null,
        waitingOnPriorClose: priorClosingPromise !== null,
        closingPromise: null,
        closedByHost: false,
        closedEmitted: false,
        innerOpen: false,
        innerDead: false,
        suppressInternalOpenClose: false,
        runtimeEpoch: 0,
        currentChild: null,
        inFlightPromptRpcIds: new Set(),
        sawUsageSinceOpen: false,
        sentPromptSinceOpen: false,
        postLoadUsageWaiter: null,
        compactor: new SessionCompactor({
          sessionEnv: input.config.env,
          launchEnv: launch.env,
          providerOptions: input.config.providerOptions,
          overrides: options.compaction,
        }),
        activeCompaction: null,
        activeTurn: null,
        queuedTurns: [],
        turnLane: Promise.resolve(),
        sequence: 0,
      };
      sessions.set(input.sessionId, session);

      const runOpenOnce = async (): Promise<void> => {
        if (session.closedByHost || connectionClosed || openAbort.signal.aborted) {
          throw new Error("Antigravity session open aborted");
        }
        session.openingBuffer = [];
        session.runtimeEpoch += 1;
        session.sawUsageSinceOpen = false;
        session.sentPromptSinceOpen = false;
        session.postLoadUsageWaiter?.settle();
        const internalReqId = `__open_${++session.sequence}_${input.requestId}`;
        session.activeOpenReqId = internalReqId;
        const readyPromise = new Promise<ProviderEvent>((resolve, reject) => {
          pendingInternalRequests.set(internalReqId, { resolve, reject });
        });
        await contextStore.run(
          {
            purpose: "session.open",
            session,
            sessionId: input.sessionId,
            cwd: input.config.cwd,
            env: input.config.env,
            signal: openAbort.signal,
          },
          () =>
            inner.send({
              ...input,
              requestId: internalReqId,
            }),
        );
        await awaitOpenReadyWithTimeout(session, internalReqId, readyPromise, openAbort.signal);
        session.innerOpen = true;
        session.innerDead = false;
        if (session.nativeSessionId && input.persistence && !session.sawUsageSinceOpen) {
          armPostLoadUsageWindow(session, postLoadUsageWindowMs);
        }
      };

      const openFlow = (async () => {
        try {
          if (priorClosingPromise) {
            await priorClosingPromise.catch(() => undefined);
          }
          session.waitingOnPriorClose = false;
          if (session.closedByHost || connectionClosed || openAbort.signal.aborted) {
            return;
          }
          try {
            await runOpenOnce();
          } catch (firstErr) {
            if (session.closedByHost || connectionClosed) {
              await session.currentChild?.close({ force: true }).catch(() => undefined);
              return;
            }
            const rawMsg =
              session.currentChild?.describeFailure(
                isRecord(firstErr) && typeof firstErr.message === "string"
                  ? firstErr.message
                  : String(firstErr),
              ) ??
              formatDiagnostic(
                isRecord(firstErr) && typeof firstErr.message === "string"
                  ? firstErr.message
                  : String(firstErr),
              );
            await session.currentChild?.close({ force: true }).catch(() => undefined);

            if (parseThinkingLevelRejection(rawMsg) !== null) {
              throw new ProviderActionError("INVALID_THINKING_LEVEL", rawMsg, rawMsg);
            }
            const rejection = parseModelRejection(rawMsg, input.config.model);
            if (!rejection) {
              throw new ProviderActionError(
                isRecord(firstErr) && typeof firstErr.code === "string" ? firstErr.code : "",
                rawMsg,
                rawMsg,
              );
            }

            // Model rejected during session.open: discard buffered replay from attempt 1 and re-probe once (`db19236`).
            session.openingBuffer = [];
            const checkDelay =
              options.recovery?.modelRejectionRetryDelayMs ?? MODEL_REJECTION_RETRY_DELAY_MS;
            if (checkDelay > 0) await abortableSleep(checkDelay, openAbort.signal);
            if (session.closedByHost || connectionClosed) return;

            let freshCatalog: ProviderCatalog | null = null;
            try {
              freshCatalog = await fetchCatalogWithResilience(input.config.cwd, {
                allowStale: false,
                countFailure: false,
                signal: openAbort.signal,
              });
            } catch {
              freshCatalog = null;
            }
            if (session.closedByHost || connectionClosed) return;

            if (freshCatalog && catalogOffersModel(freshCatalog, rejection.model)) {
              await runOpenOnce();
            } else {
              invalidateModel(rejection.model);
              const available = freshCatalog?.models.map((m) => m.id) ?? rejection.available;
              const invalidErr = buildInvalidModelError(rejection.model, available, rawMsg);
              throw new ProviderActionError(
                "INVALID_MODEL",
                invalidErr.message,
                invalidErr.diagnostic,
              );
            }
          }

          if (session.closedByHost || connectionClosed) {
            if (session.innerOpen) {
              const cleanupCloseId = `__close_after_aborted_open_${++session.sequence}`;
              session.suppressInternalOpenClose = true;
              await callInnerRequest(
                { type: "session.close", requestId: cleanupCloseId, sessionId: session.sessionId },
                { purpose: "session.close", session, sessionId: session.sessionId },
              ).catch(() => undefined);
              session.innerOpen = false;
            }
            await session.currentChild?.close({ force: true }).catch(() => undefined);
            return;
          }

          const buffered = session.openingBuffer ?? [];
          session.openingBuffer = null;
          session.openAbort = null;
          for (const bufferedEvent of buffered) {
            emitToHost(bufferedEvent);
          }
          session.readyEmitted = true;
          emitToHost({
            type: "session.ready",
            requestId: input.requestId,
            sessionId: input.sessionId,
          });
        } catch (error) {
          session.postLoadUsageWaiter?.settle();
          await session.currentChild?.close({ force: true }).catch(() => undefined);
          if (session.closedByHost || connectionClosed) {
            return;
          }
          if (sessions.get(input.sessionId) === session) {
            sessions.delete(input.sessionId);
          }
          launchRateGuard.clearSession(input.sessionId);
          const errPayload: ProviderError =
            error instanceof ProviderActionError
              ? {
                  ...(error.code ? { code: error.code } : {}),
                  message: error.message,
                  ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
                }
              : {
                  message: formatDiagnostic(error instanceof Error ? error.message : String(error)),
                };
          emitToHost({
            type: "request.failed",
            requestId: input.requestId,
            error: errPayload,
          });
        }
      })();

      const tracked = openFlow.then(
        () => undefined,
        () => undefined,
      );
      session.activeLifecycleOpen = tracked;
      try {
        await openFlow;
      } finally {
        if (session.activeLifecycleOpen === tracked) {
          session.activeLifecycleOpen = null;
        }
      }
    };

    const interruptManagedSession = async (
      session: ManagedSession,
      requestId: string,
      interruptOptions?: {
        suppressAck?: boolean;
        cancelCompaction?: boolean;
        keepQueued?: boolean;
      },
    ): Promise<void> => {
      session.compactor.clearIdleTimer();
      const cancelCompaction = interruptOptions?.cancelCompaction ?? true;
      if (!interruptOptions?.keepQueued) {
        for (const entry of session.queuedTurns) {
          entry.canceled = true;
        }
      }

      const activeTurn = session.activeTurn;
      const activeCompaction = cancelCompaction ? session.activeCompaction : null;

      if (!activeTurn && !activeCompaction) {
        // Idle cancel: complete cleanly without poisoning future turns.
        if (!interruptOptions?.suppressAck) {
          emitToHost({ type: "request.completed", requestId });
        }
        return;
      }

      const isExplicitInterrupt = !interruptOptions?.keepQueued;
      const isReopeningOrClosed =
        session.reopenPromise !== null || !session.innerOpen || session.innerDead;

      if (activeTurn) {
        activeTurn.cancelRequested = true;
        activeTurn.cancelAbort.abort();
        activeTurn.sleepAbort?.abort();
        session.postLoadUsageWaiter?.settle();
        // When an explicit Stop (`session.interrupt`) arrives while the session is inside
        // `ensureInnerSessionAlive` (not open yet, so `session/cancel` cannot be sent),
        // abort the pending reopen immediately instead of idling for `cancelFallbackTimeoutMs`.
        if (
          isExplicitInterrupt &&
          isReopeningOrClosed &&
          activeTurn.activeAttempt === null &&
          (cancelCompaction || !session.activeCompaction)
        ) {
          abortPendingSessionOpen(session, "Antigravity session reopen canceled", {
            killChild: true,
          });
        }
        // Arm a turn-level fallback deadline covering BOTH `ensureInnerSessionAlive` reopens
        // (`activeAttempt === null`) and in-flight ACP attempts (`activeAttempt !== null`).
        if (!activeTurn.cancelDeadline && (cancelCompaction || !session.activeCompaction)) {
          activeTurn.cancelDeadline = armCancelDeadline(() => {
            abortPendingSessionOpen(session, "Antigravity session reopen canceled", {
              killChild: true,
            });
            activeTurn.activeAttempt?.resolve({ state: "canceled", processExited: true });
          });
        }
      }

      if (activeCompaction) {
        activeCompaction.cancelRequested = true;
        if (isExplicitInterrupt && isReopeningOrClosed) {
          abortPendingSessionOpen(session, "Antigravity compaction reopen canceled", {
            killChild: true,
          });
        }
        if (!activeCompaction.cancelDeadline) {
          activeCompaction.cancelDeadline = armCancelDeadline(() => {
            abortPendingSessionOpen(session, "Antigravity compaction reopen canceled", {
              killChild: true,
            });
            activeCompaction.resolveOutcome("canceled");
          });
        }
      }

      const attempt = activeTurn?.activeAttempt ?? null;
      if (attempt && !attempt.innerTurnStarted) {
        // Ensure AcpRuntime.prompt has registered `this.activePrompt` before `interrupt()` runs.
        await Promise.race([attempt.innerStartedOrSettled, abortableSleep(50)]);
      }

      if (
        (activeTurn?.activeAttempt !== null || activeCompaction !== null) &&
        session.innerOpen &&
        !session.innerDead
      ) {
        const internalInterruptId = `__interrupt_${++session.sequence}`;
        await callInnerRequest(
          {
            type: "session.interrupt",
            requestId: internalInterruptId,
            sessionId: session.sessionId,
          },
          { purpose: "session.interrupt", session, sessionId: session.sessionId },
        ).catch(() => undefined);
      }

      if (activeTurn) {
        await activeTurn.done;
      }
      if (activeCompaction) {
        await activeCompaction.promise;
      }

      if (!interruptOptions?.suppressAck) {
        emitToHost({ type: "request.completed", requestId });
      }
    };

    return {
      version: inner.version,
      capabilities: inner.capabilities,
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async send(input: ProviderInput): Promise<void> {
        if (connectionClosed) {
          throw new Error("ACP provider connection is closed");
        }

        if (input.type === "catalog") {
          requireProviderCapabilities(inner.capabilities, input);
          void fetchCatalogWithResilience(input.cwd).then(
            (catalog) => {
              emitToHost({
                type: "catalog",
                requestId: input.requestId,
                catalog: excludeRejectedModels(catalog, catalogState.rejected),
              });
            },
            (error) => {
              const message = formatDiagnostic(
                error instanceof Error ? error.message : String(error),
              );
              emitToHost({
                type: "request.failed",
                requestId: input.requestId,
                error: {
                  ...(error instanceof ProviderActionError ? { code: error.code } : {}),
                  message,
                  diagnostic: message,
                },
              });
            },
          );
          return;
        }

        if (input.type === "sessions") {
          requireProviderCapabilities(inner.capabilities, input);
          await contextStore.run({ purpose: "sessions", cwd: input.cwd }, () => inner.send(input));
          return;
        }

        if (input.type === "session.open") {
          const existing = sessions.get(input.sessionId);
          if (existing && !existing.closedByHost) {
            throw new Error(`Session already exists: ${input.sessionId}`);
          }
          requireProviderCapabilities(inner.capabilities, input);
          void openManagedSessionWithModelRecheck(input, existing?.closingPromise ?? null);
          return;
        }

        if (!("sessionId" in input)) {
          await inner.send(input);
          return;
        }

        const session = sessions.get(input.sessionId);
        if (!session || (session.closedByHost && input.type !== "session.close")) {
          throw new Error(`Unknown session: ${input.sessionId}`);
        }
        requireProviderCapabilities(session.capabilities, input);

        if (input.type === "session.prompt") {
          if (input.prompt.delivery === "steer") {
            if (!session.activeTurn || session.activeTurn.recovering || !session.innerOpen) {
              emitToHost({
                type: "session.prompt_result",
                sessionId: session.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: {
                  type: "failed",
                  error: {
                    message: "ACP session can only steer while waiting on deferred background tools",
                  },
                },
              });
              return;
            }
            await inner.send(input);
            return;
          }

          for (const queued of session.queuedTurns) {
            queued.canceled = true;
          }
          const queuedEntry: QueuedTurnEntry = { prompt: input.prompt, canceled: false };
          session.queuedTurns.push(queuedEntry);

          // If a previous turn is active:
          // - Only if inner has crossed `end_turn` into deferred background-tool wait, resolve
          //   it as `completed` so running background tools stay alive into the follow-up turn.
          // - Otherwise (starting, running on wire, waiting on compaction, or in recovery sleep),
          //   interrupt and cancel it immediately before starting the replacement turn.
          if (isDeferredBackgroundToolWait(session)) {
            session.activeTurn?.activeAttempt?.resolve({
              state: "completed",
              processExited: false,
            });
          } else if (session.activeTurn) {
            const cancelReq = `__replace_${++session.sequence}`;
            void interruptManagedSession(session, cancelReq, {
              suppressAck: true,
              cancelCompaction: false,
              keepQueued: true,
            }).catch(() => undefined);
          }

          const nextTurn = session.turnLane.then(async () => {
            const idx = session.queuedTurns.indexOf(queuedEntry);
            if (idx >= 0) session.queuedTurns.splice(idx, 1);
            if (queuedEntry.canceled || session.closedByHost || connectionClosed) {
              if (!session.closedEmitted) {
                const canceledTurnId = `acp:${queuedEntry.prompt.clientMessageId}`;
                emitToHost({
                  type: "timeline.item",
                  sessionId: session.sessionId,
                  item: {
                    type: "user_message",
                    id: queuedEntry.prompt.clientMessageId,
                    text: promptDisplayText(queuedEntry.prompt),
                    clientMessageId: queuedEntry.prompt.clientMessageId,
                  },
                });
                emitToHost({
                  type: "session.prompt_result",
                  sessionId: session.sessionId,
                  clientMessageId: queuedEntry.prompt.clientMessageId,
                  result: { type: "turn", turnId: canceledTurnId },
                });
                emitToHost({
                  type: "session.turn",
                  sessionId: session.sessionId,
                  turnId: canceledTurnId,
                  state: "started",
                });
                emitToHost({
                  type: "session.turn",
                  sessionId: session.sessionId,
                  turnId: canceledTurnId,
                  state: "canceled",
                });
              }
              return;
            }
            await runForegroundPrompt(session, queuedEntry.prompt);
          });
          session.turnLane = nextTurn.catch(() => undefined);
          return;
        }

        if (input.type === "session.interrupt") {
          void interruptManagedSession(session, input.requestId);
          return;
        }

        if (input.type === "session.configure") {
          void (async () => {
            try {
              if (session.activeCompaction) {
                await session.activeCompaction.promise;
              }
              if (session.closedByHost || connectionClosed) return;
              await ensureInnerSessionAlive(session);
              if (session.closedByHost || connectionClosed) return;
              const internalCfgId = `__cfg_${++session.sequence}_${input.requestId}`;
              await callInnerRequest(
                { ...input, requestId: internalCfgId },
                {
                  purpose: "session.configure",
                  session,
                  sessionId: session.sessionId,
                  cwd: session.currentConfig.cwd,
                  env: session.currentConfig.env,
                },
              );
              emitToHost({ type: "request.completed", requestId: input.requestId });
            } catch (err) {
              if (session.closedByHost || connectionClosed) return;
              const rawMsg =
                session.currentChild?.describeFailure(
                  isRecord(err) && typeof err.message === "string" ? err.message : String(err),
                ) ??
                (isRecord(err) && typeof err.message === "string"
                  ? err.message
                  : formatDiagnostic(String(err)));
              if (parseThinkingLevelRejection(rawMsg) !== null) {
                emitToHost({
                  type: "request.failed",
                  requestId: input.requestId,
                  error: {
                    code: "INVALID_THINKING_LEVEL",
                    message: formatDiagnostic(rawMsg),
                    diagnostic: sanitizeDiagnosticText(rawMsg),
                  },
                });
                return;
              }
              const rejection = parseModelRejection(rawMsg, input.changes.model ?? undefined);
              if (rejection) {
                invalidateModel(rejection.model);
                emitToHost({
                  type: "request.failed",
                  requestId: input.requestId,
                  error: buildInvalidModelError(rejection.model, rejection.available, rawMsg),
                });
                return;
              }
              emitToHost({
                type: "request.failed",
                requestId: input.requestId,
                error: {
                  ...(isRecord(err) && typeof err.code === "string" ? { code: err.code } : {}),
                  message: formatDiagnostic(rawMsg),
                  diagnostic: sanitizeDiagnosticText(rawMsg),
                },
              });
            }
          })();
          return;
        }

        if (input.type === "session.close") {
          if (session.closingPromise) {
            await session.closingPromise;
            emitToHost({ type: "request.completed", requestId: input.requestId });
            return;
          }

          const closeTask = (async () => {
            session.closedByHost = true;
            session.suppressInternalOpenClose = true;
            session.postLoadUsageWaiter?.settle();
            session.compactor.clearIdleTimer();
            for (const queued of session.queuedTurns) {
              queued.canceled = true;
            }
            if (session.activeTurn) {
              session.activeTurn.cancelRequested = true;
              session.activeTurn.cancelAbort.abort();
              session.activeTurn.sleepAbort?.abort();
              clearCancelDeadline(session.activeTurn.cancelDeadline);
              session.activeTurn.cancelDeadline = null;
              clearCancelDeadline(session.activeTurn.activeAttempt?.cancelDeadline ?? null);
              session.activeTurn.activeAttempt?.resolve({ state: "canceled", processExited: true });
            }
            if (session.activeCompaction) {
              session.activeCompaction.cancelRequested = true;
              clearCancelDeadline(session.activeCompaction.cancelDeadline);
              session.activeCompaction.cancelDeadline = null;
              session.activeCompaction.resolveOutcome("canceled");
            }
            abortPendingSessionOpen(session, "Antigravity session closed", { killChild: true });

            if (session.activeLifecycleOpen) {
              await Promise.race([
                session.activeLifecycleOpen,
                abortableSleep(cancelFallbackTimeoutMs),
              ]);
            }

            await Promise.race([
              session.turnLane,
              abortableSleep(cancelFallbackTimeoutMs),
            ]);

            if (session.innerOpen) {
              const internalCloseId = `__close_${++session.sequence}`;
              session.suppressInternalOpenClose = true;
              await Promise.race([
                callInnerRequest(
                  {
                    type: "session.close",
                    requestId: internalCloseId,
                    sessionId: session.sessionId,
                  },
                  { purpose: "session.close", session, sessionId: session.sessionId },
                ).catch(() => undefined),
                abortableSleep(cancelFallbackTimeoutMs),
              ]);
              if (pendingInternalRequests.delete(internalCloseId)) {
                markInternalRequestIntercepted(internalCloseId);
              }
              session.innerOpen = false;
            }

            await session.currentChild?.close({ force: true }).catch(() => undefined);
            if (pendingAbortedCleanups.size > 0) {
              await Promise.race([
                Promise.all([...pendingAbortedCleanups]),
                abortableSleep(cancelFallbackTimeoutMs),
              ]);
            }
            if (sessions.get(session.sessionId) === session) {
              sessions.delete(session.sessionId);
              launchRateGuard.clearSession(session.sessionId);
            }
          })();

          session.closingPromise = closeTask;
          await closeTask;
          if (!session.closedEmitted) {
            session.closedEmitted = true;
            emitToHost({ type: "session.closed", sessionId: session.sessionId });
          }
          emitToHost({ type: "request.completed", requestId: input.requestId });
          return;
        }

        await inner.send(input);
      },
      async close(): Promise<void> {
        if (closeConnectionPromise) return closeConnectionPromise;
        connectionClosed = true;
        closeConnectionPromise = (async () => {
          for (const session of sessions.values()) {
            session.closedByHost = true;
            session.postLoadUsageWaiter?.settle();
            session.compactor.clearIdleTimer();
            for (const queued of session.queuedTurns) {
              queued.canceled = true;
            }
            if (session.activeTurn) {
              session.activeTurn.cancelRequested = true;
              session.activeTurn.cancelAbort.abort();
              session.activeTurn.sleepAbort?.abort();
              clearCancelDeadline(session.activeTurn.cancelDeadline);
              session.activeTurn.cancelDeadline = null;
              clearCancelDeadline(session.activeTurn.activeAttempt?.cancelDeadline ?? null);
              session.activeTurn.activeAttempt?.resolve({ state: "canceled", processExited: true });
            }
            if (session.activeCompaction) {
              session.activeCompaction.cancelRequested = true;
              clearCancelDeadline(session.activeCompaction.cancelDeadline);
              session.activeCompaction.cancelDeadline = null;
              session.activeCompaction.resolveOutcome("canceled");
            }
            abortPendingSessionOpen(session, "ACP provider connection closed", { killChild: true });
          }

          for (const [, pending] of pendingInternalRequests) {
            pending.reject({
              message: "ACP provider connection closed",
              diagnostic: "ACP provider connection closed",
            });
          }
          pendingInternalRequests.clear();

          // Kill all active/spawning child processes BEFORE awaiting `inner.close()` so hung
          // `session/new`, `session/load`, or `session/set_config_option` calls unblock immediately.
          await Promise.all([
            ...[...activeChildren].map((child) =>
              child.close({ force: true }).catch(() => undefined),
            ),
            ...[...sessions.values()].map((session) =>
              session.currentChild?.close({ force: true }).catch(() => undefined),
            ),
            ...[...pendingAbortedCleanups],
            (lastUtilityChild as OwnedAcpChild | null)?.close({ force: true }).catch(() => undefined),
          ]);

          await Promise.race([
            inner.close().catch(() => undefined),
            abortableSleep(cancelFallbackTimeoutMs),
          ]);
          sessions.clear();
          listeners.clear();
        })();
        return closeConnectionPromise;
      },
    };
  }

  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    description:
      "Resilient Antigravity (agy acp) provider with automatic context compaction, bounded transient recovery, legacy session compatibility, and CLI quota reporting.",
    icon: "icon.svg",
    command: defaultAgyCommand(),
    docsUrl: "https://paseo.sh/docs/supported-providers/antigravity#troubleshooting",
    installation: {
      installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
      async inspect({ launch, signal }) {
        if (!launch?.resolved) return { status: "not_installed" };
        const version = await readAgyVersion(launch, signal).catch(() => undefined);
        return version ? { status: "installed", version } : { status: "installed" };
      },
    },
    async getCatalogCacheKey(catalogOpts) {
      const launch = resolveEffectiveLaunch(catalogOpts.launch);
      return computeCatalogCacheKey(launch, now());
    },
    async status({ launch }) {
      if (!launch) {
        return {
          available: false,
          diagnostic: `Install Antigravity ${minAgyVersion} or later.`,
        };
      }
      const effectiveLaunch = resolveEffectiveLaunch(launch);
      const signIn = describeSignIn(effectiveLaunch.env);

      // Check `--version` when `acp` is present and check fails or reports an older CLI,
      // while still running the ACP initialize handshake to verify ACP + sign-in readiness.
      try {
        const connection = await connectInternal(
          {
            launch: effectiveLaunch,
            versions: [PROVIDER_PROTOCOL_VERSION],
            capabilities: [],
          },
          { skipConnectRetry: false },
        );
        await connection.close();
        return { available: true, diagnostic: signIn };
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        if (
          (error instanceof ProviderActionError && error.code === "LAUNCH_RATE_LIMITED") ||
          /refusing to launch it again/i.test(raw)
        ) {
          return {
            available: false,
            diagnostic: `${sanitizeDiagnosticText(raw)}\n${signIn}`,
          };
        }
        if (/is unsupported\. Update agy/i.test(raw)) {
          return {
            available: false,
            diagnostic: `${raw}\n${signIn}`,
          };
        }
        // Also check `agy --version` in case ACP subcommand is missing or outdated (<1.5.15).
        const version = await readAgyVersion(effectiveLaunch).catch(() => undefined);
        if (version && parseSemver(version) && !isSupportedAgyVersion(version, minAgyVersion)) {
          return {
            available: false,
            diagnostic: `${unsupportedVersionMessage(version)}\n${signIn}`,
          };
        }
        if (isPermanentAuthError(raw)) {
          return {
            available: false,
            diagnostic: `${formatDiagnostic(raw)}\n${signIn}`,
          };
        }
        if (isQuotaExhaustedError(raw)) {
          return {
            available: false,
            diagnostic: `${sanitizeDiagnosticText(raw)}\n${signIn}`,
          };
        }
        return {
          available: false,
          diagnostic: `Antigravity ACP did not start. Install Antigravity ${minAgyVersion} or later. If you override the command, include the acp subcommand.\n${signIn}`,
        };
      }
    },
    connect(request) {
      return connectInternal(request);
    },
  };
}

export const antigravityResilientProvider = createAntigravityResilientProvider();
export type { ProviderModel };
