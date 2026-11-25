# Upstream provenance and maintenance

This repository adapts the Antigravity ACP provider from
[getpaseo/paseo](https://github.com/getpaseo/paseo). Its upstream source directory is
`plugins/antigravity-provider`; installed Paseo distributions bundle the official provider under
`resources/builtin-plugins/antigravity-provider`.

## Audited upstream pin (`0.3.0` ACP rebase)

Checked on 2026-11-25:

- Repository: `https://github.com/getpaseo/paseo`
- Tag / release baseline: `v0.17.4`
- Full repository commit: `a583aec723d0bbd99ba1b3f42cf07b2ab7c3705c`
- Provider directory tree (`plugins/antigravity-provider`): `11e8edda7ddba56ed519563946d769ad59703a6f`
- SDK ACP adapter inspected (`packages/plugin/src/server/acp.ts`, `acp-internal/connection.ts`, `acp-internal/tool-call-detail.ts`): `@getpaseo/plugin@0.17.4`
- Minimum Paseo host requirement: `>=0.17.3` (`perModelThinkingOptions` landed in `v0.17.3`; `0.17.4` adds paginated `session/list`, `LEGACY_AUTO_ACCEPT_SETTING`, and `standardToolCallDetail` refinements with zero diff in `plugins/antigravity-provider`).
- Minimum `agy` CLI requirement: `>=1.5.15` (`1.5.14` added per-model `thought_level` and SSH sign-in separation; `1.5.15` guarantees `session/load` finishes replaying conversation history before resolving).

Upstream ACP provider capabilities inherited directly from `v0.17.4` include:
- `#10310`: keep turns open for non-daemon background tools (`deferTurnOnRunningTools`);
- `#10379`: canonical Antigravity tool-call detail mapping (`server/tool-calls.ts`);
- `#10383`: separate built-in slash commands (`kind: "command"`) from invocable skills (`kind: "skill"`);
- `#10428`: full history replay on reopened long sessions;
- `#10469`: complete turns immediately when recurring `schedule` (`CronExpression`) stays `in_progress` after `end_turn`;
- `#10524`: per-model `thinkingOptions` (`perModelThinkingOptions: true`, including zero thinking options on Orchestrator models).

## Architecture and adaptation summary for `0.3.0`

Starting in `0.3.0`, the legacy `stream-json` driver, native `transcript_full.jsonl` tailer, custom replay store, prompt-file image writer, and OS keyring / `cloudcode-pa` HTTP quota fetcher were removed in favor of wrapping Paseo's `runAcpProvider` (`agy acp --disable-telemetry`).

| Area | Upstream `v0.17.4` (`plugins/antigravity-provider`) | `antigravity-resilient` (`0.3.0`) ownership & adaptation |
| --- | --- | --- |
| Identity | Plugin `antigravity-provider`, provider `antigravity` | Plugin `antigravity-resilient-provider`, provider `antigravity-resilient`, label `Antigravity (Resilient)` (`index.server.ts`, `server/provider.ts`). |
| ACP core & tool calls | `runAcpProvider` + `mapToolCall` (`server/tool-calls.ts`) | Copied from `v0.17.4` with `loadReplayQuietPeriodMs: 0` (safe on enforced `agy >= 1.5.15`), `perModelThinkingOptions: true`, `waitForInitialCommands: true`, `deferTurnOnRunningTools`, and `autoAcceptMode` (`full-access`, default `true`). |
| Process launch, Windows fallback & cleanup | Spawns bare `agy acp --disable-telemetry` | `server/launch.ts` resolves `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows when `agy` is missing from daemon `PATH`, retries transient binary-swap launch errors (`1s/2s/4s`), enforces per-session (`6/60s`) & process (`30/60s`) launch rate limits, validates `agentInfo.version >= 1.5.15` on `initialize`, sanitizes `stderr`, and terminates process trees via `@getpaseo/plugin/server` `terminateProcess`. |
| Legacy session & model-effort compatibility | `sessionOpen` reads `{ conversationId }`; `configure` splits `<model>-<effort>` | `server/legacy.ts` reads `{ sessionId }`, `{ conversationId }`, and pre-init `{ sessionKey }` (read-only lookup in `~/.paseo/antigravity-resilient/conversations/session-keys/`), emits `{ sessionId, conversationId }` in `persistence`, and attaches `<model>-<thinkingOption>` `aliases` on `discover` / `config` so Paseo's validator and external routers accept suffixed IDs on both `createAgent` and reopen. |
| Automatic context compaction | None (manual `/compact` only) | `server/compaction.ts` + outer `ProviderConnection` wrapper in `server/provider.ts`: runs internal ACP `/compact` 2.5m after model request (`>=150K` tokens) and pre-turn (`>=150K` cold cache or `>=200K`), honors `DISABLE_COMPACT=1`, emits `compaction` timeline items (`loading` -> `completed`) without leaking user messages or turns, queues concurrent user prompts, cancels cleanly on `session.interrupt`, suppresses re-compaction until the next business model request updates `contextWindowUsedTokens`, and trips circuit breakers on 3 failures or 3 rapid refills (`<10` requests). |
| Bounded error recovery & diagnostics | Single attempt; generic SDK transport errors | `server/recovery.ts` + `server/provider.ts`: bounded retry on OAuth 401 refresh gaps (`8s`, max 1), transient stream/network blips (`2s`, max 1), and mid-turn `agy` exits (`1.5s` + `session/load` reopen, max 1; max 2 total recoveries/turn). Uses `CONTINUE_INTERRUPTED_TURN_PROMPT` whenever a turn already made progress so completed side-effecting tools are never re-run. Re-probes live catalog once on stale startup model rejection (`db19236`), fails immediately on permanent auth / `RESOURCE_EXHAUSTED` quota / `Session not found`, and replaces generic SDK errors with exit code, signal, JSON-RPC error, and redacted `stderr`. |
| Cancellation & tool-only turn UX | Relies on `session/cancel` response | Per-target 5s cancel fallback deadline with suspend/wake clock-jump rebasing, plus an info `session.notice` when a turn executes foreground tools and ends without trailing summary text. |
| Usage / quota reporting | `agy -p /usage --output-format json` (`source.id = "antigravity"`) | `server/usage.ts` runs `agy -p /usage --output-format json` (`source.id = "antigravity-resilient"`, `provider = "antigravity-resilient"`), maps disabled buckets and multi-group short labels, and suppresses `scope.kind === "global"` by default (opt-in via `PASEO_ANTIGRAVITY_RESILIENT_GLOBAL_USAGE=1`) so Paseo's global usage page does not show duplicate cards alongside built-in `antigravity-provider`. |

## Modules deleted in `0.3.0`

- `server/internal/*` (`catalog.ts`, `compaction.ts`, `native-reasoning.ts`, `process.ts`, `prompt.ts`, `session.ts`, `signals.ts`, `store.ts`, `timeline.ts`, `wire.ts`): replaced by ACP runtime + focused `server/{launch,legacy,compaction,recovery}.ts`.
- `server/credentials.ts`: removed OS keyring credential extraction and `cloudcode-pa.googleapis.com` HTTP quota fallback.
- `server/paseo-sdk.d.ts`, `server/prompt-files.d.ts`, `shared/input.ts`, `test/sdk-shim.ts`, `test/register-sdk.mjs`, `test/fixtures/*`: replaced by real `@getpaseo/plugin@0.17.4` devDependencies and ACP protocol tests (`test/*.test.ts`).

## Updating this baseline

1. Inspect the new upstream tag in a separate checkout (`git show <tag>:plugins/antigravity-provider/...` and `packages/plugin/src/server/acp-internal/connection.ts`) without overwriting `server/` wholesale.
2. Diff upstream `provider.ts`, `tool-calls.ts`, `usage.ts`, and SDK `connection.ts` against the commit recorded above, porting protocol/tool changes while preserving `antigravity-resilient` identity, compaction, bounded recovery, legacy compatibility, and global usage deduplication.
3. Run `npm ci --ignore-scripts`, `npm run check`, `npm run verify:install`, and the live ACP verification harness against a real signed-in `agy` binary before cutting over a live daemon.
4. Update this document and [LICENSE.paseo](../LICENSE.paseo) to match the newly audited upstream commit.

## License and modification notice

Upstream identifies `Copyright (c) 2025-present Mohamed Boudra` and Apache License,
Version 2.0, except for separately licensed third-party components. The complete text
from `v0.17.4` (`a583aec723d0bbd99ba1b3f42cf07b2ab7c3705c`) is retained in
[LICENSE.paseo](../LICENSE.paseo). See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
