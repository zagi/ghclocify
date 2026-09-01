/**
 * Clockify REST client. Discovers the current user, their workspaces and
 * projects, reads existing time entries for duplicate detection, and
 * creates new ones.
 *
 * Worker-side only — not bundled into the browser client — so this module
 * freely imports from `./http`, `./problems`, `./validate` and `./types`.
 */
import { fetchJson } from './http';
import { AppError } from './problems';
import { isClockifyId, isClockifySubdomain, segment } from './validate';
import type { ClockifyHost, ExistingEntry, ProposedEntry } from './types';

const REGIONS = new Set<ClockifyHost>(['api', 'euc1', 'use2', 'euw2', 'apse2']);

/** Matches the Python script's page cap issue: request the max page size so a
 *  workspace with more than the (undocumented) default of 50 items never
 *  silently loses projects/entries past page 1. */
const PAGE_SIZE = 5000;

/** Safety bound only — real pagination stops on the `Last-Page: true`
 *  response header. This just prevents an infinite loop if Clockify ever
 *  omits that header. */
const MAX_PAGES = 50;

export type ClockifyUser = { id: string; name: string; email: string; timezone: string | null };
export type Workspace = { id: string; name: string; plan: string; freeTier: boolean };
export type Project = { id: string; name: string; clientName: string | null };

/**
 * Resolve a Clockify host to its base API URL. `host` is drawn from a
 * hardcoded regional allowlist and `subdomain` (workspace vanity domains)
 * is checked against `isClockifySubdomain` — never accept a free-form host,
 * that is a direct SSRF. The region is not discoverable from the API; it is
 * a UI choice that defaults to `api`.
 */
export function baseUrl(host: ClockifyHost, subdomain?: string): string {
  if (subdomain) {
    if (!isClockifySubdomain(subdomain)) {
      throw new AppError(400, 'invalid_request', 'Invalid subdomain');
    }
    return `https://${subdomain}.clockify.me/api/v1`;
  }
  if (!REGIONS.has(host)) {
    throw new AppError(400, 'invalid_request', 'Unknown Clockify region');
  }
  return `https://${host}.clockify.me/api/v1`;
}

/**
 * `X-Api-Key`, never `Authorization` — Clockify's auth scheme. Wrapped in
 * try/catch: an illegal byte in `key` makes `new Headers()` throw, which
 * would otherwise surface as a 500. (The route layer already validates key
 * format via `credentials.ts`'s `SAFE_TOKEN`; this is defense in depth.)
 */
function clockifyHeaders(key: string): Headers {
  try {
    return new Headers({ 'X-Api-Key': key });
  } catch {
    throw new AppError(400, 'invalid_credentials', 'Clockify key contains invalid characters');
  }
}

/**
 * Page through an endpoint that returns a bare JSON array, using `page` +
 * `page-size` (hyphenated — the prose docs say `pageSize`, every endpoint
 * definition says `page-size`) and terminating on the `Last-Page: true`
 * response header. Clockify sends no `Link` header, so counting or
 * comparing page lengths is not an option.
 */
async function fetchAllPages<T>(
  urlForPage: (page: number) => string,
  headers: Headers,
  label: string,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  for (; page <= MAX_PAGES; page += 1) {
    const { data, headers: resHeaders } = await fetchJson<T[]>(
      urlForPage(page),
      { headers },
      { label },
    );
    // Definitive, header-independent termination: an empty (or non-array)
    // page means there is nothing left to fetch, regardless of what the
    // `Last-Page` header says or whether Clockify sends it at all. Do NOT
    // add a `data.length < PAGE_SIZE` check here — if Clockify ever
    // post-filters a page, that would truncate the existing-entries list
    // early and *cause* duplicates. Empty-page is the only safe secondary
    // condition.
    if (!Array.isArray(data) || data.length === 0) break;
    items.push(...data);
    if (resHeaders.get('last-page')?.toLowerCase() === 'true') break;
  }
  return items;
}

type ClockifyUserDto = {
  id: string;
  name: string;
  email: string;
  settings?: { timeZone?: string | null };
};

export async function getUser(key: string, base: string): Promise<ClockifyUser> {
  const headers = clockifyHeaders(key);
  const { data } = await fetchJson<ClockifyUserDto>(
    `${base}/user`,
    { headers },
    { label: 'Clockify /user' },
  );
  return {
    id: data.id,
    name: data.name,
    email: data.email,
    timezone: data.settings?.timeZone ?? null,
  };
}

type ClockifyWorkspaceDto = {
  id: string;
  name: string;
  /** Absent on some legacy/free workspaces. `plan` and `freeTier` are
   *  deliberately decoupled: `freeTier` treats a missing value as free (the
   *  conservative default — the alternative would silently drop the
   *  30-req/hour warning for exactly the accounts that need it most), but
   *  `plan` must not fabricate a confirmed `'FREE'` label for a value we
   *  never actually received — that would misreport an unknown/legacy plan
   *  as "Free" for the wrong reason. */
  featureSubscriptionType?: string | null;
};

export async function listWorkspaces(key: string, base: string): Promise<Workspace[]> {
  const headers = clockifyHeaders(key);
  const { data } = await fetchJson<ClockifyWorkspaceDto[]>(
    `${base}/workspaces`,
    { headers },
    { label: 'Clockify /workspaces' },
  );
  return data.map((w) => ({
    id: w.id,
    name: w.name,
    plan: w.featureSubscriptionType ?? 'UNKNOWN',
    freeTier:
      w.featureSubscriptionType == null ||
      w.featureSubscriptionType.toUpperCase().startsWith('FREE'),
  }));
}

type ClockifyProjectDto = {
  id: string;
  name: string;
  clientName?: string | null;
};

/**
 * `archived=false` is required, not optional: the endpoint's own docs say
 * "If omitted, you'll get both archived and non-archived" despite the
 * schema's misleading `default: false`. Without it the UI would offer
 * archived projects that reject new time entries.
 */
export async function listProjects(
  key: string,
  base: string,
  workspaceId: string,
): Promise<Project[]> {
  if (!isClockifyId(workspaceId)) {
    throw new AppError(400, 'invalid_request', 'Invalid workspace id');
  }
  const headers = clockifyHeaders(key);
  const ws = segment(workspaceId);
  const items = await fetchAllPages<ClockifyProjectDto>(
    (page) =>
      `${base}/workspaces/${ws}/projects?${new URLSearchParams({
        page: String(page),
        'page-size': String(PAGE_SIZE),
        archived: 'false',
      }).toString()}`,
    headers,
    'Clockify /workspaces/{ws}/projects',
  );
  return items.map((p) => ({ id: p.id, name: p.name, clientName: p.clientName ?? null }));
}

type ClockifyTimeEntryDto = {
  id: string;
  timeInterval: { start: string; end: string | null };
  description: string;
  projectId: string | null;
};

export async function listEntries(
  key: string,
  base: string,
  workspaceId: string,
  userId: string,
  startIso: string,
  endIso: string,
): Promise<ExistingEntry[]> {
  if (!isClockifyId(workspaceId)) {
    throw new AppError(400, 'invalid_request', 'Invalid workspace id');
  }
  if (!isClockifyId(userId)) {
    throw new AppError(400, 'invalid_request', 'Invalid user id');
  }
  const headers = clockifyHeaders(key);
  const ws = segment(workspaceId);
  const uid = segment(userId);
  const items = await fetchAllPages<ClockifyTimeEntryDto>(
    (page) =>
      `${base}/workspaces/${ws}/user/${uid}/time-entries?${new URLSearchParams({
        start: startIso,
        end: endIso,
        page: String(page),
        'page-size': String(PAGE_SIZE),
      }).toString()}`,
    headers,
    'Clockify /workspaces/{ws}/user/{uid}/time-entries',
  );
  return items.map((e) => ({
    id: e.id,
    start: e.timeInterval.start,
    end: e.timeInterval.end,
    description: e.description,
    projectId: e.projectId ?? null,
  }));
}

/**
 * Creates for the API key's owner. `userId` is deliberately never sent:
 * `CreateTimeEntryRequest` has no such property — the Python script's
 * `userId` is silently ignored by the API. The `/user/{uid}/time-entries`
 * variant (creating on someone else's behalf) needs elevated permissions
 * and is out of scope for this self-service tool.
 */
export async function createEntry(
  key: string,
  base: string,
  workspaceId: string,
  entry: ProposedEntry,
): Promise<{ id: string }> {
  if (!isClockifyId(workspaceId)) {
    throw new AppError(400, 'invalid_request', 'Invalid workspace id');
  }
  const headers = clockifyHeaders(key);
  headers.set('Content-Type', 'application/json');
  const body = {
    start: entry.start,
    end: entry.end,
    billable: entry.billable,
    description: entry.description,
    projectId: entry.projectId,
    taskId: null,
    tagIds: [],
    type: 'REGULAR',
  };
  const ws = segment(workspaceId);
  const { data } = await fetchJson<{ id: string }>(
    `${base}/workspaces/${ws}/time-entries`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    {
      label: 'Clockify /workspaces/{ws}/time-entries',
      // Clockify's API has no idempotency key. `fetchJson`'s default of 2
      // automatic retries is fine for GETs, but not here: if this POST
      // succeeds server-side and only the response is lost (timeout, 502,
      // dropped connection), an automatic retry would create a SECOND
      // identical time entry — silently doubling the user's logged hours,
      // which is the exact bug this product exists to prevent. Resolving
      // that ambiguity (re-checking what actually exists in Clockify rather
      // than blindly retrying the write) is the apply route's job — see
      // `routes/apply.ts`.
      retries: 0,
    },
  );
  return { id: data.id };
}
