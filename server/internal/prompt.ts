import type {
  ProviderContentPart,
  ProviderPrompt,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function renderPart(part: ProviderContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "uploaded_file":
      return [
        "Uploaded file available on the daemon filesystem:",
        `Path: ${part.path}`,
        `Filename: ${part.fileName}`,
        `MIME type: ${part.mimeType}`,
        `Size: ${part.size} bytes`,
      ].join("\n");
    case "review":
      return [
        `Code review (${part.mode}${part.baseRef ? ` vs ${part.baseRef}` : ""}):`,
        ...part.comments.map((comment) => {
          const lines = comment.context.lines
            .map((line) => {
              const prefix =
                line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
              return `${prefix} ${line.content}`;
            })
            .join("\n");
          return [
            `${comment.filePath}:${comment.lineNumber} (${comment.side})`,
            comment.context.hunkHeader,
            lines,
            `Comment: ${comment.body}`,
          ].join("\n");
        }),
      ].join("\n\n");
    case "github_pr":
    case "forge_change_request":
      return [
        `Change request #${part.number}: ${part.title}`,
        `URL: ${part.url}`,
        ...(part.body ? [part.body] : []),
      ].join("\n");
    case "github_issue":
    case "forge_issue":
      return [
        `Issue #${part.number}: ${part.title}`,
        `URL: ${part.url}`,
        ...(part.body ? [part.body] : []),
      ].join("\n");
    case "image":
      throw new Error("Antigravity CLI does not support image attachments.");
  }
}

export function renderPrompt(
  prompt: ProviderPrompt,
  systemPrompt?: string,
): { cliText: string; userText: string } {
  const userText =
    prompt.input.type === "command"
      ? `/${prompt.input.name}${prompt.input.arguments.trim() ? ` ${prompt.input.arguments.trim()}` : ""}`
      : prompt.input.content.map(renderPart).filter(Boolean).join("\n\n").trim();

  if (!userText) {
    throw new Error("Antigravity prompt cannot be empty.");
  }

  const trimmedSystem = systemPrompt?.trim();
  return {
    userText,
    cliText: trimmedSystem ? `${trimmedSystem}\n\n${userText}` : userText,
  };
}

/** Owns image files for one Session, following upstream PromptFiles ownership. */
export class PromptFiles {
  private directory: string | null = null;

  async encode(
    prompt: ProviderPrompt,
    systemPrompt?: string,
  ): Promise<{ cliText: string; userText: string }> {
    if (prompt.input.type === "command" || !prompt.input.content.some((part) => part.type === "image")) {
      return renderPrompt(prompt, systemPrompt);
    }
    // Validate all MIME types before writing any files.
    const parts = prompt.input.content.map((part) =>
      part.type === "image" ? { ...part, extension: imageExtension(part.mimeType) } : part,
    );
    const visible: string[] = [];
    const native: string[] = [];
    for (const part of parts) {
      if (part.type !== "image") {
        const text = renderPart(part);
        visible.push(text);
        native.push(text);
        continue;
      }
      if (this.directory === null) {
        this.directory = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-images-"));
        await chmod(this.directory, 0o700);
      }
      const file = path.join(this.directory, `${randomUUID()}.${part.extension}`);
      await writeFile(file, Buffer.from(part.data, "base64"), { flag: "wx", mode: 0o600 });
      await chmod(file, 0o600);
      native.push(`Attached image: ${file}`);
    }
    const userText = visible.filter(Boolean).join("\n\n").trim();
    const nativeText = native.filter(Boolean).join("\n\n").trim();
    const system = systemPrompt?.trim();
    return { userText, cliText: system ? `${system}\n\n${nativeText}` : nativeText };
  }

  async close(): Promise<void> {
    if (this.directory !== null) {
      await rm(this.directory, { recursive: true, force: true });
      this.directory = null;
    }
  }
}

function imageExtension(mimeType: string): string {
  const match = /^image\/([a-z0-9][a-z0-9.+-]*)$/i.exec(mimeType);
  if (!match) throw new Error(`Expected an image MIME type, received ${mimeType}`);
  const subtype = match[1].toLowerCase();
  if (subtype === "jpeg") return "jpg";
  if (subtype === "svg+xml") return "svg";
  return subtype;
}
