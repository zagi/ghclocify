import { describe, expect, it } from 'vitest';
import { batchByDay, hoursToSeconds, splitSeconds } from '../src/hours';

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

describe('batchByDay', () => {
  const item = (date: string, key: string) => ({ date, key });

  it('6. packs whole days into batches of at most max', () => {
    const items = [
      item('2026-08-03', 'a'),
      item('2026-08-03', 'b'),
      item('2026-08-04', 'c'),
      item('2026-08-04', 'd'),
      item('2026-08-05', 'e'),
    ];
    // Days 04 (2) and 05 (1) fit together under max 3; day 03 + day 04 would be 4.
    expect(batchByDay(items, 3)).toEqual([
      [item('2026-08-03', 'a'), item('2026-08-03', 'b')],
      [item('2026-08-04', 'c'), item('2026-08-04', 'd'), item('2026-08-05', 'e')],
    ]);
  });

  it('7. fills a batch up to exactly max when days fit', () => {
    const items = [
      item('2026-08-03', 'a'),
      item('2026-08-04', 'b'),
      item('2026-08-05', 'c'),
      item('2026-08-06', 'd'),
    ];
    expect(batchByDay(items, 3).map((b) => b.length)).toEqual([3, 1]);
  });

  it('8. a day larger than max is emitted alone, over the cap, never split', () => {
    const items = [
      item('2026-08-03', 'a'),
      item('2026-08-04', 'b'),
      item('2026-08-04', 'c'),
      item('2026-08-04', 'd'),
      item('2026-08-05', 'e'),
    ];
    expect(batchByDay(items, 2)).toEqual([
      [item('2026-08-03', 'a')],
      [item('2026-08-04', 'b'), item('2026-08-04', 'c'), item('2026-08-04', 'd')],
      [item('2026-08-05', 'e')],
    ]);
  });

  it('9. empty input yields no batches', () => {
    expect(batchByDay([], 5)).toEqual([]);
  });
});
