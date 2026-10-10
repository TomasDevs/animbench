import { computeRunMetrics } from "../analysis/metrics.js";
import type { BatchConfig } from "../types/config.js";
import type { PowerState } from "../diagnostics/host.js";
import type { DiscardReason, RunRecord } from "../types/record.js";

export interface QualityRules {
  expectedRefreshRateHz?: number;
  refreshTolerance?: number;
  minFramesInWindow?: number;
  requirePowerSource?: "ac" | "battery";
  minBatteryPercent?: number;
}

const DEFAULT_REFRESH_TOLERANCE = 0.1;

export function qualityRules(batch: BatchConfig): QualityRules {
  return {
    ...(batch.expectedRefreshRateHz !== undefined ? { expectedRefreshRateHz: batch.expectedRefreshRateHz } : {}),
    ...(batch.refreshTolerance !== undefined ? { refreshTolerance: batch.refreshTolerance } : {}),
    ...(batch.minFramesInWindow !== undefined ? { minFramesInWindow: batch.minFramesInWindow } : {}),
    ...(batch.requirePowerSource !== undefined ? { requirePowerSource: batch.requirePowerSource } : {}),
    ...(batch.minBatteryPercent !== undefined ? { minBatteryPercent: batch.minBatteryPercent } : {}),
  };
}

const SOURCE_NAMES = { ac: "mains", battery: "battery", unknown: "an unknown source" } as const;

/**
 * Checked before every run. Returns why the batch cannot go on: once the power
 * condition is wrong, every further run would be measured under it too.
 */
export function powerBlocker(power: PowerState, rules: QualityRules): string | null {
  if (rules.requirePowerSource && power.source !== rules.requirePowerSource) {
    return (
      `the batch requires ${SOURCE_NAMES[rules.requirePowerSource]} but the machine runs on ` +
      SOURCE_NAMES[power.source]
    );
  }
  if (rules.minBatteryPercent !== undefined) {
    if (power.batteryPercent === null) {
      return `the battery level cannot be read, so the ${rules.minBatteryPercent} % floor cannot be kept`;
    }
    if (power.batteryPercent < rules.minBatteryPercent) {
      return `the battery is at ${power.batteryPercent} %, below the ${rules.minBatteryPercent} % floor`;
    }
  }
  return null;
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

  const power = record.environment.power;
  if (rules.requirePowerSource && power && power.end.source !== rules.requirePowerSource) {
    return {
      reason: "power-changed",
      detail: `the run started on ${SOURCE_NAMES[power.start.source]} and ended on ${SOURCE_NAMES[power.end.source]}`,
    };
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
