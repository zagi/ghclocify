import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, mapWithConcurrency, nextPageUrl, MAX_CONCURRENCY } from '../src/http';
import { AppError } from '../src/problems';

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

describe('fetchJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns parsed data, headers and status on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hello: 'world' }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJson<{ hello: string }>('https://api.github.com/foo', {});

    expect(result.data).toEqual({ hello: 'world' });
    expect(result.status).toBe(200);
    expect(result.headers).toBeInstanceOf(Headers);
    expect(result.headers.get('content-type')).toContain('application/json');
  });

  it('sends every request with cache: "no-store"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchJson('https://api.github.com/foo', { headers: { Authorization: 'Bearer x' } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('no-store');
  });

  it('retries a 429 carrying Retry-After: 0 and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJson<{ ok: boolean }>('https://api.github.com/foo', {});

    expect(result.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exhausts the retry budget on a persistent 500 and throws a 502 AppError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);

    const err = await expectAppError(fetchJson('https://api.github.com/foo', {}, { retries: 1 }));

    expect(err.status).toBe(502);
    expect(err.code).toBe('upstream_error');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable, unlisted status (405) and surfaces it as upstream_rejected, not upstream_error', async () => {
    // A definitive refusal `fetchJson` doesn't special-case (unlike 400/404/
    // 409/422/451) must still be distinguishable from a genuinely ambiguous
    // outcome (a retryable status exhausted, or a network failure) -- code
    // consumers like apply.ts's isAmbiguousFailure rely on this split to
    // avoid treating "the server flatly refused" the same as "we don't know
    // if it landed".
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(405));
    vi.stubGlobal('fetch', fetchMock);

    const err = await expectAppError(fetchJson('https://api.github.com/foo', {}, { retries: 2 }));

    expect(err.status).toBe(405);
    expect(err.code).toBe('upstream_rejected');
    // Not retried even though the budget would have allowed it: a
    // non-retryable status is never worth a second attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 401 and surfaces upstream_unauthorized', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    const err = await expectAppError(fetchJson('https://api.github.com/foo', {}));

    expect(err.status).toBe(401);
    expect(err.code).toBe('upstream_unauthorized');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 403 carrying x-github-sso as upstream_saml_required, not a generic 403', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        errorResponse(403, { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const err = await expectAppError(fetchJson('https://api.github.com/orgs/acme/repos', {}));

    expect(err.status).toBe(403);
    expect(err.code).toBe('upstream_saml_required');
    expect(err.message).toMatch(/SSO/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a network rejection (timeout) as a 504 upstream_timeout', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const err = await expectAppError(fetchJson('https://api.github.com/foo', {}, { retries: 0 }));

    expect(err.status).toBe(504);
    expect(err.code).toBe('upstream_timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('nextPageUrl', () => {
  it('extracts the rel="next" URL from a Link header', () => {
    const headers = new Headers({
      link: '<https://api.github.com/foo?page=2>; rel="next", <https://api.github.com/foo?page=5>; rel="last"',
    });
    expect(nextPageUrl(headers)).toBe('https://api.github.com/foo?page=2');
  });

  it('returns null on the last page (no rel="next" entry)', () => {
    const headers = new Headers({
      link: '<https://api.github.com/foo?page=1>; rel="prev", <https://api.github.com/foo?page=1>; rel="first"',
    });
    expect(nextPageUrl(headers)).toBeNull();
  });

  it('returns null when there is no Link header at all', () => {
    expect(nextPageUrl(new Headers())).toBeNull();
  });
});

describe('mapWithConcurrency', () => {
  it('never exceeds the concurrency limit and preserves input order', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let current = 0;
    let max = 0;
    const limit = 3;

    const results = await mapWithConcurrency(items, limit, async (item) => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 5));
      current -= 1;
      return item * 2;
    });

    expect(max).toBeLessThanOrEqual(limit);
    expect(results).toEqual(items.map((i) => i * 2));
  });

  it('respects MAX_CONCURRENCY as the platform connection cap', () => {
    expect(MAX_CONCURRENCY).toBe(6);
  });
});
