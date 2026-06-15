/*
 * ui.tsx — shared, accessible UI primitives used across every screen.
 *
 * All visual styling lives in components.css (class-based → CSP-clean, no inline
 * style attributes carrying scripts). These wrappers add: label/error/hint
 * association (aria-describedby / aria-invalid), required-field semantics, and a
 * consistent API so screens compose forms quickly without re-deriving a11y.
 */
import { useId } from 'react';
import type {
  ReactNode,
  Ref,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
} from 'react';
import { IconAlert } from './icons';
import { safeHref } from '../lib/format';

// ── SafeUrl ───────────────────────────────────────────────────────────────--
//
// Render a stored URL as a link ONLY when it is a safe http(s) URL; otherwise
// render it as plain text. Defense-in-depth against a stored javascript:/data:
// URL (React does not strip a javascript: href). Every place that renders a
// user/DB-supplied URL into an anchor MUST use this rather than a raw <a href>.

interface SafeUrlProps {
  url: string | null | undefined;
  /** Optional display text; defaults to the URL itself. */
  text?: ReactNode;
  className?: string;
}

export function SafeUrl({ url, text, className }: SafeUrlProps) {
  const href = safeHref(url);
  const label = text ?? url ?? '';
  if (!href) {
    // Unsafe or empty scheme — never emit it as an href. Show as inert text.
    return (
      <span className={className} title={url ?? undefined}>
        {label}
      </span>
    );
  }
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={url ?? undefined}
    >
      {label}
    </a>
  );
}

// ── Button ──────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  iconOnly?: boolean;
  children?: ReactNode;
  /** React 19 accepts ref as a plain prop on function components. */
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  loading = false,
  iconOnly = false,
  disabled,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const cls = [
    'btn',
    `btn--${variant}`,
    size !== 'md' && `btn--${size}`,
    block && 'btn--block',
    iconOnly && 'btn--icon',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} className={cls} disabled={disabled || loading} {...rest}>
      {loading && <span className="spinner btn__spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

// ── Field wrapper (label + hint + error, wired for a11y) ─────────────────────

interface FieldProps {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, required, hint, error, children }: FieldProps) {
  const hintId = `${htmlFor}-hint`;
  const errId = `${htmlFor}-err`;
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="field__req" aria-hidden="true" title="Required">
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={errId} role="alert">
          <IconAlert size={13} /> {error}
        </p>
      )}
    </div>
  );
}

// ── Inputs (controlled, with invalid styling hook) ───────────────────────────

interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  invalid?: boolean;
  mono?: boolean;
  grow?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function TextInput({ invalid, mono, grow, ref, ...rest }: TextInputProps) {
  const cls = ['input', mono && 'input--mono', grow && 'grow', invalid && 'is-invalid']
    .filter(Boolean)
    .join(' ');
  return <input ref={ref} className={cls} aria-invalid={invalid || undefined} {...rest} />;
}

interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  invalid?: boolean;
}

export function TextArea({ invalid, ...rest }: TextAreaProps) {
  const cls = ['textarea', invalid && 'is-invalid'].filter(Boolean).join(' ');
  return <textarea className={cls} aria-invalid={invalid || undefined} {...rest} />;
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> {
  invalid?: boolean;
  children: ReactNode;
}

export function Select({ invalid, children, ...rest }: SelectProps) {
  const cls = ['select', invalid && 'is-invalid'].filter(Boolean).join(' ');
  // Wrapper draws the CSS-only chevron (no data: URI → CSP-clean).
  return (
    <span className="select-wrap">
      <select className={cls} aria-invalid={invalid || undefined} {...rest}>
        {children}
      </select>
    </span>
  );
}

// ── Toggle switch ────────────────────────────────────────────────────────────

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, description, disabled }: ToggleProps) {
  const id = useId();
  return (
    <label className="toggle" htmlFor={id}>
      <input
        id={id}
        className="toggle__input sr-only"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__thumb" />
      </span>
      <span className="toggle__label">
        <strong>{label}</strong>
        {description && <span>{description}</span>}
      </span>
    </label>
  );
}

// ── Badge ────────────────────────────────────────────────────────────────────

type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'accent';

export function Badge({
  tone = 'info',
  dot = false,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`badge badge--${tone}`}>
      {dot && <span className="badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

export function Card({
  children,
  inset = false,
}: {
  children: ReactNode;
  inset?: boolean;
}) {
  return <div className={`card${inset ? ' card--inset' : ''}`}>{children}</div>;
}

export function CardHead({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="card__head">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row row-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  return <div className={`card__body${flush ? ' card__body--flush' : ''}`}>{children}</div>;
}

// ── State views (empty / error / loading) ────────────────────────────────────

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state">
      <div className="state__icon">{icon}</div>
      <div className="stack stack-2">
        <span className="state__title">{title}</span>
        {description && <span className="state__desc">{description}</span>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state" role="alert">
      <div className="state__icon state__icon--danger">
        <IconAlert size={22} />
      </div>
      <div className="stack stack-2">
        <span className="state__title">Something went wrong</span>
        <span className="state__desc">{message}</span>
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" aria-busy="true" aria-live="polite">
      <span className="spinner spinner--lg" />
      <span className="state__desc">{label}</span>
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack stack-3" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton skeleton-row" />
      ))}
    </div>
  );
}
