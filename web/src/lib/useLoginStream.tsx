/*
 * useLoginStream — the dashboard side of the remote-browser (manual login) channel.
 *
 * Opens a same-origin WebSocket to /api/accounts/:id/login/stream (authenticated by
 * the session cookie that rides the upgrade), receives screencast frames, and sends
 * the operator's input back. The server runs the login browser HEADLESS and streams
 * it here via CDP — so this hook turns a <canvas>/<img> into a live remote browser.
 *
 * Lifecycle: connect while `enabled` (the login is parked at needs_manual); the
 * socket closes on stream end (login finished), on unmount, or when disabled. A
 * dropped socket surfaces as state 'closed' with a reconnect() the UI can offer.
 *
 * SECURITY: frames are rendered, never stored; input is transient. The socket is
 * same-origin only; auth is the existing dashboard session (no token in JS).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** A screencast frame: base64 JPEG + the viewport size for input coordinate scaling. */
export interface StreamFrame {
  data: string;
  metadata: { deviceWidth?: number; deviceHeight?: number };
}

/** Input messages sent to the server (mirrors core/login-stream.js dispatchInput). */
export type StreamInput =
  | { t: 'm'; kind: 'move' | 'down' | 'up'; x: number; y: number; button?: number; clickCount?: number }
  | { t: 'w'; x: number; y: number; dx: number; dy: number }
  | { t: 'text'; v: string }
  | {
      t: 'key';
      kind: 'down' | 'up';
      key: string;
      code?: string;
      vk?: number;
      modifiers?: number;
      /** Editor commands (e.g. ['selectAll']) for Ctrl/⌘ shortcuts. */
      commands?: string[];
    };

export type StreamState = 'connecting' | 'open' | 'closed' | 'error';

export interface LoginStream {
  state: StreamState;
  frame: StreamFrame | null;
  send: (msg: StreamInput) => void;
  reconnect: () => void;
}

function streamUrl(accountId: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/accounts/${accountId}/login/stream`;
}

export function useLoginStream(accountId: number, enabled: boolean): LoginStream {
  const [state, setState] = useState<StreamState>('connecting');
  const [frame, setFrame] = useState<StreamFrame | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Bumping this forces the connect effect to re-run (manual reconnect).
  const [attempt, setAttempt] = useState(0);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  const send = useCallback((msg: StreamInput) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* a failed send just drops this input event */
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setState('connecting');
    setFrame(null);

    let closed = false;
    const ws = new WebSocket(streamUrl(accountId));
    wsRef.current = ws;

    ws.onopen = () => {
      if (!closed) setState('open');
    };
    ws.onmessage = (ev) => {
      if (closed) return;
      let msg: { type?: string } & Partial<StreamFrame>;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (msg.type === 'frame' && typeof msg.data === 'string') {
        setFrame({ data: msg.data, metadata: msg.metadata || {} });
      } else if (msg.type === 'end') {
        // Server signalled the login finished — it will close the socket next.
        closed = true;
      }
    };
    ws.onerror = () => {
      if (!closed) setState('error');
    };
    ws.onclose = () => {
      if (!closed) setState('closed');
      if (wsRef.current === ws) wsRef.current = null;
    };

    return () => {
      closed = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [accountId, enabled, attempt]);

  return { state, frame, send, reconnect };
}
