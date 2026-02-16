import { NextResponse } from 'next/server';
import { registry } from '@/src/bot/registry';

export async function POST() {
  registry.bundleManager.distribute().catch((e: any) => console.error(`Bundle distribute error: ${e.message}`));
  return NextResponse.json({ success: true, message: 'Distribution started' });
}
