/**
 * Pure helpers for dividing a day's hours across its entries and for
 * estimating the cost of an import.
 *
 * Client-safe: no runtime imports, bundled into both the Worker and the
 * browser client.
 */

/**
 * Split `totalSeconds` into `count` whole-second shares that sum to exactly
 * `totalSeconds`. The remainder (at most `count - 1` seconds) goes one
 * second at a time to the earliest shares, so no two shares ever differ by
 * more than a second and the day's total is preserved to the second —
 * Clockify stores second precision, so fractional seconds would be lost.
 */
export function splitSeconds(totalSeconds: number, count: number): number[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('splitSeconds: count must be a positive integer');
  }
  if (!Number.isInteger(totalSeconds) || totalSeconds < 0) {
    throw new Error('splitSeconds: totalSeconds must be a non-negative integer');
  }
  const base = Math.floor(totalSeconds / count);
  const remainder = totalSeconds - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Hours (possibly fractional) to whole seconds, rounded to the nearest. */
export function hoursToSeconds(hours: number): number {
  return Math.round(hours * 3600);
}

/** Rough wall-clock cost of one sequential Clockify POST from the Worker. */
const SECONDS_PER_ENTRY = 0.5;
/** Matches the client's inter-batch pause (client/app.ts). */
const SECONDS_BETWEEN_BATCHES = 2;
/** Clockify Free: 30 requests/hour workspace-wide; keep a margin. */
const FREE_TIER_REQUESTS_PER_HOUR = 28;

export function estimateImport(
  count: number,
  batchSize: number,
): { batches: number; seconds: number } {
  if (count <= 0) return { batches: 0, seconds: 0 };
  const batches = Math.ceil(count / batchSize);
  return { batches, seconds: count * SECONDS_PER_ENTRY + (batches - 1) * SECONDS_BETWEEN_BATCHES };
}

/** Hours a Free workspace needs: one POST per entry plus one pre-check GET per batch. */
export function freeTierHours(count: number, batchSize: number): number {
  if (count <= 0) return 0;
  const { batches } = estimateImport(count, batchSize);
  return Math.ceil((count + batches) / FREE_TIER_REQUESTS_PER_HOUR);
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s === 0 ? `${m} min` : `${m} min ${s} s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
