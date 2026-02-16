'use client';

import { useEffect, useState, useCallback } from 'react';
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

interface StatusData {
  balanceSol: number;
  wallet: string;
  uptime: number;
  modules: ModuleStatus;
  config: any;
}

interface Alert {
  time: number;
  type: string;
  message: string;
}

const MODULE_LABELS: Record<string, { label: string; emoji: string }> = {
  sniper: { label: 'Sniper', emoji: 'Crosshair' },
  pumpfun: { label: 'Pump.fun', emoji: 'Zap' },
  walletTracker: { label: 'Copy-Trade', emoji: 'Eye' },
  tokenMonitor: { label: 'Monitor', emoji: 'BarChart' },
  socialSentiment: { label: 'Social', emoji: 'MessageCircle' },
  positionManager: { label: 'Positions', emoji: 'Target' },
};

export default function Dashboard() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [modules, setModules] = useState<ModuleStatus | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [tradeStats, setTradeStats] = useState<any>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const { connected, subscribe } = useWebSocket();

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, alertsRes, statsRes] = await Promise.all([
        fetch('/api/status'),
        fetch('/api/alerts'),
        fetch('/api/trades/stats'),
      ]);
      const s = await statusRes.json();
      setStatus(s);
      setModules(s.modules);
      const a = await alertsRes.json();
      setAlerts(a.alerts || []);
      setTradeStats(await statsRes.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  useEffect(() => {
    const unsub1 = subscribe('alert', (data: Alert) => {
      setAlerts(prev => [data, ...prev].slice(0, 50));
    });
    const unsub2 = subscribe('module_status', (data: ModuleStatus) => {
      setModules(data);
    });
    return () => { unsub1(); unsub2(); };
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

  const pnl = tradeStats?.totalPnlSol || 0;
  const winRate = tradeStats?.winRate || 0;
  const posCount = status ? Object.values(status.modules).filter(Boolean).length : 0;

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

      {/* Metric cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card title="Balance" icon={<Activity size={16} />}>
          <p className="text-2xl font-bold">{status?.balanceSol?.toFixed(4) || '--'} SOL</p>
        </Card>
        <Card title="Total PnL" icon={<TrendingUp size={16} />}>
          <p className={`text-2xl font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} SOL
          </p>
        </Card>
        <Card title="Win Rate" icon={<BarChart3 size={16} />}>
          <p className="text-2xl font-bold">{winRate.toFixed(1)}%</p>
          <p className="text-xs text-[var(--muted)]">{tradeStats?.total || 0} trades</p>
        </Card>
        <Card title="Open Positions" icon={<Crosshair size={16} />}>
          <p className="text-2xl font-bold">{tradeStats?.openPositions || 0}</p>
        </Card>
      </div>

      {/* Module cards */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Modules</h2>
        <div className="grid grid-cols-3 gap-3">
          {modules && Object.entries(modules).map(([name, running]) => {
            const info = MODULE_LABELS[name] || { label: name, emoji: '' };
            return (
              <div key={name} className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{info.label}</p>
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
            );
          })}
        </div>
      </div>

      {/* Alerts */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Recent Alerts</h2>
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 max-h-96 overflow-y-auto space-y-2">
          {alerts.length === 0 ? (
            <p className="text-sm text-[var(--muted)] text-center py-4">No alerts yet</p>
          ) : (
            alerts.slice(0, 30).map((a, i) => (
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

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}
