import { WebSocket } from 'ws';
import { SniperModule } from '../modules/sniper';
import { WalletTracker } from '../modules/walletTracker';
import { TokenMonitor } from '../modules/tokenMonitor';
import { PositionManager } from '../modules/positionManager';
import { PumpFunModule } from '../modules/pumpfun';
import { SocialSentimentModule } from '../modules/socialSentiment';
import { Backtester } from '../modules/backtester';
import { BundleManager } from '../modules/bundleManager';
import { storage } from '../core/storage';

export type ModuleName = 'sniper' | 'pumpfun' | 'walletTracker' | 'tokenMonitor' | 'socialSentiment' | 'positionManager';

export class ModuleRegistry {
  readonly positionManager: PositionManager;
  readonly sniper: SniperModule;
  readonly pumpfun: PumpFunModule;
  readonly walletTracker: WalletTracker;
  readonly tokenMonitor: TokenMonitor;
  readonly socialSentiment: SocialSentimentModule;
  readonly backtester: Backtester;
  readonly bundleManager: BundleManager;

  private wsClients = new Set<WebSocket>();
  private startedAt = Date.now();

  constructor() {
    this.positionManager = new PositionManager();
    this.sniper = new SniperModule(this.positionManager);
    this.pumpfun = new PumpFunModule(this.positionManager);
    this.walletTracker = new WalletTracker();
    this.tokenMonitor = new TokenMonitor();
    this.socialSentiment = new SocialSentimentModule();
    this.backtester = new Backtester();
    this.bundleManager = new BundleManager();
    this.bundleManager.setBroadcast((type, data) => this.broadcast(type, data));

    this.positionManager.setOnPositionUpdate((positions) => {
      this.broadcast('position_update', positions);
    });
  }

  getUptime() { return Date.now() - this.startedAt; }

  // ── Module control ──

  private getModule(name: ModuleName) {
    const map: Record<ModuleName, any> = {
      sniper: this.sniper,
      pumpfun: this.pumpfun,
      walletTracker: this.walletTracker,
      tokenMonitor: this.tokenMonitor,
      socialSentiment: this.socialSentiment,
      positionManager: this.positionManager,
    };
    return map[name];
  }

  async startModule(name: ModuleName) {
    const mod = this.getModule(name);
    if (!mod) throw new Error(`Unknown module: ${name}`);
    if (mod.isRunning?.()) return;
    if (name === 'positionManager') {
      await mod.startMonitoring();
    } else {
      await mod.start();
    }
    this.broadcast('module_status', this.getModuleStatuses());
  }

  stopModule(name: ModuleName) {
    const mod = this.getModule(name);
    if (!mod) throw new Error(`Unknown module: ${name}`);
    if (!mod.isRunning?.()) return;
    mod.stop();
    this.broadcast('module_status', this.getModuleStatuses());
  }

  async startAll() {
    const names: ModuleName[] = ['positionManager', 'sniper', 'pumpfun', 'walletTracker', 'tokenMonitor', 'socialSentiment'];
    await Promise.all(names.map(n => this.startModule(n)));
    this.backtester.loadHistoricalData();
  }

  stopAll() {
    const names: ModuleName[] = ['sniper', 'pumpfun', 'walletTracker', 'tokenMonitor', 'socialSentiment', 'positionManager'];
    for (const n of names) this.stopModule(n);
  }

  getModuleStatuses(): Record<ModuleName, boolean> {
    return {
      sniper: this.sniper.isRunning(),
      pumpfun: this.pumpfun.isRunning(),
      walletTracker: this.walletTracker.isRunning(),
      tokenMonitor: this.tokenMonitor.isRunning(),
      socialSentiment: this.socialSentiment.isRunning(),
      positionManager: this.positionManager.isRunning(),
    };
  }

  // ── WebSocket ──

  addClient(ws: WebSocket) {
    this.wsClients.add(ws);
    ws.on('close', () => this.wsClients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
  }

  broadcast(type: string, data: any) {
    const msg = JSON.stringify({ type, data, timestamp: Date.now() });
    for (const c of this.wsClients) {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    }
  }

  // ── Alerts + Performance ──

  private _alerts: Array<{ time: number; type: string; message: string }> = [];
  private _performanceHistory: Array<{ time: number; balanceSol: number }> = [];

  addAlert(type: string, message: string) {
    const alert = { time: Date.now(), type, message };
    this._alerts.push(alert);
    if (this._alerts.length > 200) this._alerts.shift();
    storage.addAlert(alert);
    this.broadcast('alert', alert);
  }

  getAlerts() { return this._alerts; }

  updatePerformance(balanceSol: number) {
    this._performanceHistory.push({ time: Date.now(), balanceSol });
    storage.addPerformanceEntry(balanceSol);
    this.broadcast('performance', { time: Date.now(), balanceSol });
  }

  getPerformanceHistory() { return this._performanceHistory; }
}

// Singleton: survives Next.js HMR
const g = globalThis as any;
if (!g.__registry) g.__registry = new ModuleRegistry();
export const registry: ModuleRegistry = g.__registry;
