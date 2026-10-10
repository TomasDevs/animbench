import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The physical display the browser draws to. Read from the system, because
 * the page only sees what Playwright emulates: a desktop context reports a
 * screen the size of its viewport and a pixel ratio of 1 on any monitor.
 */
export interface DisplayInfo {
  name: string | null;
  /** As the system presents it, e.g. "2560x1440". */
  resolution: string;
  refreshHz: number | null;
  connection: "internal" | "external" | null;
}

export interface HostInfo {
  platform: string;
  osVersion: string | null;
  /** Vendor model identifier, e.g. "Mac15,12"; null where the OS hides it. */
  model: string | null;
  cpu: string;
  cpuCores: number;
  memoryGb: number;
  /** The main display, or null where the system does not say. */
  display?: DisplayInfo | null;
}

/** One stable label per display, used to keep display conditions apart. */
export function describeDisplay(display: DisplayInfo): string {
  const refresh = display.refreshHz ? `@${display.refreshHz}Hz` : "";
  return [display.name, `${display.resolution}${refresh}`].filter(Boolean).join(" ");
}

/** Picks the main display from `system_profiler SPDisplaysDataType -json`. */
export function parseMacDisplays(json: string): DisplayInfo | null {
  let data: { SPDisplaysDataType?: { spdisplays_ndrvs?: Record<string, string>[] }[] };
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const displays = (data.SPDisplaysDataType ?? []).flatMap((gpu) => gpu.spdisplays_ndrvs ?? []);
  const main = displays.find((display) => display["spdisplays_main"] === "spdisplays_yes") ?? displays[0];
  if (!main) return null;

  const resolution = /(\d+)\s*x\s*(\d+)(?:\s*@\s*([\d.]+)Hz)?/.exec(main["_spdisplays_resolution"] ?? "");
  if (!resolution) return null;
  const connection = main["spdisplays_connection_type"];
  return {
    name: main["_name"] ?? null,
    resolution: `${resolution[1]}x${resolution[2]}`,
    refreshHz: resolution[3] ? Math.round(Number(resolution[3])) : null,
    connection: connection === "spdisplays_internal" ? "internal" : connection ? "external" : null,
  };
}

export interface PowerState {
  source: "ac" | "battery" | "unknown";
  batteryPercent: number | null;
  /** As the OS words it, e.g. "charging", "discharging", "charged". */
  batteryState: string | null;
}

const UNKNOWN_POWER: PowerState = { source: "unknown", batteryPercent: null, batteryState: null };

/** Never throws: a missing tool or permission yields null, not a failed batch. */
async function output(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(command, args, { timeout: 5_000 });
    return stdout;
  } catch {
    return null;
  }
}

/** Parses `pmset -g batt`. */
export function parsePmset(text: string): PowerState {
  const source = /drawing from 'AC Power'/.test(text)
    ? "ac"
    : /drawing from 'Battery Power'/.test(text)
      ? "battery"
      : "unknown";
  const battery = /\t(\d+)%;\s*([^;]+);/.exec(text);
  return {
    source,
    batteryPercent: battery ? Number(battery[1]) : null,
    batteryState: battery ? (battery[2] as string).trim() : null,
  };
}

/**
 * Parses `Win32_Battery` fields as printed by PowerShell. BatteryStatus 2 is
 * "on AC", per the WMI documentation; 1 means discharging.
 */
export function parseWindowsBattery(text: string): PowerState {
  const charge = /EstimatedChargeRemaining\s*:\s*(\d+)/.exec(text);
  const status = /BatteryStatus\s*:\s*(\d+)/.exec(text);
  if (!charge || !status) return { source: "ac", batteryPercent: null, batteryState: null };
  const code = Number(status[1]);
  return {
    source: code === 1 ? "battery" : "ac",
    batteryPercent: Number(charge[1]),
    batteryState: code === 1 ? "discharging" : code === 2 ? "on AC" : `status ${code}`,
  };
}

/** Reads `/sys/class/power_supply`, where each supply is a directory. */
async function readLinuxPower(): Promise<PowerState> {
  const base = "/sys/class/power_supply";
  const read = async (path: string) => (await readFile(path, "utf8").catch(() => "")).trim();
  const supplies = await readdir(base).catch(() => [] as string[]);

  let acOnline: boolean | null = null;
  let percent: number | null = null;
  let state: string | null = null;
  for (const supply of supplies) {
    const type = await read(join(base, supply, "type"));
    if (type === "Mains") acOnline = (await read(join(base, supply, "online"))) === "1";
    if (type === "Battery") {
      const capacity = await read(join(base, supply, "capacity"));
      percent = capacity ? Number(capacity) : null;
      state = (await read(join(base, supply, "status"))).toLowerCase() || null;
    }
  }

  const source = acOnline === true ? "ac" : acOnline === false ? "battery" : percent === null ? "ac" : "unknown";
  return { source, batteryPercent: percent, batteryState: state };
}

/**
 * Read before and after every run, outside the measured span. Laptops throttle
 * on battery, so a run's power state is a condition of the measurement, not
 * a detail of the machine.
 */
export async function readPowerState(): Promise<PowerState> {
  switch (process.platform) {
    case "darwin": {
      const text = await output("pmset", ["-g", "batt"]);
      return text ? parsePmset(text) : UNKNOWN_POWER;
    }
    case "win32": {
      const text = await output("powershell", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Battery | Format-List EstimatedChargeRemaining,BatteryStatus",
      ]);
      return text === null ? UNKNOWN_POWER : parseWindowsBattery(text);
    }
    case "linux":
      return readLinuxPower();
    default:
      return UNKNOWN_POWER;
  }
}

async function readModel(): Promise<string | null> {
  switch (process.platform) {
    case "darwin":
      return (await output("sysctl", ["-n", "hw.model"]))?.trim() || null;
    case "linux":
      return (await readFile("/sys/devices/virtual/dmi/id/product_name", "utf8").catch(() => "")).trim() || null;
    case "win32":
      return (
        (await output("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystem).Model"]))?.trim() ||
        null
      );
    default:
      return null;
  }
}

async function readOsVersion(): Promise<string | null> {
  if (process.platform === "darwin") {
    const version = (await output("sw_vers", ["-productVersion"]))?.trim();
    return version ? `macOS ${version}` : null;
  }
  if (process.platform === "linux") {
    const release = await readFile("/etc/os-release", "utf8").catch(() => "");
    return /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release)?.[1] ?? null;
  }
  return os.version() || null;
}

/**
 * Recorded automatically because hand-written labels went wrong once already:
 * a batch measured at 60 Hz carried a "75Hz" label from an earlier setup.
 */
async function readDisplay(): Promise<DisplayInfo | null> {
  if (process.platform !== "darwin") return null;
  const json = await output("system_profiler", ["SPDisplaysDataType", "-json"]);
  return json ? parseMacDisplays(json) : null;
}

export async function readHostInfo(): Promise<HostInfo> {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    osVersion: await readOsVersion(),
    model: await readModel(),
    cpu: cpus[0]?.model.trim() ?? "unknown",
    cpuCores: cpus.length,
    memoryGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    display: await readDisplay(),
  };
}
