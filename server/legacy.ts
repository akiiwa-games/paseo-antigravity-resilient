import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AcpConfigChange, AcpConfigureContext } from "@getpaseo/plugin/server/acp";
import type {
  ProviderCatalog,
  ProviderModel,
  ProviderPersistence,
} from "@getpaseo/plugin/server/provider";

const LEGACY_EFFORT_PATTERN = /^(.*)-(xhigh|high|medium|low|minimal)$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeLegacyKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (/^[A-Za-z0-9._-]{1,120}$/.test(trimmed) && !trimmed.includes("..")) {
    return trimmed;
  }
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
  const prefix = trimmed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "conv";
  return `${prefix}-${digest}`;
}

/**
 * Default directory where the old stream-json fork stored durable conversation
 * timelines and `session-keys/<sessionKey>.json` bindings. Kept read-only for
 * legacy session restoration; user data is never modified or deleted.
 */
export function defaultLegacyStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  const legacyDir = path.join(homedir(), ".paseo", "antigravity-resilient", "conversations");
  const envHome = env.PASEO_HOME?.trim();
  if (!envHome) return legacyDir;
  const envDir = path.join(envHome, "antigravity-resilient", "conversations");
  if (path.resolve(envDir) === path.resolve(legacyDir)) return legacyDir;
  if (!existsSync(envDir) && existsSync(legacyDir)) return legacyDir;
  return envDir;
}

export function resolveLegacySessionKeyBinding(
  sessionKey: string,
  options?: { storeDir?: string; env?: NodeJS.ProcessEnv },
): string | undefined {
  const cleanKey = sessionKey.trim();
  if (!cleanKey) return undefined;
  const storeDir = options?.storeDir?.trim() || defaultLegacyStoreDir(options?.env);
  const bindingFile = path.join(storeDir, "session-keys", `${safeLegacyKey(cleanKey)}.json`);
  if (!existsSync(bindingFile)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(bindingFile, "utf8"));
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      typeof parsed.conversationId === "string" &&
      parsed.conversationId.trim().length > 0
    ) {
      return parsed.conversationId.trim();
    }
  } catch {
    // Ignore unreadable or corrupted legacy binding files.
  }
  return undefined;
}

/**
 * Extracts the native Antigravity conversation/session ID from either:
 * 1. Official ACP persistence: `{ version: 1, data: { sessionId } }`
 * 2. Legacy stream-json fork persistence: `{ version: 1, data: { conversationId, sessionKey? } }`
 * 3. Legacy stream-json fork pre-init persistence: `{ version: 1, data: { sessionKey } }`
 *    resolved through `<storeDir>/session-keys/<sessionKey>.json`.
 */
export function decodeSavedSessionId(
  persistence: ProviderPersistence | undefined,
  options?: { storeDir?: string; env?: NodeJS.ProcessEnv },
): string | undefined {
  if (!persistence || persistence.version !== 1 || !isRecord(persistence.data)) {
    return undefined;
  }
  const { sessionId, conversationId, sessionKey } = persistence.data;
  if (typeof sessionId === "string" && sessionId.trim().length > 0) {
    return sessionId.trim();
  }
  if (typeof conversationId === "string" && conversationId.trim().length > 0) {
    return conversationId.trim();
  }
  if (typeof sessionKey === "string" && sessionKey.trim().length > 0) {
    return resolveLegacySessionKeyBinding(sessionKey, options);
  }
  return undefined;
}

/**
 * Preserves both `sessionId` (used by Paseo's ACP adapter) and `conversationId`
 * (read by external telemetry tools inspecting `~/.paseo/agents/`).
 */
export function enrichPersistence(
  persistence: ProviderPersistence | undefined,
): ProviderPersistence | undefined {
  if (!persistence || !isRecord(persistence.data)) return persistence;
  const sessionId =
    typeof persistence.data.sessionId === "string" && persistence.data.sessionId.trim()
      ? persistence.data.sessionId.trim()
      : typeof persistence.data.conversationId === "string" &&
          persistence.data.conversationId.trim()
        ? persistence.data.conversationId.trim()
        : undefined;
  if (!sessionId) return persistence;
  return {
    ...persistence,
    data: {
      ...persistence.data,
      sessionId,
      conversationId: sessionId,
    },
  };
}

export function parseLegacyModelEffort(
  modelId: string | null | undefined,
): { baseModel: string; effort: string } | null {
  if (!modelId) return null;
  const trimmed = modelId.trim();
  const match = LEGACY_EFFORT_PATTERN.exec(trimmed);
  if (!match || !match[1] || !match[2]) return null;
  return { baseModel: match[1], effort: match[2] };
}

/**
 * Attaches `<model.id>-<thinkingOption.id>` aliases onto each model so Paseo's
 * `validateAgentConfigurationAgainstProvider`, UI model lookup, and external
 * routers that still pass effort-suffixed IDs (`gemini-4-hydrogen-medium`,
 * `gemini-3.8-flash-low`) accept them on both `createAgent` and reopen.
 */
export function withLegacyModelAliases(models: readonly ProviderModel[]): ProviderModel[] {
  const nativeIds = new Set(models.map((model) => model.id));
  const claimedAliases = new Set<string>();
  return models.map((model) => {
    const thinkingIds = (model.thinkingOptions ?? []).map((option) => option.id);
    const extraAliases: string[] = [];
    for (const effort of thinkingIds) {
      const candidate = `${model.id}-${effort}`;
      if (!nativeIds.has(candidate) && !claimedAliases.has(candidate)) {
        claimedAliases.add(candidate);
        extraAliases.push(candidate);
      }
    }
    if (extraAliases.length === 0) return model;
    const merged = [...new Set([...(model.aliases ?? []), ...extraAliases])];
    return { ...model, aliases: merged };
  });
}

export function enrichCatalogModels(catalog: ProviderCatalog): ProviderCatalog {
  return {
    ...catalog,
    models: withLegacyModelAliases(catalog.models),
  };
}

export async function applyLegacyModelConfigure(
  change: AcpConfigChange,
  { apply, catalog }: Pick<AcpConfigureContext, "apply" | "catalog">,
): Promise<"handled" | "pass"> {
  if (change.target === "model" && change.value) {
    const parsed = parseLegacyModelEffort(change.value);
    if (parsed) {
      const { models } = catalog();
      if (
        !models.some((option) => option.id === change.value) &&
        models.some((option) => option.id === parsed.baseModel)
      ) {
        await apply({ target: "model", value: parsed.baseModel });
        if (catalog().thinkingOptions?.some((option) => option.id === parsed.effort)) {
          await apply({ target: "thinking", value: parsed.effort });
        }
        return "handled";
      }
    }
  }
  return "pass";
}
