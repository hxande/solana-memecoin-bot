import { NextResponse } from 'next/server';
import { registry } from '@/src/bot/registry';

export async function GET() {
  const stats = registry.socialSentiment.getStats();
  const narr = registry.socialSentiment.getActiveNarratives();
  return NextResponse.json({
    ...stats,
    narratives: [...narr.entries()].map(([k, v]: any) => ({ keyword: k, ...v })),
  });
}
