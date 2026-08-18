import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import {
  CONTRACT_KEYS,
  validateBenchResult,
  type BenchPageError,
  type BenchResult,
} from "../types/contract.js";
import type { TimingConfig } from "../types/config.js";
import { DEFAULT_TIMING } from "../types/config.js";
import type { DiscardReason } from "../types/record.js";

export interface PageViewport {
  width: number;
  height: number;
  devicePixelRatio: number | null;
}

export interface SingleRunSuccess {
  ok: true;
  result: BenchResult;
  viewport: PageViewport;
}

export interface SingleRunFailure {
  ok: false;
  reason: DiscardReason;
  detail: string;
}

export type SingleRunOutcome = SingleRunSuccess | SingleRunFailure;

export class ContractError extends Error {
  constructor(
    message: string,
    readonly reason: DiscardReason,
  ) {
    super(message);
    this.name = "ContractError";
  }
}

async function readPageError(page: Page): Promise<BenchPageError | null> {
  return page.evaluate((key) => {
    const value = (window as unknown as Record<string, unknown>)[key];
    if (!value) return null;
    if (typeof value === "string") return { message: value };
    const error = value as { message?: unknown; stack?: unknown };
    return {
      message: typeof error.message === "string" ? error.message : JSON.stringify(value),
      ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
    };
  }, CONTRACT_KEYS.error);
}

async function waitForReady(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForFunction(
      (keys) => {
        const scope = window as unknown as Record<string, unknown>;
        return scope[keys.ready] === true || scope[keys.error] !== undefined;
      },
      CONTRACT_KEYS,
      { timeout: timeoutMs },
    );
  } catch {
    throw new ContractError(
      `page did not set ${CONTRACT_KEYS.ready} within ${timeoutMs} ms`,
      "timeout",
    );
  }
}

async function startRun(page: Page): Promise<void> {
  const started = await page.evaluate((key) => {
    const start = (window as unknown as Record<string, unknown>)[key];
    if (typeof start !== "function") return typeof start;
    (start as () => void)();
    return "started";
  }, CONTRACT_KEYS.start);

  if (started === "started") return;

  // A page that announces readiness but exposes no way to start it is almost
  // always a build predating the start hook, served by a stale process. Saying
  // so beats a generic contract violation, because the fix is to rebuild or
  // restart the server, not to change the adapter.
  throw new ContractError(
    `page set ${CONTRACT_KEYS.ready} but exposes no ${CONTRACT_KEYS.start}() function ` +
      `(found ${started}); the served build may predate the start hook`,
    "stale-build",
  );
}

async function waitForDone(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForFunction(
      (keys) => {
        const scope = window as unknown as Record<string, unknown>;
        return scope[keys.done] === true || scope[keys.error] !== undefined;
      },
      CONTRACT_KEYS,
      { timeout: timeoutMs },
    );
  } catch {
    throw new ContractError(
      `page did not set ${CONTRACT_KEYS.done} within ${timeoutMs} ms`,
      "timeout",
    );
  }
}

/**
 * Reads the raw result and nothing else. All derived figures are computed in
 * Node, so the measured thread only ever hands over an array.
 */
export async function measureOnce(
  page: Page,
  url: string,
  timing: TimingConfig = DEFAULT_TIMING,
): Promise<SingleRunOutcome> {
  try {
    try {
      await page.goto(url, { waitUntil: "load", timeout: timing.readyTimeoutMs });
    } catch (cause) {
      throw new ContractError(
        `navigation to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        "navigation-error",
      );
    }

    await waitForReady(page, timing.readyTimeoutMs);

    const readyError = await readPageError(page);
    if (readyError) {
      throw new ContractError(`page reported: ${readyError.message}`, "page-error");
    }

    await startRun(page);
    await waitForDone(page, timing.runTimeoutMs);

    const runError = await readPageError(page);
    if (runError) {
      throw new ContractError(`page reported: ${runError.message}`, "page-error");
    }

    const raw = await page.evaluate(
      (key) => (window as unknown as Record<string, unknown>)[key],
      CONTRACT_KEYS.result,
    );

    const violations = validateBenchResult(raw);
    if (violations.length > 0) {
      const summary = violations.map((v) => `${v.path || "<root>"}: ${v.problem}`).join("; ");
      throw new ContractError(summary, "contract-violation");
    }

    const result = raw as BenchResult;
    if (result.overflowed) {
      throw new ContractError("page reported a timestamp buffer overflow", "overflowed");
    }

    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    }));
    return { ok: true, result, viewport };
  } catch (error) {
    if (error instanceof ContractError) {
      return { ok: false, reason: error.reason, detail: error.message };
    }
    throw error;
  }
}

export interface OpenBrowserOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
}

export async function withPage<T>(
  options: OpenBrowserOptions,
  body: (page: Page) => Promise<T>,
): Promise<T> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: options.headless ?? false });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    return await body(page);
  } finally {
    await browser?.close();
  }
}
