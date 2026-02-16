import { NextResponse } from 'next/server';
import { registry } from '@/src/bot/registry';
import { getConnection, getWallet } from '@/src/core/connection';
import { CONFIG } from '@/src/config';

export async function GET() {
  try {
    const conn = getConnection();
    const w = getWallet();
    const bal = await conn.getBalance(w.publicKey);
    return NextResponse.json({
      status: 'running',
      wallet: w.publicKey.toBase58(),
      balanceSol: bal / 1e9,
      uptime: registry.getUptime(),
      modules: registry.getModuleStatuses(),
      config: CONFIG.trading,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
