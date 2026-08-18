import type { RunRecord } from "../types/record.js";
import { frameIntervals, mean, percentile, standardDeviation } from "./statistics.js";

export interface RunMetrics {
  frameCount: number;
  durationMs: number;

  /** Budget derived from the measured refresh rate, not a fixed 16.7 ms. */
  budgetMs: number;
  refreshRateHz: number;

  meanIntervalMs: number;
  medianIntervalMs: number;
  /**
   * Low percentiles rather than the plain minimum, which a single outlier
   * would decide. Reported as intervals: the slowest frames are the long ones.
   */
  p95IntervalMs: number;
  p99IntervalMs: number;
  maxIntervalMs: number;
  stdDevIntervalMs: number;

  meanFps: number;
  /** Frames per second implied by the 95th and 99th percentile intervals. */
  p5Fps: number;
  p1Fps: number;

  framesOverBudget: number;
  framesOverBudgetRatio: number;

  /**
   * Achieved against achievable frame rate. Makes runs on displays of
   * different refresh rates comparable.
   */
  refreshRatio: number;
}

/**
 * The page's idle measurement gives the achievable rate; the budget follows
 * from it. Falls back to the reported refresh rate when the interval is
 * unusable.
 */
function resolveBudget(record: RunRecord): { budgetMs: number; refreshRateHz: number } {
  const baseline = record.baseline;
  if (baseline && Number.isFinite(baseline.frameIntervalMs) && baseline.frameIntervalMs > 0) {
    return {
      budgetMs: baseline.frameIntervalMs,
      refreshRateHz: baseline.refreshRateHz,
    };
  }
  const refreshRateHz = baseline?.refreshRateHz ?? Number.NaN;
  return { budgetMs: 1000 / refreshRateHz, refreshRateHz };
}

export function computeRunMetrics(record: RunRecord): RunMetrics | null {
  const timestamps = record.timestamps;
  if (!timestamps || timestamps.length < 2) return null;

  const intervals = frameIntervals(timestamps);
  const sorted = [...intervals].sort((a, b) => a - b);
  const { budgetMs, refreshRateHz } = resolveBudget(record);

  const meanIntervalMs = mean(intervals);
  const p95IntervalMs = percentile(sorted, 0.95);
  const p99IntervalMs = percentile(sorted, 0.99);
  const maxIntervalMs = sorted[sorted.length - 1] as number;

  // A frame is over budget only beyond a tolerance: timestamps carry jitter of
  // a fraction of a millisecond, which would otherwise count as a drop.
  const overBudgetThreshold = budgetMs * 1.5;
  const framesOverBudget = intervals.filter((value) => value > overBudgetThreshold).length;

  const meanFps = 1000 / meanIntervalMs;

  return {
    frameCount: timestamps.length,
    durationMs: (timestamps[timestamps.length - 1] as number) - (timestamps[0] as number),
    budgetMs,
    refreshRateHz,
    meanIntervalMs,
    medianIntervalMs: percentile(sorted, 0.5),
    p95IntervalMs,
    p99IntervalMs,
    maxIntervalMs,
    stdDevIntervalMs: standardDeviation(intervals),
    meanFps,
    p5Fps: 1000 / p95IntervalMs,
    p1Fps: 1000 / p99IntervalMs,
    framesOverBudget,
    framesOverBudgetRatio: framesOverBudget / intervals.length,
    refreshRatio: meanFps / refreshRateHz,
  };
}
