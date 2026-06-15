/*
 * AccountEditorScreen.tsx — create / edit an account ENVELOPE (v2 multi-branch).
 *
 * v2 split: this screen edits ONLY the account envelope — the identity, login,
 * browser fingerprint, proxy, account-ceiling cap, and enabled flag:
 *   core:        name, email, password (write-only), session_file
 *   proxy:       proxy_server, proxy_username, proxy_password (write-only)
 *   fingerprint: user_agent, locale, timezone_id
 *   pacing:      daily_action_cap (ACCOUNT CEILING), enabled
 *
 * All TARGETING and CONTENT (target page, DM identity, check cadence, per-branch
 * cap, comments/replies/dm/groups) moved to per-account Branches, managed by the
 * <BranchManager> below in EDIT mode. A branch needs a saved account to attach to,
 * so CREATE mode is envelope-only; after the account is created we land on its
 * edit screen where branches can be added.
 *
 * - Client validation mirrors zod for instant feedback; server 422 details[] are
 *   merged in as field errors; 409 (duplicate name) maps onto the name field.
 * - Secrets are WRITE-ONLY (SecretField) — only sent when (re)set.
 * - On save we render from the MUTATION RESPONSE (read-after-write).
 * - In CREATE mode, session_file auto-derives from the name (sessions/<name>.json)
 *   unless the operator overrides it in the Advanced section.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { ApiError } from '../api/ApiError';
import { useAsync } from '../lib/useAsync';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import { errorMessage, isEqualJson } from '../lib/format';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import {
  Button,
  Card,
  CardBody,
  CardHead,
  ErrorState,
  Field,
  LoadingState,
  Select,
  TextInput,
  Toggle,
} from '../components/ui';
import { BranchManager } from '../components/BranchManager';
import { SecretField } from '../components/SecretField';
import { IconChevronRight } from '../components/icons';
import type { Account, AccountCreateInput, AccountUpdateInput } from '../api/types';
import * as v from '../lib/validate';

// A common, sensible set of locales for the dropdown; timezone stays a text input
// so the user can type any IANA zone.
const LOCALES = ['en-US', 'en-GB', 'ar-EG', 'fr-FR', 'de-DE', 'es-ES', 'pt-BR'];

interface FormState {
  name: string;
  email: string;
  password: string; // write-only
  session_file: string;
  user_agent: string;
  locale: string;
  timezone_id: string;
  proxy_server: string;
  proxy_username: string;
  proxy_password: string; // write-only
  daily_action_cap: string; // '' = inherit global ceiling
  enabled: boolean;
  // Tracks whether session_file was hand-edited (stop auto-deriving from name).
  sessionTouched: boolean;
}

function emptyForm(): FormState {
  return {
    name: '',
    email: '',
    password: '',
    session_file: '',
    user_agent: '',
    locale: 'en-US',
    timezone_id: 'America/New_York',
    proxy_server: '',
    proxy_username: '',
    proxy_password: '',
    daily_action_cap: '',
    enabled: true,
    sessionTouched: false,
  };
}

function fromAccount(a: Account): FormState {
  return {
    name: a.name,
    email: a.email,
    password: '',
    session_file: a.session_file,
    user_agent: a.user_agent ?? '',
    locale: a.locale,
    timezone_id: a.timezone_id,
    proxy_server: a.proxy_server ?? '',
    proxy_username: a.proxy_username ?? '',
    proxy_password: '',
    daily_action_cap: a.daily_action_cap == null ? '' : String(a.daily_action_cap),
    enabled: a.enabled,
    sessionTouched: true, // existing value — never auto-overwrite
  };
}

/** Default session file derived from the account name. */
function deriveSessionFile(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return slug ? `sessions/${slug}.json` : '';
}

export function AccountEditorScreen({ mode }: { mode: 'create' | 'edit' }) {
  const navigate = useNavigate();
  const toast = useToast();
  const params = useParams();
  const accountId = mode === 'edit' ? Number(params.id) : null;

  // In edit mode, load the existing account envelope.
  const loaded = useAsync<Account | null>(
    () => (accountId ? api.accounts.get(accountId) : Promise.resolve(null)),
    [accountId]
  );

  return mode === 'edit' && loaded.loading ? (
    <LoadingState label="Loading account…" />
  ) : mode === 'edit' && loaded.error ? (
    <ErrorState message={loaded.error} onRetry={loaded.reload} />
  ) : (
    <EditorForm
      key={loaded.data?.id ?? 'new'}
      mode={mode}
      accountId={accountId}
      account={loaded.data ?? null}
      initial={loaded.data ? fromAccount(loaded.data) : emptyForm()}
      onCreated={(created) => {
        // A new account has no branches yet — land on its edit screen so the
        // operator can add the first targeting branch.
        toast.success(`Account "${created.name}" created. Add a branch to start targeting.`);
        navigate(`/accounts/${created.id}`);
      }}
      onUpdated={(saved) => {
        toast.success(`Account "${saved.name}" saved.`);
      }}
      onCancel={() => navigate('/accounts')}
    />
  );
}

interface EditorFormProps {
  mode: 'create' | 'edit';
  accountId: number | null;
  account: Account | null;
  initial: FormState;
  onCreated: (created: Account) => void;
  onUpdated: (saved: Account) => void;
  onCancel: () => void;
}

function EditorForm({
  mode,
  accountId,
  account,
  initial,
  onCreated,
  onUpdated,
  onCancel,
}: EditorFormProps) {
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<v.Errors>({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Unsaved-changes guard. `dirty` compares the live form to its initial snapshot,
  // ignoring the `sessionTouched` UI bookkeeping flag. While saving, treat as clean
  // so the post-save navigate isn't blocked. Branch edits manage their own guard.
  const dirty = !saving && !isEqualJson(formContent(form), formContent(initial));
  const guard = useUnsavedGuard(dirty);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'name' && mode === 'create' && !prev.sessionTouched) {
        next.session_file = deriveSessionFile(String(value));
      }
      return next;
    });
    setErrors((prev) => (prev[String(key)] ? omit(prev, String(key)) : prev));
  }

  const effectiveSessionFile = useMemo(
    () => form.session_file || deriveSessionFile(form.name),
    [form.session_file, form.name]
  );

  function validate(): v.Errors {
    const e: v.Errors = {};
    v.required(e, 'name', form.name, 'Name');
    v.maxLen(e, 'name', form.name, 256, 'Name');
    v.emailField(e, 'email', form.email);
    v.required(e, 'session_file', effectiveSessionFile, 'Session file');
    if (form.daily_action_cap.trim() !== '') {
      v.intRange(e, 'daily_action_cap', toIntOrNull(form.daily_action_cap), 0, 100000, 'Daily cap', {
        allowNull: false,
      });
    }
    if (mode === 'create' && !form.password) {
      e.password = 'A password is required to create an account.';
    }
    return e;
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (saving) return;
    setServerError(null);

    const clientErrors = validate();
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      focusFirstError(clientErrors);
      return;
    }

    setSaving(true);
    try {
      if (mode === 'create') {
        const created = await api.accounts.create(buildCreatePayload(form, effectiveSessionFile));
        onCreated(created);
      } else {
        const saved = await api.accounts.update(
          accountId as number,
          buildUpdatePayload(form, account)
        );
        // Re-snapshot so the form is no longer dirty after a successful save.
        setForm(fromAccount(saved));
        onUpdated(saved);
      }
    } catch (err) {
      handleServerError(err);
    } finally {
      setSaving(false);
    }
  }

  function handleServerError(err: unknown) {
    if (err instanceof ApiError) {
      if (err.isValidation) {
        setErrors((prev) => ({ ...prev, ...err.fieldErrors() }));
        setServerError('Some fields need attention — see the highlighted entries.');
        focusFirstError(err.fieldErrors());
        return;
      }
      if (err.isConflict) {
        setErrors((prev) => ({ ...prev, name: err.message }));
        setServerError(err.message);
        focusFirstError({ name: err.message });
        return;
      }
      setServerError(err.message);
      return;
    }
    setServerError(errorMessage(err));
  }

  return (
    <div className="page">
      <form onSubmit={onSubmit} noValidate>
        <Card>
          <CardHead
            title={mode === 'create' ? 'New account' : `Edit ${account?.name ?? 'account'}`}
            description="Account identity, login, and browser envelope. Targeting lives in branches."
          />
          <CardBody>
            <div className="form-section">
              <div className="section-label">Identity &amp; login</div>
              <div className="field-row field-row--2">
                <Field label="Name" htmlFor="f-name" required error={errors.name} hint="Unique label for this account.">
                  <TextInput
                    id="f-name"
                    value={form.name}
                    invalid={Boolean(errors.name)}
                    onChange={(e) => set('name', e.target.value)}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Email" htmlFor="f-email" required error={errors.email}>
                  <TextInput
                    id="f-email"
                    type="email"
                    value={form.email}
                    invalid={Boolean(errors.email)}
                    onChange={(e) => set('email', e.target.value)}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
              </div>
              <SecretField
                label="Facebook password"
                mode={mode}
                isSet={account?.has_password ?? false}
                value={form.password}
                onChange={(val) => set('password', val)}
                required={mode === 'create'}
                error={errors.password}
                autoComplete="new-password"
              />
            </div>

            <div className="form-section">
              <div className="section-label">Pacing</div>
              <Toggle
                checked={form.enabled}
                onChange={(val) => set('enabled', val)}
                label="Account enabled"
                description="When off, the worker skips this account and all its branches entirely."
              />
              <Field
                label="Account daily cap (ceiling)"
                htmlFor="f-cap"
                error={errors.daily_action_cap}
                hint="The maximum total actions/day across ALL branches. Leave blank to inherit the global cap. Each branch can set a lower cap of its own."
              >
                <TextInput
                  id="f-cap"
                  type="number"
                  min={0}
                  max={100000}
                  value={form.daily_action_cap}
                  invalid={Boolean(errors.daily_action_cap)}
                  onChange={(e) => set('daily_action_cap', e.target.value)}
                  placeholder="inherit global"
                />
              </Field>
            </div>

            {/* Advanced (proxy + fingerprint + session file) */}
            <details className="disclosure form-section">
              <summary className="disclosure__summary">
                <span className="disclosure__chevron" aria-hidden="true">
                  <IconChevronRight size={15} />
                </span>
                Advanced — proxy, fingerprint &amp; session
              </summary>
              <div className="disclosure__content">
                <div className="section-label">Proxy</div>
                <Field label="Proxy server" htmlFor="f-proxy" error={errors.proxy_server} hint="e.g. http://host:port — only used when proxy is enabled in Settings.">
                  <TextInput
                    id="f-proxy"
                    mono
                    value={form.proxy_server}
                    invalid={Boolean(errors.proxy_server)}
                    onChange={(e) => set('proxy_server', e.target.value)}
                    placeholder="http://host:port"
                  />
                </Field>
                <div className="field-row field-row--2">
                  <Field label="Proxy username" htmlFor="f-proxyuser" error={errors.proxy_username}>
                    <TextInput
                      id="f-proxyuser"
                      value={form.proxy_username}
                      invalid={Boolean(errors.proxy_username)}
                      onChange={(e) => set('proxy_username', e.target.value)}
                      autoComplete="off"
                    />
                  </Field>
                  <SecretField
                    label="Proxy password"
                    mode={mode}
                    isSet={account?.has_proxy_password ?? false}
                    value={form.proxy_password}
                    onChange={(val) => set('proxy_password', val)}
                    error={errors.proxy_password}
                    autoComplete="off"
                  />
                </div>

                <div className="section-label">Browser fingerprint</div>
                <Field label="User agent" htmlFor="f-ua" error={errors.user_agent}>
                  <TextInput
                    id="f-ua"
                    mono
                    value={form.user_agent}
                    invalid={Boolean(errors.user_agent)}
                    onChange={(e) => set('user_agent', e.target.value)}
                    placeholder="Mozilla/5.0 …"
                  />
                </Field>
                <div className="field-row field-row--2">
                  <Field label="Locale" htmlFor="f-locale" error={errors.locale}>
                    <Select
                      id="f-locale"
                      value={form.locale}
                      invalid={Boolean(errors.locale)}
                      onChange={(e) => set('locale', e.target.value)}
                    >
                      {LOCALES.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Timezone ID" htmlFor="f-tz" error={errors.timezone_id} hint="IANA tz, e.g. Africa/Cairo.">
                    <TextInput
                      id="f-tz"
                      mono
                      value={form.timezone_id}
                      invalid={Boolean(errors.timezone_id)}
                      onChange={(e) => set('timezone_id', e.target.value)}
                      placeholder="America/New_York"
                    />
                  </Field>
                </div>

                <div className="section-label">Session storage</div>
                <Field
                  label="Session file"
                  htmlFor="f-session"
                  required
                  error={errors.session_file}
                  hint="Playwright storage-state path. Auto-derived from the name; override only if needed."
                >
                  <TextInput
                    id="f-session"
                    mono
                    value={form.session_file || (mode === 'create' ? effectiveSessionFile : '')}
                    invalid={Boolean(errors.session_file)}
                    onChange={(e) => {
                      set('session_file', e.target.value);
                      setForm((p) => ({ ...p, sessionTouched: true }));
                    }}
                    placeholder="sessions/account.json"
                  />
                </Field>
              </div>
            </details>
          </CardBody>

          <div className="editor-bar">
            <span className="editor-bar__status">
              {serverError ? <span className="field__error">{serverError}</span> : ''}
            </span>
            <div className="page__actions">
              <Button
                variant="ghost"
                type="button"
                onClick={() => guard.attempt(onCancel)}
                disabled={saving}
              >
                {mode === 'create' ? 'Cancel' : 'Back to accounts'}
              </Button>
              <Button variant="primary" type="submit" loading={saving}>
                {mode === 'create' ? 'Create account' : 'Save account'}
              </Button>
            </div>
          </div>
        </Card>
      </form>

      {/* Branch management — only once the account exists (a branch needs a parent). */}
      {mode === 'edit' && accountId != null && (
        <BranchManager accountId={accountId} accountName={account?.name ?? 'account'} />
      )}

      <ConfirmDialog
        open={guard.promptOpen}
        title="Discard unsaved changes?"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        destructive
        onConfirm={guard.confirm}
        onCancel={guard.cancel}
        body="You have unsaved changes to this account. If you leave now, they will be lost."
      />
    </div>
  );
}

/**
 * Project the form to just its user-content fields for dirty comparison — drops
 * the `sessionTouched` UI bookkeeping flag (toggling it is not a content edit).
 */
function formContent(f: FormState): Omit<FormState, 'sessionTouched'> {
  const { sessionTouched: _sessionTouched, ...content } = f;
  return content;
}

// ── payload builders ──────────────────────────────────────────────────────--

function buildCreatePayload(form: FormState, sessionFile: string): AccountCreateInput {
  const payload: AccountCreateInput = {
    name: form.name.trim(),
    email: form.email.trim(),
    session_file: sessionFile,
    enabled: form.enabled,
    locale: form.locale,
    timezone_id: form.timezone_id.trim(),
    user_agent: blankToNull(form.user_agent),
    proxy_server: blankToNull(form.proxy_server),
    proxy_username: blankToNull(form.proxy_username),
    daily_action_cap: form.daily_action_cap.trim() === '' ? null : toIntOrNull(form.daily_action_cap),
  };
  if (form.password) payload.password = form.password;
  if (form.proxy_password) payload.proxy_password = form.proxy_password;
  return payload;
}

function buildUpdatePayload(form: FormState, account: Account | null): AccountUpdateInput {
  const patch: AccountUpdateInput = {
    name: form.name.trim(),
    email: form.email.trim(),
    session_file: form.session_file.trim() || deriveSessionFile(form.name),
    enabled: form.enabled,
    locale: form.locale,
    timezone_id: form.timezone_id.trim(),
    user_agent: blankToNull(form.user_agent),
    proxy_server: blankToNull(form.proxy_server),
    proxy_username: blankToNull(form.proxy_username),
    daily_action_cap: form.daily_action_cap.trim() === '' ? null : toIntOrNull(form.daily_action_cap),
  };
  // `account` is read to keep the signature symmetric with the branch editor and
  // available for future field-level diffing; secrets remain write-only below.
  void account;
  if (form.password) patch.password = form.password;
  if (form.proxy_password) patch.proxy_password = form.proxy_password;
  return patch;
}

// ── small pure helpers ─────────────────────────────────────────────────────--

function toIntOrNull(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : Number.isNaN(n) ? null : Math.trunc(n);
}

function blankToNull(s: string): string | null {
  const t = s.trim();
  return t === '' ? null : t;
}

function omit<T extends Record<string, unknown>>(obj: T, key: string): T {
  const next = { ...obj };
  delete next[key];
  return next;
}

/** Focus the first field that has an error, for keyboard + screen-reader users. */
function focusFirstError(errors: v.Errors) {
  const first = Object.keys(errors)[0];
  if (!first) return;
  const idMap: Record<string, string> = {
    name: 'f-name',
    email: 'f-email',
    daily_action_cap: 'f-cap',
    session_file: 'f-session',
    proxy_server: 'f-proxy',
    timezone_id: 'f-tz',
    user_agent: 'f-ua',
  };
  const id = idMap[first];
  if (id) {
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      el?.focus();
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
}
