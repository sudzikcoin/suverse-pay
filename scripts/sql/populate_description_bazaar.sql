-- populate_description_bazaar.sql — keyword-dense ≤320-char descriptions
-- written specifically for CDP /discovery/merchant semantic-search.
--
-- These strings are what an AI agent sees when querying the Bazaar
-- catalog; the long-form `description` column (1500+ chars) stays
-- intact for our /api/catalog/listings.json consumers.
--
-- Updating both seller_proxy_configs AND catalog_listings so the
-- dashboard publish flow can render the same value the proxy uses.
-- The proxy reads from seller_proxy_configs.description_bazaar.
--
-- Apply with:
--   PGPASSWORD=… psql -h … -U … -d suverse_pay \
--     -f scripts/sql/populate_description_bazaar.sql

BEGIN;

-- ---------------- helper: dual-update per endpoint by slug ----
-- pg-mem in db tests doesn't pin slug↔proxy_config linkage the same
-- way, so we update each table independently keyed on slug.

-- ============================================================ Base ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Verified smart contract metadata on Base mainnet by address. Returns contract name, compiler version, ABI, implementation address for proxies, license, optimization runs, EVM version. AI agent contract verification, security audit, ABI lookup, Base L2 contract API.'
WHERE endpoint_slug = 'base-contract-info';

UPDATE catalog_listings SET description_bazaar =
  'Verified smart contract metadata on Base mainnet by address. Returns contract name, compiler version, ABI, implementation address for proxies, license, optimization runs, EVM version. AI agent contract verification, security audit, ABI lookup, Base L2 contract API.'
WHERE slug = 'base-contract-info';

UPDATE seller_proxy_configs SET description_bazaar =
  'Top ERC20 token holders on Base mainnet with concentration metrics. Returns holder addresses, balance, % of supply, holder count, top10 concentration, whale flags >1%. AI agent token risk scan, whale tracking, distribution analysis, pump-and-dump detection, Base L2 token holders API.'
WHERE endpoint_slug = 'base-token-holders';

UPDATE catalog_listings SET description_bazaar =
  'Top ERC20 token holders on Base mainnet with concentration metrics. Returns holder addresses, balance, % of supply, holder count, top10 concentration, whale flags >1%. AI agent token risk scan, whale tracking, distribution analysis, pump-and-dump detection, Base L2 token holders API.'
WHERE slug = 'base-token-holders';

UPDATE seller_proxy_configs SET description_bazaar =
  'Decode any Base mainnet transaction by hash. Returns invoked contracts labeled Uniswap Aerodrome Aave Compound, ERC20 transfers, ETH transfers, gas, intent summary. AI agent wallet analysis, debug failed tx, on-chain forensics, Base L2 transaction decoder API.'
WHERE endpoint_slug = 'base-tx-decoder';

UPDATE catalog_listings SET description_bazaar =
  'Decode any Base mainnet transaction by hash. Returns invoked contracts labeled Uniswap Aerodrome Aave Compound, ERC20 transfers, ETH transfers, gas, intent summary. AI agent wallet analysis, debug failed tx, on-chain forensics, Base L2 transaction decoder API.'
WHERE slug = 'base-tx-decoder';

UPDATE seller_proxy_configs SET description_bazaar =
  'Parsed Base wallet transaction history by address. Up to 20 recent tx with hash, timestamp, ETH value, token transfers, gas, type (swap/transfer/mint/nft), counterparty, summary. AI agent portfolio tracker, tax tool, trading bot, Base L2 wallet history API.'
WHERE endpoint_slug = 'base-wallet-history';

UPDATE catalog_listings SET description_bazaar =
  'Parsed Base wallet transaction history by address. Up to 20 recent tx with hash, timestamp, ETH value, token transfers, gas, type (swap/transfer/mint/nft), counterparty, summary. AI agent portfolio tracker, tax tool, trading bot, Base L2 wallet history API.'
WHERE slug = 'base-wallet-history';

UPDATE seller_proxy_configs SET description_bazaar =
  'Bitcoin spot price in USD. Pay-per-call $0.001 USDC. AI agent BTC price feed.'
WHERE endpoint_slug = 'bazaar-test';

-- bazaar-test has no catalog listing.

-- ============================================================ Bitcoin ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Bitcoin address balance + tx history. Returns confirmed BTC and sats balance, unconfirmed mempool delta, total received/spent, tx counts, up to 20 recent tx with timestamps and fees, address type (p2pkh p2sh p2wpkh p2tr). AI agent whale tracker, BTC wallet API, on-chain analytics.'
WHERE endpoint_slug = 'bitcoin-address-info';

UPDATE catalog_listings SET description_bazaar =
  'Bitcoin address balance + tx history. Returns confirmed BTC and sats balance, unconfirmed mempool delta, total received/spent, tx counts, up to 20 recent tx with timestamps and fees, address type (p2pkh p2sh p2wpkh p2tr). AI agent whale tracker, BTC wallet API, on-chain analytics.'
WHERE slug = 'bitcoin-address-info';

UPDATE seller_proxy_configs SET description_bazaar =
  'Bitcoin block info by height or hash. Returns hash, height, timestamp, tx count, total fees, miner pool ID, size, weight, difficulty, merkle root, version, nonce, up to 100 tx IDs. AI agent BTC block explorer API, network state analysis, mining metrics.'
WHERE endpoint_slug = 'bitcoin-block-info';

UPDATE catalog_listings SET description_bazaar =
  'Bitcoin block info by height or hash. Returns hash, height, timestamp, tx count, total fees, miner pool ID, size, weight, difficulty, merkle root, version, nonce, up to 100 tx IDs. AI agent BTC block explorer API, network state analysis, mining metrics.'
WHERE slug = 'bitcoin-block-info';

UPDATE seller_proxy_configs SET description_bazaar =
  'Bitcoin recommended fees real-time from mempool. sat/vByte tiers: fastest, half-hour, hour, economy, minimum. Includes mempool tx count, total size MB, total fee sats, fee histogram. AI agent BTC broadcasting bot, fee estimator API, mempool monitor.'
WHERE endpoint_slug = 'bitcoin-fees-recommended';

UPDATE catalog_listings SET description_bazaar =
  'Bitcoin recommended fees real-time from mempool. sat/vByte tiers: fastest, half-hour, hour, economy, minimum. Includes mempool tx count, total size MB, total fee sats, fee histogram. AI agent BTC broadcasting bot, fee estimator API, mempool monitor.'
WHERE slug = 'bitcoin-fees-recommended';

UPDATE seller_proxy_configs SET description_bazaar =
  'Bitcoin mempool stats real-time. Unconfirmed tx count, total vsize MB, fee histogram, avg sat/vByte, current tip height, next difficulty adjustment estimate with progress %, remaining blocks, avg block time. AI agent BTC timing bot, mempool API, network congestion data.'
WHERE endpoint_slug = 'bitcoin-mempool-stats';

UPDATE catalog_listings SET description_bazaar =
  'Bitcoin mempool stats real-time. Unconfirmed tx count, total vsize MB, fee histogram, avg sat/vByte, current tip height, next difficulty adjustment estimate with progress %, remaining blocks, avg block time. AI agent BTC timing bot, mempool API, network congestion data.'
WHERE slug = 'bitcoin-mempool-stats';

UPDATE seller_proxy_configs SET description_bazaar =
  'Decode Bitcoin transaction by txid. Inputs and outputs with addresses and amounts, total BTC, fee in sats and sat/vByte, confirmation status, block height, timestamp, size, weight, flags (coinbase RBF OP_RETURN SegWit Taproot). AI agent BTC tx decoder API, on-chain forensics.'
WHERE endpoint_slug = 'bitcoin-tx-decoder';

UPDATE catalog_listings SET description_bazaar =
  'Decode Bitcoin transaction by txid. Inputs and outputs with addresses and amounts, total BTC, fee in sats and sat/vByte, confirmation status, block height, timestamp, size, weight, flags (coinbase RBF OP_RETURN SegWit Taproot). AI agent BTC tx decoder API, on-chain forensics.'
WHERE slug = 'bitcoin-tx-decoder';

-- ============================================================ Spot prices ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Real-time Bitcoin BTC spot price in USDT from Binance. AI agent price feed, low-latency crypto quote, market data API, pay-per-call.'
WHERE endpoint_slug = 'btc-spot';

UPDATE catalog_listings SET description_bazaar =
  'Real-time Bitcoin BTC spot price in USDT from Binance. AI agent price feed, low-latency crypto quote, market data API, pay-per-call.'
WHERE slug = 'btc-spot';

UPDATE seller_proxy_configs SET description_bazaar =
  'Real-time Bitcoin BTC spot price in USD from Coinbase. AI agent price feed, exchange-rate quote, market data API, BTC-USD ticker, pay-per-call.'
WHERE endpoint_slug = 'coinbase-btc';

UPDATE catalog_listings SET description_bazaar =
  'Real-time Bitcoin BTC spot price in USD from Coinbase. AI agent price feed, exchange-rate quote, market data API, BTC-USD ticker, pay-per-call.'
WHERE slug = 'coinbase-btc';

UPDATE seller_proxy_configs SET description_bazaar =
  'Bitcoin BTC spot price in USD via CoinGecko. AI agent price feed, market data API, clean static URL, crypto price quote.'
WHERE endpoint_slug = 'coingecko-btc';

UPDATE catalog_listings SET description_bazaar =
  'Bitcoin BTC spot price in USD via CoinGecko. AI agent price feed, market data API, clean static URL, crypto price quote.'
WHERE slug = 'coingecko-btc';

-- ============================================================ Cosmos ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Cosmos chain info for Hub, Noble, Osmosis, Juno, Stride and any Cosmos SDK chain. Current block height, latest block time, avg block time, total staking supply, bonded tokens, bonded ratio, active validator count, denom count, chain ID. AI agent Cosmos monitor, IBC ecosystem API.'
WHERE endpoint_slug = 'cosmos-chain-info';

UPDATE catalog_listings SET description_bazaar =
  'Cosmos chain info for Hub, Noble, Osmosis, Juno, Stride and any Cosmos SDK chain. Current block height, latest block time, avg block time, total staking supply, bonded tokens, bonded ratio, active validator count, denom count, chain ID. AI agent Cosmos monitor, IBC ecosystem API.'
WHERE slug = 'cosmos-chain-info';

UPDATE seller_proxy_configs SET description_bazaar =
  'Track Cosmos IBC transfer by source tx hash. Source channel/port, dest channel/port, packet sequence, timeout height/timestamp, sender, receiver, denom, amount, lifecycle (sent, acknowledged, in flight, timed out). AI agent cross-chain monitor, IBC stuck-transfer debugger, Cosmos API.'
WHERE endpoint_slug = 'cosmos-ibc-tracker';

UPDATE catalog_listings SET description_bazaar =
  'Track Cosmos IBC transfer by source tx hash. Source channel/port, dest channel/port, packet sequence, timeout height/timestamp, sender, receiver, denom, amount, lifecycle (sent, acknowledged, in flight, timed out). AI agent cross-chain monitor, IBC stuck-transfer debugger, Cosmos API.'
WHERE slug = 'cosmos-ibc-tracker';

UPDATE seller_proxy_configs SET description_bazaar =
  'Decode any Cosmos SDK transaction by hash on Hub, Noble, Osmosis, Juno, Stride. Returns msg types (MsgSend, MsgTransfer, MsgDelegate), sender, receiver, amounts, fee, gas, success flag, memo, timestamp. AI agent IBC analysis, Cosmos tx decoder API, on-chain forensics.'
WHERE endpoint_slug = 'cosmos-tx-decoder';

UPDATE catalog_listings SET description_bazaar =
  'Decode any Cosmos SDK transaction by hash on Hub, Noble, Osmosis, Juno, Stride. Returns msg types (MsgSend, MsgTransfer, MsgDelegate), sender, receiver, amounts, fee, gas, success flag, memo, timestamp. AI agent IBC analysis, Cosmos tx decoder API, on-chain forensics.'
WHERE slug = 'cosmos-tx-decoder';

UPDATE seller_proxy_configs SET description_bazaar =
  'Cosmos validator stats for any Cosmos SDK chain. Operator address, moniker, bonded tokens, delegator shares, commission rate + max + max change, jailed status, bonding status, min self delegation, slashing window. AI agent staking bot, validator selection API, Cosmos delegation tool.'
WHERE endpoint_slug = 'cosmos-validator-stats';

UPDATE catalog_listings SET description_bazaar =
  'Cosmos validator stats for any Cosmos SDK chain. Operator address, moniker, bonded tokens, delegator shares, commission rate + max + max change, jailed status, bonding status, min self delegation, slashing window. AI agent staking bot, validator selection API, Cosmos delegation tool.'
WHERE slug = 'cosmos-validator-stats';

UPDATE seller_proxy_configs SET description_bazaar =
  'Cosmos wallet balance by bech32 address with chain auto-detected from prefix. Native balance + IBC token balances with raw ibc/hash denoms, IBC denom count, native flag. AI agent Cosmos portfolio tracker, IBC denom tracer, multi-chain wallet API.'
WHERE endpoint_slug = 'cosmos-wallet-balance';

UPDATE catalog_listings SET description_bazaar =
  'Cosmos wallet balance by bech32 address with chain auto-detected from prefix. Native balance + IBC token balances with raw ibc/hash denoms, IBC denom count, native flag. AI agent Cosmos portfolio tracker, IBC denom tracer, multi-chain wallet API.'
WHERE slug = 'cosmos-wallet-balance';

-- ============================================================ Ethereum ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Ethereum mainnet gas prices (safe / standard / fast tier) real-time from Etherscan V2. AI agent MEV bot, trading bot, dApp tx-timing API, ETH gas oracle, pay-per-call. Time transactions for cost efficiency.'
WHERE endpoint_slug = 'eth-gas';

UPDATE catalog_listings SET description_bazaar =
  'Ethereum mainnet gas prices (safe / standard / fast tier) real-time from Etherscan V2. AI agent MEV bot, trading bot, dApp tx-timing API, ETH gas oracle, pay-per-call. Time transactions for cost efficiency.'
WHERE slug = 'eth-gas';

UPDATE seller_proxy_configs SET description_bazaar =
  'Live DEX liquidity pools on Ethereum mainnet from GeckoTerminal — Uniswap V3, Curve, Balancer, SushiSwap and 1800+ DEXs. Pool token pair, TVL USD, 24h volume, fee tier, APR. AI agent ETH liquidity finder, DeFi pool API, arbitrage scanner.'
WHERE endpoint_slug = 'eth-pools';

UPDATE catalog_listings SET description_bazaar =
  'Live DEX liquidity pools on Ethereum mainnet from GeckoTerminal — Uniswap V3, Curve, Balancer, SushiSwap and 1800+ DEXs. Pool token pair, TVL USD, 24h volume, fee tier, APR. AI agent ETH liquidity finder, DeFi pool API, arbitrage scanner.'
WHERE slug = 'eth-pools';

UPDATE seller_proxy_configs SET description_bazaar =
  'ERC20 token risk analysis on Base mainnet. Checks ownership renounced, mint authority, blacklist functions, honeypot, top-holder concentration, 20+ security signals. 0-100 risk score with red/green flags. AI agent scam detector, DeFi due diligence, token safety API, Base L2.'
WHERE endpoint_slug = 'evm-token-risk-base';

UPDATE catalog_listings SET description_bazaar =
  'ERC20 token risk analysis on Base mainnet. Checks ownership renounced, mint authority, blacklist functions, honeypot, top-holder concentration, 20+ security signals. 0-100 risk score with red/green flags. AI agent scam detector, DeFi due diligence, token safety API, Base L2.'
WHERE slug = 'evm-token-risk-base';

-- ============================================================ Misc ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Real-time forex exchange rates for 170+ currencies with USD base. Daily updates from ExchangeRate-API open data. AI agent international payment calculator, cross-border FX, finance dashboard, currency converter API, pay-per-call USDC.'
WHERE endpoint_slug = 'forex';

UPDATE catalog_listings SET description_bazaar =
  'Real-time forex exchange rates for 170+ currencies with USD base. Daily updates from ExchangeRate-API open data. AI agent international payment calculator, cross-border FX, finance dashboard, currency converter API, pay-per-call USDC.'
WHERE slug = 'forex';

UPDATE seller_proxy_configs SET description_bazaar =
  'IP geolocation lookup for the requesting IP. Returns country, region, city, timezone, ISP, ASN. Powered by ipwho.is. AI agent fraud detection, localization, geo-context API, IP-to-country, IP-to-city, pay-per-call USDC.'
WHERE endpoint_slug = 'geo';

UPDATE catalog_listings SET description_bazaar =
  'IP geolocation lookup for the requesting IP. Returns country, region, city, timezone, ISP, ASN. Powered by ipwho.is. AI agent fraud detection, localization, geo-context API, IP-to-country, IP-to-city, pay-per-call USDC.'
WHERE slug = 'geo';

UPDATE seller_proxy_configs SET description_bazaar =
  'Current Bitcoin BTC and Ethereum ETH spot prices in USD from CoinGecko. AI agent dual price feed, BTC-USD ETH-USD ticker, market data API, pay-per-call USDC.'
WHERE endpoint_slug = 'prices';

UPDATE catalog_listings SET description_bazaar =
  'Current Bitcoin BTC and Ethereum ETH spot prices in USD from CoinGecko. AI agent dual price feed, BTC-USD ETH-USD ticker, market data API, pay-per-call USDC.'
WHERE slug = 'prices';

-- ============================================================ Solana ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Decode any Solana transaction by signature into human-readable summary. Invoked programs (Jupiter, Raydium, Orca, SPL Token), token balance changes, fees in SOL and USD, instruction flow, one-line summary. AI agent wallet analysis, swap debugger, Solana tx decoder API.'
WHERE endpoint_slug = 'solana-tx-decoder';

UPDATE catalog_listings SET description_bazaar =
  'Decode any Solana transaction by signature into human-readable summary. Invoked programs (Jupiter, Raydium, Orca, SPL Token), token balance changes, fees in SOL and USD, instruction flow, one-line summary. AI agent wallet analysis, swap debugger, Solana tx decoder API.'
WHERE slug = 'solana-tx-decoder';

UPDATE seller_proxy_configs SET description_bazaar =
  'Simulate Solana transaction before mainnet broadcast. Success/failure, compute units consumed, program logs, accounts touched, detailed errors. AI agent trading bot validation, MEV sandwich check, wallet UX guard, DeFi multi-step test, Solana simulate API.'
WHERE endpoint_slug = 'solana-tx-simulator';

UPDATE catalog_listings SET description_bazaar =
  'Simulate Solana transaction before mainnet broadcast. Success/failure, compute units consumed, program logs, accounts touched, detailed errors. AI agent trading bot validation, MEV sandwich check, wallet UX guard, DeFi multi-step test, Solana simulate API.'
WHERE slug = 'solana-tx-simulator';

UPDATE seller_proxy_configs SET description_bazaar =
  'Solana SPL token risk analysis in milliseconds. Mint authority renounced, freeze authority, top-holder concentration, liquidity depth, market cap, token age, 20+ security signals. 0-100 risk score with rug-pull and legitimacy flags. AI agent scam detector, sniper bot filter, SPL safety API.'
WHERE endpoint_slug = 'spl-token-safety-check';

UPDATE catalog_listings SET description_bazaar =
  'Solana SPL token risk analysis in milliseconds. Mint authority renounced, freeze authority, top-holder concentration, liquidity depth, market cap, token age, 20+ security signals. 0-100 risk score with rug-pull and legitimacy flags. AI agent scam detector, sniper bot filter, SPL safety API.'
WHERE slug = 'spl-token-safety-check';

-- ============================================================ Suverse Base/Solana DEX pools ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Top liquidity pools on Base mainnet across Uniswap V3, Aerodrome, BaseSwap. Each pool token pair, TVL USD, 24h volume, fee tier, APR. AI agent Base liquidity finder, L2 DEX pool API, new-pool tracker, routing source. Real-time from GeckoTerminal.'
WHERE endpoint_slug = 'suverse-base-dex-pools';

UPDATE catalog_listings SET description_bazaar =
  'Top liquidity pools on Base mainnet across Uniswap V3, Aerodrome, BaseSwap. Each pool token pair, TVL USD, 24h volume, fee tier, APR. AI agent Base liquidity finder, L2 DEX pool API, new-pool tracker, routing source. Real-time from GeckoTerminal.'
WHERE slug = 'suverse-base-dex-pools';

-- ============================================================ Suverse swap (matches swap-quote-x402.ts) ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Bidirectional ERC20 token swap aggregator on Base mainnet via LiFi routing across 20+ DEXs (Uniswap V3, Aerodrome, BaseSwap, SushiSwap). USDC to WETH AERO DEGEN BRETT TOSHI cbETH cbBTC or any ERC20, and reverse to USDC. Two-step quote/execute x402 flow. 1% fee. AI agent swap. L2 DEX.'
WHERE endpoint_slug = 'suverse-base-swap';

UPDATE catalog_listings SET description_bazaar =
  'Bidirectional ERC20 token swap aggregator on Base mainnet via LiFi routing across 20+ DEXs (Uniswap V3, Aerodrome, BaseSwap, SushiSwap). USDC to WETH AERO DEGEN BRETT TOSHI cbETH cbBTC or any ERC20, and reverse to USDC. Two-step quote/execute x402 flow. 1% fee. AI agent swap. L2 DEX.'
WHERE slug = 'suverse-base-swap';

UPDATE seller_proxy_configs SET description_bazaar =
  'Bidirectional SPL token swap aggregator on Solana mainnet via Jupiter v6 routing across 30+ DEXs (Raydium, Orca, Meteora, Phoenix). USDC to BONK WIF POPCAT JUP RAY ORCA SOL MEW BOME or any SPL, and reverse to USDC. Two-step quote/execute x402 flow. 1% fee. AI agent swap. memecoin DEX.'
WHERE endpoint_slug = 'suverse-solana-swap';

UPDATE catalog_listings SET description_bazaar =
  'Bidirectional SPL token swap aggregator on Solana mainnet via Jupiter v6 routing across 30+ DEXs (Raydium, Orca, Meteora, Phoenix). USDC to BONK WIF POPCAT JUP RAY ORCA SOL MEW BOME or any SPL, and reverse to USDC. Two-step quote/execute x402 flow. 1% fee. AI agent swap. memecoin DEX.'
WHERE slug = 'suverse-solana-swap';

-- ============================================================ Binance ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Binance spot order book snapshot for any trading pair. Top bids and asks with price/quantity, total bid depth, total ask depth, imbalance ratio. AI agent market pressure detection, MEV arbitrage, price-impact calculator, microstructure API, real-time L2.'
WHERE endpoint_slug = 'suverse-binance-orderbook';

UPDATE catalog_listings SET description_bazaar =
  'Binance spot order book snapshot for any trading pair. Top bids and asks with price/quantity, total bid depth, total ask depth, imbalance ratio. AI agent market pressure detection, MEV arbitrage, price-impact calculator, microstructure API, real-time L2.'
WHERE slug = 'suverse-binance-orderbook';

UPDATE seller_proxy_configs SET description_bazaar =
  'Last 100 executed trades for any Binance spot pair. Price, quantity, buy/sell side, ms timestamp. AI agent whale tracker, VWAP calculator, tape-reading bot, tick-level analysis. Real-time public trade data from the largest crypto spot exchange.'
WHERE endpoint_slug = 'suverse-binance-trades';

UPDATE catalog_listings SET description_bazaar =
  'Last 100 executed trades for any Binance spot pair. Price, quantity, buy/sell side, ms timestamp. AI agent whale tracker, VWAP calculator, tape-reading bot, tick-level analysis. Real-time public trade data from the largest crypto spot exchange.'
WHERE slug = 'suverse-binance-trades';

-- ============================================================ Suverse crypto ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Top 10 24h gainers + top 10 24h losers in crypto by % change with market cap floor to filter micro-cap noise. Returns price, market cap, volume, 24h change per coin. AI agent momentum detector, news-driven mover finder, sector rotation API, real-time movers.'
WHERE endpoint_slug = 'suverse-crypto-24h-movers';

UPDATE catalog_listings SET description_bazaar =
  'Top 10 24h gainers + top 10 24h losers in crypto by % change with market cap floor to filter micro-cap noise. Returns price, market cap, volume, 24h change per coin. AI agent momentum detector, news-driven mover finder, sector rotation API, real-time movers.'
WHERE slug = 'suverse-crypto-24h-movers';

UPDATE seller_proxy_configs SET description_bazaar =
  'Top N crypto by market cap with price, 24h volume, 1h/24h/7d/30d % changes, fully diluted valuation, circulating supply, ATH/ATL, dominance. AI agent leaderboard, opportunity screener, market report, momentum tracker. 10-250 coins per call. CoinGecko data.'
WHERE endpoint_slug = 'suverse-crypto-market-rankings';

UPDATE catalog_listings SET description_bazaar =
  'Top N crypto by market cap with price, 24h volume, 1h/24h/7d/30d % changes, fully diluted valuation, circulating supply, ATH/ATL, dominance. AI agent leaderboard, opportunity screener, market report, momentum tracker. 10-250 coins per call. CoinGecko data.'
WHERE slug = 'suverse-crypto-market-rankings';

UPDATE seller_proxy_configs SET description_bazaar =
  'Daily OHLC candle bars (open/high/low/close) for any coin up to 365 days back. Timestamp + OHLC per day. AI agent technical analysis, backtest, chart generator, volatility calculator, pattern recognition. Standard format for all TA libraries. CoinGecko.'
WHERE endpoint_slug = 'suverse-crypto-ohlc-history';

UPDATE catalog_listings SET description_bazaar =
  'Daily OHLC candle bars (open/high/low/close) for any coin up to 365 days back. Timestamp + OHLC per day. AI agent technical analysis, backtest, chart generator, volatility calculator, pattern recognition. Standard format for all TA libraries. CoinGecko.'
WHERE slug = 'suverse-crypto-ohlc-history';

UPDATE seller_proxy_configs SET description_bazaar =
  'Current USD prices for up to 50 coin IDs in one call. Price, 24h change, market cap, 24h volume per coin. AI agent portfolio tracker, watchlist bot, dashboard refresher, comparative analytics. 17,000+ tokens via CoinGecko. Batch crypto price API.'
WHERE endpoint_slug = 'suverse-crypto-price-batch';

UPDATE catalog_listings SET description_bazaar =
  'Current USD prices for up to 50 coin IDs in one call. Price, 24h change, market cap, 24h volume per coin. AI agent portfolio tracker, watchlist bot, dashboard refresher, comparative analytics. 17,000+ tokens via CoinGecko. Batch crypto price API.'
WHERE slug = 'suverse-crypto-price-batch';

UPDATE seller_proxy_configs SET description_bazaar =
  'Top 7 trending crypto by user searches on CoinGecko in the last 24h. Sentiment/hype signal showing what is capturing retail attention before price moves. Name, symbol, market cap rank, price, thumbnail. AI agent attention shift detector, memecoin emergence radar.'
WHERE endpoint_slug = 'suverse-crypto-trending';

UPDATE catalog_listings SET description_bazaar =
  'Top 7 trending crypto by user searches on CoinGecko in the last 24h. Sentiment/hype signal showing what is capturing retail attention before price moves. Name, symbol, market cap rank, price, thumbnail. AI agent attention shift detector, memecoin emergence radar.'
WHERE slug = 'suverse-crypto-trending';

-- ============================================================ Suverse DeFi ====

UPDATE seller_proxy_configs SET description_bazaar =
  'DeFi protocol fee revenue (24h, 7d, 30d) ranked by earnings. Protocol name, category, fees collected, treasury revenue, growth metrics. AI agent profitability ranker, business-model comparator, fee-vs-revenue analyzer, DeFi valuation API. 200+ protocols.'
WHERE endpoint_slug = 'suverse-defi-fees';

UPDATE catalog_listings SET description_bazaar =
  'DeFi protocol fee revenue (24h, 7d, 30d) ranked by earnings. Protocol name, category, fees collected, treasury revenue, growth metrics. AI agent profitability ranker, business-model comparator, fee-vs-revenue analyzer, DeFi valuation API. 200+ protocols.'
WHERE slug = 'suverse-defi-fees';

UPDATE seller_proxy_configs SET description_bazaar =
  'Historical 90-day TVL for any DeFi protocol — Aave, Uniswap, Lido, Curve, MakerDAO, Compound and 3000+ more. Daily TVL points. AI agent protocol growth analyzer, competitive positioning tool, capital-outflow detector, DeFi dashboard. DeFiLlama-powered TVL API.'
WHERE endpoint_slug = 'suverse-defi-protocol-tvl';

UPDATE catalog_listings SET description_bazaar =
  'Historical 90-day TVL for any DeFi protocol — Aave, Uniswap, Lido, Curve, MakerDAO, Compound and 3000+ more. Daily TVL points. AI agent protocol growth analyzer, competitive positioning tool, capital-outflow detector, DeFi dashboard. DeFiLlama-powered TVL API.'
WHERE slug = 'suverse-defi-protocol-tvl';

UPDATE seller_proxy_configs SET description_bazaar =
  'Total Value Locked TVL per blockchain where DeFi exists. Chain name, current TVL USD, 24h change, 7d change, chain ID. AI agent chain growth tracker, capital rotation analyzer, Ethereum vs L2 market share, emerging ecosystem detector. 300+ chains. DeFiLlama.'
WHERE endpoint_slug = 'suverse-defi-tvl-chain';

UPDATE catalog_listings SET description_bazaar =
  'Total Value Locked TVL per blockchain where DeFi exists. Chain name, current TVL USD, 24h change, 7d change, chain ID. AI agent chain growth tracker, capital rotation analyzer, Ethereum vs L2 market share, emerging ecosystem detector. 300+ chains. DeFiLlama.'
WHERE slug = 'suverse-defi-tvl-chain';

UPDATE seller_proxy_configs SET description_bazaar =
  'Top DeFi yield farming pools by APY across 800+ protocols on all chains. Pool name, project, chain, TVL USD, current APY, base APY, reward APY, IL risk, stablecoin flag. AI agent yield bot, portfolio rebalancer, yield aggregator, treasury manager. Filter by min TVL.'
WHERE endpoint_slug = 'suverse-defi-yield-pools';

UPDATE catalog_listings SET description_bazaar =
  'Top DeFi yield farming pools by APY across 800+ protocols on all chains. Pool name, project, chain, TVL USD, current APY, base APY, reward APY, IL risk, stablecoin flag. AI agent yield bot, portfolio rebalancer, yield aggregator, treasury manager. Filter by min TVL.'
WHERE slug = 'suverse-defi-yield-pools';

-- ============================================================ Sentiment, Forex, Metals, NFT, Macro ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Crypto fear and greed sentiment index (0 extreme fear to 100 extreme greed) with classification label, 30-day history for trend analysis, timestamp. AI agent sentiment extreme detector, contrarian signal, risk-management trigger, market mood API.'
WHERE endpoint_slug = 'suverse-fear-greed-index';

UPDATE catalog_listings SET description_bazaar =
  'Crypto fear and greed sentiment index (0 extreme fear to 100 extreme greed) with classification label, 30-day history for trend analysis, timestamp. AI agent sentiment extreme detector, contrarian signal, risk-management trigger, market mood API.'
WHERE slug = 'suverse-fear-greed-index';

UPDATE seller_proxy_configs SET description_bazaar =
  'Historical daily ECB FX rate for any currency pair on any date going back to 1999. Covers major + emerging currencies USD EUR GBP JPY CHF AUD CAD CNY. AI agent historical tx reconciliation, returns computation, regulatory reporting, forex backtest API.'
WHERE endpoint_slug = 'suverse-forex-historical';

UPDATE catalog_listings SET description_bazaar =
  'Historical daily ECB FX rate for any currency pair on any date going back to 1999. Covers major + emerging currencies USD EUR GBP JPY CHF AUD CAD CNY. AI agent historical tx reconciliation, returns computation, regulatory reporting, forex backtest API.'
WHERE slug = 'suverse-forex-historical';

UPDATE seller_proxy_configs SET description_bazaar =
  'Current FX rates for up to 30 currency pairs in one call with last-update date. USD EUR GBP JPY CHF AUD CAD CNY plus EM currencies. AI agent cross-border calculator, forex arbitrage detector, international portfolio valuation, batch currency API.'
WHERE endpoint_slug = 'suverse-forex-rates';

UPDATE catalog_listings SET description_bazaar =
  'Current FX rates for up to 30 currency pairs in one call with last-update date. USD EUR GBP JPY CHF AUD CAD CNY plus EM currencies. AI agent cross-border calculator, forex arbitrage detector, international portfolio valuation, batch currency API.'
WHERE slug = 'suverse-forex-rates';

UPDATE seller_proxy_configs SET description_bazaar =
  'Comprehensive metadata for any Solana NFT or compressed NFT (cNFT). Name, symbol, image, collection, creators with royalties, attributes, ownership, mutability, on-chain authorities. Metaplex + DAS standards. AI agent NFT browser, marketplace bot, wallet portfolio, Solana NFT API.'
WHERE endpoint_slug = 'suverse-nft-metadata';

UPDATE catalog_listings SET description_bazaar =
  'Comprehensive metadata for any Solana NFT or compressed NFT (cNFT). Name, symbol, image, collection, creators with royalties, attributes, ownership, mutability, on-chain authorities. Metaplex + DAS standards. AI agent NFT browser, marketplace bot, wallet portfolio, Solana NFT API.'
WHERE slug = 'suverse-nft-metadata';

UPDATE seller_proxy_configs SET description_bazaar =
  'Crude oil spot prices in USD per barrel: WTI NYMEX and Brent ICE front-month futures with OHLC and Brent-WTI spread. AI agent energy market analyzer, geopolitical risk tracker, inflation indicator, energy sector trader, macro correlation API.'
WHERE endpoint_slug = 'suverse-oil-prices';

UPDATE catalog_listings SET description_bazaar =
  'Crude oil spot prices in USD per barrel: WTI NYMEX and Brent ICE front-month futures with OHLC and Brent-WTI spread. AI agent energy market analyzer, geopolitical risk tracker, inflation indicator, energy sector trader, macro correlation API.'
WHERE slug = 'suverse-oil-prices';

UPDATE seller_proxy_configs SET description_bazaar =
  'Binance Futures perpetual funding rate for any contract. Mark price, index price, mark-index spread, next funding timestamp, predicted rate, funding history. AI agent perp trader, basis-trade bot, funding-arb detector, leverage-flush monitor, sentiment quantifier.'
WHERE endpoint_slug = 'suverse-perp-funding';

UPDATE catalog_listings SET description_bazaar =
  'Binance Futures perpetual funding rate for any contract. Mark price, index price, mark-index spread, next funding timestamp, predicted rate, funding history. AI agent perp trader, basis-trade bot, funding-arb detector, leverage-flush monitor, sentiment quantifier.'
WHERE slug = 'suverse-perp-funding';

UPDATE seller_proxy_configs SET description_bazaar =
  'Batch funding rates for multiple Binance Futures perps in one call. Per-symbol mark price, funding rate, next funding timestamp, predicted next rate. AI agent funding arbitrage, multi-pair basis trader, market maker funding skew, hedge bot, batch perp API.'
WHERE endpoint_slug = 'suverse-perp-funding-batch';

UPDATE catalog_listings SET description_bazaar =
  'Batch funding rates for multiple Binance Futures perps in one call. Per-symbol mark price, funding rate, next funding timestamp, predicted next rate. AI agent funding arbitrage, multi-pair basis trader, market maker funding skew, hedge bot, batch perp API.'
WHERE slug = 'suverse-perp-funding-batch';

UPDATE seller_proxy_configs SET description_bazaar =
  'Open interest for any Binance Futures perpetual with 24h change %, USD notional, 5-minute OI history over last 24 hours. AI agent leverage buildup detector, squeeze-setup finder, funding-pressure precursor, position monitoring, perp OI API.'
WHERE endpoint_slug = 'suverse-perp-open-interest';

UPDATE catalog_listings SET description_bazaar =
  'Open interest for any Binance Futures perpetual with 24h change %, USD notional, 5-minute OI history over last 24 hours. AI agent leverage buildup detector, squeeze-setup finder, funding-pressure precursor, position monitoring, perp OI API.'
WHERE slug = 'suverse-perp-open-interest';

UPDATE seller_proxy_configs SET description_bazaar =
  'Spot prices in USD per troy ounce for gold XAU, silver XAG, platinum XPT, palladium XPD with latest OHLC from Stooq. AI agent precious-metals tracker, gold-bitcoin ratio analyst, inflation hedge, diversification calculator, macro asset API.'
WHERE endpoint_slug = 'suverse-precious-metals';

UPDATE catalog_listings SET description_bazaar =
  'Spot prices in USD per troy ounce for gold XAU, silver XAG, platinum XPT, palladium XPD with latest OHLC from Stooq. AI agent precious-metals tracker, gold-bitcoin ratio analyst, inflation hedge, diversification calculator, macro asset API.'
WHERE slug = 'suverse-precious-metals';

UPDATE seller_proxy_configs SET description_bazaar =
  'Latest SEC EDGAR filings for any US-listed company: 10K annual, 10Q quarterly, 8K material events, S1 IPO, Form 4 insider transactions. Returns date, form type, accession number, direct filing URL. AI agent corporate event tracker, insider activity bot, equity research API.'
WHERE endpoint_slug = 'suverse-sec-filings';

UPDATE catalog_listings SET description_bazaar =
  'Latest SEC EDGAR filings for any US-listed company: 10K annual, 10Q quarterly, 8K material events, S1 IPO, Form 4 insider transactions. Returns date, form type, accession number, direct filing URL. AI agent corporate event tracker, insider activity bot, equity research API.'
WHERE slug = 'suverse-sec-filings';

-- ============================================================ Suverse Solana extras ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Top Solana DEX liquidity pools across Raydium, Orca, Meteora and others. Token pair, TVL USD, 24h volume, fee tier, current price. AI agent Solana liquidity finder, MEV searcher, arbitrage bot, Jupiter aggregator user, SPL DEX API. Concentrated + standard pools.'
WHERE endpoint_slug = 'suverse-solana-dex-pools';

UPDATE catalog_listings SET description_bazaar =
  'Top Solana DEX liquidity pools across Raydium, Orca, Meteora and others. Token pair, TVL USD, 24h volume, fee tier, current price. AI agent Solana liquidity finder, MEV searcher, arbitrage bot, Jupiter aggregator user, SPL DEX API. Concentrated + standard pools.'
WHERE slug = 'suverse-solana-dex-pools';

UPDATE seller_proxy_configs SET description_bazaar =
  'Solana priority fee recommendations real-time. Micro-lamports per compute unit across percentiles (min, low, medium, high, veryHigh, unsafeMax) from recent congestion. AI agent fast-inclusion trading bot, payment cost optimizer, dApp UX tuner, priority fee API. Avoid underpriced failed tx.'
WHERE endpoint_slug = 'suverse-solana-priority-fee';

UPDATE catalog_listings SET description_bazaar =
  'Solana priority fee recommendations real-time. Micro-lamports per compute unit across percentiles (min, low, medium, high, veryHigh, unsafeMax) from recent congestion. AI agent fast-inclusion trading bot, payment cost optimizer, dApp UX tuner, priority fee API. Avoid underpriced failed tx.'
WHERE slug = 'suverse-solana-priority-fee';

UPDATE seller_proxy_configs SET description_bazaar =
  'Decode any Solana transaction by signature into structured human-readable summary. Invoked programs, token balance changes, fees in SOL and USD, instruction flow, one-line summary. Powered by SuVerse infrastructure on Solana mainnet. AI agent tx decoder API.'
WHERE endpoint_slug = 'suverse-solana-tx-decoder';

UPDATE catalog_listings SET description_bazaar =
  'Decode any Solana transaction by signature into structured human-readable summary. Invoked programs, token balance changes, fees in SOL and USD, instruction flow, one-line summary. Powered by SuVerse infrastructure on Solana mainnet. AI agent tx decoder API.'
WHERE slug = 'suverse-solana-tx-decoder';

UPDATE seller_proxy_configs SET description_bazaar =
  'Simulate Solana transaction before broadcasting to mainnet. Success/failure, compute units consumed, program logs, accounts touched, detailed error messages. AI agent trading bot validation, MEV check, wallet UX guard, DeFi multi-step test, Solana simulate API.'
WHERE endpoint_slug = 'suverse-solana-tx-simulator';

UPDATE catalog_listings SET description_bazaar =
  'Simulate Solana transaction before broadcasting to mainnet. Success/failure, compute units consumed, program logs, accounts touched, detailed error messages. AI agent trading bot validation, MEV check, wallet UX guard, DeFi multi-step test, Solana simulate API.'
WHERE slug = 'suverse-solana-tx-simulator';

UPDATE seller_proxy_configs SET description_bazaar =
  'Stablecoin circulating supply + per-chain distribution for USDT USDC DAI FDUSD PYUSD TUSD FRAX. Total supply, by-chain breakdown (Ethereum Tron BSC Solana Base Arbitrum), peg deviation, 30d supply change. AI agent dollar liquidity migration tracker, capital flow API.'
WHERE endpoint_slug = 'suverse-stablecoin-supply';

UPDATE catalog_listings SET description_bazaar =
  'Stablecoin circulating supply + per-chain distribution for USDT USDC DAI FDUSD PYUSD TUSD FRAX. Total supply, by-chain breakdown (Ethereum Tron BSC Solana Base Arbitrum), peg deviation, 30d supply change. AI agent dollar liquidity migration tracker, capital flow API.'
WHERE slug = 'suverse-stablecoin-supply';

-- ============================================================ TA on Binance ====

UPDATE seller_proxy_configs SET description_bazaar =
  'MACD 12-26-9 with signal line and histogram on any Binance spot pair and timeframe. Current MACD value, signal, histogram, bullish/bearish crossover within last 5 periods, trend strength. AI agent trend reversal detector, momentum confirmation, divergence finder, TA API.'
WHERE endpoint_slug = 'suverse-ta-macd';

UPDATE catalog_listings SET description_bazaar =
  'MACD 12-26-9 with signal line and histogram on any Binance spot pair and timeframe. Current MACD value, signal, histogram, bullish/bearish crossover within last 5 periods, trend strength. AI agent trend reversal detector, momentum confirmation, divergence finder, TA API.'
WHERE slug = 'suverse-ta-macd';

UPDATE seller_proxy_configs SET description_bazaar =
  'SMA + EMA at 20, 50, 200 periods for any Binance pair on any timeframe. Current price, all six MAs, golden cross / death cross detection within last 10 periods, above/below 200 SMA trend flag. AI agent trend-following bot, dynamic support-resistance, TA API.'
WHERE endpoint_slug = 'suverse-ta-moving-averages';

UPDATE catalog_listings SET description_bazaar =
  'SMA + EMA at 20, 50, 200 periods for any Binance pair on any timeframe. Current price, all six MAs, golden cross / death cross detection within last 10 periods, above/below 200 SMA trend flag. AI agent trend-following bot, dynamic support-resistance, TA API.'
WHERE slug = 'suverse-ta-moving-averages';

UPDATE seller_proxy_configs SET description_bazaar =
  'Wilder RSI 14 for any Binance spot pair on any timeframe 1m to 1w. Current RSI value, overbought >70 / oversold <30 signal, trend direction, last 50 RSI points for chart. AI agent momentum reversal detector, swing entry zone finder, TA API.'
WHERE endpoint_slug = 'suverse-ta-rsi';

UPDATE catalog_listings SET description_bazaar =
  'Wilder RSI 14 for any Binance spot pair on any timeframe 1m to 1w. Current RSI value, overbought >70 / oversold <30 signal, trend direction, last 50 RSI points for chart. AI agent momentum reversal detector, swing entry zone finder, TA API.'
WHERE slug = 'suverse-ta-rsi';

-- ============================================================ Suverse wallet history ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Parsed Solana wallet transaction history by address. Recent tx with human-readable descriptions, types (SWAP, TRANSFER, NFT_SALE), token transfers, native SOL transfers, fees, timestamps. Pagination via before/until. AI agent portfolio manager, tax tool, Solana wallet API.'
WHERE endpoint_slug = 'suverse-wallet-history';

UPDATE catalog_listings SET description_bazaar =
  'Parsed Solana wallet transaction history by address. Recent tx with human-readable descriptions, types (SWAP, TRANSFER, NFT_SALE), token transfers, native SOL transfers, fees, timestamps. Pagination via before/until. AI agent portfolio manager, tax tool, Solana wallet API.'
WHERE slug = 'suverse-wallet-history';

-- ============================================================ TVL, Weather ====

UPDATE seller_proxy_configs SET description_bazaar =
  'Real-time Total Value Locked TVL for 7000+ DeFi protocols across 500+ networks. Powered by DeFiLlama. AI agent DeFi protocol ranker, multi-chain TVL aggregator, capital flow monitor, pay-per-call USDC.'
WHERE endpoint_slug = 'tvl';

UPDATE catalog_listings SET description_bazaar =
  'Real-time Total Value Locked TVL for 7000+ DeFi protocols across 500+ networks. Powered by DeFiLlama. AI agent DeFi protocol ranker, multi-chain TVL aggregator, capital flow monitor, pay-per-call USDC.'
WHERE slug = 'tvl';

UPDATE seller_proxy_configs SET description_bazaar =
  'Free weather data from Open-Meteo. Current temperature, conditions, wind for any location (default NYC, customizable via query params). No upstream API key. AI agent travel context, logistics weather, local recommendation, geocoded forecast API.'
WHERE endpoint_slug = 'weather';

UPDATE catalog_listings SET description_bazaar =
  'Free weather data from Open-Meteo. Current temperature, conditions, wind for any location (default NYC, customizable via query params). No upstream API key. AI agent travel context, logistics weather, local recommendation, geocoded forecast API.'
WHERE slug = 'weather';

-- ============================================================ Inactive but listed ====

UPDATE seller_proxy_configs SET description_bazaar =
  '24h bridge transfer volumes for major cross-chain bridges including Stargate, Across, cBridge, Synapse, Hop, Polygon Bridge, Wormhole. Volume in USD per bridge, top routes, cumulative volumes. AI agent cross-chain capital flow tracker, bridge analytics API, multichain monitor.'
WHERE endpoint_slug = 'suverse-bridge-volumes';

UPDATE catalog_listings SET description_bazaar =
  '24h bridge transfer volumes for major cross-chain bridges including Stargate, Across, cBridge, Synapse, Hop, Polygon Bridge, Wormhole. Volume in USD per bridge, top routes, cumulative volumes. AI agent cross-chain capital flow tracker, bridge analytics API, multichain monitor.'
WHERE slug = 'suverse-bridge-volumes';

UPDATE seller_proxy_configs SET description_bazaar =
  'Live quote for any US-listed stock by ticker. Price, day open/high/low, volume, change %, market cap, P/E, dividend yield, 52-week high/low, exchange. AI agent equity tracker, stock dashboard, trading bot, US equity quote API.'
WHERE endpoint_slug = 'suverse-stock-quote';

UPDATE catalog_listings SET description_bazaar =
  'Live quote for any US-listed stock by ticker. Price, day open/high/low, volume, change %, market cap, P/E, dividend yield, 52-week high/low, exchange. AI agent equity tracker, stock dashboard, trading bot, US equity quote API.'
WHERE slug = 'suverse-stock-quote';

UPDATE seller_proxy_configs SET description_bazaar =
  'Live quotes for up to 50 US-listed stock tickers in one call. Price, prior close, change, change %, volume per ticker. AI agent portfolio tracker, equity watchlist bot, dashboard refresher, batch US stocks API, multi-ticker quote.'
WHERE endpoint_slug = 'suverse-stock-batch-quotes';

UPDATE catalog_listings SET description_bazaar =
  'Live quotes for up to 50 US-listed stock tickers in one call. Price, prior close, change, change %, volume per ticker. AI agent portfolio tracker, equity watchlist bot, dashboard refresher, batch US stocks API, multi-ticker quote.'
WHERE slug = 'suverse-stock-batch-quotes';

-- ============================================================ Cross-table sync ====

-- catalog_listings.slug ≠ seller_proxy_configs.endpoint_slug for the
-- pre-publish-redesign rows (auto-generated `<topic>-<6hex>` slugs).
-- Where the FK proxy_config_id is set, mirror the proxy's
-- description_bazaar onto the linked listing so the public catalog
-- API and the dashboard show the same string the proxy emits to CDP.

UPDATE catalog_listings cl
   SET description_bazaar = spc.description_bazaar
  FROM seller_proxy_configs spc
 WHERE cl.proxy_config_id = spc.id
   AND cl.description_bazaar IS NULL
   AND spc.description_bazaar IS NOT NULL;

COMMIT;

-- ============================================================ Sanity ====

-- All description_bazaar rows should be <= 320 chars (column constraint).
SELECT count(*) AS proxies_populated FROM seller_proxy_configs WHERE description_bazaar IS NOT NULL;
SELECT count(*) AS listings_populated FROM catalog_listings WHERE description_bazaar IS NOT NULL;
SELECT max(length(description_bazaar)) AS max_proxy_len FROM seller_proxy_configs;
SELECT max(length(description_bazaar)) AS max_listing_len FROM catalog_listings;
