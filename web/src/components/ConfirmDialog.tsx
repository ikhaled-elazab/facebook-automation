/*
 * ConfirmDialog.tsx — accessible confirmation modal.
 *
 * A11y: role=dialog + aria-modal, labelled by its title, focus moves to the modal
 * on open and is RETURNED to the trigger on close, Escape cancels, focus is
 * trapped within the dialog while open. Used for the destructive delete flow.
 */
import { useCallbackRef } from '../lib/useCallbackRef';
import { useEffect, useId, useRef } from 'react';
import { Button } from './ui';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCancelRef = useCallbackRef(onCancel);
  // Collision-safe id for aria-labelledby — multiple dialogs can coexist in the
  // tree (e.g. a delete confirm + an unsaved-changes guard), so never hardcode.
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    // Remember what had focus so we can restore it on close.
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Move focus into the dialog (the safe default action).
    confirmBtnRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancelRef();
        return;
      }
      if (e.key === 'Tab') {
        trapFocus(e, dialogRef.current);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Restore focus to the trigger element.
      previouslyFocused.current?.focus?.();
    };
  }, [open, onCancelRef]);

  if (!open) return null;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal__head">
          <h2 id={titleId}>{title}</h2>
        </div>
        <div className="modal__body">{body}</div>
        <div className="modal__foot">
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmBtnRef}
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Keep Tab focus cycling within the dialog. */
function trapFocus(e: KeyboardEvent, container: HTMLElement | null) {
  if (!container) return;
  const focusable = container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
