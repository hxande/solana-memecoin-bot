'use client';

import { useEffect, useState } from 'react';

const FIELDS = [
  { key: 'maxBuySol', label: 'Max Buy (SOL)', step: 0.01 },
  { key: 'slippageBps', label: 'Slippage (BPS)', step: 50 },
  { key: 'profitTarget', label: 'Take Profit %', step: 10 },
  { key: 'stopLoss', label: 'Stop Loss %', step: 5 },
  { key: 'maxPositions', label: 'Max Positions', step: 1 },
  { key: 'trailingStopPct', label: 'Trailing Stop %', step: 5 },
  { key: 'trailingActivationPct', label: 'Trailing Activation %', step: 5 },
  { key: 'maxHoldTimeMinutes', label: 'Max Hold Time (min)', step: 5 },
  { key: 'sniperMinScore', label: 'Sniper Min Score', step: 5 },
  { key: 'pumpfunMinScore', label: 'Pump.fun Min Score', step: 5 },
];

export default function ConfigPage() {
  const [config, setConfig] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(d => setConfig(d.config || {}));
  }, []);

  const save = async () => {
    setSaving(true);
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Trading Config</h1>
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6">
        <div className="grid grid-cols-2 gap-4">
          {FIELDS.map(({ key, label, step }) => (
            <div key={key}>
              <label className="block text-xs text-[var(--muted)] mb-1">{label}</label>
              <input
                type="number"
                step={step}
                value={config[key] ?? ''}
                onChange={(e) => setConfig(prev => ({ ...prev, [key]: parseFloat(e.target.value) }))}
                className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
              />
            </div>
          ))}
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="mt-6 w-full px-4 py-2.5 bg-[var(--primary)] text-white rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Config'}
        </button>
      </div>
    </div>
  );
}
