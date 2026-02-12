import WebSocket from 'ws';
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { sendAlert, formatTradeAlert } from '../core/alerts';
import { CONFIG } from '../config';
import { TokenInfo, TradeSignal } from '../types';

export class SniperModule {
  private jupiter: JupiterSwap;
  private ws: WebSocket | null = null;
  private processedPools = new Set<string>();

  private filters = {
    minLiquiditySOL: 5,
    maxTopHolderPct: 30,
    requireMintRevoked: true,
    requireFreezeRevoked: true,
    minHolders: 10,
    maxAgeSeconds: 300,
    blacklistedDevs: new Set<string>(),
  };

  constructor() {
    this.jupiter = new JupiterSwap(connection, wallet);
  }

  async start() {
    console.log('🎯 Sniper Module started');
    this.connectWebSocket();
  }

  private connectWebSocket() {
    const wsUrl = `wss://atlas-mainnet.helius-rpc.com/?api-key=${CONFIG.heliusKey}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('🔌 Sniper WS connected');
      const RAYDIUM_AMM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'transactionSubscribe',
        params: [{
          accountInclude: [RAYDIUM_AMM],
          type: 'SWAP',
        }, {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0,
        }],
      }));
    });

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.params?.result) await this.processNewPool(msg.params.result);
      } catch {}
    });

    this.ws.on('close', () => {
      console.log('🔌 Sniper WS disconnected, reconnecting...');
      setTimeout(() => this.connectWebSocket(), 3000);
    });

    this.ws.on('error', (err) => {
      console.error(`🔌 Sniper WS error: ${err.message}`);
      console.log('⚠️  WebSocket bloqueado (Zscaler/firewall?). Sniper em modo limitado.');
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
    if (!filterResult.passed) {
      console.log(`❌ Filtro: ${filterResult.reason}`);
      return;
    }

    const signal: TradeSignal = {
      type: 'SNIPE', action: 'BUY', mint,
      reason: `Nova pool | Liq: ${tokenInfo.liquidity} SOL | ${tokenInfo.holders} holders`,
      confidence: filterResult.score,
      amountSol: CONFIG.trading.maxBuySol,
    };

    await sendAlert(formatTradeAlert(signal));

    if (signal.confidence >= 70) {
      const tx = await this.jupiter.buy(mint, CONFIG.trading.maxBuySol);
      if (tx) await sendAlert(`✅ Snipe executado!\nTX: https://solscan.io/tx/${tx}`);
    }
  }

  private async analyzeToken(mint: string): Promise<TokenInfo | null> {
    try {
      const [heliusData, birdeyeData] = await Promise.all([
        this.getHeliusTokenData(mint),
        this.getBirdeyeTokenData(mint),
      ]);
      return {
        mint, symbol: heliusData?.symbol || 'UNKNOWN',
        name: heliusData?.name || 'Unknown', decimals: heliusData?.decimals || 9,
        poolAddress: '', liquidity: birdeyeData?.liquidity || 0,
        marketCap: birdeyeData?.mc || 0, holders: birdeyeData?.holder || 0,
        topHolderPct: await this.getTopHolderPct(mint),
        createdAt: Date.now(),
        isRenounced: heliusData?.mintAuthority === null,
        isMintable: heliusData?.mintAuthority !== null,
        lpBurned: false,
      };
    } catch { return null; }
  }

  private applyFilters(token: TokenInfo): { passed: boolean; reason: string; score: number } {
    let score = 50;
    if (token.liquidity < this.filters.minLiquiditySOL)
      return { passed: false, reason: 'Liquidez baixa', score: 0 };
    score += Math.min(20, token.liquidity / 2);

    if (token.topHolderPct > this.filters.maxTopHolderPct)
      return { passed: false, reason: `Top holder: ${token.topHolderPct}%`, score: 0 };
    score += (30 - token.topHolderPct) / 2;

    if (this.filters.requireMintRevoked && token.isMintable)
      return { passed: false, reason: 'Mint não revogada', score: 0 };
    if (token.isRenounced) score += 10;

    if (token.holders < this.filters.minHolders)
      return { passed: false, reason: `Poucos holders: ${token.holders}`, score: 0 };
    score += Math.min(10, token.holders / 10);

    return { passed: true, reason: 'OK', score: Math.min(100, Math.round(score)) };
  }

  private extractMintFromTx(txData: any): string | null {
    try {
      const accounts = txData.transaction?.message?.accountKeys || [];
      return accounts[1]?.pubkey || null;
    } catch { return null; }
  }

  private async getHeliusTokenData(mint: string): Promise<any> {
    const res = await fetch(
      `https://api.helius.xyz/v0/token-metadata?api-key=${CONFIG.heliusKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mintAccounts: [mint] }) }
    );
    const data = await res.json() as any[];
    return data[0]?.onChainAccountInfo?.accountInfo?.data?.parsed?.info || null;
  }

  private async getBirdeyeTokenData(mint: string): Promise<any> {
    const res = await fetch(
      `https://public-api.birdeye.so/defi/token_overview?address=${mint}`,
      { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } }
    );
    const data = await res.json() as { data?: any };
    return data.data || null;
  }

  private async getTopHolderPct(mint: string): Promise<number> {
    try {
      const res = await fetch(
        `https://public-api.birdeye.so/defi/token_holder?address=${mint}&limit=1`,
        { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } }
      );
      const data = await res.json() as { data?: { items?: { percentage?: number }[] } };
      return data.data?.items?.[0]?.percentage || 0;
    } catch { return 100; }
  }
}
