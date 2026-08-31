/**
 * Read-only GitHub discovery routes the browser UI uses to populate its
 * account/org/repo pickers. Requires only `X-GitHub-Token` — never
 * `X-Clockify-Key` — so the UI can validate the two credentials
 * independently and tell the user which one is wrong.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index';
import { requireGithub } from '../credentials';
import { AppError } from '../problems';
import { isOwner } from '../validate';
import { getViewer, listOrgs, getRateBudget, listRepos } from '../github';
import type { RepoScope } from '../github';

export const githubRoutes = new Hono<{ Bindings: Env }>();

/**
 * `GET /rate_limit` does not count against any GitHub rate limit, so
 * surfacing it here is free information worth showing before a scan.
 */
githubRoutes.get('/context', async (c) => {
  const token = requireGithub(c);
  const [viewer, orgs, rateLimit] = await Promise.all([
    getViewer(token),
    listOrgs(token),
    getRateBudget(token),
  ]);
  return c.json({ viewer, orgs, rateLimit });
});

/**
 * Validated before any upstream call: `scope` must be `personal` or `org`,
 * and `org` is required and must pass `isOwner` when `scope=org`. This is
 * what stops a path-traversal-shaped `org` (or a missing one) from ever
 * reaching `fetch`.
 */
function resolveRepoScope(c: Context): RepoScope {
  const scope = c.req.query('scope');
  if (scope === 'personal') return { kind: 'personal' };
  if (scope === 'org') {
    const org = c.req.query('org');
    if (!org || !isOwner(org)) {
      throw new AppError(
        400,
        'invalid_request',
        'org query parameter is required and must be a valid GitHub login when scope=org',
      );
    }
    return { kind: 'org', org };
  }
  throw new AppError(400, 'invalid_request', "scope query parameter must be 'personal' or 'org'");
}

githubRoutes.get('/repos', async (c) => {
  const token = requireGithub(c);
  const scope = resolveRepoScope(c);
  const repos = await listRepos(token, scope);
  return c.json({ repos });
});

export default githubRoutes;
