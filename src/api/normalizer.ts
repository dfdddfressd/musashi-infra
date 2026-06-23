import { parseKalshiDollars, parseKalshiSize } from '../lib/prices.js';
import { secondsSince } from '../lib/time.js';
import type { KalshiMarketRaw } from '../types/kalshi-raw.js';
import type { MarketCategory, MarketStatus, MusashiMarket, ResolutionOutcome } from '../types/market.js';
import type { PolymarketMarketRaw } from '../types/polymarket-raw.js';

export interface NormalizerResult {
  market: MusashiMarket;
  platform_raw: unknown;
  warnings: string[];
}

export interface NormalizerError {
  platform_id: string;
  error: string;
  raw_data: unknown;
}

export interface NormalizationBatch {
  normalized: NormalizerResult[];
  errors: NormalizerError[];
}

export function normalizeKalshiMarket(raw: KalshiMarketRaw, fetchedAt: Date): NormalizerResult {
  const warnings: string[] = [];
  const yesPrice = deriveKalshiYesPrice(raw, warnings);
  const noPrice = roundPrice(1 - yesPrice);
  const title = raw.title?.trim();

  if (!title) {
    throw new Error(`Kalshi market ${raw.ticker} is missing a title`);
  }

  const status = mapKalshiStatus(raw.status);
  const resolution = mapKalshiResult(raw.result);
  const resolved = status === 'resolved' && resolution !== null;

  return {
    market: {
      id: `musashi-kalshi-${raw.ticker}`,
      platform: 'kalshi',
      platform_id: raw.ticker,
      event_id: raw.event_ticker,
      series_id: raw.series_ticker ?? null,
      title,
      description: raw.subtitle?.trim() ?? null,
      category: normalizeKalshiCategory(raw),
      url: `https://kalshi.com/markets/${raw.event_ticker}/${raw.ticker}`,
      yes_price: yesPrice,
      no_price: noPrice,
      volume_24h: parseKalshiSize(raw.volume_24h_fp) ?? 0,
      open_interest: parseKalshiSize(raw.open_interest_fp),
      liquidity: parseKalshiDollars(raw.liquidity_dollars),
      spread: deriveKalshiSpread(raw),
      status,
      created_at: raw.created_time ?? raw.open_time ?? null,
      closes_at: raw.close_time ?? null,
      settles_at: raw.latest_expiration_time ?? raw.close_time ?? null,
      resolved,
      resolution,
      resolved_at: null,
      fetched_at: fetchedAt.toISOString(),
      cache_hit: false,
      data_age_seconds: secondsSince(fetchedAt.toISOString(), fetchedAt),
    },
    platform_raw: raw,
    warnings,
  };
}

export function normalizeKalshiBatch(rawMarkets: KalshiMarketRaw[], fetchedAt: Date): NormalizationBatch {
  const normalized: NormalizerResult[] = [];
  const errors: NormalizerError[] = [];

  for (const raw of rawMarkets) {
    try {
      normalized.push(normalizeKalshiMarket(raw, fetchedAt));
    } catch (error) {
      errors.push({
        platform_id: raw.ticker,
        error: error instanceof Error ? error.message : String(error),
        raw_data: raw,
      });
    }
  }

  return { normalized, errors };
}

function deriveKalshiYesPrice(raw: KalshiMarketRaw, warnings: string[]): number {
  const lastPrice = parseKalshiDollars(raw.last_price_dollars);
  if (lastPrice !== null) {
    return assertPriceBounds(lastPrice, raw.ticker, 'last_price_dollars');
  }

  const yesBid = parseKalshiDollars(raw.yes_bid_dollars);
  const yesAsk = parseKalshiDollars(raw.yes_ask_dollars);

  if (yesBid !== null && yesAsk !== null) {
    return assertPriceBounds(roundPrice((yesBid + yesAsk) / 2), raw.ticker, 'midpoint');
  }

  if (yesBid !== null) {
    warnings.push('Missing yes_ask_dollars; using yes_bid_dollars as yes_price');
    return assertPriceBounds(yesBid, raw.ticker, 'yes_bid_dollars');
  }

  if (yesAsk !== null) {
    warnings.push('Missing yes_bid_dollars; using yes_ask_dollars as yes_price');
    return assertPriceBounds(yesAsk, raw.ticker, 'yes_ask_dollars');
  }

  throw new Error(`Kalshi market ${raw.ticker} is missing usable price fields`);
}

function deriveKalshiSpread(raw: KalshiMarketRaw): number | null {
  const yesBid = parseKalshiDollars(raw.yes_bid_dollars);
  const yesAsk = parseKalshiDollars(raw.yes_ask_dollars);

  if (yesBid === null || yesAsk === null) {
    return null;
  }

  return roundPrice(Math.max(0, yesAsk - yesBid));
}

function normalizeKalshiCategory(raw: KalshiMarketRaw): MarketCategory {
  const seriesTicker = raw.series_ticker?.toLowerCase() ?? '';
  const category = raw.category?.toLowerCase().trim() ?? '';
  const title = raw.title?.toLowerCase() ?? '';

  if (seriesTicker.startsWith('kxfed') || category.includes('fed')) return 'fed_policy';
  if (category.includes('economic') || category.includes('inflation') || title.includes('cpi')) return 'economics';
  if (category.includes('financial') || category.includes('stock') || title.includes('s&p') || title.includes('nasdaq'))
    return 'financial_markets';
  if (category.includes('politic') || title.includes('election')) return 'us_politics';
  if (category.includes('geo') || title.includes('ukraine') || title.includes('china')) return 'geopolitics';
  if (category.includes('tech') || title.includes('apple') || title.includes('nvidia')) return 'technology';
  if (category.includes('crypto') || title.includes('bitcoin') || title.includes('ethereum')) return 'crypto';
  if (category.includes('sport') || title.includes('nba') || title.includes('nfl')) return 'sports';
  if (category.includes('climate') || category.includes('weather') || title.includes('hurricane')) return 'climate';
  if (category.includes('entertain') || title.includes('oscar')) return 'entertainment';
  return 'other';
}

function mapKalshiStatus(status: KalshiMarketRaw['status']): MarketStatus {
  switch (status) {
    case 'settled':
    case 'finalized':
      return 'resolved';
    case 'closed':
      return 'closed';
    case 'initialized':
    case 'unopened':
    case 'open':
    case 'active':
      return 'open';
  }
}

function mapKalshiResult(result: KalshiMarketRaw['result']): ResolutionOutcome | null {
  if (result === 'yes') return 'YES';
  if (result === 'no') return 'NO';
  return null;
}

function roundPrice(value: number): number {
  return Number(value.toFixed(6));
}

function assertPriceBounds(value: number, ticker: string, fieldName: string): number {
  if (value < 0 || value > 1) {
    throw new Error(`Kalshi market ${ticker} has out-of-range ${fieldName}: ${value}`);
  }

  return roundPrice(value);
}


export function normalizePolymarketMarket(raw: PolymarketMarketRaw, fetchedAt: Date): NormalizerResult {
  const warnings: string[] = [];
 
  if (!raw.question?.trim()) {
    throw new Error(`Polymarket market ${raw.conditionId} is missing a question/title`);
  }
 
  if (!raw.conditionId) {
    throw new Error(`Polymarket market is missing conditionId`);
  }
 
  // Must be an active, open binary Yes/No market
  if (!raw.active || raw.closed || raw.archived) {
    throw new Error(`Polymarket market ${raw.conditionId} is not active/open`);
  }
 
  // Validate binary Yes/No outcomes
  if (!Array.isArray(raw.outcomes) || raw.outcomes.length !== 2) {
    throw new Error(`Polymarket market ${raw.conditionId} is not a binary market`);
  }
  const lowerOutcomes = raw.outcomes.map(o => o.toLowerCase());
  if (!lowerOutcomes.includes('yes') || !lowerOutcomes.includes('no')) {
    throw new Error(`Polymarket market ${raw.conditionId} outcomes are not Yes/No`);
  }
 
  const yesPrice = derivePolymarketYesPrice(raw, warnings);
  const noPrice = roundPrice(1 - yesPrice);
 
  const title = raw.question.trim();
  const status = raw.closed ? 'closed' : 'open';
  const resolved = raw.resolution === 'yes' || raw.resolution === 'no';
  const resolution = raw.resolution === 'yes' ? 'YES' : raw.resolution === 'no' ? 'NO' : null;
 
  return {
    market: {
      id: `musashi-polymarket-${raw.conditionId}`,
      platform: 'polymarket',
      platform_id: raw.conditionId,
      event_id: raw.questionID ?? null,
      series_id: null, // Polymarket has no series concept
      title,
      description: raw.description?.trim() ?? null,
      category: normalizePolymarketCategory(raw),
      url: `https://polymarket.com/event/${raw.slug ?? raw.conditionId}`,
      yes_price: yesPrice,
      no_price: noPrice,
      volume_24h: parsePolymarketNumber(raw.volume24hr) ?? 0,
      open_interest: null, // not provided by gamma API
      liquidity: parsePolymarketNumber(raw.liquidity),
      spread: null, // not provided by gamma API
      status,
      created_at: raw.createdAt ?? null,
      closes_at: raw.endDate ?? null,
      settles_at: raw.endDate ?? null, // Polymarket uses endDate for both
      resolved,
      resolution,
      resolved_at: null, // not provided by gamma API
      fetched_at: fetchedAt.toISOString(),
      cache_hit: false,
      data_age_seconds: 0,
    },
    platform_raw: raw,
    warnings,
  };
}
 
export function normalizePolymarketBatch(
  rawMarkets: PolymarketMarketRaw[],
  fetchedAt: Date
): NormalizationBatch {
  const normalized: NormalizerResult[] = [];
  const errors: NormalizerError[] = [];
 
  for (const raw of rawMarkets) {
    try {
      normalized.push(normalizePolymarketMarket(raw, fetchedAt));
    } catch (error) {
      errors.push({
        platform_id: raw.conditionId ?? 'unknown',
        error: error instanceof Error ? error.message : String(error),
        raw_data: raw,
      });
    }
  }
 
  return { normalized, errors };
}
 
function derivePolymarketYesPrice(raw: PolymarketMarketRaw, warnings: string[]): number {
  if (!Array.isArray(raw.outcomePrices) || raw.outcomePrices.length !== 2) {
    warnings.push(`Market ${raw.conditionId} missing outcomePrices; defaulting to 0.5`);
    return 0.5;
  }
 
  const yesIdx = raw.outcomes.findIndex(o => o.toLowerCase() === 'yes');
  if (yesIdx === -1) {
    warnings.push(`Market ${raw.conditionId} has no Yes outcome; defaulting to 0.5`);
    return 0.5;
  }
 
  const rawPrice = raw.outcomePrices[yesIdx];
  if (rawPrice === undefined) {
    warnings.push(`Market ${raw.conditionId} missing price for Yes outcome; defaulting to 0.5`);
    return 0.5;
  }

  const parsed = parseFloat(rawPrice);
  if (isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Polymarket market ${raw.conditionId} has out-of-range yes price: ${rawPrice}`);
  }

  return roundPrice(parsed);
}
 
function normalizePolymarketCategory(raw: PolymarketMarketRaw): MarketCategory {
  const category = raw.category?.toLowerCase().trim() ?? '';
  const question = raw.question?.toUpperCase() ?? '';
  const tags = (raw.tags ?? []).map(t => t.toLowerCase());
 
  if (category.includes('crypto') || tags.includes('crypto') ||
      /BTC|ETH|SOL|XRP|DOGE|BITCOIN|ETHEREUM|CRYPTO/.test(question)) return 'crypto';
 
  if (category.includes('politic') || category.includes('elect') || tags.includes('politics') ||
      /TRUMP|BIDEN|HARRIS|CONGRESS|SENATE|ELECT|GOP|DEM|POTUS|PRESIDENT/.test(question)) return 'us_politics';
 
  if (category.includes('sport') || tags.includes('sports') ||
      /NFL|NBA|MLB|NHL|SUPER BOWL|WORLD CUP|FIFA|GOLF|TENNIS/.test(question)) return 'sports';
 
  if (category.includes('tech') || tags.includes('tech') ||
      /NVDA|AAPL|MSFT|GOOGLE|META|AMAZON|OPENAI|TESLA|AI MODEL/.test(question)) return 'technology';
 
  if (/FED|CPI|GDP|INFLATION|RATE|RECESSION|UNEMPLOYMENT|JOBS REPORT/.test(question)) return 'economics';
 
  if (/S&P|NASDAQ|DOW|STOCK|MARKET CAP|IPO/.test(question)) return 'financial_markets';
 
  if (/UKRAINE|RUSSIA|CHINA|NATO|TAIWAN|ISRAEL|GAZA|IRAN|NORTH KOREA/.test(question)) return 'geopolitics';
 
  if (/CLIMATE|HURRICANE|EARTHQUAKE|CARBON|OIL|ENERGY/.test(question)) return 'climate';
 
  if (/OSCAR|EMMY|GRAMMY|MOVIE|FILM|ALBUM|TOUR/.test(question)) return 'entertainment';
 
  if (/FED FUND|FOMC|FEDERAL RESERVE|BASIS POINT/.test(question)) return 'fed_policy';
 
  return 'other';
}
 
function parsePolymarketNumber(value: string | number | undefined | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return isNaN(parsed) ? null : parsed;
}
