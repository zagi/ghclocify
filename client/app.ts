/**
 * Orchestration: wires the DOM to the store, drives the chunked scan and
 * import loops, and recomputes the preview plan locally whenever a mapping
 * setting changes. This file is the only one that calls `fetch` indirectly
 * (via ./api) and the only one that owns event listeners — ./render is pure
 * `state -> DOM`, ./state is the store, ./api is the HTTP wrapper.
 *
 * The browser is the orchestrator: every network call here is one small,
 * bounded piece of work (one repo-commits chunk, one search window, one
 * apply batch of <= 5 entries). This module holds the accumulating state,
 * drives the progress bar, and can be cancelled between chunks.
 */
import {
  ApiError,
  apply,
  clockifyContext,
  clockifyEntries,
  clockifyProjects,
  githubContext,
  githubRepos,
  scanCommits,
  scanSearch,
} from './api';
import type { ClockifyLocation, RepoScope } from './api';
import {
  clearStoredCredentials,
  createInitialState,
  createStore,
  hasStoredCredentials,
  saveStoredCredentials,
  savePrefs,
} from './state';
import type { DatePreset, ScanSourceKey, State } from './state';
import { renderAll, renderStaticIcons } from './render';
import { createToaster } from './toast';
import {
  notificationsSupported,
  notifyIfHidden,
  notifyPermissionGranted,
  requestNotifyPermission,
} from './notify';
import { aggregate } from '../src/aggregate';
import { APPLY_CHUNK } from '../src/hours';
import { buildPlan, overflowingDates, planFingerprint } from '../src/plan';
import { dayKey, isValidTimezone, utcOffsetLabel, utcRangeForLocalDays } from '../src/timezone';
import type { Activity, ImportSettings, ProposedEntry } from '../src/types';

// ---- small pure helpers ----

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function chunksOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Matches the server's `MAX_COMMIT_REPOS` (src/routes/scan.ts). */
const REPO_CHUNK = 8;
/** Matches the server's `MAX_SEARCH_WINDOW_DAYS` (src/routes/scan.ts). */
const SEARCH_WINDOW_DAYS = 31;
// APPLY_CHUNK is imported from src/hours.ts (mirrors the server's
// MAX_ENTRIES, src/routes/apply.ts). Batches are plain fixed-size chunks
// (`chunksOf`) — a day can now span several batches, because every request
// carries `dayStarts` for its days, which is what lets the route tell this
// import's earlier batches' entries from foreign ones instead of relying on
// batches being day-aligned.

function addDaysToKey(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

function firstOfMonth(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** Day 0 of the following month is the last day of this one. */
function lastOfMonth(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function shiftMonthFirst(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function computePresetRange(preset: DatePreset, tz: string): { start: string; end: string } | null {
  if (preset === 'custom') return null;
  const today = dayKey(Date.now(), tz);
  if (preset === 'this-month') return { start: firstOfMonth(today), end: lastOfMonth(today) };
  const prevFirst = shiftMonthFirst(firstOfMonth(today), -1);
  return { start: prevFirst, end: lastOfMonth(prevFirst) };
}

/** Splits `[startKey, endKey]` into windows of at most `SEARCH_WINDOW_DAYS`
 *  days, matching `/api/scan/search`'s per-request cap. */
function monthWindows(startKey: string, endKey: string): { startKey: string; endKey: string }[] {
  const windows: { startKey: string; endKey: string }[] = [];
  let cur = startKey;
  while (cur <= endKey) {
    const candidate = addDaysToKey(cur, SEARCH_WINDOW_DAYS);
    const end = candidate > endKey ? endKey : candidate;
    windows.push({ startKey: cur, endKey: end });
    cur = addDaysToKey(end, 1);
  }
  return windows;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unexpected error.';
}

/** These never recover mid-scan: every remaining chunk/window would fail
 *  the exact same way, so downgrading each to its own warning just floods
 *  the (3-warning-truncated) display with identical noise instead of
 *  surfacing the one thing the user actually needs to fix. */
const FATAL_SCAN_CODES = new Set([
  'invalid_credentials',
  'upstream_unauthorized',
  'upstream_saml_required',
]);

function isFatalScanError(err: unknown): boolean {
  return err instanceof ApiError && FATAL_SCAN_CODES.has(err.code);
}

function clockifyLocation(prefs: State['prefs']): ClockifyLocation {
  return { host: prefs.region, subdomain: prefs.subdomain };
}

function repoScope(prefs: State['prefs']): RepoScope {
  return prefs.accountKind === 'org'
    ? { kind: 'org', org: prefs.accountOrg }
    : { kind: 'personal' };
}

function scopeFingerprint(s: State): string {
  return JSON.stringify({
    kind: s.prefs.accountKind,
    org: s.prefs.accountOrg,
    repos: [...s.prefs.selectedRepos].sort(),
    start: s.prefs.startDate,
    end: s.prefs.endDate,
    sources: s.prefs.sources,
  });
}

function buildSettings(s: State): ImportSettings {
  return {
    hoursPerDay: s.prefs.hoursPerDay,
    startTime: s.prefs.startTime,
    timezone: s.prefs.timezone,
    includeWeekends: s.prefs.includeWeekends,
    billable: s.prefs.billable,
    workspaceId: s.prefs.workspaceId,
    projectId: s.prefs.projectId,
    repoAliases: {},
  };
}

function qs<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

function announce(text: string): void {
  qs('status-region').textContent = text;
}

// ---- store + render loop ----

const store = createStore(createInitialState());
const toaster = createToaster(qs('toasts'));

function render(): void {
  renderAll(store.getState(), hasStoredCredentials());
}

store.subscribe(render);

/**
 * Rule 1 of the brief: `entry.date` must always equal `localDayOf(entry.start,
 * timezone)`. The only way to guarantee that is to never patch dates/times on
 * an existing entry — always rebuild the whole plan from the raw activities.
 * Runs whenever any mapping setting (hours, start time, timezone, weekend
 * toggle, billable, project) changes, and after every scan/duplicate fetch.
 * Purely local: no network call.
 */
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

    // A row whose last import attempt failed (e.g. a same-day sibling wrote
    // successfully and flipped this entry's status new -> duplicate on the
    // post-import re-check) must stay checked so the one-click retry isn't
    // silently lost.
    const failedKeys = new Set(s.importing.results.filter((r) => !r.ok).map((r) => r.key));
    const nextChecked = new Set<string>();
    const liveKeys = new Set<string>();
    for (const entry of plan.entries) {
      liveKeys.add(entry.key);
      const previousEntry = previousPlan?.entries.find((e) => e.key === entry.key);
      const statusUnchanged = previousEntry && previousEntry.status === entry.status;
      if (
        previousEntry &&
        s.checkedKeys.has(entry.key) &&
        (statusUnchanged || failedKeys.has(entry.key))
      ) {
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

    // A changed fingerprint (different hours, project, split, timezone, …)
    // means the previous `importing.results` no longer describe what this
    // plan would write — stale "Imported"/"Failed" pills would be lying.
    // Never touch it while a batch is actually in flight.
    if (
      s.importing.status !== 'running' &&
      previousPlan &&
      planFingerprint(previousPlan.entries) !== planFingerprint(plan.entries)
    ) {
      s.importing = { status: 'idle', results: [], total: 0, completed: 0, stopRequested: false };
    }

    s.plan = plan;
    s.checkedKeys = nextChecked;
    s.entryHours = nextHours;
  });
}

/** Scope (dates/sources/repos/account) changed: cached activities and any
 *  derived plan are stale. Does NOT touch mapping settings (hours, timezone,
 *  etc.) — those recompute in place via recomputePlan(). */
function invalidateScan(): void {
  store.update((s) => {
    s.scan.activities = [];
    s.scan.warnings = [];
    s.scan.fingerprint = null;
    s.scan.status = 'idle';
    s.scan.progress = 0;
    s.existingEntries = [];
    s.existingEntriesFingerprint = null;
    s.existingEntriesError = null;
    s.plan = null;
    s.checkedKeys = new Set();
    s.entryHours = {};
    s.importing = { status: 'idle', results: [], total: 0, completed: 0, stopRequested: false };
  });
}

// ---- Connect ----

async function handleVerify(): Promise<void> {
  const s0 = store.getState();
  store.update((s) => {
    s.connect.githubStatus = 'checking';
    s.connect.githubError = null;
    s.connect.clockifyStatus = 'checking';
    s.connect.clockifyError = null;
  });

  const loc = clockifyLocation(s0.prefs);
  const [ghResult, cfResult] = await Promise.allSettled([
    githubContext(s0.credentials),
    clockifyContext(s0.credentials, loc),
  ]);

  store.update((s) => {
    if (ghResult.status === 'fulfilled') {
      s.connect.githubStatus = 'ok';
      s.connect.viewer = ghResult.value.viewer;
      s.connect.orgs = ghResult.value.orgs;
    } else {
      s.connect.githubStatus = 'error';
      s.connect.githubError = errorMessage(ghResult.reason);
    }
    if (cfResult.status === 'fulfilled') {
      s.connect.clockifyStatus = 'ok';
      s.connect.clockifyUser = cfResult.value.user;
      s.connect.workspaces = cfResult.value.workspaces;
      if (!s.prefs.workspaceId && cfResult.value.workspaces[0]) {
        s.prefs.workspaceId = cfResult.value.workspaces[0].id;
      }
    } else {
      s.connect.clockifyStatus = 'error';
      s.connect.clockifyError = errorMessage(cfResult.reason);
    }
  });
  savePrefs(store.getState().prefs);

  if (ghResult.status === 'rejected') {
    toaster.push({
      kind: 'error',
      title: 'GitHub connection failed',
      message: errorMessage(ghResult.reason),
    });
  }
  if (cfResult.status === 'rejected') {
    toaster.push({
      kind: 'error',
      title: 'Clockify connection failed',
      message: errorMessage(cfResult.reason),
    });
  }
  if (ghResult.status === 'fulfilled' && cfResult.status === 'fulfilled') {
    toaster.push({
      kind: 'success',
      title: 'Connected',
      message: `GitHub: ${ghResult.value.viewer.login} · Clockify: ${cfResult.value.user.name}`,
    });
  }
}

// ---- Scope ----

async function loadRepos(): Promise<void> {
  const s0 = store.getState();
  if (s0.prefs.accountKind === 'org' && !s0.prefs.accountOrg) return;
  const fp = `${s0.prefs.accountKind}:${s0.prefs.accountOrg}`;
  if (s0.scope.reposFingerprint === fp && s0.scope.repos.length > 0) return;

  store.update((s) => {
    s.scope.reposLoading = true;
    s.scope.reposError = null;
  });
  try {
    const { repos } = await githubRepos(s0.credentials, repoScope(s0.prefs));
    store.update((s) => {
      s.scope.repos = repos;
      s.scope.reposLoading = false;
      s.scope.reposFingerprint = fp;
    });
  } catch (err) {
    const message = errorMessage(err);
    store.update((s) => {
      s.scope.reposLoading = false;
      s.scope.reposError = message;
    });
    toaster.push({ kind: 'error', title: "Couldn't load repositories", message });
    announce(`Couldn't load repositories: ${message}`);
  }
}

// ---- Mapping ----

async function loadProjects(): Promise<void> {
  const s0 = store.getState();
  if (!s0.prefs.workspaceId) return;
  if (s0.mapping.projectsWorkspaceId === s0.prefs.workspaceId && s0.mapping.projects.length > 0)
    return;

  store.update((s) => {
    s.mapping.projectsLoading = true;
    s.mapping.projectsError = null;
  });
  try {
    const loc = clockifyLocation(s0.prefs);
    const { projects } = await clockifyProjects(s0.credentials, loc, s0.prefs.workspaceId);
    store.update((s) => {
      s.mapping.projects = projects;
      s.mapping.projectsLoading = false;
      s.mapping.projectsWorkspaceId = s0.prefs.workspaceId;
      if (!projects.some((p) => p.id === s.prefs.projectId)) {
        s.prefs.projectId = projects[0]?.id ?? '';
      }
    });
    savePrefs(store.getState().prefs);
  } catch (err) {
    const message = errorMessage(err);
    store.update((s) => {
      s.mapping.projectsLoading = false;
      s.mapping.projectsError = message;
    });
    toaster.push({ kind: 'error', title: "Couldn't load projects", message });
    announce(`Couldn't load projects: ${message}`);
  }
}

// ---- Scan orchestration ----

function labelForSource(key: 'pull_request' | 'issue' | 'review'): string {
  if (key === 'pull_request') return 'pull requests';
  if (key === 'issue') return 'issues';
  return 'reviews';
}

async function runScan(): Promise<void> {
  const s0 = store.getState();
  const login = s0.connect.viewer?.login;
  if (!login) return;
  // Re-entrancy guard: two loops sharing `s.scan` would clobber each other's
  // progress and cancel flag.
  if (s0.scan.status === 'running') return;

  const scope = repoScope(s0.prefs);
  const repos = [...s0.prefs.selectedRepos];
  const { startDate, endDate, sources } = s0.prefs;
  const tz = s0.prefs.timezone;

  store.update((s) => {
    s.scan.status = 'running';
    s.scan.progress = 0;
    s.scan.activities = [];
    s.scan.warnings = [];
    s.scan.error = null;
    s.scan.cancelRequested = false;
    s.scan.statusText = 'Starting scan…';
    s.plan = null;
    s.importing = { status: 'idle', results: [], total: 0, completed: 0, stopRequested: false };
  });
  announce('Scan started.');

  const commitChunks = sources.commits ? chunksOf(repos, REPO_CHUNK) : [];
  const searchSources: ('pull_request' | 'issue' | 'review')[] = [];
  if (sources.pulls) searchSources.push('pull_request');
  if (sources.issues) searchSources.push('issue');
  if (sources.reviews) searchSources.push('review');
  const windows = monthWindows(startDate, endDate);
  const totalChunks = commitChunks.length + searchSources.length * windows.length;
  let doneChunks = 0;

  const activities: Activity[] = [];
  const warnings: string[] = [];
  let incompleteAny = false;
  let fatalError: string | null = null;

  const { sinceIso, untilIso } = utcRangeForLocalDays(startDate, endDate, tz);

  for (const chunk of commitChunks) {
    if (store.getState().scan.cancelRequested) break;
    store.update((s) => {
      s.scan.statusText = `Fetching commits (${doneChunks + 1} of ${totalChunks})…`;
    });
    try {
      const result = await scanCommits(s0.credentials, { repos: chunk, login, sinceIso, untilIso });
      activities.push(...result.activities);
      warnings.push(...result.warnings);
    } catch (err) {
      if (isFatalScanError(err)) {
        fatalError = errorMessage(err);
        break;
      }
      warnings.push(errorMessage(err));
    }
    doneChunks += 1;
    store.update((s) => {
      s.scan.progress = (doneChunks / Math.max(totalChunks, 1)) * 100;
    });
  }

  searchLoop: for (const source of searchSources) {
    if (fatalError) break;
    for (const window of windows) {
      if (store.getState().scan.cancelRequested) break searchLoop;
      store.update((s) => {
        s.scan.statusText = `Searching ${labelForSource(source)} (${doneChunks + 1} of ${totalChunks})…`;
      });
      try {
        const offsetLabel = utcOffsetLabel(window.startKey, tz);
        const result = await scanSearch(s0.credentials, {
          source,
          login,
          scope,
          repos,
          startKey: window.startKey,
          endKey: window.endKey,
          offsetLabel,
        });
        activities.push(...result.activities);
        warnings.push(...result.warnings);
        if (result.incomplete) incompleteAny = true;
      } catch (err) {
        if (isFatalScanError(err)) {
          fatalError = errorMessage(err);
          break searchLoop;
        }
        warnings.push(errorMessage(err));
      }
      doneChunks += 1;
      store.update((s) => {
        s.scan.progress = (doneChunks / Math.max(totalChunks, 1)) * 100;
      });
      // GitHub Search allows 30 requests/minute; pace between windows.
      if (doneChunks < totalChunks) await sleep(2000);
    }
  }

  if (fatalError) {
    store.update((s) => {
      s.scan.status = 'error';
      s.scan.error = fatalError;
      s.scan.progress = 100;
    });
    announce('Scan failed.');
    toaster.push({ kind: 'error', title: 'Scan failed', message: fatalError });
    if (store.getState().prefs.notifyWhenDone) notifyIfHidden('Scan failed', fatalError);
    return;
  }

  if (incompleteAny) {
    warnings.push('GitHub returned partial search results — try a narrower range.');
  }

  const cancelled = store.getState().scan.cancelRequested;
  store.update((s) => {
    s.scan.activities = activities;
    s.scan.warnings = warnings;
    s.scan.status = cancelled ? 'cancelled' : 'done';
    s.scan.progress = 100;
    s.scan.fingerprint = scopeFingerprint(s);
  });
  announce(cancelled ? 'Scan cancelled.' : `Scan complete: ${activities.length} activities found.`);
  if (cancelled) {
    const message = `${activities.length} activities gathered`;
    toaster.push({ kind: 'warning', title: 'Scan cancelled', message });
    if (store.getState().prefs.notifyWhenDone) notifyIfHidden('Scan cancelled', message);
  } else {
    const message =
      warnings.length > 0
        ? `${activities.length} activities found, ${warnings.length} warnings`
        : `${activities.length} activities found`;
    toaster.push({ kind: 'success', title: 'Scan complete', message });
    if (store.getState().prefs.notifyWhenDone) notifyIfHidden('Scan complete', message);
  }

  if (!cancelled) await loadExistingEntriesAndRecompute();
  else recomputePlan();
}

async function loadExistingEntriesAndRecompute(): Promise<void> {
  const s0 = store.getState();
  const { startDate, endDate, timezone, workspaceId } = s0.prefs;
  if (!workspaceId || !s0.connect.clockifyUser) {
    recomputePlan();
    return;
  }
  const fp = `${workspaceId}:${startDate}:${endDate}:${timezone}`;
  if (s0.existingEntriesFingerprint !== fp) {
    try {
      const { sinceIso, untilIso } = utcRangeForLocalDays(startDate, endDate, timezone);
      const loc = clockifyLocation(s0.prefs);
      const { entries } = await clockifyEntries(
        s0.credentials,
        loc,
        workspaceId,
        s0.connect.clockifyUser.id,
        sinceIso,
        untilIso,
      );
      store.update((s) => {
        s.existingEntries = entries;
        s.existingEntriesFingerprint = fp;
        s.existingEntriesError = null;
      });
    } catch (err) {
      const message = errorMessage(err);
      // A dedicated banner, not folded into scan.warnings: that list is
      // truncated to 3 in the UI, and a handful of routine repo warnings
      // ahead of this one would make the message that the duplicate
      // preview is unreliable invisible -- every day would show "New" with
      // no visible explanation of why the check couldn't be trusted.
      store.update((s) => {
        s.existingEntriesError = `Could not check for duplicate entries: ${message}`;
      });
      toaster.push({ kind: 'warning', title: "Couldn't check for duplicates", message });
    }
  }
  recomputePlan();
}

// ---- Import orchestration ----

async function runImport(): Promise<void> {
  const s0 = store.getState();
  if (!s0.plan) return;
  const checked = s0.plan.entries.filter((e) => s0.checkedKeys.has(e.key));
  if (checked.length === 0) return;
  // Mirrors the apply route's own rejection (entry.date must be the local
  // day of entry.start); render.ts already disables the button in this
  // state, this is the belt to that brace.
  if (overflowingDates(checked, s0.prefs.timezone).length > 0) return;

  // Keep results for keys not being retried this run — a retry of only the
  // failed rows must not erase the earlier successes' "Imported" pills.
  const retried = new Set(checked.map((e) => e.key));
  store.update((s) => {
    s.importing = {
      status: 'running',
      results: s.importing.results.filter((r) => !retried.has(r.key)),
      total: checked.length,
      completed: 0,
      stopRequested: false,
    };
  });
  announce(`Import started: ${checked.length} entries.`);

  const userId = s0.connect.clockifyUser?.id ?? '';
  const batches = chunksOf(checked, APPLY_CHUNK);

  // Every planned start for each day we are about to touch — checked or not —
  // so the route can tell our earlier batches' entries from foreign ones
  // (see decideWrite in src/plan.ts).
  const touchedDays = new Set(checked.map((e) => e.date));
  const dayStarts: Record<string, string[]> = {};
  for (const e of s0.plan.entries) {
    if (!touchedDays.has(e.date)) continue;
    (dayStarts[e.date] ??= []).push(e.start);
  }

  for (const [batchIndex, batch] of batches.entries()) {
    if (store.getState().importing.stopRequested) break;
    // Modest inter-batch pacing, same idea as runScan's 2s sleep between
    // search windows: RL_IP is 30 requests/60s keyed on CF-Connecting-IP,
    // and users behind corporate NAT share that key with everyone else
    // behind it. Firing every batch back-to-back has no reason to be fast
    // enough to matter and every reason to collide with someone else's
    // budget.
    if (batchIndex > 0) await sleep(2000);
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
    try {
      const { results } = await apply(s0.credentials, {
        host: s0.prefs.region,
        subdomain: s0.prefs.subdomain || undefined,
        workspaceId: s0.prefs.workspaceId,
        userId,
        timezone: s0.prefs.timezone,
        entries: proposed,
        dayStarts,
      });
      store.update((s) => {
        s.importing.results = [...s.importing.results, ...results];
        s.importing.completed += results.length;
      });
    } catch (err) {
      const message = errorMessage(err);
      store.update((s) => {
        s.importing.results = [
          ...s.importing.results,
          ...batch.map((e) => ({ date: e.date, key: e.key, ok: false, error: message })),
        ];
        s.importing.completed += batch.length;
      });
      toaster.push({ kind: 'error', title: 'Import request failed', message });
    }
  }

  const stopped = store.getState().importing.stopRequested;

  store.update((s) => {
    s.importing.status = 'done';
    // Imported and already-existing entries are done; only failures stay
    // selected, so the next click on "Import" retries exactly those.
    const next = new Set(s.checkedKeys);
    for (const r of s.importing.results) if (r.ok) next.delete(r.key);
    s.checkedKeys = next;
  });

  // Force a re-fetch of existing entries so the plan itself becomes
  // truthful: imported rows flip to `duplicate`, failed rows stay `new`.
  store.update((s) => {
    s.existingEntriesFingerprint = null;
  });
  await loadExistingEntriesAndRecompute();

  if (stopped) {
    const { completed, total } = store.getState().importing;
    const message = `${completed} of ${total} written`;
    announce(`Import stopped: ${message}`);
    toaster.push({ kind: 'warning', title: 'Import stopped', message });
    if (store.getState().prefs.notifyWhenDone) notifyIfHidden('Import stopped', message);
    return;
  }

  announce('Import finished.');

  const results = store.getState().importing.results;
  const imported = results.filter((r) => r.ok && !r.skipped).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  const importMessage = `${imported} imported · ${skippedCount} already existed · ${failed} failed`;
  toaster.push({
    kind: failed > 0 ? 'warning' : 'success',
    title: 'Import finished',
    message: importMessage,
  });
  if (store.getState().prefs.notifyWhenDone) notifyIfHidden('Import finished', importMessage);
}

// ---- DOM wiring ----

function initFormFromState(): void {
  const s = store.getState();

  qs<HTMLInputElement>('gh-pat').value = s.credentials.github;
  qs<HTMLInputElement>('clockify-key').value = s.credentials.clockify;
  qs<HTMLSelectElement>('clockify-region').value = s.prefs.region;
  qs<HTMLInputElement>('clockify-subdomain').value = s.prefs.subdomain;
  qs<HTMLInputElement>('remember').checked = s.prefs.remember;

  const presetRadio = document.querySelector<HTMLInputElement>(
    `input[name="date-preset"][value="${s.prefs.datePreset}"]`,
  );
  if (presetRadio) presetRadio.checked = true;

  const startInput = qs<HTMLInputElement>('scope-start');
  const endInput = qs<HTMLInputElement>('scope-end');
  const range = computePresetRange(s.prefs.datePreset, s.prefs.timezone);
  if (range) {
    store.update((st) => {
      st.prefs.startDate = range.start;
      st.prefs.endDate = range.end;
    });
    startInput.value = range.start;
    endInput.value = range.end;
    startInput.readOnly = true;
    endInput.readOnly = true;
    startInput.classList.add('is-derived');
    endInput.classList.add('is-derived');
  } else {
    startInput.value = s.prefs.startDate;
    endInput.value = s.prefs.endDate;
    startInput.readOnly = false;
    endInput.readOnly = false;
    startInput.classList.remove('is-derived');
    endInput.classList.remove('is-derived');
  }

  qs<HTMLInputElement>('source-commits').checked = s.prefs.sources.commits;
  qs<HTMLInputElement>('source-pulls').checked = s.prefs.sources.pulls;
  qs<HTMLInputElement>('source-issues').checked = s.prefs.sources.issues;
  qs<HTMLInputElement>('source-reviews').checked = s.prefs.sources.reviews;

  qs<HTMLInputElement>('split-evenly').checked = s.prefs.splitEvenly;

  const notifyField = qs('notify-field');
  notifyField.hidden = !notificationsSupported();
  if (s.prefs.notifyWhenDone && !notifyPermissionGranted()) {
    store.update((st) => {
      st.prefs.notifyWhenDone = false;
    });
  }
  qs<HTMLInputElement>('notify-when-done').checked = store.getState().prefs.notifyWhenDone;

  savePrefs(store.getState().prefs);
}

function wireConnectStep(): void {
  qs('connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void handleVerify();
  });

  qs<HTMLInputElement>('gh-pat').addEventListener('input', (e) => {
    const value = (e.target as HTMLInputElement).value;
    store.update((s) => {
      s.credentials.github = value;
      // A changed token invalidates any previous verification: without
      // this, a user can verify with token A, paste token B, and keep a
      // green "verified" badge (and an enabled Continue) while every
      // downstream call actually runs as token B. Force a re-verify.
      s.connect.githubStatus = 'idle';
      s.connect.githubError = null;
      s.connect.viewer = null;
      s.connect.orgs = [];
    });
    if (store.getState().prefs.remember) {
      saveStoredCredentials(
        store.getState().credentials.github,
        store.getState().credentials.clockify,
      );
    }
  });
  qs<HTMLInputElement>('clockify-key').addEventListener('input', (e) => {
    const value = (e.target as HTMLInputElement).value;
    store.update((s) => {
      s.credentials.clockify = value;
      // Same reasoning as the GitHub token above: this is the exact bug
      // finding #4 in the review closes — verify with key A, paste key B,
      // keep a green badge, and import with A's userId under B's key.
      s.connect.clockifyStatus = 'idle';
      s.connect.clockifyError = null;
      s.connect.clockifyUser = null;
      s.connect.workspaces = [];
    });
    if (store.getState().prefs.remember) {
      saveStoredCredentials(
        store.getState().credentials.github,
        store.getState().credentials.clockify,
      );
    }
  });

  qs<HTMLSelectElement>('clockify-region').addEventListener('change', (e) => {
    const value = (e.target as HTMLSelectElement).value;
    store.update((s) => {
      s.prefs.region = value;
      // The region/subdomain choice picks which Clockify account "clockify
      // key" is even verified against — changing it stales the same way a
      // changed key does.
      s.connect.clockifyStatus = 'idle';
      s.connect.clockifyError = null;
      s.connect.clockifyUser = null;
      s.connect.workspaces = [];
    });
    savePrefs(store.getState().prefs);
  });
  qs<HTMLInputElement>('clockify-subdomain').addEventListener('change', (e) => {
    const value = (e.target as HTMLInputElement).value;
    store.update((s) => {
      s.prefs.subdomain = value;
      s.connect.clockifyStatus = 'idle';
      s.connect.clockifyError = null;
      s.connect.clockifyUser = null;
      s.connect.workspaces = [];
    });
    savePrefs(store.getState().prefs);
  });

  qs<HTMLInputElement>('remember').addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    store.update((s) => {
      s.prefs.remember = checked;
    });
    savePrefs(store.getState().prefs);
    if (checked) {
      const creds = store.getState().credentials;
      saveStoredCredentials(creds.github, creds.clockify);
    } else {
      clearStoredCredentials();
    }
  });

  qs('forget-btn').addEventListener('click', () => {
    clearStoredCredentials();
    store.update((s) => {
      s.credentials = { github: '', clockify: '' };
      s.prefs.remember = false;
      s.connect = {
        githubStatus: 'idle',
        githubError: null,
        clockifyStatus: 'idle',
        clockifyError: null,
        viewer: null,
        orgs: [],
        clockifyUser: null,
        workspaces: [],
      };
    });
    savePrefs(store.getState().prefs);
    qs<HTMLInputElement>('gh-pat').value = '';
    qs<HTMLInputElement>('clockify-key').value = '';
    qs<HTMLInputElement>('remember').checked = false;
  });

  qs('connect-continue').addEventListener('click', () => {
    store.update((s) => {
      s.step = 2;
    });
    void loadRepos();
  });
}

function wireScopeStep(): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="date-preset"]')) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const preset = radio.value as DatePreset;
      const startInput = qs<HTMLInputElement>('scope-start');
      const endInput = qs<HTMLInputElement>('scope-end');
      const range = computePresetRange(preset, store.getState().prefs.timezone);
      if (range) {
        startInput.value = range.start;
        endInput.value = range.end;
        startInput.readOnly = true;
        endInput.readOnly = true;
        startInput.classList.add('is-derived');
        endInput.classList.add('is-derived');
      } else {
        startInput.readOnly = false;
        endInput.readOnly = false;
        startInput.classList.remove('is-derived');
        endInput.classList.remove('is-derived');
      }
      store.update((s) => {
        s.prefs.datePreset = preset;
        s.prefs.startDate = startInput.value;
        s.prefs.endDate = endInput.value;
      });
      savePrefs(store.getState().prefs);
      invalidateScan();
    });
  }

  qs<HTMLInputElement>('scope-start').addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement).readOnly) return;
    const value = (e.target as HTMLInputElement).value;
    store.update((s) => {
      s.prefs.startDate = value;
    });
    savePrefs(store.getState().prefs);
    invalidateScan();
  });
  qs<HTMLInputElement>('scope-end').addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement).readOnly) return;
    const value = (e.target as HTMLInputElement).value;
    store.update((s) => {
      s.prefs.endDate = value;
    });
    savePrefs(store.getState().prefs);
    invalidateScan();
  });

  const sourceMap: Record<string, ScanSourceKey> = {
    'source-commits': 'commits',
    'source-pulls': 'pulls',
    'source-issues': 'issues',
    'source-reviews': 'reviews',
  };
  for (const [id, key] of Object.entries(sourceMap)) {
    qs<HTMLInputElement>(id).addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      store.update((s) => {
        s.prefs.sources[key] = checked;
      });
      savePrefs(store.getState().prefs);
      invalidateScan();
    });
  }

  qs<HTMLSelectElement>('scope-account').addEventListener('change', (e) => {
    const value = (e.target as HTMLSelectElement).value;
    store.update((s) => {
      s.prefs.accountKind = value === 'personal' ? 'personal' : 'org';
      s.prefs.accountOrg = value === 'personal' ? '' : value;
      s.prefs.selectedRepos = [];
    });
    savePrefs(store.getState().prefs);
    invalidateScan();
    void loadRepos();
  });

  qs<HTMLInputElement>('repo-filter').addEventListener('input', (e) => {
    const value = (e.target as HTMLInputElement).value;
    store.update((s) => {
      s.scope.repoFilter = value;
    });
  });

  qs('repo-select-all').addEventListener('click', () => {
    const s0 = store.getState();
    const needle = s0.scope.repoFilter.trim().toLowerCase();
    const visible = needle
      ? s0.scope.repos.filter((r) => r.fullName.toLowerCase().includes(needle))
      : s0.scope.repos;
    const allSelected =
      visible.length > 0 && visible.every((r) => s0.prefs.selectedRepos.includes(r.fullName));
    store.update((s) => {
      const set = new Set(s.prefs.selectedRepos);
      for (const r of visible) {
        if (allSelected) set.delete(r.fullName);
        else set.add(r.fullName);
      }
      s.prefs.selectedRepos = [...set];
    });
    savePrefs(store.getState().prefs);
    invalidateScan();
  });

  qs('repo-list').addEventListener('change', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || !target.dataset.repo) return;
    const repo = target.dataset.repo;
    store.update((s) => {
      const set = new Set(s.prefs.selectedRepos);
      if (target.checked) set.add(repo);
      else set.delete(repo);
      s.prefs.selectedRepos = [...set];
    });
    savePrefs(store.getState().prefs);
    invalidateScan();
  });

  // Completed steps in the stepper are links back to that step; the current
  // and future ones stay inert (the panel would be empty).
  document.querySelector('.stepper')?.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('.stepper-item a');
    if (!link) return;
    e.preventDefault();
    const item = link.closest<HTMLElement>('.stepper-item');
    const target = Number(item?.dataset.step);
    if (!item?.classList.contains('is-complete') || !(target >= 1 && target <= 3)) return;
    // Same rule as the preview Back button: while a scan or import runs,
    // step 4 holds the only Cancel/Stop control, so stay on it.
    const current = store.getState();
    if (current.scan.status === 'running' || current.importing.status === 'running') return;
    store.update((s) => {
      s.step = target as 1 | 2 | 3;
    });
  });

  qs('scope-back').addEventListener('click', () => {
    store.update((s) => {
      s.step = 1;
    });
  });
  qs('scope-continue').addEventListener('click', () => {
    store.update((s) => {
      s.step = 3;
    });
    void loadProjects();
  });
}

function wireMappingStep(): void {
  qs<HTMLSelectElement>('mapping-workspace').addEventListener('change', (e) => {
    const value = (e.target as HTMLSelectElement).value;
    store.update((s) => {
      s.prefs.workspaceId = value;
      s.mapping.projects = [];
      s.mapping.projectsWorkspaceId = null;
      s.existingEntries = [];
      s.existingEntriesFingerprint = null;
      s.existingEntriesError = null;
      s.importing = { status: 'idle', results: [], total: 0, completed: 0, stopRequested: false };
    });
    savePrefs(store.getState().prefs);
    void loadProjects();
  });

  qs<HTMLSelectElement>('mapping-project').addEventListener('change', (e) => {
    const value = (e.target as HTMLSelectElement).value;
    store.update((s) => {
      s.prefs.projectId = value;
    });
    savePrefs(store.getState().prefs);
    recomputePlan();
  });

  qs<HTMLInputElement>('hours-per-day').addEventListener('change', (e) => {
    const raw = Number((e.target as HTMLInputElement).value);
    const value =
      Number.isFinite(raw) && raw > 0 && raw <= 24 ? raw : store.getState().prefs.hoursPerDay;
    store.update((s) => {
      s.prefs.hoursPerDay = value;
    });
    savePrefs(store.getState().prefs);
    recomputePlan();
  });

  qs<HTMLInputElement>('start-time').addEventListener('change', (e) => {
    const value = (e.target as HTMLInputElement).value;
    store.update((s) => {
      s.prefs.startTime = value;
    });
    savePrefs(store.getState().prefs);
    recomputePlan();
  });

  qs<HTMLInputElement>('mapping-timezone').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const value = input.value.trim();
    if (!isValidTimezone(value)) {
      input.setCustomValidity("That doesn't look like a valid IANA timezone, e.g. Europe/Warsaw.");
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    store.update((s) => {
      s.prefs.timezone = value;
    });
    savePrefs(store.getState().prefs);
    recomputePlan();
  });

  qs<HTMLInputElement>('mapping-billable').addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    store.update((s) => {
      s.prefs.billable = checked;
    });
    savePrefs(store.getState().prefs);
    recomputePlan();
  });
  qs<HTMLInputElement>('mapping-weekends').addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    store.update((s) => {
      s.prefs.includeWeekends = checked;
    });
    savePrefs(store.getState().prefs);
    recomputePlan();
  });

  qs('mapping-back').addEventListener('click', () => {
    store.update((s) => {
      s.step = 2;
    });
  });

  qs('mapping-continue').addEventListener('click', () => {
    store.update((s) => {
      s.step = 4;
    });
    const s0 = store.getState();
    const fp = scopeFingerprint(s0);
    if (s0.scan.fingerprint === fp && s0.scan.activities.length > 0) {
      void loadExistingEntriesAndRecompute();
    } else {
      void runScan();
    }
  });
}

function wirePreviewStep(): void {
  qs('preview-back').addEventListener('click', () => {
    if (store.getState().scan.status === 'running') {
      store.update((s) => {
        s.scan.cancelRequested = true;
      });
      return;
    }
    store.update((s) => {
      s.step = 3;
    });
  });

  qs<HTMLInputElement>('preview-select-all').addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    store.update((s) => {
      if (!s.plan) return;
      s.checkedKeys = checked ? new Set(s.plan.entries.map((entry) => entry.key)) : new Set();
    });
  });

  qs<HTMLInputElement>('split-evenly').addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    store.update((s) => {
      s.prefs.splitEvenly = checked;
    });
    savePrefs(store.getState().prefs);
    recomputePlan();
  });

  qs<HTMLInputElement>('notify-when-done').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    if (input.checked) {
      const granted = await requestNotifyPermission();
      if (!input.checked) {
        // The user unchecked the box while the permission prompt was open —
        // that later action wins, regardless of what the prompt returned.
        store.update((s) => {
          s.prefs.notifyWhenDone = false;
        });
        savePrefs(store.getState().prefs);
        return;
      }
      if (!granted) {
        input.checked = false;
        toaster.push({
          kind: 'warning',
          title: 'Notifications are blocked',
          message: 'Allow notifications for this site in your browser settings to use this.',
        });
        announce(
          'Notifications are blocked: Allow notifications for this site in your browser settings to use this.',
        );
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

  qs('preview-rows').addEventListener('change', (e) => {
    const target = e.target;
    if (target instanceof HTMLInputElement && target.dataset.keyCheckbox) {
      const key = target.dataset.keyCheckbox;
      store.update((s) => {
        const set = new Set(s.checkedKeys);
        if (target.checked) set.add(key);
        else set.delete(key);
        s.checkedKeys = set;
      });
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.hoursKey) {
      const key = target.dataset.hoursKey;
      const raw = Number(target.value.trim().replace(',', '.'));
      // Deferred to a macrotask: `change` fires before the browser finishes
      // moving focus on Tab/click-away, and rebuilding the table synchronously
      // would destroy the element focus is about to land on. After a 0ms
      // timeout the transfer has settled, so renderPreviewTable's focus
      // capture/restore sees (and keeps) the right input.
      setTimeout(() => {
        if (!Number.isFinite(raw) || raw <= 0 || raw > 24) {
          // Invalid input: re-render restores the last good value.
          store.update(() => {});
          return;
        }
        // Round to what's actually displayed (2 decimal places, same as the
        // input's toFixed(2) rendering) so the totals shown always agree with
        // what's stored.
        const value = Math.round(raw * 100) / 100;
        store.update((s) => {
          s.entryHours = { ...s.entryHours, [key]: value };
        });
        recomputePlan();
      }, 0);
    }
  });

  qs('import-btn').addEventListener('click', () => {
    if (store.getState().importing.status === 'running') {
      store.update((s) => {
        s.importing.stopRequested = true;
      });
      return;
    }
    void runImport();
  });
}

function init(): void {
  renderStaticIcons();
  initFormFromState();
  wireConnectStep();
  wireScopeStep();
  wireMappingStep();
  wirePreviewStep();
  render();
}

init();
