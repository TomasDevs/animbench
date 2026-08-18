import { pathToFileURL } from "node:url";
import { runGpuCheck } from "./diagnostics/gpu.js";
import { measureOnce, withPage } from "./runner/single-run.js";
import { DEFAULT_TIMING } from "./types/config.js";

function printGpuVerdict(verdict: Awaited<ReturnType<typeof runGpuCheck>>): void {
  const { report, missing, accelerated } = verdict;

  console.log("Browser:  ", report.chromeVersion ?? "unknown");
  console.log("System:   ", report.operatingSystem ?? "unknown");
  console.log("Renderer: ", report.webglRenderer ?? "unknown");
  console.log("");
  console.log("Graphics feature status");
  for (const feature of report.features) {
    console.log(`  ${feature.hardwareAccelerated ? "[hw]" : "[  ]"} ${feature.name}: ${feature.status}`);
  }
  console.log("");

  if (accelerated) {
    console.log("OK: compositing and rasterization run on the GPU.");
    return;
  }
  console.log(`FAILED: ${missing.join(", ")}`);
  console.log("Measurements taken in this browser are not comparable.");
}

/**
 * Accepts an http(s) address or a path to a local file. A query string on a
 * file path is kept: pathToFileURL would escape the "?" into the filename.
 */
function resolveTarget(target: string): string {
  if (/^[a-z]+:\/\//i.test(target)) return target;

  const queryStart = target.indexOf("?");
  if (queryStart === -1) return pathToFileURL(target).toString();

  const fileUrl = pathToFileURL(target.slice(0, queryStart));
  fileUrl.search = target.slice(queryStart + 1);
  return fileUrl.toString();
}

async function commandRun(target: string): Promise<void> {
  const url = resolveTarget(target);
  console.log(`Running ${url}`);

  const outcome = await withPage({}, (page) => measureOnce(page, url, DEFAULT_TIMING));

  if (!outcome.ok) {
    console.log(`DISCARDED (${outcome.reason}): ${outcome.detail}`);
    process.exitCode = 1;
    return;
  }

  const { result } = outcome;
  const durationMs = result.endTime - result.startTime;
  console.log("");
  console.log(`Frames:        ${result.timestamps.length}`);
  console.log(`Duration:      ${durationMs.toFixed(1)} ms`);
  console.log(`Baseline:      ${result.baseline.frameIntervalMs.toFixed(3)} ms ` +
    `(${result.baseline.refreshRateHz.toFixed(1)} Hz)`);
  console.log(`Meta:          ${JSON.stringify(result.meta)}`);
  console.log(`First stamps:  ${result.timestamps.slice(0, 5).map((t) => t.toFixed(2)).join(", ")}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "check-gpu") {
    const verdict = await runGpuCheck();
    printGpuVerdict(verdict);
    if (!verdict.accelerated) process.exitCode = 1;
    return;
  }

  if (command === "run") {
    const target = rest[0];
    if (!target) {
      console.log("Usage: animbench run <url-or-file>");
      process.exitCode = 1;
      return;
    }
    await commandRun(target);
    return;
  }

  console.log("Usage: animbench <check-gpu | run <url-or-file>>");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
