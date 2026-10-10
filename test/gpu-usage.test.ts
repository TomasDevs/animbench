import { test } from "node:test";
import assert from "node:assert/strict";
import { openForBatch, parseIoregUtilization, parseTypeperfLine } from "../src/diagnostics/gpu-usage.js";
import { computeCpuMetrics } from "../src/analysis/cpu.js";
import type { CpuSample } from "../src/types/record.js";

test("macOS utilisation is read from the accelerator statistics", () => {
  // Shape of `ioreg -c IOAccelerator` on an Apple M3.
  const ioreg = '"PerformanceStatistics" = {"Tiler Utilization %"=13,"Renderer Utilization %"=13,"Device Utilization %"=29}';
  assert.equal(parseIoregUtilization(ioreg), 29);
  assert.equal(parseIoregUtilization("no accelerator"), null);
});

test("Windows utilisation sums the 3D engines of the browser's GPU process only", () => {
  const header = [
    '"(PDH-CSV 4.0)"',
    '"\\\\PC\\GPU Engine(pid_4120_luid_0x00000000_0x0000D1B6_phys_0_eng_0_engtype_3D)\\Utilization Percentage"',
    '"\\\\PC\\GPU Engine(pid_4120_luid_0x00000000_0x0000D1B6_phys_0_eng_1_engtype_3D)\\Utilization Percentage"',
    '"\\\\PC\\GPU Engine(pid_4120_luid_0x00000000_0x0000D1B6_phys_0_eng_2_engtype_VideoDecode)\\Utilization Percentage"',
    '"\\\\PC\\GPU Engine(pid_9001_luid_0x00000000_0x0000D1B6_phys_0_eng_0_engtype_3D)\\Utilization Percentage"',
  ].join(",");
  const line = '"10/10/2026 14:00:01.123","12.5","3.5","40.0","55.0"';
  assert.equal(parseTypeperfLine(header, line, 4120), 16);
  assert.equal(parseTypeperfLine(header, line, 9001), 55);
  assert.equal(parseTypeperfLine(header, line, 7777), null, "a process with no 3D engine has no reading");
});

test("a phone never gets a reader for the computer's GPU", async () => {
  assert.deepEqual(await openForBatch("android", true, null), { reader: null, available: false });
  assert.deepEqual(await openForBatch("desktop", false, null), { reader: null, available: false });
});

test("GPU utilisation is averaged over the readings inside the window", () => {
  const samples: CpuSample[] = [0, 1000, 2000, 3000, 4000].map((t, index) => ({
    t,
    mainThread: { taskMs: t * 0.5, scriptMs: 0, styleMs: 0, layoutMs: 0 },
    processCpuMs: null,
    gpuUtilization: [90, 20, 40, 60, 90][index] as number,
  }));
  // The window 1000–3000 holds the readings 20, 40 and 60; the 90s are outside.
  assert.ok(Math.abs(computeCpuMetrics(samples, 1000, 3000).gpuBusyRatio - 0.4) < 1e-9);
  const without = samples.map(({ gpuUtilization, ...rest }) => rest);
  assert.ok(Number.isNaN(computeCpuMetrics(without, 1000, 3000).gpuBusyRatio));
});

test("GPU load above idle subtracts the run's own still-scene reading", async () => {
  const { computeRunMetrics } = await import("../src/analysis/metrics.js");
  const timestamps = Array.from({ length: 300 }, (_, i) => i * (1000 / 60));
  const cpuSamples = [0, 1000, 2000, 3000, 4000, 5000].map((t) => ({
    t,
    mainThread: { taskMs: 0, scriptMs: 0, styleMs: 0, layoutMs: 0 },
    processCpuMs: null,
    gpuUtilization: 30,
  }));
  const record = {
    schema: 1 as const, runId: "r", batchId: "b", recordedAt: "", url: "", combination: {},
    repetition: 0, sequence: 0, valid: true, timestamps, cpuSamples, gpuIdleUtilization: 12,
    baseline: { frameIntervalMs: 1000 / 60, refreshRateHz: 60 },
    environment: { browser: null, operatingSystem: null, renderer: null, hardwareAccelerated: true, viewport: { width: 1, height: 1 }, devicePixelRatio: 1 },
  };
  const metrics = computeRunMetrics(record)!;
  assert.ok(Math.abs(metrics.gpuBusyRatio - 0.3) < 1e-9);
  assert.ok(Math.abs(metrics.gpuIdleRatio - 0.12) < 1e-9);
  assert.ok(Math.abs(metrics.gpuExtraRatio - 0.18) < 1e-9);

  const { gpuIdleUtilization, ...withoutIdle } = record;
  assert.ok(Number.isNaN(computeRunMetrics(withoutIdle)!.gpuExtraRatio), "no idle reading, no difference");
});
