import { NextResponse } from 'next/server';
import { registry } from '@/src/bot/registry';

export async function GET() {
  return NextResponse.json(registry.bundleManager.getStatus());
}
