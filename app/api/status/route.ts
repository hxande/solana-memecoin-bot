import { NextResponse } from 'next/server';
import { registry } from '@/src/bot/registry';
import { CONFIG } from '@/src/config';

export async function GET() {
  const { wallet, balanceSol } = registry.getCachedStatus();
  return NextResponse.json({
    status: 'running',
    wallet,
    balanceSol,
    uptime: registry.getUptime(),
    modules: registry.getModuleStatuses(),
    config: CONFIG.trading,
  });
}
