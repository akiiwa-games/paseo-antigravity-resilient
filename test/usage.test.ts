import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { PROVIDER_ID, Usage, USAGE_SOURCE_ID } from "../server/usage.ts";
import { TempDirTracker } from "./helpers.ts";

const tracker = new TempDirTracker();

afterEach(async () => {
  await tracker.cleanup();
});

describe("Usage CLI quota source", () => {
  it("deduplicates global discovery by default while discovering antigravity-resilient sessions and mapping CLI quota buckets", async () => {
    const directory = await tracker.make("paseo-agy-usage-");
    const cli = path.join(directory, "cli.cjs");
    await writeFile(
      cli,
      `
        if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['-p', '/usage', '--output-format', 'json'])) process.exit(2);
        console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
          {
            name: 'Gemini Models',
            description: 'Models within this group: Gemini 4 Carbon, Gemini 3.8 Flash',
            buckets: [
              { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.25, reset_time: '2026-11-19T14:25:08Z' },
              { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.7 },
              { id: 'disabled', name: 'Weekly', window: 'weekly', disabled: true, remaining_fraction: 1 }
            ]
          }
        ] } } }));
      `,
      "utf8",
    );

    const usage = new Usage();
    const launch = {
      command: process.execPath,
      args: [cli, "acp", "--disable-telemetry"],
      env: { HOME: directory },
    };
    const source = usage.registration();
    assert.equal(source.id, USAGE_SOURCE_ID);
    assert.equal(source.provider, PROVIDER_ID);

    // Default global discovery returns [] so built-in `antigravity-provider` is not duplicated.
    assert.deepEqual(await source.discover({ kind: "global", launch }), []);

    // Opt-in global discovery works when built-in provider is disabled.
    const optInGlobal = await source.discover({
      kind: "global",
      launch: {
        ...launch,
        env: { ...launch.env, PASEO_ANTIGRAVITY_RESILIENT_GLOBAL_USAGE: "1" },
      },
    });
    assert.equal(optInGlobal.length, 1);

    // Session discovery binds exclusively to `antigravity-resilient`.
    const sessionAccounts = await source.discover({
      kind: "session",
      provider: "antigravity-resilient",
      env: { HOME: directory },
      launch,
    });
    assert.equal(sessionAccounts.length, 1);
    assert.equal(sessionAccounts[0]?.provider, "antigravity-resilient");
    assert.equal(sessionAccounts[0]?.key, optInGlobal[0]?.key);

    assert.deepEqual(
      await source.discover({
        kind: "session",
        provider: "antigravity",
        env: { HOME: directory },
        launch,
      }),
      [],
    );
    assert.deepEqual(
      await source.discover({
        kind: "session",
        provider: "codex",
        env: { HOME: directory },
      }),
      [],
    );

    const otherLaunch = { ...launch, env: { HOME: `${directory}-other` } };
    const otherAccounts = await source.discover({
      kind: "session",
      provider: "antigravity-resilient",
      env: otherLaunch.env,
      launch: otherLaunch,
    });
    assert.notEqual(otherAccounts[0]?.key, sessionAccounts[0]?.key);
    assert.notDeepEqual(otherAccounts[0]?.input, sessionAccounts[0]?.input);

    const snapshot = await source.fetch(sessionAccounts[0]!.input);
    if (snapshot.status !== "available") {
      throw new Error("expected available snapshot");
    }
    assert.equal(snapshot.windows.length, 3);
    assert.deepEqual(snapshot.windows[0], {
      id: "gemini-5h",
      label: "Gemini · 5h",
      shortLabel: "5h",
      durationSeconds: 18_000,
      usedPct: 75,
      remainingPct: 25,
      resetsAt: "2026-11-19T14:25:08Z",
      tone: "warning",
    });
    assert.equal(snapshot.windows[1]?.id, "gemini-weekly");
    assert.equal(snapshot.windows[1]?.shortLabel, "wk");
    assert.equal(snapshot.windows[1]?.summary, true);
    assert.ok(Math.abs((snapshot.windows[1]?.usedPct ?? 0) - 30) < 0.01);
    assert.deepEqual(snapshot.windows[2], {
      id: "disabled",
      label: "Gemini · Weekly · Disabled",
      shortLabel: "wk",
      durationSeconds: 604_800,
      usedPct: null,
      remainingPct: null,
      resetsAt: null,
      tone: "default",
    });
    assert.deepEqual(snapshot.details, [
      {
        id: "group:0",
        label: "Gemini Models",
        value: "Gemini 4 Carbon, Gemini 3.8 Flash",
      },
    ]);
  });

  it("uses compact group and period shorthands when multiple groups are reported", async () => {
    const directory = await tracker.make("paseo-agy-usage-");
    const cli = path.join(directory, "cli.cjs");
    await writeFile(
      cli,
      `
        console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
          { name: 'Gemini Models', buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9 },
            { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.8 }
          ] },
          { name: 'Claude and GPT models', buckets: [
            { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1 }
          ] }
        ] } } }));
      `,
      "utf8",
    );
    const launch = { command: process.execPath, args: [cli, "acp"], env: { HOME: directory } };
    const source = new Usage({ allowGlobalDiscovery: true }).registration();
    const [account] = await source.discover({ kind: "global", launch });
    const snapshot = await source.fetch(account!.input);
    if (snapshot.status !== "available") {
      throw new Error("expected available");
    }
    assert.deepEqual(
      snapshot.windows.map((w) => ({ id: w.id, label: w.label, shortLabel: w.shortLabel })),
      [
        { id: "gemini-weekly", label: "Gemini · Weekly", shortLabel: "Gemini wk" },
        { id: "gemini-5h", label: "Gemini · 5h", shortLabel: "Gemini 5h" },
        { id: "3p-weekly", label: "Claude and GPT · Weekly", shortLabel: "Claude and GPT wk" },
      ],
    );
  });

  it("surfaces CLI errors and hides raw stderr on command failures", async () => {
    const directory = await tracker.make("paseo-agy-usage-");
    const errCli = path.join(directory, "err-cli.cjs");
    await writeFile(
      errCli,
      `console.log(JSON.stringify({ status: 'ERROR', error: 'Authentication required' }));`,
      "utf8",
    );
    const source = new Usage({ allowGlobalDiscovery: true }).registration();
    const [errAccount] = await source.discover({
      kind: "global",
      launch: { command: process.execPath, args: [errCli, "acp"], env: { HOME: directory } },
    });
    await assert.rejects(() => source.fetch(errAccount!.input), /Authentication required/);

    const crashCli = path.join(directory, "crash-cli.cjs");
    await writeFile(
      crashCli,
      `process.stderr.write('authentication token=private-secret'); process.exit(1);`,
      "utf8",
    );
    const [crashAccount] = await source.discover({
      kind: "global",
      launch: { command: process.execPath, args: [crashCli, "acp"], env: { HOME: `${directory}-2` } },
    });
    await assert.rejects(
      () => source.fetch(crashAccount!.input),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "Antigravity usage command failed or timed out. Check that agy is signed in." &&
        !err.message.includes("private-secret"),
    );
  });
});
