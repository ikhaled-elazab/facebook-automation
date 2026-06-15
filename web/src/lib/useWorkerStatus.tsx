/*
 * useWorkerStatus — SINGLE shared worker-status poller (provider + consumer).
 *
 * Previously every consumer (top-bar telemetry, Overview, Worker screen) mounted
 * its own useWorkerStatus() → 2-3 independent 5s pollers all hitting
 * /api/worker/status. This module hoists the polling into ONE WorkerStatusProvider
 * that owns a single timer; useWorkerStatus() is now a thin context consumer, so
 * the whole app shares one poller and one piece of state.
 *
 * Reconciliation model (DESIRED vs REPORTED) → a single derived `health`:
 *   - 'live'    : desired running + heartbeat fresh  → green pulse.
 *   - 'warn'    : desired running + heartbeat stale/absent → "not responding".
 *   - 'down'    : desired stopped → grey.
 *   - 'pending' : a start/stop just issued; intent set but heartbeat lags ~1 tick
 *                 (eventual consistency) → amber pulse.
 *   - 'unknown' : first load / fetch error.
 *
 * Hygiene preserved from the old hook + improved by centralization:
 *   - Polling PAUSES when the tab is hidden, resumes on focus with an immediate
 *     refresh.
 *   - NO overlapping requests: a single in-flight guard skips a tick already
 *     running (the old per-component version could overlap across instances; one
 *     poller cannot).
 *   - Unmount cleanup clears the timer + visibility listener.
 *   - markPending() flips health to 'pending' immediately (it lives in state now,
 *     not a ref, so all consumers re-render) and a short ticker re-derives health
 *     so the pending→live/warn transition surfaces without waiting a full poll.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import { ApiError } from '../api/ApiError';
import type { WorkerStatus } from '../api/types';

export type WorkerHealth = 'live' | 'warn' | 'down' | 'pending' | 'unknown';

interface WorkerStatusValue {
  status: WorkerStatus | null;
  health: WorkerHealth;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Mark a transition as just-issued so health reads 'pending' until heartbeat catches up. */
  markPending: () => void;
}

/** Internal: derive the single render health from status + pending window. */
function deriveHealth(status: WorkerStatus | null, pendingUntil: number): WorkerHealth {
  if (!status) return 'unknown';
  const running = status.desired_state === 'running';
  if (!running) return 'down';
  // Within the eventual-consistency window after an action: show pending unless
  // the heartbeat is already fresh.
  if (Date.now() < pendingUntil && status.heartbeat.stale !== false) return 'pending';
  if (status.heartbeat.stale === false) return 'live';
  // desired running but heartbeat stale or never seen → not responding.
  return 'warn';
}

const POLL_MS = 5000;
/** How long after an action we treat status as 'pending' (heartbeat lags ~1 tick). */
const PENDING_WINDOW_MS = 8000;

const WorkerStatusContext = createContext<WorkerStatusValue | null>(null);

export function WorkerStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // pendingUntil in STATE (not a ref) so markPending re-renders all consumers.
  const [pendingUntil, setPendingUntil] = useState(0);

  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Single in-flight guard: never run two status reads concurrently.
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const s = await api.worker.status();
      if (!mounted.current) return;
      setStatus(s);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      // A 401 is handled globally (redirect); don't show it as a worker error.
      if (err instanceof ApiError && err.isAuth) return;
      setError(err instanceof ApiError ? err.message : 'Failed to read worker status.');
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  const markPending = useCallback(() => {
    setPendingUntil(Date.now() + PENDING_WINDOW_MS);
  }, []);

  // Single poll loop for the whole app.
  useEffect(() => {
    mounted.current = true;
    void refresh();

    const schedule = () => {
      timer.current = setTimeout(async () => {
        if (document.visibilityState === 'visible') {
          await refresh();
        }
        schedule();
      }, POLL_MS);
    };
    schedule();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // While inside a pending window, re-derive health on a short ticker so the
  // pending→live/warn transition surfaces between 5s polls. Stops when the window
  // closes (no idle ticker burning cycles in steady state).
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (pendingUntil <= Date.now()) return;
    const t = setInterval(() => {
      forceTick((n) => n + 1);
      if (Date.now() >= pendingUntil) {
        // Pull a fresh status as the window closes so 'warn' (crash) is detected
        // promptly rather than on the next 5s tick.
        void refresh();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [pendingUntil, refresh]);

  const value = useMemo<WorkerStatusValue>(
    () => ({
      status,
      health: deriveHealth(status, pendingUntil),
      error,
      loading,
      refresh,
      markPending,
    }),
    [status, pendingUntil, error, loading, refresh, markPending]
  );

  return <WorkerStatusContext.Provider value={value}>{children}</WorkerStatusContext.Provider>;
}

/**
 * Consume the single shared worker status. MUST be used within a
 * <WorkerStatusProvider> (mounted in the authenticated subtree).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useWorkerStatus(): WorkerStatusValue {
  const ctx = useContext(WorkerStatusContext);
  if (!ctx) {
    throw new Error('useWorkerStatus must be used within <WorkerStatusProvider>');
  }
  return ctx;
}
