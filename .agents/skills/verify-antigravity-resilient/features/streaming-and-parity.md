# Streaming, canonical tool rendering, and `agy` parity

Streaming and `agy` parity ensures that assistant messages stream incrementally in real time, native intermediate `thinking` blocks from `transcript_full.jsonl` appear in step order without truncation, `read_file`/`write_file`/`edit_file`/`run_command` tool calls render with canonical Paseo `read`/`write`/`edit`/`shell` details, and literal `<thought>` tags in markdown responses are preserved without truncation.

## Sub-features

- `stream-progress` streams pre-tool progress (`PRE_TOOL_MARKER`), tool execution, post-tool commentary (`POST_TOOL_MARKER`), and multi-chunk final text (`FINAL_MARKER` .. `END_MARKER`).
- `native-reasoning` tails `transcript_full.jsonl` (falling back to `transcript.jsonl`) and emits `reasoning` items in step order before their corresponding message or tool steps.
- `canonical-tools` maps `agy` 1.4.12 `run_command`, `write_file` (`Path`, `Content`), `edit_file` (`Path`, `Target`, `Replacement`), and `read_file` (`Path`, `StartLine`, `EndLine`) to `shell`, `write`, `edit`, and `read` tool details.
- `thought-tag-parity` preserves markdown responses containing literal `` `<thought>` `` without stdout truncation (`THOUGHT_TAG_SURVIVED_MARKER`) in a single unsplit `assistant_message` bubble (`thoughtMessageBubbles === 1`) and without duplicate `:message:1` fallback bubbles.
- `evicted-db-recovery` recovers conversation history into a new `agy` trajectory (`<CONVERSATION_HISTORY_RECOVERY>`) and migrates the durable store when `agy`'s 500-conversation cap evicts `<conversationId>.db` from `~/.gemini/antigravity-cli/conversations/`.

## How to get to it (user POV)

- Create an `antigravity-resilient` agent in Paseo and send a prompt that runs commands, reads/writes/edits files, and outputs markdown containing `` `<thought>` ``.

## Driving it with verify-live.mjs

Preconditions:

- Paseo daemon is running on `cfg.daemon.listen` (`127.0.0.1:8768`) with the latest plugin files loaded from `E:\PROJECTS\paseo-plugins\paseo-antigravity-resilient`.
- `agy` is signed in and healthy.

- **Launch probe.** Run `node .\scripts\verify-live.mjs --output "$env:TEMP\agy-live-proof"`. The script asserts `antigravity-resilient-provider` has `status === "running"` and creates a probe agent in `$env:TEMP\paseo-antigravity-live-fixture`.
- **Verify streaming turn.** The first prompt emits `PRE_TOOL_MARKER`, runs `python probe.py`, emits `POST_TOOL_MARKER`, runs `python -c "print(2+3)"`, and streams 40 numbered lines between `FINAL_MARKER` and `END_MARKER`. `completed-timeline.json` and `live-timeline.jsonl` record multiple distinct text lengths for the final message and at least one `reasoning` item.
- **Verify canonical tool details and `<thought>` parity.** The third prompt executes `write_file`, `edit_file`, and `read_file` on `sample.txt` and replies with markdown containing literal `` `<thought>` `` followed by `THOUGHT_TAG_SURVIVED_MARKER`. `parity-timeline.json` records `detail.type` values `["edit", "read", "shell", "write"]` and an untruncated assistant message containing both `<thought>` and `THOUGHT_TAG_SURVIVED_MARKER`.

## Gotchas

- `agy`'s stdout stream filter strips everything after an unclosed literal `<thought>` tag in both `step_update.text_delta` and `result.response`; `Session.reconcileNativeTurnSteps` repairs the message in-place from `transcript_full.jsonl`.
- `agy` 1.4.12 passes file paths under `Path` (capitalized) for `read_file`, `write_file`, and `edit_file`.
