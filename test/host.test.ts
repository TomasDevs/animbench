import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePmset, parseWindowsBattery } from "../src/diagnostics/host.js";

test("pmset on AC with a full battery", () => {
  const text = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=21364835)\t100%; charged; 0:00 remaining present: true\n";
  assert.deepEqual(parsePmset(text), { source: "ac", batteryPercent: 100, batteryState: "charged" });
});

test("pmset on AC with charging held back", () => {
  const text = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=21692515)\t80%; AC attached; not charging present: true\n";
  assert.deepEqual(parsePmset(text), { source: "ac", batteryPercent: 80, batteryState: "AC attached" });
});

test("pmset on battery", () => {
  const text = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=21364835)\t87%; discharging; 4:12 remaining present: true\n";
  assert.deepEqual(parsePmset(text), { source: "battery", batteryPercent: 87, batteryState: "discharging" });
});

test("pmset on a desktop without a battery", () => {
  assert.deepEqual(parsePmset("Now drawing from 'AC Power'\n"), {
    source: "ac",
    batteryPercent: null,
    batteryState: null,
  });
});

test("Windows battery status codes map to the power source", () => {
  assert.deepEqual(parseWindowsBattery("\r\nEstimatedChargeRemaining : 64\r\nBatteryStatus            : 1\r\n"), {
    source: "battery",
    batteryPercent: 64,
    batteryState: "discharging",
  });
  assert.deepEqual(parseWindowsBattery("EstimatedChargeRemaining : 100\nBatteryStatus : 2\n").source, "ac");
});

test("a Windows machine reporting no battery is on mains power", () => {
  assert.deepEqual(parseWindowsBattery(""), { source: "ac", batteryPercent: null, batteryState: null });
});
