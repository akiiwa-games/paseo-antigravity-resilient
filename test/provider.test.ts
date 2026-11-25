import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import {
  defaultAgyCommand,
  resolveDefaultAgyExecutable,
  resolveEffectiveLaunch,
} from "../server/launch.ts";
import {
  createAntigravityResilientProvider,
  MIN_AGY_VERSION_EXPORT,
  PLUGIN_ID,
  PROVIDER_ID,
  PROVIDER_LABEL,
} from "./provider-exports-bridge.ts";
import { launchStubAgent, TempDirTracker, waitFor } from "./helpers.ts";

const tracker = new TempDirTracker();

afterEach(async () => {
  await tracker.cleanup();
});

const minimalAcpAgent = `
  const { createInterface } = require("node:readline");
  createInterface({ input: process.stdin }).on("line", (line) => {
    const { id, method } = JSON.parse(line);
    if (method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "Antigravity ACP Server", version: "1.5.17" },
          agentCapabilities: {}
        }
      }) + "\\n");
    }
  });
`;

describe("provider identity and status", () => {
  it("preserves antigravity-resilient identity and minimum agy version check", async () => {
    assert.equal(PROVIDER_ID, "antigravity-resilient");
    assert.equal(PLUGIN_ID, "antigravity-resilient-provider");
    assert.equal(PROVIDER_LABEL, "Antigravity (Resilient)");
    assert.equal(MIN_AGY_VERSION_EXPORT, "1.5.15");

    const { launch } = await launchStubAgent(
      tracker,
      `
        process.stderr.write("Unknown command: acp\\n");
        process.exitCode = 1;
      `,
    );
    const provider = createAntigravityResilientProvider({ discoveryRetryDelayMs: 10 });
    assert.equal(provider.id, "antigravity-resilient");
    assert.deepEqual(provider.command?.slice(1), ["acp", "--disable-telemetry"]);
    const status = await provider.status!({ launch });
    assert.equal(status.available, false);
    assert.match(status.diagnostic ?? "", /1\.5\.15/);
  });

  it("rejects agy versions older than 1.5.15 during ACP initialize", async () => {
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
              result: {
                protocolVersion: 1,
                agentInfo: { name: "Antigravity ACP Server", version: "1.5.11" },
                agentCapabilities: {}
              }
            }) + "\\n");
          }
        });
      `,
    );
    const provider = createAntigravityResilientProvider({ discoveryRetryDelayMs: 10 });
    const status = await provider.status!({ launch });
    assert.equal(status.available, false);
    assert.match(status.diagnostic ?? "", /Antigravity 1\.5\.11 is unsupported\. Update agy to 1\.5\.15 or later\./);
  });

  it("reports SSH sign-in diagnostics accurately", async () => {
    const { launch } = await launchStubAgent(tracker, minimalAcpAgent);
    const provider = createAntigravityResilientProvider({ discoveryRetryDelayMs: 10 });
    assert.deepEqual(await provider.status!({ launch }), {
      available: true,
      diagnostic: "SSH session: no\nSign-in: can differ from agy over SSH",
    });

    for (const variable of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
      const env = { ...launch.env, [variable]: "set" };
      assert.deepEqual(await provider.status!({ launch: { ...launch, env } }), {
        available: true,
        diagnostic: `SSH session: yes (${variable})\nSign-in: can differ from agy outside SSH`,
      });
    }

    const failing = await launchStubAgent(tracker, `process.exit(1);`);
    const sshFailStatus = await provider.status!({
      launch: { ...failing.launch, env: { ...failing.launch.env, SSH_CONNECTION: "set" } },
    });
    assert.deepEqual(sshFailStatus, {
      available: false,
      diagnostic: [
        "Antigravity ACP did not start. Install Antigravity 1.5.15 or later. If you override the command, include the acp subcommand.",
        "SSH session: yes (SSH_CONNECTION)",
        "Sign-in: can differ from agy outside SSH",
      ].join("\n"),
    });
  });

  it("inspects installation version and reports not_installed when unresolved", async () => {
    const signal = new AbortController().signal;
    const { launch } = await launchStubAgent(
      tracker,
      `
        const args = process.argv.slice(2);
        if (args.includes("acp")) process.exit(1);
        if (args[0] === "--version") console.log("Antigravity CLI 1.5.17");
      `,
    );
    const installation = createAntigravityResilientProvider().installation!;
    assert.equal(
      installation.installUrl,
      "https://antigravity.google/docs/getting-started?tab=cli",
    );
    assert.equal(installation.update, undefined);
    assert.deepEqual(
      await installation.inspect!({ launch: { ...launch, resolved: true }, signal }),
      { status: "installed", version: "1.5.17" },
    );
    assert.deepEqual(
      await installation.inspect!({
        launch: { command: "agy", args: ["acp"], env: {}, resolved: false },
        signal,
      }),
      { status: "not_installed" },
    );
  });

  it("falls back to %LOCALAPPDATA%\\agy\\bin\\agy.exe on Windows when agy is missing from PATH", () => {
    const winAgy = path.join("D:", "Users", "alice", "AppData", "Local", "agy", "bin", "agy.exe");
    const resolved = resolveDefaultAgyExecutable({
      platform: "win32",
      env: {
        PATH: "C:\\Windows\\System32",
        LOCALAPPDATA: path.join("D:", "Users", "alice", "AppData", "Local"),
      },
      exists: (candidate) => candidate === winAgy,
    });
    assert.equal(resolved, winAgy);
    assert.deepEqual(
      defaultAgyCommand({
        platform: "win32",
        env: {
          PATH: "C:\\Windows\\System32",
          LOCALAPPDATA: path.join("D:", "Users", "alice", "AppData", "Local"),
        },
        exists: (candidate) => candidate === winAgy,
      }),
      [winAgy, "acp", "--disable-telemetry"],
    );

    // When agy is already on PATH, keep bare "agy" so per-provider PATH overrides win.
    const onPath = resolveDefaultAgyExecutable({
      platform: "win32",
      env: {
        PATH: "D:\\custom\\bin",
        LOCALAPPDATA: path.join("D:", "Users", "alice", "AppData", "Local"),
      },
      exists: (candidate) => candidate === path.join("D:\\custom\\bin", "agy.exe") || candidate === winAgy,
    });
    assert.equal(onPath, "agy");

    const effective = resolveEffectiveLaunch(
      {
        command: "agy",
        args: ["acp", "--disable-telemetry"],
        env: {
          PATH: "C:\\Windows\\System32",
          LOCALAPPDATA: path.join("D:", "Users", "alice", "AppData", "Local"),
        },
      },
      {
        platform: "win32",
        exists: (candidate) => candidate === winAgy,
      },
    );
    assert.equal(effective.command, winAgy);
  });
});

describe("official v0.17.4 ACP provider parity and legacy compatibility", () => {
  it("publishes Antigravity skills separately from built-in commands", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method } = JSON.parse(line);
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1 } });
          }
          if (method === "session/new") {
            send({ id, result: { sessionId: "native", modes: {
              currentModeId: "default", availableModes: [{ id: "default", name: "Default" }],
            } } });
            send({ method: "session/update", params: { sessionId: "native", update: {
              sessionUpdate: "available_commands_update",
              availableCommands: ["goal", "compact", "schedule", "browser", "plan", "grill-me",
                "teamwork", "learn", "boost", "agy-customizations", "antigravity-guide", "diagnose"]
                .map(name => ({ name, description: name })),
            } } });
          }
          if (method === "session/close") send({ id, result: {} });
        });
      `,
    );

    const connection = await createAntigravityResilientProvider().connect({
      launch,
      versions: [1],
      capabilities: [],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "session.open",
        requestId: "new",
        sessionId: "test",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: false },
      });
      const cmdEvent = await waitFor(
        () => events.find((e): e is Extract<ProviderEvent, { type: "session.commands" }> => e.type === "session.commands"),
        { label: "session.commands" },
      );
      assert.deepEqual(
        cmdEvent.commands.map(({ name, description, kind }) => ({ name, description, kind })),
        [
          ...[
            "goal",
            "compact",
            "schedule",
            "browser",
            "plan",
            "grill-me",
            "teamwork",
            "learn",
            "boost",
          ].map((name) => ({ name, description: name, kind: "command" })),
          ...["agy-customizations", "antigravity-guide", "diagnose"].map((name) => ({
            name,
            description: name,
            kind: "skill",
          })),
        ],
      );
    } finally {
      await connection.close();
    }
  });

  for (const supportsSystemPrompt of [true, false]) {
    it(`loads saved stream-json conversationId and sessionKey persistence (systemPrompt=${supportsSystemPrompt})`, async () => {
      const { directory, capturePath, launch } = await launchStubAgent(
        tracker,
        `
          const { appendFileSync } = require("node:fs");
          const { createInterface } = require("node:readline");
          const configOptions = [
            { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-neon",
              options: [
                { value: "gemini-4-neon", name: "Gemini 4 Neon" },
                { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
                { value: "gemini-4-neon-high", name: "Gemini 4 Neon High" }
              ] },
            { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "low",
              options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
            { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "accept-edits",
              options: [{ value: "default", name: "Default" }, { value: "accept-edits", name: "Accept edits" }] },
          ];
          const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
          createInterface({ input: process.stdin }).on("line", (line) => {
            appendFileSync(process.env.CAPTURE, line + "\\n");
            const { id, method, params } = JSON.parse(line);
            switch (method) {
              case "initialize":
                send({ id, result: { protocolVersion: 1, agentCapabilities: {
                  loadSession: true,
                  _meta: { antigravity: { systemPrompt: { append: ${supportsSystemPrompt} } } },
                } } });
                break;
              case "session/load":
                send({ method: "session/update", params: { sessionId: params.sessionId, update: {
                  sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Saved reply" },
                } } });
                send({ method: "session/update", params: { sessionId: params.sessionId, update: {
                  sessionUpdate: "tool_call", toolCallId: "write", name: "write_file", title: "File notes.txt",
                  status: "completed", kind: "edit", rawInput: { Path: "/repo/notes.txt", Content: "hello" },
                } } });
                send({ id, result: { configOptions } });
                break;
              case "session/set_config_option":
                configOptions.find(option => option.id === params.configId).currentValue = params.value;
                send({ id, result: { configOptions } });
                break;
              case "session/close":
                send({ id, result: {} });
                break;
            }
          });
        `,
      );

      // Also prepare a legacy `session-keys` binding directory to verify pre-init legacy persistence.
      const legacyStoreDir = path.join(directory, "legacy-store");
      await mkdir(path.join(legacyStoreDir, "session-keys"), { recursive: true });
      await writeFile(
        path.join(legacyStoreDir, "session-keys", "legacy-session-key-1.json"),
        JSON.stringify({ version: 1, conversationId: "bound-conversation-id" }),
        "utf8",
      );

      const provider = createAntigravityResilientProvider({ legacyStoreDir });
      const connection = await provider.connect({
        launch,
        versions: [1],
        capabilities: ["session.configure", "session.persistence"],
      });
      const events: ProviderEvent[] = [];
      connection.onEvent((event) => events.push(event));
      try {
        await connection.send({
          type: "session.open",
          requestId: "restore",
          sessionId: "test",
          history: "replay",
          persistence: {
            version: 1,
            data: supportsSystemPrompt
              ? { conversationId: "saved-conversation", sessionKey: "ignored-when-conv-present" }
              : { sessionKey: "legacy-session-key-1" },
          },
          config: {
            cwd: directory,
            model: "gemini-3.8-flash-high",
            mode: "full-access",
            systemPrompt: "A test system instruction",
            env: {},
            mcpServers: {},
            settings: {},
            persist: true,
          },
        });
        await waitFor(
          () => events.find((e) => e.type === "session.ready" || e.type === "request.failed"),
          { label: "session.ready" },
        );
        const expectedSessionId = supportsSystemPrompt
          ? "saved-conversation"
          : "bound-conversation-id";

        const opened = events.find((e) => e.type === "session.opened");
        if (!opened || opened.type !== "session.opened") {
          throw new Error("Expected session.opened event");
        }
        assert.deepEqual(opened.persistence, {
          version: 1,
          data: {
            sessionId: expectedSessionId,
            conversationId: expectedSessionId,
          },
        });

        assert.ok(
          events.some(
            (e) =>
              e.type === "timeline.item" &&
              e.item.type === "assistant_message" &&
              e.item.text === "Saved reply",
          ),
        );
        assert.ok(
          events.some(
            (e) =>
              e.type === "timeline.item" &&
              e.item.type === "tool_call" &&
              e.item.detail.type === "write" &&
              e.item.detail.filePath === "/repo/notes.txt" &&
              e.item.detail.content === "hello",
          ),
        );
        const cfgEvent = events.find((e) => e.type === "session.config");
        if (!cfgEvent || cfgEvent.type !== "session.config") {
          throw new Error("Expected session.config event");
        }
        assert.equal(cfgEvent.config.mode, "full-access");
        assert.equal(cfgEvent.config.model, "gemini-3.8-flash");
        assert.equal(cfgEvent.config.thinkingOption, "high");

        await connection.send({
          type: "session.configure",
          requestId: "native-model",
          sessionId: "test",
          changes: { model: "gemini-4-neon-high" },
        });
        await waitFor(
          () =>
            events.find(
              (e) => e.type === "session.config" && e.config.model === "gemini-4-neon-high",
            ),
          { label: "configure native-model" },
        );

        const requests = (await readFile(capturePath, "utf8"))
          .trim()
          .split("\n")
          .map(
            (line: string) =>
              JSON.parse(line) as {
                method: string;
                params: { sessionId?: string; _meta?: { antigravity?: unknown } };
              },
          );
        const load = requests.find((req) => req.method === "session/load");
        assert.ok(load);
        assert.equal(load.params.sessionId, expectedSessionId);
        assert.deepEqual(
          load.params._meta?.antigravity,
          supportsSystemPrompt
            ? { systemPrompt: { append: "A test system instruction" } }
            : undefined,
        );
      } finally {
        await connection.close();
      }
    });
  }

  const completedToolCalls = [
    {
      toolCallId: "shell",
      name: "run_command",
      kind: "execute",
      rawInput: {
        CommandLine: "printf test; exit 7",
        WaitMsBeforeAsync: 5000,
        toolSummary: "Run exit code test",
      },
      rawOutput: { output: "Command exited with code 7.\n\nCommand output:\ntest", exit_code: 7 },
    },
    {
      toolCallId: "read",
      name: "read_file",
      kind: "read",
      locations: [{ path: "/repo/probe.txt" }],
      rawInput: { Path: "/repo/probe.txt", StartLine: 2, EndLine: 2 },
    },
    {
      toolCallId: "write",
      name: "write_file",
      kind: "edit",
      locations: [{ path: "/repo/probe.txt" }],
      rawInput: { Path: "/repo/probe.txt", Content: "alpha\nbeta\ngamma\n", Overwrite: true },
      rawOutput: {},
      content: [{ type: "diff", path: "/repo/probe.txt", newText: "alpha\nbeta\ngamma\n" }],
    },
    {
      toolCallId: "edit",
      name: "edit_file",
      kind: "edit",
      locations: [{ path: "/repo/probe.txt" }],
      rawInput: { Path: "/repo/probe.txt", Target: "beta", Replacement: "delta" },
      rawOutput: {},
      content: [
        {
          type: "diff",
          path: "/repo/probe.txt",
          oldText: "alpha\nbeta\ngamma\n",
          newText: "alpha\ndelta\ngamma\n",
        },
      ],
    },
    {
      toolCallId: "web",
      name: "search_web",
      kind: "search",
      rawInput: { query: "IANA example domains" },
    },
    {
      toolCallId: "paseo",
      name: "mcp_paseo_send_agent_prompt",
      kind: "other",
      rawInput: { agentId: "agent-1", prompt: "Hello", toolSummary: "Send message" },
    },
    {
      toolCallId: "mcp",
      name: "mcp_local_tools_echo_message",
      kind: "other",
      rawInput: { message: "hello", toolSummary: "Echo message hello" },
    },
    {
      toolCallId: "ambiguous",
      name: "mcp_paseo_get_agent_status",
      kind: "other",
      rawInput: { agentId: "agent-1", toolSummary: "Get agent status" },
    },
  ];

  for (const source of ["live", "replay"] as const) {
    it(`maps Antigravity tool calls in ${source} timelines`, async () => {
      const { directory, launch } = await launchStubAgent(
        tracker,
        `
          const { createInterface } = require("node:readline");
          const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
          const tools = ${JSON.stringify(completedToolCalls)};
          const modes = { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] };
          createInterface({ input: process.stdin }).on("line", (line) => {
            const { id, method, params } = JSON.parse(line);
            const update = (u) => send({ method: "session/update", params: { sessionId: params.sessionId ?? "agy-session", update: u } });
            switch (method) {
              case "initialize":
                send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
                break;
              case "session/new":
                send({ id, result: { sessionId: "agy-session", modes } });
                update({ sessionUpdate: "available_commands_update", availableCommands: [] });
                break;
              case "session/load":
              case "session/prompt":
                for (const { rawOutput, content, ...tool } of tools) {
                  const completed = { status: "completed", rawOutput, content };
                  if (method === "session/load") {
                    update({ sessionUpdate: "tool_call", title: tool.name, ...tool, ...completed });
                  } else {
                    update({ sessionUpdate: "tool_call", title: tool.name, ...tool, status: "in_progress" });
                    update({ sessionUpdate: "tool_call_update", toolCallId: tool.toolCallId, ...completed });
                  }
                }
                if (method === "session/prompt") {
                  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
                }
                send({ id, result: method === "session/load" ? { modes } : { stopReason: "end_turn" } });
                break;
              case "session/close":
                send({ id, result: {} });
                break;
            }
          });
        `,
      );

      const connection = await createAntigravityResilientProvider().connect({
        launch,
        versions: [1],
        capabilities: ["session.persistence", "prompt.message"],
      });
      const events: ProviderEvent[] = [];
      connection.onEvent((event) => events.push(event));
      try {
        await connection.send({
          type: "session.open",
          requestId: "open",
          sessionId: "test",
          history: source === "replay" ? "replay" : "skip",
          persistence:
            source === "replay" ? { version: 1, data: { sessionId: "agy-session" } } : undefined,
          config: {
            cwd: directory,
            env: {},
            mcpServers: {
              paseo_get: { type: "stdio", command: "other-server" },
              local_tools: { type: "stdio", command: "echo-mcp" },
            },
            settings: {},
            persist: true,
          },
        });
        await waitFor(() => events.find((e) => e.type === "session.ready"), {
          label: "session.ready",
        });

        if (source === "live") {
          await connection.send({
            type: "session.prompt",
            sessionId: "test",
            prompt: {
              clientMessageId: "exercise-tools",
              delivery: "auto",
              input: { type: "message", content: [{ type: "text", text: "Exercise tools" }] },
            },
          });
        }

        const calls = () =>
          events.flatMap((event) =>
            event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item] : [],
          );
        await waitFor(
          () => calls().filter((call) => call.status === "completed").length === completedToolCalls.length,
          { label: "all tool calls completed" },
        );

        const completed = Object.fromEntries(
          calls()
            .filter((call) => call.status === "completed")
            .map((call) => [call.id, call]),
        );
        assert.deepEqual(completed.shell?.detail, {
          type: "shell",
          command: "printf test; exit 7",
          output: "Command exited with code 7.\n\nCommand output:\ntest",
          exitCode: 7,
        });
        assert.deepEqual(completed.read?.detail, {
          type: "read",
          filePath: "/repo/probe.txt",
          offset: 2,
          limit: 1,
        });
        assert.deepEqual(completed.write?.detail, {
          type: "write",
          filePath: "/repo/probe.txt",
          content: "alpha\nbeta\ngamma\n",
        });
        assert.deepEqual(completed.edit?.detail, {
          type: "edit",
          filePath: "/repo/probe.txt",
          oldString: "alpha\nbeta\ngamma\n",
          newString: "alpha\ndelta\ngamma\n",
          unifiedDiff: undefined,
        });
        assert.deepEqual(completed.web?.detail, {
          type: "search",
          toolName: "web_search",
          query: "IANA example domains",
        });
        assert.equal(completed.paseo?.name, "paseo.send_agent_prompt");
        assert.deepEqual(completed.paseo?.detail, {
          type: "unknown",
          input: { agentId: "agent-1", prompt: "Hello" },
          output: null,
        });
        assert.equal(completed.mcp?.name, "local_tools.echo_message");
        assert.deepEqual(completed.mcp?.detail, {
          type: "unknown",
          input: { message: "hello" },
          output: null,
        });
        assert.equal(completed.ambiguous?.name, "mcp_paseo_get_agent_status");
      } finally {
        await connection.close();
      }
    });
  }

  it("offers per-model thinkingOptions, attaches legacy effort aliases, and opens Orchestrator cleanly", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const levels = (...values) => values.map((value) => ({ value, name: value }));
        const thinking = {
          "gemini-4-neon": { currentValue: "high", options: levels("low", "medium", "high", "xhigh") },
          "gemini-4-hydrogen": { currentValue: "high", options: levels("low", "medium", "high") },
          "claude-opus-5-5": { currentValue: "medium", options: levels("low", "medium", "high") },
        };
        let model = "gemini-4-neon";
        const configOptions = () => [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon" },
            { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
            { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
            { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
          ] },
          ...(thinking[model] ? [{ id: "thought_level", name: "Thinking", category: "thought_level", type: "select", ...thinking[model] }] : []),
          { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
            options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
        ];
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          if (method === "initialize") send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
          if (method === "session/new") {
            model = "gemini-4-neon";
            send({ id, result: { sessionId: "native", configOptions: configOptions() } });
          }
          if (method === "session/set_config_option") {
            if (params.configId === "thought_level" && !thinking[model]) {
              send({ id, error: { code: -32602, message: "unknown config option" } });
              return;
            }
            if (params.configId === "model") model = params.value;
            else if (params.configId === "thought_level") thinking[model].currentValue = params.value;
            send({ id, result: { configOptions: configOptions() } });
          }
          if (method === "session/close") send({ id, result: {} });
        });
      `,
    );

    const connection = await createAntigravityResilientProvider().connect({
      launch,
      versions: [1],
      capabilities: ["session.configure"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({ type: "catalog", requestId: "catalog", cwd: directory });
      const catalogEvent = await waitFor(
        () => events.find((e): e is Extract<ProviderEvent, { type: "catalog" }> => e.type === "catalog"),
        { label: "catalog" },
      );

      const byModel = Object.fromEntries(
        catalogEvent.catalog.models.map((m) => [
          m.id,
          {
            options: m.thinkingOptions?.map((o) => o.id),
            default: m.defaultThinkingOptionId,
            aliases: m.aliases,
          },
        ]),
      );
      assert.deepEqual(byModel["gemini-4-neon"], {
        options: ["low", "medium", "high", "xhigh"],
        default: "high",
        aliases: [
          "gemini-4-neon-low",
          "gemini-4-neon-medium",
          "gemini-4-neon-high",
          "gemini-4-neon-xhigh",
        ],
      });
      assert.deepEqual(byModel["gemini-4-hydrogen"], {
        options: ["low", "medium", "high"],
        default: "high",
        aliases: [
          "gemini-4-hydrogen-low",
          "gemini-4-hydrogen-medium",
          "gemini-4-hydrogen-high",
        ],
      });
      assert.deepEqual(byModel["gemini-pro-orchestrator-neon"], {
        options: [],
        default: undefined,
        aliases: undefined,
      });

      // Open Orchestrator with undefined thinking option AND open a legacy suffixed model ID on new session.
      await connection.send({
        type: "session.open",
        requestId: "open-orch",
        sessionId: "orchestrator",
        history: "skip",
        config: {
          cwd: directory,
          model: "gemini-pro-orchestrator-neon",
          mode: "full-access",
          thinkingOption: byModel["gemini-pro-orchestrator-neon"]!.default,
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.ready" && e.sessionId === "orchestrator",
          ),
        { label: "orchestrator ready" },
      );

      await connection.send({
        type: "session.open",
        requestId: "open-legacy-model",
        sessionId: "hydrogen-session",
        history: "skip",
        config: {
          cwd: directory,
          model: "gemini-4-hydrogen-medium",
          mode: "full-access",
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.ready" && e.sessionId === "hydrogen-session",
          ),
        { label: "hydrogen-session ready" },
      );
      const hydrogenCfg = events.find(
        (e): e is Extract<ProviderEvent, { type: "session.config" }> =>
          e.type === "session.config" && e.sessionId === "hydrogen-session",
      );
      if (!hydrogenCfg) throw new Error("Expected hydrogen-session config");
      assert.equal(hydrogenCfg.config.model, "gemini-4-hydrogen");
      assert.equal(hydrogenCfg.config.thinkingOption, "medium");
    } finally {
      await connection.close();
    }
  });

  it("completes recurring schedule turns immediately and defers non-daemon background run_command turns", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
        let turn = 0;
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: params.sessionId ?? "agy-session", update: u } });
          switch (method) {
            case "initialize":
              send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
              break;
            case "session/new":
              send({ id, result: { sessionId: "agy-session", configOptions: [
                { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
                  options: [{ value: "default", name: "Default" }] },
              ] } });
              update({ sessionUpdate: "available_commands_update", availableCommands: [] });
              break;
            case "session/prompt":
              turn += 1;
              if (turn === 1) {
                const args = { CronExpression: "*/15 * * * *", Prompt: "ping" };
                update({ sessionUpdate: "tool_call", toolCallId: "cron", name: "schedule", status: "in_progress", kind: "other", title: "Run schedule", rawInput: args });
                send({ id, result: { stopReason: "end_turn" } });
              } else if (turn === 2) {
                update({ sessionUpdate: "tool_call", toolCallId: "daemon-1", name: "run_command", title: "Dev server", status: "in_progress", rawInput: { CommandLine: "npm run dev", IsDaemon: true } });
                send({ id, result: { stopReason: "end_turn" } });
              } else {
                update({ sessionUpdate: "tool_call", toolCallId: "bg-1", name: "run_command", title: "Background build", status: "in_progress", rawInput: { CommandLine: "sleep 1" } });
                send({ id, result: { stopReason: "end_turn" } });
                setTimeout(() => {
                  update({ sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed" });
                  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Build finished." } });
                  update({ sessionUpdate: "usage_update", used: 50, size: 1000 });
                }, 80);
              }
              break;
            case "session/close":
              send({ id, result: {} });
              break;
          }
        });
      `,
    );

    const connection = await createAntigravityResilientProvider().connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "session.open",
        requestId: "open",
        sessionId: "test",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: false },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });

      // Turn 1: recurring schedule completes immediately despite in_progress status.
      await connection.send({
        type: "session.prompt",
        sessionId: "test",
        prompt: {
          clientMessageId: "schedule-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "schedule" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "session.turn" &&
              e.turnId === "acp:schedule-turn" &&
              e.state === "completed",
          ),
        { label: "schedule-turn completed" },
      );

      // Turn 2: IsDaemon completes immediately.
      await connection.send({
        type: "session.prompt",
        sessionId: "test",
        prompt: {
          clientMessageId: "daemon-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "daemon" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "session.turn" &&
              e.turnId === "acp:daemon-turn" &&
              e.state === "completed",
          ),
        { label: "daemon-turn completed" },
      );

      // Turn 3: non-daemon background run_command stays open until completion + reply + usage_update.
      await connection.send({
        type: "session.prompt",
        sessionId: "test",
        prompt: {
          clientMessageId: "bg-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "build" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "timeline.item" &&
              e.item.type === "tool_call" &&
              e.item.id === "bg-1" &&
              e.item.status === "running",
          ),
        { label: "bg-1 running" },
      );
      assert.equal(
        events.some(
          (e) =>
            e.type === "session.turn" && e.turnId === "acp:bg-turn" && e.state === "completed",
        ),
        false,
      );
      await waitFor(
        () =>
          events.find(
            (e) =>
              e.type === "session.turn" && e.turnId === "acp:bg-turn" && e.state === "completed",
          ),
        { label: "bg-turn completed" },
      );
      assert.ok(
        events.some(
          (e) =>
            e.type === "timeline.item" &&
            e.item.type === "assistant_message" &&
            e.item.text === "Build finished.",
        ),
      );
      // Verify no internal __attempt_* turn IDs ever leaked to the host.
      assert.equal(
        events.some(
          (e) => e.type === "session.turn" && e.turnId.startsWith("acp:__attempt_"),
        ),
        false,
      );
    } finally {
      await connection.close();
    }
  });

  it("emits an info notice when a turn finishes foreground tools without a final message", async () => {
    const { directory, launch } = await launchStubAgent(
      tracker,
      `
        const { createInterface } = require("node:readline");
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          const update = (u) => send({ method: "session/update", params: { sessionId: params.sessionId ?? "agy-session", update: u } });
          if (method === "initialize") send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
          if (method === "session/new") {
            send({ id, result: { sessionId: "agy-session", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          }
          if (method === "session/prompt") {
            update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read /a.txt", name: "read_file", kind: "read", status: "completed", locations: [{ path: "/a.txt" }], rawInput: { Path: "/a.txt" } });
            send({ id, result: { stopReason: "end_turn" } });
          }
          if (method === "session/close") send({ id, result: {} });
        });
      `,
    );

    const connection = await createAntigravityResilientProvider().connect({
      launch,
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "session.open",
        requestId: "open",
        sessionId: "test",
        history: "skip",
        config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: false },
      });
      await waitFor(() => events.find((e) => e.type === "session.ready"), { label: "ready" });

      await connection.send({
        type: "session.prompt",
        sessionId: "test",
        prompt: {
          clientMessageId: "tool-only",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "read a.txt" }] },
        },
      });
      await waitFor(
        () =>
          events.find(
            (e) => e.type === "session.turn" && e.turnId === "acp:tool-only" && e.state === "completed",
          ),
        { label: "tool-only completed" },
      );
      assert.ok(
        events.some(
          (e) =>
            e.type === "session.notice" &&
            e.notice.title === "Turn finished without a final message",
        ),
      );
    } finally {
      await connection.close();
    }
  });
});
