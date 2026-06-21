#!/usr/bin/env node
/**
 * author-batch-006.mjs — Group A (prediction markets) from the demand-map.
 * Emits scripts/pipeline/batch-006.json: 30 single-hop GET wraps over the
 * three FREE Polymarket public APIs (gamma / clob / data-api) + the FREE
 * Kalshi public trade-api v2. No auth, no keys. Every upstream URL+param
 * was probed live (200) on 2026-06-21 before authoring.
 *
 * Pricing per the demand-map clearing band: raw $0.01, enriched/orderbook/
 * trades/holders $0.02. Sum ~= $0.40 of indexing float.
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const DATA = "https://data-api.polymarket.com";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

// Stable, permanent reference ids from live probes (Polymarket never deletes
// markets/conditions/tokens; Kalshi tickers persist post-settlement).
const REF = {
  marketId: "2323347",
  conditionId: "0xf7294e62c740abc47fb752ada68db3c76afa6d05ac92fdc502f05c43ddc3cdb0",
  tokenId: "66029546611959022847698362728102975113450293964760934634688265761392188847539",
  slug: "fifwc-ecu-ger-2026-06-25-exact-score-0-2",
  user: "0x8ac7a02ab2ca88ea27a1a237e34b1492a555f438",
  kTicker: "KXMVECROSSCATEGORY-S202615DDB390A70-61F43B89CD9",
  kEvent: "KXELONMARS-99",
  kSeries: "KXMVECROSSCATEGORY",
};

const P = (over) => ({ in: "query", type: "string", required: false, ...over });
const limit = (ex = "10") => P({ upstreamName: "limit", type: "integer", description: "Max rows to return", example: ex, default: "10" });

const rows = [];
const add = (r) => rows.push(r);
const TAGS = ["prediction-markets", "polymarket", "x402"];
const KTAGS = ["prediction-markets", "kalshi", "x402"];

// ---------- Polymarket Gamma (markets / events / tags) ----------
add({ slug: "polymarket-markets", category: "prediction-markets", source: "Polymarket Gamma", price: 10000,
  title: "Polymarket Markets List",
  description: "List Polymarket prediction markets with question, outcomes, current outcome prices, volume and liquidity. Filter by active/closed and sort order. Data from the public Polymarket Gamma API.",
  bazaar: "List live Polymarket prediction markets: question, outcomes, outcome prices (implied probability), 24h/total volume and liquidity. Filter active vs closed, sort by volume. Free Polymarket Gamma data.",
  tags: TAGS, url: `${GAMMA}/markets`,
  params: { limit: limit("10"), active: P({ type: "boolean", description: "Only active markets", example: "true", default: "true" }), closed: P({ type: "boolean", description: "Include closed markets", example: "false", default: "false" }), order: P({ type: "string", description: "Sort field, e.g. volume", example: "volume", default: "volume" }), ascending: P({ type: "boolean", description: "Ascending sort", example: "false", default: "false" }) },
  sample: { limit: "10", active: "true", closed: "false", order: "volume", ascending: "false" },
  resp: { id: "2323347", question: "Example market?", outcomes: "[\"Yes\",\"No\"]", outcomePrices: "[\"0.08\",\"0.92\"]", volume: "12345.6", liquidity: "5000.0" } });

add({ slug: "polymarket-market-detail", category: "prediction-markets", source: "Polymarket Gamma", price: 10000,
  title: "Polymarket Market Detail",
  description: "Full detail for one Polymarket market by numeric id: question, description, outcomes, outcome prices, condition id, CLOB token ids, volume, liquidity and resolution status. Public Polymarket Gamma API.",
  bazaar: "Full detail for a single Polymarket market by id: question, outcomes, outcome prices, conditionId, CLOB token ids, volume, liquidity, resolution status. Free Polymarket Gamma data.",
  tags: TAGS, url: `${GAMMA}/markets/{id}`,
  params: { id: P({ in: "path", required: true, description: "Polymarket numeric market id", example: REF.marketId }) },
  sample: { id: REF.marketId },
  resp: { id: REF.marketId, question: "Example market?", conditionId: REF.conditionId, volume: "12345.6", closed: false } });

add({ slug: "polymarket-events", category: "prediction-markets", source: "Polymarket Gamma", price: 10000,
  title: "Polymarket Events List",
  description: "List Polymarket events (groups of related markets) with title, slug, description and nested markets. Filter active/closed. Public Polymarket Gamma API.",
  bazaar: "List Polymarket events (groups of related markets) with title, slug, description and their nested markets + odds. Filter active vs closed. Free Polymarket Gamma data.",
  tags: TAGS, url: `${GAMMA}/events`,
  params: { limit: limit("5"), active: P({ type: "boolean", description: "Only active events", example: "true", default: "true" }), closed: P({ type: "boolean", description: "Include closed events", example: "false", default: "false" }) },
  sample: { limit: "5", active: "true", closed: "false" },
  resp: { id: "16183", ticker: "example-event", slug: "example-event", title: "Example event?" } });

add({ slug: "polymarket-event-detail", category: "prediction-markets", source: "Polymarket Gamma", price: 10000,
  title: "Polymarket Event Detail",
  description: "Full detail for one Polymarket event by id: title, description, and every nested market with its outcomes and prices. Public Polymarket Gamma API.",
  bazaar: "Full detail for a Polymarket event by id: title, description and every nested market with outcomes + current prices. Free Polymarket Gamma data.",
  tags: TAGS, url: `${GAMMA}/events/{id}`,
  params: { id: P({ in: "path", required: true, description: "Polymarket numeric event id", example: "16183" }) },
  sample: { id: "16183" },
  resp: { id: "16183", title: "Example event?", markets: "[...]" } });

add({ slug: "polymarket-trending-markets", category: "prediction-markets", source: "Polymarket Gamma", price: 20000,
  title: "Polymarket Trending Markets",
  description: "Top active Polymarket markets ranked by trading volume right now: question, outcome prices, 24h volume and liquidity. Public Polymarket Gamma API.",
  bazaar: "Top active Polymarket markets ranked by volume right now: question, outcome prices (implied probability), 24h volume, liquidity. The trending prediction-market board. Free Polymarket Gamma data.",
  tags: TAGS, url: `${GAMMA}/markets`, staticQuery: { active: "true", closed: "false", order: "volume", ascending: "false" },
  params: { limit: limit("15") },
  sample: { limit: "15" },
  resp: { id: "2323347", question: "Example?", volume: "98765.4", outcomePrices: "[\"0.6\",\"0.4\"]" } });

add({ slug: "polymarket-new-markets", category: "prediction-markets", source: "Polymarket Gamma", price: 10000,
  title: "Polymarket New Markets",
  description: "Most recently launched Polymarket markets, newest first, with question, outcomes and start date. Public Polymarket Gamma API.",
  bazaar: "Freshly launched Polymarket markets, newest first: question, outcomes, start date, volume. Catch new prediction markets early. Free Polymarket Gamma data.",
  tags: TAGS, url: `${GAMMA}/markets`, staticQuery: { order: "startDate", ascending: "false", closed: "false" },
  params: { limit: limit("15") },
  sample: { limit: "15" },
  resp: { id: "2633408", question: "Example new market?", startDate: "2026-06-22T00:00:00Z" } });

add({ slug: "polymarket-markets-by-tag", category: "prediction-markets", source: "Polymarket Gamma", price: 10000,
  title: "Polymarket Markets by Tag",
  description: "Polymarket markets filtered by a category tag id (e.g. politics, crypto, sports): question, outcome prices and volume. Public Polymarket Gamma API.",
  bazaar: "Polymarket markets filtered by category tag id (politics, crypto, sports, etc.): question, outcome prices, volume. Free Polymarket Gamma data. Use polymarket-tags to discover tag ids.",
  tags: TAGS, url: `${GAMMA}/markets`,
  params: { tag_id: P({ required: true, type: "integer", description: "Polymarket tag id (see polymarket-tags)", example: "100265" }), limit: limit("10"), closed: P({ type: "boolean", description: "Include closed", example: "false", default: "false" }) },
  sample: { tag_id: "100265", limit: "10", closed: "false" },
  resp: { id: "2323347", question: "Example?", outcomePrices: "[\"0.5\",\"0.5\"]" } });

add({ slug: "polymarket-tags", category: "prediction-markets", source: "Polymarket Gamma", price: 10000,
  title: "Polymarket Category Tags",
  description: "List Polymarket category tags with id and label, for filtering markets by category. Public Polymarket Gamma API.",
  bazaar: "List Polymarket category tags (id + label) used to filter markets by category (politics, crypto, sports, pop-culture). Free Polymarket Gamma data.",
  tags: TAGS, url: `${GAMMA}/tags`,
  params: { limit: limit("50") },
  sample: { limit: "50" },
  resp: { id: "100265", label: "Politics", slug: "politics" } });

add({ slug: "polymarket-resolved-markets", category: "prediction-markets", source: "Polymarket Gamma", price: 10000,
  title: "Polymarket Resolved Markets",
  description: "Recently resolved (closed) Polymarket markets with the resolved outcome, final prices and volume. Public Polymarket Gamma API.",
  bazaar: "Recently resolved Polymarket markets: the winning outcome, final prices and total volume. Backtest signal quality against real resolutions. Free Polymarket Gamma data.",
  tags: TAGS, url: `${GAMMA}/markets`, staticQuery: { closed: "true", order: "volume", ascending: "false" },
  params: { limit: limit("15") },
  sample: { limit: "15" },
  resp: { id: "2323347", question: "Example?", closed: true, outcomePrices: "[\"1\",\"0\"]" } });

add({ slug: "polymarket-market-by-slug", category: "prediction-markets", source: "Polymarket Gamma", price: 10000,
  title: "Polymarket Market by Slug",
  description: "Look up a Polymarket market by its url slug and return question, outcomes, prices, condition id and CLOB token ids. Public Polymarket Gamma API.",
  bazaar: "Look up a Polymarket market by its url slug: question, outcomes, outcome prices, conditionId and CLOB token ids. Free Polymarket Gamma data.",
  tags: TAGS, url: `${GAMMA}/markets`,
  params: { slug: P({ required: true, description: "Polymarket market url slug", example: REF.slug }) },
  sample: { slug: REF.slug },
  resp: { id: REF.marketId, slug: REF.slug, question: "Example?" } });

// ---------- Polymarket CLOB (odds / orderbook / price) ----------
add({ slug: "polymarket-orderbook", category: "prediction-markets", source: "Polymarket CLOB", price: 20000,
  title: "Polymarket Order Book",
  description: "Live CLOB order book (bids and asks with size) for a Polymarket outcome token. Public Polymarket CLOB API.",
  bazaar: "Live CLOB order book for a Polymarket outcome token: bids and asks with price + size. The real market depth behind the odds. Free Polymarket CLOB data. token_id from polymarket-market-detail.",
  tags: TAGS, url: `${CLOB}/book`,
  params: { token_id: P({ required: true, description: "CLOB token id (clobTokenIds from market detail)", example: REF.tokenId }) },
  sample: { token_id: REF.tokenId },
  resp: { market: REF.conditionId, asset_id: REF.tokenId, bids: "[...]", asks: "[...]" } });

add({ slug: "polymarket-midpoint-price", category: "prediction-markets", source: "Polymarket CLOB", price: 10000,
  title: "Polymarket Midpoint Price",
  description: "Midpoint price (implied probability) for a Polymarket outcome token from the live CLOB. Public Polymarket CLOB API.",
  bazaar: "Midpoint price (implied probability, 0-1) for a Polymarket outcome token from the live order book. Free Polymarket CLOB data. token_id from polymarket-market-detail.",
  tags: TAGS, url: `${CLOB}/midpoint`,
  params: { token_id: P({ required: true, description: "CLOB token id", example: REF.tokenId }) },
  sample: { token_id: REF.tokenId },
  resp: { mid: "0.09" } });

add({ slug: "polymarket-token-price", category: "prediction-markets", source: "Polymarket CLOB", price: 10000,
  title: "Polymarket Token Price",
  description: "Best bid or ask price for a Polymarket outcome token from the live CLOB. Public Polymarket CLOB API.",
  bazaar: "Best bid or best ask price for a Polymarket outcome token from the live CLOB. Free Polymarket CLOB data. token_id from market detail; side = buy or sell.",
  tags: TAGS, url: `${CLOB}/price`,
  params: { token_id: P({ required: true, description: "CLOB token id", example: REF.tokenId }), side: P({ required: true, enum: ["buy", "sell"], description: "buy (best ask) or sell (best bid)", example: "buy" }) },
  sample: { token_id: REF.tokenId, side: "buy" },
  resp: { price: "0.08" } });

add({ slug: "polymarket-price-history", category: "prediction-markets", source: "Polymarket CLOB", price: 20000,
  title: "Polymarket Price History",
  description: "Historical price (odds) time series for a Polymarket outcome token at a chosen interval. Public Polymarket CLOB API.",
  bazaar: "Historical price/odds time series for a Polymarket outcome token at a chosen interval (1h/6h/1d/1w/max). Chart how probability moved. Free Polymarket CLOB data.",
  tags: TAGS, url: `${CLOB}/prices-history`,
  params: { market: P({ required: true, upstreamName: "market", description: "CLOB token id", example: REF.tokenId }), interval: P({ enum: ["1h", "6h", "1d", "1w", "max"], description: "Time window", example: "1d", default: "1d" }), fidelity: P({ type: "integer", description: "Resolution in minutes", example: "60", default: "60" }) },
  sample: { market: REF.tokenId, interval: "1d", fidelity: "60" },
  resp: { history: "[{\"t\":1781992804,\"p\":0.095}]" } });

add({ slug: "polymarket-bid-ask-spread", category: "prediction-markets", source: "Polymarket CLOB", price: 10000,
  title: "Polymarket Bid-Ask Spread",
  description: "Current bid-ask spread for a Polymarket outcome token from the live CLOB. Public Polymarket CLOB API.",
  bazaar: "Current bid-ask spread for a Polymarket outcome token from the live order book - a liquidity/uncertainty gauge. Free Polymarket CLOB data. token_id from market detail.",
  tags: TAGS, url: `${CLOB}/spread`,
  params: { token_id: P({ required: true, description: "CLOB token id", example: REF.tokenId }) },
  sample: { token_id: REF.tokenId },
  resp: { spread: "0.02" } });

add({ slug: "polymarket-clob-markets", category: "prediction-markets", source: "Polymarket CLOB", price: 10000,
  title: "Polymarket CLOB Markets",
  description: "Paginated list of Polymarket CLOB markets with token ids, tick size, min order size and order-book status. Public Polymarket CLOB API.",
  bazaar: "Paginated Polymarket CLOB markets: token ids, tick size, min order size, accepting-orders + order-book-enabled flags. The tradability layer behind each market. Free Polymarket CLOB data.",
  tags: TAGS, url: `${CLOB}/markets`,
  params: { next_cursor: P({ description: "Pagination cursor (blank for first page)", example: "", default: "" }) },
  sample: { next_cursor: "" },
  resp: { data: "[...]", next_cursor: "LTE=" } });

// ---------- Polymarket Data-API (trades / holders / positions / value / activity) ----------
add({ slug: "polymarket-recent-trades", category: "prediction-markets", source: "Polymarket Data API", price: 20000,
  title: "Polymarket Recent Trades",
  description: "Most recent on-chain Polymarket trades across all markets: wallet, side, outcome, size and price. Public Polymarket Data API.",
  bazaar: "Most recent on-chain Polymarket trades across all markets: proxy wallet, side, outcome asset, size and price. Live tape of prediction-market flow. Free Polymarket Data API.",
  tags: TAGS, url: `${DATA}/trades`,
  params: { limit: limit("20"), takerOnly: P({ type: "boolean", description: "Only taker trades", example: "true", default: "true" }) },
  sample: { limit: "20", takerOnly: "true" },
  resp: { proxyWallet: REF.user, side: "BUY", size: "100", price: "0.08" } });

add({ slug: "polymarket-market-holders", category: "prediction-markets", source: "Polymarket Data API", price: 20000,
  title: "Polymarket Market Holders",
  description: "Top holders of each outcome token for a Polymarket market by condition id: wallet and position size. Public Polymarket Data API.",
  bazaar: "Top holders of each outcome token for a Polymarket market (by conditionId): proxy wallet + position size. See who is on each side. Free Polymarket Data API. conditionId from market detail.",
  tags: TAGS, url: `${DATA}/holders`,
  params: { market: P({ required: true, description: "Market conditionId", example: REF.conditionId }), limit: limit("10") },
  sample: { market: REF.conditionId, limit: "10" },
  resp: { token: REF.tokenId, holders: "[{\"proxyWallet\":\"0x..\",\"amount\":1000}]" } });

add({ slug: "polymarket-wallet-positions", category: "prediction-markets", source: "Polymarket Data API", price: 20000,
  title: "Polymarket Wallet Positions",
  description: "Current open Polymarket positions for a wallet address: market, outcome, size, average price and current value. Public Polymarket Data API.",
  bazaar: "Current open Polymarket positions for a wallet: market, outcome, size, average price, current value and unrealized PnL. Free Polymarket Data API. Pass a proxy wallet address.",
  tags: TAGS, url: `${DATA}/positions`,
  params: { user: P({ required: true, pattern: "^0x[0-9a-fA-F]{40}$", description: "Polymarket proxy wallet address", example: REF.user }), limit: limit("20") },
  sample: { user: REF.user, limit: "20" },
  resp: { proxyWallet: REF.user, asset: REF.tokenId, size: "100", avgPrice: "0.05" } });

add({ slug: "polymarket-wallet-value", category: "prediction-markets", source: "Polymarket Data API", price: 10000,
  title: "Polymarket Wallet Value",
  description: "Total current portfolio value (USDC) of all open Polymarket positions for a wallet address. Public Polymarket Data API.",
  bazaar: "Total current portfolio value (USDC) of all open Polymarket positions for a wallet address. Free Polymarket Data API. Pass a proxy wallet address.",
  tags: TAGS, url: `${DATA}/value`,
  params: { user: P({ required: true, pattern: "^0x[0-9a-fA-F]{40}$", description: "Polymarket proxy wallet address", example: REF.user }) },
  sample: { user: REF.user },
  resp: { user: REF.user, value: 4.0546 } });

add({ slug: "polymarket-wallet-activity", category: "prediction-markets", source: "Polymarket Data API", price: 20000,
  title: "Polymarket Wallet Activity",
  description: "Recent Polymarket activity (trades, splits, merges, redeems) for a wallet address with timestamps and amounts. Public Polymarket Data API.",
  bazaar: "Recent Polymarket activity for a wallet: trades, splits, merges, redeems with timestamps, market and amounts. Track a trader's footprint. Free Polymarket Data API.",
  tags: TAGS, url: `${DATA}/activity`,
  params: { user: P({ required: true, pattern: "^0x[0-9a-fA-F]{40}$", description: "Polymarket proxy wallet address", example: REF.user }), limit: limit("20") },
  sample: { user: REF.user, limit: "20" },
  resp: { proxyWallet: REF.user, timestamp: 1782077762, type: "TRADE" } });

add({ slug: "polymarket-market-trades", category: "prediction-markets", source: "Polymarket Data API", price: 20000,
  title: "Polymarket Market Trades",
  description: "Recent on-chain trades for one Polymarket market by condition id: wallet, side, outcome, size and price. Public Polymarket Data API.",
  bazaar: "Recent on-chain trades for a single Polymarket market (by conditionId): wallet, side, outcome, size, price. Per-market flow tape. Free Polymarket Data API.",
  tags: TAGS, url: `${DATA}/trades`,
  params: { market: P({ required: true, description: "Market conditionId", example: REF.conditionId }), limit: limit("20") },
  sample: { market: REF.conditionId, limit: "20" },
  resp: { proxyWallet: REF.user, side: "SELL", size: "50", price: "0.1" } });

// ---------- Kalshi (public trade-api v2) ----------
add({ slug: "kalshi-markets", category: "prediction-markets", source: "Kalshi", price: 10000,
  title: "Kalshi Markets List",
  description: "List Kalshi markets with ticker, title, yes/no bid and ask, last price and volume. Public Kalshi trade-api v2.",
  bazaar: "List Kalshi prediction markets: ticker, title, yes/no bid + ask, last price, volume and open interest. The US-regulated event-contract board. Free Kalshi public API.",
  tags: KTAGS, url: `${KALSHI}/markets`,
  params: { limit: limit("20"), status: P({ enum: ["open", "closed", "settled"], description: "Market status filter", example: "open", default: "open" }) },
  sample: { limit: "20", status: "open" },
  resp: { ticker: "EXAMPLE-TICKER", title: "Example?", yes_bid: 55, no_bid: 45, volume: 1000 } });

add({ slug: "kalshi-events", category: "prediction-markets", source: "Kalshi", price: 10000,
  title: "Kalshi Events List",
  description: "List Kalshi events (groups of related markets) with event ticker, title, category and nested markets. Public Kalshi trade-api v2.",
  bazaar: "List Kalshi events (groups of related markets): event ticker, title, category and nested markets. Free Kalshi public API.",
  tags: KTAGS, url: `${KALSHI}/events`,
  params: { limit: limit("20"), status: P({ enum: ["open", "closed", "settled"], description: "Status filter", example: "open", default: "open" }) },
  sample: { limit: "20", status: "open" },
  resp: { event_ticker: "KXELONMARS-99", title: "Example event?", category: "World" } });

add({ slug: "kalshi-market-detail", category: "prediction-markets", source: "Kalshi", price: 10000,
  title: "Kalshi Market Detail",
  description: "Full detail for one Kalshi market by ticker: title, rules summary, yes/no bid and ask, last price, volume, open interest and close time. Public Kalshi trade-api v2.",
  bazaar: "Full detail for a Kalshi market by ticker: title, rules, yes/no bid + ask, last price, volume, open interest, close time and status. Free Kalshi public API.",
  tags: KTAGS, url: `${KALSHI}/markets/{ticker}`,
  params: { ticker: P({ in: "path", required: true, description: "Kalshi market ticker", example: REF.kTicker }) },
  sample: { ticker: REF.kTicker },
  resp: { ticker: REF.kTicker, yes_bid: 50, no_bid: 50, status: "active" } });

add({ slug: "kalshi-event-detail", category: "prediction-markets", source: "Kalshi", price: 10000,
  title: "Kalshi Event Detail",
  description: "Full detail for one Kalshi event by event ticker: title, category and every nested market with prices. Public Kalshi trade-api v2.",
  bazaar: "Full detail for a Kalshi event by event ticker: title, category and every nested market with current prices. Free Kalshi public API.",
  tags: KTAGS, url: `${KALSHI}/events/{event_ticker}`,
  params: { event_ticker: P({ in: "path", required: true, description: "Kalshi event ticker", example: REF.kEvent }) },
  sample: { event_ticker: REF.kEvent },
  resp: { event_ticker: REF.kEvent, title: "Example?", markets: "[...]" } });

add({ slug: "kalshi-open-markets", category: "prediction-markets", source: "Kalshi", price: 10000,
  title: "Kalshi Open Markets",
  description: "Currently open Kalshi markets accepting trades, with ticker, title, prices and volume. Public Kalshi trade-api v2.",
  bazaar: "Currently OPEN Kalshi markets accepting trades: ticker, title, yes/no prices, volume and close time. Free Kalshi public API.",
  tags: KTAGS, url: `${KALSHI}/markets`, staticQuery: { status: "open" },
  params: { limit: limit("25") },
  sample: { limit: "25" },
  resp: { ticker: "EXAMPLE", status: "active", yes_bid: 60 } });

add({ slug: "kalshi-market-orderbook", category: "prediction-markets", source: "Kalshi", price: 20000,
  title: "Kalshi Market Order Book",
  description: "Live order book (yes and no price levels with size) for one Kalshi market by ticker. Public Kalshi trade-api v2.",
  bazaar: "Live order book for a Kalshi market by ticker: yes and no price levels with resting size. Real depth behind the quoted odds. Free Kalshi public API.",
  tags: KTAGS, url: `${KALSHI}/markets/{ticker}/orderbook`,
  params: { ticker: P({ in: "path", required: true, description: "Kalshi market ticker", example: REF.kTicker }), depth: P({ type: "integer", description: "Price levels per side", example: "10", default: "10" }) },
  sample: { ticker: REF.kTicker, depth: "10" },
  resp: { orderbook_fp: { yes_dollars: "[[\"0.55\",\"100\"]]", no_dollars: "[[\"0.45\",\"200\"]]" } } });

add({ slug: "kalshi-series-detail", category: "prediction-markets", source: "Kalshi", price: 10000,
  title: "Kalshi Series Detail",
  description: "Detail for a Kalshi series by series ticker: title, category, frequency and settlement sources. Public Kalshi trade-api v2.",
  bazaar: "Detail for a Kalshi series by series ticker: title, category, contract frequency and settlement sources. The template behind recurring events. Free Kalshi public API.",
  tags: KTAGS, url: `${KALSHI}/series/{series_ticker}`,
  params: { series_ticker: P({ in: "path", required: true, description: "Kalshi series ticker", example: REF.kSeries }) },
  sample: { series_ticker: REF.kSeries },
  resp: { series: { ticker: REF.kSeries, category: "Economics", frequency: "daily" } } });

add({ slug: "kalshi-market-trades", category: "prediction-markets", source: "Kalshi", price: 20000,
  title: "Kalshi Market Trades",
  description: "Recent executed trades for a Kalshi market by ticker: price, count, side and time. Public Kalshi trade-api v2.",
  bazaar: "Recent executed trades for a Kalshi market by ticker: price, contract count, taker side and timestamp. Live tape for a US-regulated event contract. Free Kalshi public API.",
  tags: KTAGS, url: `${KALSHI}/markets/trades`,
  params: { ticker: P({ required: true, description: "Kalshi market ticker", example: REF.kTicker }), limit: limit("20") },
  sample: { ticker: REF.kTicker, limit: "20" },
  resp: { trades: "[{\"price\":55,\"count\":10,\"taker_side\":\"yes\"}]" } });

// ---------- emit ----------
const out = rows.map((r) => ({
  slug: r.slug, category: r.category, source: r.source,
  title: r.title, description: r.description, descriptionBazaar: r.bazaar,
  tags: r.tags, priceUsdcAtomic: r.price,
  upstream: { url: r.url, timeoutMs: 12000, ...(r.staticQuery ? { staticQuery: r.staticQuery } : {}) },
  params: r.params, sampleRequest: r.sample, sampleResponse: r.resp,
}));
const path = resolve(__dirname, "batch-006.json");
writeFileSync(path, JSON.stringify(out, null, 1));
console.log(`wrote ${out.length} rows -> ${path}`);
const sum = rows.reduce((a, r) => a + r.price, 0);
console.log(`indexing float needed: $${(sum / 1e6).toFixed(3)} (${out.length} settles)`);
for (const r of out) if (r.descriptionBazaar.length > 320) console.log(`!! bazaar too long: ${r.slug} (${r.descriptionBazaar.length})`);
