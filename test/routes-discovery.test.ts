import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';

const ORIGIN = 'https://gh2clockify.example.workers.dev';
const GH_TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
const CK_KEY = 'ck_test_key_1234567890abcdef';
const WS = '5f1234567890abcdef123456';
const UID = '5f1234567890abcdef654321';

const call = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init, env);

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

const GH_HANDLERS = [
  {
    test: (url: string) => url.includes('api.github.com/user/orgs'),
    respond: () => jsonResponse([{ login: 'acme', avatar_url: 'https://x/o.png' }]),
  },
  {
    test: (url: string) => url.includes('api.github.com/user'),
    respond: () =>
      jsonResponse({ login: 'octocat', name: 'The Octocat', avatar_url: 'https://x/a.png' }),
  },
  {
    test: (url: string) => url.includes('api.github.com/rate_limit'),
    respond: () =>
      jsonResponse({
        resources: {
          core: { limit: 5000, remaining: 4812, reset: 1893456000 },
          search: { limit: 30, remaining: 30, reset: 1893456000 },
        },
      }),
  },
];

const CK_HANDLERS = [
  {
    test: (url: string) => url.includes('clockify.me') && url.endsWith('/user'),
    respond: () => jsonResponse({ id: UID, name: 'Ann', email: 'ann@example.com' }),
  },
  {
    test: (url: string) => url.includes('clockify.me') && url.endsWith('/workspaces'),
    respond: () =>
      jsonResponse([{ id: WS, name: 'Acme Workspace', featureSubscriptionType: 'FREE' }]),
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('discovery routes', () => {
  it('1. GET /api/github/context returns {viewer, orgs, rateLimit}', async () => {
    vi.stubGlobal('fetch', routedFetch(GH_HANDLERS));

    const res = await call('/api/github/context', {
      headers: { 'X-GitHub-Token': GH_TOKEN },
    });

    expect(res.status).toBe(200);
    const body = await res.json<{
      viewer: { login: string };
      orgs: { login: string }[];
      rateLimit: { limit: number; remaining: number; searchRemaining: number };
    }>();
    expect(body.viewer.login).toBe('octocat');
    expect(body.orgs).toEqual([{ login: 'acme', avatarUrl: 'https://x/o.png' }]);
    expect(body.rateLimit).toEqual({
      limit: 5000,
      remaining: 4812,
      resetAt: new Date(1893456000 * 1000).toISOString(),
      searchRemaining: 30,
    });
  });

  it('2. each credential is validated independently', async () => {
    vi.stubGlobal('fetch', routedFetch([...GH_HANDLERS, ...CK_HANDLERS]));

    const ghRes = await call('/api/github/context', {
      headers: { 'X-GitHub-Token': GH_TOKEN },
    });
    expect(ghRes.status).toBe(200);

    const ckRes = await call('/api/clockify/context', {
      headers: { 'X-Clockify-Key': CK_KEY },
    });
    expect(ckRes.status).toBe(200);
  });

  it('3. GET /api/github/repos?scope=org with no org -> 400 invalid_request', async () => {
    vi.stubGlobal('fetch', routedFetch(GH_HANDLERS));

    const res = await call('/api/github/repos?scope=org', {
      headers: { 'X-GitHub-Token': GH_TOKEN },
    });

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
  });

  it('4. a path-traversal org -> 400 and no fetch issued', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should not have been called');
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await call('/api/github/repos?scope=org&org=../../x', {
      headers: { 'X-GitHub-Token': GH_TOKEN },
    });

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('5. GET /api/clockify/projects?workspaceId=not-an-id -> 400 invalid_request', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should not have been called');
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await call('/api/clockify/projects?workspaceId=not-an-id', {
      headers: { 'X-Clockify-Key': CK_KEY },
    });

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('6. GET /api/clockify/entries widens the requested range by ±1 day', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([], { headers: { 'Last-Page': 'true' } }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await call(
      `/api/clockify/entries?workspaceId=${WS}&userId=${UID}&start=2026-01-10T00:00:00Z&end=2026-01-12T00:00:00Z`,
      { headers: { 'X-Clockify-Key': CK_KEY } },
    );

    expect(res.status).toBe(200);
    const [url] = fetchMock.mock.calls[0] as [string];
    const params = new URL(url).searchParams;
    expect(params.get('start')).toBe('2026-01-09T00:00:00Z');
    expect(params.get('end')).toBe('2026-01-13T00:00:00Z');
  });

  it('7. an upstream 401 becomes a 401 upstream_unauthorized, and the body omits the token', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await call('/api/github/context', {
      headers: { 'X-GitHub-Token': GH_TOKEN },
    });

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe('upstream_unauthorized');
    expect(text).not.toContain(GH_TOKEN);
  });
});
