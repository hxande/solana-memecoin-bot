'use client';

import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { Activity, TrendingUp, BarChart3, Crosshair } from 'lucide-react';

interface ModuleStatus {
  sniper: boolean;
  pumpfun: boolean;
  walletTracker: boolean;
  tokenMonitor: boolean;
  socialSentiment: boolean;
  positionManager: boolean;
}

interface Alert {
  time: number;
  type: string;
  message: string;
}

const MODULE_LABELS: Record<string, string> = {
  sniper: 'Sniper',
  pumpfun: 'Pump.fun',
  walletTracker: 'Copy-Trade',
  tokenMonitor: 'Monitor',
  socialSentiment: 'Social',
  positionManager: 'Positions',
};

export default function Dashboard() {
  const [balance, setBalance] = useState<number | null>(null);
  const [modules, setModules] = useState<ModuleStatus | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [toggling, setToggling] = useState<string | null>(null);
  const { connected, subscribe } = useWebSocket();

  // Single fetch on mount — just status (cached, no RPC)
  useEffect(() => {
    fetch('/api/status').then(r => r.json()).then(s => {
      setBalance(s.balanceSol);
      setModules(s.modules);
    }).catch(() => {});
  }, []);

  // WS: live alerts + module status changes + balance updates
  useEffect(() => {
    const unsubs = [
      subscribe('alert', (data: Alert) => {
        setAlerts(prev => [data, ...prev].slice(0, 50));
      }),
      subscribe('module_status', (data: ModuleStatus) => {
        setModules(data);
      }),
      subscribe('performance', (data: { balanceSol: number }) => {
        setBalance(data.balanceSol);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, [subscribe]);

  const toggleModule = async (name: string, running: boolean) => {
    setToggling(name);
    try {
      const res = await fetch(`/api/modules/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: running ? 'stop' : 'start' }),
      });
      const data = await res.json();
      if (data.modules) setModules(data.modules);
    } catch {}
    setToggling(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${
          connected ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
        }`}>
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
          {connected ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      {/* Balance card */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">
          <Activity size={16} /> Balance
        </div>
        <p className="text-2xl font-bold">{balance !== null ? `${balance.toFixed(4)} SOL` : '--'}</p>
      </div>

      {/* Module cards */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Modules</h2>
        <div className="grid grid-cols-3 gap-3">
          {modules && Object.entries(modules).map(([name, running]) => (
            <div key={name} className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{MODULE_LABELS[name] || name}</p>
                <p className={`text-xs font-medium mt-1 ${running ? 'text-emerald-400' : 'text-[var(--muted)]'}`}>
                  {running ? 'Running' : 'Stopped'}
                </p>
              </div>
              <button
                onClick={() => toggleModule(name, running)}
                disabled={toggling === name}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  running
                    ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
                    : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                } disabled:opacity-50`}
              >
                {toggling === name ? '...' : running ? 'Stop' : 'Start'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Alerts — populated only via WebSocket, no fetch */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Live Alerts</h2>
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 max-h-96 overflow-y-auto space-y-2">
          {alerts.length === 0 ? (
            <p className="text-sm text-[var(--muted)] text-center py-4">Alerts will appear here when modules are running</p>
          ) : (
            alerts.map((a, i) => (
              <div key={i} className="flex gap-3 py-2 border-b border-[var(--border)] last:border-0 text-sm">
                <span className="text-xs text-[var(--muted)] min-w-[60px]">
                  {new Date(a.time).toLocaleTimeString()}
                </span>
                <span>{a.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
