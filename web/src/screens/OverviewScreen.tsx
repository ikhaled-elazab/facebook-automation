/*
 * OverviewScreen.tsx — dashboard landing.
 *
 * Uses GET /api/status (account_count, per-account actions_today, worker snapshot)
 * + the live WorkerTelemetry. Gives the operator an at-a-glance fleet view and
 * fast paths into the common tasks (add account, open worker controls).
 */
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAsync } from '../lib/useAsync';
import { formatInt } from '../lib/format';
import {
  Card,
  CardBody,
  CardHead,
  EmptyState,
  ErrorState,
  LoadingState,
  Badge,
} from '../components/ui';
import { WorkerTelemetry } from '../components/WorkerTelemetry';
import { IconAccounts, IconPlus, IconWorker, IconActivity } from '../components/icons';

export function OverviewScreen() {
  const { data, error, loading, reload } = useAsync(() => api.status.overview());

  if (loading) return <LoadingState label="Loading overview…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const enabledCount = data.accounts.filter((a) => a.enabled).length;
  const totalToday = data.accounts.reduce((sum, a) => sum + a.actions_today, 0);

  return (
    <div className="page">
      <div className="stat-grid">
        <div className="stat">
          <span className="stat__label">Accounts</span>
          <span className="stat__value tnum">{formatInt(data.account_count)}</span>
          <span className="stat__meta">
            {enabledCount} enabled · {data.account_count - enabledCount} disabled
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">Actions today</span>
          <span className="stat__value tnum">{formatInt(totalToday)}</span>
          <span className="stat__meta">across all accounts</span>
        </div>
        <div className="stat">
          <span className="stat__label">Worker intent</span>
          <span className="stat__value">
            {data.worker.desired_state === 'running' ? 'Running' : 'Stopped'}
          </span>
          <span className="stat__meta">reported: {data.worker.reported_status}</span>
        </div>
      </div>

      <Card>
        <CardHead
          title="Worker status"
          description="Live heartbeat from the automation worker"
          actions={
            <Link to="/worker" className="btn btn--secondary btn--sm">
              <IconWorker size={15} /> Controls
            </Link>
          }
        />
        <CardBody>
          <WorkerTelemetry />
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Accounts"
          description="Per-account activity today"
          actions={
            <>
              <Link to="/accounts" className="btn btn--ghost btn--sm">
                View all
              </Link>
              <Link to="/accounts/new" className="btn btn--primary btn--sm">
                <IconPlus size={15} /> Add account
              </Link>
            </>
          }
        />
        <CardBody flush>
          {data.accounts.length === 0 ? (
            <EmptyState
              icon={<IconAccounts size={22} />}
              title="No accounts yet"
              description="Add your first automation account to get started."
              action={
                <Link to="/accounts/new" className="btn btn--primary btn--sm">
                  <IconPlus size={15} /> Add account
                </Link>
              }
            />
          ) : (
            <div>
              {data.accounts.map((a) => (
                <div className="acct-mini" key={a.id}>
                  <span className="acct-mini__name">
                    <Link to={`/accounts/${a.id}`}>{a.name}</Link>
                    {a.enabled ? (
                      <Badge tone="ok" dot>
                        Enabled
                      </Badge>
                    ) : (
                      <Badge tone="info">Disabled</Badge>
                    )}
                  </span>
                  <span className="acct-mini__count">
                    {formatInt(a.actions_today)} <span className="muted">today</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Recent activity" description="Latest actions across the fleet" />
        <CardBody>
          <Link to="/activity" className="btn btn--secondary btn--sm">
            <IconActivity size={15} /> Open activity feed
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}
