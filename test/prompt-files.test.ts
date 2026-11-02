import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { PromptFiles, renderPrompt } from "../server/internal/prompt.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
function imagePrompt(mimeType = "image/png"): ProviderPrompt {
  return {
    clientMessageId: "image-test",
    delivery: "auto",
    input: { type: "message", content: [{ type: "image", mimeType, data: png }] },
  };
}

test("image files retain exact bytes, use private permissions and are removed with their session", async () => {
  const files = new PromptFiles();
  let directory = "";
  try {
    const prompt: ProviderPrompt = {
      clientMessageId: "mixed-image-test",
      delivery: "auto",
      input: { type: "message", content: [
        { type: "text", text: "Inspect this screenshot." },
        { type: "image", mimeType: "image/png", data: png },
        { type: "uploaded_file", id: "upload", path: "/example/data.csv", fileName: "data.csv", mimeType: "text/csv", size: 123 },
      ] },
    };
    const rendered = await files.encode(prompt, "System instructions");
    const file = rendered.cliText.split("\n").find((line) => line.startsWith("Attached image: "))?.slice("Attached image: ".length);
    assert.ok(file);
    directory = path.dirname(file);
    assert.equal(readFileSync(file).toString("base64"), png);
    assert.equal(path.extname(file), ".png");
    assert.match(rendered.cliText, /^System instructions\n\nInspect this screenshot\./);
    assert.match(rendered.userText, /Inspect this screenshot\./);
    assert.match(rendered.userText, /Path: \/example\/data.csv/);
    assert.doesNotMatch(rendered.userText, /Attached image:|paseo-antigravity-images-/);
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(directory).mode & 0o777, 0o700);
    }
    const second = await files.encode(imagePrompt("image/jpeg"));
    assert.equal(second.userText, "");
    assert.match(second.cliText, /Attached image: .*\.jpg$/);
    assert.ok(second.cliText !== rendered.cliText);
  } finally {
    await files.close();
  }
  assert.equal(existsSync(directory), false);
  await files.close();
});

test("image encoding preserves command and text rendering and rejects unsafe MIME paths", async () => {
  const files = new PromptFiles();
  try {
    const command: ProviderPrompt = { clientMessageId: "command", delivery: "auto", input: { type: "command", name: "compact", arguments: "" } };
    assert.deepEqual(await files.encode(command), renderPrompt(command));
    const text: ProviderPrompt = { clientMessageId: "text", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hello" }] } };
    assert.deepEqual(await files.encode(text, "system"), renderPrompt(text, "system"));
    await assert.rejects(files.encode(imagePrompt("image/../../png")), /Expected an image MIME type/);
  } finally {
    await files.close();
  }
});
