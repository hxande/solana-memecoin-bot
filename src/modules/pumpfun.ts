import WebSocket from 'ws';
import axios from 'axios';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { PumpSwap } from '../core/pumpSwap';
import { sendAlert } from '../core/alerts';
import { storage } from '../core/storage';
import { CONFIG } from '../config';
import { PositionManager } from './positionManager';

const PUMP_FUN_API = 'https://frontend-api.pump.fun';
const PUMP_FUN_WS = 'wss://pumpportal.fun/api/data';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun/',
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

interface WSTokenData {
  mint: string; name: string; symbol: string; creator: string;
  timestamp: number; initialBuy?: number; marketCapSol?: number;
}

export class PumpFunModule {
  private jupiter: JupiterSwap;
  private pumpSwap: PumpSwap;
  private ws: WebSocket | null = null;
  private processedMints = new Set<string>();
  private tokenTradeHistory = new Map<string, PumpTrade[]>();
  private creatorHistory = new Map<string, string[]>();
  private wsTokenCache = new Map<string, WSTokenData>();
  private apiWorking = true;
  private positionManager: PositionManager | null = null;
  private _running = false;
  private _reconnect = true;
  private _timers: NodeJS.Timeout[] = [];

  private filters = {
    minReplies: 0,
    minMarketCapSOL: 2,
    maxMarketCapSOL: 100,
    minBuyCount: 3,
    maxCreatorHoldPct: 30,
    minUniqueTraders: 2,
    maxAgeMinutes: 30,
    blacklistedCreators: new Set<string>(),
    excludedKeywords: ['rug', 'scam', 'test', 'airdrop'],
  };

  constructor(positionManager?: PositionManager) {
    this.jupiter = new JupiterSwap(connection, wallet);
    this.pumpSwap = new PumpSwap(connection, wallet);
    this.positionManager = positionManager || null;
    const bl = storage.getBlacklistSet();
    this.filters.blacklistedCreators = bl;
    if (bl.size > 0) console.log(`🟣 Loaded ${bl.size} blacklisted creators`);
  }

  async start() {
    this._running = true;
    this._reconnect = true;
    console.log('🟣 Pump.fun Module started');
    await this.testApi();
    this.connectWebSocket();
    if (this.apiWorking) this.startBondingCurveMonitor();
    this.startCleanupTimer();
  }

  stop() {
    this._running = false;
    this._reconnect = false;
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    console.log('🟣 Pump.fun Module stopped');
  }

  isRunning() { return this._running; }

  // ══════════════════════════════
  // Test API
  // ══════════════════════════════
  private async testApi() {
    try {
      const res = await axios.get(`${PUMP_FUN_API}/coins?offset=0&limit=1&sort=created_timestamp&order=DESC&includeNsfw=false`, {
        headers: BROWSER_HEADERS, timeout: 5000,
      });
      if (res.status === 200 && res.data) {
        console.log('🟣 Pump.fun API: ✅ Working');
        this.apiWorking = true;
      } else {
        console.log(`🟣 Pump.fun API: ⚠️ Status ${res.status} — WS only`);
        this.apiWorking = false;
      }
    } catch (err: any) {
      console.log(`🟣 Pump.fun API: ❌ ${err.message} — WS only`);
      this.apiWorking = false;
    }
  }

  // ══════════════════════════════
  // WebSocket
  // ══════════════════════════════
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
      } catch (err: any) {
        console.error(`🟣 WS parse error: ${err.message}`);
      }
    });

    this.ws.on('error', (err) => console.error(`🔌 Pump.fun WS error: ${err.message}`));
    this.ws.on('close', (code) => {
      console.log(`🔌 Pump.fun WS closed (${code})${this._reconnect ? ', reconnecting 5s...' : ''}`);
      this.ws = null;
      if (this._reconnect) {
        const t = setTimeout(() => this.connectWebSocket(), 5000);
        this._timers.push(t);
      }
    });
  }

  // ══════════════════════════════
  // New Token
  // ══════════════════════════════
  private async handleNewToken(data: any) {
    const mint = data.mint;
    if (!mint || this.processedMints.has(mint)) return;

    console.log(`\n🆕 Pump.fun: ${data.name || '?'} (${data.symbol || '?'}) — ${mint}`);

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

    const qc = this.quickFilter(data);
    if (!qc.passed) { console.log(`  ❌ Quick filter: ${qc.reason}`); return; }

    console.log(`  ⏳ Waiting 15s for trade data...`);
    if (this._running) this._timers.push(setTimeout(async () => { await this.evaluateToken(mint); }, 15000));
  }

  // ══════════════════════════════
  // Trade
  // ══════════════════════════════
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

    const cached = this.wsTokenCache.get(mint);
    if (cached && trade.market_cap_sol) cached.marketCapSol = trade.market_cap_sol;

    if (trade.market_cap_sol >= 80 && trade.market_cap_sol <= 90) {
      await this.handleMigrationApproaching(mint, trade);
    }

    await this.detectVolumeSurge(mint);
  }

  // ══════════════════════════════
  // Evaluate Token — tightened scoring
  // ══════════════════════════════
  private async evaluateToken(mint: string): Promise<number> {
    if (this.processedMints.has(mint)) return 0;

    try {
      let tokenData: PumpToken | null = null;

      if (this.apiWorking) {
        tokenData = await this.getTokenData(mint);
      }

      if (!tokenData) {
        tokenData = this.buildFromWSData(mint);
        if (!tokenData) {
          console.log(`  ⚠️  No data for ${mint.slice(0, 8)}... (no API, no WS cache)`);
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
      const ageMin = (Date.now() - tokenData.created_timestamp) / 60000;
      if (ageMin > this.filters.maxAgeMinutes) {
        console.log(`  ❌ Age: ${ageMin.toFixed(0)}min — TOO OLD`);
        this.processedMints.add(mint);
        return 0;
      }
      if (ageMin < 5) { score += 10; reasons.push('Very new'); }
      checks.push(`  ${ageMin < 5 ? '✅' : 'ℹ️'} Age: ${ageMin.toFixed(1)}min`);

      // 2. Market cap
      let mcapSol = 0;
      if (tokenData.virtual_sol_reserves) {
        mcapSol = tokenData.virtual_sol_reserves / LAMPORTS_PER_SOL;
      } else {
        const trades = this.tokenTradeHistory.get(mint) || [];
        mcapSol = trades[trades.length - 1]?.market_cap_sol || 0;
      }

      if (mcapSol > 0 && mcapSol < this.filters.minMarketCapSOL) {
        checks.push(`  ❌ MCap: ${mcapSol.toFixed(2)} SOL — TOO LOW`);
        console.log(checks.join('\n'));
        this.processedMints.add(mint);
        return 0;
      }
      if (mcapSol > this.filters.maxMarketCapSOL) {
        checks.push(`  ❌ MCap: ${mcapSol.toFixed(2)} SOL — TOO HIGH`);
        console.log(checks.join('\n'));
        this.processedMints.add(mint);
        return 0;
      }
      if (mcapSol === 0) {
        checks.push(`  ⚠️ MCap: unknown`);
      } else {
        // Reduced: +10 for sweet spot (was +15)
        if (mcapSol >= 5 && mcapSol <= 30) { score += 10; reasons.push(`MCap: ${mcapSol.toFixed(1)} SOL`); }
        checks.push(`  ${mcapSol >= 5 && mcapSol <= 30 ? '✅' : 'ℹ️'} MCap: ${mcapSol.toFixed(2)} SOL`);
      }

      // 3. Replies (API only)
      if (tokenData.reply_count > 0) {
        if (tokenData.reply_count >= 10) { score += 15; reasons.push(`${tokenData.reply_count} replies`); }
        else if (tokenData.reply_count >= 3) { score += 8; }
        checks.push(`  ${tokenData.reply_count >= 10 ? '✅' : 'ℹ️'} Replies: ${tokenData.reply_count}`);
      } else {
        checks.push(`  ℹ️  Replies: N/A`);
      }

      // 4. Trades — tightened scoring
      const trades = this.tokenTradeHistory.get(mint) || [];
      const buys = trades.filter(t => t.is_buy);
      const sells = trades.filter(t => !t.is_buy);
      const uniqueTraders = new Set(trades.map(t => t.user)).size;

      // Buys: tiered scoring (was flat +10 at 3)
      if (buys.length >= 8) { score += 10; reasons.push(`${buys.length} buys`); }
      else if (buys.length >= this.filters.minBuyCount) { score += 5; reasons.push(`${buys.length} buys`); }
      checks.push(`  ${buys.length >= 8 ? '✅' : buys.length >= this.filters.minBuyCount ? 'ℹ️' : '⚠️'} Buys: ${buys.length} (min: ${this.filters.minBuyCount})`);

      // Unique traders: tiered (was flat +10 at 2)
      if (uniqueTraders >= 5) { score += 10; reasons.push(`${uniqueTraders} traders`); }
      else if (uniqueTraders >= this.filters.minUniqueTraders) { score += 5; reasons.push(`${uniqueTraders} traders`); }
      checks.push(`  ${uniqueTraders >= 5 ? '✅' : uniqueTraders >= this.filters.minUniqueTraders ? 'ℹ️' : '⚠️'} Traders: ${uniqueTraders} (min: ${this.filters.minUniqueTraders})`);

      // 5. Buy/sell ratio (count-based)
      const ratio = sells.length > 0 ? buys.length / sells.length : buys.length;
      if (ratio >= 3) { score += 15; reasons.push(`B/S: ${ratio.toFixed(1)}`); }
      else if (ratio >= 1.5) { score += 8; }
      checks.push(`  ${ratio >= 3 ? '✅' : ratio >= 1.5 ? 'ℹ️' : '⚠️'} B/S count: ${ratio.toFixed(1)} (${buys.length}b/${sells.length}s)`);

      // Volume-weighted B/S ratio
      const buyVolSol = buys.reduce((s, t) => s + (t.sol_amount || 0), 0);
      const sellVolSol = sells.reduce((s, t) => s + (t.sol_amount || 0), 0);
      if (sellVolSol > 0 && sellVolSol > 2 * buyVolSol) {
        score -= 15;
        checks.push(`  ❌ Sell volume ${sellVolSol.toFixed(2)} SOL > 2x buy volume ${buyVolSol.toFixed(2)} SOL (-15)`);
      }

      // 6. Volume — require minimum 1 SOL total
      const vol = buyVolSol;
      if (vol >= 1) { score += 5; reasons.push(`Vol: ${vol.toFixed(1)} SOL`); }
      checks.push(`  ${vol >= 1 ? '✅' : 'ℹ️'} Volume: ${vol.toFixed(2)} SOL`);

      // 7. Creator holdings — use actual token supply
      const creator = tokenData.creator;
      if (creator) {
        const holdPct = await this.getCreatorHoldingPct(mint, creator);
        if (holdPct <= 10) { score += 10; reasons.push('Creator < 10%'); }
        else if (holdPct > this.filters.maxCreatorHoldPct) { score -= 20; }
        checks.push(`  ${holdPct <= 10 ? '✅' : holdPct <= this.filters.maxCreatorHoldPct ? 'ℹ️' : '❌'} Creator: ${holdPct.toFixed(1)}%`);
      }

      // 8. Bonding curve — reduced from +15 to +10
      const bcPct = mcapSol > 0 ? Math.min(100, (mcapSol / 85) * 100) : 0;
      if (bcPct >= 60 && bcPct <= 85) { score += 10; reasons.push(`BC: ${bcPct.toFixed(0)}%`); }
      checks.push(`  ${bcPct >= 60 && bcPct <= 85 ? '✅' : 'ℹ️'} BC: ${bcPct.toFixed(1)}%`);

      // 9. Honeypot check: if > 30s of trading with 5+ buys and 0 sells, penalize
      if (trades.length > 0) {
        const tradingDurationSec = (Date.now() / 1000) - trades[0].timestamp;
        if (tradingDurationSec > 30 && buys.length >= 5 && sells.length === 0) {
          score -= 20;
          checks.push(`  ⚠️ Honeypot signal: ${buys.length} buys, 0 sells in ${tradingDurationSec.toFixed(0)}s (-20)`);
        }
      }

      const minScore = CONFIG.trading.pumpfunMinScore;
      console.log(checks.join('\n'));
      console.log(`  🧮 Score: ${score}/100 (threshold: ${minScore})`);

      this.processedMints.add(mint);

      if (score >= minScore) {
        // Check max positions before buying
        if (this.positionManager && !this.positionManager.canOpenPosition()) {
          console.log(`  ⏭️  Max positions (${CONFIG.trading.maxPositions}) reached — skipping buy`);
          return score;
        }

        console.log(`  ✅ PASSED — ${reasons.join(' | ')}`);
        const buyAmount = this.calculateBuyAmount(score);
        await sendAlert(this.formatPumpAlert(tokenData, mcapSol, bcPct, score, reasons));
        await this.executeBuy(mint, tokenData.symbol, buyAmount, tokenData.complete || false);
      } else {
        console.log(`  🚫 BLOCKED — Score ${score} < ${minScore}`);
        if (reasons.length > 0) console.log(`  Positive: ${reasons.join(' | ')}`);
      }

      return score;
    } catch (err: any) {
      console.error(`  ❌ Evaluate error: ${err.message}`);
      return 0;
    }
  }

  // ══════════════════════════════
  // Execute buy — bonding curve OR Jupiter
  // ══════════════════════════════
  private async executeBuy(mint: string, symbol: string, amountSol: number, migrated: boolean) {
    console.log(`  💰 Buying ${amountSol} SOL of ${symbol}...`);

    let tx: string | null = null;
    let method: string;

    if (migrated) {
      // Already on Raydium — use Jupiter
      console.log(`  🔄 Route: Jupiter (token migrated)`);
      method = 'JUPITER';
      tx = await this.jupiter.buy(mint, amountSol);
    } else {
      // Still on bonding curve — buy directly on-chain
      const onCurve = await this.pumpSwap.isOnBondingCurve(mint);
      if (onCurve) {
        console.log(`  🔄 Route: PumpSwap (bonding curve)`);
        method = 'PUMP_ONCHAIN';
        tx = await this.pumpSwap.buy(mint, amountSol, CONFIG.trading.slippageBps / 100);
      } else {
        // Might have just migrated
        console.log(`  🔄 Route: Jupiter (curve completed)`);
        method = 'JUPITER';
        tx = await this.jupiter.buy(mint, amountSol);
      }
    }

    if (tx) {
      console.log(`  ✅ BUY SUCCESS [${method}]: https://solscan.io/tx/${tx}`);
      await sendAlert(`✅ Pump.fun snipe [${method}]!\n💰 ${amountSol} SOL\n🔗 https://solscan.io/tx/${tx}`);
      storage.addTrade({
        id: tx, time: Date.now(), action: 'BUY', mint, symbol,
        amountSol, price: 0, tx, source: 'SNIPE',
      });

      // Register position with PositionManager
      if (this.positionManager) {
        const price = await this.jupiter.getPrice(mint);
        this.positionManager.addPosition({
          mint, symbol, entryPrice: price,
          amount: amountSol, entryTime: Date.now(), source: 'SNIPE',
        });
      }
    } else {
      console.log(`  ❌ BUY FAILED [${method}]`);
      await sendAlert(`❌ Buy falhou: ${symbol}\nMint: ${mint}\nRoute: ${method}`);
    }
  }

  // ══════════════════════════════
  // Migration approaching
  // ══════════════════════════════
  private async handleMigrationApproaching(mint: string, trade: PumpTrade) {
    if (this.processedMints.has(`migration_${mint}`)) return;
    this.processedMints.add(`migration_${mint}`);

    const symbol = this.wsTokenCache.get(mint)?.symbol || mint.slice(0, 8);
    console.log(`\n  🚀 MIGRATION approaching: ${symbol} (${trade.market_cap_sol?.toFixed(1)} SOL)`);
    await sendAlert(`🚀 <b>MIGRAÇÃO IMINENTE</b>\n${symbol}\nMint: <code>${mint}</code>\nMCap: ${trade.market_cap_sol?.toFixed(1)} SOL`);

    // Check max positions before migration buy
    if (this.positionManager && !this.positionManager.canOpenPosition()) {
      console.log(`  ⏭️  Max positions reached — skipping migration buy`);
      return;
    }

    const buyAmount = CONFIG.trading.maxBuySol * 0.5;
    await this.executeBuy(mint, symbol, buyAmount, false);
  }

  // ══════════════════════════════
  // Volume surge detection — with minimum volume requirement
  // ══════════════════════════════
  private async detectVolumeSurge(mint: string) {
    const trades = this.tokenTradeHistory.get(mint) || [];
    if (trades.length < 10) return;
    const now = Date.now();
    const last60 = trades.filter(t => now - t.timestamp * 1000 < 60000);
    const prev60 = trades.filter(t => { const a = now - t.timestamp * 1000; return a >= 60000 && a < 120000; });

    if (last60.length >= 3 * Math.max(prev60.length, 1) && last60.length >= 8) {
      // Require minimum 1 SOL total volume
      const totalVol = last60.reduce((s, t) => s + (t.sol_amount || 0), 0);
      if (totalVol < 1) return;

      const buyPct = (last60.filter(t => t.is_buy).length / last60.length) * 100;
      if (buyPct >= 70 && !this.processedMints.has(mint)) {
        console.log(`\n  🔥 Volume surge: ${mint.slice(0, 8)}... (${last60.length} trades/min, ${buyPct.toFixed(0)}% buys, ${totalVol.toFixed(2)} SOL)`);
        await this.evaluateToken(mint);
      }
    }
  }

  // ══════════════════════════════
  // Helpers
  // ══════════════════════════════
  private buildFromWSData(mint: string): PumpToken | null {
    const c = this.wsTokenCache.get(mint);
    if (!c) return null;
    const trades = this.tokenTradeHistory.get(mint) || [];
    const mcap = trades[trades.length - 1]?.market_cap_sol || c.marketCapSol || 0;
    return {
      mint, name: c.name, symbol: c.symbol, description: '', creator: c.creator,
      created_timestamp: c.timestamp, market_cap: mcap, reply_count: 0,
      usd_market_cap: 0, virtual_sol_reserves: mcap * LAMPORTS_PER_SOL,
      virtual_token_reserves: 0, complete: false,
    };
  }

  private async getTokenData(mint: string): Promise<PumpToken | null> {
    try {
      const res = await axios.get(`${PUMP_FUN_API}/coins/${mint}`, {
        headers: BROWSER_HEADERS, timeout: 5000,
      });
      if (res.status === 200 && res.data?.mint) return res.data;
      console.log(`  ⚠️  API status ${res.status} for ${mint.slice(0, 8)}...`);
      return null;
    } catch (err: any) {
      const st = err.response?.status;
      if ((st === 403 || st === 429) && this.apiWorking) {
        console.log(`  ⚠️  Pump.fun API ${st} — switching to WS-only`);
        this.apiWorking = false;
      } else if (st !== 404) {
        console.log(`  ⚠️  API error ${mint.slice(0, 8)}...: ${err.message}`);
      }
      return null;
    }
  }

  private async startBondingCurveMonitor() {
    const check = async () => {
      if (!this._running) return;
      if (!this.apiWorking) { this._timers.push(setTimeout(check, 30000)); return; }
      try {
        const res = await axios.get(
          `${PUMP_FUN_API}/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false`,
          { headers: BROWSER_HEADERS, timeout: 5000 }
        );
        for (const token of (res.data || []) as PumpToken[]) {
          if (token.complete || this.processedMints.has(token.mint)) continue;
          const p = this.estimateBCProgress(token);
          if (p >= 70 && p <= 95) {
            console.log(`  📈 BC ${p.toFixed(0)}%: ${token.symbol}`);
            await this.evaluateToken(token.mint);
          }
        }
      } catch (err: any) {
        if (err.response?.status === 403 || err.response?.status === 429) {
          console.log('  ⚠️  BC monitor: API blocked');
          this.apiWorking = false;
        } else {
          console.error(`  ⚠️  BC monitor error: ${err.message}`);
        }
      }
      if (this._running) this._timers.push(setTimeout(check, 20000));
    };
    check();
  }

  private quickFilter(data: any): { passed: boolean; reason: string } {
    const text = `${data.name || ''} ${data.symbol || ''} ${data.description || ''}`.toLowerCase();
    for (const kw of this.filters.excludedKeywords) {
      if (text.includes(kw)) return { passed: false, reason: `Keyword: "${kw}"` };
    }
    const creator = data.traderPublicKey || data.creator;
    if (creator && this.filters.blacklistedCreators.has(creator)) return { passed: false, reason: 'Blacklisted' };
    const ct = creator ? (this.creatorHistory.get(creator) || []) : [];
    if (ct.length > 5) {
      storage.addToBlacklist(creator, `Serial deployer: ${ct.length}`, 'auto');
      return { passed: false, reason: `Serial deployer (${ct.length})` };
    }
    return { passed: true, reason: 'OK' };
  }

  private async getCreatorHoldingPct(mint: string, creator: string): Promise<number> {
    try {
      const accs = await connection.getParsedTokenAccountsByOwner(
        new PublicKey(creator), { mint: new PublicKey(mint) }
      );
      if (accs.value.length === 0) return 0;
      const bal = accs.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;

      // Get actual token supply instead of hardcoded 1B
      let totalSupply = 1_000_000_000; // fallback
      try {
        const supplyInfo = await connection.getTokenSupply(new PublicKey(mint));
        totalSupply = parseFloat(supplyInfo.value.uiAmountString || '1000000000');
      } catch {
        // Use fallback
      }

      return (bal / totalSupply) * 100;
    } catch (err: any) {
      console.error(`  ⚠️  Creator hold check error: ${err.message}`);
      // Fail-closed: return 50% (suspicious) instead of 0 (safe)
      return 50;
    }
  }

  private estimateBCProgress(token: PumpToken): number {
    return Math.min(100, ((token.virtual_sol_reserves || 0) / LAMPORTS_PER_SOL / 85) * 100);
  }

  private calculateBuyAmount(score: number): number {
    const max = CONFIG.trading.maxBuySol;
    if (score >= 90) return max;
    if (score >= 80) return max * 0.75;
    if (score >= 70) return max * 0.5;
    return max * 0.3;
  }

  private formatPumpAlert(token: PumpToken, mcap: number, bc: number, score: number, reasons: string[]): string {
    return [
      `🟣 <b>PUMP.FUN</b> | Score: ${score}`,
      `Token: <b>${token.symbol}</b> - ${token.name}`,
      `Mint: <code>${token.mint}</code>`,
      `💰 MCap: ${mcap.toFixed(1)} SOL | 📈 BC: ${bc.toFixed(0)}%`,
      `📋 ${reasons.join(' | ')}`,
      `<a href="https://pump.fun/${token.mint}">Pump.fun</a> | <a href="https://solscan.io/token/${token.mint}">Solscan</a>`,
    ].join('\n');
  }

  // ══════════════════════════════
  // Memory cleanup
  // ══════════════════════════════
  private startCleanupTimer() {
    const id = setInterval(() => {
      if (!this._running) { clearInterval(id); return; }
      const oneHourAgo = Date.now() - 60 * 60 * 1000;

      // Trim processedMints
      if (this.processedMints.size > 10000) {
        const arr = Array.from(this.processedMints);
        this.processedMints = new Set(arr.slice(arr.length - 5000));
        console.log(`🟣 Trimmed processedMints: ${arr.length} → ${this.processedMints.size}`);
      }

      // Trim tokenTradeHistory — remove entries older than 1 hour
      for (const [mint, trades] of this.tokenTradeHistory) {
        if (trades.length > 0 && trades[trades.length - 1].timestamp * 1000 < oneHourAgo) {
          this.tokenTradeHistory.delete(mint);
        }
      }

      // Trim wsTokenCache — remove entries older than 1 hour
      for (const [mint, data] of this.wsTokenCache) {
        if (data.timestamp < oneHourAgo) {
          this.wsTokenCache.delete(mint);
        }
      }
    }, 10 * 60 * 1000); // every 10 minutes
    this._timers.push(id);
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
