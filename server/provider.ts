import {
  negotiateProviderCapabilities,
  PROVIDER_CAPABILITIES,
  PROVIDER_PROTOCOL_VERSION,
  requireProviderCapabilities,
  type ProviderDefinition,
  type ProviderEvent,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import {
  createModelAvailability,
  DEFAULT_MODE,
  DISCOVERY_TIMEOUT_MS,
  getCatalog,
  getCatalogCacheKey,
  MODES,
  SUPPORTED_CAPABILITIES,
  type ProviderDiscovery,
} from "./internal/catalog.ts";
import { LAUNCH_RETRY_DELAYS_MS, probe } from "./internal/process.ts";
import { Session } from "./internal/session.ts";
import {
  isAbortError,
  OperationSignal,
  ProviderActionError,
} from "./internal/signals.ts";
import { diagnostic } from "./internal/wire.ts";

export const PROVIDER_ID = "antigravity-resilient";
export const PLUGIN_ID = "antigravity-resilient-provider";

function failRequest(
  emit: (event: ProviderEvent) => void,
  requestId: string,
  error: unknown,
): void {
  if (error instanceof ProviderActionError) {
    emit({
      type: "request.failed",
      requestId,
      error: {
        code: error.code,
        message: error.message,
        ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
      },
    });
    return;
  }

  const message = diagnostic(
    error instanceof Error ? error.message : String(error),
  );
  emit({
    type: "request.failed",
    requestId,
    error: { message, diagnostic: message },
  });
}

type StatusResult = Awaited<ReturnType<NonNullable<ProviderDefinition["status"]>>>;

/** One `agy --version` check. `transient` marks failures worth re-checking. */
async function checkAgyVersionOnce(
  run: typeof probe,
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
): Promise<StatusResult & { transient?: boolean }> {
  try {
    const result = await run(command, [...args, "--version"], env, DISCOVERY_TIMEOUT_MS);
    if (result.timedOut) {
      return { available: false, transient: true, diagnostic: "Antigravity CLI version check timed out" };
    }
    if (result.exitCode !== 0) {
      return {
        available: false,
        transient: true,
        diagnostic: diagnostic(
          result.stderr.trim() ||
            result.stdout.trim() ||
            `agy --version exited with code ${result.exitCode ?? "unknown"}`,
        ),
      };
    }
    const version = result.stdout.trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      return {
        available: false,
        diagnostic: "Could not read the Antigravity version. Update agy to 1.1.15 or later.",
      };
    }
    const [major, minor, patch] = version.split(".").map(Number);
    if (!(major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 15))))) {
      return {
        available: false,
        diagnostic: `Antigravity ${version} is unsupported. Update agy to 1.1.15 or later.`,
      };
    }
    return { available: true, diagnostic: version };
  } catch (error) {
    return {
      available: false,
      transient: true,
      diagnostic: diagnostic(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * The daemon asks for status before every resume, command list and timeline
 * fetch, and treats one failure as "provider unavailable". agy self-updates
 * by swapping its binary in place, so a single failed check is re-run before
 * it is reported.
 */
export async function checkAgyStatus(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  options: { probe?: typeof probe; retryDelaysMs?: readonly number[] } = {},
): Promise<StatusResult> {
  const run = options.probe ?? probe;
  const delays = options.retryDelaysMs ?? LAUNCH_RETRY_DELAYS_MS;
  // A slow check already costs up to DISCOVERY_TIMEOUT_MS; don't stack many.
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS + 10_000;
  for (let i = 0; ; i += 1) {
    const { transient, ...result } = await checkAgyVersionOnce(run, command, args, env);
    if (result.available || !transient || i >= delays.length || Date.now() >= deadline) return result;
    console.warn(
      `[antigravity-resilient] agy --version check failed (${result.diagnostic}); re-checking in ${delays[i]}ms`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, delays[i]));
  }
}

export const antigravityResilientProvider: ProviderDefinition = {
  id: PROVIDER_ID,
  label: "Antigravity (Resilient)",
  description:
    "Resilient Antigravity (agy) provider with durable transcript replay across restarts and bounded recovery for OAuth 401 refresh races, sticky stream-interruption errors, and catalog timeouts.",
  command: ["agy"],
  icon: "icon.svg",

  async status(ctx) {
    if (!ctx.launch) {
      return {
        available: false,
        diagnostic:
          "agy not found on PATH. Install Antigravity, then run `agy` and sign in.",
      };
    }
    return checkAgyStatus(ctx.launch.command, ctx.launch.args, ctx.launch.env);
  },

  getCatalogCacheKey(ctx) {
    if (!ctx.launch) {
      return undefined;
    }
    return getCatalogCacheKey(
      ctx.launch.command,
      ctx.launch.args,
      ctx.launch.env,
    );
  },

  connect(ctx) {
    const supportsV1 = Array.isArray(ctx.versions)
      ? ctx.versions.includes(1)
      : ctx.protocolVersion === PROVIDER_PROTOCOL_VERSION;
    if (!supportsV1) {
      throw new Error(
        `Unsupported provider protocol version ${
          ctx.protocolVersion ?? JSON.stringify(ctx.versions)
        }`,
      );
    }
    if (!ctx.launch) {
      throw new ProviderActionError(
        "MISSING_LAUNCH",
        "The daemon must supply the Antigravity launch",
      );
    }

    const negotiatedCapabilities = negotiateProviderCapabilities(
      ctx.capabilities.length > 0 ? ctx.capabilities : PROVIDER_CAPABILITIES,
      SUPPORTED_CAPABILITIES,
    );
    const command = ctx.launch.command;
    const args = ctx.launch.args;
    const env = ctx.launch.env;
    const sessions = new Map<string, Session>();
    const pendingCatalogRequests = new Map<string, OperationSignal>();
    const listeners = new Set<(event: ProviderEvent) => void>();
    if (typeof ctx.emit === "function") {
      listeners.add(ctx.emit);
    }
    let discovered: ProviderDiscovery | null = null;
    let closed = false;
    const modelAvailability = createModelAvailability(ctx.host, command, args, env, {
      get: () => discovered,
      set: (next) => {
        if (!closed) discovered = next;
      },
    });

    const emit = (event: ProviderEvent): void => {
      if (closed) {
        return;
      }
      for (const listener of listeners) {
        listener(event);
      }
    };

    const validateSelection = async (
      model: string,
    ): Promise<string | undefined> => {
      if (discovered === null) {
        discovered = await getCatalog(ctx.host, command, args, env);
      }
      const trimmed = model.trim();
      if (!trimmed) {
        return discovered.defaultModel;
      }
      if (!discovered.models.some((entry) => entry.id === trimmed)) {
        // Re-probe once bypassing cache in case `agy` added new models (e.g. gemini-4-argon-high).
        discovered = await getCatalog(ctx.host, command, args, env, {
          bypassCache: true,
          fallbackCatalog: discovered,
        });
      }
      if (
        discovered.models.length > 0 &&
        !discovered.models.some((entry) => entry.id === trimmed)
      ) {
        throw new ProviderActionError(
          "INVALID_MODEL",
          `Unknown Antigravity model: ${trimmed}`,
        );
      }
      return trimmed;
    };

    return {
      version: 1,
      capabilities: negotiatedCapabilities,

      onEvent(listener: (event: ProviderEvent) => void): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },

      async send(input: ProviderInput): Promise<void> {
        if (closed) {
          throw new Error("Antigravity provider connection is closed");
        }
        requireProviderCapabilities(negotiatedCapabilities, input);

        switch (input.type) {
          case "catalog": {
            const signal = new OperationSignal();
            pendingCatalogRequests.set(input.requestId, signal);
            try {
              discovered = await getCatalog(ctx.host, command, args, env, {
                fallbackCatalog: discovered,
                signal: signal.signal,
              });
              if (closed || signal.aborted) {
                return;
              }
              emit({
                type: "catalog",
                requestId: input.requestId,
                catalog: discovered,
              });
              if (typeof ctx.emit === "function") {
                emit({
                  type: "request.completed",
                  requestId: input.requestId,
                });
              }
            } catch (error) {
              if (closed || signal.aborted || isAbortError(error)) {
                return;
              }
              failRequest(emit, input.requestId, error);
            } finally {
              pendingCatalogRequests.delete(input.requestId);
            }
            return;
          }

          case "session.open": {
            try {
              if (sessions.has(input.sessionId)) {
                throw new ProviderActionError(
                  "SESSION_EXISTS",
                  `Session already open: ${input.sessionId}`,
                );
              }
              if (discovered === null) {
                discovered = await getCatalog(ctx.host, command, args, env);
              }
              const model = await validateSelection(input.config.model ?? "");
              const mode = input.config.mode?.trim() || DEFAULT_MODE;
              if (!MODES.some((entry) => entry.id === mode)) {
                throw new ProviderActionError(
                  "INVALID_MODE",
                  `Unknown Antigravity mode: ${mode}`,
                );
              }
              const session = new Session(
                input.sessionId,
                command,
                args,
                env,
                { ...input.config, model, mode },
                input.persistence,
                discovered,
                emit,
                { modelAvailability },
              );
              sessions.set(input.sessionId, session);
              session.open(
                input.requestId,
                negotiatedCapabilities,
                input.history,
              );
            } catch (error) {
              failRequest(emit, input.requestId, error);
            }
            return;
          }

          case "session.configure": {
            const session = sessions.get(input.sessionId);
            if (!session) {
              failRequest(
                emit,
                input.requestId,
                new ProviderActionError(
                  "SESSION_NOT_FOUND",
                  `Unknown Antigravity session: ${input.sessionId}`,
                ),
              );
              return;
            }
            try {
              await session.configure(
                input.requestId,
                input.changes,
                validateSelection,
              );
            } catch (error) {
              failRequest(emit, input.requestId, error);
            }
            return;
          }

          case "session.prompt": {
            const session = sessions.get(input.sessionId);
            if (!session) {
              emit({
                type: "session.prompt_result",
                sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: {
                  type: "failed",
                  error: {
                    code: "SESSION_NOT_FOUND",
                    message: `Unknown Antigravity session: ${input.sessionId}`,
                  },
                },
              });
              return;
            }
            await session.prompt(input.prompt);
            return;
          }

          case "session.interrupt": {
            const session = sessions.get(input.sessionId);
            if (!session) {
              failRequest(
                emit,
                input.requestId,
                new ProviderActionError(
                  "SESSION_NOT_FOUND",
                  `Unknown Antigravity session: ${input.sessionId}`,
                ),
              );
              return;
            }
            await session.interrupt(input.requestId);
            return;
          }

          case "session.close": {
            const session = sessions.get(input.sessionId);
            sessions.delete(input.sessionId);
            if (!session) {
              emit({
                type: "request.completed",
                requestId: input.requestId,
              });
              return;
            }
            await session.close(input.requestId);
            return;
          }

          default: {
            const requestId =
              "requestId" in input && typeof input.requestId === "string"
                ? input.requestId
                : null;
            if (requestId) {
              failRequest(
                emit,
                requestId,
                new ProviderActionError(
                  "UNSUPPORTED_ACTION",
                  `Antigravity provider does not support ${input.type}`,
                ),
              );
            }
            return;
          }
        }
      },

      async close(): Promise<void> {
        closed = true;
        for (const signal of pendingCatalogRequests.values()) {
          signal.abort();
        }
        pendingCatalogRequests.clear();
        await Promise.all(
          [...sessions.values()].map((session) => session.dispose()),
        );
        sessions.clear();
        listeners.clear();
      },
    };
  },
};
