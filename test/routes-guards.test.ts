import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import app from '../src/index';
import type { Env } from '../src/index';
import { guards, readCappedJson } from '../src/credentials';
import { problem } from '../src/problems';
import { env } from 'cloudflare:test';

const ORIGIN = 'https://gh2clockify.example.workers.dev';
const GOOD_TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

const call = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init, env);

describe('credential and abuse guards', () => {
  it('rejects a request with no credential header', async () => {
    const res = await call('/api/clockify/context');
    expect(res.status).toBe(401);
    expect((await res.json<{ error: string }>()).error).toBe('missing_credentials');
  });

  it('rejects a foreign Origin', async () => {
    const res = await call('/api/clockify/context', {
      headers: { 'X-Clockify-Key': GOOD_TOKEN, Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe('cross_origin');
  });

  it('rejects a cross-site Sec-Fetch-Site', async () => {
    const res = await call('/api/clockify/context', {
      headers: { 'X-Clockify-Key': GOOD_TOKEN, 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a token containing header-injection bytes', async () => {
    // A literal CR/LF can't reach our code at all: the standard Headers/Request
    // constructor Hono uses under app.request() throws "Invalid header value"
    // before the request is even built, in every runtime (Node's undici and
    // workerd both enforce this). A tab is still a control byte SAFE_TOKEN
    // rejects, but one Headers is willing to construct, so it actually
    // exercises the validator instead of the platform's own guard.
    const res = await call('/api/clockify/context', {
      headers: { 'X-Clockify-Key': `bad\ttoken${'x'.repeat(20)}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_credentials');
  });

  it('never echoes a credential back in an error body', async () => {
    const secret = `zzz_secret_value_${'x'.repeat(20)}`;
    const res = await call('/api/clockify/context', {
      headers: { 'X-Clockify-Key': secret, Origin: 'https://evil.example.com' },
    });
    expect(await res.text()).not.toContain(secret);
  });

  it('sets Cache-Control: no-store on every api response', async () => {
    const res = await call('/api/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('emits no CORS headers at all', async () => {
    const res = await call('/api/health');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sets Cache-Control: no-store on a guard-rejected response', async () => {
    const res = await call('/api/clockify/context', {
      headers: { Origin: 'https://evil.example.com', 'X-Clockify-Key': GOOD_TOKEN },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sets Cache-Control: no-store on a missing-credential (401) response', async () => {
    const res = await call('/api/clockify/context');
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sets Cache-Control: no-store on a 404 (notFound) response', async () => {
    const res = await call('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sets Cache-Control: no-store on a 500 (onError) response', async () => {
    // Production code has no route that throws an unhandled error, by
    // design -- build a throw-away local app that mounts the same guards
    // middleware plus a deliberately-throwing handler, rather than adding
    // one to src/index.ts just to make this path reachable.
    const errorApp = new Hono<{ Bindings: Env }>();
    errorApp.use('/api/*', guards);
    errorApp.get('/api/boom', () => {
      throw new Error('boom');
    });
    errorApp.onError((err, c) => problem(c, err));

    const res = await errorApp.request(`${ORIGIN}/api/boom`, {}, env);
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('degrades instead of 500ing when the RL_IP binding is absent', async () => {
    // `env` from cloudflare:test is typed as the ambient (unaugmented,
    // empty) Cloudflare.Env, since no worker-configuration.d.ts exists to
    // widen it -- cast to our own Env to destructure a known binding off it.
    const { RL_IP: _RL_IP, ...envWithoutRateLimit } = env as Env;
    // /api/health, not /api/clockify/context: since Task 10 gave that route
    // real upstream behavior, hitting it here would depend on a live
    // Clockify response for a fake key. /api/health exercises the same
    // guards middleware (mounted on /api/*) with no upstream dependency,
    // which is all this test is about.
    const res = await app.request(`${ORIGIN}/api/health`, {}, envWithoutRateLimit);
    expect(res.status).toBe(200);
  });
});

describe('readCappedJson', () => {
  // Local throw-away app: readCappedJson isn't wired into any production
  // route yet (Tasks 11/12 do that), so it needs its own harness here.
  const bodyApp = new Hono<{ Bindings: Env }>();
  bodyApp.post('/body', async (c) => {
    const data = await readCappedJson<unknown>(c, 128_000);
    return c.json({ ok: true, received: data });
  });
  bodyApp.onError((err, c) => problem(c, err));

  it('accepts a body under the byte cap', async () => {
    const res = await bodyApp.request(
      `${ORIGIN}/body`,
      { method: 'POST', body: JSON.stringify({ hello: 'world' }) },
      env,
    );
    expect(res.status).toBe(200);
  });

  it('rejects on byte length, not UTF-16 code-unit length', async () => {
    // '☃' (U+2603) is one UTF-16 code unit but three UTF-8 bytes, so a
    // 100,000-character string is only 100,002 chars as a JSON string
    // literal -- comfortably under a 128,000 *character* cap -- but over
    // 300,000 *bytes*, comfortably over a 128,000 *byte* cap.
    const body = JSON.stringify('☃'.repeat(100_000));
    expect(body.length).toBeLessThan(128_000);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(128_000);

    const res = await bodyApp.request(`${ORIGIN}/body`, { method: 'POST', body }, env);
    expect(res.status).toBe(413);
    expect((await res.json<{ error: string }>()).error).toBe('body_too_large');
  });
});
