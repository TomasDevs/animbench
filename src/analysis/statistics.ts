/**
 * All figures are derived here rather than in the page, so the measured thread
 * only ever hands over an array of timestamps.
 */

/**
 * Linear interpolation between order statistics (the "R-7" definition, as used
 * by NumPy and spreadsheets), so a percentile does not jump between samples.
 */
export function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return Number.NaN;
  if (sortedValues.length === 1) return sortedValues[0] as number;

  const position = fraction * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sortedValues[lower] as number;
  if (lower === upper) return lowerValue;

  const upperValue = sortedValues[upper] as number;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const average = mean(values);
  let sumOfSquares = 0;
  for (const value of values) sumOfSquares += (value - average) ** 2;
  return Math.sqrt(sumOfSquares / (values.length - 1));
}

/** Differences between consecutive timestamps, in milliseconds. */
export function frameIntervals(timestamps: readonly number[]): number[] {
  const intervals: number[] = [];
  for (let index = 1; index < timestamps.length; index++) {
    intervals.push((timestamps[index] as number) - (timestamps[index - 1] as number));
  }
  return intervals;
}
