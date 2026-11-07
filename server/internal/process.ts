import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  combineAbortSignals,
  createAbortError,
  isAbortError,
  ProviderActionError,
} from "./signals.ts";

/**
 * agy's updater renames the running `agy.EXE` aside and writes the new one in
 * place. A launch that lands in that window fails with UNKNOWN/EBUSY/EPERM/
 * EACCES (file locked mid-write) or ENOENT (not written yet); it succeeds a
 * few seconds later, so these are retried rather than reported.
 */
const TRANSIENT_LAUNCH_CODES = new Set(["UNKNOWN", "EBUSY", "EPERM", "EACCES", "ETXTBSY", "EAGAIN", "ENOENT"]);
export const LAUNCH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

export function isTransientLaunchError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException | null;
  if (!err || typeof err !== "object") return false;
  const code = typeof err.code === "string" ? err.code : "";
  const launch = (typeof err.syscall === "string" && err.syscall.startsWith("spawn")) ||
    /^spawn\b/.test(String(err.message ?? ""));
  return launch && TRANSIENT_LAUNCH_CODES.has(code);
}

/** Runs `attempt` again after each delay while it fails with `retryable`. */
export async function withLaunchRetry<T>(
  attempt: () => Promise<T>,
  retryable: (error: unknown) => boolean,
  delaysMs: readonly number[] = LAUNCH_RETRY_DELAYS_MS,
  shouldStop: () => boolean = () => false,
): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (i >= delaysMs.length || shouldStop() || !retryable(error)) throw error;
      console.warn(
        `[antigravity-resilient] Antigravity CLI launch failed (${(error as Error)?.message ?? error}); retrying in ${delaysMs[i]}ms`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delaysMs[i]));
    }
  }
}

export type DriverProcess = {
  /**
   * Null when the OS process already exists. Otherwise the launch failed and
   * this rejects with the queued error; listeners must attach synchronously
   * on success, so callers only await it in that case.
   */
  spawned: Promise<void> | null;
  onClose: (
    listener: (code: number | null, signal: string | null) => void,
  ) => void;
  onError: (listener: (error: Error) => void) => void;
  onStderrLine: (listener: (line: string) => void) => void;
  onStdoutLine: (listener: (line: string) => void) => void;
  sendLine: (line: string) => Promise<void>;
  stop: () => Promise<void>;
};

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
};

export async function probe(
  command: string,
  args: string[],
  env?: Record<string, string>,
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<{
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut?: boolean;
}> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort();
  }, timeoutMs);
  const combinedSignal = signal
    ? combineAbortSignals([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const result = await execCommand(command, args, {
      env,
      signal: combinedSignal,
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (timeoutController.signal.aborted && isAbortError(error)) {
      return {
        exitCode: null,
        stdout: "",
        stderr: `Command timed out after ${timeoutMs}ms`,
        timedOut: true,
      };
    }
    const err = error as NodeJS.ErrnoException & {
      code?: number | string;
      killed?: boolean;
      stderr?: string;
      stdout?: string;
    };
    if (err.code === "ENOENT") {
      throw new ProviderActionError(
        "BINARY_NOT_FOUND",
        `Antigravity CLI not found: ${command}`,
      );
    }
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function spawnDriver(input: {
  args: string[];
  command: string;
  cwd: string;
  env?: Record<string, string>;
  spawn?: SpawnFunction;
}): DriverProcess {
  const spawnImpl = input.spawn ?? spawnProcess;
  const child = spawnImpl(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let stdoutInterface: Interface | null = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  let stderrInterface: Interface | null = createInterface({
    input: child.stderr,
    crlfDelay: Infinity,
  });

  // Node assigns the pid synchronously on success; without one the launch
  // failed and an 'error' event is already queued.
  const spawned = child.pid !== undefined
    ? null
    : new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
  spawned?.catch(() => undefined);

  const closeInterfaces = () => {
    stdoutInterface?.close();
    stderrInterface?.close();
    stdoutInterface = null;
    stderrInterface = null;
  };
  child.once("close", closeInterfaces);

  const stopTree = async (signal: "SIGTERM" | "SIGKILL") => {
    if (process.platform === "win32") return terminateProcess(child, signal);
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      // The leader may already be gone. Its dedicated group has also exited.
    }
  };

  return {
    spawned,
    sendLine(line) {
      return new Promise((resolve, reject) => {
        if (!child.stdin.writable || child.stdin.destroyed) {
          reject(new Error("Antigravity CLI stdin is closed"));
          return;
        }
        child.stdin.write(`${line}\n`, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    onStdoutLine(listener) {
      stdoutInterface?.on("line", listener);
    },
    onStderrLine(listener) {
      stderrInterface?.on("line", listener);
    },
    onError(listener) {
      child.on("error", listener);
      child.stdin.on("error", listener);
    },
    onClose(listener) {
      child.on("close", listener);
    },
    async stop() {
      closeInterfaces();
      if (child.exitCode !== null || child.signalCode !== null) {
        if (process.platform !== "win32") await stopTree("SIGKILL");
        return;
      }
      // On Windows taskkill must see the live leader to find descendants.
      // Closing stdin first can let agy exit and orphan its running command.
      if (process.platform !== "win32") child.stdin.end();
      await new Promise<void>((resolve) => {
        let killTimer: ReturnType<typeof setTimeout> | null = null;
        let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
        const done = () => {
          if (killTimer !== null) {
            clearTimeout(killTimer);
          }
          if (giveUpTimer !== null) {
            clearTimeout(giveUpTimer);
          }
          child.off("close", done);
          resolve();
        };
        child.once("close", done);
        killTimer = setTimeout(() => {
          void stopTree("SIGKILL").catch(() => undefined);
        }, 1_500);
        giveUpTimer = setTimeout(done, 7_000);
        if (process.platform === "win32") {
          void stopTree("SIGTERM").catch(() => undefined);
        } else {
          try {
            void stopTree("SIGTERM").catch(done);
          } catch {
            done();
          }
        }
      });
      if (process.platform !== "win32") await stopTree("SIGKILL");
    },
  };
}
