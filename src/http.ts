import { AppError } from './problems';

export type UpstreamResponse<T> = { data: T; headers: Headers; status: number };

/** The platform caps simultaneous connections awaiting headers at 6. */
export const MAX_CONCURRENCY = 6;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const MAX_BACKOFF_MS = 4_000;

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

function backoffMs(attempt: number, res: Response | null): number {
  const retryAfter = res?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  // GitHub reports its primary-limit reset as an epoch second.
  if (res?.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const waitMs = reset * 1000 - Date.now();
    if (Number.isFinite(waitMs) && waitMs > 0) return Math.min(waitMs, MAX_BACKOFF_MS);
  }
  return Math.min(250 * 2 ** attempt, MAX_BACKOFF_MS);
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number; retries?: number; label?: string } = {},
): Promise<UpstreamResponse<T>> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, label = 'upstream' } = opts;
  let lastStatus = 0;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        // Cloudflare's fetch cache keys on URL and does NOT Vary on
        // Authorization. Without this, one user's authenticated GitHub
        // response could be served to another user. Non-negotiable.
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (attempt === retries)
        throw new AppError(504, 'upstream_timeout', `${label} did not respond`);
      await sleep(backoffMs(attempt, null));
      continue;
    }

    if (res.ok) {
      return { data: (await res.json()) as T, headers: res.headers, status: res.status };
    }

    lastStatus = res.status;

    if (res.status === 403 && res.headers.has('x-github-sso')) {
      await drain(res);
      throw new AppError(
        403,
        'upstream_saml_required',
        'This token is not authorized for that organization. Authorize it for SSO in your GitHub token settings.',
      );
    }
    if (res.status === 401 || res.status === 403) {
      const detail = await safeText(res);
      throw new AppError(
        res.status,
        res.status === 401 ? 'upstream_unauthorized' : 'upstream_forbidden',
        `${label} rejected the request: ${detail}`,
      );
    }
    if ([400, 404, 409, 422, 451].includes(res.status)) {
      throw new AppError(res.status, 'upstream_rejected', `${label}: ${await safeText(res)}`);
    }
    if (!isRetryable(res.status) || attempt === retries) {
      await drain(res);
      break;
    }
    await drain(res);
    await sleep(backoffMs(attempt, res));
  }

  throw new AppError(502, 'upstream_error', `${label} failed with status ${lastStatus}`);
}

/** Release a body we are not going to read; the runtime docs call this out. */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return `status ${res.status}`;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const LINK_NEXT = /<([^>]+)>\s*;\s*rel="next"/;

export function nextPageUrl(headers: Headers): string | null {
  const link = headers.get('link');
  return link ? (LINK_NEXT.exec(link)?.[1] ?? null) : null;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
