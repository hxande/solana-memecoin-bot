'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Crosshair, ArrowLeftRight, Settings, Wallet, Package } from 'lucide-react';

const links = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/positions', label: 'Positions', icon: Crosshair },
  { href: '/trades', label: 'Trades', icon: ArrowLeftRight },
  { href: '/config', label: 'Config', icon: Settings },
  { href: '/wallets', label: 'Wallets', icon: Wallet },
  { href: '/bundle', label: 'Bundle', icon: Package },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 h-screen w-56 bg-[var(--surface)] border-r border-[var(--border)] flex flex-col z-50">
      <div className="p-5 border-b border-[var(--border)]">
        <h1 className="text-lg font-bold bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent">
          Solana Bot
        </h1>
        <p className="text-xs text-[var(--muted)] mt-1">Memecoin Trading</p>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {links.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                active
                  ? 'bg-[var(--primary)] text-white'
                  : 'text-[var(--dim)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
              }`}
            >
              <Icon size={18} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-[var(--border)] text-xs text-[var(--muted)]">
        v2.0 Next.js
      </div>
    </aside>
  );
}
