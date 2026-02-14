import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
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

  canOpenPosition(): boolean {
    return this.positions.size < CONFIG.trading.maxPositions;
  }

  getOpenPositionCount(): number {
    return this.positions.size;
  }

  async startMonitoring() {
    console.log('📊 Position Manager started');
    const monitor = async () => {
      for (const [mint, pos] of this.positions) {
        try {
          const currentPrice = await this.jupiter.getPrice(mint);
          if (currentPrice === 0) continue;
          pos.currentPrice = currentPrice;

          // Track highest price for trailing stop
          if (!pos.highestPrice || currentPrice > pos.highestPrice) {
            pos.highestPrice = currentPrice;
          }

          const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
          const fromPeakPct = pos.highestPrice > 0
            ? ((pos.highestPrice - currentPrice) / pos.highestPrice) * 100
            : 0;

          // Take profit
          if (pnlPct >= CONFIG.trading.profitTarget) {
            await sendAlert(`🎯 <b>TAKE PROFIT</b>\n${formatPositionUpdate(pos, currentPrice)}`);
            await this.closePosition(mint, currentPrice, `TP +${pnlPct.toFixed(1)}%`);
            continue;
          }

          // Trailing stop: if profit was > activation threshold and price dropped from peak
          if (pnlPct > CONFIG.trading.trailingActivationPct && fromPeakPct >= CONFIG.trading.trailingStopPct) {
            await sendAlert(`📉 <b>TRAILING STOP</b>\n${formatPositionUpdate(pos, currentPrice)}\nPeak drop: ${fromPeakPct.toFixed(1)}%`);
            await this.closePosition(mint, currentPrice, `Trailing SL (peak -${fromPeakPct.toFixed(1)}%, PnL +${pnlPct.toFixed(1)}%)`);
            continue;
          }

          // Hard stop loss
          if (pnlPct <= -CONFIG.trading.stopLoss) {
            await sendAlert(`🛑 <b>STOP LOSS</b>\n${formatPositionUpdate(pos, currentPrice)}`);
            await this.closePosition(mint, currentPrice, `SL ${pnlPct.toFixed(1)}%`);
            continue;
          }

          // Time-based exit: if held > maxHoldTimeMinutes and PnL < 10%
          const holdMinutes = (Date.now() - pos.entryTime) / 60000;
          if (holdMinutes > CONFIG.trading.maxHoldTimeMinutes && pnlPct < 10) {
            await sendAlert(`⏰ <b>TIME EXIT</b>\n${formatPositionUpdate(pos, currentPrice)}\nHeld: ${holdMinutes.toFixed(0)}min`);
            await this.closePosition(mint, currentPrice, `Time exit (${holdMinutes.toFixed(0)}min, PnL ${pnlPct.toFixed(1)}%)`);
            continue;
          }
        } catch (err: any) {
          console.error(`📊 Position check error (${mint.slice(0, 8)}...): ${err.message}`);
        }
      }
      // Persist updated prices
      storage.savePositions(Array.from(this.positions.values()));
      setTimeout(monitor, 5000);
    };
    monitor();
  }

  private async closePosition(mint: string, exitPrice: number, reason: string) {
    const pos = this.positions.get(mint);
    if (!pos) return;
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const pnlSol = pos.amount * (pnlPct / 100);

    // Execute actual sell transaction
    let txHash: string | null = null;
    try {
      const mintPubkey = new PublicKey(mint);
      const ata = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey);
      const accountInfo = await connection.getTokenAccountBalance(ata);
      const rawAmount = accountInfo.value.amount;

      if (BigInt(rawAmount) > 0n) {
        console.log(`📤 Selling ${pos.symbol}: ${rawAmount} raw tokens...`);
        txHash = await this.jupiter.sell(mint, BigInt(rawAmount));
        if (txHash) {
          console.log(`📤 SELL TX: https://solscan.io/tx/${txHash}`);
        } else {
          console.error(`📤 Sell failed for ${pos.symbol} — recording exit anyway`);
        }
      } else {
        console.log(`📤 ${pos.symbol}: zero balance in ATA, recording exit`);
      }
    } catch (err: any) {
      console.error(`📤 Sell execution error (${pos.symbol}): ${err.message}`);
    }

    storage.addTrade({
      id: txHash || `sell_${mint}_${Date.now()}`, time: Date.now(), action: 'SELL',
      mint, symbol: pos.symbol, amountSol: pos.amount, price: exitPrice,
      tx: txHash, source: pos.source, pnlPct, pnlSol,
    });

    this.positions.delete(mint);
    storage.removePosition(mint);
    console.log(`📤 Closed: ${pos.symbol} | ${reason} | PnL: ${pnlPct.toFixed(1)}%${txHash ? ` | TX: ${txHash}` : ''}`);
  }

  getPositions(): Position[] { return Array.from(this.positions.values()); }
}
