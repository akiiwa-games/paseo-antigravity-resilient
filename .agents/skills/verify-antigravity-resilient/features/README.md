# `paseo-antigravity-resilient` verification map

This directory is the maintained source for verifying the user-facing behavior of the `antigravity-resilient` Paseo provider plugin (`antigravity-resilient-provider`). Read this index before driving the plugin, then use the matching feature file as the recipe.

## Baseline preconditions

- The local Paseo daemon is running on `cfg.daemon.listen` (`127.0.0.1:8768`) with valid credentials in `~/.paseo/local-credential`.
- `agy --version` reports `>= 1.1.15` and has an active authenticated session.
- `npm run typecheck` passes with exit code `0`.
- Live probes use a dedicated disposable fixture directory (`$env:TEMP\paseo-antigravity-live-fixture`) and write proof artifacts to a fresh `--output` directory outside the repository.
- Never cancel or modify pre-existing user agents in Paseo; only drive the agent ID created by the verification run.

## Driving conventions

- Start every live recipe by running `node .\scripts\verify-live.mjs --output <dir>`. Only pass `--reload` when driving from outside an `antigravity-resilient` session (reloading the plugin restarts all active `antigravity-resilient` sessions).
- Treat all commands and marker strings as literal.
- Preserve all proof artifacts in the `--output` directory after deleting the disposable test agent.

## Proof and skip reporting

- Capture both real-time WebSocket stream events (`live-timeline.jsonl`) and fetched timeline snapshots (`completed-timeline.json`, `parity-timeline.json`, `replayed-timeline.json`, `canceled-timeline.json`, `summary.json`).
- Verify side effects on disk (persisted conversation snapshot in `~/.paseo/antigravity-resilient/conversations/<conversationId>.json` and `agy` native `transcript_full.jsonl`).
- Report any unreachable path with the attempted command and the unmet precondition; never report a skipped check as verified.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order:

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with verify-live.mjs / verify-install.mjs`
4. `Gotchas`

## Features

- [Streaming, canonical tool rendering, and `agy` parity](./streaming-and-parity.md) covers multi-chunk assistant streaming, native `transcript_full.jsonl` reasoning, canonical `read`/`write`/`edit`/`shell` tool details, and untruncated `<thought>` markdown rendering.
- [Continuation and durable timeline replay](./replay-and-continuation.md) covers multi-turn session resumption and `refreshAgent` history replay.
- [Turn cancellation and process-tree cleanup](./cancellation-and-cleanup.md) covers interrupting a running `run_command` tool call and verifying child PID termination.
- [Offline packaging and SDK linkage](./install-and-packaging.md) covers `npm ci`, `typecheck`, `npm pack`, offline tarball install, and Paseo SDK entry linkage.
