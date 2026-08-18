import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NdjsonWriter, readNdjson } from "../src/output/ndjson.js";
import type { RunRecord } from "../src/types/record.js";

function makeRecord(index: number): RunRecord {
  return {
    schema: 1,
    runId: `run-${index}`,
    batchId: "b",
    batchSeed: 42,
    recordedAt: "2026-08-18T00:00:00.000Z",
    url: "http://example/",
    combination: { technique: "raf" },
    repetition: index,
    sequence: index,
    valid: true,
    timestamps: [0, 16.7, 33.4],
    baseline: { frameIntervalMs: 1000 / 60, refreshRateHz: 60 },
    environment: {
      browser: null,
      operatingSystem: null,
      renderer: null,
      hardwareAccelerated: true,
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 1,
    },
  };
}

async function tempFile(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "animbench-"));
  return join(directory, name);
}

test("records round-trip through the file", async () => {
  const path = await tempFile("runs.ndjson");
  const writer = new NdjsonWriter(path);
  await writer.write(makeRecord(0));
  await writer.write(makeRecord(1));
  await writer.close();

  const { records, malformedLines } = await readNdjson(path);
  assert.deepEqual(malformedLines, []);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.runId, "run-0");
  assert.equal(records[0]?.batchSeed, 42, "the seed must survive, or orderings cannot be replayed");
});

test("writing appends rather than truncating", async () => {
  const path = await tempFile("runs.ndjson");
  const first = new NdjsonWriter(path);
  await first.write(makeRecord(0));
  await first.close();

  const second = new NdjsonWriter(path);
  await second.write(makeRecord(1));
  await second.close();

  const { records } = await readNdjson(path);
  assert.equal(records.length, 2);
});

test("the writer creates missing directories", async () => {
  const base = await tempFile("unused");
  const path = join(base, "..", "nested", "deeper", "runs.ndjson");
  const writer = new NdjsonWriter(path);
  await writer.write(makeRecord(0));
  await writer.close();
  assert.ok((await readFile(path, "utf8")).includes("run-0"));
});

test("damaged lines are reported instead of shortening the data silently", async () => {
  const path = await tempFile("runs.ndjson");
  await writeFile(
    path,
    [
      JSON.stringify(makeRecord(0)),
      "not json at all",
      "",
      JSON.stringify({ schema: 1, runId: "truncated" }),
      JSON.stringify(makeRecord(1)),
    ].join("\n") + "\n",
    "utf8",
  );

  const { records, malformedLines } = await readNdjson(path);
  assert.equal(records.length, 2, "only complete records count");
  // Line 2 is not JSON; line 4 is JSON but not a run record. Line 3 is blank.
  assert.deepEqual(malformedLines, [2, 4]);
});
