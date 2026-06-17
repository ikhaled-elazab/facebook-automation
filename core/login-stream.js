'use strict';

/**
 * core/login-stream.js — stream a HEADLESS Playwright page to the dashboard as an
 * interactive "remote browser", using the Chromium DevTools Protocol (CDP).
 *
 * WHY THIS EXISTS:
 *   Some Facebook accounts require an OTP, a QR scan, or a push-approve that has no
 *   typeable code we can automate. The operator must drive a real browser. On a VPS
 *   the operator only has the dashboard, so we surface the server's browser THERE.
 *
 * WHY CDP AND NOT Xvfb + VNC:
 *   CDP's `Page.startScreencast` streams the page as JPEG frames, and
 *   `Input.dispatchMouseEvent` / `Input.insertText` / `Input.dispatchKeyEvent`
 *   inject clicks and typing — and ALL of these work against a HEADLESS browser.
 *   So we get a fully interactive remote browser with NO virtual display and NO VNC
 *   server installed on the host. The browser stays headless; only pixels (out) and
 *   input events (in) cross the wire.
 *
 * ── DATA FLOW ────────────────────────────────────────────────────────────────
 *   server: Page.screencastFrame ──(frame: jpeg b64 + metadata)──▶ subscribers (WS)
 *   client: mouse / wheel / text / key ──(input msg)──▶ dispatchInput ──▶ CDP Input.*
 *
 * ── SECURITY ─────────────────────────────────────────────────────────────────
 *   - This module performs NO authentication itself — the WebSocket layer that
 *     owns the sockets MUST authenticate (dashboard session + one-time token)
 *     before subscribing a socket or forwarding its input here. Holding a stream
 *     means driving a browser that is logging into a real account; treat the
 *     subscribe()/dispatchInput() surface as privileged.
 *   - Frames are held only as the single most-recent buffer (for late subscribers)
 *     and are never written to disk.
 *   - stop() is idempotent and detaches the CDP session; the owner calls it on
 *     EVERY login exit path so a stream never outlives its login.
 */

/** Default screencast tuning — modest size/quality keeps frames small over WS. */
const DEFAULT_OPTS = Object.freeze({
  format: 'jpeg',
  quality: 60,
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 1,
});

/** CDP mouse button names keyed by the numeric button a browser MouseEvent uses. */
const MOUSE_BUTTONS = Object.freeze({ 0: 'left', 1: 'middle', 2: 'right' });

/**
 * A live screencast of one page. One LoginStream wraps one CDP session for one
 * page; the owning login session creates it when a manual login parks awaiting a
 * human, and stops it when the login reaches a terminal state.
 */
class LoginStream {
  /**
   * @param {import('playwright').Page} page the headless page to stream.
   * @param {object} [deps]
   * @param {Function} [deps.cdpFactory] async (page) => CDPSession. Defaults to
   *   page.context().newCDPSession(page). Tests inject a fake CDP session here.
   * @param {object} [deps.options] screencast options (merged over DEFAULT_OPTS).
   * @param {(msg:string)=>void} [deps.logger] secret-free logger (default no-op).
   */
  constructor(page, deps = {}) {
    this._page = page;
    this._cdpFactory =
      deps.cdpFactory || ((p) => p.context().newCDPSession(p));
    this._options = { ...DEFAULT_OPTS, ...(deps.options || {}) };
    this._log = typeof deps.logger === 'function' ? deps.logger : () => {};

    /** @type {object|null} the CDP session (Playwright CDPSession or a fake). */
    this._client = null;
    /** @type {Set<(frame:object)=>void>} frame subscribers (WS sockets). */
    this._subscribers = new Set();
    /** @type {object|null} the most-recent frame, replayed to late subscribers. */
    this._lastFrame = null;
    this._started = false;
    this._stopped = false;
  }

  /** @returns {boolean} whether the stream is live (started and not stopped). */
  get isActive() {
    return this._started && !this._stopped;
  }

  /** @returns {number} current subscriber count (for idle/teardown decisions). */
  get subscriberCount() {
    return this._subscribers.size;
  }

  /**
   * Begin screencasting. Idempotent: a second call is a no-op. Safe to call once
   * the page is on the challenge screen; frames flow until stop().
   * @returns {Promise<void>}
   */
  async start() {
    if (this._started || this._stopped) return;
    this._started = true;
    this._client = await this._cdpFactory(this._page);
    await this._client.send('Page.enable');
    this._client.on('Page.screencastFrame', (evt) => this._onFrame(evt));
    await this._client.send('Page.startScreencast', this._options);
    this._log('[login-stream] screencast started');
  }

  /**
   * Handle one screencast frame: keep it as the latest, ack it (so Chromium keeps
   * sending), and fan it out to subscribers. Ack failures are swallowed — a closed
   * session simply stops producing frames.
   * @param {{data:string, metadata:object, sessionId:number}} evt
   */
  _onFrame(evt) {
    if (this._stopped) return;
    const frame = {
      type: 'frame',
      // base64 JPEG (no data: prefix — the client wraps it).
      data: evt.data,
      // deviceWidth/deviceHeight let the client scale input coordinates back to the
      // page's coordinate space from whatever size it renders the canvas at.
      metadata: evt.metadata || {},
    };
    this._lastFrame = frame;
    // Ack so the next frame is produced; never throw out of the event handler.
    if (this._client && evt.sessionId !== undefined) {
      Promise.resolve(
        this._client.send('Page.screencastFrameAck', { sessionId: evt.sessionId })
      ).catch(() => {});
    }
    for (const fn of this._subscribers) {
      try {
        fn(frame);
      } catch {
        /* a bad subscriber must not break the fan-out to the others */
      }
    }
  }

  /**
   * Subscribe to frames. The latest frame (if any) is delivered immediately so a
   * newly-connected dashboard paints without waiting for the next repaint.
   * @param {(frame:object)=>void} fn
   * @returns {() => void} an unsubscribe function.
   */
  subscribe(fn) {
    this._subscribers.add(fn);
    if (this._lastFrame) {
      try {
        fn(this._lastFrame);
      } catch {
        /* ignore a throwing late-join */
      }
    }
    return () => this._subscribers.delete(fn);
  }

  /**
   * Inject one client input event into the page via CDP. Unknown/malformed events
   * are ignored (defensive: the socket is authenticated but messages are untrusted
   * shape-wise). Never throws — a failed injection must not kill the login.
   * @param {object} msg one of:
   *   {t:'m', kind:'move'|'down'|'up', x, y, button?, clickCount?, modifiers?}
   *   {t:'w', x, y, dx, dy, modifiers?}                      (wheel)
   *   {t:'text', v:string}                                   (typed text)
   *   {t:'key', kind:'down'|'up', key, code?, modifiers?}    (special keys)
   * @returns {Promise<void>}
   */
  async dispatchInput(msg) {
    if (!this._client || this._stopped || !msg || typeof msg !== 'object') return;
    try {
      switch (msg.t) {
        case 'm': {
          const type =
            msg.kind === 'down'
              ? 'mousePressed'
              : msg.kind === 'up'
                ? 'mouseReleased'
                : 'mouseMoved';
          const params = {
            type,
            x: numOr(msg.x, 0),
            y: numOr(msg.y, 0),
            modifiers: numOr(msg.modifiers, 0),
          };
          if (type !== 'mouseMoved') {
            params.button = MOUSE_BUTTONS[msg.button] || 'left';
            params.clickCount = numOr(msg.clickCount, 1);
          } else if (msg.button !== undefined) {
            // A move with a held button (drag) reports the button but no click.
            params.button = MOUSE_BUTTONS[msg.button] || 'none';
          }
          await this._client.send('Input.dispatchMouseEvent', params);
          break;
        }
        case 'w': {
          await this._client.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: numOr(msg.x, 0),
            y: numOr(msg.y, 0),
            deltaX: numOr(msg.dx, 0),
            deltaY: numOr(msg.dy, 0),
            modifiers: numOr(msg.modifiers, 0),
          });
          break;
        }
        case 'text': {
          // insertText types a whole string as one unit — ideal for entering an
          // email / password / OTP without per-key code mapping.
          if (typeof msg.v === 'string' && msg.v.length > 0) {
            await this._client.send('Input.insertText', { text: msg.v });
          }
          break;
        }
        case 'key': {
          // Special keys only (Enter, Backspace, Tab, arrows…); printable text goes
          // through 'text'. Map to a CDP key event with a best-effort code/vk.
          if (typeof msg.key !== 'string') break;
          const type = msg.kind === 'up' ? 'keyUp' : 'keyDown';
          // Prefer the client-provided virtual-key code (e.keyCode, e.g. 65 for A)
          // for event fidelity. CRUCIALLY, editor shortcuts (Ctrl+A select-all, undo,
          // …) only run when the command is named explicitly via `commands` —
          // synthetic key events do NOT auto-trigger them — so we forward the
          // client's command list straight through to dispatchKeyEvent.
          await this._client.send('Input.dispatchKeyEvent', {
            type,
            key: msg.key,
            code: typeof msg.code === 'string' ? msg.code : msg.key,
            windowsVirtualKeyCode: typeof msg.vk === 'number' ? msg.vk : VK[msg.key] || 0,
            modifiers: numOr(msg.modifiers, 0),
            commands: Array.isArray(msg.commands) ? msg.commands : undefined,
          });
          break;
        }
        default:
          /* unknown event type — ignore */
          break;
      }
    } catch {
      /* injection failed (session closing / page navigated) — drop it silently */
    }
  }

  /**
   * Stop screencasting and detach the CDP session. Idempotent and never throws —
   * the owning login calls it on every exit path. Subscribers are dropped.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    // Notify subscribers the stream is ending so the WebSocket layer can close the
    // socket cleanly (rather than the client seeing a silent stall), THEN drop them.
    for (const fn of this._subscribers) {
      try {
        fn({ type: 'end' });
      } catch {
        /* a throwing subscriber must not block teardown */
      }
    }
    this._subscribers.clear();
    this._lastFrame = null;
    const client = this._client;
    this._client = null;
    if (client) {
      try {
        await client.send('Page.stopScreencast');
      } catch {
        /* session may already be gone */
      }
      try {
        if (typeof client.detach === 'function') await client.detach();
      } catch {
        /* best-effort */
      }
    }
    this._log('[login-stream] screencast stopped');
  }
}

/** Coerce to a finite number or a fallback (defends against malformed input msgs). */
function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Minimal Windows virtual-key codes for the special keys a login flow needs. CDP
 * accepts a 0 fallback for keys we don't map, which still works for most via `key`.
 */
const VK = Object.freeze({
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
});

module.exports = { LoginStream, DEFAULT_OPTS };
