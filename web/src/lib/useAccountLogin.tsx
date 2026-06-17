/*
 * useAccountLogin — per-account Facebook login flow (launch → poll → 2FA relay).
 *
 * Model A: the account already holds an encrypted password (set via the account
 * editor's write-only field). This hook drives the runtime login: it asks the
 * server to launch a headless login, then polls status until the flow reaches a
 * terminal state (ok | failed) or parks at needs_2fa awaiting a code the operator
 * types in the UI.
 *
 * One flow per account at a time. The server enforces this (409 on a concurrent
 * launch); we surface that cleanly rather than spawning a second poller.
 *
 * Polling hygiene mirrors useWorkerStatus:
 *   - polls ONLY while running | needs_2fa (terminal states stop the timer);
 *   - a single in-flight guard prevents overlapping reads;
 *   - the tab being hidden pauses polling (resumes on visibility);
 *   - unmount clears the timer + listener.
 *
 * SECURITY: the stored password never touches this surface. The 2FA code is
 * transient — held in component state only, POSTed once, never logged or
 * persisted. The hook does not console.log codes or credentials.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { ApiError } from '../api/ApiError';
import { errorMessage } from './format';
import type { LoginMode, LoginSessionView, LoginStatus } from '../api/types';

const POLL_MS = 2000;

/** Terminal states stop polling; the flow is over until re-launched. */
function isTerminal(status: LoginStatus): boolean {
  return status === 'ok' || status === 'failed';
}

/** Active states keep the poller alive. */
function isActive(status: LoginStatus): boolean {
  // needs_manual is active too: a headed browser is open and we must keep polling
  // until the operator finishes (the flow flips to ok) or it times out (failed).
  return status === 'running' || status === 'needs_2fa' || status === 'needs_manual';
}

export interface AccountLoginState {
  status: LoginStatus;
  /** Human reason from the server (failure cause / "check your phone"). */
  detail: string | null;
  /** A launch POST is in flight (button shows a spinner; not yet polling). */
  launching: boolean;
  /** A 2FA submit is in flight. */
  submitting2fa: boolean;
  /** Transport / 409 / unexpected error surfaced to the row (not a field error). */
  error: string | null;
  /** Start (or restart) a login for this account. Pass 'manual' for the headed,
   * human-driven flow (OTP / QR / push); omit (or 'auto') for the headless form. */
  launch: (mode?: LoginMode) => Promise<void>;
  /** Submit a 2FA code mid-flow; resumes polling on success. */
  submit2fa: (code: string) => Promise<void>;
  /** Clear a surfaced error (e.g. when the operator edits the 2FA input). */
  clearError: () => void;
}

export function useAccountLogin(accountId: number): AccountLoginState {
  const [status, setStatus] = useState<LoginStatus>('idle');
  const [detail, setDetail] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [submitting2fa, setSubmitting2fa] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  // The status the poll loop reads, kept in a ref so the loop never goes stale
  // without re-subscribing the effect every state change.
  const statusRef = useRef<LoginStatus>('idle');
  statusRef.current = status;

  // The client unwraps { login } → LoginSessionView, so callers (and this hook)
  // read status/detail directly off the view.
  const apply = useCallback((view: LoginSessionView) => {
    if (!mounted.current) return;
    setStatus(view.status);
    setDetail(view.detail);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const stopTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    if (!isActive(statusRef.current)) return;
    inFlight.current = true;
    try {
      const res = await api.login.status(accountId);
      apply(res);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.isAuth) return; // global redirect handles it
      // A transient poll failure should not nuke the flow — surface it but keep
      // the last known status so the operator can retry.
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
    }
  }, [accountId, apply]);

  // Drive the poll loop while the flow is active. Re-arms whenever `status` flips
  // between active states; tears down on terminal/idle and on unmount.
  useEffect(() => {
    if (!isActive(status)) {
      stopTimer();
      return;
    }
    const schedule = () => {
      timer.current = setTimeout(async () => {
        if (document.visibilityState === 'visible') {
          await poll();
        }
        if (mounted.current && isActive(statusRef.current)) schedule();
      }, POLL_MS);
    };
    schedule();

    const onVisible = () => {
      if (document.visibilityState === 'visible' && isActive(statusRef.current)) {
        void poll();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopTimer();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status, poll, stopTimer]);

  // Track mount once, for async guards.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopTimer();
    };
  }, [stopTimer]);

  // On mount, sync with the server's CURRENT login-flow status ONCE. Without this
  // the hook starts at 'idle' and only polls while already active, so a page
  // refresh would drop an in-progress login (running / needs_2fa / needs_manual)
  // from the UI even though it is still live server-side. The durable "logged in"
  // badge comes from account.has_session; this effect resumes an ACTIVE flow (and
  // re-arms the poller via the status-driven effect above when the view is active).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.login.status(accountId);
        if (!cancelled) apply(res);
      } catch {
        // Ignore — the baseline still renders from account.has_session, and the
        // operator can relaunch. A transient read must not surface as a flow error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, apply]);

  const launch = useCallback(
    async (mode?: LoginMode) => {
      if (launching || isActive(statusRef.current)) return;
      setError(null);
      setDetail(null);
      setLaunching(true);
      try {
        const res = await api.login.launch(accountId, mode);
        apply(res);
      } catch (err) {
        if (err instanceof ApiError && err.isAuth) return;
        if (err instanceof ApiError && err.isConflict) {
          // Server already has a login session for this account. Switch to polling
          // the existing flow rather than reporting a hard failure.
          setError('A login is already running for this account — showing its progress.');
          setStatus('running');
          return;
        }
        setError(errorMessage(err));
      } finally {
        if (mounted.current) setLaunching(false);
      }
    },
    [accountId, apply, launching]
  );

  const submit2fa = useCallback(
    async (code: string) => {
      if (submitting2fa) return;
      setError(null);
      setSubmitting2fa(true);
      try {
        const res = await api.login.submit2fa(accountId, code);
        apply(res);
      } catch (err) {
        if (err instanceof ApiError && err.isAuth) return;
        // Keep status at needs_2fa so the operator can re-enter the code; the input
        // value is preserved by the caller (never cleared on a failed submit).
        setError(errorMessage(err));
      } finally {
        if (mounted.current) setSubmitting2fa(false);
      }
    },
    [accountId, apply, submitting2fa]
  );

  return {
    status,
    detail,
    launching,
    submitting2fa,
    error,
    launch,
    submit2fa,
    clearError,
  };
}

/** Re-export for callers that branch on terminal vs active state. */
export { isTerminal as isLoginTerminal, isActive as isLoginActive };
