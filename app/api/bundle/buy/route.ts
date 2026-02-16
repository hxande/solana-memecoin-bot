import { NextResponse } from 'next/server';
import { registry } from '@/src/bot/registry';

export async function POST() {
  registry.bundleManager.executeBuys().catch((e: any) => console.error(`Bundle buy error: ${e.message}`));
  return NextResponse.json({ success: true, message: 'Buys started' });
}
