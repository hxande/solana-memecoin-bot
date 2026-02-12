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
  private pollInterval = 3000;

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

  private async processTransaction(signature: string) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta || tx.meta.err) return;

      const preTokens = new Set(
        (tx.meta.preTokenBalances || []).map((b: any) => b.mint)
      );
      const postTokens = (tx.meta.postTokenBalances || []).map((b: any) => b.mint);
      const newMints = postTokens.filter(
        (mint: string) => !preTokens.has(mint) && mint !== 'So11111111111111111111111111111111111111112'
      );
      const uniqueMints = [...new Set(newMints)];

      for (const mint of uniqueMints) {
        if (this.processedPools.has(mint)) continue;
        this.processedPools.add(mint);
        console.log(`\n🆕 Raydium new pool: ${mint}`);
        await this.evaluateAndBuy(mint);
      }
    } catch {}
  }

  private async evaluateAndBuy(mint: string) {
    const tokenInfo = await this.analyzeToken(mint);
    if (!tokenInfo) {
      console.log(`  ⚠️  Could not fetch token data — skipping`);
      return;
    }

    // ── Detailed filter logging ──
    console.log(`  📋 ${tokenInfo.symbol} (${tokenInfo.name})`);

    const filterResult = this.applyFiltersWithLog(tokenInfo);

    if (!filterResult.passed) {
      console.log(`  🚫 BLOCKED — Score: ${filterResult.score}/100`);
      return;
    }

    console.log(`  ✅ PASSED — Score: ${filterResult.score}/100`);

    const signal: TradeSignal = {
      type: 'SNIPE', action: 'BUY', mint,
      reason: `Nova pool | Liq: ${tokenInfo.liquidity} SOL | ${tokenInfo.holders} holders`,
      confidence: filterResult.score, amountSol: CONFIG.trading.maxBuySol,
    };

    await sendAlert(formatTradeAlert(signal));

    if (signal.confidence >= 50) {
      console.log(`  💰 Executing buy: ${CONFIG.trading.maxBuySol} SOL...`);
      const tx = await this.jupiter.buy(mint, CONFIG.trading.maxBuySol);
      if (tx) {
        console.log(`  ✅ BUY SUCCESS: https://solscan.io/tx/${tx}`);
        await sendAlert(`✅ Snipe executado!\nTX: https://solscan.io/tx/${tx}`);
        storage.addTrade({
          id: tx, time: Date.now(), action: 'BUY', mint,
          symbol: tokenInfo.symbol, amountSol: CONFIG.trading.maxBuySol,
          price: 0, tx, source: 'SNIPE',
        });
      } else {
        console.log(`  ❌ BUY FAILED (Jupiter error)`);
      }
    } else {
      console.log(`  ⏭️  Score ${filterResult.score} < 50 — alert only, no buy`);
    }
  }

  // ==========================================
  // Filters WITH detailed logging
  // ==========================================
  private applyFiltersWithLog(token: TokenInfo): { passed: boolean; reason: string; score: number } {
    let score = 50;
    let passed = true;
    let failReason = '';

    // Liquidity
    const liqOk = token.liquidity >= this.filters.minLiquiditySOL;
    console.log(`  ${liqOk ? '✅' : '❌'} Liquidity: ${token.liquidity.toFixed(1)} SOL (min: ${this.filters.minLiquiditySOL})`);
    if (!liqOk) { passed = false; failReason = 'Liquidez baixa'; }
    else { score += Math.min(20, token.liquidity / 2); }

    // Top holder
    const holderOk = token.topHolderPct <= this.filters.maxTopHolderPct || token.topHolderPct === 0;
    console.log(`  ${holderOk ? '✅' : '❌'} Top holder: ${token.topHolderPct.toFixed(1)}% (max: ${this.filters.maxTopHolderPct}%)`);
    if (!holderOk && passed) { passed = false; failReason = `Top holder: ${token.topHolderPct}%`; }
    else if (holderOk) { score += (30 - token.topHolderPct) / 2; }

    // Mint authority
    const mintOk = !this.filters.requireMintRevoked || !token.isMintable;
    console.log(`  ${mintOk ? '✅' : '❌'} Mint renounced: ${token.isRenounced ? 'YES' : 'NO'}${this.filters.requireMintRevoked ? ' (required)' : ''}`);
    if (!mintOk && passed) { passed = false; failReason = 'Mint não revogada'; }
    if (token.isRenounced) score += 10;

    // Holders
    const holdersOk = token.holders >= this.filters.minHolders;
    console.log(`  ${holdersOk ? '✅' : '❌'} Holders: ${token.holders} (min: ${this.filters.minHolders})`);
    if (!holdersOk && passed) { passed = false; failReason = `Poucos holders: ${token.holders}`; }
    else if (holdersOk) { score += Math.min(10, token.holders / 10); }

    // LP Burned
    console.log(`  ℹ️  LP burned: ${token.lpBurned ? 'YES' : 'UNKNOWN'}`);
    console.log(`  ℹ️  Market cap: $${token.marketCap.toLocaleString()}`);

    const finalScore = Math.min(100, Math.round(score));
    console.log(`  🧮 Score: ${finalScore}/100`);

    if (!passed) return { passed: false, reason: failReason, score: finalScore };
    return { passed: true, reason: 'OK', score: finalScore };
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
        topHolderPct: await this.getTopHolderPct(mint), createdAt: Date.now(),
        isRenounced: heliusData?.mintAuthority === null,
        isMintable: heliusData?.mintAuthority !== null, lpBurned: false,
      };
    } catch { return null; }
  }

  private async getHeliusTokenData(mint: string): Promise<any> {
    try {
      const res = await fetch(`https://api.helius.xyz/v0/token-metadata?api-key=${CONFIG.heliusKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mintAccounts: [mint] }) });
      const data: any = await res.json();
      return data[0]?.onChainAccountInfo?.accountInfo?.data?.parsed?.info || null;
    } catch { return null; }
  }

  private async getBirdeyeTokenData(mint: string): Promise<any> {
    try {
      const res: any = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`,
        { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } });
      return (await res.json()).data || null;
    } catch { return null; }
  }

  private async getTopHolderPct(mint: string): Promise<number> {
    try {
      const res: any = await fetch(`https://public-api.birdeye.so/defi/token_holder?address=${mint}&limit=1`,
        { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } });
      return (await res.json()).data?.items?.[0]?.percentage || 0;
    } catch { return 100; }
  }
}