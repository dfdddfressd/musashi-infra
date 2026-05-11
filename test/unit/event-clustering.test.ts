import { describe, expect, it } from 'vitest';

import { clusterMarkets, selectPrimaryMarket } from '../../src/lib/event-clustering.js';
import type { MusashiMarket } from '../../src/types/market.js';

// ---------------------------------------------------------------------------
// Test factory
// ---------------------------------------------------------------------------

let _seq = 0;

function buildMarket(overrides: Partial<MusashiMarket> = {}): MusashiMarket {
  _seq++;
  return {
    id: `musashi-kalshi-m${_seq}`,
    platform: 'kalshi',
    platform_id: `M${_seq}`,
    event_id: null,
    series_id: null,
    title: `Market ${_seq}`,
    description: null,
    category: 'other',
    url: `https://kalshi.com/markets/m${_seq}`,
    yes_price: 0.5,
    no_price: 0.5,
    volume_24h: 0,
    open_interest: null,
    liquidity: null,
    spread: null,
    status: 'open',
    created_at: '2026-04-10T00:00:00Z',
    closes_at: '2026-05-01T00:00:00Z',
    settles_at: null,
    resolved: false,
    resolution: null,
    resolved_at: null,
    fetched_at: '2026-04-10T00:00:00Z',
    cache_hit: false,
    data_age_seconds: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// clusterMarkets
// ---------------------------------------------------------------------------

describe('clusterMarkets', () => {
  it('returns an empty array for an empty input', () => {
    expect(clusterMarkets([])).toEqual([]);
  });

  it('groups markets that share the same event_id', () => {
    const m1 = buildMarket({ event_id: 'FED-SEP' });
    const m2 = buildMarket({ event_id: 'FED-SEP' });
    const m3 = buildMarket({ event_id: 'FED-SEP' });

    const clusters = clusterMarkets([m1, m2, m3]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.cluster_id).toBe('FED-SEP');
    expect(clusters[0]?.source).toBe('event_id');
    expect(clusters[0]?.markets).toHaveLength(3);
  });

  it('does not merge markets with different event_ids', () => {
    const m1 = buildMarket({ event_id: 'FED-SEP' });
    const m2 = buildMarket({ event_id: 'FED-NOV' });

    const clusters = clusterMarkets([m1, m2]);

    expect(clusters).toHaveLength(2);
    const ids = clusters.map((c) => c.cluster_id).sort();
    expect(ids).toEqual(['FED-NOV', 'FED-SEP']);
  });

  it('creates a singleton cluster for a market with null event_id', () => {
    const m = buildMarket({ event_id: null });

    const clusters = clusterMarkets([m]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.source).toBe('singleton');
    expect(clusters[0]?.cluster_id).toBe(`singleton:${m.id}`);
    expect(clusters[0]?.markets).toHaveLength(1);
  });

  it('creates a singleton cluster for a market with blank event_id', () => {
    const m = buildMarket({ event_id: '   ' });

    const clusters = clusterMarkets([m]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.source).toBe('singleton');
  });

  it('creates a singleton cluster for a market with empty string event_id', () => {
    const m = buildMarket({ event_id: '' });

    const clusters = clusterMarkets([m]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.source).toBe('singleton');
  });

  it('does not merge different singletons together', () => {
    const m1 = buildMarket({ event_id: null });
    const m2 = buildMarket({ event_id: null });

    const clusters = clusterMarkets([m1, m2]);

    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.source === 'singleton')).toBe(true);
    expect(clusters.every((c) => c.markets.length === 1)).toBe(true);
  });

  it('handles mixed: some with event_id, some without', () => {
    const grouped1 = buildMarket({ event_id: 'ELECTION' });
    const grouped2 = buildMarket({ event_id: 'ELECTION' });
    const solo1 = buildMarket({ event_id: null });
    const solo2 = buildMarket({ event_id: '' });

    const clusters = clusterMarkets([grouped1, grouped2, solo1, solo2]);

    expect(clusters).toHaveLength(3); // 1 event_id cluster + 2 singletons
    const eventCluster = clusters.find((c) => c.source === 'event_id');
    expect(eventCluster?.markets).toHaveLength(2);
    const singletonClusters = clusters.filter((c) => c.source === 'singleton');
    expect(singletonClusters).toHaveLength(2);
  });

  it('preserves all markets within a cluster', () => {
    const markets = [
      buildMarket({ event_id: 'GDP-Q1' }),
      buildMarket({ event_id: 'GDP-Q1' }),
      buildMarket({ event_id: 'GDP-Q1' }),
    ];

    const clusters = clusterMarkets(markets);
    const cluster = clusters[0];

    expect(cluster?.markets.map((m) => m.id).sort()).toEqual(markets.map((m) => m.id).sort());
  });
});

// ---------------------------------------------------------------------------
// clusterMarkets — series_id fallback
// ---------------------------------------------------------------------------

describe('clusterMarkets (series_id fallback)', () => {
  it('groups markets by series_id when event_id is null', () => {
    const m1 = buildMarket({ event_id: null, series_id: 'FED-SERIES' });
    const m2 = buildMarket({ event_id: null, series_id: 'FED-SERIES' });

    const clusters = clusterMarkets([m1, m2]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.source).toBe('series_id');
    expect(clusters[0]?.cluster_id).toBe('series:FED-SERIES');
    expect(clusters[0]?.markets).toHaveLength(2);
  });

  it('groups markets by series_id when event_id is blank', () => {
    const m1 = buildMarket({ event_id: '', series_id: 'RATE-SERIES' });
    const m2 = buildMarket({ event_id: '  ', series_id: 'RATE-SERIES' });

    const clusters = clusterMarkets([m1, m2]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.source).toBe('series_id');
  });

  it('does not merge markets with different series_ids', () => {
    const m1 = buildMarket({ event_id: null, series_id: 'SERIES-A' });
    const m2 = buildMarket({ event_id: null, series_id: 'SERIES-B' });

    const clusters = clusterMarkets([m1, m2]);

    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.source === 'series_id')).toBe(true);
  });

  it('does not merge event_id markets with series_id markets even if series_id matches', () => {
    const withEvent = buildMarket({ event_id: 'REAL-EVENT', series_id: 'SHARED-SERIES' });
    const withSeries = buildMarket({ event_id: null, series_id: 'SHARED-SERIES' });

    const clusters = clusterMarkets([withEvent, withSeries]);

    expect(clusters).toHaveLength(2);
    const eventCluster = clusters.find((c) => c.source === 'event_id');
    const seriesCluster = clusters.find((c) => c.source === 'series_id');
    expect(eventCluster?.markets).toHaveLength(1);
    expect(seriesCluster?.markets).toHaveLength(1);
  });

  it('falls back to singleton when both event_id and series_id are null', () => {
    const m = buildMarket({ event_id: null, series_id: null });

    const clusters = clusterMarkets([m]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.source).toBe('singleton');
  });

  it('falls back to singleton when series_id is blank', () => {
    const m = buildMarket({ event_id: null, series_id: '   ' });

    const clusters = clusterMarkets([m]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.source).toBe('singleton');
  });

  it('handles all three tiers in one call', () => {
    const byEvent1 = buildMarket({ event_id: 'EVT-1', series_id: null });
    const byEvent2 = buildMarket({ event_id: 'EVT-1', series_id: null });
    const bySeries1 = buildMarket({ event_id: null, series_id: 'SER-X' });
    const bySeries2 = buildMarket({ event_id: null, series_id: 'SER-X' });
    const solo = buildMarket({ event_id: null, series_id: null });

    const clusters = clusterMarkets([byEvent1, byEvent2, bySeries1, bySeries2, solo]);

    expect(clusters).toHaveLength(3);
    expect(clusters.filter((c) => c.source === 'event_id')).toHaveLength(1);
    expect(clusters.filter((c) => c.source === 'series_id')).toHaveLength(1);
    expect(clusters.filter((c) => c.source === 'singleton')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// selectPrimaryMarket
// ---------------------------------------------------------------------------

describe('selectPrimaryMarket', () => {
  it('throws when given an empty array', () => {
    expect(() => selectPrimaryMarket([])).toThrow();
  });

  it('returns the sole market when only one is present', () => {
    const m = buildMarket({ liquidity: 500 });
    expect(selectPrimaryMarket([m])).toBe(m);
  });

  it('picks the market with the highest liquidity', () => {
    const low = buildMarket({ liquidity: 100 });
    const high = buildMarket({ liquidity: 50_000 });
    const mid = buildMarket({ liquidity: 1_000 });

    expect(selectPrimaryMarket([low, high, mid])).toBe(high);
  });

  it('ranks null liquidity after real values', () => {
    const withLiq = buildMarket({ liquidity: 1 });
    const nullLiq = buildMarket({ liquidity: null });

    expect(selectPrimaryMarket([nullLiq, withLiq])).toBe(withLiq);
  });

  it('falls back to highest open_interest when liquidity is tied', () => {
    const highOI = buildMarket({ liquidity: 5_000, open_interest: 8_000 });
    const lowOI = buildMarket({ liquidity: 5_000, open_interest: 1_000 });

    expect(selectPrimaryMarket([lowOI, highOI])).toBe(highOI);
  });

  it('falls back to highest volume_24h when liquidity and open_interest are tied', () => {
    const highVol = buildMarket({ liquidity: null, open_interest: null, volume_24h: 500 });
    const lowVol = buildMarket({ liquidity: null, open_interest: null, volume_24h: 10 });

    expect(selectPrimaryMarket([lowVol, highVol])).toBe(highVol);
  });

  it('falls back to earliest closes_at when all financial metrics are tied', () => {
    const sooner = buildMarket({
      liquidity: null,
      open_interest: null,
      volume_24h: 0,
      closes_at: '2026-06-01T00:00:00Z',
    });
    const later = buildMarket({
      liquidity: null,
      open_interest: null,
      volume_24h: 0,
      closes_at: '2026-12-01T00:00:00Z',
    });

    expect(selectPrimaryMarket([later, sooner])).toBe(sooner);
  });

  it('ranks null closes_at after real dates', () => {
    const withClose = buildMarket({
      liquidity: null,
      open_interest: null,
      volume_24h: 0,
      closes_at: '2026-06-01T00:00:00Z',
    });
    const nullClose = buildMarket({ liquidity: null, open_interest: null, volume_24h: 0, closes_at: null });

    expect(selectPrimaryMarket([nullClose, withClose])).toBe(withClose);
  });

  it('uses lexicographic id as final stable tiebreaker', () => {
    const a = buildMarket({
      id: 'musashi-kalshi-aaa',
      liquidity: null,
      open_interest: null,
      volume_24h: 0,
      closes_at: null,
    });
    const b = buildMarket({
      id: 'musashi-kalshi-bbb',
      liquidity: null,
      open_interest: null,
      volume_24h: 0,
      closes_at: null,
    });

    // 'aaa' < 'bbb' so a should win
    expect(selectPrimaryMarket([b, a])).toBe(a);
  });

  it('is deterministic — same input always returns the same market', () => {
    const markets = [buildMarket({ liquidity: 200 }), buildMarket({ liquidity: 200 }), buildMarket({ liquidity: 200 })];

    const first = selectPrimaryMarket(markets);
    const second = selectPrimaryMarket([...markets].reverse());
    expect(first.id).toBe(second.id);
  });

  it('picks liquidity 0 over null liquidity (zero is a known value, null is unknown)', () => {
    const zeroLiq = buildMarket({ liquidity: 0, open_interest: null, volume_24h: 0 });
    const nullLiq = buildMarket({ liquidity: null, open_interest: null, volume_24h: 0 });

    expect(selectPrimaryMarket([nullLiq, zeroLiq])).toBe(zeroLiq);
  });

  it('is stable across arbitrary input orderings (10 shuffles)', () => {
    const markets = Array.from({ length: 8 }, (_, i) =>
      buildMarket({ id: `musashi-kalshi-stable-${i}`, liquidity: null, volume_24h: 0, closes_at: null })
    );
    const expected = selectPrimaryMarket(markets).id;

    for (let i = 0; i < 10; i++) {
      const shuffled = [...markets].sort(() => Math.random() - 0.5);
      expect(selectPrimaryMarket(shuffled).id).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// clusterMarkets — adversarial / noisy inputs
// ---------------------------------------------------------------------------

describe('clusterMarkets (adversarial)', () => {
  it('treats a tab-only event_id as blank and creates a singleton', () => {
    const m = buildMarket({ event_id: '\t' });
    const clusters = clusterMarkets([m]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.source).toBe('singleton');
  });

  it('treats mixed-whitespace event_id as blank and creates a singleton', () => {
    const m = buildMarket({ event_id: ' \t \n ' });
    const clusters = clusterMarkets([m]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.source).toBe('singleton');
  });

  it('is case-sensitive: FED-SEP and fed-sep form separate clusters', () => {
    const upper = buildMarket({ event_id: 'FED-SEP' });
    const lower = buildMarket({ event_id: 'fed-sep' });
    const clusters = clusterMarkets([upper, lower]);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.source === 'event_id')).toBe(true);
    expect(clusters.every((c) => c.markets.length === 1)).toBe(true);
  });

  it('does not merge a whitespace-padded event_id with the trimmed version', () => {
    // The raw string is used as the map key, so " FED-SEP " and "FED-SEP" are different clusters.
    const padded = buildMarket({ event_id: ' FED-SEP ' });
    const clean = buildMarket({ event_id: 'FED-SEP' });
    const clusters = clusterMarkets([padded, clean]);
    expect(clusters).toHaveLength(2);
  });

  it('handles a large cluster (50 markets, same event_id) without dropping any', () => {
    const markets = Array.from({ length: 50 }, () => buildMarket({ event_id: 'BIG-EVENT' }));
    const clusters = clusterMarkets(markets);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.markets).toHaveLength(50);
  });

  it('does not merge an event_id cluster with a series_id cluster sharing the same raw value', () => {
    // A market with event_id 'SHARED' and a market with series_id 'SHARED' (no event_id).
    // They must end up in separate clusters.
    const byEvent = buildMarket({ event_id: 'SHARED', series_id: null });
    const bySeries = buildMarket({ event_id: null, series_id: 'SHARED' });
    const clusters = clusterMarkets([byEvent, bySeries]);
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c.source === 'event_id')?.cluster_id).toBe('SHARED');
    expect(clusters.find((c) => c.source === 'series_id')?.cluster_id).toBe('series:SHARED');
  });
});
