import { NextResponse } from 'next/server';
import { registry } from '@/src/bot/registry';

export async function POST() {
  registry.bundleManager.executeSellFlow().catch((e: any) => console.error(`Bundle sell error: ${e.message}`));
  return NextResponse.json({ success: true, message: 'Sell flow started' });
}
