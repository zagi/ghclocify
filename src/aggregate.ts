/**
 * Turns a flat list of GitHub activities into the proposed Clockify time
 * entries: one per (local day, issue group).
 *
 * Pure, dependency-free (beyond sibling client-safe modules), and bundled
 * into both the Worker and the browser client — only client-safe imports and
 * type-only imports of `Activity` / `ImportSettings` / `ProposedEntry` are
 * allowed here.
 */
import { isWeekendInZone, localDayOf, toClockifyIso, wallClockToEpochMs } from './timezone';
import { describeDay, issueNumbersIn, sanitizeDescription } from './describe';
import { hoursToSeconds, splitSeconds } from './hours';
import type { Activity, ImportSettings, ProposedEntry } from './types';

/**
 * The issue group an activity belongs to: `''` when its title references no
 * issue, else `owner/repo#12` — or `owner/repo#12#34` when one title
 * references several, which keeps such an activity in its own group rather
 * than guessing which issue it "really" belongs to. The repo is part of the
 * key because `#12` in two repos is two different issues.
 */
export function issueGroupOf(activity: Activity): string {
  const numbers = issueNumbersIn(activity.title);
  return numbers.length === 0 ? '' : `${activity.repo}#${numbers.join('#')}`;
}

/**
 * Human label for a group: `Other` for the no-issue group, else just the
 * issue numbers (`#12`, `#12 #34`) — the repo has its own column in the UI.
 */
export function groupLabel(group: string): string {
  if (group === '') return 'Other';
  return group
    .split('#')
    .slice(1)
    .map((n) => `#${n}`)
    .join(' ');
}

/** Stable identity of an entry within a plan. */
export function entryKey(date: string, group: string): string {
  return `${date}|${group}`;
}

/** Manual hours per entry, keyed by `ProposedEntry.key`. */
export type HoursOverrides = Record<string, number>;

/** An override counts only when it is a finite number of hours in (0, 24]. */
function validOverride(hours: number | undefined): hours is number {
  return hours !== undefined && Number.isFinite(hours) && hours > 0 && hours <= 24;
}

function earliestTimestamp(items: Activity[]): number {
  return Math.min(...items.map((a) => Date.parse(a.timestamp)));
}

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
 * 4. Within a day, bucket by issue group (`issueGroupOf`) and order the
 *    groups by their earliest activity; ties keep first-appearance order.
 * 5. Hours: each entry gets an equal whole-second share of `hoursPerDay`
 *    (`splitSeconds`, remainder to the earliest entries), unless
 *    `overrides[entry.key]` supplies a valid manual value — in which case
 *    only that entry changes; the others keep their even share.
 * 6. Layout: entries on a day run back-to-back from `startTime`. `end` is an
 *    *instant* offset, not a wall-clock one: on a DST-transition day this
 *    can read as a different number of local hours, but the
 *    Clockify-derived duration stays exactly the share, which is intended.
 *    Nothing here stops a large manual total from pushing a later entry's
 *    start past local midnight — `overflowingDates` in plan.ts detects that
 *    and the apply route rejects it; this function stays pure and trusting.
 * 7. Description, repos/activityCount are per group. Output is
 *    date-ascending, then group order within the day.
 *
 * A day with no activity produces no entry — no gap filling. The caller is
 * responsible for validating `hoursPerDay` is in `(0, 24]`.
 */
export function aggregate(
  activities: Activity[],
  settings: ImportSettings,
  overrides: HoursOverrides = {},
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

    // Rule 4: bucket by issue group, ordered by earliest activity. Array
    // sort is stable, so groups whose earliest activities tie keep the order
    // they first appeared in.
    const byGroup = new Map<string, Activity[]>();
    for (const activity of dayActivities) {
      const group = issueGroupOf(activity);
      let bucket = byGroup.get(group);
      if (!bucket) {
        bucket = [];
        byGroup.set(group, bucket);
      }
      bucket.push(activity);
    }
    const groups = [...byGroup.entries()].sort(
      ([, a], [, b]) => earliestTimestamp(a) - earliestTimestamp(b),
    );

    // Rule 5: even whole-second shares, overridable per entry.
    const shares = splitSeconds(hoursToSeconds(settings.hoursPerDay), groups.length);

    // Rule 6: back-to-back from the day's start time.
    let cursor = wallClockToEpochMs(date, settings.startTime, settings.timezone);

    groups.forEach(([group, items], index) => {
      const key = entryKey(date, group);
      const override = overrides[key];
      const seconds = validOverride(override) ? hoursToSeconds(override) : (shares[index] ?? 0);
      const start = cursor;
      const end = start + seconds * 1000;
      cursor = end;

      // Distinct repo full names, first-appearance order within the group.
      const repos: string[] = [];
      const seenRepos = new Set<string>();
      for (const activity of items) {
        if (!seenRepos.has(activity.repo)) {
          seenRepos.add(activity.repo);
          repos.push(activity.repo);
        }
      }

      entries.push({
        date,
        key,
        group,
        start: toClockifyIso(start),
        end: toClockifyIso(end),
        description: sanitizeDescription(describeDay(items, settings.repoAliases)),
        billable: settings.billable,
        projectId: settings.projectId,
        activityCount: items.length,
        repos,
      });
    });
  }

  return { entries, skipped };
}
