import type { Context } from 'hono';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Render any thrown value as JSON. Never includes a credential value. */
export function problem(c: Context, err: unknown): Response {
  if (err instanceof AppError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  }
  console.error('unhandled', { message: err instanceof Error ? err.message : 'unknown' });
  return c.json({ error: 'internal_error', message: 'Unexpected error' }, 500);
}
