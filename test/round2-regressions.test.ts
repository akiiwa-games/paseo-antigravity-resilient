import assert from "node:assert/strict";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createAntigravityResilientProvider } from "../server/provider.ts";
import { Usage } from "../server/usage.ts";
import { launchStubAgent, TempDirTracker, waitFor } from "./helpers.ts";

const tracker = new TempDirTracker();
const spawnedPids = new Set<number>();

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPidTree(pid: number): void {
  try {
    if (!isPidAlive(pid)) return;
    if (process.platform === "win32") {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Ignore already exited process.
  }
}

afterEach(async () => {
  for (const pid of spawnedPids) {
    killPidTree(pid);
  }
  spawnedPids.clear();
  await tracker.cleanup();
});

describe("Round 2 adversarial review regressions (R2-1 to R2-5)", () => {
  it("[R2-1a] kills mid-spawn child on session.close without leaking orphan processes or poisoning same-sessionId reopen", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method } = JSON.parse(line);
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new") {
            send({ id, result: { sessionId: "conv-r2-1a", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            send({ method: "session/update", params: { sessionId: "conv-r2-1a", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
        setInterval(() => {}, 1000);
      `,
    );

    const delayedSpawnPids: number[] = [];
    const customDelayedSpawn = ((cmd: string, args: string[], opts: any) => {
      const realChild = nodeSpawn(cmd, args, opts);
      if (realChild.pid) spawnedPids.add(realChild.pid);
      if (opts?.env?.SESSION_TAG !== "delayed") {
        return realChild as any;
      }
      if (realChild.pid) delayedSpawnPids.push(realChild.pid);
      let proxyReady = false;
      const proxy = new Proxy(realChild, {
        get(target, prop) {
          if (prop === "pid" && !proxyReady) return undefined;
          const val = Reflect.get(target, prop, target);
          return typeof val === "function" ? val.bind(target) : val;
        },
        set(target, prop, value) {
          return Reflect.set(target, prop, value, target);
        },
      });
      const origOnce = realChild.once.bind(realChild);
      (proxy as any).once = (ev: string, cb: (...a: any[]) => void) => {
        if (ev === "spawn") {
          setTimeout(() => {
            proxyReady = true;
            cb();
          }, 45);
          return proxy;
        }
        origOnce(ev as any, cb);
        return proxy;
      };
      return proxy as any;
    }) as any;

    const conn = await createAntigravityResilientProvider({
      spawn: customDelayedSpawn,
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
        requestId: "open-delayed",
        sessionId: "s-delayed",
        history: "skip",
        config: {
          cwd: directory,
          env: { SESSION_TAG: "delayed" },
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await new Promise((r) => setTimeout(r, 10));
      await conn.send({
        type: "session.close",
        requestId: "close-delayed",
        sessionId: "s-delayed",
      });
      await waitFor(
        () => events.find((e) => e.type === "request.completed" && e.requestId === "close-delayed"),
        { label: "close-delayed completed" },
      );

      // Child must ALREADY be terminated when `close-delayed` completes (no orphan window!)
      assert.equal(delayedSpawnPids.length, 1);
      assert.equal(
        isPidAlive(delayedSpawnPids[0]!),
        false,
        "delayed mid-spawn child must already be dead when session.close completes",
      );

      // Reopening the exact same sessionId on the same long-lived connection must succeed
      await conn.send({
        type: "session.open",
        requestId: "reopen-same-id",
        sessionId: "s-delayed",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(
        () => events.find((e) => e.type === "session.ready" && e.requestId === "reopen-same-id"),
        { timeoutMs: 1_500, label: "reopen-same-id session.ready" },
      );
      assert.equal(
        events.some((e) => e.type === "request.failed" && e.requestId === "reopen-same-id"),
        false,
      );
    } finally {
      for (const pid of delayedSpawnPids) killPidTree(pid);
      await Promise.race([conn.close(), new Promise((r) => setTimeout(r, 400))]);
    }
  });

  it("[R2-1b] kills active/hung session children BEFORE awaiting inner.close() so conn.close() never deadlocks on hung session/new or session/load", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method } = JSON.parse(line);
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new") {
            // Hang indefinitely on session/new
          }
        });
        setInterval(() => {}, 1000);
      `,
    );

    const hungPids: number[] = [];
    const conn = await createAntigravityResilientProvider({
      startupTimeoutMs: 5_000,
      spawn: ((cmd: string, args: string[], opts: any) => {
        const c = nodeSpawn(cmd, args, opts);
        if (c.pid) {
          spawnedPids.add(c.pid);
          hungPids.push(c.pid);
        }
        return c as any;
      }) as any,
    }).connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message"],
    });

    await conn.send({
      type: "session.open",
      requestId: "open-hung",
      sessionId: "s-hung",
      history: "skip",
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: false },
    });
    await new Promise((r) => setTimeout(r, 80));

    const closePromise = conn.close();
    const settledQuickly = await Promise.race([
      closePromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 800)),
    ]);
    const hungChildPid = hungPids[hungPids.length - 1]!;
    const aliveDuringClose = isPidAlive(hungChildPid);
    if (!settledQuickly) {
      killPidTree(hungChildPid);
      await Promise.race([closePromise, new Promise((r) => setTimeout(r, 300))]);
    }
    assert.equal(settledQuickly, true, "conn.close() must settle without deadlocking on hung session/new");
    assert.equal(aliveDuringClose, false, "hung child process must be killed by conn.close()");
  });

  it("[R2-2] enforces cancelFallbackTimeoutMs and terminates hung reopen child when session.interrupt arrives during ensureInnerSessionAlive", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method } = JSON.parse(line);
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new") {
            send({ id, result: { sessionId: "conv-r2-2", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            send({ method: "session/update", params: { sessionId: "conv-r2-2", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
            setTimeout(() => process.exit(0), 25);
          } else if (method === "session/load") {
            // Hang during session/load reopen
          }
        });
        setInterval(() => {}, 1000);
      `,
    );

    const sessionPids: number[] = [];
    const conn = await createAntigravityResilientProvider({
      startupTimeoutMs: 400,
      cancelFallbackTimeoutMs: 150,
      spawn: ((cmd: string, args: string[], opts: any) => {
        const c = nodeSpawn(cmd, args, opts);
        if (c.pid) {
          spawnedPids.add(c.pid);
          sessionPids.push(c.pid);
        }
        return c as any;
      }) as any,
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
        requestId: "o-r2-2",
        sessionId: "s-r2-2",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });
      await new Promise((r) => setTimeout(r, 80));

      await conn.send({
        type: "session.prompt",
        sessionId: "s-r2-2",
        prompt: {
          clientMessageId: "m-reopen-hang",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "hello" }] },
        },
      });
      await new Promise((r) => setTimeout(r, 60));

      await conn.send({
        type: "session.interrupt",
        requestId: "int-r2-2",
        sessionId: "s-r2-2",
      });

      // Exact repro-round2.ts check at 650ms (>4x cancelFallbackTimeoutMs=150ms and >startupTimeoutMs=400ms)
      await new Promise((r) => setTimeout(r, 650));
      const interruptAckedAfter650ms = events.some(
        (e) => e.type === "request.completed" && e.requestId === "int-r2-2",
      );
      const turnCanceledAfter650ms = events.some(
        (e) =>
          e.type === "session.turn" &&
          e.turnId === "acp:m-reopen-hang" &&
          e.state === "canceled",
      );
      const reopenChildPid = sessionPids[sessionPids.length - 1]!;
      const reopenChildStillAliveAfter650ms = isPidAlive(reopenChildPid);

      assert.equal(
        interruptAckedAfter650ms,
        true,
        "session.interrupt must complete within 650ms during hung reopen",
      );
      assert.equal(
        turnCanceledAfter650ms,
        true,
        "turn must settle as canceled within 650ms",
      );
      assert.equal(
        reopenChildStillAliveAfter650ms,
        false,
        "hung reopen child must be terminated within 650ms",
      );
    } finally {
      for (const pid of sessionPids) killPidTree(pid);
      await Promise.race([conn.close(), new Promise((r) => setTimeout(r, 400))]);
    }
  });

  it("[R2-3] extracts JSON-RPC error.data.details across generic message headers and concurrent process exits for 429, 401, stream, and permanent errors", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        let auth401Count = 0;
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: "conv-r2-3", update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new" || method === "session/load") {
            send({ id, result: { sessionId: "conv-r2-3", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          } else if (method === "session/prompt") {
            const text = params.prompt?.[0]?.text ?? "";
            if (text === "429-in-data") {
              send({
                id,
                error: {
                  code: -32603,
                  message: "Internal error",
                  data: { details: "RESOURCE_EXHAUSTED: quota exceeded (HTTP 429)" },
                },
              });
            } else if (text === "401-in-data") {
              auth401Count += 1;
              if (auth401Count === 1) {
                send({
                  id,
                  error: {
                    code: -32603,
                    message: "Internal error",
                    data: { details: "UNAUTHENTICATED (code 401): expected OAuth 2 access token" },
                  },
                });
              } else {
                update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "recovered after 401" } });
                send({ id, result: { stopReason: "end_turn" } });
              }
            } else if (text === "rpc-invalid-then-exit") {
              send({
                id,
                error: {
                  code: -32602,
                  message: "Invalid params",
                  data: { details: "Unsupported parameter combination" },
                },
              });
              setTimeout(() => process.exit(1), 5);
            }
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const conn = await createAntigravityResilientProvider({
      recovery: { tokenGapRetryDelayMs: 20, processExitRetryDelayMs: 20 },
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
        requestId: "o-r2-3",
        sessionId: "s-r2-3",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });

      // 1) 429 inside error.data.details -> QUOTA_EXHAUSTED with details, 0 retries
      await conn.send({
        type: "session.prompt",
        sessionId: "s-r2-3",
        prompt: {
          clientMessageId: "m-429-data",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "429-in-data" }] },
        },
      });
      const turn429 = await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:m-429-data" && e.state === "failed",
          ),
        { label: "m-429-data failed" },
      );
      if (turn429.type !== "session.turn") throw new Error("unreachable");
      assert.equal(turn429.error?.code, "QUOTA_EXHAUSTED");
      assert.match(turn429.error?.message ?? "", /RESOURCE_EXHAUSTED/);

      // 2) 401 inside error.data.details -> retries once and succeeds!
      await conn.send({
        type: "session.prompt",
        sessionId: "s-r2-3",
        prompt: {
          clientMessageId: "m-401-data",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "401-in-data" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "session.turn" && e.turnId === "acp:m-401-data" && e.state === "completed",
          ),
        { label: "m-401-data recovered" },
      );
      const notices401 = events.filter(
        (e) => e.type === "session.notice" && e.notice.id.startsWith("acp:m-401-data:recovery:"),
      );
      assert.equal(notices401.length, 1);

      // 3) Explicit non-retryable JSON-RPC error followed immediately by exit(1) -> must NOT retry as processExit
      await conn.send({
        type: "session.prompt",
        sessionId: "s-r2-3",
        prompt: {
          clientMessageId: "m-rpc-exit",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "rpc-invalid-then-exit" }] },
        },
      });
      const turnRpcExit = await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:m-rpc-exit" && e.state === "failed",
          ),
        { label: "m-rpc-exit failed" },
      );
      if (turnRpcExit.type !== "session.turn") throw new Error("unreachable");
      assert.match(turnRpcExit.error?.message ?? "", /Unsupported parameter combination/);
      const noticesRpcExit = events.filter(
        (e) => e.type === "session.notice" && e.notice.id.startsWith("acp:m-rpc-exit:recovery:"),
      );
      assert.equal(noticesRpcExit.length, 0, "explicit permanent RPC error must not retry as processExit");
    } finally {
      await conn.close();
    }
  });

  it("[R2-4] normalizes Usage locators across SSH client ports and worktree PATHs without evicting active registry locators", async () => {
    const dir = await tracker.make("acp-r2-4-");
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
      env: { HOME: dir, USERPROFILE: dir, PATH: process.env.PATH ?? "" },
    };

    const usageReg = new Usage().registration();
    const logins: Array<{ input: unknown }> = [];
    for (let i = 1; i <= 35; i += 1) {
      const accs = await usageReg.discover({
        kind: "session",
        provider: "antigravity-resilient",
        env: {
          PASEO_AGENT_ID: `agent-${i}`,
          SSH_CONNECTION: `10.0.0.2 ${50000 + i} 10.0.0.1 22`,
          SSH_TTY: `/dev/pts/${i}`,
        },
        launch: baseLaunch,
      });
      for (const a of accs) {
        if (!logins.some((x) => JSON.stringify(x.input) === JSON.stringify(a.input))) {
          logins.push({ input: a.input });
        }
      }
    }

    assert.equal(logins.length, 1, "35 SSH connections for the same account must share 1 locator");

    const outcomes = await Promise.allSettled(logins.map((l) => usageReg.fetch(l.input as never)));
    const cliProcessesSpawned = (await readFile(countFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean).length;
    assert.equal(outcomes.filter((o) => o.status === "rejected").length, 0);
    assert.equal(cliProcessesSpawned, 1, "must spawn only 1 CLI process for same account");

    // Active Account A must remain valid across 40 worktree PATH variations AND 40 distinct accounts
    const acctADir = path.join(dir, "acct-a");
    const acctADiscovered = await usageReg.discover({
      kind: "session",
      provider: "antigravity-resilient",
      env: { ANTIGRAVITY_HOME: acctADir },
      launch: baseLaunch,
    });
    const acctALocator = acctADiscovered[0]!.input;

    const worktreeLocators = new Set<string>();
    for (let i = 1; i <= 40; i += 1) {
      const wtAccs = await usageReg.discover({
        kind: "session",
        provider: "antigravity-resilient",
        env: { PATH: `E:/worktrees/wt-${i}/.venv/bin;${process.env.PATH ?? ""}` },
        launch: baseLaunch,
      });
      worktreeLocators.add(JSON.stringify(wtAccs[0]!.input));
    }
    assert.equal(worktreeLocators.size, 1, "worktree PATH prefixes that do not change binary must share 1 locator");

    for (let i = 1; i <= 40; i += 1) {
      await usageReg.discover({
        kind: "session",
        provider: "antigravity-resilient",
        env: { ANTIGRAVITY_HOME: path.join(dir, `other-acct-${i}`) },
        launch: baseLaunch,
      });
    }

    const refreshed = await usageReg.fetch(acctALocator);
    assert.equal(refreshed.status, "available", "targeted reportIds refresh on active Account A must not be evicted");
  });

  it("[R2-5] distinguishes live prompt usage from session/load replay usage and waits >90ms for large session post-load usage_update", async () => {
    const { directory, capturePath, launch } = await launchStubAgent(
      tracker,
      `
        const { appendFileSync } = require("node:fs");
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          appendFileSync(process.env.CAPTURE, line + "\\n");
          const { id, method, params } = JSON.parse(line);
          const sid = params?.sessionId ?? "conv-r2-5a";
          const update = (u) => send({ method: "session/update", params: { sessionId: sid, update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new") {
            send({ id, result: { sessionId: "conv-r2-5a", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
            setTimeout(() => process.exit(0), 25);
          } else if (method === "session/load") {
            send({ id, result: { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
            if (sid === "conv-slow-225k") {
              setTimeout(() => update({ sessionUpdate: "usage_update", used: 225000, size: 1048576 }), 95);
            }
          } else if (method === "session/prompt") {
            const text = params.prompt?.[0]?.text ?? "";
            if (text === "first-big-turn") {
              setTimeout(() => {
                update({ sessionUpdate: "usage_update", used: 185000, size: 1048576 });
                update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Big answer" } });
                send({ id, result: { stopReason: "end_turn" } });
              }, 15);
            } else {
              setTimeout(() => {
                update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok:" + text } });
                send({ id, result: { stopReason: "end_turn" } });
              }, 60);
            }
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
      `,
    );

    const conn = await createAntigravityResilientProvider({
      compaction: {
        autoCompactTokenThreshold: 150_000,
        preTurnCompactTokenThreshold: 200_000,
        hotCacheTtlMs: 200,
        autoCompactLeadMs: 120,
      },
    }).connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));

    try {
      // R2-5a: 0-turn session reopened via ensureInnerSessionAlive -> live 185K usage warms cache & schedules idle compact
      await conn.send({
        type: "session.open",
        requestId: "o-5a",
        sessionId: "s-5a",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready" && e.sessionId === "s-5a"), {
        label: "s-5a ready",
      });
      await new Promise((r) => setTimeout(r, 70));

      await conn.send({
        type: "session.prompt",
        sessionId: "s-5a",
        prompt: {
          clientMessageId: "m-5a",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "first-big-turn" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:m-5a" && e.state === "completed",
          ),
        { label: "m-5a completed" },
      );
      await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "timeline.item" &&
              e.sessionId === "s-5a" &&
              e.item.type === "compaction" &&
              e.item.status === "completed",
          ),
        { timeoutMs: 1_000, label: "s-5a idle compaction completed" },
      );
      await new Promise((r) => setTimeout(r, 120));

      // Verify R2-5a executed strictly ONE idle `/compact` RPC on the wire, with 2 timeline
      // status updates (`loading` -> `completed`) sharing the exact same compaction item id.
      const compactionItemsOn5a = events
        .filter(
          (
            e,
          ): e is Extract<ProviderEvent, { type: "timeline.item" }> & {
            item: { id: string; type: "compaction"; status: string };
          } => e.type === "timeline.item" && e.sessionId === "s-5a" && e.item.type === "compaction",
        )
        .map((e) => ({ id: e.item.id, status: e.item.status }));
      assert.equal(compactionItemsOn5a.length, 2);
      assert.deepEqual(
        compactionItemsOn5a.map((c) => c.status),
        ["loading", "completed"],
      );
      assert.equal(compactionItemsOn5a[0]!.id, compactionItemsOn5a[1]!.id);

      const wirePromptsOn5a = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((r) => r.method === "session/prompt" && r.params?.sessionId === "conv-r2-5a")
        .map((r) => r.params.prompt[0].text);
      assert.deepEqual(wirePromptsOn5a, ["first-big-turn", "/compact"]);

      // R2-5b: Large 225K session pushes usage_update 95ms after session.ready -> pre-turn /compact runs BEFORE turn!
      await conn.send({
        type: "session.open",
        requestId: "o-5b",
        sessionId: "s-5b",
        history: "replay",
        persistence: { version: 1, data: { sessionId: "conv-slow-225k" } },
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready" && e.sessionId === "s-5b"), {
        label: "s-5b ready",
      });
      await conn.send({
        type: "session.prompt",
        sessionId: "s-5b",
        prompt: {
          clientMessageId: "m-5b",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "turn-on-225k" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:m-5b" && e.state === "completed",
          ),
        { label: "m-5b completed" },
      );

      const wirePromptsOn5b = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((r) => r.method === "session/prompt" && r.params?.sessionId === "conv-slow-225k")
        .map((r) => r.params.prompt[0].text);
      assert.deepEqual(wirePromptsOn5b, ["/compact", "turn-on-225k"]);
    } finally {
      await conn.close();
    }
  });

  it("[R2-self-audit] settles startupTimeoutMs on hung session/new, supports unawaited close+reopen of same sessionId, and wakes postLoadUsageWaiter immediately on interrupt", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new") {
            if (process.env.HANG_SESSION_NEW === "1") {
              return;
            }
            send({ id, result: { sessionId: "conv-audit", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            send({ method: "session/update", params: { sessionId: "conv-audit", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
          } else if (method === "session/load") {
            send({ id, result: { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
            // Deliberately emit NO usage_update so postLoadUsageWaiter stays armed for 300ms
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
        setInterval(() => {}, 1000);
      `,
    );

    const sessionPids: number[] = [];
    const conn = await createAntigravityResilientProvider({
      startupTimeoutMs: 220,
      postLoadUsageWindowMs: 400,
      spawn: ((cmd: string, args: string[], opts: any) => {
        const c = nodeSpawn(cmd, args, opts);
        if (c.pid) {
          spawnedPids.add(c.pid);
          if (opts?.env?.TRACK_PID === "1") sessionPids.push(c.pid);
        }
        return c as any;
      }) as any,
    }).connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));

    try {
      // 1) Hung session/new without conn.close() fails cleanly at startupTimeoutMs and kills child
      await conn.send({
        type: "session.open",
        requestId: "open-timeout",
        sessionId: "s-timeout",
        history: "skip",
        config: {
          cwd: directory,
          env: { HANG_SESSION_NEW: "1", TRACK_PID: "1" },
          mcpServers: {},
          settings: {},
          persist: false,
        },
      });
      await waitFor(
        () => events.find((e) => e.type === "request.failed" && e.requestId === "open-timeout"),
        { timeoutMs: 1_200, label: "open-timeout request.failed" },
      );
      assert.equal(isPidAlive(sessionPids[0]!), false, "timed-out open child must be killed");

      // 2) Fire-and-forget session.close immediately followed by session.open on same sessionId
      await conn.send({
        type: "session.open",
        requestId: "open-1",
        sessionId: "s-reuse",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      void conn.send({
        type: "session.close",
        requestId: "close-1",
        sessionId: "s-reuse",
      });
      await conn.send({
        type: "session.open",
        requestId: "open-2",
        sessionId: "s-reuse",
        history: "replay",
        persistence: { version: 1, data: { sessionId: "conv-no-usage" } },
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(
        () => events.find((e) => e.type === "session.ready" && e.requestId === "open-2"),
        { timeoutMs: 1_500, label: "open-2 ready" },
      );

      // 3) Prompt waiting on 400ms postLoadUsageWaiter wakes in <100ms when interrupted
      const t0 = Date.now();
      await conn.send({
        type: "session.prompt",
        sessionId: "s-reuse",
        prompt: {
          clientMessageId: "m-interrupt-waiter",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "hi" }] },
        },
      });
      await conn.send({
        type: "session.interrupt",
        requestId: "int-waiter",
        sessionId: "s-reuse",
      });
      await waitFor(
        () => events.find((e) => e.type === "request.completed" && e.requestId === "int-waiter"),
        { timeoutMs: 250, label: "int-waiter completed immediately" },
      );
      assert.ok(Date.now() - t0 < 250, "interrupt must settle postLoadUsageWaiter without waiting 400ms");
    } finally {
      await conn.close();
    }
  });
});
