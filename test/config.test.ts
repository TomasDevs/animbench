import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, parseConfig } from "../src/config/load.js";
import { expandMatrix } from "../src/types/config.js";

const minimal = {
  target: { url: "http://localhost:4173/bench.html" },
  output: { ndjsonPath: "results/runs.ndjson" },
};

function rejects(raw: unknown, fragment: string): void {
  assert.throws(
    () => parseConfig(raw),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError, "must be a ConfigError");
      assert.ok(
        error.message.includes(fragment),
        `expected message to mention "${fragment}", got "${error.message}"`,
      );
      return true;
    },
  );
}

test("a minimal config fills in the documented defaults", () => {
  const config = parseConfig(minimal);
  assert.equal(config.batch.repetitions, 10);
  assert.equal(config.batch.warmupRuns, 1);
  assert.equal(config.batch.shuffle, true);
  assert.equal(config.browser.headless, false, "measurement must default to a visible window");
  assert.equal(config.browser.requireHardwareAcceleration, true);
  assert.deepEqual(config.target.matrix, {});
});

test("matrix values are stringified so numbers may be written as numbers", () => {
  const config = parseConfig({
    ...minimal,
    target: { ...minimal.target, matrix: { complexity: [100, 500], technique: ["raf"] } },
  });
  assert.deepEqual(config.target.matrix["complexity"], ["100", "500"]);
});

test("required fields are enforced", () => {
  rejects({}, "target");
  rejects({ target: {}, output: { ndjsonPath: "x" } }, "target.url is required");
  rejects({ target: { url: "http://x/" } }, "output");
  rejects({ target: { url: "http://x/" }, output: {} }, "output.ndjsonPath is required");
});

test("counts must be whole and within range", () => {
  rejects({ ...minimal, batch: { repetitions: 2.5 } }, "whole number");
  rejects({ ...minimal, batch: { repetitions: 0 } }, "at least 1");
  rejects({ ...minimal, batch: { warmupRuns: -1 } }, "at least 0");
  rejects({ ...minimal, batch: { seed: 1.5 } }, "seed must be an integer");
  rejects({ ...minimal, browser: { viewport: { width: 0 } } }, "at least 1");
});

test("durations may not be negative", () => {
  rejects({ ...minimal, timing: { readyTimeoutMs: -1 } }, "cannot be negative");
  rejects({ ...minimal, timing: { cooldownMs: -5 } }, "cannot be negative");
  assert.equal(parseConfig({ ...minimal, timing: { cooldownMs: 0 } }).timing.cooldownMs, 0);
});

test("an empty matrix entry is rejected rather than silently dropping a dimension", () => {
  rejects({ ...minimal, target: { ...minimal.target, matrix: { technique: [] } } }, "non-empty");
});

test("absolute URLs are kept and malformed ones rejected", () => {
  assert.equal(parseConfig(minimal).target.url, "http://localhost:4173/bench.html");
  rejects({ ...minimal, target: { url: "http://[bad" } }, "not a valid address");
});

test("relative paths resolve against the config file, keeping any query string", () => {
  const config = parseConfig(
    { ...minimal, target: { url: "../fixtures/load-page.html?load=readback" } },
    "/tmp/configs/bench.json",
  );
  assert.ok(config.target.url.startsWith("file:///tmp/fixtures/load-page.html"));
  assert.ok(config.target.url.endsWith("?load=readback"), "the query string must survive");
});

test("CPU sampling stays off unless the config asks for it", () => {
  assert.equal(parseConfig(minimal).timing.cpuSampleIntervalMs, undefined);
  assert.equal(
    parseConfig({ ...minimal, timing: { cpuSampleIntervalMs: 500 } }).timing.cpuSampleIntervalMs,
    500,
  );
  rejects({ ...minimal, timing: { cpuSampleIntervalMs: -1 } }, "cannot be negative");
});

test("the measurement target defaults to this machine and accepts Android", () => {
  assert.equal(parseConfig(minimal).browser.target, "desktop");
  const android = parseConfig({ ...minimal, browser: { target: "android", deviceSerial: "R58M123ABC" } });
  assert.equal(android.browser.target, "android");
  assert.equal(android.browser.deviceSerial, "R58M123ABC");
  rejects({ ...minimal, browser: { target: "ios" } }, "browser.target");
  rejects({ ...minimal, browser: { deviceSerial: "" } }, "deviceSerial");
});

test("linked parameter sets travel together and the label is not passed on", () => {
  const config = parseConfig({
    ...minimal,
    target: {
      ...minimal.target,
      matrix: {
        technique: ["raf", "css-transition"],
        size: [
          { complexity: 100, window: 10000 },
          { complexity: 500, window: 20000 },
          { complexity: 2000, window: 20000 },
        ],
      },
    },
  });
  const combinations = expandMatrix(config.target.matrix);
  assert.equal(combinations.length, 6);
  assert.deepEqual(combinations[0], { technique: "raf", complexity: "100", window: "10000" });
  assert.ok(combinations.every((c) => !("size" in c)));
  assert.ok(
    combinations.every((c) => (c["complexity"] === "100") === (c["window"] === "10000")),
    "a window never pairs with another element count",
  );
});

test("malformed linked sets are rejected before anything is measured", () => {
  const withMatrix = (matrix: unknown) => ({ ...minimal, target: { ...minimal.target, matrix } });
  rejects(withMatrix({ size: [{ complexity: 100 }, "500"] }), "either plain values or parameter sets");
  rejects(withMatrix({ size: [{ complexity: 100, window: 1 }, { complexity: 500 }] }), "must set the same parameters");
  rejects(withMatrix({ size: [{}] }), "at least one parameter");
  rejects(withMatrix({ size: [{ complexity: { nested: 1 } }] }), "strings or numbers");
  rejects(withMatrix({ complexity: ["100"], size: [{ complexity: 500 }] }), 'parameter "complexity" is set by both');
});

test("output paths resolve against the config file, not the working directory", () => {
  const config = parseConfig(
    { ...minimal, output: { ndjsonPath: "../data/final/main.ndjson", csvPath: "../data/final/main.csv" } },
    "/study/configs/main.json",
  );
  assert.equal(config.output.ndjsonPath, "/study/data/final/main.ndjson");
  assert.equal(config.output.csvPath, "/study/data/final/main.csv");

  const absolute = parseConfig({ ...minimal, output: { ndjsonPath: "/tmp/runs.ndjson" } }, "/study/configs/main.json");
  assert.equal(absolute.output.ndjsonPath, "/tmp/runs.ndjson");
});

test("without a config file, relative paths keep meaning the working directory", () => {
  const config = parseConfig({ ...minimal, output: { ndjsonPath: "runs.ndjson" } });
  assert.equal(config.output.ndjsonPath, `${process.cwd()}/runs.ndjson`);
});
