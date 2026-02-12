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

export class PumpFunModule {
  private jupiter: JupiterSwap;
  private ws: WebSocket | null = null;
  private processedMints = new Set<string>();
  private tokenTradeHistory = new Map<string, PumpTrade[]>();
  private creatorHistory = new Map<string, string[]>();

  private filters = {
    minReplies: 3, minMarketCapSOL: 2, maxMarketCapSOL: 100,
    minBuyCount: 5, maxCreatorHoldPct: 30, minUniqueTraders: 3,
    maxAgeMinutes: 30, blacklistedCreators: new Set<string>(),
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
    this.connectWebSocket();
    this.startPollingNewTokens();
    this.startBondingCurveMonitor();
  }

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
    this.ws.on('close', () => {
      console.log('🔌 Pump.fun WS disconnected, reconnecting...');
      setTimeout(() => this.connectWebSocket(), 3000);
    });

    this.ws.on('error', (err) => {
      console.error(`🔌 Pump.fun WS error: ${err.message}`);
      console.log('⚠️  WebSocket bloqueado (Zscaler/firewall?). Pump.fun em modo polling.');
    });
  }

  private async handleNewToken(data: any) {
    const mint = data.mint;
    if (!mint || this.processedMints.has(mint)) return;
    console.log(`🆕 Pump.fun: ${data.name} (${data.symbol})`);

    const creator = data.traderPublicKey || data.creator;
    if (creator) {
      const existing = this.creatorHistory.get(creator) || [];
      existing.push(mint);
      this.creatorHistory.set(creator, existing);
    }

    const quickCheck = this.quickFilter(data);
    if (!quickCheck.passed) return;

    setTimeout(async () => { await this.evaluateToken(mint); }, 15000);
  }

  private async handleTrade(data: PumpTrade) {
    const trades = this.tokenTradeHistory.get(data.mint) || [];
    trades.push(data);
    this.tokenTradeHistory.set(data.mint, trades);

    const mcapSol = data.market_cap_sol || 0;
    if (mcapSol >= 80 && mcapSol <= 90) {
      await this.handleMigrationApproaching(data.mint, data);
    }
    await this.detectVolumeSurge(data.mint);
  }

  private async evaluateToken(mint: string): Promise<number> {
    try {
      const tokenData = await this.getTokenData(mint);
      if (!tokenData) return 0;

      let score = 0;
      const reasons: string[] = [];

      const ageMinutes = (Date.now() - tokenData.created_timestamp) / 60000;
      if (ageMinutes > this.filters.maxAgeMinutes) return 0;
      if (ageMinutes < 5) { score += 10; reasons.push('Muito novo'); }

      const mcapSol = tokenData.virtual_sol_reserves / LAMPORTS_PER_SOL || 0;
      if (mcapSol < this.filters.minMarketCapSOL || mcapSol > this.filters.maxMarketCapSOL) return 0;
      if (mcapSol >= 5 && mcapSol <= 30) { score += 15; reasons.push(`MCap: ${mcapSol.toFixed(1)} SOL`); }

      if (tokenData.reply_count >= 10) { score += 15; reasons.push(`${tokenData.reply_count} replies`); }
      else if (tokenData.reply_count >= this.filters.minReplies) { score += 8; }

      const trades = this.tokenTradeHistory.get(mint) || [];
      const buys = trades.filter(t => t.is_buy);
      const sells = trades.filter(t => !t.is_buy);
      const uniqueTraders = new Set(trades.map(t => t.user)).size;

      if (buys.length >= this.filters.minBuyCount) { score += 10; reasons.push(`${buys.length} buys`); }
      if (uniqueTraders >= this.filters.minUniqueTraders) { score += 10; reasons.push(`${uniqueTraders} traders`); }

      const buySellRatio = sells.length > 0 ? buys.length / sells.length : buys.length;
      if (buySellRatio >= 3) { score += 15; reasons.push(`B/S ratio: ${buySellRatio.toFixed(1)}`); }

      const creatorHoldPct = await this.getCreatorHoldingPct(mint, tokenData.creator);
      if (creatorHoldPct <= 10) { score += 10; reasons.push('Creator < 10%'); }
      else if (creatorHoldPct > this.filters.maxCreatorHoldPct) score -= 20;

      const bcProgress = this.estimateBondingCurveProgress(tokenData);
      if (bcProgress >= 60 && bcProgress <= 85) {
        score += 15; reasons.push(`BC: ${bcProgress.toFixed(0)}%`);
      }

      this.processedMints.add(mint);

      if (score >= 60) {
        const signal: TradeSignal = {
          type: 'SNIPE', action: 'BUY', mint,
          reason: `Pump.fun | Score: ${score} | ${reasons.join(' | ')}`,
          confidence: Math.min(100, score),
          amountSol: this.calculateBuyAmount(score),
        };

        await sendAlert(this.formatPumpAlert(tokenData, score, reasons));

        if (score >= 75) {
          const tx = await this.jupiter.buy(mint, signal.amountSol!);
          if (tx) {
          await sendAlert(`✅ Pump.fun snipe!\n💰 ${signal.amountSol} SOL\n🔗 https://solscan.io/tx/${tx}`);
          storage.addTrade({ id: tx, time: Date.now(), action: 'BUY', mint, symbol: tokenData.symbol, amountSol: signal.amountSol!, price: 0, tx, source: 'SNIPE' });
        }
        }
      }
      return score;
    } catch { return 0; }
  }

  private async startBondingCurveMonitor() {
    const check = async () => {
      try {
        const res = await axios.get(`${PUMP_FUN_API}/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false`);
        const tokens: PumpToken[] = res.data || [];
        for (const token of tokens) {
          if (token.complete || this.processedMints.has(token.mint)) continue;
          const progress = this.estimateBondingCurveProgress(token);
          if (progress >= 70 && progress <= 95) {
            await this.evaluateToken(token.mint);
          }
        }
      } catch {}
      setTimeout(check, 20000);
    };
    check();
  }

  private async handleMigrationApproaching(mint: string, trade: PumpTrade) {
    await sendAlert([
      `🚀 <b>MIGRAÇÃO IMINENTE</b>`,
      `Mint: <code>${mint}</code>`,
      `MCap: ${trade.market_cap_sol?.toFixed(1)} SOL`,
    ].join('\n'));

    const tx = await this.jupiter.buy(mint, CONFIG.trading.maxBuySol * 0.5);
    if (tx) await sendAlert(`✅ Migration snipe: ${CONFIG.trading.maxBuySol * 0.5} SOL`);
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
        await this.evaluateToken(mint);
      }
    }
  }

  private async startPollingNewTokens() {
    const poll = async () => {
      try {
        const res = await axios.get(`${PUMP_FUN_API}/coins?offset=0&limit=20&sort=created_timestamp&order=DESC&includeNsfw=false`);
        const tokens: PumpToken[] = res.data || [];
        for (const token of tokens) {
          if (this.processedMints.has(token.mint)) continue;
          const ageMinutes = (Date.now() - token.created_timestamp) / 60000;
          if (ageMinutes <= this.filters.maxAgeMinutes) await this.evaluateToken(token.mint);
        }
      } catch {}
      setTimeout(poll, 10000);
    };
    poll();
  }

  private quickFilter(data: any): { passed: boolean; reason: string } {
    const combined = `${data.name || ''} ${data.symbol || ''} ${data.description || ''}`.toLowerCase();
    for (const kw of this.filters.excludedKeywords) {
      if (combined.includes(kw)) return { passed: false, reason: `Excluded: ${kw}` };
    }
    const creator = data.traderPublicKey || data.creator;
    if (creator && this.filters.blacklistedCreators.has(creator)) return { passed: false, reason: 'Blacklisted' };
    const creatorTokens = creator ? (this.creatorHistory.get(creator) || []) : [];
    if (creatorTokens.length > 5) storage.addToBlacklist(creator, `Serial deployer: ${creatorTokens.length} tokens`, 'auto');
      return { passed: false, reason: 'Serial deployer' };
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

  private async getTokenData(mint: string): Promise<PumpToken | null> {
    try { return (await axios.get(`${PUMP_FUN_API}/coins/${mint}`)).data; } catch { return null; }
  }

  private formatPumpAlert(token: PumpToken, score: number, reasons: string[]): string {
    const progress = this.estimateBondingCurveProgress(token);
    return [
      `🟣 <b>PUMP.FUN</b> | Score: ${score}`,
      `Token: <b>${token.symbol}</b> - ${token.name}`,
      `Mint: <code>${token.mint}</code>`,
      `💰 MCap: $${(token.usd_market_cap || 0).toFixed(0)} | 📈 BC: ${progress.toFixed(0)}%`,
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
    };
  }
}
