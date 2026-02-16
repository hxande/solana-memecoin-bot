'use client';

import { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import React from 'react';

type Listener = (data: any) => void;

interface WSContextValue {
  connected: boolean;
  subscribe: (type: string, listener: Listener) => () => void;
}

const WSContext = createContext<WSContextValue>({
  connected: false,
  subscribe: () => () => {},
});

export function WSProvider({ children }: { children: React.ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<string, Set<Listener>>>(new Map());
  const [connected, setConnected] = useState(false);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    function connect() {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}`);

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        reconnectRef.current = setTimeout(connect, 3000);
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          const handlers = listenersRef.current.get(msg.type);
          if (handlers) handlers.forEach(fn => fn(msg.data));
        } catch {}
      };

      wsRef.current = ws;
    }

    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, []);

  const subscribe = useCallback((type: string, listener: Listener) => {
    if (!listenersRef.current.has(type)) listenersRef.current.set(type, new Set());
    listenersRef.current.get(type)!.add(listener);
    return () => { listenersRef.current.get(type)?.delete(listener); };
  }, []);

  return React.createElement(WSContext.Provider, { value: { connected, subscribe } }, children);
}

export function useWebSocket() {
  return useContext(WSContext);
}
