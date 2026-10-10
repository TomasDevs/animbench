import type { CpuSample } from "../types/record.js";

/** Shares of wall time within the measured window; NaN when not measurable. */
export interface CpuMetrics {
  mainThreadBusyRatio: number;
  mainThreadScriptRatio: number;
  mainThreadStyleRatio: number;
  mainThreadLayoutRatio: number;
  /** Main-thread work outside script, style and layout. */
  mainThreadOtherRatio: number;
  /** Can exceed 1: the process runs more than one thread. */
  rendererCpuRatio: number;
  gpuProcessCpuRatio: number;
  /**
   * Mean GPU utilisation over the samples inside the span, as a share. What it
   * covers depends on the platform (see `gpuUsageScope`).
   */
  gpuBusyRatio: number;
  cpuSampleCount: number;
}

const UNAVAILABLE: CpuMetrics = {
  mainThreadBusyRatio: Number.NaN,
  mainThreadScriptRatio: Number.NaN,
  mainThreadStyleRatio: Number.NaN,
  mainThreadLayoutRatio: Number.NaN,
  mainThreadOtherRatio: Number.NaN,
  rendererCpuRatio: Number.NaN,
  gpuProcessCpuRatio: Number.NaN,
  gpuBusyRatio: Number.NaN,
  cpuSampleCount: 0,
};

type Counter = (sample: CpuSample) => number;

const COUNTERS = {
  task: (sample) => sample.mainThread.taskMs,
  script: (sample) => sample.mainThread.scriptMs,
  style: (sample) => sample.mainThread.styleMs,
  layout: (sample) => sample.mainThread.layoutMs,
  renderer: (sample) => sample.processCpuMs?.renderer ?? Number.NaN,
  gpu: (sample) => sample.processCpuMs?.gpu ?? Number.NaN,
} satisfies Record<string, Counter>;

/**
 * Value of a cumulative counter at time `t`. Samples rarely land on the window
 * edges, so the value is interpolated between the two samples around `t`.
 */
export function counterAt(samples: readonly CpuSample[], t: number, counter: Counter): number {
  for (let index = 1; index < samples.length; index++) {
    const before = samples[index - 1] as CpuSample;
    const after = samples[index] as CpuSample;
    if (t < before.t || t > after.t) continue;
    if (after.t === before.t) return counter(before);
    const fraction = (t - before.t) / (after.t - before.t);
    return counter(before) + (counter(after) - counter(before)) * fraction;
  }
  return Number.NaN;
}

/**
 * Utilisation is an instantaneous percentage, not a counter, so the span's
 * value is the mean of the readings taken inside it.
 */
function meanGpuUtilization(samples: readonly CpuSample[], fromMs: number, toMs: number): number {
  const readings = samples
    .filter((sample) => sample.t >= fromMs && sample.t <= toMs)
    .map((sample) => sample.gpuUtilization)
    .filter((value): value is number => typeof value === "number");
  if (readings.length === 0) return Number.NaN;
  return readings.reduce((total, value) => total + value, 0) / readings.length / 100;
}

/**
 * CPU cost of the span `[fromMs, toMs]`, the same span the frame metrics use.
 * A span the samples do not cover yields NaN rather than a guess.
 */
export function computeCpuMetrics(
  samples: readonly CpuSample[] | undefined,
  fromMs: number,
  toMs: number,
): CpuMetrics {
  if (!samples || samples.length < 2 || toMs <= fromMs) return UNAVAILABLE;

  const first = samples[0] as CpuSample;
  const last = samples[samples.length - 1] as CpuSample;
  if (fromMs < first.t || toMs > last.t) return UNAVAILABLE;

  const span = toMs - fromMs;
  const share = (counter: Counter) =>
    (counterAt(samples, toMs, counter) - counterAt(samples, fromMs, counter)) / span;

  const busy = share(COUNTERS.task);
  const script = share(COUNTERS.script);
  const style = share(COUNTERS.style);
  const layout = share(COUNTERS.layout);

  return {
    mainThreadBusyRatio: busy,
    mainThreadScriptRatio: script,
    mainThreadStyleRatio: style,
    mainThreadLayoutRatio: layout,
    mainThreadOtherRatio: busy - script - style - layout,
    rendererCpuRatio: share(COUNTERS.renderer),
    gpuProcessCpuRatio: share(COUNTERS.gpu),
    gpuBusyRatio: meanGpuUtilization(samples, fromMs, toMs),
    cpuSampleCount: samples.filter((sample) => sample.t >= fromMs && sample.t <= toMs).length,
  };
}
