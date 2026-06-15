/*
 * SecretField.tsx — a WRITE-ONLY credential input.
 *
 * The API never returns the secret (only a has_* boolean). So this field:
 *   - Shows "credential is set / not set" from the boolean.
 *   - Stays empty by default (we never prefill a value we don't have).
 *   - In edit mode, the secret is only sent if the user types a new one — an
 *     untouched field leaves the stored credential unchanged.
 *   - Offers an explicit "Change" toggle in edit mode so the operator doesn't
 *     accidentally overwrite a working credential.
 *
 * SECURITY: the typed value lives only in component state for the lifetime of the
 * form; it is sent once over the same-origin request and never persisted client
 * side. type=password keeps it out of shoulder-surfing + autofill history noise.
 */
import { useId, useState } from 'react';
import { Field, TextInput, Button, Badge } from './ui';
import { IconLock, IconCheck } from './icons';

interface SecretFieldProps {
  label: string;
  /** Whether a credential is already stored (has_password / has_proxy_password). */
  isSet: boolean;
  /** Current typed value (controlled by the parent form). */
  value: string;
  onChange: (next: string) => void;
  required?: boolean;
  hint?: string;
  error?: string;
  autoComplete?: string;
  /** create mode shows the input directly; edit mode gates behind "Change". */
  mode: 'create' | 'edit';
}

export function SecretField({
  label,
  isSet,
  value,
  onChange,
  required,
  hint,
  error,
  autoComplete = 'new-password',
  mode,
}: SecretFieldProps) {
  const id = useId();
  // In edit mode we only reveal the input when the user opts to change it.
  const [changing, setChanging] = useState(mode === 'create');

  if (mode === 'edit' && !changing) {
    return (
      <div className="secret">
        <span className="field__label">{label}</span>
        <div className="secret__status">
          <span aria-hidden="true">
            <IconLock size={16} />
          </span>
          <div className="secret__status-text">
            <strong>{isSet ? 'Credential is set' : 'No credential stored'}</strong>
            <span>
              {isSet
                ? 'The stored value is never displayed. Leave as-is to keep it.'
                : 'No credential has been saved for this field.'}
            </span>
          </div>
          {isSet && (
            <Badge tone="ok">
              <IconCheck size={11} /> Set
            </Badge>
          )}
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => {
              setChanging(true);
              onChange('');
            }}
          >
            {isSet ? 'Change' : 'Set'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Field
      label={label}
      htmlFor={id}
      required={required}
      hint={hint ?? (mode === 'edit' && isSet ? 'Entering a value replaces the stored credential.' : undefined)}
      error={error}
    >
      <div className="row row-2">
        <TextInput
          id={id}
          grow
          type="password"
          autoComplete={autoComplete}
          value={value}
          invalid={Boolean(error)}
          onChange={(e) => onChange(e.target.value)}
          placeholder="••••••••"
        />
        {mode === 'edit' && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => {
              setChanging(false);
              onChange('');
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </Field>
  );
}
