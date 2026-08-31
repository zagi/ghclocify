import { afterEach, describe, expect, it, vi } from 'vitest';
import { getViewer, listRepos, fetchCommits, fetchSearch } from '../src/github';
import { AppError } from '../src/problems';

const TOKEN = 'ghp_test1234567890abcdef';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response('nope', { status, headers });
}

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected promise to reject with AppError');
}

/** Routes a stubbed fetch by matching the request URL against handlers in order. */
function routedFetch(
  handlers: Array<{ test: (url: string) => boolean; respond: (url: string) => Response }>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    for (const h of handlers) {
      if (h.test(url)) return h.respond(url);
    }
    throw new Error(`unmocked fetch: ${url}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('github client', () => {
  it('1. getViewer sends Bearer, application/vnd.github+json, X-GitHub-Api-Version and a User-Agent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        login: 'octocat',
        name: 'The Octocat',
        avatar_url: 'https://example.com/a.png',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const viewer = await getViewer(TOKEN);

    expect(viewer).toEqual({
      login: 'octocat',
      name: 'The Octocat',
      avatarUrl: 'https://example.com/a.png',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user');
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('Accept')).toBe('application/vnd.github+json');
    expect(headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
    expect(headers.get('User-Agent')).toBe('gh2clockify');
  });

  it('2. listRepos hits /user/repos for personal scope and /orgs/{org}/repos for org scope', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await listRepos(TOKEN, { kind: 'personal' });
    await listRepos(TOKEN, { kind: 'org', org: 'acme' });

    const urls = fetchMock.mock.calls.map(([url]) => (url as string).toString());
    expect(urls[0]).toBe(
      'https://api.github.com/user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100',
    );
    expect(urls[1]).toBe(
      'https://api.github.com/orgs/acme/repos?type=all&sort=pushed&per_page=100',
    );
  });

  it('3. pagination follows Link rel="next" and concatenates both pages', async () => {
    const page1 = [
      {
        full_name: 'acme/repo-a',
        name: 'repo-a',
        owner: { login: 'acme' },
        private: false,
        archived: false,
        fork: false,
        pushed_at: '2026-08-01T00:00:00Z',
      },
    ];
    const page2 = [
      {
        full_name: 'acme/repo-b',
        name: 'repo-b',
        owner: { login: 'acme' },
        private: false,
        archived: false,
        fork: false,
        pushed_at: '2026-08-02T00:00:00Z',
      },
    ];
    const fetchMock = routedFetch([
      { test: (u) => u.includes('page=2'), respond: () => jsonResponse(page2) },
      {
        test: (u) => u.includes('/user/repos'),
        respond: () =>
          jsonResponse(page1, {
            headers: {
              link: '<https://api.github.com/user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100&page=2>; rel="next"',
            },
          }),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const repos = await listRepos(TOKEN, { kind: 'personal' });

    expect(repos.map((r) => r.fullName).sort()).toEqual(['acme/repo-a', 'acme/repo-b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('4. a commit maps to Activity with SHA as id, commit.author.date as timestamp and a first-line-only title', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          sha: 'deadbeef',
          html_url: 'https://github.com/acme/repo/commit/deadbeef',
          commit: {
            message: 'Fix the thing\n\nLonger body explaining why.',
            author: { date: '2026-08-03T09:00:00Z' },
            committer: { date: '2026-08-03T10:00:00Z' },
          },
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCommits(TOKEN, {
      repos: ['acme/repo'],
      login: 'octocat',
      sinceIso: '2026-08-03T00:00:00Z',
      untilIso: '2026-08-04T00:00:00Z',
    });

    expect(result.activities).toEqual([
      {
        kind: 'commit',
        id: 'deadbeef',
        repo: 'acme/repo',
        timestamp: '2026-08-03T09:00:00Z',
        title: 'Fix the thing',
        url: 'https://github.com/acme/repo/commit/deadbeef',
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('5. widens the request window by a day and re-filters an out-of-range commit back out', async () => {
    const sinceIso = '2026-08-03T00:00:00.000Z';
    const untilIso = '2026-08-04T00:00:00.000Z';

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        // committer date lands inside the widened window; author date is a
        // day before the TRUE start — a naive implementation that skips
        // re-filtering would keep this. It must be dropped.
        {
          sha: 'outside',
          html_url: 'https://github.com/acme/repo/commit/outside',
          commit: {
            message: 'Rebased commit',
            author: { date: '2026-08-02T12:00:00Z' },
            committer: { date: '2026-08-03T12:00:00Z' },
          },
        },
        // squarely inside the true window — must be kept.
        {
          sha: 'inside',
          html_url: 'https://github.com/acme/repo/commit/inside',
          commit: {
            message: 'Normal commit',
            author: { date: '2026-08-03T15:00:00Z' },
            committer: { date: '2026-08-03T15:00:00Z' },
          },
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCommits(TOKEN, {
      repos: ['acme/repo'],
      login: 'octocat',
      sinceIso,
      untilIso,
    });

    // A naive (unwidened) implementation would send since/until equal to
    // the requested window; assert the actual request was widened a day
    // either side.
    const [url] = fetchMock.mock.calls[0] as [string];
    const params = new URL(url).searchParams;
    expect(params.get('since')).toBe('2026-08-02T00:00:00.000Z');
    expect(params.get('until')).toBe('2026-08-05T00:00:00.000Z');

    expect(result.activities.map((a) => a.id)).toEqual(['inside']);
  });

  it('6. a repo returning 409 yields a warning and an empty list; other repos still return their commits', async () => {
    const fetchMock = routedFetch([
      {
        test: (u) => u.includes('/repos/acme/empty-repo/commits'),
        respond: () => errorResponse(409),
      },
      {
        test: (u) => u.includes('/repos/acme/active-repo/commits'),
        respond: () =>
          jsonResponse([
            {
              sha: 'sha1',
              html_url: 'https://github.com/acme/active-repo/commit/sha1',
              commit: { message: 'did work', author: { date: '2026-08-03T09:00:00Z' } },
            },
          ]),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCommits(TOKEN, {
      repos: ['acme/empty-repo', 'acme/active-repo'],
      login: 'octocat',
      sinceIso: '2026-08-03T00:00:00Z',
      untilIso: '2026-08-04T00:00:00Z',
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('acme/empty-repo');
    expect(result.activities.map((a) => a.id)).toEqual(['sha1']);
  });

  it('7. a repo returning 404 yields a warning and an empty list; other repos still return their commits', async () => {
    const fetchMock = routedFetch([
      {
        test: (u) => u.includes('/repos/acme/no-access/commits'),
        respond: () => errorResponse(404),
      },
      {
        test: (u) => u.includes('/repos/acme/active-repo/commits'),
        respond: () =>
          jsonResponse([
            {
              sha: 'sha1',
              html_url: 'https://github.com/acme/active-repo/commit/sha1',
              commit: { message: 'did work', author: { date: '2026-08-03T09:00:00Z' } },
            },
          ]),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCommits(TOKEN, {
      repos: ['acme/no-access', 'acme/active-repo'],
      login: 'octocat',
      sinceIso: '2026-08-03T00:00:00Z',
      untilIso: '2026-08-04T00:00:00Z',
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('acme/no-access');
    expect(result.activities.map((a) => a.id)).toEqual(['sha1']);
  });

  it('8. a 403 with x-github-sso propagates rather than becoming a warning', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        errorResponse(403, { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const err = await expectAppError(
      fetchCommits(TOKEN, {
        repos: ['acme/repo'],
        login: 'octocat',
        sinceIso: '2026-08-03T00:00:00Z',
        untilIso: '2026-08-04T00:00:00Z',
      }),
    );

    expect(err.status).toBe(403);
    expect(err.code).toBe('upstream_saml_required');
  });

  it('9. advanced_search=true is present on every search request', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ total_count: 0, incomplete_results: false, items: [] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    for (const source of ['pull_request', 'issue', 'review'] as const) {
      await fetchSearch(TOKEN, {
        source,
        login: 'octocat',
        scope: { kind: 'personal' },
        repos: ['acme/repo'],
        startKey: '2026-08-01',
        endKey: '2026-08-31',
        offsetLabel: '+00:00',
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url] of fetchMock.mock.calls as [string][]) {
      expect(new URL(url).searchParams.get('advanced_search')).toBe('true');
    }
  });

  it('10. search date qualifiers carry the offset label', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ total_count: 0, incomplete_results: false, items: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchSearch(TOKEN, {
      source: 'pull_request',
      login: 'octocat',
      scope: { kind: 'personal' },
      repos: ['acme/repo'],
      startKey: '2026-08-01',
      endKey: '2026-08-31',
      offsetLabel: '+02:00',
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    const q = new URL(url).searchParams.get('q') ?? '';
    expect(q).toContain('+02:00');
  });

  it('11. search results whose repository_url is outside the selection are dropped', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            number: 1,
            title: 'In scope',
            html_url: 'https://github.com/acme/repo/pull/1',
            repository_url: 'https://api.github.com/repos/acme/repo',
            created_at: '2026-08-03T09:00:00Z',
          },
          {
            number: 2,
            title: 'Out of scope',
            html_url: 'https://github.com/other/thing/pull/2',
            repository_url: 'https://api.github.com/repos/other/thing',
            created_at: '2026-08-03T09:00:00Z',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSearch(TOKEN, {
      source: 'pull_request',
      login: 'octocat',
      scope: { kind: 'personal' },
      repos: ['acme/repo'],
      startKey: '2026-08-01',
      endKey: '2026-08-31',
      offsetLabel: '+00:00',
    });

    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]?.repo).toBe('acme/repo');
  });

  it('12. incomplete_results: true sets incomplete: true', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ total_count: 1, incomplete_results: true, items: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSearch(TOKEN, {
      source: 'issue',
      login: 'octocat',
      scope: { kind: 'personal' },
      repos: ['acme/repo'],
      startKey: '2026-08-01',
      endKey: '2026-08-31',
      offsetLabel: '+00:00',
    });

    expect(result.incomplete).toBe(true);
  });

  it("13. a reviewed-by hit is expanded via /pulls/{n}/reviews and only the caller's own in-range review survives", async () => {
    const fetchMock = routedFetch([
      {
        test: (u) => u.includes('/search/issues'),
        respond: () =>
          jsonResponse({
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                number: 5,
                title: 'Some PR',
                html_url: 'https://github.com/acme/repo/pull/5',
                repository_url: 'https://api.github.com/repos/acme/repo',
                created_at: '2026-08-01T00:00:00Z',
              },
            ],
          }),
      },
      {
        test: (u) => u.includes('/repos/acme/repo/pulls/5/reviews'),
        respond: () =>
          jsonResponse([
            // caller's own review, inside the range — kept.
            {
              id: 1,
              user: { login: 'octocat' },
              submitted_at: '2026-08-10T12:00:00Z',
              html_url: 'https://github.com/acme/repo/pull/5#pullrequestreview-1',
            },
            // someone else's review, inside the range — dropped.
            {
              id: 2,
              user: { login: 'someone-else' },
              submitted_at: '2026-08-10T13:00:00Z',
              html_url: 'https://github.com/acme/repo/pull/5#pullrequestreview-2',
            },
            // caller's own review, but dated outside the range — dropped.
            {
              id: 3,
              user: { login: 'octocat' },
              submitted_at: '2024-01-01T00:00:00Z',
              html_url: 'https://github.com/acme/repo/pull/5#pullrequestreview-3',
            },
          ]),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSearch(TOKEN, {
      source: 'review',
      login: 'octocat',
      scope: { kind: 'personal' },
      repos: ['acme/repo'],
      startKey: '2026-08-01',
      endKey: '2026-08-31',
      offsetLabel: '+00:00',
    });

    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]?.id).toBe('review:acme/repo#5:1');
    expect(result.activities[0]?.timestamp).toBe('2026-08-10T12:00:00Z');
  });

  it('14. a path-traversal owner is rejected before any fetch is issued', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const err = await expectAppError(
      fetchCommits(TOKEN, {
        repos: ['../../etc/passwd'],
        login: 'octocat',
        sinceIso: '2026-08-03T00:00:00Z',
        untilIso: '2026-08-04T00:00:00Z',
      }),
    );

    expect(err.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
