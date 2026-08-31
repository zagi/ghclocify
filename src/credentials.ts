import type { Context, MiddlewareHandler } from 'hono';
import { AppError } from './problems';

export type Creds = { github: string; clockify: string };

/**
 * Printable ASCII only. Wide enough for every real token shape — ghp_,
 * github_pat_, gho_, 40-hex classic, and Clockify's JWT-ish keys with '.',
 * '-' and '_' — while blocking CR/LF and control bytes, which make
 * `new Headers()` throw.
 */
const SAFE_TOKEN = /^[\x21-\x7e]{20,255}$/;
const MAX_BODY_BYTES = 128_000;

// Module-level, so a misconfigured deploy logs this once per isolate
// instead of once per request.
let warnedMissingRateLimit = false;

async function checkRateLimits(c: Context): Promise<void> {
  // A missing binding is a deploy-config error, not a client error.
  // Degrade (skip rate limiting) rather than 500 every request; the
  // one-time warning is the signal an operator needs to notice and fix it.
  if (!c.env?.RL_IP) {
    if (!warnedMissingRateLimit) {
      warnedMissingRateLimit = true;
      console.warn('RL_IP binding missing; skipping rate limiting');
    }
    return;
  }
  const ip = c.req.header('CF-Connecting-IP') ?? 'anon';
  const byIp = await c.env.RL_IP.limit({ key: ip });
  if (!byIp.success) {
    throw new AppError(429, 'rate_limited', 'Too many requests. Try again in a minute.');
  }
  // Key on a hash of the credential, never the credential itself.
  const raw = c.req.header('X-GitHub-Token') ?? c.req.header('X-Clockify-Key');
  if (raw && c.env.RL_TOKEN) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const key = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const byToken = await c.env.RL_TOKEN.limit({ key });
    if (!byToken.success) {
      throw new AppError(429, 'rate_limited', 'Too many requests for this key.');
    }
  }
}

export const guards: MiddlewareHandler = async (c, next) => {
  // Set before any check (including ones that throw) so it lands on every
  // response this middleware fronts: success, guard rejections, and errors
  // thrown further down the chain and caught by app.onError. Hono's Context
  // carries staged headers into whichever response is ultimately built from
  // this same context (c.json in the route, in problem(), or in notFound).
  c.header('Cache-Control', 'no-store');

  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin) {
    throw new AppError(403, 'cross_origin', 'Requests must originate from this application');
  }
  const site = c.req.header('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new AppError(403, 'cross_origin', 'Requests must originate from this application');
  }
  await checkRateLimits(c);
  await next();
};

function readToken(c: Context, header: string): string {
  const value = c.req.header(header) ?? '';
  if (!value) throw new AppError(401, 'missing_credentials', `${header} header is required`);
  // Deliberately does not quote the offending value.
  if (!SAFE_TOKEN.test(value))
    throw new AppError(400, 'invalid_credentials', `${header} has an invalid format`);
  return value;
}

export const requireGithub = (c: Context) => readToken(c, 'X-GitHub-Token');
export const requireClockify = (c: Context) => readToken(c, 'X-Clockify-Key');

/** Read a JSON body with a hard size cap; chunked requests have no Content-Length. */
export async function readCappedJson<T>(c: Context, maxBytes = MAX_BODY_BYTES): Promise<T> {
  const text = await c.req.text();
  if (text.length > maxBytes) throw new AppError(413, 'body_too_large', 'Request body too large');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}
