import {
  Keypair, SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  createTransferInstruction, getAccount, TokenAccountNotFoundError,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { connection, wallet } from '../core/connection';
import { JupiterSwap } from '../core/jupiter';
import { storage } from '../core/storage';
import { BundleState, BundleWallet } from '../types';

const SOL_FEE_BUFFER = 0.003;
const MAX_WALLETS = 30;
const TRANSFERS_PER_TX = 7;

export class BundleManager {
  private state: BundleState | null = null;
  private keypairs: Map<string, Keypair> = new Map();
  private jupiter = new JupiterSwap(connection, wallet);
  private broadcastFn?: (type: string, data: any) => void;

  constructor() {
    const saved = storage.loadBundle();
    if (saved && saved.status !== 'idle') {
      this.state = saved;
      this.rehydrateKeypairs();
      console.log(`📦 Bundle restored: ${saved.mint} (${saved.status}, ${saved.wallets.length} wallets)`);
    }
  }

  setBroadcast(fn: (type: string, data: any) => void) { this.broadcastFn = fn; }

  private broadcast() {
    if (this.broadcastFn) this.broadcastFn('bundle', this.getStatus());
  }

  private rehydrateKeypairs() {
    if (!this.state) return;
    this.keypairs.clear();
    for (const w of this.state.wallets) {
      try {
        const kp = Keypair.fromSecretKey(bs58.decode(w.secretKeyB58));
        this.keypairs.set(w.publicKey, kp);
      } catch (err: any) {
        console.error(`📦 Failed to rehydrate keypair for ${w.publicKey}: ${err.message}`);
      }
    }
  }

  private persist() {
    if (this.state) this.state.updatedAt = Date.now();
    storage.saveBundle(this.state);
  }

  private setStatus(status: BundleState['status']) {
    if (!this.state) return;
    this.state.status = status;
    this.persist();
    this.broadcast();
  }

  private setError(msg: string) {
    if (!this.state) return;
    this.state.status = 'error';
    this.state.error = msg;
    this.persist();
    this.broadcast();
  }

  // --- Public API ---

  async createBundle(mint: string, walletCount: number, totalSol: number): Promise<BundleState> {
    if (this.state && this.state.status !== 'idle' && this.state.status !== 'error') {
      throw new Error(`Bundle already active (${this.state.status}). Cancel it first.`);
    }
    if (walletCount < 1 || walletCount > MAX_WALLETS) {
      throw new Error(`Wallet count must be 1-${MAX_WALLETS}`);
    }
    const totalNeeded = totalSol + walletCount * SOL_FEE_BUFFER;
    const balance = await connection.getBalance(wallet.publicKey);
    if (balance / LAMPORTS_PER_SOL < totalNeeded + 0.01) {
      throw new Error(`Insufficient balance. Need ~${totalNeeded.toFixed(4)} SOL (${totalSol} + fees), have ${(balance / LAMPORTS_PER_SOL).toFixed(4)}`);
    }

    // Random SOL distribution via broken-stick method
    const allocations = this.randomAllocations(walletCount, totalSol);

    const wallets: BundleWallet[] = [];
    this.keypairs.clear();
    for (let i = 0; i < walletCount; i++) {
      const kp = Keypair.generate();
      this.keypairs.set(kp.publicKey.toBase58(), kp);
      wallets.push({
        secretKeyB58: bs58.encode(kp.secretKey),
        publicKey: kp.publicKey.toBase58(),
        solAllocated: allocations[i],
        distributed: false,
        bought: false,
        consolidated: false,
        reclaimed: false,
      });
    }

    this.state = {
      mint,
      status: 'idle',
      totalSol,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      wallets,
    };
    this.persist();
    this.broadcast();
    console.log(`📦 Bundle created: ${walletCount} wallets, ${totalSol} SOL for ${mint}`);
    return this.state;
  }

  async distribute(): Promise<void> {
    if (!this.state) throw new Error('No bundle');
    this.setStatus('distributing');

    const pending = this.state.wallets.filter(w => !w.distributed);
    if (pending.length === 0) {
      console.log('📦 All wallets already funded');
      this.setStatus('idle');
      return;
    }

    // Batch transfers, TRANSFERS_PER_TX per transaction
    for (let i = 0; i < pending.length; i += TRANSFERS_PER_TX) {
      const batch = pending.slice(i, i + TRANSFERS_PER_TX);
      const tx = new Transaction();

      for (const w of batch) {
        const lamports = Math.floor((w.solAllocated + SOL_FEE_BUFFER) * LAMPORTS_PER_SOL);
        tx.add(SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey(w.publicKey),
          lamports,
        }));
      }

      try {
        const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
        for (const w of batch) {
          w.distributed = true;
          w.distributeTx = sig;
        }
        console.log(`📦 Distributed batch ${Math.floor(i / TRANSFERS_PER_TX) + 1}: ${sig}`);
      } catch (err: any) {
        console.error(`📦 Distribution batch failed: ${err.message}`);
        this.setError(`Distribution failed at batch ${Math.floor(i / TRANSFERS_PER_TX) + 1}: ${err.message}`);
        return;
      }
      this.persist();
      this.broadcast();
    }

    console.log('📦 Distribution complete');
    this.setStatus('idle');
  }

  async executeBuys(): Promise<void> {
    if (!this.state) throw new Error('No bundle');
    const undistributed = this.state.wallets.filter(w => !w.distributed);
    if (undistributed.length > 0) throw new Error(`${undistributed.length} wallets not yet funded. Distribute first.`);

    this.setStatus('buying');
    const pending = this.state.wallets.filter(w => !w.bought);
    if (pending.length === 0) {
      console.log('📦 All wallets already bought');
      this.setStatus('active');
      return;
    }

    let successes = 0;
    for (const w of pending) {
      const kp = this.keypairs.get(w.publicKey);
      if (!kp) { console.error(`📦 Missing keypair for ${w.publicKey}`); continue; }

      const subJupiter = new JupiterSwap(connection, kp);
      try {
        const sig = await subJupiter.buy(this.state.mint, w.solAllocated);
        if (sig) {
          w.bought = true;
          w.buyTx = sig;
          successes++;
          console.log(`📦 Wallet ${w.publicKey.slice(0, 8)} bought: ${sig}`);
        } else {
          console.error(`📦 Wallet ${w.publicKey.slice(0, 8)} buy returned null`);
        }
      } catch (err: any) {
        console.error(`📦 Wallet ${w.publicKey.slice(0, 8)} buy failed: ${err.message}`);
      }
      this.persist();
      this.broadcast();
      // Delay between buys to avoid RPC rate limits
      await new Promise(r => setTimeout(r, 500));
    }

    if (successes === 0) {
      this.setError('All buys failed');
    } else {
      console.log(`📦 Buys complete: ${successes}/${pending.length}`);
      this.setStatus('active');
    }
  }

  async consolidate(): Promise<void> {
    if (!this.state) throw new Error('No bundle');
    this.setStatus('consolidating');

    const mintPk = new PublicKey(this.state.mint);
    const mainAta = await getAssociatedTokenAddress(mintPk, wallet.publicKey);

    // Create main ATA if it doesn't exist
    try {
      await getAccount(connection, mainAta);
    } catch (err: any) {
      if (err instanceof TokenAccountNotFoundError) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(wallet.publicKey, mainAta, wallet.publicKey, mintPk)
        );
        await sendAndConfirmTransaction(connection, tx, [wallet]);
        console.log('📦 Created main wallet ATA');
      } else {
        this.setError(`Failed to check main ATA: ${err.message}`);
        return;
      }
    }

    const pending = this.state.wallets.filter(w => w.bought && !w.consolidated);
    for (const w of pending) {
      const kp = this.keypairs.get(w.publicKey);
      if (!kp) continue;

      try {
        const subAta = await getAssociatedTokenAddress(mintPk, kp.publicKey);
        const account = await getAccount(connection, subAta);
        const balance = account.amount; // bigint

        if (balance === 0n) {
          w.consolidated = true;
          w.tokenBalance = '0';
          this.persist();
          continue;
        }

        w.tokenBalance = balance.toString();
        const tx = new Transaction().add(
          createTransferInstruction(subAta, mainAta, kp.publicKey, balance)
        );
        const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
        w.consolidated = true;
        w.consolidateTx = sig;
        console.log(`📦 Consolidated ${w.publicKey.slice(0, 8)}: ${balance} tokens → main`);
      } catch (err: any) {
        console.error(`📦 Consolidate ${w.publicKey.slice(0, 8)} failed: ${err.message}`);
      }
      this.persist();
      this.broadcast();
      await new Promise(r => setTimeout(r, 300));
    }

    console.log('📦 Consolidation complete');
    this.setStatus('active');
  }

  async sell(): Promise<void> {
    if (!this.state) throw new Error('No bundle');
    this.setStatus('selling');

    const mintPk = new PublicKey(this.state.mint);
    const mainAta = await getAssociatedTokenAddress(mintPk, wallet.publicKey);

    try {
      const account = await getAccount(connection, mainAta);
      const balance = account.amount;

      if (balance === 0n) {
        console.log('📦 No tokens to sell');
        this.setStatus('active');
        return;
      }

      console.log(`📦 Selling ${balance} tokens of ${this.state.mint}`);
      const sig = await this.jupiter.sell(this.state.mint, balance);
      if (sig) {
        this.state.sellTx = sig;
        console.log(`📦 Sell complete: ${sig}`);
      } else {
        this.setError('Sell returned null');
        return;
      }
    } catch (err: any) {
      this.setError(`Sell failed: ${err.message}`);
      return;
    }
    this.persist();
    this.broadcast();
  }

  async reclaimSol(): Promise<void> {
    if (!this.state) throw new Error('No bundle');
    this.setStatus('reclaiming');

    const pending = this.state.wallets.filter(w => !w.reclaimed);
    for (const w of pending) {
      const kp = this.keypairs.get(w.publicKey);
      if (!kp) continue;

      try {
        const balance = await connection.getBalance(kp.publicKey);
        const sendAmount = balance - 5000; // keep 5000 lamports for rent
        if (sendAmount <= 0) {
          w.reclaimed = true;
          this.persist();
          continue;
        }

        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: wallet.publicKey,
            lamports: sendAmount,
          })
        );
        const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
        w.reclaimed = true;
        w.reclaimTx = sig;
        console.log(`📦 Reclaimed ${(sendAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL from ${w.publicKey.slice(0, 8)}`);
      } catch (err: any) {
        console.error(`📦 Reclaim ${w.publicKey.slice(0, 8)} failed: ${err.message}`);
      }
      this.persist();
      this.broadcast();
      await new Promise(r => setTimeout(r, 200));
    }

    console.log('📦 Reclaim complete — clearing bundle');
    this.state = null;
    this.keypairs.clear();
    storage.saveBundle(null);
    this.broadcast();
  }

  async executeSellFlow(): Promise<void> {
    await this.consolidate();
    if ((this.state?.status as string) === 'error') return;
    await this.sell();
    if ((this.state?.status as string) === 'error') return;
    await this.reclaimSol();
  }

  async cancelBundle(): Promise<void> {
    if (!this.state) throw new Error('No bundle');
    console.log('📦 Cancelling bundle...');

    // Try to salvage: consolidate tokens, sell, reclaim SOL
    const hasBought = this.state.wallets.some(w => w.bought && !w.consolidated);
    if (hasBought) {
      try { await this.consolidate(); } catch (e: any) { console.error(`📦 Cancel-consolidate: ${e.message}`); }
    }

    const mintPk = new PublicKey(this.state.mint);
    const mainAta = await getAssociatedTokenAddress(mintPk, wallet.publicKey);
    try {
      const account = await getAccount(connection, mainAta);
      if (account.amount > 0n) {
        try { await this.sell(); } catch (e: any) { console.error(`📦 Cancel-sell: ${e.message}`); }
      }
    } catch {}

    try { await this.reclaimSol(); } catch (e: any) {
      console.error(`📦 Cancel-reclaim: ${e.message}`);
      // Force clear even if reclaim fails
      this.state = null;
      this.keypairs.clear();
      storage.saveBundle(null);
      this.broadcast();
    }
  }

  getStatus(): Omit<BundleState, 'wallets'> & { wallets: Omit<BundleWallet, 'secretKeyB58'>[] } | null {
    if (!this.state) return null;
    return {
      ...this.state,
      wallets: this.state.wallets.map(({ secretKeyB58, ...rest }) => rest),
    };
  }

  // --- Helpers ---

  private randomAllocations(count: number, total: number): number[] {
    const minPerWallet = 0.001;
    const distributable = total - minPerWallet * count;
    if (distributable <= 0) {
      return new Array(count).fill(total / count);
    }

    // Broken-stick method: generate random breakpoints
    const breaks = Array.from({ length: count - 1 }, () => Math.random()).sort((a, b) => a - b);
    const fractions = [breaks[0] || 1];
    for (let i = 1; i < breaks.length; i++) fractions.push(breaks[i] - breaks[i - 1]);
    fractions.push(1 - (breaks[breaks.length - 1] || 0));

    return fractions.map(f => Math.round((minPerWallet + f * distributable) * 10000) / 10000);
  }
}
