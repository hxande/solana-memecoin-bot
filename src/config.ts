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
  },
};
