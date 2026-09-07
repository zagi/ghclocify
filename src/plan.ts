/**
 * Diffs proposed daily Clockify entries against what already exists in the
 * user's account, so an import can be re-run without doubling hours.
 *
 * Pure, dependency-free (beyond sibling client-safe modules), and bundled
 * into both the Worker and the browser client — only client-safe imports and
 * type-only imports of `ExistingEntry` / `ImportPlan` / `PlannedEntry` /
 * `ProposedEntry` are allowed here.
 */
import { localDayOf } from './timezone';
import type { ExistingEntry, ImportPlan, PlannedEntry, ProposedEntry } from './types';

const HOUR_MS = 3_600_000;

/**
 * An existing entry collides with `entry` when it falls on the same LOCAL
 * day and carries the same `projectId` (rule 1). Comparing local day keys
 * rather than instants is the whole point of this module: an entry starting
 * late UTC the previous day can already occupy the following local day for
 * a user east of UTC (rule 2) — see test 4 for the pinned boundary case.
 *
 * `entry.date` is already the local day the caller (aggregate.ts) computed
 * this proposed entry for, so we only need to re-derive the existing
 * entry's local day from its `start` and compare the two strings.
 *
 * `existing.end` is never consulted: only the entry's own start instant
 * determines which local day it occupies. `existing.projectId` can be
 * `null` (an entry with no project set in Clockify) — plain `===` against
 * `entry.projectId`, which is always a string, correctly treats that as
 * "never a match" with no special-casing needed.
 */
export function findDuplicate(
  entry: ProposedEntry,
  existing: ExistingEntry[],
  timezone: string,
): ExistingEntry | undefined {
  return existing.find(
    (candidate) =>
      candidate.projectId === entry.projectId &&
      localDayOf(candidate.start, timezone) === entry.date,
  );
}

/**
 * The write route's post-write check: did THIS entry land? Matches on
 * project and the exact start instant rather than the local day, because a
 * day now holds one entry per issue and a sibling written moments earlier
 * in the same batch must not be mistaken for this one. Relies on
 * aggregate.ts laying a day's entries out back-to-back, so no two proposed
 * entries on one day ever share a start.
 */
export function findLanded(
  entry: ProposedEntry,
  existing: ExistingEntry[],
): ExistingEntry | undefined {
  const start = Date.parse(entry.start);
  return existing.find(
    (candidate) => candidate.projectId === entry.projectId && Date.parse(candidate.start) === start,
  );
}

export type WriteDecision =
  | { action: 'write' }
  | { action: 'skip'; reason: 'foreign' | 'exists' | 'overlap'; existing: ExistingEntry };

/**
 * The write route's pre-write check for one entry, given every start
 * instant the plan holds for that entry's day (`plannedStarts`).
 *
 * Existing entries on the same local day and project are either OURS — their
 * start is one of the planned starts, i.e. written by an earlier batch of
 * this import or by an identical earlier run — or FOREIGN: anything else
 * (a hand-made entry, an import with a different hours layout, another
 * tab). One foreign entry marks the whole day as already imported, exactly
 * the rule the preview applies; an "ours" entry blocks only its own start —
 * unless it also overlaps this entry's interval (see below), in which case
 * it blocks this entry too.
 */
export function decideWrite(
  entry: ProposedEntry,
  existing: ExistingEntry[],
  timezone: string,
  plannedStarts: readonly string[],
): WriteDecision {
  const planned = new Set(plannedStarts.map((iso) => Date.parse(iso)));
  const onDay = existing.filter(
    (candidate) =>
      candidate.projectId === entry.projectId &&
      localDayOf(candidate.start, timezone) === entry.date,
  );
  const foreign = onDay.find((candidate) => !planned.has(Date.parse(candidate.start)));
  if (foreign) return { action: 'skip', reason: 'foreign', existing: foreign };
  const start = Date.parse(entry.start);
  const same = onDay.find((candidate) => Date.parse(candidate.start) === start);
  if (same) return { action: 'skip', reason: 'exists', existing: same };
  const end = Date.parse(entry.end);
  // An existing entry at a planned start may still be LONGER than the plan's
  // entry there (a 1-issue day re-scanned into 2 issues). Anything that
  // overlaps this entry's interval blocks it; a running timer (end === null)
  // occupies the rest of the day.
  const overlap = onDay.find((candidate) => {
    const candidateEnd = candidate.end === null ? Infinity : Date.parse(candidate.end);
    return Date.parse(candidate.start) < end && candidateEnd > start;
  });
  if (overlap) return { action: 'skip', reason: 'overlap', existing: overlap };
  return { action: 'write' };
}

/**
 * Dates on which at least one entry no longer starts on its own local day —
 * what a large manual hours total does to the later entries of a day. The
 * apply route rejects such entries (date/start mismatch), so the client
 * refuses to send them and shows these dates instead. Sorted ascending.
 */
export function overflowingDates(entries: ProposedEntry[], timezone: string): string[] {
  const dates = new Set<string>();
  for (const entry of entries) {
    if (localDayOf(entry.start, timezone) !== entry.date) dates.add(entry.date);
  }
  return [...dates].sort();
}

/**
 * Build the full import plan: every proposed entry tagged `new` or
 * `duplicate` (rule 4, with `existing` populated on duplicates), plus
 * totals and the pass-through `skipped`/`warnings` from the caller.
 *
 * `totals.hours` sums only `status: 'new'` entries (rule 5) — it is what
 * the user is about to add, not what will exist afterwards. `totals.days`
 * is the count of all proposed entries, new and duplicate alike.
 *
 * The caller is responsible for widening its Clockify query by ±1 day
 * around the range before calling this (rule 3) — the Clockify API filters
 * on the entry's own start time, so an entry that locally belongs to the
 * first or last day of the range can have a `start` outside it.
 */
/**
 * A short, stable fingerprint of the fields that determine what an import
 * would actually write: `key` (identity), `start`/`end` (the hours), and
 * `projectId` (the destination). Two plans with the same fingerprint would
 * produce identical Clockify writes; a changed fingerprint means the
 * `importing` results from before are no longer trustworthy against the
 * current plan and should be discarded (see `recomputePlan`/`invalidateScan`
 * in client/app.ts).
 */
export function planFingerprint(entries: ProposedEntry[]): string {
  return entries.map((e) => `${e.key}|${e.start}|${e.end}|${e.projectId}`).join('\n');
}

export function buildPlan(
  proposed: ProposedEntry[],
  existing: ExistingEntry[],
  opts: { timezone: string; skipped: { date: string; reason: 'weekend' }[]; warnings: string[] },
): ImportPlan {
  let hours = 0;
  let newDays = 0;
  let duplicateDays = 0;

  const entries: PlannedEntry[] = proposed.map((entry) => {
    const duplicate = findDuplicate(entry, existing, opts.timezone);
    if (duplicate) {
      duplicateDays += 1;
      return { ...entry, status: 'duplicate', existing: duplicate };
    }
    newDays += 1;
    hours += (Date.parse(entry.end) - Date.parse(entry.start)) / HOUR_MS;
    return { ...entry, status: 'new' };
  });

  return {
    entries,
    totals: { days: entries.length, hours, newDays, duplicateDays },
    skipped: opts.skipped,
    warnings: opts.warnings,
  };
}
