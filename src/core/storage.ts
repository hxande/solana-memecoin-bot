import * as fs from 'fs';
import * as path from 'path';
import { WalletConfig, Position, TradeSignal, BundleState } from '../types';
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
    bundle: 'bundle.json',
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

  // BUNDLE
  loadBundle(): BundleState | null { return this.readFile<BundleState | null>(this.files.bundle, null); }
  saveBundle(state: BundleState | null): void { this.writeFile(this.files.bundle, state, 100); }

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
