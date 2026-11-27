# Antigravity Resilient

Runs Google Antigravity (`agy acp`) agents in Paseo as a separate provider, `antigravity-resilient`, that can sit beside the built-in `antigravity` provider. It is built from the official Paseo 0.17.4 Antigravity provider and adds automatic context compaction, bounded recovery from transient failures, compatibility with older sessions, and a quota card.

## How it works

The plugin starts the `agy` CLI in ACP mode for each session and keeps everything the official provider does: full history replay through `session/load`, per-model thinking levels, agy's native modes, and the same tool and timeline mapping. The additions below run inside that ACP session.

## Setup

- Paseo 0.17.3 or later (tested on 0.17.4).
- The Antigravity CLI `agy` 1.5.15 or later, installed and signed in for the same user that runs the Paseo daemon. On Windows the plugin falls back to `%LOCALAPPDATA%\agy\bin\agy.exe` when `agy` is not on the daemon `PATH`.
- No accounts, tokens, or settings are needed beyond a working `agy` sign-in.

## What it adds

- **Automatic compaction.** When a session's context reaches 150,000 tokens, the plugin runs agy's `/compact` about 2.5 minutes after the last model request, before Gemini's prompt cache expires. A busy session is compacted before its next turn when the cache has gone cold and context is at least 150,000 tokens, or when context reaches 200,000 tokens. Compaction appears as a compaction row in the timeline, messages sent meanwhile are queued, and an interrupt cancels it. Three failures in a row, or three quick refills, pause it with a notice. Compaction is a model request and counts against your Antigravity quota.
- **Bounded recovery.** A token refresh gap is retried once after 8 seconds. A dropped stream or transient backend error (`UNAVAILABLE`, `INTERNAL`, `EOF`, 502 to 504) is retried once after 2 seconds. An agy process that exits mid-turn is reopened once through `session/load`. A turn gets at most two recoveries. If tools already ran, the plugin sends a continuation prompt instead of resending the original, so tools are not run twice. Each recovery shows a notice. Sign-in failures, exhausted quota (429), and missing sessions fail at once.
- **Clearer errors.** Generic transport errors are replaced with the agy exit code, signal, JSON-RPC error, and a redacted tail of its stderr.
- **Startup hardening.** Launch failures caused by agy replacing its own binary during self-update are retried with backoff, and launches are rate limited per session and overall.
- **Older sessions and model IDs.** Sessions saved by earlier stream-json versions of this plugin reopen through `session/load`. Model IDs with a thinking suffix, such as `gemini-4-hydrogen-medium`, are accepted as aliases for the base model plus that thinking level.
- **Quota card.** Usage windows come only from running `agy -p /usage --output-format json`, cached for 5 minutes per account. The plugin does not read the system credential store or call quota endpoints itself.

## Settings

- `DISABLE_COMPACT=1` in the daemon environment turns automatic compaction off.
- `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` changes the idle compaction threshold (minimum 100,000).
- `PASEO_ANTIGRAVITY_RESILIENT_GLOBAL_USAGE=1` shows the quota card globally before any session of this provider has been opened. Use it when the built-in `antigravity` plugin is disabled.

## Data and permissions

- Prompts, files the agent reads, and tool results are sent by `agy` to Google's Antigravity service, as with any Antigravity session.
- New sessions start in agy's `full-access` mode, which approves tool calls automatically. Switch to `default`, `accept-edits`, or `plan` per session when you want approvals.
- The plugin starts and stops `agy` subprocesses. It writes no files of its own; session files left by earlier versions under the Paseo home are only read, never changed.
