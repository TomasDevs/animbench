import { test } from "node:test";
import assert from "node:assert/strict";
import { isBenchResult, validateBenchResult } from "../src/types/contract.js";

const validResult = {
  timestamps: [0, 16.7, 33.4],
  baseline: { frameIntervalMs: 1000 / 60, refreshRateHz: 60 },
  meta: { technique: "raf" },
  startTime: 0,
  endTime: 33.4,
  overflowed: false,
};

function problemsFor(value: unknown): string[] {
  return validateBenchResult(value).map((violation) => violation.path);
}

test("a well-formed result passes", () => {
  assert.deepEqual(validateBenchResult(validResult), []);
  assert.ok(isBenchResult(validResult));
});

test("non-objects are rejected outright", () => {
  for (const value of [null, undefined, 42, "result", []]) {
    assert.ok(validateBenchResult(value).length > 0, `${String(value)} must be rejected`);
  }
});

test("every missing field is reported, not just the first", () => {
  const paths = problemsFor({});
  for (const expected of ["timestamps", "baseline", "meta", "startTime", "endTime", "overflowed"]) {
    assert.ok(paths.includes(expected), `expected a violation for ${expected}`);
  }
});

test("timestamps must be at least two finite numbers", () => {
  assert.deepEqual(problemsFor({ ...validResult, timestamps: [1] }), ["timestamps"]);
  assert.deepEqual(problemsFor({ ...validResult, timestamps: [1, Number.NaN] }), ["timestamps"]);
  assert.deepEqual(problemsFor({ ...validResult, timestamps: [1, Infinity] }), ["timestamps"]);
  assert.deepEqual(problemsFor({ ...validResult, timestamps: "nope" }), ["timestamps"]);
});

test("baseline fields must be positive, since the budget derives from them", () => {
  const bad = (baseline: unknown) => problemsFor({ ...validResult, baseline });
  assert.deepEqual(bad({ frameIntervalMs: 0, refreshRateHz: 60 }), ["baseline.frameIntervalMs"]);
  assert.deepEqual(bad({ frameIntervalMs: -1, refreshRateHz: 60 }), ["baseline.frameIntervalMs"]);
  assert.deepEqual(bad({ frameIntervalMs: 16.7, refreshRateHz: 0 }), ["baseline.refreshRateHz"]);
  assert.deepEqual(bad({ frameIntervalMs: 16.7 }), ["baseline.refreshRateHz"]);
  assert.deepEqual(bad(undefined), ["baseline"]);
});

test("optional baseline samples are checked when present", () => {
  const withSamples = (samples: unknown) =>
    problemsFor({ ...validResult, baseline: { ...validResult.baseline, samples } });
  assert.deepEqual(withSamples([16.7, 16.6]), []);
  assert.deepEqual(withSamples(undefined), []);
  assert.deepEqual(withSamples("nope"), ["baseline.samples"]);
  assert.deepEqual(withSamples([1, "two"]), ["baseline.samples"]);
});

test("overflowed must be an explicit boolean", () => {
  assert.deepEqual(problemsFor({ ...validResult, overflowed: undefined }), ["overflowed"]);
  assert.deepEqual(problemsFor({ ...validResult, overflowed: "false" }), ["overflowed"]);
  assert.deepEqual(validateBenchResult({ ...validResult, overflowed: true }), []);
});

test("meta accepts any shape the page chooses to report", () => {
  assert.deepEqual(validateBenchResult({ ...validResult, meta: {} }), []);
  assert.deepEqual(
    validateBenchResult({ ...validResult, meta: { technique: "css", nested: { seed: 42 } } }),
    [],
  );
  assert.deepEqual(problemsFor({ ...validResult, meta: null }), ["meta"]);
});
