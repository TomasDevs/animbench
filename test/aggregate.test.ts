import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateRuns, cpuSamplingOf } from "../src/analysis/aggregate.js";
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

function onDevice(
  record: RunRecord,
  model: string,
  source: "ac" | "battery",
  battery: [number, number] | null = null,
): RunRecord {
  const level = (percent: number | null) => ({
    source,
    batteryPercent: percent,
    batteryState: source === "battery" ? "discharging" : "charged",
  });
  return {
    ...record,
    environment: {
      ...record.environment,
      host: { platform: "test", osVersion: "OS 1", model, cpu: "CPU", cpuCores: 8, memoryGb: 8 },
      power: { start: level(battery?.[0] ?? null), end: level(battery?.[1] ?? null) },
    },
  };
}

test("runs from different devices are never averaged together", () => {
  const slow = Array.from({ length: 30 }, () => 1000 / 30);
  const groups = aggregateRuns([
    onDevice(makeRecord(), "Mac", "ac"),
    onDevice(makeRecord({ intervals: slow }), "Phone", "ac"),
  ]);
  assert.equal(groups.length, 2);
  const mac = groups.find((g) => g.device.model === "Mac");
  const phone = groups.find((g) => g.device.model === "Phone");
  assert.ok(Math.abs((mac?.metrics.meanFps.mean ?? 0) - 60) < 1e-6);
  assert.ok(Math.abs((phone?.metrics.meanFps.mean ?? 0) - 30) < 1e-6);
});

test("mains and battery runs on one device form separate groups", () => {
  const groups = aggregateRuns([
    onDevice(makeRecord(), "Mac", "ac"),
    onDevice(makeRecord(), "Mac", "battery", [92, 90]),
    onDevice(makeRecord(), "Mac", "battery", [90, 87]),
  ]);
  assert.equal(groups.length, 2);
  const battery = groups.find((g) => g.device.power === "battery");
  assert.equal(battery?.runsValid, 2);
  assert.deepEqual(battery?.batteryPercent, { min: 87, max: 92 });
  assert.equal(groups.find((g) => g.device.power === "ac")?.batteryPercent, null);
});

test("records predating the host field still aggregate, under an unknown device", () => {
  const groups = aggregateRuns([makeRecord(), makeRecord()]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.device.model, "unknown");
  assert.equal(groups[0]?.device.power, "unknown");
});

function sampledEvery(record: RunRecord, intervalMs: number, recordInterval: boolean): RunRecord {
  const cpuSamples = Array.from({ length: 12 }, (_, index) => ({
    t: index * intervalMs + (index % 2) * 7, // a little jitter, as in real samples
    mainThread: { taskMs: 0, scriptMs: 0, styleMs: 0, layoutMs: 0 },
    processCpuMs: null,
  }));
  return { ...record, cpuSamples, ...(recordInterval ? { cpuSampleIntervalMs: intervalMs } : {}) };
}

test("sampled and unsampled runs of one combination are kept apart", () => {
  const groups = aggregateRuns([
    makeRecord(),
    makeRecord(),
    sampledEvery(makeRecord(), 1000, true),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.cpuSampleIntervalMs === null)?.runsValid, 2);
  assert.equal(groups.find((g) => g.cpuSampleIntervalMs === 1000)?.runsValid, 1);
});

test("the interval of older records is recovered from sample spacing", () => {
  assert.equal(cpuSamplingOf(sampledEvery(makeRecord(), 1000, false)), 1000);
  assert.equal(cpuSamplingOf(sampledEvery(makeRecord(), 500, false)), 500);
  assert.equal(cpuSamplingOf(makeRecord()), null);
});

test("a failed run of a sampled batch stays with the sampled runs", () => {
  const failed = { ...makeRecord({ valid: false, discardReason: "timeout" }), cpuSampleIntervalMs: 1000 };
  delete failed.timestamps;
  const groups = aggregateRuns([sampledEvery(makeRecord(), 1000, true), failed, makeRecord()]);
  const sampled = groups.find((g) => g.cpuSampleIntervalMs === 1000);
  assert.deepEqual(sampled?.discardReasons, { timeout: 1 });
  assert.deepEqual(groups.find((g) => g.cpuSampleIntervalMs === null)?.discardReasons, {});
});
