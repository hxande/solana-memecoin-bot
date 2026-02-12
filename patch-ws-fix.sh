#!/bin/bash

# ============================================================
# PATCH: Fix WebSocket crash on 403/invalid API key
# ============================================================
# Run inside the project: ./patch-ws-fix.sh
# ============================================================

set -e
echo "  🔧 Patching WebSocket error handling..."

# ============================================================
# 1. Fix src/modules/sniper.ts
# ============================================================
cat > src/modules/sniper.ts << 'ENDOFFILE'
import WebSocket from 'ws';
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { sendAlert, formatTradeAlert } from '../core/alerts';
import { storage } from '../core/storage';
import { CONFIG } from '../config';
import { TokenInfo, TradeSignal } from '../types';

export class SniperModule {
  private jupiter: JupiterSwap;
  private ws: WebSocket | null = null;
  private processedPools = new Set<string>();
  private filters = {
    minLiquiditySOL: 5, maxTopHolderPct: 30, requireMintRevoked: true,
    requireFreezeRevoked: true, minHolders: 10, maxAgeSeconds: 300,
    blacklistedDevs: new Set<string>(),
  };

  constructor() {
    this.jupiter = new JupiterSwap(connection, wallet);
    this.filters.blacklistedDevs = storage.getBlacklistSet();
    if (this.filters.blacklistedDevs.size > 0)
      console.log(`🎯 Loaded ${this.filters.blacklistedDevs.size} blacklisted devs`);
  }

  async start() {
    console.log('🎯 Sniper Module started');
    this.connectWebSocket();
  }

  private connectWebSocket() {
    // Skip if no valid API key
    if (!CONFIG.heliusKey || CONFIG.heliusKey.includes('YOUR_') || CONFIG.heliusKey === 'your_helius_api_key') {
      console.log('⚠️  Sniper WS: No valid HELIUS_API_KEY — skipping WebSocket (Sniper will not detect new pools)');
      return;
    }

    const wsUrl = `wss://atlas-mainnet.helius-rpc.com/?api-key=${CONFIG.heliusKey}`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err: any) {
      console.error(`🔌 Sniper WS create error: ${err.message}`);
      setTimeout(() => this.connectWebSocket(), 10000);
      return;
    }

    this.ws.on('open', () => {
      console.log('🔌 Sniper WS connected');
      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'transactionSubscribe',
        params: [{
          accountInclude: ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'],
          type: 'SWAP',
        }, {
          commitment: 'confirmed', encoding: 'jsonParsed',
          transactionDetails: 'full', maxSupportedTransactionVersion: 0,
        }],
      }));
    });

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.params?.result) await this.processNewPool(msg.params.result);
      } catch {}
    });

    this.ws.on('error', (err) => {
      console.error(`🔌 Sniper WS error: ${err.message}`);
      // Don't crash — the 'close' event will handle reconnection
    });

    this.ws.on('close', (code) => {
      console.log(`🔌 Sniper WS closed (code: ${code}), reconnecting in 10s...`);
      this.ws = null;
      setTimeout(() => this.connectWebSocket(), 10000);
    });
  }

  private async processNewPool(txData: any) {
    const mint = this.extractMintFromTx(txData);
    if (!mint || this.processedPools.has(mint)) return;
    this.processedPools.add(mint);
    console.log(`🆕 Nova pool: ${mint}`);

    const tokenInfo = await this.analyzeToken(mint);
    if (!tokenInfo) return;
    const filterResult = this.applyFilters(tokenInfo);
    if (!filterResult.passed) { console.log(`❌ ${filterResult.reason}`); return; }

    const signal: TradeSignal = {
      type: 'SNIPE', action: 'BUY', mint,
      reason: `Nova pool | Liq: ${tokenInfo.liquidity} SOL | ${tokenInfo.holders} holders`,
      confidence: filterResult.score, amountSol: CONFIG.trading.maxBuySol,
    };
    await sendAlert(formatTradeAlert(signal));

    if (signal.confidence >= 70) {
      const tx = await this.jupiter.buy(mint, CONFIG.trading.maxBuySol);
      if (tx) {
        await sendAlert(`✅ Snipe executado!\nTX: https://solscan.io/tx/${tx}`);
        storage.addTrade({ id: tx, time: Date.now(), action: 'BUY', mint, symbol: tokenInfo.symbol, amountSol: CONFIG.trading.maxBuySol, price: 0, tx, source: 'SNIPE' });
      }
    }
  }

  private async analyzeToken(mint: string): Promise<TokenInfo | null> {
    try {
      const [heliusData, birdeyeData] = await Promise.all([this.getHeliusTokenData(mint), this.getBirdeyeTokenData(mint)]);
      return { mint, symbol: heliusData?.symbol || 'UNKNOWN', name: heliusData?.name || 'Unknown', decimals: heliusData?.decimals || 9, poolAddress: '', liquidity: birdeyeData?.liquidity || 0, marketCap: birdeyeData?.mc || 0, holders: birdeyeData?.holder || 0, topHolderPct: await this.getTopHolderPct(mint), createdAt: Date.now(), isRenounced: heliusData?.mintAuthority === null, isMintable: heliusData?.mintAuthority !== null, lpBurned: false };
    } catch { return null; }
  }

  private applyFilters(token: TokenInfo): { passed: boolean; reason: string; score: number } {
    let score = 50;
    if (token.liquidity < this.filters.minLiquiditySOL) return { passed: false, reason: 'Liquidez baixa', score: 0 };
    score += Math.min(20, token.liquidity / 2);
    if (token.topHolderPct > this.filters.maxTopHolderPct) return { passed: false, reason: `Top holder: ${token.topHolderPct}%`, score: 0 };
    score += (30 - token.topHolderPct) / 2;
    if (this.filters.requireMintRevoked && token.isMintable) return { passed: false, reason: 'Mint não revogada', score: 0 };
    if (token.isRenounced) score += 10;
    if (token.holders < this.filters.minHolders) return { passed: false, reason: `Poucos holders: ${token.holders}`, score: 0 };
    score += Math.min(10, token.holders / 10);
    return { passed: true, reason: 'OK', score: Math.min(100, Math.round(score)) };
  }

  private extractMintFromTx(txData: any): string | null { try { return txData.transaction?.message?.accountKeys?.[1]?.pubkey || null; } catch { return null; } }

  private async getHeliusTokenData(mint: string): Promise<any> {
    try {
      const res = await fetch(`https://api.helius.xyz/v0/token-metadata?api-key=${CONFIG.heliusKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mintAccounts: [mint] }) });
      const data = await res.json(); return data[0]?.onChainAccountInfo?.accountInfo?.data?.parsed?.info || null;
    } catch { return null; }
  }

  private async getBirdeyeTokenData(mint: string): Promise<any> {
    try {
      const res = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } });
      return (await res.json()).data || null;
    } catch { return null; }
  }

  private async getTopHolderPct(mint: string): Promise<number> {
    try {
      const res = await fetch(`https://public-api.birdeye.so/defi/token_holder?address=${mint}&limit=1`, { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } });
      return (await res.json()).data?.items?.[0]?.percentage || 0;
    } catch { return 100; }
  }
}
ENDOFFILE
echo "  ✅ Fixed src/modules/sniper.ts"

# ============================================================
# 2. Fix src/modules/pumpfun.ts — same WS error handling
# ============================================================
# Patch the connectWebSocket method in pumpfun
cat > /tmp/fix_pumpfun.py << 'PYEOF'
with open('src/modules/pumpfun.ts', 'r') as f:
    c = f.read()

# Add error handler if missing
if "this.ws.on('error'" not in c:
    old = """this.ws.on('close', () => {
      console.log('🔌 Pump.fun WS disconnected, reconnecting...');
      setTimeout(() => this.connectWebSocket(), 3000);
    });"""
    new = """this.ws.on('error', (err) => {
      console.error(`🔌 Pump.fun WS error: ${err.message}`);
    });
    this.ws.on('close', (code) => {
      console.log(`🔌 Pump.fun WS closed (${code}), reconnecting in 5s...`);
      this.ws = null;
      setTimeout(() => this.connectWebSocket(), 5000);
    });"""
    c = c.replace(old, new, 1)

with open('src/modules/pumpfun.ts', 'w') as f:
    f.write(c)
PYEOF

if command -v python3 &> /dev/null; then
  python3 /tmp/fix_pumpfun.py
  echo "  ✅ Fixed src/modules/pumpfun.ts"
elif command -v python &> /dev/null; then
  python /tmp/fix_pumpfun.py
  echo "  ✅ Fixed src/modules/pumpfun.ts"
else
  echo "  ⚠️  Could not patch pumpfun.ts — add ws.on('error') manually"
fi
rm -f /tmp/fix_pumpfun.py

# ============================================================
# 3. Fix src/core/connection.ts — handle invalid private key
# ============================================================
cat > src/core/connection.ts << 'ENDOFFILE'
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from '../config';

// Validate RPC URL
if (!CONFIG.rpc || CONFIG.rpc.includes('YOUR_')) {
  console.error('❌ SOLANA_RPC_URL not configured in .env');
  console.error('   Get a free key at https://helius.dev');
  process.exit(1);
}

export const connection = new Connection(CONFIG.rpc, {
  commitment: 'confirmed',
  wsEndpoint: CONFIG.ws,
});

// Validate private key
let wallet: Keypair;
try {
  if (!CONFIG.privateKey || CONFIG.privateKey.includes('your_')) {
    console.error('❌ PRIVATE_KEY not configured in .env');
    console.error('   Export your wallet private key in base58 format');
    process.exit(1);
  }
  wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.privateKey));
} catch (err: any) {
  console.error(`❌ Invalid PRIVATE_KEY in .env: ${err.message}`);
  process.exit(1);
}

export { wallet };
console.log(`🔑 Wallet: ${wallet.publicKey.toBase58()}`);
ENDOFFILE
echo "  ✅ Fixed src/core/connection.ts"

# ============================================================
# 4. Fix src/core/alerts.ts — handle missing Telegram token
# ============================================================
cat > src/core/alerts.ts << 'ENDOFFILE'
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
      disable_web_page_preview: true,
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
ENDOFFILE
echo "  ✅ Fixed src/core/alerts.ts"

# ============================================================
echo ""
echo "  ════════════════════════════════════════"
echo "  ✅ PATCH APPLIED!"
echo "  ════════════════════════════════════════"
echo ""
echo "  Fixed:"
echo "    • Sniper WS: won't crash on 403/invalid key"
echo "    • Pump.fun WS: added error handler"
echo "    • Connection: validates RPC URL and private key"
echo "    • Alerts: works without Telegram (logs to console)"
echo ""
echo "  ⚠️  IMPORTANT: Edit your .env with real API keys!"
echo ""
echo "  Minimum to run (free tiers):"
echo "    1. HELIUS_API_KEY  → https://helius.dev"
echo "    2. BIRDEYE_API_KEY → https://birdeye.so"
echo "    3. PRIVATE_KEY     → your wallet base58 key"
echo ""
echo "  Optional:"
echo "    4. TELEGRAM_BOT_TOKEN + CHAT_ID"
echo "    5. TWITTER_BEARER_TOKEN"
echo ""
echo "  Then run: npm start"
echo "  ════════════════════════════════════════"
