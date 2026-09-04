# Per-issue Entries With Even / Manual Hour Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Clockify entry per (day, GitHub issue) instead of one per day, with the day's hours split evenly across those entries by default, and a per-entry manual hours mode (with a running total) when the user unchecks the even-split option.

**Architecture:** The grouping and the hour split live entirely in the pure, client-safe `src/aggregate.ts` (bundled into both the Worker and the browser). Activities on a day are bucketed by an _issue group_ — `owner/repo#12` for a title referencing issue 12, `''` for everything else — and laid out back-to-back from the configured start time, each getting an equal whole-second share of `hoursPerDay` unless the caller passes a manual override keyed by the entry's stable `key`. The preview's duplicate rule (any existing Clockify entry on the same day and project marks the day as already imported) is unchanged; the write route stops treating same-batch siblings as duplicates by checking them on exact start instant instead, and the client packs whole days into each apply batch so a day never straddles two batches.

**Tech Stack:** TypeScript 6, Hono 4, Cloudflare Workers, vanilla-TS client bundled by esbuild, vitest 4 (pure `node` project for `src/*` modules, `@cloudflare/vitest-pool-workers` for routes), ESLint 10 + Prettier.

**Spec:** The user's request (translated from Polish), which this plan implements in full:

1. Every commit/activity referencing the same GitHub issue is grouped into its own entry — one entry per issue per day, not one per day.
2. A new option, on by default, splits the day's hours evenly across that day's entries: with commits for `#123` and `#124` on an 8-hour day, each entry gets 4 h (`hoursPerDay / number of entries`).
3. When the user unchecks the option, each entry in the preview gets an editable hours field, and a total of the hours is shown at the bottom, before import.

## Global Constraints

Copied from the original plan (`docs/superpowers/plans/2026-08-31-gh2clockify.md`) and the repo's current conventions. Every task's requirements implicitly include this section.

- **`src/aggregate.ts`, `src/plan.ts`, `src/describe.ts`, `src/types.ts`, `src/timezone.ts`, `src/validate.ts` and any new `src/hours.ts` are client-safe:** no runtime imports outside this set, type-only imports from `./types`. They are listed in `tsconfig.client.json` `include` and in `vitest.config.ts`'s `pure` project — a new pure module must be added to both.
- **Clockify timestamps are `yyyy-MM-ddThh:mm:ssZ`, second precision, no milliseconds.** All durations are whole seconds; `toClockifyIso` already strips millis.
- **`entry.date` must always equal `localDayOf(entry.start, timezone)`.** `src/routes/apply.ts` rejects any entry where this does not hold. Never patch times on an existing entry — rebuild the plan from activities.
- **Never double-book hours.** The write route's pre-write duplicate check and the "never retry a POST, recheck instead" rule stay in force. `createEntry` keeps `retries: 0`.
- **Description limits:** ≤ 3000 Unicode code points, no `<`/`>` (already enforced by `sanitizeDescription`).
- **CSP:** no inline `style=`/`<script>` in HTML; visibility via `el.hidden`; styling via `classList`. `render.ts` is pure `state -> DOM`, `app.ts` owns every event listener (delegated on containers).
- **Code style:** Prettier (`singleQuote`, `printWidth: 100`, trailing commas), ESLint flat config. Run `npm run ci` (typecheck + lint + format:check + test) before every commit; it must pass.
- **Commits:** conventional prefix (`feat:`, `fix:`, `test:`, `docs:`), one commit per task, ending with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.

## Design decisions (read before any task)

1. **Issue group key.** `issueGroupOf(activity)` = `''` when the title contains no `#<digits>`; otherwise `${repo}#${n1}#${n2}...` with the numbers deduped and ascending. A title referencing two issues is its own group (`acme/demo#12#34`) rather than being assigned to one of them by guesswork. The same number in two repos is two groups.
2. **Entry key.** `entryKey(date, group)` = `${date}|${group}`. Selection (`checkedKeys`) and manual hour overrides (`entryHours`) are keyed on it. It travels to the apply route and comes back in every `ApplyResult` so results can be matched to rows.
3. **Order within a day.** Groups sorted by the timestamp of their earliest activity (stable sort → ties keep first-appearance order). Days stay date-ascending.
4. **Even split.** `splitSeconds(hoursToSeconds(hoursPerDay), n)`: whole-second shares summing exactly to the day total; the remainder goes one second at a time to the earliest entries.
5. **Manual mode.** `aggregate(activities, settings, overrides)` — `overrides[key]` in hours replaces that entry's share when it is a finite number in `(0, 24]`; anything else is ignored (falls back to the even share), never clamped. The client passes `{}` in even mode and `state.entryHours` in manual mode. Entries with no override keep their even share, so unchecking the option starts from the same numbers.
6. **Layout.** Entries on a day are back-to-back from `startTime`, unchecked ones included (a gap is harmless; redistributing on deselect would make starts unstable).
7. **Overflow past midnight.** A manual total can push a later entry's start onto the next local day, which the apply route rejects. `overflowingDates(entries, timezone)` in `src/plan.ts` finds those days; the client shows an error and disables import while any checked entry overflows. Aggregate stays pure and trusting.
8. **Duplicate rule in the preview: unchanged.** `findDuplicate` matches (local day, project). One existing entry on the day marks every proposed entry on that day a duplicate. This keeps re-runs safe and keeps the README's documented limitation true.
9. **Duplicate rule in the write route.** The batch-level pre-check runs against the list fetched _before_ the batch (day-level, as today). Entries written in the same batch are tracked in a `writtenStarts` set keyed `${projectId}@${start}` instead of being pushed into `existing`, so a sibling on the same day is not mistaken for a duplicate but an exact repeat still is. The post-ambiguous-failure recheck uses `findLanded` (project + exact start instant). `MAX_ENTRIES` rises from 5 to 10 and the client packs whole days per batch (`batchByDay`): a day split across two batches would be skipped by the second batch's fresh pre-check.
10. **Preference.** `prefs.splitEvenly: boolean` (default `true`), persisted like every other pref. The checkbox lives in step 4 above the preview table so toggling it reveals the inputs immediately.
11. **Hours input.** `<input type="number" min="0.25" max="24" step="0.25">` per row in manual mode, wired on `change` (not `input`): the table is rebuilt on every state change, so recomputing on each keystroke would steal focus mid-typing.

## File map

| File                                       | Change                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/hours.ts`                             | **Create.** `splitSeconds`, `hoursToSeconds`, `batchByDay`.                                                       |
| `test/hours.test.ts`                       | **Create.**                                                                                                       |
| `src/types.ts`                             | `ProposedEntry` gains `key`, `group`; `ApplyResult` gains `key`.                                                  |
| `src/describe.ts`                          | Export `issueNumbersIn(title)`; `describeDay` uses it.                                                            |
| `src/aggregate.ts`                         | Export `issueGroupOf`, `groupLabel`, `entryKey`, `HoursOverrides`; group + split + layout.                        |
| `src/plan.ts`                              | Add `findLanded`, `overflowingDates`.                                                                             |
| `src/routes/apply.ts`                      | Validate `key`/`group`; `MAX_ENTRIES = 10`; `writtenStarts`; `findLanded` recheck; `key` in results.              |
| `client/state.ts`                          | `prefs.splitEvenly`; `checkedKeys` (was `checkedDates`); `entryHours`.                                            |
| `client/app.ts`                            | Overrides into `aggregate`; carry-over by key; whole-day batches; new listeners.                                  |
| `client/render.ts`                         | Issue + Hours columns, per-row hours input, split checkbox, totals with overflow error, results with issue label. |
| `public/index.html`                        | Split checkbox, two new columns, `colspan` 9.                                                                     |
| `public/style.css`                         | `.hours-input`, `.totals.is-error`.                                                                               |
| `README.md`                                | Describe per-issue entries + split option; adjust the duplicate paragraph.                                        |
| `tsconfig.client.json`, `vitest.config.ts` | Register `src/hours.ts` / `test/hours.test.ts`.                                                                   |

---

### Task 1: Pure hour-splitting and batching helpers (`src/hours.ts`)

**Files:**

- Create: `src/hours.ts`
- Create: `test/hours.test.ts`
- Modify: `vitest.config.ts` (add `'test/hours.test.ts'` to the `pure` project's `include`)
- Modify: `tsconfig.client.json` (add `"src/hours.ts"` to `include`)

**Interfaces:**

- Produces:
  - `splitSeconds(totalSeconds: number, count: number): number[]`
  - `hoursToSeconds(hours: number): number`
  - `batchByDay<T extends { date: string }>(items: T[], max: number): T[][]`

- [ ] **Step 1: Write the failing tests**

```ts
// test/hours.test.ts
import { describe, expect, it } from 'vitest';
import { batchByDay, hoursToSeconds, splitSeconds } from '../src/hours';

describe('splitSeconds', () => {
  it('1. divides evenly when it can: 8h into 3 is 9600s each', () => {
    expect(splitSeconds(28_800, 3)).toEqual([9600, 9600, 9600]);
  });

  it('2. gives the remainder one second at a time to the earliest shares, summing exactly', () => {
    const shares = splitSeconds(28_800, 7);
    expect(shares).toHaveLength(7);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(28_800);
    // 28800 / 7 = 4114 remainder 2 -> first two get 4115.
    expect(shares).toEqual([4115, 4115, 4114, 4114, 4114, 4114, 4114]);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
  });

  it('3. a single share is the whole total', () => {
    expect(splitSeconds(28_800, 1)).toEqual([28_800]);
  });

  it('4. rejects a non-positive or non-integer count and a negative total', () => {
    expect(() => splitSeconds(3600, 0)).toThrow();
    expect(() => splitSeconds(3600, 1.5)).toThrow();
    expect(() => splitSeconds(-1, 2)).toThrow();
  });
});

describe('hoursToSeconds', () => {
  it('5. converts fractional hours to whole seconds', () => {
    expect(hoursToSeconds(8)).toBe(28_800);
    expect(hoursToSeconds(2.5)).toBe(9000);
    expect(hoursToSeconds(0.25)).toBe(900);
    // Rounds, never truncates: 1/3 h is 1200s exactly, 0.1h is 360s.
    expect(hoursToSeconds(1 / 3)).toBe(1200);
    expect(hoursToSeconds(0.1)).toBe(360);
  });
});

describe('batchByDay', () => {
  const item = (date: string, key: string) => ({ date, key });

  it('6. packs whole days into batches of at most max', () => {
    const items = [
      item('2026-08-03', 'a'),
      item('2026-08-03', 'b'),
      item('2026-08-04', 'c'),
      item('2026-08-04', 'd'),
      item('2026-08-05', 'e'),
    ];
    // Days 04 (2) and 05 (1) fit together under max 3; day 03 + day 04 would be 4.
    expect(batchByDay(items, 3)).toEqual([
      [item('2026-08-03', 'a'), item('2026-08-03', 'b')],
      [item('2026-08-04', 'c'), item('2026-08-04', 'd'), item('2026-08-05', 'e')],
    ]);
  });

  it('7. fills a batch up to exactly max when days fit', () => {
    const items = [
      item('2026-08-03', 'a'),
      item('2026-08-04', 'b'),
      item('2026-08-05', 'c'),
      item('2026-08-06', 'd'),
    ];
    expect(batchByDay(items, 3).map((b) => b.length)).toEqual([3, 1]);
  });

  it('8. a day larger than max is emitted alone, over the cap, never split', () => {
    const items = [
      item('2026-08-03', 'a'),
      item('2026-08-04', 'b'),
      item('2026-08-04', 'c'),
      item('2026-08-04', 'd'),
      item('2026-08-05', 'e'),
    ];
    expect(batchByDay(items, 2)).toEqual([
      [item('2026-08-03', 'a')],
      [item('2026-08-04', 'b'), item('2026-08-04', 'c'), item('2026-08-04', 'd')],
      [item('2026-08-05', 'e')],
    ]);
  });

  it('9. empty input yields no batches', () => {
    expect(batchByDay([], 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Register the test and module, run to verify it fails**

In `vitest.config.ts`, inside the `pure` project's `include` array, add `'test/hours.test.ts'` after `'test/validate.test.ts'`. In `tsconfig.client.json`, add `"src/hours.ts"` to `include` after `"src/validate.ts"`.

Run: `npx vitest run --project pure test/hours.test.ts`
Expected: FAIL — `Cannot find module '../src/hours'`.

- [ ] **Step 3: Implement `src/hours.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests and the full CI check**

Run: `npx vitest run --project pure test/hours.test.ts`
Expected: PASS, 9 tests.

Run: `npm run ci`
Expected: all green (typecheck for both tsconfigs, lint, prettier, all tests).

- [ ] **Step 5: Commit**

```bash
git add src/hours.ts test/hours.test.ts vitest.config.ts tsconfig.client.json
git commit -m "feat: add pure hour-splitting and whole-day batching helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Issue grouping, even split and overrides in `aggregate`

**Files:**

- Modify: `src/types.ts` (`ProposedEntry`, `ApplyResult`)
- Modify: `src/describe.ts` (export `issueNumbersIn`)
- Modify: `src/aggregate.ts`
- Modify: `src/routes/apply.ts:130-210` (`readEntry` — validate and return `key`/`group` so the project typechecks; the route's write semantics are Task 3)
- Modify: `client/app.ts:544-553` (`runImport`'s field mapping — add `key`, `group`)
- Modify: `test/aggregate.test.ts`, `test/describe.test.ts`, `test/plan.test.ts` (fixture gains `key`/`group`), `test/routes-apply.test.ts` (`ENTRY_1`/`ENTRY_2` fixtures gain `key`/`group`)

**Interfaces:**

- Consumes: `splitSeconds`, `hoursToSeconds` from `src/hours.ts` (Task 1).
- Produces:
  - `ProposedEntry` now has `key: string` and `group: string` (both required).
  - `ApplyResult` now has `key: string` (required; the route fills it in Task 3 — until then the type is declared but the route's result objects are updated in Task 3, so in _this_ task add `key` to `ApplyResult` and add `key: entry.key` to every `results.push` in `src/routes/apply.ts` — there are seven — otherwise typecheck fails).
  - `issueNumbersIn(title: string): number[]` from `src/describe.ts`.
  - `issueGroupOf(activity: Activity): string`, `groupLabel(group: string): string`, `entryKey(date: string, group: string): string`, `type HoursOverrides = Record<string, number>` from `src/aggregate.ts`.
  - `aggregate(activities, settings, overrides?: HoursOverrides)`.

- [ ] **Step 1: Write the failing tests**

Append to `describe('describeDay', ...)`'s file `test/describe.test.ts` (new top-level `describe` block, import `issueNumbersIn` alongside the existing imports):

```ts
describe('issueNumbersIn', () => {
  it('returns every #N reference deduped and ascending', () => {
    expect(issueNumbersIn('fix #185 and #9, also #185 again')).toEqual([9, 185]);
  });

  it('returns an empty array when nothing is referenced', () => {
    expect(issueNumbersIn('bump deps')).toEqual([]);
    expect(issueNumbersIn('')).toEqual([]);
  });
});
```

Append to `describe('aggregate', ...)` in `test/aggregate.test.ts` (import `entryKey`, `groupLabel`, `issueGroupOf` from `../src/aggregate` alongside `aggregate`):

```ts
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
  expect(entries[0]?.description).toContain('start on #123');
  expect(entries[0]?.description).toContain('finish #123');
  expect(entries[0]?.description).not.toContain('work on #124');
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project pure test/aggregate.test.ts test/describe.test.ts`
Expected: FAIL — `issueNumbersIn`/`issueGroupOf` not exported; `group`/`key` undefined.

- [ ] **Step 3: Update `src/types.ts`**

Replace the `ProposedEntry` and `ApplyResult` types:

```ts
export type ProposedEntry = {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /**
   * Stable identity within a plan: `${date}|${group}` (see `entryKey` in
   * aggregate.ts). Selection and manual hour overrides are keyed on it, and
   * the apply route echoes it back in every `ApplyResult`.
   */
  key: string;
  /**
   * Issue group: `''` for activities whose titles reference no issue, else
   * `owner/repo#12` — or `owner/repo#12#34` when one title references
   * several issues (that activity is then its own group).
   */
  group: string;
  /** UTC ISO-8601 with `Z`, second precision. */
  start: string;
  end: string;
  description: string;
  billable: boolean;
  projectId: string;
  activityCount: number;
  repos: string[];
};
```

```ts
export type ApplyResult = {
  date: string;
  /** The `ProposedEntry.key` this result is for. */
  key: string;
  ok: boolean;
  entryId?: string;
  /** Set when `ok` is false, or when the write was skipped as a duplicate. */
  error?: string;
  skipped?: boolean;
};
```

- [ ] **Step 4: Export `issueNumbersIn` from `src/describe.ts` and use it in `describeDay`**

Add after the `TYPE_PREFIX` constant:

```ts
/** Every `#123` reference in `title`, deduped and ascending. */
export function issueNumbersIn(title: string): number[] {
  const numbers = new Set<number>();
  for (const match of title.matchAll(ISSUE_REF)) numbers.add(Number(match[1]));
  return [...numbers].sort((a, b) => a - b);
}
```

In `describeDay`, replace

```ts
for (const match of item.title.matchAll(ISSUE_REF)) {
  issueNumbers.add(Number(match[1]));
}
```

with

```ts
for (const n of issueNumbersIn(item.title)) issueNumbers.add(n);
```

- [ ] **Step 5: Rewrite `src/aggregate.ts`**

Replace the whole file with:

```ts
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
```

- [ ] **Step 6: Keep the rest of the project compiling**

In `src/routes/apply.ts`, in `readEntry` right after the `entry.repos` check and before the `return`, add:

```ts
if (typeof e.group !== 'string' || e.group.length > 300) {
  throw new AppError(
    400,
    'invalid_request',
    'entry.group must be a string of at most 300 characters',
  );
}
if (typeof e.key !== 'string' || e.key !== `${e.date}|${e.group}`) {
  throw new AppError(400, 'invalid_request', 'entry.key must equal `${date}|${group}`');
}
```

and add `key: e.key, group: e.group,` to the returned object (after `date: e.date,`). In the same file add `key: entry.key,` to every `results.push({ date: entry.date, ... })` object — there are seven (`skipped`, `created`, recheck-failed, recheck-landed, recheck-not-landed, `AppError`, unexpected).

In `client/app.ts` `runImport`, the `proposed` mapping becomes:

```ts
const proposed: ProposedEntry[] = batch.map((e) => ({
  date: e.date,
  key: e.key,
  group: e.group,
  start: e.start,
  end: e.end,
  description: e.description,
  billable: e.billable,
  projectId: e.projectId,
  activityCount: e.activityCount,
  repos: e.repos,
}));
```

In `test/plan.test.ts`, `proposed()` gains `key: '2026-08-03|acme/demo#1', group: 'acme/demo#1',` (after `date`). In `test/routes-apply.test.ts`, `ENTRY_1` gains `key: '2026-08-01|', group: '',` and `ENTRY_2` gains `key: '2026-08-02|', group: '',` (after `date`); in test 3, the generated entries must also set `key: \`2026-08-${...}|\`` so the 400 comes from the count and not from a key mismatch — rewrite the map callback as:

```ts
      entries: Array.from({ length: 11 }, (_, i) => {
        const date = `2026-08-${String(i + 1).padStart(2, '0')}`;
        return { ...ENTRY_1, date, key: `${date}|` };
      }),
```

(11, not 6: the cap becomes 10 in Task 3. Change the test's title to `'3. entries.length = 11 -> 400 invalid_request, no writes'` now; it passes at 6 or 11 against the current cap of 5, and stays correct after Task 3.) In test 10, the entry overriding `date: '2026-01-01'` must also override `key: '2026-01-01|'` so the rejection it pins is still the date/start mismatch. Expected result objects in tests 1, 2, 4, 11, 12, 14 gain `key: '2026-08-01|'` / `key: '2026-08-02|'`; `expect.objectContaining` assertions need no change.

- [ ] **Step 7: Run everything**

Run: `npm run ci`
Expected: all green. Existing aggregate tests 1–9 must still pass unchanged — a day with no issue references must yield exactly what it did before.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/describe.ts src/aggregate.ts src/routes/apply.ts client/app.ts test/aggregate.test.ts test/describe.test.ts test/plan.test.ts test/routes-apply.test.ts
git commit -m "feat: one entry per issue per day with even hour split and manual overrides

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Write route — same-day siblings are not duplicates

**Files:**

- Modify: `src/plan.ts` (add `findLanded`, `overflowingDates`)
- Modify: `src/routes/apply.ts` (`MAX_ENTRIES`, `writtenStarts`, `recheckLanded`)
- Modify: `test/plan.test.ts`, `test/routes-apply.test.ts`

**Interfaces:**

- Consumes: `ProposedEntry.key`/`group` (Task 2).
- Produces:
  - `findLanded(entry: ProposedEntry, existing: ExistingEntry[]): ExistingEntry | undefined`
  - `overflowingDates(entries: ProposedEntry[], timezone: string): string[]`
  - `/api/apply` accepts up to 10 entries; same-day entries with distinct starts are all written.

- [ ] **Step 1: Write the failing pure tests** (append to `describe('buildPlan', ...)` in `test/plan.test.ts`, importing `findLanded` and `overflowingDates`)

```ts
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
  const edge = proposed({ date: '2026-08-04', key: '2026-08-04|', start: '2026-08-04T22:30:00Z' });
  expect(overflowingDates([edge], 'Europe/Warsaw')).toEqual(['2026-08-04']);
  expect(overflowingDates([edge], 'UTC')).toEqual([]);
});
```

- [ ] **Step 2: Write the failing route tests** (append to `describe('apply route', ...)` in `test/routes-apply.test.ts`)

```ts
it('15. two entries on the same day (one per issue) are both written — the second is not a duplicate of the first', async () => {
  let createCount = 0;
  vi.stubGlobal(
    'fetch',
    routedFetch([
      userHandler(UID),
      emptyListHandler(),
      {
        test: isCreateEntry,
        respond: () => {
          createCount += 1;
          return jsonResponse({ id: `new-${createCount}` });
        },
      },
    ]),
  );
  const first = {
    ...ENTRY_1,
    key: '2026-08-01|acme/repo#1',
    group: 'acme/repo#1',
    start: '2026-08-01T09:00:00Z',
    end: '2026-08-01T13:00:00Z',
  };
  const second = {
    ...ENTRY_1,
    key: '2026-08-01|acme/repo#2',
    group: 'acme/repo#2',
    start: '2026-08-01T13:00:00Z',
    end: '2026-08-01T17:00:00Z',
  };

  const res = await post('/api/apply', { ...VALID_BODY, entries: [first, second] });

  expect(res.status).toBe(200);
  const body = await res.json<{ results: ApplyResult[] }>();
  expect(body.results).toEqual([
    { date: '2026-08-01', key: first.key, ok: true, entryId: 'new-1' },
    { date: '2026-08-01', key: second.key, ok: true, entryId: 'new-2' },
  ]);
  expect(createCount).toBe(2);
});

it('16. an exact repeat within one batch (same project and start) is still skipped after the first write', async () => {
  let createCount = 0;
  vi.stubGlobal(
    'fetch',
    routedFetch([
      userHandler(UID),
      emptyListHandler(),
      {
        test: isCreateEntry,
        respond: () => {
          createCount += 1;
          return jsonResponse({ id: `new-${createCount}` });
        },
      },
    ]),
  );

  const res = await post('/api/apply', { ...VALID_BODY, entries: [ENTRY_1, ENTRY_1] });

  expect(res.status).toBe(200);
  const body = await res.json<{ results: ApplyResult[] }>();
  expect(body.results).toEqual([
    { date: '2026-08-01', key: ENTRY_1.key, ok: true, entryId: 'new-1' },
    { date: '2026-08-01', key: ENTRY_1.key, ok: true, skipped: true, error: 'Already exists' },
  ]);
  expect(createCount).toBe(1);
});

it('17. an existing entry on the day still marks every entry of that day as a duplicate — the day-level rule is unchanged', async () => {
  const fetchMock = routedFetch([
    userHandler(UID),
    existingEntryHandler('2026-08-01T07:00:00Z'),
    { test: isCreateEntry, respond: () => jsonResponse({ id: 'should-not-happen' }) },
  ]);
  vi.stubGlobal('fetch', fetchMock);
  const first = { ...ENTRY_1, key: '2026-08-01|acme/repo#1', group: 'acme/repo#1' };
  const second = {
    ...ENTRY_1,
    key: '2026-08-01|acme/repo#2',
    group: 'acme/repo#2',
    start: '2026-08-01T17:00:00Z',
    end: '2026-08-01T18:00:00Z',
  };

  const res = await post('/api/apply', { ...VALID_BODY, entries: [first, second] });

  expect(res.status).toBe(200);
  const body = await res.json<{ results: ApplyResult[] }>();
  expect(body.results.map((r) => r.skipped)).toEqual([true, true]);
  const postCalls = fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
  );
  expect(postCalls).toHaveLength(0);
});

it("18. the recheck after an ambiguous failure looks for THIS entry's start, not merely any entry on the day", async () => {
  // Entry 1 (09:00) is written fine. Entry 2 (13:00) 500s; the recheck
  // list shows only entry 1 — so entry 2 did NOT land and must be
  // reported as a failure, not as "Already exists".
  let listCalls = 0;
  let createCalls = 0;
  vi.stubGlobal(
    'fetch',
    routedFetch([
      userHandler(UID),
      {
        test: isListEntries,
        respond: () => {
          listCalls += 1;
          if (listCalls === 1) return jsonResponse([], { headers: { 'Last-Page': 'true' } });
          return jsonResponse(
            [
              {
                id: 'new-1',
                timeInterval: { start: '2026-08-01T09:00:00Z', end: '2026-08-01T13:00:00Z' },
                description: 'x',
                projectId: PROJECT_ID,
              },
            ],
            { headers: { 'Last-Page': 'true' } },
          );
        },
      },
      {
        test: isCreateEntry,
        respond: () => {
          createCalls += 1;
          return createCalls === 1 ? jsonResponse({ id: 'new-1' }) : errorResponse(500);
        },
      },
    ]),
  );
  const first = {
    ...ENTRY_1,
    key: '2026-08-01|acme/repo#1',
    group: 'acme/repo#1',
    end: '2026-08-01T13:00:00Z',
  };
  const second = {
    ...ENTRY_1,
    key: '2026-08-01|acme/repo#2',
    group: 'acme/repo#2',
    start: '2026-08-01T13:00:00Z',
    end: '2026-08-01T17:00:00Z',
  };

  const res = await post('/api/apply', { ...VALID_BODY, entries: [first, second] });

  expect(res.status).toBe(200);
  const body = await res.json<{ results: ApplyResult[] }>();
  expect(body.results[0]).toEqual({
    date: '2026-08-01',
    key: first.key,
    ok: true,
    entryId: 'new-1',
  });
  expect(body.results[1]).toEqual(expect.objectContaining({ key: second.key, ok: false }));
  expect(body.results[1]?.skipped).toBeUndefined();
  expect(listCalls).toBe(2);
});

it('19. a key that does not equal `${date}|${group}` is rejected 400 with no fetch', async () => {
  const fetchMock = neverCalledFetch();
  vi.stubGlobal('fetch', fetchMock);

  const res = await post('/api/apply', {
    ...VALID_BODY,
    entries: [{ ...ENTRY_1, key: '2026-08-01|acme/repo#9', group: '' }],
  });

  expect(res.status).toBe(400);
  expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('20. ten entries are accepted (the cap holds a whole day of per-issue entries)', async () => {
  let createCount = 0;
  vi.stubGlobal(
    'fetch',
    routedFetch([
      userHandler(UID),
      emptyListHandler(),
      {
        test: isCreateEntry,
        respond: () => {
          createCount += 1;
          return jsonResponse({ id: `new-${createCount}` });
        },
      },
    ]),
  );
  const entries = Array.from({ length: 10 }, (_, i) => {
    const hh = String(9 + i).padStart(2, '0');
    return {
      ...ENTRY_1,
      key: `2026-08-01|acme/repo#${i + 1}`,
      group: `acme/repo#${i + 1}`,
      start: `2026-08-01T${hh}:00:00Z`,
      end: `2026-08-01T${hh}:30:00Z`,
    };
  });

  const res = await post('/api/apply', { ...VALID_BODY, entries });

  expect(res.status).toBe(200);
  expect(createCount).toBe(10);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/plan.test.ts test/routes-apply.test.ts`
Expected: FAIL — `findLanded`/`overflowingDates` missing; test 15 reports the second entry skipped; test 18 reports `skipped: true`; test 20 gets 400.

- [ ] **Step 4: Add the two helpers to `src/plan.ts`** (after `findDuplicate`)

```ts
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
```

- [ ] **Step 5: Update `src/routes/apply.ts`**

Change the import: `import { findDuplicate, findLanded } from '../plan';`

Replace the `MAX_ENTRIES` constant and its comment:

```ts
/**
 * Rule 1: the client sends batches and shows progress; a killed request can
 * then lose at most this many writes, each individually reported. Ten, not
 * five, because a batch must hold a whole day: the pre-write duplicate
 * check below is day-level against entries fetched before the batch, so a
 * day split across two batches would see its first half as "already
 * exists" — and a day now holds one entry per issue.
 */
const MAX_ENTRIES = 10;
```

In `recheckLanded`, replace `return findDuplicate(entry, fresh, timezone) !== undefined;` with `return findLanded(entry, fresh) !== undefined;` and update its doc comment's last sentence to: `Matches on the exact start instant (findLanded), not the local day: a sibling entry from the same day — possibly written seconds earlier in this very batch — must not vouch for this one.` The `timezone` parameter becomes unused — remove it from the signature and the call site.

In the handler, before the `for (const entry of entries)` loop, add:

```ts
// Entries written in THIS batch, keyed `${projectId}@${start}`. They are
// deliberately not pushed into `existing`: that list drives the day-level
// check, and a day now legitimately holds several entries (one per
// issue), so a sibling written moments ago must not turn the rest of its
// day into duplicates. An exact repeat (same project, same start) is
// still caught here — the belt-and-braces this route keeps against a
// client that sends the same entry twice.
const writtenStarts = new Set<string>();
const startKey = (entry: ProposedEntry) => `${entry.projectId}@${entry.start}`;
```

Replace the duplicate check at the top of the loop with:

```ts
if (findDuplicate(entry, existing, timezone) || writtenStarts.has(startKey(entry))) {
  results.push({
    date: entry.date,
    key: entry.key,
    ok: true,
    skipped: true,
    error: 'Already exists',
  });
  continue;
}
```

Replace the `existing.push({...})` block (and its comment) after `createEntry` with:

```ts
writtenStarts.add(startKey(entry));
```

In the `recheck.landed` branch, add `writtenStarts.add(startKey(entry));` before its `results.push`.

- [ ] **Step 6: Run everything**

Run: `npm run ci`
Expected: all green, including the pre-existing route tests 1–14 (test 12's recheck entry starts at `ENTRY_1.start`, so `findLanded` still finds it).

- [ ] **Step 7: Commit**

```bash
git add src/plan.ts src/routes/apply.ts test/plan.test.ts test/routes-apply.test.ts
git commit -m "fix: apply route treats same-day per-issue entries as siblings, not duplicates

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Client state, markup and wiring (split option, per-entry selection, manual hours)

**Files:**

- Modify: `client/state.ts`
- Modify: `public/index.html:395-421`
- Modify: `client/app.ts`
- Modify: `client/render.ts` (rename only — `checkedDates` → `checkedKeys`, `data-dateCheckbox` → `data-keyCheckbox`; the visual changes are Task 5)

**Interfaces:**

- Consumes: `aggregate(activities, settings, overrides)`, `HoursOverrides` (Task 2); `batchByDay` (Task 1).
- Produces (read by Task 5's render):
  - `State['prefs']['splitEvenly']: boolean`
  - `State['checkedKeys']: Set<string>`
  - `State['entryHours']: Record<string, number>`
  - DOM ids: `#split-evenly` (checkbox), `#preview-rows` rows with `input[data-key-checkbox]` and `input[data-hours-key]`.

- [ ] **Step 1: State**

In `client/state.ts`:

- Add `splitEvenly: boolean;` to `Prefs` after `includeWeekends`, and `splitEvenly: true,` to `defaultPrefs()`.
- Replace `checkedDates: Set<string>;` in `State` with:

```ts
/** `ProposedEntry.key`s selected for import. */
checkedKeys: Set<string>;
/**
 * Manual hours per entry key — used only while `prefs.splitEvenly` is
 * false. Keys that no longer exist in the plan are dropped on recompute;
 * an entry with no override keeps its even share. Cleared with the scan.
 */
entryHours: Record<string, number>;
```

- In `createInitialState()`, replace `checkedDates: new Set(),` with `checkedKeys: new Set(), entryHours: {},`.

- [ ] **Step 2: Markup**

In `public/index.html`, immediately before `<div id="preview-table-wrap" ...>`, insert:

```html
<div class="field field-checkbox">
  <input type="checkbox" id="split-evenly" name="split-evenly" checked />
  <label for="split-evenly">Split each day's hours evenly across its entries</label>
  <p class="field-hint">
    Each GitHub issue gets its own entry. Uncheck to set the hours of every entry by hand.
  </p>
</div>
```

Change the table caption to `One row per issue per day`. Replace the `<thead>` row with:

```html
<tr>
  <th scope="col">
    <input type="checkbox" id="preview-select-all" aria-label="Select all entries" />
  </th>
  <th scope="col">Date</th>
  <th scope="col">Day</th>
  <th scope="col">Issue</th>
  <th scope="col">Activity</th>
  <th scope="col">Repositories</th>
  <th scope="col">Description</th>
  <th scope="col">Hours</th>
  <th scope="col">Status</th>
</tr>
```

Change the placeholder row's `colspan="7"` to `colspan="9"`, and the totals placeholder text to `0 of 0 entries selected &mdash; 0.00 hours`.

- [ ] **Step 3: `client/render.ts` rename (mechanical, keep it compiling)**

Replace every `state.checkedDates` with `state.checkedKeys`, `checkbox.dataset.dateCheckbox = entry.date` with `checkbox.dataset.keyCheckbox = entry.key`, `checkedKeys.has(entry.date)` with `checkedKeys.has(entry.key)` (three places: the row checkbox, `selectedCount`, `selectedHours`), and `td.colSpan = 7` with `td.colSpan = 9`. Set the row checkbox's `aria-label` to `` `Include ${entry.date} ${groupLabel(entry.group)}` `` (import `groupLabel` from `'../src/aggregate'`). Nothing else in render.ts changes in this task.

- [ ] **Step 4: `client/app.ts` — recompute with overrides, carry-over by key, whole-day batches, listeners**

Imports: add `import { batchByDay } from '../src/hours';`, `import { overflowingDates } from '../src/plan';` (next to `buildPlan`), and `import { aggregate } from '../src/aggregate';` stays.

Replace the `APPLY_CHUNK` constant comment/value with:

```ts
/** Matches the server's `MAX_ENTRIES` (src/routes/apply.ts). Batches are
 *  packed by whole days (`batchByDay`): the server's pre-write duplicate
 *  check is day-level, so a day split across two batches would have its
 *  second half skipped as "already exists". */
const APPLY_CHUNK = 10;
```

Rewrite `recomputePlan`:

```ts
function recomputePlan(): void {
  store.update((s) => {
    if (
      s.scan.activities.length === 0 &&
      s.scan.status !== 'done' &&
      s.scan.status !== 'cancelled'
    ) {
      s.plan = null;
      return;
    }
    const settings = buildSettings(s);
    // Overrides only count in manual mode; in even mode the plan is fully
    // determined by the settings, and the stored overrides wait untouched
    // for the next time the user unchecks the option.
    const overrides = s.prefs.splitEvenly ? {} : s.entryHours;
    const { entries, skipped } = aggregate(s.scan.activities, settings, overrides);
    const previousPlan = s.plan;
    const plan = buildPlan(entries, s.existingEntries, {
      timezone: settings.timezone,
      skipped,
      warnings: s.scan.warnings,
    });

    const nextChecked = new Set<string>();
    const liveKeys = new Set<string>();
    for (const entry of plan.entries) {
      liveKeys.add(entry.key);
      const previousEntry = previousPlan?.entries.find((e) => e.key === entry.key);
      if (previousEntry && previousEntry.status === entry.status && s.checkedKeys.has(entry.key)) {
        nextChecked.add(entry.key);
      } else if (!previousEntry && entry.status === 'new') {
        nextChecked.add(entry.key);
      }
    }

    // Drop overrides for entries that no longer exist (e.g. a timezone
    // change moved an activity to another day).
    const nextHours: Record<string, number> = {};
    for (const [key, hours] of Object.entries(s.entryHours)) {
      if (liveKeys.has(key)) nextHours[key] = hours;
    }

    s.plan = plan;
    s.checkedKeys = nextChecked;
    s.entryHours = nextHours;
  });
}
```

In `invalidateScan`, replace `s.checkedDates = new Set();` with `s.checkedKeys = new Set(); s.entryHours = {};`.

In `runImport`:

- `const checked = s0.plan.entries.filter((e) => s0.checkedKeys.has(e.key));`
- Refuse to send overflowing days — after the `checked.length === 0` guard add:

```ts
// Mirrors the apply route's own rejection (entry.date must be the local
// day of entry.start); render.ts already disables the button in this
// state, this is the belt to that brace.
if (overflowingDates(checked, s0.prefs.timezone).length > 0) return;
```

- `const batches = batchByDay(checked, APPLY_CHUNK);`
- In the `catch` fallback that fabricates per-entry failures, include the key: `...batch.map((e) => ({ date: e.date, key: e.key, ok: false, error: message }))`.

In `wirePreviewStep`:

- Select-all: `s.checkedKeys = checked ? new Set(s.plan.entries.map((entry) => entry.key)) : new Set();`
- Row checkbox: read `target.dataset.keyCheckbox`, mutate `s.checkedKeys` (same shape as before, keyed on `key`).
- Add the split checkbox listener:

```ts
qs<HTMLInputElement>('split-evenly').addEventListener('change', (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  store.update((s) => {
    s.prefs.splitEvenly = checked;
  });
  savePrefs(store.getState().prefs);
  recomputePlan();
});
```

- Add the manual-hours listener, delegated on the rows container. `change`, not `input` — the table is rebuilt on every render, so recomputing per keystroke would steal focus mid-typing:

```ts
qs('preview-rows').addEventListener('change', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement) || !target.dataset.hoursKey) return;
  const key = target.dataset.hoursKey;
  const raw = Number(target.value);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 24) {
    // Invalid input: re-render restores the last good value.
    store.update(() => {});
    return;
  }
  store.update((s) => {
    s.entryHours = { ...s.entryHours, [key]: raw };
  });
  recomputePlan();
});
```

(This can be the same listener as the checkbox one — branch on `dataset.keyCheckbox` vs `dataset.hoursKey` — or a second `addEventListener('change', ...)` on the same element; either is fine.)

In `initFormFromState()`, add `qs<HTMLInputElement>('split-evenly').checked = s.prefs.splitEvenly;`.

- [ ] **Step 5: Typecheck, lint, build**

Run: `npm run ci && npm run build:client`
Expected: all green; `public/app.js` rebuilt.

- [ ] **Step 6: Commit** (include `public/app.js` — it is committed in this repo)

```bash
git add client/state.ts client/app.ts client/render.ts public/index.html public/app.js
git commit -m "feat: per-entry selection, split-evenly preference and manual hour overrides in the client

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Preview rendering — issue column, hours column with inputs, totals

**Files:**

- Modify: `client/render.ts` (`renderPreviewTable`, `renderImportResults`)
- Modify: `public/style.css`

**Interfaces:**

- Consumes: `State.checkedKeys`, `State.entryHours`, `State.prefs.splitEvenly`, `#split-evenly` (Task 4); `groupLabel` (Task 2); `overflowingDates` (Task 3).

- [ ] **Step 1: CSS** — append to `public/style.css` after the `.totals` rule:

```css
.totals.is-error {
  color: var(--color-danger);
}

.hours-input {
  width: 5.5rem;
  padding: 0.25rem 0.4rem;
  font-size: 0.9rem;
}

td.hours-cell {
  white-space: nowrap;
  text-align: right;
}
```

(`--color-danger` already exists — it is used by `.status-pill.status-error`.)

- [ ] **Step 2: `renderPreviewTable`** — replace the per-row body and the totals block. Import `overflowingDates` from `'../src/plan'` and keep `groupLabel` from `'../src/aggregate'`. Add a module-level helper:

```ts
function hoursOf(entry: PlannedEntry): number {
  return (Date.parse(entry.end) - Date.parse(entry.start)) / 3_600_000;
}
```

Inside the `for (const entry of plan.entries)` loop, after the `dayTd` and before the `activityTd`, insert the issue cell:

```ts
const issueTd = document.createElement('td');
issueTd.textContent = groupLabel(entry.group);
tr.appendChild(issueTd);
```

After the `descTd` and before the `statusTd`, insert the hours cell:

```ts
const hoursTd = document.createElement('td');
hoursTd.className = 'hours-cell';
if (state.prefs.splitEvenly) {
  hoursTd.textContent = hoursOf(entry).toFixed(2);
} else {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'hours-input';
  input.min = '0.25';
  input.max = '24';
  input.step = '0.25';
  input.value = hoursOf(entry).toFixed(2);
  input.dataset.hoursKey = entry.key;
  input.setAttribute('aria-label', `Hours for ${entry.date} ${groupLabel(entry.group)}`);
  hoursTd.appendChild(input);
}
tr.appendChild(hoursTd);
```

Replace the totals computation and text with:

```ts
const selected = plan.entries.filter((e) => state.checkedKeys.has(e.key));
const selectedCount = selected.length;
const selectedHours = selected.reduce((sum, e) => sum + hoursOf(e), 0);
const overflow = overflowingDates(selected, state.prefs.timezone);
if (overflow.length > 0) {
  totals.classList.add('is-error');
  totals.textContent = `Entries on ${overflow.join(', ')} run past midnight — reduce their hours before importing.`;
} else {
  totals.classList.remove('is-error');
  totals.textContent = `${selectedCount} of ${plan.entries.length} entries selected — ${selectedHours.toFixed(2)} hours`;
}
```

And in the import button branch: `importBtn.disabled = selectedCount === 0 || overflow.length > 0;`.

Also in this function, keep `(el('split-evenly') as HTMLInputElement).checked = state.prefs.splitEvenly;` near the top (after the `plan` null-check returns) so the checkbox reflects state on every render.

- [ ] **Step 3: `renderImportResults`** — show which entry a result is for. Replace `li.appendChild(document.createTextNode(\` ${result.date}\`));` with:

```ts
const entry = state.plan?.entries.find((e) => e.key === result.key);
const label = entry ? `${result.date} · ${groupLabel(entry.group)}` : result.date;
li.appendChild(document.createTextNode(` ${label}`));
```

- [ ] **Step 4: Build and run CI**

Run: `npm run ci && npm run build:client`
Expected: all green.

- [ ] **Step 5: Manual smoke check in the browser** (`npm run dev`, then open the printed URL). Verify, and record the outcome in the commit message body:
  1. Step 4 shows the "Split each day's hours evenly" checkbox checked; a day with commits for two issues renders two rows with an `#N` Issue cell and hours summing to hours-per-day.
  2. Unchecking it turns the Hours cells into number inputs; editing one and tabbing out updates that row's hours and the totals line; the other rows keep their values.
  3. Entering a total that runs past midnight turns the totals line red and disables Import.
  4. Re-checking the option restores the even split.

If `npm run dev` cannot run in the environment (no wrangler login is needed for local dev; if it still fails, note why), state that in the commit body instead of claiming it was checked.

- [ ] **Step 6: Commit**

```bash
git add client/render.ts public/style.css public/app.js
git commit -m "feat: preview shows one row per issue with an editable hours column and a live total

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: README

**Files:**

- Modify: `README.md` (intro paragraph, "Three honest limitations" duplicate paragraph, "Architecture, briefly")

- [ ] **Step 1: Intro** — in the first paragraph, after "You pick a date range and a scope, preview exactly what will be written (including what already exists, so re-running a range is safe), and import." add:

```markdown
Each GitHub issue you touched on a day becomes its own entry (commits that
reference no issue share one "Other" entry), and the day's hours are split
evenly across them — or, if you untick that option, typed in per entry with
a running total before you import.
```

- [ ] **Step 2: Limitations** — in the paragraph starting `**A day imported from a partial (cancelled) scan can never be corrected by re-scanning.**`, replace "once a day has a matching Clockify entry, every later scan sees that day as already imported and skips it" with "once a day has a matching Clockify entry, every later scan sees that whole day — every issue's entry on it — as already imported and skips it". Add, as a new sentence at the end of that paragraph: `The same rule means a day imported with one issue's entry cannot later gain a second issue's entry by re-scanning; add it in Clockify by hand.`

- [ ] **Step 3: Architecture** — in the "Architecture, briefly" section, where aggregation is described (the paragraph beginning "The browser is the orchestrator. All aggregation logic — bucketing"), extend the list of what the shared pure code does with "grouping a day's activity by referenced issue and splitting the hours across those groups (`src/aggregate.ts`, `src/hours.ts`)".

- [ ] **Step 4: Format check and commit**

Run: `npm run format:check` (Prettier also checks Markdown here). Expected: clean; run `npx prettier --write README.md` if not.

```bash
git add README.md
git commit -m "docs: describe per-issue entries and the even/manual hour split

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** (1) one entry per issue per day → Task 2 (`issueGroupOf`, grouping in `aggregate`), Task 3 (write route accepts same-day siblings), Task 5 (Issue column). (2) even split, on by default → Task 1 (`splitSeconds`), Task 2 (rule 5), Task 4 (`prefs.splitEvenly = true`, checkbox). (3) manual hours per entry with a total → Task 2 (`overrides`), Task 4 (`entryHours`, `change` listener), Task 5 (inputs, totals line, overflow guard).

**Type consistency.** `ProposedEntry.key`/`group` (Task 2) are read by `findLanded`/`overflowingDates` (Task 3), `checkedKeys`/`entryHours` (Task 4), `groupLabel(entry.group)` (Task 5). `ApplyResult.key` is written by the route (Task 2 step 6, Task 3) and read by `renderImportResults` (Task 5). `aggregate(activities, settings, overrides)` — third parameter is `HoursOverrides = Record<string, number>` in both Task 2 and Task 4. `batchByDay<T extends { date: string }>` (Task 1) is called with `PlannedEntry[]` (Task 4), which has `date`. `MAX_ENTRIES = 10` (Task 3) equals `APPLY_CHUNK = 10` (Task 4). `data-hours-key` / `dataset.hoursKey` and `data-key-checkbox` / `dataset.keyCheckbox` match between Tasks 4 and 5.
