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
