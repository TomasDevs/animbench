/**
 * Addresses and parameter names come from outside; the tool has no built-in
 * knowledge of any application, technique or scene. Parameter values are
 * opaque strings, combined and recorded but never interpreted.
 */
export type Combination = Record<string, string>;

/**
 * A dimension lists either single values, passed under the dimension's name,
 * or linked sets of parameters that only make sense together, such as a
 * measured window that depends on the element count. For linked sets the
 * dimension's name is just a label and is not passed to the page.
 */
export type MatrixDimension = readonly string[] | readonly Combination[];

export type ParameterMatrix = Record<string, MatrixDimension>;

export interface TargetConfig {
  url: string;
  /** Cartesian product defines the runs; empty means one run of the bare URL. */
  matrix: ParameterMatrix;
}

export interface TimingConfig {
  readyTimeoutMs: number;
  runTimeoutMs: number;
  cooldownMs: number;
  /** Interval of CPU sampling during a run; absent or 0 turns it off. */
  cpuSampleIntervalMs?: number;
}

export interface BatchConfig {
  repetitions: number;
  /** Performed before the measured runs and discarded, per combination. */
  warmupRuns: number;
  /**
   * Shuffled so thermal throttling does not systematically favour whichever
   * combination happened to run first.
   */
  shuffle: boolean;
  seed?: number;
  /**
   * Refresh rate the display is expected to run at. A run whose idle baseline
   * differs by more than `refreshTolerance` is discarded. Leave unset on
   * adaptive displays, which drop their rate when idle.
   */
  expectedRefreshRateHz?: number;
  /** Relative tolerance for `expectedRefreshRateHz`; 0.1 means ±10 %. */
  refreshTolerance?: number;
  /** A run with fewer frames in its measured window is discarded. */
  minFramesInWindow?: number;
}

export interface BrowserConfig {
  /**
   * Measurement needs a visible window: headless Chromium falls back to
   * software rendering, erasing the GPU compositing advantage under test.
   */
  headless: boolean;
  viewport: { width: number; height: number };
  requireHardwareAcceleration: boolean;
  /** Android drives Chrome on a phone connected over adb. */
  target: "desktop" | "android";
  /** Required only when more than one phone is connected. */
  deviceSerial?: string;
  adbPath?: string;
}

export interface OutputConfig {
  ndjsonPath: string;
  csvPath?: string;
}

export interface BenchConfig {
  target: TargetConfig;
  timing: TimingConfig;
  batch: BatchConfig;
  browser: BrowserConfig;
  output: OutputConfig;
  /** Recorded with every run, e.g. the device under test. */
  labels?: Record<string, string>;
}

export const DEFAULT_TIMING: TimingConfig = {
  readyTimeoutMs: 30_000,
  runTimeoutMs: 300_000,
  cooldownMs: 3_000,
};

export const DEFAULT_BATCH: BatchConfig = {
  repetitions: 10,
  warmupRuns: 1,
  shuffle: true,
};

export const DEFAULT_BROWSER: BrowserConfig = {
  headless: false,
  viewport: { width: 1280, height: 720 },
  requireHardwareAcceleration: true,
  target: "desktop",
};

export function expandMatrix(matrix: ParameterMatrix): Combination[] {
  const names = Object.keys(matrix);
  let combinations: Combination[] = [{}];

  for (const name of names) {
    const values = matrix[name] ?? [];
    const expanded: Combination[] = [];
    for (const partial of combinations) {
      for (const value of values) {
        expanded.push(typeof value === "string" ? { ...partial, [name]: value } : { ...partial, ...value });
      }
    }
    combinations = expanded;
  }

  return combinations;
}

export function buildRunUrl(baseUrl: string, combination: Combination): string {
  const url = new URL(baseUrl);
  for (const [name, value] of Object.entries(combination)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}
