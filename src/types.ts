export type ActivityKind = 'commit' | 'pull_request' | 'issue' | 'review';

/** One thing the user did on GitHub, normalized across all four sources. */
export type Activity = {
  kind: ActivityKind;
  /** Stable identity for dedup: commit SHA, or `review:owner/repo#12:98765`. */
  id: string;
  /** `owner/name`. */
  repo: string;
  /** UTC ISO-8601 instant the activity is attributed to. */
  timestamp: string;
  /** Commit subject line / PR title / issue title. */
  title: string;
  url: string;
};

export type ImportSettings = {
  hoursPerDay: number;
  /** Local wall-clock start, `HH:MM`. */
  startTime: string;
  /** IANA zone, e.g. `Europe/Warsaw`. */
  timezone: string;
  includeWeekends: boolean;
  billable: boolean;
  workspaceId: string;
  projectId: string;
  /** repo full-name or bare name -> short label used in descriptions. */
  repoAliases: Record<string, string>;
};

export type ProposedEntry = {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** UTC ISO-8601 with `Z`, second precision. */
  start: string;
  end: string;
  description: string;
  billable: boolean;
  projectId: string;
  activityCount: number;
  repos: string[];
};

export type ExistingEntry = {
  id: string;
  start: string;
  end: string | null;
  description: string;
  projectId: string | null;
};

export type EntryStatus = 'new' | 'duplicate';

export type PlannedEntry = ProposedEntry & {
  status: EntryStatus;
  /** Present when `status === 'duplicate'`. */
  existing?: ExistingEntry;
};

export type ImportPlan = {
  entries: PlannedEntry[];
  totals: { days: number; hours: number; newDays: number; duplicateDays: number };
  skipped: { date: string; reason: 'weekend' }[];
  warnings: string[];
};

export type ApplyResult = {
  date: string;
  ok: boolean;
  entryId?: string;
  /** Set when `ok` is false, or when the write was skipped as a duplicate. */
  error?: string;
  skipped?: boolean;
};

/** Clockify regional hosts. `api` is the default global host. */
export type ClockifyHost = 'api' | 'euc1' | 'use2' | 'euw2' | 'apse2';
