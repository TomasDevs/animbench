import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GroupAggregate } from "../analysis/aggregate.js";

/** Metrics reported per group, and the aggregate shown for each. */
const REPORTED = [
  ["meanIntervalMs", "mean"],
  ["medianIntervalMs", "mean"],
  ["p95IntervalMs", "mean"],
  ["p99IntervalMs", "mean"],
  ["maxIntervalMs", "max"],
  ["meanFps", "mean"],
  ["p5Fps", "mean"],
  ["p1Fps", "mean"],
  ["framesOverBudget", "mean"],
  ["framesOverBudgetRatio", "mean"],
  ["refreshRatio", "mean"],
  ["budgetMs", "median"],
  ["refreshRateHz", "median"],
  ["frameCount", "mean"],
] as const;

function escapeCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  return Number(value.toFixed(4)).toString();
}

/**
 * Column names come from the data, so a matrix of any shape produces a table
 * without the tool knowing what the parameters mean.
 */
function collectParameterNames(aggregates: readonly GroupAggregate[]): string[] {
  const names = new Set<string>();
  for (const aggregate of aggregates) {
    for (const name of Object.keys(aggregate.combination)) names.add(name);
  }
  return [...names].sort();
}

export function buildCsv(aggregates: readonly GroupAggregate[]): string {
  const parameterNames = collectParameterNames(aggregates);

  const header = [
    ...parameterNames,
    "runsValid",
    "runsDiscarded",
    "discardReasons",
    ...REPORTED.map(([metric, aggregate]) => `${metric}_${aggregate}`),
    // Spread across repetitions of the same combination: if this is comparable
    // to the spread between combinations, the comparison means nothing.
    "meanIntervalMs_stdDev",
    "meanFps_min",
    "meanFps_max",
  ];

  const rows = aggregates.map((aggregate) => {
    const discardSummary = Object.entries(aggregate.discardReasons)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(" ");

    return [
      ...parameterNames.map((name) => aggregate.combination[name] ?? ""),
      String(aggregate.runsValid),
      String(aggregate.runsDiscarded),
      discardSummary,
      ...REPORTED.map(([metric, aggregate_]) => formatNumber(aggregate.metrics[metric][aggregate_])),
      formatNumber(aggregate.metrics.meanIntervalMs.stdDev),
      formatNumber(aggregate.metrics.meanFps.min),
      formatNumber(aggregate.metrics.meanFps.max),
    ];
  });

  return [header, ...rows].map((row) => row.map(escapeCell).join(",")).join("\n") + "\n";
}

export async function writeCsv(path: string, aggregates: readonly GroupAggregate[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buildCsv(aggregates), "utf8");
}
