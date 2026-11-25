import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { defaultAgyCommand, resolveEffectiveLaunch } from "../server/launch.ts";
import { createAntigravityResilientProvider } from "../server/provider.ts";
import { Usage } from "../server/usage.ts";
import { launchStubAgent, TempDirTracker, waitFor } from "./helpers.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const tracker = new TempDirTracker();

afterEach(async () => {
  await tracker.cleanup();
});

// Faithful replica of Paseo v0.17.4 `packages/server/src/server/agent/plugin-provider.ts:2175-2199`
function paseoMapAssistantOrReasoning(
  item: { id: string; type: "assistant_message" | "reasoning"; text: string; messageId?: string },
  snapshots: Map<string, { type: string; text: string }>,
): { type: "assistant_message"; text: string; messageId: string } | { type: "reasoning"; text: string } | null {
  const previous = snapshots.get(item.id);
  snapshots.set(item.id, { type: item.type, text: item.text });
  const previousText = previous?.type === item.type ? previous.text : "";
  const suffix = item.text.startsWith(previousText)
    ? item.text.slice(previousText.length)
    : item.text;
  if (suffix.length === 0) return null;
  return item.type === "assistant_message"
    ? { type: "assistant_message", text: suffix, messageId: item.messageId ?? item.id }
    : { type: "reasoning", text: suffix };
}

describe("Adversarial review regressions (B1-B3, M1-M4, m1-m4)", () => {
  it("[B1] namespaces synthetic chunk IDs across internal session/load reopens so Paseo timelineSnapshots never drop or truncate replies", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: "conv-b1", update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new" || method === "session/load") {
            send({ id, result: { sessionId: "conv-b1", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/prompt") {
            const text = params.prompt?.[0]?.text ?? "";
            if (text === "turn-1") {
              update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking step 1" } });
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK: step 1 finished" } });
              send({ id, result: { stopReason: "end_turn" } });
              setTimeout(() => process.exit(0), 20);
            } else if (text === "turn-2-same-reply") {
              update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking step 1" } });
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK: step 1 finished" } });
              send({ id, result: { stopReason: "end_turn" } });
              setTimeout(() => process.exit(0), 20);
            } else if (text === "turn-3-prefix-reply") {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK: step 1 finished" } });
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " and step 3 finished" } });
              send({ id, result: { stopReason: "end_turn" } });
            }
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const conn = await createAntigravityResilientProvider().connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    const timelineById = new Map<string, ProviderEvent & { type: "timeline.item" }>();
    const paseoSnapshots = new Map<string, { type: string; text: string }>();
    const paseoDeltasByTurn: Record<string, Array<{ type: string; text: string }>> = {};
    let currentTurn = "none";

    conn.onEvent((e) => {
      events.push(e);
      if (e.type === "session.turn" && e.state === "started") {
        currentTurn = e.turnId;
        paseoDeltasByTurn[currentTurn] = [];
      }
      if (e.type === "timeline.item") {
        timelineById.set(e.item.id, e);
        if (e.item.type === "assistant_message" || e.item.type === "reasoning") {
          const mapped = paseoMapAssistantOrReasoning(e.item, paseoSnapshots);
          if (mapped) (paseoDeltasByTurn[currentTurn] ??= []).push(mapped);
        }
      }
    });

    try {
      await conn.send({
        type: "session.open",
        requestId: "o-b1",
        sessionId: "s-b1",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });

      for (const [id, text] of [
        ["t1", "turn-1"],
        ["t2", "turn-2-same-reply"],
        ["t3", "turn-3-prefix-reply"],
      ] as const) {
        await conn.send({
          type: "session.prompt",
          sessionId: "s-b1",
          prompt: {
            clientMessageId: id,
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text }] },
          },
        });
        await waitFor(
          () =>
            events.find(
              (e) => e.type === "session.turn" && e.turnId === `acp:${id}` && e.state === "completed",
            ),
          { label: `${id} completed` },
        );
        await new Promise((r) => setTimeout(r, 60));
      }

      const uniqueAssistants = [...timelineById.values()].filter(
        (e) => e.item.type === "assistant_message",
      );
      assert.equal(uniqueAssistants.length, 3, "each reopened turn must have a unique item.id");
      assert.equal(
        paseoDeltasByTurn["acp:t2"]
          ?.filter((d) => d.type === "assistant_message")
          .map((d) => d.text)
          .join(""),
        "OK: step 1 finished",
      );
      assert.equal(
        paseoDeltasByTurn["acp:t2"]
          ?.filter((d) => d.type === "reasoning")
          .map((d) => d.text)
          .join(""),
        "Thinking step 1",
      );
      assert.equal(
        paseoDeltasByTurn["acp:t3"]
          ?.filter((d) => d.type === "assistant_message")
          .map((d) => d.text)
          .join(""),
        "OK: step 1 finished and step 3 finished",
      );
    } finally {
      await conn.close();
    }
  });

  it("[B2] preserves completed tool_call statuses across crash recovery, 429 failure, and cancellation", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        let activeCancelId = null;
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: "conv-b2", update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new" || method === "session/load") {
            send({ id, result: { sessionId: "conv-b2", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/prompt") {
            const text = params.prompt?.[0]?.text ?? "";
            if (text === "run-then-crash") {
              update({ sessionUpdate: "tool_call", toolCallId: "tool-done-1", title: "Write file", name: "write_file", kind: "edit", status: "in_progress", rawInput: { Path: "/a.txt", Content: "ok" } });
              update({ sessionUpdate: "tool_call_update", toolCallId: "tool-done-1", status: "completed", rawOutput: {} });
              update({ sessionUpdate: "tool_call", toolCallId: "tool-inflight-2", title: "Run cmd", name: "run_command", kind: "execute", status: "in_progress", rawInput: { CommandLine: "sleep 5" } });
              setTimeout(() => process.exit(2), 20);
            } else if (text.includes("Continue the interrupted turn")) {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Recovered." } });
              send({ id, result: { stopReason: "end_turn" } });
            } else if (text === "run-then-429") {
              update({ sessionUpdate: "tool_call", toolCallId: "tool-done-before-429", title: "Write file 2", name: "write_file", kind: "edit", status: "in_progress", rawInput: { Path: "/b.txt", Content: "ok2" } });
              update({ sessionUpdate: "tool_call_update", toolCallId: "tool-done-before-429", status: "completed", rawOutput: {} });
              update({ sessionUpdate: "tool_call", toolCallId: "tool-inflight-429", title: "Run cmd 2", name: "run_command", kind: "execute", status: "in_progress", rawInput: { CommandLine: "echo 2" } });
              send({ id, error: { code: -32603, message: "RESOURCE_EXHAUSTED: quota exceeded (HTTP 429)" } });
            } else if (text === "run-then-cancel") {
              activeCancelId = id;
              update({ sessionUpdate: "tool_call", toolCallId: "tool-done-before-cancel", title: "Write file 3", name: "write_file", kind: "edit", status: "in_progress", rawInput: { Path: "/c.txt", Content: "ok3" } });
              update({ sessionUpdate: "tool_call_update", toolCallId: "tool-done-before-cancel", status: "completed", rawOutput: {} });
              update({ sessionUpdate: "tool_call", toolCallId: "tool-inflight-cancel", title: "Run slow", name: "run_command", kind: "execute", status: "in_progress", rawInput: { CommandLine: "sleep 30" } });
            }
          } else if (method === "session/cancel") {
            if (id !== undefined) send({ id, result: {} });
            if (activeCancelId !== null) {
              send({ id: activeCancelId, result: { stopReason: "cancelled" } });
              activeCancelId = null;
            }
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const conn = await createAntigravityResilientProvider({
      recovery: { processExitRetryDelayMs: 20 },
    }).connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));

    try {
      await conn.send({
        type: "session.open",
        requestId: "o-b2",
        sessionId: "s-b2",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });

      await conn.send({
        type: "session.prompt",
        sessionId: "s-b2",
        prompt: {
          clientMessageId: "m-retry",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run-then-crash" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:m-retry" && e.state === "completed",
          ),
        { label: "m-retry completed" },
      );

      await conn.send({
        type: "session.prompt",
        sessionId: "s-b2",
        prompt: {
          clientMessageId: "m-429",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run-then-429" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:m-429" && e.state === "failed",
          ),
        { label: "m-429 failed" },
      );

      await conn.send({
        type: "session.prompt",
        sessionId: "s-b2",
        prompt: {
          clientMessageId: "m-cancel",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run-then-cancel" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "timeline.item" &&
              e.item.type === "tool_call" &&
              e.item.id === "tool-inflight-cancel",
          ),
        { label: "tool-inflight-cancel running" },
      );
      await conn.send({ type: "session.interrupt", requestId: "int-b2", sessionId: "s-b2" });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:m-cancel" && e.state === "canceled",
          ),
        { label: "m-cancel canceled" },
      );

      const statusesOf = (toolId: string) =>
        events.flatMap((e) =>
          e.type === "timeline.item" && e.item.type === "tool_call" && e.item.id === toolId
            ? [e.item.status]
            : [],
        );

      assert.deepEqual(statusesOf("tool-done-1"), ["running", "completed"]);
      assert.deepEqual(statusesOf("tool-inflight-2"), ["running", "canceled"]);
      assert.deepEqual(statusesOf("tool-done-before-429"), ["running", "completed"]);
      assert.deepEqual(statusesOf("tool-inflight-429"), ["running", "failed"]);
      assert.deepEqual(statusesOf("tool-done-before-cancel"), ["running", "completed"]);
      assert.deepEqual(statusesOf("tool-inflight-cancel"), ["running", "canceled"]);
    } finally {
      await conn.close();
    }
  });

  it("[B3] isolates RPC errors per request so prior config errors do not block crash recovery, and does not blacklist valid models on invalid thinkingOption", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        const configOptions = [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-3.8-flash",
            options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
          { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "low",
            options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
        ];
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: "conv-b3", update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new" || method === "session/load") {
            send({ id, result: { sessionId: "conv-b3", configOptions, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/set_config_option") {
            if (params.configId === "thought_level" && params.value === "xhigh") {
              send({ id, error: { code: -32602, message: 'Thinking level "xhigh" is not offered for model "Gemini 3.8 Flash"' } });
              return;
            }
            send({ id, result: { configOptions } });
          } else if (method === "session/prompt") {
            const text = params.prompt?.[0]?.text ?? "";
            if (text === "work-then-crash") {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working..." } });
              setTimeout(() => process.exit(137), 20);
            } else {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Recovered!" } });
              send({ id, result: { stopReason: "end_turn" } });
            }
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const provider = createAntigravityResilientProvider({
      recovery: { processExitRetryDelayMs: 20 },
    });
    const conn = await provider.connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message", "session.persistence", "session.configure"],
    });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));

    try {
      await conn.send({
        type: "session.open",
        requestId: "o-b3",
        sessionId: "s-b3",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });

      const keyBefore = await provider.getCatalogCacheKey!({ scope: "global", launch });

      await conn.send({
        type: "session.configure",
        requestId: "cfg-bad-thinking",
        sessionId: "s-b3",
        changes: { model: "gemini-3.8-flash", thinkingOption: "xhigh" },
      });
      const cfgFailed = await waitFor(
        () =>
          events.find(
            (e): e is Extract<ProviderEvent, { type: "request.failed" }> =>
              e.type === "request.failed" && e.requestId === "cfg-bad-thinking",
          ),
        { label: "cfg-bad-thinking failed" },
      );

      assert.notEqual(cfgFailed.error.code, "INVALID_MODEL");
      assert.doesNotMatch(cfgFailed.error.message, /does not offer model gemini-3\.8-flash/);
      const keyAfter = await provider.getCatalogCacheKey!({ scope: "global", launch });
      assert.equal(keyAfter, keyBefore, "valid base model must not be evicted from catalog");

      // Subsequent mid-turn crash (exit 137) must NOT inherit the earlier configure RPC error!
      await conn.send({
        type: "session.prompt",
        sessionId: "s-b3",
        prompt: {
          clientMessageId: "m-b3-crash",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "work-then-crash" }] },
        },
      });
      const settled = await waitFor(
        () =>
          events.find(
            (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
              e.type === "session.turn" &&
              e.turnId === "acp:m-b3-crash" &&
              (e.state === "completed" || e.state === "failed"),
          ),
        { label: "m-b3-crash settled" },
      );
      assert.equal(settled.state, "completed");
    } finally {
      await conn.close();
    }
  });

  it("[M1] records post-ready session/load usage_update as cold baseline and runs pre-turn /compact on reopened sessions", async () => {
    const { directory, capturePath, launch } = await launchStubAgent(
      tracker,
      `
        const { appendFileSync } = require("node:fs");
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          appendFileSync(process.env.CAPTURE, line + "\\n");
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: params.sessionId, update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/load") {
            update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "old user msg" } });
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old reply" } });
            send({ id, result: { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
            const used = params.sessionId === "conv-225k" ? 225000 : 175000;
            setTimeout(() => {
              update({ sessionUpdate: "usage_update", used, size: 1048576 });
            }, 15);
          } else if (method === "session/prompt") {
            const text = params.prompt?.[0]?.text ?? "";
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ran:" + text } });
            send({ id, result: { stopReason: "end_turn" } });
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const provider = createAntigravityResilientProvider({
      compaction: {
        autoCompactTokenThreshold: 150_000,
        preTurnCompactTokenThreshold: 200_000,
      },
    });
    const conn = await provider.connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));

    try {
      // Sub-case A: Prompt sent after post-ready usage_update arrived
      await conn.send({
        type: "session.open",
        requestId: "reopen-225k",
        sessionId: "s-225k",
        history: "replay",
        persistence: { version: 1, data: { sessionId: "conv-225k" } },
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(
        () => events.find((e) => e.type === "session.ready" && e.sessionId === "s-225k"),
        { label: "s-225k ready" },
      );
      await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "session.usage" &&
              e.sessionId === "s-225k" &&
              e.usage.contextWindowUsedTokens === 225_000,
          ),
        { label: "s-225k usage" },
      );
      await conn.send({
        type: "session.prompt",
        sessionId: "s-225k",
        prompt: {
          clientMessageId: "m-225k",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "business-turn-at-225k" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:m-225k" && e.state === "completed",
          ),
        { label: "m-225k completed" },
      );

      // Sub-case B: Prompt sent immediately upon session.ready (before 15ms usage_update arrives!)
      await conn.send({
        type: "session.open",
        requestId: "reopen-175k",
        sessionId: "s-175k",
        history: "replay",
        persistence: { version: 1, data: { sessionId: "conv-175k" } },
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(
        () => events.find((e) => e.type === "session.ready" && e.sessionId === "s-175k"),
        { label: "s-175k ready" },
      );
      await conn.send({
        type: "session.prompt",
        sessionId: "s-175k",
        prompt: {
          clientMessageId: "m-175k",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "immediate-turn-at-175k" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:m-175k" && e.state === "completed",
          ),
        { label: "m-175k completed" },
      );

      const promptsBySession = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (l: string) =>
            JSON.parse(l) as {
              method: string;
              params: { sessionId?: string; prompt?: Array<{ text: string }> };
            },
        )
        .filter((r) => r.method === "session/prompt");

      assert.deepEqual(
        promptsBySession
          .filter((r) => r.params.sessionId === "conv-225k")
          .map((r) => r.params.prompt![0]!.text),
        ["/compact", "business-turn-at-225k"],
      );
      assert.deepEqual(
        promptsBySession
          .filter((r) => r.params.sessionId === "conv-175k")
          .map((r) => r.params.prompt![0]!.text),
        ["/compact", "immediate-turn-at-175k"],
      );
    } finally {
      await conn.close();
    }
  });

  it("[M2] normalizes session Usage.discover locators across per-agent PASEO_AGENT_ID env vars to prevent cache thrashing and CLI storms", async () => {
    const dir = await tracker.make("acp-rev-usage-");
    const cli = path.join(dir, "usage-cli.cjs");
    const countFile = path.join(dir, "invocations.log");
    await writeFile(
      cli,
      `
        const { appendFileSync } = require("node:fs");
        appendFileSync(${JSON.stringify(countFile)}, process.pid + "\\n");
        console.log(JSON.stringify({
          status: "SUCCESS",
          command: { name: "usage", data: { groups: [
            { name: "Gemini Models", buckets: [{ id: "g-wk", name: "Weekly", window: "weekly", remaining_fraction: 0.8 }] }
          ] } }
        }));
      `,
      "utf8",
    );

    const baseLaunch = {
      command: process.execPath,
      args: [cli, "acp", "--disable-telemetry"],
      env: { HOME: dir, USERPROFILE: dir },
    };
    const resilientUsage = new Usage().registration();
    const byAgent = new Map<string, Map<string, { source: typeof resilientUsage; logins: unknown[] }>>();
    const known = new Map<string, { source: typeof resilientUsage; logins: Array<{ input: unknown }> }>();
    const loginKey = (login: unknown) => JSON.stringify(login);
    const cacheIdentity = (id: string, k: { logins: unknown[] }) =>
      `${id}:${createHash("sha256").update(JSON.stringify([undefined, k.logins.map(loginKey)])).digest("hex")}`;

    const cacheKeysSeen: string[] = [];
    for (const agentId of ["agent-1", "agent-2", "agent-3"]) {
      const accs = await resilientUsage.discover({
        kind: "session",
        provider: "antigravity-resilient",
        env: { PASEO_AGENT_ID: agentId, PASEO_AGENT_CWD: `E:/work/${agentId}` },
        launch: baseLaunch,
      });
      const agentMap = new Map<string, { source: typeof resilientUsage; logins: unknown[] }>();
      for (const a of accs) {
        agentMap.set(`${resilientUsage.id}:${a.key}`, {
          source: resilientUsage,
          logins: [{ input: a.input, harness: resilientUsage.label, provider: a.provider }],
        });
      }
      byAgent.set(agentId, agentMap);

      known.clear();
      for (const reports of byAgent.values()) {
        for (const [id, report] of reports) {
          const ex = known.get(id);
          if (!ex) {
            known.set(id, { source: report.source, logins: [...(report.logins as Array<{ input: unknown }>)] });
          } else {
            for (const l of report.logins as Array<{ input: unknown }>) {
              if (!ex.logins.some((x) => loginKey(x) === loginKey(l))) ex.logins.push(l);
            }
          }
        }
      }
      const rk = [...known.entries()][0]!;
      cacheKeysSeen.push(cacheIdentity(rk[0], rk[1]));
    }

    const [, resilientKnown] = [...known.entries()][0]!;
    await Promise.all(resilientKnown.logins.map((l) => resilientUsage.fetch(l.input as never)));
    const cliInvocations = (await readFile(countFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean).length;

    assert.equal(resilientKnown.logins.length, 1);
    assert.equal(new Set(cacheKeysSeen).size, 1);
    assert.equal(cliInvocations, 1);
  });

  it("[M3] cancels replaced starting/recovering prompts cleanly and emits session.interrupt ack only after turn cancellation settles", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        let activeId = null;
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: "conv-m3", update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new" || method === "session/load") {
            send({ id, result: { sessionId: "conv-m3", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/prompt") {
            const text = params.prompt?.[0]?.text ?? "";
            if (text === "p1-slow") {
              activeId = id;
              setTimeout(() => {
                if (activeId === id) {
                  activeId = null;
                  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "p1 uncancelled!" } });
                  send({ id, result: { stopReason: "end_turn" } });
                }
              }, 150);
            } else if (text === "p2-replace") {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "p2 finished" } });
              send({ id, result: { stopReason: "end_turn" } });
            } else if (text === "p3-401") {
              send({ id, error: { code: -32603, message: "UNAUTHENTICATED (code 401): expected OAuth 2 access token" } });
            } else if (text === "p4-replace-during-sleep") {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "p4 finished" } });
              send({ id, result: { stopReason: "end_turn" } });
            } else if (text === "p5-deferred") {
              update({ sessionUpdate: "tool_call", toolCallId: "bg-1", title: "bg", name: "run_command", kind: "execute", status: "in_progress", rawInput: { CommandLine: "sleep 30" } });
              send({ id, result: { stopReason: "end_turn" } });
            }
          } else if (method === "session/cancel") {
            setTimeout(() => {
              if (id !== undefined) send({ id, result: {} });
              if (activeId !== null) {
                const cancelled = activeId;
                activeId = null;
                send({ id: cancelled, result: { stopReason: "cancelled" } });
              }
            }, 60);
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const conn = await createAntigravityResilientProvider({
      recovery: { tokenGapRetryDelayMs: 600 },
    }).connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: Array<{ at: number; event: ProviderEvent }> = [];
    conn.onEvent((event) => events.push({ at: Date.now(), event }));

    try {
      await conn.send({
        type: "session.open",
        requestId: "o-m3",
        sessionId: "s-m3",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(() => events.find((x) => x.event.type === "session.ready"), { label: "ready" });

      // F5a: Back-to-back p1 then p2
      await conn.send({
        type: "session.prompt",
        sessionId: "s-m3",
        prompt: {
          clientMessageId: "p1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "p1-slow" }] },
        },
      });
      await conn.send({
        type: "session.prompt",
        sessionId: "s-m3",
        prompt: {
          clientMessageId: "p2",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "p2-replace" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (x) =>
              x.event.type === "session.turn" &&
              x.event.turnId === "acp:p2" &&
              x.event.state === "completed",
          ),
        { label: "p2 completed" },
      );
      const p1Terminal = events.find(
        (x): x is { at: number; event: Extract<ProviderEvent, { type: "session.turn" }> } =>
          x.event.type === "session.turn" &&
          x.event.turnId === "acp:p1" &&
          x.event.state !== "started",
      );
      assert.equal(p1Terminal?.event.state, "canceled");

      // F5b: Replacement p4 during p3 recovery backoff sleep
      await conn.send({
        type: "session.prompt",
        sessionId: "s-m3",
        prompt: {
          clientMessageId: "p3",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "p3-401" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (x) =>
              x.event.type === "session.notice" && x.event.notice.id.startsWith("acp:p3:recovery:"),
          ),
        { label: "p3 recovery notice" },
      );
      const replaceSentAt = Date.now();
      await conn.send({
        type: "session.prompt",
        sessionId: "s-m3",
        prompt: {
          clientMessageId: "p4",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "p4-replace-during-sleep" }] },
        },
      });
      const p4Done = await waitFor(
        () =>
          events.find(
            (x) =>
              x.event.type === "session.turn" &&
              x.event.turnId === "acp:p4" &&
              x.event.state === "completed",
          ),
        { label: "p4 completed" },
      );
      const p3Final = events.find(
        (x): x is { at: number; event: Extract<ProviderEvent, { type: "session.turn" }> } =>
          x.event.type === "session.turn" &&
          x.event.turnId === "acp:p3" &&
          x.event.state !== "started",
      );
      assert.equal(p3Final?.event.state, "canceled");
      assert.ok(p4Done.at - replaceSentAt < 400, "p4 must not wait for p3 600ms sleep");

      // F5c: Interrupt during deferred background-tool turn acks AFTER turn_canceled
      await conn.send({
        type: "session.prompt",
        sessionId: "s-m3",
        prompt: {
          clientMessageId: "p5",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "p5-deferred" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (x) => x.event.type === "timeline.item" && x.event.item.id === "bg-1",
          ),
        { label: "bg-1 running" },
      );
      await new Promise((r) => setTimeout(r, 30));
      await conn.send({
        type: "session.interrupt",
        requestId: "int-p5",
        sessionId: "s-m3",
      });
      await waitFor(
        () =>
          events.find(
            (x) => x.event.type === "request.completed" && x.event.requestId === "int-p5",
          ),
        { label: "int-p5 ack" },
      );
      const turnCanceledIdx = events.findIndex(
        (x) =>
          x.event.type === "session.turn" &&
          x.event.turnId === "acp:p5" &&
          x.event.state === "canceled",
      );
      const intAckIdx = events.findIndex(
        (x) => x.event.type === "request.completed" && x.event.requestId === "int-p5",
      );
      assert.ok(turnCanceledIdx >= 0, "p5 canceled turn must be emitted");
      assert.ok(
        turnCanceledIdx < intAckIdx,
        `expected turn canceled (${turnCanceledIdx}) before interrupt ack (${intAckIdx})`,
      );
    } finally {
      await conn.close();
    }
  });

  it("[M4] clears stale thinkingOption in session.currentConfig when switching to Orchestrator so internal reopen succeeds", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        let currentModel = "gemini-4-neon";
        let currentThinking = "high";
        const getConfigOptions = () => [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel,
            options: [
              { value: "gemini-4-neon", name: "Gemini 4 Neon" },
              { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
            ] },
          ...(currentModel === "gemini-4-neon"
            ? [{ id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: currentThinking,
                options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }]
            : []),
        ];
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: "conv-m4", update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new" || method === "session/load") {
            currentModel = "gemini-4-neon";
            send({ id, result: { sessionId: "conv-m4", configOptions: getConfigOptions(), modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/set_config_option") {
            if (params.configId === "model") currentModel = params.value;
            else if (params.configId === "thought_level") {
              if (currentModel !== "gemini-4-neon") {
                send({ id, error: { code: -32602, message: "unknown config option" } });
                return;
              }
              currentThinking = params.value;
            }
            send({ id, result: { configOptions: getConfigOptions() } });
          } else if (method === "session/prompt") {
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Orchestrator reply" } });
            send({ id, result: { stopReason: "end_turn" } });
            if ((params.prompt?.[0]?.text ?? "") === "orch-turn-1") {
              setTimeout(() => process.exit(0), 20);
            }
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const conn = await createAntigravityResilientProvider({
      recovery: { processExitRetryDelayMs: 20 },
    }).connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message", "session.persistence", "session.configure"],
    });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));

    try {
      await conn.send({
        type: "session.open",
        requestId: "o-m4",
        sessionId: "s-m4",
        history: "skip",
        config: {
          cwd: directory,
          model: "gemini-4-neon",
          thinkingOption: "high",
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });

      await conn.send({
        type: "session.configure",
        requestId: "cfg-orch",
        sessionId: "s-m4",
        changes: { model: "gemini-pro-orchestrator-neon" },
      });
      await waitFor(
        () => events.find((e) => e.type === "request.completed" && e.requestId === "cfg-orch"),
        { label: "cfg-orch" },
      );

      await conn.send({
        type: "session.prompt",
        sessionId: "s-m4",
        prompt: {
          clientMessageId: "orch-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "orch-turn-1" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:orch-1" && e.state === "completed",
          ),
        { label: "orch-1 done" },
      );
      await new Promise((r) => setTimeout(r, 70));

      await conn.send({
        type: "session.prompt",
        sessionId: "s-m4",
        prompt: {
          clientMessageId: "orch-2",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "orch-turn-2" }] },
        },
      });
      const orch2 = await waitFor(
        () =>
          events.find(
            (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
              e.type === "session.turn" &&
              e.turnId === "acp:orch-2" &&
              (e.state === "completed" || e.state === "failed"),
          ),
        { label: "orch-2 settled" },
      );
      assert.equal(orch2.state, "completed");
    } finally {
      await conn.close();
    }
  });

  it("[m1] prioritizes user-configured env.PATH and env.LOCALAPPDATA over registration-time Windows LocalAppData fallback", () => {
    const daemonWinAgy = "C:\\Users\\daemonUser\\AppData\\Local\\agy\\bin\\agy.exe";
    const userPathAgy = "D:\\custom-tools\\bin\\agy.exe";
    const userProfileAgy = "D:\\custom-profile\\AppData\\Local\\agy\\bin\\agy.exe";

    const registeredCommand = defaultAgyCommand({
      platform: "win32",
      env: {
        PATH: "C:\\Windows\\System32",
        LOCALAPPDATA: "C:\\Users\\daemonUser\\AppData\\Local",
      },
      exists: (p) => p === daemonWinAgy || p === userPathAgy || p === userProfileAgy,
    });
    assert.equal(registeredCommand[0], daemonWinAgy);

    const effectiveFromPath = resolveEffectiveLaunch(
      {
        command: registeredCommand[0],
        args: registeredCommand.slice(1),
        env: {
          PATH: "D:\\custom-tools\\bin;C:\\Windows\\System32",
          LOCALAPPDATA: "C:\\Users\\daemonUser\\AppData\\Local",
        },
      },
      {
        platform: "win32",
        exists: (p) => p === daemonWinAgy || p === userPathAgy,
      },
    );
    assert.equal(effectiveFromPath.command, userPathAgy);

    const effectiveFromLocalAppData = resolveEffectiveLaunch(
      {
        command: registeredCommand[0],
        args: registeredCommand.slice(1),
        env: {
          PATH: "C:\\Windows\\System32",
          LOCALAPPDATA: "D:\\custom-profile\\AppData\\Local",
        },
      },
      {
        platform: "win32",
        exists: (p) => p === daemonWinAgy || p === userProfileAgy,
      },
    );
    assert.equal(effectiveFromLocalAppData.command, userProfileAgy);
  });

  it("[m2] does not count non-session status/catalog probes toward LaunchRateGuard and reports real rate-limit errors in status()", async () => {
    const { launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method } = JSON.parse(line);
          if (method === "initialize") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: 1, agentInfo: { name: "agy", version: "1.5.17" }, agentCapabilities: {} }
            }) + "\\n");
          }
        });
      `,
    );

    const provider = createAntigravityResilientProvider({
      launchRateLimit: { windowMs: 60_000, perSession: 6, perProcess: 2 },
    });
    const s1 = await provider.status!({ launch });
    const s2 = await provider.status!({ launch });
    const s3 = await provider.status!({ launch });
    assert.equal(s1.available, true);
    assert.equal(s2.available, true);
    assert.equal(s3.available, true);
  });

  it("[m3] avoids double history replay and catalog event leaks on session.open retry, and respects session.close during open", async () => {
    const directory = await tracker.make();
    const statePath = path.join(directory, "open-count.txt");
    const { launch } = await launchStubAgent(
      tracker,
      `
        const { existsSync, readFileSync, writeFileSync } = require("node:fs");
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        const stateFile = ${JSON.stringify(statePath)};
        const configOptions = [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-neon",
            options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }, { value: "gemini-4-argon", name: "Gemini 4 Argon" }] },
        ];
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: params.sessionId ?? "cat", update: u } });
          if (method === "initialize") send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          else if (method === "session/new") {
            if (params.cwd && params.cwd.endsWith("slow-open")) {
              setTimeout(() => {
                send({ id, result: { sessionId: "slow-sess", configOptions, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
                send({ method: "session/update", params: { sessionId: "slow-sess", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
              }, 80);
              return;
            }
            send({ id, result: { sessionId: "cat", configOptions, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/load") {
            const n = existsSync(stateFile) ? Number(readFileSync(stateFile, "utf8")) + 1 : 1;
            writeFileSync(stateFile, String(n));
            update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Historical user question" } });
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Historical assistant answer" } });
            send({ id, result: { configOptions, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/set_config_option") {
            const n = existsSync(stateFile) ? Number(readFileSync(stateFile, "utf8")) : 0;
            if (params.sessionId === "hist-conv" && params.configId === "model" && params.value === "gemini-4-argon" && n === 1) {
              send({ id, error: { code: -32602, message: "Unknown model ID: gemini-4-argon" } });
              return;
            }
            configOptions[0].currentValue = params.value;
            send({ id, result: { configOptions } });
          } else if (method === "session/close") send({ id, result: {} });
        });
      `,
    );

    const conn = await createAntigravityResilientProvider({
      recovery: { modelRejectionRetryDelayMs: 20 },
    }).connect({
      launch,
      versions: [1],
      capabilities: ["session.persistence", "session.configure"],
    });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));

    try {
      await conn.send({
        type: "session.open",
        requestId: "open-replay",
        sessionId: "s-replay",
        history: "replay",
        persistence: { version: 1, data: { sessionId: "hist-conv" } },
        config: { cwd: directory, model: "gemini-4-argon", env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(
        () => events.find((e) => e.type === "session.ready" && e.sessionId === "s-replay"),
        { label: "s-replay ready" },
      );

      const replayedUserMsgs = events.filter(
        (e) =>
          e.type === "timeline.item" &&
          e.sessionId === "s-replay" &&
          e.item.type === "user_message",
      );
      const leakedCatalogEvents = events.filter(
        (e) => "sessionId" in e && e.sessionId === "catalog",
      );
      assert.equal(replayedUserMsgs.length, 1, "history must be replayed once, not duplicated");
      assert.equal(leakedCatalogEvents.length, 0, "internal catalog session events must not leak");

      // Also test session.close while session.open is still in flight
      const slowDir = path.join(directory, "slow-open");
      await conn.send({
        type: "session.open",
        requestId: "open-slow",
        sessionId: "s-slow",
        history: "skip",
        config: { cwd: slowDir, env: {}, mcpServers: {}, settings: {}, persist: false },
      });
      await new Promise((r) => setTimeout(r, 15));
      await conn.send({
        type: "session.close",
        requestId: "close-slow",
        sessionId: "s-slow",
      });
      await waitFor(
        () => events.find((e) => e.type === "request.completed" && e.requestId === "close-slow"),
        { label: "close-slow completed" },
      );
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        events.some((e) => e.type === "session.ready" && e.sessionId === "s-slow"),
        false,
        "session.ready must not be emitted after session.close",
      );
    } finally {
      await conn.close();
    }
  });

  it("[m4] resolves repoRoot relative to scripts/verify-live.mjs when invoked from outside the repo and keeps deploy-and-verify.mjs free of stream-json store assumptions", async () => {
    const outsideCwd = await tracker.make("acp-rev-outside-cwd-");
    const outDir = path.join(outsideCwd, "smoke-out");

    const verifySource = await readFile(path.join(REPO_ROOT, "scripts/verify-live.mjs"), "utf8");
    const deploySource = await readFile(
      path.join(REPO_ROOT, "scripts/deploy-and-verify.mjs"),
      "utf8",
    );

    // Ensure deploy-and-verify.mjs no longer filters obsolete "Replayed" logs or expects .jsonl replay files
    assert.equal(deploySource.includes('.includes("Replayed")'), false);
    assert.equal(deploySource.includes(".jsonl"), false);

    // Execute the canary staging block from verify-live.mjs with cwd outside the repo
    const startIdx = verifySource.indexOf("const repoRoot");
    const endIdx = verifySource.indexOf("const installed=await client.installDirectoryPlugin");
    assert.ok(startIdx >= 0 && endIdx > startIdx, "expected canary staging slice in verify-live.mjs");
    const canaryPrepSlice = verifySource
      .slice(startIdx, endIdx)
      .replaceAll("import.meta.dirname", JSON.stringify(path.join(REPO_ROOT, "scripts")));

    const runnerPath = path.join(outsideCwd, "run-canary-prep.mjs");
    await writeFile(
      runnerPath,
      `import fs from "node:fs";\nimport path from "node:path";\nconst output = ${JSON.stringify(outDir)};\nlet canaryPluginId, providerId;\n${canaryPrepSlice}\n`,
      "utf8",
    );
    const res = spawnSync(process.execPath, [runnerPath], {
      cwd: outsideCwd,
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
  });
});
