import { createClient } from '@supabase/supabase-js';

import { checkSupabaseDirectHost } from '../src/lib/preflight.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
}

// ---------------------------------------------------------------------------
// Preflight: direct-host DNS check
// If SUPABASE_DB_HOST is set and looks like a Supabase direct-connection host,
// verify that it resolves over IPv4.  This catches the common misconfiguration
// where Supabase migrated a project to an IPv6-only endpoint but the deployment
// is IPv4-only, causing silent connect timeouts for scripts that use postgres
// directly (compact-inactive-markets, apply-migration, show-storage-summary …).
// ---------------------------------------------------------------------------

const dbHost = process.env.SUPABASE_DB_HOST;

if (dbHost) {
  const preflight = await checkSupabaseDirectHost(dbHost);

  if (!preflight.ok) {
    console.error('');
    console.error(`[preflight] WARNING: ${preflight.warning}`);
    if (preflight.fix) {
      console.error('');
      console.error('[preflight] How to fix:');
      console.error(preflight.fix);
      console.error('');
    }
    // Non-fatal: REST API may still work even if direct Postgres is broken.
    // We surface the warning but continue so the caller learns the full picture.
  }
}

// ---------------------------------------------------------------------------
// REST API check
// ---------------------------------------------------------------------------

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const { data, error } = await supabase.from('source_health').select('source').limit(1);

if (error) {
  console.error(JSON.stringify({ ok: false, message: error.message, code: error.code }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, rows: data?.length ?? 0, db_host_checked: dbHost ?? null }, null, 2));
