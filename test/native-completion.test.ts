import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { DEFAULT_MODE, MODES } from "../server/internal/catalog.ts";
import type { SpawnFunction } from "../server/internal/process.ts";
import { Session } from "../server/internal/session.ts";

// Synthetic protocol/row shapes from an incident with an old transport error,
// a completed native response, and an unnecessary continuation. No user data.
const staleError = 'API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read tcp 192.0.2.1:12345->198.51.100.2:443: wsarecv: An existing connection was forcibly closed by the remote host.';
const finalText = "Synthetic final answer.";
const config = { cwd: tmpdir(), env: {}, mcpServers: {}, settings: {}, persist: true, mode: DEFAULT_MODE };
const catalog = { models: [], modes: MODES, defaultMode: DEFAULT_MODE };
type Row = Record<string, unknown>;
const row = (step_index: number, type: string, extra: Row = {}): Row => ({
  step_index, type, status: "DONE", created_at: "2040-01-01T00:00:00Z", ...extra,
});

class ProtocolChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  pid = 42424;
  constructor(onPrompt: () => void) {
    super();
    let pending = "";
    this.stdin.on("data", (data: Buffer) => {
      pending += data.toString();
      if (pending.includes("\n")) { pending = ""; onPrompt(); }
    });
  }
  frame(value: Row): void { this.stdout.write(JSON.stringify(value) + "\n"); }
  kill(): boolean {
    if (this.exitCode === null) {
      this.killed = true; this.exitCode = 0;
      this.stdout.end(); this.stderr.end(); this.emit("close", 0, null);
    }
    return true;
  }
}

for (const scenario of ["done", "truncated", "active", "pending-tool", "pre-tool-only", "later-error",
  "prior-attempt", "other-conversation", "wrong-text", "early-exit", "torn-tail", "later-stream-step", "stream-error", "no-new-user"]) {
  test(`native completion evidence: ${scenario}`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agy-native-completion-"));
    const conv = "synthetic-completion";
    const logs = path.join(dir, conv, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const file = path.join(logs, "transcript.jsonl");
    const oldRows = [row(0, "USER_INPUT", { content: "Earlier synthetic request" }),
      row(1, "ERROR_MESSAGE", { error: staleError }),
      row(2, "PLANNER_RESPONSE", { content: "Earlier completed answer" })];
    writeFileSync(file, oldRows.map(value => JSON.stringify(value)).join("\n") + "\n");
    const events: ProviderEvent[] = [];
    let attempts = 0;
    const spawn: SpawnFunction = () => {
      const child = new ProtocolChild(() => {
        attempts++;
        const base = 3 + (attempts - 1) * 5;
        const input = row(base, "USER_INPUT", { content: "Synthetic current request" });
        const response = row(base + 2, "PLANNER_RESPONSE", { content: finalText,
          status: scenario === "active" ? "ACTIVE" : "DONE" });
        if (scenario === "pending-tool" || scenario === "pre-tool-only") response.tool_calls = [{ name: "synthetic_tool" }];
        let fresh = [input, row(base + 1, "GENERIC", { content: "Synthetic tool finished" }), response];
        if (scenario === "no-new-user") fresh = fresh.slice(1);
        if (scenario === "pre-tool-only") fresh.push(row(base + 3, "GENERIC", { content: "Tool result, awaiting model" }));
        if (scenario === "later-error") fresh.push(row(base + 3, "ERROR_MESSAGE", { error: staleError }));
        const destination = scenario === "other-conversation"
          ? path.join(dir, "different-conversation", ".system_generated", "logs", "transcript.jsonl") : file;
        mkdirSync(path.dirname(destination), { recursive: true });
        if (scenario !== "prior-attempt" || attempts === 1) {
          // On attempt one, a pending tool prevents accepting this DONE. Attempt
          // two must not reuse it when it writes no new native request/response.
          const stored = scenario === "truncated" ? fresh.map(value => value === response
            ? { ...value, content: "Synthetic...", truncated_fields: ["content"] } : value) : fresh;
          appendFileSync(destination, stored.map(value => JSON.stringify(value)).join("\n") + "\n");
          if (scenario === "truncated") writeFileSync(path.join(logs, "transcript_full.jsonl"),
            [...oldRows, ...fresh].map(value => JSON.stringify(value)).join("\n") + "\n");
        }
        if (scenario === "torn-tail") appendFileSync(file, '{"step_index":999');
        if (scenario === "prior-attempt" && attempts === 1) child.frame({ event: "step_update", step_update: {
          step_index: base + 3, step_type: "tool", state: "ACTIVE", tool_name: "synthetic_tool" } });
        if (!(scenario === "prior-attempt" && attempts === 2)) child.frame({ event: "step_update", step_update: {
          step_index: scenario === "later-stream-step" ? base + 3 : base + 2,
          step_type: "agent_response", state: scenario === "stream-error" ? "ERROR" : "ACTIVE", text_delta: finalText } });
        child.frame({ event: "result", result: { conversation_id: conv, status: "ERROR", error: staleError,
          response: scenario === "wrong-text" ? "A different synthetic answer." : finalText,
          ...(scenario === "early-exit" ? { finished_reason: "interrupted" } : {}) } });
      });
      queueMicrotask(() => child.frame({ event: "init", conversation_id: conv }));
      return child as unknown as ReturnType<SpawnFunction>;
    };
    const session = new Session("synthetic", "agy", [], {}, config,
      { version: 1, data: { conversationId: conv } }, catalog, event => events.push(event),
      { spawn, storeDir: path.join(dir, "store"), brainDir: dir, autoCompactEnabled: false, streamInterruptRetryDelayMs: 1 });
    try {
      await session.prompt({ clientMessageId: "synthetic-request", delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "Synthetic request" }] } });
      const deadline = Date.now() + 3000;
      while (!events.some(event => event.type === "session.turn" && event.state !== "started")) {
        assert.ok(Date.now() < deadline, "synthetic protocol did not settle");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const end = events.find(event => event.type === "session.turn" && event.state !== "started");
      assert.ok(end?.type === "session.turn");
      const success = scenario === "done" || scenario === "truncated";
      assert.equal(end.state, success ? "completed" : "failed");
      assert.equal(attempts, success ? 1 : 2, "only proven completion avoids the bounded continuation");
    } finally { await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
}
