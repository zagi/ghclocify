import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/aggregate';
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
});
