/**
 * Builds the per-day Clockify description from a day's GitHub activity, and
 * sanitizes it to Clockify's server constraints.
 *
 * Pure, dependency-free, and bundled into both the Worker and the browser
 * client — only a type-only import of `Activity` is allowed here.
 */
import type { Activity } from './types';

export const CLOCKIFY_MAX_DESCRIPTION = 3000;

/**
 * Short label for a repo in a description: alias keyed by full name
 * (`owner/repo`) first, then by bare name, then a mechanical fallback.
 */
export function repoAlias(repoFullName: string, aliases: Record<string, string>): string {
  const byFullName = aliases[repoFullName];
  if (byFullName) return byFullName;

  const bareName = repoFullName.split('/').pop() ?? repoFullName;
  const byBareName = aliases[bareName];
  if (byBareName) return byBareName;

  return bareName.toUpperCase().replaceAll('-', '_');
}

const ISSUE_REF = /#(\d+)/g;
/** Anchored at the title start; case-insensitive; original casing captured. */
const TYPE_PREFIX = /^\((fix|feat)\)/i;

/**
 * A title as it appears inside the description: without the leading
 * `(fix)`/`(feat)` marker and without `#N` references, because both are
 * already emitted once per repo block. Collapses the whitespace left behind.
 * Returns '' when nothing but markers remained (e.g. a title of "#12").
 */
export function cleanTitle(title: string): string {
  return title.replace(TYPE_PREFIX, '').replace(ISSUE_REF, '').replace(/\s+/g, ' ').trim();
}

/** Every `#123` reference in `title`, deduped and ascending. */
export function issueNumbersIn(title: string): number[] {
  const numbers = new Set<number>();
  for (const match of title.matchAll(ISSUE_REF)) numbers.add(Number(match[1]));
  return [...numbers].sort((a, b) => a - b);
}

/**
 * `<ALIAS> [ISSUE #a #b] [(fix) (feat)] title1, title2   |   <ALIAS2> ...`
 *
 * Titles are cleaned: the leading type marker and every `#N` are removed
 * (they are already in the segments) and whitespace is collapsed. Repo
 * blocks are joined with `' | '` in the order repos first appear in
 * `activities`. Within a block: issue numbers are deduped and sorted
 * numerically; types are deduped and sorted; cleaned titles are deduped but
 * keep chronological order (by `timestamp`).
 */
export function describeDay(activities: Activity[], aliases: Record<string, string>): string {
  const repoOrder: string[] = [];
  const byRepo = new Map<string, Activity[]>();

  for (const activity of activities) {
    let bucket = byRepo.get(activity.repo);
    if (!bucket) {
      bucket = [];
      byRepo.set(activity.repo, bucket);
      repoOrder.push(activity.repo);
    }
    bucket.push(activity);
  }

  const blocks = repoOrder.map((repo) => {
    const items = [...(byRepo.get(repo) ?? [])].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );

    const issueNumbers = new Set<number>();
    const types = new Set<string>();
    const seenTitles = new Set<string>();
    const titles: string[] = [];

    for (const item of items) {
      for (const n of issueNumbersIn(item.title)) issueNumbers.add(n);

      const typeMatch = TYPE_PREFIX.exec(item.title);
      if (typeMatch?.[1]) types.add(typeMatch[1]);

      const cleaned = cleanTitle(item.title);
      if (cleaned !== '' && !seenTitles.has(cleaned)) {
        seenTitles.add(cleaned);
        titles.push(cleaned);
      }
    }

    const parts = [repoAlias(repo, aliases)];

    if (issueNumbers.size > 0) {
      const sorted = [...issueNumbers].sort((a, b) => a - b);
      parts.push(`ISSUE ${sorted.map((n) => `#${n}`).join(' ')}`);
    }

    if (types.size > 0) {
      parts.push(
        [...types]
          .sort()
          .map((t) => `(${t})`)
          .join(' '),
      );
    }

    if (titles.length > 0) parts.push(titles.join(', '));

    return parts.join(' ');
  });

  return blocks.join(' | ');
}

const TRUNCATION_MARKER = ' | ...(truncated)';
/** C0 controls except tab; they survive JSON but confuse the Clockify UI. */
// eslint-disable-next-line no-control-regex -- intentional: stripping C0 control bytes.
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Enforce Clockify's real server constraints: no `<`/`>`, no C0 control
 * characters, and a 3000-Unicode-code-point description limit.
 */
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
