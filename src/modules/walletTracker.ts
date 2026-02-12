import { PublicKey } from '@solana/web3.js';
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { sendAlert, formatTradeAlert } from '../core/alerts';
import { storage } from '../core/storage';
import { CONFIG } from '../config';
import { WalletConfig, TradeSignal } from '../types';

export class WalletTracker {
  private jupiter: JupiterSwap;
  private trackedWallets: WalletConfig[];

  constructor() {
    this.jupiter = new JupiterSwap(connection, wallet);
    const saved = storage.loadWallets();
    if (saved.length > 0) {
      this.trackedWallets = saved;
      console.log(`👀 Loaded ${saved.length} wallets from disk`);
    } else {
      this.trackedWallets = [];
    }
  }

  async start() {
    console.log('👀 Wallet Tracker started');
    console.log(`📋 Monitorando ${this.trackedWallets.filter(w => w.enabled).length} wallets`);
    for (const w of this.trackedWallets) {
      if (w.enabled) this.pollWalletTransactions(w);
    }
  }

  private async pollWalletTransactions(config: WalletConfig) {
    let lastSig: string | undefined;
    const poll = async () => {
      try {
        const sigs = await connection.getSignaturesForAddress(
          new PublicKey(config.address), { limit: 5, until: lastSig }
        );
        if (sigs.length > 0) {
          lastSig = sigs[0].signature;
          for (const sig of sigs.reverse()) await this.analyzeTransaction(sig.signature, config);
        }
      } catch (err: any) { console.error(`Poll error (${config.label}): ${err.message}`); }
      setTimeout(poll, 2000);
    };
    poll();
  }

  private async analyzeTransaction(signature: string, config: WalletConfig) {
    try {
      const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) return;
      const changes = this.detectTokenChanges(tx.meta.preTokenBalances || [], tx.meta.postTokenBalances || [], config.address);

      for (const change of changes) {
        if (Math.abs(change.solAmount) < config.minTradeSol) continue;
        const signal: TradeSignal = {
          type: 'COPY', action: change.solAmount < 0 ? 'BUY' : 'SELL', mint: change.mint,
          reason: `${config.label} ${change.solAmount < 0 ? 'comprou' : 'vendeu'} ${Math.abs(change.solAmount).toFixed(2)} SOL`,
          confidence: 65, amountSol: Math.abs(change.solAmount) * (config.copyPct / 100),
        };
        console.log(`🔔 ${signal.reason}`);
        await sendAlert(formatTradeAlert(signal));

        if (signal.action === 'BUY' && signal.amountSol! <= CONFIG.trading.maxBuySol) {
          const buyTx = await this.jupiter.buy(signal.mint, signal.amountSol!);
          if (buyTx) {
            await sendAlert(`✅ Copy trade!\n${config.label} → ${signal.amountSol} SOL\nTX: https://solscan.io/tx/${buyTx}`);
            storage.addTrade({
              id: buyTx, time: Date.now(), action: 'BUY', mint: signal.mint,
              symbol: signal.mint.slice(0, 8), amountSol: signal.amountSol!,
              price: 0, tx: buyTx, source: 'COPY',
            });
          }
        }
      }
    } catch {}
  }

  private detectTokenChanges(pre: any[], post: any[], walletAddr: string): Array<{ mint: string; solAmount: number }> {
    const changes: Array<{ mint: string; solAmount: number }> = [];
    const preMap = new Map<string, number>(), postMap = new Map<string, number>();
    for (const b of pre) { if (b.owner === walletAddr) preMap.set(b.mint, parseFloat(b.uiTokenAmount?.uiAmountString || '0')); }
    for (const b of post) { if (b.owner === walletAddr) postMap.set(b.mint, parseFloat(b.uiTokenAmount?.uiAmountString || '0')); }
    for (const [mint, postAmt] of postMap) { if (postAmt > (preMap.get(mint) || 0)) changes.push({ mint, solAmount: -0.5 }); }
    for (const [mint, preAmt] of preMap) { if (preAmt > (postMap.get(mint) || 0)) changes.push({ mint, solAmount: 0.5 }); }
    return changes;
  }

  addWallet(config: WalletConfig) {
    const existing = this.trackedWallets.find(w => w.address === config.address);
    if (existing) Object.assign(existing, config);
    else { this.trackedWallets.push(config); if (config.enabled) this.pollWalletTransactions(config); }
    storage.saveWallets(this.trackedWallets);
    console.log(`➕ Wallet saved: ${config.label}`);
  }

  removeWallet(address: string) {
    this.trackedWallets = this.trackedWallets.filter(w => w.address !== address);
    storage.saveWallets(this.trackedWallets);
  }

  listWallets(): WalletConfig[] { return this.trackedWallets; }
}
