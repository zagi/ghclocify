/**
 * Turns a flat list of GitHub activities into the proposed daily Clockify
 * time entries.
 *
 * Pure, dependency-free (beyond sibling client-safe modules), and bundled
 * into both the Worker and the browser client — only client-safe imports and
 * type-only imports of `Activity` / `ImportSettings` / `ProposedEntry` are
 * allowed here.
 */
import { isWeekendInZone, localDayOf, toClockifyIso, wallClockToEpochMs } from './timezone';
import { describeDay, sanitizeDescription } from './describe';
import type { Activity, ImportSettings, ProposedEntry } from './types';

const HOUR_MS = 3_600_000;

/**
 * Group deduped activities into `{ entries, skipped }`.
 *
 * 1. Dedupe by `id` first: the same commit SHA can arrive from two repos
 *    when a fork is listed alongside its parent. First occurrence in
 *    `activities` wins; later duplicates are dropped entirely (they do not
 *    contribute to `repos`, `activityCount`, or the description).
 * 2. Bucket by LOCAL day, via `localDayOf` (== `dayKey(Date.parse(iso), tz)`,
 *    but without re-deriving that composition here).
 * 3. Drop weekend days when `settings.includeWeekends` is false, recording
 *    each in `skipped`.
 * 4. `end` is an *instant* offset (`start + hoursPerDay * 3_600_000`), not a
 *    wall-clock one: on a DST-transition day this can read as a different
 *    number of local hours, but the Clockify-derived duration stays exactly
 *    `hoursPerDay`, which is the intended behaviour.
 * 5-7: description, repos/activityCount, and date-ascending ordering — see
 *    inline comments below.
 *
 * A day with no activity produces no entry — no gap filling. The caller is
 * responsible for validating `hoursPerDay` is in `(0, 24]`.
 */
export function aggregate(
  activities: Activity[],
  settings: ImportSettings,
): { entries: ProposedEntry[]; skipped: { date: string; reason: 'weekend' }[] } {
  // Rule 1: dedupe by id, first occurrence wins, relative order preserved.
  const seenIds = new Set<string>();
  const deduped: Activity[] = [];
  for (const activity of activities) {
    if (seenIds.has(activity.id)) continue;
    seenIds.add(activity.id);
    deduped.push(activity);
  }

  // Rule 2: bucket by local calendar day.
  const byDay = new Map<string, Activity[]>();
  for (const activity of deduped) {
    const date = localDayOf(activity.timestamp, settings.timezone);
    let bucket = byDay.get(date);
    if (!bucket) {
      bucket = [];
      byDay.set(date, bucket);
    }
    bucket.push(activity);
  }

  // Rule 7: date-ascending output. `YYYY-MM-DD` sorts correctly as strings.
  const dates = [...byDay.keys()].sort();

  const entries: ProposedEntry[] = [];
  const skipped: { date: string; reason: 'weekend' }[] = [];

  for (const date of dates) {
    // Rule 3: drop weekends unless included, but still report them.
    if (!settings.includeWeekends && isWeekendInZone(date, settings.timezone)) {
      skipped.push({ date, reason: 'weekend' });
      continue;
    }

    const dayActivities = byDay.get(date) ?? [];

    // Rule 4: instant offset, not a wall-clock one — see doc comment above.
    const start = wallClockToEpochMs(date, settings.startTime, settings.timezone);
    const end = start + settings.hoursPerDay * HOUR_MS;

    // Rule 6: distinct repo full names, first-appearance order.
    const repos: string[] = [];
    const seenRepos = new Set<string>();
    for (const activity of dayActivities) {
      if (!seenRepos.has(activity.repo)) {
        seenRepos.add(activity.repo);
        repos.push(activity.repo);
      }
    }

    entries.push({
      date,
      start: toClockifyIso(start),
      end: toClockifyIso(end),
      // Rule 5.
      description: sanitizeDescription(describeDay(dayActivities, settings.repoAliases)),
      billable: settings.billable,
      projectId: settings.projectId,
      // Rule 6: the deduped count for the day.
      activityCount: dayActivities.length,
      repos,
    });
  }

  return { entries, skipped };
}
