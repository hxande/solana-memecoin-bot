import { SniperModule } from './modules/sniper';
import { WalletTracker } from './modules/walletTracker';
import { TokenMonitor } from './modules/tokenMonitor';
import { PositionManager } from './modules/positionManager';
import { PumpFunModule } from './modules/pumpfun';
import { SocialSentimentModule } from './modules/socialSentiment';
import { Backtester } from './modules/backtester';
import { DashboardServer } from './dashboard/server';
import { sendAlert } from './core/alerts';
import { storage } from './core/storage';
import { connection, wallet } from './core/connection';

async function main() {
  console.log('\n  🚀 Solana Memecoin Bot v1.1\n  ════════════════════════════════════\n');

  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSol = balance / 1e9;
  console.log(`  🔑 Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`  💰 Balance: ${balanceSol.toFixed(4)} SOL\n`);
  if (balanceSol < 0.01) console.log('  ⚠️  Low balance!\n');

  // Load persisted state
  console.log('  💾 Loading persisted state...');
  const savedConfig = storage.loadConfig();
  if (savedConfig) console.log(`  💾 Config restored (saved: ${new Date(savedConfig.updatedAt).toLocaleString()})`);

  const stats = storage.getTradeStats();
  if (stats.total > 0) console.log(`  💾 History: ${stats.total} trades | WR: ${stats.winRate.toFixed(1)}% | PnL: ${stats.totalPnlSol.toFixed(2)} SOL`);

  const storageStats = storage.getStorageStats();
  for (const [key, info] of Object.entries(storageStats)) {
    if (info.exists) console.log(`  💾 ${key}: ${info.sizeKB}KB${info.entries !== undefined ? ` (${info.entries})` : ''}`);
  }
  console.log('');

  // Init modules — PositionManager first so it can be shared
  const positions = new PositionManager();
  const sniper = new SniperModule(positions);
  const tracker = new WalletTracker();
  const monitor = new TokenMonitor();
  const pumpfun = new PumpFunModule(positions);
  const social = new SocialSentimentModule();
  const backtester = new Backtester();

  const dashboard = new DashboardServer(parseInt(process.env.DASHBOARD_PORT || '3000'));
  dashboard.setModules({ sniper, tracker, monitor, positions, pumpfun, social, backtester });

  console.log('  🚀 Starting modules...\n');

  try {
    await dashboard.start();
    await Promise.all([
      sniper.start().then(() => { console.log('  ✅ Sniper'); dashboard.addAlert('snipe', 'Sniper active'); }),
      tracker.start().then(() => { console.log('  ✅ Wallet Tracker'); dashboard.addAlert('copy', 'Tracker active'); }),
      monitor.start().then(() => { console.log('  ✅ Token Monitor'); dashboard.addAlert('filter', 'Monitor active'); }),
      positions.startMonitoring().then(() => { console.log('  ✅ Position Manager'); }),
      pumpfun.start().then(() => { console.log('  ✅ Pump.fun'); dashboard.addAlert('pumpfun', 'Pump.fun active'); }),
      social.start().then(() => { console.log('  ✅ Social Sentiment'); dashboard.addAlert('social', 'Social active'); }),
    ]);
    backtester.loadHistoricalData();
  } catch (err: any) { console.error(`❌ Error: ${err.message}`); }

  await sendAlert([
    '🤖 <b>Bot Iniciado! (v1.1 + persistence)</b>', '',
    `💰 Balance: ${balanceSol.toFixed(4)} SOL`,
    stats.total > 0 ? `📊 History: ${stats.total} trades | WR: ${stats.winRate.toFixed(1)}%` : '',
    '', '🎯 Sniper | 🟣 Pump.fun | 👀 Copy-Trade',
    '📊 Monitor | 📱 Social | 📈 Positions', '',
    `🌐 Dashboard: http://localhost:${process.env.DASHBOARD_PORT || 3000}`,
  ].filter(Boolean).join('\n'));

  setInterval(async () => {
    try { const bal = await connection.getBalance(wallet.publicKey); dashboard.updatePerformance(bal / 1e9); } catch {}
  }, 60000);

  console.log('\n  ════════════════════════════════════');
  console.log('  ✅ All modules running (with persistence)');
  console.log(`  🌐 Dashboard: http://localhost:${process.env.DASHBOARD_PORT || 3000}`);
  console.log('  💾 Data: ./data/');
  console.log('  📱 Alerts → Telegram');
  console.log('  Press Ctrl+C to stop\n');

  const shutdown = async (signal: string) => {
    console.log(`\n🛑 ${signal} — saving state...`);
    await storage.flush();
    await sendAlert('🔴 Bot desligado (state saved)');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    console.error('❌ Uncaught:', err);
    await storage.flush();
    process.exit(1);
  });
  process.stdin.resume();
}

main().catch(async (err) => { console.error('❌ Fatal:', err); await storage.flush(); process.exit(1); });
