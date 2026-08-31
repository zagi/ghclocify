import { describe, expect, it } from 'vitest';
import app from '../src/index';
import type { Env } from '../src/index';
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

  it('degrades instead of 500ing when the RL_IP binding is absent', async () => {
    // `env` from cloudflare:test is typed as the ambient (unaugmented,
    // empty) Cloudflare.Env, since no worker-configuration.d.ts exists to
    // widen it -- cast to our own Env to destructure a known binding off it.
    const { RL_IP: _RL_IP, ...envWithoutRateLimit } = env as Env;
    const res = await app.request(
      `${ORIGIN}/api/clockify/context`,
      { headers: { 'X-Clockify-Key': GOOD_TOKEN } },
      envWithoutRateLimit,
    );
    expect(res.status).toBe(200);
  });
});
