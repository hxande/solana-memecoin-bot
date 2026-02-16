import { PublicKey } from '@solana/web3.js';
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { sendAlert, formatTradeAlert } from '../core/alerts';
import { storage } from '../core/storage';
import { CONFIG } from '../config';
import { TokenInfo, TradeSignal } from '../types';
import { PositionManager } from './positionManager';

const RAYDIUM_AMM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

export class SniperModule {
  private jupiter: JupiterSwap;
  private processedSignatures = new Set<string>();
  private processedMints = new Set<string>();
  private lastSignature: string | undefined;
  private pollInterval = 3000;
  private apiErrors = { helius: 0, birdeye: 0 };
  private positionManager: PositionManager | null = null;
  private _running = false;
  private _timers: NodeJS.Timeout[] = [];

  private filters = {
    minLiquiditySOL: 5, maxTopHolderPct: 30, requireMintRevoked: true,
    requireFreezeRevoked: true, minHolders: 10, maxAgeSeconds: 300,
    blacklistedDevs: new Set<string>(),
  };

  constructor(positionManager?: PositionManager) {
    this.jupiter = new JupiterSwap(connection, wallet);
    this.positionManager = positionManager || null;
    this.filters.blacklistedDevs = storage.getBlacklistSet();
    if (this.filters.blacklistedDevs.size > 0)
      console.log(`🎯 Loaded ${this.filters.blacklistedDevs.size} blacklisted devs`);
  }

  async start() {
    this._running = true;
    console.log('🎯 Sniper Module started (polling mode)');
    await this.validateApis();
    this.pollRaydium();
    this.startCleanupTimer();
  }

  stop() {
    this._running = false;
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    console.log('🎯 Sniper Module stopped');
  }

  isRunning() { return this._running; }

  // ══════════════════════════════
  // Validate API keys on startup
  // ══════════════════════════════
  private async validateApis() {
    // Test Helius
    try {
      const res = await fetch(`https://api.helius.xyz/v0/token-metadata?api-key=${CONFIG.heliusKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mintAccounts: ['So11111111111111111111111111111111111111112'] }),
      });
      if (res.ok) {
        console.log('🎯 Helius API: ✅ Working');
      } else {
        console.error(`🎯 Helius API: ❌ Status ${res.status} — check HELIUS_API_KEY`);
      }
    } catch (err: any) {
      console.error(`🎯 Helius API: ❌ ${err.message}`);
    }

    // Test Birdeye
    try {
      const res = await fetch('https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112', {
        headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' },
      });
      if (res.ok) {
        console.log('🎯 Birdeye API: ✅ Working');
      } else {
        console.error(`🎯 Birdeye API: ❌ Status ${res.status} — check BIRDEYE_API_KEY`);
      }
    } catch (err: any) {
      console.error(`🎯 Birdeye API: ❌ ${err.message}`);
    }
  }

  // ══════════════════════════════
  // Poll Raydium AMM
  // ══════════════════════════════
  private async pollRaydium() {
    const poll = async () => {
      try {
        const sigs = await connection.getSignaturesForAddress(
          RAYDIUM_AMM, { limit: 10, until: this.lastSignature }, 'confirmed'
        );

        if (sigs.length > 0) {
          this.lastSignature = sigs[0].signature;
          for (const sig of sigs.reverse()) {
            if (this.processedSignatures.has(sig.signature)) continue;
            this.processedSignatures.add(sig.signature);
            await this.processTransaction(sig.signature);
          }
        }
      } catch (err: any) {
        console.error(`🎯 Poll error: ${err.message}`);
      }
      if (this._running) this._timers.push(setTimeout(poll, this.pollInterval));
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
        (m: string) => !preTokens.has(m) && m !== 'So11111111111111111111111111111111111111112'
      );
      const unique = [...new Set(newMints)];

      for (const mint of unique) {
        if (this.processedMints.has(mint)) continue;
        this.processedMints.add(mint);
        console.log(`\n🆕 Raydium new pool: ${mint}`);
        await this.evaluateAndBuy(mint);
      }
    } catch (err: any) {
      console.error(`🎯 ProcessTx error (${signature.slice(0, 8)}...): ${err.message}`);
    }
  }

  private async evaluateAndBuy(mint: string) {
    const tokenInfo = await this.analyzeToken(mint);
    if (!tokenInfo) {
      console.log(`  ⚠️  Could not fetch token data — skipping`);
      console.log(`  📊 API errors: Helius=${this.apiErrors.helius}, Birdeye=${this.apiErrors.birdeye}`);
      return;
    }

    console.log(`  📋 ${tokenInfo.symbol} (${tokenInfo.name})`);
    const result = this.applyFiltersWithLog(tokenInfo);

    if (!result.passed) {
      console.log(`  🚫 BLOCKED — ${result.reason} | Score: ${result.score}/100`);
      return;
    }

    console.log(`  ✅ PASSED — Score: ${result.score}/100 (threshold: ${CONFIG.trading.sniperMinScore})`);

    const signal: TradeSignal = {
      type: 'SNIPE', action: 'BUY', mint,
      reason: `Nova pool | Liq: ${tokenInfo.liquidity} SOL | ${tokenInfo.holders} holders`,
      confidence: result.score, amountSol: CONFIG.trading.maxBuySol,
    };

    await sendAlert(formatTradeAlert(signal));

    if (signal.confidence >= CONFIG.trading.sniperMinScore) {
      // Check max positions before buying
      if (this.positionManager && !this.positionManager.canOpenPosition()) {
        console.log(`  ⏭️  Max positions (${CONFIG.trading.maxPositions}) reached — skipping buy`);
        return;
      }

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

        // Register position with PositionManager
        if (this.positionManager) {
          const price = await this.jupiter.getPrice(mint);
          this.positionManager.addPosition({
            mint, symbol: tokenInfo.symbol, entryPrice: price,
            amount: CONFIG.trading.maxBuySol, entryTime: Date.now(), source: 'SNIPE',
          });
        }
      } else {
        console.log(`  ❌ BUY FAILED (Jupiter error)`);
      }
    } else {
      console.log(`  ⏭️  Score ${result.score} < ${CONFIG.trading.sniperMinScore} — alert only`);
    }
  }

  // ══════════════════════════════
  // Filters — base 0, threshold from config
  // ══════════════════════════════
  private applyFiltersWithLog(token: TokenInfo): { passed: boolean; reason: string; score: number } {
    let score = 0, passed = true, fail = '';

    // Blacklist check — instant reject
    if (token.creator && this.filters.blacklistedDevs.has(token.creator)) {
      console.log(`  ❌ Blacklisted dev: ${token.creator.slice(0, 8)}...`);
      return { passed: false, reason: 'Blacklisted dev', score: 0 };
    }

    // Age check — reject tokens older than maxAgeSeconds
    const ageSec = (Date.now() - token.createdAt) / 1000;
    if (ageSec > this.filters.maxAgeSeconds) {
      console.log(`  ❌ Token too old: ${ageSec.toFixed(0)}s (max: ${this.filters.maxAgeSeconds}s)`);
      return { passed: false, reason: `Token too old: ${ageSec.toFixed(0)}s`, score: 0 };
    }

    // Liquidity: max 20pts — needs 100 SOL for max
    const liqOk = token.liquidity >= this.filters.minLiquiditySOL;
    console.log(`  ${liqOk ? '✅' : '❌'} Liquidity: ${token.liquidity.toFixed(1)} SOL (min: ${this.filters.minLiquiditySOL})`);
    if (!liqOk) { passed = false; fail = 'Liquidez baixa'; }
    else score += Math.min(20, Math.floor(token.liquidity / 5));

    // Top holder: max 15pts
    const holderOk = token.topHolderPct <= this.filters.maxTopHolderPct;
    console.log(`  ${holderOk ? '✅' : '❌'} Top holder: ${token.topHolderPct.toFixed(1)}% (max: ${this.filters.maxTopHolderPct}%)`);
    if (!holderOk && passed) { passed = false; fail = `Top holder: ${token.topHolderPct}%`; }
    else if (holderOk) score += Math.min(15, Math.floor((30 - token.topHolderPct) / 2));

    // Mint renounced: +15
    const mintOk = !this.filters.requireMintRevoked || !token.isMintable;
    console.log(`  ${mintOk ? '✅' : '❌'} Mint renounced: ${token.isRenounced ? 'YES' : 'NO'}`);
    if (!mintOk && passed) { passed = false; fail = 'Mint não revogada'; }
    if (token.isRenounced) score += 15;

    // Freeze authority revoked: +10
    const freezeOk = !this.filters.requireFreezeRevoked || token.freezeAuthority === null;
    console.log(`  ${freezeOk ? '✅' : '❌'} Freeze revoked: ${token.freezeAuthority === null ? 'YES' : token.freezeAuthority === undefined ? 'UNKNOWN' : 'NO'}`);
    if (!freezeOk && passed) { passed = false; fail = 'Freeze authority ativa'; }
    if (token.freezeAuthority === null) score += 10;

    // Holders: max 15pts — needs 300 for max
    const holdersOk = token.holders >= this.filters.minHolders;
    console.log(`  ${holdersOk ? '✅' : '❌'} Holders: ${token.holders} (min: ${this.filters.minHolders})`);
    if (!holdersOk && passed) { passed = false; fail = `Poucos holders: ${token.holders}`; }
    else if (holdersOk) score += Math.min(15, Math.floor(token.holders / 20));

    // LP burned: +10
    console.log(`  ℹ️  LP burned: ${token.lpBurned ? 'YES' : 'UNKNOWN'}`);
    if (token.lpBurned) score += 10;

    // Fresh token bonus: +10 if < 120s old
    if (ageSec < 120) {
      score += 10;
      console.log(`  ✅ Fresh token: ${ageSec.toFixed(0)}s old (+10)`);
    } else {
      console.log(`  ℹ️  Token age: ${ageSec.toFixed(0)}s`);
    }

    console.log(`  ℹ️  MCap: $${token.marketCap.toLocaleString()}`);

    const s = Math.min(100, Math.round(score));
    console.log(`  🧮 Score: ${s}/100 (threshold: ${CONFIG.trading.sniperMinScore})`);

    return passed ? { passed: true, reason: 'OK', score: s } : { passed: false, reason: fail, score: s };
  }

  // ══════════════════════════════
  // Token analysis — with full error logging
  // ══════════════════════════════
  private async analyzeToken(mint: string): Promise<TokenInfo | null> {
    try {
      const [heliusData, birdeyeData] = await Promise.allSettled([
        this.getHeliusTokenData(mint),
        this.getBirdeyeTokenData(mint),
      ]);

      const helius = heliusData.status === 'fulfilled' ? heliusData.value : null;
      const birdeye = birdeyeData.status === 'fulfilled' ? birdeyeData.value : null;

      if (heliusData.status === 'rejected') {
        console.error(`  ⚠️  Helius failed: ${heliusData.reason?.message || heliusData.reason}`);
        this.apiErrors.helius++;
      }
      if (birdeyeData.status === 'rejected') {
        console.error(`  ⚠️  Birdeye failed: ${birdeyeData.reason?.message || birdeyeData.reason}`);
        this.apiErrors.birdeye++;
      }

      // Need at least birdeye for liquidity data
      if (!birdeye) {
        console.log(`  ⚠️  No Birdeye data — cannot evaluate liquidity`);
        return null;
      }

      const topHolder = await this.getTopHolderPct(mint);

      return {
        mint,
        symbol: helius?.symbol || birdeye?.symbol || 'UNKNOWN',
        name: helius?.name || birdeye?.name || 'Unknown',
        decimals: helius?.decimals || 9,
        poolAddress: '',
        liquidity: birdeye?.liquidity || 0,
        marketCap: birdeye?.mc || 0,
        holders: birdeye?.holder || 0,
        topHolderPct: topHolder,
        createdAt: Date.now(),
        // Fail-closed: if Helius fails, assume mintable (unsafe)
        isRenounced: helius ? helius.mintAuthority === null : false,
        isMintable: helius ? helius.mintAuthority !== null : true,
        lpBurned: false,
        // Extract freeze authority from Helius data
        freezeAuthority: helius ? (helius.freezeAuthority || null) : undefined,
      };
    } catch (err: any) {
      console.error(`  ❌ analyzeToken error: ${err.message}`);
      return null;
    }
  }

  private async getHeliusTokenData(mint: string): Promise<any> {
    try {
      const res = await fetch(`https://api.helius.xyz/v0/token-metadata?api-key=${CONFIG.heliusKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mintAccounts: [mint] }),
      });
      if (!res.ok) {
        console.error(`  ⚠️  Helius HTTP ${res.status} for ${mint.slice(0, 8)}...`);
        this.apiErrors.helius++;
        return null;
      }
      const data: any = await res.json();
      return data[0]?.onChainAccountInfo?.accountInfo?.data?.parsed?.info || null;
    } catch (err: any) {
      console.error(`  ⚠️  Helius error: ${err.message}`);
      this.apiErrors.helius++;
      return null;
    }
  }

  private async getBirdeyeTokenData(mint: string): Promise<any> {
    try {
      const res = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, {
        headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' },
      });
      if (!res.ok) {
        console.error(`  ⚠️  Birdeye HTTP ${res.status} for ${mint.slice(0, 8)}...`);
        this.apiErrors.birdeye++;
        return null;
      }
      const data = await res.json() as any;
      return data?.data || null;
    } catch (err: any) {
      console.error(`  ⚠️  Birdeye error: ${err.message}`);
      this.apiErrors.birdeye++;
      return null;
    }
  }

  private async getTopHolderPct(mint: string): Promise<number> {
    try {
      const res = await fetch(`https://public-api.birdeye.so/defi/token_holder?address=${mint}&limit=1`, {
        headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' },
      });
      if (!res.ok) {
        console.error(`  ⚠️  Birdeye holders HTTP ${res.status}`);
        // Fail-closed: assume worst case on HTTP error
        return 100;
      }
      const data = await res.json() as any;
      return data?.data?.items?.[0]?.percentage || 0;
    } catch (err: any) {
      console.error(`  ⚠️  Top holder check error: ${err.message}`);
      return 100;
    }
  }

  // ══════════════════════════════
  // Memory cleanup
  // ══════════════════════════════
  private startCleanupTimer() {
    const id = setInterval(() => {
      if (!this._running) { clearInterval(id); return; }
      // Cap processedSignatures at 10k
      if (this.processedSignatures.size > 10000) {
        const arr = Array.from(this.processedSignatures);
        this.processedSignatures = new Set(arr.slice(arr.length - 5000));
        console.log(`🎯 Trimmed processedSignatures: ${arr.length} → ${this.processedSignatures.size}`);
      }
      // Cap processedMints at 10k
      if (this.processedMints.size > 10000) {
        const arr = Array.from(this.processedMints);
        this.processedMints = new Set(arr.slice(arr.length - 5000));
        console.log(`🎯 Trimmed processedMints: ${arr.length} → ${this.processedMints.size}`);
      }
    }, 10 * 60 * 1000); // every 10 minutes
    this._timers.push(id);
  }
}
