import http from 'http';
import { registry, type ModuleName } from '../bot/registry';
import { storage } from '../core/storage';
import { CONFIG } from '../config';

const VALID_MODULES: ModuleName[] = ['sniper', 'pumpfun', 'walletTracker', 'tokenMonitor', 'socialSentiment', 'positionManager'];

function json(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

export async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = req.url || '';
  const method = req.method || 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return true;
  }

  if (!url.startsWith('/api/')) return false;

  // ── GET routes ──

  if (url === '/api/status' && method === 'GET') {
    const { wallet, balanceSol } = registry.getCachedStatus();
    return json(res, { status: 'running', wallet, balanceSol, uptime: registry.getUptime(), modules: registry.getModuleStatuses(), config: CONFIG.trading }), true;
  }

  if (url === '/api/modules' && method === 'GET') {
    return json(res, registry.getModuleStatuses()), true;
  }

  if (url === '/api/positions' && method === 'GET') {
    return json(res, { positions: registry.positionManager.getPositions() }), true;
  }

  if (url === '/api/trades' && method === 'GET') {
    return json(res, { trades: storage.loadTrades().slice(-100) }), true;
  }

  if (url === '/api/trades/stats' && method === 'GET') {
    return json(res, storage.getTradeStats()), true;
  }

  if (url === '/api/alerts' && method === 'GET') {
    return json(res, { alerts: registry.getAlerts().slice(-50) }), true;
  }

  if (url === '/api/config' && method === 'GET') {
    return json(res, { config: CONFIG.trading }), true;
  }

  if (url === '/api/wallets' && method === 'GET') {
    return json(res, { wallets: registry.walletTracker.listWallets() }), true;
  }

  if (url === '/api/blacklist' && method === 'GET') {
    return json(res, { entries: storage.loadBlacklist() }), true;
  }

  if (url === '/api/influencers' && method === 'GET') {
    return json(res, { influencers: storage.loadInfluencers() }), true;
  }

  if (url === '/api/performance' && method === 'GET') {
    return json(res, { history: registry.getPerformanceHistory() }), true;
  }

  if (url === '/api/pumpfun/stats' && method === 'GET') {
    return json(res, registry.pumpfun.getStats()), true;
  }

  if (url === '/api/social/stats' && method === 'GET') {
    const stats = registry.socialSentiment.getStats();
    const narr = registry.socialSentiment.getActiveNarratives();
    return json(res, { ...stats, narratives: [...narr.entries()].map(([k, v]: any) => ({ keyword: k, ...v })) }), true;
  }

  if (url === '/api/storage/stats' && method === 'GET') {
    return json(res, storage.getStorageStats()), true;
  }

  if (url === '/api/bundle/status' && method === 'GET') {
    return json(res, registry.bundleManager.getStatus()), true;
  }

  // ── POST routes ──

  if (url.startsWith('/api/modules/') && method === 'POST') {
    const name = url.replace('/api/modules/', '') as ModuleName;
    if (!VALID_MODULES.includes(name)) return json(res, { error: `Unknown module: ${name}` }, 400), true;
    const body = await readBody(req);
    try {
      if (body.action === 'start') await registry.startModule(name);
      else if (body.action === 'stop') registry.stopModule(name);
      else return json(res, { error: 'action must be start or stop' }, 400), true;
      return json(res, { success: true, modules: registry.getModuleStatuses() }), true;
    } catch (e: any) {
      return json(res, { error: e.message }, 500), true;
    }
  }

  if (url === '/api/config' && method === 'POST') {
    const body = await readBody(req);
    const fields = ['maxBuySol', 'slippageBps', 'profitTarget', 'stopLoss', 'maxPositions',
      'trailingStopPct', 'trailingActivationPct', 'maxHoldTimeMinutes', 'sniperMinScore', 'pumpfunMinScore'] as const;
    for (const f of fields) { if (body[f] !== undefined) (CONFIG.trading as any)[f] = body[f]; }
    storage.saveConfig();
    return json(res, { success: true, config: CONFIG.trading }), true;
  }

  if (url === '/api/wallets' && method === 'POST') {
    const { address, label, copyPct, minTradeSol } = await readBody(req);
    if (!address || !label) return json(res, { error: 'address and label required' }, 400), true;
    registry.walletTracker.addWallet({ address, label, copyPct: copyPct || 50, minTradeSol: minTradeSol || 0.5, enabled: true });
    return json(res, { success: true }), true;
  }

  if (url === '/api/blacklist' && method === 'POST') {
    const { address, reason } = await readBody(req);
    if (!address) return json(res, { error: 'address required' }, 400), true;
    storage.addToBlacklist(address, reason || 'Manual', 'manual');
    return json(res, { success: true }), true;
  }

  if (url.startsWith('/api/blacklist/') && method === 'DELETE') {
    const address = url.replace('/api/blacklist/', '');
    storage.removeFromBlacklist(decodeURIComponent(address));
    return json(res, { success: true }), true;
  }

  if (url === '/api/influencers' && method === 'POST') {
    const { handle, platform, followers, weight, trackBuyCalls } = await readBody(req);
    if (!handle) return json(res, { error: 'handle required' }, 400), true;
    const inf = { handle, platform: platform || 'twitter', followers: followers || 0, weight: weight || 5, trackBuyCalls: trackBuyCalls !== false, addedAt: Date.now() };
    storage.addInfluencer(inf);
    registry.socialSentiment.addInfluencer({ handle: inf.handle, platform: inf.platform, followers: inf.followers, weight: inf.weight, trackBuyCalls: inf.trackBuyCalls });
    return json(res, { success: true }), true;
  }

  if (url.startsWith('/api/influencers/') && method === 'DELETE') {
    const handle = url.replace('/api/influencers/', '');
    storage.removeInfluencer(decodeURIComponent(handle));
    return json(res, { success: true }), true;
  }

  // ── Bundle routes ──

  if (url === '/api/bundle/create' && method === 'POST') {
    try {
      const { mint, walletCount, totalSol } = await readBody(req);
      if (!mint || !walletCount || !totalSol) return json(res, { error: 'mint, walletCount, totalSol required' }, 400), true;
      const state = await registry.bundleManager.createBundle(mint, walletCount, totalSol);
      return json(res, { success: true, wallets: state.wallets.length }), true;
    } catch (e: any) {
      return json(res, { error: e.message }, 400), true;
    }
  }

  if (url === '/api/bundle/distribute' && method === 'POST') {
    registry.bundleManager.distribute().catch((e: any) => console.error(`Bundle distribute error: ${e.message}`));
    return json(res, { success: true, message: 'Distribution started' }), true;
  }

  if (url === '/api/bundle/buy' && method === 'POST') {
    registry.bundleManager.executeBuys().catch((e: any) => console.error(`Bundle buy error: ${e.message}`));
    return json(res, { success: true, message: 'Buys started' }), true;
  }

  if (url === '/api/bundle/sell' && method === 'POST') {
    registry.bundleManager.executeSellFlow().catch((e: any) => console.error(`Bundle sell error: ${e.message}`));
    return json(res, { success: true, message: 'Sell flow started' }), true;
  }

  if (url === '/api/bundle/cancel' && method === 'POST') {
    registry.bundleManager.cancelBundle().catch((e: any) => console.error(`Bundle cancel error: ${e.message}`));
    return json(res, { success: true, message: 'Cancel started' }), true;
  }

  if (url === '/api/bundle/reclaim' && method === 'POST') {
    registry.bundleManager.reclaimSol().catch((e: any) => console.error(`Bundle reclaim error: ${e.message}`));
    return json(res, { success: true, message: 'Reclaim started' }), true;
  }

  // Not found
  json(res, { error: 'Not found' }, 404);
  return true;
}
