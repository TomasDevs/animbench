import type { MeasurementTarget } from "../runner/target.js";
import type { RunEnvironment } from "../types/record.js";
import { probeCapabilities } from "./capabilities.js";
import { readGpuStatus } from "./gpu.js";

/** Read once, before any run; per-run fields are filled in by the caller. */
export async function readEnvironment(
  target: MeasurementTarget,
  viewport: { width: number; height: number },
): Promise<RunEnvironment> {
  const { page } = target;
  const browser = page.context().browser();
  if (!browser) throw new Error("the measured page has no browser to inspect");
  const gpu = await readGpuStatus(browser);
  const host = await target.readHost();
  // Read before any run, so a run that fails still carries its display.
  const display = await page
    .evaluate(() => ({
      devicePixelRatio: window.devicePixelRatio,
      screen: { width: window.screen.width, height: window.screen.height },
    }))
    .catch(() => null);
  return {
    browser: browser.version(),
    operatingSystem: host.osVersion,
    renderer: gpu.renderer,
    hardwareAccelerated: gpu.accelerated,
    viewport,
    devicePixelRatio: display?.devicePixelRatio ?? null,
    ...(display ? { screen: display.screen } : {}),
    host,
    capabilities: await probeCapabilities(page),
  };
}
