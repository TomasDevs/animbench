import { test } from "node:test";
import assert from "node:assert/strict";
import { checkQuality, powerBlocker } from "../src/runner/quality.js";
import type { RunRecord } from "../src/types/record.js";

function makeRecord(refreshRateHz: number, frames: number, window?: [number, number]): RunRecord {
  const timestamps = Array.from({ length: frames }, (_, i) => i * (1000 / 60));
  return {
    schema: 1, runId: "r", batchId: "b", recordedAt: "2026-10-10T00:00:00.000Z", url: "http://example/",
    combination: {}, repetition: 0, sequence: 0, valid: true, timestamps,
    baseline: { frameIntervalMs: 1000 / refreshRateHz, refreshRateHz },
    ...(window ? { meta: { steadyStateFromMs: window[0], steadyStateToMs: window[1] } } : {}),
    environment: { browser: null, operatingSystem: null, renderer: null, hardwareAccelerated: true, viewport: { width: 1, height: 1 }, devicePixelRatio: 1 },
  };
}

test("no rules set means nothing is discarded", () => {
  assert.equal(checkQuality(makeRecord(30, 5), {}), null);
});

test("refresh within ten percent passes, beyond it is discarded", () => {
  const rules = { expectedRefreshRateHz: 60 };
  assert.equal(checkQuality(makeRecord(59.88, 200), rules), null);
  assert.equal(checkQuality(makeRecord(54.1, 200), rules), null);
  const slow = checkQuality(makeRecord(50, 200), rules);
  assert.equal(slow?.reason, "refresh-mismatch");
  assert.match(slow?.detail ?? "", /50\.0 Hz.*60 Hz.*16\.7 %/);
  assert.equal(checkQuality(makeRecord(120, 200), rules)?.reason, "refresh-mismatch");
});

test("a custom tolerance replaces the default", () => {
  assert.equal(checkQuality(makeRecord(57, 200), { expectedRefreshRateHz: 60, refreshTolerance: 0.02 })?.reason, "refresh-mismatch");
});

test("frames are counted inside the measured window, not over the whole run", () => {
  // 300 frames recorded, but only about 60 of them fall within the window.
  const record = makeRecord(60, 300, [1000, 2000]);
  assert.equal(checkQuality(record, { minFramesInWindow: 100 })?.reason, "too-few-frames");
  assert.equal(checkQuality(makeRecord(60, 300), { minFramesInWindow: 100 }), null);
});

test("runs already discarded are left with their original reason", () => {
  const warmup = { ...makeRecord(30, 5), valid: false, discardReason: "warmup" as const };
  assert.equal(checkQuality(warmup, { expectedRefreshRateHz: 60, minFramesInWindow: 100 }), null);
});

const power = (source: "ac" | "battery" | "unknown", batteryPercent: number | null) => ({
  source,
  batteryPercent,
  batteryState: null,
});

test("the batch stops when the power source is not the required one", () => {
  assert.equal(powerBlocker(power("ac", 100), { requirePowerSource: "ac" }), null);
  assert.match(powerBlocker(power("battery", 95), { requirePowerSource: "ac" }) ?? "", /requires mains.*runs on battery/);
  assert.match(powerBlocker(power("ac", 100), { requirePowerSource: "battery" }) ?? "", /requires battery/);
  assert.equal(powerBlocker(power("battery", 30), {}), null, "no rule, no stop");
});

test("the batch stops once the battery falls below the floor", () => {
  const rules = { requirePowerSource: "battery" as const, minBatteryPercent: 80 };
  assert.equal(powerBlocker(power("battery", 80), rules), null);
  assert.match(powerBlocker(power("battery", 79), rules) ?? "", /79 %, below the 80 %/);
  assert.match(powerBlocker(power("battery", null), rules) ?? "", /cannot be read/);
});

test("a run during which the charger was pulled is discarded", () => {
  const record = makeRecord(60, 300);
  record.environment.power = { start: power("ac", 100), end: power("battery", 100) };
  assert.equal(checkQuality(record, { requirePowerSource: "ac" })?.reason, "power-changed");
  record.environment.power = { start: power("ac", 100), end: power("ac", 100) };
  assert.equal(checkQuality(record, { requirePowerSource: "ac" }), null);
});
