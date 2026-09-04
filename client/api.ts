/**
 * Thin fetch wrapper for the browser client. Attaches the two credential
 * headers to every call, decodes the `{ error, message }` body `problem()`
 * (src/problems.ts) emits on a non-2xx response, and turns each error code
 * into a sentence a user can act on.
 *
 * One function per HTTP call. The looping / chunking / pacing that turns
 * these into a scan or an import lives in app.ts, not here — this module
 * knows nothing about wizard state.
 *
 * Never put a credential in a URL: both keys always travel as headers.
 */
import type { Activity, ApplyResult, ExistingEntry, ProposedEntry } from '../src/types';

export type Service = 'github' | 'clockify';

export type Credentials = { github: string; clockify: string };

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Maps a wire error code (plus which upstream service the call concerned) to
 * a sentence a user can act on. Codes not special-cased here fall through to
 * the server's own `message`, which is already written to be readable (e.g.
 * "repos must be an array of at most 8 repo full names").
 */
function humanize(code: string, rawMessage: string, status: number, service?: Service): string {
  const who = service === 'clockify' ? 'Clockify' : service === 'github' ? 'GitHub' : 'The server';
  switch (code) {
    case 'missing_credentials':
      if (service === 'clockify') return 'Enter your Clockify API key.';
      if (service === 'github') return 'Enter your GitHub personal access token.';
      return rawMessage;
    case 'invalid_credentials':
      if (service === 'clockify') return "That doesn't look like a valid Clockify API key.";
      if (service === 'github')
        return "That doesn't look like a valid GitHub personal access token.";
      return rawMessage;
    case 'upstream_saml_required':
      return "Your GitHub token isn't authorized for that organization. Authorize it for SSO in your token settings.";
    case 'upstream_unauthorized':
      return `${who} rejected the request. Double-check the key and try again.`;
    case 'upstream_forbidden':
      return `${who} refused that request. The key may be missing a required permission.`;
    case 'rate_limited':
      return 'Too many requests — waiting a moment.';
    case 'upstream_timeout':
      return `${who} did not respond in time. Try again.`;
    case 'upstream_error':
      // A 429 that survived fetchJson's retries lands here (429 is treated
      // as retryable, so it never reaches the upstream_rejected branch).
      if (service === 'clockify' && /\b429\b/.test(rawMessage)) {
        return "Clockify's free plan allows 30 requests per hour for the whole workspace. Try again later, or narrow the range.";
      }
      return `${who} is temporarily unavailable. Try again in a moment.`;
    case 'upstream_rejected':
      return rawMessage || `${who} rejected that request.`;
    case 'body_too_large':
      return 'That request was too large to send.';
    case 'invalid_json':
    case 'internal_error':
      return 'Something unexpected went wrong. Try again.';
    case 'cross_origin':
      return 'This request was blocked for security reasons. Reload the page and try again.';
    case 'not_found':
      return 'That endpoint could not be found.';
    case 'network_error':
      return rawMessage;
    default:
      return rawMessage || `Request failed (${status}).`;
  }
}

async function request<T>(
  path: string,
  init: RequestInit,
  creds: Credentials,
  service?: Service,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (creds.github) headers.set('X-GitHub-Token', creds.github);
  if (creds.clockify) headers.set('X-Clockify-Key', creds.clockify);

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(
      'network_error',
      'Could not reach the server. Check your connection and try again.',
      0,
    );
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No/invalid JSON body — `body` stays null, handled by the `?? {}` below.
  }

  if (!res.ok) {
    const record = (body && typeof body === 'object' ? body : {}) as {
      error?: string;
      message?: string;
    };
    const code = record.error ?? 'unknown_error';
    const rawMessage = record.message ?? `Request failed (${res.status})`;
    throw new ApiError(code, humanize(code, rawMessage, res.status, service), res.status);
  }

  return body as T;
}

// ---- GitHub ----

export type GithubViewer = { login: string; name: string | null; avatarUrl: string };
export type GithubOrg = { login: string; avatarUrl: string };
export type GithubRepo = {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  pushedAt: string | null;
};
export type RateBudget = {
  limit: number;
  remaining: number;
  resetAt: string;
  searchRemaining: number;
};
export type RepoScope = { kind: 'personal' } | { kind: 'org'; org: string };

export async function githubContext(
  creds: Credentials,
): Promise<{ viewer: GithubViewer; orgs: GithubOrg[]; rateLimit: RateBudget }> {
  return request('/api/github/context', { method: 'GET' }, creds, 'github');
}

export async function githubRepos(
  creds: Credentials,
  scope: RepoScope,
): Promise<{ repos: GithubRepo[] }> {
  const params = new URLSearchParams({ scope: scope.kind });
  if (scope.kind === 'org') params.set('org', scope.org);
  return request(`/api/github/repos?${params.toString()}`, { method: 'GET' }, creds, 'github');
}

export type ActivityFetch = { activities: Activity[]; warnings: string[]; incomplete: boolean };

export async function scanCommits(
  creds: Credentials,
  body: { repos: string[]; login: string; sinceIso: string; untilIso: string },
): Promise<ActivityFetch> {
  return request(
    '/api/scan/commits',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    creds,
    'github',
  );
}

export async function scanSearch(
  creds: Credentials,
  body: {
    source: 'pull_request' | 'issue' | 'review';
    login: string;
    scope: RepoScope;
    repos: string[];
    startKey: string;
    endKey: string;
    offsetLabel: string;
  },
): Promise<ActivityFetch> {
  return request(
    '/api/scan/search',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    creds,
    'github',
  );
}

// ---- Clockify ----

export type ClockifyUser = { id: string; name: string; email: string; timezone: string | null };
export type ClockifyWorkspace = { id: string; name: string; plan: string; freeTier: boolean };
export type ClockifyProject = { id: string; name: string; clientName: string | null };

/** `host` and `subdomain` mirror the server's own precedence: a non-empty
 *  `subdomain` always wins over `host`. */
export type ClockifyLocation = { host: string; subdomain: string };

function clockifyParams(loc: ClockifyLocation): URLSearchParams {
  const params = new URLSearchParams();
  if (loc.subdomain) params.set('subdomain', loc.subdomain);
  else params.set('host', loc.host);
  return params;
}

export async function clockifyContext(
  creds: Credentials,
  loc: ClockifyLocation,
): Promise<{ user: ClockifyUser; workspaces: ClockifyWorkspace[] }> {
  return request(
    `/api/clockify/context?${clockifyParams(loc).toString()}`,
    { method: 'GET' },
    creds,
    'clockify',
  );
}

export async function clockifyProjects(
  creds: Credentials,
  loc: ClockifyLocation,
  workspaceId: string,
): Promise<{ projects: ClockifyProject[] }> {
  const params = clockifyParams(loc);
  params.set('workspaceId', workspaceId);
  return request(
    `/api/clockify/projects?${params.toString()}`,
    { method: 'GET' },
    creds,
    'clockify',
  );
}

export async function clockifyEntries(
  creds: Credentials,
  loc: ClockifyLocation,
  workspaceId: string,
  userId: string,
  startIso: string,
  endIso: string,
): Promise<{ entries: ExistingEntry[] }> {
  const params = clockifyParams(loc);
  params.set('workspaceId', workspaceId);
  params.set('userId', userId);
  params.set('start', startIso);
  params.set('end', endIso);
  return request(
    `/api/clockify/entries?${params.toString()}`,
    { method: 'GET' },
    creds,
    'clockify',
  );
}

export async function apply(
  creds: Credentials,
  body: {
    host: string;
    subdomain?: string;
    workspaceId: string;
    userId: string;
    timezone: string;
    entries: ProposedEntry[];
    dayStarts: Record<string, string[]>;
  },
): Promise<{ results: ApplyResult[] }> {
  return request(
    '/api/apply',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    creds,
    'clockify',
  );
}
