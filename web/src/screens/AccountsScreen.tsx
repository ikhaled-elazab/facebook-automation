/*
 * AccountsScreen.tsx — account list + delete.
 *
 *   GET    /api/accounts        → table (name, email, has_password, target,
 *                                 sendDmToCommenters, enabled status)
 *   DELETE /api/accounts/:id    → with an explicit confirm dialog
 *
 * Secrets are never shown — only the has_password boolean drives a "set/not set"
 * badge. Create + Edit route into the AccountEditorScreen.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAsync } from '../lib/useAsync';
import { errorMessage } from '../lib/format';
import { useToast } from '../components/Toast';
import {
  Card,
  CardBody,
  CardHead,
  EmptyState,
  ErrorState,
  LoadingState,
  Badge,
  Button,
  SafeUrl,
} from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IconAccounts, IconPlus, IconEdit, IconTrash, IconLock } from '../components/icons';
import type { Account } from '../api/types';

export function AccountsScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.accounts.list());
  const [pendingDelete, setPendingDelete] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.accounts.remove(pendingDelete.id);
      toast.success(`Deleted account "${pendingDelete.name}".`);
      setPendingDelete(null);
      await reload();
    } catch (err) {
      toast.error(`Could not delete account: ${errorMessage(err)}`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="page">
      <Card>
        <CardHead
          title="Accounts"
          description={data ? `${data.length} configured` : 'Automation accounts'}
          actions={
            <Link to="/accounts/new" className="btn btn--primary btn--sm">
              <IconPlus size={15} /> Add account
            </Link>
          }
        />
        <CardBody flush>
          {loading ? (
            <div className="card__body">
              <LoadingState label="Loading accounts…" />
            </div>
          ) : error ? (
            <div className="card__body">
              <ErrorState message={error} onRetry={reload} />
            </div>
          ) : !data || data.length === 0 ? (
            <EmptyState
              icon={<IconAccounts size={22} />}
              title="No accounts configured"
              description="Add your first automation account. You'll set its login, target page, and the comment/reply/DM content it uses."
              action={
                <Link to="/accounts/new" className="btn btn--primary btn--sm">
                  <IconPlus size={15} /> Add account
                </Link>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Target page</th>
                    <th>Credential</th>
                    <th>DM commenters</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.map((acct) => (
                    <tr key={acct.id}>
                      <td className="is-primary">
                        <Link to={`/accounts/${acct.id}`}>{acct.name}</Link>
                      </td>
                      <td className="mono truncate">{acct.email}</td>
                      <td>
                        <SafeUrl
                          className="mono truncate"
                          url={acct.target_page_url}
                          text={shortUrl(acct.target_page_url)}
                        />
                      </td>
                      <td>
                        {acct.has_password ? (
                          <Badge tone="ok">
                            <IconLock size={11} /> Set
                          </Badge>
                        ) : (
                          <Badge tone="warn">Not set</Badge>
                        )}
                      </td>
                      <td>
                        {acct.send_dm_to_commenters ? (
                          <Badge tone="accent" dot>
                            On
                          </Badge>
                        ) : (
                          <Badge tone="info">Off</Badge>
                        )}
                      </td>
                      <td>
                        {acct.enabled ? (
                          <Badge tone="ok" dot>
                            Enabled
                          </Badge>
                        ) : (
                          <Badge tone="info">Disabled</Badge>
                        )}
                      </td>
                      <td>
                        <div className="table__actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            aria-label={`Edit ${acct.name}`}
                            onClick={() => navigate(`/accounts/${acct.id}`)}
                          >
                            <IconEdit size={16} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            aria-label={`Delete ${acct.name}`}
                            onClick={() => setPendingDelete(acct)}
                          >
                            <IconTrash size={16} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete account?"
        destructive
        confirmLabel="Delete"
        loading={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        body={
          <span>
            This permanently deletes{' '}
            <strong className="mono">{pendingDelete?.name}</strong> and all its content
            (comments, replies, DM messages, groups) and runtime state. This cannot be undone.
          </span>
        }
      />
    </div>
  );
}

/** Compact a URL for table display (host + trimmed path). */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 24 ? u.pathname.slice(0, 24) + '…' : u.pathname;
    return u.host + (path === '/' ? '' : path) + (u.search ? '?…' : '');
  } catch {
    return url;
  }
}
