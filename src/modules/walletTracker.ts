import { PublicKey } from '@solana/web3.js';
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { sendAlert, formatTradeAlert } from '../core/alerts';
import { CONFIG } from '../config';
import { WalletConfig, TradeSignal } from '../types';

export class WalletTracker {
  private jupiter: JupiterSwap;
  private trackedWallets: WalletConfig[] = [
    // Adicione wallets reais aqui (endereços base58 válidos)
    // Exemplo: { address: 'DYw8jCTfxttAj...', label: 'Smart Money #1', copyPct: 50, minTradeSol: 0.5, enabled: true },
  ];

  constructor() {
    this.jupiter = new JupiterSwap(connection, wallet);
  }

  async start() {
    console.log('👀 Wallet Tracker started');
    const enabledWallets = this.trackedWallets.filter(w => w.enabled && this.isValidAddress(w.address));
    console.log(`📋 Monitorando ${enabledWallets.length} wallets`);
    if (enabledWallets.length === 0) {
      console.log('⚠️  Nenhuma wallet configurada para rastrear. Adicione endereços em walletTracker.ts');
    }
    for (const w of enabledWallets) {
      this.pollWalletTransactions(w);
    }
  }

  private isValidAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  private async pollWalletTransactions(config: WalletConfig) {
    let lastSig: string | undefined;
    const poll = async () => {
      try {
        const sigs = await connection.getSignaturesForAddress(
          new PublicKey(config.address),
          { limit: 5, until: lastSig }
        );
        if (sigs.length > 0) {
          lastSig = sigs[0].signature;
          for (const sig of sigs.reverse()) {
            await this.analyzeTransaction(sig.signature, config);
          }
        }
      } catch (err: any) {
        console.error(`Poll error (${config.label}): ${err.message}`);
      }
      setTimeout(poll, 2000);
    };
    poll();
  }

  private async analyzeTransaction(signature: string, config: WalletConfig) {
    try {
      const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) return;

      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];
      const changes = this.detectTokenChanges(preBalances, postBalances, config.address);

      for (const change of changes) {
        if (Math.abs(change.solAmount) < config.minTradeSol) continue;

        const signal: TradeSignal = {
          type: 'COPY',
          action: change.solAmount < 0 ? 'BUY' : 'SELL',
          mint: change.mint,
          reason: `${config.label} ${change.solAmount < 0 ? 'comprou' : 'vendeu'} ${Math.abs(change.solAmount).toFixed(2)} SOL`,
          confidence: 65,
          amountSol: Math.abs(change.solAmount) * (config.copyPct / 100),
        };

        console.log(`🔔 ${signal.reason}`);
        await sendAlert(formatTradeAlert(signal));

        if (signal.action === 'BUY' && signal.amountSol! <= CONFIG.trading.maxBuySol) {
          const buyTx = await this.jupiter.buy(signal.mint, signal.amountSol!);
          if (buyTx) {
            await sendAlert(`✅ Copy trade!\n${config.label} → ${signal.amountSol} SOL\nTX: https://solscan.io/tx/${buyTx}`);
          }
        }
      }
    } catch {}
  }

  private detectTokenChanges(pre: any[], post: any[], walletAddr: string): Array<{ mint: string; solAmount: number }> {
    const changes: Array<{ mint: string; solAmount: number }> = [];
    const preMap = new Map<string, number>();
    const postMap = new Map<string, number>();

    for (const b of pre) {
      if (b.owner === walletAddr) preMap.set(b.mint, parseFloat(b.uiTokenAmount?.uiAmountString || '0'));
    }
    for (const b of post) {
      if (b.owner === walletAddr) postMap.set(b.mint, parseFloat(b.uiTokenAmount?.uiAmountString || '0'));
    }

    for (const [mint, postAmt] of postMap) {
      const preAmt = preMap.get(mint) || 0;
      if (postAmt > preAmt) changes.push({ mint, solAmount: -0.5 });
    }
    for (const [mint, preAmt] of preMap) {
      const postAmt = postMap.get(mint) || 0;
      if (preAmt > postAmt) changes.push({ mint, solAmount: 0.5 });
    }
    return changes;
  }

  addWallet(config: WalletConfig) {
    this.trackedWallets.push(config);
    if (config.enabled) this.pollWalletTransactions(config);
    console.log(`➕ Wallet adicionada: ${config.label}`);
  }

  listWallets(): WalletConfig[] {
    return this.trackedWallets;
  }
}
