'use client';

import { useEffect, useState } from 'react';

interface WalletConfig {
  address: string;
  label: string;
  copyPct: number;
  minTradeSol: number;
  enabled: boolean;
}

export default function WalletsPage() {
  const [wallets, setWallets] = useState<WalletConfig[]>([]);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [copyPct, setCopyPct] = useState(50);

  const load = () => fetch('/api/wallets').then(r => r.json()).then(d => setWallets(d.wallets || []));
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!address.trim()) return;
    await fetch('/api/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address.trim(), label: label || address.slice(0, 8) + '...', copyPct, minTradeSol: 0.5 }),
    });
    setAddress('');
    setLabel('');
    load();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tracked Wallets</h1>

      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-[var(--muted)]">Add Wallet</h2>
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Address</label>
            <input value={address} onChange={e => setAddress(e.target.value)} placeholder="Wallet address..."
              className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text)]" />
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Label</label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Name..."
              className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text)]" />
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Copy %</label>
            <input type="number" value={copyPct} onChange={e => setCopyPct(+e.target.value)} min={1} max={100}
              className="w-20 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text)]" />
          </div>
          <button onClick={add} className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-semibold hover:opacity-90">
            Add
          </button>
        </div>
      </div>

      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Label</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Address</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Copy %</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Min SOL</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Status</th>
            </tr>
          </thead>
          <tbody>
            {wallets.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-8 text-[var(--muted)]">No wallets tracked</td></tr>
            ) : wallets.map(w => (
              <tr key={w.address} className="border-b border-[var(--border)] hover:bg-[var(--surface-2)]">
                <td className="p-3 font-medium">{w.label}</td>
                <td className="p-3 font-mono text-xs text-[var(--dim)]">{w.address.slice(0, 16)}...</td>
                <td className="p-3">{w.copyPct}%</td>
                <td className="p-3">{w.minTradeSol} SOL</td>
                <td className="p-3">
                  <span className={`px-2 py-0.5 rounded text-xs ${w.enabled ? 'bg-emerald-500/15 text-emerald-400' : 'bg-[var(--surface-2)] text-[var(--muted)]'}`}>
                    {w.enabled ? 'Active' : 'Disabled'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
