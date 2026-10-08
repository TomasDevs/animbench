import { test } from "node:test";
import assert from "node:assert/strict";
import { toCpuSample } from "../src/runner/cpu-sampler.js";

const metrics = [
  { name: "Timestamp", value: 1000.5 },
  { name: "TaskDuration", value: 2.5 },
  { name: "ScriptDuration", value: 0.1 },
  { name: "RecalcStyleDuration", value: 0.75 },
  { name: "LayoutDuration", value: 0 },
];

test("CDP seconds become milliseconds on the page clock", () => {
  const sample = toCpuSample(metrics, [], -1_000_000);
  assert.equal(sample.t, 1000.5 * 1000 - 1_000_000);
  assert.equal(sample.mainThread.taskMs, 2500);
  assert.equal(sample.mainThread.scriptMs, 100);
  assert.equal(sample.mainThread.styleMs, 750);
  assert.equal(sample.mainThread.layoutMs, 0);
});

test("process CPU time is summed per process type", () => {
  const sample = toCpuSample(
    metrics,
    [
      { type: "browser", cpuTime: 9 },
      { type: "renderer", cpuTime: 1.5 },
      { type: "renderer", cpuTime: 0.25 },
      { type: "GPU", cpuTime: 3 },
      { type: "utility", cpuTime: 7 },
    ],
    0,
  );
  assert.equal(sample.processCpuMs.renderer, 1750);
  assert.equal(sample.processCpuMs.gpu, 3000);
});

test("a counter missing from the response reads as zero rather than NaN", () => {
  const sample = toCpuSample([{ name: "Timestamp", value: 1 }], [], 0);
  assert.equal(sample.mainThread.taskMs, 0);
  assert.equal(sample.processCpuMs.gpu, 0);
});
