import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { CONFIG } from '../config';

// ════════════════════════════════════════════
// Pump.fun Program Constants
// ════════════════════════════════════════════
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FEE = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ5Nmhcdo1so');
const PUMP_EVENT_AUTH = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
const SYSTEM_PROGRAM = SystemProgram.programId;
const RENT_PROGRAM = new PublicKey('SysvarRent111111111111111111111111111111111');

// Pump.fun instruction discriminators
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// Bonding curve constants
const TOTAL_TOKEN_SUPPLY = 1_000_000_000_000_000; // 1B tokens with 6 decimals
const INITIAL_VIRTUAL_TOKEN = 1_073_000_000_000_000;
const INITIAL_VIRTUAL_SOL = 30_000_000_000; // 30 SOL in lamports

export class PumpSwap {
  constructor(
    private connection: Connection,
    private wallet: Keypair
  ) {}

  // ════════════════════════════════════════════
  // BUY on bonding curve
  // ════════════════════════════════════════════
  async buy(mint: string, amountSol: number, slippagePct: number = 25): Promise<string | null> {
    try {
      const mintPk = new PublicKey(mint);
      const amountLamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

      // Derive bonding curve PDA
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mintPk.toBuffer()],
        PUMP_PROGRAM
      );

      // Bonding curve's associated token account
      const bondingCurveAta = await getAssociatedTokenAddress(
        mintPk, bondingCurve, true
      );

      // Our associated token account
      const buyerAta = await getAssociatedTokenAddress(
        mintPk, this.wallet.publicKey
      );

      // Get current bonding curve state to calculate expected tokens
      const curveState = await this.getBondingCurveState(bondingCurve);
      if (!curveState) {
        console.error('  ❌ PumpSwap: Could not read bonding curve state');
        return null;
      }

      if (curveState.complete) {
        console.log('  ⚠️  PumpSwap: Token already migrated — use Jupiter instead');
        return null;
      }

      // Calculate expected tokens out
      const expectedTokens = this.calculateBuyTokens(
        curveState.virtualSolReserves,
        curveState.virtualTokenReserves,
        amountLamports
      );

      if (expectedTokens <= 0n) {
        console.error('  ❌ PumpSwap: Zero tokens expected — amount too small');
        return null;
      }

      // Apply slippage: we accept minimum tokens = expected * (1 - slippage%)
      const minTokens = expectedTokens * BigInt(100 - slippagePct) / 100n;

      // Max SOL cost with 1% buffer for fees
      const maxSolCost = amountLamports + (amountLamports * 2n / 100n);

      console.log(`  📊 PumpSwap: ${amountSol} SOL → ~${Number(expectedTokens) / 1e6} tokens (min: ${Number(minTokens) / 1e6})`);

      // Build transaction
      const tx = new Transaction();

      // Priority fee
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.floor(CONFIG.trading.priorityFee * 1e9 / 200_000 * 1e6),
      }));

      // Create ATA if needed
      const ataInfo = await this.connection.getAccountInfo(buyerAta);
      if (!ataInfo) {
        tx.add(createAssociatedTokenAccountInstruction(
          this.wallet.publicKey, buyerAta, this.wallet.publicKey, mintPk
        ));
      }

      // Pump.fun buy instruction
      const buyData = Buffer.alloc(8 + 8 + 8);
      BUY_DISCRIMINATOR.copy(buyData, 0);
      buyData.writeBigUInt64LE(expectedTokens, 8); // token amount
      buyData.writeBigUInt64LE(maxSolCost, 16);     // max SOL cost

      const buyIx = new TransactionInstruction({
        programId: PUMP_PROGRAM,
        keys: [
          { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
          { pubkey: PUMP_FEE, isSigner: false, isWritable: true },
          { pubkey: mintPk, isSigner: false, isWritable: false },
          { pubkey: bondingCurve, isSigner: false, isWritable: true },
          { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
          { pubkey: buyerAta, isSigner: false, isWritable: true },
          { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: PUMP_EVENT_AUTH, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: buyData,
      });

      tx.add(buyIx);

      // Send
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.wallet.publicKey;
      tx.sign(this.wallet);

      const sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });

      console.log(`  ✅ PumpSwap BUY: https://solscan.io/tx/${sig}`);

      // Confirm with timeout
      try {
        await this.connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          'confirmed'
        );
        console.log(`  ✅ Confirmed`);
      } catch {
        console.log(`  ⚠️  Confirmation timeout — tx may still land`);
      }

      return sig;
    } catch (err: any) {
      console.error(`  ❌ PumpSwap buy error: ${err.message}`);
      if (err.logs) {
        console.error(`  📋 Logs: ${err.logs.slice(-3).join(' | ')}`);
      }
      return null;
    }
  }

  // ════════════════════════════════════════════
  // SELL on bonding curve
  // ════════════════════════════════════════════
  async sell(mint: string, tokenAmount: bigint, slippagePct: number = 25): Promise<string | null> {
    try {
      const mintPk = new PublicKey(mint);

      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mintPk.toBuffer()],
        PUMP_PROGRAM
      );

      const bondingCurveAta = await getAssociatedTokenAddress(mintPk, bondingCurve, true);
      const sellerAta = await getAssociatedTokenAddress(mintPk, this.wallet.publicKey);

      const curveState = await this.getBondingCurveState(bondingCurve);
      if (!curveState) {
        console.error('  ❌ PumpSwap: Could not read bonding curve state');
        return null;
      }

      if (curveState.complete) {
        console.log('  ⚠️  PumpSwap: Token migrated — use Jupiter');
        return null;
      }

      // Calculate expected SOL out
      const expectedSol = this.calculateSellSol(
        curveState.virtualSolReserves,
        curveState.virtualTokenReserves,
        tokenAmount
      );

      const minSol = expectedSol * BigInt(100 - slippagePct) / 100n;

      console.log(`  📊 PumpSwap: ${Number(tokenAmount) / 1e6} tokens → ~${Number(expectedSol) / LAMPORTS_PER_SOL} SOL`);

      const tx = new Transaction();

      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.floor(CONFIG.trading.priorityFee * 1e9 / 200_000 * 1e6),
      }));

      const sellData = Buffer.alloc(8 + 8 + 8);
      SELL_DISCRIMINATOR.copy(sellData, 0);
      sellData.writeBigUInt64LE(tokenAmount, 8);
      sellData.writeBigUInt64LE(minSol, 16);

      const sellIx = new TransactionInstruction({
        programId: PUMP_PROGRAM,
        keys: [
          { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
          { pubkey: PUMP_FEE, isSigner: false, isWritable: true },
          { pubkey: mintPk, isSigner: false, isWritable: false },
          { pubkey: bondingCurve, isSigner: false, isWritable: true },
          { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
          { pubkey: sellerAta, isSigner: false, isWritable: true },
          { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: PUMP_EVENT_AUTH, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: sellData,
      });

      tx.add(sellIx);

      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.wallet.publicKey;
      tx.sign(this.wallet);

      const sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });

      console.log(`  ✅ PumpSwap SELL: https://solscan.io/tx/${sig}`);

      try {
        await this.connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          'confirmed'
        );
      } catch {
        console.log(`  ⚠️  Confirmation timeout`);
      }

      return sig;
    } catch (err: any) {
      console.error(`  ❌ PumpSwap sell error: ${err.message}`);
      return null;
    }
  }

  // ════════════════════════════════════════════
  // Check if token is still on bonding curve
  // ════════════════════════════════════════════
  async isOnBondingCurve(mint: string): Promise<boolean> {
    try {
      const mintPk = new PublicKey(mint);
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mintPk.toBuffer()],
        PUMP_PROGRAM
      );
      const state = await this.getBondingCurveState(bondingCurve);
      return state !== null && !state.complete;
    } catch {
      return false;
    }
  }

  // ════════════════════════════════════════════
  // Read bonding curve account state
  // ════════════════════════════════════════════
  private async getBondingCurveState(bondingCurve: PublicKey): Promise<{
    virtualTokenReserves: bigint;
    virtualSolReserves: bigint;
    realTokenReserves: bigint;
    realSolReserves: bigint;
    tokenTotalSupply: bigint;
    complete: boolean;
  } | null> {
    try {
      const info = await this.connection.getAccountInfo(bondingCurve);
      if (!info || !info.data || info.data.length < 49) return null;

      const d = info.data;
      // Skip 8 bytes discriminator
      return {
        virtualTokenReserves: d.readBigUInt64LE(8),
        virtualSolReserves: d.readBigUInt64LE(16),
        realTokenReserves: d.readBigUInt64LE(24),
        realSolReserves: d.readBigUInt64LE(32),
        tokenTotalSupply: d.readBigUInt64LE(40),
        complete: d[48] === 1,
      };
    } catch (err: any) {
      console.error(`  ❌ Read bonding curve error: ${err.message}`);
      return null;
    }
  }

  // ════════════════════════════════════════════
  // AMM math: constant product x * y = k
  // ════════════════════════════════════════════
  private calculateBuyTokens(
    virtualSolReserves: bigint,
    virtualTokenReserves: bigint,
    solIn: bigint
  ): bigint {
    // Pump.fun takes 1% fee on buys
    const fee = solIn / 100n;
    const solAfterFee = solIn - fee;

    // Constant product: (sol + solIn) * (token - tokenOut) = sol * token
    // tokenOut = token - (sol * token) / (sol + solIn)
    // tokenOut = token * solIn / (sol + solIn)
    const num = virtualTokenReserves * solAfterFee;
    const den = virtualSolReserves + solAfterFee;
    return num / den;
  }

  private calculateSellSol(
    virtualSolReserves: bigint,
    virtualTokenReserves: bigint,
    tokenIn: bigint
  ): bigint {
    // solOut = sol * tokenIn / (token + tokenIn)
    const num = virtualSolReserves * tokenIn;
    const den = virtualTokenReserves + tokenIn;
    const solOut = num / den;

    // 1% fee
    const fee = solOut / 100n;
    return solOut - fee;
  }
}