/**
 * The contract a measured page exposes on `window`. The tool knows nothing
 * about the page beyond this: no technique names, no scene names, no expected
 * parameters. Everything descriptive travels inside `meta` as opaque values
 * that are recorded and grouped, never interpreted.
 */

export const CONTRACT_KEYS = {
  ready: "__benchReady",
  start: "__benchStart",
  result: "__benchResult",
  done: "__benchDone",
  error: "__benchError",
} as const;

/**
 * Idle measurement taken by the page before the run. The frame budget is
 * derived from this rather than a fixed 16.7 ms, because displays also run at
 * 120 or 144 Hz.
 */
export interface BenchBaseline {
  frameIntervalMs: number;
  refreshRateHz: number;
  samples?: number[];
}

/** Free-form: whatever a page puts here becomes a grouping dimension. */
export type BenchMeta = Record<string, unknown>;

/**
 * Optional window of full load, in the same clock as `timestamps`. A scene that
 * starts its elements gradually is under a rising, then falling load, so an
 * average over the whole run mixes three different workloads. A page that knows
 * when every element was running reports it here and only that span is measured.
 *
 * Names of the meta keys carrying the window. The tool cannot derive them: it
 * knows nothing about how a scene ramps up.
 */
export const STEADY_STATE_KEYS = {
  from: "steadyStateFromMs",
  to: "steadyStateToMs",
} as const;

export interface SteadyStateWindow {
  fromMs: number;
  toMs: number;
}

/**
 * Reads the window a page declared. Returns null when the page declares none,
 * which keeps the tool usable against scenes that have no ramp at all.
 */
export function readSteadyStateWindow(meta: BenchMeta | undefined): SteadyStateWindow | null {
  if (!meta) return null;
  const from = meta[STEADY_STATE_KEYS.from];
  const to = meta[STEADY_STATE_KEYS.to];
  if (typeof from !== "number" || !Number.isFinite(from)) return null;
  if (typeof to !== "number" || !Number.isFinite(to)) return null;
  if (to <= from) return null;
  return { fromMs: from, toMs: to };
}

/**
 * Read from the page after a run. The page performs no aggregation: computing
 * inside the page would load the very thread being measured.
 */
export interface BenchResult {
  /** From `performance.now()`, in milliseconds. */
  timestamps: number[];
  baseline: BenchBaseline;
  meta: BenchMeta;
  startTime: number;
  endTime: number;
  /** Set when the page's timestamp buffer ran out; such a run is discarded. */
  overflowed: boolean;
}

export interface BenchPageError {
  message: string;
  stack?: string;
}

export type ContractViolation = { path: string; problem: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateBaseline(value: unknown, violations: ContractViolation[]): void {
  if (typeof value !== "object" || value === null) {
    violations.push({ path: "baseline", problem: "missing or not an object" });
    return;
  }
  const baseline = value as Record<string, unknown>;
  if (!isFiniteNumber(baseline["frameIntervalMs"]) || baseline["frameIntervalMs"] <= 0) {
    violations.push({ path: "baseline.frameIntervalMs", problem: "not a positive number" });
  }
  if (!isFiniteNumber(baseline["refreshRateHz"]) || baseline["refreshRateHz"] <= 0) {
    violations.push({ path: "baseline.refreshRateHz", problem: "not a positive number" });
  }
  const samples = baseline["samples"];
  if (samples !== undefined && !(Array.isArray(samples) && samples.every(isFiniteNumber))) {
    violations.push({ path: "baseline.samples", problem: "not an array of finite numbers" });
  }
}

/**
 * Returns every violation rather than a boolean, so a page breaking the
 * contract fails loudly instead of yielding a run that means something else.
 */
export function validateBenchResult(value: unknown): ContractViolation[] {
  const violations: ContractViolation[] = [];

  if (typeof value !== "object" || value === null) {
    return [{ path: "", problem: "result is not an object" }];
  }
  const result = value as Record<string, unknown>;

  const timestamps = result["timestamps"];
  if (!Array.isArray(timestamps)) {
    violations.push({ path: "timestamps", problem: "missing or not an array" });
  } else if (!timestamps.every(isFiniteNumber)) {
    violations.push({ path: "timestamps", problem: "contains non-finite values" });
  } else if (timestamps.length < 2) {
    violations.push({ path: "timestamps", problem: "fewer than two frames recorded" });
  }

  validateBaseline(result["baseline"], violations);

  if (typeof result["meta"] !== "object" || result["meta"] === null) {
    violations.push({ path: "meta", problem: "missing or not an object" });
  }
  if (!isFiniteNumber(result["startTime"])) {
    violations.push({ path: "startTime", problem: "not a finite number" });
  }
  if (!isFiniteNumber(result["endTime"])) {
    violations.push({ path: "endTime", problem: "not a finite number" });
  }
  if (typeof result["overflowed"] !== "boolean") {
    violations.push({ path: "overflowed", problem: "not a boolean" });
  }

  return violations;
}

export function isBenchResult(value: unknown): value is BenchResult {
  return validateBenchResult(value).length === 0;
}
