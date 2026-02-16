import { NextRequest, NextResponse } from 'next/server';
import { storage } from '@/src/core/storage';
import { registry } from '@/src/bot/registry';

export async function GET() {
  return NextResponse.json({ influencers: storage.loadInfluencers() });
}

export async function POST(req: NextRequest) {
  const { handle, platform, followers, weight, trackBuyCalls } = await req.json();
  if (!handle) return NextResponse.json({ error: 'handle required' }, { status: 400 });
  const inf = { handle, platform: platform || 'twitter', followers: followers || 0, weight: weight || 5, trackBuyCalls: trackBuyCalls !== false, addedAt: Date.now() };
  storage.addInfluencer(inf);
  registry.socialSentiment.addInfluencer({ handle: inf.handle, platform: inf.platform, followers: inf.followers, weight: inf.weight, trackBuyCalls: inf.trackBuyCalls });
  return NextResponse.json({ success: true });
}
