import { randomUUID } from 'node:crypto';

import { KalshiClient, KalshiPaginationBudgetError, KalshiPaginationCursorError } from '../api/kalshi-client.js';
import { PolymarketClient, PolymarketPaginationBudgetError } from '../api/polymarket-client.js';
import { normalizeKalshiBatch, normalizePolymarketBatch } from '../api/normalizer.js';
import { getEnv } from '../lib/env.js';
import { selectSnapshotCandidates } from '../lib/snapshot-policy.js';
import { getCheckpoint, upsertCheckpoint, clearCheckpoint } from '../db/checkpoints.js';
import { failOpenRuns, startRun, completeRun, updateRunProgress } from '../db/ingestion-log.js';
import { reconcileMissingOpenMarkets, upsertMarkets } from '../db/markets.js';
import { writeSnapshots } from '../db/snapshots.js';
import { updateSourceHealth } from '../db/source-health.js';
import type { IngestionRunRecord } from '../types/storage.js';

const FULL_SYNC_CHECKPOINT_KEY = 'kalshi_full_sync';

export async function runFullSync(): Promise<IngestionRunRecord> {
  const jobId = randomUUID();
  const startedAt = new Date();
  const env = getEnv();
  const checkpoint = await getCheckpoint(FULL_SYNC_CHECKPOINT_KEY);
  const snapshotTime = checkpoint?.snapshot_time ? new Date(checkpoint.snapshot_time) : startedAt;
  const kalshiSnapshotCandidates: Parameters<typeof writeSnapshots>[0] = [];
  const polymarketSnapshotCandidates: Parameters<typeof writeSnapshots>[0] = [];

  await failOpenRuns('full_sync', 'Superseded by a newer full_sync run before completion.');

  await startRun({
    job_id: jobId,
    run_type: 'full_sync',
    started_at: startedAt.toISOString(),
    status: 'running',
  });

  const result: IngestionRunRecord = {
    job_id: jobId,
    run_type: 'full_sync',
    started_at: startedAt.toISOString(),
    completed_at: null,
    duration_ms: null,
    kalshi_markets_fetched: 0,
    kalshi_markets_new: 0,
    kalshi_snapshots_written: 0,
    kalshi_errors: 0,
    kalshi_available: true,
    kalshi_fetch_ms: null,
    polymarket_markets_fetched: 0,
    polymarket_markets_new: 0,
    polymarket_snapshots_written: 0,
    polymarket_errors: 0,
    polymarket_available: false,
    polymarket_fetch_ms: null,
    resolutions_detected: 0,
    errors: [],
    status: 'running',
    notes: null,
  };

  const kalshiClient = new KalshiClient({ baseUrl: env.kalshiBaseUrl });
  const polymarketClient = new PolymarketClient({ baseUrl: env.polymarketBaseUrl });

  // ── Kalshi: resolve page budget before kicking off parallel syncs ──────────
  let pageIndex = checkpoint?.page_count ?? 0;
  let nextCursor = checkpoint?.cursor ?? '';
  result.kalshi_markets_fetched = checkpoint?.market_count ?? 0;

  const remainingAbsolutePages = Math.max(0, env.fullSyncAbsoluteMaxPages - pageIndex);
  const runPageBudget = Math.min(env.fullSyncPageBudget, remainingAbsolutePages);

  if (runPageBudget <= 0) {
    const err = new KalshiPaginationBudgetError(
      `Kalshi crawl reached the configured absolute page cap of ${env.fullSyncAbsoluteMaxPages}`
    );
    result.kalshi_available = true;
    result.status = result.kalshi_markets_fetched > 0 ? 'partial' : 'failed';
    result.errors.push({
      source: 'kalshi',
      error_type: 'page_budget_exhausted',
      error_message: err.message,
    });
    result.kalshi_errors += 1;
    result.notes = `Full sync paused after ${result.kalshi_markets_fetched} markets. Resume checkpoint retained.`;
    result.completed_at = new Date().toISOString();
    result.duration_ms = new Date(result.completed_at).getTime() - startedAt.getTime();
    await completeRun(result);
    return result;
  }

  // Track whether Kalshi completed a full crawl (cursor reached end)
  // Used to gate reconciliation and checkpoint clearing.
  let kalshiCompletedFullCrawl = false;

  // ── Run Kalshi and Polymarket syncs in parallel ───────────────────────────
  const [kalshiSyncOutcome, polymarketSyncOutcome] = await Promise.allSettled([
    // Kalshi sync
    (async () => {
      for await (const page of kalshiClient.iterateMarkets({
        cursor: nextCursor,
        limit: env.fullSyncPageSize,
        status: 'open',
        maxPages: runPageBudget,
      })) {
        pageIndex += 1;
        const fetchedAt = new Date();
        result.kalshi_fetch_ms = (result.kalshi_fetch_ms ?? 0) + page.fetch_ms;
        result.kalshi_markets_fetched += page.markets.length;

        const normalizedBatch = normalizeKalshiBatch(page.markets, fetchedAt);
        result.kalshi_errors += normalizedBatch.errors.length;

        for (const error of normalizedBatch.errors) {
          result.errors.push({
            source: 'kalshi',
            error_type: 'normalize_failed',
            error_message: error.error,
            market_id: error.platform_id,
          });
        }

        const upsertResult = await upsertMarkets(normalizedBatch.normalized);
        result.kalshi_markets_new += upsertResult.kalshi_new;

        const pageSnapshotCandidates = selectSnapshotCandidates(
          normalizedBatch.normalized.map(({ market }) => market),
          fetchedAt,
          {
            limit: Math.max(0, env.snapshotCandidateLimit - kalshiSnapshotCandidates.length),
            activeWindowHours: env.snapshotActiveWindowHours,
            minVolume24h: env.snapshotMinVolume24h,
            minLiquidity: env.snapshotMinLiquidity,
          }
        );
        kalshiSnapshotCandidates.push(...pageSnapshotCandidates);

        nextCursor = page.cursor;

        await upsertCheckpoint({
          checkpoint_key: FULL_SYNC_CHECKPOINT_KEY,
          run_type: 'full_sync',
          cursor: nextCursor === '' ? null : nextCursor,
          page_count: pageIndex,
          market_count: result.kalshi_markets_fetched,
          snapshot_time: snapshotTime.toISOString(),
          job_id: jobId,
        });

        if (pageIndex % env.fullSyncProgressEveryPages === 0 || nextCursor === '') {
          result.notes = formatProgressNote({
            resumed: checkpoint !== null,
            pageIndex,
            marketCount: result.kalshi_markets_fetched,
            snapshotsWritten: result.kalshi_snapshots_written,
            snapshotCandidates: kalshiSnapshotCandidates.length,
            nextCursor,
          });
          await updateRunProgress(jobId, {
            kalshi_markets_fetched: result.kalshi_markets_fetched,
            kalshi_markets_new: result.kalshi_markets_new,
            kalshi_snapshots_written: result.kalshi_snapshots_written,
            kalshi_errors: result.kalshi_errors,
            kalshi_fetch_ms: result.kalshi_fetch_ms,
            errors: result.errors,
            status: 'running',
            notes: result.notes,
          });
        }
      }

      // nextCursor === '' means the full cursor chain was exhausted
      kalshiCompletedFullCrawl = nextCursor === '';
    })(),

    // Polymarket sync
    (async () => {
      const polyPageBudget = Math.min(env.polymarketSyncPageBudget, env.polymarketSyncAbsoluteMaxPages);

      for await (const page of polymarketClient.iterateMarkets({
        limit: env.polymarketSyncPageSize,
        maxPages: polyPageBudget,
      })) {
        const fetchedAt = new Date();
        result.polymarket_fetch_ms = (result.polymarket_fetch_ms ?? 0) + page.fetch_ms;
        result.polymarket_markets_fetched += page.markets.length;

        const normalizedBatch = normalizePolymarketBatch(page.markets, fetchedAt);
        result.polymarket_errors += normalizedBatch.errors.length;

        for (const error of normalizedBatch.errors) {
          result.errors.push({
            source: 'polymarket',
            error_type: 'normalize_failed',
            error_message: error.error,
            market_id: error.platform_id,
          });
        }

        const upsertResult = await upsertMarkets(normalizedBatch.normalized);
        result.polymarket_markets_new += upsertResult.polymarket_new;

        // Issue 7: collect Polymarket snapshot candidates
        const pageSnapshotCandidates = selectSnapshotCandidates(
          normalizedBatch.normalized.map(({ market }) => market),
          fetchedAt,
          {
            limit: Math.max(0, env.snapshotCandidateLimit - polymarketSnapshotCandidates.length),
            activeWindowHours: env.snapshotActiveWindowHours,
            minVolume24h: env.snapshotMinVolume24h,
            minLiquidity: env.snapshotMinLiquidity,
          }
        );
        polymarketSnapshotCandidates.push(...pageSnapshotCandidates);
      }

      result.polymarket_available = true;
    })(),
  ]);

  // ── Handle Kalshi outcome ─────────────────────────────────────────────────

  if (kalshiSyncOutcome.status === 'fulfilled') {
    // Issue 7: write Kalshi snapshots
    const kalshiSnapshotResult = await writeSnapshots(kalshiSnapshotCandidates, snapshotTime, {
      source: 'kalshi_api_v2',
      fetchLatencyMs: result.kalshi_fetch_ms,
    });
    result.kalshi_snapshots_written += kalshiSnapshotResult.kalshi_written;

    await updateSourceHealth({
      source: 'kalshi',
      is_available: true,
      market_count: result.kalshi_markets_fetched,
      last_successful_fetch: new Date().toISOString(),
      last_error: null,
      last_error_at: null,
    });

    // Issue 2 + 3: only reconcile and clear checkpoint after a complete crawl
    if (kalshiCompletedFullCrawl) {
      await reconcileMissingOpenMarkets('kalshi', startedAt.toISOString());
      await clearCheckpoint(FULL_SYNC_CHECKPOINT_KEY);
    }
  } else {
    const error = kalshiSyncOutcome.reason;
    const errorType = classifyFullSyncError(error);
    result.kalshi_available = errorType !== 'source_unavailable';
    result.errors.push({
      source: 'kalshi',
      error_type: errorType,
      error_message: error instanceof Error ? error.message : String(error),
    });
    result.kalshi_errors += 1;

    await updateSourceHealth({
      source: 'kalshi',
      is_available: result.kalshi_available,
      market_count: result.kalshi_markets_fetched,
      last_error: !result.kalshi_available ? (error instanceof Error ? error.message : String(error)) : null,
      last_error_at: !result.kalshi_available ? new Date().toISOString() : null,
      last_successful_fetch: result.kalshi_available ? new Date().toISOString() : null,
    });
    // Checkpoint retained — do not clear on partial/failed Kalshi sync
  }

  // ── Handle Polymarket outcome ─────────────────────────────────────────────

  if (polymarketSyncOutcome.status === 'fulfilled') {
    // Issue 7: write Polymarket snapshots
    if (polymarketSnapshotCandidates.length > 0) {
      const polySnapshotResult = await writeSnapshots(polymarketSnapshotCandidates, snapshotTime, {
        source: 'polymarket_gamma_api',
        fetchLatencyMs: result.polymarket_fetch_ms,
      });
      result.polymarket_snapshots_written += polySnapshotResult.kalshi_written;
    }

    // Issue 6: update Polymarket source health on success
    await updateSourceHealth({
      source: 'polymarket',
      is_available: true,
      market_count: result.polymarket_markets_fetched,
      last_successful_fetch: new Date().toISOString(),
      last_error: null,
      last_error_at: null,
    });

    // Issue 5: skip reconciliation for Polymarket — no checkpoint semantics yet,
    // so bounded-window fetches would incorrectly mark older markets as closed.
  } else {
    const error = polymarketSyncOutcome.reason;

    // Issue 4: classify budget exhaustion separately from real outages
    const isPageBudget = error instanceof PolymarketPaginationBudgetError;
    const errorType = isPageBudget ? 'page_budget_exhausted' : 'source_unavailable';

    result.polymarket_available = !isPageBudget;
    result.errors.push({
      source: 'polymarket',
      error_type: errorType,
      error_message: error instanceof Error ? error.message : String(error),
    });
    result.polymarket_errors += 1;

    // Issue 6: update Polymarket source health on failure
    await updateSourceHealth({
      source: 'polymarket',
      is_available: result.polymarket_available,
      market_count: result.polymarket_markets_fetched,
      last_error: !result.polymarket_available ? (error instanceof Error ? error.message : String(error)) : null,
      last_error_at: !result.polymarket_available ? new Date().toISOString() : null,
      last_successful_fetch: result.polymarket_available ? new Date().toISOString() : null,
    });
  }

  result.status = result.errors.length > 0 ? 'partial' : 'success';
  result.notes = `Processed ${result.kalshi_markets_fetched} Kalshi and ${result.polymarket_markets_fetched} Polymarket markets. Kalshi full crawl: ${kalshiCompletedFullCrawl}.`;

  result.completed_at = new Date().toISOString();
  result.duration_ms = new Date(result.completed_at).getTime() - startedAt.getTime();

  await completeRun(result);
  return result;
}

function classifyFullSyncError(error: unknown): string {
  if (error instanceof KalshiPaginationBudgetError) {
    return 'page_budget_exhausted';
  }

  if (error instanceof KalshiPaginationCursorError) {
    return 'cursor_loop_detected';
  }

  return 'source_unavailable';
}

function formatProgressNote(input: {
  resumed: boolean;
  pageIndex: number;
  marketCount: number;
  snapshotsWritten: number;
  snapshotCandidates: number;
  nextCursor: string;
}): string {
  const prefix = input.resumed ? 'Resuming full sync' : 'Running full sync';
  const cursorState = input.nextCursor === '' ? 'complete' : 'checkpoint saved';

  return `${prefix}: page ${input.pageIndex}, markets ${input.marketCount}, snapshot candidates ${input.snapshotCandidates}, snapshots ${input.snapshotsWritten}, ${cursorState}.`;
}
