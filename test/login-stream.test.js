'use strict';

/**
 * test/login-stream.test.js — the CDP-backed remote-browser streaming engine.
 *
 * No real browser: a fake CDP session records every `.send(method, params)` and
 * lets the test emit `Page.screencastFrame` events, so we prove the engine's wiring
 * (screencast start/ack/fan-out, late-subscriber replay, input mapping, teardown)
 * without Chromium.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { LoginStream, DEFAULT_OPTS } = require('../core/login-stream');

/** A fake CDP session: records sends, registers handlers, can emit events. */
function makeFakeCdp() {
  const sent = [];
  const handlers = {};
  return {
    sent,
    detached: false,
    async send(method, params) {
      sent.push({ method, params });
      return {};
    },
    on(event, fn) {
      (handlers[event] = handlers[event] || []).push(fn);
    },
    emit(event, payload) {
      (handlers[event] || []).forEach((fn) => fn(payload));
    },
    async detach() {
      this.detached = true;
    },
  };
}

/** A LoginStream over a fake CDP session (page is unused — cdpFactory injected). */
function makeStream(cdp, options) {
  return new LoginStream({}, { cdpFactory: () => cdp, options, logger: () => {} });
}

/** Methods of all `Input.*` sends, in order (the input-mapping assertion target). */
function inputSends(cdp) {
  return cdp.sent.filter((s) => s.method.startsWith('Input.'));
}

test('start() enables the page and starts the screencast with merged options', async () => {
  const cdp = makeFakeCdp();
  const stream = makeStream(cdp, { quality: 42 });
  await stream.start();

  const methods = cdp.sent.map((s) => s.method);
  assert.deepEqual(methods, ['Page.enable', 'Page.startScreencast']);
  const opts = cdp.sent.find((s) => s.method === 'Page.startScreencast').params;
  assert.equal(opts.format, DEFAULT_OPTS.format);
  assert.equal(opts.quality, 42, 'caller option overrides the default');
  assert.equal(stream.isActive, true);
});

test('start() is idempotent', async () => {
  const cdp = makeFakeCdp();
  const stream = makeStream(cdp);
  await stream.start();
  await stream.start();
  assert.equal(cdp.sent.filter((s) => s.method === 'Page.startScreencast').length, 1);
});

test('a screencast frame is fanned out to subscribers and acked', async () => {
  const cdp = makeFakeCdp();
  const stream = makeStream(cdp);
  await stream.start();

  const got = [];
  stream.subscribe((f) => got.push(f));
  cdp.emit('Page.screencastFrame', { data: 'AAAA', metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: 7 });

  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'frame');
  assert.equal(got[0].data, 'AAAA');
  assert.equal(got[0].metadata.deviceWidth, 800);
  // The frame must be acked or Chromium stops producing frames.
  await Promise.resolve();
  const ack = cdp.sent.find((s) => s.method === 'Page.screencastFrameAck');
  assert.ok(ack, 'frame was acked');
  assert.equal(ack.params.sessionId, 7);
});

test('subscribing after a frame replays the latest frame immediately', async () => {
  const cdp = makeFakeCdp();
  const stream = makeStream(cdp);
  await stream.start();
  cdp.emit('Page.screencastFrame', { data: 'LATEST', metadata: {}, sessionId: 1 });

  const got = [];
  stream.subscribe((f) => got.push(f));
  assert.equal(got.length, 1, 'late subscriber gets the last frame without waiting');
  assert.equal(got[0].data, 'LATEST');
});

test('unsubscribe stops further delivery; subscriberCount tracks live subscribers', async () => {
  const cdp = makeFakeCdp();
  const stream = makeStream(cdp);
  await stream.start();

  const got = [];
  const off = stream.subscribe((f) => got.push(f));
  assert.equal(stream.subscriberCount, 1);
  off();
  assert.equal(stream.subscriberCount, 0);
  cdp.emit('Page.screencastFrame', { data: 'X', metadata: {}, sessionId: 2 });
  assert.equal(got.length, 0, 'no delivery after unsubscribe');
});

test('dispatchInput maps mouse / wheel / text / key to the right CDP calls', async () => {
  const cdp = makeFakeCdp();
  const stream = makeStream(cdp);
  await stream.start();

  await stream.dispatchInput({ t: 'm', kind: 'down', x: 10, y: 20, button: 0, clickCount: 2 });
  await stream.dispatchInput({ t: 'm', kind: 'move', x: 11, y: 21 });
  await stream.dispatchInput({ t: 'w', x: 5, y: 6, dx: 0, dy: -120 });
  await stream.dispatchInput({ t: 'text', v: 'user@example.com' });
  await stream.dispatchInput({ t: 'key', kind: 'down', key: 'Enter' });

  const inputs = inputSends(cdp);
  assert.equal(inputs[0].method, 'Input.dispatchMouseEvent');
  assert.equal(inputs[0].params.type, 'mousePressed');
  assert.equal(inputs[0].params.button, 'left');
  assert.equal(inputs[0].params.clickCount, 2);

  assert.equal(inputs[1].params.type, 'mouseMoved');

  assert.equal(inputs[2].params.type, 'mouseWheel');
  assert.equal(inputs[2].params.deltaY, -120);

  assert.equal(inputs[3].method, 'Input.insertText');
  assert.equal(inputs[3].params.text, 'user@example.com');

  assert.equal(inputs[4].method, 'Input.dispatchKeyEvent');
  assert.equal(inputs[4].params.type, 'keyDown');
  assert.equal(inputs[4].params.key, 'Enter');
  assert.equal(inputs[4].params.windowsVirtualKeyCode, 13);
});

test('dispatchInput forwards a modifier shortcut (Ctrl+A) with code, vk, and modifiers', async () => {
  const cdp = makeFakeCdp();
  const stream = makeStream(cdp);
  await stream.start();

  // Ctrl+A: select-all is an editing command. It must go as a key event with the
  // Ctrl modifier (2), the right code/vk, AND the explicit `commands` list — without
  // which a synthetic key event never runs select-all.
  await stream.dispatchInput({
    t: 'key',
    kind: 'down',
    key: 'a',
    code: 'KeyA',
    vk: 65,
    modifiers: 2,
    commands: ['selectAll'],
  });

  const evt = inputSends(cdp).at(-1);
  assert.equal(evt.method, 'Input.dispatchKeyEvent');
  assert.equal(evt.params.type, 'keyDown');
  assert.equal(evt.params.code, 'KeyA');
  assert.equal(evt.params.windowsVirtualKeyCode, 65, 'client-provided vk is honored');
  assert.equal(evt.params.modifiers, 2, 'Ctrl modifier bit is forwarded');
  assert.deepEqual(evt.params.commands, ['selectAll'], 'the editor command is named explicitly');
});

test('dispatchInput ignores malformed / unknown messages without throwing or sending', async () => {
  const cdp = makeFakeCdp();
  const stream = makeStream(cdp);
  await stream.start();
  const before = inputSends(cdp).length;

  await stream.dispatchInput(null);
  await stream.dispatchInput({});
  await stream.dispatchInput({ t: 'nope' });
  await stream.dispatchInput({ t: 'text' }); // missing v
  await stream.dispatchInput({ t: 'text', v: '' }); // empty string is a no-op

  assert.equal(inputSends(cdp).length, before, 'no Input.* sent for junk messages');
});

test('stop() stops the screencast, detaches, is idempotent, and halts frames', async () => {
  const cdp = makeFakeCdp();
  const stream = makeStream(cdp);
  await stream.start();
  const got = [];
  stream.subscribe((f) => got.push(f));

  await stream.stop();
  await stream.stop(); // idempotent

  assert.ok(cdp.sent.some((s) => s.method === 'Page.stopScreencast'), 'stopScreencast sent');
  assert.equal(cdp.detached, true, 'CDP session detached');
  assert.equal(stream.isActive, false);
  assert.equal(stream.subscriberCount, 0);

  // stop() delivers a single terminal {type:'end'} so the client can close cleanly.
  assert.equal(got.length, 1, 'subscriber received exactly the end event');
  assert.equal(got[0].type, 'end');

  // Frames arriving after stop are dropped (no throw, no further delivery).
  cdp.emit('Page.screencastFrame', { data: 'late', metadata: {}, sessionId: 9 });
  assert.equal(got.length, 1, 'no frames delivered after stop');
});
