# Continuation and durable timeline replay

Continuation and durable timeline replay lets a user send follow-up prompts in the same `agy` conversation and reopen or refresh the session without losing prior messages, reasoning blocks, or canonical tool details.

## Sub-features

- `same-conversation-continuation` reuses the `agy` conversation handle across turns so the model recalls prior turn outputs (`RESUME_MARKER 5`).
- `durable-replay` replays the persisted timeline from `~/.paseo/antigravity-resilient/conversations/<conversationId>.json` when `client.refreshAgent(agentId)` or `session.open(..., "replay")` is called.
- `replay-upgrade` upgrades legacy `unknown` `read_file`/`write_file`/`edit_file` tool details and legacy compaction notifications on read without mutating snapshot files on disk.

## How to get to it (user POV)

- Send a follow-up prompt in an existing Paseo `antigravity-resilient` session, or refresh/reopen the session in Paseo.

## Driving it with verify-live.mjs

Preconditions:

- Turn 1 (`END_MARKER`) and Turn 3 (`THOUGHT_TAG_SURVIVED_MARKER`) have completed in `verify-live.mjs`.

- **Send follow-up turn.** `verify-live.mjs` sends `Without tools: recall the number printed by the second command. Reply only RESUME_MARKER followed by that number.` The timeline settles with `status === "idle"` and an `assistant_message` matching `/RESUME_MARKER\s+5/`.
- **Refresh and replay.** `verify-live.mjs` calls `await client.refreshAgent(agentId)` and `await client.fetchAgentTimeline(agentId)`, saving `replayed-timeline.json` and asserting both `END_MARKER` and `THOUGHT_TAG_SURVIVED_MARKER` are present in the replayed timeline.

## Gotchas

- Replaying a session that had an unfinished (`status: "running"`) tool call from a crashed predecessor must settle that replayed tool item as `"canceled"` rather than reviving a live spinner.
