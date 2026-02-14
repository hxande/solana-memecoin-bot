export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  poolAddress: string;
  liquidity: number;
  marketCap: number;
  holders: number;
  topHolderPct: number;
  createdAt: number;
  isRenounced: boolean;
  isMintable: boolean;
  lpBurned: boolean;
  creator?: string;
  freezeAuthority?: string | null;
}

export interface TradeSignal {
  type: 'SNIPE' | 'COPY' | 'FILTER';
  action: 'BUY' | 'SELL';
  mint: string;
  reason: string;
  confidence: number;
  amountSol?: number;
  metadata?: Record<string, any>;
}

export interface Position {
  mint: string;
  symbol: string;
  entryPrice: number;
  amount: number;
  entryTime: number;
  source: TradeSignal['type'];
  currentPrice?: number;
  highestPrice?: number;
}

export interface WalletConfig {
  address: string;
  label: string;
  copyPct: number;
  minTradeSol: number;
  enabled: boolean;
}

export type BundleStatus = 'idle' | 'distributing' | 'buying' | 'active' | 'consolidating' | 'selling' | 'reclaiming' | 'error';

export interface BundleWallet {
  secretKeyB58: string;
  publicKey: string;
  solAllocated: number;
  distributed: boolean;
  bought: boolean;
  consolidated: boolean;
  reclaimed: boolean;
  distributeTx?: string;
  buyTx?: string;
  consolidateTx?: string;
  reclaimTx?: string;
  tokenBalance?: string; // bigint as string
}

export interface BundleState {
  mint: string;
  status: BundleStatus;
  totalSol: number;
  createdAt: number;
  updatedAt: number;
  wallets: BundleWallet[];
  sellTx?: string;
  error?: string;
}
