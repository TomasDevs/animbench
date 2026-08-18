import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CONTRACT_KEYS } from "../src/types/contract.js";

const FIXTURE_DIR = "fixtures";

async function fixturePaths(): Promise<string[]> {
  const entries = await readdir(FIXTURE_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(FIXTURE_DIR, entry.name));
}

function extractScript(html: string): string {
  const parts = html.split("<script>");
  assert.ok(parts.length > 1, "fixture must contain an inline script");
  return (parts[1] as string).split("</script>")[0] as string;
}

test("every fixture script parses", async () => {
  // A fixture broken by an editing slip fails as an opaque ready-timeout at
  // run time, so the syntax is checked here instead.
  for (const path of await fixturePaths()) {
    const script = extractScript(await readFile(path, "utf8"));
    assert.doesNotThrow(() => new Function(script), `${path} must parse`);
  }
});

test("every fixture exposes the full contract", async () => {
  for (const path of await fixturePaths()) {
    const html = await readFile(path, "utf8");
    for (const key of Object.values(CONTRACT_KEYS)) {
      assert.ok(html.includes(key), `${path} must reference ${key}`);
    }
  }
});

test("fixtures report failures through __benchError rather than throwing", async () => {
  for (const path of await fixturePaths()) {
    const script = extractScript(await readFile(path, "utf8"));
    assert.ok(
      script.includes("catch"),
      `${path} must catch its own errors so the tool sees a reason, not a timeout`,
    );
  }
});
