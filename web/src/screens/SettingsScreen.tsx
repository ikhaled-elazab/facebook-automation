/*
 * SettingsScreen.tsx — global settings (GET/PATCH /api/settings).
 *
 * Covers every field in SETTINGS_PUBLIC_FIELDS, grouped for the operator:
 *   Safety & pacing : pacing_enabled, global_daily_action_cap, active_hours_*,
 *                     account_stagger_ms  (the ban-avoidance governor)
 *   Humanization    : min/max_action_ms, min/max_typing_ms
 *   Browser/run     : headless, use_proxy, screenshot_on_error, log_dir
 *   AI / vision     : use_ai, use_vision, vision_model, vision_max_steps
 *   DM              : enable_dm_to_commenters (global gate)
 *
 * Cross-field validation (min ≤ max for the *_ms ranges, active-hours sanity) is
 * checked client-side AND surfaced from the server 422 (the zod refine paths line
 * up: 'min_action_ms', 'min_typing_ms').
 *
 * Save sends a PATCH of the whole editable set and renders from the response
 * (read-after-write) so the displayed 'last changed' reflects the new state.
 */
import { useState } from 'react';
import { api } from '../api/client';
import { ApiError } from '../api/ApiError';
import { useAsync } from '../lib/useAsync';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import { absoluteTime, errorMessage, isEqualJson } from '../lib/format';
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
import type { Settings, SettingsUpdateInput } from '../api/types';
import * as v from '../lib/validate';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const VISION_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'];

interface SettingsFormState {
  headless: boolean;
  use_proxy: boolean;
  use_ai: boolean;
  use_vision: boolean;
  vision_model: string;
  vision_max_steps: string;
  log_dir: string;
  screenshot_on_error: boolean;
  enable_dm_to_commenters: boolean;
  min_action_ms: string;
  max_action_ms: string;
  min_typing_ms: string;
  max_typing_ms: string;
  account_stagger_ms: string;
  pacing_enabled: boolean;
  global_daily_action_cap: string;
  active_hours_start: string;
  active_hours_end: string;
}

function toForm(s: Settings): SettingsFormState {
  return {
    headless: s.headless,
    use_proxy: s.use_proxy,
    use_ai: s.use_ai,
    use_vision: s.use_vision,
    vision_model: s.vision_model,
    vision_max_steps: String(s.vision_max_steps),
    log_dir: s.log_dir,
    screenshot_on_error: s.screenshot_on_error,
    enable_dm_to_commenters: s.enable_dm_to_commenters,
    min_action_ms: String(s.min_action_ms),
    max_action_ms: String(s.max_action_ms),
    min_typing_ms: String(s.min_typing_ms),
    max_typing_ms: String(s.max_typing_ms),
    account_stagger_ms: String(s.account_stagger_ms),
    pacing_enabled: s.pacing_enabled,
    global_daily_action_cap: String(s.global_daily_action_cap),
    active_hours_start: String(s.active_hours_start),
    active_hours_end: String(s.active_hours_end),
  };
}

export function SettingsScreen() {
  const { data, error, loading, reload, setData } = useAsync(() => api.settings.get());

  if (loading) return <LoadingState label="Loading settings…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  return <SettingsForm key={data.updated_at} initial={data} onSaved={setData} />;
}

function SettingsForm({ initial, onSaved }: { initial: Settings; onSaved: (s: Settings) => void }) {
  const toast = useToast();
  const [form, setForm] = useState<SettingsFormState>(toForm(initial));
  // Baseline for dirty-tracking; updated to the saved values after each save so
  // the form is "clean" again post-save (this screen stays on-page after saving).
  const [baseline, setBaseline] = useState<SettingsFormState>(toForm(initial));
  const [errors, setErrors] = useState<v.Errors>({});
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(initial.updated_at);

  const dirty = !saving && !isEqualJson(form, baseline);
  const guard = useUnsavedGuard(dirty);

  function set<K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) {
    setForm((p) => ({ ...p, [key]: value }));
    setErrors((p) => {
      if (!p[String(key)]) return p;
      const next = { ...p };
      delete next[String(key)];
      return next;
    });
  }

  function validate(): v.Errors {
    const e: v.Errors = {};
    const ints: Array<[keyof SettingsFormState, number, number, string]> = [
      ['vision_max_steps', 1, 100, 'Vision max steps'],
      ['min_action_ms', 0, 600000, 'Min action delay'],
      ['max_action_ms', 0, 600000, 'Max action delay'],
      ['min_typing_ms', 0, 60000, 'Min typing delay'],
      ['max_typing_ms', 0, 60000, 'Max typing delay'],
      ['account_stagger_ms', 0, 3600000, 'Account stagger'],
      ['global_daily_action_cap', 0, 1000000, 'Global daily cap'],
      ['active_hours_start', 0, 23, 'Active hours start'],
      ['active_hours_end', 0, 23, 'Active hours end'],
    ];
    for (const [key, min, max, label] of ints) {
      v.intRange(e, String(key), toInt(form[key] as string), min, max, label);
    }
    v.required(e, 'log_dir', form.log_dir, 'Log directory');
    v.required(e, 'vision_model', form.vision_model, 'Vision model');
    // Cross-field: min ≤ max (paths match the server refine paths).
    const minA = toInt(form.min_action_ms);
    const maxA = toInt(form.max_action_ms);
    if (minA != null && maxA != null && minA > maxA) {
      e.min_action_ms = 'Min action delay must be ≤ max action delay.';
    }
    const minT = toInt(form.min_typing_ms);
    const maxT = toInt(form.max_typing_ms);
    if (minT != null && maxT != null && minT > maxT) {
      e.min_typing_ms = 'Min typing delay must be ≤ max typing delay.';
    }
    return e;
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (saving) return;
    const clientErrors = validate();
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }
    setSaving(true);
    try {
      const patch = buildPatch(form);
      const saved = await api.settings.update(patch);
      onSaved(saved);
      const savedForm = toForm(saved);
      setForm(savedForm);
      setBaseline(savedForm); // new clean baseline → form is no longer dirty
      setUpdatedAt(saved.updated_at);
      setErrors({});
      toast.success('Settings saved.');
    } catch (err) {
      if (err instanceof ApiError && err.isValidation) {
        setErrors((p) => ({ ...p, ...err.fieldErrors() }));
        toast.error('Some settings need attention — see the highlighted fields.');
      } else {
        toast.error(`Could not save settings: ${errorMessage(err)}`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="page" onSubmit={onSubmit} noValidate>
      <Card>
        <CardHead
          title="Safety &amp; pacing"
          description="The ban-avoidance governor — pace actions to look human"
        />
        <CardBody>
          <div className="form-section">
            <Toggle
              checked={form.pacing_enabled}
              onChange={(val) => set('pacing_enabled', val)}
              label="Pacing enabled"
              description="Enforce the daily caps and active-hours window. Strongly recommended."
            />
            <div className="field-row field-row--2">
              <NumField
                id="s-cap"
                label="Global daily action cap"
                hint="Max actions/day across all accounts (0 = unlimited)."
                suffix="actions"
                value={form.global_daily_action_cap}
                error={errors.global_daily_action_cap}
                onChange={(val) => set('global_daily_action_cap', val)}
              />
              <NumField
                id="s-stagger"
                label="Account stagger"
                hint="Delay between starting each account's run."
                suffix="ms"
                value={form.account_stagger_ms}
                error={errors.account_stagger_ms}
                onChange={(val) => set('account_stagger_ms', val)}
              />
            </div>
            <div className="field-row field-row--2">
              <Field label="Active hours start" htmlFor="s-hstart" error={errors.active_hours_start} hint="Worker only acts within this local-hour window.">
                <Select
                  id="s-hstart"
                  value={form.active_hours_start}
                  invalid={Boolean(errors.active_hours_start)}
                  onChange={(e) => set('active_hours_start', e.target.value)}
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {pad(h)}:00
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Active hours end" htmlFor="s-hend" error={errors.active_hours_end}>
                <Select
                  id="s-hend"
                  value={form.active_hours_end}
                  invalid={Boolean(errors.active_hours_end)}
                  onChange={(e) => set('active_hours_end', e.target.value)}
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {pad(h)}:00
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Humanization delays" description="Randomized timing to mimic a real user" />
        <CardBody>
          <div className="form-section">
            <div className="field-row field-row--2">
              <NumField
                id="s-mina"
                label="Min action delay"
                suffix="ms"
                value={form.min_action_ms}
                error={errors.min_action_ms}
                onChange={(val) => set('min_action_ms', val)}
              />
              <NumField
                id="s-maxa"
                label="Max action delay"
                suffix="ms"
                value={form.max_action_ms}
                error={errors.max_action_ms}
                onChange={(val) => set('max_action_ms', val)}
              />
            </div>
            <div className="field-row field-row--2">
              <NumField
                id="s-mint"
                label="Min typing delay"
                suffix="ms"
                value={form.min_typing_ms}
                error={errors.min_typing_ms}
                onChange={(val) => set('min_typing_ms', val)}
              />
              <NumField
                id="s-maxt"
                label="Max typing delay"
                suffix="ms"
                value={form.max_typing_ms}
                error={errors.max_typing_ms}
                onChange={(val) => set('max_typing_ms', val)}
              />
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Browser &amp; run" description="How the worker launches and logs" />
        <CardBody>
          <div className="form-section">
            <Toggle
              checked={form.headless}
              onChange={(val) => set('headless', val)}
              label="Headless browser"
              description="Run Chromium without a visible window (use on the VPS)."
            />
            <Toggle
              checked={form.use_proxy}
              onChange={(val) => set('use_proxy', val)}
              label="Use proxy"
              description="Route each account through its configured proxy."
            />
            <Toggle
              checked={form.screenshot_on_error}
              onChange={(val) => set('screenshot_on_error', val)}
              label="Screenshot on error"
              description="Capture a screenshot when an action fails (for debugging)."
            />
            <Field label="Log directory" htmlFor="s-logdir" error={errors.log_dir}>
              <TextInput
                id="s-logdir"
                mono
                value={form.log_dir}
                invalid={Boolean(errors.log_dir)}
                onChange={(e) => set('log_dir', e.target.value)}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHead title="AI &amp; vision" description="Optional AI-assisted navigation" />
        <CardBody>
          <div className="form-section">
            <Toggle
              checked={form.use_ai}
              onChange={(val) => set('use_ai', val)}
              label="Use AI"
              description="Enable AI for generating/selecting content."
            />
            <Toggle
              checked={form.use_vision}
              onChange={(val) => set('use_vision', val)}
              label="Use vision"
              description="Let the worker use a vision model to navigate the page."
            />
            <div className="field-row field-row--2">
              <Field label="Vision model" htmlFor="s-vmodel" error={errors.vision_model}>
                <Select
                  id="s-vmodel"
                  value={form.vision_model}
                  invalid={Boolean(errors.vision_model)}
                  onChange={(e) => set('vision_model', e.target.value)}
                >
                  {VISION_MODELS.includes(form.vision_model) ? null : (
                    <option value={form.vision_model}>{form.vision_model}</option>
                  )}
                  {VISION_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
              <NumField
                id="s-vsteps"
                label="Vision max steps"
                hint="Max vision iterations per task (1–100)."
                value={form.vision_max_steps}
                error={errors.vision_max_steps}
                onChange={(val) => set('vision_max_steps', val)}
              />
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Direct messages" description="Global DM gate" />
        <CardBody>
          <Toggle
            checked={form.enable_dm_to_commenters}
            onChange={(val) => set('enable_dm_to_commenters', val)}
            label="Enable DM to commenters (global)"
            description="Master switch. Each account also has its own per-account toggle."
          />
        </CardBody>
        <div className="editor-bar">
          <span className="editor-bar__status">
            {dirty ? (
              <span className="field__error">Unsaved changes</span>
            ) : (
              <>Last changed {absoluteTime(updatedAt)}</>
            )}
          </span>
          <div className="page__actions">
            <Button
              variant="ghost"
              type="button"
              disabled={!dirty || saving}
              onClick={() => guard.attempt(() => setForm(baseline))}
            >
              Revert
            </Button>
            <Button variant="primary" type="submit" loading={saving} disabled={!dirty}>
              Save settings
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
        body="You have unsaved changes to the settings. If you leave now, they will be lost."
      />
    </form>
  );
}

// ── Reusable number field with a unit suffix ────────────────────────────────--

function NumField({
  id,
  label,
  hint,
  suffix,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  suffix?: string;
  value: string;
  error?: string;
  onChange: (val: string) => void;
}) {
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint}>
      {suffix ? (
        <div className="input-suffix">
          <TextInput
            id={id}
            type="number"
            value={value}
            invalid={Boolean(error)}
            onChange={(e) => onChange(e.target.value)}
          />
          <span className="input-suffix__tag">{suffix}</span>
        </div>
      ) : (
        <TextInput
          id={id}
          type="number"
          value={value}
          invalid={Boolean(error)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function toInt(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : Number.isNaN(n) ? null : Math.trunc(n);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function buildPatch(form: SettingsFormState): SettingsUpdateInput {
  return {
    headless: form.headless,
    use_proxy: form.use_proxy,
    use_ai: form.use_ai,
    use_vision: form.use_vision,
    vision_model: form.vision_model.trim(),
    vision_max_steps: toInt(form.vision_max_steps) ?? 8,
    log_dir: form.log_dir.trim(),
    screenshot_on_error: form.screenshot_on_error,
    enable_dm_to_commenters: form.enable_dm_to_commenters,
    min_action_ms: toInt(form.min_action_ms) ?? 0,
    max_action_ms: toInt(form.max_action_ms) ?? 0,
    min_typing_ms: toInt(form.min_typing_ms) ?? 0,
    max_typing_ms: toInt(form.max_typing_ms) ?? 0,
    account_stagger_ms: toInt(form.account_stagger_ms) ?? 0,
    pacing_enabled: form.pacing_enabled,
    global_daily_action_cap: toInt(form.global_daily_action_cap) ?? 0,
    active_hours_start: toInt(form.active_hours_start) ?? 0,
    active_hours_end: toInt(form.active_hours_end) ?? 0,
  };
}
