import { test } from "node:test";
import assert from "node:assert/strict";
import {
  androidHostInfo,
  countCpuRange,
  parseAdbDevices,
  parseDumpsysBattery,
  parseGetprop,
  parseWmSize,
} from "../src/android/adb.js";

// Captured from the Android 16 emulator used to develop the Android target.
const emulatorBattery = `Current Battery Service state:
  AC powered: false
  USB powered: false
  Wireless powered: false
  Dock powered: false
  Max charging current: 0
  status: 4
  health: 2
  present: true
  level: 100
  scale: 100
`;

const emulatorProps = `[ro.board.platform]: []
[ro.build.version.release]: [16]
[ro.build.version.sdk]: [36]
[ro.hardware]: [ranchu]
[ro.product.manufacturer]: [Google]
[ro.product.model]: [sdk_gphone64_arm64]
[ro.soc.manufacturer]: [AOSP]
[ro.soc.model]: [ranchu]
`;

test("adb devices lists every device with its state", () => {
  const listing = "List of devices attached\nemulator-5554\tdevice\nR58M123ABC\tunauthorized\n192.168.1.20:37000\tdevice\n\n";
  assert.deepEqual(parseAdbDevices(listing), [
    { serial: "emulator-5554", state: "device" },
    { serial: "R58M123ABC", state: "unauthorized" },
    { serial: "192.168.1.20:37000", state: "device" },
  ]);
  assert.deepEqual(parseAdbDevices("List of devices attached\n\n"), []);
});

test("a phone on no external power runs on battery", () => {
  assert.deepEqual(parseDumpsysBattery(emulatorBattery), {
    source: "battery",
    batteryPercent: 100,
    batteryState: "not charging",
  });
});

test("a phone on a USB cable counts as externally powered", () => {
  const usb = emulatorBattery.replace("USB powered: false", "USB powered: true").replace("status: 4", "status: 2").replace("level: 100", "level: 87");
  assert.deepEqual(parseDumpsysBattery(usb), { source: "ac", batteryPercent: 87, batteryState: "charging" });
});

test("battery level is scaled when the scale is not 100", () => {
  const scaled = emulatorBattery.replace("level: 100", "level: 50").replace("scale: 100", "scale: 200");
  assert.equal(parseDumpsysBattery(scaled).batteryPercent, 25);
});

test("an unreadable battery report is unknown, not on battery", () => {
  assert.deepEqual(parseDumpsysBattery(""), { source: "unknown", batteryPercent: null, batteryState: null });
});

test("system properties describe the phone", () => {
  const host = androidHostInfo(parseGetprop(emulatorProps), 8, "MemTotal:        2022324 kB\n");
  assert.deepEqual(host, {
    platform: "android",
    osVersion: "Android 16 (API 36)",
    model: "Google sdk_gphone64_arm64",
    cpu: "AOSP ranchu",
    cpuCores: 8,
    memoryGb: 1.9,
  });
});

test("phones older than Android 12 fall back to the board name", () => {
  const props = parseGetprop("[ro.board.platform]: [msm8998]\n[ro.build.version.release]: [9]\n");
  assert.equal(androidHostInfo(props, 8, "").cpu, "msm8998");
});

test("kernel CPU ranges are counted including split clusters", () => {
  assert.equal(countCpuRange("0-7\n"), 8);
  assert.equal(countCpuRange("0"), 1);
  assert.equal(countCpuRange("0-3,6-7"), 6);
  assert.equal(countCpuRange(""), 0);
});

test("the phone display comes from wm size, honouring an override", () => {
  assert.equal(parseWmSize("Physical size: 1080x2400\n")?.resolution, "1080x2400");
  assert.equal(parseWmSize("Physical size: 1440x3120\nOverride size: 1080x2340\n")?.resolution, "1080x2340");
  assert.equal(parseWmSize(""), null);
});
