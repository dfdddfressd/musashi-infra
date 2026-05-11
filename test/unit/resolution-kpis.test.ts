import { describe, expect, it } from 'vitest';

import { readCountOrThrow, sumRecentResolutionsOrThrow } from '../../src/lib/resolution-kpis.js';

describe('readCountOrThrow', () => {
  it('returns the query count when there is no error', () => {
    expect(readCountOrThrow('settlement_ready_unresolved', { count: 12, error: null })).toBe(12);
  });

  it('throws when the query returns an error', () => {
    expect(() =>
      readCountOrThrow('settlement_ready_unresolved', {
        count: null,
        error: { message: 'missing column', code: '42703', details: '', hint: '' },
      })
    ).toThrow(/settlement_ready_unresolved query failed: missing column/);
  });

  it('throws when the query count is unexpectedly null', () => {
    expect(() => readCountOrThrow('settlement_ready_unresolved', { count: null, error: null })).toThrow(
      /returned a null count/
    );
  });
});

describe('sumRecentResolutionsOrThrow', () => {
  it('sums resolutions_detected across the returned rows', () => {
    expect(
      sumRecentResolutionsOrThrow('resolutions_last_24h', {
        data: [{ resolutions_detected: 2 }, { resolutions_detected: 3 }, { resolutions_detected: null }],
        error: null,
      })
    ).toBe(5);
  });

  it('throws when the recent runs query fails', () => {
    expect(() =>
      sumRecentResolutionsOrThrow('resolutions_last_24h', {
        data: null,
        error: { message: 'timeout', code: '57014', details: 'statement timeout', hint: '' },
      })
    ).toThrow(/resolutions_last_24h query failed: timeout/);
  });
});
