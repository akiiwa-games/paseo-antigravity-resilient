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
import { resolveEffectiveLaunch } from "./launch.ts";

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

const MAX_CACHED_LAUNCHES = 32;

const USAGE_RELEVANT_ENV_KEYS = [
  "ANTIGRAVITY_HOME",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "PATH",
  "Path",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

function pickUsageRelevantEnvOverride(
  baseEnv: Readonly<Record<string, string>>,
  sessionEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (!sessionEnv) return undefined;
  let picked: Record<string, string> | undefined;
  for (const key of USAGE_RELEVANT_ENV_KEYS) {
    const value = sessionEnv[key];
    if (typeof value === "string" && value !== baseEnv[key]) {
      picked ??= {};
      picked[key] = value;
    }
  }
  return picked;
}

function canonicalLocator(launch: ProviderLaunch): { launch: ProviderLaunch; locator: string } {
  const sortedEntries = Object.entries(launch.env).sort(([a], [b]) => a.localeCompare(b));
  const canonicalEnv = Object.fromEntries(sortedEntries);
  const normalized: ProviderLaunch = {
    command: launch.command,
    args: [...launch.args],
    env: canonicalEnv,
  };
  const locator = hashAccountKey(
    JSON.stringify([normalized.command, normalized.args, sortedEntries]),
  );
  return { launch: normalized, locator };
}

export class Usage {
  private readonly launches = new Map<string, ProviderLaunch>();
  private readonly inFlight = new Map<string, Promise<UsageFetchResult>>();
  private readonly options: UsageOptions;

  constructor(options: UsageOptions = {}) {
    this.options = options;
  }

  private rememberLaunch(locator: string, launch: ProviderLaunch): void {
    if (this.launches.has(locator)) {
      this.launches.delete(locator);
    }
    this.launches.set(locator, launch);
    while (this.launches.size > MAX_CACHED_LAUNCHES) {
      const oldest = this.launches.keys().next().value;
      if (oldest === undefined) break;
      this.launches.delete(oldest);
    }
  }

  private async runFetch(locator: string, launch: ProviderLaunch): Promise<UsageFetchResult> {
    const existing = this.inFlight.get(locator);
    if (existing) return existing;
    const promise = this.executeCliFetch(launch).finally(() => {
      if (this.inFlight.get(locator) === promise) {
        this.inFlight.delete(locator);
      }
    });
    this.inFlight.set(locator, promise);
    return promise;
  }

  private async executeCliFetch(launch: ProviderLaunch): Promise<UsageFetchResult> {
    const acpIndex = launch.args.indexOf("acp");
    if (acpIndex < 0) throw new Error("Antigravity launch does not contain the acp subcommand");
    let result;
    try {
      result = await execCommand(
        launch.command,
        [...launch.args.slice(0, acpIndex), "-p", "/usage", "--output-format", "json"],
        {
          env: launch.env,
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
          const resolved = resolveEffectiveLaunch(scope.launch);
          const { launch, locator } = canonicalLocator(resolved);
          const key = accountKey(launch.env);
          this.rememberLaunch(locator, launch);
          return [{ key, provider: PROVIDER_ID, input: { launch: locator } }];
        }

        if (scope.provider !== PROVIDER_ID) return [];
        if (!scope.launch) return [];
        const relevantOverride = pickUsageRelevantEnvOverride(scope.launch.env, scope.env);
        const resolved = resolveEffectiveLaunch(
          scope.launch,
          relevantOverride ? { envOverride: relevantOverride } : undefined,
        );
        const { launch, locator } = canonicalLocator(resolved);
        const key = accountKey(launch.env);
        this.rememberLaunch(locator, launch);
        return [{ key, provider: PROVIDER_ID, input: { launch: locator } }];
      },
      fetch: async (value) => {
        const { launch: locator } = inputSchema.parse(value);
        const launch = this.launches.get(locator);
        if (!launch) throw new Error("Antigravity launch no longer exists");
        return this.runFetch(locator, launch);
      },
    };
  }
}
