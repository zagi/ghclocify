import { describe, expect, it } from 'vitest';
import { describeDay, issueNumbersIn, repoAlias, sanitizeDescription } from '../src/describe';
import type { Activity } from '../src/types';

let nextId = 0;

function act(overrides: Partial<Activity> = {}): Activity {
  nextId += 1;
  return {
    kind: 'commit',
    id: `sha-${nextId}`,
    repo: 'acme/demo-project',
    timestamp: '2026-08-03T09:00:00Z',
    title: 'do a thing',
    url: 'https://github.com/acme/demo-project/commit/abc',
    ...overrides,
  };
}

describe('describeDay', () => {
  it('builds a repo block with alias, issues and types', () => {
    const activities: Activity[] = [
      act({
        repo: 'acme/dp',
        title: '(fix) resolve login redirect #185',
        timestamp: '2026-08-03T09:00:00Z',
      }),
      act({ repo: 'acme/dp', title: 'bump deps #9', timestamp: '2026-08-03T10:00:00Z' }),
    ];
    expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe(
      'DP ISSUE #9 #185 (fix) (fix) resolve login redirect #185, bump deps #9',
    );
  });

  it('sorts issue numbers numerically, not lexicographically', () => {
    const activities: Activity[] = [
      act({ repo: 'acme/dp', title: 'work on #10', timestamp: '2026-08-03T09:00:00Z' }),
      act({ repo: 'acme/dp', title: 'work on #9', timestamp: '2026-08-03T10:00:00Z' }),
      act({ repo: 'acme/dp', title: 'work on #185', timestamp: '2026-08-03T11:00:00Z' }),
    ];
    expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe(
      'DP ISSUE #9 #10 #185 work on #10, work on #9, work on #185',
    );
  });

  it('keeps titles in chronological order, not alphabetical or input order', () => {
    // Input array order is apple-then-zebra; timestamps say the reverse.
    const activities: Activity[] = [
      act({ repo: 'acme/dp', title: 'apple work', timestamp: '2026-08-03T10:00:00Z' }),
      act({ repo: 'acme/dp', title: 'zebra work', timestamp: '2026-08-03T09:00:00Z' }),
    ];
    expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe('DP zebra work, apple work');
  });

  it('joins multiple repo blocks with " | " in first-appearance order', () => {
    const activities: Activity[] = [
      act({ repo: 'acme/beta', title: 'beta work', timestamp: '2026-08-03T09:00:00Z' }),
      act({ repo: 'acme/alpha', title: 'alpha work', timestamp: '2026-08-03T10:00:00Z' }),
    ];
    expect(describeDay(activities, { 'acme/beta': 'BETA', 'acme/alpha': 'ALPHA' })).toBe(
      'BETA beta work | ALPHA alpha work',
    );
  });

  it('dedupes identical titles within a repo', () => {
    const activities: Activity[] = [
      act({ repo: 'acme/dp', title: 'same title', timestamp: '2026-08-03T09:00:00Z' }),
      act({ repo: 'acme/dp', title: 'same title', timestamp: '2026-08-03T10:00:00Z' }),
    ];
    expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe('DP same title');
  });

  it('omits ISSUE and type segments when neither is present', () => {
    const activities: Activity[] = [act({ repo: 'acme/dp', title: 'plain work no markers' })];
    expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe('DP plain work no markers');
  });

  it('pins the sort order of multiple distinct type markers', () => {
    // Insertion order is fix-then-feat; alphabetical order is feat-then-fix.
    // If the `.sort()` in describeDay were deleted or replaced with
    // insertion order, the types segment would read "(fix) (feat)" instead.
    const activities: Activity[] = [
      act({
        repo: 'acme/dp',
        title: '(fix) resolve login redirect',
        timestamp: '2026-08-03T09:00:00Z',
      }),
      act({ repo: 'acme/dp', title: '(feat) add sso support', timestamp: '2026-08-03T10:00:00Z' }),
    ];
    expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe(
      'DP (feat) (fix) (fix) resolve login redirect, (feat) add sso support',
    );
  });

  it('does not dedupe type markers that differ only in case (mirrors the Python original, which added the raw matched substring to a set)', () => {
    const activities: Activity[] = [
      act({
        repo: 'acme/dp',
        title: '(fix) resolve login redirect',
        timestamp: '2026-08-03T09:00:00Z',
      }),
      act({ repo: 'acme/dp', title: '(Fix) bump deps', timestamp: '2026-08-03T10:00:00Z' }),
    ];
    expect(describeDay(activities, { 'acme/dp': 'DP' })).toBe(
      'DP (Fix) (fix) (fix) resolve login redirect, (Fix) bump deps',
    );
  });
});

describe('repoAlias', () => {
  it('falls back to the uppercased, underscored bare repo name', () => {
    expect(repoAlias('acme/my-cool-repo', {})).toBe('MY_COOL_REPO');
  });
});

describe('sanitizeDescription', () => {
  it('replaces < and > with (lt) and (gt)', () => {
    expect(sanitizeDescription('a < b > c')).toBe('a (lt) b (gt) c');
  });

  it('returns a short description untouched', () => {
    expect(sanitizeDescription('DP #1 fix')).toBe('DP #1 fix');
  });

  it('truncates on a block boundary, stays under 3000 and ends with the marker', () => {
    const block = 'a'.repeat(1000);
    const message = [block, block, block, block].join(' | ');
    const out = sanitizeDescription(message);
    expect(out).toBe([block, block].join(' | ') + ' | ...(truncated)');
    expect(Array.from(out).length).toBeLessThan(3000);
  });

  it('salvages a clean title prefix when the very first block already overflows', () => {
    const items = Array.from({ length: 400 }, (_, i) => `item${String(i).padStart(4, '0')}`);
    const block = items.join(', ');
    const out = sanitizeDescription(block);
    const marker = ' | ...(truncated)';

    expect(out.endsWith(marker)).toBe(true);
    expect(Array.from(out).length).toBeLessThan(3000);

    const prefix = out.slice(0, out.length - marker.length);
    // The kept prefix is a clean, unmodified prefix of the original block...
    expect(block.startsWith(prefix)).toBe(true);
    // ...cut exactly at a ", " boundary, not mid-word.
    expect(prefix.endsWith(',')).toBe(false);
    expect(block.slice(prefix.length, prefix.length + 2)).toBe(', ');
  });

  it('counts length after < and > replacement, not before', () => {
    // 1000 raw chars (under the limit), but 4000 chars once expanded.
    const message = '<'.repeat(1000);
    const out = sanitizeDescription(message);
    expect(out.endsWith(' | ...(truncated)')).toBe(true);
    expect(Array.from(out).length).toBeLessThan(3000);
  });

  it('is code-point safe with emoji-heavy input: no overcount, no lone surrogate', () => {
    const message = '🎉'.repeat(2000);
    const out = sanitizeDescription(message);
    const points = Array.from(out);

    expect(points.length).toBeLessThan(3000);
    expect(out).toBe(points.join(''));

    const strippedPairs = out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
    expect(/[\uD800-\uDFFF]/.test(strippedPairs)).toBe(false);
  });

  it('replaces control characters with spaces', () => {
    expect(sanitizeDescription('a\x01b\x1fc\x7fd')).toBe('a b c d');
  });
});

describe('issueNumbersIn', () => {
  it('returns every #N reference deduped and ascending', () => {
    expect(issueNumbersIn('fix #185 and #9, also #185 again')).toEqual([9, 185]);
  });

  it('returns an empty array when nothing is referenced', () => {
    expect(issueNumbersIn('bump deps')).toEqual([]);
    expect(issueNumbersIn('')).toEqual([]);
  });
});
