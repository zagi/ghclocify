/**
 * A single mutable state object plus a `subscribe(fn)` notifier — the whole
 * of the client's "framework". Credentials live in memory always and are
 * mirrored to localStorage ONLY when "Remember on this device" is checked
 * (keys `gh2clockify.github` / `gh2clockify.clockify`). Non-secret
 * preferences always persist under `gh2clockify.prefs`. Every localStorage
 * access is wrapped in try/catch: it throws outright in some privacy
 * contexts (Safari private browsing, cookies blocked, etc.), and losing
 * persistence must never break the app.
 */
import type { ActivityFetch } from './api';
import type {
  ClockifyProject,
  ClockifyUser,
  ClockifyWorkspace,
  GithubOrg,
  GithubRepo,
  GithubViewer,
} from './api';
import type { Activity, ApplyResult, ExistingEntry, ImportPlan } from '../src/types';

const GITHUB_KEY = 'gh2clockify.github';
const CLOCKIFY_KEY = 'gh2clockify.clockify';
const PREFS_KEY = 'gh2clockify.prefs';

export type ScanSourceKey = 'commits' | 'pulls' | 'issues' | 'reviews';

export type DatePreset = 'this-month' | 'last-month' | 'custom';

export type Prefs = {
  region: string;
  subdomain: string;
  remember: boolean;
  datePreset: DatePreset;
  startDate: string;
  endDate: string;
  sources: Record<ScanSourceKey, boolean>;
  accountKind: 'personal' | 'org';
  accountOrg: string;
  selectedRepos: string[];
  workspaceId: string;
  projectId: string;
  hoursPerDay: number;
  startTime: string;
  timezone: string;
  billable: boolean;
  includeWeekends: boolean;
  splitEvenly: boolean;
};

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultPrefs(): Prefs {
  return {
    region: 'api',
    subdomain: '',
    remember: false,
    datePreset: 'this-month',
    startDate: '',
    endDate: '',
    sources: { commits: true, pulls: true, issues: false, reviews: false },
    accountKind: 'personal',
    accountOrg: '',
    selectedRepos: [],
    workspaceId: '',
    projectId: '',
    hoursPerDay: 8,
    startTime: '09:00',
    timezone: detectTimezone(),
    billable: false,
    includeWeekends: false,
    splitEvenly: true,
  };
}

export function loadPrefs(): Prefs {
  const base = defaultPrefs();
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      ...base,
      ...parsed,
      sources: { ...base.sources, ...parsed.sources },
    };
  } catch {
    return base;
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable (private browsing, quota, disabled cookies).
    // Preferences simply won't persist across reloads.
  }
}

export function loadStoredCredentials(): { github: string; clockify: string } {
  try {
    return {
      github: localStorage.getItem(GITHUB_KEY) ?? '',
      clockify: localStorage.getItem(CLOCKIFY_KEY) ?? '',
    };
  } catch {
    return { github: '', clockify: '' };
  }
}

export function saveStoredCredentials(github: string, clockify: string): void {
  try {
    localStorage.setItem(GITHUB_KEY, github);
    localStorage.setItem(CLOCKIFY_KEY, clockify);
  } catch {
    // See savePrefs above.
  }
}

export function clearStoredCredentials(): void {
  try {
    localStorage.removeItem(GITHUB_KEY);
    localStorage.removeItem(CLOCKIFY_KEY);
  } catch {
    // Nothing to clear if localStorage itself is unavailable.
  }
}

export function hasStoredCredentials(): boolean {
  try {
    return localStorage.getItem(GITHUB_KEY) != null || localStorage.getItem(CLOCKIFY_KEY) != null;
  } catch {
    return false;
  }
}

// ---- wizard state ----

export type Step = 1 | 2 | 3 | 4;
export type AsyncStatus = 'idle' | 'checking' | 'ok' | 'error';

export type State = {
  step: Step;
  /** In-memory only. Mirrored to localStorage by app.ts, never read from
   *  render.ts or api.ts directly. */
  credentials: { github: string; clockify: string };
  prefs: Prefs;

  connect: {
    githubStatus: AsyncStatus;
    githubError: string | null;
    clockifyStatus: AsyncStatus;
    clockifyError: string | null;
    viewer: GithubViewer | null;
    orgs: GithubOrg[];
    clockifyUser: ClockifyUser | null;
    workspaces: ClockifyWorkspace[];
  };

  scope: {
    repos: GithubRepo[];
    reposLoading: boolean;
    reposError: string | null;
    repoFilter: string;
    /** `accountKind:accountOrg` the current `repos` list was fetched for —
     *  avoids re-fetching (and burning a free-tier workspace's shared
     *  request budget indirectly via repeated navigation) on Back/Continue
     *  when the account scope has not actually changed. */
    reposFingerprint: string | null;
  };

  mapping: {
    projects: ClockifyProject[];
    projectsLoading: boolean;
    projectsError: string | null;
    /** workspaceId the current `projects` list was fetched for. */
    projectsWorkspaceId: string | null;
  };

  scan: {
    status: 'idle' | 'running' | 'done' | 'cancelled' | 'error';
    progress: number; // 0-100
    statusText: string;
    activities: Activity[];
    warnings: string[];
    error: string | null;
    cancelRequested: boolean;
    /** Cache-invalidation key: scope inputs (repos, sources, dates, account)
     *  serialized. When this no longer matches the current scope inputs, the
     *  cached activities are stale and a fresh scan is required. */
    fingerprint: string | null;
  };

  existingEntries: ExistingEntry[];
  /** Cache-invalidation key for existingEntries: workspace + date range. */
  existingEntriesFingerprint: string | null;
  /** Set when the duplicate-check fetch (existing Clockify entries) itself
   *  fails. Rendered as its own banner rather than folded into
   *  `scan.warnings` — that list is truncated to 3 in the UI, and a handful
   *  of routine repo warnings ahead of this one would hide the message that
   *  the duplicate preview is unreliable. Cleared on the next successful
   *  fetch. */
  existingEntriesError: string | null;

  plan: ImportPlan | null;
  /** `ProposedEntry.key`s selected for import. */
  checkedKeys: Set<string>;
  /**
   * Manual hours per entry key — used only while `prefs.splitEvenly` is
   * false. Keys that no longer exist in the plan are dropped on recompute;
   * an entry with no override keeps its even share. Cleared with the scan.
   */
  entryHours: Record<string, number>;

  importing: {
    status: 'idle' | 'running' | 'done';
    results: ApplyResult[];
    total: number;
    completed: number;
    stopRequested: boolean;
  };
};

export function createInitialState(): State {
  return {
    step: 1,
    credentials: loadStoredCredentials(),
    prefs: loadPrefs(),
    connect: {
      githubStatus: 'idle',
      githubError: null,
      clockifyStatus: 'idle',
      clockifyError: null,
      viewer: null,
      orgs: [],
      clockifyUser: null,
      workspaces: [],
    },
    scope: {
      repos: [],
      reposLoading: false,
      reposError: null,
      repoFilter: '',
      reposFingerprint: null,
    },
    mapping: {
      projects: [],
      projectsLoading: false,
      projectsError: null,
      projectsWorkspaceId: null,
    },
    scan: {
      status: 'idle',
      progress: 0,
      statusText: '',
      activities: [],
      warnings: [],
      error: null,
      cancelRequested: false,
      fingerprint: null,
    },
    existingEntries: [],
    existingEntriesFingerprint: null,
    existingEntriesError: null,
    plan: null,
    checkedKeys: new Set(),
    entryHours: {},
    importing: { status: 'idle', results: [], total: 0, completed: 0, stopRequested: false },
  };
}

/** Re-exported so app.ts can type a scan result without importing ./api. */
export type { ActivityFetch };

export type Listener = (state: State) => void;

/**
 * Minimal store: `update` takes a mutator that edits the object in place
 * (simplest for a deeply nested single state object), then swaps in a new
 * top-level reference and notifies subscribers — enough for render.ts to
 * treat `state` as "the current snapshot" without needing a diffing library.
 */
export function createStore(initial: State) {
  let state = initial;
  const listeners = new Set<Listener>();

  function notify(): void {
    for (const fn of listeners) fn(state);
  }

  return {
    getState: (): State => state,
    update: (mutator: (draft: State) => void): void => {
      mutator(state);
      state = { ...state };
      notify();
    },
    subscribe: (fn: Listener): (() => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
