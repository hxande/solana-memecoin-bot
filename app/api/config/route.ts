import { NextRequest, NextResponse } from 'next/server';
import { CONFIG } from '@/src/config';
import { storage } from '@/src/core/storage';

export async function GET() {
  return NextResponse.json({ config: CONFIG.trading });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const fields = ['maxBuySol', 'slippageBps', 'profitTarget', 'stopLoss', 'maxPositions',
    'trailingStopPct', 'trailingActivationPct', 'maxHoldTimeMinutes', 'sniperMinScore', 'pumpfunMinScore'] as const;
  for (const f of fields) {
    if (body[f] !== undefined) (CONFIG.trading as any)[f] = body[f];
  }
  storage.saveConfig();
  return NextResponse.json({ success: true, config: CONFIG.trading });
}
