/**
 * Name → handler registry consulted when a `seller_proxy_configs` row
 * has `internal_handler` set. Single source of truth for legal handler
 * names; anything else surfaces as 503 + a log line, so a typo in the
 * DB column cannot silently fall through to the upstream HTTP path.
 *
 * Add a new handler by importing it here and adding one entry to the
 * map — no other code change required.
 */
import { binanceFunding } from "./binance-funding.js";
import { binanceFundingBatch } from "./binance-funding-batch.js";
import { binanceOpenInterest } from "./binance-open-interest.js";
import { binanceOrderbook } from "./binance-orderbook.js";
import { binanceTrades } from "./binance-trades.js";
import { coingecko24hMovers } from "./coingecko-24h-movers.js";
import { coingeckoMarketRankings } from "./coingecko-market-rankings.js";
import { coingeckoOhlcHistory } from "./coingecko-ohlc-history.js";
import { coingeckoPriceBatch } from "./coingecko-price-batch.js";
import { coingeckoTrending } from "./coingecko-trending.js";
import { defillamaBridges } from "./defillama-bridges.js";
import { defillamaFees } from "./defillama-fees.js";
import { defillamaProtocolTvl } from "./defillama-protocol-tvl.js";
import { defillamaStablecoins } from "./defillama-stablecoins.js";
import { defillamaTvlChain } from "./defillama-tvl-chain.js";
import { defillamaYieldPools } from "./defillama-yield-pools.js";
import { fearGreedIndex } from "./fear-greed-index.js";
import { frankfurterHistorical } from "./frankfurter-historical.js";
import { frankfurterRatesBatch } from "./frankfurter-rates-batch.js";
import { geckoterminalBasePools } from "./geckoterminal-base-pools.js";
import { geckoterminalSolanaPools } from "./geckoterminal-solana-pools.js";
import { heliusNftMetadata } from "./helius-nft-metadata.js";
import { heliusPriorityFee } from "./helius-priority-fee.js";
import { heliusTxDecoder } from "./helius-tx-decoder.js";
import { heliusTxSimulator } from "./helius-tx-simulator.js";
import { heliusWalletHistory } from "./helius-wallet-history.js";
import { secFilings } from "./sec-filings.js";
import { stooqOilPrices } from "./stooq-oil-prices.js";
import { stooqPreciousMetals } from "./stooq-precious-metals.js";
import { taMacd } from "./ta-macd.js";
import { taMovingAverages } from "./ta-moving-averages.js";
import { taRsi } from "./ta-rsi.js";
import { yahooStockBatch } from "./yahoo-stock-batch.js";
import { yahooStockQuote } from "./yahoo-stock-quote.js";

// Base / Cosmos / Bitcoin first-party endpoints (no upstream x402).
import { baseRpcTxDecoder } from "./base-rpc-tx-decoder.js";
import { blockscoutBaseTokenHolders } from "./blockscout-base-token-holders.js";
import { blockscoutBaseWalletHistory } from "./blockscout-base-wallet-history.js";
import { etherscanBaseContractInfo } from "./etherscan-base-contract-info.js";
import { goplusTokenRiskBase } from "./goplus-token-risk-base.js";
import { cosmosChainInfo } from "./cosmos-chain-info.js";
import { cosmosIbcTracker } from "./cosmos-ibc-tracker.js";
import { cosmosTxDecoder } from "./cosmos-tx-decoder.js";
import { cosmosValidatorStats } from "./cosmos-validator-stats.js";
import { cosmosWalletBalance } from "./cosmos-wallet-balance.js";
import { bitcoinAddressInfo } from "./bitcoin-address-info.js";
import { bitcoinBlockInfo } from "./bitcoin-block-info.js";
import { bitcoinFeesRecommended } from "./bitcoin-fees-recommended.js";
import { bitcoinMempoolStats } from "./bitcoin-mempool-stats.js";
import { bitcoinTxDecoder } from "./bitcoin-tx-decoder.js";

// SuVerse Swap — the actual swap flow lives in apps/proxy/src/swap.ts
// at /v1/swap/solana/{quote,execute}; this registry entry exists so
// the discovery-only seller_proxy_configs row can carry a non-null
// internal_handler. See handlers/swap-solana-execute.ts for the
// rationale.
import { swapSolanaExecute } from "./swap-solana-execute.js";

import type { InternalHandler } from "./types.js";

export const INTERNAL_HANDLERS: Record<string, InternalHandler> = {
  helius_tx_decoder: heliusTxDecoder,
  helius_tx_simulator: heliusTxSimulator,
  helius_priority_fee: heliusPriorityFee,
  helius_nft_metadata: heliusNftMetadata,
  helius_wallet_history: heliusWalletHistory,
  coingecko_price_batch: coingeckoPriceBatch,
  coingecko_ohlc_history: coingeckoOhlcHistory,
  coingecko_market_rankings: coingeckoMarketRankings,
  coingecko_24h_movers: coingecko24hMovers,
  coingecko_trending: coingeckoTrending,
  defillama_tvl_chain: defillamaTvlChain,
  defillama_protocol_tvl: defillamaProtocolTvl,
  defillama_yield_pools: defillamaYieldPools,
  defillama_bridges: defillamaBridges,
  defillama_fees: defillamaFees,
  geckoterminal_base_pools: geckoterminalBasePools,
  geckoterminal_solana_pools: geckoterminalSolanaPools,
  binance_orderbook: binanceOrderbook,
  binance_trades: binanceTrades,
  binance_funding: binanceFunding,
  ta_rsi: taRsi,
  ta_macd: taMacd,
  ta_moving_averages: taMovingAverages,
  binance_open_interest: binanceOpenInterest,
  binance_funding_batch: binanceFundingBatch,
  defillama_stablecoins: defillamaStablecoins,
  yahoo_stock_quote: yahooStockQuote,
  yahoo_stock_batch: yahooStockBatch,
  frankfurter_rates_batch: frankfurterRatesBatch,
  frankfurter_historical: frankfurterHistorical,
  fear_greed_index: fearGreedIndex,
  sec_filings: secFilings,
  stooq_precious_metals: stooqPreciousMetals,
  stooq_oil_prices: stooqOilPrices,

  // Base
  base_rpc_tx_decoder: baseRpcTxDecoder,
  goplus_token_risk_base: goplusTokenRiskBase,
  blockscout_base_wallet_history: blockscoutBaseWalletHistory,
  blockscout_base_token_holders: blockscoutBaseTokenHolders,
  etherscan_base_contract_info: etherscanBaseContractInfo,

  // Cosmos
  cosmos_tx_decoder: cosmosTxDecoder,
  cosmos_wallet_balance: cosmosWalletBalance,
  cosmos_validator_stats: cosmosValidatorStats,
  cosmos_ibc_tracker: cosmosIbcTracker,
  cosmos_chain_info: cosmosChainInfo,

  // Bitcoin
  bitcoin_tx_decoder: bitcoinTxDecoder,
  bitcoin_fees_recommended: bitcoinFeesRecommended,
  bitcoin_address_info: bitcoinAddressInfo,
  bitcoin_mempool_stats: bitcoinMempoolStats,
  bitcoin_block_info: bitcoinBlockInfo,

  // SuVerse Swap (discovery stub — real flow at /v1/swap/solana/...).
  swap_solana_execute: swapSolanaExecute,
};

export function getInternalHandler(name: string): InternalHandler | undefined {
  return INTERNAL_HANDLERS[name];
}
