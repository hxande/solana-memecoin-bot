import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from '../config';

// Validate RPC URL
if (!CONFIG.rpc || CONFIG.rpc.includes('YOUR_')) {
  console.error('❌ SOLANA_RPC_URL not configured in .env');
  console.error('   Get a free key at https://helius.dev');
  process.exit(1);
}

export const connection = new Connection(CONFIG.rpc, {
  commitment: 'confirmed',
  wsEndpoint: CONFIG.ws,
});

// Validate private key
let wallet: Keypair;
try {
  if (!CONFIG.privateKey || CONFIG.privateKey.includes('your_')) {
    console.error('❌ PRIVATE_KEY not configured in .env');
    console.error('   Export your wallet private key in base58 format');
    process.exit(1);
  }
  wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.privateKey));
} catch (err: any) {
  console.error(`❌ Invalid PRIVATE_KEY in .env: ${err.message}`);
  process.exit(1);
}

export { wallet };
console.log(`🔑 Wallet: ${wallet.publicKey.toBase58()}`);
