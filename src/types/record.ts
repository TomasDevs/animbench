import type { BenchBaseline, BenchMeta } from "./contract.js";
import type { Combination } from "./config.js";

export type DiscardReason =
  | "warmup"
  | "overflowed"
  | "page-error"
  | "contract-violation"
  | "timeout"
  | "navigation-error";

export interface RunEnvironment {
  browser: string | null;
  operatingSystem: string | null;
  /** WebGL renderer, the evidence that the GPU rather than the CPU drew. */
  renderer: string | null;
  hardwareAccelerated: boolean;
  viewport: { width: number; height: number };
  devicePixelRatio: number | null;
}

/**
 * One line of the NDJSON output. Timestamps stay raw: everything derived is
 * computed later in Node, so nothing but reading burdens the measured thread.
 */
export interface RunRecord {
  /** Schema version, so older result files stay readable. */
  schema: 1;
  runId: string;
  batchId: string;
  /** Shuffle seed of the batch, so its ordering can be reproduced from data. */
  batchSeed?: number;
  recordedAt: string;

  url: string;
  combination: Combination;
  repetition: number;
  /**
   * Position in the executed (shuffled) order, which repetition alone does not
   * give. Lets a batch be checked afterwards for drift caused by throttling.
   */
  sequence: number;

  /** False for warm-up runs and for runs that broke the contract. */
  valid: boolean;
  discardReason?: DiscardReason;
  discardDetail?: string;

  timestamps?: number[];
  baseline?: BenchBaseline;
  /** Whatever the page reported about itself. Never interpreted by the tool. */
  meta?: BenchMeta;
  startTime?: number;
  endTime?: number;
  overflowed?: boolean;

  environment: RunEnvironment;
  labels?: Record<string, string>;
}

export function serializeRunRecord(record: RunRecord): string {
  return JSON.stringify(record);
}

export function parseRunRecord(line: string): RunRecord {
  return JSON.parse(line) as RunRecord;
}
