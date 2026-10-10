import type { BenchBaseline, BenchMeta } from "./contract.js";
import type { Combination } from "./config.js";
import type { Capabilities } from "../diagnostics/capabilities.js";
import type { HostInfo, PowerState } from "../diagnostics/host.js";

export type DiscardReason =
  | "warmup"
  | "overflowed"
  | "page-error"
  | "contract-violation"
  | "stale-build"
  | "timeout"
  | "navigation-error"
  | "refresh-mismatch"
  | "too-few-frames"
  | "power-changed";

export interface RunEnvironment {
  browser: string | null;
  operatingSystem: string | null;
  /** WebGL renderer, the evidence that the GPU rather than the CPU drew. */
  renderer: string | null;
  hardwareAccelerated: boolean;
  /**
   * What the page actually saw, read from the page rather than taken from the
   * configuration: a scene that lays itself out by viewport width would
   * otherwise be compared across differently sized windows without any trace.
   */
  viewport: { width: number; height: number };
  devicePixelRatio: number | null;
  /**
   * Screen size as the page saw it. On a desktop this is Playwright's
   * emulation matching the viewport; the physical display is in host.display.
   */
  screen?: { width: number; height: number };
  host?: HostInfo;
  capabilities?: Capabilities;
  /**
   * What `gpuUtilization` covers: the whole GPU on macOS, the browser's GPU
   * process on Windows; null where it was not measured.
   */
  gpuUsageScope?: "system" | "browser-gpu-process" | null;
  /** What kept the machine from sleeping during the batch; null if nothing could. */
  keepAwake?: string | null;
  /** Read just before navigation and just after the run, outside the measurement. */
  power?: { start: PowerState; end: PowerState };
}

/**
 * Cumulative counters read over CDP while a run is in progress. Values only
 * ever grow; the cost of a span is the difference between two samples, which is
 * computed in Node like everything else.
 */
export interface CpuSample {
  /** Page clock (`performance.now()`), the axis `timestamps` use. */
  t: number;
  /** Main thread of the measured page, in milliseconds. */
  mainThread: {
    taskMs: number;
    scriptMs: number;
    styleMs: number;
    layoutMs: number;
  };
  /**
   * CPU time per browser process, in milliseconds. The GPU process figure is
   * processor time spent driving the GPU, not GPU utilisation. Null where the
   * platform hides it, as Android does for its sandboxed processes.
   */
  processCpuMs: {
    renderer: number;
    gpu: number;
  } | null;
  /**
   * GPU utilisation in percent at this moment, read from the operating system.
   * Unlike the counters above it is not cumulative. Absent where unavailable.
   */
  gpuUtilization?: number | null;
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
  cpuSamples?: CpuSample[];
  /**
   * Set whenever the run was configured to sample CPU, failed runs included.
   * Sampling has a small cost on loaded techniques, so sampled and unsampled
   * runs are kept apart during aggregation.
   */
  cpuSampleIntervalMs?: number;

  environment: RunEnvironment;
  labels?: Record<string, string>;
}

export function serializeRunRecord(record: RunRecord): string {
  return JSON.stringify(record);
}

export function parseRunRecord(line: string): RunRecord {
  return JSON.parse(line) as RunRecord;
}
