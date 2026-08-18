import { test } from "node:test";
import assert from "node:assert/strict";
import { planBatch } from "../src/runner/batch.js";
import { buildRunUrl, expandMatrix, type BenchConfig } from "../src/types/config.js";

interface BatchOverrides {
  repetitions?: number;
  warmupRuns?: number;
  shuffle?: boolean;
  /** Explicitly nullable: a missing seed is a distinct case worth testing. */
  seed?: number | undefined;
}

function makeConfig(overrides: BatchOverrides = {}): BenchConfig {
  return {
    target: { url: "http://example/bench", matrix: { technique: ["raf", "css"], complexity: ["100", "500"] } },
    timing: { readyTimeoutMs: 1000, runTimeoutMs: 1000, cooldownMs: 0 },
    batch: {
      repetitions: overrides.repetitions ?? 3,
      warmupRuns: overrides.warmupRuns ?? 1,
      shuffle: overrides.shuffle ?? true,
      ...("seed" in overrides
        ? overrides.seed !== undefined
          ? { seed: overrides.seed }
          : {}
        : { seed: 42 }),
    },
    browser: { headless: false, viewport: { width: 800, height: 600 }, requireHardwareAcceleration: true },
    output: { ndjsonPath: "out.ndjson" },
  };
}

const label = (run: { combination: Record<string, string>; warmup: boolean }) =>
  `${run.combination["technique"]}-${run.combination["complexity"]}${run.warmup ? "-w" : ""}`;

test("the plan covers every combination the requested number of times", () => {
  const { runs } = planBatch(makeConfig());
  assert.equal(runs.length, 4 * 3 + 4, "4 combinations x 3 repetitions + 4 warm-ups");

  const measured = runs.filter((run) => !run.warmup);
  const counts = new Map<string, number>();
  for (const run of measured) counts.set(label(run), (counts.get(label(run)) ?? 0) + 1);
  assert.equal(counts.size, 4);
  assert.ok([...counts.values()].every((count) => count === 3));
});

test("warm-up runs all precede the measured ones", () => {
  const { runs } = planBatch(makeConfig());
  const firstMeasured = runs.findIndex((run) => !run.warmup);
  assert.equal(firstMeasured, 4);
  assert.ok(runs.slice(0, 4).every((run) => run.warmup));
  assert.ok(runs.slice(4).every((run) => !run.warmup));
});

test("the same seed reproduces the same order", () => {
  const first = planBatch(makeConfig()).runs.map(label);
  const second = planBatch(makeConfig()).runs.map(label);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, planBatch(makeConfig({ seed: 7 })).runs.map(label));
});

test("an unseeded shuffle still reports the seed it used", () => {
  const plan = planBatch(makeConfig({ seed: undefined }));
  assert.equal(typeof plan.seed, "number");
  // Replaying that seed must reproduce the ordering.
  const replay = planBatch(makeConfig({ seed: plan.seed }));
  assert.deepEqual(replay.runs.map(label), plan.runs.map(label));
});

test("shuffling actually reorders the measured runs", () => {
  const ordered = planBatch(makeConfig({ shuffle: false }));
  assert.equal(ordered.seed, undefined);
  const shuffled = planBatch(makeConfig({ seed: 42 }));
  assert.notDeepEqual(shuffled.runs.map(label), ordered.runs.map(label));
  // Same multiset, different order.
  assert.deepEqual([...shuffled.runs.map(label)].sort(), [...ordered.runs.map(label)].sort());
});

test("a matrix expands in declaration order and keeps existing query parameters", () => {
  const combinations = expandMatrix({ technique: ["raf", "css"], complexity: ["100"] });
  assert.deepEqual(combinations, [
    { technique: "raf", complexity: "100" },
    { technique: "css", complexity: "100" },
  ]);
  assert.deepEqual(expandMatrix({}), [{}], "an empty matrix means a single bare run");

  const url = buildRunUrl("http://example/bench.html?mode=bench", { technique: "raf" });
  assert.ok(url.includes("mode=bench"));
  assert.ok(url.includes("technique=raf"));
});

test("zero warm-ups produce only measured runs", () => {
  const { runs } = planBatch(makeConfig({ warmupRuns: 0 }));
  assert.equal(runs.length, 12);
  assert.ok(runs.every((run) => !run.warmup));
});
