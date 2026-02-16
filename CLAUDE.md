# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Start custom server (Next.js + WS + bot modules) in dev mode
npm run build          # Build Next.js for production
npm start              # Start custom server in production mode
npm run backtest       # Run backtester with historical data
npx tsc --noEmit       # Type-check without emitting (no linter/test framework configured)
```

## Architecture

This is a Solana memecoin trading bot built with TypeScript. Six trading modules are orchestrated by `ModuleRegistry` (start/stop individually from the UI), with a Next.js dashboard and Telegram alerts.

### Core Layer (`src/core/`)

- **connection.ts** — Lazy-initialized `getConnection()` and `getWallet()` functions plus backward-compat proxy exports `connection` and `wallet`. Does NOT call `process.exit()` at import time (safe for Next.js build).
- **jupiter.ts** — `JupiterSwap` class: executes buys/sells through Jupiter Aggregator v6 (`quote` + `swap` endpoints). Also provides `getPrice()` via Birdeye API.
- **pumpSwap.ts** — `PumpSwap` class: executes buys/sells directly on Pump.fun's bonding curve program. Falls back to Jupiter after migration.
- **storage.ts** — `Storage` singleton: JSON file persistence in `./data/`. Debounced writes, atomic tmp+rename, corruption recovery.
- **alerts.ts** — Telegram notifications via Telegraf. Gracefully degrades if token not configured.

### Bot Layer (`src/bot/`)

- **registry.ts** — `ModuleRegistry` singleton (survives Next.js HMR via `globalThis`). Instantiates all modules (PositionManager first, injected into Sniper + PumpFun). Provides `startModule(name)`, `stopModule(name)`, `startAll()`, `stopAll()`. Holds WebSocket client set for broadcasting position updates, alerts, and module status changes.

### Module Layer (`src/modules/`)

All modules have `start()`, `stop()`, and `isRunning()` methods. They are NOT auto-started — user starts them from the dashboard.

- **sniper.ts** — `SniperModule`: Polls Helius for Raydium AMM new pool transactions. Scores 0-100. Buys via Jupiter if score >= 70.
- **pumpfun.ts** — `PumpFunModule`: Connects to Pump.fun WebSocket. Buys via PumpSwap (on-curve) or Jupiter (post-migration). `stop()` closes WS and prevents reconnect.
- **walletTracker.ts** — `WalletTracker`: Polls per tracked wallet. Copies trades proportionally.
- **tokenMonitor.ts** — `TokenMonitor`: Scores trending tokens from Birdeye. Alerts on score >= 60.
- **socialSentiment.ts** — `SocialSentimentModule`: Twitter API, DexScreener boosts, narrative detection.
- **positionManager.ts** — `PositionManager`: Monitors positions every 5s. TP/SL/trailing stop. Calls `_onPositionUpdate` callback for WebSocket broadcasting.
- **bundleManager.ts** — `BundleManager`: Multi-wallet token buying. User-driven via dashboard API.

### Custom Server (`server.ts`)

Node.js HTTP server that:
1. Initializes Next.js app
2. Attaches WebSocketServer for real-time updates
3. Creates ModuleRegistry singleton, wires WS clients
4. Handles HTTP via Next.js `handle(req, res)`
5. Graceful shutdown: `stopAll()` → `storage.flush()` → exit

### Dashboard (Next.js App Router)

- **`app/page.tsx`** — Dashboard: metrics, module start/stop toggles, live alerts
- **`app/positions/page.tsx`** — Real-time position table via WebSocket
- **`app/trades/page.tsx`** — Trade history with stats
- **`app/config/page.tsx`** — Trading config form
- **`app/wallets/page.tsx`** — Tracked wallet management
- **`app/bundle/page.tsx`** — Bundle manager UI
- **`app/api/`** — Route handlers that import `registry` singleton
- **`hooks/use-websocket.ts`** — Client-side WS hook with auto-reconnect
- **`components/layout/sidebar.tsx`** — Navigation sidebar

### Shared Types (`src/types.ts`)

Key interfaces: `TokenInfo`, `TradeSignal`, `Position`, `WalletConfig`, `BundleState`, `BundleWallet`, `BundleStatus`.

### Config Priority

`data/config.json` (runtime, from dashboard) overrides `.env` values. Delete `data/config.json` to reset to `.env` defaults.

## Key Patterns

- **Module start/stop**: Every module stores timer refs in `_timers[]` and checks `_running` flag before scheduling next iteration. `stop()` clears all timers.
- **Two swap paths**: Jupiter (post-Raydium-migration tokens) and PumpSwap (bonding curve tokens).
- **All state in `./data/*.json`**: Config, wallets, positions, trades, alerts, blacklist, influencers, narratives, performance, bundle.
- **Graceful shutdown**: `server.ts` SIGINT/SIGTERM calls `registry.stopAll()` then `storage.flush()`.
- **Lazy connection**: `connection.ts` uses lazy getters + Proxy for backward compat — no process.exit at import time.

## Environment

Requires Node.js >= 18. Key env vars: `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `PRIVATE_KEY`, `HELIUS_API_KEY`, `BIRDEYE_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Optional: `TWITTER_BEARER_TOKEN`, `DASHBOARD_PORT` (default 3000).
