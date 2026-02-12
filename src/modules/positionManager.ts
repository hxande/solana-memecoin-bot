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
