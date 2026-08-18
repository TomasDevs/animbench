import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRunMetrics } from "../src/analysis/metrics.js";
import type { RunRecord } from "../src/types/record.js";

function makeRecord(intervals: number[], baseline?: Partial<RunRecord["baseline"]>): RunRecord {
  const timestamps = [0];
  for (const gap of intervals) timestamps.push((timestamps.at(-1) as number) + gap);
  return {
    schema: 1,
    runId: "r",
    batchId: "b",
    recordedAt: "2026-08-18T00:00:00.000Z",
    url: "http://example/",
    combination: {},
    repetition: 0,
    sequence: 0,
    valid: true,
    timestamps,
    baseline: { frameIntervalMs: 1000 / 60, refreshRateHz: 60, ...baseline },
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

test("budget comes from the measured baseline, not a fixed 16.7 ms", () => {
  const at75 = computeRunMetrics(makeRecord([13.3, 13.3], { frameIntervalMs: 1000 / 75, refreshRateHz: 75 }));
  assert.ok(at75);
  assert.ok(Math.abs(at75.budgetMs - 13.3333) < 1e-3);
  assert.equal(at75.refreshRateHz, 75);

  const at144 = computeRunMetrics(makeRecord([6.9, 6.9], { frameIntervalMs: 1000 / 144, refreshRateHz: 144 }));
  assert.ok(at144);
  assert.ok(Math.abs(at144.budgetMs - 6.944) < 1e-3);
});

test("frames over budget counts only gaps beyond the 1.5x tolerance", () => {
  const budget = 1000 / 60;
  // Jitter just above budget must not count; a doubled frame must.
  const metrics = computeRunMetrics(makeRecord([budget, budget * 1.2, budget * 2, budget * 1.4]));
  assert.ok(metrics);
  assert.equal(metrics.framesOverBudget, 1);
  assert.ok(Math.abs(metrics.framesOverBudgetRatio - 0.25) < 1e-9);
});

test("low-percentile FPS is derived from high-percentile intervals", () => {
  // 100 frames at 60 Hz with three 50 ms stalls.
  const budget = 1000 / 60;
  const intervals = Array.from({ length: 100 }, (_, i) => (i % 33 === 32 ? 50 : budget));
  const metrics = computeRunMetrics(makeRecord(intervals));
  assert.ok(metrics);

  assert.equal(metrics.framesOverBudget, 3);
  assert.ok(Math.abs(metrics.maxIntervalMs - 50) < 1e-9);
  assert.ok(Math.abs(metrics.medianIntervalMs - budget) < 1e-9);
  // The worst 1 % of frames are the 50 ms ones, so p1Fps must be 1000/50 = 20.
  assert.ok(Math.abs(metrics.p99IntervalMs - 50) < 1e-9);
  assert.ok(Math.abs(metrics.p1Fps - 20) < 1e-9);
  assert.ok(metrics.p1Fps < metrics.p5Fps, "p1 must be worse than p5");
  // With only 3 stalls in 100 frames the 95th percentile is still a clean
  // frame, so p5Fps sits above the mean, which the stalls drag down. The
  // percentiles describe the tail, not a bound on the average.
  assert.ok(Math.abs(metrics.p5Fps - 60) < 1e-6);
  assert.ok(metrics.meanFps < metrics.p5Fps);
});

test("p5Fps tracks the tail once stalls exceed 5 percent of frames", () => {
  const budget = 1000 / 60;
  // 10 stalls in 100 frames: now both the 95th and 99th percentile are stalls.
  const intervals = Array.from({ length: 100 }, (_, i) => (i % 10 === 9 ? 50 : budget));
  const metrics = computeRunMetrics(makeRecord(intervals));
  assert.ok(metrics);
  assert.equal(metrics.framesOverBudget, 10);
  assert.ok(Math.abs(metrics.p5Fps - 20) < 1e-6, "p5 must now reflect the stalls");
  assert.ok(metrics.p5Fps < metrics.meanFps, "the tail is now worse than the mean");
});

test("a run at exactly the refresh rate reports refreshRatio of 1", () => {
  const metrics = computeRunMetrics(makeRecord(Array.from({ length: 60 }, () => 1000 / 60)));
  assert.ok(metrics);
  assert.ok(Math.abs(metrics.refreshRatio - 1) < 1e-9);
  assert.equal(metrics.framesOverBudget, 0);
});

test("every other frame dropped reads as half the refresh rate", () => {
  // The pattern reported from the demo app: median exactly double the budget.
  const metrics = computeRunMetrics(makeRecord(Array.from({ length: 60 }, () => 1000 / 30)));
  assert.ok(metrics);
  assert.ok(Math.abs(metrics.medianIntervalMs - 33.333) < 1e-2);
  assert.ok(Math.abs(metrics.meanFps - 30) < 1e-6);
  assert.ok(Math.abs(metrics.refreshRatio - 0.5) < 1e-6);
  // Uniform double-length frames: every one is over budget, none is an outlier.
  assert.equal(metrics.framesOverBudget, 60);
  assert.ok(Math.abs(metrics.stdDevIntervalMs) < 1e-9);
});

test("runs without usable timestamps yield no metrics", () => {
  const record = makeRecord([16.7]);
  record.timestamps = [1];
  assert.equal(computeRunMetrics(record), null);

  const withoutTimestamps: RunRecord = { ...record };
  delete withoutTimestamps.timestamps;
  assert.equal(computeRunMetrics(withoutTimestamps), null);
});
