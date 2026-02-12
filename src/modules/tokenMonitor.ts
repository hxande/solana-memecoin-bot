import axios from 'axios';
import { CONFIG } from '../config';
import { TokenInfo } from '../types';
import { sendAlert } from '../core/alerts';

export class TokenMonitor {
  private minScore = 60;
  private analyzed = new Set<string>();

  async start() {
    console.log('📊 Token Monitor started');
    this.monitorTrending();
  }

  private async monitorTrending() {
    const check = async () => {
      try {
        const tokens = await this.getTrendingTokens();
        for (const token of tokens) {
          if (this.analyzed.has(token.mint)) continue;
          this.analyzed.add(token.mint);
          const score = await this.scoreToken(token);
          if (score.total >= this.minScore) {
            await sendAlert([
              `📊 <b>Token Score: ${score.total}/100</b>`,
              `Token: <b>${token.symbol}</b> (<code>${token.mint}</code>)`,
              `🔒 Segurança: ${score.safety}/30 | 💧 Liquidez: ${score.liquidity}/25`,
              `👥 Comunidade: ${score.community}/25 | 📈 Momentum: ${score.momentum}/20`,
              `<a href="https://birdeye.so/token/${token.mint}?chain=solana">Birdeye</a> | <a href="https://dexscreener.com/solana/${token.mint}">DexScreener</a>`,
            ].join('\n'));
          }
        }
      } catch (err: any) { console.error(`Monitor error: ${err.message}`); }
      setTimeout(check, 30000);
    };
    check();
  }

  async scoreToken(token: TokenInfo) {
    let safety = 0, liquidity = 0, community = 0, momentum = 0;

    if (token.isRenounced) safety += 10;
    if (!token.isMintable) safety += 5;
    if (token.lpBurned) safety += 10;
    if (token.topHolderPct < 10) safety += 5;
    else if (token.topHolderPct < 20) safety += 3;

    if (token.liquidity >= 100) liquidity += 10;
    else if (token.liquidity >= 30) liquidity += 5;
    if (token.marketCap > 0 && token.liquidity > 0) {
      const ratio = token.liquidity / token.marketCap;
      if (ratio > 0.1) liquidity += 10; else if (ratio > 0.05) liquidity += 5;
    }
    if (token.marketCap < 1_000_000) liquidity += 5;

    if (token.holders >= 500) community += 15;
    else if (token.holders >= 100) community += 10;
    else if (token.holders >= 30) community += 5;
    community += 10;

    const priceData = await this.getRecentPriceAction(token.mint);
    if (priceData) {
      if (priceData.priceChange1h > 0 && priceData.priceChange1h < 100) momentum += 10;
      if (priceData.volumeChange > 50) momentum += 10;
    }

    return { total: safety + liquidity + community + momentum, safety, liquidity, community, momentum };
  }

  private async getTrendingTokens(): Promise<TokenInfo[]> {
    try {
      const res = await axios.get(
        'https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20',
        { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } }
      );
      return (res.data.data?.tokens || []).map((t: any) => ({
        mint: t.address, symbol: t.symbol || 'UNKNOWN', name: t.name || '',
        decimals: t.decimals || 9, poolAddress: '', liquidity: t.liquidity || 0,
        marketCap: t.mc || 0, holders: t.holder || 0, topHolderPct: 0,
        createdAt: 0, isRenounced: false, isMintable: false, lpBurned: false,
      }));
    } catch { return []; }
  }

  private async getRecentPriceAction(mint: string): Promise<{ priceChange1h: number; volumeChange: number } | null> {
    try {
      const res = await axios.get(
        `https://public-api.birdeye.so/defi/token_overview?address=${mint}`,
        { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } }
      );
      const d = res.data.data;
      return { priceChange1h: d?.priceChange1hPercent || 0, volumeChange: d?.v24hChangePercent || 0 };
    } catch { return null; }
  }
}
