import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DisplayInfo, HostInfo, PowerState } from "../diagnostics/host.js";

const run = promisify(execFile);

export interface AdbDeviceEntry {
  serial: string;
  /** "device" when usable; "unauthorized" until the phone accepts the computer. */
  state: string;
}

/** Parses `adb devices`. */
export function parseAdbDevices(text: string): AdbDeviceEntry[] {
  return text
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[0])
    .map(([serial, state]) => ({ serial: serial as string, state: state as string }));
}

/** Parses `getprop` output, lines of the form `[key]: [value]`. */
export function parseGetprop(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const match of text.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]/gm)) {
    props[match[1] as string] = match[2] as string;
  }
  return props;
}

const BATTERY_STATUS: Record<string, string> = {
  "2": "charging",
  "3": "discharging",
  "4": "not charging",
  "5": "full",
};

/**
 * Parses `dumpsys battery`. A phone on a USB cable counts as externally
 * powered: it charges, so battery runs need wireless debugging instead.
 */
export function parseDumpsysBattery(text: string): PowerState {
  const field = (name: string) => new RegExp(`^\\s*${name}: (.+)$`, "m").exec(text)?.[1]?.trim();
  const powered = ["AC powered", "USB powered", "Wireless powered", "Dock powered"].some(
    (name) => field(name) === "true",
  );
  const level = Number(field("level"));
  const scale = Number(field("scale") ?? 100);
  const status = field("status");

  return {
    source: text.trim() ? (powered ? "ac" : "battery") : "unknown",
    batteryPercent: Number.isFinite(level) && scale > 0 ? Math.round((level / scale) * 100) : null,
    batteryState: status ? (BATTERY_STATUS[status] ?? `status ${status}`) : null,
  };
}

/** Parses `wm size`; an override set by the user takes precedence. */
export function parseWmSize(text: string): DisplayInfo | null {
  const size =
    /Override size:\s*(\d+)x(\d+)/.exec(text) ?? /Physical size:\s*(\d+)x(\d+)/.exec(text);
  if (!size) return null;
  return { name: null, resolution: `${size[1]}x${size[2]}`, refreshHz: null, connection: "internal" };
}

/** Counts CPUs in a kernel range list such as "0-3,6-7". */
export function countCpuRange(text: string): number {
  return text
    .trim()
    .split(",")
    .filter(Boolean)
    .reduce((total, part) => {
      const [from, to] = part.split("-").map(Number);
      if (from === undefined || !Number.isFinite(from)) return total;
      return total + (to === undefined ? 1 : to - from + 1);
    }, 0);
}

/** Builds the host description from system properties and kernel figures. */
export function androidHostInfo(
  props: Record<string, string>,
  cpuCores: number,
  meminfo: string,
): HostInfo {
  const memKb = Number(/^MemTotal:\s+(\d+)\s+kB/m.exec(meminfo)?.[1]);
  const soc = [props["ro.soc.manufacturer"], props["ro.soc.model"]].filter(Boolean).join(" ");
  const release = props["ro.build.version.release"];
  const sdk = props["ro.build.version.sdk"];

  return {
    platform: "android",
    osVersion: release ? `Android ${release}${sdk ? ` (API ${sdk})` : ""}` : null,
    model:
      [props["ro.product.manufacturer"], props["ro.product.model"]].filter(Boolean).join(" ") ||
      null,
    // ro.soc.* exists from Android 12; older phones only name the board.
    cpu: soc || props["ro.board.platform"] || props["ro.hardware"] || "unknown",
    cpuCores,
    memoryGb: Number.isFinite(memKb) ? Math.round((memKb / 2 ** 20) * 10) / 10 : 0,
  };
}

/** Where Android Studio and the SDK command-line tools install adb by default. */
function adbCandidates(): string[] {
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  const sdkRoots = [
    process.env["ANDROID_HOME"],
    process.env["ANDROID_SDK_ROOT"],
    join(os.homedir(), "Library", "Android", "sdk"),
    join(os.homedir(), "Android", "Sdk"),
    process.env["LOCALAPPDATA"] && join(process.env["LOCALAPPDATA"], "Android", "Sdk"),
  ].filter((root): root is string => Boolean(root));
  return sdkRoots.map((root) => join(root, "platform-tools", executable));
}

export async function findAdb(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  for (const candidate of adbCandidates()) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return "adb";
}

export class AdbDevice {
  constructor(
    private readonly adb: string,
    readonly serial: string,
  ) {}

  async run(args: string[]): Promise<string> {
    const { stdout } = await run(this.adb, ["-s", this.serial, ...args], { timeout: 15_000 });
    return stdout;
  }

  shell(command: string): Promise<string> {
    return this.run(["shell", command]);
  }

  async readHost(): Promise<HostInfo> {
    const [props, possible, nproc, meminfo, wmSize] = await Promise.all([
      this.shell("getprop"),
      this.shell("cat /sys/devices/system/cpu/possible").catch(() => ""),
      this.shell("nproc").catch(() => "0"),
      this.shell("cat /proc/meminfo").catch(() => ""),
      this.shell("wm size").catch(() => ""),
    ]);
    // nproc counts only the cores the debug shell may use, which Android can
    // restrict to the efficiency cluster; the kernel list covers the whole SoC.
    const cores = countCpuRange(possible) || Number(nproc.trim()) || 0;
    return { ...androidHostInfo(parseGetprop(props), cores, meminfo), display: parseWmSize(wmSize) };
  }

  async readPower(): Promise<PowerState> {
    return parseDumpsysBattery(await this.shell("dumpsys battery").catch(() => ""));
  }
}

/**
 * Picks the phone to measure. With several connected the serial must be named:
 * guessing could measure the wrong device without anyone noticing.
 */
export async function connectDevice(adb: string, serial?: string): Promise<AdbDevice> {
  let listing: string;
  try {
    listing = (await run(adb, ["devices"], { timeout: 15_000 })).stdout;
  } catch {
    throw new Error(`adb not found or not runnable (${adb}); install Android platform-tools`);
  }

  const devices = parseAdbDevices(listing);
  const chosen = serial
    ? devices.find((device) => device.serial === serial)
    : devices.length === 1
      ? devices[0]
      : undefined;

  if (!chosen) {
    if (serial) throw new Error(`device ${serial} is not connected`);
    if (devices.length === 0) throw new Error("no Android device connected; enable USB debugging");
    throw new Error(
      `several devices connected (${devices.map((device) => device.serial).join(", ")}); ` +
        "set browser.deviceSerial",
    );
  }
  if (chosen.state === "unauthorized") {
    throw new Error(`device ${chosen.serial} has not authorised this computer; confirm the prompt on the phone`);
  }
  if (chosen.state !== "device") {
    throw new Error(`device ${chosen.serial} is ${chosen.state}`);
  }
  return new AdbDevice(adb, chosen.serial);
}
