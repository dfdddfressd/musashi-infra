import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: {
    resolve4: vi.fn(),
  },
}));

import dns from 'node:dns/promises';

import { checkSupabaseDirectHost } from '../../src/lib/preflight.js';

const mockResolve4 = vi.mocked(dns.resolve4);

describe('checkSupabaseDirectHost', () => {
  beforeEach(() => {
    mockResolve4.mockReset();
  });

  it('skips DNS lookup for non-direct hosts', async () => {
    const result = await checkSupabaseDirectHost('aws-0-us-east-1.pooler.supabase.com');

    expect(result).toEqual({ ok: true });
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it('returns ok when the direct host resolves over IPv4', async () => {
    mockResolve4.mockResolvedValue(['127.0.0.1']);

    const result = await checkSupabaseDirectHost('db.projectref.supabase.co');

    expect(result).toEqual({ ok: true });
    expect(mockResolve4).toHaveBeenCalledWith('db.projectref.supabase.co');
  });

  it('returns pooler guidance when the direct host has no IPv4 answer', async () => {
    mockResolve4.mockRejectedValue(Object.assign(new Error('no data'), { code: 'ENODATA' }));

    const result = await checkSupabaseDirectHost('db.projectref.supabase.co');

    expect(result.ok).toBe(false);
    expect(result.warning).toContain('has no IPv4 DNS answer (ENODATA)');
    expect(result.fix).toContain('session-mode pooler hostname');
  });

  it('returns a generic DNS warning for non-IPv4 lookup failures', async () => {
    mockResolve4.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'ETIMEOUT' }));

    const result = await checkSupabaseDirectHost('db.projectref.supabase.co');

    expect(result.ok).toBe(false);
    expect(result.warning).toContain('failed DNS lookup (ETIMEOUT)');
    expect(result.warning).toContain('network/DNS connectivity');
    expect(result.fix).toBeUndefined();
  });
});
