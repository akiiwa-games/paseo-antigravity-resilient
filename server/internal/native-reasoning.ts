import { openSync, closeSync, readSync, statSync } from "node:fs";

/** agy 1.4.12 omits thinking from stream-json but writes it to its native
 * transcript when a model request finishes. Tail only this turn's additions;
 * never replay a previous conversation's thoughts as new live progress. */
export class NativeReasoningTail {
  private offset = 0;
  private pending = Buffer.alloc(0);
  private ino: number | undefined;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      const stat = statSync(file);
      this.offset = stat.size;
      this.ino = stat.ino;
    } catch { /* the new conversation has not created its transcript yet */ }
  }

  read(): Array<{ step: number; text: string; timestamp?: string }> {
    const thoughts: Array<{ step: number; text: string; timestamp?: string }> = [];
    let fd: number | undefined;
    try {
      const stat = statSync(this.file);
      if (stat.size < this.offset || (this.ino !== undefined && stat.ino !== this.ino)) {
        // Replacement is not append-only progress. Start at the new EOF so
        // historical thoughts cannot leak into the active turn.
        this.offset = stat.size;
        this.pending = Buffer.alloc(0);
      }
      this.ino = stat.ino;
      if (stat.size === this.offset) return thoughts;
      fd = openSync(this.file, "r");
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - this.offset));
      while (this.offset < stat.size) {
        const size = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - this.offset), this.offset);
        if (!size) break;
        this.offset += size;
        const bytes = Buffer.concat([this.pending, chunk.subarray(0, size)]);
        let start = 0;
        for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
          try {
            const row = JSON.parse(bytes.subarray(start, end).toString("utf8"));
            if (row.type === "PLANNER_RESPONSE" && Number.isInteger(row.step_index) &&
                typeof row.thinking === "string" && row.thinking.trim()) {
              thoughts.push({ step: row.step_index, text: row.thinking,
                ...(typeof row.created_at === "string" ? { timestamp: row.created_at } : {}) });
            }
          } catch { /* ignore a malformed native row; the JSON stream remains authoritative */ }
          start = end + 1;
        }
        this.pending = Buffer.from(bytes.subarray(start));
      }
    } catch { /* optional local transcript may not exist on this CLI build */ }
    finally { if (fd !== undefined) closeSync(fd); }
    return thoughts;
  }
}
