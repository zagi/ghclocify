/**
 * Pure `state -> DOM` rendering. No `fetch`, no state mutation, no event
 * wiring — app.ts owns every listener (mostly via event delegation on the
 * containers this module renders into) and calls these functions after every
 * state change. Visibility toggles use `el.hidden`; styling differences use
 * `classList`, never inline `style=` (the CSP forbids inline style/script
 * anyway) — the exceptions are the progress bar's `width` and each preview
 * row's `--i` stagger index, both set through the CSSOM (`el.style.width`,
 * `el.style.setProperty('--i', …)`), which is not what CSP's `style-src`
 * restricts (that governs `<style>` blocks and HTML `style="…"` attributes,
 * not runtime `element.style` writes) and is the only practical way to
 * express a continuously variable percentage against the existing
 * `.progress-fill` rule, or a per-row animation delay against `#preview-rows
 * tr`.
 */
import { groupLabel } from '../src/aggregate';
import { APPLY_CHUNK, estimateImport, formatDuration, freeTierHours } from '../src/hours';
import { overflowingDates } from '../src/plan';
import type { ApplyResult, PlannedEntry } from '../src/types';
import { icon, type IconName } from './icons';
import type { State } from './state';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

function setText(id: string, text: string): void {
  el(id).textContent = text;
}

export function setButtonLabel(button: HTMLButtonElement, name: IconName, text: string): void {
  button.replaceChildren(
    icon(name),
    Object.assign(document.createElement('span'), { textContent: text }),
  );
}

/** Sets the static (never re-rendered) icons: the nav
 *  buttons whose label doesn't change across renders, the preview table's
 *  Issue/Hours column headers, and the alert icon inside the two warning
 *  banners. Called once from app.ts's `init()`, before the first `render()`. */
const STEP_ICONS: Record<number, IconName> = {
  1: 'connect',
  2: 'filter',
  3: 'mapping',
  4: 'upload',
};

/** The stepper badge shows the step's icon, or a check once the step is
 *  complete. The visible number was dropped: the badge is only 1.6rem wide and
 *  an icon and "01" could not share it. A `Step N:` prefix stays for screen
 *  readers as the badge's first child. */
function renderStepBadge(item: HTMLElement, complete: boolean): void {
  const badge = item.querySelector<HTMLElement>('.stepper-badge');
  if (!badge) return;
  const wanted = complete ? 'success' : STEP_ICONS[Number(item.dataset.step)];
  if (!wanted || badge.dataset.icon === wanted) return;
  badge.dataset.icon = wanted;
  badge.querySelector('svg')?.remove();
  badge.append(icon(wanted, { size: 14 }));
}

export function renderStaticIcons(): void {
  setButtonLabel(el('connect-continue') as HTMLButtonElement, 'next', 'Continue to scope');
  setButtonLabel(el('scope-back') as HTMLButtonElement, 'back', 'Back');
  setButtonLabel(el('scope-continue') as HTMLButtonElement, 'next', 'Continue to mapping');
  setButtonLabel(el('mapping-back') as HTMLButtonElement, 'back', 'Back');
  setButtonLabel(el('mapping-continue') as HTMLButtonElement, 'scan', 'Scan activity');
  const issueTh = document.querySelector<HTMLElement>('#preview-table-wrap th[data-col="issue"]');
  if (issueTh) issueTh.prepend(icon('hash', { size: 12 }));
  const hoursTh = document.querySelector<HTMLElement>('#preview-table-wrap th[data-col="hours"]');
  if (hoursTh) hoursTh.prepend(icon('clock', { size: 12 }));
  const planWarningP = document.querySelector<HTMLElement>('#plan-warning p');
  if (planWarningP) planWarningP.prepend(icon('alert'));
  const dupWarningP = document.querySelector<HTMLElement>('#duplicate-check-warning p');
  if (dupWarningP) dupWarningP.prepend(icon('alert'));
  el('coffee-link').prepend(icon('coffee', { size: 14 }));
  el('source-link').prepend(icon('code', { size: 14 }));
}

const WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });

/** `dateKey` is a local calendar day, already resolved by aggregate.ts — format
 *  it as a fixed calendar date (anchored at UTC noon) so the browser's own
 *  timezone can never shift which weekday is displayed. */
function weekdayLabel(dateKey: string): string {
  return WEEKDAY_FMT.format(new Date(`${dateKey}T12:00:00Z`));
}

// ---- stepper ----

let lastStep = 0;

export function renderStepper(state: State): void {
  for (let step = 1; step <= 4; step += 1) {
    const item = document.querySelector<HTMLElement>(`.stepper-item[data-step="${step}"]`);
    if (!item) continue;
    const link = item.querySelector('a');
    item.classList.toggle('is-current', step === state.step);
    item.classList.toggle('is-complete', step < state.step);
    renderStepBadge(item, step < state.step);
    if (link) {
      if (step === state.step) link.setAttribute('aria-current', 'step');
      else link.removeAttribute('aria-current');
    }
  }

  el('step-connect').hidden = state.step !== 1;
  el('step-scope').hidden = state.step !== 2;
  el('step-mapping').hidden = state.step !== 3;
  el('step-preview').hidden = state.step !== 4;
  document.querySelector('.page')?.classList.toggle('is-wide', state.step === 4);

  if (state.step !== lastStep) {
    for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
      panel.classList.remove('is-entering');
    }
    const stepPanelIds: Record<number, string> = {
      1: 'step-connect',
      2: 'step-scope',
      3: 'step-mapping',
      4: 'step-preview',
    };
    const currentId = stepPanelIds[state.step];
    if (currentId) el(currentId).classList.add('is-entering');
    lastStep = state.step;
  }
}

// ---- masthead ----

export function renderMasthead(hasStoredCreds: boolean): void {
  el('forget-btn').hidden = !hasStoredCreds;
}

// ---- step 1: connect ----

function renderCredentialResult(
  prefix: 'github' | 'clockify',
  status: State['connect']['githubStatus'],
  error: string | null,
  okText: string,
): void {
  const dd = el(`connect-${prefix === 'github' ? 'github-login' : 'clockify-user'}`);
  if (status === 'idle') dd.textContent = '—';
  else if (status === 'checking') dd.textContent = 'Checking…';
  else if (status === 'ok') dd.textContent = okText;
  else dd.textContent = error ?? 'Failed';
  dd.classList.toggle('is-error', status === 'error');
}

export function renderConnect(state: State): void {
  const { connect } = state;

  renderCredentialResult(
    'github',
    connect.githubStatus,
    connect.githubError,
    connect.viewer ? `Connected as ${connect.viewer.login}` : '',
  );
  renderCredentialResult(
    'clockify',
    connect.clockifyStatus,
    connect.clockifyError,
    connect.clockifyUser ? `Connected as ${connect.clockifyUser.name}` : '',
  );

  const showResult = connect.githubStatus !== 'idle' || connect.clockifyStatus !== 'idle';
  el('connect-result').hidden = !showResult;

  const bothOk = connect.githubStatus === 'ok' && connect.clockifyStatus === 'ok';
  (el('connect-continue') as HTMLButtonElement).disabled = !bothOk;

  const verifyBtn = el('verify-btn') as HTMLButtonElement;
  const checking = connect.githubStatus === 'checking' || connect.clockifyStatus === 'checking';
  verifyBtn.disabled = checking;
  setButtonLabel(verifyBtn, 'shield', checking ? 'Verifying…' : 'Verify connection');
}

// ---- step 2: scope ----

export function renderAccountOptions(state: State): void {
  const select = el<HTMLSelectElement>('scope-account');
  const wanted = state.prefs.accountKind === 'org' ? state.prefs.accountOrg : 'personal';

  // Rebuild only if the org set actually changed (cheap enough not to matter,
  // but avoids fighting the user's open dropdown on every unrelated render).
  const existingOrgValues = [...select.options].map((o) => o.value).filter((v) => v !== 'personal');
  const wantedOrgValues = state.connect.orgs.map((o) => o.login);
  const same =
    existingOrgValues.length === wantedOrgValues.length &&
    existingOrgValues.every((v, i) => v === wantedOrgValues[i]);
  if (!same) {
    select.innerHTML = '';
    const personalOpt = document.createElement('option');
    personalOpt.value = 'personal';
    personalOpt.textContent = 'Personal';
    select.appendChild(personalOpt);
    for (const org of state.connect.orgs) {
      const opt = document.createElement('option');
      opt.value = org.login;
      opt.textContent = org.login;
      select.appendChild(opt);
    }
  }
  select.value = wanted;
}

export function renderRepoList(state: State): void {
  const list = el('repo-list');
  const { repos, reposLoading, reposError, repoFilter } = state.scope;
  const selected = new Set(state.prefs.selectedRepos);
  const count = el('repo-count');

  list.innerHTML = '';

  if (reposLoading) {
    const li = document.createElement('li');
    li.className = 'repo-list-empty';
    li.id = 'repo-list-empty';
    li.textContent = 'Loading repositories…';
    list.appendChild(li);
    count.hidden = true;
    return;
  }

  if (reposError) {
    const li = document.createElement('li');
    li.className = 'repo-list-empty';
    li.id = 'repo-list-empty';
    li.textContent = reposError;
    list.appendChild(li);
    count.hidden = true;
    return;
  }

  if (repos.length === 0) {
    const li = document.createElement('li');
    li.className = 'repo-list-empty';
    li.id = 'repo-list-empty';
    li.textContent = 'Verify your connection to load repositories.';
    list.appendChild(li);
    count.hidden = true;
    return;
  }

  const needle = repoFilter.trim().toLowerCase();
  const visible = needle ? repos.filter((r) => r.fullName.toLowerCase().includes(needle)) : repos;
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.fullName));
  setText('repo-select-all', allVisibleSelected ? 'Deselect all' : 'Select all');

  count.hidden = false;
  const selectedCount = state.prefs.selectedRepos.length;
  count.textContent = needle
    ? `${visible.length} of ${repos.length} match "${repoFilter.trim()}" · ${selectedCount} selected`
    : `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'} · ${selectedCount} selected`;

  if (visible.length === 0) {
    const li = document.createElement('li');
    li.className = 'repo-list-empty';
    li.id = 'repo-list-empty';
    li.textContent = 'No repositories match that filter.';
    list.appendChild(li);
    return;
  }

  for (const repo of visible) {
    const li = document.createElement('li');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `repo-${repo.fullName}`;
    checkbox.dataset.repo = repo.fullName;
    checkbox.checked = selected.has(repo.fullName);

    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = repo.fullName;

    if (repo.private) {
      const tag = document.createElement('span');
      tag.className = 'duplicate-tag';
      tag.textContent = 'private';
      label.appendChild(document.createTextNode(' '));
      label.appendChild(tag);
    }
    if (repo.archived) {
      const tag = document.createElement('span');
      tag.className = 'duplicate-tag';
      tag.textContent = 'archived';
      label.appendChild(document.createTextNode(' '));
      label.appendChild(tag);
    }

    li.appendChild(checkbox);
    li.appendChild(label);
    list.appendChild(li);
  }
}

export function renderScope(state: State): void {
  renderAccountOptions(state);
  renderRepoList(state);

  const anySource = Object.values(state.prefs.sources).some(Boolean);
  const anyRepo = state.prefs.selectedRepos.length > 0;
  const datesValid =
    state.prefs.startDate !== '' &&
    state.prefs.endDate !== '' &&
    state.prefs.startDate <= state.prefs.endDate;
  (el('scope-continue') as HTMLButtonElement).disabled = !(anySource && anyRepo && datesValid);
}

// ---- step 3: mapping ----

function populateSelect(
  select: HTMLSelectElement,
  items: { id: string; label: string }[],
  wanted: string,
): void {
  const existing = [...select.options].map((o) => o.value);
  const incoming = items.map((i) => i.id);
  const same = existing.length === incoming.length && existing.every((v, i) => v === incoming[i]);
  if (!same) {
    select.innerHTML = '';
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.label;
      select.appendChild(opt);
    }
  }
  if (items.some((i) => i.id === wanted)) select.value = wanted;
  else if (items.length > 0) select.value = items[0]?.id ?? '';
}

export function renderMapping(state: State): void {
  const workspaceSelect = el<HTMLSelectElement>('mapping-workspace');
  populateSelect(
    workspaceSelect,
    state.connect.workspaces.map((w) => ({
      id: w.id,
      label:
        w.name +
        (w.freeTier
          ? w.plan === 'UNKNOWN'
            ? ' — plan unknown (treated as Free)'
            : ' — Free plan'
          : ''),
    })),
    state.prefs.workspaceId,
  );

  const projectSelect = el<HTMLSelectElement>('mapping-project');
  if (state.mapping.projectsLoading) {
    projectSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Loading projects…';
    projectSelect.appendChild(opt);
  } else {
    populateSelect(
      projectSelect,
      state.mapping.projects.map((p) => ({ id: p.id, label: p.name })),
      state.prefs.projectId,
    );
  }

  (el('hours-per-day') as HTMLInputElement).value = String(state.prefs.hoursPerDay);
  (el('start-time') as HTMLInputElement).value = state.prefs.startTime;
  (el('mapping-timezone') as HTMLInputElement).value = state.prefs.timezone;
  (el('mapping-billable') as HTMLInputElement).checked = state.prefs.billable;
  (el('mapping-weekends') as HTMLInputElement).checked = state.prefs.includeWeekends;

  const ready =
    state.prefs.workspaceId !== '' && state.prefs.projectId !== '' && state.prefs.hoursPerDay > 0;
  (el('mapping-continue') as HTMLButtonElement).disabled = !ready;

  // Keyed on the workspace actually selected in this step's own dropdown —
  // not step 1's default (workspaces[0]), which the user may have since
  // changed. Reads workspaceSelect.value (not state.prefs.workspaceId
  // directly) so it stays correct even while workspaces are still loading
  // and populateSelect has fallen back to a different option.
  const warning = el('plan-warning');
  const selectedWorkspace = state.connect.workspaces.find((w) => w.id === workspaceSelect.value);
  if (selectedWorkspace?.freeTier) {
    warning.hidden = false;
    const label = selectedWorkspace.plan === 'UNKNOWN' ? 'could not be determined' : 'is Free';
    const span = warning.querySelector('.banner-text');
    if (span) {
      span.textContent =
        selectedWorkspace.plan === 'UNKNOWN'
          ? `This workspace's plan ${label}, so we're assuming it's on Clockify's Free plan (30 API requests per hour, workspace-wide) to be safe. Large imports may be slow or need to be split up.`
          : `This workspace ${label} on Clockify, which allows only 30 API requests per hour, workspace-wide. Large imports may be slow or need to be split up.`;
    }
  } else {
    warning.hidden = true;
  }
}

// ---- step 4: scan progress ----

export function renderScanProgress(state: State): void {
  const { scan } = state;

  el('scan-progress').classList.toggle('is-running', scan.status === 'running');

  // A dedicated banner for a failed duplicate-check fetch, kept separate
  // from `scan.warnings` below (which is truncated to 3 entries) so this
  // never gets crowded out.
  const dupWarning = el('duplicate-check-warning');
  if (state.existingEntriesError) {
    dupWarning.hidden = false;
    const span = dupWarning.querySelector('.banner-text');
    if (span && span.textContent !== state.existingEntriesError) {
      span.textContent = state.existingEntriesError;
    }
  } else {
    dupWarning.hidden = true;
  }

  const wrap = el('scan-progress-wrap');

  if (scan.status === 'idle') {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  // The bar only means something while the scan runs; afterwards the status
  // line carries the result and a full bar read as a decorative underline.
  el('scan-progress').hidden = scan.status !== 'running';
  const pct = scan.status === 'running' ? scan.progress : 100;
  el('scan-progress').setAttribute('aria-valuenow', String(Math.round(pct)));
  el<HTMLElement>('scan-progress-fill').style.width = `${pct}%`;

  if (scan.status === 'running') {
    setText('scan-status', scan.statusText || 'Scanning…');
  } else if (scan.status === 'cancelled') {
    setText(
      'scan-status',
      `Scan cancelled — ${scan.activities.length} activities gathered so far.`,
    );
  } else if (scan.status === 'error') {
    setText('scan-status', scan.error ?? 'Scan failed.');
  } else {
    const shown = scan.warnings.slice(0, 3).join('; ');
    const more = scan.warnings.length > 3 ? '…' : '';
    const warningsText =
      scan.warnings.length > 0
        ? ` (${scan.warnings.length} warning${scan.warnings.length === 1 ? '' : 's'}: ${shown}${more})`
        : '';
    setText(
      'scan-status',
      `Scan complete — ${scan.activities.length} activities found.${warningsText}`,
    );
  }
}

// ---- step 4: preview table ----

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

function statusPill(status: PlannedEntry['status']): HTMLElement {
  const span = document.createElement('span');
  span.className = `status-pill status-${status === 'duplicate' ? 'pending' : 'success'}`;
  const isDuplicate = status === 'duplicate';
  span.append(
    icon(isDuplicate ? 'copy' : 'sparkles', { size: 12 }),
    document.createTextNode(isDuplicate ? 'Duplicate' : 'New'),
  );
  return span;
}

function hoursOf(entry: PlannedEntry): number {
  return (Date.parse(entry.end) - Date.parse(entry.start)) / 3_600_000;
}

type FocusCapture = {
  attr: 'hoursKey' | 'keyCheckbox';
  key: string;
  selectionStart: number | null;
  selectionEnd: number | null;
} | null;

/** The whole table is torn down and rebuilt on every render (`rowsEl.innerHTML
 *  = ''` below); without this, focus falls to `<body>` on every committed
 *  hours edit — breaking Tab, Enter, and spinner stepping between rows. Call
 *  before the rebuild, then `restoreFocus` after. */
function captureFocus(rowsEl: HTMLElement): FocusCapture {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !rowsEl.contains(active)) return null;

  if (active.dataset.hoursKey !== undefined) {
    let selectionStart: number | null;
    let selectionEnd: number | null;
    try {
      // `type=number` inputs return null (Chrome) or throw (Firefox) for
      // selection properties — either way, guarded here rather than assumed.
      selectionStart = active.selectionStart;
      selectionEnd = active.selectionEnd;
    } catch {
      selectionStart = null;
      selectionEnd = null;
    }
    return { attr: 'hoursKey', key: active.dataset.hoursKey, selectionStart, selectionEnd };
  }
  if (active.dataset.keyCheckbox !== undefined) {
    return {
      attr: 'keyCheckbox',
      key: active.dataset.keyCheckbox,
      selectionStart: null,
      selectionEnd: null,
    };
  }
  return null;
}

function restoreFocus(rowsEl: HTMLElement, capture: FocusCapture): void {
  if (!capture) return;
  const selector =
    capture.attr === 'hoursKey'
      ? `input[data-hours-key="${CSS.escape(capture.key)}"]`
      : `input[data-key-checkbox="${CSS.escape(capture.key)}"]`;
  const next = rowsEl.querySelector<HTMLInputElement>(selector);
  if (!next) return;
  next.focus();
  if (
    capture.attr === 'hoursKey' &&
    typeof capture.selectionStart === 'number' &&
    typeof capture.selectionEnd === 'number'
  ) {
    try {
      next.setSelectionRange(capture.selectionStart, capture.selectionEnd);
    } catch {
      // setSelectionRange is unsupported on type=number in some browsers.
    }
  }
}

let lastRowSetKey = '';

export function renderPreviewTable(state: State): void {
  const wrap = el('preview-table-wrap');
  const totals = el('preview-totals');
  const freeWarning = el('preview-free-warning');
  const rowsEl = el('preview-rows');
  const selectAll = el<HTMLInputElement>('preview-select-all');
  const focusCapture = captureFocus(rowsEl);

  const plan = state.plan;

  if (!plan) {
    wrap.hidden = true;
    totals.hidden = true;
    freeWarning.hidden = true;
    rowsEl.innerHTML = '';
    lastRowSetKey = '';
    (el('import-btn') as HTMLButtonElement).disabled = true;
    setButtonLabel(el('import-btn') as HTMLButtonElement, 'upload', 'Import entries');
    return;
  }

  // Inputs stay editable during an import while runImport writes from a
  // snapshot it took when the import started — editing them mid-import
  // would have no effect and could confuse the totals shown.
  const importingNow = state.importing.status === 'running';

  const splitEvenlyInput = el('split-evenly') as HTMLInputElement;
  splitEvenlyInput.checked = state.prefs.splitEvenly;
  splitEvenlyInput.disabled = importingNow;

  const notifyInput = el('notify-when-done') as HTMLInputElement;
  notifyInput.checked = state.prefs.notifyWhenDone;

  wrap.hidden = false;
  rowsEl.innerHTML = '';

  if (plan.entries.length === 0) {
    totals.hidden = true;
    freeWarning.hidden = true;
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 9;
    td.className = 'table-empty';
    td.textContent = 'No activity found for this range.';
    tr.appendChild(td);
    rowsEl.appendChild(tr);
    (el('import-btn') as HTMLButtonElement).disabled = true;
    setButtonLabel(el('import-btn') as HTMLButtonElement, 'upload', 'Import entries');
    return;
  }

  totals.hidden = false;
  rowsEl.classList.toggle('is-manual', !state.prefs.splitEvenly);

  const hint = el('split-evenly-hint');
  hint.textContent = state.prefs.splitEvenly
    ? 'Each GitHub issue gets its own entry. Uncheck to set the hours of every entry by hand — "Hours per day" then only seeds the values.'
    : 'Manual mode: type the hours for each entry in the Hours column (e.g. 1.5 or 1,5). Re-check to go back to an even split.';

  for (const [index, entry] of plan.entries.entries()) {
    const tr = document.createElement('tr');
    tr.dataset.date = entry.date;
    tr.style.setProperty('--i', String(Math.min(index, 20)));
    if (entry.status === 'duplicate') tr.classList.add('is-duplicate');

    const selectTd = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.keyCheckbox = entry.key;
    checkbox.checked = state.checkedKeys.has(entry.key);
    checkbox.disabled = importingNow;
    checkbox.setAttribute('aria-label', `Include ${entry.date} ${groupLabel(entry.group)}`);
    selectTd.appendChild(checkbox);
    tr.appendChild(selectTd);

    const dateTd = document.createElement('td');
    dateTd.className = 'date-cell';
    dateTd.dataset.label = 'Date';
    dateTd.textContent = entry.date;
    tr.appendChild(dateTd);

    const dayTd = document.createElement('td');
    dayTd.className = 'day-cell';
    dayTd.dataset.label = 'Day';
    dayTd.textContent = weekdayLabel(entry.date);
    tr.appendChild(dayTd);

    const issueTd = document.createElement('td');
    issueTd.className = 'issue-cell';
    issueTd.dataset.label = 'Issue';
    issueTd.textContent = groupLabel(entry.group);
    tr.appendChild(issueTd);

    const activityTd = document.createElement('td');
    activityTd.className = 'activity-cell';
    activityTd.dataset.label = 'Activity';
    activityTd.textContent = `${entry.activityCount} ${entry.activityCount === 1 ? 'activity' : 'activities'}`;
    tr.appendChild(activityTd);

    const reposTd = document.createElement('td');
    reposTd.className = 'repos-cell';
    reposTd.dataset.label = 'Repositories';
    reposTd.textContent = entry.repos.join(', ');
    tr.appendChild(reposTd);

    const descTd = document.createElement('td');
    descTd.className = 'description-cell';
    descTd.dataset.label = 'Description';
    descTd.textContent = entry.description;
    tr.appendChild(descTd);

    const hoursTd = document.createElement('td');
    hoursTd.className = 'hours-cell';
    hoursTd.dataset.label = 'Hours';
    if (state.prefs.splitEvenly) {
      hoursTd.textContent = hoursOf(entry).toFixed(2);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.className = 'hours-input';
      input.autocomplete = 'off';
      input.value = hoursOf(entry).toFixed(2);
      input.dataset.hoursKey = entry.key;
      input.disabled = importingNow;
      input.setAttribute('aria-label', `Hours for ${entry.date} ${groupLabel(entry.group)}`);
      hoursTd.appendChild(input);
    }
    tr.appendChild(hoursTd);

    const statusTd = document.createElement('td');
    statusTd.className = 'status-cell';
    statusTd.dataset.label = 'Status';
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
      const existingP = document.createElement('div');
      existingP.className = 'field-hint';
      existingP.textContent = `Existing: ${entry.existing.description || '(no description)'}`;
      statusTd.appendChild(existingP);
    }
    tr.appendChild(statusTd);

    rowsEl.appendChild(tr);
  }

  const rowSetKey = plan.entries.map((e) => e.key).join('\n');
  rowsEl.classList.toggle('is-entering', rowSetKey !== lastRowSetKey);
  lastRowSetKey = rowSetKey;

  restoreFocus(rowsEl, focusCapture);

  const selected = plan.entries.filter((e) => state.checkedKeys.has(e.key));
  const selectedCount = selected.length;
  const selectedHours = selected.reduce((sum, e) => sum + hoursOf(e), 0);
  const overflow = overflowingDates(selected, state.prefs.timezone);

  if (overflow.length > 0) {
    totals.classList.add('is-error');
    totals.textContent = `Entries on ${overflow.join(', ')} run past midnight — reduce their hours before importing.`;
  } else {
    totals.classList.remove('is-error');
    const { seconds } = estimateImport(selectedCount, APPLY_CHUNK);
    const prefix = state.prefs.splitEvenly ? '' : 'Manual hours — ';
    totals.textContent = `${prefix}${selectedCount} of ${plan.entries.length} entries selected — ${selectedHours.toFixed(2)} hours · import takes ~${formatDuration(seconds)}`;
  }

  const workspace = state.connect.workspaces.find((w) => w.id === state.prefs.workspaceId);
  if (workspace?.freeTier && selectedCount > 0) {
    const hours = freeTierHours(selectedCount, APPLY_CHUNK);
    freeWarning.hidden = false;
    const nextText =
      hours <= 1
        ? 'Free Clockify plan: 30 API requests per hour, workspace-wide. This import fits in one hour of quota, so run it once — a second run in the same hour may be rejected with 429.'
        : `Free Clockify plan: 30 API requests per hour, workspace-wide. This import needs about ${hours} hours and will start failing with 429 after roughly 24 entries — uncheck rows or import in stages.`;
    if (freeWarning.textContent !== nextText) freeWarning.textContent = nextText;
  } else {
    freeWarning.hidden = true;
  }

  selectAll.checked = selectedCount > 0 && selectedCount === plan.entries.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < plan.entries.length;
  selectAll.disabled = importingNow;

  // While an import is running, the same button doubles as Stop — it must
  // stay enabled so the user can click it to stop after the in-flight batch.
  const importBtn = el('import-btn') as HTMLButtonElement;
  if (importingNow) {
    importBtn.disabled = false;
    setButtonLabel(
      importBtn,
      'stop',
      `Stop (${state.importing.completed} of ${state.importing.total} imported)`,
    );
  } else {
    importBtn.disabled = selectedCount === 0 || overflow.length > 0;
    setButtonLabel(
      importBtn,
      'upload',
      selectedCount === 0
        ? 'Import entries'
        : `Import ${selectedCount} ${selectedCount === 1 ? 'entry' : 'entries'}`,
    );
  }

  const previewBack = el('preview-back') as HTMLButtonElement;
  if (state.scan.status === 'running') {
    setButtonLabel(previewBack, 'x', 'Cancel scan');
  } else {
    setButtonLabel(previewBack, 'back', 'Back');
  }
}

// ---- step 4: import results ----

// `freshFrom` marks where the most recent GROWTH of `importing.results`
// started; `lastResultCount` is the length as of the last render. Using the
// growth boundary (rather than "the length as of the last render", which a
// same-length re-render — e.g. the status flip to 'done' right after the
// final batch's results are appended — would immediately invalidate before
// the browser ever paints the `is-fresh` class) lets the newest batch's
// pills keep animating across renders that don't add any new results.
let freshFrom = 0;
let lastResultCount = 0;

export function renderImportResults(state: State): void {
  const wrap = el('import-results');
  const list = el('import-results-list');
  const { importing } = state;

  if (importing.results.length === 0) {
    wrap.hidden = true;
    list.innerHTML = '';
    freshFrom = 0;
    lastResultCount = 0;
    return;
  }

  if (importing.results.length > lastResultCount) {
    freshFrom = lastResultCount;
    lastResultCount = importing.results.length;
  }

  wrap.hidden = false;
  list.innerHTML = '';
  for (const [index, result] of importing.results.entries()) {
    const li = document.createElement('li');
    const pill = document.createElement('span');
    if (result.ok && !result.skipped) {
      pill.className = 'status-pill status-success';
      pill.append(icon('success', { size: 12 }), document.createTextNode('Imported'));
    } else if (result.skipped) {
      pill.className = 'status-pill status-pending';
      pill.append(icon('copy', { size: 12 }), document.createTextNode('Already exists'));
    } else {
      pill.className = 'status-pill status-error';
      pill.append(icon('alert', { size: 12 }), document.createTextNode('Failed'));
    }
    if (index >= freshFrom) pill.classList.add('is-fresh');
    li.appendChild(pill);
    const entry = state.plan?.entries.find((e) => e.key === result.key);
    const label = entry ? `${result.date} · ${groupLabel(entry.group)}` : result.date;
    li.appendChild(document.createTextNode(` ${label}`));
    if (!result.ok && result.error) {
      const detail = document.createElement('div');
      detail.className = 'field-hint';
      detail.textContent = result.error;
      li.appendChild(detail);
    }
    list.appendChild(li);
  }
}

// ---- top-level ----

export function renderAll(state: State, hasStoredCreds: boolean): void {
  renderStepper(state);
  renderMasthead(hasStoredCreds);
  renderConnect(state);
  renderScope(state);
  renderMapping(state);
  renderScanProgress(state);
  renderPreviewTable(state);
  renderImportResults(state);
}
