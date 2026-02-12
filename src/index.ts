import { SniperModule } from './modules/sniper';
import { WalletTracker } from './modules/walletTracker';
import { TokenMonitor } from './modules/tokenMonitor';
import { PositionManager } from './modules/positionManager';
import { PumpFunModule } from './modules/pumpfun';
import { SocialSentimentModule } from './modules/socialSentiment';
import { Backtester } from './modules/backtester';
import { DashboardServer } from './dashboard/server';
import { sendAlert } from './core/alerts';
import { connection, wallet } from './core/connection';

async function main() {
  console.log('\n  🚀 Solana Memecoin Bot v1.0\n  ════════════════════════════════════\n');

  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSol = balance / 1e9;
  console.log(`  🔑 Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`  💰 Balance: ${balanceSol.toFixed(4)} SOL\n`);

  if (balanceSol < 0.01) console.log('  ⚠️  Low balance!\n');

  const sniper = new SniperModule();
  const tracker = new WalletTracker();
  const monitor = new TokenMonitor();
  const positions = new PositionManager();
  const pumpfun = new PumpFunModule();
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
    '🤖 <b>Bot Iniciado!</b>', '',
    `💰 Balance: ${balanceSol.toFixed(4)} SOL`, '',
    '🎯 Sniper | 🟣 Pump.fun | 👀 Copy-Trade',
    '📊 Monitor | 📱 Social | 📈 Positions', '',
    `🌐 Dashboard: http://localhost:${process.env.DASHBOARD_PORT || 3000}`,
  ].join('\n'));

  setInterval(async () => {
    try {
      const bal = await connection.getBalance(wallet.publicKey);
      dashboard.updatePerformance(bal / 1e9);
    } catch {}
  }, 60000);

  console.log('\n  ════════════════════════════════════');
  console.log('  ✅ All modules running');
  console.log(`  🌐 Dashboard: http://localhost:${process.env.DASHBOARD_PORT || 3000}`);
  console.log('  📱 Alerts → Telegram');
  console.log('  Press Ctrl+C to stop\n');

  process.on('SIGINT', async () => {
    await sendAlert('🔴 Bot desligado');
    process.exit(0);
  });
  process.stdin.resume();
}

main().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
