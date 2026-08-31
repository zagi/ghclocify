/**
 * Pure `state -> DOM` rendering. No `fetch`, no state mutation, no event
 * wiring — app.ts owns every listener (mostly via event delegation on the
 * containers this module renders into) and calls these functions after every
 * state change. Visibility toggles use `el.hidden`; styling differences use
 * `classList`, never inline `style=` (the CSP forbids inline style/script
 * anyway) — the one exception is the progress bar's `width`, set through the
 * CSSOM (`el.style.width`), which is not what CSP's `style-src` restricts
 * (that governs `<style>` blocks and HTML `style="…"` attributes, not
 * runtime `element.style` writes) and is the only practical way to express a
 * continuously variable percentage against the existing `.progress-fill`
 * rule.
 */
import type { PlannedEntry } from '../src/types';
import type { State } from './state';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

function setText(id: string, text: string): void {
  el(id).textContent = text;
}

const WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });

/** `dateKey` is a local calendar day, already resolved by aggregate.ts — format
 *  it as a fixed calendar date (anchored at UTC noon) so the browser's own
 *  timezone can never shift which weekday is displayed. */
function weekdayLabel(dateKey: string): string {
  return WEEKDAY_FMT.format(new Date(`${dateKey}T12:00:00Z`));
}

// ---- stepper ----

export function renderStepper(state: State): void {
  for (let step = 1; step <= 4; step += 1) {
    const item = document.querySelector<HTMLElement>(`.stepper-item[data-step="${step}"]`);
    if (!item) continue;
    const link = item.querySelector('a');
    item.classList.toggle('is-current', step === state.step);
    item.classList.toggle('is-complete', step < state.step);
    if (link) {
      if (step === state.step) link.setAttribute('aria-current', 'step');
      else link.removeAttribute('aria-current');
    }
  }

  el('step-connect').hidden = state.step !== 1;
  el('step-scope').hidden = state.step !== 2;
  el('step-mapping').hidden = state.step !== 3;
  el('step-preview').hidden = state.step !== 4;
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
  verifyBtn.textContent = checking ? 'Verifying…' : 'Verify connection';

  const warning = el('plan-warning');
  const defaultWorkspace =
    connect.workspaces.find((w) => w.id === state.prefs.workspaceId) ?? connect.workspaces[0];
  if (bothOk && defaultWorkspace?.freeTier) {
    warning.hidden = false;
    const label = defaultWorkspace.plan === 'UNKNOWN' ? 'could not be determined' : 'is Free';
    const p = warning.querySelector('p');
    if (p) {
      p.textContent =
        defaultWorkspace.plan === 'UNKNOWN'
          ? `This workspace's plan ${label}, so we're assuming it's on Clockify's Free plan (30 API requests per hour, workspace-wide) to be safe. Large imports may be slow or need to be split up.`
          : `This workspace ${label} on Clockify, which allows only 30 API requests per hour, workspace-wide. Large imports may be slow or need to be split up.`;
    }
  } else {
    warning.hidden = true;
  }
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

  list.innerHTML = '';

  if (reposLoading) {
    const li = document.createElement('li');
    li.className = 'repo-list-empty';
    li.id = 'repo-list-empty';
    li.textContent = 'Loading repositories…';
    list.appendChild(li);
    return;
  }

  if (reposError) {
    const li = document.createElement('li');
    li.className = 'repo-list-empty';
    li.id = 'repo-list-empty';
    li.textContent = reposError;
    list.appendChild(li);
    return;
  }

  if (repos.length === 0) {
    const li = document.createElement('li');
    li.className = 'repo-list-empty';
    li.id = 'repo-list-empty';
    li.textContent = 'Verify your connection to load repositories.';
    list.appendChild(li);
    return;
  }

  const needle = repoFilter.trim().toLowerCase();
  const visible = needle ? repos.filter((r) => r.fullName.toLowerCase().includes(needle)) : repos;

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
}

// ---- step 4: scan progress ----

export function renderScanProgress(state: State): void {
  const { scan } = state;
  const wrap = el('scan-progress-wrap');

  if (scan.status === 'idle') {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
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

function statusPill(status: PlannedEntry['status']): HTMLElement {
  const span = document.createElement('span');
  span.className = `status-pill status-${status === 'duplicate' ? 'pending' : 'success'}`;
  span.textContent = status === 'duplicate' ? 'Duplicate' : 'New';
  return span;
}

export function renderPreviewTable(state: State): void {
  const wrap = el('preview-table-wrap');
  const totals = el('preview-totals');
  const rowsEl = el('preview-rows');
  const selectAll = el<HTMLInputElement>('preview-select-all');

  const plan = state.plan;

  if (!plan) {
    wrap.hidden = true;
    totals.hidden = true;
    rowsEl.innerHTML = '';
    (el('import-btn') as HTMLButtonElement).disabled = true;
    (el('import-btn') as HTMLButtonElement).textContent = 'Import entries';
    return;
  }

  wrap.hidden = false;
  rowsEl.innerHTML = '';

  if (plan.entries.length === 0) {
    totals.hidden = true;
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'table-empty';
    td.textContent = 'No activity found for this range.';
    tr.appendChild(td);
    rowsEl.appendChild(tr);
    (el('import-btn') as HTMLButtonElement).disabled = true;
    (el('import-btn') as HTMLButtonElement).textContent = 'Import entries';
    return;
  }

  totals.hidden = false;

  for (const entry of plan.entries) {
    const tr = document.createElement('tr');
    tr.dataset.date = entry.date;
    if (entry.status === 'duplicate') tr.classList.add('is-duplicate');

    const selectTd = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.dateCheckbox = entry.date;
    checkbox.checked = state.checkedDates.has(entry.date);
    checkbox.setAttribute('aria-label', `Include ${entry.date}`);
    selectTd.appendChild(checkbox);
    tr.appendChild(selectTd);

    const dateTd = document.createElement('td');
    dateTd.textContent = entry.date;
    tr.appendChild(dateTd);

    const dayTd = document.createElement('td');
    dayTd.textContent = weekdayLabel(entry.date);
    tr.appendChild(dayTd);

    const activityTd = document.createElement('td');
    activityTd.textContent = `${entry.activityCount} ${entry.activityCount === 1 ? 'activity' : 'activities'}`;
    tr.appendChild(activityTd);

    const reposTd = document.createElement('td');
    reposTd.textContent = entry.repos.join(', ');
    tr.appendChild(reposTd);

    const descTd = document.createElement('td');
    descTd.textContent = entry.description;
    tr.appendChild(descTd);

    const statusTd = document.createElement('td');
    statusTd.appendChild(statusPill(entry.status));
    if (entry.status === 'duplicate' && entry.existing) {
      const existingP = document.createElement('div');
      existingP.className = 'field-hint';
      existingP.textContent = `Existing: ${entry.existing.description || '(no description)'}`;
      statusTd.appendChild(existingP);
    }
    tr.appendChild(statusTd);

    rowsEl.appendChild(tr);
  }

  const selectedCount = plan.entries.filter((e) => state.checkedDates.has(e.date)).length;
  const selectedHours = plan.entries
    .filter((e) => state.checkedDates.has(e.date))
    .reduce((sum, e) => sum + (Date.parse(e.end) - Date.parse(e.start)) / 3_600_000, 0);
  totals.textContent = `${selectedCount} of ${plan.entries.length} days selected — ${selectedHours.toFixed(2)} hours`;

  selectAll.checked = selectedCount > 0 && selectedCount === plan.entries.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < plan.entries.length;

  // While an import is running, the same button doubles as Stop — it must
  // stay enabled so the user can click it to stop after the in-flight batch.
  const importing = state.importing.status === 'running';
  const importBtn = el('import-btn') as HTMLButtonElement;
  if (importing) {
    importBtn.disabled = false;
    importBtn.textContent = `Stop (${state.importing.completed} of ${state.importing.total} imported)`;
  } else {
    importBtn.disabled = selectedCount === 0;
    importBtn.textContent = 'Import entries';
  }

  (el('preview-back') as HTMLButtonElement).textContent =
    state.scan.status === 'running' ? 'Cancel scan' : 'Back';
}

// ---- step 4: import results ----

export function renderImportResults(state: State): void {
  const wrap = el('import-results');
  const list = el('import-results-list');
  const { importing } = state;

  if (importing.results.length === 0) {
    wrap.hidden = true;
    list.innerHTML = '';
    return;
  }

  wrap.hidden = false;
  list.innerHTML = '';
  for (const result of importing.results) {
    const li = document.createElement('li');
    const pill = document.createElement('span');
    if (result.ok && !result.skipped) {
      pill.className = 'status-pill status-success';
      pill.textContent = 'Imported';
    } else if (result.skipped) {
      pill.className = 'status-pill status-pending';
      pill.textContent = 'Already exists';
    } else {
      pill.className = 'status-pill status-error';
      pill.textContent = 'Failed';
    }
    li.appendChild(pill);
    li.appendChild(document.createTextNode(` ${result.date}`));
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
