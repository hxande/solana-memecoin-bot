import { Backtester } from '../modules/backtester';

async function runBacktest() {
  const bt = new Backtester();

  console.log('📊 Coletando dados históricos...');
  await bt.collectHistoricalData(30);

  const strategies = Backtester.getDefaultStrategies();
  for (const strategy of strategies) {
    await bt.runBacktest({
      startDate: Date.now() - 30 * 86400000,
      endDate: Date.now(),
      initialBalance: 10,
      maxPositionSize: 0.1,
      maxOpenPositions: 5,
      takeProfitPct: 100,
      stopLossPct: 50,
      strategy,
    });
  }
}

runBacktest().catch(console.error);
