import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageDetail,
  type UsageSourceRegistration,
} from "@getpaseo/plugin/server/usage";

type UsageFetchResult = Awaited<ReturnType<UsageSourceRegistration["fetch"]>>;
import { resolveCommandOnPath, resolveEffectiveLaunch } from "./launch.ts";

export const USAGE_SOURCE_ID = "antigravity-resilient";
export const USAGE_SOURCE_LABEL = "Antigravity (Resilient)";
export const PROVIDER_ID = "antigravity-resilient";

const inputSchema = z.object({ launch: z.string() }).strict();
const responseSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  response: z.string().optional(),
  command: z
    .object({
      name: z.literal("usage"),
      data: z.object({
        groups: z.array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            buckets: z.array(
              z.object({
                id: z.string().min(1),
                name: z.string(),
                window: z.string(),
                remaining_fraction: z.number().min(0).max(1).nullish(),
                reset_time: z.string().nullish(),
                disabled: z.boolean().optional(),
              }),
            ),
          }),
        ),
      }),
    })
    .optional(),
});

export function accountKey(env: ProviderLaunch["env"]): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return hashAccountKey(
    path.resolve(env.ANTIGRAVITY_HOME ?? path.join(home, ".gemini", "antigravity-cli")),
  );
}

function formatWindowLabel(name: string, window: string): string {
  if (window.trim().toLowerCase() === "5h") return "5h";
  return name.trim().replace(/(?:\s+Limit)?\s+Remaining$/i, "");
}

function shortWindow(window: string): string {
  const trimmed = window.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "weekly") return "wk";
  if (normalized === "monthly") return "mo";
  return trimmed;
}

function windowDurationSeconds(window: string): number | undefined {
  switch (window.trim().toLowerCase()) {
    case "5h":
      return 5 * 3600;
    case "weekly":
      return 7 * 86400;
    default:
      return undefined;
  }
}

function formatGroupLabel(name: string): string {
  return name
    .trim()
    .replace(/(?:^|\s+)models$/i, "")
    .trim();
}

function formatShortLabel(groupLabel: string, window: string): string {
  const period = shortWindow(window);
  return groupLabel ? `${groupLabel} ${period}` : period;
}

export interface UsageOptions {
  /**
   * Paseo's `UsageSourceRegistry` keys cards by `${source.id}:${account.key}` and merges
   * `[this.defaults, ...this.byAgent.values()]` into `this.known`.
   *
   * Because built-in `antigravity-provider` registers `source.id = "antigravity"` globally,
   * returning `[]` on `scope.kind === "global"` avoids spawning a second `agy -p /usage`
   * before any `antigravity-resilient` session is active (note: once an `antigravity-resilient`
   * session is inspected, Paseo's host `mergeKnown()` still merges session-discovered sources
   * into `this.known`). Session discovery filters `scope.env` down to account/executable-relevant
   * variables only, so all sessions under the same account share a single `locator`, 5-minute
   * cache entry, and coalesced CLI invocation rather than busting cache per `PASEO_AGENT_ID`.
   */
  allowGlobalDiscovery?: boolean;
}

const SSH_SESSION_ENV_KEYS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;

const ACCOUNT_CONFIG_ENV_KEYS = [
  "ANTIGRAVITY_HOME",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

const BINARY_RESOLUTION_ENV_KEYS = ["PATH", "Path"] as const;

interface StoredUsageLaunch {
  command: string;
  args: string[];
  baseEnv: Readonly<Record<string, string>>;
  envOverrides?: Record<string, string>;
}

function hasSshSession(env: Readonly<Record<string, string | undefined>>): boolean {
  return SSH_SESSION_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}

function canonicalizeExecutablePath(command: string): string {
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    const abs = path.resolve(command);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  }
  return command;
}

function buildUsageLocatorAndLaunch(
  baseLaunch: ProviderLaunch,
  sessionEnv?: Readonly<Record<string, string>>,
): { key: string; locator: string; stored: StoredUsageLaunch } {
  let resolutionOverride: Record<string, string> | undefined;
  let storedOverrides: Record<string, string> | undefined;

  if (sessionEnv) {
    for (const envKey of ACCOUNT_CONFIG_ENV_KEYS) {
      const value = sessionEnv[envKey];
      if (typeof value === "string" && value !== baseLaunch.env[envKey]) {
        resolutionOverride ??= {};
        resolutionOverride[envKey] = value;
        storedOverrides ??= {};
        storedOverrides[envKey] = value;
      }
    }
    for (const pathKey of BINARY_RESOLUTION_ENV_KEYS) {
      const value = sessionEnv[pathKey];
      if (typeof value === "string" && value !== baseLaunch.env[pathKey]) {
        resolutionOverride ??= {};
        resolutionOverride[pathKey] = value;
      }
    }
  }

  const combinedSsh = sessionEnv
    ? hasSshSession({ ...baseLaunch.env, ...sessionEnv })
    : hasSshSession(baseLaunch.env);
  const baseHasSsh = hasSshSession(baseLaunch.env);
  if (combinedSsh && !baseHasSsh) {
    storedOverrides ??= {};
    storedOverrides.SSH_TTY = "1";
  } else if (!combinedSsh && baseHasSsh) {
    storedOverrides ??= {};
    for (const sshKey of SSH_SESSION_ENV_KEYS) {
      storedOverrides[sshKey] = "";
    }
  }

  const resolved = resolveEffectiveLaunch(
    baseLaunch,
    resolutionOverride ? { envOverride: resolutionOverride } : undefined,
  );
  const resolvedCommand =
    resolveCommandOnPath(resolved.command, resolved.env) ?? resolved.command;
  // If `resolvedCommand` remained a bare command name (not found on PATH), keep custom PATH override.
  if (
    resolvedCommand === resolved.command &&
    !(
      resolvedCommand.includes("/") ||
      resolvedCommand.includes("\\") ||
      path.isAbsolute(resolvedCommand)
    ) &&
    sessionEnv
  ) {
    for (const pathKey of BINARY_RESOLUTION_ENV_KEYS) {
      const value = sessionEnv[pathKey];
      if (typeof value === "string" && value !== baseLaunch.env[pathKey]) {
        storedOverrides ??= {};
        storedOverrides[pathKey] = value;
      }
    }
  }

  const key = accountKey(resolved.env);
  const osAccountDirs = [
    resolved.env.HOME ?? "",
    resolved.env.USERPROFILE ?? "",
    resolved.env.LOCALAPPDATA ?? "",
    resolved.env.APPDATA ?? "",
    resolved.env.XDG_CONFIG_HOME ?? "",
  ];
  const proxyTuple = [
    resolved.env.HTTPS_PROXY ?? resolved.env.https_proxy ?? "",
    resolved.env.HTTP_PROXY ?? resolved.env.http_proxy ?? "",
    resolved.env.ALL_PROXY ?? resolved.env.all_proxy ?? "",
    resolved.env.NO_PROXY ?? resolved.env.no_proxy ?? "",
  ];

  // Locator depends exclusively on identity-determining inputs: resolved binary, args,
  // account directory, OS keyring dirs, boolean SSH sign-in mode, and proxy settings.
  const locator = hashAccountKey(
    JSON.stringify([
      canonicalizeExecutablePath(resolvedCommand),
      resolved.args,
      key,
      osAccountDirs,
      combinedSsh,
      proxyTuple,
    ]),
  );

  return {
    key,
    locator,
    stored: {
      command: resolvedCommand,
      args: [...resolved.args],
      baseEnv: baseLaunch.env,
      ...(storedOverrides ? { envOverrides: storedOverrides } : {}),
    },
  };
}

export class Usage {
  private readonly launches = new Map<string, StoredUsageLaunch>();
  private readonly inFlight = new Map<string, Promise<UsageFetchResult>>();
  private readonly options: UsageOptions;

  constructor(options: UsageOptions = {}) {
    this.options = options;
  }

  private rememberLaunch(locator: string, stored: StoredUsageLaunch): void {
    // Never evict registered locators: Paseo's `UsageSourceRegistry` retains discovered
    // `{ launch: locator }` inputs in `known` / `byAgent` and refreshes `listReports({ reportIds })`
    // without re-running `discover()`. Because `locator` is strictly normalized to account +
    // binary identity and `StoredUsageLaunch` shares `baseEnv` by reference, each distinct
    // account uses a single ~150B entry.
    this.launches.set(locator, stored);
  }

  private async runFetch(locator: string, stored: StoredUsageLaunch): Promise<UsageFetchResult> {
    const existing = this.inFlight.get(locator);
    if (existing) return existing;
    const promise = this.executeCliFetch(stored).finally(() => {
      if (this.inFlight.get(locator) === promise) {
        this.inFlight.delete(locator);
      }
    });
    this.inFlight.set(locator, promise);
    return promise;
  }

  private async executeCliFetch(stored: StoredUsageLaunch): Promise<UsageFetchResult> {
    const acpIndex = stored.args.indexOf("acp");
    if (acpIndex < 0) throw new Error("Antigravity launch does not contain the acp subcommand");
    const execEnv = stored.envOverrides
      ? { ...stored.baseEnv, ...stored.envOverrides }
      : stored.baseEnv;
    let result;
    try {
      result = await execCommand(
        stored.command,
        [...stored.args.slice(0, acpIndex), "-p", "/usage", "--output-format", "json"],
        {
          env: execEnv,
          timeout: 18_000,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch {
      throw new Error(
        "Antigravity usage command failed or timed out. Check that agy is signed in.",
      );
    }
    const trimmed = result.stdout.trim();
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    const jsonSlice =
      firstBrace >= 0 && lastBrace > firstBrace
        ? trimmed.slice(firstBrace, lastBrace + 1)
        : trimmed;
    const data = responseSchema.parse(JSON.parse(jsonSlice));
    if (data.status !== "SUCCESS") {
      throw new Error(data.error || data.response || `agy usage returned ${data.status}`);
    }
    if (!data.command) throw new Error("agy did not return usage data");
    const groups = data.command.data.groups;
    const includeGroup = groups.length > 1;
    const windows = groups.flatMap((group) => {
      const groupLabel = formatGroupLabel(group.name);
      return group.buckets.flatMap((bucket) => {
        if (!bucket.disabled && bucket.remaining_fraction == null) return [];
        const used = bucket.disabled ? null : (1 - bucket.remaining_fraction!) * 100;
        return [
          windowFromUsedPct({
            id: bucket.id,
            label: [
              groupLabel,
              formatWindowLabel(bucket.name, bucket.window),
              bucket.disabled ? "Disabled" : null,
            ]
              .filter(Boolean)
              .join(" · "),
            shortLabel: formatShortLabel(includeGroup ? groupLabel : "", bucket.window),
            summary: !bucket.disabled && bucket.window === "weekly",
            utilizationPct: used,
            durationSeconds: windowDurationSeconds(bucket.window),
            resetsAt: bucket.disabled ? null : bucket.reset_time,
            tone: used === null ? "default" : toneFromUsedPct(used),
          }),
        ];
      });
    });
    if (windows.length === 0) {
      return unavailable({ kind: "no_quota", detail: "No usage quota reported by agy" });
    }
    const details: UsageDetail[] = [];
    groups.forEach((group, index) => {
      const modelsText = group.description
        ?.replace(/^models within this group:\s*/iu, "")
        .trim();
      if (modelsText) {
        details.push({
          id: `group:${index}`,
          label: group.name,
          value: modelsText,
        });
      }
    });
    return {
      status: "available",
      windows,
      ...(details.length > 0 ? { details } : {}),
    };
  }

  registration(): UsageSourceRegistration {
    return {
      id: USAGE_SOURCE_ID,
      label: USAGE_SOURCE_LABEL,
      icon: "icon.svg",
      input: inputSchema,
      provider: PROVIDER_ID,
      discover: async (scope) => {
        if (scope.kind === "global") {
          const globalEnabled =
            this.options.allowGlobalDiscovery ??
            (scope.launch?.env.PASEO_ANTIGRAVITY_RESILIENT_GLOBAL_USAGE === "1" ||
              process.env.PASEO_ANTIGRAVITY_RESILIENT_GLOBAL_USAGE === "1");
          if (!globalEnabled || !scope.launch) return [];
          const { key, locator, stored } = buildUsageLocatorAndLaunch(scope.launch);
          this.rememberLaunch(locator, stored);
          return [{ key, provider: PROVIDER_ID, input: { launch: locator } }];
        }

        if (scope.provider !== PROVIDER_ID) return [];
        if (!scope.launch) return [];
        const { key, locator, stored } = buildUsageLocatorAndLaunch(scope.launch, scope.env);
        this.rememberLaunch(locator, stored);
        return [{ key, provider: PROVIDER_ID, input: { launch: locator } }];
      },
      fetch: async (value) => {
        const { launch: locator } = inputSchema.parse(value);
        const stored = this.launches.get(locator);
        if (!stored) throw new Error("Antigravity launch no longer exists");
        return this.runFetch(locator, stored);
      },
    };
  }
}
