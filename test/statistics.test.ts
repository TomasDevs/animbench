import { test } from "node:test";
import assert from "node:assert/strict";
import { frameIntervals, mean, percentile, standardDeviation } from "../src/analysis/statistics.js";

test("percentile interpolates between order statistics (R-7)", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile(values, 1), 10);
  assert.equal(percentile(values, 0.5), 5.5);
  // Verified against NumPy's default: np.percentile(range(1,11), 95) == 9.55
  assert.ok(Math.abs(percentile(values, 0.95) - 9.55) < 1e-9);
  assert.ok(Math.abs(percentile(values, 0.99) - 9.91) < 1e-9);
});

test("percentile handles degenerate inputs", () => {
  assert.ok(Number.isNaN(percentile([], 0.5)));
  assert.equal(percentile([42], 0.5), 42);
  assert.equal(percentile([42], 0.99), 42);
  assert.equal(percentile([7, 7, 7], 0.5), 7);
});

test("mean and standardDeviation use the sample definition", () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.ok(Number.isNaN(mean([])));
  // Sample sd (n-1) of [2,4,4,4,5,5,7,9] is 2.13809..., population sd would be 2.
  assert.ok(Math.abs(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138089935) < 1e-8);
  assert.equal(standardDeviation([5, 5, 5]), 0);
  assert.ok(Number.isNaN(standardDeviation([1])));
});

test("frameIntervals returns gaps, one fewer than timestamps", () => {
  assert.deepEqual(frameIntervals([0, 10, 25, 30]), [10, 15, 5]);
  assert.deepEqual(frameIntervals([5]), []);
  assert.deepEqual(frameIntervals([]), []);
});
