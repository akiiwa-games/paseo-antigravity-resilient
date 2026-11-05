---
name: verify-antigravity-resilient
description: "Verify the antigravity-resilient Paseo provider plugin end-to-end against a real local Paseo daemon and logged-in agy CLI, plus offline packaging/SDK linkage. Use when validating streaming, native transcript_full.jsonl parity, canonical tool details, durable replay, or process-tree cancellation."
---

# Verify `paseo-antigravity-resilient`

This skill drives the real `antigravity-resilient-provider` plugin inside a live Paseo daemon (`cfg.daemon.listen`, e.g. `127.0.0.1:8768`) backed by a logged-in `agy` CLI (`>= 1.1.15`), and verifies offline packaging via `npm run verify:install`.

## Launch

`paseo-antigravity-resilient` runs as a server plugin inside the local Paseo daemon (`~/.paseo/config.json`) loaded directly from `E:\PROJECTS\paseo-plugins\paseo-antigravity-resilient`.

1. **Run the live integration probe:**
   `scripts/verify-live.mjs` reads `daemon.listen` from `~/.paseo/config.json` (`127.0.0.1:8768`), connects over WebSocket (`ws://127.0.0.1:8768/ws`), asserts `plugin.status === "running"`, and creates a disposable probe agent in an isolated fixture directory (`$env:TEMP\paseo-antigravity-live-fixture`).
   > **Important:** Only pass `--reload` when invoking `verify-live.mjs` from outside an `antigravity-resilient` session. Calling `client.reloadPlugin('antigravity-resilient-provider')` from inside an `antigravity-resilient` agent restarts the plugin worker hosting that agent itself.

## Doctor

Run this read-only check before driving the live daemon to confirm:
1. TypeScript compilation passes (`npm run typecheck`),
2. `agy --version` is readable and `>= 1.1.15`,
3. `~/.paseo/config.json` and `~/.paseo/local-credential` exist and the Paseo daemon is listening on `daemon.listen` (`127.0.0.1:8768`):

```powershell
npm run typecheck; agy --version; Test-NetConnection -ComputerName 127.0.0.1 -Port 8768 -InformationLevel Quiet
```

## Drive

1. **Unit & protocol regression suite (deterministic, no model quota):**
   ```powershell
   npm test
   ```
2. **Offline packaging & real SDK entry linkage verification:**
   ```powershell
   npm run verify:install -- "$env:TEMP\agy-install-proof-$(Get-Date -Format 'yyyyMMddHHmmss')"
   ```
3. **Live Paseo daemon + `agy` end-to-end verification (streaming, native `transcript_full.jsonl` reasoning, canonical `read`/`write`/`edit`/`shell` tool details, literal `<thought>` markdown survival, continuation, durable replay, and process-tree cancellation):**
   ```powershell
   node .\scripts\verify-live.mjs --reload --output "$env:TEMP\agy-live-proof-$(Get-Date -Format 'yyyyMMddHHmmss')"
   ```

## Evidence

Every verification run writes durable proof artifacts outside the source tree so cleanup never deletes them:
- `verify:install` output directory:
  - `steps.json`, `npm-ci.stdout.log`, `typecheck.stdout.log`, `package-contents.json`, `packed-entry-link.stdout.log`, and `summary.json`.
- `verify:live` output directory:
  - `live-timeline.jsonl`: every real-time WebSocket timeline event with timestamp.
  - `completed-timeline.json`: full Paseo timeline snapshot after the streaming turn.
  - `parity-timeline.json`: full Paseo timeline snapshot proving canonical `shell`, `write`, `edit`, and `read` tool details and untruncated literal `<thought>` markdown output in a single unsplit bubble (`thoughtMessageBubbles === 1`).
  - `replayed-timeline.json`: timeline snapshot after `client.refreshAgent(agentId)` proving durable replay.
  - `evicted-recovery-timeline.json`: timeline snapshot after deleting `<conversationId>.db` from `~/.gemini/antigravity-cli/conversations/` and sending a continuation turn (`EVICTED_RECOVERY_MARKER beta`), proving automatic history recovery without `"Antigravity restored a different conversation; refusing to mix histories"`.
  - `canceled-timeline.json`: timeline snapshot after `client.cancelAgent(agentId)` proving no tool remains in `"running"` state and the child `python slow.py` process (`slowPid`) exited.
  - `summary.json`: structured pass/fail summary of all live checks (`streaming`, `continuation`, `toolAndThoughtParity`, `replay`, `evictedDbRecovery`, `cancellation`).

## Cleanup

1. `scripts/verify-live.mjs` automatically cancels, archives, and deletes the temporary probe agent (`client.cancelAgent`, `client.archiveAgent`, `client.deleteAgent`) in its `finally` block while preserving the `--output` evidence directory.
2. Never kill processes by name (`agy.exe`, `node.exe`, `python.exe`). Always inspect command lines and kill only exact PIDs started by the verification run:
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='agy.exe'" | Where-Object { $_.CommandLine -match 'paseo-antigravity-live-fixture|slow\.py|probe\.py' } | Select-Object ProcessId,Name,CommandLine
   ```
   If any stray fixture process remains, stop it by exact PID:
   ```powershell
   Stop-Process -Id <pid> -Force
   ```

## Helpers

- [`scripts/verify-live.mjs`](../../../scripts/verify-live.mjs): Live Paseo daemon + `agy` integration verifier (`node .\scripts\verify-live.mjs --reload --output <dir>`).
- [`scripts/verify-install.mjs`](../../../scripts/verify-install.mjs): Clean `npm ci`, `typecheck`, `npm pack`, offline tarball install, and real SDK entry linkage verifier (`npm run verify:install -- <dir>`).
