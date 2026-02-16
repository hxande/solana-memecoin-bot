'use client';

import { useEffect, useState } from 'react';

interface Trade {
  id: string;
  time: number;
  action: string;
  mint: string;
  symbol: string;
  amountSol: number;
  price: number;
  tx?: string;
  source: string;
  pnlPct?: number;
  pnlSol?: number;
}

export default function TradesPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/trades').then(r => r.json()),
      fetch('/api/trades/stats').then(r => r.json()),
    ]).then(([t, s]) => {
      setTrades((t.trades || []).reverse());
      setStats(s);
    });
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Trade History</h1>

      {stats && (
        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Total Trades" value={stats.total} />
          <StatCard label="Win Rate" value={`${(stats.winRate || 0).toFixed(1)}%`} />
          <StatCard label="Total PnL" value={`${(stats.totalPnlSol || 0).toFixed(2)} SOL`} color={stats.totalPnlSol >= 0 ? 'text-emerald-400' : 'text-red-400'} />
          <StatCard label="Avg PnL" value={`${(stats.avgPnlPct || 0).toFixed(1)}%`} />
        </div>
      )}

      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Time</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Action</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Token</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Amount</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">PnL</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Source</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">TX</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-8 text-[var(--muted)]">No trades yet</td></tr>
            ) : trades.map((t) => (
              <tr key={t.id} className="border-b border-[var(--border)] hover:bg-[var(--surface-2)]">
                <td className="p-3 text-[var(--dim)]">{new Date(t.time).toLocaleString()}</td>
                <td className="p-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                    t.action === 'BUY' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                  }`}>{t.action}</span>
                </td>
                <td className="p-3 font-medium">{t.symbol}</td>
                <td className="p-3">{t.amountSol?.toFixed(3)} SOL</td>
                <td className={`p-3 ${(t.pnlPct || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {t.pnlPct !== undefined ? `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%` : '--'}
                </td>
                <td className="p-3"><span className="px-2 py-0.5 rounded text-xs bg-[var(--surface-2)]">{t.source}</span></td>
                <td className="p-3">
                  {t.tx ? (
                    <a href={`https://solscan.io/tx/${t.tx}`} target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:underline text-xs">
                      {t.tx.slice(0, 8)}...
                    </a>
                  ) : '--'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
      <p className="text-xs uppercase text-[var(--muted)] mb-1">{label}</p>
      <p className={`text-xl font-bold ${color || ''}`}>{value}</p>
    </div>
  );
}
