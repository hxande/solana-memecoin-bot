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
}

export interface WalletConfig {
  address: string;
  label: string;
  copyPct: number;
  minTradeSol: number;
  enabled: boolean;
}
