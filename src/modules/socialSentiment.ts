import axios from 'axios';
import { CONFIG } from '../config';
import { storage } from '../core/storage';
import { sendAlert } from '../core/alerts';
import { TradeSignal } from '../types';

interface SocialMention {
  source: string; text: string; author: string; authorFollowers: number;
  timestamp: number; engagement: number; url: string;
  tokenMints: string[]; tokenSymbols: string[];
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

interface TokenSocialData {
  mint: string; symbol: string; mentions: SocialMention[];
  totalMentions: number; uniqueInfluencers: number; avgSentiment: number;
  engagementScore: number; trendVelocity: number;
  firstMentionAt: number; lastMentionAt: number;
}

interface InfluencerConfig {
  handle: string; platform: string; followers: number;
  weight: number; trackBuyCalls: boolean;
}

const BULLISH_KW = ['bullish','moon','gem','early','100x','1000x','lfg','send it','loading','accumulate','buy','alpha','call','pump','aped','aping'];
const BEARISH_KW = ['sell','dump','rug','scam','short','bearish','dead','avoid','warning','honeypot','fake'];
const SOLANA_MINT_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const TICKER_REGEX = /\$([A-Z]{2,10})\b/g;

export class SocialSentimentModule {
  private tokenData = new Map<string, TokenSocialData>();
  private mentionBuffer: SocialMention[] = [];
  private processedTweetIds = new Set<string>();
  private activeNarratives = new Map<string, { keywords: string[]; score: number; startedAt: number }>();

  private influencers: InfluencerConfig[];

  constructor() {
    const saved = storage.loadInfluencers();
    if (saved.length > 0) {
      this.influencers = saved.map(s => ({ handle: s.handle, platform: s.platform, followers: s.followers, weight: s.weight, trackBuyCalls: s.trackBuyCalls }));
      console.log(`📱 Loaded ${saved.length} influencers from disk`);
    } else {
      this.influencers = [];
    }
    const savedN = storage.loadNarratives();
    for (const n of savedN) {
      if (Date.now() - n.startedAt < 6 * 3600000) this.activeNarratives.set(n.keyword, { keywords: n.keywords, score: n.score, startedAt: n.startedAt });
    }
  }

  async start() {
    console.log('📱 Social Sentiment Module started');
    this.startTwitterMonitoring();
    this.startNarrativeDetection();
    this.startTrendAnalysis();
  }

  private async startTwitterMonitoring() {
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    if (!bearerToken) {
      console.log('⚠️ Twitter token not set, using alternatives');
      this.startAlternativeMonitoring();
      return;
    }
    this.pollInfluencerTweets();
    this.pollTokenMentions();
  }

  private async pollInfluencerTweets() {
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    const poll = async () => {
      for (const inf of this.influencers) {
        if (inf.platform !== 'twitter') continue;
        try {
          const res = await axios.get(
            `https://api.twitter.com/2/tweets/search/recent?query=from:${inf.handle}&max_results=10&tweet.fields=created_at,public_metrics`,
            { headers: { Authorization: `Bearer ${bearerToken}` } }
          );
          for (const tweet of (res.data.data || [])) {
            if (this.processedTweetIds.has(tweet.id)) continue;
            this.processedTweetIds.add(tweet.id);
            await this.processTweet(tweet, inf);
          }
        } catch (err: any) {
          if (err.response?.status === 429) await new Promise(r => setTimeout(r, 60000));
        }
      }
      setTimeout(poll, 30000);
    };
    poll();
  }

  private async pollTokenMentions() {
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    const poll = async () => {
      const symbols = await this.getTrendingSymbols();
      for (const symbol of symbols.slice(0, 5)) {
        try {
          const res = await axios.get(
            `https://api.twitter.com/2/tweets/search/recent?query=$${symbol} (solana OR sol)&max_results=20&tweet.fields=created_at,public_metrics`,
            { headers: { Authorization: `Bearer ${bearerToken}` } }
          );
          const tweets = res.data.data || [];
          const totalEng = tweets.reduce((s: number, t: any) => {
            const m = t.public_metrics || {};
            return s + (m.like_count || 0) + (m.retweet_count || 0) * 2 + (m.reply_count || 0);
          }, 0);

          if (tweets.length >= 10 || totalEng >= 100) {
            await sendAlert(`📱 <b>SOCIAL SURGE: $${symbol}</b>\n🐦 ${tweets.length} menções | ❤️ ${totalEng}`);
          }
        } catch {}
        await new Promise(r => setTimeout(r, 2000));
      }
      setTimeout(poll, 60000);
    };
    poll();
  }

  private async startAlternativeMonitoring() {
    const poll = async () => {
      try { await this.fetchDexScreenerTrending(); } catch {}
      setTimeout(poll, 30000);
    };
    poll();
  }

  private async fetchDexScreenerTrending() {
    try {
      const res = await axios.get('https://api.dexscreener.com/token-boosts/top/v1');
      const boosts = (res.data || []).filter((b: any) => b.chainId === 'solana');
      for (const b of boosts.slice(0, 10)) {
        const mention: SocialMention = {
          source: 'dexscreener', text: `Boost: ${b.tokenAddress}`,
          author: 'dexscreener', authorFollowers: 0, timestamp: Date.now(),
          engagement: b.amount || 0, url: `https://dexscreener.com/solana/${b.tokenAddress}`,
          tokenMints: [b.tokenAddress], tokenSymbols: [], sentiment: 'bullish',
        };
        this.mentionBuffer.push(mention);
        this.updateTokenSocialData(b.tokenAddress, '', mention);
      }
    } catch {}
  }

  private async processTweet(tweet: any, influencer: InfluencerConfig) {
    const text = tweet.text || '';
    const metrics = tweet.public_metrics || {};
    const mints = text.match(SOLANA_MINT_REGEX) || [];
    const tickers = [...text.matchAll(TICKER_REGEX)].map((m: any) => m[1]);
    if (mints.length === 0 && tickers.length === 0) return;

    const sentiment = this.analyzeSentiment(text);
    const engagement = (metrics.like_count || 0) + (metrics.retweet_count || 0) * 2 + (metrics.reply_count || 0) * 1.5;

    if (influencer.weight >= 7 && sentiment === 'bullish') {
      await sendAlert([
        `🐦 <b>INFLUENCER CALL</b>`,
        `👤 @${influencer.handle} (${(influencer.followers / 1000).toFixed(0)}K)`,
        `Token: <code>${mints[0] || '$' + tickers[0]}</code>`,
        `❤️ Engagement: ${engagement.toFixed(0)}`,
      ].join('\n'));
    }
  }

  private analyzeSentiment(text: string): 'bullish' | 'bearish' | 'neutral' {
    const lower = text.toLowerCase();
    let bull = 0, bear = 0;
    for (const kw of BULLISH_KW) { if (lower.includes(kw)) bull++; }
    for (const kw of BEARISH_KW) { if (lower.includes(kw)) bear++; }
    bull += (text.match(/🚀|🔥|💎|🌙|💰|📈/g) || []).length;
    bear += (text.match(/💀|🔴|📉|⚠️/g) || []).length;
    if (bull > bear + 1) return 'bullish';
    if (bear > bull + 1) return 'bearish';
    return 'neutral';
  }

  private async startNarrativeDetection() {
    const detect = async () => {
      const recent = this.mentionBuffer.filter(m => Date.now() - m.timestamp < 3600000);
      if (recent.length < 5) { setTimeout(detect, 60000); return; }

      const wordFreq = new Map<string, number>();
      const narrativeKW = ['ai','agent','cat','dog','trump','elon','pepe','doge','gaming','meme','political','anime'];

      for (const m of recent) {
        for (const w of m.text.toLowerCase().split(/\s+/)) {
          if (narrativeKW.includes(w) || w.startsWith('$')) {
            wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
          }
        }
      }

      for (const [word, count] of [...wordFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        if (count >= 5 && !this.activeNarratives.has(word)) {
          this.activeNarratives.set(word, { keywords: [word], score: count, startedAt: Date.now() });
          await sendAlert(`📖 <b>NOVA NARRATIVA:</b> "${word}" (${count} menções/hora)`);
        }
      }

      for (const [key, val] of this.activeNarratives) {
        if (Date.now() - val.startedAt > 6 * 3600000) this.activeNarratives.delete(key);
      }
      storage.saveNarratives(this.activeNarratives);
      setTimeout(detect, 60000);
    };
    detect();
  }

  private async startTrendAnalysis() {
    const analyze = async () => {
      for (const [mint, data] of this.tokenData) {
        const now = Date.now();
        const last30m = data.mentions.filter(m => now - m.timestamp < 1800000);
        const prev30m = data.mentions.filter(m => { const age = now - m.timestamp; return age >= 1800000 && age < 3600000; });
        const velocity = prev30m.length > 0 ? last30m.length / prev30m.length : last30m.length;
        data.trendVelocity = velocity;

        if (velocity >= 3 && last30m.length >= 5) {
          const bullPct = (last30m.filter(m => m.sentiment === 'bullish').length / last30m.length) * 100;
          if (bullPct >= 70) {
            await sendAlert(`🔥 <b>TRENDING:</b> ${data.symbol}\n📱 ${last30m.length} menções (30m) | 🟢 ${bullPct.toFixed(0)}% bullish`);
          }
        }
      }
      setTimeout(analyze, 45000);
    };
    analyze();
  }

  private updateTokenSocialData(mint: string, symbol: string, mention: SocialMention) {
    let data = this.tokenData.get(mint);
    if (!data) {
      data = { mint, symbol: symbol || mint.substring(0, 8), mentions: [], totalMentions: 0,
        uniqueInfluencers: 0, avgSentiment: 0, engagementScore: 0, trendVelocity: 0,
        firstMentionAt: mention.timestamp, lastMentionAt: mention.timestamp };
      this.tokenData.set(mint, data);
    }
    data.mentions.push(mention);
    data.totalMentions++;
    data.uniqueInfluencers = new Set(data.mentions.map(m => m.author)).size;
    data.engagementScore = data.mentions.reduce((s, m) => s + m.engagement, 0);
    data.mentions = data.mentions.filter(m => Date.now() - m.timestamp < 6 * 3600000);
  }

  private async getTrendingSymbols(): Promise<string[]> {
    try {
      const res = await axios.get(
        'https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=10',
        { headers: { 'X-API-KEY': CONFIG.birdeyeKey, 'x-chain': 'solana' } }
      );
      return (res.data.data?.tokens || []).map((t: any) => t.symbol).filter(Boolean);
    } catch { return []; }
  }

  getTokenSentiment(mint: string) { return this.tokenData.get(mint) || null; }
  getActiveNarratives() { return this.activeNarratives; }

  addInfluencer(config: InfluencerConfig) {
    this.influencers.push(config);
    storage.addInfluencer({ handle: config.handle, platform: config.platform as 'twitter' | 'telegram', followers: config.followers, weight: config.weight, trackBuyCalls: config.trackBuyCalls, addedAt: Date.now() });
    console.log(`➕ Influencer saved: @${config.handle}`);
  }

  getStats() {
    return {
      trackedTokens: this.tokenData.size,
      totalMentions: this.mentionBuffer.length,
      activeNarratives: this.activeNarratives.size,
      influencersTracked: this.influencers.length,
    };
  }
}
