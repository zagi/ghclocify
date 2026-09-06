import { describe, expect, it } from 'vitest';
import { aggregate, entryKey, groupLabel, issueGroupOf } from '../src/aggregate';
import type { Activity, ImportSettings } from '../src/types';

let nextId = 0;

function act(overrides: Partial<Activity> = {}): Activity {
  nextId += 1;
  return {
    kind: 'commit',
    id: `sha-${nextId}`,
    repo: 'acme/demo-project',
    timestamp: '2026-08-03T09:00:00Z',
    title: 'do a thing',
    url: 'https://github.com/acme/demo-project/commit/abc',
    ...overrides,
  };
}

function baseSettings(overrides: Partial<ImportSettings> = {}): ImportSettings {
  return {
    hoursPerDay: 8,
    startTime: '09:00',
    timezone: 'UTC',
    includeWeekends: false,
    billable: true,
    workspaceId: 'ws1',
    projectId: 'proj1',
    repoAliases: {},
    ...overrides,
  };
}

describe('aggregate', () => {
  it('1. groups two commits on the same local day into one entry with activityCount 2', () => {
    const activities: Activity[] = [
      act({ timestamp: '2026-08-03T09:00:00Z', title: 'first commit' }),
      act({ timestamp: '2026-08-03T15:00:00Z', title: 'second commit' }),
    ];
    const { entries } = aggregate(activities, baseSettings({ timezone: 'UTC' }));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.activityCount).toBe(2);
  });

  it('2. collapses duplicate ids across repos to a single activity, first occurrence wins', () => {
    const activities: Activity[] = [
      act({
        id: 'shared-sha',
        repo: 'acme/first-repo',
        title: 'from first repo',
        timestamp: '2026-08-03T09:00:00Z',
      }),
      act({
        id: 'shared-sha',
        repo: 'acme/second-repo',
        title: 'from second repo',
        timestamp: '2026-08-03T10:00:00Z',
      }),
    ];
    const { entries } = aggregate(activities, baseSettings({ timezone: 'UTC' }));
    expect(entries).toHaveLength(1);
    // If dedup were missing (or scoped wrong), this would be 2 and both repos
    // would show up below.
    expect(entries[0]?.activityCount).toBe(1);
    expect(entries[0]?.repos).toEqual(['acme/first-repo']);
    expect(entries[0]?.description).toContain('from first repo');
    expect(entries[0]?.description).not.toContain('from second repo');
  });

  it('3. computes start/end for a 6h day starting 10:00 Europe/Warsaw', () => {
    const activities: Activity[] = [act({ timestamp: '2026-08-03T09:00:00Z' })];
    const { entries } = aggregate(
      activities,
      baseSettings({ hoursPerDay: 6, startTime: '10:00', timezone: 'Europe/Warsaw' }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.date).toBe('2026-08-03');
    expect(entries[0]?.start).toBe('2026-08-03T08:00:00Z');
    expect(entries[0]?.end).toBe('2026-08-03T14:00:00Z');
  });

  it('4. emits start/end with no milliseconds', () => {
    const activities: Activity[] = [act({ timestamp: '2026-08-03T09:00:00Z' })];
    const { entries } = aggregate(
      activities,
      baseSettings({ timezone: 'UTC', startTime: '09:00' }),
    );
    expect(entries[0]?.start).toBe('2026-08-03T09:00:00Z');
    expect(entries[0]?.end).toBe('2026-08-03T17:00:00Z');
    expect(entries[0]?.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(entries[0]?.end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('5. drops a Saturday-only day when includeWeekends is false, reports it in skipped; keeps it when true', () => {
    // 2026-08-01 is a Saturday (verified via Intl weekday format).
    const activities: Activity[] = [act({ timestamp: '2026-08-01T09:00:00Z' })];

    const dropped = aggregate(
      activities,
      baseSettings({ includeWeekends: false, timezone: 'UTC' }),
    );
    expect(dropped.entries).toHaveLength(0);
    expect(dropped.skipped).toEqual([{ date: '2026-08-01', reason: 'weekend' }]);

    const kept = aggregate(activities, baseSettings({ includeWeekends: true, timezone: 'UTC' }));
    expect(kept.entries).toHaveLength(1);
    expect(kept.entries[0]?.date).toBe('2026-08-01');
    expect(kept.skipped).toHaveLength(0);
  });

  it('6. buckets a late-UTC commit onto the correct local day (the bug fix)', () => {
    const activities: Activity[] = [act({ timestamp: '2026-08-02T22:30:00Z' })];

    const warsaw = aggregate(
      activities,
      baseSettings({ timezone: 'Europe/Warsaw', includeWeekends: true }),
    );
    expect(warsaw.entries.map((e) => e.date)).toEqual(['2026-08-03']);

    const utc = aggregate(activities, baseSettings({ timezone: 'UTC', includeWeekends: true }));
    expect(utc.entries.map((e) => e.date)).toEqual(['2026-08-02']);
  });

  it('7. returns entries date-ascending even when input activities are shuffled', () => {
    // Fed in descending timestamp order, and none of these are weekend days
    // (Mon/Tue/Wed) — a Map-insertion-order implementation that forgot the
    // explicit sort would emit 08-05, 08-03, 08-04 instead.
    const activities: Activity[] = [
      act({ timestamp: '2026-08-05T09:00:00Z' }), // Wednesday
      act({ timestamp: '2026-08-03T09:00:00Z' }), // Monday
      act({ timestamp: '2026-08-04T09:00:00Z' }), // Tuesday
    ];
    const { entries } = aggregate(activities, baseSettings({ timezone: 'UTC' }));
    expect(entries.map((e) => e.date)).toEqual(['2026-08-03', '2026-08-04', '2026-08-05']);
  });

  it('8. returns an empty entry list for an empty activity list, not a throw', () => {
    expect(() => aggregate([], baseSettings())).not.toThrow();
    const { entries, skipped } = aggregate([], baseSettings());
    expect(entries).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('9. counts mixed activity kinds on one day in a single entry', () => {
    const activities: Activity[] = [
      act({ kind: 'commit', id: 'c1', title: 'a commit' }),
      act({ kind: 'pull_request', id: 'pr1', title: 'a pr' }),
      act({ kind: 'issue', id: 'issue1', title: 'an issue' }),
      act({ kind: 'review', id: 'review1', title: 'a review' }),
    ];
    const { entries } = aggregate(activities, baseSettings({ timezone: 'UTC' }));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.activityCount).toBe(4);
  });

  it('10. splits a day into one entry per referenced issue, laid out back-to-back with equal hours', () => {
    const activities: Activity[] = [
      act({ timestamp: '2026-08-03T09:00:00Z', title: 'start on #123' }),
      act({ timestamp: '2026-08-03T11:00:00Z', title: 'work on #124' }),
      act({ timestamp: '2026-08-03T15:00:00Z', title: 'finish #123' }),
    ];
    const { entries } = aggregate(activities, baseSettings({ timezone: 'UTC' }));
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.group)).toEqual(['acme/demo-project#123', 'acme/demo-project#124']);
    expect(entries.map((e) => e.key)).toEqual([
      '2026-08-03|acme/demo-project#123',
      '2026-08-03|acme/demo-project#124',
    ]);
    expect(entries[0]?.start).toBe('2026-08-03T09:00:00Z');
    expect(entries[0]?.end).toBe('2026-08-03T13:00:00Z');
    expect(entries[1]?.start).toBe('2026-08-03T13:00:00Z');
    expect(entries[1]?.end).toBe('2026-08-03T17:00:00Z');
    expect(entries[0]?.activityCount).toBe(2);
    expect(entries[1]?.activityCount).toBe(1);
    expect(entries[0]?.description).toContain('start on');
    expect(entries[0]?.description).toContain('finish');
    expect(entries[0]?.description).not.toContain('work on');
  });

  it('11. activities referencing no issue form a single "other" group on the day, keyed with an empty group', () => {
    const activities: Activity[] = [
      act({ timestamp: '2026-08-03T09:00:00Z', title: 'chore: tidy' }),
      act({ timestamp: '2026-08-03T10:00:00Z', title: 'fix #7' }),
      act({ timestamp: '2026-08-03T12:00:00Z', title: 'chore: more tidy' }),
    ];
    const { entries } = aggregate(activities, baseSettings({ timezone: 'UTC' }));
    expect(entries.map((e) => e.group)).toEqual(['', 'acme/demo-project#7']);
    expect(entries[0]?.key).toBe('2026-08-03|');
    expect(entries[0]?.activityCount).toBe(2);
    expect(entries[0]?.date).toBe('2026-08-03');
    expect(entries[1]?.date).toBe('2026-08-03');
  });

  it("12. orders a day's groups by their earliest activity, not by issue number", () => {
    const activities: Activity[] = [
      act({ timestamp: '2026-08-03T14:00:00Z', title: 'late #5' }),
      act({ timestamp: '2026-08-03T09:00:00Z', title: 'early #900' }),
      act({ timestamp: '2026-08-03T08:00:00Z', title: 'earliest #5' }),
    ];
    const { entries } = aggregate(activities, baseSettings({ timezone: 'UTC' }));
    expect(entries.map((e) => e.group)).toEqual(['acme/demo-project#5', 'acme/demo-project#900']);
  });

  it('13. shares are whole seconds summing exactly to hoursPerDay, remainder to the earliest entries', () => {
    const activities: Activity[] = Array.from({ length: 7 }, (_, i) =>
      act({ timestamp: `2026-08-03T0${i + 1}:00:00Z`, title: `task #${i + 1}` }),
    );
    const { entries } = aggregate(
      activities,
      baseSettings({ timezone: 'UTC', hoursPerDay: 8, startTime: '09:00' }),
    );
    const seconds = entries.map((e) => (Date.parse(e.end) - Date.parse(e.start)) / 1000);
    expect(seconds.every(Number.isInteger)).toBe(true);
    expect(seconds.reduce((a, b) => a + b, 0)).toBe(28_800);
    expect(seconds).toEqual([4115, 4115, 4114, 4114, 4114, 4114, 4114]);
    expect(entries[0]?.start).toBe('2026-08-03T09:00:00Z');
    expect(entries[6]?.end).toBe('2026-08-03T17:00:00Z');
  });

  it("14. a manual override replaces only that entry's hours; others keep the even share and layout stays sequential", () => {
    const activities: Activity[] = [
      act({ timestamp: '2026-08-03T09:00:00Z', title: 'a #1' }),
      act({ timestamp: '2026-08-03T10:00:00Z', title: 'b #2' }),
    ];
    const { entries } = aggregate(activities, baseSettings({ timezone: 'UTC' }), {
      '2026-08-03|acme/demo-project#1': 1.5,
    });
    expect(entries[0]?.start).toBe('2026-08-03T09:00:00Z');
    expect(entries[0]?.end).toBe('2026-08-03T10:30:00Z');
    expect(entries[1]?.start).toBe('2026-08-03T10:30:00Z');
    expect(entries[1]?.end).toBe('2026-08-03T14:30:00Z');
  });

  it('15. an override that is not a finite number in (0, 24] is ignored, not clamped', () => {
    const activities: Activity[] = [act({ timestamp: '2026-08-03T09:00:00Z', title: 'a #1' })];
    for (const bad of [0, -1, 25, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { entries } = aggregate(activities, baseSettings({ timezone: 'UTC' }), {
        '2026-08-03|acme/demo-project#1': bad,
      });
      expect(entries[0]?.end).toBe('2026-08-03T17:00:00Z');
    }
  });

  it('16. the same issue number in two repos is two groups; a title referencing two issues is its own group', () => {
    const activities: Activity[] = [
      act({ repo: 'acme/one', timestamp: '2026-08-03T09:00:00Z', title: 'fix #1' }),
      act({ repo: 'acme/two', timestamp: '2026-08-03T10:00:00Z', title: 'fix #1' }),
      act({ repo: 'acme/one', timestamp: '2026-08-03T11:00:00Z', title: 'refs #2 #1' }),
    ];
    const { entries } = aggregate(activities, baseSettings({ timezone: 'UTC' }));
    expect(entries.map((e) => e.group)).toEqual(['acme/one#1', 'acme/two#1', 'acme/one#1#2']);
  });

  it('17. issueGroupOf / groupLabel / entryKey helpers', () => {
    expect(issueGroupOf(act({ repo: 'acme/x', title: 'no ref' }))).toBe('');
    expect(issueGroupOf(act({ repo: 'acme/x', title: 'see #34 and #12' }))).toBe('acme/x#12#34');
    expect(groupLabel('')).toBe('Other');
    expect(groupLabel('acme/x#12')).toBe('#12');
    expect(groupLabel('acme/x#12#34')).toBe('#12 #34');
    expect(entryKey('2026-08-03', 'acme/x#12')).toBe('2026-08-03|acme/x#12');
    expect(entryKey('2026-08-03', '')).toBe('2026-08-03|');
  });

  it('18. with no issue references at all the output is one entry per day, exactly as before', () => {
    const activities: Activity[] = [
      act({ timestamp: '2026-08-03T09:00:00Z', title: 'first commit' }),
      act({ timestamp: '2026-08-03T15:00:00Z', title: 'second commit' }),
    ];
    const { entries } = aggregate(activities, baseSettings({ timezone: 'UTC' }));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.group).toBe('');
    expect(entries[0]?.start).toBe('2026-08-03T09:00:00Z');
    expect(entries[0]?.end).toBe('2026-08-03T17:00:00Z');
  });
});
