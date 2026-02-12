import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import axios from 'axios';
import { CONFIG } from '../config';

const WSOL = 'So11111111111111111111111111111111111111112';

export class JupiterSwap {
  constructor(
    private connection: Connection,
    private wallet: Keypair
  ) {}

  async buy(tokenMint: string, amountSol: number): Promise<string | null> {
    try {
      const amountLamports = Math.floor(amountSol * 1e9);

      const quoteRes = await axios.get(`${CONFIG.jupiterApi}/quote`, {
        params: {
          inputMint: WSOL,
          outputMint: tokenMint,
          amount: amountLamports,
          slippageBps: CONFIG.trading.slippageBps,
          onlyDirectRoutes: false,
        },
      });

      const quote = quoteRes.data;
      console.log(`📊 Quote: ${amountSol} SOL → ${quote.outAmount} tokens`);

      const swapRes = await axios.post(`${CONFIG.jupiterApi}/swap`, {
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: Math.floor(CONFIG.trading.priorityFee * 1e9),
      });

      const txBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.wallet]);

      const sig = await this.connection.sendTransaction(tx, {
        skipPreflight: true,
        maxRetries: 3,
      });

      console.log(`✅ BUY TX: https://solscan.io/tx/${sig}`);
      return sig;
    } catch (err: any) {
      console.error(`❌ Buy failed: ${err.message}`);
      return null;
    }
  }

  async sell(tokenMint: string, amountTokens: bigint): Promise<string | null> {
    try {
      const quoteRes = await axios.get(`${CONFIG.jupiterApi}/quote`, {
        params: {
          inputMint: tokenMint,
          outputMint: WSOL,
          amount: amountTokens.toString(),
          slippageBps: CONFIG.trading.slippageBps,
        },
      });

      const swapRes = await axios.post(`${CONFIG.jupiterApi}/swap`, {
        quoteResponse: quoteRes.data,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: Math.floor(CONFIG.trading.priorityFee * 1e9),
      });

      const txBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.wallet]);

      const sig = await this.connection.sendTransaction(tx, {
        skipPreflight: true,
        maxRetries: 3,
      });

      console.log(`✅ SELL TX: https://solscan.io/tx/${sig}`);
      return sig;
    } catch (err: any) {
      console.error(`❌ Sell failed: ${err.message}`);
      return null;
    }
  }

  async getPrice(tokenMint: string): Promise<number> {
    try {
      const res = await axios.get(
        `https://public-api.birdeye.so/defi/price?address=${tokenMint}`,
        { headers: { 'X-API-KEY': CONFIG.birdeyeKey } }
      );
      return res.data.data.value || 0;
    } catch {
      return 0;
    }
  }
}
