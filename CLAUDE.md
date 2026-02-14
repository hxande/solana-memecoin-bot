# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start              # Start all modules (ts-node src/index.ts)
npm run dev            # Start with auto-restart on file changes (ts-node-dev)
npm run build          # Compile TypeScript to dist/
npm run sniper         # Run only the Raydium sniper module
npm run tracker        # Run only the wallet tracker (copy-trading)
npm run monitor        # Run only the token monitor (on-chain filters)
npm run backtest       # Run backtester with historical data
npx tsc --noEmit       # Type-check without emitting (no linter/test framework configured)
```

## Architecture

This is a Solana memecoin trading bot built with TypeScript. It runs six concurrent trading modules orchestrated by `src/index.ts`, with a web dashboard and Telegram alerts.

### Core Layer (`src/core/`)

- **connection.ts** — Exports singleton `connection` (Solana RPC via Helius) and `wallet` (Keypair from `PRIVATE_KEY` env). Validates credentials on import and exits the process if invalid.
- **jupiter.ts** — `JupiterSwap` class: executes buys/sells through Jupiter Aggregator v6 (`quote` + `swap` endpoints). Also provides `getPrice()` via Birdeye API. Used by most modules for trades on Raydium/Orca/Meteora.
- **pumpSwap.ts** — `PumpSwap` class: executes buys/sells directly on Pump.fun's bonding curve program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`). Reads bonding curve PDA state, calculates AMM math (constant product), builds raw transactions. Falls back to Jupiter after migration.
- **storage.ts** — `Storage` singleton: JSON file persistence in `./data/`. Debounced writes (1-5s), atomic tmp+rename, corruption recovery with `.bak` files. In-memory cache layer. Exports `storage` singleton. Call `storage.flush()` before shutdown.
- **alerts.ts** — Telegram notifications via Telegraf. Gracefully degrades if Telegram token is not configured. Always logs to console.

### Module Layer (`src/modules/`)

All modules are classes with a `start()` method. They are instantiated and started in parallel by `index.ts`.

- **sniper.ts** — `SniperModule`: Polls Helius for Raydium AMM (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`) new pool transactions. Scores tokens 0-100 with safety filters (liquidity, holders, mint/freeze authority, blacklist). Buys via Jupiter if score >= 70.
- **pumpfun.ts** — `PumpFunModule`: Connects to Pump.fun WebSocket (`wss://pumpportal.fun/api/data`). Four strategies: earlySnipe, bondingCurvePlay, migrationSnipe, socialMomentum. Buys via PumpSwap (on-curve) or Jupiter (post-migration). Auto-blacklists serial deployers.
- **walletTracker.ts** — `WalletTracker`: Polls `getSignaturesForAddress` every 2s for tracked wallets. Detects swaps by comparing pre/post token balances. Copies trades proportionally. Wallets loaded from `data/wallets.json`.
- **tokenMonitor.ts** — `TokenMonitor`: Scores trending tokens from Birdeye across safety/liquidity/community/momentum (max 100). Alerts on score >= 60.
- **socialSentiment.ts** — `SocialSentimentModule`: Twitter API (optional), DexScreener boosts, Birdeye social scores. Detects influencer calls, narrative emergence, and trend velocity spikes. Persists influencers and narratives to disk.
- **positionManager.ts** — `PositionManager`: Monitors open positions every 10s. Enforces TP (default +100%) and SL (default -50%). Positions persist across restarts.
- **backtester.ts** — `Backtester`: Tests strategies against historical Birdeye data. Calculates win rate, Sharpe ratio, max drawdown.

### Dashboard (`src/dashboard/server.ts`)

Express + WebSocket server. REST API on `DASHBOARD_PORT` (default 3000). Real-time alerts via WS. Endpoints for positions, trades, config, wallets, blacklist, influencers, storage stats. Config changes via POST persist to `data/config.json` and override `.env` values.

### Shared Types (`src/types.ts`)

Key interfaces: `TokenInfo`, `TradeSignal` (types: SNIPE/COPY/FILTER), `Position`, `WalletConfig`.

### Config Priority

`data/config.json` (runtime, from dashboard) overrides `.env` values. Delete `data/config.json` to reset to `.env` defaults. The `CONFIG` object in `src/config.ts` is mutable — storage loads saved values into it at startup.

## Key Patterns

- **Two swap paths**: Jupiter (post-Raydium-migration tokens) and PumpSwap (bonding curve tokens). Modules choose based on whether the token has completed its bonding curve.
- **All state in `./data/*.json`**: Config, wallets, positions, trades, alerts, blacklist, influencers, narratives, performance. The `data/` directory is gitignored.
- **Graceful shutdown**: SIGINT/SIGTERM handlers flush storage. `uncaughtException` also flushes before exit.
- **Polling, not WebSocket subscriptions for Solana RPC**: Sniper uses `getSignaturesForAddress` polling (despite originally being designed for WS). Pump.fun module uses its own WebSocket to `pumpportal.fun`.

## Environment

Requires Node.js >= 18. Key env vars: `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `PRIVATE_KEY`, `HELIUS_API_KEY`, `BIRDEYE_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Optional: `TWITTER_BEARER_TOKEN`. See `.env` for full list. The `.env` file is gitignored.
