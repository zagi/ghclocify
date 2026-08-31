import { Hono } from 'hono';
import type { RateLimit } from '@cloudflare/workers-types';
import { guards } from './credentials';
import { problem } from './problems';
import { githubRoutes } from './routes/github';
import { clockifyRoutes } from './routes/clockify';
import { scanRoutes } from './routes/scan';

export type Env = {
  RL_IP: RateLimit;
  RL_TOKEN: RateLimit;
};

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', guards);

app.get('/api/health', (c) => c.json({ ok: true }));

app.route('/api/github', githubRoutes);
app.route('/api/clockify', clockifyRoutes);
app.route('/api/scan', scanRoutes);

app.notFound((c) => c.json({ error: 'not_found', message: 'No such route' }, 404));

app.onError((err, c) => problem(c, err));

export default app;
