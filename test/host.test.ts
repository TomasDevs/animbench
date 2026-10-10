import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMacDisplays, parsePmset, parsePmsetLowPower, parseWindowsBattery } from "../src/diagnostics/host.js";

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

test("the main display is read from system_profiler", () => {
  // Captured on a MacBook Air M3 with only its built-in panel.
  const internal = JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: [{
    _name: "Color LCD", _spdisplays_pixels: "3420 x 2224", _spdisplays_resolution: "1710 x 1112 @ 60.00Hz",
    spdisplays_connection_type: "spdisplays_internal", spdisplays_main: "spdisplays_yes",
  }] }] });
  assert.deepEqual(parseMacDisplays(internal), { name: "Color LCD", resolution: "1710x1112", refreshHz: 60, connection: "internal" });

  const external = JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: [
    { _name: "Color LCD", _spdisplays_resolution: "1710 x 1112 @ 60.00Hz", spdisplays_connection_type: "spdisplays_internal" },
    { _name: "DELL U2719D", _spdisplays_resolution: "2560 x 1440 @ 59.95Hz", spdisplays_connection_type: "spdisplays_displayport", spdisplays_main: "spdisplays_yes" },
  ] }] });
  assert.deepEqual(parseMacDisplays(external), { name: "DELL U2719D", resolution: "2560x1440", refreshHz: 60, connection: "external" });
  assert.equal(parseMacDisplays("not json"), null);
});

test("low power mode is read in both pmset spellings", () => {
  assert.equal(parsePmsetLowPower(" lowpowermode         0\n sleep 1\n"), false);
  assert.equal(parsePmsetLowPower(" lowpowermode         1\n"), true);
  assert.equal(parsePmsetLowPower(" powermode            1\n"), true);
  assert.equal(parsePmsetLowPower(" powermode            2\n"), false, "2 is high power");
  assert.equal(parsePmsetLowPower(" sleep 1\n"), null);
});
