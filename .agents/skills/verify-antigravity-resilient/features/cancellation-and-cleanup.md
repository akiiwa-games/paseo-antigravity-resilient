# Turn cancellation and process-tree cleanup

Turn cancellation stops an active `agy` turn, terminates its child process tree (`python slow.py`), and settles any running tool calls as `"canceled"` so no spinner or orphan process remains.

## Sub-features

- `cancel-in-flight-tool` interrupts an active `run_command` tool call via `client.cancelAgent(agentId)`.
- `child-process-tree-exit` terminates the spawned child process (`slow.pid`) on Windows (`taskkill /T /F`) and POSIX.
- `settle-running-tools` transitions all `"running"` tool items to `"canceled"` (`error: null`).

## How to get to it (user POV)

- Click Stop/Cancel in Paseo or call `client.cancelAgent(agentId)` while a shell command is running.

## Driving it with verify-live.mjs

Preconditions:

- `slow.py` exists in `$env:TEMP\paseo-antigravity-live-fixture` and writes its PID to `slow.pid` before sleeping 90 seconds.

- **Start long command.** `verify-live.mjs` sends `Run python slow.py exactly once in this directory.` and waits until `slow.pid` appears on disk.
- **Cancel turn.** `verify-live.mjs` reads `slowPid` from `slow.pid` and calls `await client.cancelAgent(agentId)`.
- **Confirm process exit and settled timeline.** `verify-live.mjs` polls `process.kill(slowPid, 0)` until `ESRCH` confirms the child process exited, writes `canceled-timeline.json`, and asserts zero `tool_call` items remain in `status === "running"`.

## Gotchas

- Never kill `python.exe` or `agy.exe` globally by process name; always verify `slowPid` from `slow.pid` or match the fixture path in `Win32_Process.CommandLine`.
