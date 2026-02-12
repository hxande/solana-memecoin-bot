import { PublicKey } from '@solana/web3.js';
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { sendAlert, formatTradeAlert } from '../core/alerts';
import { storage } from '../core/storage';
import { CONFIG } from '../config';
import { TokenInfo, TradeSignal } from '../types';

const RAYDIUM_AMM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

export class SniperModule {
  private jupiter: JupiterSwap;
  private processedPools = new Set<string>();
  private lastSignature: string | undefined;
  private pollInterval = 3000; // 3 seconds

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
    console.log('🎯 Sniper Module started (polling mode)');
    this.pollRaydium();
  }

  // ==========================================
  // Polling — checks Raydium for new txs every 3s
  // ==========================================
  private async pollRaydium() {
    const poll = async () => {
      try {
        const sigs = await connection.getSignaturesForAddress(
          RAYDIUM_AMM,
          { limit: 10, until: this.lastSignature },
          'confirmed'
        );

        if (sigs.length > 0) {
          this.lastSignature = sigs[0].signature;

          // Process oldest first
          for (const sig of sigs.reverse()) {
            if (this.processedPools.has(sig.signature)) continue;
            this.processedPools.add(sig.signature);
            await this.processTransaction(sig.signature);
          }
        }
      } catch (err: any) {
        console.error(`🎯 Poll error: ${err.message}`);
      }

      setTimeout(poll, this.pollInterval);
    };

    poll();
  }

  // ==========================================
  // Process a Raydium transaction
  // ==========================================
  private async processTransaction(signature: string) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx?.meta || tx.meta.err) return;

      // Detect new token mints from post-token balances
      // New pools create token accounts that didn't exist before
      const preTokens = new Set(
        (tx.meta.preTokenBalances || []).map((b: any) => b.mint)
      );
      const postTokens = (tx.meta.postTokenBalances || []).map((b: any) => b.mint);

      // Find mints that appear in post but not in pre (new pool tokens)
      const newMints = postTokens.filter(
        (mint: string) => !preTokens.has(mint) && mint !== 'So11111111111111111111111111111111111111112'
      );

      // Deduplicate
      const uniqueMints = [...new Set(newMints)];

      for (const mint of uniqueMints) {
        if (this.processedPools.has(mint)) continue;
        this.processedPools.add(mint);

        console.log(`🆕 Raydium new pool: ${mint}`);
        await this.evaluateAndBuy(mint);
      }
    } catch {}
  }

  // ==========================================
  // Evaluate token and buy if score is high
  // ==========================================
  private async evaluateAndBuy(mint: string) {
    const tokenInfo = await this.analyzeToken(mint);
    if (!tokenInfo) return;

    const filterResult = this.applyFilters(tokenInfo);
    if (!filterResult.passed) {
      console.log(`  ❌ ${filterResult.reason}`);
      return;
    }

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
        storage.addTrade({
          id: tx, time: Date.now(), action: 'BUY', mint,
          symbol: tokenInfo.symbol, amountSol: CONFIG.trading.maxBuySol,
          price: 0, tx, source: 'SNIPE',
        });
      }
    }
  }

  // ==========================================
  // Token analysis
  // ==========================================
  private async analyzeToken(mint: string): Promise<TokenInfo | null> {
    try {
      const [heliusData, birdeyeData] = await Promise.all([
        this.getHeliusTokenData(mint),
        this.getBirdeyeTokenData(mint),
      ]);
      return {
        mint,
        symbol: heliusData?.symbol || 'UNKNOWN',
        name: heliusData?.name || 'Unknown',
        decimals: heliusData?.decimals || 9,
        poolAddress: '',
        liquidity: birdeyeData?.liquidity || 0,
        marketCap: birdeyeData?.mc || 0,
        holders: birdeyeData?.holder || 0,
        topHolderPct: await this.getTopHolderPct(mint),
        createdAt: Date.now(),
        isRenounced: heliusData?.mintAuthority === null,
        isMintable: heliusData?.mintAuthority !== null,
        lpBurned: false,
      };
    } catch { return null; }
  }

  // ==========================================
  // Filters
  // ==========================================
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

  // ==========================================
  // API calls
  // ==========================================
  private async getHeliusTokenData(mint: string): Promise<any> {
    try {
      const res = await fetch(
        `https://api.helius.xyz/v0/token-metadata?api-key=${CONFIG.heliusKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mintAccounts: [mint] }) }
      );
      const data = (await res.json()) as any[];
      return data[0]?.onChainAccountInfo?.accountInfo?.data?.parsed?.info || null;
    } catch { return null; }
  }

  private async getBirdeyeTokenData(mint: string): Promise<any> {
    try {
      const res = await fetch(
        `https://public-api.birdeye.so/defi/token_overview?address=${mint}`,
        { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } }
      );
      const data = (await res.json()) as { data?: any };
      return data.data || null;
    } catch { return null; }
  }

  private async getTopHolderPct(mint: string): Promise<number> {
    try {
      const res = await fetch(
        `https://public-api.birdeye.so/defi/token_holder?address=${mint}&limit=1`,
        { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } }
      );
      const data = (await res.json()) as { data?: { items?: { percentage?: number }[] } };
      return data.data?.items?.[0]?.percentage || 0;
    } catch { return 100; }
  }
}