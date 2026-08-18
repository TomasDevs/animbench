import { chromium, type Browser, type Page } from "playwright";

export interface GpuFeatureStatus {
  name: string;
  status: string;
  hardwareAccelerated: boolean;
}

export interface GpuReport {
  features: GpuFeatureStatus[];
  chromeVersion: string | null;
  operatingSystem: string | null;
  graphicsBackend: string | null;
  webglRenderer: string | null;
  webglVendor: string | null;
}

/**
 * Without GPU compositing and rasterization the browser paints on the main
 * thread, which erases the very advantage of CSS-driven animation that these
 * measurements compare. A run on a machine failing this check is not
 * comparable to one that passes it.
 */
export const REQUIRED_FEATURES = ["Compositing", "Rasterization"] as const;

const GPU_URL = "chrome://gpu";

/**
 * chrome:// pages reject Playwright's normal navigation, so the address is
 * handed to the browser through CDP instead.
 */
async function openGpuPage(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Page.navigate", { url: GPU_URL });
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** Runs inside the page: chrome://gpu keeps its report in a shadow root. */
function readGpuPage(): Omit<GpuReport, "webglRenderer" | "webglVendor"> {
  const shadowRoot = document.querySelector("info-view")?.shadowRoot;
  if (!shadowRoot) {
    return {
      features: [],
      chromeVersion: null,
      operatingSystem: null,
      graphicsBackend: null,
    };
  }

  // The page reuses the feature-* colour classes for hundreds of ANGLE and
  // driver rows further down, so only the list right after the
  // "Graphics Feature Status" heading counts.
  const headings = Array.from(shadowRoot.querySelectorAll("h3"));
  const statusHeading = headings.find((heading) =>
    /graphics feature status/i.test(heading.textContent ?? ""),
  );
  const statusList = statusHeading?.nextElementSibling;

  const features: GpuFeatureStatus[] = [];
  for (const row of Array.from(statusList?.querySelectorAll("li") ?? [])) {
    const statusNode = row.querySelector("[class^='feature-']");
    if (!statusNode) continue;
    const rowText = (row.textContent ?? "").trim();
    const separator = rowText.indexOf(":");
    if (separator === -1) continue;
    const name = rowText.slice(0, separator).replace(/^[*\s]+/, "").trim();
    const status = (statusNode.textContent ?? "").trim();
    if (name.length === 0 || status.length === 0) continue;
    features.push({
      name,
      status,
      hardwareAccelerated: /hardware accelerated/i.test(status),
    });
  }

  const info = new Map<string, string>();
  for (const row of Array.from(shadowRoot.querySelectorAll("tr"))) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 2) continue;
    // Keys are padded with spaces and end with a colon, e.g. "Chrome version    :".
    const key = (cells[0]?.textContent ?? "")
      .replace(/\s*:\s*$/, "")
      .trim()
      .toLowerCase();
    const value = (cells[1]?.textContent ?? "").trim();
    if (key.length > 0 && !info.has(key)) info.set(key, value);
  }

  return {
    features,
    chromeVersion: info.get("chrome version") ?? null,
    operatingSystem: info.get("operating system") ?? null,
    graphicsBackend: info.get("2d graphics backend") ?? null,
  };
}

/** Runs inside the page. */
function readWebglInfo(): { webglRenderer: string | null; webglVendor: string | null } {
  const canvas = document.createElement("canvas");
  const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as
    | WebGLRenderingContext
    | null;
  if (!gl) return { webglRenderer: null, webglVendor: null };

  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererKey = debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const vendorKey = debugInfo ? debugInfo.UNMASKED_VENDOR_WEBGL : gl.VENDOR;
  return {
    webglRenderer: String(gl.getParameter(rendererKey)),
    webglVendor: String(gl.getParameter(vendorKey)),
  };
}

export async function inspectGpu(page: Page): Promise<GpuReport> {
  await openGpuPage(page);
  try {
    await page.waitForFunction(
      () => {
        const root = document.querySelector("info-view")?.shadowRoot;
        if (!root) return false;
        return Array.from(root.querySelectorAll("h3")).some((heading) =>
          /graphics feature status/i.test(heading.textContent ?? ""),
        );
      },
      undefined,
      { timeout: 20_000 },
    );
  } catch (cause) {
    // Headless Chromium refuses to open chrome:// pages at all, which is by
    // itself a reason not to measure in it.
    throw new Error(
      `Could not read ${GPU_URL} (browser reported ${page.url()}). ` +
        "The GPU report is unavailable in headless Chromium; run with a visible window.",
      { cause },
    );
  }

  const pageInfo = await page.evaluate(readGpuPage);

  // A fresh page: chrome:// pages forbid creating a WebGL context.
  const probePage = await page.context().newPage();
  try {
    await probePage.goto("about:blank");
    const webglInfo = await probePage.evaluate(readWebglInfo);
    return { ...pageInfo, ...webglInfo };
  } finally {
    await probePage.close();
  }
}

export interface GpuVerdict {
  report: GpuReport;
  missing: string[];
  accelerated: boolean;
}

/** Substrings identifying renderers that run on the CPU. */
const SOFTWARE_RENDERERS = ["swiftshader", "llvmpipe", "software"];

export function isSoftwareRenderer(renderer: string | null): boolean {
  if (!renderer) return false;
  const lowered = renderer.toLowerCase();
  return SOFTWARE_RENDERERS.some((marker) => lowered.includes(marker));
}

export function evaluateGpuReport(report: GpuReport): GpuVerdict {
  const missing: string[] = REQUIRED_FEATURES.filter((required) => {
    const match = report.features.find(
      (feature) => feature.name.toLowerCase() === required.toLowerCase(),
    );
    return !match?.hardwareAccelerated;
  });
  if (isSoftwareRenderer(report.webglRenderer)) {
    missing.push(`software renderer (${report.webglRenderer})`);
  }
  return { report, missing, accelerated: missing.length === 0 };
}

export async function runGpuCheck(
  options: { headless?: boolean } = {},
): Promise<GpuVerdict> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: options.headless ?? false });
    const context = await browser.newContext();
    const page = await context.newPage();
    const report = await inspectGpu(page);
    return evaluateGpuReport(report);
  } finally {
    await browser?.close();
  }
}
