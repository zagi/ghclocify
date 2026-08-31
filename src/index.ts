import { Hono } from 'hono';
import type { RateLimit } from '@cloudflare/workers-types';

export type Env = {
  RL_IP: RateLimit;
  RL_TOKEN: RateLimit;
};

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true }));

app.notFound((c) => c.json({ error: 'not_found', message: 'No such route' }, 404));

app.onError((err, c) => {
  console.error('unhandled', { message: err instanceof Error ? err.message : 'unknown' });
  return c.json({ error: 'internal_error', message: 'Unexpected error' }, 500);
});

export default app;
