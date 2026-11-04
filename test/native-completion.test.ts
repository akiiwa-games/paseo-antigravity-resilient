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
import { Session, TOKEN_GAP_CONTINUE_PROMPT } from "../server/internal/session.ts";

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

for (const scenario of ["done", "truncated", "large-turn", "active", "pending-tool", "pre-tool-only", "later-error",
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
        const toolRow = scenario === "large-turn"
          ? row(base + 1, "GENERIC", { status: "ERROR", content: "x".repeat(300 * 1024) })
          : row(base + 1, "GENERIC", { content: "Synthetic tool finished" });
        let fresh = [input, toolRow, response];
        if (scenario === "no-new-user") fresh = fresh.slice(1);
        if (scenario === "pre-tool-only") fresh.push(row(base + 3, "GENERIC", { content: "Tool result, awaiting model" }));
        if (scenario === "later-error") fresh.push(row(base + 3, "ERROR_MESSAGE", { error: staleError }));
        const destination = scenario === "other-conversation"
          ? path.join(dir, "different-conversation", ".system_generated", "logs", "transcript.jsonl") : file;
        mkdirSync(path.dirname(destination), { recursive: true });
        if (scenario !== "prior-attempt" || attempts === 1) {
          // On attempt one, a pending tool prevents accepting this DONE. Attempt
          // two must not reuse it when it writes no new native request/response.
          const isTruncated = scenario === "truncated" || scenario === "large-turn";
          const stored = isTruncated ? fresh.map(value => value === response
            ? { ...value, content: "Synthetic...", truncated_fields: ["content"] } : value) : fresh;
          appendFileSync(destination, stored.map(value => JSON.stringify(value)).join("\n") + "\n");
          if (isTruncated) writeFileSync(path.join(logs, "transcript_full.jsonl"),
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
          finished_reason: scenario === "early-exit" ? "interrupted" : "error" } });
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
      const success = scenario === "done" || scenario === "truncated" || scenario === "large-turn";
      assert.equal(end.state, success ? "completed" : "failed");
      assert.equal(attempts, success ? 1 : 2, "only proven completion avoids the bounded continuation");
    } finally { await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("business turn interrupted after automatic mid-turn CHECKPOINT retries once with continuation prompt", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-midturn-checkpoint-"));
  const conv = "synthetic-midturn-checkpoint";
  const logs = path.join(dir, conv, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const file = path.join(logs, "transcript.jsonl");
  writeFileSync(file, JSON.stringify(row(0, "USER_INPUT", { content: "Earlier request" })) + "\n");
  const events: ProviderEvent[] = [];
  const prompts: string[] = [];
  let attempts = 0;
  const spawn: SpawnFunction = () => {
    let buf = "";
    const child = new ProtocolChild(() => {
      attempts++;
      if (attempts === 1) {
        const fresh = [
          row(1, "USER_INPUT", { content: "Long business turn" }),
          row(2, "CHECKPOINT", { content: "Automatic mid-turn summary" }),
          row(3, "ERROR_MESSAGE", { error: staleError }),
        ];
        appendFileSync(file, fresh.map(v => JSON.stringify(v)).join("\n") + "\n");
        child.frame({ event: "step_update", conversation_id: conv, timestamp: "2040-01-01T00:00:00Z",
          step_update: { step_index: 2, step_type: "CHECKPOINT", state: "DONE" } });
        child.frame({ event: "result", result: { conversation_id: conv, status: "ERROR",
          finished_reason: "error", error: staleError, response: "" } });
        return;
      }
      const recovered = [
        row(4, "USER_INPUT", { content: TOKEN_GAP_CONTINUE_PROMPT }),
        row(5, "PLANNER_RESPONSE", { content: finalText }),
      ];
      appendFileSync(file, recovered.map(v => JSON.stringify(v)).join("\n") + "\n");
      child.frame({ event: "step_update", step_update: { step_index: 5, step_type: "agent_response", state: "ACTIVE", text_delta: finalText } });
      child.frame({ event: "result", result: { conversation_id: conv, status: "ERROR",
        finished_reason: "error", error: staleError, response: finalText } });
    });
    child.stdin.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      while (buf.includes("\n")) {
        const idx = buf.indexOf("\n");
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) prompts.push((JSON.parse(line) as { content: string }).content);
      }
    });
    queueMicrotask(() => child.frame({ event: "init", conversation_id: conv }));
    return child as unknown as ReturnType<SpawnFunction>;
  };
  const session = new Session("synthetic-cp", "agy", [], {}, config,
    { version: 1, data: { conversationId: conv } }, catalog, event => events.push(event),
    { spawn, storeDir: path.join(dir, "store"), brainDir: dir, autoCompactEnabled: false, streamInterruptRetryDelayMs: 1 });
  try {
    await session.prompt({ clientMessageId: "cp-req", delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "Long business turn" }] } });
    const deadline = Date.now() + 3000;
    while (!events.some(event => event.type === "session.turn" && event.state !== "started")) {
      assert.ok(Date.now() < deadline, "mid-turn checkpoint retry did not settle");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const end = events.find(event => event.type === "session.turn" && event.state !== "started");
    assert.ok(end?.type === "session.turn");
    assert.equal(end.state, "completed");
    assert.equal(attempts, 2);
    assert.equal(prompts[1], TOKEN_GAP_CONTINUE_PROMPT);
  } finally { await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

for (const recoveredErr of [
  "API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.",
  "Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty - no input to parse.\nPlease retry with a properly formatted function call\nRetries remaining: 3",
  "model output error: model output must contain either output text or tool calls, these cannot both be empty, please try again",
]) {
  test(`non-stream-interruption native ERROR_MESSAGE superseded by DONE response does not poison turn: ${recoveredErr.slice(0, 36)}`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agy-recovered-nonstream-"));
    const conv = "synthetic-nonstream-recovered";
    const logs = path.join(dir, conv, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const file = path.join(logs, "transcript.jsonl");
    writeFileSync(file, JSON.stringify(row(0, "USER_INPUT", { content: "Earlier request" })) + "\n");
    const events: ProviderEvent[] = [];
    const spawn: SpawnFunction = () => {
      const child = new ProtocolChild(() => {
        const fresh = [
          row(1, "USER_INPUT", { content: "Current request" }),
          row(2, "ERROR_MESSAGE", { error: recoveredErr, content: `Error: ${recoveredErr}` }),
          row(3, "PLANNER_RESPONSE", { content: finalText, status: "DONE" }),
        ];
        appendFileSync(file, fresh.map(v => JSON.stringify(v)).join("\n") + "\n");
        child.frame({ event: "step_update", step_update: { step_index: 3, step_type: "agent_response", state: "DONE", text_delta: finalText } });
        child.frame({ event: "result", result: { conversation_id: conv, status: "ERROR",
          finished_reason: "error", error: recoveredErr, response: finalText } });
      });
      queueMicrotask(() => child.frame({ event: "init", conversation_id: conv }));
      return child as unknown as ReturnType<SpawnFunction>;
    };
    const session = new Session("synthetic-nonstream", "agy", [], {}, config,
      { version: 1, data: { conversationId: conv } }, catalog, event => events.push(event),
      { spawn, storeDir: path.join(dir, "store"), brainDir: dir, autoCompactEnabled: false, streamInterruptRetryDelayMs: 1 });
    try {
      await session.prompt({ clientMessageId: "nonstream-req", delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "Current request" }] } });
      const deadline = Date.now() + 3000;
      while (!events.some(event => event.type === "session.turn" && event.state !== "started")) {
        assert.ok(Date.now() < deadline, "non-stream recovered turn did not settle");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const end = events.find(event => event.type === "session.turn" && event.state !== "started");
      assert.ok(end?.type === "session.turn");
      assert.equal(end.state, "completed");
    } finally { await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("a failed turn's error does not poison subsequent turns in the same conversation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-subsequent-turn-"));
  const conv = "synthetic-subsequent-turn";
  const logs = path.join(dir, conv, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const file = path.join(logs, "transcript.jsonl");
  const fatalErr = "API error (attempt 1): UNAVAILABLE (code 503): Service overloaded";
  const events: ProviderEvent[] = [];
  let turnCall = 0;
  const spawn: SpawnFunction = () => {
    const child = new ProtocolChild(() => {
      turnCall++;
      if (turnCall === 1) {
        const failRows = [
          row(0, "USER_INPUT", { content: "Turn 1" }),
          row(1, "ERROR_MESSAGE", { error: fatalErr }),
        ];
        writeFileSync(file, failRows.map(v => JSON.stringify(v)).join("\n") + "\n");
        child.frame({ event: "result", result: { conversation_id: conv, status: "ERROR",
          finished_reason: "error", error: fatalErr, response: "" } });
        return;
      }
      const okRows = [
        row(2, "USER_INPUT", { content: "Turn 2" }),
        row(3, "PLANNER_RESPONSE", { content: finalText, status: "DONE" }),
      ];
      appendFileSync(file, okRows.map(v => JSON.stringify(v)).join("\n") + "\n");
      child.frame({ event: "step_update", step_update: { step_index: 3, step_type: "agent_response", state: "DONE", text_delta: finalText } });
      child.frame({ event: "result", result: { conversation_id: conv, status: "ERROR",
        finished_reason: "error", error: fatalErr, response: finalText } });
    });
    queueMicrotask(() => child.frame({ event: "init", conversation_id: conv }));
    return child as unknown as ReturnType<SpawnFunction>;
  };
  const session = new Session("synthetic-multi", "agy", [], {}, config,
    { version: 1, data: { conversationId: conv } }, catalog, event => events.push(event),
    { spawn, storeDir: path.join(dir, "store"), brainDir: dir, autoCompactEnabled: false, streamInterruptRetryDelayMs: 1 });
  try {
    await session.prompt({ clientMessageId: "t1", delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "Turn 1" }] } });
    const deadline1 = Date.now() + 3000;
    while (events.filter(e => e.type === "session.turn" && e.state !== "started").length < 1) {
      assert.ok(Date.now() < deadline1);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const turnEnds1 = events.filter((e): e is Extract<ProviderEvent, { type: "session.turn" }> => e.type === "session.turn" && e.state !== "started");
    assert.equal(turnEnds1[0]?.state, "failed");

    await session.prompt({ clientMessageId: "t2", delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "Turn 2" }] } });
    const deadline2 = Date.now() + 3000;
    while (events.filter(e => e.type === "session.turn" && e.state !== "started").length < 2) {
      assert.ok(Date.now() < deadline2);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const turnEnds2 = events.filter((e): e is Extract<ProviderEvent, { type: "session.turn" }> => e.type === "session.turn" && e.state !== "started");
    assert.equal(turnEnds2[1]?.state, "completed");
  } finally { await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test("live native reasoning emission gates future thoughts behind intervening tool step_update frames", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-live-step-order-"));
  const conv = "synthetic-live-step-order";
  const logs = path.join(dir, conv, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const file = path.join(logs, "transcript.jsonl");
  const events: ProviderEvent[] = [];
  const spawn: SpawnFunction = () => {
    const child = new ProtocolChild(() => {
      // Simulate transcript.jsonl already having steps 1..10 written on disk while stdout
      // flushes tool step_update frames afterwards (as happens behind a background command).
      const rows = [
        row(0, "USER_INPUT", { content: "Run multi-step task" }),
        row(1, "PLANNER_RESPONSE", { thinking: "Thought 1", content: "" }),
        row(2, "GENERIC", { content: "Tool 2 done" }),
        row(3, "GENERIC", { content: "Tool 3 done" }),
        row(4, "PLANNER_RESPONSE", { thinking: "Thought 4", content: "" }),
        row(5, "GENERIC", { content: "Tool 5 done" }),
        row(6, "PLANNER_RESPONSE", { thinking: "Thought 6", content: finalText }),
      ];
      writeFileSync(file, rows.map(v => JSON.stringify(v)).join("\n") + "\n");
      child.frame({ event: "step_update", step_update: { step_index: 2, step_type: "tool", state: "DONE", tool_name: "read_file" } });
      child.frame({ event: "step_update", step_update: { step_index: 3, step_type: "tool", state: "DONE", tool_name: "read_file" } });
      child.frame({ event: "step_update", step_update: { step_index: 5, step_type: "tool", state: "DONE", tool_name: "run_command" } });
      child.frame({ event: "step_update", step_update: { step_index: 6, step_type: "agent_response", state: "DONE", text_delta: finalText } });
      child.frame({ event: "result", result: { conversation_id: conv, status: "SUCCESS",
        finished_reason: "stop", response: finalText } });
    });
    queueMicrotask(() => child.frame({ event: "init", conversation_id: conv }));
    return child as unknown as ReturnType<SpawnFunction>;
  };
  const session = new Session("synthetic-order", "agy", [], {}, config,
    { version: 1, data: { conversationId: conv } }, catalog, event => events.push(event),
    { spawn, storeDir: path.join(dir, "store"), brainDir: dir, autoCompactEnabled: false });
  try {
    await session.prompt({ clientMessageId: "order-req", delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "Run multi-step task" }] } });
    const deadline = Date.now() + 3000;
    while (!events.some(event => event.type === "session.turn" && event.state !== "started")) {
      assert.ok(Date.now() < deadline, "live step order test did not settle");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const itemIds = events
      .filter((e): e is Extract<ProviderEvent, { type: "timeline.item" }> => e.type === "timeline.item")
      .map(e => e.item.id);
    assert.deepEqual(itemIds, [
      "user:order-req",
      "turn-1:step:1:reasoning",
      "turn-1:step:2",
      "turn-1:step:3",
      "turn-1:step:4:reasoning",
      "turn-1:step:5",
      "turn-1:step:6:reasoning",
      "turn-1:step:6",
    ]);
  } finally { await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
