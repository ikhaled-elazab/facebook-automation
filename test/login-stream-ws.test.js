'use strict';

/**
 * test/login-stream-ws.test.js — the authenticated remote-browser WebSocket bridge.
 *
 * Drives the real attachLoginStreamWs() over a real HTTP server with a real `ws`
 * client, injecting a FAKE session middleware (to toggle auth) and a FAKE login
 * registry + stream (to avoid a real browser). Proves: unauthenticated upgrades are
 * refused, missing-stream upgrades are refused, cross-origin is refused, and the
 * happy path relays frames out + input in and closes on stream end.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');

const { attachLoginStreamWs } = require('../server/login-stream-ws');

/** A fake LoginStream: records subscribers + dispatched input; can emit frames. */
function makeFakeStream() {
  const subs = new Set();
  const dispatched = [];
  return {
    dispatched,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    emit(frame) {
      for (const fn of subs) fn(frame);
    },
    async dispatchInput(msg) {
      dispatched.push(msg);
    },
    subscriberCount: () => subs.size,
  };
}

/**
 * Start an HTTP server with the stream WS attached.
 * @param {object} cfg
 * @param {boolean} cfg.authenticated whether the fake session marks the request authed.
 * @param {Map<number, object>} cfg.streams accountId → fake stream.
 */
function startServer({ authenticated, streams }) {
  const server = http.createServer((_req, res) => res.end());
  const sessionMiddleware = (req, _res, next) => {
    req.session = { authenticated };
    next();
  };
  const loginControl = { getStream: (id) => streams.get(id) || null };
  const handle = attachLoginStreamWs({
    server,
    sessionMiddleware,
    loginControl,
    logger: { warn() {}, error() {} },
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `ws://127.0.0.1:${port}`,
        async close() {
          await handle.close();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

/** Resolve 'open' | 'close' | 'error' for a connecting socket (whichever first). */
function settle(ws) {
  return new Promise((resolve) => {
    ws.once('open', () => resolve('open'));
    ws.once('error', () => resolve('error'));
    ws.once('unexpected-response', () => resolve('error'));
    ws.once('close', () => resolve('close'));
  });
}

test('rejects an unauthenticated upgrade', async () => {
  const srv = await startServer({ authenticated: false, streams: new Map() });
  const ws = new WebSocket(`${srv.url}/api/accounts/1/login/stream`);
  const outcome = await settle(ws);
  assert.notEqual(outcome, 'open', 'unauthenticated socket must not open');
  ws.terminate();
  await srv.close();
});

test('rejects when there is no live stream for the account', async () => {
  const srv = await startServer({ authenticated: true, streams: new Map() });
  const ws = new WebSocket(`${srv.url}/api/accounts/1/login/stream`);
  const outcome = await settle(ws);
  assert.notEqual(outcome, 'open', 'no-stream socket must not open');
  ws.terminate();
  await srv.close();
});

test('rejects a non-stream path', async () => {
  const srv = await startServer({ authenticated: true, streams: new Map() });
  const ws = new WebSocket(`${srv.url}/api/accounts/1/login/elsewhere`);
  const outcome = await settle(ws);
  assert.notEqual(outcome, 'open');
  ws.terminate();
  await srv.close();
});

test('rejects a cross-origin upgrade', async () => {
  const streams = new Map([[1, makeFakeStream()]]);
  const srv = await startServer({ authenticated: true, streams });
  const ws = new WebSocket(`${srv.url}/api/accounts/1/login/stream`, {
    origin: 'http://evil.example',
  });
  const outcome = await settle(ws);
  assert.notEqual(outcome, 'open', 'cross-origin socket must not open');
  ws.terminate();
  await srv.close();
});

test('authenticated happy path: frames out, input in, end closes the socket', async () => {
  const stream = makeFakeStream();
  const streams = new Map([[7, stream]]);
  const srv = await startServer({ authenticated: true, streams });

  const ws = new WebSocket(`${srv.url}/api/accounts/7/login/stream`);
  assert.equal(await settle(ws), 'open', 'authenticated + live stream connects');
  assert.equal(stream.subscriberCount(), 1, 'socket subscribed to the stream');

  // Frame out: the server pushes a screencast frame; the client receives it.
  const gotFrame = new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
  stream.emit({ type: 'frame', data: 'ABC', metadata: { deviceWidth: 800, deviceHeight: 600 } });
  const frame = await gotFrame;
  assert.equal(frame.type, 'frame');
  assert.equal(frame.data, 'ABC');

  // Input in: the client sends a mouse event; it reaches stream.dispatchInput.
  ws.send(JSON.stringify({ t: 'm', kind: 'down', x: 5, y: 6, button: 0 }));
  await waitFor(() => stream.dispatched.length === 1);
  assert.deepEqual(stream.dispatched[0], { t: 'm', kind: 'down', x: 5, y: 6, button: 0 });

  // End: the stream ends → the socket is closed by the server.
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  stream.emit({ type: 'end' });
  const code = await closed;
  assert.equal(code, 1000, 'server closes the socket with a normal code on stream end');

  await srv.close();
});

test('malformed inbound messages are ignored (no throw, not dispatched)', async () => {
  const stream = makeFakeStream();
  const streams = new Map([[3, stream]]);
  const srv = await startServer({ authenticated: true, streams });

  const ws = new WebSocket(`${srv.url}/api/accounts/3/login/stream`);
  assert.equal(await settle(ws), 'open');
  ws.send('not json at all');
  ws.send(JSON.stringify({ t: 'm', kind: 'down', x: 1, y: 1 }));
  await waitFor(() => stream.dispatched.length === 1);
  assert.equal(stream.dispatched.length, 1, 'only the valid message was dispatched');

  ws.terminate();
  await srv.close();
});

/** Poll a predicate up to ~1s (for async cross-socket propagation). */
async function waitFor(pred) {
  for (let i = 0; i < 100; i += 1) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: condition not met in time');
}
