import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from '../config';

let _connection: Connection | null = null;
let _wallet: Keypair | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    if (!CONFIG.rpc || CONFIG.rpc.includes('YOUR_')) {
      throw new Error('SOLANA_RPC_URL not configured in .env');
    }
    _connection = new Connection(CONFIG.rpc, {
      commitment: 'confirmed',
      wsEndpoint: CONFIG.ws,
    });
  }
  return _connection;
}

export function getWallet(): Keypair {
  if (!_wallet) {
    if (!CONFIG.privateKey || CONFIG.privateKey.includes('your_')) {
      throw new Error('PRIVATE_KEY not configured in .env');
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.privateKey));
    console.log(`🔑 Wallet: ${_wallet.publicKey.toBase58()}`);
  }
  return _wallet;
}

// Backward-compat: lazy getters that look like plain exports
export const connection: Connection = new Proxy({} as Connection, {
  get(_target, prop) {
    return (getConnection() as any)[prop];
  },
});

export const wallet: Keypair = new Proxy({} as Keypair, {
  get(_target, prop) {
    return (getWallet() as any)[prop];
  },
});
