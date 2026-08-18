import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateRuns } from "../src/analysis/aggregate.js";
import type { DiscardReason, RunRecord } from "../src/types/record.js";

interface Options {
  batchId?: string;
  combination?: Record<string, string>;
  intervals?: number[];
  valid?: boolean;
  discardReason?: DiscardReason;
}

function makeRecord(options: Options = {}): RunRecord {
  const intervals = options.intervals ?? Array.from({ length: 30 }, () => 1000 / 60);
  const timestamps = [0];
  for (const gap of intervals) timestamps.push((timestamps.at(-1) as number) + gap);

  const record: RunRecord = {
    schema: 1,
    runId: Math.random().toString(36).slice(2),
    batchId: options.batchId ?? "batch-1",
    recordedAt: "2026-08-18T00:00:00.000Z",
    url: "http://example/",
    combination: options.combination ?? { technique: "raf" },
    repetition: 0,
    sequence: 0,
    valid: options.valid ?? true,
    timestamps,
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
  if (options.discardReason) record.discardReason = options.discardReason;
  return record;
}

test("runs are grouped by combination regardless of key order", () => {
  const groups = aggregateRuns([
    makeRecord({ combination: { technique: "raf", complexity: "500" } }),
    makeRecord({ combination: { complexity: "500", technique: "raf" } }),
    makeRecord({ combination: { technique: "css-transition", complexity: "500" } }),
  ]);
  assert.equal(groups.length, 2);
  const raf = groups.find((g) => g.combination["technique"] === "raf");
  assert.equal(raf?.runsValid, 2);
});

test("aggregation restricted to one batch ignores earlier ones", () => {
  const records = [
    makeRecord({ batchId: "old", intervals: Array.from({ length: 30 }, () => 1000 / 30) }),
    makeRecord({ batchId: "new" }),
    makeRecord({ batchId: "new" }),
  ];

  const all = aggregateRuns(records);
  assert.equal(all[0]?.runsValid, 3, "without a filter every batch is counted");

  const scoped = aggregateRuns(records, { batchId: "new" });
  assert.equal(scoped[0]?.runsValid, 2);
  // The slow "old" run must not drag the average down.
  assert.ok(Math.abs((scoped[0]?.metrics.meanFps.mean ?? 0) - 60) < 1e-6);
});

test("an unknown batch id yields no groups rather than everything", () => {
  assert.deepEqual(aggregateRuns([makeRecord()], { batchId: "absent" }), []);
});

test("warm-up runs are separated from real discards", () => {
  const groups = aggregateRuns([
    makeRecord(),
    makeRecord({ valid: false, discardReason: "warmup" }),
    makeRecord({ valid: false, discardReason: "overflowed" }),
    makeRecord({ valid: false, discardReason: "page-error" }),
  ]);

  const group = groups[0];
  assert.ok(group);
  assert.equal(group.runsValid, 1);
  assert.equal(group.runsWarmup, 1);
  assert.equal(group.runsDiscarded, 2, "warm-ups must not count as failures");
  assert.deepEqual(group.discardReasons, { overflowed: 1, "page-error": 1 });
  assert.equal(group.runsTotal, 4);
});

test("a group with no valid runs still reports why they were lost", () => {
  const groups = aggregateRuns([
    makeRecord({ valid: false, discardReason: "timeout" }),
    makeRecord({ valid: false, discardReason: "timeout" }),
  ]);
  const group = groups[0];
  assert.ok(group);
  assert.equal(group.runsValid, 0);
  assert.deepEqual(group.discardReasons, { timeout: 2 });
  assert.ok(Number.isNaN(group.metrics.meanFps.mean));
});

test("discarded runs never contribute measurements", () => {
  // A discarded run carries timestamps; they must be excluded anyway.
  const groups = aggregateRuns([
    makeRecord(),
    makeRecord({ valid: false, discardReason: "overflowed", intervals: Array.from({ length: 30 }, () => 1000 / 10) }),
  ]);
  assert.ok(Math.abs((groups[0]?.metrics.meanFps.mean ?? 0) - 60) < 1e-6);
});
