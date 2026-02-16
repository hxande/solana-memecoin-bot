import { NextRequest, NextResponse } from 'next/server';
import { storage } from '@/src/core/storage';

export async function GET() {
  return NextResponse.json({ entries: storage.loadBlacklist() });
}

export async function POST(req: NextRequest) {
  const { address, reason } = await req.json();
  if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 });
  storage.addToBlacklist(address, reason || 'Manual', 'manual');
  return NextResponse.json({ success: true });
}
