import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';

const ORIGIN = 'https://gh2clockify.example.workers.dev';
const GH_TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

const call = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init, env);

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-GitHub-Token': GH_TOKEN, ...headers },
    body: JSON.stringify(body),
  });

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
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

function neverCalledFetch() {
  return vi.fn(async () => {
    throw new Error('fetch should not have been called');
  });
}

const COMMITS_HANDLER = {
  test: (url: string) => url.includes('/repos/acme/repo/commits'),
  respond: () =>
    jsonResponse([
      {
        sha: 'abc123',
        html_url: 'https://github.com/acme/repo/commit/abc123',
        commit: {
          message: 'Fix bug\n\nDetails here',
          author: { date: '2026-08-01T12:00:00Z' },
        },
      },
    ]),
};

function searchHandler(body: {
  total_count: number;
  incomplete_results: boolean;
  items: unknown[];
}) {
  return {
    test: (url: string) => url.includes('/search/issues'),
    respond: () => jsonResponse(body),
  };
}

const VALID_COMMITS_BODY = {
  repos: ['acme/repo'],
  login: 'octocat',
  sinceIso: '2026-08-01T00:00:00Z',
  untilIso: '2026-08-02T00:00:00Z',
};

const VALID_SEARCH_BODY = {
  source: 'pull_request' as const,
  login: 'octocat',
  scope: { kind: 'personal' as const },
  repos: ['acme/repo'],
  startKey: '2026-08-01',
  endKey: '2026-08-31',
  offsetLabel: '+00:00',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('scan routes', () => {
  it('1. a valid commits chunk returns activities and warnings', async () => {
    vi.stubGlobal('fetch', routedFetch([COMMITS_HANDLER]));

    const res = await post('/api/scan/commits', VALID_COMMITS_BODY);

    expect(res.status).toBe(200);
    const body = await res.json<{
      activities: { id: string }[];
      warnings: string[];
      incomplete: boolean;
    }>();
    expect(body.activities).toEqual([
      expect.objectContaining({ id: 'abc123', repo: 'acme/repo', kind: 'commit' }),
    ]);
    expect(body.warnings).toEqual([]);
    expect(body.incomplete).toBe(false);
  });

  it('2. repos.length = 9 -> 400 invalid_request, and fetch is never called', async () => {
    const fetchMock = neverCalledFetch();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/api/scan/commits', {
      ...VALID_COMMITS_BODY,
      repos: Array.from({ length: 9 }, (_, i) => `acme/repo${i}`),
    });

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('3. a repo full-name failing validation -> 400 before any fetch', async () => {
    const fetchMock = neverCalledFetch();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/api/scan/commits', {
      ...VALID_COMMITS_BODY,
      repos: ['not-a-repo-full-name'],
    });

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4. a search window of 40 days -> 400 invalid_request, and fetch is never called', async () => {
    const fetchMock = neverCalledFetch();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/api/scan/search', {
      ...VALID_SEARCH_BODY,
      startKey: '2026-01-01',
      endKey: '2026-02-10',
    });

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('5. a body over 128 KB -> 413 body_too_large, and fetch is never called', async () => {
    const fetchMock = neverCalledFetch();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/api/scan/commits', {
      ...VALID_COMMITS_BODY,
      padding: 'a'.repeat(200_000),
    });

    expect(res.status).toBe(413);
    expect((await res.json<{ error: string }>()).error).toBe('body_too_large');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("6. source: 'commit' on /api/scan/search -> 400, and fetch is never called", async () => {
    const fetchMock = neverCalledFetch();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/api/scan/search', { ...VALID_SEARCH_BODY, source: 'commit' });

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('7. incomplete: true from the client is passed through to the response', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch([searchHandler({ total_count: 1, incomplete_results: true, items: [] })]),
    );

    const res = await post('/api/scan/search', VALID_SEARCH_BODY);

    expect(res.status).toBe(200);
    const body = await res.json<{ incomplete: boolean }>();
    expect(body.incomplete).toBe(true);
  });

  it('8. a missing X-GitHub-Token -> 401, and fetch is never called', async () => {
    const fetchMock = neverCalledFetch();
    vi.stubGlobal('fetch', fetchMock);

    const res = await call('/api/scan/commits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_COMMITS_BODY),
    });

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
