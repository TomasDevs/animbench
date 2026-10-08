import type { Page } from "playwright";
import type { RunEnvironment } from "../types/record.js";
import { probeCapabilities } from "./capabilities.js";
import { readGpuStatus } from "./gpu.js";
import { readHostInfo } from "./host.js";

/** Read once, before any run; per-run fields are filled in by the caller. */
export async function readEnvironment(
  page: Page,
  viewport: { width: number; height: number },
): Promise<RunEnvironment> {
  const browser = page.context().browser();
  if (!browser) throw new Error("the measured page has no browser to inspect");
  const gpu = await readGpuStatus(browser);
  const host = await readHostInfo();
  return {
    browser: browser.version(),
    operatingSystem: host.osVersion,
    renderer: gpu.renderer,
    hardwareAccelerated: gpu.accelerated,
    viewport,
    devicePixelRatio: null,
    host,
    capabilities: await probeCapabilities(page),
  };
}
