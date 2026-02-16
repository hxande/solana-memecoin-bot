import { NextResponse } from 'next/server';
import { storage } from '@/src/core/storage';

export async function GET() {
  return NextResponse.json(storage.getStorageStats());
}
