import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { DEFAULT_MODE, MODES, type ProviderDiscovery } from "../server/internal/catalog.ts";
import type { SpawnFunction } from "../server/internal/process.ts";
import { MAX_PROCESS_LAUNCHES_PER_WINDOW, MAX_SESSION_LAUNCHES_PER_WINDOW, Session } from "../server/internal/session.ts";

const CATALOG: ProviderDiscovery = {
  models: [{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", isDefault: true }],
  modes: MODES,
  defaultModel: "gemini-3.8-flash-high",
  defaultMode: DEFAULT_MODE,
};

class CrashingChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 4343;

  constructor() {
    super();
    queueMicrotask(() => {
      this.stderr.write("fatal: synthetic crash\n");
      this.exitCode = 1;
      this.stdout.end();
      this.stderr.end();
      setTimeout(() => this.emit("close", 1, null), 5);
    });
  }

  kill(): boolean {
    return true;
  }
}

function turnEnds(events: ProviderEvent[]) {
  return events.filter(
    (event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
      event.type === "session.turn" && (event.state === "completed" || event.state === "failed"),
  );
}

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the per-session launch cap refuses a relaunch loop with LAUNCH_RATE_LIMITED", async () => {
  assert.ok(MAX_SESSION_LAUNCHES_PER_WINDOW < MAX_PROCESS_LAUNCHES_PER_WINDOW);
  const tempDir = mkdtempSync(path.join(tmpdir(), "agy-launch-guard-"));
  try {
    let launches = 0;
    const spawn: SpawnFunction = () => {
      launches += 1;
      return new CrashingChild() as unknown as ReturnType<SpawnFunction>;
    };
    const events: ProviderEvent[] = [];
    const session = new Session(
      "sess-launch-guard",
      "agy",
      [],
      {},
      { cwd: tempDir, env: {}, mcpServers: {}, model: "gemini-3.8-flash-high", mode: "full-access", settings: {}, persist: true },
      undefined,
      CATALOG,
      (event) => events.push(event),
      {
        spawn,
        storeDir: tempDir,
        launchRetryDelaysMs: [],
        launchRateLimit: { windowMs: 60_000, perSession: 2, perProcess: 100 },
      },
    );
    for (let i = 1; i <= 3; i += 1) {
      await session.prompt({ clientMessageId: `m${i}`, delivery: "auto", input: { type: "message", content: [{ type: "text", text: `try ${i}` }] } });
      await waitFor(() => turnEnds(events).length === i);
    }

    const [first, second, third] = turnEnds(events);
    assert.equal(first?.state, "failed");
    assert.equal(second?.state, "failed");
    assert.ok(first?.error?.code !== "LAUNCH_RATE_LIMITED");
    assert.equal(third?.error?.code, "LAUNCH_RATE_LIMITED");
    assert.match(third?.error?.message ?? "", /launched 2 times for this session/);
    assert.equal(launches, 2, "the refused launch never reaches spawn");
    await session.dispose();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
