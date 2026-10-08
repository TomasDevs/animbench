import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGpuStatus } from "../src/diagnostics/gpu.js";

// Feature status and renderer as SystemInfo.getInfo reported them on an Apple M3.
const metal = "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Version 15.6.1 (Build 24G90))";
const swiftShader = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver-5.0.0)";

test("a visible window on the GPU passes", () => {
  const status = evaluateGpuStatus({ gpu_compositing: "enabled", rasterization: "enabled" }, metal);
  assert.equal(status.accelerated, true);
  assert.deepEqual(status.missing, []);
});

test("headless software rendering fails on both features and the renderer", () => {
  const status = evaluateGpuStatus(
    { gpu_compositing: "disabled_software", rasterization: "disabled_software" },
    swiftShader,
  );
  assert.equal(status.accelerated, false);
  assert.equal(status.missing.length, 3);
});

test("forced-on statuses count as enabled", () => {
  assert.equal(
    evaluateGpuStatus({ gpu_compositing: "enabled_on", rasterization: "enabled_force" }, metal).accelerated,
    true,
  );
});

test("a missing feature status is a failure, not a pass", () => {
  assert.equal(evaluateGpuStatus({}, metal).accelerated, false);
});

test("a software renderer fails even if features claim acceleration", () => {
  const status = evaluateGpuStatus({ gpu_compositing: "enabled", rasterization: "enabled" }, swiftShader);
  assert.equal(status.accelerated, false);
});
