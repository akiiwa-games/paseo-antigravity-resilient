import assert from "node:assert/strict";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { spawnProcess } from "@getpaseo/plugin/server";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createAntigravityResilientProvider } from "../server/provider.ts";
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

describe("Round 3 adversarial review regressions (R3-1 to R3-4)", () => {
  it("[R3-1] single-flights concurrent ensureInnerSessionAlive calls so prompt + configure spawn one child and leave zero orphans after session.close", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          const sid = params?.sessionId ?? "conv-r3-1";
          const update = (u) => send({ method: "session/update", params: { sessionId: sid, update: u } });
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          } else if (method === "session/new") {
            send({
              id,
              result: {
                sessionId: "conv-r3-1",
                modes: {
                  currentModeId: "default",
                  availableModes: [
                    { id: "default", name: "Default" },
                    { id: "plan", name: "Plan" },
                  ],
                },
              },
            });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
            setTimeout(() => process.exit(0), 25);
          } else if (method === "session/load") {
            setTimeout(() => {
              send({
                id,
                result: {
                  modes: {
                    currentModeId: "default",
                    availableModes: [
                      { id: "default", name: "Default" },
                      { id: "plan", name: "Plan" },
                    ],
                  },
                },
              });
              update({ sessionUpdate: "available_commands_update", availableCommands: [] });
            }, 90);
          } else if (method === "session/set_mode") {
            send({ id, result: {} });
          } else if (method === "session/prompt") {
            setTimeout(() => {
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
              send({ id, result: { stopReason: "end_turn" } });
            }, 30);
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
        setInterval(() => {}, 1000);
      `,
    );

    const sessionPids: number[] = [];
    const conn = await createAntigravityResilientProvider({
      spawn: ((cmd: string, args: string[], opts: any) => {
        const child = nodeSpawn(cmd, args, opts);
        if (child.pid) {
          spawnedPids.add(child.pid);
          if (opts?.env?.TRACK_R3_1 === "1") {
            sessionPids.push(child.pid);
          }
        }
        return child as any;
      }) as any,
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
        requestId: "open-r3-1",
        sessionId: "s-r3-1",
        history: "skip",
        config: {
          cwd: directory,
          env: { TRACK_R3_1: "1" },
          mode: "default",
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await waitFor(
        () => events.find((e) => e.type === "session.ready" && e.requestId === "open-r3-1"),
        { label: "open-r3-1 ready" },
      );
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(isPidAlive(sessionPids[0]!), false, "initial child exited while idle");

      // Trigger reopen via prompt, then concurrently send session.configure while session/load is in flight
      await conn.send({
        type: "session.prompt",
        sessionId: "s-r3-1",
        prompt: {
          clientMessageId: "m-r3-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "hello" }] },
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      await conn.send({
        type: "session.configure",
        requestId: "cfg-r3-1",
        sessionId: "s-r3-1",
        changes: { mode: "plan" },
      });

      const cfgOutcome = await waitFor(
        () =>
          events.find(
            (e) =>
              (e.type === "request.completed" || e.type === "request.failed") &&
              e.requestId === "cfg-r3-1",
          ),
        { label: "cfg-r3-1 settled" },
      );
      const turnOutcome = await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "session.turn" &&
              e.turnId === "acp:m-r3-1" &&
              e.state !== "started",
          ),
        { label: "m-r3-1 settled" },
      );
      assert.equal(cfgOutcome.type, "request.completed");
      assert.equal(turnOutcome.type === "session.turn" ? turnOutcome.state : null, "completed");

      await conn.send({
        type: "session.close",
        requestId: "close-r3-1",
        sessionId: "s-r3-1",
      });
      await waitFor(
        () => events.find((e) => e.type === "request.completed" && e.requestId === "close-r3-1"),
        { label: "close-r3-1 completed" },
      );
      await new Promise((r) => setTimeout(r, 60));

      const reopenPids = sessionPids.slice(1);
      assert.equal(reopenPids.length, 1, "concurrent reopen must spawn exactly one child");
      assert.deepEqual(
        reopenPids.filter((pid) => isPidAlive(pid)),
        [],
        "no session child may remain alive after session.close",
      );
    } finally {
      await conn.close();
    }
  });

  it("[R3-1 + R2-2] single-flights concurrent prompt + configure on hung reopen and cancels/kills the single child within 650ms on session.interrupt", async () => {
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
            send({
              id,
              result: {
                sessionId: "conv-r3-1-int",
                modes: {
                  currentModeId: "default",
                  availableModes: [
                    { id: "default", name: "Default" },
                    { id: "plan", name: "Plan" },
                  ],
                },
              },
            });
            send({
              method: "session/update",
              params: {
                sessionId: "conv-r3-1-int",
                update: { sessionUpdate: "available_commands_update", availableCommands: [] },
              },
            });
            setTimeout(() => process.exit(0), 25);
          } else if (method === "session/load") {
            // Hang during session/load!
          } else if (method === "session/set_mode") {
            send({ id, result: {} });
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
        const child = nodeSpawn(cmd, args, opts);
        if (child.pid) {
          spawnedPids.add(child.pid);
          if (opts?.env?.TRACK_R3_1_INT === "1") {
            sessionPids.push(child.pid);
          }
        }
        return child as any;
      }) as any,
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
        requestId: "open-r3-1-int",
        sessionId: "s-r3-1-int",
        history: "skip",
        config: {
          cwd: directory,
          env: { TRACK_R3_1_INT: "1" },
          mode: "default",
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await waitFor(
        () => events.find((e) => e.type === "session.ready" && e.requestId === "open-r3-1-int"),
        { label: "open-r3-1-int ready" },
      );
      await new Promise((r) => setTimeout(r, 80));

      await conn.send({
        type: "session.prompt",
        sessionId: "s-r3-1-int",
        prompt: {
          clientMessageId: "m-r3-1-int",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "hello" }] },
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      await conn.send({
        type: "session.configure",
        requestId: "cfg-r3-1-int",
        sessionId: "s-r3-1-int",
        changes: { mode: "plan" },
      });
      await new Promise((r) => setTimeout(r, 40));

      await conn.send({
        type: "session.interrupt",
        requestId: "int-r3-1-int",
        sessionId: "s-r3-1-int",
      });

      await new Promise((r) => setTimeout(r, 650));
      const reopenPids = sessionPids.slice(1);
      assert.equal(reopenPids.length, 1, "must still spawn only 1 reopen child");
      assert.equal(
        events.some((e) => e.type === "request.completed" && e.requestId === "int-r3-1-int"),
        true,
        "session.interrupt must settle within 650ms",
      );
      assert.equal(
        events.some(
          (e) =>
            e.type === "session.turn" &&
            e.turnId === "acp:m-r3-1-int" &&
            e.state === "canceled",
        ),
        true,
        "foreground turn must settle as canceled within 650ms",
      );
      assert.equal(
        events.some((e) => e.type === "request.failed" && e.requestId === "cfg-r3-1-int"),
        true,
        "concurrent session.configure sharing aborted reopenPromise must settle with request.failed",
      );
      assert.equal(isPidAlive(reopenPids[0]!), false, "single reopen child must be dead within 650ms");
    } finally {
      for (const pid of sessionPids) killPidTree(pid);
      await conn.close();
    }
  });

  it("[R3-2] chains prior closingPromise inside new ManagedSession on synchronous open so close-1 -> open-2 -> close-2 cancels open-2 cleanly", async () => {
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
            send({
              id,
              result: {
                sessionId: "conv-r3-2",
                modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
              },
            });
            send({
              method: "session/update",
              params: {
                sessionId: "conv-r3-2",
                update: { sessionUpdate: "available_commands_update", availableCommands: [] },
              },
            });
          } else if (method === "session/close") {
            setTimeout(() => send({ id, result: {} }), 80);
          }
        });
        setInterval(() => {}, 1000);
      `,
    );

    const open2Pids: number[] = [];
    const conn = await createAntigravityResilientProvider({
      spawn: ((cmd: string, args: string[], opts: any) => {
        const child = nodeSpawn(cmd, args, opts);
        if (child.pid) {
          spawnedPids.add(child.pid);
          if (opts?.env?.GEN === "open-2") {
            open2Pids.push(child.pid);
          }
        }
        return child as any;
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
        requestId: "open-1",
        sessionId: "s-reuse",
        history: "skip",
        config: { cwd: directory, env: { GEN: "open-1" }, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(
        () => events.find((e) => e.type === "session.ready" && e.requestId === "open-1"),
        { label: "open-1 ready" },
      );

      // Unawaited close-1 -> open-2 -> close-2 while close-1 takes 80ms
      void conn.send({ type: "session.close", requestId: "close-1", sessionId: "s-reuse" });
      await conn.send({
        type: "session.open",
        requestId: "open-2",
        sessionId: "s-reuse",
        history: "skip",
        config: { cwd: directory, env: { GEN: "open-2" }, mcpServers: {}, settings: {}, persist: true },
      });
      await new Promise((r) => setTimeout(r, 15));
      await conn.send({ type: "session.close", requestId: "close-2", sessionId: "s-reuse" });

      await waitFor(
        () => events.find((e) => e.type === "request.completed" && e.requestId === "close-2"),
        { label: "close-2 completed" },
      );
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(
        events.some((e) => e.type === "session.ready" && e.requestId === "open-2"),
        false,
        "open-2 must never emit session.ready after close-2",
      );
      assert.equal(open2Pids.length, 0, "open-2 must not spawn a child after close-2 canceled it");
      assert.equal(
        open2Pids.some((pid) => isPidAlive(pid)),
        false,
        "no open-2 child may remain alive after close-2",
      );

      // A subsequent open-3 on the same sessionId must still succeed cleanly
      await conn.send({
        type: "session.open",
        requestId: "open-3",
        sessionId: "s-reuse",
        history: "skip",
        config: { cwd: directory, env: { GEN: "open-3" }, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(
        () => events.find((e) => e.type === "session.ready" && e.requestId === "open-3"),
        { label: "open-3 ready" },
      );
    } finally {
      await conn.close();
    }
  });

  it("[R3-3] intercepts late internal __-prefixed request.failed/request.completed events after single-session startup timeout or abort", async () => {
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
            if (process.env.HANG_NEW === "1") return;
            send({
              id,
              result: {
                sessionId: "conv-r3-3",
                modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
              },
            });
            send({
              method: "session/update",
              params: {
                sessionId: "conv-r3-3",
                update: { sessionUpdate: "available_commands_update", availableCommands: [] },
              },
            });
            if (process.env.EXIT_AFTER_OPEN === "1") {
              setTimeout(() => process.exit(0), 25);
            }
          } else if (method === "session/load") {
            // Hang on reopen so interrupt fallback timeout aborts __internal_reopen_...
          } else if (method === "session/close") {
            send({ id, result: {} });
          }
        });
        setInterval(() => {}, 1000);
      `,
    );

    const conn = await createAntigravityResilientProvider({
      startupTimeoutMs: 120,
      cancelFallbackTimeoutMs: 90,
      spawn: ((cmd: string, args: string[], opts: any) => {
        const child = nodeSpawn(cmd, args, opts);
        if (child.pid) spawnedPids.add(child.pid);
        return child as any;
      }) as any,
    }).connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));

    try {
      // 1) Single-session startupTimeoutMs abort (__open_...)
      await conn.send({
        type: "session.open",
        requestId: "host-open-timeout",
        sessionId: "s-r3-3-timeout",
        history: "skip",
        config: { cwd: directory, env: { HANG_NEW: "1" }, mcpServers: {}, settings: {}, persist: false },
      });
      await waitFor(
        () => events.find((e) => e.type === "request.failed" && e.requestId === "host-open-timeout"),
        { label: "host-open-timeout failed" },
      );

      // 2) Mid-reopen session.interrupt fallback timeout (__internal_reopen_...)
      await conn.send({
        type: "session.open",
        requestId: "host-open-reopen",
        sessionId: "s-r3-3-reopen",
        history: "skip",
        config: {
          cwd: directory,
          env: { EXIT_AFTER_OPEN: "1" },
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await waitFor(
        () => events.find((e) => e.type === "session.ready" && e.requestId === "host-open-reopen"),
        { label: "host-open-reopen ready" },
      );
      await new Promise((r) => setTimeout(r, 70));
      await conn.send({
        type: "session.prompt",
        sessionId: "s-r3-3-reopen",
        prompt: {
          clientMessageId: "m-r3-3-reopen",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "trigger-hung-reopen" }] },
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      await conn.send({
        type: "session.interrupt",
        requestId: "host-interrupt-reopen",
        sessionId: "s-r3-3-reopen",
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "request.completed" && e.requestId === "host-interrupt-reopen",
          ),
        { label: "host-interrupt-reopen completed" },
      );
      await new Promise((r) => setTimeout(r, 80));

      const leakedInternalEvents = events.filter(
        (e) => "requestId" in e && typeof e.requestId === "string" && e.requestId.startsWith("__"),
      );
      assert.deepEqual(
        leakedInternalEvents,
        [],
        "internal __-prefixed request events must never leak to conn.onEvent",
      );
    } finally {
      await conn.close();
    }
  });

  it(
    "[R3-4] kills entire process tree (including Windows .cmd wrapper grandchildren) on delayed-pid mid-spawn abort",
    { skip: process.platform !== "win32" },
    async () => {
      const directory = await tracker.make("acp-r3-4-cmd-");
      const pidOutFile = path.join(directory, "grandchild.pid");
      const grandchildScript = path.join(directory, "grandchild.cjs");
      const wrapperCmd = path.join(directory, "agy-wrapper.cmd");

      await writeFile(
        grandchildScript,
        `
          const fs = require("node:fs");
          const { createInterface } = require("node:readline");
          if (process.env.RECORD_GRANDCHILD === "1") {
            fs.writeFileSync(${JSON.stringify(pidOutFile)}, String(process.pid));
          }
          const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
          createInterface({ input: process.stdin }).on("line", (line) => {
            const { id, method } = JSON.parse(line);
            if (method === "initialize") {
              send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
            } else if (method === "session/new") {
              send({
                id,
                result: {
                  sessionId: "conv-r3-4",
                  modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
                },
              });
              send({
                method: "session/update",
                params: {
                  sessionId: "conv-r3-4",
                  update: { sessionUpdate: "available_commands_update", availableCommands: [] },
                },
              });
            }
          });
          setInterval(() => {}, 1000);
        `,
        "utf8",
      );
      await writeFile(
        wrapperCmd,
        `@echo off\r\n"${process.execPath}" "${grandchildScript}" %*\r\n`,
        "utf8",
      );

      const delayedCmdSpawn = ((cmd: string, args: string[], opts: any) => {
        const realChild = spawnProcess(cmd, args, opts);
        if (realChild.pid) spawnedPids.add(realChild.pid);
        if (opts?.env?.RECORD_GRANDCHILD !== "1") {
          return realChild as any;
        }
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
            // Wait until the .cmd wrapper has actually launched its grandchild Node process,
            // then expose `pid` and fire `"spawn"` so `killAbortedChild` runs against the live tree.
            const poll = setInterval(() => {
              if (existsSync(pidOutFile)) {
                clearInterval(poll);
                proxyReady = true;
                cb();
              }
            }, 15);
            poll.unref();
            return proxy;
          }
          origOnce(ev as any, cb);
          return proxy;
        };
        return proxy as any;
      }) as any;

      const conn = await createAntigravityResilientProvider({
        spawn: delayedCmdSpawn,
      }).connect({
        launch: {
          command: wrapperCmd,
          args: ["acp"],
          env: { ...process.env } as Record<string, string>,
        },
        versions: [1],
        capabilities: ["prompt.message"],
      });
      const events: ProviderEvent[] = [];
      conn.onEvent((e) => events.push(e));

      try {
        await conn.send({
          type: "session.open",
          requestId: "open-cmd",
          sessionId: "s-cmd",
          history: "skip",
          config: {
            cwd: directory,
            env: { RECORD_GRANDCHILD: "1" },
            mcpServers: {},
            settings: {},
            persist: false,
          },
        });
        await new Promise((r) => setTimeout(r, 10));
        await conn.send({
          type: "session.close",
          requestId: "close-cmd",
          sessionId: "s-cmd",
        });
        await waitFor(
          () => events.find((e) => e.type === "request.completed" && e.requestId === "close-cmd"),
          { label: "close-cmd completed" },
        );

        assert.equal(existsSync(pidOutFile), true, "grandchild pid file must have been written");
        const grandPid = Number(readFileSync(pidOutFile, "utf8").trim());
        spawnedPids.add(grandPid);
        assert.equal(
          isPidAlive(grandPid),
          false,
          "Windows .cmd grandchild process must be terminated by killAbortedChild",
        );
      } finally {
        if (existsSync(pidOutFile)) {
          const grandPid = Number(readFileSync(pidOutFile, "utf8").trim());
          if (Number.isFinite(grandPid) && grandPid > 0) killPidTree(grandPid);
        }
        await conn.close();
      }
    },
  );
});
