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
   * Paseo's `UsageSourceRegistry` keys global cards by `${source.id}:${account.key}`.
   * Because built-in `antigravity-provider` already registers `source.id = "antigravity"`
   * globally, returning an account on `scope.kind === "global"` from this plugin would
   * render two identical Antigravity cards in the global view and run `agy -p /usage`
   * twice. By default, global discovery is suppressed unless `allowGlobalDiscovery` is
   * enabled (or `PASEO_ANTIGRAVITY_RESILIENT_GLOBAL_USAGE=1` is set when built-in
   * `antigravity-provider` is disabled), while every `antigravity-resilient` session
   * discovers its exact launch/account on `scope.kind === "session"`.
   */
  allowGlobalDiscovery?: boolean;
}

export class Usage {
  private readonly launches = new Map<string, ProviderLaunch>();
  private readonly options: UsageOptions;

  constructor(options: UsageOptions = {}) {
    this.options = options;
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
          const launch = resolveEffectiveLaunch(scope.launch);
          const key = accountKey(launch.env);
          const locator = hashAccountKey(JSON.stringify(launch));
          this.launches.set(locator, launch);
          return [{ key, provider: PROVIDER_ID, input: { launch: locator } }];
        }

        if (scope.provider !== PROVIDER_ID) return [];
        if (!scope.launch) return [];
        const launch = resolveEffectiveLaunch(scope.launch, { envOverride: scope.env });
        const key = accountKey(launch.env);
        const locator = hashAccountKey(JSON.stringify(launch));
        this.launches.set(locator, launch);
        return [{ key, provider: PROVIDER_ID, input: { launch: locator } }];
      },
      fetch: async (value) => {
        const { launch: locator } = inputSchema.parse(value);
        const launch = this.launches.get(locator);
        if (!launch) throw new Error("Antigravity launch no longer exists");
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
      },
    };
  }
}
