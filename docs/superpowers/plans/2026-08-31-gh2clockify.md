# gh2clockify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **On first execution:** copy this file to `docs/superpowers/plans/2026-08-31-gh2clockify.md` inside the new repo and commit it, so the plan travels with the code.

**Goal:** A public, stateless single-page web tool on Cloudflare Workers that lets anyone holding a GitHub PAT and a Clockify API key preview and import their GitHub activity as Clockify time entries.

**Architecture:** A Hono Worker serving a hand-written HTML/CSS page plus a vanilla-TS bundle from Workers Assets. Credentials live in the browser and travel per-request as `X-GitHub-Token` / `X-Clockify-Key` headers; the Worker has no storage bindings, no accounts and no cookies, and forgets both keys when the request ends. **The browser is the orchestrator:** all aggregation logic is pure TypeScript in `src/` that is bundled into _both_ the Worker and the client, so the Worker only ever performs small, bounded API calls (one chunk of repos, one search window, one batch of writes) while the browser holds the accumulating state, drives the progress bar, and can retry or cancel any chunk.

**Tech Stack:** TypeScript 6, Hono 4, Cloudflare Workers (Paid) + Workers Assets, esbuild for the client bundle, vitest 4 (two projects: plain Node for pure modules, `@cloudflare/vitest-pool-workers` for routes), ESLint 10 flat config + Prettier, npm, Node ≥ 22.

**Spec:** This document. Domain rules are ported from `/Users/michalzagalski/projects/github_events_zagi/populate_clocify_from_github.py`, which is the reference implementation; its behaviour is quoted inline wherever it is preserved or deliberately changed.

---

## Context

The user runs `populate_clocify_from_github.py` by hand, roughly monthly, to turn a month of GitHub commits into Clockify time entries. It works, but it is single-tenant and unsafe to hand to anyone else:

- Identity is hardcoded — `GITHUB_AUTHOR_USERNAME = "zagi"`, org `"coinpaprika"`, Clockify project `"coin"`, and `workspaces[0]` picked blindly.
- **It is not idempotent.** It POSTs every generated entry with no check for existing ones, so re-running a range silently doubles the hours. There is no dry run.
- Everything is UTC by fiat: days are bucketed on the UTC calendar and every entry is written `08:00Z–16:00Z`. For a Warsaw user, a 23:30 local commit is filed under the previous day and every entry renders as 10:00–18:00.
- No rate-limit handling, no retries, no request timeouts. Any GitHub error other than 404/409 aborts the whole run mid-month, leaving a partially populated Clockify with no resume marker.
- Only commits, only from each repo's default branch, only one organization.

This project replaces it with a web UI anyone can use with their own two keys: pick a date range, pick personal or organization scope, pick repositories and which kinds of activity count, **see exactly what will be written and what already exists**, then import. The outcome is that the monthly ritual becomes a two-minute browser task and a colleague can do the same without being handed anyone's credentials.

## Global Constraints

Every task's requirements implicitly include this section.

**Security**

- **Never persist credentials.** No KV, no D1, no R2, no cookies, no logging of header values or whole header objects. The Worker declares no storage bindings; a task that adds one is wrong.
- **Fixed upstream allowlist.** GitHub is always `https://api.github.com`. Clockify is `https://{host}.clockify.me/api/v1` where `host` comes from the hardcoded set `api | euc1 | use2 | euw2 | apse2`, or a subdomain matched against `/^[a-z0-9-]{1,40}$/`. Never accept a free-form host — that is a direct SSRF.
- **`encodeURIComponent` every value interpolated into an upstream URL path.** `owner`, `repo`, `workspaceId`, `projectId`, `userId` are all attacker-controlled.
- **Every upstream `fetch` passes `cache: 'no-store'`.** Cloudflare's fetch cache keys on URL and does _not_ `Vary` on `Authorization`; without this, one user's GitHub response can be served to another.
- **Every `/api/*` response carries `Cache-Control: no-store`.** No CORS headers are ever emitted — no `Access-Control-Allow-Origin`, no CORS middleware.
- Credential header values must match `/^[\x21-\x7e]{20,255}$/` before use, and header construction is wrapped in `try/catch` (illegal bytes make `new Headers()` throw, which would otherwise surface as a 500).

**Limits** (Workers Paid plan: 10,000 subrequests, 30 s CPU, 6 simultaneous connections)

- `limits: { cpu_ms: 60000 }` in `wrangler.jsonc`.
- Per-request input caps, enforced before any `fetch`: **≤ 25 repos**, **≤ 92 days**, **≤ 4 sources**, request body **≤ 128 KB** (checked after reading, since chunked requests carry no `Content-Length`).
- Upstream concurrency is **6** — the platform's simultaneous-connection cap. Higher just queues.

**Clockify**

- Description: `maxLength` 3000 **Unicode code points** (count and slice with `Array.from`, never `.length`/`.slice`), and the server rejects `<` and `>`.
- Timestamps: `yyyy-MM-ddThh:mm:ssZ` — strip milliseconds with `.replace(/\.\d{3}Z$/, 'Z')`.
- Pagination params are `page` and **`page-size`** (hyphenated). Terminate on the `Last-Page: true` response header, not by counting.
- **Free-plan workspaces are capped at 30 API requests per hour, workspace-wide** (paid: 50/sec). Detect via `WorkspaceDtoV1.featureSubscriptionType`, warn prominently, and treat 429 as a first-class UI state.

**GitHub**

- Always send `advanced_search=true` on `/search/issues` and write queries in the advanced dialect (explicit `OR`, since a bare space means AND there).
- Search: 30 requests/minute, 1000 results per query max, `per_page` ≤ 100, `page` ≤ 10.

**Tooling**

- Node `>= 22.0.0` (`engines`). npm with a committed `package-lock.json`.
- Prettier: `semi: true, singleQuote: true, tabWidth: 2, trailingComma: "all", printWidth: 100, arrowParens: "always", endOfLine: "lf"`.
- tsconfig: `strict: true` **and** `noUncheckedIndexedAccess: true`.
- **Never write `new Date('2026-08-03T09:00')`** (no offset ⇒ parsed as _local_ time, and the Workers runtime is UTC while Node vitest is not). Every `Date` comes from `Date.UTC`, an epoch number, or a `Z`-suffixed string.
- `npm run ci` = `typecheck && lint && format:check && test`, and it must pass at the end of every task.

_These conventions match the house exemplar `/Users/michalzagalski/projects/coinpaprika/agent-payment-cf-dexpaprika/mpp-cf-dexpaprika` — read its `package.json`, `tsconfig.json`, `eslint.config.mjs` and `src/env.ts` before Task 1 and imitate them._

---

## File Structure

New repo at **`/Users/michalzagalski/projects/gh2clockify`**.

Modules marked **shared** are pure, dependency-free, and bundled into _both_ the Worker and the browser client. That is what lets the browser own orchestration while the Worker stays small.

| File                                                                                          | Responsibility                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler.jsonc`                                                                              | Worker name, `main`, compat date, `assets`, `limits`, rate-limit bindings. No storage bindings.                                                                                                           |
| `package.json`, `tsconfig.json`, `tsconfig.client.json`                                       | Tooling. Two tsconfigs: the Worker has no DOM, the client has no Workers types.                                                                                                                           |
| `vitest.config.ts`                                                                            | Two projects — `pure` (plain Node) and `worker` (workers pool).                                                                                                                                           |
| `scripts/build-client.mjs`                                                                    | esbuild `client/app.ts` → `public/app.js`; fails the build if anything lands under `public/api/`.                                                                                                         |
| `public/_headers`                                                                             | CSP and security headers for the static page.                                                                                                                                                             |
| `src/index.ts`                                                                                | Hono app: middleware wiring, route mounting, `onError`, `notFound`.                                                                                                                                       |
| `src/types.ts`                                                                                | **shared** — the entire wire contract.                                                                                                                                                                    |
| `src/problems.ts`                                                                             | `AppError` + JSON error rendering.                                                                                                                                                                        |
| `src/validate.ts`                                                                             | **shared** — shape validators for owners, repo names, Clockify ids and hosts, date keys, times; `segment()` encoder. (Timezone validation lives in `timezone.ts`, next to the formatter that defines it.) |
| `src/credentials.ts`                                                                          | Credential extraction, origin/`Sec-Fetch-Site` guard, rate-limit middleware, `no-store` middleware.                                                                                                       |
| `src/http.ts`                                                                                 | `fetchJson` with timeout, bounded retry, `Retry-After`/rate-limit backoff, `cache: 'no-store'`, Link pagination, bounded-concurrency map.                                                                 |
| `src/timezone.ts`                                                                             | **shared** — IANA local-day bucketing and wall-clock ⇄ UTC conversion.                                                                                                                                    |
| `src/describe.ts`                                                                             | **shared** — per-day description construction and Clockify sanitization.                                                                                                                                  |
| `src/aggregate.ts`                                                                            | **shared** — `Activity[]` + settings → `ProposedEntry[]`.                                                                                                                                                 |
| `src/plan.ts`                                                                                 | **shared** — diff proposed entries against existing Clockify entries → `ImportPlan`.                                                                                                                      |
| `src/github.ts`                                                                               | GitHub REST + Search client → normalized `Activity[]`.                                                                                                                                                    |
| `src/clockify.ts`                                                                             | Clockify client, including regional-host resolution.                                                                                                                                                      |
| `src/routes/github.ts`, `src/routes/clockify.ts`, `src/routes/scan.ts`, `src/routes/apply.ts` | Route groups.                                                                                                                                                                                             |
| `client/app.ts`, `client/state.ts`, `client/render.ts`                                        | The four-step wizard: state, orchestration, DOM rendering.                                                                                                                                                |
| `public/index.html`, `public/style.css`                                                       | Markup and styles. `public/app.js` is build output and git-ignored.                                                                                                                                       |
| `test/*.test.ts`                                                                              | One file per `src` module.                                                                                                                                                                                |

### HTTP surface

| Route                                                              | Credential | Purpose                                                                 |
| ------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------- |
| `GET /api/health`                                                  | —          | Liveness.                                                               |
| `GET /api/github/context`                                          | GitHub     | `{viewer, orgs, rateLimit}`                                             |
| `GET /api/github/repos?scope=personal` \| `?scope=org&org=X`       | GitHub     | `{repos}`                                                               |
| `POST /api/scan/commits`                                           | GitHub     | One chunk of ≤ 8 repos → `{activities, warnings}`                       |
| `POST /api/scan/search`                                            | GitHub     | One source × one ≤ 31-day window → `{activities, warnings, incomplete}` |
| `GET /api/clockify/context?host=`                                  | Clockify   | `{user, workspaces}` (each workspace carries its plan type)             |
| `GET /api/clockify/projects?host=&workspaceId=`                    | Clockify   | `{projects}` (non-archived)                                             |
| `GET /api/clockify/entries?host=&workspaceId=&userId=&start=&end=` | Clockify   | Existing entries, for duplicate detection                               |
| `POST /api/apply`                                                  | Clockify   | ≤ 5 entries, re-checked for duplicates immediately before each write    |

Aggregation, description building and duplicate diffing all run **in the browser** using the shared modules. The Worker re-runs the duplicate check inside `/api/apply` because the plan is stale by the time the user approves it.

---

## Wire contract (`src/types.ts`)

Written verbatim in Task 2; every later task uses these exact names.

```ts
export type ActivityKind = 'commit' | 'pull_request' | 'issue' | 'review';

/** One thing the user did on GitHub, normalized across all four sources. */
export type Activity = {
  kind: ActivityKind;
  /** Stable identity for dedup: commit SHA, or `review:owner/repo#12:98765`. */
  id: string;
  /** `owner/name`. */
  repo: string;
  /** UTC ISO-8601 instant the activity is attributed to. */
  timestamp: string;
  /** Commit subject line / PR title / issue title. */
  title: string;
  url: string;
};

export type ImportSettings = {
  hoursPerDay: number;
  /** Local wall-clock start, `HH:MM`. */
  startTime: string;
  /** IANA zone, e.g. `Europe/Warsaw`. */
  timezone: string;
  includeWeekends: boolean;
  billable: boolean;
  workspaceId: string;
  projectId: string;
  /** repo full-name or bare name -> short label used in descriptions. */
  repoAliases: Record<string, string>;
};

export type ProposedEntry = {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** UTC ISO-8601 with `Z`, second precision. */
  start: string;
  end: string;
  description: string;
  billable: boolean;
  projectId: string;
  activityCount: number;
  repos: string[];
};

export type ExistingEntry = {
  id: string;
  start: string;
  end: string | null;
  description: string;
  projectId: string | null;
};

export type EntryStatus = 'new' | 'duplicate';

export type PlannedEntry = ProposedEntry & {
  status: EntryStatus;
  /** Present when `status === 'duplicate'`. */
  existing?: ExistingEntry;
};

export type ImportPlan = {
  entries: PlannedEntry[];
  totals: { days: number; hours: number; newDays: number; duplicateDays: number };
  skipped: { date: string; reason: 'weekend' }[];
  warnings: string[];
};

export type ApplyResult = {
  date: string;
  ok: boolean;
  entryId?: string;
  /** Set when `ok` is false, or when the write was skipped as a duplicate. */
  error?: string;
  skipped?: boolean;
};

/** Clockify regional hosts. `api` is the default global host. */
export type ClockifyHost = 'api' | 'euc1' | 'use2' | 'euw2' | 'apse2';
```

---

## Tasks

### Task 1: Repo scaffold, Hono skeleton, assets and limits config

**Files:**

- Create: `/Users/michalzagalski/projects/gh2clockify/` (new git repo)
- Create: `package.json`, `tsconfig.json`, `tsconfig.client.json`, `wrangler.jsonc`, `vitest.config.ts`, `eslint.config.mjs`, `.prettierrc.json`, `.gitignore`
- Create: `src/index.ts`
- Test: `test/index.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `export default app` from `src/index.ts` (a `Hono<{ Bindings: Env }>`), importable by every route test as `import app from '../src/index'`.

- [ ] **Step 1: Create the directory and initialise the repo**

```bash
mkdir -p /Users/michalzagalski/projects/gh2clockify
cd /Users/michalzagalski/projects/gh2clockify
git init -b main
mkdir -p src/routes test client public scripts
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "gh2clockify",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "build:client": "node scripts/build-client.mjs",
    "dev": "npm run build:client && wrangler dev",
    "deploy": "npm run build:client && wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.client.json",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "ci": "npm run typecheck && npm run lint && npm run format:check && npm run test"
  },
  "dependencies": {
    "hono": "^4.12.18"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.16.2",
    "@cloudflare/workers-types": "^4.20260507.1",
    "@eslint/js": "^10.0.1",
    "esbuild": "^0.25.0",
    "eslint": "^10.3.0",
    "eslint-config-prettier": "^10.1.8",
    "prettier": "^3.8.3",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.59.2",
    "vitest": "^4.1.5",
    "wrangler": "^4.89.1"
  }
}
```

Then `npm install`.

- [ ] **Step 3: Write `tsconfig.json` and `tsconfig.client.json`**

`tsconfig.json` — copy the exemplar's compiler options verbatim (`target ES2022`, `module ESNext`, `moduleResolution Bundler`, `lib ["ES2022"]`, `types ["@cloudflare/workers-types"]`, `strict`, `noUncheckedIndexedAccess`, `esModuleInterop`, `skipLibCheck`, `forceConsistentCasingInFileNames`, `resolveJsonModule`, `isolatedModules`, `noEmit`), with `"include": ["src/**/*", "test/**/*"]`.

`tsconfig.client.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": []
  },
  "include": [
    "client/**/*",
    "src/types.ts",
    "src/timezone.ts",
    "src/describe.ts",
    "src/aggregate.ts",
    "src/plan.ts",
    "src/validate.ts"
  ]
}
```

The `include` list is exactly the shared modules — if a future edit makes one of them import `@cloudflare/workers-types`, `npm run typecheck` fails, which is the guard that keeps them pure.

- [ ] **Step 4: Write `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "gh2clockify",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-02", // max supported by the pinned workerd; bump when wrangler updates
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true,
  },
  // Paid plan. Aggregation is client-side, so the Worker never needs long CPU,
  // but JSON.parse over many 100-item commit pages is real work.
  "limits": {
    "cpu_ms": 60000,
  },
  "assets": {
    "directory": "./public",
    // /api/* goes to the Worker; everything else is served from public/.
    "run_worker_first": ["/api/*"],
    // NOT "single-page-application": that mode makes *navigation* requests skip
    // the Worker entirely, so opening an /api/ URL in a tab would render
    // index.html instead of the API response. This is one hand-written page
    // with no client-side router, so it wants no SPA fallback at all.
    "not_found_handling": "none",
    "html_handling": "auto-trailing-slash",
  },
  // Storage-free abuse guards. Counters are per-colo and eventually consistent —
  // Cloudflare documents them as permissive, not exact. Good enough to stop a
  // script from using this Worker as a token-validity oracle.
  "ratelimits": [
    { "name": "RL_IP", "namespace_id": "1001", "simple": { "limit": 30, "period": 60 } },
    { "name": "RL_TOKEN", "namespace_id": "1002", "simple": { "limit": 60, "period": 60 } },
  ],
  // Intentionally no kv_namespaces / d1_databases / r2_buckets: this Worker
  // handles other people's API keys and must have nowhere to put them.
}
```

Requires wrangler ≥ 4.36.0 for the rate-limit binding. `period` accepts only `10` or `60`.

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
.dev.vars
.wrangler/
dist/
public/app.js
public/app.js.map
*.log
.DS_Store
```

- [ ] **Step 6: Copy `eslint.config.mjs` and `.prettierrc.json` from the exemplar**

Reproduce `/Users/michalzagalski/projects/coinpaprika/agent-payment-cf-dexpaprika/mpp-cf-dexpaprika/eslint.config.mjs` and `.prettierrc.json`, adding `public/app.js` and `.wrangler` to the ignore list.

- [ ] **Step 7: Write `vitest.config.ts` with two projects**

Pure modules run in plain Node — fast, and immune to the assets-in-pool bugs that have historically broken `@cloudflare/vitest-pool-workers`. Route tests run in the workers pool.

```ts
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'pure',
          include: [
            'test/timezone.test.ts',
            'test/describe.test.ts',
            'test/aggregate.test.ts',
            'test/plan.test.ts',
            'test/validate.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
        test: {
          name: 'worker',
          include: [
            'test/http.test.ts',
            'test/github.test.ts',
            'test/clockify.test.ts',
            'test/routes-*.test.ts',
            'test/index.test.ts',
          ],
        },
      },
    ],
  },
});
```

Do **not** write tests that assert `GET /` returns the HTML page — asset serving inside the test pool has been a recurring source of breakage, and it tests Cloudflare's router rather than this code.

- [ ] **Step 8: Write the failing test**

```ts
// test/index.test.ts
import { describe, expect, it } from 'vitest';
import app from '../src/index';

describe('health', () => {
  it('reports ok', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('404s an unknown api route as JSON', async () => {
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
```

- [ ] **Step 9: Run the test and watch it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/index'`.

- [ ] **Step 10: Write `src/index.ts`**

```ts
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
```

Note the error log records **only** `err.message`. Logging a whole error object risks serialising a `Request` and with it the credential headers.

- [ ] **Step 11: Run the tests and the full CI gate**

Run: `npm test` → Expected: PASS (2 tests).
Run: `npm run ci` → Expected: all four stages pass.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: scaffold gh2clockify Worker with Hono, assets and rate limits"
```

---

### Task 2: Wire contract, validators, error helper, credential and abuse guards

**Files:**

- Create: `src/types.ts` (copy the **Wire contract** section verbatim), `src/problems.ts`, `src/validate.ts`, `src/credentials.ts`
- Modify: `src/index.ts`
- Test: `test/validate.test.ts` (pure project), `test/routes-guards.test.ts` (worker project)

**Interfaces:**

- Consumes: `app` from Task 1.
- Produces:

```ts
// src/problems.ts
export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string);
}
export function problem(c: Context, err: unknown): Response;

// src/validate.ts  (shared, pure)
export function isOwner(v: string): boolean;        // /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
export function isRepoName(v: string): boolean;     // /^[A-Za-z0-9._-]{1,100}$/
export function isRepoFullName(v: string): boolean; // owner/name
export function isClockifyId(v: string): boolean;   // /^[0-9a-f]{24}$/i
export function isDateKey(v: string): boolean;      // /^\d{4}-\d{2}-\d{2}$/
export function isHhMm(v: string): boolean;         // /^([01]\d|2[0-3]):[0-5]\d$/
export function isClockifyHost(v: string): v is ClockifyHost;
export function isClockifySubdomain(v: string): boolean; // /^[a-z0-9-]{1,40}$/
export function segment(v: string): string;         // encodeURIComponent, throws on empty
export function daysBetween(startKey: string, endKey: string): number;

// src/credentials.ts
export type Creds = { github: string; clockify: string };
export const guards: MiddlewareHandler;             // origin + Sec-Fetch-Site + no-store + rate limit
export function requireGithub(c: Context): string;
export function requireClockify(c: Context): string;
export async function readCappedJson<T>(c: Context, maxBytes?: number): Promise<T>;
```

**Why the guards look like this:** `Origin` and `Sec-Fetch-Site` are trivially forged by `curl`, so they are not authentication. They are the control that stops _other websites_ from turning this Worker into a browser-side proxy against a victim's stored keys. Non-browser abuse is handled by the rate-limit bindings instead. Both layers are needed; neither substitutes for the other.

- [ ] **Step 1: Write the failing tests**

```ts
// test/routes-guards.test.ts
import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { env } from 'cloudflare:test';

const ORIGIN = 'https://gh2clockify.example.workers.dev';
const GOOD_TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

const call = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init, env);

describe('credential and abuse guards', () => {
  it('rejects a request with no credential header', async () => {
    const res = await call('/api/clockify/context');
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('missing_credentials');
  });

  it('rejects a foreign Origin', async () => {
    const res = await call('/api/clockify/context', {
      headers: { 'X-Clockify-Key': GOOD_TOKEN, Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('cross_origin');
  });

  it('rejects a cross-site Sec-Fetch-Site', async () => {
    const res = await call('/api/clockify/context', {
      headers: { 'X-Clockify-Key': GOOD_TOKEN, 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a token containing header-injection bytes', async () => {
    const res = await call('/api/clockify/context', {
      headers: { 'X-Clockify-Key': `bad\ntoken${'x'.repeat(20)}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_credentials');
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
});
```

`test/validate.test.ts` (pure) covers each validator's accept and reject cases, and pins the two that matter most:

```ts
it('rejects a path-traversal owner', () => {
  expect(isOwner('../../user')).toBe(false);
});

it('percent-encodes a slash so it cannot escape a path segment', () => {
  expect(segment('../../user')).toBe('..%2F..%2Fuser');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test` → Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/problems.ts`**

```ts
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
```

- [ ] **Step 4: Write `src/validate.ts`**

Pure predicates as listed in the Interfaces block. `segment(v)` throws `AppError(400, 'invalid_request', …)` on an empty value and otherwise returns `encodeURIComponent(v)` — which percent-encodes `/`, and neither the `URL` parser nor `fetch` re-decodes `%2F`, so traversal is defeated.

- [ ] **Step 5: Write `src/credentials.ts`**

```ts
import type { Context, MiddlewareHandler } from 'hono';
import { AppError } from './problems';

/**
 * Printable ASCII only. Wide enough for every real token shape — ghp_,
 * github_pat_, gho_, 40-hex classic, and Clockify's JWT-ish keys with '.',
 * '-' and '_' — while blocking CR/LF and control bytes, which make
 * `new Headers()` throw.
 */
const SAFE_TOKEN = /^[\x21-\x7e]{20,255}$/;
const MAX_BODY_BYTES = 128_000;

async function checkRateLimits(c: Context): Promise<void> {
  const ip = c.req.header('CF-Connecting-IP') ?? 'anon';
  const byIp = await c.env.RL_IP.limit({ key: ip });
  if (!byIp.success) {
    throw new AppError(429, 'rate_limited', 'Too many requests. Try again in a minute.');
  }
  // Key on a hash of the credential, never the credential itself.
  const raw = c.req.header('X-GitHub-Token') ?? c.req.header('X-Clockify-Key');
  if (raw) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const key = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const byToken = await c.env.RL_TOKEN.limit({ key });
    if (!byToken.success) {
      throw new AppError(429, 'rate_limited', 'Too many requests for this key.');
    }
  }
}

export const guards: MiddlewareHandler = async (c, next) => {
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
  c.header('Cache-Control', 'no-store');
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
```

Ordering matters and the tests pin it: **missing** is checked before **malformed**, so an absent header yields 401 and never reaches the regex.

- [ ] **Step 6: Wire into `src/index.ts`**

Add `app.use('/api/*', guards)`, change `onError` to `(err, c) => problem(c, err)`, and add a temporary `app.get('/api/clockify/context', (c) => { requireClockify(c); return c.json({}); })` so the guard tests have a route to hit. Task 10 replaces it.

- [ ] **Step 7: Create `src/types.ts`** — copy the **Wire contract** section verbatim.

- [ ] **Step 8: Run the tests** → Expected: PASS. Then `npm run ci`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add wire contract, validators and credential/abuse guards"
```

---

### Task 3: HTTP helper — timeout, retry, rate-limit backoff, pagination

**Files:**

- Create: `src/http.ts`
- Test: `test/http.test.ts`

**Interfaces:**

- Consumes: `AppError`.
- Produces:

```ts
export type UpstreamResponse<T> = { data: T; headers: Headers; status: number };
export function fetchJson<T>(
  url: string,
  init: RequestInit,
  opts?: { timeoutMs?: number; retries?: number; label?: string },
): Promise<UpstreamResponse<T>>;
export function nextPageUrl(headers: Headers): string | null;
export function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]>;
export const MAX_CONCURRENCY = 6;
```

**Why this exists:** the Python original has no timeouts, no retries and no rate-limit handling, and a single 403 aborts a whole month. Worker `fetch` has no default timeout either.

- [ ] **Step 1: Write the failing test**

`test/http.test.ts` stubs `globalThis.fetch` with `vi.stubGlobal` and covers:

1. Success returns parsed data, headers and status.
2. **Every request is sent with `cache: 'no-store'`** — assert on the init object the mock received. This is the cross-user data-isolation guard, so it gets its own test.
3. A 429 carrying `Retry-After: 0` is retried once, then succeeds.
4. A 500 exhausts the retry budget and throws `AppError` with status 502.
5. A 401 is **not** retried (assert `fetch` was called exactly once) and surfaces as 401 `upstream_unauthorized`.
6. A 403 carrying an `x-github-sso` header surfaces as `upstream_saml_required` with an actionable message — this is the single most common org failure and must not be reported as "no activity".
7. A network rejection (timeout) surfaces as 504 `upstream_timeout`.
8. `nextPageUrl` extracts `rel="next"`, returns `null` on the last page and `null` with no `Link` header.
9. `mapWithConcurrency` never exceeds the limit and preserves input order.

- [ ] **Step 2: Run and watch fail** → `npx vitest run test/http.test.ts`

- [ ] **Step 3: Write `src/http.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests** → Expected: PASS (9 tests). Then `npm run ci`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add HTTP helper with no-store, retries and rate-limit backoff"
```

---

### Task 4: Timezone helpers (shared, pure)

**Files:**

- Create: `src/timezone.ts`
- Test: `test/timezone.test.ts` (pure project)

**Interfaces:**

- Consumes: nothing. **This module must import nothing** — it runs in both the Worker and the browser.
- Produces:

```ts
export function isValidTimezone(tz: string): boolean;
export function dayKey(epochMs: number, tz: string): string; // 'YYYY-MM-DD'
export function localDayOf(instantIso: string, tz: string): string;
export function wallClockToEpochMs(dateKey: string, hhmm: string, tz: string): number;
export function isWeekendInZone(dateKey: string, tz: string): boolean;
export function utcRangeForLocalDays(
  startKey: string,
  endKey: string,
  tz: string,
): { sinceIso: string; untilIso: string };
export function utcOffsetLabel(dateKey: string, tz: string): string; // '+02:00', for GitHub search qualifiers
export function toClockifyIso(epochMs: number): string; // 'YYYY-MM-DDTHH:MM:SSZ'
```

**Why this module exists:** the Python buckets commits by **UTC** date and writes every entry as `08:00Z–16:00Z`. For a Warsaw user a 23:30 local commit is filed under the previous day, and every entry renders as 10:00–18:00. Both the bucketing and the entry times must be computed in the user's own zone.

**Three traps this implementation avoids:**

1. **Do not use `Temporal`.** Cloudflare shipped it to production in July 2026 with `Temporal.Now` stuck at epoch 0, and reverted it in August; there is no re-landing timeline. Never feature-detect it with `typeof Temporal === 'undefined'` — that is exactly what turned the outage into silent data corruption for others. `Intl` is ~40 lines and has no such risk.
2. **The naive two-pass offset inversion is wrong.** Sampling the offset at "wall clock as UTC" and re-sampling at the result converges to the _second_ occurrence of an ambiguous time and mishandles the spring-forward gap. Sample 24 h either side of the target instead, then keep only candidates that actually round-trip.
3. **Pin the formatter completely.** `hour12: false` yields hour `"24"` at midnight on some ICU builds. An unpinned locale can produce Buddhist-era years (`th-TH` → `2569`) or Arabic-Indic digits (`ar-EG` → `٢٠٢٦`), and `Number()` on those gives `NaN`. Force `en-US` + `calendar: 'gregory'` + `numberingSystem: 'latn'` + `hourCycle: 'h23'`, and build strings from `formatToParts`, never from a formatted string.

- [ ] **Step 1: Write the failing test**

```ts
// test/timezone.test.ts
import { describe, expect, it } from 'vitest';
import {
  dayKey,
  isValidTimezone,
  isWeekendInZone,
  toClockifyIso,
  utcOffsetLabel,
  utcRangeForLocalDays,
  wallClockToEpochMs,
} from '../src/timezone';

const iso = (ms: number) => new Date(ms).toISOString();

describe('isValidTimezone', () => {
  it('accepts real IANA zones and rejects junk', () => {
    expect(isValidTimezone('Europe/Warsaw')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('dayKey', () => {
  it('buckets a late-evening UTC instant into the next local day', () => {
    // 22:30Z on 2 Aug is 00:30 on 3 Aug in Warsaw (UTC+2 in summer).
    expect(dayKey(Date.parse('2026-08-02T22:30:00Z'), 'Europe/Warsaw')).toBe('2026-08-03');
  });

  it('buckets an early-morning UTC instant into the previous local day', () => {
    expect(dayKey(Date.parse('2026-08-03T04:00:00Z'), 'America/Los_Angeles')).toBe('2026-08-02');
  });

  it('is the identity for UTC', () => {
    expect(dayKey(Date.parse('2026-08-03T22:30:00Z'), 'UTC')).toBe('2026-08-03');
  });
});

describe('wallClockToEpochMs', () => {
  it('converts a summer (CEST, UTC+2) wall clock', () => {
    expect(iso(wallClockToEpochMs('2026-08-03', '09:00', 'Europe/Warsaw'))).toBe(
      '2026-08-03T07:00:00.000Z',
    );
  });

  it('converts a winter (CET, UTC+1) wall clock', () => {
    expect(iso(wallClockToEpochMs('2026-01-03', '09:00', 'Europe/Warsaw'))).toBe(
      '2026-01-03T08:00:00.000Z',
    );
  });

  it('shifts a nonexistent spring-forward time out of the gap', () => {
    // Warsaw DST begins 2026-03-29: 02:00 -> 03:00, so 02:30 does not exist.
    expect(iso(wallClockToEpochMs('2026-03-29', '02:30', 'Europe/Warsaw'))).toBe(
      '2026-03-29T01:30:00.000Z', // = 03:30 local
    );
  });

  it('picks the first occurrence of an ambiguous fall-back time', () => {
    // Warsaw DST ends 2026-10-25: 03:00 -> 02:00, so 02:30 happens twice.
    expect(iso(wallClockToEpochMs('2026-10-25', '02:30', 'Europe/Warsaw'))).toBe(
      '2026-10-25T00:30:00.000Z', // the CEST one
    );
  });

  it('handles a half-hour offset zone', () => {
    expect(iso(wallClockToEpochMs('2026-08-03', '09:00', 'Asia/Kolkata'))).toBe(
      '2026-08-03T03:30:00.000Z',
    );
  });

  it('handles midnight without rolling the date', () => {
    expect(iso(wallClockToEpochMs('2026-08-03', '00:00', 'Europe/Warsaw'))).toBe(
      '2026-08-02T22:00:00.000Z',
    );
  });
});

describe('isWeekendInZone', () => {
  it('identifies Saturday and Sunday', () => {
    expect(isWeekendInZone('2026-08-01', 'Europe/Warsaw')).toBe(true); // Sat
    expect(isWeekendInZone('2026-08-02', 'Europe/Warsaw')).toBe(true); // Sun
    expect(isWeekendInZone('2026-08-03', 'Europe/Warsaw')).toBe(false); // Mon
  });
});

describe('utcRangeForLocalDays', () => {
  it('spans local midnight to local midnight after the last day', () => {
    const { sinceIso, untilIso } = utcRangeForLocalDays(
      '2026-08-01',
      '2026-08-31',
      'Europe/Warsaw',
    );
    expect(sinceIso).toBe('2026-07-31T22:00:00.000Z');
    expect(untilIso).toBe('2026-08-31T22:00:00.000Z'); // exclusive
  });
});

describe('utcOffsetLabel', () => {
  it('renders the offset GitHub search qualifiers need', () => {
    expect(utcOffsetLabel('2026-08-03', 'Europe/Warsaw')).toBe('+02:00');
    expect(utcOffsetLabel('2026-01-03', 'Europe/Warsaw')).toBe('+01:00');
    expect(utcOffsetLabel('2026-08-03', 'America/Los_Angeles')).toBe('-07:00');
    expect(utcOffsetLabel('2026-08-03', 'Asia/Kolkata')).toBe('+05:30');
  });
});

describe('toClockifyIso', () => {
  it('emits second precision with no milliseconds', () => {
    expect(toClockifyIso(Date.parse('2026-08-03T07:00:00.000Z'))).toBe('2026-08-03T07:00:00Z');
  });
});
```

- [ ] **Step 2: Run and watch fail** → `npx vitest run --project pure test/timezone.test.ts`

- [ ] **Step 3: Write `src/timezone.ts`**

```ts
/**
 * Timezone maths with no dependencies and no imports — this module is bundled
 * into both the Worker and the browser client.
 *
 * Deliberately does NOT use Temporal: Cloudflare shipped it to production in
 * July 2026 with Temporal.Now stuck at epoch 0 and reverted it in August, with
 * no re-landing timeline. Intl is enough.
 */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * A fully pinned formatter. Every option here is load-bearing:
 *   - 'en-US' + gregory + latn: an unpinned locale can emit Buddhist-era years
 *     or Arabic-Indic digits, and Number() on those returns NaN.
 *   - hourCycle 'h23': `hour12: false` yields "24" at midnight on some ICU
 *     builds, which rolls Date.UTC into the next day.
 */
function formatter(tz: string): Intl.DateTimeFormat {
  let found = FORMATTERS.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    FORMATTERS.set(tz, found);
  }
  return found;
}

function fields(epochMs: number, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(epochMs)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The local calendar day an instant falls on, in `tz`. */
export function dayKey(epochMs: number, tz: string): string {
  const f = fields(epochMs, tz);
  return `${(f.year ?? '0').padStart(4, '0')}-${f.month ?? '01'}-${f.day ?? '01'}`;
}

export function localDayOf(instantIso: string, tz: string): string {
  return dayKey(Date.parse(instantIso), tz);
}

/** How far `tz` is ahead of UTC at instant `t`, in ms. East of UTC is positive. */
function offsetMs(t: number, tz: string): number {
  const f = fields(t, tz);
  const asIfUtc = Date.UTC(
    Number(f.year),
    Number(f.month) - 1,
    Number(f.day),
    Number(f.hour),
    Number(f.minute),
    Number(f.second),
  );
  // formatToParts truncates sub-second, so compare against a truncated t.
  return asIfUtc - Math.floor(t / 1000) * 1000;
}

/**
 * Turn a local wall clock into the epoch instant it denotes.
 *
 * Sample the zone offset a day either side of the target — never at the target
 * itself, which is what makes the naive two-pass version converge on the wrong
 * side of a DST transition. Keep only candidates that round-trip back to the
 * requested wall clock. Ambiguous (fall-back) times resolve to the earliest
 * occurrence; nonexistent (spring-forward) times shift forward out of the gap.
 * This matches Temporal's 'compatible' disambiguation.
 */
export function wallClockToEpochMs(dateKey: string, hhmm: string, tz: string): number {
  if (!DATE_KEY.test(dateKey)) throw new Error(`Invalid date key: ${dateKey}`);
  if (!HHMM.test(hhmm)) throw new Error(`Invalid time: ${hhmm}`);

  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm, 0);

  const before = wall - offsetMs(wall - DAY_MS, tz);
  const after = wall - offsetMs(wall + DAY_MS, tz);
  const candidates = before === after ? [before] : [before, after].sort((a, b) => a - b);

  const valid = candidates.filter((t) => t + offsetMs(t, tz) === wall);
  if (valid.length > 0) return valid[0] as number;
  return Math.max(...candidates);
}

const WEEKEND = new Set(['Sat', 'Sun']);

/** Weekday judged in the user's own zone, from the same pinned formatter. */
export function isWeekendInZone(dateKey: string, tz: string): boolean {
  const noon = wallClockToEpochMs(dateKey, '12:00', tz);
  return WEEKEND.has(fields(noon, tz).weekday ?? '');
}

/**
 * The UTC window covering a span of local days: local midnight on the first day
 * up to (but excluding) local midnight after the last. The exclusive upper
 * bound replaces the Python's `23:59:59Z`, which dropped the final second.
 */
export function utcRangeForLocalDays(
  startKey: string,
  endKey: string,
  tz: string,
): { sinceIso: string; untilIso: string } {
  const [y, m, d] = endKey.split('-').map(Number) as [number, number, number];
  const nextKey = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return {
    sinceIso: new Date(wallClockToEpochMs(startKey, '00:00', tz)).toISOString(),
    untilIso: new Date(wallClockToEpochMs(nextKey, '00:00', tz)).toISOString(),
  };
}

/** '+02:00' — GitHub search date qualifiers accept a UTC offset suffix. */
export function utcOffsetLabel(dateKey: string, tz: string): string {
  const minutes = offsetMs(wallClockToEpochMs(dateKey, '12:00', tz), tz) / 60_000;
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Clockify documents start/end as `yyyy-MM-ddThh:mm:ssZ` — no milliseconds. */
export function toClockifyIso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
```

- [ ] **Step 4: Run the tests** → Expected: PASS (16 tests).

If a DST expectation fails, print the actual value before changing the test — the expectations were derived from the real Warsaw 2026 transitions (DST 2026-03-29 → 2026-10-25), so a failure more likely means the candidate filtering is wrong than that the expectation is.

Then `npm run ci`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add DST-correct timezone helpers"
```

---

### Task 5: Description builder (shared, pure)

**Files:**

- Create: `src/describe.ts`
- Test: `test/describe.test.ts` (pure project)

**Interfaces:**

- Consumes: `Activity` from `src/types.ts` (type-only import).
- Produces:

```ts
export const CLOCKIFY_MAX_DESCRIPTION = 3000;
export function repoAlias(repoFullName: string, aliases: Record<string, string>): string;
export function describeDay(activities: Activity[], aliases: Record<string, string>): string;
export function sanitizeDescription(message: string): string;
```

**Format** — preserved from the Python, with both sort bugs fixed:

```
<ALIAS> [ISSUE #a #b] [(fix) (feat)] title1, title2   |   <ALIAS2> ...
```

- Repo blocks joined with `" | "`, in the order repos first appear in the day's activity.
- `ALIAS` from the alias map keyed by full name (`owner/repo`) first, then bare name; fallback `name.toUpperCase().replaceAll('-', '_')`.
- `ISSUE` lists `#\d+` references found in titles, deduped, **sorted numerically** — the Python sorted them as strings, so `#10` came before `#9`. Omitted when empty.
- Types are `(fix)` / `(feat)` matched case-insensitively but **anchored at the title start**, original casing preserved. Deduped, sorted, space-joined. Omitted when empty.
- Titles are deduped but keep **chronological order** — the Python sorted them alphabetically, destroying the shape of the day.

**Sanitization** — real Clockify server constraints, ported with two corrections:

```ts
const TRUNCATION_MARKER = ' | ...(truncated)';
/** C0 controls except tab; they survive JSON but confuse the Clockify UI. */
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function sanitizeDescription(message: string): string {
  // Clockify 400s on '<' and '>'. Do this first: it grows the string, so the
  // length check must see the grown version.
  const safe = message.replaceAll('<', '(lt)').replaceAll('>', '(gt)').replace(CONTROL_CHARS, ' ');

  // maxLength counts Unicode CODE POINTS. String.length counts UTF-16 code
  // units, so an emoji overcounts by one and .slice() can split a surrogate
  // pair into a lone surrogate. Work in code points throughout.
  const points = Array.from(safe);
  if (points.length < CLOCKIFY_MAX_DESCRIPTION) return safe;

  const budget = CLOCKIFY_MAX_DESCRIPTION - Array.from(TRUNCATION_MARKER).length - 1;
  const kept: string[] = [];
  let used = 0;

  for (const block of safe.split(' | ')) {
    const size = Array.from(block).length;
    const sep = kept.length > 0 ? 3 : 0;
    if (used + sep + size <= budget) {
      kept.push(block);
      used += sep + size;
    } else {
      if (kept.length === 0) {
        // A single block already overflows. Salvage a clean prefix, cut at the
        // last complete title rather than mid-word or mid-code-point.
        let prefix = Array.from(block).slice(0, budget).join('');
        const cut = prefix.lastIndexOf(', ');
        if (cut !== -1) prefix = prefix.slice(0, cut);
        kept.push(prefix);
      }
      break;
    }
  }
  return kept.join(' | ') + TRUNCATION_MARKER;
}
```

- [ ] **Step 1: Write the failing test**

`test/describe.test.ts` covers, with an `act(overrides)` factory building `Activity` objects:

1. A repo block with alias, issues and types: two commits → `DP ISSUE #9 #185 (fix) (fix) resolve login redirect #185, bump deps #9`.
2. Issue numbers sort **numerically**: `#10`, `#9`, `#185` → `ISSUE #9 #10 #185`.
3. Titles keep **chronological** order: a 09:00 "zebra work" and a 10:00 "apple work" → `DP zebra work, apple work`.
4. Multiple repos join with `" | "` in first-appearance order.
5. Alias fallback: `acme/my-cool-repo` with no alias → `MY_COOL_REPO`.
6. Identical titles within one repo dedupe.
7. `ISSUE` and type segments are omitted entirely when empty.
8. `sanitizeDescription` replaces `<`/`>` with `(lt)`/`(gt)`.
9. A short description is returned untouched.
10. Truncation happens on a block boundary, stays under 3000 and ends with the marker.
11. When the very first block overflows, a clean title prefix is salvaged and the tail is dropped.
12. Length is counted **after** bracket replacement: `'<'.repeat(1000)` becomes 4000 chars and must truncate.
13. **Code-point safety:** `'🎉'.repeat(2000)` truncates to fewer than 3000 code points and `Array.from(out).length < 3000`, with no lone surrogate (assert `out === Array.from(out).join('')` and that the string contains no unpaired `\uD800-\uDBFF`).
14. Control characters are replaced with spaces.

- [ ] **Step 2: Run and watch fail** → `npx vitest run --project pure test/describe.test.ts`

- [ ] **Step 3: Implement `src/describe.ts`**

- [ ] **Step 4: Run the tests** → Expected: PASS (14 tests). Then `npm run ci`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add day description builder with code-point-safe sanitization"
```

---

### Task 6: Aggregation (shared, pure)

**Files:**

- Create: `src/aggregate.ts`
- Test: `test/aggregate.test.ts` (pure project)

**Interfaces:**

- Consumes: `dayKey`, `wallClockToEpochMs`, `isWeekendInZone`, `toClockifyIso` (Task 4); `describeDay`, `sanitizeDescription` (Task 5); `Activity`, `ImportSettings`, `ProposedEntry` (Task 2).
- Produces:

```ts
export function aggregate(
  activities: Activity[],
  settings: ImportSettings,
): { entries: ProposedEntry[]; skipped: { date: string; reason: 'weekend' }[] };
```

**Rules:**

1. **Dedupe by `id` first.** The same commit SHA can arrive from two repos (a fork listed in the same org); the Python counted it twice.
2. Bucket by `dayKey(Date.parse(activity.timestamp), settings.timezone)`.
3. Drop weekend days when `includeWeekends` is false, recording each in `skipped` so the UI can say "3 weekend days ignored" rather than silently losing them.
4. Per remaining day: `start = wallClockToEpochMs(date, settings.startTime, settings.timezone)`, `end = start + hoursPerDay * 3_600_000`, both serialized with `toClockifyIso`.
5. `description = sanitizeDescription(describeDay(dayActivities, settings.repoAliases))`.
6. `repos` = distinct repo full names for the day in first-appearance order; `activityCount` = the deduped count.
7. **Return entries sorted by date ascending.** The Python emitted them in hash order.

A day with no activity produces no entry — no gap filling. The caller validates `hoursPerDay` in `(0, 24]`.

**Note on `end`:** adding `hoursPerDay × 3600 s` is an _instant_ offset, not a wall-clock offset. On a DST transition day an "09:00 + 8h" entry reads 09:00–18:00 local. Clockify derives duration from the instants so the hours are correct, and this is the behaviour we want (8 hours means 8 hours); the UI note in Task 14 mentions it.

- [ ] **Step 1: Write the failing test**

`test/aggregate.test.ts` covers:

1. Two commits on the same local day → one entry with `activityCount: 2`.
2. Duplicate `id`s across repos collapse to one activity.
3. `hoursPerDay: 6`, `startTime: '10:00'`, `Europe/Warsaw`, `2026-08-03` → `start: '2026-08-03T08:00:00Z'`, `end: '2026-08-03T14:00:00Z'`.
4. Emitted timestamps have **no milliseconds** — assert the literal strings.
5. `includeWeekends: false` drops a Saturday-only activity and reports it in `skipped`; `true` keeps it.
6. **The bug fix, pinned:** a `2026-08-02T22:30:00Z` commit lands on `2026-08-03` for `Europe/Warsaw` and on `2026-08-02` for `UTC`.
7. Entries come back date-ascending even when input activities are shuffled.
8. An empty activity list yields an empty entry list, not a throw.
9. Mixed activity kinds on one day produce a single entry counting all of them.

- [ ] **Step 2: Run and watch fail** → `npx vitest run --project pure test/aggregate.test.ts`

- [ ] **Step 3: Implement `src/aggregate.ts`**

- [ ] **Step 4: Run the tests** → Expected: PASS (9 tests). Then `npm run ci`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: aggregate activity into timezone-correct daily entries"
```

---

### Task 7: Duplicate detection / plan diff (shared, pure)

**Files:**

- Create: `src/plan.ts`
- Test: `test/plan.test.ts` (pure project)

**Interfaces:**

- Consumes: `dayKey` (Task 4); `ProposedEntry`, `ExistingEntry`, `PlannedEntry`, `ImportPlan` (Task 2).
- Produces:

```ts
export function buildPlan(
  proposed: ProposedEntry[],
  existing: ExistingEntry[],
  opts: {
    timezone: string;
    projectId: string;
    skipped: { date: string; reason: 'weekend' }[];
    warnings: string[];
  },
): ImportPlan;

/** Used by /api/apply for the pre-write re-check. */
export function findDuplicate(
  entry: ProposedEntry,
  existing: ExistingEntry[],
  timezone: string,
): ExistingEntry | undefined;
```

**This is the single most important safety feature in the product.** The Python has no idempotency at all — re-running a month silently doubles the hours. Rules:

1. An existing entry collides with a proposed entry when it falls on the **same local day** and has the **same `projectId`**.
2. **Compare on local day key, not on instants.** An entry starting at 23:00 the previous day still occupies the following local day for a user east of UTC, and instant comparison would miss it.
3. The caller must widen the Clockify query by **±1 day** around the range for the same reason (Task 10 does this) — the API filters on the entry's own start time.
4. A colliding entry gets `status: 'duplicate'` and carries `existing`, so the UI can show what is already there. Duplicates default to **unchecked** in the UI.
5. `totals.hours` counts only `status: 'new'` entries — it is what the user is about to add, not what will exist afterwards.

- [ ] **Step 1: Write the failing test**

`test/plan.test.ts` covers:

1. No existing entries → every entry `status: 'new'`, `duplicateDays: 0`.
2. An existing entry on the same day and project → `status: 'duplicate'` with `existing` populated.
3. An existing entry on the same day but a **different project** → still `new`.
4. **The boundary case:** an existing entry starting `2026-08-02T23:00:00Z` is a duplicate of a proposed `2026-08-03` entry when `timezone` is `Europe/Warsaw` (it is 01:00 on the 3rd locally), and is **not** a duplicate under `UTC`.
5. `totals.hours` sums only new entries.
6. `skipped` and `warnings` pass through unchanged.
7. `findDuplicate` returns `undefined` when nothing collides and the entry when one does.

- [ ] **Step 2: Run and watch fail** → `npx vitest run --project pure test/plan.test.ts`

- [ ] **Step 3: Implement `src/plan.ts`**

- [ ] **Step 4: Run the tests** → Expected: PASS (7 tests). Then `npm run ci`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add duplicate detection so imports are idempotent"
```

---

### Task 8: GitHub client

**Files:**

- Create: `src/github.ts`
- Test: `test/github.test.ts` (worker project)

**Interfaces:**

- Consumes: `fetchJson`, `nextPageUrl`, `mapWithConcurrency`, `MAX_CONCURRENCY` (Task 3); `segment`, `isOwner`, `isRepoFullName` (Task 2); `Activity`, `ActivityKind` (Task 2); `AppError`.
- Produces:

```ts
export type Viewer = { login: string; name: string | null; avatarUrl: string };
export type Org = { login: string; avatarUrl: string };
export type Repo = {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  pushedAt: string | null;
};
export type RepoScope = { kind: 'personal' } | { kind: 'org'; org: string };
export type RateBudget = {
  limit: number;
  remaining: number;
  resetAt: string;
  searchRemaining: number;
};
export type ActivityFetch = { activities: Activity[]; warnings: string[]; incomplete: boolean };

export function getViewer(token: string): Promise<Viewer>;
export function listOrgs(token: string): Promise<Org[]>;
export function getRateBudget(token: string): Promise<RateBudget>;
export function listRepos(token: string, scope: RepoScope): Promise<Repo[]>;
export function fetchCommits(
  token: string,
  p: { repos: string[]; login: string; sinceIso: string; untilIso: string },
): Promise<ActivityFetch>;
export function fetchSearch(
  token: string,
  p: {
    source: Exclude<ActivityKind, 'commit'>;
    login: string;
    scope: RepoScope;
    repos: string[];
    startKey: string;
    endKey: string;
    offsetLabel: string;
  },
): Promise<ActivityFetch>;
```

**Headers** — three deliberate changes from the Python:

```ts
const GITHUB_API = 'https://api.github.com';

function ghHeaders(token: string): HeadersInit {
  return {
    // Modern media type + pinned API version, replacing 'vnd.github.v3+json'.
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // 'Bearer' covers classic AND fine-grained PATs; the legacy 'token ...'
    // scheme only covers classic ones.
    Authorization: `Bearer ${token}`,
    // GitHub rejects requests with no User-Agent.
    'User-Agent': 'gh2clockify',
  };
}
```

Wrap header construction in `try/catch` and rethrow as `AppError(400, 'invalid_credentials', …)` — an illegal byte makes `new Headers()` throw, which would otherwise be a 500.

**Pagination** follows the `Link` header, capped at 10 pages (also the Search API's hard result cap). The Python looped on "empty array", which spins forever if the API ever returns a non-array 200.

**Repo listing:**

| Scope    | Request                                                                   |
| -------- | ------------------------------------------------------------------------- |
| personal | `GET /user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100` |
| org      | `GET /orgs/{org}/repos?type=all&sort=pushed&per_page=100`                 |

Sort results by `pushedAt` descending so recently active repos surface first in the picker.

**Commits** — one paginated call per repo at concurrency `MAX_CONCURRENCY`:

```
GET /repos/{segment(owner)}/{segment(name)}/commits
    ?author={login}&since={widenedSince}&until={widenedUntil}&per_page=100
```

Two corrections over a naive port:

- **Widen the window by ±1 day, then re-filter client-side on `commit.author.date`.** The docs define `since`/`until` against the _committer_ date, but bucketing uses the _author_ date, and rebases/amends/cherry-picks make them differ by days. Without widening, edge days silently lose commits.
- 404 (no access) and 409 (empty repo) become `warnings` entries, not failures. A 403 with `x-github-sso` propagates as the actionable SAML error from Task 3 — **do not swallow it as "no activity"**, it is the most common org failure.

Map: `id` = SHA (free cross-repo dedup), `timestamp` = `commit.author.date` (falling back to `commit.committer.date`), `title` = **first line only** of `commit.message`, trimmed.

**Known limitation, surfaced in the UI (Task 14) and README:** with no `sha` parameter GitHub returns only commits reachable from the default branch. Work on unmerged branches is invisible; squash-merged work is dated by the merge. This matches the current Python behaviour and was an explicit product decision.

**PRs / issues / reviews** — the Search API, one query per source per ≤ 31-day window:

```
GET /search/issues?q={query}&per_page=100&advanced_search=true
```

| Source         | Query                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| `pull_request` | `author:{login} type:pr created:{start}T00:00:00{off}..{end}T23:59:59{off} {scope}`      |
| `issue`        | `author:{login} type:issue created:{start}T00:00:00{off}..{end}T23:59:59{off} {scope}`   |
| `review`       | `reviewed-by:{login} type:pr updated:{start}T00:00:00{off}..{end}T23:59:59{off} {scope}` |

where `{scope}` is `org:{org}` or `user:{login}`, and `{off}` is `utcOffsetLabel(...)` from Task 4.

Four things that will silently break if not done:

- **`advanced_search=true` is mandatory.** In the legacy mode a space between two same-type qualifiers means OR; in advanced mode it means AND. GitHub has announced the default will flip, so any query written for one dialect returns zero results under the other. Pin the parameter and write explicit `OR` where needed.
- **Date qualifiers must carry the UTC offset.** A bare UTC window will not line up with local-day buckets, dropping or duplicating edge days.
- **Search items have no `repository` object** — only `repository_url` (`https://api.github.com/repos/owner/name`). Parse its last two segments to get `owner/name`, then drop anything outside the caller's selection.
- **Honour `incomplete_results: true`** (search index timeout ⇒ silently partial) and assert `total_count <= 1000`; if either trips, return `incomplete: true` so the UI can tell the user to narrow the range.

**Reviews need a second hop.** `reviewed-by:{login} updated:{range}` means "PRs this person reviewed at some point, that were _touched_ in the range" — it will happily attribute a 2024 review to today. Use it as a candidate filter only, then:

```
GET /repos/{owner}/{name}/pulls/{number}/reviews?per_page=100
```

at concurrency `MAX_CONCURRENCY`, keeping only reviews where `user.login === login` and `submitted_at` is in range. `id` = `review:{owner}/{name}#{number}:{reviewId}`, `timestamp` = `submitted_at`. A failure on a single PR becomes a warning, not an abort.

- [ ] **Step 1: Write the failing tests**

`test/github.test.ts` stubs `fetch` and covers:

1. `getViewer` sends `Bearer`, `application/vnd.github+json`, `X-GitHub-Api-Version` and a `User-Agent`.
2. `listRepos` hits `/user/repos?affiliation=owner,collaborator` for personal and `/orgs/acme/repos` for org.
3. Pagination follows `Link: <…page=2>; rel="next"` and concatenates both pages.
4. A commit maps to `Activity` with SHA as id, `commit.author.date` as timestamp and a first-line-only title.
5. **The requested window is widened by a day, and a commit outside the true range is filtered back out.**
6. A repo returning 409 yields a warning and an empty list; the other repos in the batch still return their commits.
7. A repo returning 404 does the same.
8. A 403 with `x-github-sso` **propagates** rather than becoming a warning.
9. **`advanced_search=true` is present on every search request** — its own test, since omitting it silently returns nothing.
10. Search date qualifiers carry the offset label (assert the `q` contains `+02:00`).
11. Search results whose `repository_url` is outside the selection are dropped.
12. `incomplete_results: true` in the response sets `incomplete: true` in the return value.
13. A `reviewed-by` hit is expanded via `/pulls/{n}/reviews`, and only the caller's own review inside the range becomes an `Activity`; a review by someone else and one dated outside the range are both dropped.
14. A path-traversal owner is rejected before any `fetch` is issued.

- [ ] **Step 2: Run and watch fail** → `npx vitest run test/github.test.ts`

- [ ] **Step 3: Implement `src/github.ts`**

- [ ] **Step 4: Run the tests** → Expected: PASS (14 tests). Then `npm run ci`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add GitHub client for commits, PRs, issues and reviews"
```

---

### Task 9: Clockify client

**Files:**

- Create: `src/clockify.ts`
- Test: `test/clockify.test.ts` (worker project)

**Interfaces:**

- Consumes: `fetchJson` (Task 3); `segment`, `isClockifyHost`, `isClockifySubdomain` (Task 2); `ProposedEntry`, `ExistingEntry`, `ClockifyHost` (Task 2).
- Produces:

```ts
export type ClockifyUser = { id: string; name: string; email: string; timezone: string | null };
export type Workspace = { id: string; name: string; plan: string; freeTier: boolean };
export type Project = { id: string; name: string; clientName: string | null };

export function baseUrl(host: ClockifyHost, subdomain?: string): string;
export function getUser(key: string, base: string): Promise<ClockifyUser>;
export function listWorkspaces(key: string, base: string): Promise<Workspace[]>;
export function listProjects(key: string, base: string, workspaceId: string): Promise<Project[]>;
export function listEntries(
  key: string,
  base: string,
  workspaceId: string,
  userId: string,
  startIso: string,
  endIso: string,
): Promise<ExistingEntry[]>;
export function createEntry(
  key: string,
  base: string,
  workspaceId: string,
  entry: ProposedEntry,
): Promise<{ id: string }>;
```

**Host resolution** — hardcoded allowlist, never a free-form host (that would be a direct SSRF):

```ts
const REGIONS = new Set(['api', 'euc1', 'use2', 'euw2', 'apse2']);

export function baseUrl(host: ClockifyHost, subdomain?: string): string {
  if (subdomain) {
    if (!isClockifySubdomain(subdomain))
      throw new AppError(400, 'invalid_request', 'Invalid subdomain');
    return `https://${subdomain}.clockify.me/api/v1`;
  }
  if (!REGIONS.has(host)) throw new AppError(400, 'invalid_request', 'Unknown Clockify region');
  return `https://${host}.clockify.me/api/v1`;
}
```

Clockify's own docs: _"If your workspace is in a specific region, you need to change your URL prefix"_ (EU `euc1`, USA `use2`, UK `euw2`, AU `apse2`), and subdomain workspaces need a key generated specifically for that subdomain. The region is **not** discoverable from the API, so it is a UI choice (Task 14) defaulting to `api`.

**Endpoints** (auth header `X-Api-Key`, never `Authorization`):

| Purpose          | Request                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Current user     | `GET /user` → `{id, name, email, settings.timeZone}`                                         |
| Workspaces       | `GET /workspaces` → also read `featureSubscriptionType` for the plan                         |
| Projects         | `GET /workspaces/{ws}/projects?page={n}&page-size=5000&archived=false`                       |
| Existing entries | `GET /workspaces/{ws}/user/{uid}/time-entries?start={iso}&end={iso}&page={n}&page-size=5000` |
| Create           | `POST /workspaces/{ws}/time-entries`                                                         |

**Pagination:** Clockify sends **no `Link` header**. Use `page` (1-based) and **`page-size`** (hyphenated — the prose docs say `pageSize`, but every endpoint definition declares `page-size`), and terminate on the **`Last-Page: true`** response header rather than by counting. The Python passed no paging params at all, so a workspace with more than the default 50 projects silently failed to find the target project.

**`archived=false` is required.** The parameter's own documentation: _"If omitted, you'll get both archived and non-archived"_ — the schema's `default: false` is misleading. Without it the UI offers projects that reject new entries.

**Never pick `workspaces[0]`** the way the Python does; the workspace is always an explicit UI choice.

**Create body** — exactly:

```ts
{
  start: entry.start,          // 'YYYY-MM-DDTHH:MM:SSZ'
  end: entry.end,
  billable: entry.billable,
  description: entry.description,
  projectId: entry.projectId,
  taskId: null,
  tagIds: [],
  type: 'REGULAR',
}
```

`userId` is **not** sent. `CreateTimeEntryRequest` has no such property — the `userId` the Python sends is silently ignored. `POST /workspaces/{ws}/time-entries` creates for the key's owner, which is exactly right here; the `/user/{uid}/time-entries` variant is for creating on someone else's behalf and needs elevated permissions.

**Free-plan detection.** Map `featureSubscriptionType` into `freeTier`. Free workspaces are capped at **30 API requests per hour, workspace-wide**; paid ones get 50/second. Surface this on the `Workspace` object so the UI can warn before the user starts a 30-entry import. Clockify returns no rate-limit headers, so pacing is fixed client-side and 429 is handled by `fetchJson`'s backoff.

- [ ] **Step 1: Write the failing tests**

`test/clockify.test.ts` covers:

1. Every request carries `X-Api-Key` and **no** `Authorization` header.
2. `baseUrl('euc1')` → `https://euc1.clockify.me/api/v1`; `baseUrl('api', 'acme')` → `https://acme.clockify.me/api/v1`; an unknown region and a malformed subdomain both throw 400.
3. `listProjects` requests `page-size=5000` and `archived=false`, follows to page 2 when `Last-Page: false`, and stops on `Last-Page: true`.
4. `listEntries` passes `start`/`end` through and paginates the same way.
5. `createEntry` POSTs the exact body above — deep-equal the parsed JSON including `taskId: null` and `type: 'REGULAR'` — and **`userId` is absent**.
6. A 401 surfaces as `AppError` 401 `upstream_unauthorized`.
7. `getUser` maps `settings.timeZone` into `timezone` and tolerates it being absent.
8. `listWorkspaces` sets `freeTier: true` for a `FREE` `featureSubscriptionType` and `false` otherwise.
9. A workspace id failing `isClockifyId` is rejected before any `fetch`.

- [ ] **Step 2: Run and watch fail** → `npx vitest run test/clockify.test.ts`

- [ ] **Step 3: Implement `src/clockify.ts`**

- [ ] **Step 4: Run the tests** → Expected: PASS (9 tests). Then `npm run ci`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Clockify client with regional hosts and correct pagination"
```

---

### Task 10: Discovery routes

**Files:**

- Create: `src/routes/github.ts`, `src/routes/clockify.ts`
- Modify: `src/index.ts` (mount routers, delete the Task 2 placeholder)
- Test: `test/routes-discovery.test.ts`

**Interfaces:**

- Consumes: Tasks 8 and 9's clients; `requireGithub`, `requireClockify` (Task 2).
- Produces the five discovery routes from the HTTP surface table.

Each route requires only the credential it actually needs, so the UI can validate the two keys independently and say _which_ one is wrong.

Query validation is explicit, using Task 2's validators — `scope` ∈ `{personal, org}`; `org` required and `isOwner` when `scope=org`; `workspaceId`/`userId` must be `isClockifyId`; `host` must be `isClockifyHost`. Anything else is `AppError(400, 'invalid_request', …)`.

**`GET /api/clockify/entries` widens the requested range by ±1 day** before calling `listEntries`, because the API filters on the entry's own start time and an entry beginning at 23:00 the previous day still occupies the following local day. Task 7's diff then compares on local day keys.

**`GET /api/github/context` also returns the rate budget** from `GET /rate_limit` — that endpoint does not count against any limit, and showing "4,812 of 5,000 requests left" before a 25-repo scan is worth one free call.

- [ ] **Step 1: Write the failing tests**

`test/routes-discovery.test.ts`, with `fetch` stubbed to canned upstream payloads:

1. `/api/github/context` returns `{viewer, orgs, rateLimit}`.
2. It succeeds with **no** `X-Clockify-Key` (independent validation), and `/api/clockify/context` succeeds with no `X-GitHub-Token`.
3. `/api/github/repos?scope=org` with no `org` → 400 `invalid_request`.
4. `/api/github/repos?scope=org&org=../../x` → 400, and no `fetch` was issued.
5. `/api/clockify/projects?workspaceId=not-an-id` → 400 `invalid_request`.
6. `/api/clockify/entries` widens the range — assert the upstream URL's `start` is one day before the requested one.
7. An upstream 401 becomes a 401 `upstream_unauthorized`, and the body does not contain the token string.

- [ ] **Step 2: Run and watch fail** → `npx vitest run test/routes-discovery.test.ts`

- [ ] **Step 3: Implement the routers and mount them**

```ts
// src/index.ts
app.route('/api/github', githubRoutes);
app.route('/api/clockify', clockifyRoutes);
```

- [ ] **Step 4: Run the tests** → Expected: PASS (7 tests). Then `npm run ci`.

- [ ] **Step 5: Smoke test against the real APIs**

```bash
npm run dev
# In another shell, with your own keys:
curl -s -H "X-GitHub-Token: $GH" http://localhost:8787/api/github/context | head -c 400
curl -s -H "X-Clockify-Key: $CK" http://localhost:8787/api/clockify/context | head -c 400
```

Expected: your GitHub login, orgs and remaining rate budget; your Clockify user id and workspaces with plan types.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add GitHub and Clockify discovery routes"
```

---

### Task 11: Scan routes (chunked activity fetching)

**Files:**

- Create: `src/routes/scan.ts`
- Modify: `src/index.ts`
- Test: `test/routes-scan.test.ts`

**Interfaces:**

- Consumes: `fetchCommits`, `fetchSearch` (Task 8); `readCappedJson` (Task 2).
- Produces:

```
POST /api/scan/commits  body: { repos: string[]; login: string; sinceIso: string; untilIso: string }
                        -> { activities: Activity[]; warnings: string[]; incomplete: boolean }

POST /api/scan/search   body: { source: 'pull_request'|'issue'|'review'; login: string;
                                scope: RepoScope; repos: string[];
                                startKey: string; endKey: string; offsetLabel: string }
                        -> { activities: Activity[]; warnings: string[]; incomplete: boolean }
```

**These are chunk endpoints, and that is the whole point.** Cloudflare cancels outstanding work when the client disconnects, a custom domain adds a ~100 s proxy timeout, and a user can close the tab. A single monolithic scan over 50 repos would be killed mid-flight with no way to resume. Making the browser the orchestrator gives a progress bar, per-chunk retry, cancel, and resumability for free — and keeps each Worker invocation small.

**Server-side caps, enforced before any `fetch`:**

- `/api/scan/commits`: `repos.length <= 8`. At up to 10 pages each that is ≤ 80 subrequests, comfortably inside the Paid budget with room for the review second-hop.
- `/api/scan/search`: exactly one source, and `endKey - startKey <= 31` days — search is 30 requests/minute, so the client paces month-sized windows.
- Both: body ≤ 128 KB via `readCappedJson`, every repo full-name validated with `isRepoFullName`.

- [ ] **Step 1: Write the failing tests**

`test/routes-scan.test.ts` covers:

1. A valid commits chunk returns activities and warnings.
2. `repos.length = 9` → 400 `invalid_request`, **and no `fetch` was issued**.
3. A repo full-name failing validation → 400 before any `fetch`.
4. A search window of 40 days → 400 `invalid_request`.
5. A body over 128 KB → 413 `body_too_large`.
6. `source: 'commit'` on `/api/scan/search` → 400 (commits have their own route).
7. `incomplete: true` from the client is passed through to the response.
8. A missing `X-GitHub-Token` → 401.

- [ ] **Step 2: Run and watch fail** → `npx vitest run test/routes-scan.test.ts`

- [ ] **Step 3: Implement `src/routes/scan.ts` and mount at `/api/scan`**

- [ ] **Step 4: Run the tests** → Expected: PASS (8 tests). Then `npm run ci`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add chunked scan routes for commits and search"
```

---

### Task 12: Apply route

**Files:**

- Create: `src/routes/apply.ts`
- Modify: `src/index.ts`
- Test: `test/routes-apply.test.ts`

**Interfaces:**

- Consumes: `listEntries`, `createEntry`, `baseUrl` (Task 9); `findDuplicate` (Task 7); `readCappedJson` (Task 2).
- Produces:

```
POST /api/apply  body: { host: ClockifyHost; subdomain?: string; workspaceId: string;
                         userId: string; timezone: string; entries: ProposedEntry[] }
                 -> { results: ApplyResult[] }
```

**Behaviour — this route is the one that can cause real damage, so it is deliberately conservative:**

1. Cap at **5 entries per request**. The client sends batches and shows progress; a killed request can then lose at most five writes, and each is individually reported.
2. **Re-run duplicate detection immediately before writing.** The preview is stale by the time the user approves it, and Clockify's API has no idempotency key, so a retried POST after a timeout creates a duplicate. Fetch existing entries once for the batch's date span (widened ±1 day), then call `findDuplicate` per entry. A hit yields `{ok: true, skipped: true, error: 'Already exists'}` and **no write**.
3. Write **sequentially**, not concurrently. Clockify Free workspaces allow 30 requests/hour total; hammering concurrently just converts the budget into 429s.
4. A failure on one entry is recorded and the loop continues — one bad day must not abort the batch.
5. **Never retry a POST on an ambiguous failure** (timeout, 502). Re-GET that day first; a blind retry is exactly how duplicates get created.

- [ ] **Step 1: Write the failing tests**

`test/routes-apply.test.ts` covers:

1. Two new entries → two POSTs, `results` both `ok: true` with entry ids.
2. **An entry that already exists is skipped with no POST** — assert the create endpoint was never called for it. This is the core safety guarantee.
3. `entries.length = 6` → 400 `invalid_request`, no writes.
4. A 400 on entry 1 does not stop entry 2; results report one failure and one success.
5. The duplicate pre-check fetches entries **once** for the batch, not once per entry.
6. Writes happen sequentially — assert the second POST starts only after the first resolves.
7. A missing `X-Clockify-Key` → 401.
8. An invalid `host` → 400, no writes.

- [ ] **Step 2: Run and watch fail** → `npx vitest run test/routes-apply.test.ts`

- [ ] **Step 3: Implement `src/routes/apply.ts` and mount at `/api/apply`**

- [ ] **Step 4: Run the tests** → Expected: PASS (8 tests). Then `npm run ci`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add apply route with pre-write duplicate re-check"
```

---

### Task 13: UI shell, client build pipeline and security headers

**Files:**

- Create: `scripts/build-client.mjs`, `public/index.html`, `public/style.css`, `public/_headers`, `client/app.ts` (stub)
- Test: manual (`npm run dev`)

**Interfaces:**

- Consumes: nothing yet — Task 14 fills in the logic.
- Produces: a built `public/app.js`, and a page that loads it.

- [ ] **Step 1: Write `scripts/build-client.mjs`**

```js
import { build } from 'esbuild';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Workers Assets serves public/ verbatim and asset routes shadow Worker routes.
// A file under public/api/ would silently shadow the API, so fail the build.
function assertNoApiDir(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'api') throw new Error(`public/api/ would shadow the Worker API: ${full}`);
      assertNoApiDir(full);
    }
  }
}

await build({
  entryPoints: ['client/app.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'public/app.js',
  // No sourcemap: public/ is served unauthenticated, and a map would publish
  // the full client source.
  sourcemap: false,
  minify: true,
});

assertNoApiDir('public');
console.log('client bundled -> public/app.js');
```

- [ ] **Step 2: Write `public/_headers`**

The keys live in `localStorage`, so a single XSS is total credential compromise. A strict CSP with no inline script and no CDN is what makes that storage decision defensible. (Limits: 100 rules, 2000 chars per line.)

```
/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
```

**No inline `<script>`, no inline `style` attribute that would need `unsafe-inline`, no CDN, no analytics, no web fonts.** All CSS goes in `style.css`, all JS in `app.js`.

- [ ] **Step 3: Write `public/index.html`**

A single page with four `<section>` steps, each `hidden` until reachable:

1. **Connect** — two `<input type="password">` fields (GitHub PAT, Clockify key), a "Remember on this device" checkbox, a Clockify region `<select>` (`api` default, plus the four regional hosts and an optional subdomain field), and a **Verify** button. On success shows the GitHub login and the Clockify user, and warns in-line if the chosen workspace is on the Free plan.
2. **Scope** — start/end date inputs with presets (This month / Last month / Custom), source checkboxes (Commits / Pull requests / Issues / Reviews), an account `<select>` (Personal + each org), and a searchable repo list with select-all. Carries the note: _"Only commits on each repository's default branch are counted."_
3. **Mapping** — workspace `<select>`, project `<select>`, hours per day (default 8), start time (default 09:00), timezone (defaulting to `Intl.DateTimeFormat().resolvedOptions().timeZone`), billable and include-weekends checkboxes.
4. **Preview & Import** — a progress bar for the scan, then a table of days (date, weekday, activity count, repos, description, status) with a checkbox per row, duplicates pre-unchecked and visually marked, a totals line, and an **Import N entries** button leading to a per-entry result list.

Mark up the table with real `<table>`/`<th scope>` and give every input a `<label for>` — this is a form-heavy tool and it should be keyboard- and screen-reader-usable.

- [ ] **Step 4: Write `public/style.css`**

A single stylesheet, system font stack, CSS custom properties for colour, and a `prefers-color-scheme: dark` block. No framework.

- [ ] **Step 5: Stub `client/app.ts`**

```ts
console.info('gh2clockify ready');
```

- [ ] **Step 6: Verify the page serves and the API still routes**

```bash
npm run build:client
npm run dev
```

Then in a browser at `http://localhost:8787`: the page renders, the console logs `gh2clockify ready`, and there are **no CSP violations** in the console. And confirm the API is not shadowed:

```bash
curl -s http://localhost:8787/api/health          # -> {"ok":true}
curl -s -I http://localhost:8787/api/health | grep -i cache-control   # -> no-store
curl -s -I http://localhost:8787/ | grep -i content-security-policy   # -> the CSP line
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add UI shell, client build pipeline and CSP headers"
```

---

### Task 14: UI wizard logic

**Files:**

- Create: `client/state.ts`, `client/api.ts`, `client/render.ts`
- Modify: `client/app.ts`
- Test: manual, per the checklist below

**Interfaces:**

- Consumes: the shared pure modules (`src/types.ts`, `src/timezone.ts`, `src/describe.ts`, `src/aggregate.ts`, `src/plan.ts`) and the HTTP surface.
- Produces: the working tool.

**`client/state.ts`** holds a single mutable state object and a `subscribe(fn)` notifier. Credentials are kept in memory and mirrored to `localStorage` **only** when "Remember on this device" is checked, under keys `gh2clockify.github` / `gh2clockify.clockify`. Non-secret preferences — last workspace, project, hours, start time, timezone, sources, repo selection, region — always persist under `gh2clockify.prefs`. A **Forget keys** button clears both credential keys and wipes the in-memory copies.

**`client/api.ts`** wraps `fetch` with the two credential headers and maps a non-2xx body into a thrown `{code, message}`. It gives each error code a human sentence — `upstream_saml_required` becomes _"Your GitHub token isn't authorized for that organization. Authorize it for SSO in your token settings."_, `rate_limited` becomes _"Too many requests — waiting a moment."_, and a Clockify 429 on a Free workspace becomes _"Clockify's free plan allows 30 requests per hour for the whole workspace. Try again later, or narrow the range."_

**Orchestration** — the part that makes the design work:

```ts
// Scan: chunk repos for commits, chunk months for search, accumulate client-side.
const REPO_CHUNK = 8; // matches the /api/scan/commits server cap
const activities: Activity[] = [];

for (const chunk of chunksOf(selectedRepos, REPO_CHUNK)) {
  if (cancelled) break;
  const res = await api.post('/api/scan/commits', { repos: chunk, login, sinceIso, untilIso });
  activities.push(...res.activities);
  warnings.push(...res.warnings);
  progress.advance();
}

for (const source of selectedSearchSources) {
  for (const window of monthWindows(startKey, endKey)) {
    // <=31 days each
    if (cancelled) break;
    const res = await api.post('/api/scan/search', {
      source,
      ...window,
      login,
      scope,
      repos: selectedRepos,
      offsetLabel: utcOffsetLabel(window.startKey, tz),
    });
    activities.push(...res.activities);
    if (res.incomplete)
      warnings.push('GitHub returned partial search results — try a narrower range.');
    progress.advance();
    await sleep(2000); // search is 30 req/min; pace it
  }
}
```

Then, entirely in the browser: `aggregate(activities, settings)` → fetch existing entries via `GET /api/clockify/entries` → `buildPlan(...)` → render the table. No large POST body ever crosses the wire, and the plan is recomputed instantly when the user changes hours-per-day or the weekend toggle.

**Import** posts checked entries in batches of 5, appending results as each batch returns, with a live "12 of 30 imported" counter and a **Stop** button that stops after the in-flight batch. The final summary lists created, skipped-as-duplicate and failed entries, with the error text for each failure.

- [ ] **Step 1: Implement `client/state.ts` and `client/api.ts`**
- [ ] **Step 2: Implement `client/render.ts`** — pure `state → DOM` functions, no fetching.
- [ ] **Step 3: Implement the orchestration in `client/app.ts`**
- [ ] **Step 4: Run `npm run typecheck`** — this is what proves the shared modules stay browser-safe, since `tsconfig.client.json` gives them no Workers types.

- [ ] **Step 5: Manual verification against real accounts**

With `npm run dev` and your own keys, confirm each of these:

1. Entering only a GitHub key and clicking Verify reports the Clockify key as missing — not a generic failure.
2. A deliberately wrong Clockify key reports _"Clockify rejected the request"_, and the GitHub side still verifies.
3. "Remember on this device" unchecked → reload → the fields are empty. Checked → reload → they are populated. **Forget keys** empties them.
4. Selecting an org lists its repos; selecting Personal lists your own plus collaborator repos.
5. A scan of 10+ repos advances the progress bar in steps and does not hang.
6. **Preview against a month you have already imported shows every day as a duplicate**, pre-unchecked, with the existing entry's description visible. This is the single most important manual check — it is the safety property the Python lacks.
7. Change hours-per-day from 8 to 6 → the table's start/end times and totals update with no new network requests.
8. Import one entry into a scratch project, then re-run the preview → that day now shows as a duplicate.
9. Import with one entry deliberately made invalid (e.g. point at an archived project) → that row reports its error and the others still succeed.
10. In DevTools, confirm no request URL contains a token, and that every `/api/*` response carries `Cache-Control: no-store`.
11. Set the timezone to `Pacific/Auckland` and confirm a late-evening commit moves to the expected local day.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: implement the four-step import wizard"
```

---

### Task 15: README, deploy and end-to-end verification

**Files:**

- Create: `README.md`, `docs/superpowers/plans/2026-08-31-gh2clockify.md` (this plan)
- Test: a real import against a scratch Clockify project

- [ ] **Step 1: Write `README.md`**

Cover: what it does; that it stores nothing and how to verify that (no storage bindings in `wrangler.jsonc`); how to get a GitHub PAT (`repo` scope for private repos, and the SSO authorization step for org repos) and a Clockify key; the Clockify region selector and when it is needed; **the default-branch-only limitation**; **the Clockify Free-plan 30-requests-per-hour cap**; local development; and deployment.

- [ ] **Step 2: Create the rate-limit namespaces and deploy**

The `namespace_id` values in `wrangler.jsonc` are arbitrary but must be unique within the account; no `wrangler` command is needed to create them.

```bash
npm run ci
npm run deploy
```

- [ ] **Step 3: Verify the deployed Worker**

```bash
BASE=https://gh2clockify.<your-subdomain>.workers.dev
curl -s $BASE/api/health                                   # -> {"ok":true}
curl -s -I $BASE/ | grep -i content-security-policy        # -> CSP present
curl -s -I $BASE/api/health | grep -i cache-control        # -> no-store
curl -s -I $BASE/api/health | grep -i access-control       # -> no output
curl -s -H "Origin: https://evil.example.com" -H "X-Clockify-Key: $CK" \
  $BASE/api/clockify/context                               # -> 403 cross_origin
curl -s $BASE/api/scan/commits -X POST -d '{}'             # -> 401 missing_credentials
```

- [ ] **Step 4: End-to-end import**

In the deployed UI, against a **scratch Clockify project**: import a single past week, verify in Clockify that the entries exist with the right local times and descriptions, then re-run the same preview and confirm every day is now flagged as a duplicate and pre-unchecked.

- [ ] **Step 5: Commit and tag**

```bash
git add -A
git commit -m "docs: add README and deployment notes"
git tag v0.1.0
```

---

## Verification summary

| Layer       | How                                                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure logic  | `npx vitest run --project pure` — timezone (DST both directions, half-hour zones), descriptions (code-point safety, truncation), aggregation (dedup, weekends, local-day bucketing), duplicate diff (the ±1 day boundary case). No network, no Workers runtime. |
| Routes      | `npx vitest run --project worker` — guards, validation-before-fetch, chunk caps, and the apply route's skip-on-duplicate behaviour.                                                                                                                             |
| Integration | `npm run dev` plus the `curl` calls in Tasks 10 and 15 against real GitHub and Clockify accounts.                                                                                                                                                               |
| End-to-end  | The Task 14 manual checklist, then the Task 15 scratch-project import — with the re-run-shows-duplicates check as the gate on shipping.                                                                                                                         |
| Security    | Task 15's `curl` set: CSP present, `no-store` everywhere, no CORS headers, foreign `Origin` rejected, credentials required.                                                                                                                                     |

## Open risks

1. **Clockify Free plan, 30 requests/hour, workspace-wide.** A first-time Free user can exhaust their budget in one session. Mitigated by caching context client-side, `page-size=5000`, and a prominent warning — but not solved. If it proves painful in practice, the next step is a client-side request counter that blocks the import button with an estimate before starting.
2. **Default-branch-only commits.** An explicit product decision, surfaced in the UI. If it turns out to miss too much real work, the follow-up is adding the head branches of PRs authored in the range, which are already fetched by the PR source.
3. **Rate-limit binding counters are per-colo and eventually consistent.** Cloudflare documents them as permissive rather than exact, so a distributed attacker gets more headroom than the configured number suggests. Adequate against casual scripted abuse; if the Worker attracts real attention, Turnstile on the scan and apply routes is the escalation.
4. **GitHub's `advanced_search` default is due to flip.** The code pins `advanced_search=true`, which is correct in both worlds, but the query dialect should be re-verified after the flip lands.
