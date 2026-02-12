import { Telegraf } from 'telegraf';
import { CONFIG } from '../config';
import { TradeSignal, Position } from '../types';

const bot = new Telegraf(CONFIG.telegram.token);

export async function sendAlert(msg: string) {
  try {
    await bot.telegram.sendMessage(CONFIG.telegram.chatId, msg, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err: any) {
    console.error(`Telegram error: ${err.message}`);
  }
}

export function formatTradeAlert(signal: TradeSignal): string {
  const emoji = signal.action === 'BUY' ? '🟢' : '🔴';
  const src = { SNIPE: '🎯 Sniper', COPY: '👀 Copy', FILTER: '📊 Filter' };
  return [
    `${emoji} <b>${signal.action}</b> | ${src[signal.type]}`,
    `Token: <code>${signal.mint}</code>`,
    `Motivo: ${signal.reason}`,
    `Confiança: ${signal.confidence}%`,
    signal.amountSol ? `Valor: ${signal.amountSol} SOL` : '',
    `<a href="https://birdeye.so/token/${signal.mint}?chain=solana">Birdeye</a> | <a href="https://solscan.io/token/${signal.mint}">Solscan</a>`,
  ].filter(Boolean).join('\n');
}

export function formatPositionUpdate(pos: Position, currentPrice: number): string {
  const pnl = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const emoji = pnl >= 0 ? '📈' : '📉';
  return [
    `${emoji} <b>${pos.symbol}</b>`,
    `Entry: $${pos.entryPrice.toFixed(8)}`,
    `Current: $${currentPrice.toFixed(8)}`,
    `PnL: <b>${pnl.toFixed(1)}%</b>`,
  ].join('\n');
}
