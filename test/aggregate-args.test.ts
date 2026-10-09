import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAggregateArgs } from "../src/cli/aggregate-args.js";

test("every file before the last one is an input", () => {
  assert.deepEqual(parseAggregateArgs(["mac.ndjson", "phone.ndjson", "all.csv"]), {
    ndjsonPaths: ["mac.ndjson", "phone.ndjson"],
    csvPath: "all.csv",
  });
});

test("without --batch the first file is kept", () => {
  // Regression: a missing flag gave index -1, and filtering out "index + 1"
  // silently dropped the first input.
  const parsed = parseAggregateArgs(["a.ndjson", "out.csv"]);
  assert.ok(typeof parsed !== "string");
  assert.deepEqual(parsed.ndjsonPaths, ["a.ndjson"]);
});

test("--batch is taken out wherever it appears", () => {
  assert.deepEqual(parseAggregateArgs(["--batch", "b1", "a.ndjson", "out.csv"]), {
    ndjsonPaths: ["a.ndjson"],
    csvPath: "out.csv",
    batchId: "b1",
  });
  assert.deepEqual(parseAggregateArgs(["a.ndjson", "out.csv", "--batch", "b1"]), {
    ndjsonPaths: ["a.ndjson"],
    csvPath: "out.csv",
    batchId: "b1",
  });
});

test("malformed invocations return a message", () => {
  assert.equal(typeof parseAggregateArgs(["out.csv"]), "string");
  assert.equal(typeof parseAggregateArgs([]), "string");
  assert.equal(parseAggregateArgs(["a.ndjson", "out.csv", "--batch"]), "--batch requires a batch id");
});
