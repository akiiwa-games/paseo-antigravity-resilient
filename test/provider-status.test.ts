import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { antigravityResilientProvider } from "../server/provider.ts";

test("status probes a real process and accepts only readable CLI versions at least 1.1.15", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-agy-version-"));
  try {
    for (const [version, available] of [["1.1.14", false], ["1.1.15", true], ["1.4.12", true], ["0.9.99", false], ["banner\n1.4.12", false]] as const) {
      const script = path.join(directory, "version.cjs");
      writeFileSync(script, `process.stdout.write(${JSON.stringify(version)});`);
      const status = await antigravityResilientProvider.status!({ launch: { command: process.argv[0], args: [script], env: {} } });
      assert.equal(status.available, available, `Version: ${version}`);
      if (!status.available) assert.match(status.diagnostic, /1\.1\.15/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
