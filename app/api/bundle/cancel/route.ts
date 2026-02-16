import { NextResponse } from 'next/server';
import { registry } from '@/src/bot/registry';

export async function POST() {
  registry.bundleManager.cancelBundle().catch((e: any) => console.error(`Bundle cancel error: ${e.message}`));
  return NextResponse.json({ success: true, message: 'Cancel started' });
}
