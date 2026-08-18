import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCsv } from "../src/output/csv.js";
import { aggregateRuns } from "../src/analysis/aggregate.js";
import type { RunRecord } from "../src/types/record.js";

function makeRecord(combination: Record<string, string>, valid = true): RunRecord {
  const timestamps = [0];
  for (let i = 0; i < 30; i++) timestamps.push((timestamps.at(-1) as number) + 1000 / 60);
  const record: RunRecord = {
    schema: 1,
    runId: Math.random().toString(36).slice(2),
    batchId: "b",
    recordedAt: "2026-08-18T00:00:00.000Z",
    url: "http://example/",
    combination,
    repetition: 0,
    sequence: 0,
    valid,
    timestamps,
    baseline: { frameIntervalMs: 1000 / 60, refreshRateHz: 60 },
    meta: { note: "ignored by the CSV" },
    environment: {
      browser: null,
      operatingSystem: null,
      renderer: null,
      hardwareAccelerated: true,
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 1,
    },
  };
  if (!valid) record.discardReason = "overflowed";
  return record;
}

/** Minimal RFC 4180 reader, so the test does not trust the writer's own rules. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

test("columns are derived from the data, not a fixed list", () => {
  const csv = buildCsv(aggregateRuns([makeRecord({ technique: "raf", scene: "grid" })]));
  const [header] = parseCsv(csv);
  assert.ok(header);
  assert.equal(header[0], "scene", "parameter columns come first, sorted");
  assert.equal(header[1], "technique");
  assert.ok(header.includes("meanFps_mean"));
  assert.ok(header.includes("runsWarmup"));
});

test("every row has exactly as many fields as the header", () => {
  const csv = buildCsv(
    aggregateRuns([
      makeRecord({ technique: "raf" }),
      makeRecord({ technique: "css" }),
      makeRecord({ technique: "css" }, false),
    ]),
  );
  const rows = parseCsv(csv);
  const width = rows[0]?.length;
  assert.ok(width && width > 10);
  for (const row of rows.slice(1)) assert.equal(row.length, width);
});

test("values containing separators survive a round trip", () => {
  const csv = buildCsv(aggregateRuns([makeRecord({ label: 'a,b "quoted"' })]));
  const rows = parseCsv(csv);
  assert.equal(rows[1]?.[0], 'a,b "quoted"');
});

test("page-reported meta never reaches the CSV", () => {
  const csv = buildCsv(aggregateRuns([makeRecord({ technique: "raf" })]));
  assert.ok(!csv.includes("ignored by the CSV"));
});

test("discard reasons are reported per row", () => {
  const csv = buildCsv(aggregateRuns([makeRecord({ technique: "css" }, false)]));
  const rows = parseCsv(csv);
  const column = rows[0]?.indexOf("discardReasons") ?? -1;
  assert.ok(column >= 0);
  assert.equal(rows[1]?.[column], "overflowed:1");
});

test("non-finite aggregates become empty cells rather than NaN", () => {
  const csv = buildCsv(aggregateRuns([makeRecord({ technique: "css" }, false)]));
  assert.ok(!csv.includes("NaN"));
});
