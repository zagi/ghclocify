# Unlimited Per-Day Import, Time Estimate and UI Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the "at most 10 entries per day" import cap by letting a day span several apply batches safely, tell the user how long an import will take (and warn on Clockify Free), make manual-hours mode visibly different, and polish the client with Lucide icons, toasts, browser notifications and CSS animations.

**Architecture:** The apply route learns to tell the tool's own entries from foreign ones: each batch carries `dayStarts` — for every day in the batch, the start instants of all entries the plan holds for that day. An existing Clockify entry on (day, project) whose start is in that list is "ours" and only blocks its own exact start; any other existing entry still blocks the whole day. That keeps re-runs and stale previews safe while letting a 40-entry day flow through four batches of 10. Everything else is client-only: a pure `estimateImport` helper feeds the totals line; `client/icons.ts`, `client/toast.ts` and `client/notify.ts` are small modules with one job each; animations are CSS behind the existing `prefers-reduced-motion` rule.

**Tech Stack:** TypeScript 6, Hono 4, Cloudflare Workers, esbuild client bundle (CSP `script-src 'self'; style-src 'self'` — no CDNs, no inline style/script), `lucide` npm package (SVG icon nodes, tree-shaken), vitest 4, ESLint 10 + Prettier.

**Spec:** The user's requests of 2026-09-04, approved in chat:

1. "Should inform how long it will take and should allow to import as many rows as selected, but warn that it will take time; split into batches so we don't eat the API limit per row." Clockify Free: warning only, no automatic hour-long pacing.
2. Unchecking "Split each day's hours evenly" looked like it did nothing on a 40-entry day (the cap error masked it, and 0.20 h looked the same as text and as an input): manual mode must be visibly different, and the number rendering must not flip between `0.20` and `0,20`.
3. Lucide icons in the UI.
4. Toasts.
5. Browser notifications when a scan or import finishes.
6. Tasteful animations.

## Global Constraints

- **CSP** (`public/_headers`): `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:`. No CDN scripts, no inline `<script>`, no `style=""` attributes. Runtime `element.style.setProperty(...)` (CSSOM) is allowed and already used for the progress bar. All CSS goes in `public/style.css`.
- **Client-safe pure modules** (`src/aggregate.ts`, `src/plan.ts`, `src/describe.ts`, `src/types.ts`, `src/timezone.ts`, `src/validate.ts`, `src/hours.ts`): no runtime imports outside this set; registered in `tsconfig.client.json` and in `vitest.config.ts`'s `pure` project.
- **Never double-book hours.** `createEntry` keeps `retries: 0`; ambiguous failures are rechecked (`findLanded`), never retried. A foreign existing entry on (day, project) blocks the whole day exactly as before.
- **`entry.date === localDayOf(entry.start, timezone)`** stays enforced in the route and mirrored in the client (`overflowingDates`).
- **`render.ts` is pure state→DOM**; `app.ts` owns every listener and every side effect (toasts, notifications included: `render.ts` never calls them).
- **`public/app.js` is gitignored** and rebuilt at deploy; never commit it. `npm run build:client` is verification only.
- **Prettier** (`singleQuote`, `printWidth: 100`, trailing commas) also checks Markdown (`proseWrap: preserve` — wrap prose by hand at ~76 cols). `npm run ci` must be green before every commit.
- **Commits:** conventional prefix, one per task, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Server cap `MAX_ENTRIES = 10` and client `APPLY_CHUNK = 10` stay equal.** Inter-batch pause stays 2 s.
- Existing route tests 1–20, pure tests and the no-issue-reference "byte-identical output" behaviour must keep passing.

## Design decisions

1. **`dayStarts` contract.** Apply body gains `dayStarts: Record<string, string[]>` — key `YYYY-MM-DD`, value: every planned entry start (`yyyy-MM-ddThh:mm:ssZ`) for that local day, from the whole plan (checked or not). Route validation: each key is a date key, each value an array of ≤ 500 ISO instants whose `localDayOf` equals the key; total instants ≤ 5000; every entry in the batch must have `entry.date` present in `dayStarts` and `entry.start` included in its list, else 400. Missing `dayStarts` → 400 (the shipped client always sends it).
2. **Per-entry decision in the route** (`decideWrite` in `src/plan.ts`, pure, tested): `existingOnDay` = existing entries with `projectId === entry.projectId` and `localDayOf(start) === entry.date`. If any of them has a start instant NOT in the day's planned starts → `{ action: 'skip', reason: 'foreign' }` (whole day already has a non-plan entry). Else if any has start instant `=== entry.start` → `{ action: 'skip', reason: 'exists' }`. Else `{ action: 'write' }`. Both skips report `ok: true, skipped: true, error: 'Already exists'` exactly as today (the wire contract for results is unchanged). `writtenStarts` and `findLanded` stay.
3. **Client batching** goes back to plain `chunksOf(checked, APPLY_CHUNK)` — a day may span batches. `batchByDay` is deleted from `src/hours.ts` with its tests. The per-day-cap guards (render + `runImport` + `MAX_ENTRIES_PER_DAY`) are deleted.
4. **Estimate.** `estimateImport(count, batchSize)` in `src/hours.ts` → `{ batches, seconds }` with `seconds = count * 0.5 + (batches - 1) * 2` (0.5 s per Clockify POST, 2 s pause between batches). Free tier: `freeTierHours(count)` → `Math.ceil((count + batches) / 28)` hours, 28 = 30/hour minus a margin for the pre-check GETs. Totals line: `N of M entries selected — H hours · ~T` where T is `formatDuration(seconds)` (`12 s`, `1 min 20 s`). For a `freeTier` workspace a second line (class `totals-warning`) says: `Free Clockify plan: 30 API requests per hour. This import needs about K hour(s) and will start failing with 429 after ~28 entries — uncheck rows or import in stages.` Import stays enabled.
5. **Manual mode affordance.** Hours cell input becomes `type="text" inputmode="decimal"` (accepts `1.5` and `1,5`; parsed with `replace(',', '.')`), so the rendered glyph matches the text mode's `toFixed(2)`. The hint under the checkbox switches text by mode; the `<tbody>` gets class `is-manual`, which styles the inputs with a visible border and a light background; the totals line in manual mode is prefixed `Manual hours — `.
6. **Icons.** `client/icons.ts` wraps `lucide`'s `createElement(iconNode, attrs)`; exports `icon(name: IconName, opts?)`. Static icons (stepper, nav buttons) are inserted once at startup by `renderStaticIcons()` in `render.ts`, called from `init()` in `app.ts`; dynamic ones (status pills, toasts, import button label) are created in the render functions. Every icon SVG gets `aria-hidden="true"` and `class="icon"`; buttons keep their text (icon + text span), so `textContent` assignments on buttons are replaced by a `setButtonLabel(btn, iconName, text)` helper.
7. **Toasts.** `client/toast.ts`: `createToaster(host: HTMLElement)` → `{ push(toast: ToastInput): void }`. Kinds `info | success | warning | error`; auto-dismiss 5 s except `error` (sticky until closed); max 4 visible (oldest dropped); close button; host has `aria-live="polite"`, errors also set `role="alert"`. `app.ts` owns one toaster and pushes on: verify ok/failed (per service), repos/projects load failed, scan complete/cancelled/failed, duplicate-check failure, import finished (imported/skipped/failed counts), batch request failure, notification permission denied.
8. **Notifications.** Pref `notifyWhenDone: boolean` (default `false`), checkbox in step 4 next to the split checkbox, hidden when `'Notification' in window` is false. Checking requests permission; if the result is not `granted`, the pref is reset to false and a toast explains. `client/notify.ts`: `notificationsSupported()`, `requestNotifyPermission(): Promise<boolean>`, `notifyIfHidden(title, body)` — fires only when `document.hidden` and permission is `granted`; click focuses the window. Called from `app.ts` after scan complete/cancelled/failed and import finished.
9. **Animations** (CSS only, all inside the existing reduced-motion contract): `.panel` enter (`panel-in`: fade + translateY 8px→0, 220 ms) triggered by toggling class `is-entering` in `renderStepper` when the step changes; table rows `row-in` with `animation-delay: calc(var(--i) * 25ms)` where `--i` is set via `tr.style.setProperty('--i', String(Math.min(index, 20)))`; progress bar `.progress.is-running .progress-fill::after` shimmer; toast `toast-in`/`toast-out`; `.status-pill.is-fresh` pop for import results appended in the last render; button `transform: translateY(1px)` on `:active`, `transition: background-color, box-shadow 150 ms`.

## File map

| File                                                                   | Change                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/plan.ts`                                                          | Add `decideWrite`.                                                                          |
| `src/routes/apply.ts`                                                  | Read/validate `dayStarts`; use `decideWrite`.                                               |
| `src/hours.ts`                                                         | Remove `batchByDay`; add `estimateImport`, `freeTierHours`, `formatDuration`.               |
| `test/plan.test.ts`, `test/routes-apply.test.ts`, `test/hours.test.ts` | Update/add.                                                                                 |
| `client/api.ts`                                                        | `apply` body gains `dayStarts`.                                                             |
| `client/app.ts`                                                        | Batching, `dayStarts`, estimate wiring, toasts, notifications, static icons, hours parsing. |
| `client/render.ts`                                                     | Remove cap guard; estimate + free-tier line; manual affordance; icons; animation hooks.     |
| `client/state.ts`                                                      | `prefs.notifyWhenDone`.                                                                     |
| `client/icons.ts`, `client/toast.ts`, `client/notify.ts`               | **Create.**                                                                                 |
| `public/index.html`                                                    | Toast host, notify checkbox, hint ids, icon slots.                                          |
| `public/style.css`                                                     | Manual-mode styles, totals warning, icons, toasts, animations.                              |
| `package.json`                                                         | dependency `lucide`.                                                                        |
| `README.md`                                                            | Limitations: remove 10/day cap; describe estimate + Free warning; notifications.            |

---

### Task 1: Route — `dayStarts` lets a day span batches

**Files:**

- Modify: `src/plan.ts` (add `decideWrite`)
- Modify: `src/routes/apply.ts`
- Modify: `test/plan.test.ts`, `test/routes-apply.test.ts`

**Interfaces:**

- Produces: `decideWrite(entry: ProposedEntry, existing: ExistingEntry[], timezone: string, plannedStarts: readonly string[]): { action: 'write' } | { action: 'skip'; reason: 'foreign' | 'exists'; existing: ExistingEntry }`
- Wire: POST `/api/apply` body gains required `dayStarts: Record<string, string[]>` (decision 1).

- [ ] **Step 1: Pure tests** — append to `describe('buildPlan', …)` in `test/plan.test.ts` (import `decideWrite`):

```ts
it('15. decideWrite: no existing entries on the day -> write', () => {
  const entry = proposed({ start: '2026-08-03T09:00:00Z', end: '2026-08-03T13:00:00Z' });
  expect(decideWrite(entry, [], 'UTC', ['2026-08-03T09:00:00Z', '2026-08-03T13:00:00Z'])).toEqual({
    action: 'write',
  });
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
  const firstLanded = existing({ id: 'ours', start: '2026-08-03T09:00:00Z' });
  expect(decideWrite(first, [firstLanded], 'UTC', planned)).toEqual({
    action: 'skip',
    reason: 'exists',
    existing: firstLanded,
  });
  expect(decideWrite(second, [firstLanded], 'UTC', planned)).toEqual({ action: 'write' });
  // Millisecond formatting differences do not matter: instants compare.
  const ms = existing({ id: 'ms', start: '2026-08-03T09:00:00.000Z' });
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
  expect(decideWrite(entry, [late], 'Europe/Warsaw', ['2026-08-03T07:00:00Z']).action).toBe('skip');
  expect(decideWrite(entry, [late], 'UTC', ['2026-08-03T07:00:00Z'])).toEqual({ action: 'write' });
});
```

- [ ] **Step 2: Route tests.** In `test/routes-apply.test.ts` add to `VALID_BODY`:

```ts
  dayStarts: {
    '2026-08-01': ['2026-08-01T09:00:00Z'],
    '2026-08-02': ['2026-08-02T09:00:00Z'],
  },
```

Go through every existing test that posts a body with custom `entries` and give it a matching `dayStarts` (the entries' dates → their starts). Concretely: test 3 (11 entries → build `dayStarts` from the generated entries), test 9/10 (mismatch tests: `dayStarts` must list the _claimed_ date with the sent start — the 400 must still come from the date/start mismatch; put `dayStarts: { '2026-01-01': ['2026-08-03T09:00:00Z'] }` in test 10 and check it still 400s with no fetch), tests 15–20 (per their entries). Then append:

```ts
it('21. a day split across two requests: the second request writes the remaining entries instead of skipping the day', async () => {
  // Request 1 wrote entry A (09:00). Request 2 carries entry B (13:00) and
  // dayStarts listing both; the pre-check sees A and must treat it as ours.
  let createCount = 0;
  vi.stubGlobal(
    'fetch',
    routedFetch([
      userHandler(UID),
      existingEntryHandler('2026-08-01T09:00:00Z'),
      {
        test: isCreateEntry,
        respond: () => {
          createCount += 1;
          return jsonResponse({ id: `new-${createCount}` });
        },
      },
    ]),
  );
  const second = {
    ...ENTRY_1,
    key: '2026-08-01|acme/repo#2',
    group: 'acme/repo#2',
    start: '2026-08-01T13:00:00Z',
    end: '2026-08-01T17:00:00Z',
  };

  const res = await post('/api/apply', {
    ...VALID_BODY,
    entries: [second],
    dayStarts: { '2026-08-01': ['2026-08-01T09:00:00Z', '2026-08-01T13:00:00Z'] },
  });

  expect(res.status).toBe(200);
  const body = await res.json<{ results: ApplyResult[] }>();
  expect(body.results).toEqual([
    { date: '2026-08-01', key: second.key, ok: true, entryId: 'new-1' },
  ]);
  expect(createCount).toBe(1);
});

it('22. a foreign existing entry (start not in dayStarts) still blocks every entry of that day', async () => {
  const fetchMock = routedFetch([
    userHandler(UID),
    existingEntryHandler('2026-08-01T07:30:00Z'),
    { test: isCreateEntry, respond: () => jsonResponse({ id: 'should-not-happen' }) },
  ]);
  vi.stubGlobal('fetch', fetchMock);
  const second = {
    ...ENTRY_1,
    key: '2026-08-01|acme/repo#2',
    group: 'acme/repo#2',
    start: '2026-08-01T13:00:00Z',
    end: '2026-08-01T17:00:00Z',
  };

  const res = await post('/api/apply', {
    ...VALID_BODY,
    entries: [ENTRY_1, second],
    dayStarts: { '2026-08-01': ['2026-08-01T09:00:00Z', '2026-08-01T13:00:00Z'] },
  });

  expect(res.status).toBe(200);
  const body = await res.json<{ results: ApplyResult[] }>();
  expect(body.results.map((r) => r.skipped)).toEqual([true, true]);
  const postCalls = fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
  );
  expect(postCalls).toHaveLength(0);
});

it('23. re-running an identical import skips every entry individually as Already exists', async () => {
  vi.stubGlobal(
    'fetch',
    routedFetch([
      userHandler(UID),
      {
        test: isListEntries,
        respond: () =>
          jsonResponse(
            [
              {
                id: 'e1',
                timeInterval: { start: '2026-08-01T09:00:00Z', end: '2026-08-01T13:00:00Z' },
                description: 'a',
                projectId: PROJECT_ID,
              },
              {
                id: 'e2',
                timeInterval: { start: '2026-08-01T13:00:00Z', end: '2026-08-01T17:00:00Z' },
                description: 'b',
                projectId: PROJECT_ID,
              },
            ],
            { headers: { 'Last-Page': 'true' } },
          ),
      },
      { test: isCreateEntry, respond: () => jsonResponse({ id: 'should-not-happen' }) },
    ]),
  );
  const first = { ...ENTRY_1, end: '2026-08-01T13:00:00Z' };
  const second = {
    ...ENTRY_1,
    key: '2026-08-01|acme/repo#2',
    group: 'acme/repo#2',
    start: '2026-08-01T13:00:00Z',
    end: '2026-08-01T17:00:00Z',
  };

  const res = await post('/api/apply', {
    ...VALID_BODY,
    entries: [first, second],
    dayStarts: { '2026-08-01': ['2026-08-01T09:00:00Z', '2026-08-01T13:00:00Z'] },
  });

  expect(res.status).toBe(200);
  const body = await res.json<{ results: ApplyResult[] }>();
  expect(body.results).toEqual([
    { date: '2026-08-01', key: first.key, ok: true, skipped: true, error: 'Already exists' },
    { date: '2026-08-01', key: second.key, ok: true, skipped: true, error: 'Already exists' },
  ]);
});

it('24. dayStarts is required, must cover every entry, and its instants must fall on their key day — each violation is a 400 with no fetch', async () => {
  const fetchMock = neverCalledFetch();
  vi.stubGlobal('fetch', fetchMock);

  const { dayStarts: _omit, ...withoutDayStarts } = VALID_BODY;
  void _omit;
  expect((await post('/api/apply', withoutDayStarts)).status).toBe(400);

  // Entry's own start missing from its day's list.
  expect(
    (
      await post('/api/apply', {
        ...VALID_BODY,
        entries: [ENTRY_1],
        dayStarts: { '2026-08-01': ['2026-08-01T13:00:00Z'] },
      })
    ).status,
  ).toBe(400);

  // An instant listed under the wrong day.
  expect(
    (
      await post('/api/apply', {
        ...VALID_BODY,
        entries: [ENTRY_1],
        dayStarts: { '2026-08-01': ['2026-08-01T09:00:00Z', '2026-08-02T09:00:00Z'] },
      })
    ).status,
  ).toBe(400);

  // Malformed instant.
  expect(
    (
      await post('/api/apply', {
        ...VALID_BODY,
        entries: [ENTRY_1],
        dayStarts: { '2026-08-01': ['2026-08-01T09:00:00Z', 'yesterday'] },
      })
    ).status,
  ).toBe(400);

  expect(fetchMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run to verify failures**

Run: `npx vitest run test/plan.test.ts test/routes-apply.test.ts`
Expected: FAIL — `decideWrite` missing; tests 21, 23, 24 fail against the current day-level behaviour.

- [ ] **Step 4: `decideWrite` in `src/plan.ts`** (after `findLanded`):

```ts
export type WriteDecision =
  { action: 'write' } | { action: 'skip'; reason: 'foreign' | 'exists'; existing: ExistingEntry };

/**
 * The write route's pre-write check for one entry, given every start
 * instant the plan holds for that entry's day (`plannedStarts`).
 *
 * Existing entries on the same local day and project are either OURS — their
 * start is one of the planned starts, i.e. written by an earlier batch of
 * this import or by an identical earlier run — or FOREIGN: anything else
 * (a hand-made entry, an import with a different hours layout, another
 * tab). One foreign entry marks the whole day as already imported, exactly
 * the rule the preview applies; an "ours" entry blocks only its own start.
 * That is what lets a day span several batches without double-booking.
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
  return { action: 'write' };
}
```

- [ ] **Step 5: Route changes in `src/routes/apply.ts`**

Import `decideWrite` alongside `findLanded` (drop `findDuplicate` from the import if no longer used). Add limits and a reader:

```ts
/** Sanity bounds for `dayStarts`: a day can hold at most this many planned
 *  entries, and a batch's days together at most this many instants. */
const MAX_STARTS_PER_DAY = 500;
const MAX_STARTS_TOTAL = 5000;

/**
 * `dayStarts` — for every day present in this batch, every start instant
 * the client's plan holds for that day (all entries, checked or not). The
 * pre-write check uses it to tell this import's own earlier writes from
 * foreign entries (see `decideWrite`). Validated as strictly as entries:
 * date keys, second-precision UTC instants, each on its key's local day.
 */
function readDayStarts(
  value: unknown,
  entries: ProposedEntry[],
  timezone: string,
): Record<string, string[]> {
  const raw = asRecord(value);
  const out: Record<string, string[]> = {};
  let total = 0;
  for (const [date, list] of Object.entries(raw)) {
    if (!isDateKey(date)) {
      throw new AppError(400, 'invalid_request', 'dayStarts keys must be YYYY-MM-DD dates');
    }
    if (!Array.isArray(list) || list.length > MAX_STARTS_PER_DAY) {
      throw new AppError(
        400,
        'invalid_request',
        `dayStarts[${date}] must be an array of at most ${MAX_STARTS_PER_DAY} instants`,
      );
    }
    total += list.length;
    if (total > MAX_STARTS_TOTAL) {
      throw new AppError(400, 'invalid_request', 'dayStarts lists too many instants');
    }
    out[date] = list.map((iso) => {
      if (typeof iso !== 'string' || !ISO_INSTANT_RE.test(iso) || Number.isNaN(Date.parse(iso))) {
        throw new AppError(400, 'invalid_request', `dayStarts[${date}] holds a malformed instant`);
      }
      if (localDayOf(iso, timezone) !== date) {
        throw new AppError(
          400,
          'invalid_request',
          `dayStarts[${date}] holds an instant that falls on another local day`,
        );
      }
      return iso;
    });
  }
  for (const entry of entries) {
    const starts = out[entry.date];
    if (!starts || !starts.some((iso) => Date.parse(iso) === Date.parse(entry.start))) {
      throw new AppError(
        400,
        'invalid_request',
        `dayStarts[${entry.date}] must include the start of every entry on that day`,
      );
    }
  }
  return out;
}
```

In the handler, after `const entries = readEntries(body.entries, timezone);` add `const dayStarts = readDayStarts(body.dayStarts, entries, timezone);`. Replace the loop's duplicate check with:

```ts
const decision = decideWrite(entry, existing, timezone, dayStarts[entry.date] ?? []);
if (decision.action === 'skip' || writtenStarts.has(startKey(entry))) {
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

Update the `writtenStarts` comment: it still guards exact repeats within a batch; the cross-batch case is now handled by `decideWrite` seeing the earlier batch's entries as ours. Update the `MAX_ENTRIES` comment: batches no longer need to hold whole days; 10 bounds writes lost to a killed request.

- [ ] **Step 6: Run everything** — `npm run ci` green. Existing test 17 (foreign blocks both) and 16 (exact repeat) must still pass.

- [ ] **Step 7: Commit**

```bash
git add src/plan.ts src/routes/apply.ts test/plan.test.ts test/routes-apply.test.ts
git commit -m "feat: apply route accepts dayStarts so a day can span batches without double-booking

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Client — unlimited days, `dayStarts`, estimate and Free-plan warning

**Files:**

- Modify: `src/hours.ts` (remove `batchByDay`; add `estimateImport`, `freeTierHours`, `formatDuration`), `test/hours.test.ts`
- Modify: `client/api.ts` (`apply` body type), `client/app.ts`, `client/render.ts`, `public/style.css`, `README.md`

**Interfaces:**

- Produces: `estimateImport(count: number, batchSize: number): { batches: number; seconds: number }`; `freeTierHours(count: number, batchSize: number): number`; `formatDuration(seconds: number): string`.
- Wire: client sends `dayStarts` built from `plan.entries` grouped by `date`.

- [ ] **Step 1: Tests** — in `test/hours.test.ts` delete the `batchByDay` block and add:

```ts
describe('estimateImport', () => {
  it('10. counts batches and seconds: 0.5 s per entry plus 2 s between batches', () => {
    expect(estimateImport(0, 10)).toEqual({ batches: 0, seconds: 0 });
    expect(estimateImport(3, 10)).toEqual({ batches: 1, seconds: 1.5 });
    expect(estimateImport(10, 10)).toEqual({ batches: 1, seconds: 5 });
    expect(estimateImport(40, 10)).toEqual({ batches: 4, seconds: 26 });
  });

  it('11. freeTierHours budgets 28 requests per hour for entries plus one pre-check per batch', () => {
    expect(freeTierHours(3, 10)).toBe(1); // 3 + 1 = 4 requests
    expect(freeTierHours(27, 10)).toBe(2); // 27 + 3 = 30 > 28
    expect(freeTierHours(40, 10)).toBe(2); // 40 + 4 = 44 -> 2 hours
    expect(freeTierHours(0, 10)).toBe(0);
  });

  it('12. formatDuration renders seconds, minutes and hours compactly', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(1.5)).toBe('2 s');
    expect(formatDuration(26)).toBe('26 s');
    expect(formatDuration(80)).toBe('1 min 20 s');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(3720)).toBe('1 h 2 min');
  });
});
```

- [ ] **Step 2: Implement in `src/hours.ts`** (delete `batchByDay` and its doc comment):

```ts
/** Rough wall-clock cost of one sequential Clockify POST from the Worker. */
const SECONDS_PER_ENTRY = 0.5;
/** Matches the client's inter-batch pause (client/app.ts). */
const SECONDS_BETWEEN_BATCHES = 2;
/** Clockify Free: 30 requests/hour workspace-wide; keep a margin. */
const FREE_TIER_REQUESTS_PER_HOUR = 28;

export function estimateImport(
  count: number,
  batchSize: number,
): { batches: number; seconds: number } {
  if (count <= 0) return { batches: 0, seconds: 0 };
  const batches = Math.ceil(count / batchSize);
  return { batches, seconds: count * SECONDS_PER_ENTRY + (batches - 1) * SECONDS_BETWEEN_BATCHES };
}

/** Hours a Free workspace needs: one POST per entry plus one pre-check GET per batch. */
export function freeTierHours(count: number, batchSize: number): number {
  if (count <= 0) return 0;
  const { batches } = estimateImport(count, batchSize);
  return Math.ceil((count + batches) / FREE_TIER_REQUESTS_PER_HOUR);
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s === 0 ? `${m} min` : `${m} min ${s} s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
```

Run `npx vitest run --project pure test/hours.test.ts` → PASS (12 tests).

- [ ] **Step 3: `client/api.ts`** — add `dayStarts: Record<string, string[]>;` to `apply`'s body type after `entries`.

- [ ] **Step 4: `client/app.ts`**

- Replace `import { batchByDay } from '../src/hours';` with nothing (use the local `chunksOf`). Remove the per-day-cap block in `runImport` (the `perDayCounts` guard and its comment). `const batches = chunksOf(checked, APPLY_CHUNK);`.
- Update the `APPLY_CHUNK` comment: batches are plain chunks; a day may span batches because every request carries `dayStarts`.
- Build `dayStarts` once before the loop from ALL plan entries of the days present in `checked`:

```ts
// Every planned start for each day we are about to touch — checked or not —
// so the route can tell our earlier batches' entries from foreign ones
// (see decideWrite in src/plan.ts).
const touchedDays = new Set(checked.map((e) => e.date));
const dayStarts: Record<string, string[]> = {};
for (const e of s0.plan.entries) {
  if (!touchedDays.has(e.date)) continue;
  (dayStarts[e.date] ??= []).push(e.start);
}
```

and pass `dayStarts` in each `apply(...)` call (sending the whole map every batch is fine: ≤ 5000 instants).

- Hours input parsing (`data-hours-key` handler): `const raw = Number(target.value.trim().replace(',', '.'));`.

- [ ] **Step 5: `client/render.ts`**

- Delete `MAX_ENTRIES_PER_DAY`, `perDayCounts`, `overCapDates`, `dayCapExceeded` and the cap branch; `importBtn.disabled = selectedCount === 0 || overflow.length > 0;`.
- Import `estimateImport, freeTierHours, formatDuration` from `'../src/hours'`. Add a module constant `const APPLY_CHUNK = 10; // mirrors client/app.ts APPLY_CHUNK and src/routes/apply.ts MAX_ENTRIES`.
- Totals (non-error branch):

```ts
const { seconds } = estimateImport(selectedCount, APPLY_CHUNK);
const prefix = state.prefs.splitEvenly ? '' : 'Manual hours — ';
totals.textContent = `${prefix}${selectedCount} of ${plan.entries.length} entries selected — ${selectedHours.toFixed(2)} hours · ~${formatDuration(seconds)}`;
```

- Free-tier line: `public/index.html` gets `<p id="preview-free-warning" class="totals totals-warning" role="status" hidden></p>` right after `#preview-totals`. In render:

```ts
const freeWarning = el('preview-free-warning');
const workspace = state.connect.workspaces.find((w) => w.id === state.prefs.workspaceId);
if (workspace?.freeTier && selectedCount > 0) {
  const hours = freeTierHours(selectedCount, APPLY_CHUNK);
  freeWarning.hidden = false;
  freeWarning.textContent = `Free Clockify plan: 30 API requests per hour, workspace-wide. This import needs about ${hours} hour${hours === 1 ? '' : 's'} and will start failing with 429 after ~28 entries — uncheck rows or import in stages.`;
} else {
  freeWarning.hidden = true;
}
```

(hide it too on the `!plan` and empty-entries early returns).

- Manual-mode affordance: hours input becomes

```ts
const input = document.createElement('input');
input.type = 'text';
input.inputMode = 'decimal';
input.className = 'hours-input';
input.autocomplete = 'off';
input.value = hoursOf(entry).toFixed(2);
input.dataset.hoursKey = entry.key;
input.disabled = importingNow;
input.setAttribute('aria-label', `Hours for ${entry.date} ${groupLabel(entry.group)}`);
```

`rowsEl.classList.toggle('is-manual', !state.prefs.splitEvenly);` and the hint: give the hint `<p>` under `#split-evenly` the id `split-evenly-hint` and set its text per mode: even → `Each GitHub issue gets its own entry. Uncheck to set the hours of every entry by hand — "Hours per day" then only seeds the values.`; manual → `Manual mode: type the hours for each entry in the Hours column (e.g. 1.5 or 1,5). Re-check to go back to an even split.`

- [ ] **Step 6: CSS** (`public/style.css`): `.totals-warning { color: var(--color-danger); font-weight: 500; }` and

```css
tbody.is-manual .hours-input {
  border: 1.5px solid var(--color-primary, #b45309);
  background: var(--color-surface-alt, #fff8f0);
  text-align: right;
}
```

(check the file's existing custom property names and use them; do not invent new tokens if equivalents exist).

- [ ] **Step 7: README** — in "Three honest limitations" delete the 10-entries-per-day sentence(s) added last time; add to the Free-plan paragraph: the preview shows an estimated duration and, for Free workspaces, the number of hours the import would need; the tool does not pace across hours — import in stages instead.

- [ ] **Step 8: Verify** — `npm run ci && npm run build:client` green.

- [ ] **Step 9: Commit**

```bash
git add src/hours.ts test/hours.test.ts client/api.ts client/app.ts client/render.ts public/index.html public/style.css README.md
git commit -m "feat: import any number of entries per day, show a time estimate and a Free-plan warning

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Lucide icons

**Files:**

- Modify: `package.json` (+ lockfile) — `npm install lucide@^1.40.0`
- Create: `client/icons.ts`
- Modify: `client/render.ts`, `client/app.ts`, `public/index.html`, `public/style.css`

**Interfaces:**

- Produces: `icon(name: IconName, opts?: { size?: number; className?: string }): SVGElement`; `type IconName = keyof typeof ICONS`; `setButtonLabel(button: HTMLButtonElement, name: IconName, text: string): void` (in `render.ts`, exported); `renderStaticIcons(): void` (in `render.ts`, exported, called once from `init()`).

- [ ] **Step 1: Install and write `client/icons.ts`**

```ts
/**
 * Lucide icons as DOM elements. The CSP forbids CDN scripts and inline
 * styles, so icons are bundled (esbuild tree-shakes the unused ones) and
 * created with lucide's own `createElement`, never via innerHTML strings.
 */
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Filter,
  Hash,
  Info,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Upload,
  X,
  createElement,
} from 'lucide';

export const ICONS = {
  alert: AlertTriangle,
  back: ArrowLeft,
  bell: Bell,
  check: Check,
  clock: Clock,
  connect: Plug,
  copy: Copy,
  filter: Filter,
  hash: Hash,
  info: Info,
  mapping: SlidersHorizontal,
  next: ArrowRight,
  shield: ShieldCheck,
  sparkles: Sparkles,
  stop: Square,
  success: CheckCircle2,
  upload: Upload,
  x: X,
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, opts: { size?: number; className?: string } = {}): SVGElement {
  const size = opts.size ?? 16;
  const svg = createElement(ICONS[name], {
    width: String(size),
    height: String(size),
    'stroke-width': '2',
    class: `icon${opts.className ? ` ${opts.className}` : ''}`,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  return svg;
}
```

Verify against `node_modules/lucide/dist/lucide.d.ts` that `createElement(iconNode, attrs)` exists with this signature and that the icon names exist (`CheckCircle2` may be `CircleCheck` in this version — use whatever exists and keep the alias `success`). If `createElement`'s attribute handling differs, adapt while keeping the exported API above.

- [ ] **Step 2: `render.ts` helpers**

```ts
export function setButtonLabel(button: HTMLButtonElement, name: IconName, text: string): void {
  button.replaceChildren(
    icon(name),
    Object.assign(document.createElement('span'), { textContent: text }),
  );
}
```

Replace every `btn.textContent = '…'` on `#verify-btn`, `#connect-continue`, `#scope-back`, `#scope-continue`, `#mapping-back`, `#mapping-continue`, `#preview-back`, `#import-btn` with `setButtonLabel(...)`: verify → `shield`, continues → `next`, backs → `back`, `Cancel scan` → `x`, `Scan activity` → `filter`, `Import entries` → `upload`, `Stop (…)` → `stop`. Static labels (those never re-rendered) are set in `renderStaticIcons()`:

```ts
export function renderStaticIcons(): void {
  const stepIcons: Record<string, IconName> = {
    '1': 'connect',
    '2': 'filter',
    '3': 'mapping',
    '4': 'upload',
  };
  for (const [step, name] of Object.entries(stepIcons)) {
    const num = document.querySelector<HTMLElement>(
      `.stepper-item[data-step="${step}"] .stepper-num`,
    );
    if (num)
      num.replaceChildren(
        icon(name, { size: 14 }),
        document.createTextNode(` ${num.textContent?.trim() ?? ''}`),
      );
  }
  setButtonLabel(el('connect-continue') as HTMLButtonElement, 'next', 'Continue to scope');
  setButtonLabel(el('scope-back') as HTMLButtonElement, 'back', 'Back');
  setButtonLabel(el('scope-continue') as HTMLButtonElement, 'next', 'Continue to mapping');
  setButtonLabel(el('mapping-back') as HTMLButtonElement, 'back', 'Back');
  setButtonLabel(el('mapping-continue') as HTMLButtonElement, 'filter', 'Scan activity');
  const issueTh = document.querySelector<HTMLElement>('#preview-table-wrap th[data-col="issue"]');
  if (issueTh) issueTh.prepend(icon('hash', { size: 12 }));
  const hoursTh = document.querySelector<HTMLElement>('#preview-table-wrap th[data-col="hours"]');
  if (hoursTh) hoursTh.prepend(icon('clock', { size: 12 }));
}
```

Add `data-col="issue"` / `data-col="hours"` to those two `<th>`s in `public/index.html`. Status pills: `statusPill()` prepends `icon('sparkles', {size: 12})` for New and `icon('copy', …)` for Duplicate; import result pills: `success`/`copy`/`alert`. Banners (`#plan-warning`, `#duplicate-check-warning`): prepend `icon('alert')` inside the `<p>` in `renderStaticIcons` (the `<p>` text is replaced at runtime via `textContent` in `renderMapping`/`renderScanProgress` — change those to set a nested `<span class="banner-text">` instead so the icon survives; add the span in the HTML).

- [ ] **Step 3: `app.ts`** — call `renderStaticIcons()` in `init()` before the first `render()`. Import `setButtonLabel` where `textContent` was used on buttons (only render.ts should touch buttons; move any such code there if found).

- [ ] **Step 4: CSS**

```css
.icon {
  display: inline-block;
  vertical-align: -0.125em;
  flex: none;
}
.btn .icon {
  margin-right: 0.4rem;
}
.btn {
  display: inline-flex;
  align-items: center;
}
.status-pill .icon {
  margin-right: 0.25rem;
}
th .icon {
  margin-right: 0.25rem;
  opacity: 0.7;
}
```

- [ ] **Step 5: Verify** — `npm run ci && npm run build:client`; check `public/app.js` grew by a modest amount (`ls -la public/app.js`, expect < 40 KB added). Commit:

```bash
git add package.json package-lock.json client/icons.ts client/render.ts client/app.ts public/index.html public/style.css
git commit -m "feat: Lucide icons on stepper, buttons, pills and banners

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Toasts

**Files:**

- Create: `client/toast.ts`
- Modify: `client/app.ts`, `public/index.html`, `public/style.css`

**Interfaces:**

- Produces: `createToaster(host: HTMLElement): Toaster`; `type ToastKind = 'info' | 'success' | 'warning' | 'error'`; `Toaster.push({ kind, title, message? }): void`.

- [ ] **Step 1: Markup** — before `</main>`'s closing (inside `.page`, after `<main>`): `<div id="toasts" class="toasts" aria-live="polite" aria-relevant="additions"></div>`.

- [ ] **Step 2: `client/toast.ts`**

```ts
import { icon } from './icons';
import type { IconName } from './icons';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export type ToastInput = { kind: ToastKind; title: string; message?: string };
export type Toaster = { push(toast: ToastInput): void };

const AUTO_DISMISS_MS = 5000;
const MAX_VISIBLE = 4;
const ICON_FOR: Record<ToastKind, IconName> = {
  info: 'info',
  success: 'success',
  warning: 'alert',
  error: 'alert',
};

export function createToaster(host: HTMLElement): Toaster {
  function dismiss(node: HTMLElement): void {
    if (!node.isConnected) return;
    node.classList.add('is-leaving');
    const remove = () => node.remove();
    node.addEventListener('animationend', remove, { once: true });
    // Reduced-motion users get no animationend; don't leave ghosts behind.
    setTimeout(remove, 400);
  }

  return {
    push({ kind, title, message }) {
      const node = document.createElement('div');
      node.className = `toast toast-${kind}`;
      if (kind === 'error') node.setAttribute('role', 'alert');

      const body = document.createElement('div');
      body.className = 'toast-body';
      const strong = document.createElement('strong');
      strong.textContent = title;
      body.appendChild(strong);
      if (message) {
        const p = document.createElement('p');
        p.textContent = message;
        body.appendChild(p);
      }

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'toast-close';
      close.setAttribute('aria-label', 'Dismiss');
      close.appendChild(icon('x', { size: 14 }));
      close.addEventListener('click', () => dismiss(node));

      node.append(icon(ICON_FOR[kind], { size: 18, className: 'toast-icon' }), body, close);
      host.appendChild(node);

      while (host.children.length > MAX_VISIBLE) {
        const oldest = host.firstElementChild;
        if (oldest instanceof HTMLElement) oldest.remove();
        else break;
      }
      if (kind !== 'error') setTimeout(() => dismiss(node), AUTO_DISMISS_MS);
    },
  };
}
```

- [ ] **Step 3: Wire in `client/app.ts`** — `const toaster = createToaster(qs('toasts'));` after the store. Push toasts:
  - `handleVerify`: GitHub ok → none; failures → `error` "GitHub connection failed" / "Clockify connection failed" with the message; both ok → `success` "Connected" with `${login} · ${clockify name}`.
  - `loadRepos` / `loadProjects` catch → `error` "Couldn't load repositories/projects".
  - `runScan`: fatal → `error` "Scan failed"; cancelled → `warning` "Scan cancelled" (`N activities gathered`); done → `success` "Scan complete" (`N activities found`, plus `W warnings` when any).
  - `loadExistingEntriesAndRecompute` catch → `warning` "Couldn't check for duplicates" with the message.
  - `runImport` batch catch → `error` "Import request failed" with the message; end → count `imported/skipped/failed` from `results` and push `success` (no failures) or `warning` (some failed) "Import finished" with `X imported · Y already existed · Z failed`.
    Keep every existing `announce(...)` call as-is (screen-reader region).

- [ ] **Step 4: CSS**

```css
.toasts {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  z-index: 50;
  max-width: min(22rem, calc(100vw - 2rem));
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.7rem 0.8rem;
  border-radius: 8px;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border);
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.12);
  animation: toast-in 220ms ease-out;
}
.toast.is-leaving {
  animation: toast-out 200ms ease-in forwards;
}
.toast-body p {
  margin: 0.2rem 0 0;
  font-size: 0.85rem;
  color: var(--color-text-muted);
}
.toast-close {
  margin-left: auto;
  background: none;
  border: 0;
  cursor: pointer;
  color: var(--color-text-muted);
  padding: 0.1rem;
}
.toast-success .toast-icon {
  color: var(--color-positive);
}
.toast-warning .toast-icon,
.toast-error .toast-icon {
  color: var(--color-danger);
}
.toast-info .toast-icon {
  color: var(--color-primary, #b45309);
}
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes toast-out {
  to {
    opacity: 0;
    transform: translateY(8px);
  }
}
```

Use the file's real custom property names (check `:root`); the reduced-motion rule at the end of the file already neutralises animations.

- [ ] **Step 5: Verify + commit**

```bash
git add client/toast.ts client/app.ts public/index.html public/style.css
git commit -m "feat: toast notifications for connection, scan and import events

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Browser notifications

**Files:**

- Create: `client/notify.ts`
- Modify: `client/state.ts` (`prefs.notifyWhenDone`), `client/app.ts`, `client/render.ts`, `public/index.html`

**Interfaces:**

- Produces: `notificationsSupported(): boolean`; `requestNotifyPermission(): Promise<boolean>`; `notifyIfHidden(title: string, body: string): void`.

- [ ] **Step 1: `client/notify.ts`**

```ts
/** Browser notifications for long scans/imports, shown only when the tab is
 *  in the background — a visible tab already has toasts. */
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function requestNotifyPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

export function notifyIfHidden(title: string, body: string): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  try {
    const n = new Notification(title, { body, tag: 'gh2clockify' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some browsers throw when constructing Notification directly (e.g. Android Chrome).
  }
}
```

- [ ] **Step 2: State + markup** — `Prefs.notifyWhenDone: boolean` default `false`. In `public/index.html`, right after the split-evenly `.field-checkbox`:

```html
<div class="field field-checkbox" id="notify-field">
  <input type="checkbox" id="notify-when-done" name="notify-when-done" />
  <label for="notify-when-done">Notify me when a scan or import finishes</label>
  <p class="field-hint">Browser notification, only while this tab is in the background.</p>
</div>
```

- [ ] **Step 3: Wiring (`app.ts`)** — in `initFormFromState`: hide `#notify-field` when `!notificationsSupported()`; set the checkbox from prefs but force it false (and persist) when `Notification.permission !== 'granted'`. Listener:

```ts
qs<HTMLInputElement>('notify-when-done').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  if (input.checked) {
    const granted = await requestNotifyPermission();
    if (!granted) {
      input.checked = false;
      toaster.push({
        kind: 'warning',
        title: 'Notifications are blocked',
        message: 'Allow notifications for this site in your browser settings to use this.',
      });
    }
    store.update((s) => {
      s.prefs.notifyWhenDone = granted;
    });
  } else {
    store.update((s) => {
      s.prefs.notifyWhenDone = false;
    });
  }
  savePrefs(store.getState().prefs);
});
```

`render.ts` syncs `#notify-when-done`.checked from `state.prefs.notifyWhenDone` in `renderPreviewTable` (next to the split checkbox sync). Fire: in `runScan` end (`Scan complete — N activities found` / cancelled / failed) and `runImport` end (`Import finished — X imported, Y already existed, Z failed`) call `if (store.getState().prefs.notifyWhenDone) notifyIfHidden(title, body)`.

- [ ] **Step 4: Verify + commit**

```bash
git add client/notify.ts client/state.ts client/app.ts client/render.ts public/index.html
git commit -m "feat: optional browser notification when a background scan or import finishes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Animations

**Files:**

- Modify: `public/style.css`, `client/render.ts`

- [ ] **Step 1: CSS** (before the `prefers-reduced-motion` block, which stays last):

```css
.panel.is-entering {
  animation: panel-in 220ms ease-out;
}
@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
#preview-rows tr {
  animation: row-in 260ms ease-out both;
  animation-delay: calc(var(--i, 0) * 25ms);
}
@keyframes row-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.progress.is-running .progress-fill {
  position: relative;
  overflow: hidden;
}
.progress.is-running .progress-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 0.35), transparent);
  animation: shimmer 1.4s linear infinite;
}
@keyframes shimmer {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(100%);
  }
}
.status-pill.is-fresh {
  animation: pill-pop 260ms ease-out;
}
@keyframes pill-pop {
  from {
    transform: scale(0.85);
    opacity: 0.4;
  }
  to {
    transform: none;
    opacity: 1;
  }
}
.btn {
  transition:
    background-color 150ms ease,
    box-shadow 150ms ease,
    transform 80ms ease;
}
.btn:active:not(:disabled) {
  transform: translateY(1px);
}
.totals {
  transition: color 200ms ease;
}
```

- [ ] **Step 2: Hooks in `render.ts`**
  - `renderStepper`: keep a module-level `let lastStep = 0;`. When `state.step !== lastStep`, remove `is-entering` from all `.panel`s, add it to the current step's panel (force reflow not needed since the element was hidden), set `lastStep = state.step`.
  - `renderPreviewTable`: `tr.style.setProperty('--i', String(Math.min(index, 20)));` for each row (CSSOM, allowed by CSP as documented at the top of render.ts).
  - `renderScanProgress`: `el('scan-progress').classList.toggle('is-running', scan.status === 'running')`.
  - `renderImportResults`: keep a module-level `let renderedResults = 0;`; pills for results with index `>= renderedResults` get class `is-fresh`; set `renderedResults = importing.results.length` at the end (reset to 0 when `results.length === 0`).

- [ ] **Step 3: Verify + commit**

```bash
git add public/style.css client/render.ts
git commit -m "feat: subtle motion — panel and row entrances, progress shimmer, toast and pill animations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: README and docs sweep

**Files:** `README.md`

- [ ] Update the intro (mention the time estimate and optional notifications in one sentence), the Free-plan limitation paragraph (estimate + hours figure + "import in stages"), remove any remaining reference to a per-day cap, and add a short "Notifications" note under usage: browser notifications are opt-in, only fire when the tab is in the background, and can be revoked in the browser. Keep lines ≤ ~78 chars; `npm run format:check`.

```bash
git add README.md
git commit -m "docs: time estimate, Free-plan hours warning, notifications; drop the per-day cap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** Unlimited rows per day + batching + time estimate + Free warning → Tasks 1, 2, 7. Manual-mode visibility + `0,20` → Task 2 (decision 5). Icons → Task 3. Toasts → Task 4. Browser notifications → Task 5. Animations → Task 6.

**Type consistency.** `decideWrite(entry, existing, timezone, plannedStarts)` (Task 1) is called with `dayStarts[entry.date] ?? []` (Task 1 route). `apply` body `dayStarts: Record<string, string[]>` (Task 2 api.ts) matches `readDayStarts` (Task 1). `estimateImport(count, batchSize)` / `freeTierHours(count, batchSize)` / `formatDuration(seconds)` (Task 2) used in `render.ts` (Task 2). `icon(name, opts)` / `IconName` (Task 3) used by `toast.ts` (Task 4) and `render.ts` (Tasks 3, 6). `Toaster.push({kind,title,message})` (Task 4) used in Task 5. `notifyIfHidden(title, body)` (Task 5). `APPLY_CHUNK = 10` in `app.ts` and `render.ts`, `MAX_ENTRIES = 10` in the route.
