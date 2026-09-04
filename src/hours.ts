/**
 * Pure helpers for dividing a day's hours across its entries and for
 * packing entries into apply batches.
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

/**
 * Pack `items` into batches of at most `max`, never splitting one `date`
 * across two batches. The apply route's pre-write duplicate check is
 * day-level against entries fetched before each batch, so a day's second
 * half in a later batch would see its first half as "already exists".
 *
 * A single day holding more than `max` items is emitted on its own, over
 * the cap — the caller decides what to do with it (the server rejects it).
 */
export function batchByDay<T extends { date: string }>(items: T[], max: number): T[][] {
  const days = new Map<string, T[]>();
  for (const item of items) {
    let bucket = days.get(item.date);
    if (!bucket) {
      bucket = [];
      days.set(item.date, bucket);
    }
    bucket.push(item);
  }

  const batches: T[][] = [];
  let current: T[] = [];
  for (const day of days.values()) {
    if (current.length > 0 && current.length + day.length > max) {
      batches.push(current);
      current = [];
    }
    current.push(...day);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
