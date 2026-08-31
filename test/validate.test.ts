import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  isClockifyHost,
  isClockifyId,
  isClockifySubdomain,
  isDateKey,
  isHhMm,
  isOwner,
  isRepoFullName,
  isRepoName,
  segment,
} from '../src/validate';

describe('isOwner', () => {
  it('accepts a normal GitHub login', () => {
    expect(isOwner('octocat')).toBe(true);
  });

  it('accepts a single character', () => {
    expect(isOwner('a')).toBe(true);
  });

  it('accepts hyphens in the middle', () => {
    expect(isOwner('my-org-2')).toBe(true);
  });

  it('accepts the maximum 39-character length', () => {
    expect(isOwner('a'.repeat(39))).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isOwner('')).toBe(false);
  });

  it('rejects a leading hyphen', () => {
    expect(isOwner('-octocat')).toBe(false);
  });

  it('rejects more than 39 characters', () => {
    expect(isOwner('a'.repeat(40))).toBe(false);
  });

  it('rejects a path-traversal owner', () => {
    expect(isOwner('../../user')).toBe(false);
  });

  it('rejects whitespace', () => {
    expect(isOwner('my org')).toBe(false);
  });
});

describe('isRepoName', () => {
  it('accepts dots, underscores and hyphens', () => {
    expect(isRepoName('my-repo.name_v2')).toBe(true);
  });

  it('accepts a single character', () => {
    expect(isRepoName('a')).toBe(true);
  });

  it('accepts the maximum 100-character length', () => {
    expect(isRepoName('a'.repeat(100))).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isRepoName('')).toBe(false);
  });

  it('rejects a slash', () => {
    expect(isRepoName('owner/repo')).toBe(false);
  });

  it('rejects more than 100 characters', () => {
    expect(isRepoName('a'.repeat(101))).toBe(false);
  });
});

describe('isRepoFullName', () => {
  it('accepts owner/name', () => {
    expect(isRepoFullName('octocat/Hello-World')).toBe(true);
  });

  it('rejects a value with no slash', () => {
    expect(isRepoFullName('octocat')).toBe(false);
  });

  it('rejects a value with more than one slash', () => {
    expect(isRepoFullName('octocat/a/b')).toBe(false);
  });

  it('rejects an invalid owner half', () => {
    expect(isRepoFullName('-octocat/repo')).toBe(false);
  });

  it('rejects an invalid name half', () => {
    expect(isRepoFullName('octocat/')).toBe(false);
  });

  it('rejects a path-traversal attempt', () => {
    expect(isRepoFullName('../../user/repo')).toBe(false);
  });
});

describe('isClockifyId', () => {
  it('accepts a 24-char lowercase hex id', () => {
    expect(isClockifyId('5f9d88b9c9e77c001a1b2c3d')).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isClockifyId('5F9D88B9C9E77C001A1B2C3D')).toBe(true);
  });

  it('rejects a short id', () => {
    expect(isClockifyId('5f9d88b9c9e77c001a1b2c3')).toBe(false);
  });

  it('rejects a long id', () => {
    expect(isClockifyId('5f9d88b9c9e77c001a1b2c3d0')).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isClockifyId('zzzz88b9c9e77c001a1b2c3')).toBe(false);
  });
});

describe('isDateKey', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(isDateKey('2026-08-31')).toBe(true);
  });

  it('rejects a single-digit month', () => {
    expect(isDateKey('2026-8-31')).toBe(false);
  });

  it('rejects a value with no separators', () => {
    expect(isDateKey('20260831')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isDateKey('not-a-date')).toBe(false);
  });
});

describe('isHhMm', () => {
  it('accepts 00:00', () => {
    expect(isHhMm('00:00')).toBe(true);
  });

  it('accepts 23:59', () => {
    expect(isHhMm('23:59')).toBe(true);
  });

  it('accepts a mid-range time', () => {
    expect(isHhMm('09:30')).toBe(true);
  });

  it('rejects hour 24', () => {
    expect(isHhMm('24:00')).toBe(false);
  });

  it('rejects a missing leading zero', () => {
    expect(isHhMm('9:30')).toBe(false);
  });

  it('rejects minute 60', () => {
    expect(isHhMm('12:60')).toBe(false);
  });
});

describe('isClockifyHost', () => {
  it('accepts each known host', () => {
    for (const host of ['api', 'euc1', 'use2', 'euw2', 'apse2']) {
      expect(isClockifyHost(host)).toBe(true);
    }
  });

  it('rejects an unknown host', () => {
    expect(isClockifyHost('eu-west-9')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isClockifyHost('')).toBe(false);
  });
});

describe('isClockifySubdomain', () => {
  it('accepts a simple subdomain', () => {
    expect(isClockifySubdomain('myworkspace')).toBe(true);
  });

  it('accepts digits and hyphens', () => {
    expect(isClockifySubdomain('my-workspace-2')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isClockifySubdomain('')).toBe(false);
  });

  it('rejects uppercase letters', () => {
    expect(isClockifySubdomain('MyWorkspace')).toBe(false);
  });

  it('rejects more than 40 characters', () => {
    expect(isClockifySubdomain('a'.repeat(41))).toBe(false);
  });
});

describe('segment', () => {
  it('percent-encodes a slash so it cannot escape a path segment', () => {
    expect(segment('../../user')).toBe('..%2F..%2Fuser');
  });

  it('leaves an ordinary value effectively unchanged', () => {
    expect(segment('octocat')).toBe('octocat');
  });

  it('throws on an empty value', () => {
    expect(() => segment('')).toThrow();
  });
});

describe('daysBetween', () => {
  it('counts whole days apart', () => {
    expect(daysBetween('2026-01-01', '2026-01-03')).toBe(2);
  });

  it('returns 0 for the same day', () => {
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('returns a negative number when end precedes start', () => {
    expect(daysBetween('2026-01-03', '2026-01-01')).toBe(-2);
  });

  it('spans a month boundary', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1);
  });
});
