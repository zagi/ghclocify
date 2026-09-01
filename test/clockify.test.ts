import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseUrl,
  createEntry,
  getUser,
  listEntries,
  listProjects,
  listWorkspaces,
} from '../src/clockify';
import { AppError } from '../src/problems';
import type { ProposedEntry } from '../src/types';

const KEY = 'ck_test_key_1234567890abcdef';
const BASE = 'https://api.clockify.me/api/v1';
const WS = '5f1234567890abcdef123456';
const UID = '5f1234567890abcdef654321';

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('clockify client', () => {
  it('1. every request carries X-Api-Key and no Authorization header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: UID, name: 'Ann', email: 'ann@example.com' }));
    vi.stubGlobal('fetch', fetchMock);

    await getUser(KEY, BASE);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('X-Api-Key')).toBe(KEY);
    expect(headers.get('Authorization')).toBeNull();
  });

  it('2. baseUrl resolves regions and subdomains, rejects unknown region and malformed subdomain', () => {
    expect(baseUrl('euc1')).toBe('https://euc1.clockify.me/api/v1');
    expect(baseUrl('api', 'acme')).toBe('https://acme.clockify.me/api/v1');
    expect(() => baseUrl('bogus' as never)).toThrow(AppError);
    expect(() => baseUrl('api', 'not a valid subdomain!')).toThrow(AppError);
    try {
      baseUrl('bogus' as never);
    } catch (err) {
      expect((err as AppError).status).toBe(400);
    }
  });

  it('3. listProjects requests page-size=5000 and archived=false, paginates on Last-Page', async () => {
    const page1 = [{ id: 'p1', name: 'Project One', clientName: null }];
    const page2 = [{ id: 'p2', name: 'Project Two', clientName: 'Acme' }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1, { headers: { 'Last-Page': 'false' } }))
      .mockResolvedValueOnce(jsonResponse(page2, { headers: { 'Last-Page': 'true' } }));
    vi.stubGlobal('fetch', fetchMock);

    const projects = await listProjects(KEY, BASE, WS);

    expect(projects).toEqual([
      { id: 'p1', name: 'Project One', clientName: null },
      { id: 'p2', name: 'Project Two', clientName: 'Acme' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url1 = new URL(fetchMock.mock.calls[0]?.[0] as string);
    const url2 = new URL(fetchMock.mock.calls[1]?.[0] as string);
    expect(url1.searchParams.get('page-size')).toBe('5000');
    expect(url1.searchParams.get('archived')).toBe('false');
    expect(url1.searchParams.get('page')).toBe('1');
    expect(url2.searchParams.get('page')).toBe('2');
  });

  it('4. listEntries passes start/end through and paginates the same way', async () => {
    const entry = {
      id: 'e1',
      timeInterval: { start: '2026-08-01T09:00:00Z', end: '2026-08-01T17:00:00Z' },
      description: 'work',
      projectId: 'p1',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([entry], { headers: { 'Last-Page': 'false' } }))
      .mockResolvedValueOnce(jsonResponse([], { headers: { 'Last-Page': 'true' } }));
    vi.stubGlobal('fetch', fetchMock);

    const entries = await listEntries(
      KEY,
      BASE,
      WS,
      UID,
      '2026-08-01T00:00:00Z',
      '2026-08-02T00:00:00Z',
    );

    expect(entries).toEqual([
      {
        id: 'e1',
        start: '2026-08-01T09:00:00Z',
        end: '2026-08-01T17:00:00Z',
        description: 'work',
        projectId: 'p1',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url1 = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url1.searchParams.get('start')).toBe('2026-08-01T00:00:00Z');
    expect(url1.searchParams.get('end')).toBe('2026-08-02T00:00:00Z');
    expect(url1.searchParams.get('page-size')).toBe('5000');
    const url2 = new URL(fetchMock.mock.calls[1]?.[0] as string);
    expect(url2.searchParams.get('page')).toBe('2');
  });

  it('5. createEntry POSTs the exact body with taskId: null, type: REGULAR, and no userId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'new-entry-id' }));
    vi.stubGlobal('fetch', fetchMock);

    const proposed: ProposedEntry = {
      date: '2026-08-01',
      start: '2026-08-01T09:00:00Z',
      end: '2026-08-01T17:00:00Z',
      description: 'Did some work',
      billable: true,
      projectId: 'p1',
      activityCount: 3,
      repos: ['acme/repo'],
    };

    const result = await createEntry(KEY, BASE, WS, proposed);

    expect(result).toEqual({ id: 'new-entry-id' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/workspaces/${WS}/time-entries`);
    expect(init.method).toBe('POST');
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(parsed).toEqual({
      start: '2026-08-01T09:00:00Z',
      end: '2026-08-01T17:00:00Z',
      billable: true,
      description: 'Did some work',
      projectId: 'p1',
      taskId: null,
      tagIds: [],
      type: 'REGULAR',
    });
    expect('userId' in parsed).toBe(false);
  });

  it('6. a 401 surfaces as AppError 401 upstream_unauthorized', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    const err = await expectAppError(getUser(KEY, BASE));

    expect(err.status).toBe(401);
    expect(err.code).toBe('upstream_unauthorized');
  });

  it('7. getUser maps settings.timeZone into timezone and tolerates it being absent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: UID,
          name: 'Ann',
          email: 'ann@example.com',
          settings: { timeZone: 'Europe/Warsaw' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: UID, name: 'Ann', email: 'ann@example.com' }));
    vi.stubGlobal('fetch', fetchMock);

    const withTz = await getUser(KEY, BASE);
    expect(withTz.timezone).toBe('Europe/Warsaw');

    const withoutTz = await getUser(KEY, BASE);
    expect(withoutTz.timezone).toBeNull();
  });

  it('8. listWorkspaces sets freeTier true for FREE featureSubscriptionType and false otherwise', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { id: 'w1', name: 'Free WS', featureSubscriptionType: 'FREE' },
        { id: 'w2', name: 'Paid WS', featureSubscriptionType: 'STANDARD' },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const workspaces = await listWorkspaces(KEY, BASE);

    expect(workspaces).toEqual([
      { id: 'w1', name: 'Free WS', plan: 'FREE', freeTier: true },
      { id: 'w2', name: 'Paid WS', plan: 'STANDARD', freeTier: false },
    ]);
  });

  it('8b. listWorkspaces treats a missing/null featureSubscriptionType as freeTier: true, plan: UNKNOWN', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { id: 'w3', name: 'No Field WS' },
        { id: 'w4', name: 'Null Field WS', featureSubscriptionType: null },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const workspaces = await listWorkspaces(KEY, BASE);

    expect(workspaces).toEqual([
      { id: 'w3', name: 'No Field WS', plan: 'UNKNOWN', freeTier: true },
      { id: 'w4', name: 'Null Field WS', plan: 'UNKNOWN', freeTier: true },
    ]);
  });

  it('8c. listWorkspaces treats FREE_2026 (and other FREE-prefixed/cased values) as freeTier: true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { id: 'w5', name: 'Free 2026 WS', featureSubscriptionType: 'FREE_2026' },
        { id: 'w6', name: 'lowercase free WS', featureSubscriptionType: 'free' },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const workspaces = await listWorkspaces(KEY, BASE);

    expect(workspaces).toEqual([
      { id: 'w5', name: 'Free 2026 WS', plan: 'FREE_2026', freeTier: true },
      { id: 'w6', name: 'lowercase free WS', plan: 'free', freeTier: true },
    ]);
  });

  it('11. fetchAllPages terminates on an empty page even with no Last-Page header, not after MAX_PAGES', async () => {
    const page1 = [{ id: 'p1', name: 'Project One', clientName: null }];
    const fetchMock = vi
      .fn()
      // No Last-Page header at all on either response.
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const projects = await listProjects(KEY, BASE, WS);

    expect(projects).toEqual([{ id: 'p1', name: 'Project One', clientName: null }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('10. a failing createEntry POST is attempted exactly once (no automatic retry)', async () => {
    // Clockify has no idempotency key: a retried POST after a lost response
    // is exactly how a duplicate time entry gets created. `retries: 0`
    // means a single 500 must surface immediately, with no second attempt.
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);

    const proposed: ProposedEntry = {
      date: '2026-08-01',
      start: '2026-08-01T09:00:00Z',
      end: '2026-08-01T17:00:00Z',
      description: 'Did some work',
      billable: true,
      projectId: 'p1',
      activityCount: 3,
      repos: ['acme/repo'],
    };

    const err = await expectAppError(createEntry(KEY, BASE, WS, proposed));

    expect(err.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('9. a workspace id failing isClockifyId is rejected before any fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const err = await expectAppError(listProjects(KEY, BASE, 'not-a-valid-id'));

    expect(err.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
