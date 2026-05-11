import dns from 'node:dns/promises';

/**
 * Pattern that matches Supabase direct-connection hosts.
 *
 * Examples:
 *   db.abcdefghijklmnop.supabase.co          (legacy direct host)
 *   aws-0-us-east-1.pooler.supabase.com       (session-mode pooler — fine)
 *
 * The direct host path (db.PROJECT.supabase.co) has a known DNS failure mode:
 * Supabase switched some projects to IPv6-only endpoints, which silently break
 * on IPv4-only hosts. The session-mode pooler (*.pooler.supabase.com) always
 * exposes an IPv4 address and is the correct alternative.
 */
const SUPABASE_DIRECT_HOST_RE = /^db\.[a-z0-9]+\.supabase\.co$/i;
const DIRECT_HOST_IPV4_MISSING_CODES = new Set(['ENODATA', 'ENOTFOUND']);

export interface PreflightResult {
  ok: boolean;
  warning?: string;
  fix?: string;
}

/**
 * Validate that a SUPABASE_DB_HOST value will resolve correctly.
 *
 * - If the host is not a Supabase direct-connection host, returns ok immediately.
 * - If it IS a direct-connection host, performs a DNS lookup and returns a
 *   clear warning (with a pooler fallback hint) on failure.
 *
 * This catches the common misconfiguration where `SUPABASE_DB_HOST` is set to
 * `db.PROJECT.supabase.co` but the host only has AAAA (IPv6) records and the
 * deployment environment is IPv4-only.
 */
export async function checkSupabaseDirectHost(host: string): Promise<PreflightResult> {
  if (!SUPABASE_DIRECT_HOST_RE.test(host)) {
    return { ok: true };
  }

  try {
    // Attempt an A-record lookup (IPv4).  If the host is IPv6-only this will
    // throw ENOTFOUND or ENODATA, giving us the signal we need.
    await dns.resolve4(host);
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (DIRECT_HOST_IPV4_MISSING_CODES.has(code)) {
      return {
        ok: false,
        warning:
          `SUPABASE_DB_HOST "${host}" has no IPv4 DNS answer (${code}).\n` +
          `This is a known issue with Supabase direct-connection hosts on IPv4-only environments.`,
        fix: buildSessionModePoolerFix(),
      };
    }

    return {
      ok: false,
      warning:
        `SUPABASE_DB_HOST "${host}" failed DNS lookup (${code}).\n` +
        `Check the hostname value and your network/DNS connectivity before switching hosts.`,
    };
  }
}

function buildSessionModePoolerFix(): string {
  // Direct host: db.PROJECT.supabase.co
  // Pooler host: aws-0-REGION.pooler.supabase.com  (region must be set manually)
  return (
    `Switch SUPABASE_DB_HOST to the session-mode pooler hostname.\n` +
    `  Find it in the Supabase dashboard under:\n` +
    `    Project Settings → Database → Connection string → Session mode\n` +
    `  It looks like: aws-0-<region>.pooler.supabase.com\n` +
    `  Also update SUPABASE_DB_PORT to 5432 (session mode) if it was 6543.`
  );
}
