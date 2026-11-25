import type { ProviderError } from "@getpaseo/plugin/server/provider";

export class ProviderActionError extends Error {
  readonly code: string;
  readonly diagnostic?: string;

  constructor(code: string, message: string, diagnostic?: string) {
    super(message);
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

export const CONTINUE_INTERRUPTED_TURN_PROMPT =
  "Continue the interrupted turn from the current conversation state. Do not repeat completed text or tool actions.";

export const TOKEN_GAP_RETRY_DELAY_MS = 8_000;
export const STREAM_INTERRUPT_RETRY_DELAY_MS = 2_000;
export const PROCESS_EXIT_RETRY_DELAY_MS = 1_500;
export const MODEL_REJECTION_RETRY_DELAY_MS = 3_000;

export const MAX_TOKEN_GAP_RETRIES = 1;
export const MAX_STREAM_INTERRUPT_RETRIES = 1;
export const MAX_PROCESS_EXIT_RETRIES = 1;
export const MAX_MODEL_REJECTION_RETRIES = 1;
export const MAX_TOTAL_TURN_RECOVERIES = 2;

export interface RecoveryPolicyOptions {
  tokenGapRetryDelayMs?: number;
  streamInterruptRetryDelayMs?: number;
  processExitRetryDelayMs?: number;
  modelRejectionRetryDelayMs?: number;
  maxTokenGapRetries?: number;
  maxStreamInterruptRetries?: number;
  maxProcessExitRetries?: number;
  maxModelRejectionRetries?: number;
  maxTotalRecoveries?: number;
}

export interface TurnRetryCounts {
  tokenGap: number;
  streamInterrupt: number;
  processExit: number;
  modelRejection: number;
  total: number;
}

export function emptyRetryCounts(): TurnRetryCounts {
  return {
    tokenGap: 0,
    streamInterrupt: 0,
    processExit: 0,
    modelRejection: 0,
    total: 0,
  };
}

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/ya29\.[A-Za-z0-9._-]{16,}/g, "<REDACTED_OAUTH_TOKEN>")
    .replace(/1\/\/[A-Za-z0-9._-]{16,}/g, "<REDACTED_REFRESH_TOKEN>")
    .replace(/AIza[A-Za-z0-9._-]{16,}/g, "<REDACTED_API_KEY>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1<REDACTED_BEARER>")
    .replace(/(token=)[^\s&"']+/gi, "$1<REDACTED>")
    .replace(/https:\/\/accounts\.google\.com\/\S+/gi, "<REDACTED_AUTH_URL>");
}

export function isGenericSdkTransportError(message: string): boolean {
  const trimmed = message.trim();
  return (
    /^ACP transport closed unexpectedly$/i.test(trimmed) ||
    /^ACP transport is closed$/i.test(trimmed) ||
    /^ACP connection closed(?:\s+unexpectedly)?$/i.test(trimmed) ||
    /^ACP session is closed$/i.test(trimmed) ||
    /^Connection closed$/i.test(trimmed) ||
    /^ACP turn failed$/i.test(trimmed) ||
    /^ACP process exited\s*\([^)]*\)$/i.test(trimmed)
  );
}

/**
 * Matches genuine missing/revoked login errors where retrying without user
 * sign-in cannot succeed. Deliberately narrow so substrings like `author` or
 * `authority` never match.
 */
export function isPermanentAuthError(message: string): boolean {
  return (
    /you are not logged in/i.test(message) ||
    /please sign in/i.test(message) ||
    /open the following link to authenticate/i.test(message) ||
    /\bauthentication required\b/i.test(message) ||
    /\blogin required\b/i.test(message) ||
    /couldn't sign in/i.test(message) ||
    /expired or revoked/i.test(message) ||
    /\binvalid_grant\b/i.test(message)
  );
}

/**
 * Matches transient OAuth 401 refresh-race and token-endpoint failures.
 */
export function isTokenGap(message: string): boolean {
  if (isPermanentAuthError(message)) return false;
  return (
    /\bunauthenticated\b/i.test(message) ||
    /\bcode\s*401\b/i.test(message) ||
    /invalid authentication credentials/i.test(message) ||
    /expected oauth 2 access token/i.test(message) ||
    /oauth2:\s*cannot fetch token/i.test(message) ||
    /oauth2\.googleapis\.com\/token/i.test(message)
  );
}

/**
 * Matches quota exhaustion and hard rate-limit rejections, which must fail
 * immediately with the real cause instead of burning retries.
 */
export function isQuotaExhaustedError(message: string): boolean {
  return (
    /\bRESOURCE_EXHAUSTED\b/.test(message) ||
    /\bQUOTA_EXHAUSTED\b/.test(message) ||
    /exhausted your capacity/i.test(message) ||
    /\bquota exceeded\b/i.test(message) ||
    /\bno quota\b/i.test(message) ||
    /\b(?:code|status|HTTP)\s*429\b/i.test(message) ||
    /\brate[\s_-]?limit exceeded\b/i.test(message)
  );
}

/**
 * Matches transient stream/transport interruptions and backend 5xx/UNAVAILABLE
 * blips during an ACP turn or discovery call.
 */
export function isStreamInterruption(message: string): boolean {
  if (isQuotaExhaustedError(message) || isPermanentAuthError(message)) return false;
  return (
    /the stream was interrupted/i.test(message) ||
    /please continue the task you were working on/i.test(message) ||
    /the model backend had a brief,\s*transient interruption/i.test(message) ||
    /\brequest failed:\s*stream idle timeout\s*\([^\r\n)]+\):\s*context deadline exceeded\b/i.test(
      message,
    ) ||
    /\b(?:request failed:\s*Post\s+"[^"]*streamGenerateContent[^"]*":|streamGenerateContent[^\r\n]*:)\s*(?:[^\r\n]*\b(?:unexpected\s+EOF|EOF|wsarecv|wsasend|forcibly closed by the remote host|use of closed network connection|connection reset by peer|broken pipe|client connection lost|stream error)\b)/i.test(
      message,
    ) ||
    /\bAPI error\s*\(attempt\s+\d+\):\s*(?:request failed:[^\r\n]*\b(?:unexpected\s+EOF|EOF|wsarecv|wsasend|forcibly closed by the remote host|use of closed network connection|connection reset by peer|broken pipe|client connection lost)\b|incomplete envelope:\s*unexpected EOF|Error\s+(?:502|503|504)\b)/i.test(
      message,
    ) ||
    /\bUNAVAILABLE\b/.test(message) ||
    /\bINTERNAL\b/.test(message) ||
    /\b(?:code|Error|HTTP)\s*50[0234]\b/i.test(message) ||
    /TLS handshake timeout/i.test(message) ||
    /\b(?:ECONNRESET|ETIMEDOUT|EPIPE)\b/.test(message) ||
    /\bconnection reset by peer\b/i.test(message)
  );
}

export function isSessionNotFoundError(message: string): boolean {
  return /\bSession not found:\s*\S+/i.test(message);
}

/**
 * Parses explicit model rejections from both ACP (`Unknown model ID: ...`,
 * `Invalid model "..."`, `Thinking level "..." is not offered for model "..."`)
 * and legacy CLI format strings.
 */
export function parseModelRejection(
  text: string,
  configuredModel?: string,
): { model: string; available: string[] } | null {
  const acpUnknown = /\bUnknown model ID:\s*([^\s"']+)/i.exec(text);
  if (acpUnknown?.[1]) {
    return { model: acpUnknown[1].trim(), available: [] };
  }

  const acpInvalid = /\bInvalid model\s+"([^"]+)"(?:\s*\((?:available|valid choices):\s*([^)]+)\))?/i.exec(
    text,
  );
  if (acpInvalid?.[1]) {
    const available = acpInvalid[2]
      ? acpInvalid[2]
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    return { model: acpInvalid[1].trim(), available };
  }

  const badThinking = /Thinking level\s+"[^"]+"\s+is not offered for model\s+"([^"]+)"/i.exec(text);
  if (badThinking?.[1]) {
    return { model: configuredModel || badThinking[1].trim(), available: [] };
  }

  const legacy =
    /invalid model selection \(--model "([^"]*)"[^)]*\): model (\S+) is not recognized as a known model/u.exec(
      text,
    );
  if (legacy) {
    const available: string[] = [];
    const listStart = text.indexOf("Available models:", legacy.index);
    if (listStart >= 0) {
      const lines = text.slice(listStart).split(/\r?\n/u).slice(1);
      const indented = /^\s/u.test(lines[0] ?? "");
      for (const line of lines) {
        if (!line.trim() || (indented && !/^\s/u.test(line)) || /:\s*$/u.test(line)) break;
        available.push(line.trim());
      }
    }
    return { model: legacy[1] || legacy[2] || configuredModel || "unknown", available };
  }

  return null;
}

export function isModelLookupFailure(text: string): boolean {
  return (
    /\bNOT_FOUND \(code 404\)/u.test(text) ||
    /\bunknown model key \S+: model not found\b/u.test(text) ||
    /\bunknown model name \S+/u.test(text)
  );
}

export function isUnexpectedProcessExitError(
  message: string,
  processExited: boolean,
): boolean {
  if (
    isPermanentAuthError(message) ||
    isQuotaExhaustedError(message) ||
    isSessionNotFoundError(message) ||
    parseModelRejection(message) !== null
  ) {
    return false;
  }
  if (processExited) return true;
  return (
    /Antigravity CLI exited(?:\s+unexpectedly)?\s*\(/i.test(message) ||
    /ACP transport closed unexpectedly/i.test(message) ||
    /ACP connection closed/i.test(message) ||
    /Antigravity ACP connection closed unexpectedly/i.test(message) ||
    /Antigravity CLI stdin is closed/i.test(message)
  );
}

export function formatDiagnostic(rawMessage: string): string {
  const clean = sanitizeDiagnosticText(rawMessage.trim());
  if (isPermanentAuthError(clean)) {
    return `Antigravity authentication failed. Run \`agy\` and sign in, then retry.${
      clean ? ` (${clean})` : ""
    }`;
  }
  return clean || "Antigravity operation failed";
}

export type TurnFailureClassification =
  | {
      action: "retry";
      category: "tokenGap" | "streamInterrupt" | "processExit";
      delayMs: number;
      noticeTitle: string;
      noticeDescription: string;
    }
  | {
      action: "check_model";
      model: string;
      explicitRejection: { model: string; available: string[] } | null;
      rawError: string;
    }
  | {
      action: "fail";
      error: ProviderError;
    };

export function classifyTurnFailure(input: {
  rawError: string;
  processExited: boolean;
  hadProgress: boolean;
  configuredModel?: string;
  counts: TurnRetryCounts;
  policy?: RecoveryPolicyOptions;
}): TurnFailureClassification {
  const clean = sanitizeDiagnosticText(input.rawError.trim());
  const maxTotal = input.policy?.maxTotalRecoveries ?? MAX_TOTAL_TURN_RECOVERIES;
  const maxTokenGap = input.policy?.maxTokenGapRetries ?? MAX_TOKEN_GAP_RETRIES;
  const maxStream = input.policy?.maxStreamInterruptRetries ?? MAX_STREAM_INTERRUPT_RETRIES;
  const maxProcessExit = input.policy?.maxProcessExitRetries ?? MAX_PROCESS_EXIT_RETRIES;
  const maxModelRej = input.policy?.maxModelRejectionRetries ?? MAX_MODEL_REJECTION_RETRIES;

  // 1. Permanent errors never retry.
  if (isPermanentAuthError(clean)) {
    const formatted = formatDiagnostic(clean);
    return {
      action: "fail",
      error: { code: "AUTH_REQUIRED", message: formatted, diagnostic: clean },
    };
  }

  if (isQuotaExhaustedError(clean)) {
    return {
      action: "fail",
      error: { code: "QUOTA_EXHAUSTED", message: clean, diagnostic: clean },
    };
  }

  if (isSessionNotFoundError(clean)) {
    return {
      action: "fail",
      error: { code: "SESSION_NOT_FOUND", message: clean, diagnostic: clean },
    };
  }

  // 2. Model rejection / withdrawn model lookup.
  const rejection = parseModelRejection(clean, input.configuredModel);
  if (rejection) {
    if (!input.hadProgress && input.counts.modelRejection < maxModelRej && input.counts.total < maxTotal) {
      return {
        action: "check_model",
        model: rejection.model,
        explicitRejection: rejection,
        rawError: clean,
      };
    }
    return {
      action: "fail",
      error: buildInvalidModelError(rejection.model, rejection.available, clean),
    };
  }

  if (isModelLookupFailure(clean) && input.configuredModel) {
    return {
      action: "check_model",
      model: input.configuredModel,
      explicitRejection: null,
      rawError: clean,
    };
  }

  // 3. Bounded transient retries.
  if (input.counts.total < maxTotal) {
    if (isTokenGap(clean) && input.counts.tokenGap < maxTokenGap) {
      const delayMs = input.policy?.tokenGapRetryDelayMs ?? TOKEN_GAP_RETRY_DELAY_MS;
      return {
        action: "retry",
        category: "tokenGap",
        delayMs,
        noticeTitle: "Recovering from OAuth token refresh race",
        noticeDescription: `Antigravity returned a transient 401 credential gap; retrying in ${Math.round(
          delayMs / 1000,
        )}s (${input.counts.tokenGap + 1}/${maxTokenGap}).`,
      };
    }

    if (isStreamInterruption(clean) && input.counts.streamInterrupt < maxStream) {
      const delayMs = input.policy?.streamInterruptRetryDelayMs ?? STREAM_INTERRUPT_RETRY_DELAY_MS;
      return {
        action: "retry",
        category: "streamInterrupt",
        delayMs,
        noticeTitle: "Recovering from transient stream interruption",
        noticeDescription: `${clean} — continuing turn in ${Math.round(delayMs / 1000)}s (${
          input.counts.streamInterrupt + 1
        }/${maxStream}).`,
      };
    }

    if (
      isUnexpectedProcessExitError(clean, input.processExited) &&
      input.counts.processExit < maxProcessExit
    ) {
      const delayMs = input.policy?.processExitRetryDelayMs ?? PROCESS_EXIT_RETRY_DELAY_MS;
      return {
        action: "retry",
        category: "processExit",
        delayMs,
        noticeTitle: "Recovering from unexpected Antigravity CLI exit",
        noticeDescription: `${clean} — reopening session and continuing (${
          input.counts.processExit + 1
        }/${maxProcessExit}).`,
      };
    }
  }

  // If token gap failed again after exhausting its retry, surface auth remedy.
  if (isTokenGap(clean)) {
    const message = `Antigravity authentication failed after retry. Run \`agy\` and sign in, then retry. (${clean})`;
    return {
      action: "fail",
      error: { code: "AUTH_FAILED", message, diagnostic: clean },
    };
  }

  return {
    action: "fail",
    error: { message: formatDiagnostic(clean), diagnostic: clean },
  };
}

export function buildInvalidModelError(
  model: string,
  available: readonly string[],
  rawError: string,
): ProviderError {
  const clean = sanitizeDiagnosticText(rawError.trim());
  return {
    code: "INVALID_MODEL",
    message: `Antigravity does not offer model ${model} right now.${
      available.length > 0 ? ` Available models: ${available.join(", ")}` : ""
    }`,
    diagnostic: clean,
  };
}
