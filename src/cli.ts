import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { evaluateGpuReport, inspectGpu, runGpuCheck } from "./diagnostics/gpu.js";
import { buildRunRecord } from "./runner/build-record.js";
import { measureOnce, withPage } from "./runner/single-run.js";
import { NdjsonWriter, installInterruptHandler, readNdjson } from "./output/ndjson.js";
import { aggregateRuns } from "./analysis/aggregate.js";
import { writeCsv } from "./output/csv.js";
import { DEFAULT_BROWSER, DEFAULT_TIMING } from "./types/config.js";
import type { RunEnvironment } from "./types/record.js";

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

/** The query parameters of a run become its grouping key during aggregation. */
function combinationFromUrl(url: string): Record<string, string> {
  const combination: Record<string, string> = {};
  for (const [name, value] of new URL(url).searchParams) combination[name] = value;
  return combination;
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

async function commandRun(target: string, ndjsonPath?: string): Promise<void> {
  const url = resolveTarget(target);
  const batchId = randomUUID();
  console.log(`Running ${url}`);

  const writer = ndjsonPath ? new NdjsonWriter(ndjsonPath) : undefined;
  const removeInterruptHandler = writer ? installInterruptHandler(writer) : undefined;

  try {
    const outcome = await withPage({}, async (page) => {
      const verdict = evaluateGpuReport(await inspectGpu(page));
      const measured = await measureOnce(page, url, DEFAULT_TIMING);
      const devicePixelRatio = measured.ok ? measured.devicePixelRatio : null;

      const environment: RunEnvironment = {
        browser: verdict.report.chromeVersion,
        operatingSystem: verdict.report.operatingSystem,
        renderer: verdict.report.webglRenderer,
        hardwareAccelerated: verdict.accelerated,
        viewport: DEFAULT_BROWSER.viewport,
        devicePixelRatio,
      };
      return { measured, environment, accelerated: verdict.accelerated };
    });

    if (!outcome.accelerated) {
      console.log("WARNING: hardware acceleration not confirmed; results are not comparable.");
    }

    const record = buildRunRecord(
      {
        batchId,
        url,
        combination: combinationFromUrl(url),
        repetition: 0,
        sequence: 0,
        environment: outcome.environment,
        warmup: false,
        recordedAt: new Date().toISOString(),
      },
      outcome.measured,
    );

    await writer?.write(record);

    if (!outcome.measured.ok) {
      console.log(`DISCARDED (${outcome.measured.reason}): ${outcome.measured.detail}`);
      process.exitCode = 1;
    } else {
      const { result } = outcome.measured;
      console.log("");
      console.log(`Frames:        ${result.timestamps.length}`);
      console.log(`Duration:      ${(result.endTime - result.startTime).toFixed(1)} ms`);
      console.log(
        `Baseline:      ${result.baseline.frameIntervalMs.toFixed(3)} ms ` +
          `(${result.baseline.refreshRateHz.toFixed(1)} Hz)`,
      );
      console.log(`Meta:          ${JSON.stringify(result.meta)}`);
    }

    if (ndjsonPath) console.log(`Written to ${ndjsonPath}`);
  } finally {
    removeInterruptHandler?.();
    await writer?.close();
  }
}

async function commandAggregate(ndjsonPath: string, csvPath: string): Promise<void> {
  const { records, malformedLines } = await readNdjson(ndjsonPath);

  if (malformedLines.length > 0) {
    console.log(`WARNING: ${malformedLines.length} unreadable line(s): ${malformedLines.join(", ")}`);
  }
  if (records.length === 0) {
    console.log(`No runs found in ${ndjsonPath}`);
    process.exitCode = 1;
    return;
  }

  const aggregates = aggregateRuns(records);
  await writeCsv(csvPath, aggregates);

  const valid = aggregates.reduce((total, group) => total + group.runsValid, 0);
  const discarded = aggregates.reduce((total, group) => total + group.runsDiscarded, 0);
  console.log(`${records.length} run(s), ${valid} valid, ${discarded} discarded`);
  console.log(`${aggregates.length} combination(s) written to ${csvPath}`);

  for (const group of aggregates) {
    const label = Object.entries(group.combination).map(([k, v]) => `${k}=${v}`).join(" ") || "(no parameters)";
    const discards = Object.entries(group.discardReasons)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(" ");
    const summary =
      group.runsValid === 0
        ? "no valid runs"
        : `fps=${group.metrics.meanFps.mean.toFixed(1)}  ` +
          `p1=${group.metrics.p1Fps.mean.toFixed(1)}  ` +
          `over=${group.metrics.framesOverBudget.mean.toFixed(1)}`;

    console.log(
      `  ${label}  n=${group.runsValid}  ${summary}` +
        (discards ? `  discarded[${discards}]` : ""),
    );
  }
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
      console.log("Usage: animbench run <url-or-file> [--out <file.ndjson>]");
      process.exitCode = 1;
      return;
    }
    const outIndex = rest.indexOf("--out");
    const ndjsonPath = outIndex === -1 ? undefined : rest[outIndex + 1];
    if (outIndex !== -1 && !ndjsonPath) {
      console.log("--out requires a file path");
      process.exitCode = 1;
      return;
    }
    await commandRun(target, ndjsonPath);
    return;
  }

  if (command === "aggregate") {
    const [ndjsonPath, csvPath] = rest;
    if (!ndjsonPath || !csvPath) {
      console.log("Usage: animbench aggregate <file.ndjson> <file.csv>");
      process.exitCode = 1;
      return;
    }
    await commandAggregate(ndjsonPath, csvPath);
    return;
  }

  console.log(
    "Usage: animbench <check-gpu | run <url-or-file> [--out <file.ndjson>] | " +
      "aggregate <file.ndjson> <file.csv>>",
  );
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
