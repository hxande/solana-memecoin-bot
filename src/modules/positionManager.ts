import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { sendAlert, formatPositionUpdate } from '../core/alerts';
import { CONFIG } from '../config';
import { Position } from '../types';

export class PositionManager {
  private jupiter: JupiterSwap;
  private positions: Map<string, Position> = new Map();

  constructor() {
    this.jupiter = new JupiterSwap(connection, wallet);
  }

  addPosition(pos: Position) {
    this.positions.set(pos.mint, pos);
    console.log(`📌 Position added: ${pos.symbol} @ $${pos.entryPrice}`);
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
            console.log(`🎯 Take profit: ${pos.symbol} +${pnlPct.toFixed(1)}%`);
            await sendAlert(`🎯 <b>TAKE PROFIT</b>\n${formatPositionUpdate(pos, currentPrice)}`);
          }
          if (pnlPct <= -CONFIG.trading.stopLoss) {
            console.log(`🛑 Stop loss: ${pos.symbol} ${pnlPct.toFixed(1)}%`);
            await sendAlert(`🛑 <b>STOP LOSS</b>\n${formatPositionUpdate(pos, currentPrice)}`);
          }
        } catch {}
      }
      setTimeout(monitor, 10000);
    };
    monitor();
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }
}
