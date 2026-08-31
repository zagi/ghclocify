/**
 * Chunk endpoints the browser calls repeatedly, in a loop it drives itself,
 * to gather GitHub activity. See task-11-brief.md for why: Cloudflare
 * cancels outstanding work on client disconnect, a custom domain adds a
 * ~100s proxy timeout, and a user can close the tab mid-scan. A single
 * monolithic scan over dozens of repos would be killed mid-flight with no
 * way to resume. Making the browser the orchestrator buys a progress bar,
 * per-chunk retry, cancellation and resumability for free, and keeps every
 * Worker invocation far inside its subrequest budget — which is exactly
 * why every cap below is enforced before any upstream `fetch`, never after.
 */
import { Hono } from 'hono';
import type { Env } from '../index';
import { requireGithub, readCappedJson } from '../credentials';
import { AppError } from '../problems';
import { isDateKey, isOwner, isRepoFullName, daysBetween } from '../validate';
import { fetchCommits, fetchSearch } from '../github';
import type { RepoScope } from '../github';

export const scanRoutes = new Hono<{ Bindings: Env }>();

/**
 * `/api/scan/commits` fetches one paginated commits call per repo, at up to
 * 10 pages each — 8 repos keeps a single chunk to <= 80 subrequests,
 * comfortably inside the Paid budget with room for the search endpoint's
 * per-PR review second hop.
 */
const MAX_COMMIT_REPOS = 8;

/**
 * GitHub Search allows only 30 requests/minute, so the client paces itself
 * in month-sized windows — a single chunk never exceeds that budget.
 */
const MAX_SEARCH_WINDOW_DAYS = 31;

/** `yyyy-MM-ddThh:mm:ssZ`, optionally with milliseconds — mirrors
 *  `routes/clockify.ts`'s `ISO_INSTANT_RE`; browsers commonly produce
 *  `toISOString()`, which always carries millis. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** `+HH:MM` / `-HH:MM` UTC offset — what `fetchSearch` splices directly
 *  into its search query's date qualifiers. */
const OFFSET_LABEL_RE = /^[+-]\d{2}:\d{2}$/;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError(400, 'invalid_request', 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/**
 * Validates every repo full-name before any upstream call. `fetchCommits`
 * repeats this check internally, but `fetchSearch` does not — so the route
 * layer is the only place both endpoints are guaranteed to reject a bad
 * repo before touching the network. `max` is omitted for `/search`, which
 * fans out on `source`, not per-repo, so a repo-count cap does not bound
 * its subrequest count the way it does for `/commits`.
 */
function readRepos(value: unknown, max?: number): string[] {
  if (!Array.isArray(value) || (max !== undefined && value.length > max)) {
    throw new AppError(
      400,
      'invalid_request',
      max !== undefined
        ? `repos must be an array of at most ${max} repo full names`
        : 'repos must be an array of repo full names',
    );
  }
  return value.map((repo) => {
    if (typeof repo !== 'string' || !isRepoFullName(repo)) {
      throw new AppError(400, 'invalid_request', `Invalid repo full name: ${String(repo)}`);
    }
    return repo;
  });
}

function readLogin(value: unknown): string {
  if (typeof value !== 'string' || !isOwner(value)) {
    throw new AppError(400, 'invalid_request', 'login must be a valid GitHub login');
  }
  return value;
}

function readIsoInstant(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new AppError(400, 'invalid_request', `${name} must be an ISO-8601 UTC instant`);
  }
  return value;
}

function readDateKey(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isDateKey(value)) {
    throw new AppError(400, 'invalid_request', `${name} must be a YYYY-MM-DD date`);
  }
  return value;
}

/**
 * `RepoScope` arrives as an untyped JSON value; narrow it by hand rather
 * than casting, since a body-supplied `org` would otherwise reach
 * `fetchSearch` (and the upstream `org:` search qualifier) unvalidated.
 */
function readScope(value: unknown): RepoScope {
  const scope = asRecord(value);
  if (scope.kind === 'personal') return { kind: 'personal' };
  if (scope.kind === 'org') {
    if (typeof scope.org !== 'string' || !isOwner(scope.org)) {
      throw new AppError(
        400,
        'invalid_request',
        'scope.org must be a valid GitHub login when scope.kind is org',
      );
    }
    return { kind: 'org', org: scope.org };
  }
  throw new AppError(400, 'invalid_request', "scope.kind must be 'personal' or 'org'");
}

/**
 * One paginated commits call per repo, at up to `MAX_COMMIT_REPOS` repos
 * per chunk. All validation happens before `fetchCommits` is called, so a
 * rejected request never issues an upstream `fetch`.
 */
scanRoutes.post('/commits', async (c) => {
  const token = requireGithub(c);
  const body = asRecord(await readCappedJson<unknown>(c));

  const repos = readRepos(body.repos, MAX_COMMIT_REPOS);
  const login = readLogin(body.login);
  const sinceIso = readIsoInstant(body.sinceIso, 'sinceIso');
  const untilIso = readIsoInstant(body.untilIso, 'untilIso');

  const result = await fetchCommits(token, { repos, login, sinceIso, untilIso });
  return c.json(result);
});

/**
 * One Search API query for exactly one source over a window of at most
 * `MAX_SEARCH_WINDOW_DAYS` days. `source: 'commit'` is rejected here —
 * commits have their own route above, since Search cannot answer commit
 * queries at all. All validation happens before `fetchSearch` is called,
 * so a rejected request never issues an upstream `fetch`.
 */
scanRoutes.post('/search', async (c) => {
  const token = requireGithub(c);
  const body = asRecord(await readCappedJson<unknown>(c));

  const source = body.source;
  if (source !== 'pull_request' && source !== 'issue' && source !== 'review') {
    throw new AppError(
      400,
      'invalid_request',
      "source must be 'pull_request', 'issue' or 'review'",
    );
  }
  const login = readLogin(body.login);
  const scope = readScope(body.scope);
  const repos = readRepos(body.repos);
  const startKey = readDateKey(body.startKey, 'startKey');
  const endKey = readDateKey(body.endKey, 'endKey');
  const days = daysBetween(startKey, endKey);
  if (days < 0 || days > MAX_SEARCH_WINDOW_DAYS) {
    throw new AppError(
      400,
      'invalid_request',
      `search window must be between 0 and ${MAX_SEARCH_WINDOW_DAYS} days`,
    );
  }
  const offsetLabel = body.offsetLabel;
  if (typeof offsetLabel !== 'string' || !OFFSET_LABEL_RE.test(offsetLabel)) {
    throw new AppError(
      400,
      'invalid_request',
      "offsetLabel must be a '+HH:MM' or '-HH:MM' UTC offset",
    );
  }

  const result = await fetchSearch(token, {
    source,
    login,
    scope,
    repos,
    startKey,
    endKey,
    offsetLabel,
  });
  return c.json(result);
});

export default scanRoutes;
