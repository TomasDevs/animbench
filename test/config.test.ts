import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, parseConfig } from "../src/config/load.js";

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
