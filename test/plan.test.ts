import { describe, expect, it } from 'vitest';
import { buildPlan, findDuplicate } from '../src/plan';
import type { ExistingEntry, ProposedEntry } from '../src/types';

function proposed(overrides: Partial<ProposedEntry> = {}): ProposedEntry {
  return {
    date: '2026-08-03',
    start: '2026-08-03T09:00:00Z',
    end: '2026-08-03T17:00:00Z',
    description: 'did stuff',
    billable: true,
    projectId: 'proj1',
    activityCount: 1,
    repos: ['acme/demo'],
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingEntry> = {}): ExistingEntry {
  return {
    id: 'existing1',
    start: '2026-08-03T09:00:00Z',
    end: '2026-08-03T17:00:00Z',
    description: 'already here',
    projectId: 'proj1',
    ...overrides,
  };
}

describe('buildPlan', () => {
  it('1. with no existing entries, every entry is new and duplicateDays is 0', () => {
    const plan = buildPlan([proposed()], [], { timezone: 'UTC', skipped: [], warnings: [] });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.status).toBe('new');
    expect(plan.entries[0]?.existing).toBeUndefined();
    expect(plan.totals.duplicateDays).toBe(0);
    expect(plan.totals.newDays).toBe(1);
  });

  it('2. an existing entry on the same day and project marks the proposed entry a duplicate', () => {
    const same = existing({ id: 'dup1' });
    const plan = buildPlan([proposed()], [same], { timezone: 'UTC', skipped: [], warnings: [] });
    expect(plan.entries[0]?.status).toBe('duplicate');
    expect(plan.entries[0]?.existing).toEqual(same);
    expect(plan.totals.duplicateDays).toBe(1);
    expect(plan.totals.newDays).toBe(0);
  });

  it('3. an existing entry on the same day but a different project stays new', () => {
    const otherProject = existing({ id: 'other-proj', projectId: 'proj2' });
    const plan = buildPlan([proposed({ projectId: 'proj1' })], [otherProject], {
      timezone: 'UTC',
      skipped: [],
      warnings: [],
    });
    expect(plan.entries[0]?.status).toBe('new');
    expect(plan.entries[0]?.existing).toBeUndefined();
  });

  it('4. boundary: a 23:00Z-previous-day entry duplicates under Europe/Warsaw but not under UTC', () => {
    // 2026-08-02T23:00:00Z is 01:00 on 2026-08-03 in Europe/Warsaw (UTC+2 in
    // August), so it already occupies the 3 August slot there. Under UTC it
    // is still on 2 August, so it must NOT collide with a proposed 3 August
    // entry. This is the case an instant-based comparison would get wrong.
    const lateEntry = existing({ id: 'late', start: '2026-08-02T23:00:00Z' });
    const proposedAug3 = proposed({ date: '2026-08-03' });

    const warsaw = buildPlan([proposedAug3], [lateEntry], {
      timezone: 'Europe/Warsaw',
      skipped: [],
      warnings: [],
    });
    expect(warsaw.entries[0]?.status).toBe('duplicate');
    expect(warsaw.entries[0]?.existing).toEqual(lateEntry);

    const utc = buildPlan([proposedAug3], [lateEntry], {
      timezone: 'UTC',
      skipped: [],
      warnings: [],
    });
    expect(utc.entries[0]?.status).toBe('new');
    expect(utc.entries[0]?.existing).toBeUndefined();
  });

  it('5. totals.hours sums only new entries, ignoring duplicates', () => {
    const newEntry = proposed({
      date: '2026-08-03',
      start: '2026-08-03T09:00:00Z',
      end: '2026-08-03T17:00:00Z', // 8h
    });
    const dupEntry = proposed({
      date: '2026-08-04',
      start: '2026-08-04T09:00:00Z',
      end: '2026-08-04T13:00:00Z', // 4h, but duplicated below
    });
    const dupExisting = existing({ id: 'dup2', start: '2026-08-04T09:00:00Z' });

    const plan = buildPlan([newEntry, dupEntry], [dupExisting], {
      timezone: 'UTC',
      skipped: [],
      warnings: [],
    });
    expect(plan.totals.hours).toBe(8);
    expect(plan.totals.days).toBe(2);
    expect(plan.totals.newDays).toBe(1);
    expect(plan.totals.duplicateDays).toBe(1);
  });

  it('6. skipped and warnings pass through unchanged', () => {
    const skipped = [{ date: '2026-08-01', reason: 'weekend' as const }];
    const warnings = ['free-plan workspace rate limit is close'];
    const plan = buildPlan([proposed()], [], { timezone: 'UTC', skipped, warnings });
    expect(plan.skipped).toEqual(skipped);
    expect(plan.skipped).toBe(skipped);
    expect(plan.warnings).toEqual(warnings);
    expect(plan.warnings).toBe(warnings);
  });

  it('7. findDuplicate returns undefined when nothing collides and the entry when one does', () => {
    expect(findDuplicate(proposed(), [], 'UTC')).toBeUndefined();
    expect(
      findDuplicate(proposed(), [existing({ id: 'other-proj', projectId: 'proj2' })], 'UTC'),
    ).toBeUndefined();

    const match = existing({ id: 'match' });
    expect(findDuplicate(proposed(), [match], 'UTC')).toEqual(match);
  });
});
