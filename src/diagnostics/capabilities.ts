import type { Page } from "playwright";

/**
 * Which CDP readings the target actually provides. Recorded with every run so
 * that a missing figure is traceable to the platform rather than to the page.
 */
export interface Capabilities {
  /** `SystemInfo.getInfo` reports GPU feature status. */
  gpuStatus: boolean;
  /** `Performance.getMetrics` reports main-thread task durations. */
  mainThreadMetrics: boolean;
  /**
   * `SystemInfo.getProcessInfo` reports CPU time of renderer and GPU processes.
   * Android answers the call but reports zero for its sandboxed processes.
   */
  processCpu: boolean;
}

interface ProcessInfo {
  type: string;
  cpuTime: number;
}

/**
 * A live renderer cannot have used no CPU at all, so all-zero renderer times
 * mean the platform hides them, not that the page was idle.
 */
export function processCpuAvailable(processes: readonly ProcessInfo[]): boolean {
  return processes.some((process) => process.type === "renderer" && process.cpuTime > 0);
}

async function succeeds(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

export async function probeCapabilities(page: Page): Promise<Capabilities> {
  const browser = page.context().browser();
  if (!browser) return { gpuStatus: false, mainThreadMetrics: false, processCpu: false };

  const browserSession = await browser.newBrowserCDPSession();
  const pageSession = await page.context().newCDPSession(page);
  try {
    return {
      gpuStatus: await succeeds(async () => {
        const info = (await browserSession.send("SystemInfo.getInfo")) as {
          gpu: { featureStatus?: Record<string, string> };
        };
        return Object.keys(info.gpu.featureStatus ?? {}).length > 0;
      }),
      mainThreadMetrics: await succeeds(async () => {
        await pageSession.send("Performance.enable");
        const { metrics } = (await pageSession.send("Performance.getMetrics")) as {
          metrics: { name: string }[];
        };
        await pageSession.send("Performance.disable");
        return metrics.some((metric) => metric.name === "TaskDuration");
      }),
      processCpu: await succeeds(async () => {
        const { processInfo } = (await browserSession.send("SystemInfo.getProcessInfo")) as {
          processInfo: ProcessInfo[];
        };
        return processCpuAvailable(processInfo);
      }),
    };
  } finally {
    await pageSession.detach().catch(() => undefined);
    await browserSession.detach().catch(() => undefined);
  }
}
