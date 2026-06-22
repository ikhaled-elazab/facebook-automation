/*
 * AccountsScreen.tsx — account list + delete + per-account login (v2 multi-branch).
 *
 *   GET    /api/accounts        → table (name, email, has_password, branch count,
 *                                 enabled status, live login state)
 *   DELETE /api/accounts/:id    → with an explicit confirm dialog
 *
 * Secrets are never shown — only the has_password boolean drives a "set/not set"
 * badge. Targeting now lives in branches, so the row shows a branch-count badge
 * (from account.branch_count) instead of a single target URL. Create + Edit route
 * into the AccountEditorScreen.
 *
 * Per-account login (Model A): each row carries a Login control that launches a
 * headless Facebook login using the account's stored (encrypted) password, polls
 * its status, and — when Facebook challenges — reveals a 2FA code input the
 * operator fills in to resume the flow. Login is ACCOUNT-level (one envelope = one
 * session), not per-branch. See <LoginCell>.
 */
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAsync } from '../lib/useAsync';
import { useAccountLogin } from '../lib/useAccountLogin';
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
  Field,
  TextInput,
} from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  IconAccounts,
  IconPlus,
  IconEdit,
  IconTrash,
  IconLock,
  IconInbox,
  IconPlay,
  IconRefresh,
  IconCheck,
  IconAlert,
  IconTerminal,
  IconX,
} from '../components/icons';
import { RemoteBrowser } from '../components/RemoteBrowser';
import type { Account, LoginStatus } from '../api/types';

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
                    <th>Branches</th>
                    <th>Credential</th>
                    <th>Status</th>
                    <th>Login</th>
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
                        <Badge tone={acct.branch_count > 0 ? 'accent' : 'warn'}>
                          <IconInbox size={11} />{' '}
                          {acct.branch_count} {acct.branch_count === 1 ? 'branch' : 'branches'}
                        </Badge>
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
                        {acct.enabled ? (
                          <Badge tone="ok" dot>
                            Enabled
                          </Badge>
                        ) : (
                          <Badge tone="info">Disabled</Badge>
                        )}
                      </td>
                      <td>
                        <LoginCell account={acct} />
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

// ── Per-account login control ─────────────────────────────────────────────────
//
// Owns ONE login flow for ONE account: launch → poll → (optional 2FA) → terminal.
// The poller + state live in useAccountLogin; this component renders the status,
// the Login/Retry button, and the 2FA relay input when the flow parks at
// needs_2fa. Each row mounts its own LoginCell, so unmounting (e.g. on delete or
// navigation) tears down that account's poller cleanly.

const LOGIN_BADGE: Record<LoginStatus, { tone: 'ok' | 'warn' | 'danger' | 'info' | 'accent'; label: string }> = {
  idle: { tone: 'info', label: 'Not logged in' },
  running: { tone: 'accent', label: 'Logging in…' },
  needs_2fa: { tone: 'warn', label: 'Needs 2FA code' },
  // A headed browser is open and the operator must finish login in it (OTP / QR /
  // approve). The surface that lets them do so (instructions now, embedded stream
  // later) is layered on top; the badge just reflects the parked state.
  needs_manual: { tone: 'warn', label: 'Finish in browser' },
  ok: { tone: 'ok', label: 'Logged in' },
  failed: { tone: 'danger', label: 'Login failed' },
};

function LoginCell({ account }: { account: Account }) {
  const login = useAccountLogin(account.id);
  const { status, detail, launching, cancelling, error } = login;
  // The remote-browser modal can be dismissed without ending the (server-side)
  // login; a new manual launch re-opens it. It only renders while needs_manual.
  const [browserDismissed, setBrowserDismissed] = useState(false);

  // The durable "logged in" state comes from the saved session FILE
  // (account.has_session) — it survives a page refresh AND a server restart, unlike
  // the in-memory login-attempt `status`. The live flow status overlays the baseline
  // during/after an attempt; when the flow is idle but a session exists, show
  // "Logged in" rather than reverting to "Not logged in".
  const effectiveStatus = status === 'idle' && account.has_session ? 'ok' : status;
  const badge = LOGIN_BADGE[effectiveStatus];
  // Both launches are blocked while a flow is active or a launch is in flight. The
  // QUICK (auto) login additionally needs a stored password; the IN-BROWSER (manual)
  // login does not — the operator types/scans/approves in the streamed browser.
  const active = status === 'running' || status === 'needs_2fa' || status === 'needs_manual';
  const busy = active || launching;
  const canQuickLaunch = !busy && account.has_password;
  const isRetry = status === 'failed';

  function launchInBrowser() {
    setBrowserDismissed(false);
    void login.launch('manual');
  }

  return (
    <div className="login-cell">
      <div className="login-cell__row">
        <Badge tone={badge.tone} dot={effectiveStatus === 'running'}>
          {effectiveStatus === 'ok' && <IconCheck size={11} />}
          {effectiveStatus === 'failed' && <IconAlert size={11} />}
          {badge.label}
        </Badge>

        <div className="login-cell__actions">
          {account.has_password && (
            <Button
              variant={isRetry ? 'secondary' : 'primary'}
              size="sm"
              type="button"
              loading={launching}
              disabled={!canQuickLaunch}
              onClick={() => void login.launch()}
              aria-label={isRetry ? `Retry quick login for ${account.name}` : `Quick log in ${account.name}`}
            >
              {isRetry ? <IconRefresh size={14} /> : <IconPlay size={14} />}
              {isRetry ? 'Retry' : busy ? 'Logging in…' : 'Quick login'}
            </Button>
          )}

          {/* In-browser (manual) login — works WITHOUT a stored password and is the
              path for OTP / QR scan / push-approve. Opens the streamed remote browser. */}
          <Button
            variant={account.has_password ? 'ghost' : 'primary'}
            size="sm"
            type="button"
            disabled={busy}
            onClick={launchInBrowser}
            aria-label={`Log in ${account.name} in a remote browser`}
            title="Open a real browser you drive from here — for codes, QR scan, or phone approval"
          >
            <IconTerminal size={14} /> Log in in browser
          </Button>

          {/* Cancel — only while a login is in flight (running / needs 2FA / finish
              in browser). Aborts the server-side flow (closes the browser, no orphan)
              and frees the account to be relaunched immediately. */}
          {active && (
            <Button
              variant="danger"
              size="sm"
              type="button"
              loading={cancelling}
              disabled={cancelling}
              onClick={() => void login.cancel()}
              aria-label={`Cancel login for ${account.name}`}
              title="Stop this login attempt"
            >
              <IconX size={14} /> Cancel
            </Button>
          )}
        </div>
      </div>

      {!account.has_password && status === 'idle' && (
        <span className="login-cell__hint">
          <IconLock size={12} /> No saved password — use “Log in in browser”, or set a password for quick login.
        </span>
      )}

      {/* Mid-flow 2FA relay — revealed only when the server parks at needs_2fa. */}
      {status === 'needs_2fa' && <TwoFactorRelay login={login} accountName={account.name} />}

      {/* Remote browser — shown while the manual login is parked at needs_manual. */}
      {status === 'needs_manual' && !browserDismissed && (
        <RemoteBrowser
          accountId={account.id}
          accountName={account.name}
          detail={detail}
          onClose={() => setBrowserDismissed(true)}
        />
      )}

      {/* A failure reason or a server prompt (e.g. "check your phone"). */}
      {detail && (status === 'failed' || status === 'needs_2fa') && (
        <p className={`login-cell__detail${status === 'failed' ? ' login-cell__detail--error' : ''}`}>
          {detail}
        </p>
      )}

      {/* Transient transport / 409 error, distinct from the flow status. */}
      {error && (
        <p className="login-cell__detail login-cell__detail--error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ── 2FA relay input ───────────────────────────────────────────────────────────
//
// Numeric code entry shown while the login is parked at needs_2fa. The typed code
// is transient (component state only), preserved across a failed submit so the
// operator can correct a typo, and cleared once submitted successfully (the flow
// leaves needs_2fa). SECURITY: never logged, never persisted.

function TwoFactorRelay({
  login,
  accountName,
}: {
  login: ReturnType<typeof useAccountLogin>;
  accountName: string;
}) {
  const [code, setCode] = useState('');
  const inputId = useId();
  const { submitting2fa } = login;
  // Mirror common authenticator/SMS code lengths; the server is authoritative.
  const trimmed = code.trim();
  const valid = /^\d{4,8}$/.test(trimmed);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting2fa || !valid) return;
    await login.submit2fa(trimmed);
    // On success the flow leaves needs_2fa and this component unmounts; if it
    // failed, keep the code so the operator can correct it (do NOT clear here).
  }

  return (
    <form className="login-cell__twofa" onSubmit={onSubmit} noValidate>
      <Field label={`2FA code for ${accountName}`} htmlFor={inputId} hint="Enter the code from SMS or your authenticator app.">
        <div className="row row-2">
          <TextInput
            id={inputId}
            grow
            mono
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d*"
            maxLength={8}
            placeholder="123456"
            onChange={(e) => {
              // Keep digits only; strip spaces/dashes the operator might paste.
              setCode(e.target.value.replace(/[^\d]/g, ''));
              if (login.error) login.clearError();
            }}
          />
          <Button variant="primary" size="sm" type="submit" loading={submitting2fa} disabled={!valid}>
            Submit code
          </Button>
        </div>
      </Field>
    </form>
  );
}
