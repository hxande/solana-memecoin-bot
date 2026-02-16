import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/layout/sidebar';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Solana Memecoin Bot',
  description: 'Trading bot dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="flex min-h-screen">
        <Providers>
          <Sidebar />
          <main className="flex-1 ml-56 p-6 overflow-auto">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
