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
