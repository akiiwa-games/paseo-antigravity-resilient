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

test("literal <thought> tag stdout truncation is healed in-place from transcript_full.jsonl without duplicate message", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-thought-tag-truncation-"));
  const conv = "synthetic-thought-tag";
  const logs = path.join(dir, conv, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const compactFile = path.join(logs, "transcript.jsonl");
  const fullFile = path.join(logs, "transcript_full.jsonl");
  const fullMarkdown = [
    "### 改动要点",
    "- **移除冗余包裹**：直接返回正文；",
    "- **砍掉生成前的 `<thought>` 与自检协议**：原版要求先输出 `<thought>` 块，导致流被截断；",
    "- **完整保留后续 4000 字报告**：这是 `<thought>` 之后的正文内容。",
  ].join("\n");
  // Simulate agy stdout cutting off right before `<thought>`
  const cutIdx = fullMarkdown.indexOf("<thought>");
  const truncatedStreamText = `${fullMarkdown.slice(0, cutIdx - 1)}\n`;
  const events: ProviderEvent[] = [];
  const spawn: SpawnFunction = () => {
    const child = new ProtocolChild(() => {
      const fullRows = [
        row(0, "USER_INPUT", { content: "Explain the <thought> fix" }),
        row(1, "PLANNER_RESPONSE", { thinking: "Analyzing <thought> tag stripping", content: fullMarkdown }),
      ];
      writeFileSync(compactFile, fullRows.map(v => JSON.stringify(v)).join("\n") + "\n");
      writeFileSync(fullFile, fullRows.map(v => JSON.stringify(v)).join("\n") + "\n");
      child.frame({
        event: "step_update",
        step_update: { step_index: 1, step_type: "agent_response", state: "ACTIVE", text_delta: truncatedStreamText },
      });
      child.frame({
        event: "result",
        result: { conversation_id: conv, status: "SUCCESS", finished_reason: "stop", response: truncatedStreamText },
      });
    });
    queueMicrotask(() => child.frame({ event: "init", conversation_id: conv }));
    return child as unknown as ReturnType<SpawnFunction>;
  };
  const session = new Session("synthetic-thought", "agy", [], {}, config,
    { version: 1, data: { conversationId: conv } }, catalog, event => events.push(event),
    { spawn, storeDir: path.join(dir, "store"), brainDir: dir, autoCompactEnabled: false });
  try {
    await session.prompt({ clientMessageId: "thought-req", delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "Explain the <thought> fix" }] } });
    const deadline = Date.now() + 3000;
    while (!events.some(event => event.type === "session.turn" && event.state !== "started")) {
      assert.ok(Date.now() < deadline, "<thought> truncation test did not settle");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const assistantItems = events
      .filter((e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
        e.type === "timeline.item" && e.item.type === "assistant_message")
      .map(e => e.item as Extract<ProviderEvent, { type: "timeline.item" }>["item"] & { type: "assistant_message" });
    const finalMsg = assistantItems.at(-1);
    assert.ok(finalMsg);
    assert.equal(finalMsg.id, "turn-1:step:1");
    assert.equal(finalMsg.text, fullMarkdown);
    assert.equal(
      assistantItems.some(item => item.id.includes(":message:")),
      false,
      "Must update turn-1:step:1 in-place without emitting a duplicate :message:1 item",
    );
  } finally { await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test("stalled stdout stepTracker behind an interrupted RUNNING tool recovers and backfills full thoughts, tools, and final report from transcript_full.jsonl", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-stalled-steptracker-"));
  const conv = "synthetic-stalled-tracker";
  const logs = path.join(dir, conv, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const compactFile = path.join(logs, "transcript.jsonl");
  const fullFile = path.join(logs, "transcript_full.jsonl");
  const longThought = "Deep analysis of catalog routing. ".repeat(160).trim(); // > 5000 chars
  const compactThought = `${longThought.slice(0, 4100)}\n...[truncated 1000 chars]`;
  const workerReport = "### [Worker final report]\n\nAll 7 items verified and passing.";
  const events: ProviderEvent[] = [];
  const spawn: SpawnFunction = () => {
    const child = new ProtocolChild(() => {
      // Step 1 calls edit_file (step 2), which is interrupted at step 3 (ERROR_MESSAGE) and stays RUNNING in agy.
      // agy continues with steps 4..6 in transcript_full.jsonl, while stdout stepTracker stalls at step 2.
      const fullRows = [
        row(0, "USER_INPUT", { content: "Fix PR #670" }),
        row(1, "PLANNER_RESPONSE", {
          thinking: "Starting edit",
          tool_calls: [{ name: "edit_file", args: { Path: "/repo/src/catalog.js", Target: "a", Replacement: "b" } }],
        }),
        row(3, "ERROR_MESSAGE", {
          error: "The stream was interrupted. Please continue the task you were working on.",
          content: "Error: The stream was interrupted. Please continue the task you were working on.",
        }),
        row(4, "PLANNER_RESPONSE", {
          thinking: longThought,
          tool_calls: [{ name: "read_file", args: { Path: "/repo/src/catalog.js", StartLine: 1, EndLine: 20 } }],
        }),
        row(5, "GENERIC", { content: "1: const b = 2;" }),
        row(6, "PLANNER_RESPONSE", { thinking: "Finalizing report", content: workerReport }),
      ];
      const compactRows = fullRows.map(r =>
        r.step_index === 4
          ? { ...r, thinking: compactThought, truncated_fields: ["thinking"] }
          : r,
      );
      writeFileSync(compactFile, compactRows.map(v => JSON.stringify(v)).join("\n") + "\n");
      writeFileSync(fullFile, fullRows.map(v => JSON.stringify(v)).join("\n") + "\n");

      // Stdout only emits step 2 ACTIVE before stalling at step 2
      child.frame({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "edit_file",
          tool_info: {
            name: "edit_file",
            parameters: { Path: "/repo/src/catalog.js", Target: "a", Replacement: "b" },
          },
        },
      });
      child.frame({
        event: "result",
        result: {
          conversation_id: conv,
          status: "ERROR",
          finished_reason: "error",
          error: "The stream was interrupted. Please continue the task you were working on.",
          response: workerReport,
        },
      });
    });
    queueMicrotask(() => child.frame({ event: "init", conversation_id: conv }));
    return child as unknown as ReturnType<SpawnFunction>;
  };
  const session = new Session("synthetic-stalled", "agy", [], {}, config,
    { version: 1, data: { conversationId: conv } }, catalog, event => events.push(event),
    { spawn, storeDir: path.join(dir, "store"), brainDir: dir, autoCompactEnabled: false });
  try {
    await session.prompt({ clientMessageId: "stalled-req", delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "Fix PR #670" }] } });
    const deadline = Date.now() + 3000;
    while (!events.some(event => event.type === "session.turn" && event.state !== "started")) {
      assert.ok(Date.now() < deadline, "stalled stepTracker test did not settle");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const end = events.find(event => event.type === "session.turn" && event.state !== "started");
    assert.ok(end?.type === "session.turn");
    assert.equal(end.state, "completed");

    const latestById = new Map<string, Extract<ProviderEvent, { type: "timeline.item" }>["item"]>();
    for (const e of events) {
      if (e.type === "timeline.item") latestById.set(e.item.id, e.item);
    }
    const step4Reasoning = latestById.get("turn-1:step:4:reasoning");
    assert.ok(step4Reasoning?.type === "reasoning");
    assert.equal(step4Reasoning.text, longThought, "Must use untruncated thinking from transcript_full.jsonl");

    const step5Tool = latestById.get("turn-1:step:5");
    assert.ok(step5Tool?.type === "tool_call");
    assert.equal(step5Tool.status, "completed");
    assert.deepEqual(step5Tool.detail, {
      type: "read",
      filePath: "/repo/src/catalog.js",
      offset: 1,
      limit: 20,
      content: "1: const b = 2;",
    });

    const step6Msg = latestById.get("turn-1:step:6");
    assert.ok(step6Msg?.type === "assistant_message");
    assert.equal(step6Msg.text, workerReport);
  } finally { await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test("multi-step <thought> table truncation heals at step DONE without late reasoning split or duplicate :message:1", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-multistep-thought-table-"));
  const conv = "synthetic-multistep-thought";
  const logs = path.join(dir, conv, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const compactFile = path.join(logs, "transcript.jsonl");
  const fullFile = path.join(logs, "transcript_full.jsonl");

  const step1Full = "Checking `<thought>` truncation across step 1 before running verification.";
  const step1Prefix = step1Full.slice(0, step1Full.indexOf("<thought>"));
  const step3Full = [
    "### Table 1: Summary",
    "| Metric | Count |",
    "| :--- | :--- |",
    "| **Literal `<thought>` cutoff** | 4 |",
    "| **Completed** | 189 |",
    "",
    "### Table 2: Details",
    "| Session | Status |",
    "| :--- | :--- |",
    "| `a292a6cf` | Verified |",
  ].join("\n");
  const step3Prefix = step3Full.slice(0, step3Full.indexOf("<thought>"));
  const combinedTruncatedResponse = `${step1Prefix}\n${step3Prefix}\n`;

  const events: ProviderEvent[] = [];
  const spawn: SpawnFunction = () => {
    const child = new ProtocolChild(() => {
      const rows = [row(0, "USER_INPUT", { content: "Continue and show tables" })];
      writeFileSync(compactFile, rows.map(v => JSON.stringify(v)).join("\n") + "\n");
      writeFileSync(fullFile, rows.map(v => JSON.stringify(v)).join("\n") + "\n");

      // Step 1 streams ACTIVE prefix, then writes transcript on DONE and sends synthetic "\n"
      child.frame({
        event: "step_update",
        step_update: { step_index: 1, step_type: "agent_response", state: "ACTIVE", text_delta: step1Prefix },
      });
      const step1Row = row(1, "PLANNER_RESPONSE", { thinking: "Step 1 thinking", content: step1Full });
      appendFileSync(compactFile, JSON.stringify(step1Row) + "\n");
      appendFileSync(fullFile, JSON.stringify(step1Row) + "\n");
      child.frame({
        event: "step_update",
        step_update: { step_index: 1, step_type: "agent_response", state: "DONE", text_delta: "\n" },
      });

      // Step 2 tool call
      child.frame({
        event: "step_update",
        step_update: { step_index: 2, step_type: "tool", state: "DONE", tool_name: "run_command" },
      });

      // Step 3 streams ACTIVE prefix (cut at `<thought>`), then writes transcript on DONE and sends "\n"
      child.frame({
        event: "step_update",
        step_update: { step_index: 3, step_type: "agent_response", state: "ACTIVE", text_delta: step3Prefix },
      });
      const step3Row = row(3, "PLANNER_RESPONSE", { thinking: "Step 3 thinking", content: step3Full });
      appendFileSync(compactFile, JSON.stringify(step3Row) + "\n");
      appendFileSync(fullFile, JSON.stringify(step3Row) + "\n");
      child.frame({
        event: "step_update",
        step_update: { step_index: 3, step_type: "agent_response", state: "DONE", text_delta: "\n" },
      });

      child.frame({
        event: "result",
        result: {
          conversation_id: conv,
          status: "SUCCESS",
          finished_reason: "stop",
          response: combinedTruncatedResponse,
        },
      });
    });
    queueMicrotask(() => child.frame({ event: "init", conversation_id: conv }));
    return child as unknown as ReturnType<SpawnFunction>;
  };

  const session = new Session("synthetic-multistep", "agy", [], {}, config,
    { version: 1, data: { conversationId: conv } }, catalog, event => events.push(event),
    { spawn, storeDir: path.join(dir, "store"), brainDir: dir, autoCompactEnabled: false });
  try {
    await session.prompt({ clientMessageId: "multi-req", delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "Continue and show tables" }] } });
    const deadline = Date.now() + 3000;
    while (!events.some(event => event.type === "session.turn" && event.state !== "started")) {
      assert.ok(Date.now() < deadline, "multi-step <thought> test did not settle");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const timelineEvents = events.filter(
      (e): e is Extract<ProviderEvent, { type: "timeline.item" }> => e.type === "timeline.item",
    );
    // Live timeline must keep each step's ACTIVE + DONE assistant_message updates contiguous
    // (never split by reasoning in the middle), never re-emit step 1 after step 2, and never emit :message:1
    assert.deepEqual(
      timelineEvents.map(e => `${e.item.id}:${e.item.type}`),
      [
        "user:multi-req:user_message",
        "turn-1:step:1:assistant_message",
        "turn-1:step:1:assistant_message",
        "turn-1:step:1:reasoning:reasoning",
        "turn-1:step:2:tool_call",
        "turn-1:step:3:assistant_message",
        "turn-1:step:3:assistant_message",
        "turn-1:step:3:reasoning:reasoning",
      ],
    );
    // Each step's second emission must start with its first emission so Paseo's mapTimelineItem
    // computes a pure suffix delta and TimelineProjection merges it into a single bubble.
    const step1Updates = timelineEvents
      .filter(e => e.item.id === "turn-1:step:1" && e.item.type === "assistant_message")
      .map(e => (e.item as { text: string }).text);
    assert.equal(step1Updates.length, 2);
    assert.equal(step1Updates[0], step1Prefix);
    assert.equal(step1Updates[1], step1Full);
    assert.equal(step1Updates[1]!.startsWith(step1Updates[0]!), true);

    const step3Updates = timelineEvents
      .filter(e => e.item.id === "turn-1:step:3" && e.item.type === "assistant_message")
      .map(e => (e.item as { text: string }).text);
    assert.equal(step3Updates.length, 2);
    assert.equal(step3Updates[0], step3Prefix);
    assert.equal(step3Updates[1], step3Full);
    assert.equal(step3Updates[1]!.startsWith(step3Updates[0]!), true);

    // Durable store still records reasoning ordered before each step for future replay
    const storedIds = session.getStore().load(conv).map(r => r.id);
    assert.deepEqual(storedIds, [
      "user:multi-req",
      "turn-1:step:1:reasoning",
      "turn-1:step:1",
      "turn-1:step:2",
      "turn-1:step:3:reasoning",
      "turn-1:step:3",
    ]);
  } finally {
    await session.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evicted native <conversationId>.db recovers history into a new CLI trajectory and migrates store instead of failing with 'refusing to mix histories'", async () => {
  for (const mode of ["proactive-missing-db", "reactive-init-mismatch", "unrecoverable-unknown"] as const) {
    const dir = mkdtempSync(path.join(tmpdir(), `agy-evicted-db-${mode}-`));
    const brainDir = path.join(dir, "brain");
    const convDir = path.join(dir, "conversations");
    const storeDir = path.join(dir, "store");
    mkdirSync(brainDir, { recursive: true });
    mkdirSync(convDir, { recursive: true });
    mkdirSync(storeDir, { recursive: true });

    const oldConv = "0f0ef4f7-e66c-4c4f-a6e0-c3e15f81f0f9";
    const newConv = "c1692b97-06d8-444f-82c0-ee0bc760169e";

    if (mode !== "unrecoverable-unknown") {
      const oldLogs = path.join(brainDir, oldConv, ".system_generated", "logs");
      mkdirSync(oldLogs, { recursive: true });
      writeFileSync(
        path.join(oldLogs, "transcript_full.jsonl"),
        [
          JSON.stringify(row(0, "USER_INPUT", { content: "<USER_REQUEST>\nAnalyze trade_atm\n</USER_REQUEST>" })),
          JSON.stringify(row(1, "CHECKPOINT", { content: "Checkpoint summary: trade_atm uses 5m bars." })),
          JSON.stringify(row(2, "PLANNER_RESPONSE", { content: "Initial trade_atm analysis complete." })),
        ].join("\n") + "\n",
      );
      if (mode === "reactive-init-mismatch") {
        // Simulate .db file still existing on disk when checked, but agy ignoring --conversation at init
        writeFileSync(path.join(convDir, `${oldConv}.db`), "corrupted-or-ignored");
      }
    } else {
      // Create .db so proactive check passes, but no history in store or brain
      writeFileSync(path.join(convDir, `${oldConv}.db`), "dummy");
    }

    const events: ProviderEvent[] = [];
    const sentPrompts: Array<{ args: readonly string[]; content: string }> = [];
    const spawn: SpawnFunction = (_cmd, args) => {
      const child = new ProtocolChild(() => {
        child.frame({
          event: "step_update",
          step_update: { step_index: 1, step_type: "agent_response", state: "DONE", text_delta: "Recovered reply" },
        });
        child.frame({
          event: "result",
          result: { conversation_id: newConv, status: "SUCCESS", finished_reason: "stop", response: "Recovered reply" },
        });
      });
      let buf = "";
      child.stdin.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        while (buf.includes("\n")) {
          const idx = buf.indexOf("\n");
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) sentPrompts.push({ args: [...args], content: (JSON.parse(line) as { content: string }).content });
        }
      });
      queueMicrotask(() => child.frame({ event: "init", conversation_id: newConv }));
      return child as unknown as ReturnType<SpawnFunction>;
    };

    const session = new Session(`sess-${mode}`, "agy", [], {}, config,
      { version: 1, data: { conversationId: oldConv, sessionKey: `key-${mode}` } },
      catalog, event => events.push(event),
      { spawn, storeDir, brainDir, autoCompactEnabled: false });
    try {
      await session.prompt({ clientMessageId: "follow-up-1", delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "What bar interval does trade_atm use?" }] } });
      const deadline = Date.now() + 3000;
      while (!events.some(event => event.type === "session.turn" && event.state !== "started")) {
        assert.ok(Date.now() < deadline, `${mode} did not settle`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const end = events.find(
        (event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
          event.type === "session.turn" && event.state !== "started",
      );
      assert.ok(end);

      if (mode === "unrecoverable-unknown") {
        assert.equal(end.state, "failed");
        assert.match(end.error?.message ?? "", /refusing to mix histories/);
        continue;
      }

      assert.equal(end.state, "completed", `${mode} should recover transparently`);
      const lastSent = sentPrompts.at(-1);
      assert.ok(lastSent);
      assert.equal(lastSent.args.includes("--conversation"), false);
      assert.match(lastSent.content, /<CONVERSATION_HISTORY_RECOVERY>/);
      assert.match(lastSent.content, /Checkpoint summary: trade_atm uses 5m bars\./);
      assert.match(lastSent.content, /Initial trade_atm analysis complete\./);
      assert.match(lastSent.content, /What bar interval does trade_atm use\?/);

      const persistenceEvents = events.filter(
        (e): e is Extract<ProviderEvent, { type: "session.persistence" }> => e.type === "session.persistence",
      );
      assert.equal(
        (persistenceEvents.at(-1)?.persistence.data as { conversationId?: string } | undefined)?.conversationId,
        newConv,
      );

      const migratedRecords = session.getStore().load(newConv);
      assert.ok(migratedRecords.some(r => r.item.type === "assistant_message" && r.item.text === "Initial trade_atm analysis complete."));
      assert.ok(migratedRecords.some(r => r.item.type === "assistant_message" && r.item.text === "Recovered reply"));
      assert.equal(session.getStore().resolveConversationId(`key-${mode}`), newConv);
    } finally {
      await session.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
