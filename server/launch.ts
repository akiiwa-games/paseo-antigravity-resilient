import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type {
  ProviderInstallationLaunch,
  ProviderLaunch,
} from "@getpaseo/plugin/server/provider";
import { isRecord } from "./legacy.ts";
import {
  formatDiagnostic,
  isGenericSdkTransportError,
  ProviderActionError,
  sanitizeDiagnosticText,
} from "./recovery.ts";

/**
 * agy 1.5.14 introduced per-model `thought_level` options and SSH sign-in
 * separation; agy 1.5.15 fixed `session/load` so full conversation history
 * finishes replaying before the `session/load` response returns.
 */
export const MIN_AGY_VERSION = "1.5.15";

const TRANSIENT_LAUNCH_CODES = new Set([
  "UNKNOWN",
  "EBUSY",
  "EPERM",
  "EACCES",
  "ETXTBSY",
  "EAGAIN",
  "ENOENT",
]);

export const LAUNCH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
export const LAUNCH_RATE_WINDOW_MS = 60_000;
export const MAX_SESSION_LAUNCHES_PER_WINDOW = 6;
export const MAX_PROCESS_LAUNCHES_PER_WINDOW = 30;
const MAX_STDERR_LINES = 64;
const MAX_WIRE_FRAME_BYTES = 16 * 1024 * 1024;

export type LaunchRateLimit = {
  windowMs: number;
  perSession: number;
  perProcess: number;
};

export type SpawnProcessLike = (
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: "pipe" },
) => ChildProcess & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
};

export function parseSemver(text: string): [number, number, number] | null {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(text);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  return [major, minor, patch];
}

export function extractVersionString(text: string): string | undefined {
  const firstLine = text.trim().split(/\r?\n/)[0]?.trim();
  return /\b\d+\.\d+\.\d+\S*/.exec(text)?.[0] ?? (firstLine || undefined);
}

export function compareSemver(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i]! !== minimum[i]!) return actual[i]! - minimum[i]!;
  }
  return 0;
}

export function isSupportedAgyVersion(versionText: string, minVersion = MIN_AGY_VERSION): boolean {
  const actual = parseSemver(versionText);
  const minimum = parseSemver(minVersion);
  if (!actual || !minimum) return false;
  return compareSemver(actual, minimum) >= 0;
}

export function unsupportedVersionMessage(version: string): string {
  return `Antigravity ${version} is unsupported. Update agy to ${MIN_AGY_VERSION} or later.`;
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\") || path.isAbsolute(command);
}

function normalizeWinPath(candidate: string): string {
  return candidate.replaceAll("/", "\\").toLowerCase();
}

const registeredWindowsFallbacks = new Set<string>();

export function resolveCommandOnPath(
  command: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  if (hasPathSeparator(command)) return exists(command) ? command : null;
  const pathRaw = env.PATH ?? env.Path ?? "";
  if (!pathRaw) return null;
  const dirs = pathRaw.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const exts =
    platform === "win32"
      ? path.extname(command)
        ? [""]
        : [".exe", ".cmd", ".bat", ""]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function isCommandOnPath(
  command: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = existsSync,
): boolean {
  return resolveCommandOnPath(command, env, platform, exists) !== null;
}

export function findWindowsLocalAppDataAgy(
  env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (candidate: string) => boolean = existsSync,
  home?: string,
): string | null {
  const localAppData =
    env.LOCALAPPDATA?.trim() || (home ? path.join(home, "AppData", "Local") : "");
  if (!localAppData) return null;
  const candidate = path.join(localAppData, "agy", "bin", "agy.exe");
  return exists(candidate) ? candidate : null;
}

/**
 * Resolves the default executable advertised in `provider.command`.
 * When `agy` is already on PATH, keep `"agy"` so per-provider `env.PATH`
 * overrides continue to win. On Windows daemons whose service PATH omits
 * `%LOCALAPPDATA%\agy\bin`, fall back to the installed `agy.exe` path so the
 * daemon's pre-connect executable check succeeds without editing config.json.
 */
export function resolveDefaultAgyExecutable(options?: {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
  home?: string;
}): string {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const exists = options?.exists ?? existsSync;
  if (isCommandOnPath("agy", env, platform, exists)) {
    return "agy";
  }
  if (platform === "win32") {
    const home =
      options?.home ??
      (options?.env ? (env.USERPROFILE ?? env.HOME) : homedir());
    const fallback = findWindowsLocalAppDataAgy(env, exists, home);
    if (fallback) {
      registeredWindowsFallbacks.add(normalizeWinPath(fallback));
      return fallback;
    }
  }
  return "agy";
}

export function defaultAgyCommand(options?: {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
  home?: string;
}): [string, ...string[]] {
  return [resolveDefaultAgyExecutable(options), "acp", "--disable-telemetry"];
}

export function resolveEffectiveLaunch(
  launch: ProviderLaunch | undefined,
  options?: {
    envOverride?: Readonly<Record<string, string>>;
    processEnv?: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
    exists?: (candidate: string) => boolean;
    home?: string;
  },
): ProviderLaunch {
  const processEnv = options?.processEnv ?? process.env;
  const platform = options?.platform ?? process.platform;
  const exists = options?.exists ?? existsSync;
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(launch?.env ?? processEnv)) {
    if (typeof v === "string") baseEnv[k] = v;
  }
  const mergedEnv = options?.envOverride ? { ...baseEnv, ...options.envOverride } : baseEnv;
  let command = launch?.command ?? "agy";
  const args = launch?.args ? [...launch.args] : ["acp", "--disable-telemetry"];

  if (platform === "win32") {
    const effectiveHome =
      options?.home ??
      (launch ? (mergedEnv.USERPROFILE ?? mergedEnv.HOME) : homedir());
    const processHome = options?.home ?? processEnv.USERPROFILE ?? processEnv.HOME ?? homedir();
    const processFallback = findWindowsLocalAppDataAgy(processEnv, exists, processHome);
    const isRegistrationFallback =
      registeredWindowsFallbacks.has(normalizeWinPath(command)) ||
      (processFallback !== null && normalizeWinPath(command) === normalizeWinPath(processFallback));

    if (command === "agy" || command === "agy.exe") {
      if (!isCommandOnPath(command, mergedEnv, platform, exists)) {
        const winFallback = findWindowsLocalAppDataAgy(mergedEnv, exists, effectiveHome);
        if (winFallback) command = winFallback;
      }
    } else if (isRegistrationFallback) {
      // Honor custom `env.PATH` or `env.LOCALAPPDATA` configured in ~/.paseo/config.json
      // when `launch.command` came from the registration-time LocalAppData fallback.
      const fromCustomPath = resolveCommandOnPath("agy", mergedEnv, platform, exists);
      if (fromCustomPath) {
        command = fromCustomPath;
      } else {
        const fromCustomLocalAppData = findWindowsLocalAppDataAgy(mergedEnv, exists, effectiveHome);
        if (fromCustomLocalAppData) command = fromCustomLocalAppData;
      }
    }
  }

  return { command, args, env: mergedEnv };
}

export function resolveCommandFingerprint(
  command: string,
  env?: Readonly<Record<string, string>>,
): string {
  const candidates: string[] = [];
  if (hasPathSeparator(command)) {
    candidates.push(command);
  } else {
    const pathEnv = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? "";
    const dirs = pathEnv.split(path.delimiter).filter(Boolean);
    const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
    for (const dir of dirs) {
      for (const ext of exts) {
        candidates.push(path.join(dir, `${command}${ext}`));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) {
        return `${candidate}:${Math.trunc(stat.mtimeMs)}:${stat.size}`;
      }
    } catch {
      // Continue searching candidates.
    }
  }
  return command;
}

export function isTransientLaunchError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as NodeJS.ErrnoException;
  const code = typeof err.code === "string" ? err.code : "";
  const message = String(err.message ?? "");
  const isSpawn =
    (typeof err.syscall === "string" && err.syscall.startsWith("spawn")) ||
    /^spawn\b/i.test(message);
  return isSpawn && TRANSIENT_LAUNCH_CODES.has(code);
}

export async function withLaunchRetry<T>(
  attempt: () => Promise<T>,
  retryable: (error: unknown) => boolean = isTransientLaunchError,
  delaysMs: readonly number[] = LAUNCH_RETRY_DELAYS_MS,
  shouldStop: () => boolean = () => false,
): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (i >= delaysMs.length || shouldStop() || !retryable(error)) throw error;
      const delay = delaysMs[i]!;
      console.warn(
        `[antigravity-resilient] Antigravity CLI launch failed (${sanitizeDiagnosticText(
          error instanceof Error ? error.message : String(error),
        )}); retrying in ${delay}ms`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function readAgyVersion(
  launch: ProviderLaunch | ProviderInstallationLaunch,
  signal?: AbortSignal,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  const acpIndex = launch.args.indexOf("acp");
  const prefix = acpIndex === -1 ? launch.args : launch.args.slice(0, acpIndex);
  const { stdout } = await execCommand(launch.command, [...prefix, "--version"], {
    env: launch.env,
    timeout: timeoutMs,
    maxBuffer: 8192,
    signal,
  });
  return extractVersionString(stdout);
}

const sharedProcessLaunchTimes: number[] = [];

function pruneBefore(times: number[], cutoff: number): void {
  while (times.length > 0 && (times[0] ?? 0) <= cutoff) {
    times.shift();
  }
}

export class LaunchRateGuard {
  private readonly sessionTimes = new Map<string, number[]>();
  private readonly processTimes: number[];
  private readonly limit: LaunchRateLimit;
  private readonly now: () => number;

  constructor(options?: {
    limit?: Partial<LaunchRateLimit>;
    isolatedProcessCounter?: boolean;
    now?: () => number;
  }) {
    this.limit = {
      windowMs: options?.limit?.windowMs ?? LAUNCH_RATE_WINDOW_MS,
      perSession: options?.limit?.perSession ?? MAX_SESSION_LAUNCHES_PER_WINDOW,
      perProcess: options?.limit?.perProcess ?? MAX_PROCESS_LAUNCHES_PER_WINDOW,
    };
    this.processTimes = options?.isolatedProcessCounter ? [] : sharedProcessLaunchTimes;
    this.now = options?.now ?? Date.now;
  }

  recordLaunch(sessionKey: string | undefined, reason: string): void {
    const now = this.now();
    const cutoff = now - this.limit.windowMs;
    pruneBefore(this.processTimes, cutoff);

    let sessionBucket: number[] | undefined;
    if (sessionKey) {
      sessionBucket = this.sessionTimes.get(sessionKey);
      if (!sessionBucket) {
        sessionBucket = [];
        this.sessionTimes.set(sessionKey, sessionBucket);
      }
      pruneBefore(sessionBucket, cutoff);
    }

    const exceededScope =
      sessionBucket && sessionBucket.length >= this.limit.perSession
        ? `${sessionBucket.length} times for this session`
        : this.processTimes.length >= this.limit.perProcess
          ? `${this.processTimes.length} times across all sessions`
          : null;

    if (exceededScope) {
      const seconds = Math.round(this.limit.windowMs / 1_000);
      const message = `Antigravity CLI was launched ${exceededScope} in the last ${seconds} seconds; refusing to launch it again for ${reason}. Wait a minute and resend.`;
      throw new ProviderActionError("LAUNCH_RATE_LIMITED", message);
    }

    sessionBucket?.push(now);
    this.processTimes.push(now);
  }

  clearSession(sessionKey: string): void {
    this.sessionTimes.delete(sessionKey);
  }
}

export interface OwnedAcpChild {
  readonly stream: AcpStream;
  readonly pid: number | undefined;
  readonly closed: Promise<void>;
  readonly exitInfo: () => { code: number | null; signal: NodeJS.Signals | null } | null;
  readonly stderrTail: () => readonly string[];
  readonly detectedVersion: () => string | null;
  readonly lastRpcError: () => { code: number; message: string; data?: unknown } | null;
  describeFailure(fallback?: string): string;
  close(options?: { force?: boolean }): Promise<void>;
}

function isSignInStdoutPrompt(line: string): boolean {
  return (
    /^open the following link to authenticate/i.test(line) ||
    /^https:\/\/accounts\.google\.com\//i.test(line) ||
    /\bplease sign in\b/i.test(line)
  );
}

async function spawnChildOnce(
  spawnFn: SpawnProcessLike,
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string>,
): Promise<
  ChildProcess & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
  }
> {
  const child = spawnFn(command, args, {
    cwd,
    env,
    stdio: "pipe",
  });
  if (child.pid !== undefined) return child;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  return child;
}

export async function spawnAcpChildStream(input: {
  launch: ProviderLaunch;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  spawn?: SpawnProcessLike;
  retryDelaysMs?: readonly number[];
  minAgyVersion?: string;
  shouldStopRetry?: () => boolean;
}): Promise<OwnedAcpChild> {
  const spawnFn = input.spawn ?? (spawnProcess as SpawnProcessLike);
  const mergedEnv: Record<string, string> = {
    ...input.launch.env,
    ...(input.env ?? {}),
  };
  const child = await withLaunchRetry(
    () => spawnChildOnce(spawnFn, input.launch.command, [...input.launch.args], input.cwd, mergedEnv),
    isTransientLaunchError,
    input.retryDelaysMs ?? LAUNCH_RETRY_DELAYS_MS,
    input.shouldStopRetry,
  );

  const stderrLines: string[] = [];
  let activeStderrBookmark = 0;
  let outgoingRequestCount = 0;
  let exitState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let spawnErr: Error | null = null;
  let protocolFailure: string | null = null;
  let agentVersion: string | null = null;
  let recentRpcError: { code: number; message: string; data?: unknown } | null = null;
  const pendingRequests = new Map<string | number, string>();

  let resolveExit!: () => void;
  const exitObserved = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  let streamClosed = false;
  let closePromise: Promise<void> | null = null;
  let controller: ReadableStreamDefaultController<AcpStreamMessage> | null = null;
  const decoder = new StringDecoder("utf8");
  let stdoutBuffer = "";

  const pushStderr = (chunk: string) => {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      stderrLines.push(sanitizeDiagnosticText(trimmed));
      if (stderrLines.length > MAX_STDERR_LINES) {
        stderrLines.shift();
        activeStderrBookmark = Math.max(0, activeStderrBookmark - 1);
      }
    }
  };

  child.stderr.on("data", (chunk: Buffer | string) => {
    pushStderr(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });

  child.on("error", (error) => {
    spawnErr = error;
    if (!streamClosed) {
      streamClosed = true;
      try {
        controller?.error(error);
      } catch {
        // Ignore if stream already cancelled.
      }
    }
  });

  child.stdin.on("error", () => {
    // Handled via child exit / write rejection.
  });

  child.once("close", (code, signal) => {
    exitState = { code, signal };
    resolveExit();
  });

  const minVersion = input.minAgyVersion ?? MIN_AGY_VERSION;

  const inspectIncomingFrame = (frame: AcpStreamMessage): string | null => {
    const raw = frame as Record<string, unknown>;
    const id = typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : null;
    const reqMethod = id !== null ? pendingRequests.get(id) : undefined;
    if (id !== null && !("method" in raw)) {
      pendingRequests.delete(id);
      if ("result" in raw) {
        recentRpcError = null;
      }
    }

    if ("error" in raw && isRecord(raw.error)) {
      const code = typeof raw.error.code === "number" ? raw.error.code : -32603;
      const message = sanitizeDiagnosticText(String(raw.error.message ?? "ACP error"));
      recentRpcError = {
        code,
        message,
        ...(raw.error.data !== undefined ? { data: raw.error.data } : {}),
      };
    }

    if (reqMethod === "initialize" && "result" in raw && isRecord(raw.result)) {
      const agentInfo = isRecord(raw.result.agentInfo) ? raw.result.agentInfo : null;
      if (agentInfo && typeof agentInfo.version === "string" && agentInfo.version.trim()) {
        agentVersion = agentInfo.version.trim();
        if (parseSemver(agentVersion) && !isSupportedAgyVersion(agentVersion, minVersion)) {
          return unsupportedVersionMessage(agentVersion);
        }
      }
    }

    if (
      "method" in raw &&
      raw.method === "session/request_permission" &&
      isRecord(raw.params) &&
      isRecord(raw.params.toolCall) &&
      raw.params.toolCall.rawInput === undefined
    ) {
      raw.params.toolCall.rawInput = null;
    }

    return null;
  };

  const processLine = (rawLine: string): boolean => {
    const trimmed = rawLine.trim();
    if (!trimmed) return true;
    if (isSignInStdoutPrompt(trimmed)) {
      protocolFailure = "Antigravity authentication required. Run `agy` and sign in, then retry.";
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Ignore stray non-JSON banner lines unless they indicate auth failure;
      // record sanitized line in stderr context in case ACP never initializes.
      pushStderr(trimmed);
      return true;
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
      pushStderr(trimmed);
      return true;
    }
    const frame = parsed as AcpStreamMessage;
    const fatal = inspectIncomingFrame(frame);
    if (fatal) {
      protocolFailure = fatal;
      return false;
    }
    if (!streamClosed) {
      controller?.enqueue(frame);
    }
    return true;
  };

  const drainBuffer = (): boolean => {
    let newlineIdx: number;
    while ((newlineIdx = stdoutBuffer.indexOf("\n")) >= 0) {
      if (newlineIdx > MAX_WIRE_FRAME_BYTES) {
        protocolFailure = "Antigravity ACP message exceeded maximum frame size";
        return false;
      }
      const line = stdoutBuffer.slice(0, newlineIdx);
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (!processLine(line)) return false;
    }
    if (stdoutBuffer.length > MAX_WIRE_FRAME_BYTES) {
      protocolFailure = "Antigravity ACP message exceeded maximum frame size";
      return false;
    }
    return true;
  };

  const closeTree = async (options?: { force?: boolean }): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (!streamClosed) {
        streamClosed = true;
        try {
          controller?.close();
        } catch {
          // Already closed or errored.
        }
      }
      if (process.platform !== "win32") {
        try {
          child.stdin.end();
        } catch {
          // Ignore closed pipe.
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        if (options?.force || process.platform === "win32") {
          await terminateProcess(child, "SIGKILL").catch(() => undefined);
        } else {
          await terminateProcess(child, "SIGTERM").catch(() => undefined);
          const graceful = await Promise.race([
            exitObserved.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 400)),
          ]);
          if (!graceful && child.exitCode === null && child.signalCode === null) {
            await terminateProcess(child, "SIGKILL").catch(() => undefined);
          }
        }
        await Promise.race([
          exitObserved,
          new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
        ]);
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    })();
    return closePromise;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (streamClosed) return;
    stdoutBuffer += decoder.write(chunk);
    if (!drainBuffer()) {
      const err = new Error(protocolFailure ?? "Antigravity ACP stream failed");
      streamClosed = true;
      try {
        controller?.error(err);
      } catch {
        // Ignore if cancelled.
      }
      void closeTree({ force: true });
    }
  });

  child.stdout.once("end", () => {
    void (async () => {
      if (streamClosed) return;
      stdoutBuffer += decoder.end();
      const ok = drainBuffer() && (!stdoutBuffer.trim() || processLine(stdoutBuffer));
      stdoutBuffer = "";
      if (!ok) {
        const err = new Error(protocolFailure ?? "Antigravity ACP stream failed");
        streamClosed = true;
        try {
          controller?.error(err);
        } catch {
          // Ignore.
        }
        await closeTree({ force: true });
        return;
      }
      // Wait briefly for `close` event so exit code / signal are recorded before
      // downstream `connection.closed` observes EOF.
      await Promise.race([
        exitObserved,
        new Promise<void>((resolve) => setTimeout(resolve, 80)),
      ]);
      if (!streamClosed) {
        streamClosed = true;
        try {
          controller?.close();
        } catch {
          // Ignore.
        }
      }
    })();
  });

  const describeFailure = (fallback?: string): string => {
    if (protocolFailure) return protocolFailure;
    if (spawnErr) return formatDiagnostic(spawnErr.message);

    const fallbackClean = fallback ? sanitizeDiagnosticText(fallback.trim()) : "";
    if (fallbackClean && !isGenericSdkTransportError(fallbackClean)) {
      return formatDiagnostic(fallbackClean);
    }

    const processDiedWithPendingRpc = exitState !== null && pendingRequests.size > 0;
    if (recentRpcError && !processDiedWithPendingRpc && exitState === null) {
      const dataText =
        typeof recentRpcError.data === "string"
          ? recentRpcError.data
          : isRecord(recentRpcError.data) && typeof recentRpcError.data.details === "string"
            ? recentRpcError.data.details
            : "";
      const combined = [recentRpcError.message, dataText].filter(Boolean).join(": ");
      return formatDiagnostic(combined);
    }

    const tail = stderrLines.slice(activeStderrBookmark).slice(-6).join("\n").trim();
    const exitDetail = exitState
      ? exitState.signal
        ? `signal ${exitState.signal}`
        : exitState.code !== null
          ? `exit code ${exitState.code}`
          : "unknown exit"
      : null;

    if (tail && exitDetail) {
      return formatDiagnostic(`Antigravity CLI exited (${exitDetail}): ${tail}`);
    }
    if (tail) {
      return formatDiagnostic(tail);
    }
    if (exitDetail) {
      return `Antigravity CLI exited unexpectedly (${exitDetail})`;
    }
    if (recentRpcError) {
      const dataText =
        typeof recentRpcError.data === "string"
          ? recentRpcError.data
          : isRecord(recentRpcError.data) && typeof recentRpcError.data.details === "string"
            ? recentRpcError.data.details
            : "";
      const combined = [recentRpcError.message, dataText].filter(Boolean).join(": ");
      return formatDiagnostic(combined);
    }
    return fallbackClean ? formatDiagnostic(fallbackClean) : "Antigravity ACP connection closed unexpectedly";
  };

  const stream: AcpStream = {
    readable: new ReadableStream<AcpStreamMessage>({
      start(c) {
        controller = c;
      },
      cancel() {
        return closeTree();
      },
    }),
    writable: new WritableStream<AcpStreamMessage>({
      write(message) {
        if (streamClosed || !child.stdin.writable || child.stdin.destroyed) {
          return Promise.reject(new Error(describeFailure("Antigravity CLI stdin is closed")));
        }
        const raw = message as Record<string, unknown>;
        if (
          typeof raw.method === "string" &&
          (typeof raw.id === "string" || typeof raw.id === "number")
        ) {
          outgoingRequestCount += 1;
          pendingRequests.set(raw.id, raw.method);
          recentRpcError = null;
          if (outgoingRequestCount > 1) {
            activeStderrBookmark = stderrLines.length;
          }
        }
        return new Promise<void>((resolve, reject) => {
          child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
            if (error) reject(new Error(describeFailure(error.message)));
            else resolve();
          });
        });
      },
      close() {
        return closeTree();
      },
      abort() {
        return closeTree({ force: true });
      },
    }),
  };

  return {
    stream,
    pid: child.pid,
    closed: exitObserved,
    exitInfo: () => exitState,
    stderrTail: () => stderrLines,
    detectedVersion: () => agentVersion,
    lastRpcError: () => recentRpcError,
    describeFailure,
    close: closeTree,
  };
}
