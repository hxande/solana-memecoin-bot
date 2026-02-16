'use client';

import { useEffect, useRef, useCallback, useState } from 'react';

type Listener = (data: any) => void;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<string, Set<Listener>>>(new Map());
  const [connected, setConnected] = useState(false);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setTimeout(connect, 3000);
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const handlers = listenersRef.current.get(msg.type);
        if (handlers) handlers.forEach(fn => fn(msg.data));
      } catch {}
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();
    return () => { wsRef.current?.close(); };
  }, [connect]);

  const subscribe = useCallback((type: string, listener: Listener) => {
    if (!listenersRef.current.has(type)) listenersRef.current.set(type, new Set());
    listenersRef.current.get(type)!.add(listener);
    return () => { listenersRef.current.get(type)?.delete(listener); };
  }, []);

  return { connected, subscribe };
}
