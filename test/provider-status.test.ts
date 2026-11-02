import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { antigravityResilientProvider } from "../server/provider.ts";
import { getCatalog } from "../server/internal/catalog.ts";

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

test("model discovery retries the CLI's internal timeout once, without inventing a catalog", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-agy-models-"));
  try {
    const script = path.join(directory, "models.cjs");
    writeFileSync(script, `
      const fs = require('node:fs');
      const [counter, mode] = process.argv.slice(2);
      const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
      fs.writeFileSync(counter, String(count));
      if (count === 1 || mode === 'persistent') {
        process.stderr.write('Fetching available models...\\nError: timed out waiting for available models\\n');
        process.exitCode = 1;
      } else {
        process.stdout.write('gemini-example\\tExample model\\n');
      }
    `);
    const recovered = path.join(directory, "recovered.txt");
    const catalog = await getCatalog(undefined, process.argv[0], [script, recovered, "recover"], {}, { retryDelayMs: 0 });
    assert.equal(readFileSync(recovered, "utf8"), "2");
    assert.equal(catalog.models[0].id, "gemini-example");

    const persistent = path.join(directory, "persistent.txt");
    await assert.rejects(
      getCatalog(undefined, process.argv[0], [script, persistent, "persistent"], {}, { retryDelayMs: 0 }),
      /timed out waiting for available models/,
    );
    assert.equal(readFileSync(persistent, "utf8"), "2");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
