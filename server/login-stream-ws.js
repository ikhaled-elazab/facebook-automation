'use strict';

/**
 * server/login-stream-ws.js — the authenticated WebSocket bridge for the dashboard
 * "remote browser" (manual login). It connects a dashboard socket to the live
 * LoginStream for one account: server screencast frames flow OUT to the socket, and
 * the operator's mouse / keyboard flow IN and are injected into the headless page.
 *
 * Endpoint:  GET (Upgrade) /api/accounts/:id/login/stream
 *
 * ── SECURITY (this surface drives a browser logging into a real account) ──────
 *   1. Loopback + SSH: the control plane binds 127.0.0.1 only and is reached via an
 *      SSH tunnel, so this endpoint is never publicly exposed (parity with the REST
 *      API). Defense in depth follows.
 *   2. Session auth: the upgrade runs the SAME express-session middleware as the
 *      REST API and is rejected unless req.session.authenticated === true — i.e.
 *      only a logged-in dashboard operator can attach. The opaque httpOnly,
 *      SameSite=strict session cookie is the credential.
 *   3. Same-origin: an Upgrade carrying an Origin whose host differs from the Host
 *      header is rejected (blocks cross-origin socket attempts; SameSite=strict
 *      already prevents the cookie riding a cross-site request, this is belt-and-
 *      suspenders for non-cookie auth contexts).
 *   4. Scope: the socket is bound to ONE account's live stream via
 *      loginControl.getStream(id); if there is no live streamed manual login for
 *      that account the upgrade is refused.
 *   5. Bounds: inbound messages are capped (maxPayload) and outbound frames are
 *      dropped when the socket is backpressured, so a slow/hostile client cannot
 *      exhaust server memory. Nothing from this channel is logged or persisted.
 */

const http = require('http');
const { WebSocketServer } = require('ws');

/** Only this exact path is a stream upgrade; the capture group is the account id. */
const STREAM_PATH = /^\/api\/accounts\/(\d+)\/login\/stream$/;

/** Cap a single inbound input message (mouse/key/text are tiny; 64KB is generous). */
const MAX_INBOUND_BYTES = 64 * 1024;
/** Drop outbound frames once the socket has this many unsent bytes buffered. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Attach the login-stream WebSocket handler to an HTTP server.
 * @param {object} params
 * @param {import('http').Server} params.server the listening HTTP server.
 * @param {import('express').RequestHandler} params.sessionMiddleware the SAME
 *   express-session instance the app uses (to populate req.session on the upgrade).
 * @param {{getStream:(id:number)=>object|null}} params.loginControl the login
 *   registry (only getStream is used here).
 * @param {{warn:Function, error:Function}} [params.logger]
 * @returns {{wss: import('ws').WebSocketServer, close: ()=>Promise<void>}}
 */
function attachLoginStreamWs({ server, sessionMiddleware, loginControl, logger = console }) {
  // noServer: we own the HTTP upgrade so we can authenticate BEFORE accepting.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_BYTES });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return reject(socket, 400, 'Bad Request');
    }

    const match = STREAM_PATH.exec(pathname);
    if (!match) {
      // Not our endpoint and there are no other WS handlers — refuse cleanly.
      return reject(socket, 404, 'Not Found');
    }

    // Same-origin enforcement: if an Origin is present it must match the Host.
    const origin = req.headers.origin;
    if (origin) {
      let originHost;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (!originHost || originHost !== req.headers.host) {
        return reject(socket, 403, 'Forbidden');
      }
    }

    // Run the real session middleware to populate req.session. A throwaway
    // ServerResponse satisfies express-session's res.end/writeHead patching; we
    // never write to it (the session is only READ here, never re-saved).
    const res = new http.ServerResponse(req);
    sessionMiddleware(req, res, () => {
      if (!req.session || req.session.authenticated !== true) {
        return reject(socket, 401, 'Unauthorized');
      }

      const accountId = Number(match[1]);
      const stream = loginControl.getStream(accountId);
      if (!stream) {
        // No live streamed manual login for this account (never launched, already
        // finished, or an auto login). 409: the precondition is not met.
        return reject(socket, 409, 'No active remote login for this account');
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        bindSocketToStream(ws, stream, logger);
      });
    });
  });

  return {
    wss,
    close() {
      return new Promise((resolve) => {
        for (const client of wss.clients) {
          try {
            client.close(1001, 'server shutting down');
          } catch {
            /* best-effort */
          }
        }
        wss.close(() => resolve());
      });
    },
  };
}

/**
 * Wire one accepted socket to a stream: frames out, input in, cleanup on close.
 * @param {import('ws').WebSocket} ws
 * @param {object} stream a LoginStream
 * @param {{warn:Function, error:Function}} logger
 */
function bindSocketToStream(ws, stream, logger) {
  // Frames out — drop when the socket is backpressured so a slow client cannot
  // make us buffer unbounded JPEG frames. The 'end' event closes the socket.
  const off = stream.subscribe((frame) => {
    if (ws.readyState !== ws.OPEN) return;
    if (frame.type === 'end') {
      try {
        ws.close(1000, 'login finished');
      } catch {
        /* ignore */
      }
      return;
    }
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return; // shed load
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* a failed send just drops this frame */
    }
  });

  // Input in — parse defensively and inject via the stream. Malformed messages are
  // ignored by dispatchInput; we only guard the JSON.parse here.
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // not JSON — ignore
    }
    // Never await — input is fire-and-forget; a slow injection must not block reads.
    Promise.resolve(stream.dispatchInput(msg)).catch(() => {});
  });

  ws.on('close', off);
  ws.on('error', (err) => {
    off();
    logger.warn && logger.warn(`[login-stream-ws] socket error: ${err.message}`);
  });
}

/** Reject an upgrade with a minimal HTTP response, then destroy the socket. */
function reject(socket, status, message) {
  const reason = `${status} ${message}`;
  try {
    socket.write(
      `HTTP/1.1 ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
    );
  } catch {
    /* socket may already be gone */
  }
  socket.destroy();
}

module.exports = { attachLoginStreamWs };
