import WebSocket from 'ws';
import axios from 'axios';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { sendAlert, formatTradeAlert } from '../core/alerts';
import { storage } from '../core/storage';
import { CONFIG } from '../config';
import { TradeSignal } from '../types';

const PUMP_FUN_API = 'https://frontend-api.pump.fun';
const PUMP_FUN_WS = 'wss://pumpportal.fun/api/data';

// Browser-like headers to avoid 403
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://pump.fun',
  'Referer': 'https://pump.fun/',
};

interface PumpToken {
  mint: string; name: string; symbol: string; description: string;
  creator: string; created_timestamp: number; market_cap: number;
  reply_count: number; usd_market_cap: number;
  virtual_sol_reserves: number; virtual_token_reserves: number;
  complete: boolean;
}

interface PumpTrade {
  mint: string; sol_amount: number; token_amount: number;
  is_buy: boolean; user: string; timestamp: number;
  market_cap_sol: number;
}

// Data we get directly from the WebSocket (no API needed)
interface WSTokenData {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  timestamp: number;
  initialBuy?: number;
  marketCapSol?: number;
}

export class PumpFunModule {
  private jupiter: JupiterSwap;
  private ws: WebSocket | null = null;
  private processedMints = new Set<string>();
  private tokenTradeHistory = new Map<string, PumpTrade[]>();
  private creatorHistory = new Map<string, string[]>();
  private wsTokenCache = new Map<string, WSTokenData>(); // Cache WS data as fallback
  private apiWorking = true; // Track if Pump.fun API is responding

  private filters = {
    minReplies: 0,           // Lowered — WS data doesn't have replies
    minMarketCapSOL: 2,
    maxMarketCapSOL: 100,
    minBuyCount: 3,          // Lowered — 15s window doesn't always catch 5
    maxCreatorHoldPct: 30,
    minUniqueTraders: 2,     // Lowered
    maxAgeMinutes: 30,
    blacklistedCreators: new Set<string>(),
    excludedKeywords: ['rug', 'scam', 'test', 'airdrop'],
  };

  constructor() {
    this.jupiter = new JupiterSwap(connection, wallet);
    const bl = storage.getBlacklistSet();
    this.filters.blacklistedCreators = bl;
    if (bl.size > 0) console.log(`🟣 Loaded ${bl.size} blacklisted creators`);
  }

  async start() {
    console.log('🟣 Pump.fun Module started');
    await this.testApi();
    this.connectWebSocket();
    if (this.apiWorking) this.startBondingCurveMonitor();
  }

  // ==========================================
  // Test if Pump.fun API is accessible
  // ==========================================
  private async testApi() {
    try {
      const res = await axios.get(`${PUMP_FUN_API}/coins?offset=0&limit=1&sort=created_timestamp&order=DESC&includeNsfw=false`, {
        headers: BROWSER_HEADERS, timeout: 5000,
      });
      if (res.status === 200 && res.data) {
        console.log('🟣 Pump.fun API: ✅ Working');
        this.apiWorking = true;
      } else {
        console.log(`🟣 Pump.fun API: ⚠️ Status ${res.status} — using WS data only`);
        this.apiWorking = false;
      }
    } catch (err: any) {
      console.log(`🟣 Pump.fun API: ❌ ${err.message} — using WS data only`);
      this.apiWorking = false;
    }
  }

  // ==========================================
  // WebSocket
  // ==========================================
  private connectWebSocket() {
    this.ws = new WebSocket(PUMP_FUN_WS);

    this.ws.on('open', () => {
      console.log('🔌 Pump.fun WS connected');
      this.ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
      this.ws!.send(JSON.stringify({ method: 'subscribeTokenTrade' }));
    });

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.txType === 'create') await this.handleNewToken(msg);
        else if (msg.txType === 'buy' || msg.txType === 'sell') await this.handleTrade(msg);
      } catch {}
    });

    this.ws.on('error', (err) => {
      console.error(`🔌 Pump.fun WS error: ${err.message}`);
    });

    this.ws.on('close', (code) => {
      console.log(`🔌 Pump.fun WS closed (${code}), reconnecting in 5s...`);
      this.ws = null;
      setTimeout(() => this.connectWebSocket(), 5000);
    });
  }

  // ==========================================
  // New token from WebSocket
  // ==========================================
  private async handleNewToken(data: any) {
    const mint = data.mint;
    if (!mint || this.processedMints.has(mint)) return;

    console.log(`\n🆕 Pump.fun: ${data.name || '?'} (${data.symbol || '?'}) — ${mint}`);

    // Cache the WS data (this is our fallback if API fails)
    this.wsTokenCache.set(mint, {
      mint,
      name: data.name || 'Unknown',
      symbol: data.symbol || 'UNKNOWN',
      creator: data.traderPublicKey || data.creator || '',
      timestamp: Date.now(),
      initialBuy: data.initialBuy || 0,
      marketCapSol: data.marketCapSol || data.vSolInBondingCurve || 0,
    });

    const creator = data.traderPublicKey || data.creator;
    if (creator) {
      const existing = this.creatorHistory.get(creator) || [];
      existing.push(mint);
      this.creatorHistory.set(creator, existing);
    }

    const quickCheck = this.quickFilter(data);
    if (!quickCheck.passed) {
      console.log(`  ❌ Quick filter: ${quickCheck.reason}`);
      return;
    }

    console.log(`  ⏳ Waiting 15s for trade data...`);
    setTimeout(async () => { await this.evaluateToken(mint); }, 15000);
  }

  // ==========================================
  // Trade from WebSocket
  // ==========================================
  private async handleTrade(data: any) {
    const mint = data.mint;
    if (!mint) return;

    const trade: PumpTrade = {
      mint,
      sol_amount: data.solAmount || data.sol_amount || 0,
      token_amount: data.tokenAmount || data.token_amount || 0,
      is_buy: data.txType === 'buy',
      user: data.traderPublicKey || data.user || '',
      timestamp: data.timestamp || Math.floor(Date.now() / 1000),
      market_cap_sol: data.marketCapSol || data.vSolInBondingCurve || 0,
    };

    const trades = this.tokenTradeHistory.get(mint) || [];
    trades.push(trade);
    this.tokenTradeHistory.set(mint, trades);

    // Update cached market cap
    const cached = this.wsTokenCache.get(mint);
    if (cached && trade.market_cap_sol) {
      cached.marketCapSol = trade.market_cap_sol;
    }

    // Migration detection
    const mcapSol = trade.market_cap_sol || 0;
    if (mcapSol >= 80 && mcapSol <= 90) {
      await this.handleMigrationApproaching(mint, trade);
    }

    await this.detectVolumeSurge(mint);
  }

  // ==========================================
  // Evaluate token — tries API first, falls back to WS data
  // ==========================================
  private async evaluateToken(mint: string): Promise<number> {
    if (this.processedMints.has(mint)) return 0;

    try {
      // Try API first
      let tokenData: PumpToken | null = null;
      if (this.apiWorking) {
        tokenData = await this.getTokenData(mint);
      }

      // If API failed, build from WS cache + trade history
      if (!tokenData) {
        tokenData = this.buildFromWSData(mint);
        if (!tokenData) {
          console.log(`  ⚠️  No data for ${mint.slice(0, 8)}... (API down, no WS cache)`);
          return 0;
        }
        console.log(`  ℹ️  Using WebSocket data (API unavailable)`);
      }

      let score = 0;
      const reasons: string[] = [];
      const checks: string[] = [];

      console.log(`\n  📋 Evaluating: ${tokenData.symbol} (${tokenData.name})`);
      console.log(`  Mint: ${mint}`);

      // 1. Age
      const ageMinutes = (Date.now() - tokenData.created_timestamp) / 60000;
      if (ageMinutes > this.filters.maxAgeMinutes) {
        console.log(`  ❌ Age: ${ageMinutes.toFixed(0)}min — TOO OLD`);
        this.processedMints.add(mint);
        return 0;
      }
      if (ageMinutes < 5) { score += 10; reasons.push('Very new'); }
      checks.push(`  ${ageMinutes < 5 ? '✅' : 'ℹ️'} Age: ${ageMinutes.toFixed(1)}min`);

      // 2. Market cap (from WS trades or API)
      let mcapSol = 0;
      if (tokenData.virtual_sol_reserves) {
        mcapSol = tokenData.virtual_sol_reserves / LAMPORTS_PER_SOL;
      } else {
        // Estimate from latest trade data
        const trades = this.tokenTradeHistory.get(mint) || [];
        const latestTrade = trades[trades.length - 1];
        mcapSol = latestTrade?.market_cap_sol || 0;
      }

      if (mcapSol < this.filters.minMarketCapSOL && mcapSol > 0) {
        checks.push(`  ❌ MCap: ${mcapSol.toFixed(2)} SOL (min: ${this.filters.minMarketCapSOL}) — TOO LOW`);
        console.log(checks.join('\n'));
        this.processedMints.add(mint);
        return 0;
      }
      if (mcapSol > this.filters.maxMarketCapSOL) {
        checks.push(`  ❌ MCap: ${mcapSol.toFixed(2)} SOL (max: ${this.filters.maxMarketCapSOL}) — TOO HIGH`);
        console.log(checks.join('\n'));
        this.processedMints.add(mint);
        return 0;
      }
      // If mcap is 0, we don't have data — don't block, just note it
      if (mcapSol === 0) {
        checks.push(`  ⚠️ MCap: unknown (no data yet)`);
      } else {
        if (mcapSol >= 5 && mcapSol <= 30) { score += 15; reasons.push(`MCap: ${mcapSol.toFixed(1)} SOL`); }
        checks.push(`  ${mcapSol >= 5 && mcapSol <= 30 ? '✅' : 'ℹ️'} MCap: ${mcapSol.toFixed(2)} SOL`);
      }

      // 3. Replies (only if API data available)
      if (tokenData.reply_count !== undefined && tokenData.reply_count > 0) {
        if (tokenData.reply_count >= 10) { score += 15; reasons.push(`${tokenData.reply_count} replies`); }
        else if (tokenData.reply_count >= 3) { score += 8; }
        checks.push(`  ${tokenData.reply_count >= 10 ? '✅' : tokenData.reply_count >= 3 ? 'ℹ️' : '⚠️'} Replies: ${tokenData.reply_count}`);
      } else {
        checks.push(`  ℹ️  Replies: N/A (WS mode)`);
      }

      // 4. Trade analysis (from WS — this always works)
      const trades = this.tokenTradeHistory.get(mint) || [];
      const buys = trades.filter(t => t.is_buy);
      const sells = trades.filter(t => !t.is_buy);
      const uniqueTraders = new Set(trades.map(t => t.user)).size;

      const buysOk = buys.length >= this.filters.minBuyCount;
      if (buysOk) { score += 10; reasons.push(`${buys.length} buys`); }
      checks.push(`  ${buysOk ? '✅' : '⚠️'} Buys: ${buys.length} (min: ${this.filters.minBuyCount})`);

      const tradersOk = uniqueTraders >= this.filters.minUniqueTraders;
      if (tradersOk) { score += 10; reasons.push(`${uniqueTraders} traders`); }
      checks.push(`  ${tradersOk ? '✅' : '⚠️'} Unique traders: ${uniqueTraders} (min: ${this.filters.minUniqueTraders})`);

      // 5. Buy/sell ratio
      const ratio = sells.length > 0 ? buys.length / sells.length : buys.length;
      if (ratio >= 3) { score += 15; reasons.push(`B/S: ${ratio.toFixed(1)}`); }
      else if (ratio >= 1.5) { score += 8; }
      checks.push(`  ${ratio >= 3 ? '✅' : ratio >= 1.5 ? 'ℹ️' : '⚠️'} Buy/Sell: ${ratio.toFixed(1)} (${buys.length}b/${sells.length}s)`);

      // 6. Total SOL volume
      const totalBuyVolume = buys.reduce((s, t) => s + (t.sol_amount || 0), 0);
      if (totalBuyVolume >= 1) { score += 5; reasons.push(`Vol: ${totalBuyVolume.toFixed(1)} SOL`); }
      checks.push(`  ${totalBuyVolume >= 1 ? '✅' : 'ℹ️'} Buy volume: ${totalBuyVolume.toFixed(2)} SOL`);

      // 7. Creator holdings
      const creator = tokenData.creator;
      let creatorHoldPct = 0;
      if (creator) {
        creatorHoldPct = await this.getCreatorHoldingPct(mint, creator);
        if (creatorHoldPct <= 10) { score += 10; reasons.push('Creator < 10%'); }
        else if (creatorHoldPct > this.filters.maxCreatorHoldPct) { score -= 20; }
        checks.push(`  ${creatorHoldPct <= 10 ? '✅' : creatorHoldPct <= this.filters.maxCreatorHoldPct ? 'ℹ️' : '❌'} Creator: ${creatorHoldPct.toFixed(1)}% (max: ${this.filters.maxCreatorHoldPct}%)`);
      } else {
        checks.push(`  ℹ️  Creator: unknown`);
      }

      // 8. Bonding curve
      const bcProgress = mcapSol > 0 ? Math.min(100, (mcapSol / 85) * 100) : 0;
      if (bcProgress >= 60 && bcProgress <= 85) { score += 15; reasons.push(`BC: ${bcProgress.toFixed(0)}%`); }
      checks.push(`  ${bcProgress >= 60 && bcProgress <= 85 ? '✅' : 'ℹ️'} Bonding curve: ${bcProgress.toFixed(1)}%`);

      // Print results
      console.log(checks.join('\n'));
      console.log(`  🧮 Score: ${score}/100 (threshold: 50)`);

      this.processedMints.add(mint);

      if (score >= 50) {
        console.log(`  ✅ PASSED — ${reasons.join(' | ')}`);

        const buyAmount = this.calculateBuyAmount(score);

        await sendAlert(this.formatPumpAlert(tokenData, mcapSol, bcProgress, score, reasons));

        console.log(`  💰 Executing buy: ${buyAmount} SOL...`);
        const tx = await this.jupiter.buy(mint, buyAmount);
        if (tx) {
          console.log(`  ✅ BUY SUCCESS: https://solscan.io/tx/${tx}`);
          await sendAlert(`✅ Pump.fun snipe!\n💰 ${buyAmount} SOL\n🔗 https://solscan.io/tx/${tx}`);
          storage.addTrade({ id: tx, time: Date.now(), action: 'BUY', mint, symbol: tokenData.symbol, amountSol: buyAmount, price: 0, tx, source: 'SNIPE' });
        } else {
          console.log(`  ❌ BUY FAILED (Jupiter error)`);
        }
      } else {
        console.log(`  🚫 BLOCKED — Score ${score} < 50`);
        if (reasons.length > 0) console.log(`  Positive: ${reasons.join(' | ')}`);
      }

      return score;
    } catch (err: any) {
      console.error(`  ❌ Evaluate error: ${err.message}`);
      return 0;
    }
  }

  // ==========================================
  // Build PumpToken from WebSocket cached data
  // ==========================================
  private buildFromWSData(mint: string): PumpToken | null {
    const cached = this.wsTokenCache.get(mint);
    if (!cached) return null;

    const trades = this.tokenTradeHistory.get(mint) || [];
    const latestTrade = trades[trades.length - 1];
    const mcapSol = latestTrade?.market_cap_sol || cached.marketCapSol || 0;

    return {
      mint,
      name: cached.name,
      symbol: cached.symbol,
      description: '',
      creator: cached.creator,
      created_timestamp: cached.timestamp,
      market_cap: mcapSol,
      reply_count: 0,
      usd_market_cap: 0,
      virtual_sol_reserves: mcapSol * LAMPORTS_PER_SOL,
      virtual_token_reserves: 0,
      complete: false,
    };
  }

  // ==========================================
  // API with browser headers
  // ==========================================
  private async getTokenData(mint: string): Promise<PumpToken | null> {
    try {
      const res = await axios.get(`${PUMP_FUN_API}/coins/${mint}`, {
        headers: BROWSER_HEADERS,
        timeout: 5000,
      });

      if (res.status === 200 && res.data && res.data.mint) {
        return res.data;
      }

      console.log(`  ⚠️  API returned status ${res.status} for ${mint.slice(0, 8)}...`);
      return null;
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 403 || status === 429) {
        if (this.apiWorking) {
          console.log(`  ⚠️  Pump.fun API ${status} — switching to WS-only mode`);
          this.apiWorking = false;
        }
      } else if (status === 404) {
        // Token not indexed yet — normal for very new tokens
      } else {
        console.log(`  ⚠️  API error for ${mint.slice(0, 8)}...: ${err.message}`);
      }
      return null;
    }
  }

  // ==========================================
  // Other methods
  // ==========================================
  private async startBondingCurveMonitor() {
    const check = async () => {
      if (!this.apiWorking) { setTimeout(check, 30000); return; }
      try {
        const res = await axios.get(
          `${PUMP_FUN_API}/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false`,
          { headers: BROWSER_HEADERS, timeout: 5000 }
        );
        const tokens: PumpToken[] = res.data || [];
        for (const token of tokens) {
          if (token.complete || this.processedMints.has(token.mint)) continue;
          const progress = this.estimateBondingCurveProgress(token);
          if (progress >= 70 && progress <= 95) {
            console.log(`  📈 BC ${progress.toFixed(0)}%: ${token.symbol}`);
            await this.evaluateToken(token.mint);
          }
        }
      } catch (err: any) {
        if (err.response?.status === 403 || err.response?.status === 429) {
          console.log('  ⚠️  BC monitor: API blocked, pausing...');
          this.apiWorking = false;
        }
      }
      setTimeout(check, 20000);
    };
    check();
  }

  private async handleMigrationApproaching(mint: string, trade: PumpTrade) {
    if (this.processedMints.has(`migration_${mint}`)) return;
    this.processedMints.add(`migration_${mint}`);

    console.log(`\n  🚀 MIGRATION approaching: ${mint.slice(0, 8)}... (${trade.market_cap_sol?.toFixed(1)} SOL)`);
    await sendAlert(`🚀 <b>MIGRAÇÃO IMINENTE</b>\nMint: <code>${mint}</code>\nMCap: ${trade.market_cap_sol?.toFixed(1)} SOL`);

    const buyAmount = CONFIG.trading.maxBuySol * 0.5;
    console.log(`  💰 Migration snipe: ${buyAmount} SOL...`);
    const tx = await this.jupiter.buy(mint, buyAmount);
    if (tx) {
      console.log(`  ✅ SUCCESS: https://solscan.io/tx/${tx}`);
      storage.addTrade({ id: tx, time: Date.now(), action: 'BUY', mint, symbol: mint.slice(0, 8), amountSol: buyAmount, price: 0, tx, source: 'SNIPE' });
    } else {
      console.log(`  ❌ Migration snipe FAILED`);
    }
  }

  private async detectVolumeSurge(mint: string) {
    const trades = this.tokenTradeHistory.get(mint) || [];
    if (trades.length < 10) return;
    const now = Date.now();
    const last60s = trades.filter(t => now - t.timestamp * 1000 < 60000);
    const prev60s = trades.filter(t => { const age = now - t.timestamp * 1000; return age >= 60000 && age < 120000; });

    if (last60s.length >= 3 * Math.max(prev60s.length, 1) && last60s.length >= 8) {
      const buyPct = (last60s.filter(t => t.is_buy).length / last60s.length) * 100;
      if (buyPct >= 70 && !this.processedMints.has(mint)) {
        console.log(`\n  🔥 Volume surge: ${mint.slice(0, 8)}... (${last60s.length} trades/min, ${buyPct.toFixed(0)}% buys)`);
        await this.evaluateToken(mint);
      }
    }
  }

  private quickFilter(data: any): { passed: boolean; reason: string } {
    const combined = `${data.name || ''} ${data.symbol || ''} ${data.description || ''}`.toLowerCase();
    for (const kw of this.filters.excludedKeywords) {
      if (combined.includes(kw)) return { passed: false, reason: `Keyword: "${kw}"` };
    }
    const creator = data.traderPublicKey || data.creator;
    if (creator && this.filters.blacklistedCreators.has(creator)) return { passed: false, reason: 'Blacklisted creator' };
    const creatorTokens = creator ? (this.creatorHistory.get(creator) || []) : [];
    if (creatorTokens.length > 5) {
      storage.addToBlacklist(creator, `Serial deployer: ${creatorTokens.length} tokens`, 'auto');
      return { passed: false, reason: `Serial deployer (${creatorTokens.length} tokens)` };
    }
    return { passed: true, reason: 'OK' };
  }

  private async getCreatorHoldingPct(mint: string, creator: string): Promise<number> {
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(
        new PublicKey(creator), { mint: new PublicKey(mint) }
      );
      if (accounts.value.length === 0) return 0;
      const balance = accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
      return (balance / 1_000_000_000) * 100;
    } catch { return 0; }
  }

  private estimateBondingCurveProgress(token: PumpToken): number {
    const currentSol = (token.virtual_sol_reserves || 0) / LAMPORTS_PER_SOL;
    return Math.min(100, (currentSol / 85) * 100);
  }

  private calculateBuyAmount(score: number): number {
    const max = CONFIG.trading.maxBuySol;
    if (score >= 90) return max;
    if (score >= 80) return max * 0.75;
    if (score >= 70) return max * 0.5;
    return max * 0.3;
  }

  private formatPumpAlert(token: PumpToken, mcapSol: number, bcProgress: number, score: number, reasons: string[]): string {
    return [
      `🟣 <b>PUMP.FUN</b> | Score: ${score}`,
      `Token: <b>${token.symbol}</b> - ${token.name}`,
      `Mint: <code>${token.mint}</code>`,
      `💰 MCap: ${mcapSol.toFixed(1)} SOL | 📈 BC: ${bcProgress.toFixed(0)}%`,
      `📋 ${reasons.join(' | ')}`,
      `<a href="https://pump.fun/${token.mint}">Pump.fun</a> | <a href="https://solscan.io/token/${token.mint}">Solscan</a>`,
    ].join('\n');
  }

  getStats() {
    return {
      processedTokens: this.processedMints.size,
      trackedTrades: Array.from(this.tokenTradeHistory.values()).reduce((a, b) => a + b.length, 0),
      knownCreators: this.creatorHistory.size,
      blacklistedCreators: this.filters.blacklistedCreators.size,
      apiWorking: this.apiWorking,
    };
  }
}