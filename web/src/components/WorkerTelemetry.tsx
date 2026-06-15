/*
 * WorkerTelemetry.tsx — the signature live worker indicator.
 *
 * A pulsing telemetry chip that renders the derived worker health consistently.
 * `compact` is the top-bar variant (chip only); the full variant adds the
 * last-heartbeat detail. aria-live announces state changes to screen readers.
 */
import { useWorkerStatus } from '../lib/useWorkerStatus';
import type { WorkerHealth } from '../lib/useWorkerStatus';
import { relativeTime } from '../lib/format';

const LABEL: Record<WorkerHealth, { text: string; sub: string }> = {
  live: { text: 'Worker live', sub: 'heartbeat fresh' },
  warn: { text: 'Not responding', sub: 'heartbeat stale' },
  down: { text: 'Worker stopped', sub: 'idle' },
  pending: { text: 'Starting…', sub: 'awaiting heartbeat' },
  unknown: { text: 'Worker', sub: 'checking…' },
};

const TELEMETRY_CLASS: Record<WorkerHealth, string> = {
  live: 'telemetry--live',
  warn: 'telemetry--warn',
  down: 'telemetry--down',
  pending: 'telemetry--pending',
  unknown: 'telemetry--down',
};

export function WorkerTelemetry({ compact = false }: { compact?: boolean }) {
  const { status, health } = useWorkerStatus();
  const label = LABEL[health];
  const heartbeat = status?.heartbeat.lastHeartbeat ?? null;

  return (
    <div
      className={`telemetry ${TELEMETRY_CLASS[health]}`}
      role="status"
      aria-live="polite"
      title={
        heartbeat ? `Last heartbeat: ${relativeTime(heartbeat)}` : 'No heartbeat recorded yet'
      }
    >
      <span className="telemetry__pulse" aria-hidden="true" />
      <span className="telemetry__text">
        <strong>{label.text}</strong>
        <span>{compact ? label.sub : `${label.sub} · ${relativeTime(heartbeat)}`}</span>
      </span>
    </div>
  );
}
