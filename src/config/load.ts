import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_BATCH,
  DEFAULT_BROWSER,
  DEFAULT_TIMING,
  type BenchConfig,
} from "../types/config.js";

export class ConfigError extends Error {}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Values are stringified so numbers in the matrix are accepted as written. */
function parseMatrix(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  const source = asRecord(value, "target.matrix");
  const matrix: Record<string, string[]> = {};

  for (const [name, values] of Object.entries(source)) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new ConfigError(`target.matrix.${name} must be a non-empty array`);
    }
    matrix[name] = values.map((entry) => {
      if (typeof entry === "string") return entry;
      if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
      throw new ConfigError(`target.matrix.${name} must contain strings or numbers`);
    });
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
function resolveTargetUrl(url: string, configPath: string): string {
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
  const configDirectory = resolvePath(configPath, "..");
  const absolute = isAbsolute(filePart) ? filePart : resolvePath(configDirectory, filePart);

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

export function parseConfig(raw: unknown, configPath = "."): BenchConfig {
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
    },
    batch: {
      repetitions,
      warmupRuns,
      shuffle: parseBoolean(batch["shuffle"], "batch.shuffle", DEFAULT_BATCH.shuffle),
      ...(seed !== undefined ? { seed } : {}),
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
    },
    output: { ndjsonPath, ...(csvPath !== undefined ? { csvPath } : {}) },
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
