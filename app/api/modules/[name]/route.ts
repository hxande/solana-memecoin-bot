import { NextRequest, NextResponse } from 'next/server';
import { registry, type ModuleName } from '@/src/bot/registry';

const VALID: ModuleName[] = ['sniper', 'pumpfun', 'walletTracker', 'tokenMonitor', 'socialSentiment', 'positionManager'];

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!VALID.includes(name as ModuleName)) {
    return NextResponse.json({ error: `Unknown module: ${name}` }, { status: 400 });
  }
  const { action } = await req.json();
  try {
    if (action === 'start') {
      await registry.startModule(name as ModuleName);
    } else if (action === 'stop') {
      registry.stopModule(name as ModuleName);
    } else {
      return NextResponse.json({ error: 'action must be start or stop' }, { status: 400 });
    }
    return NextResponse.json({ success: true, modules: registry.getModuleStatuses() });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
