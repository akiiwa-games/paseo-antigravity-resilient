# Upstream provenance and maintenance

This repository adapts the Antigravity provider from
[getpaseo/paseo](https://github.com/getpaseo/paseo). Its source directory is
`plugins/antigravity-provider`; installed Paseo distributions put the provider under
`resources/builtin-plugins/antigravity-provider`. The installed path is not the Git
repository path.

## Audited upstream pin

Checked on 2026-11-02:

- Repository: `https://github.com/getpaseo/paseo`
- Branch inspected: `main`
- Full repository commit: `da8d58bfee5279369c1a733cf5cf4ddc3bd56bb8`
- Commit timestamp: `2026-11-02T05:04:23Z`
- Provider directory tree: `9678d16761c22cebd71a39adaaa13d75ccd8b78c`
- Most recent commit affecting that directory:
  `9760292650216e4cb93fa787085251029c882130` (2026-10-05),
  “fix(providers): launch plugin CLIs on Windows and tolerate Muse startup (#6151)”.
- Snapshot: all 243 provider-directory files, including fixtures and tests, were
  saved before comparison. The eight runtime server modules, entry and manifest
  matched the locally installed built-in provider line for line.

The audit establishes the current comparison baseline. It does not establish the
historical commit from which every pre-existing fork modification was originally made.
The provider directory has not changed since October 5 at the audited pin; differences
from our implementation are upstream changes absent from the older fork, rather than
new provider changes in today's main commit.

## Selective integration for 0.2.0

The local provider keeps its own ID, persistence/replay, bounded transient recovery,
context usage, quota reporting, native transcript handling and automatic compaction.
The upstream provider is substantially refactored, so copying its directory wholesale
would remove those behaviors. The release integration is split as follows:

| Upstream behavior | Local adaptation and ownership |
| --- | --- |
| Private image temporary files | `PromptFiles.encode(prompt, systemPrompt?)` writes image data into a session-owned directory, preserves visible text separately and retains the fork's command and non-image attachment support. `close()` removes the directory. Session owns calling it. |
| Minimum CLI version | `provider.status()` accepts readable `agy` versions at least `1.1.15`, retaining the fork's probe diagnostics and timeout. |
| Startup deadline and stdin failure | `Session.ensureDriver()` bounds initialization to 90 seconds, configurable with `providerOptions.startupTimeoutMs`. The upstream 30-second default timed out during successful silent authentication on the second test host. `spawnDriver()` forwards stdin failures. |
| Child process tree cleanup | `spawnDriver().stop()` uses the host SDK's Windows tree termination and dedicated POSIX groups. Retired-driver callbacks are ignored and overlapping shutdown is awaited. |
| Terminal tool status | `Session.finishTools()` finalizes running tools as completed, failed or canceled at the turn boundary. Recovery cancels the retired attempt's tools. |
| Resume identity | The init handler rejects a restored CLI conversation that differs from the requested conversation. |
| Idle process failure | Driver close/error handlers report `session.runtime_failed` when idle. |
| Cumulative denied actions | `Session.handleResult()` counts native denial occurrences and surfaces only newly observed policy denials. |

The local streaming layer also reconciles the final response and tails new native
reasoning rows, which the audited upstream does not provide. It also handles agy
1.4.12 retaining a historical SSE transport error in an otherwise finished result.
Recovery requires an explicit response `DONE` (or a compaction request's completed
native checkpoint), rejects early termination and checks for later native errors.
Result text length and absence of an error marker are not completion evidence.
Keep the fork's narrowed authentication classifier: upstream `wire.ts` still uses
an overly broad `/auth/` match. Keep the fork's tolerant catalog parser, binary-aware
cache key and bounded transient retries. Image temporary-file permissions use `0700`
for the directory and `0600` for files on POSIX; Windows does not implement POSIX
permission bits and relies on the user's temporary-directory ACLs.

## Updating this baseline

1. Resolve and record the full upstream commit and provider tree SHA before changing
   runtime code. Fetch source and LICENSE at that immutable commit into a separate
   research directory; preserve the full snapshot and unabridged diffs.
2. Compare the new provider directory to this pin, the installed built-in provider
   and our implementation. Track new lifecycle/protocol fixes separately from local
   replay/recovery/compaction and usage behavior.
3. Apply each relevant fix on top of the local behavior. Do not overwrite `server/`
   or install-source directories from an unreviewed upstream snapshot.
4. Run clean `npm ci --ignore-scripts`, `npm run typecheck`, relevant behavioral tests
   and `npm run verify:install`. Then validate actual model streaming, tool progress,
   final text, interruption and resumed history in a Paseo test installation.
5. Update this pin, integration notes and license notices. Publish the reviewed
   repository revision and verify another host before treating the update as released.

## License and modification notice

Upstream identifies `Copyright (c) 2025-present Mohamed Boudra` and Apache License,
Version 2.0, except for separately licensed third-party components. The complete text
from the audited commit is retained as [LICENSE.paseo](../LICENSE.paseo).

This is a modified provider: local changes add a distinct provider ID, durable replay,
recovery, compaction, usage/quota reporting, streaming repair and installation tooling.
The repository-wide license for local modifications has not been selected by its
owner; the upstream license is not presented as a new grant by that owner. See
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
