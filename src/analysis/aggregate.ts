import type { RunRecord } from "../types/record.js";
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

export interface GroupAggregate {
  /** Parameter values shared by the runs in this group. */
  combination: Record<string, string>;
  /** Values from the page's meta shared across the group, for reference. */
  meta: Record<string, unknown>;

  runsTotal: number;
  runsValid: number;
  runsDiscarded: number;
  /** Discard reasons and their counts, so losses are never invisible. */
  discardReasons: Record<string, number>;

  metrics: Record<keyof RunMetrics, AggregatedMetric>;
}

const METRIC_KEYS = [
  "frameCount",
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
function groupKey(combination: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(combination)
      .sort()
      .map((name) => [name, combination[name]]),
  );
}

export function aggregateRuns(records: readonly RunRecord[]): GroupAggregate[] {
  const groups = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = groupKey(record.combination);
    const existing = groups.get(key);
    if (existing) existing.push(record);
    else groups.set(key, [record]);
  }

  const aggregates: GroupAggregate[] = [];

  for (const groupRecords of groups.values()) {
    const validRecords = groupRecords.filter((record) => record.valid);

    const discardReasons: Record<string, number> = {};
    for (const record of groupRecords) {
      if (record.valid) continue;
      const reason = record.discardReason ?? "unknown";
      discardReasons[reason] = (discardReasons[reason] ?? 0) + 1;
    }

    const runMetrics = validRecords
      .map((record) => computeRunMetrics(record))
      .filter((metrics): metrics is RunMetrics => metrics !== null);

    const metrics = {} as Record<keyof RunMetrics, AggregatedMetric>;
    for (const key of METRIC_KEYS) {
      metrics[key] = aggregateValues(runMetrics.map((entry) => entry[key]));
    }

    aggregates.push({
      combination: groupRecords[0]?.combination ?? {},
      meta: validRecords[0]?.meta ?? {},
      runsTotal: groupRecords.length,
      runsValid: runMetrics.length,
      runsDiscarded: groupRecords.length - runMetrics.length,
      discardReasons,
      metrics,
    });
  }

  return aggregates;
}
