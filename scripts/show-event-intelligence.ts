/**
 * show-event-intelligence.ts
 *
 * Smoke-test the event layer against real DB data.
 *
 * Usage:
 *   npm run event:show                          # top 5 active events by liquidity
 *   npm run event:show -- --event-id FED-SEP    # one specific event_id
 *   npm run event:show -- --category fed_policy # active markets in a category
 *   npm run event:show -- --limit 10            # show more events
 */

import { createClient } from '@supabase/supabase-js';

import { clusterMarkets, selectPrimaryMarket } from '../src/lib/event-clustering.js';
import { buildEventIntelligence } from '../src/lib/event-intelligence.js';
import { buildHistoricalResolutionCounts } from '../src/lib/event-resolution-counts.js';
import { chunkArray } from '../src/lib/collections.js';
import { loadRuntimeEnv } from '../src/lib/runtime-env.js';
import type { MusashiMarket } from '../src/types/market.js';
import type { MarketSnapshot } from '../src/types/storage.js';

const MARKET_SELECT =
  'id,platform,platform_id,event_id,series_id,title,description,category,url,' +
  'yes_price,no_price,volume_24h,open_interest,liquidity,spread,status,' +
  'created_at,closes_at,settles_at,resolved,resolution,resolved_at,last_ingested_at';
const SNAPSHOT_SELECT =
  'market_id,snapshot_time,yes_price,no_price,volume_24h,open_interest,liquidity,spread,source,fetch_latency_ms,created_at';
const MARKET_PAGE_SIZE = 1000;
const DB_FILTER_CHUNK_SIZE = 200;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const filterEventId = getArg('--event-id');
const filterCategory = getArg('--category');
const parsedLimit = Number(getArg('--limit') ?? '5');
const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 5;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const env = await loadRuntimeEnv(new URL('../.env', import.meta.url));

if (!env['SUPABASE_URL'] || !env['SUPABASE_SERVICE_KEY']) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env');
}

const supabase = createClient(env['SUPABASE_URL'], env['SUPABASE_SERVICE_KEY'], {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Fetch markets
// ---------------------------------------------------------------------------

const marketRows = await fetchActiveMarketRows();

if (!marketRows || marketRows.length === 0) {
  console.log(JSON.stringify({ message: 'No active markets found for the given filters.' }, null, 2));
  process.exit(0);
}

// Map DB rows -> MusashiMarket by filling in API-only fields with neutral defaults.
const markets: MusashiMarket[] = (marketRows as unknown as Array<Record<string, unknown>>).map((row) => ({
  ...(row as Omit<MusashiMarket, 'fetched_at' | 'cache_hit' | 'data_age_seconds'>),
  fetched_at: (row['last_ingested_at'] as string) ?? new Date().toISOString(),
  cache_hit: false,
  data_age_seconds: 0,
}));
console.error(`Fetched ${markets.length} market(s) from DB`);

// ---------------------------------------------------------------------------
// Build event objects
// ---------------------------------------------------------------------------

const clusters = clusterMarkets(markets);
console.error(`Formed ${clusters.length} cluster(s)`);

// Sort clusters by primary market liquidity descending after fetching the full active selection.
const selectedClusters = clusters
  .map((cluster) => ({ cluster, primary: selectPrimaryMarket(cluster.markets) }))
  .sort((a, b) => {
    const la = a.primary.liquidity ?? -1;
    const lb = b.primary.liquidity ?? -1;
    return lb - la;
  })
  .slice(0, limit)
  .map(({ cluster }) => cluster);

// ---------------------------------------------------------------------------
// Fetch snapshots (last 8 days to cover 7d change calculation)
// ---------------------------------------------------------------------------

const selectedMarketIds = selectedClusters.flatMap((cluster) => cluster.markets.map((market) => market.id));
const since = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

const snapshots = await fetchSnapshots(selectedMarketIds, since);
console.error(`Fetched ${snapshots.length} snapshot(s) for ${selectedMarketIds.length} selected market(s)`);

const eventIds = selectedClusters
  .filter((cluster) => cluster.source === 'event_id')
  .map((cluster) => cluster.cluster_id);
const historicalMarkets = await fetchHistoricalMarkets(eventIds);
const historicalMarketIds = historicalMarkets.map((market) => market.id);
const resolvedMarketIds = await fetchResolvedMarketIds(historicalMarketIds);
const resolutionCountsByCluster = buildHistoricalResolutionCounts(
  selectedClusters,
  historicalMarkets,
  resolvedMarketIds
);

console.error(`${resolvedMarketIds.size} historical resolved market(s) across ${eventIds.length} event cluster(s)`);

const eventObjects = selectedClusters.map((cluster) => {
  const clusterResolutionCount = resolutionCountsByCluster.get(cluster.cluster_id) ?? 0;
  return buildEventIntelligence(cluster, snapshots, clusterResolutionCount);
});

// ---------------------------------------------------------------------------
// Quality metrics
// ---------------------------------------------------------------------------

const totalEvents = eventObjects.length;

function pct(count: number): number {
  if (totalEvents === 0) return 0;
  return Math.round((count / totalEvents) * 100) / 100;
}

const nonNull24h = eventObjects.filter((e) => e.probability_change_24h !== null).length;
const nonNull7d = eventObjects.filter((e) => e.probability_change_7d !== null).length;
const singletons = selectedClusters.filter((c) => c.source === 'singleton').length;
const totalRelated = eventObjects.reduce((sum, e) => sum + e.related_markets.length, 0);

const qualityMetrics = {
  total_events: totalEvents,
  pct_non_null_24h_change: pct(nonNull24h),
  pct_non_null_7d_change: pct(nonNull7d),
  pct_singleton_clusters: pct(singletons),
  avg_related_markets_per_event: totalEvents > 0 ? Math.round((totalRelated / totalEvents) * 10) / 10 : 0,
  raw: {
    non_null_24h: nonNull24h,
    non_null_7d: nonNull7d,
    singleton_clusters: singletons,
    total_related_markets: totalRelated,
  },
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log(JSON.stringify({ quality_metrics: qualityMetrics, events: eventObjects }, null, 2));

async function fetchActiveMarketRows(): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let from = 0;

  while (true) {
    // Select only columns that exist in the DB - fetched_at / cache_hit / data_age_seconds
    // are API-layer fields on MusashiMarket but are never stored.
    let query = supabase.from('markets').select(MARKET_SELECT).eq('is_active', true).order('id', { ascending: true });

    if (filterEventId !== undefined) {
      query = query.eq('event_id', filterEventId);
    } else if (filterCategory !== undefined) {
      query = query.eq('category', filterCategory);
    }

    const { data, error } = await query.range(from, from + MARKET_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to fetch markets: ${error.message}`);
    }

    rows.push(...((data ?? []) as unknown as Array<Record<string, unknown>>));

    if (!data || data.length < MARKET_PAGE_SIZE) {
      return rows;
    }

    from += MARKET_PAGE_SIZE;
  }
}

async function fetchSnapshots(marketIdsToFetch: string[], sinceIso: string): Promise<MarketSnapshot[]> {
  const snapshots: MarketSnapshot[] = [];

  for (const marketIdChunk of chunkArray(marketIdsToFetch, DB_FILTER_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('market_snapshots')
      .select(SNAPSHOT_SELECT)
      .in('market_id', marketIdChunk)
      .gte('snapshot_time', sinceIso)
      .order('snapshot_time', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch snapshots: ${error.message}`);
    }

    snapshots.push(...((data ?? []) as MarketSnapshot[]));
  }

  return snapshots;
}

async function fetchHistoricalMarkets(
  eventIdsToFetch: string[]
): Promise<Array<{ id: string; event_id: string | null }>> {
  const rows: Array<{ id: string; event_id: string | null }> = [];
  const uniqueEventIds = [...new Set(eventIdsToFetch)];

  for (const eventIdChunk of chunkArray(uniqueEventIds, DB_FILTER_CHUNK_SIZE)) {
    const { data, error } = await supabase.from('markets').select('id,event_id').in('event_id', eventIdChunk);

    if (error) {
      throw new Error(`Failed to fetch historical event markets: ${error.message}`);
    }

    rows.push(...((data ?? []) as Array<{ id: string; event_id: string | null }>));
  }

  return rows;
}

async function fetchResolvedMarketIds(marketIdsToFetch: string[]): Promise<Set<string>> {
  const resolvedMarketIds = new Set<string>();

  for (const marketIdChunk of chunkArray(marketIdsToFetch, DB_FILTER_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('market_resolutions')
      .select('market_id')
      .in('market_id', marketIdChunk);

    if (error) {
      throw new Error(`Failed to fetch resolutions: ${error.message}`);
    }

    for (const row of data ?? []) {
      resolvedMarketIds.add((row as { market_id: string }).market_id);
    }
  }

  return resolvedMarketIds;
}
