import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_BATCH,
  DEFAULT_BROWSER,
  DEFAULT_TIMING,
  type BenchConfig,
  type Combination,
  type MatrixDimension,
  type ParameterMatrix,
} from "../types/config.js";

export class ConfigError extends Error {}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseScalar(entry: unknown, path: string): string {
  if (typeof entry === "string") return entry;
  if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
  throw new ConfigError(`${path} must contain strings or numbers`);
}

function parseLinkedSet(entry: unknown, path: string): Combination {
  const source = asRecord(entry, path);
  const keys = Object.keys(source);
  if (keys.length === 0) throw new ConfigError(`${path} must set at least one parameter`);
  return Object.fromEntries(keys.map((key) => [key, parseScalar(source[key], `${path}.${key}`)]));
}

/** The parameter names a dimension passes to the page. */
function parameterNames(name: string, dimension: MatrixDimension): string[] {
  const [first] = dimension;
  return typeof first === "string" || first === undefined ? [name] : Object.keys(first);
}

/** Values are stringified so numbers in the matrix are accepted as written. */
function parseMatrix(value: unknown): ParameterMatrix {
  if (value === undefined) return {};
  const source = asRecord(value, "target.matrix");
  const matrix: ParameterMatrix = {};

  for (const [name, values] of Object.entries(source)) {
    const path = `target.matrix.${name}`;
    if (!Array.isArray(values) || values.length === 0) {
      throw new ConfigError(`${path} must be a non-empty array`);
    }
    const linked = values.map((entry) => typeof entry === "object" && entry !== null);
    if (linked.some(Boolean) !== linked.every(Boolean)) {
      throw new ConfigError(`${path} must contain either plain values or parameter sets, not both`);
    }
    if (!linked[0]) {
      matrix[name] = values.map((entry, index) => parseScalar(entry, `${path}[${index}]`));
      continue;
    }

    const sets = values.map((entry, index) => parseLinkedSet(entry, `${path}[${index}]`));
    // Uneven sets would leave some runs without a parameter the others have.
    const expected = Object.keys(sets[0] as Combination).sort().join(",");
    sets.forEach((set, index) => {
      if (Object.keys(set).sort().join(",") !== expected) {
        throw new ConfigError(`${path}[${index}] must set the same parameters as ${path}[0] (${expected})`);
      }
    });
    matrix[name] = sets;
  }

  const owner = new Map<string, string>();
  for (const [name, dimension] of Object.entries(matrix)) {
    for (const parameter of parameterNames(name, dimension)) {
      const previous = owner.get(parameter);
      if (previous) {
        throw new ConfigError(`parameter "${parameter}" is set by both target.matrix.${previous} and target.matrix.${name}`);
      }
      owner.set(parameter, name);
    }
  }
  return matrix;
}

function parseNumber(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${path} must be a number`);
  }
  return value;
}

function parseCount(value: unknown, path: string, fallback: number, minimum: number): number {
  const parsed = parseNumber(value, path, fallback);
  if (!Number.isInteger(parsed)) throw new ConfigError(`${path} must be a whole number`);
  if (parsed < minimum) throw new ConfigError(`${path} must be at least ${minimum}`);
  return parsed;
}

function parseDuration(value: unknown, path: string, fallback: number): number {
  const parsed = parseNumber(value, path, fallback);
  if (parsed < 0) throw new ConfigError(`${path} cannot be negative`);
  return parsed;
}

/**
 * Accepts a URL or a path relative to the config file, so a config can point at
 * a local page without the operator hand-writing a file:// address.
 */
/** Relative paths in a config mean relative to the config file itself. */
function baseDirectory(configPath: string | undefined): string {
  return configPath ? dirname(resolvePath(configPath)) : process.cwd();
}

function resolveFromConfig(path: string, configPath: string | undefined): string {
  return isAbsolute(path) ? path : resolvePath(baseDirectory(configPath), path);
}

function resolveTargetUrl(url: string, configPath: string | undefined): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      new URL(url);
    } catch {
      throw new ConfigError(`target.url is not a valid address: ${url}`);
    }
    return url;
  }

  const queryStart = url.indexOf("?");
  const filePart = queryStart === -1 ? url : url.slice(0, queryStart);
  const absolute = resolveFromConfig(filePart, configPath);

  const fileUrl = pathToFileURL(absolute);
  if (queryStart !== -1) fileUrl.search = url.slice(queryStart + 1);
  return fileUrl.toString();
}

function parseBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be true or false`);
  return value;
}

function parseLabels(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const source = asRecord(value, "labels");
  const labels: Record<string, string> = {};
  for (const [name, entry] of Object.entries(source)) {
    if (typeof entry !== "string") throw new ConfigError(`labels.${name} must be a string`);
    labels[name] = entry;
  }
  return labels;
}

function parseTarget(value: unknown): "desktop" | "android" {
  if (value === undefined) return DEFAULT_BROWSER.target;
  if (value === "desktop" || value === "android") return value;
  throw new ConfigError(`browser.target must be "desktop" or "android"`);
}

function optionalPositive(
  source: Record<string, unknown>,
  key: string,
  maximum = Number.POSITIVE_INFINITY,
): Record<string, number> {
  const value = source[key];
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new ConfigError(
      `batch.${key} must be a positive number${Number.isFinite(maximum) ? ` up to ${maximum}` : ""}`,
    );
  }
  return { [key]: value };
}

function optionalString(source: Record<string, unknown>, key: string): Record<string, string> {
  const value = source[key];
  if (value === undefined) return {};
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`browser.${key} must be a non-empty string`);
  }
  return { [key]: value };
}

export function parseConfig(raw: unknown, configPath?: string): BenchConfig {
  const root = asRecord(raw, "config");

  const target = asRecord(root["target"], "target");
  const rawUrl = target["url"];
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new ConfigError("target.url is required");
  }
  const url = resolveTargetUrl(rawUrl, configPath);

  const timing = asRecord(root["timing"] ?? {}, "timing");
  const batch = asRecord(root["batch"] ?? {}, "batch");
  const browser = asRecord(root["browser"] ?? {}, "browser");
  const viewport = asRecord(browser["viewport"] ?? {}, "browser.viewport");
  const output = asRecord(root["output"], "output");

  const ndjsonPath = output["ndjsonPath"];
  if (typeof ndjsonPath !== "string" || ndjsonPath.length === 0) {
    throw new ConfigError("output.ndjsonPath is required");
  }
  const csvPath = output["csvPath"];
  if (csvPath !== undefined && typeof csvPath !== "string") {
    throw new ConfigError("output.csvPath must be a string");
  }

  const repetitions = parseCount(batch["repetitions"], "batch.repetitions", DEFAULT_BATCH.repetitions, 1);
  const warmupRuns = parseCount(batch["warmupRuns"], "batch.warmupRuns", DEFAULT_BATCH.warmupRuns, 0);

  const seed = batch["seed"];
  if (seed !== undefined && (typeof seed !== "number" || !Number.isInteger(seed))) {
    throw new ConfigError("batch.seed must be an integer");
  }

  const labels = parseLabels(root["labels"]);

  return {
    target: { url, matrix: parseMatrix(target["matrix"]) },
    timing: {
      readyTimeoutMs: parseDuration(timing["readyTimeoutMs"], "timing.readyTimeoutMs", DEFAULT_TIMING.readyTimeoutMs),
      runTimeoutMs: parseDuration(timing["runTimeoutMs"], "timing.runTimeoutMs", DEFAULT_TIMING.runTimeoutMs),
      cooldownMs: parseDuration(timing["cooldownMs"], "timing.cooldownMs", DEFAULT_TIMING.cooldownMs),
      ...(timing["cpuSampleIntervalMs"] !== undefined
        ? {
            cpuSampleIntervalMs: parseDuration(
              timing["cpuSampleIntervalMs"],
              "timing.cpuSampleIntervalMs",
              0,
            ),
          }
        : {}),
    },
    batch: {
      repetitions,
      warmupRuns,
      shuffle: parseBoolean(batch["shuffle"], "batch.shuffle", DEFAULT_BATCH.shuffle),
      ...(seed !== undefined ? { seed } : {}),
      ...optionalPositive(batch, "expectedRefreshRateHz"),
      ...optionalPositive(batch, "refreshTolerance", 1),
      ...(batch["minFramesInWindow"] !== undefined
        ? { minFramesInWindow: parseCount(batch["minFramesInWindow"], "batch.minFramesInWindow", 0, 1) }
        : {}),
    },
    browser: {
      headless: parseBoolean(browser["headless"], "browser.headless", DEFAULT_BROWSER.headless),
      viewport: {
        width: parseCount(viewport["width"], "browser.viewport.width", DEFAULT_BROWSER.viewport.width, 1),
        height: parseCount(viewport["height"], "browser.viewport.height", DEFAULT_BROWSER.viewport.height, 1),
      },
      requireHardwareAcceleration: parseBoolean(
        browser["requireHardwareAcceleration"],
        "browser.requireHardwareAcceleration",
        DEFAULT_BROWSER.requireHardwareAcceleration,
      ),
      target: parseTarget(browser["target"]),
      ...optionalString(browser, "deviceSerial"),
      ...optionalString(browser, "adbPath"),
    },
    // Resolved against the config, so a config kept next to its study writes
    // into that study whichever directory the tool is started from.
    output: {
      ndjsonPath: resolveFromConfig(ndjsonPath, configPath),
      ...(csvPath !== undefined ? { csvPath: resolveFromConfig(csvPath, configPath) } : {}),
    },
    ...(labels ? { labels } : {}),
  };
}

export async function loadConfig(path: string): Promise<BenchConfig> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new ConfigError(`cannot read config file: ${path}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (cause) {
    throw new ConfigError(
      `config file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return parseConfig(raw, path);
}
