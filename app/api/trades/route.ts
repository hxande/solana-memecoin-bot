import { NextResponse } from 'next/server';
import { storage } from '@/src/core/storage';

export async function GET() {
  return NextResponse.json({ trades: storage.loadTrades().slice(-100) });
}
