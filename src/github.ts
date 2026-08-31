/**
 * GitHub REST + Search client. Produces the normalized `Activity[]` that
 * `aggregate.ts` and everything downstream consumes.
 *
 * Worker-side only — not bundled into the browser client — so this module
 * freely imports from `./http`, `./problems`, `./validate` and `./types`.
 */
import { fetchJson, mapWithConcurrency, nextPageUrl, MAX_CONCURRENCY } from './http';
import { AppError } from './problems';
import { isOwner, isRepoFullName, segment } from './validate';
import type { Activity, ActivityKind } from './types';

const GITHUB_API = 'https://api.github.com';

/** Also the Search API's hard per-query result cap at `per_page=100`. */
const MAX_PAGES = 10;

const DAY_MS = 86_400_000;

export type Viewer = { login: string; name: string | null; avatarUrl: string };
export type Org = { login: string; avatarUrl: string };
export type Repo = {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  pushedAt: string | null;
};
export type RepoScope = { kind: 'personal' } | { kind: 'org'; org: string };
export type RateBudget = {
  limit: number;
  remaining: number;
  resetAt: string;
  searchRemaining: number;
};
export type ActivityFetch = { activities: Activity[]; warnings: string[]; incomplete: boolean };

/**
 * Modern media type + pinned API version, `Bearer` (covers classic AND
 * fine-grained PATs, unlike the legacy `token ...` scheme) and a
 * `User-Agent` (GitHub rejects requests without one). Wrapped in try/catch:
 * an illegal byte in `token` makes `new Headers()` throw, which would
 * otherwise surface as a 500.
 */
function ghHeaders(token: string): Headers {
  try {
    return new Headers({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'gh2clockify',
    });
  } catch {
    throw new AppError(400, 'invalid_credentials', 'GitHub token contains invalid characters');
  }
}

/**
 * Follow `Link: rel="next"` for an endpoint that returns a bare JSON array,
 * capped at `MAX_PAGES`. A non-array 200 is treated as an empty page rather
 * than looped on — the page cap is what actually bounds the loop.
 */
async function fetchAllPages<T>(url: string, headers: Headers, label: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = url;
  let pages = 0;
  while (next && pages < MAX_PAGES) {
    const { data, headers: resHeaders } = await fetchJson<unknown>(next, { headers }, { label });
    if (Array.isArray(data)) items.push(...(data as T[]));
    next = nextPageUrl(resHeaders);
    pages += 1;
  }
  return items;
}

export async function getViewer(token: string): Promise<Viewer> {
  const headers = ghHeaders(token);
  const { data } = await fetchJson<{ login: string; name: string | null; avatar_url: string }>(
    `${GITHUB_API}/user`,
    { headers },
    { label: 'GitHub /user' },
  );
  return { login: data.login, name: data.name, avatarUrl: data.avatar_url };
}

type GhOrg = { login: string; avatar_url: string };

export async function listOrgs(token: string): Promise<Org[]> {
  const headers = ghHeaders(token);
  const items = await fetchAllPages<GhOrg>(
    `${GITHUB_API}/user/orgs?per_page=100`,
    headers,
    'GitHub /user/orgs',
  );
  return items.map((o) => ({ login: o.login, avatarUrl: o.avatar_url }));
}

export async function getRateBudget(token: string): Promise<RateBudget> {
  const headers = ghHeaders(token);
  const { data } = await fetchJson<{
    resources: {
      core: { limit: number; remaining: number; reset: number };
      search: { limit: number; remaining: number; reset: number };
    };
  }>(`${GITHUB_API}/rate_limit`, { headers }, { label: 'GitHub /rate_limit' });
  return {
    limit: data.resources.core.limit,
    remaining: data.resources.core.remaining,
    resetAt: new Date(data.resources.core.reset * 1000).toISOString(),
    searchRemaining: data.resources.search.remaining,
  };
}

type GhRepo = {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  archived: boolean;
  fork: boolean;
  pushed_at: string | null;
};

function mapRepo(r: GhRepo): Repo {
  return {
    fullName: r.full_name,
    name: r.name,
    owner: r.owner.login,
    private: r.private,
    archived: r.archived,
    fork: r.fork,
    pushedAt: r.pushed_at,
  };
}

export async function listRepos(token: string, scope: RepoScope): Promise<Repo[]> {
  const headers = ghHeaders(token);
  let url: string;
  let label: string;
  if (scope.kind === 'personal') {
    url = `${GITHUB_API}/user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100`;
    label = 'GitHub /user/repos';
  } else {
    if (!isOwner(scope.org)) {
      throw new AppError(400, 'invalid_request', 'Invalid organization login');
    }
    url = `${GITHUB_API}/orgs/${segment(scope.org)}/repos?type=all&sort=pushed&per_page=100`;
    label = `GitHub /orgs/${scope.org}/repos`;
  }
  const items = await fetchAllPages<GhRepo>(url, headers, label);
  const repos = items.map(mapRepo);
  // Recently active repos first; repos never pushed to (`pushedAt: null`)
  // sort last, since '' < any real ISO timestamp.
  repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
  return repos;
}

type GhCommit = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { date?: string } | null;
    committer?: { date?: string } | null;
  };
};

/**
 * One paginated call per repo at `MAX_CONCURRENCY`.
 *
 * The `since`/`until` filter GitHub applies is against the *committer* date,
 * but activities are bucketed on `commit.author.date` — rebases, amends and
 * cherry-picks make those differ by days. The requested window is widened
 * by a day on each side before the request, then every commit is re-filtered
 * client-side against the true (unwidened) window on `commit.author.date`.
 * Skipping either half silently loses or duplicates edge-day commits.
 */
export async function fetchCommits(
  token: string,
  p: { repos: string[]; login: string; sinceIso: string; untilIso: string },
): Promise<ActivityFetch> {
  const headers = ghHeaders(token);
  for (const repo of p.repos) {
    if (!isRepoFullName(repo)) {
      throw new AppError(400, 'invalid_request', `Invalid repo full name: ${repo}`);
    }
  }

  const trueSince = Date.parse(p.sinceIso);
  const trueUntil = Date.parse(p.untilIso);
  const widenedSince = new Date(trueSince - DAY_MS).toISOString();
  const widenedUntil = new Date(trueUntil + DAY_MS).toISOString();

  const warnings: string[] = [];

  const perRepo = await mapWithConcurrency(p.repos, MAX_CONCURRENCY, async (repoFullName) => {
    const [owner, name] = repoFullName.split('/') as [string, string];
    const url = `${GITHUB_API}/repos/${segment(owner)}/${segment(name)}/commits?${new URLSearchParams(
      { author: p.login, since: widenedSince, until: widenedUntil, per_page: '100' },
    ).toString()}`;

    try {
      const items = await fetchAllPages<GhCommit>(url, headers, `GitHub commits ${repoFullName}`);
      const activities: Activity[] = [];
      for (const c of items) {
        const timestamp = c.commit.author?.date ?? c.commit.committer?.date;
        if (!timestamp) continue;
        const t = Date.parse(timestamp);
        // Re-filter to the true (unwidened) window.
        if (t < trueSince || t >= trueUntil) continue;
        activities.push({
          kind: 'commit',
          id: c.sha,
          repo: repoFullName,
          timestamp,
          title: (c.commit.message.split(/\r?\n/)[0] ?? '').trim(),
          url: c.html_url,
        });
      }
      return activities;
    } catch (err) {
      // 404 (no access) / 409 (empty repo) become warnings, not failures.
      // Everything else — in particular a 403 upstream_saml_required —
      // must propagate: swallowing it as "no activity" hides the most
      // common real-world org-access failure.
      if (err instanceof AppError && (err.status === 404 || err.status === 409)) {
        warnings.push(`${repoFullName}: ${err.message}`);
        return [];
      }
      throw err;
    }
  });

  return { activities: perRepo.flat(), warnings, incomplete: false };
}

type GhSearchIssue = {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  created_at: string;
};

type GhSearchResponse = {
  total_count: number;
  incomplete_results: boolean;
  items: GhSearchIssue[];
};

/** Search items carry no `repository` object, only this URL. */
function repoFromUrl(repositoryUrl: string): string | null {
  const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl);
  if (!match) return null;
  const owner = match[1];
  const name = match[2];
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

async function searchAllPages(
  url: string,
  headers: Headers,
  label: string,
): Promise<{ items: GhSearchIssue[]; incomplete: boolean }> {
  const items: GhSearchIssue[] = [];
  let incomplete = false;
  let totalCount = 0;
  let next: string | null = url;
  let pages = 0;
  while (next && pages < MAX_PAGES) {
    const { data, headers: resHeaders } = await fetchJson<GhSearchResponse>(
      next,
      { headers },
      { label },
    );
    items.push(...data.items);
    if (data.incomplete_results) incomplete = true;
    totalCount = data.total_count;
    next = nextPageUrl(resHeaders);
    pages += 1;
  }
  // The Search API never actually serves past the 1000th result, but assert
  // it explicitly: if the true result set is bigger than what we could ever
  // page through, the answer is partial and the caller must be told so.
  if (totalCount > 1000) incomplete = true;
  return { items, incomplete };
}

type GhReview = {
  id: number;
  user: { login: string } | null;
  submitted_at: string | null;
  html_url: string;
};

/**
 * PRs, issues and reviews, one Search API query per source per ≤ 31-day
 * window. `advanced_search=true` is mandatory: in the legacy dialect a space
 * between two same-type qualifiers means OR, in advanced mode it means AND,
 * and GitHub has announced the default will flip — a query written for the
 * wrong dialect returns zero results, not an error.
 */
export async function fetchSearch(
  token: string,
  p: {
    source: Exclude<ActivityKind, 'commit'>;
    login: string;
    scope: RepoScope;
    repos: string[];
    startKey: string;
    endKey: string;
    offsetLabel: string;
  },
): Promise<ActivityFetch> {
  const headers = ghHeaders(token);
  if (p.scope.kind === 'org' && !isOwner(p.scope.org)) {
    throw new AppError(400, 'invalid_request', 'Invalid organization login');
  }
  // GitHub owner/repo names are case-insensitive, but the casing the caller
  // supplied (and what `repoAliases` is keyed on, and what the UI displays)
  // may not match the canonical casing GitHub returns in `repository_url`.
  // Match case-insensitively, keyed by the lowercased full name, but always
  // emit `Activity.repo` in the caller's supplied form — the same repo must
  // carry one consistent string everywhere, or `describeDay`/`aggregate`
  // silently treat it as two different repos.
  const callerFormByLowerCase = new Map(p.repos.map((r) => [r.toLowerCase(), r] as const));
  const scopeQualifier = p.scope.kind === 'org' ? `org:${p.scope.org}` : `user:${p.login}`;
  // Bare UTC windows would not line up with the local-day buckets
  // aggregate.ts produces; the offset label keeps them aligned.
  const range = `${p.startKey}T00:00:00${p.offsetLabel}..${p.endKey}T23:59:59${p.offsetLabel}`;

  let q: string;
  if (p.source === 'pull_request') {
    q = `author:${p.login} type:pr created:${range} ${scopeQualifier}`;
  } else if (p.source === 'issue') {
    q = `author:${p.login} type:issue created:${range} ${scopeQualifier}`;
  } else {
    q = `reviewed-by:${p.login} type:pr updated:${range} ${scopeQualifier}`;
  }

  const url = `${GITHUB_API}/search/issues?${new URLSearchParams({
    q,
    per_page: '100',
    advanced_search: 'true',
  }).toString()}`;

  const { items, incomplete } = await searchAllPages(url, headers, `GitHub search (${p.source})`);

  const inScope = items
    .map((item) => {
      const canonical = repoFromUrl(item.repository_url);
      const repo = canonical ? callerFormByLowerCase.get(canonical.toLowerCase()) : undefined;
      return { item, repo };
    })
    .filter((x): x is { item: GhSearchIssue; repo: string } => x.repo !== undefined);

  if (p.source !== 'review') {
    const source = p.source;
    const activities: Activity[] = inScope.map(({ item, repo }) => ({
      kind: source,
      id: `${source}:${repo}#${item.number}`,
      repo,
      timestamp: item.created_at,
      title: item.title,
      url: item.html_url,
    }));
    return { activities, warnings: [], incomplete };
  }

  // `reviewed-by:{login} updated:{range}` means "PRs this person reviewed at
  // some point, that were touched in the range" — it happily attributes a
  // stale review to today. Use it only as a candidate filter, then fetch
  // each PR's actual reviews and keep only the caller's own, submitted
  // inside the true window.
  const windowStart = Date.parse(`${p.startKey}T00:00:00${p.offsetLabel}`);
  const windowEnd = Date.parse(`${p.endKey}T23:59:59${p.offsetLabel}`);
  const warnings: string[] = [];

  const expanded = await mapWithConcurrency(inScope, MAX_CONCURRENCY, async ({ item, repo }) => {
    const [owner, name] = repo.split('/') as [string, string];
    try {
      const reviews = await fetchAllPages<GhReview>(
        `${GITHUB_API}/repos/${segment(owner)}/${segment(name)}/pulls/${item.number}/reviews?per_page=100`,
        headers,
        `GitHub reviews ${repo}#${item.number}`,
      );
      const activities: Activity[] = [];
      for (const r of reviews) {
        if (r.user?.login !== p.login) continue;
        if (!r.submitted_at) continue;
        const t = Date.parse(r.submitted_at);
        if (t < windowStart || t > windowEnd) continue;
        activities.push({
          kind: 'review',
          id: `review:${repo}#${item.number}:${r.id}`,
          repo,
          timestamp: r.submitted_at,
          title: `Review: ${item.title}`,
          url: r.html_url,
        });
      }
      return activities;
    } catch (err) {
      // A single PR's reviews failing to fetch becomes a warning, not an
      // abort — but a SAML/SSO 403 still must propagate (see fetchCommits).
      if (err instanceof AppError && err.code === 'upstream_saml_required') throw err;
      const message = err instanceof AppError ? err.message : 'failed to fetch reviews';
      warnings.push(`${repo}#${item.number}: ${message}`);
      return [];
    }
  });

  return { activities: expanded.flat(), warnings, incomplete };
}
