export interface AggregateArgs {
  ndjsonPaths: string[];
  csvPath: string;
  batchId?: string;
}

/**
 * `<file.ndjson>... <file.csv> [--batch <id>]`: the last positional argument is
 * the output, everything before it is input. Returns an error message instead
 * of throwing so the caller can print usage.
 */
export function parseAggregateArgs(args: readonly string[]): AggregateArgs | string {
  const batchIndex = args.indexOf("--batch");
  let batchId: string | undefined;
  let positional = [...args];

  if (batchIndex !== -1) {
    batchId = args[batchIndex + 1];
    if (!batchId || batchId.startsWith("--")) return "--batch requires a batch id";
    positional = args.filter((_, index) => index !== batchIndex && index !== batchIndex + 1);
  }

  const csvPath = positional.at(-1);
  const ndjsonPaths = positional.slice(0, -1);
  if (!csvPath || ndjsonPaths.length === 0) {
    return "Usage: animbench aggregate <file.ndjson>... <file.csv> [--batch <id>]";
  }
  return { ndjsonPaths, csvPath, ...(batchId ? { batchId } : {}) };
}
