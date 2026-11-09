import type {
  ProviderCapability,
  ProviderCatalog,
  ProviderCatalogMode,
  ProviderCatalogModel,
  ProviderHost,
} from "@getpaseo/plugin/server/provider";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { probe } from "./process.ts";
import { ProviderActionError } from "./signals.ts";
import { diagnostic } from "./wire.ts";

export type ProviderDiscovery = ProviderCatalog;

export const DEFAULT_MODE = "full-access";
export const DISCOVERY_TIMEOUT_MS = 20_000;
// `agy models` may perform silent authentication and network discovery. Give
// it the same startup allowance as a conversation, while --version stays fast.
export const MODEL_DISCOVERY_TIMEOUT_MS = 90_000;
export const DISCOVERY_RETRY_DELAY_MS = 1_500;
// agy's model list is server-driven and changes without a binary update (a
// model can be withdrawn and restored the same day), so a catalogue is only
// trusted this long. The daemon keeps its own copy per catalogue key and
// re-reads the key on every warm-up, so the key carries the TTL window.
export const CATALOG_TTL_MS = 30 * 60_000;

export const SUPPORTED_CAPABILITIES: ProviderCapability[] = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "session.persistence",
  "session.configure",
];

export const MODES: ProviderCatalogMode[] = [
  {
    id: "full-access",
    label: "Full access",
    description:
      "Antigravity cannot ask for permission when another app drives it. Paseo starts it with --dangerously-skip-permissions.",
    icon: "ShieldOff",
    colorTier: "dangerous",
    isUnattended: true,
  },
];

export function resolveCommandFingerprint(
  command: string,
  env?: Record<string, string>,
): string {
  const candidates: string[] = [];
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    candidates.push(command);
  } else {
    const pathEnv = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? "";
    const dirs = pathEnv.split(path.delimiter).filter(Boolean);
    const exts =
      process.platform === "win32"
        ? ["", ".cmd", ".exe", ".bat"]
        : [""];
    for (const dir of dirs) {
      for (const ext of exts) {
        candidates.push(path.join(dir, `${command}${ext}`));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) {
        return `${candidate}:${Math.trunc(stat.mtimeMs)}:${stat.size}`;
      }
    } catch {
      // Continue searching candidates.
    }
  }
  return command;
}

function launchIdentity(
  command: string,
  args: string[],
  env?: Record<string, string>,
): string {
  const fingerprint = resolveCommandFingerprint(command, env);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "antigravity-resilient-v2",
        command,
        fingerprint,
        args,
        Object.entries(env ?? {}).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ]),
    )
    .digest("hex");
}

type CatalogState = {
  /** Bumped whenever agy rejects a model the catalogue still listed. */
  generation: number;
  /** Models agy rejected since the last successful `agy models`. */
  rejected: Set<string>;
  lastGood: ProviderDiscovery | null;
};

const catalogStates = new Map<string, CatalogState>();

function catalogState(identity: string): CatalogState {
  let state = catalogStates.get(identity);
  if (!state) {
    state = { generation: 0, rejected: new Set(), lastGood: null };
    catalogStates.set(identity, state);
  }
  return state;
}

/**
 * Changes when the agy binary changes, when the TTL window rolls over, and
 * when a model is invalidated, so neither the daemon's catalogue nor the host
 * cache outlives what agy currently offers.
 */
export function getCatalogCacheKey(
  command: string,
  args: string[],
  env?: Record<string, string>,
  now: number = Date.now(),
): string {
  const identity = launchIdentity(command, args, env);
  const { generation } = catalogState(identity);
  return createHash("sha256")
    .update(JSON.stringify([identity, Math.floor(now / CATALOG_TTL_MS), generation]))
    .digest("hex");
}

/**
 * Records that agy refused `model`: the next catalogue key differs, and any
 * fallback catalogue omits the model until `agy models` lists it again.
 */
export function invalidateModel(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  model: string,
): void {
  const state = catalogState(launchIdentity(command, args, env));
  state.generation += 1;
  state.rejected.add(model);
}

/** Drops `models` from a catalogue, moving the default if it was dropped. */
export function excludeModels(
  catalog: ProviderDiscovery,
  models: Iterable<string>,
): ProviderDiscovery {
  const drop = new Set(models);
  if (!catalog.models.some((model) => drop.has(model.id))) {
    return catalog;
  }
  const kept = catalog.models.filter((model) => !drop.has(model.id));
  const defaultModel =
    catalog.defaultModel && !drop.has(catalog.defaultModel)
      ? catalog.defaultModel
      : kept[0]?.id;
  return {
    ...catalog,
    models: kept.map((model) => ({ ...model, isDefault: model.id === defaultModel })),
    defaultModel,
  };
}

/** Marks a catalogue served after `agy models` failed as possibly outdated. */
function markStale(catalog: ProviderDiscovery): ProviderDiscovery {
  return {
    ...catalog,
    models: catalog.models.map((model) => ({
      ...model,
      metadata: { ...model.metadata, catalogStale: true },
    })),
  };
}

/**
 * agy rejects an unknown `--model` before starting a conversation and exits
 * with code 1. The turn error recorded by the daemon in the 2026-11-09
 * incident (agy 1.1.x) was, verbatim:
 *
 *   invalid model selection (--model "gemini-4-argon-high" --effort ""): model gemini-4-argon-high is not recognized as a known model or custom model in settings
 *   Available models:
 *     Gemini 3.8 Flash (High)
 *     ...
 *
 * The indentation survived, so it arrived as one failed-result error string
 * (the stderr path trims each line); stderr is parsed the same way in case a
 * build prints it there. The list holds display labels, not ids. Returns
 * null for any other text.
 */
export function parseInvalidModelSelection(
  text: string,
): { model: string; available: string[] } | null {
  const match =
    /invalid model selection \(--model "([^"]*)"[^)]*\): model (\S+) is not recognized as a known model/u.exec(
      text,
    );
  if (!match) {
    return null;
  }
  const available: string[] = [];
  const listStart = text.indexOf("Available models:", match.index);
  if (listStart >= 0) {
    const lines = text.slice(listStart).split(/\r?\n/u).slice(1);
    const indented = /^\s/u.test(lines[0] ?? "");
    for (const line of lines) {
      if (!line.trim() || (indented && !/^\s/u.test(line)) || /:\s*$/u.test(line)) break;
      available.push(line.trim());
    }
  }
  return { model: match[1] || match[2], available };
}

/** gRPC NOT_FOUND as agy reports it in a failed result. */
export function isNotFoundError(text: string): boolean {
  return /\bNOT_FOUND \(code 404\)/u.test(text);
}

/**
 * Input token limit per model family. `agy models` reports only ids and
 * labels, so the window is derived from the family name; a session can
 * override it with `providerOptions.contextWindowMaxTokens`.
 *
 * Gemini's own limit is 1M, but agy runs every conversation in its default
 * `256K` context-window preset (`512K`/`900K` are paid upgrades in the model
 * selector) and checkpoints natively at ~230-250K, so 256K is what the
 * meter should measure against.
 */
export const AGY_DEFAULT_CONTEXT_WINDOW_TOKENS = 262_144;

const FAMILY_CONTEXT_WINDOWS: ReadonlyArray<{
  pattern: RegExp;
  maxTokens: number;
}> = [
  { pattern: /^gemini-/iu, maxTokens: AGY_DEFAULT_CONTEXT_WINDOW_TOKENS },
  { pattern: /^claude-/iu, maxTokens: 200_000 },
  { pattern: /^gpt-oss-/iu, maxTokens: 131_072 },
];

export const DEFAULT_CONTEXT_WINDOW_MAX_TOKENS = AGY_DEFAULT_CONTEXT_WINDOW_TOKENS;

export function resolveContextWindowMaxTokens(model: string | undefined): number {
  const id = model?.trim() ?? "";
  for (const entry of FAMILY_CONTEXT_WINDOWS) {
    if (entry.pattern.test(id)) {
      return entry.maxTokens;
    }
  }
  return DEFAULT_CONTEXT_WINDOW_MAX_TOKENS;
}

/**
 * Fills in `contextWindowMaxTokens` for models that do not carry one, so the
 * daemon can advertise a window even for catalogues cached by older builds.
 * Explicit values (from `agy` or a hand-written catalogue) win.
 */
export function withContextWindows(
  models: ProviderCatalogModel[],
): ProviderCatalogModel[] {
  return models.map((model) =>
    typeof model.contextWindowMaxTokens === "number" &&
    model.contextWindowMaxTokens > 0
      ? model
      : {
          ...model,
          contextWindowMaxTokens: resolveContextWindowMaxTokens(model.id),
        },
  );
}

export function parseModels(stdout: string): ProviderCatalogModel[] {
  const seen = new Set<string>();
  const models: ProviderCatalogModel[] = [];

  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || !line.includes("\t")) {
      continue;
    }
    const [rawId = "", ...labelParts] = line.split("\t");
    const id = rawId.trim();
    const label = labelParts.join("\t").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({
      id,
      label: label || id,
      isDefault: models.length === 0,
    });
  }

  return models;
}

export function isTransientDiscoveryFailure(result: {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut?: boolean;
}): boolean {
  if (result.timedOut) {
    return true;
  }
  const combined = `${result.stderr}\n${result.stdout}`;
  return (
    /\bUNAVAILABLE\b/i.test(combined) ||
    /\bcode\s*50[0234]\b/i.test(combined) ||
    /\bINTERNAL\b/i.test(combined) ||
    // The CLI has its own model-list deadline and can exit before our timer.
    /\btimed out waiting for available models\b/i.test(combined) ||
    /TLS handshake timeout/i.test(combined) ||
    /\bEOF\b/.test(combined) ||
    /connection reset/i.test(combined)
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });
}

export type GetCatalogOptions = {
  /** When false, a failed probe throws instead of serving a stale catalogue. */
  allowStale?: boolean;
  bypassCache?: boolean;
  fallbackCatalog?: ProviderDiscovery | null;
  probeImpl?: typeof probe;
  probeTimeoutMs?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
};

export async function getCatalog(
  host: ProviderHost | undefined,
  command: string,
  args: string[],
  env?: Record<string, string>,
  options: GetCatalogOptions = {},
): Promise<ProviderDiscovery> {
  const state = catalogState(launchIdentity(command, args, env));
  const cacheKey = getCatalogCacheKey(command, args, env);
  const cached = host ? await host.readCatalogCache(cacheKey) : null;
  if (!options.bypassCache && cached && cached.models.length > 0) {
    return withWindows(excludeModels(cached, state.rejected));
  }

  const probeFn = options.probeImpl ?? probe;
  const timeoutMs = options.probeTimeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DISCOVERY_RETRY_DELAY_MS;
  const signal = options.signal;
  const fallbackSource =
    options.allowStale === false
      ? null
      : [options.fallbackCatalog, cached, state.lastGood].find(
          (candidate): candidate is ProviderDiscovery =>
            Boolean(candidate && candidate.models.length > 0),
        ) ?? null;
  const fallback = fallbackSource
    ? markStale(excludeModels(fallbackSource, state.rejected))
    : null;

  let result = await probeFn(
    command,
    [...args, "models"],
    env,
    timeoutMs,
    signal,
  );

  if (result.exitCode !== 0 && isTransientDiscoveryFailure(result) && !signal?.aborted) {
    console.warn(
      `[antigravity-resilient] Model discovery failed transiently (${result.timedOut ? "timeout" : `exit=${result.exitCode}`}); retrying once in ${retryDelayMs}ms`,
    );
    await sleep(retryDelayMs, signal);
    result = await probeFn(
      command,
      [...args, "models"],
      env,
      timeoutMs,
      signal,
    );
  }

  if (result.timedOut) {
    if (fallback) {
      console.warn(
        "[antigravity-resilient] Model discovery timed out after retry; using last valid cached catalog",
      );
      return withWindows(fallback);
    }
    throw new ProviderActionError(
      "PROBE_TIMEOUT",
      "Antigravity discovery timed out",
    );
  }

  if (result.exitCode !== 0) {
    if (fallback && isTransientDiscoveryFailure(result)) {
      console.warn(
        "[antigravity-resilient] Model discovery returned transient error after retry; using last valid cached catalog",
      );
      return withWindows(fallback);
    }
    const detail = diagnostic(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `agy models exited with code ${result.exitCode ?? "unknown"}`,
    );
    throw new ProviderActionError("DISCOVERY_FAILED", detail, detail);
  }

  const models = parseModels(result.stdout);
  if (models.length === 0) {
    if (fallback) {
      return withWindows(fallback);
    }
    throw new ProviderActionError(
      "DISCOVERY_FAILED",
      "Antigravity CLI returned no models from `agy models`.",
    );
  }

  const catalog: ProviderDiscovery = {
    models: withContextWindows(models),
    modes: MODES,
    thinkingOptions: [],
    defaultModel: models[0]?.id,
    defaultMode: DEFAULT_MODE,
  };
  // `agy models` is authoritative: a model it lists again is usable again.
  state.rejected.clear();
  state.lastGood = catalog;
  if (host) {
    await host.writeCatalogCache(cacheKey, catalog);
  }
  return catalog;
}

/** How a session reports agy refusing its model back to the catalogue. */
export type ModelAvailability = {
  /** agy refused `model` outright: drop it now and re-probe in the background. */
  rejected(model: string): void;
  /**
   * Re-probes `agy models`. Returns the fresh catalogue when it no longer
   * lists `model`, or null when it still does or the probe failed.
   */
  confirmMissing(model: string): Promise<ProviderDiscovery | null>;
};

export function createModelAvailability(
  host: ProviderHost | undefined,
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  catalog: {
    get(): ProviderDiscovery | null;
    set(next: ProviderDiscovery): void;
  },
  options: Pick<GetCatalogOptions, "probeImpl" | "retryDelayMs"> = {},
): ModelAvailability {
  const refresh = (
    extra: GetCatalogOptions,
  ): Promise<ProviderDiscovery> =>
    getCatalog(host, command, args, env, {
      ...options,
      bypassCache: true,
      fallbackCatalog: catalog.get(),
      ...extra,
    });
  return {
    rejected(model) {
      invalidateModel(command, args, env, model);
      const current = catalog.get();
      if (current) catalog.set(excludeModels(current, [model]));
      void refresh({}).then(
        (next) => catalog.set(next),
        (error: unknown) => {
          console.warn(
            `[antigravity-resilient] Model list refresh after agy rejected ${model} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      );
    },
    async confirmMissing(model) {
      let fresh: ProviderDiscovery;
      try {
        fresh = await refresh({ allowStale: false, probeTimeoutMs: DISCOVERY_TIMEOUT_MS });
      } catch {
        return null;
      }
      catalog.set(fresh);
      if (fresh.models.some((entry) => entry.id === model)) return null;
      invalidateModel(command, args, env, model);
      return fresh;
    },
  };
}

function withWindows(catalog: ProviderDiscovery): ProviderDiscovery {
  if (
    catalog.models.every(
      (model) =>
        typeof model.contextWindowMaxTokens === "number" &&
        model.contextWindowMaxTokens > 0,
    )
  ) {
    return catalog;
  }
  return { ...catalog, models: withContextWindows(catalog.models) };
}
