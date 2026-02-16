'use client';

import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';

export default function BundlePage() {
  const [bundle, setBundle] = useState<any>(null);
  const [mint, setMint] = useState('');
  const [walletCount, setWalletCount] = useState(5);
  const [totalSol, setTotalSol] = useState(0.5);
  const [error, setError] = useState('');
  const { subscribe } = useWebSocket();

  const load = () => fetch('/api/bundle/status').then(r => r.json()).then(d => setBundle(d));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    return subscribe('bundle', () => load());
  }, [subscribe]);

  const create = async () => {
    setError('');
    if (!mint.trim()) { setError('Enter token CA'); return; }
    const res = await fetch('/api/bundle/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mint: mint.trim(), walletCount, totalSol }),
    });
    const d = await res.json();
    if (!res.ok) setError(d.error);
    else load();
  };

  const action = (endpoint: string) => async () => {
    await fetch(`/api/bundle/${endpoint}`, { method: 'POST' });
    setTimeout(load, 1000);
  };

  const hasBundle = bundle && bundle.status && bundle.status !== 'idle';
  const busy = bundle && ['distributing', 'buying', 'consolidating', 'selling', 'reclaiming'].includes(bundle.status);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Bundle Manager</h1>

      {!hasBundle && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 space-y-4">
          <h2 className="text-sm font-semibold text-[var(--muted)]">Create Bundle</h2>
          <div className="grid grid-cols-[2fr_1fr_1fr_auto] gap-3 items-end">
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Token CA</label>
              <input value={mint} onChange={e => setMint(e.target.value)} placeholder="Token mint address..."
                className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text)]" />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Wallets (1-30)</label>
              <input type="number" value={walletCount} onChange={e => setWalletCount(+e.target.value)} min={1} max={30}
                className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text)]" />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Total SOL</label>
              <input type="number" value={totalSol} onChange={e => setTotalSol(+e.target.value)} step={0.01}
                className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text)]" />
            </div>
            <button onClick={create} className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-semibold hover:opacity-90">
              Create
            </button>
          </div>
          {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
        </div>
      )}

      {hasBundle && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-xs text-[var(--muted)]">Status: </span>
              <span className={`text-sm font-semibold ${bundle.status === 'error' ? 'text-red-400' : bundle.status === 'active' ? 'text-emerald-400' : 'text-[var(--text)]'}`}>
                {bundle.status.toUpperCase()}
              </span>
              <span className="text-xs text-[var(--muted)] ml-4">
                {bundle.mint.slice(0, 8)}... | {bundle.totalSol} SOL | {bundle.wallets.length} wallets
              </span>
            </div>
            <div className="flex gap-2">
              <button onClick={action('distribute')} disabled={busy} className="px-3 py-1.5 bg-[var(--primary)] text-white rounded-lg text-xs font-semibold disabled:opacity-50">Distribute</button>
              <button onClick={action('buy')} disabled={busy} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50">Buy</button>
              <button onClick={action('sell')} disabled={busy} className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50">Sell All</button>
              <button onClick={action('cancel')} disabled={busy && bundle.status !== 'error'} className="px-3 py-1.5 bg-gray-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50">Cancel</button>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="text-left p-2 text-xs uppercase text-[var(--muted)]">Wallet</th>
                <th className="text-left p-2 text-xs uppercase text-[var(--muted)]">SOL</th>
                <th className="text-center p-2 text-xs uppercase text-[var(--muted)]">Funded</th>
                <th className="text-center p-2 text-xs uppercase text-[var(--muted)]">Bought</th>
                <th className="text-center p-2 text-xs uppercase text-[var(--muted)]">Consolidated</th>
                <th className="text-center p-2 text-xs uppercase text-[var(--muted)]">Reclaimed</th>
              </tr>
            </thead>
            <tbody>
              {bundle.wallets.map((w: any) => (
                <tr key={w.publicKey} className="border-b border-[var(--border)]">
                  <td className="p-2 font-mono text-xs">{w.publicKey.slice(0, 12)}...</td>
                  <td className="p-2">{w.solAllocated?.toFixed(4)}</td>
                  <td className="p-2 text-center">{w.distributed ? 'Y' : '-'}</td>
                  <td className="p-2 text-center">{w.bought ? 'Y' : '-'}</td>
                  <td className="p-2 text-center">{w.consolidated ? 'Y' : '-'}</td>
                  <td className="p-2 text-center">{w.reclaimed ? 'Y' : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {bundle.error && (
            <p className="text-sm text-red-400 bg-red-500/10 p-3 rounded-lg">{bundle.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
