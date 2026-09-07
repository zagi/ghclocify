import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  decideWrite,
  findDuplicate,
  findLanded,
  overflowingDates,
  planFingerprint,
} from '../src/plan';
import type { ExistingEntry, ProposedEntry } from '../src/types';

function proposed(overrides: Partial<ProposedEntry> = {}): ProposedEntry {
  return {
    date: '2026-08-03',
    key: '2026-08-03|acme/demo#1',
    group: 'acme/demo#1',
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

  it('8. a null existing.projectId never matches, even against a proposed entry on the same day', () => {
    // Guards against a future "helpful" change where a null projectId is
    // made to fall back to some plan-level project id before comparison —
    // that would start matching unassigned-project entries against
    // everything, and today nothing would catch it. Plain `===` against a
    // string is the only thing standing in the way.
    const unassigned = existing({ id: 'no-project', projectId: null });
    const plan = buildPlan([proposed({ projectId: 'proj1' })], [unassigned], {
      timezone: 'UTC',
      skipped: [],
      warnings: [],
    });
    expect(plan.entries[0]?.status).toBe('new');
    expect(plan.entries[0]?.existing).toBeUndefined();
  });

  it('9. two existing entries colliding on the same day and project: flagged duplicate regardless of which one `find` returns first', () => {
    // `findDuplicate` uses Array#find, so the first matching entry in
    // `existing` wins arbitrarily when more than one collides. Pinning that
    // the *outcome* (status stays 'duplicate') does not depend on which one
    // that is — documented behaviour, not an accident of iteration order.
    const first = existing({ id: 'first-collision' });
    const second = existing({ id: 'second-collision' });
    const plan = buildPlan([proposed()], [first, second], {
      timezone: 'UTC',
      skipped: [],
      warnings: [],
    });
    expect(plan.entries[0]?.status).toBe('duplicate');
    expect([first, second]).toContainEqual(plan.entries[0]?.existing);
  });

  it('10. trust boundary: findDuplicate compares candidates against entry.date verbatim, never re-deriving it from entry.start — a caller-contract violation is not defended against here', () => {
    // entry.date claims 2026-08-10 but entry.start is nowhere near that day
    // (2026-08-03), simulating a caller bug — e.g. entry.date computed in a
    // different zone than the `timezone` passed to findDuplicate/buildPlan.
    // findDuplicate never reads entry.start at all, so it matches purely on
    // the (here, inconsistent) entry.date. This is a deliberate, undefended
    // caller contract — aggregate.ts is responsible for entry.date already
    // being the local day of entry.start under the same timezone passed
    // here — not a runtime-checked invariant: a defensive re-derivation
    // would cost every call in this hot, pure function to guard a bug that
    // belongs to the caller to get right once. This test pins that trust
    // explicitly rather than leaving it a silent assumption.
    const inconsistentEntry = proposed({
      date: '2026-08-10',
      start: '2026-08-03T09:00:00Z',
    });
    const matchesStatedDate = existing({ id: 'trust-boundary', start: '2026-08-10T09:00:00Z' });

    const plan = buildPlan([inconsistentEntry], [matchesStatedDate], {
      timezone: 'UTC',
      skipped: [],
      warnings: [],
    });
    // Matches on entry.date (08-10), completely ignoring that entry.start
    // (08-03) disagrees with it — proof the module trusts entry.date as-is.
    expect(plan.entries[0]?.status).toBe('duplicate');
    expect(plan.entries[0]?.existing).toEqual(matchesStatedDate);
  });

  it('11. existing.end: null (a running timer) is still matchable as a duplicate', () => {
    const runningTimer = existing({ id: 'running', end: null });
    const plan = buildPlan([proposed()], [runningTimer], {
      timezone: 'UTC',
      skipped: [],
      warnings: [],
    });
    expect(plan.entries[0]?.status).toBe('duplicate');
    expect(plan.entries[0]?.existing).toEqual(runningTimer);
  });

  it('12. an unparseable existing.start fails loudly rather than silently non-matching', () => {
    const bad = existing({ id: 'bad-start', start: 'not-a-date' });
    expect(() => findDuplicate(proposed(), [bad], 'UTC')).toThrow();
  });

  it('13. findLanded matches on project and the exact start instant, not the day', () => {
    const sibling = existing({ id: 'sibling', start: '2026-08-03T09:00:00Z' });
    const mine = existing({ id: 'mine', start: '2026-08-03T13:00:00Z' });
    const second = proposed({ start: '2026-08-03T13:00:00Z', end: '2026-08-03T17:00:00Z' });
    expect(findLanded(second, [sibling])).toBeUndefined();
    expect(findLanded(second, [sibling, mine])).toEqual(mine);
    // A different project at the same instant is not it.
    expect(
      findLanded(second, [existing({ id: 'p2', start: mine.start, projectId: 'proj2' })]),
    ).toBeUndefined();
    // Millisecond formatting differences do not matter — instants compare.
    expect(findLanded(second, [existing({ id: 'ms', start: '2026-08-03T13:00:00.000Z' })])).toEqual(
      existing({ id: 'ms', start: '2026-08-03T13:00:00.000Z' }),
    );
  });

  it('14. overflowingDates lists days where an entry starts on a different local day than its date', () => {
    const fine = proposed({ date: '2026-08-03', start: '2026-08-03T09:00:00Z' });
    const spilled = proposed({
      date: '2026-08-04',
      key: '2026-08-04|acme/demo#2',
      start: '2026-08-05T01:00:00Z',
      end: '2026-08-05T03:00:00Z',
    });
    expect(overflowingDates([fine], 'UTC')).toEqual([]);
    expect(overflowingDates([fine, spilled], 'UTC')).toEqual(['2026-08-04']);
    // Under Europe/Warsaw (UTC+2 in August) 2026-08-05T01:00Z is still 03:00
    // on the 5th — still overflowing the 4th.
    expect(overflowingDates([spilled], 'Europe/Warsaw')).toEqual(['2026-08-04']);
    // 2026-08-04T22:30Z is 00:30 on the 5th in Warsaw: overflow there, fine in UTC.
    const edge = proposed({
      date: '2026-08-04',
      key: '2026-08-04|',
      start: '2026-08-04T22:30:00Z',
    });
    expect(overflowingDates([edge], 'Europe/Warsaw')).toEqual(['2026-08-04']);
    expect(overflowingDates([edge], 'UTC')).toEqual([]);
  });

  it('15. decideWrite: no existing entries on the day -> write', () => {
    const entry = proposed({ start: '2026-08-03T09:00:00Z', end: '2026-08-03T13:00:00Z' });
    expect(decideWrite(entry, [], 'UTC', ['2026-08-03T09:00:00Z', '2026-08-03T13:00:00Z'])).toEqual(
      {
        action: 'write',
      },
    );
    // Other days and other projects are irrelevant.
    const otherDay = existing({ id: 'od', start: '2026-08-04T09:00:00Z' });
    const otherProject = existing({ id: 'op', projectId: 'proj2' });
    expect(decideWrite(entry, [otherDay, otherProject], 'UTC', ['2026-08-03T09:00:00Z'])).toEqual({
      action: 'write',
    });
  });

  it('16. decideWrite: an existing entry whose start is a planned start is ours — blocks only its own start', () => {
    const planned = ['2026-08-03T09:00:00Z', '2026-08-03T13:00:00Z'];
    const first = proposed({ start: '2026-08-03T09:00:00Z', end: '2026-08-03T13:00:00Z' });
    const second = proposed({
      key: '2026-08-03|acme/demo#2',
      group: 'acme/demo#2',
      start: '2026-08-03T13:00:00Z',
      end: '2026-08-03T17:00:00Z',
    });
    // `end` matches `first`'s own end (13:00) rather than the `existing()`
    // helper's whole-day default: a landed entry that stops where `second`
    // starts must not trip the overlap guard added for finding A.
    const firstLanded = existing({
      id: 'ours',
      start: '2026-08-03T09:00:00Z',
      end: '2026-08-03T13:00:00Z',
    });
    expect(decideWrite(first, [firstLanded], 'UTC', planned)).toEqual({
      action: 'skip',
      reason: 'exists',
      existing: firstLanded,
    });
    expect(decideWrite(second, [firstLanded], 'UTC', planned)).toEqual({ action: 'write' });
    // Millisecond formatting differences do not matter: instants compare.
    const ms = existing({
      id: 'ms',
      start: '2026-08-03T09:00:00.000Z',
      end: '2026-08-03T13:00:00Z',
    });
    expect(decideWrite(second, [ms], 'UTC', planned)).toEqual({ action: 'write' });
  });

  it('17. decideWrite: an existing entry with a start outside the plan is foreign — blocks the whole day', () => {
    const planned = ['2026-08-03T09:00:00Z', '2026-08-03T13:00:00Z'];
    const second = proposed({ start: '2026-08-03T13:00:00Z', end: '2026-08-03T17:00:00Z' });
    const manual = existing({ id: 'manual', start: '2026-08-03T07:30:00Z' });
    expect(decideWrite(second, [manual], 'UTC', planned)).toEqual({
      action: 'skip',
      reason: 'foreign',
      existing: manual,
    });
    // Foreign wins even when our own earlier entry is also there.
    const ours = existing({ id: 'ours', start: '2026-08-03T09:00:00Z' });
    expect(decideWrite(second, [ours, manual], 'UTC', planned).action).toBe('skip');
    expect((decideWrite(second, [ours, manual], 'UTC', planned) as { reason: string }).reason).toBe(
      'foreign',
    );
  });

  it('18. decideWrite compares local days: a 23:00Z-previous-day entry is on the day under Europe/Warsaw, not under UTC', () => {
    const entry = proposed({
      date: '2026-08-03',
      start: '2026-08-03T07:00:00Z',
      end: '2026-08-03T11:00:00Z',
    });
    const late = existing({ id: 'late', start: '2026-08-02T23:00:00Z' });
    expect(decideWrite(entry, [late], 'Europe/Warsaw', ['2026-08-03T07:00:00Z']).action).toBe(
      'skip',
    );
    expect(decideWrite(entry, [late], 'UTC', ['2026-08-03T07:00:00Z'])).toEqual({
      action: 'write',
    });
  });

  it("19. an existing entry at a planned start but longer than the plan's entry blocks the later entries of its day", () => {
    // A 1-issue day (09:00-17:00) already imported, now re-scanned into two
    // issues (09:00-13:00, 13:00-17:00). The first entry's start matches the
    // existing entry's start exactly -> 'exists'. The second entry's start
    // (13:00) is itself a planned start, so it is NOT foreign and does not
    // exact-match the existing entry's start either -- without the overlap
    // guard it would be written, double-booking 13:00-17:00.
    const planned = ['2026-08-03T09:00:00Z', '2026-08-03T13:00:00Z'];
    const existingLong = existing({
      id: 'long',
      start: '2026-08-03T09:00:00Z',
      end: '2026-08-03T17:00:00Z',
    });
    const second = proposed({
      key: '2026-08-03|acme/demo#2',
      group: 'acme/demo#2',
      start: '2026-08-03T13:00:00Z',
      end: '2026-08-03T17:00:00Z',
    });
    expect(decideWrite(second, [existingLong], 'UTC', planned)).toEqual({
      action: 'skip',
      reason: 'overlap',
      existing: existingLong,
    });
  });

  it('20. back-to-back entries written by an earlier batch do not block the next one', () => {
    // The first entry landed with its own real end (09:00-13:00); a second
    // entry starting exactly where the first ends must not be treated as
    // overlapping it.
    const planned = ['2026-08-03T09:00:00Z', '2026-08-03T13:00:00Z'];
    const firstLanded = existing({
      id: 'first',
      start: '2026-08-03T09:00:00Z',
      end: '2026-08-03T13:00:00Z',
    });
    const second = proposed({
      key: '2026-08-03|acme/demo#2',
      group: 'acme/demo#2',
      start: '2026-08-03T13:00:00Z',
      end: '2026-08-03T17:00:00Z',
    });
    expect(decideWrite(second, [firstLanded], 'UTC', planned)).toEqual({ action: 'write' });
  });

  it('21. a running timer (end: null) starting at a planned start blocks a later entry that overlaps it', () => {
    const planned = ['2026-08-03T09:00:00Z', '2026-08-03T13:00:00Z'];
    const runningTimer = existing({ id: 'running', start: '2026-08-03T09:00:00Z', end: null });
    const second = proposed({
      key: '2026-08-03|acme/demo#2',
      group: 'acme/demo#2',
      start: '2026-08-03T13:00:00Z',
      end: '2026-08-03T17:00:00Z',
    });
    expect(decideWrite(second, [runningTimer], 'UTC', planned)).toEqual({
      action: 'skip',
      reason: 'overlap',
      existing: runningTimer,
    });
  });
});

describe('planFingerprint', () => {
  it('22. the same entries produce the same fingerprint', () => {
    const entries = [proposed(), proposed({ date: '2026-08-04', key: '2026-08-04|acme/demo#2' })];
    expect(planFingerprint(entries)).toBe(planFingerprint(entries));
    expect(planFingerprint(entries)).toBe(planFingerprint([...entries]));
  });

  it('23. a changed end produces a different fingerprint', () => {
    const base = [proposed()];
    const changed = [proposed({ end: '2026-08-03T18:00:00Z' })];
    expect(planFingerprint(base)).not.toBe(planFingerprint(changed));
  });

  it('24. a changed projectId produces a different fingerprint', () => {
    const base = [proposed()];
    const changed = [proposed({ projectId: 'proj2' })];
    expect(planFingerprint(base)).not.toBe(planFingerprint(changed));
  });

  it('25. a changed start produces a different fingerprint', () => {
    const base = [proposed()];
    const changed = [proposed({ start: '2026-08-03T10:00:00Z' })];
    expect(planFingerprint(base)).not.toBe(planFingerprint(changed));
  });

  it('26. an empty plan has a stable, defined fingerprint', () => {
    expect(planFingerprint([])).toBe(planFingerprint([]));
  });
});
