import { NextResponse } from 'next/server';
import { registry } from '@/src/bot/registry';

export async function POST() {
  registry.bundleManager.reclaimSol().catch((e: any) => console.error(`Bundle reclaim error: ${e.message}`));
  return NextResponse.json({ success: true, message: 'Reclaim started' });
}
