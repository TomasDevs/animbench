import { describeDisplay } from "../diagnostics/host.js";
import type { CpuSample, RunRecord } from "../types/record.js";
import { computeRunMetrics, type RunMetrics } from "./metrics.js";
import { mean, percentile, standardDeviation } from "./statistics.js";

/** Metrics averaged over runs. Keys mirror RunMetrics. */
export type AggregatedMetric = {
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
};

/**
 * The machine and power condition a run was measured under. Part of the group
 * key: runs from different devices, or on mains and on battery, measure
 * different things and must never be averaged together.
 */
export interface DeviceCondition {
  model: string;
  cpu: string;
  os: string;
  power: "ac" | "battery" | "unknown";
  /**
   * Screen size and pixel ratio, e.g. "2560x1440@1x". One laptop on its own
   * Retina panel and on an external monitor draws four times as many pixels in
   * one case, so the two are different conditions.
   */
  display: string;
}

function displayOf(record: RunRecord): string {
  const physical = record.environment.host?.display;
  if (physical) return describeDisplay(physical);
  // Older records and platforms without a system reading fall back to what the
  // page saw; on a desktop that is Playwright's emulation, not the monitor.
  const { screen, devicePixelRatio } = record.environment;
  const size = screen ? `${screen.width}x${screen.height}` : "unknown";
  return devicePixelRatio ? `${size}@${devicePixelRatio}x` : size;
}

export function deviceConditionOf(record: RunRecord): DeviceCondition {
  const host = record.environment.host;
  return {
    model: host?.model ?? "unknown",
    cpu: host?.cpu ?? "unknown",
    os: host?.osVersion ?? record.environment.operatingSystem ?? "unknown",
    power: record.environment.power?.start.source ?? "unknown",
    display: displayOf(record),
  };
}

/**
 * The CPU sampling interval of a run, or null when it was not sampled. Records
 * written before the interval was stored carry only their samples, so the
 * interval is recovered from their spacing.
 */
export function cpuSamplingOf(record: RunRecord): number | null {
  if (record.cpuSampleIntervalMs) return record.cpuSampleIntervalMs;
  const samples = record.cpuSamples;
  if (!samples || samples.length < 3) return null;
  const gaps = samples
    .slice(1)
    .map((sample, index) => sample.t - (samples[index] as CpuSample).t)
    .sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] as number;
  return Math.round(median / 100) * 100;
}

export interface GroupAggregate {
  device: DeviceCondition;
  /** Runs sampled for CPU and runs that were not are never grouped together. */
  cpuSampleIntervalMs: number | null;
  /** Lowest and highest charge seen across the group's runs; null off battery data. */
  batteryPercent: { min: number; max: number } | null;
  /** Parameter values shared by the runs in this group. */
  combination: Record<string, string>;
  /** Values from the page's meta shared across the group, for reference. */
  meta: Record<string, unknown>;

  runsTotal: number;
  runsValid: number;
  /**
   * Runs lost to a failure. Warm-ups are excluded: they are discarded by
   * design, so counting them here would hide whether anything actually failed.
   */
  runsDiscarded: number;
  runsWarmup: number;
  /** Discard reasons and their counts, so losses are never invisible. */
  discardReasons: Record<string, number>;

  metrics: Record<keyof RunMetrics, AggregatedMetric>;
}

const METRIC_KEYS = [
  "frameCount",
  "recordedFrameCount",
  "trimmedRatio",
  "durationMs",
  "budgetMs",
  "refreshRateHz",
  "meanIntervalMs",
  "medianIntervalMs",
  "p95IntervalMs",
  "p99IntervalMs",
  "maxIntervalMs",
  "stdDevIntervalMs",
  "meanFps",
  "p5Fps",
  "p1Fps",
  "framesOverBudget",
  "framesOverBudgetRatio",
  "refreshRatio",
  "mainThreadBusyRatio",
  "mainThreadScriptRatio",
  "mainThreadStyleRatio",
  "mainThreadLayoutRatio",
  "mainThreadOtherRatio",
  "rendererCpuRatio",
  "gpuProcessCpuRatio",
  "cpuSampleCount",
] as const satisfies readonly (keyof RunMetrics)[];

function aggregateValues(values: number[]): AggregatedMetric {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) {
    return { mean: Number.NaN, median: Number.NaN, stdDev: Number.NaN, min: Number.NaN, max: Number.NaN };
  }
  const sorted = [...usable].sort((a, b) => a - b);
  return {
    mean: mean(usable),
    median: percentile(sorted, 0.5),
    stdDev: standardDeviation(usable),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

/** Groups by the parameter combination, the only dimension the tool defines. */
function groupKey(record: RunRecord): string {
  const { combination } = record;
  return JSON.stringify([
    deviceConditionOf(record),
    cpuSamplingOf(record),
    Object.keys(combination)
      .sort()
      .map((name) => [name, combination[name]]),
  ]);
}

function batteryRange(records: readonly RunRecord[]): GroupAggregate["batteryPercent"] {
  const levels = records
    .flatMap((record) => {
      const power = record.environment.power;
      return power ? [power.start.batteryPercent, power.end.batteryPercent] : [];
    })
    .filter((level): level is number => level !== null);
  return levels.length ? { min: Math.min(...levels), max: Math.max(...levels) } : null;
}

export interface AggregateOptions {
  /**
   * Restricts aggregation to one batch. The NDJSON file is append-only, so
   * without this a repeated batch would be averaged together with the previous
   * one.
   */
  batchId?: string;
}

export function aggregateRuns(
  records: readonly RunRecord[],
  options: AggregateOptions = {},
): GroupAggregate[] {
  const selected = options.batchId
    ? records.filter((record) => record.batchId === options.batchId)
    : records;

  const groups = new Map<string, RunRecord[]>();
  for (const record of selected) {
    const key = groupKey(record);
    const existing = groups.get(key);
    if (existing) existing.push(record);
    else groups.set(key, [record]);
  }

  const aggregates: GroupAggregate[] = [];

  for (const groupRecords of groups.values()) {
    const validRecords = groupRecords.filter((record) => record.valid);

    const discardReasons: Record<string, number> = {};
    let warmupCount = 0;
    for (const record of groupRecords) {
      if (record.valid) continue;
      const reason = record.discardReason ?? "unknown";
      if (reason === "warmup") {
        warmupCount++;
        continue;
      }
      discardReasons[reason] = (discardReasons[reason] ?? 0) + 1;
    }

    const runMetrics = validRecords
      .map((record) => computeRunMetrics(record))
      .filter((metrics): metrics is RunMetrics => metrics !== null);

    const metrics = {} as Record<keyof RunMetrics, AggregatedMetric>;
    for (const key of METRIC_KEYS) {
      metrics[key] = aggregateValues(runMetrics.map((entry) => entry[key]));
    }

    const first = groupRecords[0] as RunRecord;
    aggregates.push({
      device: deviceConditionOf(first),
      cpuSampleIntervalMs: cpuSamplingOf(first),
      batteryPercent: batteryRange(groupRecords),
      combination: first.combination,
      meta: validRecords[0]?.meta ?? {},
      runsTotal: groupRecords.length,
      runsValid: runMetrics.length,
      runsDiscarded: groupRecords.length - runMetrics.length - warmupCount,
      runsWarmup: warmupCount,
      discardReasons,
      metrics,
    });
  }

  return aggregates;
}
