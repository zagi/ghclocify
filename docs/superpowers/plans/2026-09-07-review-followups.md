# Design Review Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 14 findings left open by the 2026-09-07 design/UX review: a real "done" state after import, a card layout for the preview on phones, de-duplicated Clockify descriptions, and a set of smaller contrast, copy and accessibility fixes.

**Architecture:** All UI work stays inside the existing split — `client/state.ts` (store), `client/render.ts` (pure state→DOM, rebuilds the preview table every render), `client/app.ts` (listeners and side effects), `public/style.css`, `public/index.html`. The one pure-module change is in `src/describe.ts` (bundled into both the Worker and the client). The CSP is `script-src 'self'; style-src 'self'`: no inline `style=""` attributes, no inline scripts, no CDNs; `element.style.setProperty` from TypeScript is fine.

**Tech Stack:** TypeScript 6, esbuild bundle to `public/app.js` (gitignored — never commit it), vitest 4 (`pure` node project for `src/*`), ESLint 10, Prettier (also checks Markdown), Lucide icons via `client/icons.ts`.

**Spec:** The review artifact (https://claude.ai/code/artifact/dae81ab9-2c04-472b-a4d0-dbf67c32bc37), section "Znaleziska: otwarte". The finding numbers below (F1–F14) follow that list in order.

## Global Constraints

- `npm run ci` (typecheck + lint + prettier + tests) must pass after every task. Run `npx prettier --write <files>` before committing; Prettier also formats Markdown.
- Never commit `public/app.js`. Run `npm run build:client` to check the bundle builds.
- No inline `style` attributes or `<style>`/`<script>` blocks in HTML. New CSS goes in `public/style.css`; the `@media (prefers-reduced-motion: reduce)` block must stay LAST in the file.
- All user-facing copy is English. Commit messages English, Conventional-Commits style (`feat:`, `fix:`, `test:`).
- There are no client unit tests; client tasks are verified by `npm run typecheck`, `npx eslint client`, `npm run build:client`, and a mocked-API Playwright run at the end (the plan's final step). Every client task still lists the manual check it must pass.
- Keep `hidden` for show/hide toggling (`public/style.css` has `[hidden] { display: none !important }`).

---

### Task 1: Descriptions stop repeating the issue number and type prefix (F3)

**Files:**

- Modify: `src/describe.ts:66-100` (`describeDay` title collection)
- Test: `test/describe.test.ts`

**Interfaces:**

- Consumes: `TYPE_PREFIX` (`/^\((fix|feat)\)/i`), `ISSUE_REF` (`/#(\d+)/g`) already defined in `src/describe.ts`.
- Produces: `describeDay(activities, aliases)` — same signature, titles inside the description no longer carry a leading `(fix)`/`(feat)` marker nor `#N` references; both are already emitted once in the `ISSUE #a #b` and `(fix) (feat)` segments.

Background: today the description reads `GH2CLOCKIFY ISSUE #12 (fix) (fix) handle expired tokens #12`. The type and issue segments are extracted from the title, but the title is appended untouched, so both repeat. Keep the alias and the segments — in Clockify the description is the only place that information lives — and clean the title only.

- [ ] **Step 1: Update the existing expectations and add a test for the cleaned title**

In `test/describe.test.ts`, change the three expectations that encode the duplication:

```ts
// 'builds a repo block with alias, issues and types'
expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe(
  'DP ISSUE #9 #185 (fix) resolve login redirect, bump deps',
);

// 'pins the sort order of multiple distinct type markers'
expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe(
  'DP (feat) (fix) resolve login redirect, add sso support',
);

// 'does not dedupe type markers that differ only in case ...'
expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe(
  'DP (Fix) (fix) resolve login redirect, bump deps',
);
```

Then add, inside `describe('describeDay', …)`:

```ts
it('strips the type prefix and #N references from titles, keeping inner words and punctuation', () => {
  const activities: Activity[] = [
    act({
      repo: 'acme/dp',
      title: '(feat) add per-issue split #34 in the preview table #12',
      timestamp: '2026-08-03T09:00:00Z',
    }),
    act({ repo: 'acme/dp', title: '#12', timestamp: '2026-08-03T10:00:00Z' }),
  ];
  expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe(
    'DP ISSUE #12 #34 (feat) add per-issue split in the preview table',
  );
});

it('dedupes titles after cleaning, not before', () => {
  const activities: Activity[] = [
    act({ repo: 'acme/dp', title: '(fix) same work #1', timestamp: '2026-08-03T09:00:00Z' }),
    act({ repo: 'acme/dp', title: 'same work #2', timestamp: '2026-08-03T10:00:00Z' }),
  ];
  expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe('DP ISSUE #1 #2 (fix) same work');
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project pure test/describe.test.ts`
Expected: 5 failures (the three edited expectations and the two new tests) mentioning `(fix) (fix)` / `#185`.

- [ ] **Step 3: Clean the title in `describeDay`**

In `src/describe.ts`, add next to `TYPE_PREFIX`:

```ts
/**
 * A title as it appears inside the description: without the leading
 * `(fix)`/`(feat)` marker and without `#N` references, because both are
 * already emitted once per repo block. Collapses the whitespace left behind.
 * Returns '' when nothing but markers remained (e.g. a title of "#12").
 */
export function cleanTitle(title: string): string {
  return title.replace(TYPE_PREFIX, '').replace(ISSUE_REF, '').replace(/\s+/g, ' ').trim();
}
```

Then in the `for (const item of items)` loop replace the title bookkeeping:

```ts
const cleaned = cleanTitle(item.title);
if (cleaned !== '' && !seenTitles.has(cleaned)) {
  seenTitles.add(cleaned);
  titles.push(cleaned);
}
```

and make the final push conditional so an all-marker day does not end with a trailing space:

```ts
if (titles.length > 0) parts.push(titles.join(', '));
```

Note `ISSUE_REF` has the `g` flag; `String.prototype.replace` with a global regex replaces every match and does not depend on `lastIndex`, so no reset is needed.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project pure test/describe.test.ts`
Expected: all pass. Then `npx vitest run --project pure` — `aggregate.test.ts` may contain description expectations too; if any assert a `(fix) (fix)` or trailing `#N`, update them to the cleaned form (same rule: markers appear once, in the segments).

- [ ] **Step 5: Update the docstring above `describeDay` and README**

Replace the format line in the `describeDay` JSDoc with:

```ts
/**
 * `<ALIAS> [ISSUE #a #b] [(fix) (feat)] title1, title2   |   <ALIAS2> ...`
 *
 * Titles are cleaned: the leading type marker and every `#N` are removed
 * (they are already in the segments) and whitespace is collapsed. Repo
 * blocks are joined with `' | '` in the order repos first appear in
 * `activities`. Within a block: issue numbers are deduped and sorted
 * numerically; types are deduped and sorted; cleaned titles are deduped but
 * keep chronological order (by `timestamp`).
 */
```

In `README.md`, find the "Each GitHub issue you touched on a day becomes its own entry" paragraph and append one sentence: `The entry description lists the repository, the issue numbers and the commit titles once each — titles are shown without the "#N" and "(fix)" markers that already lead the description.`

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/describe.ts test/describe.test.ts README.md
npm run ci
git add src/describe.ts test/describe.test.ts test/aggregate.test.ts README.md
git commit -m "fix: descriptions list the type marker and issue numbers once, titles are cleaned"
```

---

### Task 2: A real "done" state after import (F1, and the results card placement)

**Files:**

- Modify: `client/app.ts:664-681` (end of `runImport`)
- Modify: `client/render.ts:452-461` (`statusPill`), `client/render.ts:588-660` (row builder), `client/render.ts:700-718` (import button)
- Modify: `public/index.html:455-465` (move `#import-results` above `.actions-nav`)
- Modify: `public/style.css` (`.status-pill.status-error` exists; add `tr.is-imported`)

**Interfaces:**

- Consumes: `state.importing.results: ApplyResult[]` (`{ date, key, ok, skipped?, error? }`), `state.checkedKeys: Set<string>`, `groupLabel` from `../src/aggregate`.
- Produces: `latestResultFor(state, key): ApplyResult | undefined` (module-private in `render.ts`); row status pill shows `Imported` / `Already exists` / `Failed` once a result exists for that key; `runImport` unchecks every key whose result is `ok` (imported or skipped) when the import finishes.

Behaviour to build:

1. When an import finishes, keys that were imported or already existed are removed from `checkedKeys`. Failed keys stay checked so "Import entries" becomes a retry of exactly the failures.
2. In the table, a row with a result shows that result instead of New/Duplicate: green `Imported` (check icon), muted `Already exists` (copy icon) or red `Failed` (alert icon, error text under it). Imported rows get `tr.is-imported` (same tint as `is-duplicate`).
3. The results card moves above the Back/Import row so it is inside the panel body, not under its footer.
4. The import button label becomes `Import N entries` (N = selected count) so "0 selected" reads as done, and it is disabled when N is 0 (already the case).

- [ ] **Step 1: Uncheck successful keys when the import finishes**

In `client/app.ts`, in `runImport`, replace:

```ts
store.update((s) => {
  s.importing.status = 'done';
});
```

with:

```ts
store.update((s) => {
  s.importing.status = 'done';
  // Imported and already-existing entries are done; only failures stay
  // selected, so the next click on "Import" retries exactly those.
  const next = new Set(s.checkedKeys);
  for (const r of s.importing.results) if (r.ok) next.delete(r.key);
  s.checkedKeys = next;
});
```

(`ok` is true for both written and skipped entries — see `src/routes/apply.ts`, all skips return `ok: true, skipped: true`.)

- [ ] **Step 2: Show the result in the row's status cell**

In `client/render.ts`, above `statusPill`, add:

```ts
/** The last apply result for an entry key, if the current import touched it. */
function latestResultFor(state: State, key: string): ApplyResult | undefined {
  const { results } = state.importing;
  for (let i = results.length - 1; i >= 0; i -= 1) {
    if (results[i]?.key === key) return results[i];
  }
  return undefined;
}

function resultPill(result: ApplyResult): HTMLElement {
  const span = document.createElement('span');
  if (result.ok && !result.skipped) {
    span.className = 'status-pill status-success';
    span.append(icon('success', { size: 12 }), document.createTextNode('Imported'));
  } else if (result.skipped) {
    span.className = 'status-pill status-pending';
    span.append(icon('copy', { size: 12 }), document.createTextNode('Already exists'));
  } else {
    span.className = 'status-pill status-error';
    span.append(icon('alert', { size: 12 }), document.createTextNode('Failed'));
  }
  return span;
}
```

Import the type at the top of `render.ts`: `import type { ApplyResult, PlannedEntry } from '../src/types';` (merge with the existing type import line — check what it already imports).

In the row builder, replace:

```ts
    const statusTd = document.createElement('td');
    statusTd.className = 'status-cell';
    statusTd.appendChild(statusPill(entry.status));
    if (entry.status === 'duplicate' && entry.existing) {
```

with:

```ts
    const statusTd = document.createElement('td');
    statusTd.className = 'status-cell';
    const result = latestResultFor(state, entry.key);
    if (result) {
      statusTd.appendChild(resultPill(result));
      if (result.ok && !result.skipped) tr.classList.add('is-imported');
      if (!result.ok && result.error) {
        const errorP = document.createElement('div');
        errorP.className = 'field-hint';
        errorP.textContent = result.error;
        statusTd.appendChild(errorP);
      }
    } else {
      statusTd.appendChild(statusPill(entry.status));
    }
    if (!result && entry.status === 'duplicate' && entry.existing) {
```

(The existing `Existing: …` hint block follows unchanged.)

- [ ] **Step 3: Label the import button with the count**

In `renderPreviewTable`, replace:

```ts
importBtn.disabled = selectedCount === 0 || overflow.length > 0;
setButtonLabel(importBtn, 'upload', 'Import entries');
```

with:

```ts
importBtn.disabled = selectedCount === 0 || overflow.length > 0;
setButtonLabel(
  importBtn,
  'upload',
  selectedCount === 0
    ? 'Import entries'
    : `Import ${selectedCount} ${selectedCount === 1 ? 'entry' : 'entries'}`,
);
```

- [ ] **Step 4: Move the results card above the action row**

In `public/index.html`, cut the whole

```html
<div id="import-results" class="result-card" hidden>
  <h3>Import results</h3>
  <ul id="import-results-list"></ul>
</div>
```

block and paste it directly BEFORE `<div class="actions actions-nav">` that contains `#preview-back` / `#import-btn` (i.e. after `#preview-free-warning`).

In `public/style.css`, after the `tbody tr.is-duplicate` rule add:

```css
tbody tr.is-imported {
  background: var(--color-positive-bg);
}
```

and change `.result-card { margin-top: 1.25rem; … }` to also set `margin-bottom: 1.25rem;` so the card has air above the divider.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npx eslint client && npm run build:client`
Expected: no errors.

Manual check (do it — start `npx wrangler dev --port 8787` and use the mocked walkthrough in the plan's final task, or a quick Playwright snippet): after a mocked import with 3 successes + 1 skipped, the table shows three `Imported` rows tinted green, the duplicate row `Already exists`, every checkbox unchecked, the button reads `Import entries` and is disabled, and the results card sits above the Back/Import row. Then tick one row: the button reads `Import 1 entry`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write client public/index.html public/style.css
npm run ci
git add client/app.ts client/render.ts public/index.html public/style.css
git commit -m "feat: done state after import — rows show Imported/Already exists/Failed, successes uncheck, results card above the actions"
```

---

### Task 3: Phone layout — preview cards, toasts on top, compact stepper (F2, F4, F14)

**Files:**

- Modify: `client/render.ts` row builder (add `data-label` on every `td`)
- Modify: `public/style.css` `@media (max-width: 640px)` block and `.toasts`

**Interfaces:**

- Consumes: the `td.*-cell` classes added on 2026-09-07 (`date-cell`, `day-cell`, `issue-cell`, `activity-cell`, `repos-cell`, `description-cell`, `hours-cell`, `status-cell`).
- Produces: below 640 px each `tbody tr` renders as a card (CSS grid), each cell prefixed by its `data-label`; toasts dock to the top; the stepper is one horizontal row of badges with only the current step's label.

- [ ] **Step 1: Add `data-label` to the cells**

In the row builder in `client/render.ts`, after each cell's `className` assignment, set the label the card layout prints before the value:

```ts
dateTd.dataset.label = 'Date';
dayTd.dataset.label = 'Day';
issueTd.dataset.label = 'Issue';
activityTd.dataset.label = 'Activity';
reposTd.dataset.label = 'Repositories';
descTd.dataset.label = 'Description';
hoursTd.dataset.label = 'Hours';
statusTd.dataset.label = 'Status';
```

(`hoursTd.className = 'hours-cell'` already exists — add the label line under it.) The checkbox cell gets no label.

- [ ] **Step 2: Card layout below 640 px**

Append INSIDE the existing `@media (max-width: 640px) { … }` block in `public/style.css` (before its closing brace):

```css
/* Preview as cards: the nine-column table cannot fit a phone. */
.page.is-wide {
  max-width: 46rem;
}

#preview-table-wrap thead {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

#preview-table-wrap tbody tr {
  display: grid;
  grid-template-columns: auto 1fr 1fr;
  grid-template-areas:
    'check date status'
    'check issue hours'
    'check repos repos'
    'check desc desc';
  gap: 0.15rem 0.6rem;
  padding: 0.6rem 0.65rem;
  border-bottom: 1px solid var(--color-border);
}

#preview-table-wrap tbody td {
  display: block;
  padding: 0;
  border: 0;
  white-space: normal;
  min-width: 0;
  max-width: none;
}

#preview-table-wrap tbody td:first-child {
  grid-area: check;
  align-self: start;
}
#preview-table-wrap td.date-cell {
  grid-area: date;
  font-weight: 600;
}
#preview-table-wrap td.day-cell,
#preview-table-wrap td.activity-cell {
  display: none;
}
#preview-table-wrap td.status-cell {
  grid-area: status;
  justify-self: end;
}
#preview-table-wrap td.issue-cell {
  grid-area: issue;
}
#preview-table-wrap td.hours-cell {
  grid-area: hours;
  justify-self: end;
  text-align: right;
}
#preview-table-wrap td.repos-cell {
  grid-area: repos;
  color: var(--color-text-muted);
  font-size: 0.8rem;
}
#preview-table-wrap td.description-cell {
  grid-area: desc;
}
#preview-table-wrap td.repos-cell::before,
#preview-table-wrap td.description-cell::before {
  content: attr(data-label) ': ';
  font-family: var(--font-mono);
  font-size: 0.65rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
#preview-table-wrap td.status-cell .field-hint {
  min-width: 0;
  max-width: none;
}
```

The date + status header row and issue + hours row need no `::before` label: the value is self-explanatory. Day and activity count are dropped on phones (the date already implies the weekday to the person who did the work; the count is visible on desktop).

- [ ] **Step 3: Toasts on top, compact stepper**

Still inside the same `@media (max-width: 640px)` block, add:

```css
.toasts {
  top: 0.75rem;
  bottom: auto;
  left: 1rem;
  right: 1rem;
  max-width: none;
}

/* One row of badges; only the current step keeps its label. */
.stepper ol {
  flex-direction: row;
}
.stepper-item {
  flex: 0 0 auto;
  border-bottom: none;
  border-right: 1px solid var(--color-border);
}
.stepper-item.is-current {
  flex: 1 1 auto;
}
.stepper-item:last-child {
  border-right: none;
}
.stepper-item a {
  padding: 0.6rem 0.65rem;
  justify-content: center;
}
.stepper-item.is-current a {
  justify-content: flex-start;
}
.stepper-label {
  display: none;
}
.stepper-item.is-current .stepper-label {
  display: inline;
}
```

Then DELETE the older mobile stepper rules at the top of that media block (`.stepper ol { flex-direction: column; }`, `.stepper-item { border-right: none; border-bottom: … }`, `.stepper-item:last-child { border-bottom: none; }`) so the two sets do not fight; the rules above replace them.

- [ ] **Step 4: Verify**

Run: `npm run build:client && npx prettier --check public/style.css`.

Manual check at 390×844 (Playwright `viewport: { width: 390, height: 844 }`, mocked API, on the preview step): each row is a card with the date bold top-left, the status pill top-right, issue under the date, hours right-aligned under the pill, then `REPOSITORIES:` and `DESCRIPTION:` lines; no horizontal scrolling anywhere on the page (`document.documentElement.scrollWidth <= window.innerWidth`); the stepper is a single row about 44 px tall; a toast appears at the top of the viewport and does not cover the Import button at the bottom. At 1280 px nothing changed.

- [ ] **Step 5: Commit**

```bash
npx prettier --write client public/style.css
npm run ci
git add client/render.ts public/style.css
git commit -m "feat: phone layout — preview rows as cards, toasts docked to the top, one-row stepper"
```

---

### Task 4: Control-boundary contrast, disabled primary button, and a contrast test (F5, F6)

**Files:**

- Modify: `public/style.css` (`:root` tokens, dark tokens, inputs, `.btn-primary:disabled`, `.repo-list`, `.table-wrap`)
- Create: `test/contrast.test.ts`
- Modify: `vitest.config.ts` (add the test to the `pure` project)

**Interfaces:**

- Produces: new tokens `--color-border-strong` (light `#8f8774`, dark `#5f6878`) used for form controls; `test/contrast.test.ts` parses the tokens from `public/style.css` and asserts WCAG ratios.

- [ ] **Step 1: Write the contrast test**

Create `test/contrast.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards the palette in public/style.css against silent contrast regressions.
 * Text pairs need 4.5:1 (WCAG 1.4.3), control boundaries 3:1 (WCAG 1.4.11).
 */
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}

const rootStart = css.indexOf(':root {');
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const light = tokens(css.slice(rootStart, darkStart));
const dark = tokens(css.slice(darkStart, css.indexOf('}', css.indexOf(':root', darkStart) + 200)));

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_PAIRS: [string, string][] = [
  ['color-text', 'color-surface'],
  ['color-text-muted', 'color-surface'],
  ['color-text-muted', 'color-surface-alt'],
  ['color-accent-contrast', 'color-accent'],
  ['color-accent', 'color-surface'],
  ['color-positive', 'color-positive-bg'],
  ['color-danger', 'color-danger-bg'],
  ['color-warning', 'color-warning-bg'],
  ['color-warning', 'color-surface'],
];
const BOUNDARY_PAIRS: [string, string][] = [['color-border-strong', 'color-surface']];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s palette', (_name, palette) => {
  it('defines every token the pairs use', () => {
    for (const [a, b] of [...TEXT_PAIRS, ...BOUNDARY_PAIRS]) {
      expect(palette[a], a).toBeDefined();
      expect(palette[b], b).toBeDefined();
    }
  });

  it.each(TEXT_PAIRS)('%s on %s reaches 4.5:1', (fg, bg) => {
    expect(ratio(palette[fg]!, palette[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(BOUNDARY_PAIRS)('%s on %s reaches 3:1', (fg, bg) => {
    expect(ratio(palette[fg]!, palette[bg]!)).toBeGreaterThanOrEqual(3);
  });
});
```

Register it: in `vitest.config.ts`, add `'test/contrast.test.ts',` to the `pure` project's `include` list.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project pure test/contrast.test.ts`
Expected: failures for `color-border-strong` being undefined in both palettes (the text pairs should already pass; if `color-warning` fails, the token name differs — read the `:root` block and fix the pair names, not the thresholds).

- [ ] **Step 3: Add the tokens and use them**

In `public/style.css` `:root`, after `--color-border: #d8d3c4;` add `--color-border-strong: #8f8774;`. In the dark `:root` block, after `--color-border: #333a46;` add `--color-border-strong: #5f6878;`.

Then use it for controls — change the shared input/select rule:

```css
input[type='text'],
input[type='password'],
input[type='search'],
input[type='date'],
input[type='time'],
input[type='number'],
select {
  /* unchanged declarations … */
  border: 1px solid var(--color-border-strong);
}
```

and `.repo-list { … border: 1px solid var(--color-border-strong); }`, `.btn-ghost { border-color: var(--color-border-strong); }`. Leave `.table-wrap`, `.panel`, row dividers and the stepper on `--color-border` — those are decorative separators, not control boundaries.

Replace the disabled button rule:

```css
.btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
```

with

```css
.btn:disabled {
  cursor: not-allowed;
}

.btn-primary:disabled {
  background: var(--color-surface-alt);
  color: var(--color-text-muted);
  border-color: var(--color-border);
}

.btn-ghost:disabled {
  opacity: 0.55;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project pure test/contrast.test.ts`
Expected: all pass. If `color-border-strong` on `color-surface` misses 3:1 in either palette, darken (light) or lighten (dark) the token until it passes and note the final value in the commit message.

Manual check: in dark mode the disabled "Continue to scope" button reads as a flat grey slab, not a brown clickable button; text inputs have a visible edge in both themes.

- [ ] **Step 5: Commit**

```bash
npx prettier --write public/style.css test/contrast.test.ts vitest.config.ts
npm run ci
git add public/style.css test/contrast.test.ts vitest.config.ts
git commit -m "fix: 3:1 control boundaries, flat disabled primary button, contrast regression test"
```

---

### Task 5: Copy and semantics — headings, panel intros, scan icon, Connected toast, one live region (F7, F8, F9, F10, F11)

**Files:**

- Modify: `public/index.html` (headings, intros, live regions)
- Modify: `client/icons.ts` (add `Radar`), `client/render.ts:70` (`mapping-continue` icon)
- Modify: `client/app.ts:318-323` (Connected toast)

**Interfaces:**

- Produces: `IconName` gains `'scan'` (Lucide `Radar`).

- [ ] **Step 1: Headings without numbers, an intro on every step**

In `public/index.html`:

- `<h2 id="step-connect-heading">1. Connect</h2>` → `Connect`; `2. Scope` → `Scope`; `3. Mapping` → `Mapping`; `4. Preview &amp; import` → `Preview &amp; import`.
- Step 2: replace `<p class="note">Only commits on each repository's default branch are counted.</p>` with
  ```html
  <p class="panel-intro">
    Pick the period and the repositories to read. Only your own activity is counted, and only
    commits on each repository's default branch.
  </p>
  ```
- Step 3: after `<h2 id="step-mapping-heading">Mapping</h2>` insert
  ```html
  <p class="panel-intro">
    Choose the Clockify workspace and project the entries go to, and how a day is shaped: each day
    with activity gets entries starting at the start time, adding up to the hours per day, in the
    timezone the dates are read in.
  </p>
  ```
- Step 4: after `<h2 id="step-preview-heading">Preview &amp; import</h2>` insert
  ```html
  <p class="panel-intro">
    One row per issue per day. Untick what you don't want, adjust hours if needed, then import. Days
    that already have entries in this project are marked as duplicates and skipped.
  </p>
  ```

Remove the now-unused `.note` rule from `public/style.css`.

- [ ] **Step 2: One announcement path**

In `public/index.html`:

- `#toasts`: remove `aria-live="polite" aria-relevant="additions"` (it stays a visual layer; `announce()` in app.ts is the screen-reader channel and already says the same thing).
- `#scan-status`: remove `role="status" aria-live="polite"` (progress text changes many times per scan; the start/finish are announced by `announce()`).
- Keep `#status-region`, `#connect-result` (`role="status"`), the two `role="alert"` banners, and `#preview-free-warning`.

Update the module comment at the top of `client/toast.ts` to say the container is not a live region on purpose.

- [ ] **Step 3: Scan icon and the Connected toast**

`client/icons.ts`: import `Radar` from `'lucide'` (alphabetical position, after `Plug`) and add `scan: Radar,` to `ICONS`. In `client/render.ts` `renderStaticIcons`, change the `mapping-continue` line to `setButtonLabel(el('mapping-continue') as HTMLButtonElement, 'scan', 'Scan activity');`. Search `render.ts` for any other `'filter', 'Scan activity'` (the scan-running relabel, if one exists) and switch it to `'scan'` too — the funnel now means "Scope" only.

`client/app.ts` Connected toast:

```ts
toaster.push({
  kind: 'success',
  title: 'Connected',
  message: `GitHub: ${ghResult.value.viewer.login} · Clockify: ${cfResult.value.user.name}`,
});
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx eslint client && npm run build:client && npx prettier --check public/index.html client`.

Manual check: step 3's CTA shows a radar icon; a mocked verify shows the toast "GitHub: … · Clockify: …"; every panel has a muted intro paragraph; `document.querySelectorAll('[aria-live]').length` on the page is 4 (`#connect-result`, `#duplicate-check-warning`, `#status-region`, plus `role=alert` implies live on `#plan-warning` — count `[aria-live], [role=alert], [role=status]` and expect no `#toasts` or `#scan-status` among them).

- [ ] **Step 5: Commit**

```bash
npx prettier --write public/index.html public/style.css client
npm run ci
git add public/index.html public/style.css client/icons.ts client/render.ts client/app.ts client/toast.ts
git commit -m "feat: plain headings with panel intros, radar scan icon, labelled Connected toast, one live region"
```

---

### Task 6: Scope step — derived dates stay readable, repository count (F12, F13)

**Files:**

- Modify: `client/app.ts:699-712` (`initFormFromState`) and `client/app.ts:852-870` (preset change handler)
- Modify: `client/render.ts:210-290` (`renderRepoList`)
- Modify: `public/index.html:276-281` (repo list + count line)
- Modify: `public/style.css`

**Interfaces:**

- Produces: `#repo-count` (`<p class="field-hint">`) under the list reading `N repositories · M selected` (with a filter: `N of T match "…" · M selected`); date inputs use `readOnly` + class `is-derived` instead of `disabled` when a preset drives them.

- [ ] **Step 1: readOnly instead of disabled for preset dates**

In `client/app.ts`, in BOTH places that currently do

```ts
startInput.disabled = true;
endInput.disabled = true;
```

replace with

```ts
startInput.readOnly = true;
endInput.readOnly = true;
startInput.classList.add('is-derived');
endInput.classList.add('is-derived');
```

and the `else` branches that do `startInput.disabled = false; endInput.disabled = false;` with

```ts
startInput.readOnly = false;
endInput.readOnly = false;
startInput.classList.remove('is-derived');
endInput.classList.remove('is-derived');
```

(`initFormFromState` has no `else` that re-enables — add the four lines to its `else` branch that assigns `startInput.value = s.prefs.startDate` so a stored "custom" preset starts editable.)

In `public/style.css` add after the shared input rule:

```css
input.is-derived {
  background: var(--color-surface-alt);
  border-style: dashed;
  cursor: default;
}
```

- [ ] **Step 2: Repository count under the list**

In `public/index.html`, after `</ul>` of `#repo-list` add:

```html
<p id="repo-count" class="field-hint" hidden></p>
```

In `client/render.ts` `renderRepoList`, at the top after `const selected = …` add `const count = el('repo-count');`, and in each early-return branch (loading, error, no repos) set `count.hidden = true;` before `return`. After the `visible` computation (it is used for the `Deselect all` label too) add:

```ts
count.hidden = false;
const selectedCount = state.prefs.selectedRepos.length;
count.textContent = needle
  ? `${visible.length} of ${repos.length} match "${repoFilter.trim()}" · ${selectedCount} selected`
  : `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'} · ${selectedCount} selected`;
```

Keep this before the `if (visible.length === 0)` early return so the "no match" state still shows the count.

Make the list's scrollbar visible on WebKit/Blink (macOS hides overlay scrollbars until scrolled), in `public/style.css` after `.repo-list { … }`:

```css
.repo-list::-webkit-scrollbar {
  width: 10px;
}

.repo-list::-webkit-scrollbar-thumb {
  background: var(--color-border-strong);
  border-radius: 999px;
  border: 2px solid var(--color-surface);
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npx eslint client && npm run build:client`.

Manual check (mocked API, 5 fixture repos): under the list `5 repositories · 0 selected`; tick two → `· 2 selected`; type `zzz` → `0 of 5 match "zzz" · 2 selected` above the "No repositories match" row; "This month" dates are shown in full contrast with a dashed border and cannot be edited; "Custom" makes them solid and editable.

- [ ] **Step 4: Commit**

```bash
npx prettier --write client public/index.html public/style.css
npm run ci
git add client/app.ts client/render.ts public/index.html public/style.css
git commit -m "feat: repository count under the list, preset dates read-only instead of greyed out"
```

---

### Task 7: Whole-flow browser verification

**Files:**

- Create: `/private/tmp/claude-501/-Users-michalzagalski-projects-gh2clockify/d1d42866-6b1c-45e8-96f2-5f674f6b7849/scratchpad/shots3/` (screenshots; not committed)

The mocked-API Playwright walkthrough from the review round lives at `…/scratchpad/shots2/walk.mjs` with `installMocks(page, { plan, searchDelayMs })` exported from `…/scratchpad/shots2/walklib.mjs`. Copy both into `shots3/`, point `OUT` at `shots3` and `BASE` at the dev server, run it (`npm run build:client && npx wrangler dev --port 8787`, then `node walk.mjs`), and check the screenshots against the manual checks listed in Tasks 2–6. Then run a second script that reproduces the Task 2 and Task 3 checks programmatically (unchecked rows after import, button label, `scrollWidth <= innerWidth` at 390 px, count line text). Record the results in the SDD ledger; fix anything that fails in the task that owns it and re-run.

---

## Self-review

- **Spec coverage:** F1 → Task 2; F2, F4, F14 → Task 3; F3 → Task 1; F5, F6 → Task 4; F7, F8, F9, F10, F11 → Task 5; F12, F13 → Task 6. The evaluator's item "results card below the action row" → Task 2 step 4.
- **Placeholder scan:** every code step carries the code; the two "search for other occurrences" instructions (Task 1 step 4 aggregate expectations, Task 5 step 3 scan icon) name the exact string to search for.
- **Type consistency:** `ApplyResult` fields (`ok`, `skipped`, `key`, `error`) match `src/types.ts`; `IconName` `'scan'` is defined in Task 5 before use in the same task; `--color-border-strong` is defined in Task 4 and used by Task 6's scrollbar rule (Task 6 runs after Task 4).
