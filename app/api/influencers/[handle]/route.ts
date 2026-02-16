import { NextRequest, NextResponse } from 'next/server';
import { storage } from '@/src/core/storage';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  storage.removeInfluencer(handle);
  return NextResponse.json({ success: true });
}
