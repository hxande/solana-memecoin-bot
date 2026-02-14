import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  rpc: process.env.SOLANA_RPC_URL!,
  ws: process.env.SOLANA_WS_URL!,
  privateKey: process.env.PRIVATE_KEY!,
  heliusKey: process.env.HELIUS_API_KEY!,
  birdeyeKey: process.env.BIRDEYE_API_KEY!,
  jupiterApi: process.env.JUPITER_API || 'https://quote-api.jup.ag/v6',
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN!,
    chatId: process.env.TELEGRAM_CHAT_ID!,
  },
  trading: {
    maxBuySol: parseFloat(process.env.MAX_BUY_SOL || '0.1'),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '500'),
    profitTarget: parseFloat(process.env.AUTO_SELL_PROFIT_PCT || '100'),
    stopLoss: parseFloat(process.env.STOP_LOSS_PCT || '50'),
    priorityFee: parseFloat(process.env.GAS_PRIORITY_FEE || '0.005'),
    maxPositions: parseInt(process.env.MAX_POSITIONS || '5'),
    trailingStopPct: parseFloat(process.env.TRAILING_STOP_PCT || '30'),
    trailingActivationPct: parseFloat(process.env.TRAILING_ACTIVATION_PCT || '30'),
    maxHoldTimeMinutes: parseInt(process.env.MAX_HOLD_TIME_MINUTES || '30'),
    sniperMinScore: parseInt(process.env.SNIPER_MIN_SCORE || '70'),
    pumpfunMinScore: parseInt(process.env.PUMPFUN_MIN_SCORE || '65'),
  },
};
