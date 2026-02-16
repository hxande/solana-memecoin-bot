import { NextRequest, NextResponse } from 'next/server';
import { registry } from '@/src/bot/registry';

export async function GET() {
  return NextResponse.json({ wallets: registry.walletTracker.listWallets() });
}

export async function POST(req: NextRequest) {
  const { address, label, copyPct, minTradeSol } = await req.json();
  if (!address || !label) return NextResponse.json({ error: 'address and label required' }, { status: 400 });
  registry.walletTracker.addWallet({ address, label, copyPct: copyPct || 50, minTradeSol: minTradeSol || 0.5, enabled: true });
  return NextResponse.json({ success: true });
}
