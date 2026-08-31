import { Hono } from 'hono';
import type { RateLimit } from '@cloudflare/workers-types';
import { guards, requireClockify } from './credentials';
import { problem } from './problems';

export type Env = {
  RL_IP: RateLimit;
  RL_TOKEN: RateLimit;
};

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', guards);

app.get('/api/health', (c) => c.json({ ok: true }));

// Temporary: exists only so the credential-guard tests have a route to hit.
// Task 10 replaces this with the real /api/clockify/context handler.
app.get('/api/clockify/context', (c) => {
  requireClockify(c);
  return c.json({});
});

app.notFound((c) => c.json({ error: 'not_found', message: 'No such route' }, 404));

app.onError((err, c) => problem(c, err));

export default app;
