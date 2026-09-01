import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';
import type { ApplyResult } from '../src/types';

const ORIGIN = 'https://gh2clockify.example.workers.dev';
const CK_KEY = 'ck_test_key_1234567890abcdef';
const WS = '5f1234567890abcdef123456';
const UID = '5f1234567890abcdef654321';
const PROJECT_ID = '5f1234567890abcdef111111';

const call = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init, env);

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Clockify-Key': CK_KEY, ...headers },
    body: JSON.stringify(body),
  });

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function errorResponse(status: number): Response {
  return new Response('nope', { status });
}

/** Routes a stubbed fetch by matching the request URL against handlers in order. */
function routedFetch(
  handlers: Array<{ test: (url: string, init?: RequestInit) => boolean; respond: () => Response }>,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    for (const h of handlers) {
      if (h.test(url, init)) return h.respond();
    }
    throw new Error(`unmocked fetch: ${url} ${init?.method ?? 'GET'}`);
  });
}

function neverCalledFetch() {
  return vi.fn(async () => {
    throw new Error('fetch should not have been called');
  });
}

/** listEntries hits `/workspaces/{ws}/user/{uid}/time-entries`; createEntry
 *  hits `/workspaces/{ws}/time-entries` — no `/user/` segment — so the two
 *  are distinguishable by URL shape alone. */
const isListEntries = (url: string) => url.includes('/user/') && url.includes('/time-entries');
const isCreateEntry = (url: string, init?: RequestInit) =>
  !url.includes('/user/') && url.includes('/time-entries') && init?.method === 'POST';
/** getUser hits `/user` exactly — no `/time-entries` suffix, so it's
 *  distinguishable from both of the above by URL shape alone. */
const isGetUser = (url: string) => url.endsWith('/user');

/** The apply route now calls getUser(key, base) up front (finding #4: the
 *  client-supplied userId must match the API key's actual owner), so every
 *  test that expects the batch to proceed needs this handler wired in. */
function userHandler(id: string) {
  return {
    test: isGetUser,
    respond: () => jsonResponse({ id, name: 'Ann', email: 'ann@example.com' }),
  };
}

function emptyListHandler() {
  return {
    test: isListEntries,
    respond: () => jsonResponse([], { headers: { 'Last-Page': 'true' } }),
  };
}

function existingEntryHandler(start: string) {
  return {
    test: isListEntries,
    respond: () =>
      jsonResponse(
        [
          {
            id: 'existing-1',
            timeInterval: { start, end: null },
            description: 'already logged',
            projectId: PROJECT_ID,
          },
        ],
        { headers: { 'Last-Page': 'true' } },
      ),
  };
}

function createHandler(id: string) {
  return { test: isCreateEntry, respond: () => jsonResponse({ id }) };
}

const ENTRY_1 = {
  date: '2026-08-01',
  start: '2026-08-01T09:00:00Z',
  end: '2026-08-01T17:00:00Z',
  description: 'Did some work',
  billable: true,
  projectId: PROJECT_ID,
  activityCount: 3,
  repos: ['acme/repo'],
};

const ENTRY_2 = {
  date: '2026-08-02',
  start: '2026-08-02T09:00:00Z',
  end: '2026-08-02T17:00:00Z',
  description: 'Did more work',
  billable: true,
  projectId: PROJECT_ID,
  activityCount: 2,
  repos: ['acme/repo'],
};

const VALID_BODY = {
  host: 'api',
  workspaceId: WS,
  userId: UID,
  timezone: 'UTC',
  entries: [ENTRY_1, ENTRY_2],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('apply route', () => {
  it('1. two new entries -> two POSTs, results both ok:true with entry ids', async () => {
    let createCount = 0;
    vi.stubGlobal(
      'fetch',
      routedFetch([
        userHandler(UID),
        emptyListHandler(),
        {
          test: isCreateEntry,
          respond: () => {
            createCount += 1;
            return jsonResponse({ id: `new-${createCount}` });
          },
        },
      ]),
    );

    const res = await post('/api/apply', VALID_BODY);

    expect(res.status).toBe(200);
    const body = await res.json<{ results: ApplyResult[] }>();
    expect(body.results).toEqual([
      { date: '2026-08-01', ok: true, entryId: 'new-1' },
      { date: '2026-08-02', ok: true, entryId: 'new-2' },
    ]);
    expect(createCount).toBe(2);
  });

  it('2. an entry that already exists is skipped with no POST', async () => {
    const fetchMock = routedFetch([
      userHandler(UID),
      existingEntryHandler(ENTRY_1.start),
      { test: isCreateEntry, respond: () => jsonResponse({ id: 'should-not-happen' }) },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/api/apply', { ...VALID_BODY, entries: [ENTRY_1] });

    expect(res.status).toBe(200);
    const body = await res.json<{ results: ApplyResult[] }>();
    expect(body.results).toEqual([
      { date: '2026-08-01', ok: true, skipped: true, error: 'Already exists' },
    ]);
    // Airtight: no call to fetch ever had method POST.
    const postCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCalls).toHaveLength(0);
  });

  it('3. entries.length = 6 -> 400 invalid_request, no writes', async () => {
    const fetchMock = neverCalledFetch();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/api/apply', {
      ...VALID_BODY,
      entries: Array.from({ length: 6 }, (_, i) => ({
        ...ENTRY_1,
        date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      })),
    });

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4. a 400 on entry 1 does not stop entry 2 — one failure, one success', async () => {
    let createCalls = 0;
    vi.stubGlobal(
      'fetch',
      routedFetch([
        userHandler(UID),
        emptyListHandler(),
        {
          test: isCreateEntry,
          respond: () => {
            createCalls += 1;
            return createCalls === 1 ? errorResponse(400) : jsonResponse({ id: 'new-2' });
          },
        },
      ]),
    );

    const res = await post('/api/apply', VALID_BODY);

    expect(res.status).toBe(200);
    const body = await res.json<{ results: ApplyResult[] }>();
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toEqual(expect.objectContaining({ date: '2026-08-01', ok: false }));
    expect(body.results[1]).toEqual({ date: '2026-08-02', ok: true, entryId: 'new-2' });
    expect(createCalls).toBe(2);
  });

  it('5. the duplicate pre-check fetches entries once for the batch, not once per entry', async () => {
    let listCalls = 0;
    vi.stubGlobal(
      'fetch',
      routedFetch([
        userHandler(UID),
        {
          test: isListEntries,
          respond: () => {
            listCalls += 1;
            return jsonResponse([], { headers: { 'Last-Page': 'true' } });
          },
        },
        createHandler('new-id'),
      ]),
    );

    const res = await post('/api/apply', VALID_BODY);

    expect(res.status).toBe(200);
    expect(listCalls).toBe(1);
  });

  it('6. writes happen sequentially — the second POST starts only after the first resolves', async () => {
    let createCalls = 0;
    let firstResolved = false;
    vi.stubGlobal(
      'fetch',
      routedFetch([
        userHandler(UID),
        emptyListHandler(),
        {
          test: isCreateEntry,
          respond: () => {
            createCalls += 1;
            if (createCalls === 1) {
              return new Response(
                new ReadableStream({
                  async start(controller) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    firstResolved = true;
                    controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: 'new-1' })));
                    controller.close();
                  },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              );
            }
            // If this runs before the first POST's body finished streaming,
            // the implementation is firing writes concurrently.
            expect(firstResolved).toBe(true);
            return jsonResponse({ id: 'new-2' });
          },
        },
      ]),
    );

    const res = await post('/api/apply', VALID_BODY);

    expect(res.status).toBe(200);
    expect(createCalls).toBe(2);
    expect(firstResolved).toBe(true);
  });

  it('7. a missing X-Clockify-Key -> 401', async () => {
    const fetchMock = neverCalledFetch();
    vi.stubGlobal('fetch', fetchMock);

    const res = await call('/api/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('8. an invalid host -> 400, no writes', async () => {
    const fetchMock = neverCalledFetch();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/api/apply', { ...VALID_BODY, host: 'not-a-real-region' });

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('9. entry.date must match the local day of entry.start -- a mismatch is rejected 400, no fetch issued', async () => {
    const fetchMock = neverCalledFetch();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/api/apply', {
      ...VALID_BODY,
      // start is still 2026-08-01T09:00:00Z; date claims a different day.
      entries: [{ ...ENTRY_1, date: '2026-01-01' }],
    });

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('10. a mismatched date can no longer smuggle a duplicate write past the pre-check', async () => {
    // Mirrors the exploit this closes: a proposed entry whose `start` truly
    // falls on 2026-08-03 (where a matching entry already exists) but
    // claims an unrelated `date`. Before the fix, `findDuplicate` compared
    // against the false claimed date and could miss the real duplicate,
    // reaching `createEntry` and writing a second entry on 2026-08-03. Now
    // the mismatch is rejected before any fetch is issued at all, so the
    // "existing" entry below is never even queried for.
    const fetchMock = routedFetch([
      existingEntryHandler('2026-08-03T09:00:00Z'),
      { test: isCreateEntry, respond: () => jsonResponse({ id: 'should-not-happen' }) },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/api/apply', {
      ...VALID_BODY,
      entries: [
        {
          ...ENTRY_1,
          date: '2026-01-01',
          start: '2026-08-03T09:00:00Z',
          end: '2026-08-03T17:00:00Z',
        },
      ],
    });

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('11. a definitive but unlisted POST failure (405) is recorded as a failure without triggering a recheck GET', async () => {
    let listCalls = 0;
    vi.stubGlobal(
      'fetch',
      routedFetch([
        userHandler(UID),
        {
          test: isListEntries,
          respond: () => {
            listCalls += 1;
            return jsonResponse([], { headers: { 'Last-Page': 'true' } });
          },
        },
        { test: isCreateEntry, respond: () => errorResponse(405) },
      ]),
    );

    const res = await post('/api/apply', { ...VALID_BODY, entries: [ENTRY_1] });

    expect(res.status).toBe(200);
    const body = await res.json<{ results: ApplyResult[] }>();
    expect(body.results).toEqual([expect.objectContaining({ date: '2026-08-01', ok: false })]);
    // Only the batch-level pre-check GET -- a 405 is a definitive refusal,
    // not an ambiguous one, so it must not spend a second GET on a recheck.
    expect(listCalls).toBe(1);
  });

  it('12. an ambiguous POST failure (500) triggers a recheck GET and reports success if the write actually landed', async () => {
    let listCalls = 0;
    vi.stubGlobal(
      'fetch',
      routedFetch([
        userHandler(UID),
        {
          test: isListEntries,
          respond: () => {
            listCalls += 1;
            if (listCalls === 1) {
              // Batch-level pre-check: nothing exists yet.
              return jsonResponse([], { headers: { 'Last-Page': 'true' } });
            }
            // Recheck after the ambiguous 500: the write actually landed.
            return jsonResponse(
              [
                {
                  id: 'landed-1',
                  timeInterval: { start: ENTRY_1.start, end: null },
                  description: 'x',
                  projectId: PROJECT_ID,
                },
              ],
              { headers: { 'Last-Page': 'true' } },
            );
          },
        },
        { test: isCreateEntry, respond: () => errorResponse(500) },
      ]),
    );

    const res = await post('/api/apply', { ...VALID_BODY, entries: [ENTRY_1] });

    expect(res.status).toBe(200);
    const body = await res.json<{ results: ApplyResult[] }>();
    expect(body.results).toEqual([
      { date: '2026-08-01', ok: true, skipped: true, error: 'Already exists' },
    ]);
    expect(listCalls).toBe(2);
  });

  it('13. userId mismatching the API key owner is rejected 400 before any duplicate check or write', async () => {
    const fetchMock = routedFetch([
      userHandler('some-other-user-id'),
      emptyListHandler(),
      { test: isCreateEntry, respond: () => jsonResponse({ id: 'should-not-happen' }) },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/api/apply', VALID_BODY);

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request');
    const postCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCalls).toHaveLength(0);
  });

  it('14. a recheck that itself fails does not discard results already accumulated in the batch', async () => {
    // Two entries: the first POST fails ambiguously (500) and its recheck
    // GET also fails (500) -- that must not wipe out the second entry's
    // successful write, which happens after it in the same batch.
    let listCalls = 0;
    let createCalls = 0;
    vi.stubGlobal(
      'fetch',
      routedFetch([
        userHandler(UID),
        {
          test: isListEntries,
          respond: () => {
            listCalls += 1;
            if (listCalls === 1) {
              // Batch-level pre-check: nothing exists yet.
              return jsonResponse([], { headers: { 'Last-Page': 'true' } });
            }
            // The recheck after entry 1's ambiguous failure also fails.
            return errorResponse(500);
          },
        },
        {
          test: isCreateEntry,
          respond: () => {
            createCalls += 1;
            return createCalls === 1 ? errorResponse(500) : jsonResponse({ id: 'new-2' });
          },
        },
      ]),
    );

    const res = await post('/api/apply', VALID_BODY);

    expect(res.status).toBe(200);
    const body = await res.json<{ results: ApplyResult[] }>();
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toEqual(expect.objectContaining({ date: '2026-08-01', ok: false }));
    expect(body.results[0]?.error).toContain('could not confirm whether it landed');
    expect(body.results[1]).toEqual({ date: '2026-08-02', ok: true, entryId: 'new-2' });
  });
});
