// Raw shape of a market returned by the Polymarket gamma API.
// NOTE: outcomes, outcomePrices, and clobTokenIds are JSON-encoded strings,
// not arrays. Parse them at the API boundary before use.
export interface PolymarketMarketRaw {
  id: string;
  question: string;
  description?: string;
  // JSON strings e.g. "[\"Yes\",\"No\"]" — parse before use
  outcomes: string;
  outcomePrices: string;
  clobTokenIds?: string;
  volume: string;
  // volume24hr is a number in the real Gamma response
  volume24hr: number;
  liquidity: string;
  startDate?: string;
  endDate?: string;
  endDateIso?: string;
  createdAt?: string;
  closed: boolean;
  archived: boolean;
  active: boolean;
  questionID?: string;
  conditionId: string;
  slug?: string;
  category?: string;
  groupItemTitle?: string;
  resolution?: string;
  resolutionSource?: string;
  tags?: string[];
  events?: Array<{ slug: string }>;
  restricted?: boolean;
}

export interface PolymarketMarketsResponse {
  data: PolymarketMarketRaw[];
  next_cursor?: string;
}
