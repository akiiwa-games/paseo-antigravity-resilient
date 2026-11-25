import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

export class TempDirTracker {
  private readonly dirs: string[] = [];

  async make(prefix = "paseo-agy-resilient-test-"): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    this.dirs.push(dir);
    return dir;
  }

  async cleanup(): Promise<void> {
    const pending = this.dirs.splice(0);
    await Promise.all(
      pending.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
    );
  }
}

export async function launchStubAgent(
  tracker: TempDirTracker,
  source: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<{ directory: string; executable: string; capturePath: string; launch: ProviderLaunch }> {
  const directory = await tracker.make();
  const executable = path.join(directory, "agy.cjs");
  const capturePath = path.join(directory, "requests.ndjson");
  await writeFile(executable, source, "utf8");
  return {
    directory,
    executable,
    capturePath,
    launch: {
      command: process.execPath,
      args: [executable, "acp", "--disable-telemetry"],
      env: {
        CAPTURE: capturePath,
        ...extraEnv,
      },
    },
  };
}

export async function waitFor<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  options?: { timeoutMs?: number; intervalMs?: number; label?: string },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 4_000;
  const intervalMs = options?.intervalMs ?? 15;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new assert.AssertionError({
    message: `Timed out after ${timeoutMs}ms waiting for ${options?.label ?? "condition"}`,
  });
}
