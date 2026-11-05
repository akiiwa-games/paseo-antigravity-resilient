import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { DEFAULT_MODE, MODES } from "../server/internal/catalog.ts";
import { Session } from "../server/internal/session.ts";
import { ConversationStore } from "../server/internal/store.ts";
import { replayTimelineItem, stepToolDetail, toolDetail } from "../server/internal/timeline.ts";

const legacy: ProviderTimelineItem = {
  id: "turn-3:auto-compact", type: "notification", level: "info",
  message: "Auto-compacted context (180,000 tokens) 1m before 5m hot cache expiry.",
};

test("legacy idle compaction replays in chronological history, never opening notifications", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-replay-order-"));
  try {
    const store = new ConversationStore({ storeDir: dir });
    store.upsert("conv-order", { id: "turn-2:message:1", type: "assistant_message", text: "Morning" }, "2040-01-02T12:30:00Z");
    store.upsert("conv-order", legacy, "2040-01-02T12:38:33Z");
    store.upsert("conv-order", { id: "turn-4:message:1", type: "assistant_message", text: "Afternoon" }, "2040-01-02T19:06:40Z");
    store.flush("conv-order");
    const original = readFileSync(store.snapshotPath("conv-order"), "utf8");
    for (let reopen = 0; reopen < 3; reopen++) {
      const events: ProviderEvent[] = [];
      const session = new Session(`reopen-${reopen}`, "agy", [], {}, {
        cwd: dir, env: {}, mcpServers: {}, settings: {}, persist: true, mode: "full-access",
      }, { version: 1, data: { conversationId: "conv-order" } }, {
        models: [], modes: MODES, defaultMode: DEFAULT_MODE,
      }, (event) => events.push(event), {
        storeDir: dir, spawn: () => { throw new Error("History replay must never start agy or compact"); },
      });
      session.open("open", ["session.persistence"], "replay");
      const timeline = events.filter((event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item");
      assert.deepEqual(timeline.map((e) => e.item.id), ["turn-2:message:1", "turn-3:auto-compact", "turn-4:message:1"]);
      assert.equal(timeline[1].timestamp, "2040-01-02T12:38:33Z");
      assert.deepEqual(timeline[1].item, { id: legacy.id, type: "compaction", status: "completed", trigger: "auto", preTokens: 180000 });
      // Installed Paseo 0.11.2 PluginAgentSession extracts precisely this list
      // and appends it on registration when durable history already exists.
      assert.deepEqual(timeline.filter((e) => e.item.type === "notification"), []);
      assert.equal(events.some((e) => e.type === "session.turn"), false);
      await session.dispose();
    }
    assert.equal(readFileSync(store.snapshotPath("conv-order"), "utf8"), original, "Read-time migration must not rewrite historical data");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy compaction migration is narrow and idempotent", () => {
  const migrated = replayTimelineItem(legacy);
  assert.equal(replayTimelineItem(migrated), migrated);
  for (const other of [
    { ...legacy, id: "permission-warning" },
    { ...legacy, message: "Other warning" },
    { ...legacy, message: "Auto-compacted context (99999999999999999999 tokens) 1m before 5m hot cache expiry." },
  ]) assert.equal(replayTimelineItem(other), other);
});

test("reopening a persisted unfinished tool does not revive its spinner or rewrite history", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-replay-tool-"));
  let session: Session | undefined;
  try {
    const store = new ConversationStore({ storeDir: dir });
    store.upsert("conv-tool", { id: "turn-4:step:138", type: "tool_call", callId: "turn-4:step:138",
      name: "run_command", detail: { type: "shell", command: "python probe.py" }, status: "running", error: null });
    store.flush("conv-tool");
    const original = readFileSync(store.snapshotPath("conv-tool"), "utf8");
    const events: ProviderEvent[] = [];
    session = new Session("reopen", "agy", [], {}, {
      cwd: dir, env: {}, mcpServers: {}, settings: {}, persist: true, mode: "full-access",
    }, { version: 1, data: { conversationId: "conv-tool" } }, {
      models: [], modes: MODES, defaultMode: DEFAULT_MODE,
    }, event => events.push(event), { storeDir: dir, brainDir: dir,
      spawn: () => { throw new Error("Replay must not re-execute a command"); } });
    session.open("open", ["session.persistence"], "replay");
    const row = events.find(e => e.type === "timeline.item" && e.item.type === "tool_call");
    assert.ok(row?.type === "timeline.item" && row.item.type === "tool_call");
    assert.equal(row.item.status, "canceled");
    assert.equal(readFileSync(store.snapshotPath("conv-tool"), "utf8"), original);
  } finally { await session?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});


test("step-indexed block ordering normalizes reasoning before same-step message and subsequent tool calls", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-step-order-"));
  try {
    const store = new ConversationStore({ storeDir: dir });
    store.upsert("conv-step-order", { id: "user:msg-1", type: "user_message", text: "Hello" });
    // Pattern 1: assistant_message (turn-1:step:8) arrives ACTIVE before turn-1:step:8:reasoning
    store.upsert("conv-step-order", { id: "turn-1:step:8", messageId: "turn-1:step:8", type: "assistant_message", text: "Answer" });
    store.upsert("conv-step-order", { id: "turn-1:step:8:reasoning", type: "reasoning", text: "Thought for step 8" });
    // Pattern 2: tool_call (turn-1:step:42) arrives before turn-1:step:41:reasoning
    store.upsert("conv-step-order", { id: "turn-1:step:42", type: "tool_call", callId: "turn-1:step:42",
      name: "read_file", detail: { type: "unknown", input: {}, output: null }, status: "completed", error: null });
    store.upsert("conv-step-order", { id: "turn-1:step:41:reasoning", type: "reasoning", text: "Thought for step 41" });
    // Pattern 3: bunched reasoning blocks (step 46:reasoning) arriving before earlier tool calls (step 43, 45)
    store.upsert("conv-step-order", { id: "turn-1:step:46:reasoning", type: "reasoning", text: "Thought for step 46" });
    store.upsert("conv-step-order", { id: "turn-1:step:43", type: "tool_call", callId: "turn-1:step:43",
      name: "run_command", detail: { type: "unknown", input: {}, output: null }, status: "completed", error: null });
    store.upsert("conv-step-order", { id: "turn-1:step:45", type: "tool_call", callId: "turn-1:step:45",
      name: "run_command", detail: { type: "unknown", input: {}, output: null }, status: "completed", error: null });
    store.upsert("conv-step-order", { id: "turn-1:step:47", type: "tool_call", callId: "turn-1:step:47",
      name: "run_command", detail: { type: "unknown", input: {}, output: null }, status: "completed", error: null });
    store.flush("conv-step-order");

    const loaded = store.load("conv-step-order");
    assert.deepEqual(loaded.map(r => r.id), [
      "user:msg-1",
      "turn-1:step:8:reasoning",
      "turn-1:step:8",
      "turn-1:step:41:reasoning",
      "turn-1:step:42",
      "turn-1:step:43",
      "turn-1:step:45",
      "turn-1:step:46:reasoning",
      "turn-1:step:47",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("late reasoning upserts for earlier turns stay inside their own turns and never push assistant messages after later turns", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-cross-turn-order-"));
  try {
    const store = new ConversationStore({ storeDir: dir });
    // Turn 5 originally persisted without some reasoning steps
    store.upsert("conv-cross-turn", { id: "turn-5:step:2", type: "tool_call", callId: "turn-5:step:2",
      name: "read_file", detail: { type: "unknown", input: {}, output: null }, status: "completed", error: null });
    store.upsert("conv-cross-turn", { id: "turn-5:step:28", type: "tool_call", callId: "turn-5:step:28",
      name: "edit_file", detail: { type: "unknown", input: {}, output: null }, status: "completed", error: null });
    store.upsert("conv-cross-turn", { id: "turn-5:step:39", messageId: "turn-5:step:39", type: "assistant_message", text: "Turn 5 final answer" });

    // Turn 6
    store.upsert("conv-cross-turn", { id: "user:msg-turn-6", type: "user_message", text: "Turn 6 question" });
    store.upsert("conv-cross-turn", { id: "turn-6:step:41", messageId: "turn-6:step:41", type: "assistant_message", text: "Turn 6 final answer" });

    // Turn 7
    store.upsert("conv-cross-turn", { id: "user:msg-turn-7", type: "user_message", text: "Turn 7 question" });
    store.upsert("conv-cross-turn", { id: "turn-7:step:44:reasoning", type: "reasoning", text: "Turn 7 thought" });
    store.upsert("conv-cross-turn", { id: "turn-7:step:45", type: "tool_call", callId: "turn-7:step:45",
      name: "read_file", detail: { type: "unknown", input: {}, output: null }, status: "completed", error: null });
    store.upsert("conv-cross-turn", { id: "turn-7:step:55", messageId: "turn-7:step:55", type: "assistant_message", text: "Turn 7 final answer" });

    // Now backfill reasoning steps for turn 5 (including around a mid-turn native checkpoint) and turn 6
    store.upsert("conv-cross-turn", { id: "native-checkpoint:27", type: "compaction", status: "completed", trigger: "auto" });
    store.upsert("conv-cross-turn", { id: "turn-5:step:1:reasoning", type: "reasoning", text: "Turn 5 initial thought" });
    store.upsert("conv-cross-turn", { id: "turn-5:step:39:reasoning", type: "reasoning", text: "Turn 5 final thought" });
    store.upsert("conv-cross-turn", { id: "turn-6:step:41:reasoning", type: "reasoning", text: "Turn 6 thought" });
    store.flush("conv-cross-turn");

    const loaded = store.load("conv-cross-turn");
    assert.deepEqual(loaded.map(r => r.id), [
      "turn-5:step:1:reasoning",
      "turn-5:step:2",
      "native-checkpoint:27",
      "turn-5:step:28",
      "turn-5:step:39:reasoning",
      "turn-5:step:39",
      "user:msg-turn-6",
      "turn-6:step:41:reasoning",
      "turn-6:step:41",
      "user:msg-turn-7",
      "turn-7:step:44:reasoning",
      "turn-7:step:45",
      "turn-7:step:55",
    ]);
    assert.deepEqual(loaded.map(r => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateConversation prepends predecessor turns without seq collisions when target conversation already has later turns", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-migrate-order-"));
  try {
    const store = new ConversationStore({ storeDir: dir });
    store.upsert("conv-prev", { id: "user:msg-turn-1", type: "user_message", text: "Turn 1 prompt" });
    store.upsert("conv-prev", { id: "turn-1:step:2", messageId: "turn-1:step:2", type: "assistant_message", text: "Turn 1 reply" });
    store.upsert("conv-prev", { id: "user:msg-turn-2", type: "user_message", text: "Turn 2 prompt" });
    store.flush("conv-prev");

    store.upsert("conv-next", { id: "turn-2:step:1:reasoning", type: "reasoning", text: "Turn 2 thought" });
    store.upsert("conv-next", { id: "turn-2:step:2", messageId: "turn-2:step:2", type: "assistant_message", text: "Turn 2 reply" });
    store.upsert("conv-next", { id: "user:msg-turn-3", type: "user_message", text: "Turn 3 prompt" });
    store.upsert("conv-next", { id: "turn-3:step:4", messageId: "turn-3:step:4", type: "assistant_message", text: "Turn 3 reply" });
    store.flush("conv-next");

    store.migrateConversation("conv-prev", "conv-next", "sess-1");
    const merged = store.load("conv-next");
    assert.deepEqual(merged.map(r => r.id), [
      "user:msg-turn-1",
      "turn-1:step:2",
      "user:msg-turn-2",
      "turn-2:step:1:reasoning",
      "turn-2:step:2",
      "user:msg-turn-3",
      "turn-3:step:4",
    ]);
    assert.deepEqual(merged.map(r => r.seq), [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agy 1.4.12 read_file, write_file, edit_file, and subagent_info map to canonical Paseo tool details", () => {
  assert.deepEqual(
    toolDetail("read_file", { Path: "/repo/src/index.ts", StartLine: 10, EndLine: 29 }, "line 10..29"),
    { type: "read", filePath: "/repo/src/index.ts", offset: 10, limit: 20, content: "line 10..29" },
  );
  assert.deepEqual(
    toolDetail("write_file", { Path: "/repo/src/new.ts", Content: "export const x = 1;\n" }),
    { type: "write", filePath: "/repo/src/new.ts", content: "export const x = 1;\n" },
  );
  assert.deepEqual(
    toolDetail("edit_file", {
      Path: "/repo/src/index.ts",
      Target: "const oldVal = 1;",
      Replacement: "const newVal = 2;",
    }),
    {
      type: "edit",
      filePath: "/repo/src/index.ts",
      oldString: "const oldVal = 1;",
      newString: "const newVal = 2;",
    },
  );
  assert.deepEqual(
    stepToolDetail({
      step_index: 7,
      state: "DONE",
      step_type: "subagent",
      tool_name: "invoke_subagent",
      subagent_info: {
        subagents: [
          {
            type_name: "research",
            initial_prompt: "Audit all sessions",
            conversation_id: "child-conv-1",
            log_uri: "file:///logs/child.jsonl",
          },
        ],
      },
    }),
    {
      type: "sub_agent",
      subAgentType: "research",
      description: "Audit all sessions",
      childSessionId: "child-conv-1",
      log: "file:///logs/child.jsonl",
    },
  );
  assert.deepEqual(
    stepToolDetail({
      step_index: 8,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "custom_banner",
    }),
    { type: "plain_text", label: "custom_banner", text: "" },
  );

  // replayTimelineItem upgrades persisted unknown read_file/write_file/edit_file items on read
  const legacyUnknownRead: ProviderTimelineItem = {
    id: "turn-1:step:2",
    type: "tool_call",
    callId: "turn-1:step:2",
    name: "read_file",
    detail: { type: "unknown", input: { Path: "/repo/README.md" }, output: "# Readme" },
    status: "completed",
    error: null,
  };
  const upgradedRead = replayTimelineItem(legacyUnknownRead);
  assert.equal(upgradedRead.type, "tool_call");
  if (upgradedRead.type === "tool_call") {
    assert.deepEqual(upgradedRead.detail, {
      type: "read",
      filePath: "/repo/README.md",
      content: "# Readme",
    });
  }
});
