import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import next from 'next';
import { WebSocketServer } from 'ws';
import { registry } from './src/bot/registry';
import { storage } from './src/core/storage';
import { getConnection, getWallet } from './src/core/connection';
import { sendAlert } from './src/core/alerts';

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.DASHBOARD_PORT || '3000', 10);

async function main() {
  console.log('\n  🚀 Solana Memecoin Bot v2.0 (Next.js)\n  ════════════════════════════════════\n');

  // Validate connection
  const conn = getConnection();
  const w = getWallet();
  const balance = await conn.getBalance(w.publicKey);
  const balanceSol = balance / 1e9;
  console.log(`  🔑 Wallet:  ${w.publicKey.toBase58()}`);
  console.log(`  💰 Balance: ${balanceSol.toFixed(4)} SOL\n`);
  if (balanceSol < 0.01) console.log('  ⚠️  Low balance!\n');

  // Load persisted state
  const savedConfig = storage.loadConfig();
  if (savedConfig) console.log(`  💾 Config restored (saved: ${new Date(savedConfig.updatedAt).toLocaleString()})`);
  const stats = storage.getTradeStats();
  if (stats.total > 0) console.log(`  💾 History: ${stats.total} trades | WR: ${stats.winRate.toFixed(1)}% | PnL: ${stats.totalPnlSol.toFixed(2)} SOL`);

  // Next.js app
  const app = next({ dev });
  const handle = app.getRequestHandler();
  await app.prepare();

  // HTTP + WebSocket server
  const server = http.createServer((req, res) => {
    handle(req, res);
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    registry.addClient(ws);
  });

  // Performance polling
  setInterval(async () => {
    try {
      const bal = await conn.getBalance(w.publicKey);
      registry.updatePerformance(bal / 1e9);
    } catch {}
  }, 60000);

  server.listen(port, () => {
    console.log(`\n  ════════════════════════════════════`);
    console.log(`  ✅ Dashboard: http://localhost:${port}`);
    console.log(`  💾 Data: ./data/`);
    console.log(`  📱 Alerts → Telegram`);
    console.log(`  ℹ️  Modules are stopped — start them from the UI`);
    console.log(`  Press Ctrl+C to stop\n`);
  });

  await sendAlert([
    '🤖 <b>Bot v2.0 Started (Next.js)</b>', '',
    `💰 Balance: ${balanceSol.toFixed(4)} SOL`,
    `🌐 Dashboard: http://localhost:${port}`,
    '', 'ℹ️ Modules idle — start from dashboard',
  ].filter(Boolean).join('\n'));

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 ${signal} — stopping modules & saving state...`);
    registry.stopAll();
    await storage.flush();
    await sendAlert('🔴 Bot desligado (state saved)');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    console.error('❌ Uncaught:', err);
    registry.stopAll();
    await storage.flush();
    process.exit(1);
  });
}

main().catch(async (err) => {
  console.error('❌ Fatal:', err);
  await storage.flush();
  process.exit(1);
});
