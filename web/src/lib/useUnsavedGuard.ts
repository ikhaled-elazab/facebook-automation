/*
 * useUnsavedGuard — warn before discarding unsaved form edits.
 *
 * THREE layers, so every "leave with unsaved edits" path is covered:
 *   1. In-app router nav (sidebar links, programmatic navigate): React Router's
 *      useBlocker intercepts the transition while `dirty` and opens the prompt.
 *   2. Explicit actions (a Cancel button): caller routes the action through
 *      `attempt(action)` — runs immediately when clean, prompts when dirty.
 *   3. Tab-close / refresh / external nav: a `beforeunload` listener (only while
 *      dirty) triggers the browser's native "leave site?" dialog — the one path
 *      neither a router blocker nor an in-app dialog can intercept.
 *
 * The caller renders <ConfirmDialog open={promptOpen} …> wired to confirm/cancel.
 */
import { useCallback, useEffect, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import type { BlockerFunction } from 'react-router-dom';

interface UnsavedGuard {
  /** True when a confirm dialog should be shown. */
  promptOpen: boolean;
  /**
   * Attempt an explicit action that would discard edits (e.g. a Cancel button).
   * Runs immediately when clean; defers + opens the prompt when dirty.
   */
  attempt: (action: () => void) => void;
  /** Confirm the discard — proceeds with the blocked navigation or deferred action. */
  confirm: () => void;
  /** Cancel the discard — keep editing. */
  cancel: () => void;
}

export function useUnsavedGuard(dirty: boolean): UnsavedGuard {
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // Layer 1: block in-app router navigations while dirty.
  const blockFn = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
    [dirty]
  );
  const blocker = useBlocker(blockFn);

  // Layer 3: native guard for tab-close / refresh / external nav.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // modern browsers show a generic message
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Layer 2: explicit action gating.
  const attempt = useCallback(
    (action: () => void) => {
      if (!dirty) {
        action();
        return;
      }
      setPendingAction(() => action);
    },
    [dirty]
  );

  const promptOpen = blocker.state === 'blocked' || pendingAction !== null;

  const confirm = useCallback(() => {
    if (blocker.state === 'blocked') {
      blocker.proceed();
    }
    const action = pendingAction;
    setPendingAction(null);
    action?.();
  }, [blocker, pendingAction]);

  const cancel = useCallback(() => {
    if (blocker.state === 'blocked') {
      blocker.reset();
    }
    setPendingAction(null);
  }, [blocker]);

  return { promptOpen, attempt, confirm, cancel };
}
