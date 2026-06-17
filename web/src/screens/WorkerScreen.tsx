/*
 * WorkerScreen.tsx — worker control + live status.
 *
 *   POST /api/worker/start | /stop   → returns the unified status + `action`
 *   GET  /api/worker/status (polled) → the same canonical shape
 *
 * The big dial reflects the derived health (live / warn / down / pending). We
 * explain the eventual-consistency window: intent (desired_state) updates
 * immediately, but the heartbeat lags ~one tick, so right after Start the state
 * reads "Starting…" until the worker's first heartbeat lands.
 *
 * The `action` from start/stop (started/restarted/stopped/noop) is shown as a
 * transient toast — the canonical state to render is the rest of the shape.
 */
import { useState } from 'react';
import { api } from '../api/client';
import { ApiError } from '../api/ApiError';
import { useWorkerStatus } from '../lib/useWorkerStatus';
import type { WorkerHealth } from '../lib/useWorkerStatus';
import { absoluteTime, errorMessage, formatMs, relativeTime } from '../lib/format';
import { useToast } from '../components/Toast';
import { Button, Card, CardBody, CardHead, Badge } from '../components/ui';
import { IconPlay, IconStop, IconRefresh } from '../components/icons';
import type { WorkerAction } from '../api/types';

const DIAL_CLASS: Record<WorkerHealth, string> = {
  live: 'worker-hero__dial--live',
  warn: 'worker-hero__dial--warn',
  down: 'worker-hero__dial--down',
  pending: 'worker-hero__dial--pending',
  unknown: 'worker-hero__dial--down',
};

const STATE_LABEL: Record<WorkerHealth, string> = {
  live: 'Running',
  warn: 'Not responding',
  down: 'Stopped',
  pending: 'Starting…',
  unknown: 'Checking…',
};

const ACTION_MSG: Record<WorkerAction, string> = {
  started: 'Worker started.',
  restarted: 'Worker restarted.',
  stopped: 'Worker stopped.',
  noop: 'No change — worker was already in that state.',
};

export function WorkerScreen() {
  const toast = useToast();
  const { status, health, error, loading, refresh, markPending } = useWorkerStatus();
  const [busy, setBusy] = useState<null | 'start' | 'stop'>(null);

  async function act(which: 'start' | 'stop') {
    if (busy) return;
    setBusy(which);
    markPending();
    try {
      const res = which === 'start' ? await api.worker.start() : await api.worker.stop();
      toast.success(ACTION_MSG[res.action] ?? 'Done.');
      // Refresh shortly after so the heartbeat catches up out of the pending window.
      await refresh();
      window.setTimeout(() => void refresh(), 2500);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        toast.error(
          'The worker process manager is unavailable. Your intent was recorded and will reconcile on retry.'
        );
      } else {
        toast.error(`Worker ${which} failed: ${errorMessage(err)}`);
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const desiredRunning = status?.desired_state === 'running';
  const hb = status?.heartbeat;

  return (
    <div className="page">
      <Card>
        <CardHead
          title="Worker"
          description="Start, stop, and monitor the automation worker"
          actions={
            <Button variant="ghost" size="sm" onClick={() => void refresh()} loading={loading}>
              <IconRefresh size={15} /> Refresh
            </Button>
          }
        />
        <div className="worker-hero">
          <div className={`worker-hero__dial ${DIAL_CLASS[health]}`} aria-hidden="true">
            <span className="worker-hero__dial-core" />
          </div>
          <div className="worker-hero__info">
            <span className="worker-hero__state" role="status" aria-live="polite">
              {STATE_LABEL[health]}
            </span>
            <div className="worker-hero__meta">
              <span>
                Intent:{' '}
                <strong className="mono">{status?.desired_state ?? '—'}</strong>
              </span>
              <span>
                Reported:{' '}
                <strong className="mono">{status?.reported_status ?? '—'}</strong>
              </span>
              {hb?.lastHeartbeat ? (
                <span>
                  Last heartbeat: <strong>{relativeTime(hb.lastHeartbeat)}</strong>
                </span>
              ) : (
                <span className="muted">No heartbeat yet</span>
              )}
            </div>
            {health === 'pending' && (
              <span className="text-sm muted">
                Intent is set; waiting for the worker's first heartbeat (eventual consistency,
                ~one tick).
              </span>
            )}
            {health === 'warn' && (
              <span className="text-sm" role="alert">
                <Badge tone="warn" dot>
                  Heartbeat stale
                </Badge>{' '}
                The worker is meant to be running but isn't reporting. It may have crashed —
                try restarting.
              </span>
            )}
          </div>
          <div className="worker-hero__actions">
            {/* Single state-aware toggle: Start when the worker is stopped, Stop
                when it is running. Keyed off desired_state (intent) so it flips
                immediately on click while the heartbeat catches up. */}
            {desiredRunning ? (
              <Button
                variant="danger"
                onClick={() => void act('stop')}
                loading={busy === 'stop'}
                disabled={busy !== null}
              >
                <IconStop size={16} /> Stop
              </Button>
            ) : (
              <Button
                variant="success"
                onClick={() => void act('start')}
                loading={busy === 'start'}
                disabled={busy !== null}
              >
                <IconPlay size={16} /> Start
              </Button>
            )}
            {/* Recovery affordance: only when the worker SHOULD be running but its
                heartbeat is stale (crashed). The toggle shows "Stop" in that state,
                so a direct Restart (re-issue start) is the genuinely useful extra. */}
            {health === 'warn' && (
              <Button
                variant="ghost"
                onClick={() => void act('start')}
                loading={busy === 'start'}
                disabled={busy !== null}
              >
                <IconRefresh size={16} /> Restart
              </Button>
            )}
          </div>
        </div>
      </Card>

      {error && (
        <Card>
          <CardBody>
            <span className="field__error">{error}</span>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHead title="Details" description="Raw status from the control plane" />
        <CardBody>
          <dl className="dl">
            <dt>Desired</dt>
            <dd className="mono">{status?.desired_state ?? '—'}</dd>
            <dt>Reported</dt>
            <dd className="mono">{status?.reported_status ?? '—'}</dd>
            <dt>Heartbeat age</dt>
            <dd>{hb?.ageMs != null ? formatMs(hb.ageMs) : '—'}</dd>
            <dt>Heartbeat fresh</dt>
            <dd>
              {hb?.stale == null ? (
                <span className="muted">unknown</span>
              ) : hb.stale ? (
                <Badge tone="warn">stale</Badge>
              ) : (
                <Badge tone="ok">fresh</Badge>
              )}
            </dd>
            <dt>Process</dt>
            <dd className="mono">
              {status?.process?.present
                ? status.process.status
                : (status?.process?.error ?? 'not present')}
            </dd>
            {status?.detail && (
              <>
                <dt>Detail</dt>
                <dd>{status.detail}</dd>
              </>
            )}
            <dt>Updated</dt>
            <dd>{absoluteTime(status?.updated_at)}</dd>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
