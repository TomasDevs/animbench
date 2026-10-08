import { chromium, type Browser } from "playwright";

/**
 * Without GPU compositing and rasterization the browser paints on the CPU,
 * which erases the very advantage of compositor-driven animation that these
 * measurements compare. A run failing this check is not comparable.
 */
export const REQUIRED_FEATURES = ["gpu_compositing", "rasterization"] as const;

/** Substrings identifying renderers that run on the CPU. */
const SOFTWARE_RENDERERS = ["swiftshader", "llvmpipe", "software"];

export interface GpuStatus {
  /** Chrome's feature status map, e.g. `{ gpu_compositing: "enabled" }`. */
  features: Record<string, string>;
  renderer: string | null;
  accelerated: boolean;
  missing: string[];
}

export function isSoftwareRenderer(renderer: string | null): boolean {
  if (!renderer) return false;
  const lowered = renderer.toLowerCase();
  return SOFTWARE_RENDERERS.some((marker) => lowered.includes(marker));
}

/**
 * Statuses read "enabled", "enabled_on" or "enabled_force" when the GPU does
 * the work, and "disabled_software" and the like when it does not.
 */
export function evaluateGpuStatus(
  features: Record<string, string>,
  renderer: string | null,
): GpuStatus {
  const missing: string[] = REQUIRED_FEATURES.filter(
    (feature) => !/^enabled/.test(features[feature] ?? ""),
  );
  if (isSoftwareRenderer(renderer)) missing.push(`software renderer (${renderer})`);
  return { features, renderer, accelerated: missing.length === 0, missing };
}

/**
 * Read over CDP rather than scraped from chrome://gpu: the structured answer
 * survives redesigns of that page, and chrome:// pages cannot be opened at all
 * in headless or Android Chrome.
 */
export async function readGpuStatus(browser: Browser): Promise<GpuStatus> {
  const session = await browser.newBrowserCDPSession();
  try {
    const info = (await session.send("SystemInfo.getInfo")) as {
      gpu: { featureStatus?: Record<string, string>; devices?: { deviceString?: string }[] };
    };
    return evaluateGpuStatus(
      info.gpu.featureStatus ?? {},
      info.gpu.devices?.[0]?.deviceString?.trim() || null,
    );
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export async function runGpuCheck(options: { headless?: boolean } = {}): Promise<GpuStatus> {
  const browser = await chromium.launch({ headless: options.headless ?? false });
  try {
    return await readGpuStatus(browser);
  } finally {
    await browser.close();
  }
}
