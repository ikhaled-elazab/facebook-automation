/*
 * ActivityScreen.tsx — the action_log feed (GET /api/status/events).
 *
 * FEED CONTRACT (server/routes/status.js):
 *   { events, total, has_more, next_before } ; query: limit, account_id, before.
 *   - page 1: omit `before`.
 *   - older:  pass before = next_before until has_more is false.
 *
 * Supports an account filter (loaded from /api/status) and a manual refresh.
 * "Load older" appends the next page; the filter resets the feed. Events are
 * newest-first.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { ApiError } from '../api/ApiError';
import { errorMessage, relativeTime, absoluteTime } from '../lib/format';
import {
  Button,
  Card,
  CardBody,
  CardHead,
  EmptyState,
  ErrorState,
  LoadingState,
  Badge,
  Select,
  SafeUrl,
} from '../components/ui';
import { IconActivity, IconRefresh, IconInbox } from '../components/icons';
import type { ActionLogEvent, StatusAccountSummary } from '../api/types';

type StatusTone = 'ok' | 'warn' | 'danger' | 'info' | 'accent';

const STATUS_TONE: Record<string, StatusTone> = {
  ok: 'ok',
  failed: 'danger',
  skipped: 'warn',
};

const PAGE_SIZE = 50;

export function ActivityScreen() {
  const [accounts, setAccounts] = useState<StatusAccountSummary[]>([]);
  const [accountId, setAccountId] = useState<number | 'all'>('all');

  const [events, setEvents] = useState<ActionLogEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  // Load the account list once (for the filter dropdown).
  useEffect(() => {
    mounted.current = true;
    api.status
      .overview()
      .then((s) => {
        if (mounted.current) setAccounts(s.accounts);
      })
      .catch(() => {
        /* filter is optional; ignore */
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  // (Re)load page 1 whenever the account filter changes.
  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.status.events({
        limit: PAGE_SIZE,
        account_id: accountId === 'all' ? undefined : accountId,
      });
      if (!mounted.current) return;
      setEvents(page.events);
      setTotal(page.total);
      setHasMore(page.has_more);
      setNextBefore(page.next_before);
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) return;
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  async function loadOlder() {
    if (loadingMore || nextBefore == null) return;
    setLoadingMore(true);
    try {
      const page = await api.status.events({
        limit: PAGE_SIZE,
        account_id: accountId === 'all' ? undefined : accountId,
        before: nextBefore,
      });
      if (!mounted.current) return;
      setEvents((prev) => [...prev, ...page.events]);
      setHasMore(page.has_more);
      setNextBefore(page.next_before);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }

  const accountName = useCallback(
    (id: number | null): string => {
      if (id == null) return 'system';
      return accounts.find((a) => a.id === id)?.name ?? `#${id}`;
    },
    [accounts]
  );

  return (
    <div className="page">
      <Card>
        <CardHead
          title="Activity"
          description={loading ? 'Loading…' : `${total} event${total === 1 ? '' : 's'}`}
          actions={
            <div className="filter-bar">
              <Select
                aria-label="Filter by account"
                value={accountId === 'all' ? 'all' : String(accountId)}
                onChange={(e) =>
                  setAccountId(e.target.value === 'all' ? 'all' : Number(e.target.value))
                }
              >
                <option value="all">All accounts</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              <Button variant="ghost" size="sm" onClick={() => void loadFirst()} loading={loading}>
                <IconRefresh size={15} /> Refresh
              </Button>
            </div>
          }
        />
        <CardBody flush>
          {loading ? (
            <div className="card__body">
              <LoadingState label="Loading activity…" />
            </div>
          ) : error ? (
            <div className="card__body">
              <ErrorState message={error} onRetry={loadFirst} />
            </div>
          ) : events.length === 0 ? (
            <EmptyState
              icon={<IconInbox size={22} />}
              title="No activity yet"
              description={
                accountId === 'all'
                  ? 'Once the worker runs, every like, comment, share, and DM appears here.'
                  : 'No recorded actions for this account yet.'
              }
            />
          ) : (
            <>
              <div className="feed">
                {events.map((ev) => (
                  <div className="feed__row" key={ev.id}>
                    <span className="feed__type">
                      <Badge tone={STATUS_TONE[ev.status] ?? 'info'} dot>
                        {ev.action_type}
                      </Badge>
                    </span>
                    <div className="feed__detail">
                      <span className="feed__detail-main">
                        <strong>{accountName(ev.account_id)}</strong>
                        {ev.status !== 'ok' && (
                          <>
                            {' · '}
                            <span className="muted">{ev.status}</span>
                          </>
                        )}
                        {ev.detail ? ` — ${ev.detail}` : ''}
                      </span>
                      {ev.target_url && (
                        <SafeUrl className="feed__detail-sub truncate" url={ev.target_url} />
                      )}
                    </div>
                    <time
                      className="feed__time"
                      dateTime={ev.created_at}
                      title={absoluteTime(ev.created_at)}
                    >
                      {relativeTime(ev.created_at)}
                    </time>
                  </div>
                ))}
              </div>
              {hasMore && (
                <div className="feed__load">
                  <Button variant="secondary" size="sm" onClick={loadOlder} loading={loadingMore}>
                    <IconActivity size={15} /> Load older
                  </Button>
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
