import { randomUUID } from "node:crypto";
import type { Combination } from "../types/config.js";
import type { RunEnvironment, RunRecord } from "../types/record.js";
import type { SingleRunOutcome } from "./single-run.js";

export interface RecordContext {
  batchId: string;
  url: string;
  combination: Combination;
  repetition: number;
  sequence: number;
  environment: RunEnvironment;
  /** Warm-up runs are recorded but never counted. */
  warmup: boolean;
  labels?: Record<string, string>;
  recordedAt: string;
}

export function buildRunRecord(
  context: RecordContext,
  outcome: SingleRunOutcome,
): RunRecord {
  const record: RunRecord = {
    schema: 1,
    runId: randomUUID(),
    batchId: context.batchId,
    recordedAt: context.recordedAt,
    url: context.url,
    combination: context.combination,
    repetition: context.repetition,
    sequence: context.sequence,
    environment: context.environment,
    valid: false,
  };

  if (context.labels) record.labels = context.labels;

  if (!outcome.ok) {
    record.discardReason = outcome.reason;
    record.discardDetail = outcome.detail;
    return record;
  }

  const { result } = outcome;
  record.timestamps = result.timestamps;
  record.baseline = result.baseline;
  record.meta = result.meta;
  record.startTime = result.startTime;
  record.endTime = result.endTime;
  record.overflowed = result.overflowed;

  if (context.warmup) {
    record.discardReason = "warmup";
    return record;
  }

  record.valid = true;
  return record;
}
