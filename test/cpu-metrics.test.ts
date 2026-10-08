import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCpuMetrics, counterAt } from "../src/analysis/cpu.js";
import type { CpuSample } from "../src/types/record.js";

/**
 * Samples every 500 ms from t=0 to t=10 000 with the main thread busy at a
 * fixed share: half of it styles, a tenth script, the rest unclassified.
 */
function samplesAt(busyShare: number, gpuShare = 0.4): CpuSample[] {
  return Array.from({ length: 21 }, (_, index) => {
    const t = index * 500;
    const task = t * busyShare;
    return {
      t,
      mainThread: { taskMs: task, scriptMs: task * 0.1, styleMs: task * 0.5, layoutMs: 0 },
      processCpuMs: { renderer: t * 1.3, gpu: t * gpuShare },
    };
  });
}

const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test("counters are interpolated between samples", () => {
  const samples = samplesAt(0.6);
  // 1250 ms lies between the samples at 1000 and 1500.
  near(counterAt(samples, 1250, (s) => s.mainThread.taskMs), 1250 * 0.6);
  assert.ok(Number.isNaN(counterAt(samples, 20_000, (s) => s.mainThread.taskMs)));
});

test("shares are measured over the given span only", () => {
  // The edges fall between samples on purpose.
  const metrics = computeCpuMetrics(samplesAt(0.6), 3_120, 7_870);
  near(metrics.mainThreadBusyRatio, 0.6);
  near(metrics.mainThreadStyleRatio, 0.3);
  near(metrics.mainThreadScriptRatio, 0.06);
  near(metrics.mainThreadLayoutRatio, 0);
  near(metrics.mainThreadOtherRatio, 0.24);
  near(metrics.rendererCpuRatio, 1.3);
  near(metrics.gpuProcessCpuRatio, 0.4);
  assert.equal(metrics.cpuSampleCount, 9);
});

test("a ramp outside the span does not leak into it", () => {
  // Idle for the first 5 s, then busy at 80 %.
  const samples = samplesAt(0).map((sample) => {
    const busy = Math.max(0, sample.t - 5_000) * 0.8;
    return { ...sample, mainThread: { taskMs: busy, scriptMs: 0, styleMs: 0, layoutMs: 0 } };
  });
  near(computeCpuMetrics(samples, 6_000, 10_000).mainThreadBusyRatio, 0.8);
  near(computeCpuMetrics(samples, 0, 10_000).mainThreadBusyRatio, 0.4);
});

test("a span the samples do not cover is reported as unavailable", () => {
  const samples = samplesAt(0.5);
  assert.ok(Number.isNaN(computeCpuMetrics(samples, -100, 5_000).mainThreadBusyRatio));
  assert.ok(Number.isNaN(computeCpuMetrics(samples, 5_000, 12_000).mainThreadBusyRatio));
  assert.ok(Number.isNaN(computeCpuMetrics(undefined, 0, 1_000).mainThreadBusyRatio));
  assert.ok(Number.isNaN(computeCpuMetrics(samples.slice(0, 1), 0, 0).mainThreadBusyRatio));
  assert.equal(computeCpuMetrics(undefined, 0, 1_000).cpuSampleCount, 0);
});
