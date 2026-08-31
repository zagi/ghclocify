import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { env } from 'cloudflare:test';

describe('health', () => {
  it('reports ok', async () => {
    const res = await app.request('/api/health', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('404s an unknown api route as JSON', async () => {
    const res = await app.request('/api/nope', {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
