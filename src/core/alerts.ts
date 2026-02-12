import { Telegraf } from 'telegraf';
import { CONFIG } from '../config';
import { TradeSignal, Position } from '../types';

let bot: Telegraf | null = null;

// Only init Telegram if token is configured
if (CONFIG.telegram.token && !CONFIG.telegram.token.includes('your_')) {
  try {
    bot = new Telegraf(CONFIG.telegram.token);
  } catch (err: any) {
    console.error(`⚠️  Telegram init failed: ${err.message}`);
  }
} else {
  console.log('⚠️  Telegram not configured — alerts will only show in console/dashboard');
}

export async function sendAlert(msg: string) {
  // Always log to console (strip HTML tags for readability)
  const clean = msg.replace(/<[^>]*>/g, '');
  console.log(`📢 ${clean.split('\n')[0]}`);

  if (!bot || !CONFIG.telegram.chatId || CONFIG.telegram.chatId.includes('your_')) return;

  try {
    await bot.telegram.sendMessage(CONFIG.telegram.chatId, msg, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err: any) {
    // Don't crash on Telegram errors, just log
    console.error(`⚠️  Telegram send failed: ${err.message}`);
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
