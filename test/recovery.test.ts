import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { LaunchRateGuard, withLaunchRetry } from "../server/launch.ts";
import { createAntigravityResilientProvider } from "../server/provider.ts";
import {
  CONTINUE_INTERRUPTED_TURN_PROMPT,
  isPermanentAuthError,
  isQuotaExhaustedError,
  isStreamInterruption,
  isTokenGap,
  parseModelRejection,
  parseThinkingLevelRejection,
  sanitizeDiagnosticText,
} from "../server/recovery.ts";
import { launchStubAgent, TempDirTracker, waitFor } from "./helpers.ts";

const tracker = new TempDirTracker();

afterEach(async () => {
  await tracker.cleanup();
});

describe("recovery classifiers and launch guards", () => {
  it("narrowly classifies permanent auth, token gaps, quota, stream interruptions, and redacts secrets", () => {
    // Words like "author" or "authority" must NEVER trigger auth error!
    assert.equal(isPermanentAuthError("Commit author Alice lacked authority"), false);
    assert.equal(isPermanentAuthError("You are not logged in. Please run agy."), true);
    assert.equal(isPermanentAuthError("oauth2: token expired or revoked (invalid_grant)"), true);

    assert.equal(isTokenGap("RPC failed: UNAUTHENTICATED (code 401): expected OAuth 2 access token"), true);
    assert.equal(isTokenGap("You are not logged in"), false);

    assert.equal(isQuotaExhaustedError("RESOURCE_EXHAUSTED: You have exhausted your capacity"), true);
    assert.equal(isStreamInterruption("RESOURCE_EXHAUSTED: quota exceeded"), false);
    assert.equal(
      isStreamInterruption(
        'API error (attempt 1): request failed: Post "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": unexpected EOF',
      ),
      true,
    );
    assert.equal(isStreamInterruption("RPC error: UNAVAILABLE: upstream reset"), true);

    assert.deepEqual(parseModelRejection("Unknown model ID: gemini-nonexistent-99"), {
      model: "gemini-nonexistent-99",
      available: [],
    });
    assert.equal(
      parseModelRejection(
        'Thinking level "xhigh" is not offered for model "Gemini 3.8 Flash"',
        "gemini-3.8-flash",
      ),
      null,
    );
    assert.deepEqual(
      parseThinkingLevelRejection(
        'Thinking level "xhigh" is not offered for model "Gemini 3.8 Flash"',
      ),
      {
        thinkingLevel: "xhigh",
        model: "Gemini 3.8 Flash",
      },
    );

    const redacted = sanitizeDiagnosticText(
      "Bearer ya29.a0AfH6SMBxSecretToken1234567890 refresh=1//0gSecretRefreshToken123456789 key=AIzaSySecretApiKey1234567890 url=https://accounts.google.com/o/oauth2/auth?token=xyz",
    );
    assert.equal(redacted.includes("ya29."), false);
    assert.equal(redacted.includes("1//0g"), false);
    assert.equal(redacted.includes("AIzaSy"), false);
    assert.equal(redacted.includes("accounts.google.com"), false);
  });

  it("retries transient binary-swap EBUSY/EPERM spawn errors and enforces LaunchRateGuard", async () => {
    let attempts = 0;
    const value = await withLaunchRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          const err = Object.assign(new Error("spawn EBUSY"), {
            code: "EBUSY",
            syscall: "spawn agy.exe",
          });
          throw err;
        }
        return "started";
      },
      undefined,
      [5, 10, 20],
    );
    assert.equal(value, "started");
    assert.equal(attempts, 3);

    let now = 50_000;
    const guard = new LaunchRateGuard({
      limit: { windowMs: 60_000, perSession: 3, perProcess: 10 },
      isolatedProcessCounter: true,
      now: () => now,
    });
    guard.recordLaunch("sess-1", "open");
    guard.recordLaunch("sess-1", "recover-1");
    guard.recordLaunch("sess-1", "recover-2");
    assert.throws(
      () => guard.recordLaunch("sess-1", "recover-3"),
      (err: unknown) =>
        err instanceof Error &&
        (err as { code?: string }).code === "LAUNCH_RATE_LIMITED" &&
        /3 times for this session/.test(err.message),
    );
    now += 61_000;
    guard.recordLaunch("sess-1", "after-window");
  });
});

describe("ACP mid-turn bounded recovery, tool non-duplication, and real diagnostics", () => {
  it("recovers from mid-turn agy crash via session/load + continuation prompt without re-running completed tools, and caps retries", async () => {
    const directory = await tracker.make();
    const stateFile = path.join(directory, "crash-state.json");
    const { capturePath, launch } = await launchStubAgent(
      tracker,
      `
        const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
        const { createInterface } = require("node:readline");
        const statePath = ${JSON.stringify(stateFile)};
        const readState = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { runs: 0, toolRuns: 0 };
        const writeState = (s) => writeFileSync(statePath, JSON.stringify(s));
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");

        createInterface({ input: process.stdin }).on("line", (line) => {
          appendFileSync(process.env.CAPTURE, line + "\\n");
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: params.sessionId ?? "conv-crash-1", update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new") {
            send({ id, result: { sessionId: "conv-crash-1", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/load") {
            send({ id, result: { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/prompt") {
            const st = readState();
            st.runs += 1;
            const text = params.prompt?.[0]?.text ?? "";
            if (st.runs === 1) {
              st.toolRuns += 1;
              writeState(st);
              update({ sessionUpdate: "tool_call", toolCallId: "side-effect-1", title: "Write /once.txt", name: "write_file", kind: "edit", status: "completed", rawInput: { Path: "/once.txt", Content: "1" } });
              process.stderr.write("panic: unexpected network EOF while streaming\\n");
              setTimeout(() => process.exit(2), 20);
              return;
            }
            if (st.runs === 2) {
              writeState(st);
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Recovered cleanly with prompt: " + text } });
              send({ id, result: { stopReason: "end_turn" } });
              return;
            }
            // Turn 2: crash twice in a row to verify processExit retry cap (max 1)!
            writeState(st);
            process.stderr.write("fatal crash code 137 token=secret123\\n");
            setTimeout(() => process.exit(137), 15);
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const provider = createAntigravityResilientProvider({
      recovery: {
        processExitRetryDelayMs: 25,
        streamInterruptRetryDelayMs: 25,
        maxProcessExitRetries: 1,
        maxStreamInterruptRetries: 1,
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
        sessionId: "s-crash",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });

      // Turn 1: executes side-effect tool, crashes mid-turn, reopens via session/load, and continues!
      await connection.send({
        type: "session.prompt",
        sessionId: "s-crash",
        prompt: {
          clientMessageId: "turn-recover",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Write /once.txt once" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "session.turn" &&
              e.turnId === "acp:turn-recover" &&
              e.state === "completed",
          ),
        { label: "turn-recover completed" },
      );

      // Visible recovery notice emitted.
      assert.ok(
        events.some(
          (e) => e.type === "session.notice" && e.notice.severity === "warning",
        ),
      );
      // Continuation prompt used instead of repeating original prompt, and side-effect tool ran ONLY once!
      const stateAfterTurn1 = JSON.parse(await readFile(stateFile, "utf8"));
      assert.equal(stateAfterTurn1.toolRuns, 1);
      assert.ok(
        events.some(
          (e) =>
            e.type === "timeline.item" &&
            e.item.type === "assistant_message" &&
            e.item.text.includes(CONTINUE_INTERRUPTED_TURN_PROMPT),
        ),
      );

      const captured = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line: string) =>
            JSON.parse(line) as { method: string; params: { sessionId?: string } },
        );
      assert.ok(
        captured.some(
          (req) => req.method === "session/load" && req.params.sessionId === "conv-crash-1",
        ),
      );

      // Turn 2: crashes on both attempt 1 and recovery attempt 2 -> stops at cap and surfaces real exit code + sanitized stderr!
      await connection.send({
        type: "session.prompt",
        sessionId: "s-crash",
        prompt: {
          clientMessageId: "turn-cap",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Crash repeatedly" }] },
        },
      });
      const failedTurn = await waitFor(
        () =>
          events.find(
            (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
              e.type === "session.turn" && e.turnId === "acp:turn-cap" && e.state === "failed",
          ),
        { label: "turn-cap failed" },
      );
      assert.match(failedTurn.error?.message ?? "", /exit code 137/);
      assert.match(failedTurn.error?.message ?? "", /fatal crash code 137/);
      assert.equal(failedTurn.error?.message.includes("secret123"), false);
      assert.equal(
        failedTurn.error?.message.includes("ACP transport closed unexpectedly"),
        false,
      );
    } finally {
      await connection.close();
    }
  });

  it("fails immediately without retrying on RESOURCE_EXHAUSTED quota errors and permanent auth errors", async () => {
    const { directory, capturePath, launch } = await launchStubAgent(
      tracker,
      `
        const { appendFileSync } = require("node:fs");
        const { createInterface } = require("node:readline");
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
        let turn = 0;
        createInterface({ input: process.stdin }).on("line", (line) => {
          appendFileSync(process.env.CAPTURE, line + "\\n");
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: params.sessionId ?? "s-nonretry", update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new") {
            send({ id, result: { sessionId: "s-nonretry", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/prompt") {
            turn += 1;
            if (turn === 1) {
              send({ id, error: { code: -32603, message: "RESOURCE_EXHAUSTED: You have exhausted your capacity on this model (HTTP 429)" } });
            } else {
              send({ id, error: { code: -32603, message: "You are not logged in. Please sign in." } });
            }
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const connection = await createAntigravityResilientProvider().connect({
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

      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "quota-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "hit quota" }] },
        },
      });
      const quotaFail = await waitFor(
        () =>
          events.find(
            (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
              e.type === "session.turn" && e.turnId === "acp:quota-turn" && e.state === "failed",
          ),
        { label: "quota-turn failed" },
      );
      assert.equal(quotaFail.error?.code, "QUOTA_EXHAUSTED");
      assert.match(quotaFail.error?.message ?? "", /RESOURCE_EXHAUSTED/);

      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "auth-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "hit auth" }] },
        },
      });
      const authFail = await waitFor(
        () =>
          events.find(
            (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
              e.type === "session.turn" && e.turnId === "acp:auth-turn" && e.state === "failed",
          ),
        { label: "auth-turn failed" },
      );
      assert.equal(authFail.error?.code, "AUTH_REQUIRED");
      assert.match(authFail.error?.message ?? "", /Run `agy` and sign in/);

      // Exactly 2 prompts sent on wire — zero retries wasted!
      const prompts = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line) as { method: string })
        .filter((req) => req.method === "session/prompt");
      assert.equal(prompts.length, 2);
    } finally {
      await connection.close();
    }
  });

  it("handles stale startup model rejection by re-probing catalog once (db19236) and invalidates withdrawn models", async () => {
    const directory = await tracker.make();
    const stateFile = path.join(directory, "model-state.json");
    const { launch } = await launchStubAgent(
      tracker,
      `
        const { existsSync, readFileSync, writeFileSync } = require("node:fs");
        const { createInterface } = require("node:readline");
        const statePath = ${JSON.stringify(stateFile)};
        const readState = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { sessionOpens: 0 };
        const writeState = (s) => writeFileSync(statePath, JSON.stringify(s));
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");

        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new") {
            const st = readState();
            st.sessionOpens += 1;
            writeState(st);
            // First session open omits gemini-4-argon (stale startup list); subsequent opens & catalog include it!
            const models = st.sessionOpens === 1
              ? [{ value: "gemini-3.8-flash", name: "Flash" }]
              : [{ value: "gemini-3.8-flash", name: "Flash" }, { value: "gemini-4-argon", name: "Argon" }];
            send({ id, result: {
              sessionId: "s-" + st.sessionOpens,
              configOptions: [
                { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-3.8-flash", options: models },
                { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
              ],
            } });
            send({ method: "session/update", params: { sessionId: "s-" + st.sessionOpens, update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
          } else if (method === "session/set_config_option") {
            const st = readState();
            if (params.configId === "model") {
              if (params.value === "withdrawn-model-x" || (params.value === "gemini-4-argon" && st.sessionOpens === 1)) {
                send({ id, error: { code: -32602, message: "Unknown model ID: " + params.value } });
                return;
              }
            }
            send({ id, result: { configOptions: [
              { id: "model", name: "Model", category: "model", type: "select", currentValue: params.value, options: [
                { value: "gemini-3.8-flash", name: "Flash" }, { value: "gemini-4-argon", name: "Argon" }
              ] },
              { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
            ] } });
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const provider = createAntigravityResilientProvider({
      recovery: { modelRejectionRetryDelayMs: 20 },
    });
    const keyBefore = await provider.getCatalogCacheKey!({ scope: "global", launch });
    const connection = await provider.connect({
      launch,
      versions: [1],
      capabilities: ["session.configure", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      // 1. Stale rejection of gemini-4-argon: re-probes live catalog, sees it's listed, relaunches once and succeeds!
      await connection.send({
        type: "session.open",
        requestId: "open-argon",
        sessionId: "s-argon",
        history: "skip",
        config: {
          cwd: directory,
          model: "gemini-4-argon",
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await waitFor(
        () => events.find((e) => e.type === "session.ready" && e.sessionId === "s-argon"),
        { label: "s-argon ready after 1x relaunch" },
      );

      // 2. Genuinely withdrawn model: re-probes catalog, sees it's absent, fails with INVALID_MODEL and bumps cache key!
      await connection.send({
        type: "session.open",
        requestId: "open-withdrawn",
        sessionId: "s-withdrawn",
        history: "skip",
        config: {
          cwd: directory,
          model: "withdrawn-model-x",
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      const failedOpen = await waitFor(
        () =>
          events.find(
            (e): e is Extract<ProviderEvent, { type: "request.failed" }> =>
              e.type === "request.failed" && e.requestId === "open-withdrawn",
          ),
        { label: "open-withdrawn failed" },
      );
      assert.equal(failedOpen.error.code, "INVALID_MODEL");
      assert.match(
        failedOpen.error.message,
        /Antigravity does not offer model withdrawn-model-x right now/,
      );
      const keyAfter = await provider.getCatalogCacheKey!({ scope: "global", launch });
      assert.notEqual(keyAfter, keyBefore);
    } finally {
      await connection.close();
    }
  });

  it("enforces cancel fallback deadline when agy ignores session/cancel, and rebases across suspend/wake clock jumps", async () => {
    let clock = 100_000;
    const provider = createAntigravityResilientProvider({
      cancelFallbackTimeoutMs: 120,
      now: () => clock,
      spawn: () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const fakeChild = Object.assign(new EventEmitter(), {
          pid: undefined,
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
          stdin,
          stdout,
          stderr,
          kill: () => {
            fakeChild.exitCode = 1;
            stdout.end();
            fakeChild.emit("close", 1, null);
            return true;
          },
        });
        queueMicrotask(() => fakeChild.emit("spawn"));
        let buffer = "";
        stdin.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            const { id, method } = JSON.parse(line);
            const send = (msg: object) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
            if (method === "initialize") {
              send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
            } else if (method === "session/new") {
              send({ id, result: { sessionId: "hang-1", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
              send({ method: "session/update", params: { sessionId: "hang-1", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
            } else if (method === "session/cancel") {
              if (id !== undefined) send({ id, result: {} });
              // Deliberately NEVER resolve session/prompt!
            } else if (method === "session/close") {
              send({ id, result: {} });
            }
          }
        });
        return fakeChild as never;
      },
    });

    const directory = await tracker.make();
    const connection = await provider.connect({
      launch: { command: "agy-fake", args: ["acp"], env: {} },
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "session.open",
        requestId: "open",
        sessionId: "s-hang",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: false },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });

      await connection.send({
        type: "session.prompt",
        sessionId: "s-hang",
        prompt: {
          clientMessageId: "hang-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "hang forever" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:hang-turn" && e.state === "started",
          ),
        { label: "hang-turn started" },
      );

      await connection.send({
        type: "session.interrupt",
        requestId: "cancel-hang",
        sessionId: "s-hang",
      });

      // Simulate a 60-second laptop sleep jump first -> deadline rebases instead of tripping at 0ms,
      // then advance normal wall time past 120ms so fallback fires!
      await new Promise<void>((r) => setTimeout(r, 35));
      clock += 60_000;
      await new Promise<void>((r) => setTimeout(r, 35));
      assert.equal(
        events.some(
          (e) => e.type === "session.turn" && e.turnId === "acp:hang-turn" && e.state === "canceled",
        ),
        false,
      );
      clock += 150;

      await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "session.turn" && e.turnId === "acp:hang-turn" && e.state === "canceled",
          ),
        { label: "hang-turn force-canceled by deadline" },
      );
    } finally {
      await connection.close();
    }
  });

  it("serves stale last-good catalog marked stale on transient discovery failures up to 3 failures (4c65788 + 4d48c3a)", async () => {
    const directory = await tracker.make();
    const stateFile = path.join(directory, "cat-state.json");
    const { launch } = await launchStubAgent(
      tracker,
      `
        const { existsSync, readFileSync, writeFileSync } = require("node:fs");
        const { createInterface } = require("node:readline");
        const statePath = ${JSON.stringify(stateFile)};
        const readState = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { mode: "ok" };
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");

        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method } = JSON.parse(line);
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
          } else if (method === "session/new") {
            const st = readState();
            if (st.mode === "fail") {
              send({ id, error: { code: -32603, message: "Internal service failure" } });
              return;
            }
            send({ id, result: {
              sessionId: "cat-1",
              configOptions: [
                { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-3.8-flash", options: [{ value: "gemini-3.8-flash", name: "Flash" }] },
                { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
              ],
            } });
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    let clock = 10_000_000;
    const provider = createAntigravityResilientProvider({
      discoveryRetryDelayMs: 10,
      now: () => clock,
    });
    const connection = await provider.connect({
      launch,
      versions: [1],
      capabilities: ["session.configure"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      // 1. Seed initial good catalog.
      await connection.send({ type: "catalog", requestId: "cat-good", cwd: directory });
      const good = await waitFor(
        () =>
          events.find(
            (e): e is Extract<ProviderEvent, { type: "catalog" }> =>
              e.type === "catalog" && e.requestId === "cat-good",
          ),
        { label: "cat-good" },
      );
      assert.equal(good.catalog.models[0]?.id, "gemini-3.8-flash");
      assert.equal(good.catalog.models[0]?.metadata?.catalogStale, undefined);

      // 2. Flip catalog endpoint to failing: failures 1 & 2 return stale catalog; failure 3 surfaces request.failed!
      const { writeFile } = await import("node:fs/promises");
      await writeFile(stateFile, JSON.stringify({ mode: "fail" }), "utf8");

      await connection.send({ type: "catalog", requestId: "cat-stale-1", cwd: directory });
      const stale1 = await waitFor(
        () =>
          events.find(
            (e): e is Extract<ProviderEvent, { type: "catalog" }> =>
              e.type === "catalog" && e.requestId === "cat-stale-1",
          ),
        { label: "cat-stale-1" },
      );
      assert.equal(stale1.catalog.models[0]?.metadata?.catalogStale, true);

      // Advance past retryAt backoff so failures 2 and 3 count!
      clock += 10 * 60_000;
      await connection.send({ type: "catalog", requestId: "cat-stale-2", cwd: directory });
      await waitFor(
        () => events.find((e) => e.type === "catalog" && e.requestId === "cat-stale-2"),
        { label: "cat-stale-2" },
      );

      clock += 10 * 60_000;
      await connection.send({ type: "catalog", requestId: "cat-fail-3", cwd: directory });
      const fail3 = await waitFor(
        () =>
          events.find(
            (e): e is Extract<ProviderEvent, { type: "request.failed" }> =>
              e.type === "request.failed" && e.requestId === "cat-fail-3",
          ),
        { label: "cat-fail-3" },
      );
      assert.match(fail3.error.message, /Internal service failure/);
    } finally {
      await connection.close();
    }
  });
});
