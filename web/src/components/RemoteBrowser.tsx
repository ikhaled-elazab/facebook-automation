/*
 * RemoteBrowser.tsx — the dashboard "remote browser" for a manual login.
 *
 * When an account login parks at needs_manual, the server is running the login
 * browser HEADLESS and streaming it over a WebSocket (useLoginStream). This modal
 * renders the live frames into an <img> and forwards the operator's mouse + keyboard
 * back into the page via CDP — so the user can type their password, scan a QR with
 * their phone, or approve a push, all from the dashboard. No CLI, no VNC.
 *
 * Coordinate model: the surface is locked to the browser viewport's aspect ratio and
 * the image fills it exactly (no letterboxing), so a click at (cx,cy) within the
 * surface maps linearly to viewport CSS coordinates using the frame's deviceWidth/
 * deviceHeight (falling back to the known 1366×768 context viewport).
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';
import { IconX, IconRefresh } from './icons';
import { useLoginStream } from '../lib/useLoginStream';

/** The login context viewport (server: login-flow.js _buildContextOptions). */
const VIEWPORT_W = 1366;
const VIEWPORT_H = 768;

/**
 * Ctrl/⌘ + key → the Chromium editor command to run. Synthetic CDP key events do
 * NOT auto-trigger these (the OS normally does the key→command mapping), so we name
 * the command explicitly via dispatchKeyEvent's `commands` field. (⌘V paste is
 * handled separately via the Clipboard API.)
 */
const EDITING_COMMANDS: Record<string, string> = {
  a: 'selectAll',
  z: 'undo',
  y: 'redo',
  x: 'cut',
  c: 'copy',
};

/** Special keys we forward as key events; everything printable goes as 'text'. */
const SPECIAL_KEYS = new Set([
  'Enter',
  'Backspace',
  'Tab',
  'Delete',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

export function RemoteBrowser({
  accountId,
  accountName,
  detail,
  onClose,
}: {
  accountId: number;
  accountName: string;
  detail: string | null;
  onClose: () => void;
}) {
  const { state, frame, send, reconnect } = useLoginStream(accountId, true);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  const lastMove = useRef(0);
  // Set when a programmatic clipboard read is denied, so we can tell the user to
  // type the value instead of leaving them wondering why paste did nothing.
  const [pasteBlocked, setPasteBlocked] = useState(false);

  // Focus the surface on open so keyboard input flows immediately; Escape closes.
  useEffect(() => {
    surfaceRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Map a pointer event to viewport CSS coordinates for CDP input. */
  function toViewport(e: React.PointerEvent | React.WheelEvent) {
    const el = surfaceRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const dw = frame?.metadata.deviceWidth || VIEWPORT_W;
    const dh = frame?.metadata.deviceHeight || VIEWPORT_H;
    const x = ((e.clientX - rect.left) / rect.width) * dw;
    const y = ((e.clientY - rect.top) / rect.height) * dh;
    return { x: clamp(x, 0, dw), y: clamp(y, 0, dh) };
  }

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    surfaceRef.current?.focus();
    pressed.current = true;
    const { x, y } = toViewport(e);
    send({ t: 'm', kind: 'down', x, y, button: e.button, clickCount: e.detail || 1 });
  }
  function onPointerUp(e: React.PointerEvent) {
    e.preventDefault();
    pressed.current = false;
    const { x, y } = toViewport(e);
    send({ t: 'm', kind: 'up', x, y, button: e.button });
  }
  function onPointerMove(e: React.PointerEvent) {
    // Throttle moves to ~30fps; always forward while dragging.
    const now = e.timeStamp;
    if (!pressed.current && now - lastMove.current < 33) return;
    lastMove.current = now;
    const { x, y } = toViewport(e);
    send({ t: 'm', kind: 'move', x, y, button: pressed.current ? e.button : undefined });
  }
  function onWheel(e: React.WheelEvent) {
    const { x, y } = toViewport(e);
    send({ t: 'w', x, y, dx: e.deltaX, dy: e.deltaY });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Escape is handled by the document listener (closes the modal).
    if (e.key === 'Escape') return;
    // Paste: a non-editable surface never fires the native paste event, so we read
    // the clipboard ourselves on Ctrl/Cmd+V (a user gesture, so the read is allowed)
    // and forward the text. Covers both 'v' and 'V' (Shift held).
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      void pasteFromClipboard();
      return;
    }
    // Other Ctrl/Cmd shortcuts (select-all, undo, etc.) are forwarded as REAL key
    // events carrying the modifier bitmask + code/vk, so the remote page runs the
    // editing command (insertText can't express modifiers, so it never could). The
    // editing command fires on keydown, so a keyup is unnecessary for the combo.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      // Name the editor command explicitly — this is what actually runs select-all,
      // undo, etc. in the remote page (the vk/modifiers alone never would).
      const lk = e.key.toLowerCase();
      const command = lk === 'z' && e.shiftKey ? 'redo' : EDITING_COMMANDS[lk];
      send({
        t: 'key',
        kind: 'down',
        key: e.key,
        code: e.code,
        vk: e.keyCode,
        modifiers: modMask(e),
        commands: command ? [command] : undefined,
      });
      return;
    }
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      send({ t: 'key', kind: 'down', key: e.key, code: e.code, vk: e.keyCode });
    } else if (e.key.length === 1 && !e.altKey) {
      e.preventDefault();
      send({ t: 'text', v: e.key });
    }
  }
  function onKeyUp(e: React.KeyboardEvent) {
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      send({ t: 'key', kind: 'up', key: e.key, code: e.code, vk: e.keyCode });
    }
  }
  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setPasteBlocked(false);
        send({ t: 'text', v: text });
      }
    } catch {
      // Read denied (older browser, insecure context, or permission refused) —
      // tell the operator to type it instead rather than failing silently.
      setPasteBlocked(true);
    }
  }

  const connecting = state === 'connecting' && !frame;
  const dropped = state === 'closed' || state === 'error';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label={`Log in ${accountName}`}>
        <div className="modal__head remote-browser__head">
          <h2>Log in — {accountName}</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close remote browser">
            <IconX size={16} />
          </button>
        </div>

        <div className="modal__body remote-browser__body">
          <p className="remote-browser__hint">
            {detail ||
              'Complete the login below — click a field, then type or paste (Ctrl/⌘+V). Enter a code, scan the QR with the Facebook app, or approve the prompt on your phone. This window closes automatically once you are logged in.'}
          </p>

          {pasteBlocked && (
            <p className="remote-browser__hint remote-browser__hint--warn" role="alert">
              Your browser blocked clipboard access — type the value instead, or allow
              clipboard permission for this site and try paste again.
            </p>
          )}

          <div
            ref={surfaceRef}
            className="remote-browser__surface"
            tabIndex={0}
            role="application"
            aria-label="Remote browser — click and type to control the login"
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerMove={onPointerMove}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            {frame ? (
              <img
                className="remote-browser__frame"
                src={`data:image/jpeg;base64,${frame.data}`}
                alt="Remote browser view"
                draggable={false}
              />
            ) : (
              <div className="remote-browser__placeholder">
                {connecting ? 'Connecting to the browser…' : dropped ? 'Connection lost.' : 'Waiting for the browser…'}
              </div>
            )}
          </div>
        </div>

        <div className="modal__foot remote-browser__foot">
          <span className={`remote-browser__status remote-browser__status--${state}`}>
            {state === 'open' ? 'Connected' : state === 'connecting' ? 'Connecting…' : 'Disconnected'}
          </span>
          <div className="row row-2">
            {dropped && (
              <Button variant="secondary" size="sm" type="button" onClick={reconnect}>
                <IconRefresh size={14} /> Reconnect
              </Button>
            )}
            <Button variant="ghost" size="sm" type="button" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta/⌘=4, Shift=8 (combine with OR). */
function modMask(e: React.KeyboardEvent): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}
