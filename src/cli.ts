import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { evaluateGpuReport, inspectGpu, runGpuCheck } from "./diagnostics/gpu.js";
import { buildRunRecord } from "./runner/build-record.js";
import { measureOnce, withPage } from "./runner/single-run.js";
import { NdjsonWriter, installInterruptHandler, readNdjson } from "./output/ndjson.js";
import { aggregateRuns } from "./analysis/aggregate.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { runBatch } from "./runner/batch.js";
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

async function commandAggregate(
  ndjsonPath: string,
  csvPath: string,
  batchId?: string,
): Promise<void> {
  const { records, malformedLines } = await readNdjson(ndjsonPath);

  if (malformedLines.length > 0) {
    console.log(`WARNING: ${malformedLines.length} unreadable line(s): ${malformedLines.join(", ")}`);
  }
  if (records.length === 0) {
    console.log(`No runs found in ${ndjsonPath}`);
    process.exitCode = 1;
    return;
  }

  const aggregates = aggregateRuns(records, batchId ? { batchId } : {});
  if (aggregates.length === 0) {
    console.log(`No runs in ${ndjsonPath} belong to batch ${batchId}`);
    process.exitCode = 1;
    return;
  }
  await writeCsv(csvPath, aggregates);

  const valid = aggregates.reduce((total, group) => total + group.runsValid, 0);
  const discarded = aggregates.reduce((total, group) => total + group.runsDiscarded, 0);
  const warmup = aggregates.reduce((total, group) => total + group.runsWarmup, 0);
  const counted = aggregates.reduce((total, group) => total + group.runsTotal, 0);
  console.log(
    `${counted} run(s), ${valid} valid, ${discarded} discarded, ${warmup} warm-up` +
      (batchId ? ` (batch ${batchId})` : ""),
  );
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

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return minutes > 0 ? `${minutes}m ${totalSeconds % 60}s` : `${totalSeconds}s`;
}

async function commandBatch(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  const startedAt = Date.now();

  console.log(`Target:   ${config.target.url}`);
  console.log(`Output:   ${config.output.ndjsonPath}`);
  console.log("");

  const summary = await runBatch(config, ({ sequence, total, record }) => {
    const label =
      Object.entries(record.combination).map(([k, v]) => `${k}=${v}`).join(" ") || "(no parameters)";
    const status = record.valid
      ? `${record.timestamps?.length ?? 0} frames`
      : `discarded: ${record.discardReason}`;
    const position = String(sequence + 1).padStart(String(total).length, " ");
    console.log(`[${position}/${total}] ${label}  ${status}`);
  });

  console.log("");
  console.log(`Batch ${summary.batchId}`);
  if (summary.seed !== undefined) console.log(`Seed:     ${summary.seed}`);
  console.log(
    `Runs:     ${summary.total} planned, ${summary.valid} valid, ` +
      `${summary.discarded} discarded, ${summary.warmup} warm-up`,
  );
  for (const [reason, count] of Object.entries(summary.discardReasons)) {
    console.log(`            ${reason}: ${count}`);
  }
  console.log(`Elapsed:  ${formatDuration(Date.now() - startedAt)}`);

  if (summary.abortedAfter) {
    console.log("");
    console.log(`ABORTED after run ${summary.abortedAfter.sequence + 1}: ${summary.abortedAfter.error}`);
    process.exitCode = 1;
  }

  if (config.output.csvPath) {
    console.log("");
    await commandAggregate(config.output.ndjsonPath, config.output.csvPath, summary.batchId);
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
      console.log("Usage: animbench aggregate <file.ndjson> <file.csv> [--batch <id>]");
      process.exitCode = 1;
      return;
    }
    const batchIndex = rest.indexOf("--batch");
    const batchId = batchIndex === -1 ? undefined : rest[batchIndex + 1];
    if (batchIndex !== -1 && !batchId) {
      console.log("--batch requires a batch id");
      process.exitCode = 1;
      return;
    }
    await commandAggregate(ndjsonPath, csvPath, batchId);
    return;
  }

  if (command === "batch") {
    const configPath = rest[0];
    if (!configPath) {
      console.log("Usage: animbench batch <config.json>");
      process.exitCode = 1;
      return;
    }
    await commandBatch(configPath);
    return;
  }

  console.log("Usage: animbench <command>");
  console.log("  check-gpu                          verify hardware acceleration");
  console.log("  run <url-or-file> [--out <file>]   measure a single run");
  console.log("  batch <config.json>                measure a matrix of combinations");
  console.log("  aggregate <file.ndjson> <file.csv> [--batch <id>]   summarise recorded runs");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(`Config error: ${error.message}`);
  else console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
