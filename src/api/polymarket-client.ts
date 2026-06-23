import { sleep } from '../lib/time.js';
import type { PolymarketMarketRaw } from '../types/polymarket-raw.js';

const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';
const PAGE_SIZE = 100;

// ─── Rate limiter ─────────────────────────────────────────────────────────────
// Polymarket's public API has no published rate limit, but 200ms between
// requests (~5 req/sec) is conservative enough to avoid 429s.

class GlobalRateLimiter {
  private lastRequestStartedAt = 0;
  private readonly rateLimitMs: number;

  constructor(rateLimitMs: number) {
    this.rateLimitMs = rateLimitMs;
  }

  async wait(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestStartedAt;
    const remaining = this.rateLimitMs - elapsed;
    if (remaining > 0) await sleep(remaining);
    this.lastRequestStartedAt = Date.now();
  }
}

const globalPolymarketRateLimiter = new GlobalRateLimiter(200);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PolymarketClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface FetchMarketsPageOptions {
  offset?: number;
  limit?: number;
}

export interface PolymarketMarketsPage {
  markets: PolymarketMarketRaw[];
  nextOffset: number | null; // null = no more pages
  fetch_ms: number;
}

export interface IterateMarketsOptions extends FetchMarketsPageOptions {
  maxPages?: number;
}

export interface FetchAllMarketsResult {
  markets: PolymarketMarketRaw[];
  errors: string[];
  fetch_ms: number;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class PolymarketClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PolymarketClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? POLYMARKET_GAMMA_API;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchMarketsPage(options: FetchMarketsPageOptions = {}): Promise<PolymarketMarketsPage> {
    const startedAt = Date.now();
    const limit = options.limit ?? PAGE_SIZE;
    const offset = options.offset ?? 0;

    const params = new URLSearchParams({
      closed: 'false',
      active: 'true',
      order: 'volume24hrClob',
      ascending: 'false',
      limit: String(limit),
      offset: String(offset),
    });

    const data = await this.fetchWithRetry<PolymarketMarketRaw[]>(`/markets?${params.toString()}`);

    // Polymarket returns an empty array when there are no more results
    const nextOffset = data.length === limit ? offset + limit : null;

    return {
      markets: data,
      nextOffset,
      fetch_ms: Date.now() - startedAt,
    };
  }

  async *iterateMarkets(options: IterateMarketsOptions = {}): AsyncGenerator<PolymarketMarketsPage> {
    const maxPages = options.maxPages ?? 250;
    let pageCount = 0;
    let offset = options.offset ?? 0;

    while (true) {
      if (pageCount >= maxPages) {
        throw new PolymarketPaginationBudgetError(
          `Polymarket market pagination exceeded run budget of ${maxPages} pages`
        );
      }

      const page = await this.fetchMarketsPage({
        offset,
        limit: options.limit ?? PAGE_SIZE,
      });

      pageCount += 1;
      yield page;

      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
  }

  async fetchAllMarkets(): Promise<FetchAllMarketsResult> {
    const startedAt = Date.now();
    const markets: PolymarketMarketRaw[] = [];
    const errors: string[] = [];

    try {
      for await (const page of this.iterateMarkets()) {
        markets.push(...page.markets);
      }
    } catch (error) {
      errors.push(String(error));
    }

    return {
      markets,
      errors,
      fetch_ms: Date.now() - startedAt,
    };
  }

  private async fetchWithRetry<T>(path: string, retries = this.maxRetries): Promise<T> {
    try {
      return await this.fetchJson<T>(path);
    } catch (error) {
      if (retries <= 0 || !isRetryablePolymarketError(error)) throw error;
      const attemptIndex = this.maxRetries - retries;
      await sleep(1000 * 2 ** attemptIndex);
      return this.fetchWithRetry<T>(path, retries - 1);
    }
  }

  private async fetchJson<T>(path: string): Promise<T> {
    await globalPolymarketRateLimiter.wait();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new PolymarketHttpError(response.status, `${response.status} ${response.statusText}`, path);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (isAbortError(error)) {
        throw new PolymarketTimeoutError(`Polymarket request timed out after ${this.timeoutMs}ms: ${path}`);
      }
      if (error instanceof Error) throw error;
      throw new Error(`Unknown Polymarket fetch error for ${path}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class PolymarketHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly path: string
  ) {
    super(message);
    this.name = 'PolymarketHttpError';
  }
}

export class PolymarketTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolymarketTimeoutError';
  }
}

export class PolymarketPaginationBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolymarketPaginationBudgetError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRetryablePolymarketError(error: unknown): boolean {
  if (error instanceof PolymarketTimeoutError) return true;
  if (error instanceof PolymarketHttpError) {
    return error.status >= 500 || error.status === 429;
  }
  return error instanceof TypeError;
}
