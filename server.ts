import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import next from 'next';
import { WebSocketServer } from 'ws';
import { registry } from './src/bot/registry';
import { handleApi } from './src/api/handler';
import { storage } from './src/core/storage';
import { getConnection, getWallet } from './src/core/connection';
import { sendAlert } from './src/core/alerts';

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.DASHBOARD_PORT || '3000', 10);

async function main() {
  console.log('\n  Solana Memecoin Bot v2.0 (Next.js)\n  ====================================\n');

  const conn = getConnection();
  const w = getWallet();
  const balance = await conn.getBalance(w.publicKey);
  const balanceSol = balance / 1e9;
  console.log(`  Wallet:  ${w.publicKey.toBase58()}`);
  console.log(`  Balance: ${balanceSol.toFixed(4)} SOL\n`);

  registry.setCachedStatus(w.publicKey.toBase58(), balanceSol);

  const savedConfig = storage.loadConfig();
  if (savedConfig) console.log(`  Config restored (saved: ${new Date(savedConfig.updatedAt).toLocaleString()})`);
  const stats = storage.getTradeStats();
  if (stats.total > 0) console.log(`  History: ${stats.total} trades | WR: ${stats.winRate.toFixed(1)}% | PnL: ${stats.totalPnlSol.toFixed(2)} SOL`);

  const app = next({ dev });
  const handle = app.getRequestHandler();
  await app.prepare();

  // API routes handled directly by Node — Next.js only renders pages
  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }
    handle(req, res);
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => registry.addClient(ws));

  // Balance poll — only when modules are running
  setInterval(async () => {
    const anyRunning = Object.values(registry.getModuleStatuses()).some(Boolean);
    if (!anyRunning) return;
    try {
      const bal = await conn.getBalance(w.publicKey);
      const solBal = bal / 1e9;
      registry.setCachedStatus(w.publicKey.toBase58(), solBal);
      registry.updatePerformance(solBal);
    } catch {}
  }, 60000);

  server.listen(port, () => {
    console.log(`\n  Dashboard: http://localhost:${port}`);
    console.log(`  Modules are stopped — start them from the UI`);
    console.log(`  Press Ctrl+C to stop\n`);
  });

  await sendAlert([
    '<b>Bot v2.0 Started</b>', '',
    `Balance: ${balanceSol.toFixed(4)} SOL`,
    `Dashboard: http://localhost:${port}`,
    '', 'Modules idle — start from dashboard',
  ].filter(Boolean).join('\n'));

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} — stopping modules & saving state...`);
    registry.stopAll();
    await storage.flush();
    await sendAlert('Bot stopped (state saved)');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    console.error('Uncaught:', err);
    registry.stopAll();
    await storage.flush();
    process.exit(1);
  });
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  await storage.flush();
  process.exit(1);
});
