# gh2clockify

Turn a stretch of your own GitHub activity — commits, pull requests, issues,
reviews — into Clockify time entries, without ever handing your credentials
to a third party. You pick a date range and a scope, preview exactly what
will be written (including what already exists, so re-running a range is
safe), and import. It replaces the monthly ritual of hand-editing a
timesheet with a two-minute browser task.

Each GitHub issue you touched on a day becomes its own entry (activities that
reference no issue share one "Other" entry), and the day's hours are split
evenly across them — or, if you untick that option, typed in per entry with
a running total before you import.

It is a public tool: anyone can use it with their own GitHub personal
access token and their own Clockify API key. There is no login, no account,
and nothing shared between users except the code.

## It stores nothing — here's how to check

Your GitHub token and Clockify key travel from your browser to this Worker
as request headers (`X-GitHub-Token`, `X-Clockify-Key`) on each API call,
and from the Worker straight through to GitHub's and Clockify's own APIs.
The Worker holds them in memory for the lifetime of that one request and
then they're gone. Nothing is written to a database, a cache, a cookie, or
a log line anywhere in the chain.

You don't have to take that on faith:

- **No storage bindings.** Open `wrangler.jsonc` — there is no
  `kv_namespaces`, `d1_databases`, or `r2_buckets` entry. A Cloudflare
  Worker can only persist data through one of those bindings; without them,
  there is physically nowhere on the server side to put a credential.
- **Credentials never touch the URL, the body, or a cookie.** They're
  read out of request headers in `src/credentials.ts` and never logged —
  `src/problems.ts`'s error handler explicitly never includes header
  values in its output, and nothing in the codebase calls `console.log`
  on a header object.
- **Every response is `Cache-Control: no-store`,** set unconditionally in
  `src/credentials.ts`'s request guard, so nothing downstream (a browser
  cache, a CDN, Cloudflare's own edge cache) is tempted to keep a copy of
  a response that might contain your data.
- The browser is the only thing that persists anything, and only if you
  check "Remember on this device" on the Connect screen — that's
  `localStorage`, under your control, clearable from your browser's
  settings at any time.

If you'd rather not trust a hosted instance at all, the whole point of a
stateless design is that running your own costs nothing but a `wrangler
deploy` — see [Deployment](#deployment) below.

## Getting your credentials

### GitHub personal access token

Create one at **Settings → Developer settings → Personal access tokens**.
Either token type works:

- **Fine-grained token:** grant read access to Contents, Issues, and Pull
  requests for the repositories you want to import from.
- **Classic token:** the `repo` scope covers everything the tool needs,
  including private repositories. If you only ever import from public
  repos, no scopes are required at all.

**If you're importing from an organization's repositories, there's a step
people miss.** Organizations that enforce SAML SSO require every token —
fine-grained or classic — to be explicitly authorized for that
organization before it can see anything owned by it. A token that works
fine for your personal repos will fail with a 403 the moment it touches an
SSO-enforced org, and it fails in a way that looks like a bug rather than
a permissions issue: GitHub returns 403 with no clear message pointing
you at the fix.

This tool catches that specific case and surfaces it as an
`upstream_saml_required` error telling you to authorize the token for
SSO. To do it yourself ahead of time: go to
**Settings → Developer settings → Personal access tokens**, find your
token, and click **"Configure SSO"** next to it, then authorize it for
the organization in question.

### Clockify API key

In Clockify, go to **Profile settings → API key**, and generate (or copy)
your key.

**Pick the right region.** Clockify runs on several region-specific
hosts — `api` (global), `euc1` (EU Central), `use2` (US East), `euw2` (EU
West), and `apse2` (Asia Pacific) — and your workspace lives on exactly
one of them. If you don't know which, `api` is the default and works for
most accounts. If your organization uses a **custom subdomain**
(`https://mycompany.clockify.me`), use the "Custom subdomain" field
instead of picking a region — and note that a key generated for a
subdomain workspace is scoped to that subdomain; a key from your default
`app.clockify.me` account won't authenticate against it, and vice versa.
The region isn't something the API can tell you in advance, so if
Clockify sign-in fails, this — the wrong region or subdomain, not a bad
key — is the first thing to check.

## Three honest limitations

**Only commits on each repository's default branch are counted.** GitHub's
commits endpoint, called without an explicit branch, returns commits
reachable from the default branch only. Work sitting on an unmerged
feature branch will not show up. If that branch is later squash-merged,
the merge commit is what gets counted, dated on the day of the merge —
not spread across the days the original work actually happened. Pull
requests, issues, and reviews aren't affected by this; only the commit
source is.

**Clockify's free-plan workspaces are capped at 30 API requests per hour,
workspace-wide** — shared across everyone in that workspace, not just
you. A large import (many repos, a long date range) can burn through that
budget in a single run, and this tool has no way to see anyone else's
concurrent usage against the same cap. The tool detects a free-plan
workspace from the API and shows a prominent warning before you import;
if it can't determine a workspace's plan at all (some legacy or
edge-case responses omit the field), it assumes free and warns anyway,
since that's the safer direction to be wrong in. If you're on a paid
Clockify plan (50 requests/sec), this doesn't apply to you.

**A day imported from a partial (cancelled) scan can never be corrected by
re-scanning.** Duplicate detection matches on (day, project): once a day has
a matching Clockify entry, every later scan sees that whole day — every
issue's entry on it — as already imported and skips it — even if the scan
that created it was cancelled early and only captured, say, one commit out
of five for that day. This is inherent to the dedup rule that keeps
re-running an import safe, not a defect, but it means a cancelled scan's
entries should be checked (and corrected directly in Clockify, if needed)
before you rely on a later full scan to fill in the rest. The same rule
means a day imported with one issue's entry cannot later gain a second
issue's entry by re-scanning; add it in Clockify by hand.

**A single day can hold at most 10 entries in one import.** The apply
route rejects a batch of more than 10 entries, and a day's entries are
never split across batches — so if a day's selected entries exceed that,
uncheck some rows on that day before importing.

## Local development

Requires Node ≥ 22.

```bash
npm install
npm run dev
```

This builds the client bundle and starts `wrangler dev`, serving the app
at `http://localhost:8787` against real GitHub and Clockify APIs (there's
no mock mode — you'll need a real token and key to exercise anything past
the Connect screen).

Other useful scripts:

```bash
npm run test        # vitest — pure-logic tests run in plain Node, route
                     # tests run in the Workers runtime
npm run typecheck    # tsc, once for the Worker and once for the client
npm run lint         # eslint
npm run format       # prettier --write
npm run ci           # typecheck && lint && format:check && test — the
                     # full gate, and what must pass before any commit
```

## Deployment

```bash
npm run deploy
```

This builds the client bundle with esbuild and publishes the Worker (plus
the static assets in `public/`) via `wrangler deploy`. You'll need a
Cloudflare account with the Workers Paid plan — the configured
`limits.cpu_ms` and the abuse-prevention rate limits below both assume it.

**Check the two `ratelimits` entries in `wrangler.jsonc` before your first
deploy.** Their `namespace_id` values (`"1001"`, `"1002"`) are arbitrary
numbers, not IDs issued by any Cloudflare API — there's no `wrangler`
command that creates or reserves them. The only requirement is that each
value is **unique within your Cloudflare account**: if you already use a
rate-limit binding with `namespace_id: "1001"` or `"1002"` elsewhere in
the same account, change one of these to a number you haven't used, or
the two bindings will share counters. Otherwise the checked-in values are
fine as-is.

## Architecture, briefly

The browser is the orchestrator. All aggregation logic — bucketing
activity into local calendar days, deduping, generating descriptions,
diffing against existing Clockify entries, grouping a day's activity by
referenced issue and splitting the hours across those groups — lives in
plain, dependency-free TypeScript under `src/` (`aggregate.ts`,
`describe.ts`, `timezone.ts`, `plan.ts`, `hours.ts`) that gets bundled
into _both_ the Worker and the client script in `public/app.js`. The
Worker itself never does anything long-running: it performs small,
bounded calls to GitHub or Clockify — one chunk of repos, one search
window, one batch of writes — and hands the result back, while the
browser holds the accumulating state, drives the progress bar, and can
retry or cancel any individual chunk. That split is what keeps every
Worker invocation short and stateless: there is no in-progress import
sitting on the server for a dropped connection to orphan.
