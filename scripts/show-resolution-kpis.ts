/**
 * show-resolution-kpis.ts
 *
 * Print the five key resolution health numbers in a compact table.
 * These are the first things to check when the resolution pipeline looks stuck.
 *
 * Usage:
 *   npm run status:resolution:kpis
 *
 * Numbers emitted:
 *   settlement_ready_unresolved   — unresolved markets whose settles_at (or closes_at) has passed
 *   closed_waiting_settlement     — closed inactive markets still waiting for their settles_at window
 *   missing_settles_at            — closed inactive markets with no settles_at recorded (backfill needed)
 *   source_missing_unresolved     — unresolved markets Kalshi can no longer find (stale 404s)
 *   resolutions_last_24h          — number of resolutions recorded by ingestion jobs in the last 24 hours
 */

import { createClient } from '@supabase/supabase-js';

import { readCountOrThrow, sumRecentResolutionsOrThrow } from '../src/lib/resolution-kpis.js';
import { loadRuntimeEnv } from '../src/lib/runtime-env.js';

const env = await loadRuntimeEnv(new URL('../.env', import.meta.url));

if (!env['SUPABASE_URL'] || !env['SUPABASE_SERVICE_KEY']) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env');
}

const supabase = createClient(env['SUPABASE_URL'], env['SUPABASE_SERVICE_KEY'], {
  auth: { persistSession: false, autoRefreshToken: false },
});

const nowIso = new Date().toISOString();
const since24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const [settlementReadyResult, closedWaitingResult, missingSettlesAtResult, sourceMissingResult, recentRunsResult] =
  await Promise.all([
    // Unresolved markets whose settlement window has opened (settles_at passed, or falls back to closes_at).
    supabase
      .from('markets')
      .select('id', { count: 'estimated', head: true })
      .eq('resolved', false)
      .or(`settles_at.lte.${nowIso},and(settles_at.is.null,closes_at.lte.${nowIso})`),

    // Closed inactive markets still inside their settles_at window — not yet ready to resolve.
    supabase
      .from('markets')
      .select('id', { count: 'estimated', head: true })
      .eq('platform', 'kalshi')
      .eq('resolved', false)
      .eq('status', 'closed')
      .eq('is_active', false)
      .gt('settles_at', nowIso),

    // Closed inactive markets missing settles_at — the backfill job should pick these up.
    supabase
      .from('markets')
      .select('id', { count: 'estimated', head: true })
      .eq('platform', 'kalshi')
      .eq('resolved', false)
      .eq('status', 'closed')
      .eq('is_active', false)
      .is('settles_at', null)
      .not('closes_at', 'is', null)
      .lte('closes_at', nowIso),

    // Unresolved markets that Kalshi can no longer find (source_missing_at set).
    supabase
      .from('markets')
      .select('id', { count: 'estimated', head: true })
      .eq('platform', 'kalshi')
      .eq('resolved', false)
      .not('source_missing_at', 'is', null),

    // Sum resolutions_detected across all runs started in the last 24 hours.
    supabase.from('ingestion_runs').select('resolutions_detected').gte('started_at', since24hIso),
  ]);

const resolutionsLast24h = sumRecentResolutionsOrThrow('resolutions_last_24h', recentRunsResult);

const kpis = {
  settlement_ready_unresolved: readCountOrThrow('settlement_ready_unresolved', settlementReadyResult),
  closed_waiting_settlement: readCountOrThrow('closed_waiting_settlement', closedWaitingResult),
  missing_settles_at: readCountOrThrow('missing_settles_at', missingSettlesAtResult),
  source_missing_unresolved: readCountOrThrow('source_missing_unresolved', sourceMissingResult),
  resolutions_last_24h: resolutionsLast24h,
  generated_at: nowIso,
};

// Human-readable table to stderr, JSON to stdout (so it can be piped)
const width = 38;
console.error('');
console.error('  Resolution KPIs');
console.error('  ' + '─'.repeat(width));
for (const [key, value] of Object.entries(kpis)) {
  if (key === 'generated_at') continue;
  const label = key.replace(/_/g, ' ');
  const dots = '.'.repeat(width - label.length - String(value).length);
  console.error(`  ${label}${dots}${value}`);
}
console.error('  ' + '─'.repeat(width));
console.error(`  as of ${nowIso}`);
console.error('');

console.log(JSON.stringify(kpis, null, 2));
