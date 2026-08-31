/**
 * Timezone maths with no dependencies and no imports — this module is bundled
 * into both the Worker and the browser client.
 *
 * Deliberately does NOT use Temporal: Cloudflare shipped it to production in
 * July 2026 with Temporal.Now stuck at epoch 0 and reverted it in August, with
 * no re-landing timeline. Intl is enough.
 */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * A fully pinned formatter. Every option here is load-bearing:
 *   - 'en-US' + gregory + latn: an unpinned locale can emit Buddhist-era years
 *     or Arabic-Indic digits, and Number() on those returns NaN.
 *   - hourCycle 'h23': `hour12: false` yields "24" at midnight on some ICU
 *     builds, which rolls Date.UTC into the next day.
 */
function formatter(tz: string): Intl.DateTimeFormat {
  let found = FORMATTERS.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    FORMATTERS.set(tz, found);
  }
  return found;
}

function fields(epochMs: number, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(epochMs)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The local calendar day an instant falls on, in `tz`. */
export function dayKey(epochMs: number, tz: string): string {
  const f = fields(epochMs, tz);
  return `${(f.year ?? '0').padStart(4, '0')}-${f.month ?? '01'}-${f.day ?? '01'}`;
}

export function localDayOf(instantIso: string, tz: string): string {
  return dayKey(Date.parse(instantIso), tz);
}

/** How far `tz` is ahead of UTC at instant `t`, in ms. East of UTC is positive. */
function offsetMs(t: number, tz: string): number {
  const f = fields(t, tz);
  const asIfUtc = Date.UTC(
    Number(f.year),
    Number(f.month) - 1,
    Number(f.day),
    Number(f.hour),
    Number(f.minute),
    Number(f.second),
  );
  // formatToParts truncates sub-second, so compare against a truncated t.
  return asIfUtc - Math.floor(t / 1000) * 1000;
}

/**
 * Turn a local wall clock into the epoch instant it denotes.
 *
 * Sample the zone offset a day either side of the target — never at the target
 * itself, which is what makes the naive two-pass version converge on the wrong
 * side of a DST transition. Keep only candidates that round-trip back to the
 * requested wall clock. Ambiguous (fall-back) times resolve to the earliest
 * occurrence; nonexistent (spring-forward) times shift forward out of the gap.
 * This matches Temporal's 'compatible' disambiguation.
 */
export function wallClockToEpochMs(dateKey: string, hhmm: string, tz: string): number {
  if (!DATE_KEY.test(dateKey)) throw new Error(`Invalid date key: ${dateKey}`);
  if (!HHMM.test(hhmm)) throw new Error(`Invalid time: ${hhmm}`);

  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm, 0);

  const before = wall - offsetMs(wall - DAY_MS, tz);
  const after = wall - offsetMs(wall + DAY_MS, tz);
  const candidates = before === after ? [before] : [before, after].sort((a, b) => a - b);

  const valid = candidates.filter((t) => t + offsetMs(t, tz) === wall);
  if (valid.length > 0) return valid[0] as number;
  return Math.max(...candidates);
}

const WEEKEND = new Set(['Sat', 'Sun']);

/** Weekday judged in the user's own zone, from the same pinned formatter. */
export function isWeekendInZone(dateKey: string, tz: string): boolean {
  const noon = wallClockToEpochMs(dateKey, '12:00', tz);
  return WEEKEND.has(fields(noon, tz).weekday ?? '');
}

/**
 * The UTC window covering a span of local days: local midnight on the first day
 * up to (but excluding) local midnight after the last. The exclusive upper
 * bound replaces the Python's `23:59:59Z`, which dropped the final second.
 */
export function utcRangeForLocalDays(
  startKey: string,
  endKey: string,
  tz: string,
): { sinceIso: string; untilIso: string } {
  const [y, m, d] = endKey.split('-').map(Number) as [number, number, number];
  const nextKey = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return {
    sinceIso: new Date(wallClockToEpochMs(startKey, '00:00', tz)).toISOString(),
    untilIso: new Date(wallClockToEpochMs(nextKey, '00:00', tz)).toISOString(),
  };
}

/** '+02:00' — GitHub search date qualifiers accept a UTC offset suffix. */
export function utcOffsetLabel(dateKey: string, tz: string): string {
  const minutes = offsetMs(wallClockToEpochMs(dateKey, '12:00', tz), tz) / 60_000;
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Clockify documents start/end as `yyyy-MM-ddThh:mm:ssZ` — no milliseconds. */
export function toClockifyIso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
