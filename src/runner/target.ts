import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser, type Page } from "playwright";
import { connectDevice, findAdb, type AdbDevice } from "../android/adb.js";
import { readHostInfo, readPowerState, type HostInfo, type PowerState } from "../diagnostics/host.js";

export interface TargetOptions {
  target: "desktop" | "android";
  headless?: boolean;
  /** Desktop only: a phone always measures at its own screen size. */
  viewport?: { width: number; height: number };
  deviceSerial?: string;
  adbPath?: string;
  /** A localhost address here is made reachable from the phone over USB. */
  appUrl?: string;
}

/** Where a run happens. Batches and commands never need to know which kind. */
export interface MeasurementTarget {
  kind: "desktop" | "android";
  page: Page;
  readHost(): Promise<HostInfo>;
  readPower(): Promise<PowerState>;
}

const CHROME_PACKAGE = "com.android.chrome";
const CHROME_ACTIVITY = `${CHROME_PACKAGE}/com.google.android.apps.chrome.Main`;
const DEVTOOLS_SOCKET = "chrome_devtools_remote";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function localPort(url: string | undefined): number | null {
  if (!url) return null;
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return null;
  return Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
}

/**
 * Android only renders what is on screen, so a dark or locked screen would
 * stall the run rather than slow it.
 */
async function assertScreenOn(device: AdbDevice): Promise<void> {
  const power = await device.shell("dumpsys power").catch(() => "");
  const wakefulness = /mWakefulness=(\w+)/.exec(power)?.[1];
  if (wakefulness && wakefulness !== "Awake") {
    throw new Error(`the phone screen is ${wakefulness.toLowerCase()}; wake and unlock it`);
  }
}

/**
 * Chrome only opens its DevTools socket once it runs, so it is started first
 * and the socket awaited.
 */
async function startChrome(device: AdbDevice): Promise<void> {
  await device.shell(`am start -n ${CHROME_ACTIVITY}`);
  for (let attempt = 0; attempt < 20; attempt++) {
    const sockets = await device.shell("cat /proc/net/unix").catch(() => "");
    if (sockets.includes(`@${DEVTOOLS_SOCKET}`)) return;
    await sleep(500);
  }
  throw new Error("Chrome did not open its DevTools socket; is USB debugging enabled?");
}

async function withDesktop<T>(
  options: TargetOptions,
  body: (target: MeasurementTarget) => Promise<T>,
): Promise<T> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: options.headless ?? false });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    return await body({ kind: "desktop", page, readHost: readHostInfo, readPower: readPowerState });
  } finally {
    await browser?.close();
  }
}

/**
 * Connects the way chrome://inspect does: the phone's DevTools socket is
 * forwarded to a local port. Playwright's own Android launcher depends on a
 * flags file that Chrome ignores on phones that are not rooted.
 */
async function withAndroid<T>(
  options: TargetOptions,
  body: (target: MeasurementTarget) => Promise<T>,
): Promise<T> {
  const device = await connectDevice(await findAdb(options.adbPath), options.deviceSerial);
  await assertScreenOn(device);
  await startChrome(device);

  const devtoolsPort = await freePort();
  const appPort = localPort(options.appUrl);
  await device.run(["forward", `tcp:${devtoolsPort}`, `localabstract:${DEVTOOLS_SOCKET}`]);
  if (appPort) await device.run(["reverse", `tcp:${appPort}`, `tcp:${appPort}`]);

  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtoolsPort}`, { timeout: 30_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome on the phone exposed no browsing context");
    page = await context.newPage();
    return await body({
      kind: "android",
      page,
      readHost: () => device.readHost(),
      readPower: () => device.readPower(),
    });
  } finally {
    await page?.close().catch(() => undefined);
    // Disconnects without quitting Chrome on the phone.
    await browser?.close().catch(() => undefined);
    await device.run(["forward", "--remove", `tcp:${devtoolsPort}`]).catch(() => undefined);
    if (appPort) await device.run(["reverse", "--remove", `tcp:${appPort}`]).catch(() => undefined);
  }
}

export function withTarget<T>(
  options: TargetOptions,
  body: (target: MeasurementTarget) => Promise<T>,
): Promise<T> {
  return options.target === "android" ? withAndroid(options, body) : withDesktop(options, body);
}
