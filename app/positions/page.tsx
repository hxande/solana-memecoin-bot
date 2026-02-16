'use client';

import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';

interface Position {
  mint: string;
  symbol: string;
  entryPrice: number;
  currentPrice?: number;
  amount: number;
  entryTime: number;
  source: string;
  highestPrice?: number;
}

export default function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const { subscribe } = useWebSocket();

  useEffect(() => {
    fetch('/api/positions').then(r => r.json()).then(d => setPositions(d.positions || []));
  }, []);

  useEffect(() => {
    return subscribe('position_update', (data: Position[]) => {
      setPositions(data);
    });
  }, [subscribe]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Open Positions</h1>
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Token</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Entry</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Current</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">PnL</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Hold Time</th>
              <th className="text-left p-3 text-xs uppercase text-[var(--muted)]">Source</th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-8 text-[var(--muted)]">No open positions</td>
              </tr>
            ) : (
              positions.map((pos) => {
                const pnl = pos.currentPrice && pos.entryPrice
                  ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
                  : 0;
                const holdMin = Math.floor((Date.now() - pos.entryTime) / 60000);
                return (
                  <tr key={pos.mint} className={`border-b border-[var(--border)] hover:bg-[var(--surface-2)] ${
                    pnl >= 0 ? '' : ''
                  }`}>
                    <td className="p-3">
                      <span className="font-medium">{pos.symbol}</span>
                      <span className="text-[var(--muted)] text-xs ml-2">{pos.mint.slice(0, 8)}...</span>
                    </td>
                    <td className="p-3">${pos.entryPrice.toFixed(8)}</td>
                    <td className="p-3">${pos.currentPrice?.toFixed(8) || '--'}</td>
                    <td className={`p-3 font-semibold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}%
                    </td>
                    <td className="p-3 text-[var(--dim)]">{holdMin}m</td>
                    <td className="p-3">
                      <span className="px-2 py-0.5 rounded text-xs bg-[var(--surface-2)]">{pos.source}</span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
