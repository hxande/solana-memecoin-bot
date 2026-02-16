import { NextRequest, NextResponse } from 'next/server';
import { storage } from '@/src/core/storage';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  storage.removeFromBlacklist(address);
  return NextResponse.json({ success: true });
}
