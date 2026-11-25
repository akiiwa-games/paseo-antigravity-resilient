import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import {
  AUTOCOMPACT_THRASHING_MESSAGE,
  DEFAULT_AUTO_COMPACT_LEAD_MS,
  DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD,
  DEFAULT_HOT_CACHE_TTL_MS,
  DEFAULT_PRE_TURN_COMPACT_TOKEN_THRESHOLD,
  resolveEnvIdleCompactMinTokens,
  SessionCompactor,
} from "../server/compaction.ts";
import { createAntigravityResilientProvider } from "../server/provider.ts";
import { launchStubAgent, TempDirTracker, waitFor } from "./helpers.ts";

const tracker = new TempDirTracker();

afterEach(async () => {
  await tracker.cleanup();
});

describe("SessionCompactor unit policy", () => {
  it("anchors idle compaction 2.5m after the model request start, not turn end (a64107a + fedeef2)", () => {
    let clock = 1_000_000;
    const compactor = new SessionCompactor({
      overrides: { now: () => clock },
    });
    assert.equal(compactor.hotCacheTtlMs, DEFAULT_HOT_CACHE_TTL_MS);
    assert.equal(compactor.autoCompactLeadMs, DEFAULT_AUTO_COMPACT_LEAD_MS);
    assert.equal(compactor.autoCompactTokenThreshold, DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD);
    assert.equal(compactor.preTurnCompactTokenThreshold, DEFAULT_PRE_TURN_COMPACT_TOKEN_THRESHOLD);

    // Turn starts at t = 1,000,000; streaming finishes 90s later at t = 1,090,000.
    compactor.noteBusinessTurnStart(clock);
    clock += 90_000;
    compactor.noteBusinessModelUsage(165_000, clock);

    // At 150s after request start (t = 1,150,000 -> 60s left until 2.5m fire target):
    let fired = 0;
    compactor.noteBusinessTurnCompleted(
      {
        hasNativeSession: true,
        isBusy: () => false,
        isClosed: () => false,
        onFire: () => {
          fired += 1;
        },
      },
      clock,
    );
    assert.equal(compactor.getLastIdleSkipReason(), null);
    compactor.clearIdleTimer();
    assert.equal(fired, 0);

    // At t = 1,310,000 (> 300,000ms after request start -> cache cold), idle gate skips as lapsed,
    // while pre-turn compaction triggers because cache is cold and context >= 150K (`cc2aaee`).
    clock = 1_310_000;
    assert.equal(
      compactor.evaluateIdleGate({
        armedRequestObservedAt: null,
        armedFireAt: null,
        hasNativeSession: true,
        isBusy: false,
        isClosed: false,
        now: clock,
      }),
      "lapsed",
    );
    assert.equal(compactor.needsPreTurnCompact(true, clock), true);
  });

  it("handles DISABLE_COMPACT=1, env token floor, native regrowth (b8d90c2), and thrashing breakers", () => {
    const disabled = new SessionCompactor({
      sessionEnv: { DISABLE_COMPACT: "1" },
    });
    assert.equal(disabled.autoCompactEnabled, false);
    disabled.noteBusinessTurnStart(1_000);
    disabled.noteBusinessModelUsage(250_000, 2_000);
    assert.equal(disabled.needsPreTurnCompact(true, 3_000), false);

    assert.equal(resolveEnvIdleCompactMinTokens("50000"), 100_000);
    assert.equal(resolveEnvIdleCompactMinTokens("180000"), 180_000);

    // Native compaction followed by regrowth past threshold (`b8d90c2`) must NOT stay suppressed.
    let clock = 10_000;
    const regrown = new SessionCompactor({ overrides: { now: () => clock } });
    regrown.noteBusinessTurnStart(clock);
    regrown.noteNativeCompactionCompleted();
    assert.equal(regrown.isCompacted(), true);
    clock += 5_000;
    regrown.noteBusinessModelUsage(370_000, clock);
    regrown.noteBusinessTurnCompleted(
      {
        hasNativeSession: true,
        isBusy: () => false,
        isClosed: () => false,
        onFire: () => undefined,
      },
      clock,
    );
    regrown.clearIdleTimer();
    assert.equal(regrown.isCompacted(), false);
    assert.equal(regrown.needsPreTurnCompact(true, clock), true);

    // Rapid-refill thrashing breaker trips on 3rd rapid refill (<10 requests each).
    const thrash = new SessionCompactor({ overrides: { now: () => clock } });
    // Initial compact #0
    thrash.noteBusinessTurnStart(clock);
    thrash.noteBusinessModelUsage(210_000, clock);
    const b0 = thrash.checkAutoCompactBreaker();
    assert.equal(b0.allowed, true);
    thrash.noteCompactFinished({ source: "auto", outcome: "completed", pendingRapidRefills: 0 });
    assert.equal(thrash.isCompacted(), true);
    // Post-compact suppression blocks repeated compaction until a new model request arrives.
    assert.equal(thrash.needsPreTurnCompact(true, clock + 400_000), false);

    for (let refill = 1; refill <= 2; refill += 1) {
      clock += 1_000;
      thrash.noteBusinessTurnStart(clock);
      thrash.noteBusinessModelUsage(210_000, clock);
      const check = thrash.checkAutoCompactBreaker();
      assert.equal(check.allowed, true);
      if (check.allowed) {
        thrash.noteCompactFinished({
          source: "auto",
          outcome: "completed",
          pendingRapidRefills: check.pendingRapidRefills,
        });
      }
    }

    // 3rd rapid refill trips the breaker!
    clock += 1_000;
    thrash.noteBusinessTurnStart(clock);
    thrash.noteBusinessModelUsage(210_000, clock);
    const tripped = thrash.checkAutoCompactBreaker();
    assert.deepEqual(tripped, {
      allowed: false,
      thrashingMessage: AUTOCOMPACT_THRASHING_MESSAGE,
    });
    assert.equal(thrash.needsPreTurnCompact(true, clock), false);

    // Manual `/compact` resets the rapid-refill breaker.
    thrash.noteCompactFinished({ source: "manual", outcome: "completed" });
    assert.equal(thrash.isRapidRefillBreakerTripped(), false);
  });
});

describe("ACP auto-compaction hiding, queueing, and cancellation", () => {
  it("runs idle /compact as compaction timeline items, hides internal turn/message, and queues concurrent user prompts", async () => {
    const { directory, capturePath, launch } = await launchStubAgent(
      tracker,
      `
        const { appendFileSync } = require("node:fs");
        const { createInterface } = require("node:readline");
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          appendFileSync(process.env.CAPTURE, line + "\\n");
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: params.sessionId ?? "agy-compact", update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new") {
            send({ id, result: { sessionId: "agy-compact", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/prompt") {
            const text = params.prompt?.[0]?.text ?? "";
            if (text === "/compact") {
              setTimeout(() => {
                update({ sessionUpdate: "usage_update", used: 160000, size: 1048576 });
                send({ id, result: { stopReason: "end_turn" } });
              }, 120);
            } else if (text === "turn-1") {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First reply" } });
              update({ sessionUpdate: "usage_update", used: 160000, size: 1048576 });
              send({ id, result: { stopReason: "end_turn" } });
            } else if (text === "queued-during-compact") {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Queued reply after compact" } });
              // Simulate post-compact dropped usage on next real request:
              update({ sessionUpdate: "usage_update", used: 22000, size: 1048576 });
              send({ id, result: { stopReason: "end_turn" } });
            }
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const provider = createAntigravityResilientProvider({
      compaction: {
        hotCacheTtlMs: 5_000,
        autoCompactLeadMs: 4_940, // Fires ~60ms after turn-1!
        autoCompactTokenThreshold: 150_000,
      },
    });
    const connection = await provider.connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "session.open",
        requestId: "open",
        sessionId: "s1",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });

      // Turn 1 pushes context to 160,000 tokens.
      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "turn-1" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:m1" && e.state === "completed",
          ),
        { label: "m1 completed" },
      );

      // Wait for idle auto-compaction to emit loading item.
      const loadingCompact = await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "timeline.item" &&
              e.item.type === "compaction" &&
              e.item.status === "loading" &&
              e.item.trigger === "auto",
          ),
        { label: "auto compaction loading" },
      );
      assert.ok(loadingCompact);

      // Send a user prompt WHILE compaction is still running -> must queue, never fail!
      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m2",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "queued-during-compact" }],
          },
        },
      });

      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:m2" && e.state === "completed",
          ),
        { label: "m2 completed after compaction" },
      );

      // Compaction completed item emitted with same id and preTokens = 160000.
      assert.ok(
        events.some(
          (e) =>
            e.type === "timeline.item" &&
            e.item.type === "compaction" &&
            e.item.status === "completed" &&
            e.item.trigger === "auto" &&
            e.item.preTokens === 160_000,
        ),
      );

      // Internal `/compact` must NEVER appear as a user_message or turn!
      const userMessages = events.flatMap((e) =>
        e.type === "timeline.item" && e.item.type === "user_message" ? [e.item.text] : [],
      );
      assert.deepEqual(userMessages, ["turn-1", "queued-during-compact"]);

      const turnIds = events.flatMap((e) => (e.type === "session.turn" ? [e.turnId] : []));
      assert.ok(turnIds.every((id) => id === "acp:m1" || id === "acp:m2"));

      // Wire order confirms `/compact` ran before `queued-during-compact`.
      const wirePrompts = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line: string) =>
            JSON.parse(line) as { method: string; params: { prompt: Array<{ text: string }> } },
        )
        .filter((req) => req.method === "session/prompt")
        .map((req) => req.params.prompt[0]!.text);
      assert.deepEqual(wirePrompts, ["turn-1", "/compact", "queued-during-compact"]);
    } finally {
      await connection.close();
    }
  });

  it("runs pre-turn compaction above 200K, skips commands, and cancels cleanly on interrupt without sending user prompt", async () => {
    const { directory, capturePath, launch } = await launchStubAgent(
      tracker,
      `
        const { appendFileSync } = require("node:fs");
        const { createInterface } = require("node:readline");
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
        let activePromptId = null;
        createInterface({ input: process.stdin }).on("line", (line) => {
          appendFileSync(process.env.CAPTURE, line + "\\n");
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: params.sessionId ?? "agy-pre", update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new") {
            send({ id, result: { sessionId: "agy-pre", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "plan", description: "plan" }] });
          } else if (method === "session/prompt") {
            const text = params.prompt?.[0]?.text ?? "";
            if (text === "seed-210k") {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Seeded" } });
              update({ sessionUpdate: "usage_update", used: 210000, size: 1048576 });
              send({ id, result: { stopReason: "end_turn" } });
            } else if (text.startsWith("/plan")) {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Plan output" } });
              send({ id, result: { stopReason: "end_turn" } });
            } else if (text === "/compact") {
              activePromptId = id;
              // Hold until cancelled!
            } else {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Should not run after cancel" } });
              send({ id, result: { stopReason: "end_turn" } });
            }
          } else if (method === "session/cancel") {
            if (id !== undefined) send({ id, result: {} });
            if (activePromptId !== null) {
              send({ id: activePromptId, result: { stopReason: "cancelled" } });
              activePromptId = null;
            }
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const provider = createAntigravityResilientProvider({
      compaction: {
        hotCacheTtlMs: 300_000,
        autoCompactLeadMs: 150_000,
        autoCompactTokenThreshold: 150_000,
        preTurnCompactTokenThreshold: 200_000,
      },
    });
    const connection = await provider.connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message", "prompt.command", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "session.open",
        requestId: "open",
        sessionId: "s-pre",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });

      // Seed 210K tokens (> 200K pre-turn threshold even while cache is warm).
      await connection.send({
        type: "session.prompt",
        sessionId: "s-pre",
        prompt: {
          clientMessageId: "seed",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "seed-210k" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:seed" && e.state === "completed",
          ),
        { label: "seed completed" },
      );

      // Slash command must NOT trigger pre-turn compaction (`cc2aaee`).
      await connection.send({
        type: "session.prompt",
        sessionId: "s-pre",
        prompt: {
          clientMessageId: "cmd-1",
          delivery: "auto",
          input: { type: "command", name: "plan", arguments: "now" },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:cmd-1" && e.state === "completed",
          ),
        { label: "cmd-1 completed" },
      );
      assert.equal(
        events.some((e) => e.type === "timeline.item" && e.item.type === "compaction"),
        false,
      );

      // Now send a business turn: pre-turn compaction starts (`loading`), then we interrupt!
      await connection.send({
        type: "session.prompt",
        sessionId: "s-pre",
        prompt: {
          clientMessageId: "biz-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "do-business-work" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "timeline.item" &&
              e.item.type === "compaction" &&
              e.item.status === "loading",
          ),
        { label: "pre-turn compaction loading" },
      );

      await connection.send({
        type: "session.interrupt",
        requestId: "int-1",
        sessionId: "s-pre",
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:biz-1" && e.state === "canceled",
          ),
        { label: "biz-1 canceled" },
      );

      // Verify `do-business-work` was NEVER sent to agy after pre-turn compaction was canceled!
      const wirePrompts = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line: string) =>
            JSON.parse(line) as { method: string; params: { prompt: Array<{ text: string }> } },
        )
        .filter((req) => req.method === "session/prompt")
        .map((req) => req.params.prompt[0]!.text);
      assert.deepEqual(wirePrompts, ["seed-210k", "/plan now", "/compact"]);
    } finally {
      await connection.close();
    }
  });
});
