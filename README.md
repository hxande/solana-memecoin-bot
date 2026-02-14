# 🤖 Solana Memecoin Trading Bot

A fully automated trading bot for Solana memecoins. Snipes new tokens on Raydium and Pump.fun, copies smart money wallets, scores tokens with on-chain filters, tracks social sentiment, and manages positions with take-profit and stop-loss — all from a real-time web dashboard with Telegram alerts.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Modules](#modules)
  - [Sniper (Raydium)](#1-sniper-raydium)
  - [Pump.fun Sniper](#2-pumpfun-sniper)
  - [Copy-Trading (Wallet Tracker)](#3-copy-trading-wallet-tracker)
  - [Token Monitor (On-Chain Filters)](#4-token-monitor-on-chain-filters)
  - [Social Sentiment](#5-social-sentiment)
  - [Position Manager](#6-position-manager)
  - [Backtester](#7-backtester)
  - [Bundle Manager](#8-bundle-manager)
  - [Web Dashboard](#9-web-dashboard)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [API Keys Setup](#api-keys-setup)
  - [Trading Parameters](#trading-parameters)
- [Usage](#usage)
  - [Running the Bot](#running-the-bot)
  - [Running Individual Modules](#running-individual-modules)
  - [Running Backtests](#running-backtests)
- [Project Structure](#project-structure)
- [Data Persistence](#data-persistence)
- [API Reference (Dashboard)](#api-reference-dashboard)
- [How Each Module Works](#how-each-module-works)
- [Customization](#customization)
  - [Adding Wallets to Track](#adding-wallets-to-track)
  - [Adding Influencers](#adding-influencers)
  - [Tuning Filters](#tuning-filters)
  - [Creating Backtest Strategies](#creating-backtest-strategies)
- [Safety and Risk Management](#safety-and-risk-management)
- [Troubleshooting](#troubleshooting)
- [Disclaimer](#disclaimer)

---

## Overview

This bot combines seven trading modules into a single system:

| Strategy | What it does | Speed |
|----------|-------------|-------|
| **Raydium Sniper** | Buys tokens within seconds of a new liquidity pool being created | ~1-3s |
| **Pump.fun Sniper** | Monitors Pump.fun launches, bonding curve progress, and migration events | ~5-15s |
| **Copy-Trading** | Mirrors trades from wallets you specify (smart money, whales, influencers) | ~2-5s |
| **Token Monitor** | Scores trending tokens using on-chain data (safety, liquidity, holders, momentum) | Continuous |
| **Social Sentiment** | Tracks Twitter/X mentions, influencer calls, DexScreener boosts, and emerging narratives | Continuous |
| **Position Manager** | Monitors open positions with TP, SL, trailing stop, and time-based exits — executes real sells via Jupiter | Every 5s |
| **Bundle Manager** | Multi-wallet token buying: generates temp wallets, distributes SOL, buys from multiple wallets, consolidates and sells from main | User-driven |

All signals are sent to **Telegram** in real time. The **web dashboard** at `http://localhost:3000` gives you a visual overview of everything. All state is **persisted to disk** — the bot survives restarts without losing data.

---

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │           Web Dashboard              │
                    │       http://localhost:3000           │
                    │  (positions, alerts, config, P&L)    │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │           index.ts                    │
                    │       (Module Orchestrator)           │
                    └──┬───┬───┬───┬───┬───┬───┬──────────┘
                       │   │   │   │   │   │   │
          ┌────────────┘   │   │   │   │   │   └──────────────┐
          ▼                ▼   │   ▼   │   ▼                  ▼
    ┌──────────┐  ┌──────────┐│┌──────────┐│┌──────────┐ ┌──────────┐
    │  Sniper  │  │ Pump.fun ││ │  Token   ││ │  Social  │ │ Backtest │
    │ (Raydium)│  │  Sniper  ││ │ Monitor  ││ │Sentiment │ │  Engine  │
    └────┬─────┘  └────┬─────┘│ └────┬─────┘│ └────┬─────┘ └──────────┘
         │              │      │      │      │      │
         │    ┌─────────┘      │      │      │      │
         │    │   ┌────────────┘      │   ┌──┘      │
         ▼    ▼   ▼                   ▼   ▼         │
    ┌──────────────────┐    ┌──────────────────┐    │
    │   Copy-Trading   │    │ Position Manager │    │
    │ (Wallet Tracker) │    │  (TP / SL / PnL) │    │
    └────────┬─────────┘    └────────┬─────────┘    │
             │                       │              │
             ▼                       ▼              │
    ┌──────────────────────────────────────────┐    │
    │              Jupiter Swap API             │    │
    │       (Best price across all DEXs)       │    │
    └────────────────┬─────────────────────────┘    │
                     │                              │
                     ▼                              │
    ┌──────────────────────────────────────────┐    │
    │            Solana Blockchain              │    │
    │         (via Helius RPC + WebSocket)      │◄───┘
    └──────────────────────────────────────────┘
             │                    │
             ▼                    ▼
    ┌────────────────┐  ┌─────────────────┐
    │ Telegram Alerts │  │ Persistence     │
    │ (real-time)     │  │ (./data/*.json) │
    └────────────────┘  └─────────────────┘
```

---

## Modules

### 1. Sniper (Raydium)

**File:** `src/modules/sniper.ts`

Polls for new liquidity pool creation on Raydium AMM via Helius RPC. When a new pool is detected, it:

1. Extracts the token mint address from the transaction
2. Fetches token metadata from Helius and market data from Birdeye
3. Runs the token through safety filters (anti-rug checks) — all filters fail-closed (API errors assume unsafe)
4. Assigns a confidence score starting from **0** (every point must be earned)
5. If score >= configurable threshold (default **70**), checks max open positions, then executes a buy via Jupiter
6. Registers the position with PositionManager for automatic TP/SL/trailing stop monitoring
7. Persists the trade to `data/trades.json`

**Scoring breakdown (max 100, base 0):**

| Check | Max Points | Details |
|-------|-----------|---------|
| Liquidity | 20 | `min(20, floor(liquidity / 5))` — needs 100 SOL for max |
| Top holder | 15 | `min(15, floor((30 - topHolderPct) / 2))` |
| Mint renounced | 15 | +15 if mint authority is null |
| Freeze revoked | 10 | +10 if freeze authority is null |
| Holders | 15 | `min(15, floor(holders / 20))` — needs 300 for max |
| LP burned | 10 | +10 if LP tokens are burned |
| Fresh token | 10 | +10 if token is < 120 seconds old |
| Blacklisted dev | -100 | Instant reject |

**Safety filters (hard rejections):**
- Minimum liquidity: 5 SOL
- Maximum top holder concentration: 30% (returns 100% on API error — fail-closed)
- Mint authority must be revoked (assumes mintable on Helius failure — fail-closed)
- Freeze authority must be revoked
- Minimum 10 holders
- Token must be less than 5 minutes old
- Developer address checked against blacklist (loaded from `data/blacklist.json`)

**Key constants:**
- `RAYDIUM_AMM`: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
- Polling: `getSignaturesForAddress` every 3 seconds

---

### 2. Pump.fun Sniper

**File:** `src/modules/pumpfun.ts`

Pump.fun is where most Solana memecoins launch. This module connects to the Pump.fun WebSocket (`wss://pumpportal.fun/api/data`) and REST API to monitor:

**Four strategies:**

| Strategy | Trigger | Description |
|----------|---------|-------------|
| `earlySnipe` | New token created | Waits 15s for initial trade data, then evaluates |
| `bondingCurvePlay` | BC progress 70-95% | Buys tokens approaching Raydium migration |
| `migrationSnipe` | BC progress 80-90 SOL | Buys right before the token migrates to Raydium |
| `socialMomentum` | Volume surge detected | Buys when buy volume spikes 3x in 60 seconds |

**Scoring criteria (max 100, threshold default 65):**

| Check | Max Points | Details |
|-------|-----------|---------|
| Token age | 10 | +10 if < 5 minutes old |
| Market cap range | 10 | +10 if 5-30 SOL (sweet spot) |
| Replies | 15 | >= 10 replies: +15, >= 3: +8 |
| Buy count | 10 | >= 8 buys: +10, >= 3: +5 (tiered) |
| Unique traders | 10 | >= 5 traders: +10, >= 2: +5 (tiered) |
| Buy/sell ratio (count) | 15 | >= 3:1: +15, >= 1.5:1: +8 |
| Volume-weighted B/S | -15 | Penalizes if sell volume > 2x buy volume |
| Volume | 5 | +5 if total buy volume >= 1 SOL |
| Creator holdings | 10 | < 10%: +10 (uses actual token supply, not hardcoded 1B) |
| Bonding curve | 10 | +10 if 60-85% complete |
| Honeypot signal | -20 | Penalizes if 5+ buys with 0 sells after 30s of trading |

**Anti-rug checks:**
- Excluded keywords in name/description: `rug`, `scam`, `test`, `airdrop`
- Blacklisted creators (auto-blacklists serial deployers with 5+ tokens, persisted to `data/blacklist.json`)
- Creator holding percentage check (fail-closed: returns 50% on error, not 0%)
- Honeypot detection: penalizes tokens with many buys but zero sells
- Volume-weighted sell pressure detection
- Max open positions check before buying

**Bonding curve mechanics:**
- Pump.fun tokens start on a bonding curve
- When ~85 SOL of market cap is reached, liquidity migrates to Raydium
- This migration often causes a significant price pump
- The bot can buy just before migration for this play

---

### 3. Copy-Trading (Wallet Tracker)

**File:** `src/modules/walletTracker.ts`

Monitors specified wallet addresses for swap transactions. When a tracked wallet buys or sells a token, the bot copies the trade proportionally. Wallets are persisted to `data/wallets.json`.

**How it works:**
1. Polls `getSignaturesForAddress` every 2 seconds per wallet
2. Fetches and parses each transaction
3. Compares pre/post token balances to detect swaps
4. Calculates actual SOL amount from `preBalances`/`postBalances` (not hardcoded)
5. If a buy is detected and exceeds the minimum threshold, copies it proportionally
6. If a sell is detected for a token we hold, sells our full position (copy-sell)

**Configuration per wallet:**
```typescript
{
  address: 'WALLET_ADDRESS',  // Solana public key
  label: 'Smart Money #1',    // Your label for this wallet
  copyPct: 50,                // Copy 50% of their trade size
  minTradeSol: 0.5,           // Ignore trades smaller than 0.5 SOL
  enabled: true               // Toggle on/off
}
```

**How to find wallets to track:**
- Use [Birdeye](https://birdeye.so) or [Solscan](https://solscan.io) to find profitable wallets
- Look at early buyers of tokens that did 10x+
- Check influencer wallets (many are public)
- Use [GMGN](https://gmgn.ai) or [Cielo](https://cielo.finance) for smart money tracking

---

### 4. Token Monitor (On-Chain Filters)

**File:** `src/modules/tokenMonitor.ts`

Continuously scores trending tokens from Birdeye using four categories:

**Scoring breakdown:**

| Category | Max Score | What it checks |
|----------|-----------|---------------|
| **Safety** | 30 | Mint renounced (+10), not mintable (+5), LP burned (+10), top holder < 10% (+5) |
| **Liquidity** | 25 | Liquidity ≥ $100k (+10), good liquidity/mcap ratio (+10), low mcap < $1M (+5) |
| **Community** | 25 | Holders ≥ 500 (+15), ≥ 100 (+10), ≥ 30 (+5) — no unconditional bonus |
| **Momentum** | 20 | Positive 1h price change (+10), volume increasing > 50% (+10) |

Tokens scoring ≥ 60/100 trigger a Telegram alert with full breakdown.

---

### 5. Social Sentiment

**File:** `src/modules/socialSentiment.ts`

Tracks social media activity to detect hype before price movement. Influencer list is persisted to `data/influencers.json`, narratives to `data/narratives.json`.

**Data sources:**
- **Twitter/X API** (if bearer token provided): Polls influencer tweets and token mentions
- **DexScreener Boosts API** (free, no key needed): Tracks boosted/promoted tokens
- **Birdeye Social Score**: Token-level social scoring

**Three detection systems:**

**A) Influencer Call Detection**
- Monitors tweets from configured influencer accounts
- Extracts Solana mint addresses and ticker symbols ($SYMBOL) from tweet text
- Analyzes sentiment using keyword matching and emoji analysis
- Alerts when a high-weight influencer (≥ 7/10) posts a bullish call

**B) Narrative Detection**
- Aggregates all mentions from the last hour
- Counts frequency of narrative keywords: `ai`, `agent`, `cat`, `dog`, `trump`, `elon`, `pepe`, etc.
- Detects when a new narrative emerges (≥ 5 mentions in an hour)
- Tracks narrative growth rate over time

**C) Trend Velocity Analysis**
- For each tracked token, compares mentions in the last 30 min vs. previous 30 min
- Alerts when velocity ≥ 3x and ≥ 70% of mentions are bullish

**Sentiment analysis:**
- Bullish keywords: `moon`, `gem`, `100x`, `lfg`, `alpha`, `pump`, etc.
- Bearish emojis: 💀🔴📉⚠️
- Bullish emojis: 🚀🔥💎🌙💰📈

---

### 6. Position Manager

**File:** `src/modules/positionManager.ts`

Monitors all open positions every **5 seconds** and enforces exit rules. Positions are persisted to `data/positions.json` and automatically restored on restart. Shared with Sniper and Pump.fun modules via constructor injection — both modules register positions after successful buys.

**Exit triggers:**
- **Take Profit**: Sells when position reaches the configured profit target (default: +100%)
- **Trailing Stop**: Tracks the highest price per position. When profit exceeds the activation threshold (default: +30%) and price drops from peak by the trailing stop percentage (default: 30%), sells to lock in gains. This captures profits on tokens that pump then fade.
- **Stop Loss**: Sells when position drops below the configured loss limit (default: -50%)
- **Time-Based Exit**: If a position is held longer than `maxHoldTimeMinutes` (default: 30) and PnL is below +10%, sells. Memecoins that don't move quickly rarely recover.

**Position limits:**
- Maximum concurrent positions: configurable via `MAX_POSITIONS` (default: 5). Modules check `canOpenPosition()` before buying.

**How it works:**
1. Loops through all open positions (loaded from disk on startup)
2. Fetches current price from Birdeye
3. Updates highest price tracking for trailing stop
4. Calculates unrealized P&L and distance from peak
5. Checks all four exit conditions in priority order (TP > trailing > SL > time)
6. **Executes an actual sell via Jupiter** — gets ATA token balance, calls `jupiter.sell()` with the full raw token amount
7. Sends Telegram alert with exit reason and TX hash
8. Logs the closed trade to `data/trades.json` with final P&L

---

### 7. Backtester

**File:** `src/modules/backtester.ts`

Tests trading strategies against historical data before risking real money.

**Data collection:**
- Fetches historical token data from Birdeye token list API
- Stores mint, launch price, peak price, ATH multiple, liquidity, holders, and rug status
- Saves data to `data/backtest/` as JSON files

**Simulation:**
1. Filters tokens using strategy filters
2. Checks entry rules (score threshold, volume spike, bonding curve completion)
3. Simulates trade execution with entry/exit prices
4. Applies exit rules (take profit, stop loss, trailing stop, time-based exit)
5. Calculates P&L per trade and portfolio metrics

**Output metrics:**
- Total P&L (SOL and %)
- Win rate
- Profit factor (gross profit / gross loss)
- Sharpe ratio
- Maximum drawdown
- Average hold time
- Number of rugs prevented by filters
- Equity curve
- Best and worst trade

**Pre-built strategies:**

| Strategy | Min Liquidity | Max Top Holder | TP | SL | Style |
|----------|--------------|----------------|-----|-----|-------|
| Conservative | $5,000 | 15% | 50% | 25% | Safe, fewer trades |
| Aggressive | $1,000 | 30% | 200% | 50% | Risky, more trades |

---

### 8. Bundle Manager

**File:** `src/modules/bundleManager.ts`

Multi-wallet token buying for distributing buys across many wallets. Controlled entirely from the dashboard — no background polling.

**Lifecycle:**

| Step | Action | Details |
|------|--------|---------|
| **Create** | Generate wallets | Creates 1-30 fresh Keypairs, randomly allocates SOL via broken-stick method (min 0.001 SOL each) |
| **Distribute** | Fund wallets | Batched `SystemProgram.transfer` from main wallet (7 transfers per TX to stay within size limits) |
| **Buy** | Execute buys | Each sub-wallet gets its own `JupiterSwap` instance and buys sequentially (500ms delay for RPC rate limits) |
| **Sell** | Consolidate + sell + reclaim | One-click: transfers all tokens to main ATA, sells via Jupiter, sweeps leftover SOL back |
| **Cancel** | Emergency exit | Attempts consolidate → sell → reclaim, force-clears state if anything fails |

**Key design decisions:**
- **Fresh wallets each time** — Keypairs are generated per bundle and discarded after reclaim
- **Consolidate-then-sell** — All tokens are transferred to the main wallet ATA, then sold in a single Jupiter swap (better price than individual sells)
- **Auto-reclaim SOL** — After selling, each sub-wallet sends its remaining SOL (minus 5000 lamports rent) back to the main wallet
- **Crash recovery** — State persists to `data/bundle.json`. Each phase checks per-wallet flags (`distributed`, `bought`, `consolidated`, `reclaimed`) and skips already-completed wallets, making operations idempotent and resumable
- **Secret keys never exposed** — `getStatus()` strips `secretKeyB58` from wallet data before sending to the dashboard

**Constants:**
- `SOL_FEE_BUFFER`: 0.003 SOL per wallet (covers TX fees)
- `MAX_WALLETS`: 30
- `TRANSFERS_PER_TX`: 7 (Solana TX size limit)

---

### 9. Web Dashboard

**File:** `src/dashboard/server.ts`

Express + WebSocket server serving a real-time single-page dashboard.

**Features:**
- Live wallet balance display
- Module status indicators (ON/OFF for each module)
- Open positions table with real-time P&L
- Live alerts feed (WebSocket-powered, no refresh needed)
- Trading configuration editor (max buy, slippage, TP, SL) — changes persist to disk
- Tracked wallets list with add/remove — persists to disk
- Active narratives display from Social Sentiment module
- Pump.fun and Social module statistics
- Blacklist and influencer management via API
- Bundle Manager card — create bundles, step through distribute/buy/sell with per-wallet progress table
- Storage statistics endpoint

**Endpoints:** See [API Reference](#api-reference-dashboard).

---

## Prerequisites

- **Node.js** v18 or higher
- **npm** or **yarn**
- A **Solana wallet** with SOL (start with a small amount for testing)
- **API keys** (see [API Keys Setup](#api-keys-setup))

---

## Installation

### Option A: Using the setup scripts

```bash
# Download and run the two setup scripts
chmod +x setup.sh setup-part2.sh
./setup.sh
./setup-part2.sh

# Apply persistence patch
chmod +x patch-storage.sh
./patch-storage.sh

# Enter the project directory
cd solana-memecoin-bot

# Configure your API keys
nano .env

# Install dependencies
npm install
```

### Option B: Manual setup

```bash
# Create the project
mkdir solana-memecoin-bot && cd solana-memecoin-bot
mkdir -p src/{core,modules,dashboard/public,scripts} data/backtest

# Initialize and install
npm init -y
npm install @solana/web3.js @solana/spl-token bs58 axios dotenv ws telegraf express cors
npm install -D typescript ts-node ts-node-dev @types/node @types/ws @types/express @types/cors

# Copy all source files from the setup scripts into their respective locations
# Then configure your .env file
```

---

## Configuration

### Environment Variables

Copy the `.env` file and fill in your values:

```env
# Solana RPC (Helius recommended)
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Your bot's wallet private key (base58 encoded)
PRIVATE_KEY=your_base58_private_key

# API Keys
HELIUS_API_KEY=your_helius_key
BIRDEYE_API_KEY=your_birdeye_key
JUPITER_API=https://quote-api.jup.ag/v6

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Twitter (optional)
TWITTER_BEARER_TOKEN=your_bearer_token

# Trading
MAX_BUY_SOL=0.1
SLIPPAGE_BPS=500
AUTO_SELL_PROFIT_PCT=100
STOP_LOSS_PCT=50
GAS_PRIORITY_FEE=0.005

# Position Management
MAX_POSITIONS=5
TRAILING_STOP_PCT=30
TRAILING_ACTIVATION_PCT=30
MAX_HOLD_TIME_MINUTES=30

# Scoring Thresholds
SNIPER_MIN_SCORE=70
PUMPFUN_MIN_SCORE=65

# Dashboard
DASHBOARD_PORT=3000
```

### API Keys Setup

#### Helius (Required)

Helius provides the Solana RPC, WebSocket, and token metadata API.

1. Go to [https://helius.dev](https://helius.dev)
2. Create a free account
3. Copy your API key
4. Free tier: 100,000 requests/day — sufficient for this bot

#### Birdeye (Required)

Birdeye provides token market data, pricing, holder info, and trending lists.

1. Go to [https://birdeye.so](https://birdeye.so)
2. Navigate to the developer section
3. Create an API key
4. Free tier: 100 requests/minute

#### Telegram Bot (Recommended)

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts
3. Copy the bot token
4. Send any message to your new bot
5. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
6. Find `chat.id` in the response — that is your `TELEGRAM_CHAT_ID`

#### Twitter/X (Optional)

Without this key, the bot still works using DexScreener boosts and Birdeye social data as alternatives.

1. Go to [https://developer.twitter.com](https://developer.twitter.com)
2. Create a project and app
3. Generate a Bearer Token
4. Free tier: 500,000 tweets/month read access

### Trading Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_BUY_SOL` | 0.1 | Maximum SOL spent per trade |
| `SLIPPAGE_BPS` | 500 | Slippage tolerance in basis points (500 = 5%) |
| `AUTO_SELL_PROFIT_PCT` | 100 | Take profit at +100% gain |
| `STOP_LOSS_PCT` | 50 | Stop loss at -50% |
| `GAS_PRIORITY_FEE` | 0.005 | Priority fee in SOL for faster transactions |
| `MAX_POSITIONS` | 5 | Maximum concurrent open positions |
| `TRAILING_STOP_PCT` | 30 | Trailing stop: sell when price drops this % from peak |
| `TRAILING_ACTIVATION_PCT` | 30 | Trailing stop activates after this % profit |
| `MAX_HOLD_TIME_MINUTES` | 30 | Close position after this many minutes if PnL < 10% |
| `SNIPER_MIN_SCORE` | 70 | Minimum score for Raydium sniper to execute a buy |
| `PUMPFUN_MIN_SCORE` | 65 | Minimum score for Pump.fun module to execute a buy |

> **Tip:** Start with `MAX_BUY_SOL=0.01` for testing. Increase only after verifying the bot works correctly with your filters.

---

## Usage

### Running the Bot

```bash
# Start all modules
npm start

# Start with auto-restart on file changes (development)
npm run dev
```

On startup, the bot will:
1. Print your wallet address and balance
2. Load all persisted state from `./data/` (config, wallets, positions, blacklist, etc.)
3. Print trade history stats (win rate, total P&L)
4. Start all six trading modules
5. Start the web dashboard
6. Send a Telegram notification confirming it is running

### Running Individual Modules

```bash
# Only the Raydium sniper
npm run sniper

# Only the wallet tracker (copy-trading)
npm run tracker

# Only the token monitor (on-chain filters)
npm run monitor
```

### Running Backtests

```bash
# Collect historical data and run all default strategies
npm run backtest
```

This will:
1. Fetch the last 30 days of token data from Birdeye
2. Run the Conservative strategy simulation
3. Run the Aggressive strategy simulation
4. Print a report for each with win rate, P&L, Sharpe ratio, etc.
5. Save results to `data/backtest/`

---

## Project Structure

```
solana-memecoin-bot/
│
├── .env                          # API keys and configuration
├── .gitignore                    # Excludes node_modules, .env, data/
├── package.json                  # Dependencies and scripts
├── tsconfig.json                 # TypeScript configuration
├── README.md                     # This file
│
├── data/                         # All persisted state (auto-created)
│   ├── config.json               # Runtime trading parameters
│   ├── wallets.json              # Tracked wallets
│   ├── positions.json            # Open positions
│   ├── trades.json               # Trade history (max 5000)
│   ├── alerts.json               # Alert history (max 1000)
│   ├── blacklist.json            # Blacklisted creators/devs
│   ├── influencers.json          # Social influencer list
│   ├── narratives.json           # Active narratives
│   ├── performance.json          # Balance history (max 10000)
│   ├── bundle.json               # Active bundle state
│   └── backtest/                 # Backtest data and results
│
└── src/
    ├── index.ts                  # Main entry point, starts all modules
    ├── config.ts                 # Loads .env into typed CONFIG object
    ├── types.ts                  # Shared TypeScript interfaces
    │
    ├── core/
    │   ├── connection.ts         # Solana RPC connection + wallet keypair
    │   ├── jupiter.ts            # Jupiter Aggregator swap (buy/sell)
    │   ├── pumpSwap.ts           # Pump.fun bonding curve direct swap
    │   ├── alerts.ts             # Telegram alert formatting and sending
    │   └── storage.ts            # JSON file persistence layer
    │
    ├── modules/
    │   ├── sniper.ts             # Raydium new pool sniper
    │   ├── pumpfun.ts            # Pump.fun token sniper
    │   ├── walletTracker.ts      # Copy-trading / wallet monitoring
    │   ├── tokenMonitor.ts       # On-chain token scoring
    │   ├── socialSentiment.ts    # Twitter/social monitoring
    │   ├── positionManager.ts    # Take-profit / stop-loss manager
    │   ├── bundleManager.ts      # Multi-wallet bundle buying
    │   └── backtester.ts         # Strategy backtesting engine
    │
    ├── dashboard/
    │   └── server.ts             # Express + WebSocket dashboard server
    │
    └── scripts/
        └── runBacktest.ts        # Standalone backtest runner
```

---

## Data Persistence

All bot state is persisted to JSON files in the `data/` directory. The bot survives restarts without losing any configuration, positions, or history.

### What is Persisted

| File | Data | Max Entries | Loaded On Startup |
|------|------|-------------|-------------------|
| `config.json` | Trading parameters (max buy, slippage, TP, SL) | 1 object | ✅ Overrides `.env` values |
| `wallets.json` | Tracked wallets for copy-trading | Unlimited | ✅ Replaces default list |
| `positions.json` | Open positions with entry price and source | Unlimited | ✅ Resumes monitoring |
| `trades.json` | Complete trade history with P&L | 5,000 | ✅ Shown in dashboard |
| `alerts.json` | Recent alert history | 1,000 | ✅ Shown in dashboard |
| `blacklist.json` | Blacklisted creator/dev addresses | Unlimited | ✅ Loaded into Sniper + Pump.fun |
| `influencers.json` | Twitter/social influencer list | Unlimited | ✅ Loaded into Social module |
| `narratives.json` | Active narrative keywords (< 6h old) | Unlimited | ✅ Loaded into Social module |
| `performance.json` | Balance history over time | 10,000 | ✅ Shown in dashboard chart |
| `bundle.json` | Active bundle state (wallets, phase flags) | 1 object | ✅ Resumes bundle operations |

### How It Works

- **Debounced writes**: Disk writes are debounced (1-5 seconds) to avoid excessive I/O during bursts of activity.
- **Atomic writes**: Data is written to a `.tmp` file first, then renamed — preventing corruption if the process crashes mid-write.
- **Corruption recovery**: If a JSON file is corrupted, it is automatically backed up as `.bak.<timestamp>` and the bot starts fresh for that file.
- **Graceful shutdown**: On `SIGINT` (Ctrl+C) or `SIGTERM`, all pending writes are flushed to disk before exit.
- **Crash protection**: Even on `uncaughtException`, the bot flushes storage before exiting.
- **Cache layer**: Files are read from disk once, then served from an in-memory cache for performance.

### Storage API (Dashboard)

```bash
# View storage statistics (file sizes, entry counts)
curl http://localhost:3000/api/storage/stats

# View trade statistics (win rate, total P&L)
curl http://localhost:3000/api/trades/stats

# Manage blacklist
curl http://localhost:3000/api/blacklist
curl -X POST http://localhost:3000/api/blacklist \
  -H "Content-Type: application/json" \
  -d '{"address": "ScammerAddress...", "reason": "Known rugger"}'
curl -X DELETE http://localhost:3000/api/blacklist/ScammerAddress...

# Manage influencers
curl http://localhost:3000/api/influencers
curl -X POST http://localhost:3000/api/influencers \
  -H "Content-Type: application/json" \
  -d '{"handle": "crypto_whale", "followers": 50000, "weight": 8}'
curl -X DELETE http://localhost:3000/api/influencers/crypto_whale
```

### Priority Order for Config

When the bot starts, configuration is resolved in this order (last wins):

1. **`.env` file** — Base defaults
2. **`data/config.json`** — Runtime changes saved from the dashboard

This means if you change `MAX_BUY_SOL` in the dashboard, that value persists across restarts even though `.env` still has the old value. To reset to `.env` defaults, delete `data/config.json`.

---

## API Reference (Dashboard)

The dashboard exposes a REST API on the configured port (default: 3000).

### GET `/api/status`

Returns bot status, wallet balance, active modules, and current config.

```json
{
  "status": "running",
  "wallet": "YourPublicKey...",
  "balanceSol": 1.5432,
  "uptime": 3600,
  "modules": {
    "sniper": true,
    "tracker": true,
    "monitor": true,
    "pumpfun": true,
    "social": true
  },
  "config": {
    "maxBuySol": 0.1,
    "slippageBps": 500,
    "profitTarget": 100,
    "stopLoss": 50
  }
}
```

### GET `/api/positions`

Returns all open positions with current P&L.

### GET `/api/trades`

Returns the last 100 executed trades.

### GET `/api/trades/stats`

Returns aggregated trade statistics.

```json
{
  "total": 150,
  "wins": 87,
  "losses": 63,
  "winRate": 58.0,
  "totalPnlSol": 3.45
}
```

### GET `/api/alerts`

Returns the last 50 alerts.

### GET `/api/wallets`

Returns all tracked wallets and their configuration.

### POST `/api/wallets`

Add a new wallet to track. Persists to disk immediately.

```json
{
  "address": "WalletPublicKey...",
  "label": "My Whale",
  "copyPct": 50,
  "minTradeSol": 0.5
}
```

### POST `/api/config`

Update trading parameters at runtime (no restart needed). Persists to disk.

```json
{
  "maxBuySol": 0.2,
  "slippageBps": 300,
  "profitTarget": 150,
  "stopLoss": 40
}
```

### GET `/api/pumpfun/stats`

Returns Pump.fun module statistics (tokens processed, trades tracked, etc.).

### GET `/api/social/stats`

Returns social sentiment statistics and active narratives.

### GET `/api/blacklist`

Returns all blacklisted addresses with reason and timestamp.

### POST `/api/blacklist`

Manually blacklist a creator/developer address.

```json
{
  "address": "SuspiciousAddress...",
  "reason": "Known scammer"
}
```

### DELETE `/api/blacklist/:address`

Remove an address from the blacklist.

### GET `/api/influencers`

Returns all tracked influencers.

### POST `/api/influencers`

Add a new influencer to track. Persists to disk and immediately starts monitoring.

```json
{
  "handle": "crypto_alpha",
  "platform": "twitter",
  "followers": 75000,
  "weight": 8,
  "trackBuyCalls": true
}
```

### DELETE `/api/influencers/:handle`

Remove an influencer from tracking.

### GET `/api/storage/stats`

Returns file sizes and entry counts for all persisted data.

```json
{
  "config": { "exists": true, "sizeKB": 0.2 },
  "wallets": { "exists": true, "sizeKB": 0.5, "entries": 3 },
  "trades": { "exists": true, "sizeKB": 45.2, "entries": 312 },
  "blacklist": { "exists": true, "sizeKB": 2.1, "entries": 47 }
}
```

### GET `/api/performance`

Returns balance history for the equity chart.

### GET `/api/bundle/status`

Returns current bundle state (wallets, status, phase flags). Secret keys are stripped. Returns `null` if no active bundle.

### POST `/api/bundle/create`

Create a new bundle. Generates fresh wallets and allocates SOL.

```json
{
  "mint": "TokenMintAddress...",
  "walletCount": 5,
  "totalSol": 0.5
}
```

### POST `/api/bundle/distribute`

Fund all sub-wallets from main wallet. Returns 200 immediately; runs async with WebSocket progress updates.

### POST `/api/bundle/buy`

Execute buys from all sub-wallets. Returns 200 immediately; runs async.

### POST `/api/bundle/sell`

One-click sell flow: consolidate tokens to main wallet → sell via Jupiter → reclaim SOL. Returns 200 immediately; runs async.

### POST `/api/bundle/cancel`

Emergency cancel: attempts to salvage funds (consolidate + sell + reclaim), then force-clears state.

### POST `/api/bundle/reclaim`

Standalone SOL reclaim from sub-wallets back to main wallet.

### WebSocket

Connect to `ws://localhost:3000` for real-time events:

```json
{ "type": "alert", "data": { "time": 1234567890, "type": "snipe", "message": "..." } }
{ "type": "trade", "data": { "action": "BUY", "mint": "...", "amount": 0.1 } }
{ "type": "performance", "data": { "time": 1234567890, "balanceSol": 1.54 } }
{ "type": "bundle", "data": { "mint": "...", "status": "buying", "wallets": [...] } }
```

---

## How Each Module Works

### Trade Execution Flow

```
Signal Detected (any module)
        │
        ▼
┌─────────────────┐
│ Apply Filters   │──── FAIL ──── Log & skip
│ (safety checks) │
└────────┬────────┘
         │ PASS
         ▼
┌─────────────────┐
│ Calculate Score  │──── < threshold ──── Alert only (no buy)
│ (0-100, base 0) │
└────────┬────────┘
         │ ≥ threshold
         ▼
┌─────────────────┐
│ Check Positions  │──── Max reached ──── Skip (log & continue)
│ (max 5 open)     │
└────────┬────────┘
         │ Slots available
         ▼
┌─────────────────┐
│ Get Jupiter Quote│
│ (best price)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Build & Sign TX  │
│ (VersionedTx)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Send to Solana   │
│ (skipPreflight)  │
└────────┬────────┘
         │
         ├──────────────────────┬──────────────────────┐
         ▼                      ▼                      ▼
┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Telegram Alert   │  │ Persist to disk  │  │ Register Position│
│ + Dashboard WS   │  │ (trades.json)    │  │ (TP/SL/trailing) │
└─────────────────┘  └──────────────────┘  └──────────────────┘
```

### Jupiter Swap

All trades go through Jupiter Aggregator (`https://quote-api.jup.ag/v6`), which:
- Finds the best price across all Solana DEXs (Raydium, Orca, Meteora, etc.)
- Handles WSOL wrapping/unwrapping automatically
- Supports versioned transactions for compute efficiency
- Applies configurable slippage and priority fees

---

## Customization

### Adding Wallets to Track

**Via dashboard API (recommended — persists automatically):**

```bash
curl -X POST http://localhost:3000/api/wallets \
  -H "Content-Type: application/json" \
  -d '{"address": "RealWalletHere", "label": "Top Trader", "copyPct": 50, "minTradeSol": 0.5}'
```

**Via code** — edit `src/modules/walletTracker.ts` defaults (loaded only if `data/wallets.json` doesn't exist):

```typescript
this.trackedWallets = [
  {
    address: 'RealWalletAddressHere',
    label: 'Top Trader',
    copyPct: 50,
    minTradeSol: 0.5,
    enabled: true,
  },
];
```

### Adding Influencers

**Via dashboard API (persists automatically):**

```bash
curl -X POST http://localhost:3000/api/influencers \
  -H "Content-Type: application/json" \
  -d '{"handle": "crypto_whale", "followers": 50000, "weight": 8}'
```

**Via code** — edit `src/modules/socialSentiment.ts`.

### Tuning Filters

#### Sniper filters (`src/modules/sniper.ts`):

```typescript
private filters = {
  minLiquiditySOL: 5,          // Increase for safer trades
  maxTopHolderPct: 30,         // Lower = safer but fewer trades
  requireMintRevoked: true,    // Set false for more trades (riskier)
  requireFreezeRevoked: true,
  minHolders: 10,              // Increase to avoid very early tokens
  maxAgeSeconds: 300,          // Decrease to only snipe very new tokens
};
```

#### Pump.fun filters (`src/modules/pumpfun.ts`):

```typescript
private filters = {
  minReplies: 3,               // Pump.fun comment count
  minMarketCapSOL: 2,          // Minimum to avoid dust
  maxMarketCapSOL: 100,        // Maximum to buy early
  minBuyCount: 5,              // Minimum buy transactions
  maxCreatorHoldPct: 30,       // Creator max holdings
  minUniqueTraders: 3,         // Avoid wash trading
  maxAgeMinutes: 30,           // Only recent tokens
  excludedKeywords: ['rug', 'scam', 'test'],
};
```

### Creating Backtest Strategies

```typescript
const myStrategy = {
  name: 'My Custom Strategy',
  filters: {
    minLiquidity: 3000,
    maxTopHolderPct: 20,
    requireMintRenounced: true,
    requireLpBurned: false,
    minHolders: 30,
    maxAgeMinutes: 45,
    minScore: 65,
  },
  entryRules: [
    { type: 'score_threshold', params: { min: 65 } },
    { type: 'volume_spike', params: { minVolumeUSD: 15000 } },
  ],
  exitRules: [
    { type: 'take_profit', params: { pct: 150 } },
    { type: 'stop_loss', params: { pct: 35 } },
    { type: 'trailing_stop', params: { pct: 25 } },
    { type: 'time_based', params: { maxHours: 8 } },
  ],
};
```

---

## Safety and Risk Management

### Critical Security Rules

1. **Never share your private key.** The `.env` file contains your wallet's private key. Never commit it to git, share it, or expose it.

2. **Use a dedicated wallet.** Create a new wallet specifically for this bot. Do not use your main wallet.

3. **Start small.** Set `MAX_BUY_SOL=0.01` initially. Only increase after extensive testing.

4. **Run backtests first.** Before trading real money, run the backtester to validate your filter settings.

5. **Monitor constantly at first.** Watch the Telegram alerts and dashboard closely during the first few days.

6. **The `.env` file must be in `.gitignore`.** This is already configured, but double-check before pushing to any repository.

7. **The `data/` directory is also in `.gitignore`.** Your trade history and wallet list are not committed to git.

### What the Filters Protect Against

| Risk | Protection |
|------|-----------|
| **Rug pulls** | Mint authority check, freeze authority check, LP burn check, holder concentration |
| **Honeypots** | Slippage limits, sell simulation (via Jupiter), buy/sell pattern detection (5+ buys with 0 sells) |
| **Wash trading** | Unique trader count, buy/sell ratio analysis, volume-weighted B/S ratio |
| **Serial scammers** | Creator history tracking, auto-blacklisting (persisted), blacklist check on every token |
| **Low liquidity** | Minimum liquidity filters, liquidity/mcap ratio |
| **API failures** | Fail-closed defaults — API errors assume unsafe (mintable, 100% holder concentration) |
| **Overexposure** | Max concurrent positions limit (default 5), per-module position checks |
| **Slow bleeds** | Trailing stop locks in profits, time-based exit closes stale positions |

### What the Filters Cannot Protect Against

- Tokens that pass all filters but still go to zero (most memecoins do)
- Coordinated pump-and-dump schemes with sophisticated execution
- Smart contract exploits in novel token designs
- Sudden liquidity removal after passing initial checks
- Market-wide crashes affecting all tokens simultaneously

---

## Troubleshooting

### Common Issues

**"Connection refused" on WebSocket**
- Check that your Helius API key is valid
- Verify the WebSocket URL format: `wss://mainnet.helius-rpc.com/?api-key=KEY`
- Helius free tier has rate limits — you may be temporarily blocked

**"Buy failed" errors**
- Insufficient SOL balance (need SOL for both the trade and gas fees)
- Slippage too low — increase `SLIPPAGE_BPS` (try 1000 for volatile tokens)
- Token may have trading restrictions (honeypot)
- Jupiter route may not exist yet for very new tokens

**"Telegram error"**
- Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are correct
- Make sure you sent at least one message to the bot before starting
- Check that the bot token has not been revoked

**"Rate limited" on Birdeye**
- Free tier: 100 requests/minute
- The bot makes many requests — consider a paid plan for heavy usage
- Or increase polling intervals in the modules

**Dashboard not loading**
- Check if port 3000 is available: `lsof -i :3000`
- Change the port in `.env` with `DASHBOARD_PORT=3001`

**Data not persisting**
- Check that `./data/` directory exists and is writable
- Look for `.bak.*` files — indicates a corrupted file was recovered
- Check console for `💾 Write error` messages
- Run `curl http://localhost:3000/api/storage/stats` to check file states

**Bot lost state after restart**
- Make sure the bot shut down gracefully (Ctrl+C, not kill -9)
- Check `data/` directory for the JSON files
- If files exist but are empty, check for `.tmp` files (incomplete writes)

**TypeScript compilation errors**
- Run `npx tsc --noEmit` to check for type errors
- Make sure all dependencies are installed: `npm install`

---

## Disclaimer

**This software is provided for educational and research purposes only.**

- Memecoin trading is extremely high-risk. The vast majority of memecoins go to zero.
- Past performance (including backtests) does not guarantee future results.
- Never invest more than you can afford to lose completely.
- This bot does not constitute financial advice.
- You are solely responsible for any trades executed by this bot.
- The authors are not liable for any financial losses.
- Always do your own research before trading.

---

## License

MIT