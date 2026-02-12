import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../config';

interface HistoricalToken {
  mint: string; symbol: string; name: string; launchDate: number;
  launchPriceUSD: number; peakPriceUSD: number; peakTime: number;
  currentPriceUSD: number; athMultiple: number; liquidityAtLaunch: number;
  holdersAtLaunch: number; topHolderPctAtLaunch: number;
  mintRenounced: boolean; lpBurned: boolean; wasRug: boolean;
  migrated: boolean; volumeFirst1h: number; volumeFirst24h: number;
  source: string;
}

interface BacktestStrategy {
  name: string;
  filters: { minLiquidity: number; maxTopHolderPct: number; requireMintRenounced: boolean; requireLpBurned: boolean; minHolders: number; maxAgeMinutes: number; minScore: number; };
  entryRules: Array<{ type: string; params: Record<string, number> }>;
  exitRules: Array<{ type: string; params: Record<string, number> }>;
}

interface SimulatedTrade {
  mint: string; symbol: string; entryPrice: number; exitPrice: number;
  entryTime: number; exitTime: number; amountSol: number;
  pnlSol: number; pnlPct: number; exitReason: string; score: number; holdTimeMs: number;
}

interface BacktestResult {
  strategyName: string; totalTrades: number; winningTrades: number;
  losingTrades: number; winRate: number; totalPnlSol: number;
  totalPnlPct: number; avgPnlPct: number; maxDrawdownPct: number;
  sharpeRatio: number; profitFactor: number; avgHoldTime: string;
  rugsPrevented: number; trades: SimulatedTrade[];
  equityCurve: Array<{ time: number; balance: number }>;
}

export class Backtester {
  private historicalData: HistoricalToken[] = [];
  private dataDir = path.join(process.cwd(), 'data', 'backtest');

  constructor() {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  }

  async collectHistoricalData(days: number = 30): Promise<number> {
    console.log(`📊 Coletando dados (${days} dias)...`);
    const tokens: HistoricalToken[] = [];
    const startTime = Date.now() - days * 86400000;

    try {
      for (let offset = 0; offset < 500; offset += 50) {
        const res = await axios.get(
          `https://public-api.birdeye.so/defi/tokenlist?sort_by=created_at&sort_type=desc&offset=${offset}&limit=50`,
          { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } }
        );
        const list = res.data.data?.tokens || [];
        if (list.length === 0) break;

        for (const t of list) {
          if (t.created_at && t.created_at * 1000 < startTime) continue;
          tokens.push({
            mint: t.address, symbol: t.symbol || 'UNKNOWN', name: t.name || '',
            launchDate: (t.created_at || 0) * 1000, launchPriceUSD: t.price || 0,
            peakPriceUSD: 0, peakTime: 0, currentPriceUSD: t.price || 0, athMultiple: 0,
            liquidityAtLaunch: t.liquidity || 0, holdersAtLaunch: t.holder || 0,
            topHolderPctAtLaunch: 0, mintRenounced: false, lpBurned: false,
            wasRug: t.price === 0 || (t.liquidity || 0) < 50,
            migrated: true, volumeFirst1h: t.v1h || 0, volumeFirst24h: t.v24h || 0, source: 'birdeye',
          });
        }
        await new Promise(r => setTimeout(r, 500));
        console.log(`  ${tokens.length} tokens...`);
      }
    } catch (e: any) { console.error(`Coleta erro: ${e.message}`); }

    this.historicalData = tokens;
    const file = path.join(this.dataDir, `historical_${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(tokens, null, 2));
    console.log(`✅ ${tokens.length} tokens salvos em ${file}`);
    return tokens.length;
  }

  async runBacktest(config: {
    startDate: number; endDate: number; initialBalance: number;
    maxPositionSize: number; maxOpenPositions: number;
    takeProfitPct: number; stopLossPct: number; strategy: BacktestStrategy;
  }): Promise<BacktestResult> {
    console.log(`\n🔬 Backtest: "${config.strategy.name}"`);

    const tokensInPeriod = this.historicalData.filter(
      t => t.launchDate >= config.startDate && t.launchDate <= config.endDate
    );

    let balance = config.initialBalance;
    const trades: SimulatedTrade[] = [];
    const equityCurve = [{ time: config.startDate, balance }];
    let maxBalance = balance, maxDrawdown = 0, rugsPrevented = 0;

    for (const token of tokensInPeriod) {
      // Filtros
      if (token.liquidityAtLaunch < config.strategy.filters.minLiquidity) {
        if (token.wasRug) rugsPrevented++;
        continue;
      }
      if (token.topHolderPctAtLaunch > config.strategy.filters.maxTopHolderPct && token.topHolderPctAtLaunch > 0) continue;

      // Entry check
      let score = 50;
      if (token.volumeFirst1h > 10000) score += 10;
      if (token.holdersAtLaunch > 50) score += 10;
      if (!token.wasRug) score += 15;
      if (score < 60) continue;

      const posSize = Math.min(config.maxPositionSize, balance * 0.1);
      if (posSize < 0.01 || balance < posSize) continue;

      // Simular trade
      const entry = token.launchPriceUSD;
      if (entry <= 0) continue;

      let exitPrice = entry, exitReason = 'time_exit';
      const peak = token.athMultiple || 1;
      const tpMult = 1 + config.takeProfitPct / 100;
      const slMult = 1 - config.stopLossPct / 100;

      if (peak >= tpMult) { exitPrice = entry * tpMult; exitReason = `TP ${config.takeProfitPct}%`; }
      else if (token.wasRug || token.currentPriceUSD < entry * slMult) { exitPrice = entry * slMult; exitReason = `SL ${config.stopLossPct}%`; }
      else { exitPrice = token.currentPriceUSD; }

      const pnlPct = ((exitPrice - entry) / entry) * 100;
      const pnlSol = posSize * (pnlPct / 100);

      trades.push({
        mint: token.mint, symbol: token.symbol, entryPrice: entry, exitPrice,
        entryTime: token.launchDate, exitTime: token.launchDate + 3600000,
        amountSol: posSize, pnlSol, pnlPct, exitReason, score,
        holdTimeMs: 3600000,
      });

      balance += pnlSol;
      equityCurve.push({ time: token.launchDate, balance });
      maxBalance = Math.max(maxBalance, balance);
      maxDrawdown = Math.max(maxDrawdown, ((maxBalance - balance) / maxBalance) * 100);
    }

    const wins = trades.filter(t => t.pnlPct > 0);
    const losses = trades.filter(t => t.pnlPct <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnlSol, 0);
    const avgPnl = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0;
    const grossProfit = wins.reduce((s, t) => s + t.pnlSol, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));

    const returns = trades.map(t => t.pnlPct);
    const avgR = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const stdDev = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgR, 2), 0) / (returns.length || 1));

    const result: BacktestResult = {
      strategyName: config.strategy.name,
      totalTrades: trades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnlSol: totalPnl,
      totalPnlPct: ((balance - config.initialBalance) / config.initialBalance) * 100,
      avgPnlPct: avgPnl,
      maxDrawdownPct: maxDrawdown,
      sharpeRatio: stdDev > 0 ? avgR / stdDev : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      avgHoldTime: '1h',
      rugsPrevented,
      trades,
      equityCurve,
    };

    this.printReport(result);
    return result;
  }

  private printReport(r: BacktestResult) {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`📊 ${r.strategyName}`);
    console.log(`${'═'.repeat(50)}`);
    console.log(`PnL: ${r.totalPnlSol >= 0 ? '+' : ''}${r.totalPnlSol.toFixed(2)} SOL (${r.totalPnlPct.toFixed(1)}%)`);
    console.log(`Win Rate: ${r.winRate.toFixed(1)}% | Trades: ${r.totalTrades}`);
    console.log(`Profit Factor: ${r.profitFactor.toFixed(2)} | Sharpe: ${r.sharpeRatio.toFixed(2)}`);
    console.log(`Max Drawdown: ${r.maxDrawdownPct.toFixed(1)}% | Rugs Prevented: ${r.rugsPrevented}`);
    console.log(`${'═'.repeat(50)}`);
  }

  static getDefaultStrategies(): BacktestStrategy[] {
    return [
      {
        name: 'Conservative',
        filters: { minLiquidity: 5000, maxTopHolderPct: 15, requireMintRenounced: true, requireLpBurned: true, minHolders: 50, maxAgeMinutes: 60, minScore: 70 },
        entryRules: [{ type: 'score_threshold', params: { min: 70 } }],
        exitRules: [{ type: 'take_profit', params: { pct: 50 } }, { type: 'stop_loss', params: { pct: 25 } }],
      },
      {
        name: 'Aggressive',
        filters: { minLiquidity: 1000, maxTopHolderPct: 30, requireMintRenounced: false, requireLpBurned: false, minHolders: 10, maxAgeMinutes: 15, minScore: 50 },
        entryRules: [{ type: 'score_threshold', params: { min: 50 } }],
        exitRules: [{ type: 'take_profit', params: { pct: 200 } }, { type: 'stop_loss', params: { pct: 50 } }],
      },
    ];
  }

  exportResults(result: BacktestResult, filename?: string): string {
    const file = path.join(this.dataDir, filename || `bt_${result.strategyName}_${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(`💾 Saved: ${file}`);
    return file;
  }

  loadHistoricalData(filePath?: string): number {
    const file = filePath || this.getLatestDataFile();
    if (!file || !fs.existsSync(file)) return 0;
    this.historicalData = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log(`📂 Loaded ${this.historicalData.length} tokens`);
    return this.historicalData.length;
  }

  private getLatestDataFile(): string | null {
    if (!fs.existsSync(this.dataDir)) return null;
    const files = fs.readdirSync(this.dataDir).filter(f => f.startsWith('historical_')).sort().reverse();
    return files.length > 0 ? path.join(this.dataDir, files[0]) : null;
  }
}
