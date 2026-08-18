/**
 * Addresses and parameter names come from outside; the tool has no built-in
 * knowledge of any application, technique or scene. Parameter values are
 * opaque strings, combined and recorded but never interpreted.
 */
export type ParameterMatrix = Record<string, readonly string[]>;

export type Combination = Record<string, string>;

export interface TargetConfig {
  url: string;
  /** Cartesian product defines the runs; empty means one run of the bare URL. */
  matrix: ParameterMatrix;
}

export interface TimingConfig {
  readyTimeoutMs: number;
  runTimeoutMs: number;
  cooldownMs: number;
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
}

export interface BrowserConfig {
  /**
   * Measurement needs a visible window: headless Chromium falls back to
   * software rendering, erasing the GPU compositing advantage under test.
   */
  headless: boolean;
  viewport: { width: number; height: number };
  requireHardwareAcceleration: boolean;
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
  runTimeoutMs: 120_000,
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
};

export function expandMatrix(matrix: ParameterMatrix): Combination[] {
  const names = Object.keys(matrix);
  let combinations: Combination[] = [{}];

  for (const name of names) {
    const values = matrix[name] ?? [];
    const expanded: Combination[] = [];
    for (const partial of combinations) {
      for (const value of values) {
        expanded.push({ ...partial, [name]: value });
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
