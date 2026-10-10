import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { Browser } from "playwright";

const run = promisify(execFile);

/**
 * Reads GPU utilisation from the operating system. Browsers do not expose it,
 * so it is the one figure the tool takes from outside the browser. What it
 * covers differs by platform, and the readings are only comparable between
 * techniques on one device.
 */
export interface GpuUsageReader {
  /** What the figure covers, recorded with the run. */
  scope: "system" | "browser-gpu-process";
  /** Latest utilisation in percent, or null when no reading is available. */
  read(): Promise<number | null>;
  close(): void;
}

/** Parses `ioreg -c IOAccelerator`; Apple's driver reports whole-GPU utilisation. */
export function parseIoregUtilization(text: string): number | null {
  const match = /"Device Utilization %"\s*=\s*(\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** Splits one line of typeperf's quoted CSV. */
function csvCells(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] as string);
}

/**
 * Sums the 3D-engine utilisation of one process from a typeperf header and data
 * line. Windows names each counter instance after the process, for example
 * `pid_1234_luid_..._engtype_3D`, which is how Task Manager attributes GPU use.
 */
export function parseTypeperfLine(header: string, line: string, pid: number): number | null {
  const names = csvCells(header);
  const values = csvCells(line);
  let total = 0;
  let found = false;
  names.forEach((name, index) => {
    if (!name.includes(`pid_${pid}_`) || !/engtype_3D\)/i.test(name)) return;
    const value = Number(values[index]);
    if (Number.isFinite(value)) {
      total += value;
      found = true;
    }
  });
  return found ? Math.min(total, 100) : null;
}

function macReader(): GpuUsageReader {
  return {
    scope: "system",
    async read() {
      try {
        const { stdout } = await run("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], { timeout: 2_000 });
        return parseIoregUtilization(stdout);
      } catch {
        return null;
      }
    },
    close() {},
  };
}

/**
 * One typeperf process streams the counters for the whole batch: starting
 * PowerShell for every sample would itself load the CPU being measured.
 */
function windowsReader(gpuProcessId: number): GpuUsageReader {
  const child: ChildProcess = spawn("typeperf", ["\\GPU Engine(*)\\Utilization Percentage", "-si", "1"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let header: string | null = null;
  let latest: number | null = null;
  if (child.stdout) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.startsWith('"')) return;
      if (line.startsWith('"(PDH-CSV')) header = line;
      else if (header) latest = parseTypeperfLine(header, line, gpuProcessId);
    });
  }
  const close = () => {
    if (child.exitCode === null) child.kill();
  };
  process.once("exit", close);
  return {
    scope: "browser-gpu-process",
    async read() {
      return latest;
    },
    close() {
      process.off("exit", close);
      close();
    },
  };
}

/** Process id of the browser's GPU process, which Windows attributes GPU use to. */
export async function readGpuProcessId(browser: Browser): Promise<number | null> {
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = (await session.send("SystemInfo.getProcessInfo")) as {
      processInfo: { type: string; id: number }[];
    };
    return processInfo.find((process) => process.type === "GPU")?.id ?? null;
  } catch {
    return null;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/**
 * Opens a reader for a batch that samples CPU on a desktop, and checks it with
 * one reading so the capabilities record what was actually available.
 */
export async function openForBatch(
  kind: "desktop" | "android",
  sampling: boolean,
  browser: Browser | null,
): Promise<{ reader: GpuUsageReader | null; available: boolean }> {
  if (!sampling || kind !== "desktop" || !browser) return { reader: null, available: false };
  const reader = openGpuUsageReader(await readGpuProcessId(browser));
  if (!reader) return { reader: null, available: false };
  // typeperf reports its first values about a second after it starts.
  let reading = await reader.read();
  for (let attempt = 0; reading === null && attempt < 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    reading = await reader.read();
  }
  return { reader, available: reading !== null };
}

/**
 * A reader for the machine the browser runs on, or null where the platform has
 * no unprivileged source. Never used for a phone: the computer it is attached
 * to has a GPU of its own.
 */
export function openGpuUsageReader(gpuProcessId: number | null): GpuUsageReader | null {
  if (process.platform === "darwin") return macReader();
  if (process.platform === "win32" && gpuProcessId !== null) return windowsReader(gpuProcessId);
  return null;
}
