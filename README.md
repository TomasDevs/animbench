# animbench

CLI tool for measuring frame timing and main-thread load of web animations.

It opens a page in a visible Chromium window, waits for the page to report that
it is ready, starts the run, and reads back raw `performance.now()` timestamps.
All statistics are computed in Node afterwards, never inside the page being
measured.

The tool knows nothing about the page it measures. Any page that implements the
[contract](#page-contract) can be benchmarked.

## Requirements

- Node.js 20 or newer
- A machine with GPU acceleration (checked before every batch)

## Install

```bash
pnpm install
pnpm exec playwright install chromium
```

## Usage

```bash
pnpm dev check-gpu                          # verify hardware acceleration
pnpm dev run <url> [--out runs.ndjson] [--cpu]
pnpm dev batch config.json                  # full parameter matrix
pnpm dev aggregate runs.ndjson summary.csv [--batch <id>]
```

A batch is driven by a JSON config:

```json
{
  "target": {
    "url": "http://localhost:4173/bench.html",
    "matrix": { "technique": ["raf", "css-transition"], "complexity": ["100", "500", "2000"] }
  },
  "timing": { "cooldownMs": 15000, "cpuSampleIntervalMs": 1000 },
  "batch": { "repetitions": 10, "warmupRuns": 1 },
  "output": { "ndjsonPath": "results/runs.ndjson", "csvPath": "results/summary.csv" }
}
```

The matrix expands into every combination; values are passed to the page as
query parameters and recorded with each run. Runs are shuffled with a recorded
seed, and warm-up runs are discarded.

## Page contract

The page exposes five values on `window`:

| key | meaning |
|---|---|
| `__benchReady` | `true` once the scene is built |
| `__benchStart` | function the tool calls to start the run |
| `__benchResult` | raw timestamps, idle baseline and free-form `meta` |
| `__benchDone` | `true` once the result is available |
| `__benchError` | `{ message, stack? }` instead of a result |

The page records timestamps and nothing else. The frame budget is derived from
the idle refresh rate the page measures, not from a fixed 16.7 ms. A page whose
load ramps up may declare `meta.steadyStateFromMs` / `steadyStateToMs`, and
metrics are then computed from that window only.

## Output

- **NDJSON** — one line per run with raw timestamps, CPU samples, the machine,
  its power state and, for discarded runs, the reason.
- **CSV** — one row per combination: frame-interval percentiles, frames over
  budget, achieved vs. achievable refresh rate, and main-thread and process CPU
  shares.

## Documentation

Detailed documentation is in Czech:

- [docs/navod.md](docs/navod.md) — user guide: configuration, contract, outputs
  and how to read the results
- [docs/stav-nastroje.md](docs/stav-nastroje.md) — methodological decisions and
  the measurements behind them

## Development

```bash
pnpm check   # type check and tests
pnpm build   # bundle to dist/
```

## License

MIT
