/*
 * AccountEditorScreen.tsx — create / edit an account (ALL fields).
 *
 * Covers every account field from server/schemas.js:
 *   core: name, email, password (write-only), session_file, target_page_url
 *   identity: own_profile_url, dm_as_page_url, send_dm_to_commenters
 *   fingerprint: user_agent, locale, timezone_id, check_interval_minutes
 *   proxy: proxy_server, proxy_username, proxy_password (write-only)
 *   pacing: daily_action_cap (per-account override), enabled
 *   children: comments[], replies[], dm_messages[], groups[]
 *
 * - Client validation mirrors zod for instant feedback; server 422 details[] are
 *   merged in as field errors; 409 (duplicate name) maps onto the name field.
 * - Secrets are WRITE-ONLY (SecretField) — only sent when (re)set.
 * - On save we render from the MUTATION RESPONSE (read-after-write).
 * - In CREATE mode, session_file auto-derives from the name (sessions/<name>.json)
 *   unless the operator overrides it in the Advanced section — the API requires
 *   it but a user shouldn't need to understand Playwright storage files.
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
import { ListEditor } from '../components/ListEditor';
import { SecretField } from '../components/SecretField';
import { IconChevronRight } from '../components/icons';
import type { AccountWithChildren, AccountCreateInput, AccountUpdateInput } from '../api/types';
import * as v from '../lib/validate';

// A common, sensible set of locales/timezones for the dropdowns; the user can
// always type a custom value (the timezone field stays a text input).
const LOCALES = ['en-US', 'en-GB', 'ar-EG', 'fr-FR', 'de-DE', 'es-ES', 'pt-BR'];

interface FormState {
  name: string;
  email: string;
  password: string; // write-only
  session_file: string;
  target_page_url: string;
  own_profile_url: string;
  dm_as_page_url: string;
  send_dm_to_commenters: boolean;
  user_agent: string;
  locale: string;
  timezone_id: string;
  check_interval_minutes: string; // text in the input; coerced on submit
  proxy_server: string;
  proxy_username: string;
  proxy_password: string; // write-only
  daily_action_cap: string; // '' = inherit global
  enabled: boolean;
  comments: string[];
  replies: string[];
  dm_messages: string[];
  groups: string[];
  // Tracks whether session_file was hand-edited (stop auto-deriving from name).
  sessionTouched: boolean;
}

function emptyForm(): FormState {
  return {
    name: '',
    email: '',
    password: '',
    session_file: '',
    target_page_url: '',
    own_profile_url: '',
    dm_as_page_url: '',
    send_dm_to_commenters: false,
    user_agent: '',
    locale: 'en-US',
    timezone_id: 'America/New_York',
    check_interval_minutes: '7',
    proxy_server: '',
    proxy_username: '',
    proxy_password: '',
    daily_action_cap: '',
    enabled: true,
    comments: [],
    replies: [],
    dm_messages: [],
    groups: [],
    sessionTouched: false,
  };
}

function fromAccount(a: AccountWithChildren): FormState {
  return {
    name: a.name,
    email: a.email,
    password: '',
    session_file: a.session_file,
    target_page_url: a.target_page_url,
    own_profile_url: a.own_profile_url ?? '',
    dm_as_page_url: a.dm_as_page_url ?? '',
    send_dm_to_commenters: a.send_dm_to_commenters,
    user_agent: a.user_agent ?? '',
    locale: a.locale,
    timezone_id: a.timezone_id,
    check_interval_minutes: String(a.check_interval_minutes),
    proxy_server: a.proxy_server ?? '',
    proxy_username: a.proxy_username ?? '',
    proxy_password: '',
    daily_action_cap: a.daily_action_cap == null ? '' : String(a.daily_action_cap),
    enabled: a.enabled,
    comments: a.comments,
    replies: a.replies,
    dm_messages: a.dm_messages,
    groups: a.groups,
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

  // In edit mode, load the existing account (with children).
  const loaded = useAsync<AccountWithChildren | null>(
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
      onSaved={(saved) => {
        toast.success(
          mode === 'create' ? `Account "${saved.name}" created.` : `Account "${saved.name}" saved.`
        );
        navigate('/accounts');
      }}
      onCancel={() => navigate('/accounts')}
    />
  );
}

interface EditorFormProps {
  mode: 'create' | 'edit';
  accountId: number | null;
  account: AccountWithChildren | null;
  initial: FormState;
  onSaved: (saved: AccountWithChildren) => void;
  onCancel: () => void;
}

function EditorForm({ mode, accountId, account, initial, onSaved, onCancel }: EditorFormProps) {
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<v.Errors>({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Unsaved-changes guard. `dirty` compares the live form to its initial snapshot,
  // ignoring the `sessionTouched` UI bookkeeping flag (not user content). While
  // saving, treat as clean so the post-save navigate isn't blocked.
  const dirty = !saving && !isEqualJson(formContent(form), formContent(initial));
  const guard = useUnsavedGuard(dirty);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // Auto-derive session_file from name in create mode until hand-edited.
      if (key === 'name' && mode === 'create' && !prev.sessionTouched) {
        next.session_file = deriveSessionFile(String(value));
      }
      return next;
    });
    // Clear the error for a field as soon as the user edits it.
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
    v.urlField(e, 'target_page_url', form.target_page_url, 'Target page URL');
    v.urlField(e, 'own_profile_url', form.own_profile_url, 'Own profile URL', { allowEmpty: true });
    v.urlField(e, 'dm_as_page_url', form.dm_as_page_url, 'DM-as-page URL', { allowEmpty: true });
    v.required(e, 'session_file', effectiveSessionFile, 'Session file');
    v.intRange(
      e,
      'check_interval_minutes',
      toIntOrNull(form.check_interval_minutes),
      1,
      1440,
      'Check interval'
    );
    if (form.daily_action_cap.trim() !== '') {
      v.intRange(e, 'daily_action_cap', toIntOrNull(form.daily_action_cap), 0, 100000, 'Daily cap', {
        allowNull: false,
      });
    }
    // Password required only on create.
    if (mode === 'create' && !form.password) {
      e.password = 'A password is required to create an account.';
    }
    // Child collections: zod rejects empty strings — flag any blank rows.
    for (const field of ['comments', 'replies', 'dm_messages', 'groups'] as const) {
      form[field].forEach((item, i) => {
        if (!item.trim()) e[`${field}.${i}`] = 'Empty entries are not allowed — remove or fill it.';
        if (field === 'groups' && item.trim() && !isUrlSafe(item)) {
          e[`${field}.${i}`] = 'Must be a valid URL.';
        }
      });
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
      const saved =
        mode === 'create'
          ? await api.accounts.create(buildCreatePayload(form, effectiveSessionFile))
          : await api.accounts.update(accountId as number, buildUpdatePayload(form, account));
      onSaved(saved);
    } catch (err) {
      handleServerError(err);
    } finally {
      setSaving(false);
    }
  }

  function handleServerError(err: unknown) {
    if (err instanceof ApiError) {
      if (err.isValidation) {
        // Merge field-level server issues (snake_case paths line up with our keys;
        // child paths like "comments.0" map onto our `${field}.${i}` keys too).
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
    <form className="page" onSubmit={onSubmit} noValidate>
      <Card>
        <CardHead
          title={mode === 'create' ? 'New account' : `Edit ${account?.name ?? 'account'}`}
          description="All fields the worker uses for this account"
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
            <div className="section-label">Targets</div>
            <Field
              label="Target page URL"
              htmlFor="f-target"
              required
              error={errors.target_page_url}
              hint="The Facebook page/profile this account monitors."
            >
              <TextInput
                id="f-target"
                mono
                value={form.target_page_url}
                invalid={Boolean(errors.target_page_url)}
                onChange={(e) => set('target_page_url', e.target.value)}
                placeholder="https://www.facebook.com/…"
              />
            </Field>
            <div className="field-row field-row--2">
              <Field label="Own profile URL" htmlFor="f-own" error={errors.own_profile_url} hint="Used to skip self when DMing commenters.">
                <TextInput
                  id="f-own"
                  mono
                  value={form.own_profile_url}
                  invalid={Boolean(errors.own_profile_url)}
                  onChange={(e) => set('own_profile_url', e.target.value)}
                  placeholder="https://www.facebook.com/…"
                />
              </Field>
              <Field label="DM-as-page URL" htmlFor="f-dmpage" error={errors.dm_as_page_url} hint="The page identity used when sending DMs.">
                <TextInput
                  id="f-dmpage"
                  mono
                  value={form.dm_as_page_url}
                  invalid={Boolean(errors.dm_as_page_url)}
                  onChange={(e) => set('dm_as_page_url', e.target.value)}
                  placeholder="https://www.facebook.com/…"
                />
              </Field>
            </div>
          </div>

          <div className="form-section">
            <div className="section-label">Behavior</div>
            <Toggle
              checked={form.send_dm_to_commenters}
              onChange={(val) => set('send_dm_to_commenters', val)}
              label="DM commenters"
              description="Send a direct message to people who comment (highest ban-risk feature)."
            />
            <Toggle
              checked={form.enabled}
              onChange={(val) => set('enabled', val)}
              label="Account enabled"
              description="When off, the worker skips this account entirely."
            />
            <div className="field-row field-row--2">
              <Field
                label="Check interval"
                htmlFor="f-interval"
                required
                error={errors.check_interval_minutes}
                hint="How often the worker checks this account (1–1440 minutes)."
              >
                <div className="input-suffix">
                  <TextInput
                    id="f-interval"
                    type="number"
                    min={1}
                    max={1440}
                    value={form.check_interval_minutes}
                    invalid={Boolean(errors.check_interval_minutes)}
                    onChange={(e) => set('check_interval_minutes', e.target.value)}
                  />
                  <span className="input-suffix__tag">min</span>
                </div>
              </Field>
              <Field
                label="Daily action cap"
                htmlFor="f-cap"
                error={errors.daily_action_cap}
                hint="Per-account override. Leave blank to inherit the global cap."
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
          </div>

          {/* Content collections */}
          <div className="form-section">
            <div className="section-label">Comments</div>
            <ListEditor
              items={form.comments}
              onChange={(next) => set('comments', next)}
              addLabel="Add comment"
              placeholder="A comment the worker may post on new posts…"
              emptyHint="No comments configured. The worker won't comment until you add some."
              itemErrors={collectItemErrors(errors, 'comments')}
            />
          </div>
          <div className="form-section">
            <div className="section-label">Replies</div>
            <ListEditor
              items={form.replies}
              onChange={(next) => set('replies', next)}
              addLabel="Add reply"
              placeholder="A reply the worker may use when responding to comments…"
              emptyHint="No replies configured."
              itemErrors={collectItemErrors(errors, 'replies')}
            />
          </div>
          <div className="form-section">
            <div className="section-label">DM messages</div>
            <ListEditor
              items={form.dm_messages}
              onChange={(next) => set('dm_messages', next)}
              addLabel="Add DM message"
              placeholder="A direct message template…"
              emptyHint="No DM messages configured."
              itemErrors={collectItemErrors(errors, 'dm_messages')}
            />
          </div>
          <div className="form-section">
            <div className="section-label">Groups</div>
            <ListEditor
              items={form.groups}
              onChange={(next) => set('groups', next)}
              variant="url"
              addLabel="Add group"
              placeholder="https://www.facebook.com/groups/…"
              emptyHint="No groups configured."
              itemErrors={collectItemErrors(errors, 'groups')}
            />
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
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={saving}>
              {mode === 'create' ? 'Create account' : 'Save changes'}
            </Button>
          </div>
        </div>
      </Card>

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
    </form>
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
    target_page_url: form.target_page_url.trim(),
    send_dm_to_commenters: form.send_dm_to_commenters,
    enabled: form.enabled,
    locale: form.locale,
    timezone_id: form.timezone_id.trim(),
    check_interval_minutes: toIntOrNull(form.check_interval_minutes) ?? 7,
    own_profile_url: blankToNull(form.own_profile_url),
    dm_as_page_url: blankToNull(form.dm_as_page_url),
    user_agent: blankToNull(form.user_agent),
    proxy_server: blankToNull(form.proxy_server),
    proxy_username: blankToNull(form.proxy_username),
    daily_action_cap: form.daily_action_cap.trim() === '' ? null : toIntOrNull(form.daily_action_cap),
    comments: trimList(form.comments),
    replies: trimList(form.replies),
    dm_messages: trimList(form.dm_messages),
    groups: trimList(form.groups),
  };
  if (form.password) payload.password = form.password;
  if (form.proxy_password) payload.proxy_password = form.proxy_password;
  return payload;
}

function buildUpdatePayload(form: FormState, account: AccountWithChildren | null): AccountUpdateInput {
  // Send the full editable set (a PATCH that replaces values). Secrets are only
  // included when the user typed a new one (write-only semantics).
  const patch: AccountUpdateInput = {
    name: form.name.trim(),
    email: form.email.trim(),
    session_file: form.session_file.trim() || deriveSessionFile(form.name),
    target_page_url: form.target_page_url.trim(),
    send_dm_to_commenters: form.send_dm_to_commenters,
    enabled: form.enabled,
    locale: form.locale,
    timezone_id: form.timezone_id.trim(),
    check_interval_minutes: toIntOrNull(form.check_interval_minutes) ?? account?.check_interval_minutes ?? 7,
    own_profile_url: blankToNull(form.own_profile_url),
    dm_as_page_url: blankToNull(form.dm_as_page_url),
    user_agent: blankToNull(form.user_agent),
    proxy_server: blankToNull(form.proxy_server),
    proxy_username: blankToNull(form.proxy_username),
    daily_action_cap: form.daily_action_cap.trim() === '' ? null : toIntOrNull(form.daily_action_cap),
    comments: trimList(form.comments),
    replies: trimList(form.replies),
    dm_messages: trimList(form.dm_messages),
    groups: trimList(form.groups),
  };
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

function trimList(items: string[]): string[] {
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

function omit<T extends Record<string, unknown>>(obj: T, key: string): T {
  const next = { ...obj };
  delete next[key];
  return next;
}

function isUrlSafe(s: string): boolean {
  try {
    return Boolean(new URL(s.trim()));
  } catch {
    return false;
  }
}

/** Pull child-list errors keyed "comments.3" into { 3: message } for ListEditor. */
function collectItemErrors(errors: v.Errors, field: string): Record<number, string> {
  const out: Record<number, string> = {};
  const prefix = `${field}.`;
  for (const [k, msg] of Object.entries(errors)) {
    if (k.startsWith(prefix)) {
      const idx = Number(k.slice(prefix.length));
      if (Number.isInteger(idx)) out[idx] = msg;
    }
  }
  return out;
}

/** Focus the first field that has an error, for keyboard + screen-reader users. */
function focusFirstError(errors: v.Errors) {
  const first = Object.keys(errors)[0];
  if (!first) return;
  // Map known top-level keys to their input ids.
  const idMap: Record<string, string> = {
    name: 'f-name',
    email: 'f-email',
    target_page_url: 'f-target',
    own_profile_url: 'f-own',
    dm_as_page_url: 'f-dmpage',
    check_interval_minutes: 'f-interval',
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
