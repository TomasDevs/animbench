import type { CDPSession, Page } from "playwright";
import { processCpuAvailable } from "../diagnostics/capabilities.js";
import type { GpuUsageReader } from "../diagnostics/gpu-usage.js";
import type { CpuSample } from "../types/record.js";

interface PerformanceMetric {
  name: string;
  value: number;
}

interface ProcessInfo {
  type: string;
  cpuTime: number;
}

/** Converts raw CDP responses into one sample on the page clock. */
export function toCpuSample(
  metrics: readonly PerformanceMetric[],
  processes: readonly ProcessInfo[],
  clockOffsetMs: number,
): CpuSample {
  const metric = (name: string) => metrics.find((entry) => entry.name === name)?.value ?? 0;
  // CDP reports seconds; everything else in the tool is milliseconds.
  const ms = (name: string) => metric(name) * 1000;
  const processMs = (type: string) =>
    processes
      .filter((process) => process.type === type)
      .reduce((total, process) => total + process.cpuTime * 1000, 0);

  return {
    t: ms("Timestamp") + clockOffsetMs,
    mainThread: {
      taskMs: ms("TaskDuration"),
      scriptMs: ms("ScriptDuration"),
      styleMs: ms("RecalcStyleDuration"),
      layoutMs: ms("LayoutDuration"),
    },
    // Summed because the process list does not say which renderer serves which
    // page; a batch keeps only the measured page open.
    processCpuMs: processCpuAvailable(processes)
      ? { renderer: processMs("renderer"), gpu: processMs("GPU") }
      : null,
  };
}

/**
 * Samples CDP counters on a fixed interval while a run is in progress. Only
 * DevTools reads these counters, so the measured page runs no extra code.
 */
export class CpuSampler {
  private readonly samples: CpuSample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  private constructor(
    private readonly pageSession: CDPSession,
    private readonly browserSession: CDPSession,
    private readonly clockOffsetMs: number,
    private readonly intervalMs: number,
    private readonly gpuUsage: GpuUsageReader | null,
  ) {}

  /**
   * Must be called before the run starts: aligning the clocks evaluates script
   * in the page, which is only acceptable while nothing is being measured.
   */
  static async attach(page: Page, intervalMs: number, gpuUsage: GpuUsageReader | null = null): Promise<CpuSampler> {
    const browser = page.context().browser();
    if (!browser) throw new Error("CPU sampling needs a launched browser");

    const pageSession = await page.context().newCDPSession(page);
    const browserSession = await browser.newBrowserCDPSession();
    await pageSession.send("Performance.enable");

    const clockOffsetMs = await measureClockOffset(page, pageSession);
    return new CpuSampler(pageSession, browserSession, clockOffsetMs, intervalMs, gpuUsage);
  }

  async start(): Promise<void> {
    await this.sample();
    this.timer = setInterval(() => {
      // A slow reply must not let samples pile up behind each other.
      if (this.inFlight) return;
      this.inFlight = this.sample()
        .catch(() => undefined)
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.intervalMs);
  }

  async stop(): Promise<CpuSample[]> {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
    try {
      await this.sample();
    } finally {
      await this.pageSession.detach().catch(() => undefined);
      await this.browserSession.detach().catch(() => undefined);
    }
    return this.samples;
  }

  private async sample(): Promise<void> {
    const [{ metrics }, { processInfo }, gpu] = await Promise.all([
      this.pageSession.send("Performance.getMetrics") as Promise<{ metrics: PerformanceMetric[] }>,
      this.browserSession.send("SystemInfo.getProcessInfo") as Promise<{ processInfo: ProcessInfo[] }>,
      this.gpuUsage ? this.gpuUsage.read() : Promise.resolve(undefined),
    ]);
    const sample = toCpuSample(metrics, processInfo, this.clockOffsetMs);
    if (gpu !== undefined) sample.gpuUtilization = gpu;
    this.samples.push(sample);
  }
}

/**
 * CDP timestamps run on a different clock than `performance.now()`. The offset
 * is stable, so it is read a few times and the reading with the shortest round
 * trip wins: its two halves were taken closest together.
 */
async function measureClockOffset(page: Page, session: CDPSession): Promise<number> {
  let best = { offsetMs: 0, roundTripMs: Number.POSITIVE_INFINITY };

  for (let attempt = 0; attempt < 3; attempt++) {
    const sentAt = Date.now();
    const { metrics } = (await session.send("Performance.getMetrics")) as {
      metrics: PerformanceMetric[];
    };
    const pageNow = await page.evaluate(() => performance.now());
    const roundTripMs = Date.now() - sentAt;

    const timestamp = metrics.find((entry) => entry.name === "Timestamp")?.value ?? 0;
    if (roundTripMs < best.roundTripMs) {
      best = { offsetMs: pageNow - timestamp * 1000, roundTripMs };
    }
  }
  return best.offsetMs;
}
