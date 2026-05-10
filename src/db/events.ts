import { chunkArray } from '../lib/collections.js';
import { buildHistoricalResolutionCounts } from '../lib/event-resolution-counts.js';
import { clusterMarkets } from '../lib/event-clustering.js';
import { buildEventIntelligence } from '../lib/event-intelligence.js';
import type { MarketCategory, MusashiMarket } from '../types/market.js';
import type { EventIntelligence } from '../types/event.js';
import type { MarketSnapshot } from '../types/storage.js';
import { getSupabase } from './supabase.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_BATCH_SIZE = 200;
const SNAPSHOT_LOOKBACK_DAYS = 8; // covers both 24h and 7d change windows
const TOP_EVENTS_MARKET_SCAN_LIMIT = 5_000;

const MARKET_COLUMNS =
  'id,platform,platform_id,event_id,series_id,title,description,category,url,' +
  'yes_price,no_price,volume_24h,open_interest,liquidity,spread,status,' +
  'created_at,closes_at,settles_at,resolved,resolution,resolved_at,last_ingested_at';

const SNAPSHOT_COLUMNS =
  'market_id,snapshot_time,yes_price,no_price,volume_24h,open_interest,liquidity,spread,source,fetch_latency_ms,created_at';

const MARKET_PAGE_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a single event by its Kalshi event_id and return one EventIntelligence
 * object covering all markets in that event. Returns null if no active markets
 * are found for the given event_id.
 */
export async function getEventIntelligenceById(eventId: string): Promise<EventIntelligence | null> {
  const markets = await fetchActiveMarkets({ eventId });
  if (markets.length === 0) return null;
  const events = await buildEvents(markets);
  return events[0] ?? null;
}

/**
 * List EventIntelligence objects for all active markets in a category,
 * sorted by primary market liquidity descending.
 */
export async function listEventIntelligenceByCategory(
  category: MarketCategory,
  limit = 20
): Promise<EventIntelligence[]> {
  const markets = await fetchActiveMarkets({ category });
  return buildEvents(markets, limit);
}

/**
 * List the top EventIntelligence objects across all active markets,
 * sorted by primary market liquidity descending.
 */
export async function listTopEventIntelligence(limit = 10): Promise<EventIntelligence[]> {
  const markets = await fetchActiveMarkets({ maxRows: TOP_EVENTS_MARKET_SCAN_LIMIT });
  return buildEvents(markets, limit);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface FetchMarketsOptions {
  eventId?: string;
  category?: MarketCategory;
  maxRows?: number;
}

async function fetchActiveMarkets(options: FetchMarketsOptions): Promise<MusashiMarket[]> {
  const supabase = getSupabase();
  const rows: Array<Record<string, unknown>> = [];
  let from = 0;

  while (true) {
    let query = supabase
      .from('markets')
      .select(MARKET_COLUMNS)
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, from + MARKET_PAGE_SIZE - 1);

    if (options.eventId !== undefined) {
      query = query.eq('event_id', options.eventId);
    }
    if (options.category !== undefined) {
      query = query.eq('category', options.category);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch markets: ${error.message}`);
    }

    rows.push(...((data ?? []) as unknown as Array<Record<string, unknown>>));

    if (options.maxRows !== undefined && rows.length >= options.maxRows) {
      return rows.slice(0, options.maxRows).map(
        (row): MusashiMarket => ({
          ...(row as Omit<MusashiMarket, 'fetched_at' | 'cache_hit' | 'data_age_seconds'>),
          fetched_at: (row['last_ingested_at'] as string | undefined) ?? new Date().toISOString(),
          cache_hit: false,
          data_age_seconds: 0,
        })
      );
    }

    if (!data || data.length < MARKET_PAGE_SIZE) break;
    from += MARKET_PAGE_SIZE;
  }

  // Map DB rows → MusashiMarket. fetched_at / cache_hit / data_age_seconds are
  // API-only fields that are never stored — fill them with neutral defaults.
  return rows.map(
    (row): MusashiMarket => ({
      ...(row as Omit<MusashiMarket, 'fetched_at' | 'cache_hit' | 'data_age_seconds'>),
      fetched_at: (row['last_ingested_at'] as string | undefined) ?? new Date().toISOString(),
      cache_hit: false,
      data_age_seconds: 0,
    })
  );
}

async function fetchSnapshots(marketIds: string[]): Promise<MarketSnapshot[]> {
  if (marketIds.length === 0) return [];

  const supabase = getSupabase();
  const since = new Date(Date.now() - SNAPSHOT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const snapshots: MarketSnapshot[] = [];

  for (const chunk of chunkArray(marketIds, DB_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('market_snapshots')
      .select(SNAPSHOT_COLUMNS)
      .in('market_id', chunk)
      .gte('snapshot_time', since)
      .order('snapshot_time', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch snapshots: ${error.message}`);
    }

    snapshots.push(...((data ?? []) as MarketSnapshot[]));
  }

  return snapshots;
}

async function fetchResolutionCountsByCluster(
  clusters: ReturnType<typeof clusterMarkets>
): Promise<Map<string, number>> {
  if (clusters.length === 0) return new Map();

  const supabase = getSupabase();

  // For event_id clusters: look up all historical markets with that event_id
  const eventIdClusters = clusters.filter((c) => c.source === 'event_id');
  const eventIds = eventIdClusters.map((c) => c.cluster_id);

  const historicalMarkets: Array<{ id: string; event_id: string | null }> = [];

  for (const chunk of chunkArray(eventIds, DB_BATCH_SIZE)) {
    if (chunk.length === 0) continue;
    const { data, error } = await supabase.from('markets').select('id,event_id').in('event_id', chunk);
    if (error) throw new Error(`Failed to fetch historical markets: ${error.message}`);
    historicalMarkets.push(...((data ?? []) as Array<{ id: string; event_id: string | null }>));
  }

  // For non-event_id clusters: use markets already in the cluster
  const nonEventIdMarketIds = clusters
    .filter((c) => c.source !== 'event_id')
    .flatMap((c) => c.markets.map((m) => m.id));

  const allMarketIds = [...historicalMarkets.map((m) => m.id), ...nonEventIdMarketIds];

  const resolvedIds = new Set<string>();

  for (const chunk of chunkArray([...new Set(allMarketIds)], DB_BATCH_SIZE)) {
    if (chunk.length === 0) continue;
    const { data, error } = await supabase.from('market_resolutions').select('market_id').in('market_id', chunk);
    if (error) throw new Error(`Failed to fetch resolutions: ${error.message}`);
    for (const row of data ?? []) {
      resolvedIds.add((row as { market_id: string }).market_id);
    }
  }

  return buildHistoricalResolutionCounts(clusters, historicalMarkets, resolvedIds);
}

async function buildEvents(markets: MusashiMarket[], limit?: number): Promise<EventIntelligence[]> {
  if (markets.length === 0) return [];

  const clusters = clusterMarkets(markets);

  // Sort clusters by primary market liquidity descending — done in memory to
  // avoid an unindexed ORDER BY on the markets table.
  const sorted = clusters
    .map((cluster) => {
      const bestLiquidity = Math.max(...cluster.markets.map((m) => m.liquidity ?? -1));
      return { cluster, bestLiquidity };
    })
    .sort((a, b) => b.bestLiquidity - a.bestLiquidity);

  const selected = limit !== undefined ? sorted.slice(0, limit) : sorted;
  const selectedClusters = selected.map((s) => s.cluster);

  const marketIds = selectedClusters.flatMap((c) => c.markets.map((m) => m.id));
  const [snapshots, resolutionCounts] = await Promise.all([
    fetchSnapshots(marketIds),
    fetchResolutionCountsByCluster(selectedClusters),
  ]);

  return selectedClusters.map((cluster) =>
    buildEventIntelligence(cluster, snapshots, resolutionCounts.get(cluster.cluster_id) ?? 0)
  );
}
