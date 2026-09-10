import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_SAMPLES, computeRunMetrics } from "../src/analysis/metrics.js";
import { readSteadyStateWindow } from "../src/types/contract.js";
import type { RunRecord } from "../src/types/record.js";

/**
 * Builds a run whose load ramps up, holds, then winds down — the bell-shaped
 * profile a staggered scene produces.
 */
function makeRampedRecord(meta: Record<string, unknown> = {}): RunRecord {
  const timestamps: number[] = [];
  let clock = 0;
  const push = (interval: number, count: number) => {
    for (let i = 0; i < count; i++) {
      timestamps.push(clock);
      clock += interval;
    }
  };
  push(16.7, 30); // ramp-up: light load, full rate
  push(50, 40); // steady state: heavy load
  push(16.7, 30); // wind-down: light again
  timestamps.push(clock);

  const steadyFrom = 30 * 16.7;
  const steadyTo = steadyFrom + 40 * 50;

  return {
    schema: 1,
    runId: "r",
    batchId: "b",
    recordedAt: "2026-09-10T00:00:00.000Z",
    url: "http://example/",
    combination: {},
    repetition: 0,
    sequence: 0,
    valid: true,
    timestamps,
    baseline: { frameIntervalMs: 1000 / 60, refreshRateHz: 60 },
    meta: { steadyStateFromMs: steadyFrom, steadyStateToMs: steadyTo, ...meta },
    environment: {
      browser: null,
      operatingSystem: null,
      renderer: null,
      hardwareAccelerated: true,
      viewport: { width: 1280, height: 720 },
      devicePixelRatio: 1,
    },
  };
}

test("a declared window is read, malformed ones are ignored", () => {
  assert.deepEqual(readSteadyStateWindow({ steadyStateFromMs: 100, steadyStateToMs: 500 }), {
    fromMs: 100,
    toMs: 500,
  });
  assert.equal(readSteadyStateWindow(undefined), null);
  assert.equal(readSteadyStateWindow({}), null);
  assert.equal(readSteadyStateWindow({ steadyStateFromMs: 100 }), null);
  assert.equal(readSteadyStateWindow({ steadyStateFromMs: "100", steadyStateToMs: 500 }), null);
  assert.equal(readSteadyStateWindow({ steadyStateFromMs: 500, steadyStateToMs: 100 }), null, "reversed");
  assert.equal(readSteadyStateWindow({ steadyStateFromMs: 100, steadyStateToMs: 100 }), null, "empty");
  assert.equal(readSteadyStateWindow({ steadyStateFromMs: Number.NaN, steadyStateToMs: 500 }), null);
});

test("metrics describe the steady state, not the ramp", () => {
  const metrics = computeRunMetrics(makeRampedRecord());
  assert.ok(metrics);
  assert.ok(metrics.trimmed);
  // Inside the window every frame is 50 ms, so the whole distribution is flat.
  assert.ok(Math.abs(metrics.medianIntervalMs - 50) < 1e-6);
  assert.ok(Math.abs(metrics.meanIntervalMs - 50) < 1e-6);
  assert.ok(metrics.stdDevIntervalMs < 1e-6, "a trimmed steady state must be flat");
  assert.ok(Math.abs(metrics.meanFps - 20) < 1e-6);
});

test("without a window the ramp drags the average toward the middle", () => {
  const untrimmed = computeRunMetrics(makeRampedRecord({ steadyStateFromMs: undefined, steadyStateToMs: undefined }));
  assert.ok(untrimmed);
  assert.equal(untrimmed.trimmed, false);
  // Mixing 16.7 ms and 50 ms frames lands between the two and spreads wide.
  assert.ok(untrimmed.meanIntervalMs > 20 && untrimmed.meanIntervalMs < 45);
  assert.ok(untrimmed.stdDevIntervalMs > 10, "the unmeasured ramp shows up as spread");
});

test("the trimmed share is reported so a narrowed run is visible", () => {
  const metrics = computeRunMetrics(makeRampedRecord());
  assert.ok(metrics);
  assert.equal(metrics.recordedFrameCount, 101);
  assert.equal(metrics.frameCount, 40, "the frames inside the window");
  assert.ok(Math.abs(metrics.trimmedRatio - 61 / 101) < 1e-6);
});

test("a window leaving too little to measure falls back to the whole run", () => {
  // A window covering a single frame cannot yield percentiles.
  const record = makeRampedRecord({ steadyStateFromMs: 0, steadyStateToMs: 20 });
  const metrics = computeRunMetrics(record);
  assert.ok(metrics);
  assert.equal(metrics.trimmed, false, "falling back beats reporting one interval");
  assert.equal(metrics.frameCount, metrics.recordedFrameCount);
});

test("runs without a window keep behaving exactly as before", () => {
  const record = makeRampedRecord();
  delete record.meta;
  const metrics = computeRunMetrics(record);
  assert.ok(metrics);
  assert.equal(metrics.trimmed, false);
  assert.equal(metrics.trimmedRatio, 0);
  assert.equal(metrics.frameCount, metrics.recordedFrameCount);
});

test("percentiles the sample count cannot support are flagged", () => {
  const build = (frames: number) => {
    const record = makeRampedRecord();
    const timestamps = Array.from({ length: frames }, (_, i) => 1000 + i * 50);
    record.timestamps = timestamps;
    record.meta = {
      steadyStateFromMs: timestamps[0],
      steadyStateToMs: timestamps[timestamps.length - 1],
    };
    return computeRunMetrics(record);
  };

  // Below both thresholds: neither percentile means anything.
  const thin = build(40);
  assert.ok(thin);
  assert.deepEqual(thin.unreliablePercentiles, ["p5Fps", "p1Fps"]);

  // p95 settles first, so only the deeper percentile stays flagged.
  const middle = build(MIN_SAMPLES.p95 + 20);
  assert.ok(middle);
  assert.deepEqual(middle.unreliablePercentiles, ["p1Fps"]);

  const ample = build(MIN_SAMPLES.p99 + 50);
  assert.ok(ample);
  assert.deepEqual(ample.unreliablePercentiles, []);
});
