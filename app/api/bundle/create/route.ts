import { NextRequest, NextResponse } from 'next/server';
import { registry } from '@/src/bot/registry';

export async function POST(req: NextRequest) {
  try {
    const { mint, walletCount, totalSol } = await req.json();
    if (!mint || !walletCount || !totalSol) {
      return NextResponse.json({ error: 'mint, walletCount, totalSol required' }, { status: 400 });
    }
    const state = await registry.bundleManager.createBundle(mint, walletCount, totalSol);
    return NextResponse.json({ success: true, wallets: state.wallets.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
