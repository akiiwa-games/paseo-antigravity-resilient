import type { ProviderTimelineItem, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import { isRecord, type StepUpdate, type ToolResultFrame } from "./wire.ts";

/**
 * Paseo 0.11.2 treats every replayed notification as an opening notice and
 * appends it again when a durable timeline already exists. Compaction is a
 * native timeline event, not a notification. Migrate old snapshots on read
 * without rewriting their timestamps, IDs or chronological storage order.
 * Also upgrades persisted `unknown` tool_call details (such as `read_file`,
 * `write_file`, `edit_file` with `Path` arguments) on replay.
 */
export function replayTimelineItem(item: ProviderTimelineItem): ProviderTimelineItem {
  if (item.type === "tool_call" && item.detail.type === "unknown") {
    if (!isRecord(item.detail.input) || Object.keys(item.detail.input).length === 0) {
      return item;
    }
    const upgraded = toolDetail(
      item.name,
      item.detail.input,
      typeof item.detail.output === "string" ? item.detail.output : undefined,
    );
    if (upgraded.type !== "unknown") {
      return { ...item, detail: upgraded };
    }
    return item;
  }
  if (item.type !== "notification" || !/^turn-\d+:auto-compact$/.test(item.id)) {
    return item;
  }
  const match = /^Auto-compacted context \(([\d,]+) tokens\) 1m before 5m hot cache expiry\.$/.exec(item.message);
  if (!match) return item;
  const preTokens = Number(match[1].replaceAll(",", ""));
  if (!Number.isSafeInteger(preTokens) || preTokens < 0) return item;
  return { id: item.id, type: "compaction", status: "completed", trigger: "auto", preTokens };
}

function stringArg(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export function toolOutput(frame: ToolResultFrame): string | undefined {
  if (typeof frame.content === "string") {
    return frame.content;
  }
  if (frame.content !== undefined && frame.content !== null) {
    try {
      return JSON.stringify(frame.content, null, 2);
    } catch {
      return String(frame.content);
    }
  }
  if (typeof frame.error === "string") {
    return frame.error;
  }
  return undefined;
}

export function toolDetail(
  name: string,
  input: unknown,
  output?: string,
): ProviderToolCallDetail {
  const args = isRecord(input) ? input : {};
  const command = stringArg(args, ["CommandLine", "command", "cmd"]);
  if (name === "run_command" || command) {
    return {
      type: "shell",
      command: command ?? name,
      cwd: stringArg(args, ["Cwd", "cwd"]),
      ...(output !== undefined ? { output } : {}),
    };
  }

  const filePath = stringArg(args, [
    "Path",
    "AbsolutePath",
    "TargetFile",
    "FilePath",
    "file_path",
    "path",
  ]);
  if (
    (name === "view_file" ||
      name === "view_file_outline" ||
      name === "view_code_item" ||
      name === "read_file") &&
    filePath
  ) {
    const startLine =
      typeof args.StartLine === "number" && Number.isSafeInteger(args.StartLine)
        ? args.StartLine
        : undefined;
    const endLine =
      typeof args.EndLine === "number" && Number.isSafeInteger(args.EndLine)
        ? args.EndLine
        : undefined;
    return {
      type: "read",
      filePath,
      ...(startLine !== undefined ? { offset: startLine } : {}),
      ...(startLine !== undefined && endLine !== undefined && endLine >= startLine
        ? { limit: endLine - startLine + 1 }
        : {}),
      ...(output !== undefined ? { content: output } : {}),
    };
  }
  if ((name === "write_to_file" || name === "write_file") && filePath) {
    const content =
      typeof args.Content === "string"
        ? args.Content
        : typeof args.CodeContent === "string"
          ? args.CodeContent
          : undefined;
    return {
      type: "write",
      filePath,
      ...(content !== undefined ? { content } : {}),
    };
  }
  if (
    (name === "replace_file_content" ||
      name === "multi_replace_file_content" ||
      name === "edit_file") &&
    filePath
  ) {
    const oldString =
      typeof args.Target === "string"
        ? args.Target
        : typeof args.TargetContent === "string"
          ? args.TargetContent
          : undefined;
    const newString =
      typeof args.Replacement === "string"
        ? args.Replacement
        : typeof args.ReplacementContent === "string"
          ? args.ReplacementContent
          : undefined;
    return {
      type: "edit",
      filePath,
      ...(oldString !== undefined ? { oldString } : {}),
      ...(newString !== undefined ? { newString } : {}),
    };
  }

  if (name === "invoke_subagent") {
    const subAgentType = stringArg(args, ["TypeName", "Role"]);
    const description = stringArg(args, ["Prompt", "Role"]);
    if (subAgentType || description) {
      return {
        type: "sub_agent",
        ...(subAgentType ? { subAgentType } : {}),
        ...(description ? { description } : {}),
        log: output ?? "",
      };
    }
  }

  const query = stringArg(args, [
    "Query",
    "query",
    "Pattern",
    "pattern",
    "SearchPath",
    "SearchDirectory",
    "DirectoryPath",
  ]);
  if (
    name === "grep_search" ||
    name === "find_by_name" ||
    name === "search_web" ||
    name === "list_dir" ||
    name === "list_directory" ||
    query
  ) {
    return {
      type: "search",
      query: query ?? filePath ?? name,
      ...(output !== undefined ? { content: output } : {}),
    };
  }

  const url = stringArg(args, ["Url", "url"]);
  if (name === "read_url_content" || url) {
    return {
      type: "fetch",
      url: url ?? name,
      ...(output !== undefined ? { result: output } : {}),
    };
  }

  return {
    type: "unknown",
    input: input ?? null,
    output: output ?? null,
  };
}

export function stepToolDetail(step: StepUpdate): ProviderToolCallDetail {
  if (step.subagent_info) {
    const child = step.subagent_info.subagents[0];
    if (child) {
      return {
        type: "sub_agent",
        subAgentType: child.type_name,
        description: child.initial_prompt,
        childSessionId: child.conversation_id === null ? undefined : child.conversation_id,
        log: child.log_uri ?? "",
      };
    }
  }
  const info = step.tool_info;
  if (!info) {
    return { type: "plain_text", label: step.tool_name, text: "" };
  }
  const detail = toolDetail(
    step.tool_name || info.name || "Antigravity tool",
    info.parameters ?? {},
    info.output,
  );
  if (detail.type === "unknown") {
    return {
      type: "unknown",
      input: info.parameters ?? null,
      output: info.error || info.output || null,
    };
  }
  return detail;
}
