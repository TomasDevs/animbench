import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { evaluateGpuReport, inspectGpu } from "../diagnostics/gpu.js";
import { buildRunUrl, expandMatrix, type BenchConfig, type Combination } from "../types/config.js";
import type { RunEnvironment, RunRecord } from "../types/record.js";
import { NdjsonWriter, installInterruptHandler } from "../output/ndjson.js";
import { buildRunRecord } from "./build-record.js";
import { measureOnce, withPage, type SingleRunOutcome } from "./single-run.js";

/**
 * Errors that mean the browser itself is gone: retrying every remaining run
 * against a dead browser would only produce a file full of identical failures.
 */
function isFatalBrowserError(message: string): boolean {
  return /Target page, context or browser has been closed|browser has been closed|Browser closed/i.test(
    message,
  );
}

interface PlannedRun {
  combination: Combination;
  url: string;
  repetition: number;
  warmup: boolean;
}

/**
 * Mulberry32. A seeded generator keeps an ordering reproducible, which matters
 * when a batch has to be repeated or explained.
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(items: T[], random: () => number): void {
  for (let index = items.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    const swap = items[index] as T;
    items[index] = items[target] as T;
    items[target] = swap;
  }
}

/**
 * Warm-up runs stay in front of the measured ones: their point is to bring the
 * machine to a working state before anything is recorded. Only the measured
 * runs are shuffled against thermal throttling.
 */
export interface BatchPlan {
  runs: PlannedRun[];
  /** The seed actually used, so the ordering can be reproduced. */
  seed: number | undefined;
}

export function planBatch(config: BenchConfig): BatchPlan {
  const combinations = expandMatrix(config.target.matrix);

  const warmups: PlannedRun[] = [];
  const measured: PlannedRun[] = [];

  for (const combination of combinations) {
    const url = buildRunUrl(config.target.url, combination);
    for (let index = 0; index < config.batch.warmupRuns; index++) {
      warmups.push({ combination, url, repetition: index, warmup: true });
    }
    for (let index = 0; index < config.batch.repetitions; index++) {
      measured.push({ combination, url, repetition: index, warmup: false });
    }
  }

  let seed: number | undefined;
  if (config.batch.shuffle) {
    seed = config.batch.seed ?? Math.floor(Math.random() * 0xffffffff);
    shuffleInPlace(measured, createRandom(seed));
  }

  return { runs: [...warmups, ...measured], seed };
}

export interface BatchProgress {
  sequence: number;
  total: number;
  record: RunRecord;
}

export interface BatchSummary {
  batchId: string;
  seed: number | undefined;
  total: number;
  valid: number;
  /** Failures only; warm-ups are discarded by design and counted separately. */
  discarded: number;
  warmup: number;
  discardReasons: Record<string, number>;
  environment: RunEnvironment;
  /** Set when the batch stopped early, with the reason it stopped. */
  abortedAfter?: { sequence: number; error: string };
}

async function readEnvironment(page: Page, config: BenchConfig): Promise<RunEnvironment> {
  const verdict = evaluateGpuReport(await inspectGpu(page));
  return {
    browser: verdict.report.chromeVersion,
    operatingSystem: verdict.report.operatingSystem,
    renderer: verdict.report.webglRenderer,
    hardwareAccelerated: verdict.accelerated,
    viewport: config.browser.viewport,
    devicePixelRatio: null,
  };
}

export async function runBatch(
  config: BenchConfig,
  onProgress?: (progress: BatchProgress) => void,
): Promise<BatchSummary> {
  const batchId = randomUUID();
  const { runs: planned, seed } = planBatch(config);
  const writer = new NdjsonWriter(config.output.ndjsonPath);
  const removeInterruptHandler = installInterruptHandler(writer);

  const discardReasons: Record<string, number> = {};
  let valid = 0;
  let discarded = 0;
  let warmup = 0;
  let abortedAfter: { sequence: number; error: string } | undefined;

  try {
    const environment = await withPage(
      { headless: config.browser.headless, viewport: config.browser.viewport },
      async (page) => {
        const environment = await readEnvironment(page, config);

        if (config.browser.requireHardwareAcceleration && !environment.hardwareAccelerated) {
          throw new Error(
            "hardware acceleration is not active; measurements would not be comparable",
          );
        }

        for (let index = 0; index < planned.length; index++) {
          const run = planned[index] as PlannedRun;

          // A crash in one run must not cost the hours of runs still queued, so
          // anything measureOnce did not classify is recorded and the batch
          // continues.
          let outcome: SingleRunOutcome;
          try {
            outcome = await measureOnce(page, run.url, config.timing);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (isFatalBrowserError(detail)) {
              abortedAfter = { sequence: index, error: detail };
              break;
            }
            outcome = { ok: false, reason: "page-error", detail };
          }

          const record = buildRunRecord(
            {
              batchId,
              ...(seed !== undefined ? { batchSeed: seed } : {}),
              url: run.url,
              combination: run.combination,
              repetition: run.repetition,
              sequence: index,
              environment: outcome.ok
                ? {
                    ...environment,
                    viewport: { width: outcome.viewport.width, height: outcome.viewport.height },
                    devicePixelRatio: outcome.viewport.devicePixelRatio,
                  }
                : environment,
              warmup: run.warmup,
              ...(config.labels ? { labels: config.labels } : {}),
              recordedAt: new Date().toISOString(),
            },
            outcome,
          );

          await writer.write(record);

          if (record.valid) valid++;
          else if (record.discardReason === "warmup") warmup++;
          else {
            discarded++;
            const reason = record.discardReason ?? "unknown";
            discardReasons[reason] = (discardReasons[reason] ?? 0) + 1;
          }

          onProgress?.({ sequence: index, total: planned.length, record });

          const isLast = index === planned.length - 1;
          if (!isLast && config.timing.cooldownMs > 0) {
            await sleep(config.timing.cooldownMs);
          }
        }

        return environment;
      },
    );

    return {
      batchId,
      seed,
      total: planned.length,
      valid,
      discarded,
      warmup,
      discardReasons,
      environment,
      ...(abortedAfter ? { abortedAfter } : {}),
    };
  } finally {
    removeInterruptHandler();
    await writer.close();
  }
}
