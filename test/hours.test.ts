import { describe, expect, it } from 'vitest';
import {
  estimateImport,
  formatDuration,
  freeTierHours,
  hoursToSeconds,
  splitSeconds,
} from '../src/hours';

describe('splitSeconds', () => {
  it('1. divides evenly when it can: 8h into 3 is 9600s each', () => {
    expect(splitSeconds(28_800, 3)).toEqual([9600, 9600, 9600]);
  });

  it('2. gives the remainder one second at a time to the earliest shares, summing exactly', () => {
    const shares = splitSeconds(28_800, 7);
    expect(shares).toHaveLength(7);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(28_800);
    // 28800 / 7 = 4114 remainder 2 -> first two get 4115.
    expect(shares).toEqual([4115, 4115, 4114, 4114, 4114, 4114, 4114]);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
  });

  it('3. a single share is the whole total', () => {
    expect(splitSeconds(28_800, 1)).toEqual([28_800]);
  });

  it('4. rejects a non-positive or non-integer count and a negative total', () => {
    expect(() => splitSeconds(3600, 0)).toThrow();
    expect(() => splitSeconds(3600, 1.5)).toThrow();
    expect(() => splitSeconds(-1, 2)).toThrow();
  });
});

describe('hoursToSeconds', () => {
  it('5. converts fractional hours to whole seconds', () => {
    expect(hoursToSeconds(8)).toBe(28_800);
    expect(hoursToSeconds(2.5)).toBe(9000);
    expect(hoursToSeconds(0.25)).toBe(900);
    // Rounds, never truncates: 1/3 h is 1200s exactly, 0.1h is 360s.
    expect(hoursToSeconds(1 / 3)).toBe(1200);
    expect(hoursToSeconds(0.1)).toBe(360);
  });
});

describe('estimateImport', () => {
  it('10. counts batches and seconds: 0.5 s per entry plus 2 s between batches', () => {
    expect(estimateImport(0, 10)).toEqual({ batches: 0, seconds: 0 });
    expect(estimateImport(3, 10)).toEqual({ batches: 1, seconds: 1.5 });
    expect(estimateImport(10, 10)).toEqual({ batches: 1, seconds: 5 });
    expect(estimateImport(40, 10)).toEqual({ batches: 4, seconds: 26 });
  });

  it('11. freeTierHours budgets 28 requests per hour for entries plus a getUser + a pre-check GET per batch', () => {
    expect(freeTierHours(3, 10)).toBe(1); // 1 batch: (3 + 1*2) / 28 = 5/28 -> 1
    expect(freeTierHours(27, 10)).toBe(2); // 3 batches: (27 + 3*2) / 28 = 33/28 -> 2
    expect(freeTierHours(40, 10)).toBe(2); // 4 batches: (40 + 4*2) / 28 = 48/28 -> 2
    expect(freeTierHours(0, 10)).toBe(0);
    expect(freeTierHours(24, 10)).toBe(2); // 3 batches: (24 + 3*2) / 28 = 30/28 -> 2
    expect(freeTierHours(26, 10)).toBe(2); // 3 batches: (26 + 3*2) / 28 = 32/28 -> 2
  });

  it('12. formatDuration renders seconds, minutes and hours compactly', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(1.5)).toBe('2 s');
    expect(formatDuration(26)).toBe('26 s');
    expect(formatDuration(80)).toBe('1 min 20 s');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(3720)).toBe('1 h 2 min');
  });
});
