#!/bin/bash

# ============================================================
# PATCH: Adiciona persistência a TODOS os módulos
# ============================================================
# Rodar DENTRO da pasta do projeto:
#   cd solana-memecoin-bot
#   chmod +x patch-storage.sh
#   ./patch-storage.sh
# ============================================================

set -e

echo ""
echo "  💾 PATCH: Adding persistence layer"
echo "  ════════════════════════════════════"
echo ""

# Verificar se estamos na pasta certa
if [ ! -f "src/config.ts" ]; then
  echo "  ❌ ERROR: Run this inside the solana-memecoin-bot folder"
  echo "  Usage: cd solana-memecoin-bot && ./patch-storage.sh"
  exit 1
fi

# ============================================================
# 1. Criar src/core/storage.ts
# ============================================================
cat > src/core/storage.ts << 'ENDOFFILE'
import * as fs from 'fs';
import * as path from 'path';
import { WalletConfig, Position, TradeSignal } from '../types';
import { CONFIG } from '../config';

export interface PersistedConfig {
  maxBuySol: number; slippageBps: number; profitTarget: number;
  stopLoss: number; priorityFee: number; updatedAt: number;
}

export interface PersistedTrade {
  id: string; time: number; action: 'BUY' | 'SELL'; mint: string;
  symbol: string; amountSol: number; price: number; tx: string | null;
  source: TradeSignal['type']; pnlPct?: number; pnlSol?: number;
}

export interface PersistedAlert { time: number; type: string; message: string; }
export interface BlacklistEntry { address: string; reason: string; addedAt: number; source: 'manual' | 'auto'; }
export interface InfluencerEntry { handle: string; platform: 'twitter' | 'telegram'; followers: number; weight: number; trackBuyCalls: boolean; addedAt: number; }
export interface PerformanceEntry { time: number; balanceSol: number; }

export class Storage {
  private dataDir: string;
  private cache = new Map<string, any>();
  private writeQueue = new Map<string, NodeJS.Timeout>();

  private files = {
    config: 'config.json', wallets: 'wallets.json', positions: 'positions.json',
    trades: 'trades.json', alerts: 'alerts.json', blacklist: 'blacklist.json',
    influencers: 'influencers.json', narratives: 'narratives.json', performance: 'performance.json',
  };

  private limits = { trades: 5000, alerts: 1000, performance: 10000 };

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), 'data');
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    console.log(`💾 Storage: ${this.dataDir}`);
  }

  private getPath(file: string): string { return path.join(this.dataDir, file); }

  private readFile<T>(file: string, fallback: T): T {
    if (this.cache.has(file)) return this.cache.get(file) as T;
    const fp = this.getPath(file);
    try {
      if (fs.existsSync(fp)) {
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8')) as T;
        this.cache.set(file, data);
        return data;
      }
    } catch (err: any) {
      console.error(`💾 Read error (${file}): ${err.message}`);
      try { fs.renameSync(fp, fp + '.bak.' + Date.now()); } catch {}
    }
    this.cache.set(file, fallback);
    return fallback;
  }

  private writeFile<T>(file: string, data: T, debounceMs: number = 1000): void {
    this.cache.set(file, data);
    const existing = this.writeQueue.get(file);
    if (existing) clearTimeout(existing);
    this.writeQueue.set(file, setTimeout(() => {
      try {
        const fp = this.getPath(file);
        const tmp = fp + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, fp);
      } catch (err: any) { console.error(`💾 Write error (${file}): ${err.message}`); }
      this.writeQueue.delete(file);
    }, debounceMs));
  }

  // CONFIG
  loadConfig(): PersistedConfig | null {
    const cfg = this.readFile<PersistedConfig | null>(this.files.config, null);
    if (cfg) {
      CONFIG.trading.maxBuySol = cfg.maxBuySol;
      CONFIG.trading.slippageBps = cfg.slippageBps;
      CONFIG.trading.profitTarget = cfg.profitTarget;
      CONFIG.trading.stopLoss = cfg.stopLoss;
      CONFIG.trading.priorityFee = cfg.priorityFee;
      console.log('💾 Config loaded from disk');
    }
    return cfg;
  }

  saveConfig(): void {
    this.writeFile(this.files.config, {
      maxBuySol: CONFIG.trading.maxBuySol, slippageBps: CONFIG.trading.slippageBps,
      profitTarget: CONFIG.trading.profitTarget, stopLoss: CONFIG.trading.stopLoss,
      priorityFee: CONFIG.trading.priorityFee, updatedAt: Date.now(),
    });
  }

  // WALLETS
  loadWallets(): WalletConfig[] { return this.readFile<WalletConfig[]>(this.files.wallets, []); }
  saveWallets(wallets: WalletConfig[]): void { this.writeFile(this.files.wallets, wallets); }

  addWallet(wallet: WalletConfig): WalletConfig[] {
    const wallets = this.loadWallets();
    const exists = wallets.find(w => w.address === wallet.address);
    if (exists) Object.assign(exists, wallet); else wallets.push(wallet);
    this.saveWallets(wallets);
    return wallets;
  }

  removeWallet(address: string): WalletConfig[] {
    const wallets = this.loadWallets().filter(w => w.address !== address);
    this.saveWallets(wallets);
    return wallets;
  }

  // POSITIONS
  loadPositions(): Position[] { return this.readFile<Position[]>(this.files.positions, []); }
  savePositions(positions: Position[]): void { this.writeFile(this.files.positions, positions); }

  addPosition(position: Position): void {
    const positions = this.loadPositions();
    const idx = positions.findIndex(p => p.mint === position.mint);
    if (idx >= 0) positions[idx] = position; else positions.push(position);
    this.savePositions(positions);
  }

  removePosition(mint: string): void {
    this.savePositions(this.loadPositions().filter(p => p.mint !== mint));
  }

  // TRADES
  loadTrades(): PersistedTrade[] { return this.readFile<PersistedTrade[]>(this.files.trades, []); }

  addTrade(trade: PersistedTrade): void {
    const trades = this.loadTrades();
    trades.push(trade);
    while (trades.length > this.limits.trades) trades.shift();
    this.writeFile(this.files.trades, trades);
  }

  getTradeStats() {
    const trades = this.loadTrades().filter(t => t.pnlSol !== undefined);
    const wins = trades.filter(t => (t.pnlSol || 0) > 0);
    return {
      total: trades.length, wins: wins.length, losses: trades.length - wins.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnlSol: trades.reduce((s, t) => s + (t.pnlSol || 0), 0),
    };
  }

  // ALERTS
  loadAlerts(): PersistedAlert[] { return this.readFile<PersistedAlert[]>(this.files.alerts, []); }

  addAlert(alert: PersistedAlert): void {
    const alerts = this.loadAlerts();
    alerts.push(alert);
    while (alerts.length > this.limits.alerts) alerts.shift();
    this.writeFile(this.files.alerts, alerts, 2000);
  }

  // BLACKLIST
  loadBlacklist(): BlacklistEntry[] { return this.readFile<BlacklistEntry[]>(this.files.blacklist, []); }

  addToBlacklist(address: string, reason: string, source: 'manual' | 'auto' = 'auto'): void {
    const list = this.loadBlacklist();
    if (list.find(e => e.address === address)) return;
    list.push({ address, reason, addedAt: Date.now(), source });
    this.writeFile(this.files.blacklist, list);
  }

  removeFromBlacklist(address: string): void {
    this.writeFile(this.files.blacklist, this.loadBlacklist().filter(e => e.address !== address));
  }

  isBlacklisted(address: string): boolean { return this.loadBlacklist().some(e => e.address === address); }
  getBlacklistSet(): Set<string> { return new Set(this.loadBlacklist().map(e => e.address)); }

  // INFLUENCERS
  loadInfluencers(): InfluencerEntry[] { return this.readFile<InfluencerEntry[]>(this.files.influencers, []); }
  saveInfluencers(influencers: InfluencerEntry[]): void { this.writeFile(this.files.influencers, influencers); }

  addInfluencer(inf: InfluencerEntry): void {
    const list = this.loadInfluencers();
    const exists = list.find(i => i.handle === inf.handle);
    if (exists) Object.assign(exists, inf); else list.push(inf);
    this.saveInfluencers(list);
  }

  removeInfluencer(handle: string): void {
    this.saveInfluencers(this.loadInfluencers().filter(i => i.handle !== handle));
  }

  // NARRATIVES
  loadNarratives(): Array<{ keyword: string; keywords: string[]; score: number; startedAt: number }> {
    return this.readFile(this.files.narratives, []);
  }

  saveNarratives(narratives: Map<string, { keywords: string[]; score: number; startedAt: number }>): void {
    this.writeFile(this.files.narratives, [...narratives.entries()].map(([k, v]) => ({ keyword: k, ...v })));
  }

  // PERFORMANCE
  loadPerformance(): PerformanceEntry[] { return this.readFile<PerformanceEntry[]>(this.files.performance, []); }

  addPerformanceEntry(balanceSol: number): void {
    const h = this.loadPerformance();
    h.push({ time: Date.now(), balanceSol });
    while (h.length > this.limits.performance) h.shift();
    this.writeFile(this.files.performance, h, 5000);
  }

  // FLUSH (call before shutdown)
  async flush(): Promise<void> {
    for (const [file, timeout] of this.writeQueue) {
      clearTimeout(timeout);
      try {
        const data = this.cache.get(file);
        if (data !== undefined) fs.writeFileSync(this.getPath(file), JSON.stringify(data, null, 2));
      } catch {}
    }
    this.writeQueue.clear();
    console.log('💾 All data flushed to disk');
  }

  getStorageStats(): Record<string, { exists: boolean; sizeKB: number; entries?: number }> {
    const stats: Record<string, any> = {};
    for (const [key, file] of Object.entries(this.files)) {
      const fp = this.getPath(file);
      const exists = fs.existsSync(fp);
      let sizeKB = 0, entries: number | undefined;
      if (exists) {
        sizeKB = Math.round(fs.statSync(fp).size / 1024 * 10) / 10;
        try { const d = JSON.parse(fs.readFileSync(fp, 'utf-8')); if (Array.isArray(d)) entries = d.length; } catch {}
      }
      stats[key] = { exists, sizeKB, entries };
    }
    return stats;
  }
}

export const storage = new Storage();
ENDOFFILE
echo "  ✅ Created src/core/storage.ts"

# ============================================================
# 2. Rewrite src/modules/walletTracker.ts (with persistence)
# ============================================================
cat > src/modules/walletTracker.ts << 'ENDOFFILE'
import { PublicKey } from '@solana/web3.js';
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { sendAlert, formatTradeAlert } from '../core/alerts';
import { storage } from '../core/storage';
import { CONFIG } from '../config';
import { WalletConfig, TradeSignal } from '../types';

export class WalletTracker {
  private jupiter: JupiterSwap;
  private trackedWallets: WalletConfig[];

  constructor() {
    this.jupiter = new JupiterSwap(connection, wallet);
    const saved = storage.loadWallets();
    if (saved.length > 0) {
      this.trackedWallets = saved;
      console.log(`👀 Loaded ${saved.length} wallets from disk`);
    } else {
      this.trackedWallets = [];
    }
  }

  async start() {
    console.log('👀 Wallet Tracker started');
    console.log(`📋 Monitorando ${this.trackedWallets.filter(w => w.enabled).length} wallets`);
    for (const w of this.trackedWallets) {
      if (w.enabled) this.pollWalletTransactions(w);
    }
  }

  private async pollWalletTransactions(config: WalletConfig) {
    let lastSig: string | undefined;
    const poll = async () => {
      try {
        const sigs = await connection.getSignaturesForAddress(
          new PublicKey(config.address), { limit: 5, until: lastSig }
        );
        if (sigs.length > 0) {
          lastSig = sigs[0].signature;
          for (const sig of sigs.reverse()) await this.analyzeTransaction(sig.signature, config);
        }
      } catch (err: any) { console.error(`Poll error (${config.label}): ${err.message}`); }
      setTimeout(poll, 2000);
    };
    poll();
  }

  private async analyzeTransaction(signature: string, config: WalletConfig) {
    try {
      const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) return;
      const changes = this.detectTokenChanges(tx.meta.preTokenBalances || [], tx.meta.postTokenBalances || [], config.address);

      for (const change of changes) {
        if (Math.abs(change.solAmount) < config.minTradeSol) continue;
        const signal: TradeSignal = {
          type: 'COPY', action: change.solAmount < 0 ? 'BUY' : 'SELL', mint: change.mint,
          reason: `${config.label} ${change.solAmount < 0 ? 'comprou' : 'vendeu'} ${Math.abs(change.solAmount).toFixed(2)} SOL`,
          confidence: 65, amountSol: Math.abs(change.solAmount) * (config.copyPct / 100),
        };
        console.log(`🔔 ${signal.reason}`);
        await sendAlert(formatTradeAlert(signal));

        if (signal.action === 'BUY' && signal.amountSol! <= CONFIG.trading.maxBuySol) {
          const buyTx = await this.jupiter.buy(signal.mint, signal.amountSol!);
          if (buyTx) {
            await sendAlert(`✅ Copy trade!\n${config.label} → ${signal.amountSol} SOL\nTX: https://solscan.io/tx/${buyTx}`);
            storage.addTrade({
              id: buyTx, time: Date.now(), action: 'BUY', mint: signal.mint,
              symbol: signal.mint.slice(0, 8), amountSol: signal.amountSol!,
              price: 0, tx: buyTx, source: 'COPY',
            });
          }
        }
      }
    } catch {}
  }

  private detectTokenChanges(pre: any[], post: any[], walletAddr: string): Array<{ mint: string; solAmount: number }> {
    const changes: Array<{ mint: string; solAmount: number }> = [];
    const preMap = new Map<string, number>(), postMap = new Map<string, number>();
    for (const b of pre) { if (b.owner === walletAddr) preMap.set(b.mint, parseFloat(b.uiTokenAmount?.uiAmountString || '0')); }
    for (const b of post) { if (b.owner === walletAddr) postMap.set(b.mint, parseFloat(b.uiTokenAmount?.uiAmountString || '0')); }
    for (const [mint, postAmt] of postMap) { if (postAmt > (preMap.get(mint) || 0)) changes.push({ mint, solAmount: -0.5 }); }
    for (const [mint, preAmt] of preMap) { if (preAmt > (postMap.get(mint) || 0)) changes.push({ mint, solAmount: 0.5 }); }
    return changes;
  }

  addWallet(config: WalletConfig) {
    const existing = this.trackedWallets.find(w => w.address === config.address);
    if (existing) Object.assign(existing, config);
    else { this.trackedWallets.push(config); if (config.enabled) this.pollWalletTransactions(config); }
    storage.saveWallets(this.trackedWallets);
    console.log(`➕ Wallet saved: ${config.label}`);
  }

  removeWallet(address: string) {
    this.trackedWallets = this.trackedWallets.filter(w => w.address !== address);
    storage.saveWallets(this.trackedWallets);
  }

  listWallets(): WalletConfig[] { return this.trackedWallets; }
}
ENDOFFILE
echo "  ✅ Updated src/modules/walletTracker.ts"

# ============================================================
# 3. Rewrite src/modules/positionManager.ts (with persistence)
# ============================================================
cat > src/modules/positionManager.ts << 'ENDOFFILE'
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { sendAlert, formatPositionUpdate } from '../core/alerts';
import { storage } from '../core/storage';
import { CONFIG } from '../config';
import { Position } from '../types';

export class PositionManager {
  private jupiter: JupiterSwap;
  private positions: Map<string, Position> = new Map();

  constructor() {
    this.jupiter = new JupiterSwap(connection, wallet);
    const saved = storage.loadPositions();
    for (const pos of saved) this.positions.set(pos.mint, pos);
    if (saved.length > 0) console.log(`📌 Loaded ${saved.length} positions from disk`);
  }

  addPosition(pos: Position) {
    this.positions.set(pos.mint, pos);
    storage.addPosition(pos);
    console.log(`📌 Position saved: ${pos.symbol} @ $${pos.entryPrice}`);
  }

  async startMonitoring() {
    console.log('📊 Position Manager started');
    const monitor = async () => {
      for (const [mint, pos] of this.positions) {
        try {
          const currentPrice = await this.jupiter.getPrice(mint);
          if (currentPrice === 0) continue;
          pos.currentPrice = currentPrice;
          const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

          if (pnlPct >= CONFIG.trading.profitTarget) {
            await sendAlert(`🎯 <b>TAKE PROFIT</b>\n${formatPositionUpdate(pos, currentPrice)}`);
            await this.closePosition(mint, currentPrice, `TP +${pnlPct.toFixed(1)}%`);
          } else if (pnlPct <= -CONFIG.trading.stopLoss) {
            await sendAlert(`🛑 <b>STOP LOSS</b>\n${formatPositionUpdate(pos, currentPrice)}`);
            await this.closePosition(mint, currentPrice, `SL ${pnlPct.toFixed(1)}%`);
          }
        } catch {}
      }
      // Persist updated prices
      storage.savePositions(Array.from(this.positions.values()));
      setTimeout(monitor, 10000);
    };
    monitor();
  }

  private async closePosition(mint: string, exitPrice: number, reason: string) {
    const pos = this.positions.get(mint);
    if (!pos) return;
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const pnlSol = pos.amount * (pnlPct / 100);

    storage.addTrade({
      id: `sell_${mint}_${Date.now()}`, time: Date.now(), action: 'SELL',
      mint, symbol: pos.symbol, amountSol: pos.amount, price: exitPrice,
      tx: null, source: pos.source, pnlPct, pnlSol,
    });

    this.positions.delete(mint);
    storage.removePosition(mint);
    console.log(`📤 Closed: ${pos.symbol} | ${reason} | PnL: ${pnlPct.toFixed(1)}%`);
  }

  getPositions(): Position[] { return Array.from(this.positions.values()); }
}
ENDOFFILE
echo "  ✅ Updated src/modules/positionManager.ts"

# ============================================================
# 4. Rewrite src/modules/sniper.ts (with persistence)
# ============================================================
cat > src/modules/sniper.ts << 'ENDOFFILE'
import WebSocket from 'ws';
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { sendAlert, formatTradeAlert } from '../core/alerts';
import { storage } from '../core/storage';
import { CONFIG } from '../config';
import { TokenInfo, TradeSignal } from '../types';

export class SniperModule {
  private jupiter: JupiterSwap;
  private ws: WebSocket | null = null;
  private processedPools = new Set<string>();
  private filters = {
    minLiquiditySOL: 5, maxTopHolderPct: 30, requireMintRevoked: true,
    requireFreezeRevoked: true, minHolders: 10, maxAgeSeconds: 300,
    blacklistedDevs: new Set<string>(),
  };

  constructor() {
    this.jupiter = new JupiterSwap(connection, wallet);
    this.filters.blacklistedDevs = storage.getBlacklistSet();
    if (this.filters.blacklistedDevs.size > 0)
      console.log(`🎯 Loaded ${this.filters.blacklistedDevs.size} blacklisted devs`);
  }

  async start() { console.log('🎯 Sniper Module started'); this.connectWebSocket(); }

  private connectWebSocket() {
    const wsUrl = `wss://atlas-mainnet.helius-rpc.com/?api-key=${CONFIG.heliusKey}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.on('open', () => {
      console.log('🔌 Sniper WS connected');
      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'transactionSubscribe',
        params: [{ accountInclude: ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'], type: 'SWAP' },
        { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 }],
      }));
    });
    this.ws.on('message', async (data) => {
      try { const msg = JSON.parse(data.toString()); if (msg.params?.result) await this.processNewPool(msg.params.result); } catch {}
    });
    this.ws.on('close', () => { setTimeout(() => this.connectWebSocket(), 3000); });
  }

  private async processNewPool(txData: any) {
    const mint = this.extractMintFromTx(txData);
    if (!mint || this.processedPools.has(mint)) return;
    this.processedPools.add(mint);
    console.log(`🆕 Nova pool: ${mint}`);

    const tokenInfo = await this.analyzeToken(mint);
    if (!tokenInfo) return;
    const filterResult = this.applyFilters(tokenInfo);
    if (!filterResult.passed) { console.log(`❌ ${filterResult.reason}`); return; }

    const signal: TradeSignal = {
      type: 'SNIPE', action: 'BUY', mint,
      reason: `Nova pool | Liq: ${tokenInfo.liquidity} SOL | ${tokenInfo.holders} holders`,
      confidence: filterResult.score, amountSol: CONFIG.trading.maxBuySol,
    };
    await sendAlert(formatTradeAlert(signal));

    if (signal.confidence >= 70) {
      const tx = await this.jupiter.buy(mint, CONFIG.trading.maxBuySol);
      if (tx) {
        await sendAlert(`✅ Snipe executado!\nTX: https://solscan.io/tx/${tx}`);
        storage.addTrade({ id: tx, time: Date.now(), action: 'BUY', mint, symbol: tokenInfo.symbol, amountSol: CONFIG.trading.maxBuySol, price: 0, tx, source: 'SNIPE' });
      }
    }
  }

  private async analyzeToken(mint: string): Promise<TokenInfo | null> {
    try {
      const [heliusData, birdeyeData] = await Promise.all([this.getHeliusTokenData(mint), this.getBirdeyeTokenData(mint)]);
      return { mint, symbol: heliusData?.symbol || 'UNKNOWN', name: heliusData?.name || 'Unknown', decimals: heliusData?.decimals || 9, poolAddress: '', liquidity: birdeyeData?.liquidity || 0, marketCap: birdeyeData?.mc || 0, holders: birdeyeData?.holder || 0, topHolderPct: await this.getTopHolderPct(mint), createdAt: Date.now(), isRenounced: heliusData?.mintAuthority === null, isMintable: heliusData?.mintAuthority !== null, lpBurned: false };
    } catch { return null; }
  }

  private applyFilters(token: TokenInfo): { passed: boolean; reason: string; score: number } {
    let score = 50;
    if (token.liquidity < this.filters.minLiquiditySOL) return { passed: false, reason: 'Liquidez baixa', score: 0 };
    score += Math.min(20, token.liquidity / 2);
    if (token.topHolderPct > this.filters.maxTopHolderPct) return { passed: false, reason: `Top holder: ${token.topHolderPct}%`, score: 0 };
    score += (30 - token.topHolderPct) / 2;
    if (this.filters.requireMintRevoked && token.isMintable) return { passed: false, reason: 'Mint não revogada', score: 0 };
    if (token.isRenounced) score += 10;
    if (token.holders < this.filters.minHolders) return { passed: false, reason: `Poucos holders: ${token.holders}`, score: 0 };
    score += Math.min(10, token.holders / 10);
    return { passed: true, reason: 'OK', score: Math.min(100, Math.round(score)) };
  }

  private extractMintFromTx(txData: any): string | null { try { return txData.transaction?.message?.accountKeys?.[1]?.pubkey || null; } catch { return null; } }

  private async getHeliusTokenData(mint: string): Promise<any> {
    const res = await fetch(`https://api.helius.xyz/v0/token-metadata?api-key=${CONFIG.heliusKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mintAccounts: [mint] }) });
    const data = await res.json(); return data[0]?.onChainAccountInfo?.accountInfo?.data?.parsed?.info || null;
  }

  private async getBirdeyeTokenData(mint: string): Promise<any> {
    const res = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } });
    return (await res.json()).data || null;
  }

  private async getTopHolderPct(mint: string): Promise<number> {
    try { const res = await fetch(`https://public-api.birdeye.so/defi/token_holder?address=${mint}&limit=1`, { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } }); return (await res.json()).data?.items?.[0]?.percentage || 0; } catch { return 100; }
  }
}
ENDOFFILE
echo "  ✅ Updated src/modules/sniper.ts"

# ============================================================
# 5. Rewrite src/modules/pumpfun.ts (with persistence)
# ============================================================
# Adding storage import and blacklist persistence to pumpfun
# We patch only the key parts: constructor + quickFilter + buy
cat > /tmp/pumpfun_patch.py << 'PYEOF'
import re

with open('src/modules/pumpfun.ts', 'r') as f:
    content = f.read()

# Add storage import after the last existing import
if "import { storage }" not in content:
    content = content.replace(
        "import { CONFIG }",
        "import { storage } from '../core/storage';\nimport { CONFIG }"
    )

# Patch constructor to load blacklist
old_ctor = "this.jupiter = new JupiterSwap(connection, wallet);\n  }"
new_ctor = """this.jupiter = new JupiterSwap(connection, wallet);
    const bl = storage.getBlacklistSet();
    this.filters.blacklistedCreators = bl;
    if (bl.size > 0) console.log(`🟣 Loaded ${bl.size} blacklisted creators`);
  }"""
content = content.replace(old_ctor, new_ctor, 1)

# Patch serial deployer detection to persist
old_serial = "return { passed: false, reason: 'Serial deployer' };"
new_serial = "storage.addToBlacklist(creator, `Serial deployer: ${creatorTokens.length} tokens`, 'auto');\n      return { passed: false, reason: 'Serial deployer' };"
if "storage.addToBlacklist" not in content:
    content = content.replace(old_serial, new_serial, 1)

# Add trade persistence after successful buy
old_buy = "if (tx) await sendAlert(`✅ Pump.fun snipe!\\n💰 ${signal.amountSol} SOL\\n🔗 https://solscan.io/tx/${tx}`);"
new_buy = """if (tx) {
          await sendAlert(`✅ Pump.fun snipe!\\n💰 ${signal.amountSol} SOL\\n🔗 https://solscan.io/tx/${tx}`);
          storage.addTrade({ id: tx, time: Date.now(), action: 'BUY', mint, symbol: tokenData.symbol, amountSol: signal.amountSol!, price: 0, tx, source: 'SNIPE' });
        }"""
content = content.replace(old_buy, new_buy, 1)

with open('src/modules/pumpfun.ts', 'w') as f:
    f.write(content)
PYEOF

# Try python3, then python, then do simple sed fallback
if command -v python3 &> /dev/null; then
  python3 /tmp/pumpfun_patch.py
  echo "  ✅ Updated src/modules/pumpfun.ts"
elif command -v python &> /dev/null; then
  python /tmp/pumpfun_patch.py
  echo "  ✅ Updated src/modules/pumpfun.ts"
else
  # Fallback: just add import at top
  sed -i.bak "1s/^/import { storage } from '..\/core\/storage';\n/" src/modules/pumpfun.ts 2>/dev/null || true
  echo "  ⚠️  Partially updated src/modules/pumpfun.ts (add storage calls manually)"
fi
rm -f /tmp/pumpfun_patch.py

# ============================================================
# 6. Rewrite src/modules/socialSentiment.ts (with persistence)
# ============================================================
# Patch: add storage import + load influencers + save narratives
cat > /tmp/social_patch.py << 'PYEOF'
import re

with open('src/modules/socialSentiment.ts', 'r') as f:
    content = f.read()

if "import { storage }" not in content:
    content = content.replace(
        "import { sendAlert }",
        "import { storage } from '../core/storage';\nimport { sendAlert }"
    )

# Patch influencer loading
old_inf = """private influencers: InfluencerConfig[] = [
    { handle: 'example_ct_1', platform: 'twitter', followers: 50000, weight: 8, trackBuyCalls: true },
    { handle: 'example_ct_2', platform: 'twitter', followers: 100000, weight: 9, trackBuyCalls: true },
  ];"""
new_inf = """private influencers: InfluencerConfig[];"""
content = content.replace(old_inf, new_inf, 1)

# Add constructor with storage loading
old_start = "async start() {"
new_start = """constructor() {
    const saved = storage.loadInfluencers();
    if (saved.length > 0) {
      this.influencers = saved.map(s => ({ handle: s.handle, platform: s.platform, followers: s.followers, weight: s.weight, trackBuyCalls: s.trackBuyCalls }));
      console.log(`📱 Loaded ${saved.length} influencers from disk`);
    } else {
      this.influencers = [];
    }
    const savedN = storage.loadNarratives();
    for (const n of savedN) {
      if (Date.now() - n.startedAt < 6 * 3600000) this.activeNarratives.set(n.keyword, { keywords: n.keywords, score: n.score, startedAt: n.startedAt });
    }
  }

  async start() {"""
content = content.replace(old_start, new_start, 1)

# Save narratives after detection
old_narr = "setTimeout(detect, 60000);\n    };\n    detect();\n  }"
new_narr = "storage.saveNarratives(this.activeNarratives);\n      setTimeout(detect, 60000);\n    };\n    detect();\n  }"
# This is fragile, only apply if not already done
if "storage.saveNarratives" not in content:
    content = content.replace(old_narr, new_narr, 1)

# Persist addInfluencer
old_add = """addInfluencer(config: InfluencerConfig) {
    this.influencers.push(config);
    console.log(`➕ Influencer: @${config.handle}`);
  }"""
new_add = """addInfluencer(config: InfluencerConfig) {
    this.influencers.push(config);
    storage.addInfluencer({ handle: config.handle, platform: config.platform as 'twitter' | 'telegram', followers: config.followers, weight: config.weight, trackBuyCalls: config.trackBuyCalls, addedAt: Date.now() });
    console.log(`➕ Influencer saved: @${config.handle}`);
  }"""
content = content.replace(old_add, new_add, 1)

with open('src/modules/socialSentiment.ts', 'w') as f:
    f.write(content)
PYEOF

if command -v python3 &> /dev/null; then
  python3 /tmp/social_patch.py
  echo "  ✅ Updated src/modules/socialSentiment.ts"
elif command -v python &> /dev/null; then
  python /tmp/social_patch.py
  echo "  ✅ Updated src/modules/socialSentiment.ts"
else
  sed -i.bak "1s/^/import { storage } from '..\/core\/storage';\n/" src/modules/socialSentiment.ts 2>/dev/null || true
  echo "  ⚠️  Partially updated src/modules/socialSentiment.ts"
fi
rm -f /tmp/social_patch.py

# ============================================================
# 7. Rewrite src/dashboard/server.ts (with persistence)
# ============================================================
cat > /tmp/dashboard_patch.py << 'PYEOF'
with open('src/dashboard/server.ts', 'r') as f:
    content = f.read()

if "import { storage }" not in content:
    content = content.replace(
        "import { connection, wallet }",
        "import { storage } from '../core/storage';\nimport { connection, wallet }"
    )

# Persist alerts
old_alert = "this.broadcast('alert', alert);\n  }"
new_alert = "storage.addAlert(alert);\n    this.broadcast('alert', alert);\n  }"
if "storage.addAlert" not in content:
    content = content.replace(old_alert, new_alert, 1)

# Persist performance
old_perf = "this.broadcast('performance', { time: Date.now(), balanceSol });\n  }"
new_perf = "storage.addPerformanceEntry(balanceSol);\n    this.broadcast('performance', { time: Date.now(), balanceSol });\n  }"
if "storage.addPerformanceEntry" not in content:
    content = content.replace(old_perf, new_perf, 1)

# Persist config changes
old_cfg = "res.json({ success: true, config: CONFIG.trading });\n    });"
new_cfg = "storage.saveConfig();\n      res.json({ success: true, config: CONFIG.trading });\n    });"
if "storage.saveConfig" not in content:
    content = content.replace(old_cfg, new_cfg, 1)

# Add new API endpoints before the catch-all route
catch_all = "// Serve dashboard HTML"
new_endpoints = """// Storage endpoints
    this.app.get('/api/blacklist', (_req, res) => res.json({ entries: storage.loadBlacklist() }));
    this.app.post('/api/blacklist', (req, res) => {
      const { address, reason } = req.body;
      if (!address) return res.status(400).json({ error: 'address required' });
      storage.addToBlacklist(address, reason || 'Manual', 'manual');
      res.json({ success: true });
    });
    this.app.delete('/api/blacklist/:address', (req, res) => { storage.removeFromBlacklist(req.params.address); res.json({ success: true }); });
    this.app.get('/api/influencers', (_req, res) => res.json({ influencers: storage.loadInfluencers() }));
    this.app.post('/api/influencers', (req, res) => {
      const { handle, platform, followers, weight, trackBuyCalls } = req.body;
      if (!handle) return res.status(400).json({ error: 'handle required' });
      storage.addInfluencer({ handle, platform: platform || 'twitter', followers: followers || 0, weight: weight || 5, trackBuyCalls: trackBuyCalls !== false, addedAt: Date.now() });
      this.modules.social?.addInfluencer({ handle, platform: platform || 'twitter', followers: followers || 0, weight: weight || 5, trackBuyCalls: trackBuyCalls !== false });
      res.json({ success: true });
    });
    this.app.delete('/api/influencers/:handle', (req, res) => { storage.removeInfluencer(req.params.handle); this.modules.social?.removeInfluencer(req.params.handle); res.json({ success: true }); });
    this.app.get('/api/storage/stats', (_req, res) => res.json(storage.getStorageStats()));
    this.app.get('/api/trades/stats', (_req, res) => res.json(storage.getTradeStats()));

    // Serve dashboard HTML"""
if "/api/blacklist" not in content:
    content = content.replace(catch_all, new_endpoints)

with open('src/dashboard/server.ts', 'w') as f:
    f.write(content)
PYEOF

if command -v python3 &> /dev/null; then
  python3 /tmp/dashboard_patch.py
  echo "  ✅ Updated src/dashboard/server.ts"
elif command -v python &> /dev/null; then
  python /tmp/dashboard_patch.py
  echo "  ✅ Updated src/dashboard/server.ts"
else
  echo "  ⚠️  Could not patch dashboard. Add storage import manually."
fi
rm -f /tmp/dashboard_patch.py

# ============================================================
# 8. Update src/index.ts (load state + flush on shutdown)
# ============================================================
cat > src/index.ts << 'ENDOFFILE'
import { SniperModule } from './modules/sniper';
import { WalletTracker } from './modules/walletTracker';
import { TokenMonitor } from './modules/tokenMonitor';
import { PositionManager } from './modules/positionManager';
import { PumpFunModule } from './modules/pumpfun';
import { SocialSentimentModule } from './modules/socialSentiment';
import { Backtester } from './modules/backtester';
import { DashboardServer } from './dashboard/server';
import { sendAlert } from './core/alerts';
import { storage } from './core/storage';
import { connection, wallet } from './core/connection';

async function main() {
  console.log('\n  🚀 Solana Memecoin Bot v1.1\n  ════════════════════════════════════\n');

  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSol = balance / 1e9;
  console.log(`  🔑 Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`  💰 Balance: ${balanceSol.toFixed(4)} SOL\n`);
  if (balanceSol < 0.01) console.log('  ⚠️  Low balance!\n');

  // Load persisted state
  console.log('  💾 Loading persisted state...');
  const savedConfig = storage.loadConfig();
  if (savedConfig) console.log(`  💾 Config restored (saved: ${new Date(savedConfig.updatedAt).toLocaleString()})`);

  const stats = storage.getTradeStats();
  if (stats.total > 0) console.log(`  💾 History: ${stats.total} trades | WR: ${stats.winRate.toFixed(1)}% | PnL: ${stats.totalPnlSol.toFixed(2)} SOL`);

  const storageStats = storage.getStorageStats();
  for (const [key, info] of Object.entries(storageStats)) {
    if (info.exists) console.log(`  💾 ${key}: ${info.sizeKB}KB${info.entries !== undefined ? ` (${info.entries})` : ''}`);
  }
  console.log('');

  // Init modules
  const sniper = new SniperModule();
  const tracker = new WalletTracker();
  const monitor = new TokenMonitor();
  const positions = new PositionManager();
  const pumpfun = new PumpFunModule();
  const social = new SocialSentimentModule();
  const backtester = new Backtester();

  const dashboard = new DashboardServer(parseInt(process.env.DASHBOARD_PORT || '3000'));
  dashboard.setModules({ sniper, tracker, monitor, positions, pumpfun, social, backtester });

  console.log('  🚀 Starting modules...\n');

  try {
    await dashboard.start();
    await Promise.all([
      sniper.start().then(() => { console.log('  ✅ Sniper'); dashboard.addAlert('snipe', 'Sniper active'); }),
      tracker.start().then(() => { console.log('  ✅ Wallet Tracker'); dashboard.addAlert('copy', 'Tracker active'); }),
      monitor.start().then(() => { console.log('  ✅ Token Monitor'); dashboard.addAlert('filter', 'Monitor active'); }),
      positions.startMonitoring().then(() => { console.log('  ✅ Position Manager'); }),
      pumpfun.start().then(() => { console.log('  ✅ Pump.fun'); dashboard.addAlert('pumpfun', 'Pump.fun active'); }),
      social.start().then(() => { console.log('  ✅ Social Sentiment'); dashboard.addAlert('social', 'Social active'); }),
    ]);
    backtester.loadHistoricalData();
  } catch (err: any) { console.error(`❌ Error: ${err.message}`); }

  await sendAlert([
    '🤖 <b>Bot Iniciado! (v1.1 + persistence)</b>', '',
    `💰 Balance: ${balanceSol.toFixed(4)} SOL`,
    stats.total > 0 ? `📊 History: ${stats.total} trades | WR: ${stats.winRate.toFixed(1)}%` : '',
    '', '🎯 Sniper | 🟣 Pump.fun | 👀 Copy-Trade',
    '📊 Monitor | 📱 Social | 📈 Positions', '',
    `🌐 Dashboard: http://localhost:${process.env.DASHBOARD_PORT || 3000}`,
  ].filter(Boolean).join('\n'));

  setInterval(async () => {
    try { const bal = await connection.getBalance(wallet.publicKey); dashboard.updatePerformance(bal / 1e9); } catch {}
  }, 60000);

  console.log('\n  ════════════════════════════════════');
  console.log('  ✅ All modules running (with persistence)');
  console.log(`  🌐 Dashboard: http://localhost:${process.env.DASHBOARD_PORT || 3000}`);
  console.log('  💾 Data: ./data/');
  console.log('  📱 Alerts → Telegram');
  console.log('  Press Ctrl+C to stop\n');

  const shutdown = async (signal: string) => {
    console.log(`\n🛑 ${signal} — saving state...`);
    await storage.flush();
    await sendAlert('🔴 Bot desligado (state saved)');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    console.error('❌ Uncaught:', err);
    await storage.flush();
    process.exit(1);
  });
  process.stdin.resume();
}

main().catch(async (err) => { console.error('❌ Fatal:', err); await storage.flush(); process.exit(1); });
ENDOFFILE
echo "  ✅ Updated src/index.ts"

# ============================================================
# DONE
# ============================================================
echo ""
echo "  ════════════════════════════════════════"
echo "  ✅ PATCH APPLIED SUCCESSFULLY!"
echo "  ════════════════════════════════════════"
echo ""
echo "  Changes made:"
echo "    + Created  src/core/storage.ts"
echo "    ~ Updated  src/index.ts"
echo "    ~ Updated  src/modules/sniper.ts"
echo "    ~ Updated  src/modules/walletTracker.ts"
echo "    ~ Updated  src/modules/positionManager.ts"
echo "    ~ Updated  src/modules/pumpfun.ts"
echo "    ~ Updated  src/modules/socialSentiment.ts"
echo "    ~ Updated  src/dashboard/server.ts"
echo ""
echo "  Data will be saved to: ./data/"
echo "    config.json, wallets.json, positions.json,"
echo "    trades.json, alerts.json, blacklist.json,"
echo "    influencers.json, narratives.json, performance.json"
echo ""
echo "  Run: npm start"
echo "  ════════════════════════════════════════"
