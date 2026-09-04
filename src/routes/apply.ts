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
import { isValidTimezone, localDayOf, toClockifyIso } from '../timezone';
import { baseUrl, createEntry, getUser, listEntries } from '../clockify';
import { decideWrite, findLanded } from '../plan';
import { CLOCKIFY_MAX_DESCRIPTION } from '../describe';
import type { ApplyResult, ProposedEntry } from '../types';

export const applyRoutes = new Hono<{ Bindings: Env }>();

/**
 * Rule 1: the client sends batches and shows progress; a killed request can
 * then lose at most this many writes, each individually reported. Batches no
 * longer need to hold a whole day — `dayStarts` (below) lets `decideWrite`
 * tell this import's earlier writes from foreign entries across batches, so
 * ten here only bounds writes lost to a killed request, not a day's size.
 */
const MAX_ENTRIES = 10;

const DAY_MS = 86_400_000;

/** Sanity bounds for `dayStarts`: a day can hold at most this many planned
 *  entries, and a batch's days together at most this many instants. */
const MAX_STARTS_PER_DAY = 500;
const MAX_STARTS_TOTAL = 5000;

/** `yyyy-MM-ddThh:mm:ssZ`, no milliseconds — matches `ProposedEntry`'s own
 *  documented "second precision" contract, which is exactly what
 *  `aggregate.ts`'s `toClockifyIso` produces. Stricter than the read-only
 *  routes' `ISO_INSTANT_RE` (which tolerates millis) is deliberate: this is
 *  the write path. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

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
 *
 * `timezone` is required here — not just for validation shape, but because
 * `entry.date` is never trusted as-is. `findDuplicate` (plan.ts) matches an
 * existing entry against `entry.date`, the CLAIMED local day, not anything
 * derived from `entry.start`. A client (or a bug) that sends a `start`
 * instant on one day but a `date` on another would make the pre-write
 * duplicate check look on the wrong day and silently miss a real duplicate
 * — a write-time double-booking that needs no ambiguous failure at all to
 * trigger. So `entry.date` is verified against the local day `localDayOf`
 * actually derives from `entry.start`, and rejected outright on a mismatch
 * rather than silently corrected: a mismatch means the caller has a bug,
 * and quietly overwriting it would hide that from whoever sent it.
 */
function readEntry(value: unknown, timezone: string): ProposedEntry {
  if (typeof value !== 'object' || value === null) {
    throw new AppError(400, 'invalid_request', 'Each entry must be an object');
  }
  const e = value as Record<string, unknown>;

  if (typeof e.date !== 'string' || !isDateKey(e.date)) {
    throw new AppError(400, 'invalid_request', 'entry.date must be a YYYY-MM-DD date');
  }
  if (
    typeof e.start !== 'string' ||
    !ISO_INSTANT_RE.test(e.start) ||
    Number.isNaN(Date.parse(e.start))
  ) {
    throw new AppError(400, 'invalid_request', 'entry.start must be an ISO-8601 UTC instant');
  }
  if (typeof e.end !== 'string' || !ISO_INSTANT_RE.test(e.end) || Number.isNaN(Date.parse(e.end))) {
    throw new AppError(400, 'invalid_request', 'entry.end must be an ISO-8601 UTC instant');
  }
  if (Date.parse(e.end) <= Date.parse(e.start)) {
    throw new AppError(400, 'invalid_request', 'entry.end must be after entry.start');
  }
  const actualDate = localDayOf(e.start, timezone);
  if (actualDate !== e.date) {
    throw new AppError(
      400,
      'invalid_request',
      `entry.date (${e.date}) does not match the local day of entry.start in ${timezone} (${actualDate})`,
    );
  }
  if (typeof e.description !== 'string') {
    throw new AppError(400, 'invalid_request', 'entry.description must be a string');
  }
  // Clockify's own server limits, mirrored so a bad entry 400s here rather
  // than surfacing as an opaque upstream rejection mid-batch.
  if (Array.from(e.description).length > CLOCKIFY_MAX_DESCRIPTION) {
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
  if (typeof e.group !== 'string' || e.group.length > 300) {
    throw new AppError(
      400,
      'invalid_request',
      'entry.group must be a string of at most 300 characters',
    );
  }
  if (typeof e.key !== 'string' || e.key !== `${e.date}|${e.group}`) {
    throw new AppError(400, 'invalid_request', 'entry.key must equal `${date}|${group}`');
  }

  return {
    date: e.date,
    key: e.key,
    group: e.group,
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
function readEntries(value: unknown, timezone: string): ProposedEntry[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw new AppError(
      400,
      'invalid_request',
      `entries must be an array of at most ${MAX_ENTRIES}`,
    );
  }
  return value.map((entry) => readEntry(entry, timezone));
}

/**
 * `dayStarts` — for every day present in this batch, every start instant
 * the client's plan holds for that day (all entries, checked or not). The
 * pre-write check uses it to tell this import's own earlier writes from
 * foreign entries (see `decideWrite`). Validated as strictly as entries:
 * date keys, second-precision UTC instants, each on its key's local day.
 */
function readDayStarts(
  value: unknown,
  entries: ProposedEntry[],
  timezone: string,
): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError(400, 'invalid_request', 'dayStarts must be an object keyed by YYYY-MM-DD');
  }
  const raw = value as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  let total = 0;
  for (const [date, list] of Object.entries(raw)) {
    if (!isDateKey(date)) {
      throw new AppError(400, 'invalid_request', 'dayStarts keys must be YYYY-MM-DD dates');
    }
    if (!Array.isArray(list)) {
      throw new AppError(400, 'invalid_request', `dayStarts[${date}] must be an array`);
    }
    if (list.length > MAX_STARTS_PER_DAY) {
      throw new AppError(
        400,
        'invalid_request',
        `dayStarts[${date}] must hold at most ${MAX_STARTS_PER_DAY} instants`,
      );
    }
    total += list.length;
    if (total > MAX_STARTS_TOTAL) {
      throw new AppError(400, 'invalid_request', 'dayStarts lists too many instants');
    }
    out[date] = list.map((iso) => {
      if (typeof iso !== 'string' || !ISO_INSTANT_RE.test(iso) || Number.isNaN(Date.parse(iso))) {
        throw new AppError(400, 'invalid_request', `dayStarts[${date}] holds a malformed instant`);
      }
      if (localDayOf(iso, timezone) !== date) {
        throw new AppError(
          400,
          'invalid_request',
          `dayStarts[${date}] holds an instant that falls on another local day`,
        );
      }
      return iso;
    });
  }
  for (const entry of entries) {
    const starts = out[entry.date];
    if (!starts || !starts.some((iso) => Date.parse(iso) === Date.parse(entry.start))) {
      throw new AppError(
        400,
        'invalid_request',
        `dayStarts[${entry.date}] must include the start of every entry on that day`,
      );
    }
  }
  return out;
}

/**
 * A "may or may not have landed" failure: the fetch itself failed (network
 * error, timeout — `upstream_timeout`) or the response was a genuinely
 * retryable status (429/408/5xx) that `fetchJson` gave up on after
 * `createEntry`'s `retries: 0` (`upstream_error`). Both mean Clockify may
 * have processed the write before we lost the signal.
 *
 * Everything else is unambiguous and must NOT trigger a recheck: `http.ts`
 * throws `upstream_rejected` both for the explicitly-listed definitive
 * statuses (400/404/409/422/451) and for any other non-retryable status it
 * doesn't special-case (e.g. 405, 418) — a flat refusal, never processed.
 * Treating those as ambiguous would spend a free-tier workspace's scarce
 * 30-requests/hour budget on a needless recheck GET for a write we already
 * know failed.
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
 * specific write attempt and cannot know about it. Matches on the exact
 * start instant (findLanded), not the local day: a sibling entry from the
 * same day — possibly written seconds earlier in this very batch — must not
 * vouch for this one.
 */
async function recheckLanded(
  key: string,
  base: string,
  workspaceId: string,
  userId: string,
  entry: ProposedEntry,
): Promise<boolean> {
  const widenedStart = toClockifyIso(Date.parse(entry.start) - DAY_MS);
  const widenedEnd = toClockifyIso(Date.parse(entry.end) + DAY_MS);
  const fresh = await listEntries(key, base, workspaceId, userId, widenedStart, widenedEnd);
  return findLanded(entry, fresh) !== undefined;
}

applyRoutes.post('/', async (c) => {
  const key = requireClockify(c);
  const body = asRecord(await readCappedJson<unknown>(c));

  const base = resolveBase(body);
  const workspaceId = requireClockifyIdField(body, 'workspaceId');
  const userId = requireClockifyIdField(body, 'userId');
  // Read before entries: readEntries/readEntry need it to verify entry.date
  // against entry.start rather than trusting the client's claimed date.
  const timezone = requireTimezone(body);
  const entries = readEntries(body.entries, timezone);
  const dayStarts = readDayStarts(body.dayStarts, entries, timezone);

  // Belt and braces against a client-supplied userId that diverges from the
  // API key's actual owner: listEntries (the pre-write duplicate check)
  // inspects `userId`'s timeline, but createEntry always writes as the
  // key's owner. If they diverge the pre-check silently inspects the wrong
  // timeline and every entry looks new. The client is supposed to keep
  // these in sync (re-verifying on credential change), but this route
  // re-verifies everything it can rather than trusting the client's word:
  // ids, dates, starts, which local day each entry belongs to, and (in
  // decideWrite) whether an entry's interval overlaps something already in
  // Clockify. The one thing genuinely taken on faith is `dayStarts` — which
  // planned starts belong to THIS import, used to tell an earlier batch's
  // own write from a foreign entry — and even that is only ever used to
  // narrow what counts as "ours"; decideWrite's overlap guard below is the
  // server-side backstop that catches a double-booking regardless of what
  // `dayStarts` claims.
  const me = await getUser(key, base);
  if (me.id !== userId) {
    throw new AppError(400, 'invalid_request', 'userId does not match the Clockify API key owner');
  }

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

  // Entries written in THIS batch, keyed `${projectId}@${start}`. They are
  // deliberately not pushed into `existing`: that list drives `decideWrite`,
  // and a day now legitimately holds several entries (one per issue), so a
  // sibling written moments ago must not turn the rest of its day into
  // duplicates — `decideWrite` already recognizes it as ours via
  // `dayStarts`. This set still guards exact repeats within THIS batch (same
  // project, same start) — the belt-and-braces this route keeps against a
  // client that sends the same entry twice; the cross-batch case (an
  // earlier batch's own write) is handled by `decideWrite` seeing that
  // earlier write in `existing` and recognizing its start as planned.
  const writtenStarts = new Set<string>();
  const startKey = (entry: ProposedEntry) => `${entry.projectId}@${entry.start}`;

  // Rule 3: sequential, never concurrent. Clockify Free workspaces allow
  // only 30 requests/hour, workspace-wide — firing concurrently just
  // converts that budget into 429s.
  for (const entry of entries) {
    const decision = decideWrite(entry, existing, timezone, dayStarts[entry.date] ?? []);
    if (decision.action === 'skip' || writtenStarts.has(startKey(entry))) {
      results.push({
        date: entry.date,
        key: entry.key,
        ok: true,
        skipped: true,
        error: 'Already exists',
      });
      continue;
    }

    try {
      const created = await createEntry(key, base, workspaceId, entry);
      writtenStarts.add(startKey(entry));
      results.push({ date: entry.date, key: entry.key, ok: true, entryId: created.id });
    } catch (err) {
      // Rule 4: one entry's failure never aborts the batch.
      if (isAmbiguousFailure(err)) {
        // Rule 5: never blindly retry. Find out what actually happened.
        // Resolved via .then's two callbacks (rather than a `let` reassigned
        // inside a try) so a recheck failure can never be mistaken for "it
        // did not land": each outcome is its own branch, not a shared
        // mutable flag.
        const recheck = await recheckLanded(key, base, workspaceId, userId, entry).then(
          (landed) => ({ recheckOk: true as const, landed }),
          () => ({ recheckOk: false as const }),
        );
        if (!recheck.recheckOk) {
          // Recheck itself failed: we still don't know. Report the original
          // failure and let the next run's pre-check resolve it — never
          // retry — but do NOT let this propagate out of the loop: that
          // would discard every result already accumulated in this batch,
          // including entries successfully written moments earlier. Worst
          // exactly when it hurts most: on a free workspace over its cap,
          // every POST 429s, triggering a recheck that also 429s.
          results.push({
            date: entry.date,
            key: entry.key,
            ok: false,
            error: `${(err as AppError).message} (could not confirm whether it landed)`,
          });
          continue;
        }
        if (recheck.landed) {
          writtenStarts.add(startKey(entry));
          results.push({
            date: entry.date,
            key: entry.key,
            ok: true,
            skipped: true,
            error: 'Already exists',
          });
        } else {
          results.push({
            date: entry.date,
            key: entry.key,
            ok: false,
            error: (err as AppError).message,
          });
        }
      } else if (err instanceof AppError) {
        results.push({ date: entry.date, key: entry.key, ok: false, error: err.message });
      } else {
        // Still rule 4: an unexpected (non-AppError) exception must not
        // abort the batch either — record it and let the caller learn
        // which entries succeeded, same as every other failure shape.
        results.push({
          date: entry.date,
          key: entry.key,
          ok: false,
          error: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    }
  }

  return c.json({ results });
});

export default applyRoutes;
