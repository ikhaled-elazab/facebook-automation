/*
 * Toast.tsx — accessible, ephemeral notifications.
 *
 * Provider holds a queue; useToast() pushes. Region is aria-live=polite so screen
 * readers announce without stealing focus. Auto-dismiss with a sensible default;
 * errors persist longer. Reduced-motion is respected via CSS.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { IconCheck, IconAlert, IconInfo, IconX } from './icons';

type ToastTone = 'success' | 'error' | 'warn' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  push: (tone: ToastTone, message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_MS: Record<ToastTone, number> = {
  success: 3500,
  info: 4000,
  warn: 5000,
  error: 7000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = ++seq.current;
      setItems((prev) => [...prev, { id, tone, message }]);
      const handle = setTimeout(() => dismiss(id), DEFAULT_MS[tone]);
      timers.current.set(id, handle);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      warn: (m) => push('warn', m),
      info: (m) => push('info', m),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => (
          <Toast key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const icon =
    item.tone === 'success' ? (
      <IconCheck size={16} />
    ) : item.tone === 'error' || item.tone === 'warn' ? (
      <IconAlert size={16} />
    ) : (
      <IconInfo size={16} />
    );
  return (
    <div className={`toast toast--${item.tone}`}>
      <span className="toast__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="toast__body">{item.message}</div>
      <button className="toast__close" onClick={onDismiss} aria-label="Dismiss notification">
        <IconX size={14} />
      </button>
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}
