import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import {
  createModelAvailability,
  DEFAULT_MODE,
  getCatalog,
  getCatalogCacheKey,
  MODES,
  parseInvalidModelSelection,
  type ProviderDiscovery,
} from "../server/internal/catalog.ts";
import type { SpawnFunction } from "../server/internal/process.ts";
import { Session } from "../server/internal/session.ts";

// Verbatim from the 2026-11-09 daemon log (agy's stderr, exit code 1).
const AGY_INVALID_MODEL = [
  'invalid model selection (--model "gemini-4-argon-high" --effort ""): model gemini-4-argon-high is not recognized as a known model or custom model in settings',
  "Available models:",
  "  Gemini 3.8 Flash (High)",
  "  Claude Opus 5.5 (High)",
  "  GPT-OSS 120B (Medium)",
];

const MODELS_WITHOUT_ARGON =
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n";
const MODELS_WITH_ARGON = `gemini-4-argon-high\tGemini 4 Argon (High)\n${MODELS_WITHOUT_ARGON}`;

function catalogWithArgon(): ProviderDiscovery {
  return {
    models: [
      { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)", isDefault: true },
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
    ],
    modes: MODES,
    defaultModel: "gemini-4-argon-high",
    defaultMode: DEFAULT_MODE,
  };
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 4242;

  exit(code: number): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setTimeout(() => this.emit("close", code, null), 10);
  }

  kill(): boolean {
    if (this.exitCode === null) this.exit(0);
    return true;
  }
}

function holder(initial: ProviderDiscovery) {
  let current: ProviderDiscovery | null = initial;
  return { get: () => current, set: (next: ProviderDiscovery) => { current = next; } };
}

function turnFailure(events: ProviderEvent[]) {
  const failed = events.find(
    (event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
      event.type === "session.turn" && event.state === "failed",
  );
  return failed?.error;
}

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeSession(
  tempDir: string,
  spawn: SpawnFunction,
  catalog: ProviderDiscovery,
  modelAvailability: ReturnType<typeof createModelAvailability>,
  events: ProviderEvent[],
): Session {
  return new Session(
    "sess-invalid-model",
    "agy",
    [],
    { AGY_TEST: tempDir },
    { cwd: tempDir, env: {}, mcpServers: {}, model: "gemini-4-argon-high", mode: "full-access", settings: {}, persist: true },
    undefined,
    catalog,
    (event) => events.push(event),
    { spawn, storeDir: tempDir, modelAvailability, launchRetryDelaysMs: [] },
  );
}

test("parseInvalidModelSelection reads agy's refusal and its label list", () => {
  assert.deepEqual(parseInvalidModelSelection(AGY_INVALID_MODEL.join("\n")), {
    model: "gemini-4-argon-high",
    available: ["Gemini 3.8 Flash (High)", "Claude Opus 5.5 (High)", "GPT-OSS 120B (Medium)"],
  });
  assert.equal(parseInvalidModelSelection("NOT_FOUND (code 404): Requested entity was not found."), null);
});

for (const via of ["result", "stderr"] as const) test(`agy refusing the model (${via}) fails the turn with INVALID_MODEL, invalidates the catalogue and drops the model from list_models`, async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "agy-invalid-model-"));
  try {
    const env = { AGY_TEST: tempDir };
    const catalog = holder(catalogWithArgon());
    // `agy models` stays down after the refusal: the stale fallback must still omit Argon.
    let probes = 0;
    const probeImpl = async () => {
      probes += 1;
      return { exitCode: 1, stdout: "", stderr: "UNAVAILABLE (code 503): No capacity available" };
    };
    const availability = createModelAvailability(undefined, "agy", [], env, catalog, { probeImpl, retryDelayMs: 1 });
    const keyBefore = getCatalogCacheKey("agy", [], env);

    let launches = 0;
    const spawn: SpawnFunction = () => {
      launches += 1;
      const child = new FakeChild();
      queueMicrotask(() => {
        if (via === "result") {
          // The incident's shape: one multi-line error string, indentation intact.
          child.stdout.write(`${JSON.stringify({
            event: "result",
            status: "error",
            errors: [AGY_INVALID_MODEL.join("\n")],
          })}\n`);
        } else {
          child.stderr.write(`${AGY_INVALID_MODEL.join("\n")}\n`);
        }
        child.exit(1);
      });
      return child as unknown as ReturnType<SpawnFunction>;
    };
    const events: ProviderEvent[] = [];
    const session = makeSession(tempDir, spawn, catalogWithArgon(), availability, events);
    await session.prompt({ clientMessageId: "m1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hi" }] } });
    await waitFor(() => turnFailure(events) !== undefined);

    const error = turnFailure(events);
    assert.equal(error?.code, "INVALID_MODEL");
    assert.match(error?.message ?? "", /gemini-4-argon-high/);
    assert.match(error?.message ?? "", /gemini-3\.8-flash-high, claude-opus-5-5-high, GPT-OSS 120B \(Medium\)/);
    assert.match(error?.diagnostic ?? "", /invalid model selection/);
    assert.equal(launches, 1, "a model refusal is not a crash and must not be relaunched");

    // Invalidated: the daemon sees a new catalogue key and agy is re-probed.
    assert.ok(getCatalogCacheKey("agy", [], env) !== keyBefore);
    await waitFor(() => probes >= 1);

    // The session's own model list no longer offers it either.
    const config = events.filter(
      (event): event is Extract<ProviderEvent, { type: "session.config" }> => event.type === "session.config",
    ).at(-1);
    assert.ok(config && !config.config.models?.some((model) => model.id === "gemini-4-argon-high"));

    // Next list_models (the provider's `catalog` request) while agy models is still failing.
    const listed = await getCatalog(undefined, "agy", [], env, {
      fallbackCatalog: catalog.get(),
      probeImpl,
      retryDelayMs: 1,
    });
    assert.deepEqual(listed.models.map((model) => model.id), ["gemini-3.8-flash-high", "claude-opus-5-5-high"]);
    assert.equal(listed.defaultModel, "gemini-3.8-flash-high");
    assert.ok(listed.models.every((model) => model.metadata?.catalogStale === true), "fallback is marked possibly outdated");

    // Once agy lists the model again it is offered again.
    const restored = await getCatalog(undefined, "agy", [], env, {
      fallbackCatalog: catalog.get(),
      probeImpl: async () => ({ exitCode: 0, stdout: MODELS_WITH_ARGON, stderr: "" }),
    });
    assert.equal(restored.models[0]?.id, "gemini-4-argon-high");
    assert.ok(restored.models.every((model) => model.metadata?.catalogStale !== true));
    await session.dispose();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("NOT_FOUND becomes INVALID_MODEL only when a fresh agy models no longer lists the model", async () => {
  for (const { stdout, expectedCode } of [
    { stdout: MODELS_WITHOUT_ARGON, expectedCode: "INVALID_MODEL" },
    { stdout: MODELS_WITH_ARGON, expectedCode: undefined },
  ]) {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agy-not-found-"));
    try {
      const env = { AGY_TEST: tempDir };
      const catalog = holder(catalogWithArgon());
      const availability = createModelAvailability(undefined, "agy", [], env, catalog, {
        // Slower than agy's exit, so the close lands while the check runs.
        probeImpl: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { exitCode: 0, stdout, stderr: "" };
        },
      });
      const keyBefore = getCatalogCacheKey("agy", [], env);
      let launches = 0;
      const spawn: SpawnFunction = () => {
        launches += 1;
        const child = new FakeChild();
        child.stdin.setEncoding("utf8");
        child.stdin.once("data", () => {
          child.stdout.write(`${JSON.stringify({
            event: "result",
            conversation_id: "conv-not-found",
            status: "error",
            errors: ["NOT_FOUND (code 404): Requested entity was not found."],
          })}\n`);
          child.exit(3);
        });
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ event: "init", conversation_id: "conv-not-found" })}\n`);
        });
        return child as unknown as ReturnType<SpawnFunction>;
      };
      const events: ProviderEvent[] = [];
      const session = makeSession(tempDir, spawn, catalogWithArgon(), availability, events);
      await session.prompt({ clientMessageId: "m1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hi" }] } });
      await waitFor(() => turnFailure(events) !== undefined);

      const error = turnFailure(events);
      assert.equal(error?.code, expectedCode);
      assert.match(error?.diagnostic ?? error?.message ?? "", /NOT_FOUND \(code 404\)/);
      assert.equal(launches, 1);
      if (expectedCode) {
        assert.ok(getCatalogCacheKey("agy", [], env) !== keyBefore);
        assert.ok(!catalog.get()?.models.some((model) => model.id === "gemini-4-argon-high"));
      } else {
        assert.equal(getCatalogCacheKey("agy", [], env), keyBefore);
      }
      await session.dispose();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("catalogue key rolls over with the TTL window", () => {
  const env = { AGY_TEST: "ttl" };
  const now = Date.UTC(2026, 10, 9, 12, 0, 0);
  assert.equal(getCatalogCacheKey("agy", [], env, now), getCatalogCacheKey("agy", [], env, now + 60_000));
  assert.ok(getCatalogCacheKey("agy", [], env, now) !== getCatalogCacheKey("agy", [], env, now + 31 * 60_000));
});
