'use client';

import { WSProvider } from '@/hooks/use-websocket';

export function Providers({ children }: { children: React.ReactNode }) {
  return <WSProvider>{children}</WSProvider>;
}
