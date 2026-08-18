import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import { parseRunRecord, serializeRunRecord, type RunRecord } from "../types/record.js";

/**
 * Appends one line per run. Writes are awaited so a line is never left half
 * written, but the stream still buffers: a batch abandoned without close()
 * loses its most recent records. Long batches should therefore be closed on
 * interrupt, which `installInterruptHandler` arranges.
 */
export class NdjsonWriter {
  private stream: WriteStream | undefined;

  constructor(private readonly path: string) {}

  private async ensureStream(): Promise<WriteStream> {
    if (this.stream) return this.stream;
    await mkdir(dirname(this.path), { recursive: true });
    const stream = createWriteStream(this.path, { flags: "a" });
    await once(stream, "open");
    this.stream = stream;
    return stream;
  }

  async write(record: RunRecord): Promise<void> {
    const stream = await this.ensureStream();
    if (!stream.write(`${serializeRunRecord(record)}\n`)) {
      await once(stream, "drain");
    }
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    const stream = this.stream;
    this.stream = undefined;
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }
}

/**
 * Flushes the writer when the batch is interrupted, so hours of completed runs
 * are not lost to the stream buffer. Returns a function removing the handlers.
 */
export function installInterruptHandler(writer: NdjsonWriter): () => void {
  const signals = ["SIGINT", "SIGTERM"] as const;

  const handlers = signals.map((signal) => {
    const handler = () => {
      void writer.close().finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    };
    process.once(signal, handler);
    return { signal, handler };
  });

  return () => {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  };
}

export interface ReadResult {
  records: RunRecord[];
  /** Line numbers that failed to parse, so a damaged file is not read as short. */
  malformedLines: number[];
}

/**
 * Guards against a line that is valid JSON but not a run: a truncated or
 * foreign line must be reported, not silently counted as a record.
 */
function isRunRecordShape(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<RunRecord>;
  return (
    record.schema === 1 &&
    typeof record.runId === "string" &&
    typeof record.batchId === "string" &&
    typeof record.valid === "boolean"
  );
}

export async function readNdjson(path: string): Promise<ReadResult> {
  const content = await readFile(path, "utf8");
  const records: RunRecord[] = [];
  const malformedLines: number[] = [];

  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const parsed: unknown = parseRunRecord(line);
      if (isRunRecordShape(parsed)) {
        records.push(parsed);
      } else {
        malformedLines.push(index + 1);
      }
    } catch {
      malformedLines.push(index + 1);
    }
  }

  return { records, malformedLines };
}
