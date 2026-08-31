/**
 * The only endpoint in this product that writes to Clockify.
 *
 * Every safeguard here traces back to one fact: Clockify's API has no
 * idempotency key. A response lost after a successful write looks, from
 * this Worker's point of view, identical to a write that never landed —
 * and blindly retrying is exactly how re-running an import doubles
 * someone's logged hours, the failure mode this product exists to replace.
 * See `createEntry` in `../clockify.ts` (`retries: 0`, with the same
 * reasoning) and the ambiguous-failure handling below.
 */
import { Hono } from 'hono';
import type { Env } from '../index';
import { requireClockify, readCappedJson } from '../credentials';
import { AppError } from '../problems';
import { isClockifyHost, isClockifyId, isDateKey } from '../validate';
import { isValidTimezone, toClockifyIso } from '../timezone';
import { baseUrl, createEntry, listEntries } from '../clockify';
import { findDuplicate } from '../plan';
import type { ApplyResult, ProposedEntry } from '../types';

export const applyRoutes = new Hono<{ Bindings: Env }>();

/**
 * Rule 1: the client sends batches and shows progress; a killed request can
 * then lose at most this many writes, each individually reported.
 */
const MAX_ENTRIES = 5;

const DAY_MS = 86_400_000;

/** `yyyy-MM-ddThh:mm:ssZ`, no milliseconds — matches `ProposedEntry`'s own
 *  documented "second precision" contract, which is exactly what
 *  `aggregate.ts`'s `toClockifyIso` produces. Stricter than the read-only
 *  routes' `ISO_INSTANT_RE` (which tolerates millis) is deliberate: this is
 *  the write path. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Mirrors `describe.ts`'s `CLOCKIFY_MAX_DESCRIPTION` — duplicated rather
 *  than imported to keep this route's validation self-contained; both are
 *  Clockify's documented server limit and must not drift apart. */
const MAX_DESCRIPTION_CODEPOINTS = 3000;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError(400, 'invalid_request', 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/**
 * Mirrors `routes/clockify.ts`'s `resolveBase` and `baseUrl`'s own
 * precedence: a present, non-empty `subdomain` wins over `host`. Read from
 * the JSON body here (a POST route) rather than query parameters.
 */
function resolveBase(body: Record<string, unknown>): string {
  const subdomain = body.subdomain;
  if (typeof subdomain === 'string' && subdomain) {
    return baseUrl('api', subdomain);
  }
  const host = body.host;
  if (typeof host !== 'string' || !isClockifyHost(host)) {
    throw new AppError(400, 'invalid_request', 'Invalid Clockify host');
  }
  return baseUrl(host);
}

function requireClockifyIdField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || !isClockifyId(value)) {
    throw new AppError(400, 'invalid_request', `${name} must be a valid Clockify id`);
  }
  return value;
}

function requireTimezone(body: Record<string, unknown>): string {
  const value = body.timezone;
  if (typeof value !== 'string' || !isValidTimezone(value)) {
    throw new AppError(400, 'invalid_request', 'timezone must be a valid IANA zone');
  }
  return value;
}

/**
 * Validates one proposed entry field by field. Every field `createEntry` or
 * `findDuplicate` reads is checked strictly; `activityCount`/`repos` (unused
 * by the write itself) get only a shallow type check, since a malformed
 * value there cannot cause a bad write.
 */
function readEntry(value: unknown): ProposedEntry {
  if (typeof value !== 'object' || value === null) {
    throw new AppError(400, 'invalid_request', 'Each entry must be an object');
  }
  const e = value as Record<string, unknown>;

  if (typeof e.date !== 'string' || !isDateKey(e.date)) {
    throw new AppError(400, 'invalid_request', 'entry.date must be a YYYY-MM-DD date');
  }
  if (typeof e.start !== 'string' || !ISO_INSTANT_RE.test(e.start)) {
    throw new AppError(400, 'invalid_request', 'entry.start must be an ISO-8601 UTC instant');
  }
  if (typeof e.end !== 'string' || !ISO_INSTANT_RE.test(e.end)) {
    throw new AppError(400, 'invalid_request', 'entry.end must be an ISO-8601 UTC instant');
  }
  if (Date.parse(e.end) <= Date.parse(e.start)) {
    throw new AppError(400, 'invalid_request', 'entry.end must be after entry.start');
  }
  if (typeof e.description !== 'string') {
    throw new AppError(400, 'invalid_request', 'entry.description must be a string');
  }
  // Clockify's own server limits, mirrored so a bad entry 400s here rather
  // than surfacing as an opaque upstream rejection mid-batch.
  if (Array.from(e.description).length > MAX_DESCRIPTION_CODEPOINTS) {
    throw new AppError(400, 'invalid_request', "entry.description exceeds Clockify's length limit");
  }
  if (e.description.includes('<') || e.description.includes('>')) {
    throw new AppError(400, 'invalid_request', "entry.description must not contain '<' or '>'");
  }
  if (typeof e.billable !== 'boolean') {
    throw new AppError(400, 'invalid_request', 'entry.billable must be a boolean');
  }
  if (typeof e.projectId !== 'string' || !isClockifyId(e.projectId)) {
    throw new AppError(400, 'invalid_request', 'entry.projectId must be a valid Clockify id');
  }
  if (typeof e.activityCount !== 'number' || !Number.isFinite(e.activityCount)) {
    throw new AppError(400, 'invalid_request', 'entry.activityCount must be a number');
  }
  if (!Array.isArray(e.repos) || e.repos.some((r) => typeof r !== 'string')) {
    throw new AppError(400, 'invalid_request', 'entry.repos must be an array of strings');
  }

  return {
    date: e.date,
    start: e.start,
    end: e.end,
    description: e.description,
    billable: e.billable,
    projectId: e.projectId,
    activityCount: e.activityCount,
    repos: e.repos as string[],
  };
}

/** Rule 1: caps the batch before any upstream call is made. */
function readEntries(value: unknown): ProposedEntry[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw new AppError(
      400,
      'invalid_request',
      `entries must be an array of at most ${MAX_ENTRIES}`,
    );
  }
  return value.map(readEntry);
}

/**
 * A "may or may not have landed" failure: the fetch itself failed (network
 * error, timeout) or the response was a retryable status Clockify kept
 * returning (`fetchJson` gives up on those as `upstream_error`, since
 * `createEntry` now runs with `retries: 0`). Everything else — a clean 400
 * rejection, 401/403 — is unambiguous: Clockify actively refused the
 * request, so nothing was created, and no recheck is needed.
 */
function isAmbiguousFailure(err: unknown): boolean {
  return (
    err instanceof AppError && (err.code === 'upstream_timeout' || err.code === 'upstream_error')
  );
}

/**
 * Rule 5: never retry a POST on an ambiguous failure — re-GET that entry's
 * own day first (widened ±1 day, same reasoning as the batch-level
 * pre-check) and ask whether it landed after all. Deliberately a fresh
 * fetch, never reusing the batch-level `existing` list, which predates this
 * specific write attempt and cannot know about it.
 */
async function recheckLanded(
  key: string,
  base: string,
  workspaceId: string,
  userId: string,
  timezone: string,
  entry: ProposedEntry,
): Promise<boolean> {
  const widenedStart = toClockifyIso(Date.parse(entry.start) - DAY_MS);
  const widenedEnd = toClockifyIso(Date.parse(entry.end) + DAY_MS);
  const fresh = await listEntries(key, base, workspaceId, userId, widenedStart, widenedEnd);
  return findDuplicate(entry, fresh, timezone) !== undefined;
}

applyRoutes.post('/', async (c) => {
  const key = requireClockify(c);
  const body = asRecord(await readCappedJson<unknown>(c));

  const base = resolveBase(body);
  const workspaceId = requireClockifyIdField(body, 'workspaceId');
  const userId = requireClockifyIdField(body, 'userId');
  const timezone = requireTimezone(body);
  const entries = readEntries(body.entries);

  const results: ApplyResult[] = [];
  if (entries.length === 0) return c.json({ results });

  // Rule 2: re-run duplicate detection immediately before writing — the
  // preview the user approved can be stale by the time they click import.
  // Fetch existing entries ONCE for the whole batch's span (widened ±1 day:
  // Clockify filters on an entry's own start time, so an entry beginning at
  // 23:00 the previous day still occupies the following local day), not
  // once per entry.
  const minStart = Math.min(...entries.map((e) => Date.parse(e.start)));
  const maxEnd = Math.max(...entries.map((e) => Date.parse(e.end)));
  const existing = await listEntries(
    key,
    base,
    workspaceId,
    userId,
    toClockifyIso(minStart - DAY_MS),
    toClockifyIso(maxEnd + DAY_MS),
  );

  // Rule 3: sequential, never concurrent. Clockify Free workspaces allow
  // only 30 requests/hour, workspace-wide — firing concurrently just
  // converts that budget into 429s.
  for (const entry of entries) {
    if (findDuplicate(entry, existing, timezone)) {
      results.push({ date: entry.date, ok: true, skipped: true, error: 'Already exists' });
      continue;
    }

    try {
      const created = await createEntry(key, base, workspaceId, entry);
      results.push({ date: entry.date, ok: true, entryId: created.id });
    } catch (err) {
      // Rule 4: one entry's failure never aborts the batch.
      if (isAmbiguousFailure(err)) {
        // Rule 5: never blindly retry. Find out what actually happened.
        const landed = await recheckLanded(key, base, workspaceId, userId, timezone, entry);
        if (landed) {
          results.push({ date: entry.date, ok: true, skipped: true, error: 'Already exists' });
        } else {
          results.push({ date: entry.date, ok: false, error: (err as AppError).message });
        }
      } else if (err instanceof AppError) {
        results.push({ date: entry.date, ok: false, error: err.message });
      } else {
        throw err;
      }
    }
  }

  return c.json({ results });
});

export default applyRoutes;
