import { computeRunMetrics } from "../analysis/metrics.js";
import type { BatchConfig } from "../types/config.js";
import type { DiscardReason, RunRecord } from "../types/record.js";

export interface QualityRules {
  expectedRefreshRateHz?: number;
  refreshTolerance?: number;
  minFramesInWindow?: number;
}

const DEFAULT_REFRESH_TOLERANCE = 0.1;

export function qualityRules(batch: BatchConfig): QualityRules {
  return {
    ...(batch.expectedRefreshRateHz !== undefined ? { expectedRefreshRateHz: batch.expectedRefreshRateHz } : {}),
    ...(batch.refreshTolerance !== undefined ? { refreshTolerance: batch.refreshTolerance } : {}),
    ...(batch.minFramesInWindow !== undefined ? { minFramesInWindow: batch.minFramesInWindow } : {}),
  };
}

/**
 * Applied while measuring, so a run failing the study's rules is written as
 * discarded with its reason rather than left for the analysis to catch.
 */
export function checkQuality(
  record: RunRecord,
  rules: QualityRules,
): { reason: DiscardReason; detail: string } | null {
  if (!record.valid) return null;

  const measuredHz = record.baseline?.refreshRateHz;
  if (rules.expectedRefreshRateHz !== undefined && measuredHz !== undefined) {
    const tolerance = rules.refreshTolerance ?? DEFAULT_REFRESH_TOLERANCE;
    const deviation = Math.abs(measuredHz - rules.expectedRefreshRateHz) / rules.expectedRefreshRateHz;
    if (deviation > tolerance) {
      return {
        reason: "refresh-mismatch",
        detail:
          `idle refresh ${measuredHz.toFixed(1)} Hz differs from the expected ` +
          `${rules.expectedRefreshRateHz} Hz by ${(deviation * 100).toFixed(1)} %`,
      };
    }
  }

  if (rules.minFramesInWindow !== undefined) {
    const frames = computeRunMetrics(record)?.frameCount ?? 0;
    if (frames < rules.minFramesInWindow) {
      return {
        reason: "too-few-frames",
        detail: `${frames} frames in the measured window, fewer than ${rules.minFramesInWindow}`,
      };
    }
  }
  return null;
}
