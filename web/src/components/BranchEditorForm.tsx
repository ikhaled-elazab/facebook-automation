/*
 * BranchEditorForm.tsx — the detail editor for one branch (create or edit).
 *
 * Covers every per-branch field from the v2 branch contract:
 *   targeting: target_page_url, own_profile_url, dm_as_page_url
 *   behavior:  send_dm_to_commenters, enabled, check_interval_minutes
 *   pacing:    daily_action_cap (per-branch override, ≤ account ceiling)
 *   content:   comments[], replies[], dm_messages[], groups[]
 *
 * - In CREATE mode the branch is a local draft until first save (POST).
 * - In EDIT mode the branch + its children are lazy-loaded on mount, then PATCHed.
 * - Client validation mirrors the branch zod (required target_page_url, http(s)
 *   scheme, empty-row rejection for child arrays). Server 422 details[] are merged.
 * - Secrets do not apply to branches (they live on the account envelope).
 */
import { useState } from 'react';
import { api } from '../api/client';
import { ApiError } from '../api/ApiError';
import { useAsync } from '../lib/useAsync';
import { errorMessage } from '../lib/format';
import { Button, Field, ErrorState, LoadingState, TextInput, Toggle } from './ui';
import { ListEditor } from './ListEditor';
import type {
  Branch,
  BranchWithChildren,
  BranchCreateInput,
  BranchUpdateInput,
} from '../api/types';
import * as v from '../lib/validate';

interface BranchEditorFormProps {
  accountId: number;
  /** null = creating a new draft branch; number = editing an existing one. */
  branchId: number | null;
  /** True when this is the account's only branch (informs default messaging). */
  isOnlyBranch: boolean;
  /** Count of existing branches — used to default the draft name (e.g. "Branch 2"). */
  existingBranchCount: number;
  onSaved: (saved: Branch, wasCreate: boolean) => void;
  onCancelCreate: () => void;
}

interface FormState {
  name: string;
  target_page_url: string;
  own_profile_url: string;
  dm_as_page_url: string;
  send_dm_to_commenters: boolean;
  enabled: boolean;
  check_interval_minutes: string; // text in the input; coerced on submit
  daily_action_cap: string; // '' = inherit account ceiling
  comments: string[];
  replies: string[];
  dm_messages: string[];
  groups: string[];
}

function emptyForm(branchCount: number): FormState {
  return {
    name: `Branch ${branchCount + 1}`,
    target_page_url: '',
    own_profile_url: '',
    dm_as_page_url: '',
    send_dm_to_commenters: false,
    enabled: true,
    check_interval_minutes: '7',
    daily_action_cap: '',
    comments: [],
    replies: [],
    dm_messages: [],
    groups: [],
  };
}

function fromBranch(b: BranchWithChildren): FormState {
  return {
    name: b.name,
    target_page_url: b.target_page_url,
    own_profile_url: b.own_profile_url ?? '',
    dm_as_page_url: b.dm_as_page_url ?? '',
    send_dm_to_commenters: b.send_dm_to_commenters,
    enabled: b.enabled,
    check_interval_minutes: String(b.check_interval_minutes),
    daily_action_cap: b.daily_action_cap == null ? '' : String(b.daily_action_cap),
    comments: b.comments,
    replies: b.replies,
    dm_messages: b.dm_messages,
    groups: b.groups,
  };
}

export function BranchEditorForm({
  accountId,
  branchId,
  isOnlyBranch,
  existingBranchCount,
  onSaved,
  onCancelCreate,
}: BranchEditorFormProps) {
  // Edit mode: lazy-load the branch WITH children. Create mode: no fetch.
  const loaded = useAsync<BranchWithChildren | null>(
    () => (branchId != null ? api.branches.get(accountId, branchId) : Promise.resolve(null)),
    [accountId, branchId]
  );

  if (branchId != null && loaded.loading) return <LoadingState label="Loading branch…" />;
  if (branchId != null && loaded.error)
    return <ErrorState message={loaded.error} onRetry={loaded.reload} />;

  return (
    <InnerForm
      key={loaded.data?.id ?? 'new'}
      accountId={accountId}
      branchId={branchId}
      branch={loaded.data ?? null}
      isOnlyBranch={isOnlyBranch}
      initial={loaded.data ? fromBranch(loaded.data) : emptyForm(existingBranchCount)}
      onSaved={onSaved}
      onCancelCreate={onCancelCreate}
    />
  );
}

interface InnerFormProps {
  accountId: number;
  branchId: number | null;
  branch: BranchWithChildren | null;
  isOnlyBranch: boolean;
  initial: FormState;
  onSaved: (saved: Branch, wasCreate: boolean) => void;
  onCancelCreate: () => void;
}

function InnerForm({
  accountId,
  branchId,
  branch,
  isOnlyBranch,
  initial,
  onSaved,
  onCancelCreate,
}: InnerFormProps) {
  const isCreate = branchId == null;
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<v.Errors>({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[String(key)] ? omit(prev, String(key)) : prev));
  }

  function validate(): v.Errors {
    const e: v.Errors = {};
    v.required(e, 'name', form.name, 'Branch name');
    v.maxLen(e, 'name', form.name, 256, 'Branch name');
    v.urlField(e, 'target_page_url', form.target_page_url, 'Target page URL');
    v.urlField(e, 'own_profile_url', form.own_profile_url, 'Own profile URL', { allowEmpty: true });
    v.urlField(e, 'dm_as_page_url', form.dm_as_page_url, 'DM-as-page URL', { allowEmpty: true });
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
    // Child collections: zod rejects empty strings — flag any blank rows; groups
    // must additionally be valid URLs.
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
      const saved = isCreate
        ? await api.branches.create(accountId, buildCreatePayload(form))
        : await api.branches.update(accountId, branchId as number, buildUpdatePayload(form));
      onSaved(saved, isCreate);
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
    <form onSubmit={onSubmit} noValidate>
      <div className="branch-detail__head">
        <h3 className="branch-detail__title">
          {isCreate ? 'New branch' : `Edit ${branch?.name ?? 'branch'}`}
        </h3>
        {!isCreate && branch?.is_default && (
          <span className="branch-detail__default-note">
            This is the default branch{isOnlyBranch ? ' (the account’s only branch)' : ''}.
          </span>
        )}
      </div>

      <div className="form-section">
        <Field
          label="Branch name"
          htmlFor="b-name"
          required
          error={errors.name}
          hint="A label for this targeting context (e.g. “Main page”, “Promo group”)."
        >
          <TextInput
            id="b-name"
            value={form.name}
            invalid={Boolean(errors.name)}
            onChange={(e) => set('name', e.target.value)}
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
      </div>

      <div className="form-section">
        <div className="section-label">Targets</div>
        <Field
          label="Target page URL"
          htmlFor="b-target"
          required
          error={errors.target_page_url}
          hint="The Facebook page/profile this branch monitors."
        >
          <TextInput
            id="b-target"
            mono
            value={form.target_page_url}
            invalid={Boolean(errors.target_page_url)}
            onChange={(e) => set('target_page_url', e.target.value)}
            placeholder="https://www.facebook.com/…"
          />
        </Field>
        <div className="field-row field-row--2">
          <Field label="Own profile URL" htmlFor="b-own" error={errors.own_profile_url} hint="Used to skip self when DMing commenters.">
            <TextInput
              id="b-own"
              mono
              value={form.own_profile_url}
              invalid={Boolean(errors.own_profile_url)}
              onChange={(e) => set('own_profile_url', e.target.value)}
              placeholder="https://www.facebook.com/…"
            />
          </Field>
          <Field label="DM-as-page URL" htmlFor="b-dmpage" error={errors.dm_as_page_url} hint="The page identity used when sending DMs.">
            <TextInput
              id="b-dmpage"
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
          label="Branch enabled"
          description="When off, the worker skips this branch (but still runs the account’s other branches)."
        />
        <div className="field-row field-row--2">
          <Field
            label="Check interval"
            htmlFor="b-interval"
            required
            error={errors.check_interval_minutes}
            hint="How often the worker checks this branch (1–1440 minutes)."
          >
            <div className="input-suffix">
              <TextInput
                id="b-interval"
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
            label="Branch daily cap"
            htmlFor="b-cap"
            error={errors.daily_action_cap}
            hint="Per-branch override. Leave blank to inherit the account ceiling."
          >
            <TextInput
              id="b-cap"
              type="number"
              min={0}
              max={100000}
              value={form.daily_action_cap}
              invalid={Boolean(errors.daily_action_cap)}
              onChange={(e) => set('daily_action_cap', e.target.value)}
              placeholder="inherit account ceiling"
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

      <div className="editor-bar">
        <span className="editor-bar__status">
          {serverError ? <span className="field__error">{serverError}</span> : ''}
        </span>
        <div className="page__actions">
          {isCreate && (
            <Button variant="ghost" type="button" onClick={onCancelCreate} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button variant="primary" type="submit" loading={saving}>
            {isCreate ? 'Create branch' : 'Save branch'}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ── payload builders ──────────────────────────────────────────────────────--

function buildCreatePayload(form: FormState): BranchCreateInput {
  return {
    name: form.name.trim(),
    target_page_url: form.target_page_url.trim(),
    own_profile_url: blankToNull(form.own_profile_url),
    dm_as_page_url: blankToNull(form.dm_as_page_url),
    send_dm_to_commenters: form.send_dm_to_commenters,
    enabled: form.enabled,
    check_interval_minutes: toIntOrNull(form.check_interval_minutes) ?? 7,
    daily_action_cap: form.daily_action_cap.trim() === '' ? null : toIntOrNull(form.daily_action_cap),
    comments: trimList(form.comments),
    replies: trimList(form.replies),
    dm_messages: trimList(form.dm_messages),
    groups: trimList(form.groups),
  };
}

function buildUpdatePayload(form: FormState): BranchUpdateInput {
  return {
    name: form.name.trim(),
    target_page_url: form.target_page_url.trim(),
    own_profile_url: blankToNull(form.own_profile_url),
    dm_as_page_url: blankToNull(form.dm_as_page_url),
    send_dm_to_commenters: form.send_dm_to_commenters,
    enabled: form.enabled,
    check_interval_minutes: toIntOrNull(form.check_interval_minutes) ?? 7,
    daily_action_cap: form.daily_action_cap.trim() === '' ? null : toIntOrNull(form.daily_action_cap),
    comments: trimList(form.comments),
    replies: trimList(form.replies),
    dm_messages: trimList(form.dm_messages),
    groups: trimList(form.groups),
  };
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
  const idMap: Record<string, string> = {
    name: 'b-name',
    target_page_url: 'b-target',
    own_profile_url: 'b-own',
    dm_as_page_url: 'b-dmpage',
    check_interval_minutes: 'b-interval',
    daily_action_cap: 'b-cap',
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
