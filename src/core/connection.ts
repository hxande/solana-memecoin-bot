import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from '../config';

export const connection = new Connection(CONFIG.rpc, {
  commitment: 'confirmed',
  wsEndpoint: CONFIG.ws,
});

export const wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.privateKey));

console.log(`🔑 Wallet: ${wallet.publicKey.toBase58()}`);
