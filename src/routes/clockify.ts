/**
 * Read-only Clockify discovery routes the browser UI uses to populate its
 * workspace/project pickers and to fetch existing entries for duplicate
 * detection. Requires only `X-Clockify-Key` — never `X-GitHub-Token` — so
 * the UI can validate the two credentials independently and tell the user
 * which one is wrong.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index';
import { requireClockify } from '../credentials';
import { AppError } from '../problems';
import { isClockifyHost, isClockifyId, isClockifySubdomain } from '../validate';
import { baseUrl, getUser, listEntries, listProjects, listWorkspaces } from '../clockify';

export const clockifyRoutes = new Hono<{ Bindings: Env }>();

const DAY_MS = 86_400_000;
/** `yyyy-MM-ddThh:mm:ssZ`, optionally with milliseconds — Clockify's own
 *  format strips millis, but the query parameter is allowed to carry them
 *  (browsers commonly produce `toISOString()`, which always does). */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * Resolves the regional (or vanity-subdomain) base URL from query
 * parameters, validated with `isClockifyHost` / `isClockifySubdomain`
 * before any upstream call. Mirrors `baseUrl`'s own precedence: a present,
 * non-empty `subdomain` wins over `host`. `host` defaults to `api`.
 */
function resolveBase(c: Context): string {
  const subdomain = c.req.query('subdomain');
  if (subdomain) {
    if (!isClockifySubdomain(subdomain)) {
      throw new AppError(400, 'invalid_request', 'Invalid Clockify subdomain');
    }
    return baseUrl('api', subdomain);
  }
  const host = c.req.query('host') ?? 'api';
  if (!isClockifyHost(host)) {
    throw new AppError(400, 'invalid_request', 'Invalid Clockify host');
  }
  return baseUrl(host);
}

function requireClockifyId(c: Context, name: string): string {
  const value = c.req.query(name);
  if (!value || !isClockifyId(value)) {
    throw new AppError(
      400,
      'invalid_request',
      `${name} query parameter must be a valid Clockify id`,
    );
  }
  return value;
}

function requireIsoInstant(c: Context, name: string): string {
  const value = c.req.query(name);
  if (!value || !ISO_INSTANT_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new AppError(
      400,
      'invalid_request',
      `${name} query parameter must be an ISO-8601 UTC instant, e.g. 2026-01-01T00:00:00Z`,
    );
  }
  return value;
}

/** Strips milliseconds per Clockify's `yyyy-MM-ddThh:mm:ssZ` format. */
function widen(iso: string, deltaMs: number): string {
  return new Date(Date.parse(iso) + deltaMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

clockifyRoutes.get('/context', async (c) => {
  const key = requireClockify(c);
  const base = resolveBase(c);
  const [user, workspaces] = await Promise.all([getUser(key, base), listWorkspaces(key, base)]);
  return c.json({ user, workspaces });
});

clockifyRoutes.get('/projects', async (c) => {
  const key = requireClockify(c);
  const base = resolveBase(c);
  const workspaceId = requireClockifyId(c, 'workspaceId');
  const projects = await listProjects(key, base, workspaceId);
  return c.json({ projects });
});

/**
 * Widens the requested `[start, end]` by ±1 day before calling `listEntries`.
 * Clockify filters on an entry's own start time, so an entry beginning at
 * 23:00 the previous day still occupies the following local day; Task 7's
 * `findDuplicate` compares on local day keys and depends on this widening
 * to have seen those boundary entries. Skipping it silently double-books
 * across midnight — the exact bug this product exists to prevent.
 */
clockifyRoutes.get('/entries', async (c) => {
  const key = requireClockify(c);
  const base = resolveBase(c);
  const workspaceId = requireClockifyId(c, 'workspaceId');
  const userId = requireClockifyId(c, 'userId');
  const start = requireIsoInstant(c, 'start');
  const end = requireIsoInstant(c, 'end');
  const widenedStart = widen(start, -DAY_MS);
  const widenedEnd = widen(end, DAY_MS);
  const entries = await listEntries(key, base, workspaceId, userId, widenedStart, widenedEnd);
  return c.json({ entries });
});

export default clockifyRoutes;
