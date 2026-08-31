// Shared, pure module: no runtime imports. This file is bundled into the
// browser client via tsconfig.client.json, so importing anything from
// './problems' (which pulls in hono's types) would break that build.
// A type-only import is erased at compile time and is safe here.
import type { ClockifyHost } from './types';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const CLOCKIFY_ID_RE = /^[0-9a-f]{24}$/i;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOCKIFY_SUBDOMAIN_RE = /^[a-z0-9-]{1,40}$/;

const CLOCKIFY_HOSTS: readonly ClockifyHost[] = ['api', 'euc1', 'use2', 'euw2', 'apse2'];

export function isOwner(v: string): boolean {
  return OWNER_RE.test(v);
}

export function isRepoName(v: string): boolean {
  return REPO_NAME_RE.test(v);
}

export function isRepoFullName(v: string): boolean {
  const idx = v.indexOf('/');
  if (idx === -1) return false;
  const owner = v.slice(0, idx);
  const name = v.slice(idx + 1);
  return isOwner(owner) && isRepoName(name) && !name.includes('/');
}

export function isClockifyId(v: string): boolean {
  return CLOCKIFY_ID_RE.test(v);
}

export function isDateKey(v: string): boolean {
  return DATE_KEY_RE.test(v);
}

export function isHhMm(v: string): boolean {
  return HH_MM_RE.test(v);
}

export function isClockifyHost(v: string): v is ClockifyHost {
  return (CLOCKIFY_HOSTS as readonly string[]).includes(v);
}

export function isClockifySubdomain(v: string): boolean {
  return CLOCKIFY_SUBDOMAIN_RE.test(v);
}

/**
 * Percent-encode a single path segment, throwing on an empty value. Uses a
 * plain Error (not AppError) so this module stays free of runtime imports;
 * callers in the route layer are responsible for wrapping this in an
 * AppError(400, 'invalid_request', ...) if they let it reach a client.
 */
export function segment(v: string): string {
  if (!v) throw new Error('segment: value must not be empty');
  return encodeURIComponent(v);
}

export function daysBetween(startKey: string, endKey: string): number {
  const start = Date.parse(`${startKey}T00:00:00Z`);
  const end = Date.parse(`${endKey}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}
