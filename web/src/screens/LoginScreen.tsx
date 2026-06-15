/*
 * LoginScreen.tsx — POST /api/auth/login (with CSRF).
 *
 * Handles: invalid credentials (401), rate-limit (429), network failure, and the
 * expired-session case (arrived here because a prior session timed out). User
 * input is preserved across every error — the password is only ever cleared on a
 * deliberate successful login. The CSRF token is pre-fetched on mount so the
 * first submit doesn't pay a round-trip.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { api } from '../api/client';
import { ApiError } from '../api/ApiError';
import { Button, Field, TextInput } from '../components/ui';
import { IconLock, IconAlert } from '../components/icons';

export function LoginScreen() {
  const { login, expired } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const userId = useId();
  const passId = useId();
  const userRef = useRef<HTMLInputElement>(null);

  // Pre-fetch a CSRF token + establish the bootstrap session so the first login
  // POST already has a valid token. Failures are non-fatal (the submit retries).
  useEffect(() => {
    void api.auth.csrf().catch(() => {
      /* surfaced on submit if still failing */
    });
    userRef.current?.focus();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);

    if (!username.trim() || !password) {
      setFormError('Enter both your username and password.');
      return;
    }

    setSubmitting(true);
    try {
      await login(username.trim(), password);
      // On success the router redirects (status flips to authenticated).
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.isRateLimited) {
          setFormError('Too many attempts. Please wait a few minutes and try again.');
        } else if (err.isAuth) {
          setFormError('Invalid username or password.');
        } else if (err.isNetwork) {
          setFormError('Cannot reach the control plane. Is it running?');
        } else {
          setFormError(err.message);
        }
      } else {
        setFormError('An unexpected error occurred. Please try again.');
      }
      // Preserve the username; clear only the password for a clean retry.
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login">
      <div className="login__panel">
        <div className="login__brand">
          <div className="login__mark" aria-hidden="true">
            FB
          </div>
          <div>
            <h1 className="login__title">Automation Console</h1>
            <p className="login__sub">Local control plane · sign in to continue</p>
          </div>
        </div>

        {expired && (
          <div className="login__notice" role="status">
            <IconAlert size={15} />
            <span>Your session expired. Please sign in again.</span>
          </div>
        )}

        <form className="login__form" onSubmit={onSubmit} noValidate>
          <Field label="Username" htmlFor={userId} required>
            <TextInput
              id={userId}
              ref={userRef}
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>

          <Field label="Password" htmlFor={passId} required>
            <TextInput
              id={passId}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </Field>

          {formError && (
            <p className="login__error" role="alert">
              <IconAlert size={14} /> {formError}
            </p>
          )}

          <Button type="submit" variant="primary" block loading={submitting}>
            <IconLock size={16} /> Sign in
          </Button>
        </form>

        <p className="login__foot">
          Reached over an SSH tunnel · loopback only · credentials never leave this host
        </p>
      </div>
    </div>
  );
}
