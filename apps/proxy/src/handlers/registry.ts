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
import {
  cryptoMarketPulse,
  cryptoMarketPulsePreflight,
  cryptoMarketPulseValidator,
} from "./crypto-market-pulse.js";
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
import {
  heliusTxDecoder,
  heliusTxDecoderValidator,
} from "./helius-tx-decoder.js";
import {
  heliusTxSimulator,
  heliusTxSimulatorValidator,
} from "./helius-tx-simulator.js";
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
// at /v1/swap/solana/{quote,execute} and apps/proxy/src/swap-base.ts
// at /v1/swap/base/{quote,execute}; these registry entries exist so
// the discovery-only seller_proxy_configs row can carry a non-null
// internal_handler. See handlers/swap-solana-execute.ts for the
// rationale.
import { swapSolanaExecute } from "./swap-solana-execute.js";
import { swapBaseExecute } from "./swap-base-execute.js";
import {
  tokenCheck,
  tokenCheckInputSchema,
  tokenCheckPreflight,
  tokenCheckValidator,
} from "./token-check.js";
import {
  walletReputation,
  walletReputationInputSchema,
  walletReputationPreflight,
  walletReputationValidator,
} from "./wallet-reputation.js";
import {
  smartMoneyTokenRankings,
  smartMoneyAccumulation,
  smartMoneyDistribution,
  smartMoneyTopWallets,
  smartMoneyTokenRankingsPreflight,
  smartMoneyAccumulationPreflight,
  smartMoneyDistributionPreflight,
  smartMoneyTopWalletsPreflight,
  smartMoneyRankingValidator,
  smartMoneyTokenRankingsInputSchema,
  smartMoneyAccumulationInputSchema,
  smartMoneyDistributionInputSchema,
  smartMoneyTopWalletsInputSchema,
} from "./smart-money-rankings.js";
import {
  walletLabel,
  walletLabelInputSchema,
  walletLabelPreflight,
  walletLabelValidator,
} from "./wallet-label.js";
import {
  walletPnl,
  walletPnlInputSchema,
  walletPnlPreflight,
  walletPnlValidator,
} from "./wallet-pnl.js";

import type {
  InternalHandler,
  InternalHandlerPreflight,
  InternalHandlerValidator,
} from "./types.js";
import type { InternalHandlerInputSchema } from "./discovery.js";

// Declarative (data-driven) endpoints. Each batch file is generated by
// scripts/pipeline/wrap-batch.mjs from discovery-map rows; the engine
// turns each spec into a handler (+ validator + preflight + input
// schema). Registering them is a loop at the bottom of this file, so a
// 100-endpoint batch is a data import, not 100 hand-written functions.
import {
  makeDeclarativeHandler,
  makeDeclarativeValidator,
  makeDeclarativePreflight,
  makeDeclarativeInputSchema,
} from "./declarative/engine.js";
import { SPECS_BATCH_001 } from "./declarative/specs.batch-001.js";
import { SPECS_BATCH_002 } from "./declarative/specs.batch-002.js";
import { SPECS_BATCH_E2E } from "./declarative/specs.batch-e2e.js";
import { SPECS_BATCH_003 } from "./declarative/specs.batch-003.js";
import { SPECS_BATCH_004 } from "./declarative/specs.batch-004.js";
import { SPECS_BATCH_005 } from "./declarative/specs.batch-005.js";
import { SPECS_BATCH_006 } from "./declarative/specs.batch-006.js";
import { SPECS_BATCH_007 } from "./declarative/specs.batch-007.js";

const DECLARATIVE_SPECS = [...SPECS_BATCH_001, ...SPECS_BATCH_002, ...SPECS_BATCH_E2E, ...SPECS_BATCH_003, ...SPECS_BATCH_004, ...SPECS_BATCH_005, ...SPECS_BATCH_006, ...SPECS_BATCH_007];

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
  crypto_market_pulse: cryptoMarketPulse,
  wallet_reputation: walletReputation,
  smart_money_token_rankings: smartMoneyTokenRankings,
  smart_money_accumulation: smartMoneyAccumulation,
  smart_money_distribution: smartMoneyDistribution,
  smart_money_top_wallets: smartMoneyTopWallets,
  wallet_label_lookup: walletLabel,
  wallet_pnl: walletPnl,
  token_check: tokenCheck,
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

  // SuVerse Swap (discovery stubs — real flows at /v1/swap/<chain>/...).
  swap_solana_execute: swapSolanaExecute,
  swap_base_execute: swapBaseExecute,
};

export function getInternalHandler(name: string): InternalHandler | undefined {
  return INTERNAL_HANDLERS[name];
}

/**
 * Pre-payment body validators keyed by the same handler name as
 * `INTERNAL_HANDLERS`. Optional — handlers without a validator skip
 * pre-payment validation, the buyer pays first and the handler
 * surfaces its own 400 after settlement (legacy behavior). Add an
 * entry here when you want to reject malformed bodies BEFORE the
 * 402 challenge, sparing buyers a fee for a call that was always
 * going to fail.
 */
export const INTERNAL_HANDLER_VALIDATORS: Record<string, InternalHandlerValidator> = {
  helius_tx_simulator: heliusTxSimulatorValidator,
  helius_tx_decoder: heliusTxDecoderValidator,
  crypto_market_pulse: cryptoMarketPulseValidator,
  wallet_reputation: walletReputationValidator,
  smart_money_token_rankings: smartMoneyRankingValidator,
  smart_money_accumulation: smartMoneyRankingValidator,
  smart_money_distribution: smartMoneyRankingValidator,
  smart_money_top_wallets: smartMoneyRankingValidator,
  wallet_label_lookup: walletLabelValidator,
  wallet_pnl: walletPnlValidator,
  token_check: tokenCheckValidator,
};

export function getInternalHandlerValidator(
  name: string,
): InternalHandlerValidator | undefined {
  return INTERNAL_HANDLER_VALIDATORS[name];
}

/**
 * Pre-settlement health gates keyed by handler name. Optional — only
 * fail-closed endpoints register one. The dispatcher runs it AFTER
 * the cheap validator but BEFORE `runProtocol()` settles, so a buyer
 * is never charged for a verdict the handler cannot produce. See
 * `InternalHandlerPreflight` in types.ts for the contract.
 */
export const INTERNAL_HANDLER_PREFLIGHTS: Record<string, InternalHandlerPreflight> = {
  crypto_market_pulse: cryptoMarketPulsePreflight,
  wallet_reputation: walletReputationPreflight,
  smart_money_token_rankings: smartMoneyTokenRankingsPreflight,
  smart_money_accumulation: smartMoneyAccumulationPreflight,
  smart_money_distribution: smartMoneyDistributionPreflight,
  smart_money_top_wallets: smartMoneyTopWalletsPreflight,
  wallet_label_lookup: walletLabelPreflight,
  wallet_pnl: walletPnlPreflight,
  token_check: tokenCheckPreflight,
};

export function getInternalHandlerPreflight(
  name: string,
): InternalHandlerPreflight | undefined {
  return INTERNAL_HANDLER_PREFLIGHTS[name];
}

/**
 * Machine-readable input contracts keyed by handler name. The
 * dispatcher merges a registered schema into the 402 challenge body
 * as top-level `input_schema`, so catalog crawlers probing with empty
 * bodies — and schema-aware agents about to pay — learn the required
 * field, type and an example without paying first.
 */
export const INTERNAL_HANDLER_INPUT_SCHEMAS: Record<
  string,
  InternalHandlerInputSchema
> = {
  wallet_reputation: walletReputationInputSchema,
  smart_money_token_rankings: smartMoneyTokenRankingsInputSchema,
  smart_money_accumulation: smartMoneyAccumulationInputSchema,
  smart_money_distribution: smartMoneyDistributionInputSchema,
  smart_money_top_wallets: smartMoneyTopWalletsInputSchema,
  wallet_label_lookup: walletLabelInputSchema,
  wallet_pnl: walletPnlInputSchema,
  token_check: tokenCheckInputSchema,
};

export function getInternalHandlerInputSchema(
  name: string,
): InternalHandlerInputSchema | undefined {
  return INTERNAL_HANDLER_INPUT_SCHEMAS[name];
}

// ---------------------------------------------------------------------
// Register the declarative batch endpoints. One loop fans every spec
// into the four registries above. A duplicate handler name (a slug that
// collides with a hand-written handler) throws at module load — loud,
// not silent, so a bad batch can never shadow a bespoke endpoint.
// ---------------------------------------------------------------------
for (const spec of DECLARATIVE_SPECS) {
  if (INTERNAL_HANDLERS[spec.handlerName]) {
    throw new Error(
      `declarative spec handlerName collides with existing handler: ${spec.handlerName}`,
    );
  }
  INTERNAL_HANDLERS[spec.handlerName] = makeDeclarativeHandler(spec);
  const validator = makeDeclarativeValidator(spec);
  if (validator) INTERNAL_HANDLER_VALIDATORS[spec.handlerName] = validator;
  const preflight = makeDeclarativePreflight(spec);
  if (preflight) INTERNAL_HANDLER_PREFLIGHTS[spec.handlerName] = preflight;
  const schema = makeDeclarativeInputSchema(spec);
  if (schema) INTERNAL_HANDLER_INPUT_SCHEMAS[spec.handlerName] = schema;
}
