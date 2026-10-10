import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readEnvironment } from "./diagnostics/environment.js";
import { readGpuStatus, type GpuStatus } from "./diagnostics/gpu.js";
import type { HostInfo, PowerState } from "./diagnostics/host.js";
import { buildRunRecord } from "./runner/build-record.js";
import { measureOnce } from "./runner/single-run.js";
import { withTarget, type TargetOptions } from "./runner/target.js";
import { NdjsonWriter, installInterruptHandler, readNdjson } from "./output/ndjson.js";
import { aggregateRuns } from "./analysis/aggregate.js";
import { parseAggregateArgs } from "./cli/aggregate-args.js";
import { computeRunMetrics } from "./analysis/metrics.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { runBatch } from "./runner/batch.js";
import { writeCsv } from "./output/csv.js";
import { DEFAULT_BROWSER, DEFAULT_TIMING } from "./types/config.js";
import type { RunEnvironment, RunRecord } from "./types/record.js";

function printGpuStatus(status: GpuStatus): void {
  const { features, renderer, missing, accelerated } = status;

  console.log("Renderer: ", renderer ?? "unknown");
  console.log("");
  console.log("Graphics feature status");
  for (const [name, value] of Object.entries(features).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${/^enabled/.test(value) ? "[on]" : "[  ]"} ${name}: ${value}`);
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

/** Sampling interval used by `run --cpu`; a batch sets its own in the config. */
const RUN_CPU_SAMPLE_INTERVAL_MS = 1000;

/** `--android [--serial <id>]` switches a command from this machine to a phone. */
function targetFromArgs(args: string[]): TargetOptions {
  const serialIndex = args.indexOf("--serial");
  const serial = serialIndex === -1 ? undefined : args[serialIndex + 1];
  return {
    target: args.includes("--android") ? "android" : "desktop",
    ...(serial ? { deviceSerial: serial } : {}),
  };
}

async function commandRun(
  target: string,
  targetOptions: TargetOptions,
  ndjsonPath?: string,
  sampleCpu = false,
): Promise<void> {
  const url = resolveTarget(target);
  const batchId = randomUUID();
  console.log(`Running ${url}`);

  const writer = ndjsonPath ? new NdjsonWriter(ndjsonPath) : undefined;
  const removeInterruptHandler = writer ? installInterruptHandler(writer) : undefined;

  try {
    const outcome = await withTarget({ ...targetOptions, appUrl: url }, async (device) => {
      const { page } = device;
      const base = await readEnvironment(device, DEFAULT_BROWSER.viewport);
      const timing = sampleCpu
        ? { ...DEFAULT_TIMING, cpuSampleIntervalMs: RUN_CPU_SAMPLE_INTERVAL_MS }
        : DEFAULT_TIMING;
      const powerStart = await device.readPower();
      const measured = await measureOnce(page, url, timing);
      const powerEnd = await device.readPower();

      const environment: RunEnvironment = {
        ...base,
        viewport: measured.ok
          ? { width: measured.viewport.width, height: measured.viewport.height }
          : DEFAULT_BROWSER.viewport,
        devicePixelRatio: measured.ok ? measured.viewport.devicePixelRatio : null,
        power: { start: powerStart, end: powerEnd },
      };
      return { measured, environment, accelerated: base.hardwareAccelerated };
    });

    if (!outcome.accelerated) {
      console.log("WARNING: hardware acceleration not confirmed; results are not comparable.");
    }

    const record = buildRunRecord(
      {
        batchId,
        ...(sampleCpu ? { cpuSampleIntervalMs: RUN_CPU_SAMPLE_INTERVAL_MS } : {}),
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

      const samples = outcome.measured.cpuSamples;
      if (samples && samples.length >= 2) {
        const first = samples[0]!;
        const last = samples[samples.length - 1]!;
        const span = last.t - first.t;
        const task = last.mainThread.taskMs - first.mainThread.taskMs;
        console.log(
          `CPU samples:   ${samples.length} over ${(span / 1000).toFixed(1)} s, ` +
            `main thread busy ${((task / span) * 100).toFixed(0)} % (whole run, ramp included)`,
        );
      }
    }

    if (ndjsonPath) console.log(`Written to ${ndjsonPath}`);
  } finally {
    removeInterruptHandler?.();
    await writer?.close();
  }
}

/** Several files merge the devices they were measured on into one table. */
async function commandAggregate(
  ndjsonPaths: string[],
  csvPath: string,
  batchId?: string,
): Promise<void> {
  const records: RunRecord[] = [];
  for (const ndjsonPath of ndjsonPaths) {
    const read = await readNdjson(ndjsonPath);
    if (read.malformedLines.length > 0) {
      console.log(
        `WARNING: ${ndjsonPath}: ${read.malformedLines.length} unreadable line(s): ` +
          read.malformedLines.join(", "),
      );
    }
    records.push(...read.records);
  }
  const sources = ndjsonPaths.join(", ");
  if (records.length === 0) {
    console.log(`No runs found in ${sources}`);
    process.exitCode = 1;
    return;
  }

  const aggregates = aggregateRuns(records, batchId ? { batchId } : {});
  if (aggregates.length === 0) {
    console.log(`No runs in ${sources} belong to batch ${batchId}`);
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

  // Only worth naming the device when the table mixes several.
  const conditions = new Set(aggregates.map((group) => JSON.stringify(group.device)));
  for (const group of aggregates) {
    const parameters =
      Object.entries(group.combination).map(([k, v]) => `${k}=${v}`).join(" ") || "(no parameters)";
    const label =
      conditions.size > 1 ? `[${group.device.model}, ${group.device.power}] ${parameters}` : parameters;
    const discards = Object.entries(group.discardReasons)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(" ");
    const summary =
      group.runsValid === 0
        ? "no valid runs"
        : `fps=${group.metrics.meanFps.mean.toFixed(1)}  ` +
          `p1=${group.metrics.p1Fps.mean.toFixed(1)}  ` +
          `over=${group.metrics.framesOverBudget.mean.toFixed(1)}` +
          (Number.isFinite(group.metrics.mainThreadBusyRatio.mean)
            ? `  main=${(group.metrics.mainThreadBusyRatio.mean * 100).toFixed(0)}%`
            : "");

    console.log(
      `  ${label}  n=${group.runsValid}  ${summary}` +
        (discards ? `  discarded[${discards}]` : ""),
    );
  }
}

function describeHost(host: HostInfo): string {
  return [host.model, host.cpu, `${host.cpuCores} cores`, `${host.memoryGb} GB`, host.osVersion]
    .filter(Boolean)
    .join(", ");
}

function describePower(power: PowerState): string {
  const source = { ac: "mains", battery: "on battery", unknown: "unknown" }[power.source];
  const battery =
    power.batteryPercent === null ? "" : `, battery ${power.batteryPercent} % (${power.batteryState})`;
  return `${source}${battery}`;
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

  const thinSamples: string[] = [];

  const summary = await runBatch(config, ({ sequence, total, record }) => {
    // Read from the first record: on Android the machine and its power are
    // the phone's, which only the running target knows.
    const { host, power, capabilities } = record.environment;
    if (sequence === 0 && host) console.log(`Machine:  ${describeHost(host)}`);
    if (sequence === 0 && power) console.log(`Power:    ${describePower(power.start)}`);
    if (sequence === 0) {
      // Shown at once: on an adaptive display a wrong rate is the first thing
      // to catch, and the batch should be stopped before hours are spent.
      const hz = record.baseline?.refreshRateHz;
      const expected = config.batch.expectedRefreshRateHz;
      if (hz !== undefined) {
        console.log(`Display:  ${hz.toFixed(1)} Hz measured${expected ? `, ${expected} Hz expected` : ", not enforced"}`);
      }
      const awake = record.environment.keepAwake;
      console.log(
        awake ? `Sleep:    blocked (${awake})` : "WARNING:  sleep could not be blocked; keep the machine awake by hand",
      );
    }
    if (sequence === 0 && capabilities) {
      const mark = (available: boolean) => (available ? "yes" : "NO");
      console.log(
        `CDP:      GPU status ${mark(capabilities.gpuStatus)}, ` +
          `main-thread metrics ${mark(capabilities.mainThreadMetrics)}, ` +
          `process CPU ${mark(capabilities.processCpu)}`,
      );
      console.log("");
    }

    const label =
      Object.entries(record.combination).map(([k, v]) => `${k}=${v}`).join(" ") || "(no parameters)";
    const position = String(sequence + 1).padStart(String(total).length, " ");

    if (!record.valid) {
      console.log(`[${position}/${total}] ${label}  discarded: ${record.discardReason}`);
      return;
    }

    // Reported as the batch runs: a thin window is worth knowing about while
    // there is still time to widen it, not once the analysis is under way.
    const metrics = computeRunMetrics(record);
    const measured = metrics?.frameCount ?? record.timestamps?.length ?? 0;
    const window = metrics?.trimmed ? ` in window, ${measured} of ${metrics.recordedFrameCount}` : "";
    const warning = metrics?.unreliablePercentiles.length
      ? `  [too few samples for ${metrics.unreliablePercentiles.join(", ")}]`
      : "";

    if (warning) thinSamples.push(`${label} (${measured} samples)`);
    console.log(`[${position}/${total}] ${label}  ${measured} frames${window}${warning}`);
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

  if (thinSamples.length > 0) {
    console.log("");
    console.log(`WARNING: ${thinSamples.length} run(s) had too few samples for some percentiles.`);
    for (const entry of [...new Set(thinSamples)].slice(0, 5)) console.log(`  ${entry}`);
    console.log("Widen the measured window for those combinations.");
  }

  if (summary.abortedAfter) {
    console.log("");
    console.log(`ABORTED after run ${summary.abortedAfter.sequence + 1}: ${summary.abortedAfter.error}`);
    process.exitCode = 1;
  }

  if (config.output.csvPath) {
    console.log("");
    await commandAggregate([config.output.ndjsonPath], config.output.csvPath, summary.batchId);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "check-gpu") {
    const verdict = await withTarget(targetFromArgs(rest), async ({ page }) => {
      const browser = page.context().browser();
      if (!browser) throw new Error("no browser to inspect");
      return readGpuStatus(browser);
    });
    printGpuStatus(verdict);
    if (!verdict.accelerated) process.exitCode = 1;
    return;
  }

  if (command === "run") {
    const target = rest[0];
    if (!target) {
      console.log("Usage: animbench run <url-or-file> [--out <file.ndjson>] [--cpu] [--android [--serial <id>]]");
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
    await commandRun(target, targetFromArgs(rest), ndjsonPath, rest.includes("--cpu"));
    return;
  }

  if (command === "aggregate") {
    const parsed = parseAggregateArgs(rest);
    if (typeof parsed === "string") {
      console.log(parsed);
      process.exitCode = 1;
      return;
    }
    await commandAggregate(parsed.ndjsonPaths, parsed.csvPath, parsed.batchId);
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
  console.log("  run <url-or-file> [--out <file>] [--cpu]   measure a single run");
  console.log("  batch <config.json>                measure a matrix of combinations");
  console.log("  aggregate <file.ndjson>... <file.csv> [--batch <id>]   summarise recorded runs");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(`Config error: ${error.message}`);
  else console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
