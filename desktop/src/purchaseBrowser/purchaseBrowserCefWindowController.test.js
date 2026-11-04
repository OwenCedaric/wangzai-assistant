import assert from 'node:assert/strict';
import test from 'node:test';
import { createPurchaseBrowserCefWindowController } from './purchaseBrowserCefWindowController.js';

function fakeParent(bounds = { x: 100, y: 80, width: 1200, height: 800 }) {
  const listeners = new Map();
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getBounds: () => ({ ...bounds }),
    getContentBounds: () => ({ ...bounds }),
    on(eventName, listener) { listeners.set(eventName, listener); },
    removeListener(eventName) { listeners.delete(eventName); },
    emit(eventName) { listeners.get(eventName)?.(); },
  };
}

test('native presentation controller never creates an Electron browser shell and publishes physical bounds', async () => {
  const parent = fakeParent();
  const published = [];
  const controller = createPurchaseBrowserCefWindowController({
    screen: {
      getDisplayMatching: () => ({
        scaleFactor: 1.25,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    getParentWindow: () => parent,
    onBoundsChanged: async (bounds) => { published.push(bounds); },
  });

  assert.equal(await controller.ensure(), parent);
  assert.equal(await controller.showLoading(), parent);
  assert.equal(published.at(-1).visible, false);

  assert.equal(await controller.showReady(), parent);
  const ready = published.at(-1);
  assert.equal(ready.visible, true);
  assert.ok(ready.width >= 640);
  assert.ok(ready.height >= 480);
  assert.equal(Number.isInteger(ready.x), true);
  assert.equal(Number.isInteger(ready.y), true);
  assert.deepEqual(controller.viewportBounds({ visible: true }), ready);

  controller.setBrowserState({ visible: false });
  assert.equal(controller.viewportBounds({ visible: true }).visible, false);
  await controller.restore();
  assert.equal(controller.viewportBounds({ visible: true }).visible, true);

  controller.hide();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.at(-1).visible, false);
  assert.equal(controller.getWindow(), parent);
  controller.dispose();
});

test('payment-related standalone CEF windows use the same Alipay H5 proportion', () => {
  const controller = createPurchaseBrowserCefWindowController({
    screen: {
      getDisplayMatching: () => ({
        scaleFactor: 1.25,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    getParentWindow: () => fakeParent(),
  });
  const bounds = controller.standaloneBoundsForSize({ width: 520, height: 800 });
  assert.equal(bounds.width, 650);
  assert.equal(bounds.height, 1000);
  assert.equal(bounds.visible, true);
  assert.equal(bounds.compact, true);
  controller.dispose();
});

test('native presentation controller fails closed without the Electron main-window IPC owner', async () => {
  const controller = createPurchaseBrowserCefWindowController({
    screen: { getDisplayMatching: () => ({ workArea: { width: 1920, height: 1080 }, scaleFactor: 1 }) },
    getParentWindow: () => null,
  });
  await assert.rejects(() => controller.ensure(), /PURCHASE_BROWSER_HOST_WINDOW_REQUIRED/u);
  assert.equal(controller.getWindow(), null);
});

test('native presentation controller treats cancelled hide bounds as a benign lifecycle result', async () => {
  const logs = [];
  const error = Object.assign(new Error('PURCHASE_BROWSER_COMMAND_CANCELLED'), {
    code: 'PURCHASE_BROWSER_COMMAND_CANCELLED',
  });
  const controller = createPurchaseBrowserCefWindowController({
    screen: {
      getDisplayMatching: () => ({
        scaleFactor: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    getParentWindow: () => fakeParent(),
    onBoundsChanged: async () => { throw error; },
    appendLog: (_name, message) => logs.push(message),
  });

  assert.equal(controller.hide(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(logs.join(''), /PURCHASE_BROWSER_COMMAND_CANCELLED/u);
  controller.dispose();
});

test('native presentation controller maps the React viewport to physical parent-client coordinates', async () => {
  const parentBounds = { x: 108, y: 92, width: 1400, height: 900 };
  const parent = fakeParent(parentBounds);
  const published = [];
  const controller = createPurchaseBrowserCefWindowController({
    screen: {
      getDisplayMatching: () => ({
        scaleFactor: 1.25,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    getParentWindow: () => parent,
    onBoundsChanged: async (bounds) => { published.push(bounds); return bounds; },
  });

  await controller.setEmbeddedViewport({ x: 420, y: 70, width: 800, height: 600, visible: true });
  assert.equal(published.at(-1).visible, false);
  await controller.showReady({ embedded: true });
  assert.deepEqual(published.at(-1), {
    x: 525,
    y: 87,
    width: 1000,
    height: 750,
    visible: true,
    boundsVersion: 2,
  });

  const publishCount = published.length;
  parentBounds.x = 120;
  parent.emit('move');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.length, publishCount);
  assert.equal(published.at(-1).x, 525);

  await controller.clearEmbeddedViewport();
  assert.equal(published.at(-1).visible, false);
  controller.dispose();
});

test('atomic embedded hide freezes locally and rejects a late visible readback generation', async () => {
  const published = [];
  const controller = createPurchaseBrowserCefWindowController({
    screen: {
      getDisplayMatching: () => ({
        scaleFactor: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    getParentWindow: () => fakeParent(),
    onBoundsChanged: async (bounds) => { published.push(bounds); return bounds; },
  });

  await controller.setEmbeddedViewport({ x: 420, y: 70, width: 800, height: 600, visible: true });
  await controller.showReady({ embedded: true });
  const visibleVersion = published.at(-1).boundsVersion;
  const frozen = await controller.clearEmbeddedViewport({ notify: false });
  assert.equal(published.at(-1).visible, true, 'freeze does not queue a supersedable normal bounds command');
  assert.equal(frozen.visible, false);
  assert.ok(frozen.boundsVersion > visibleVersion);

  controller.setBrowserState({
    visible: true,
    boundsVersion: visibleVersion,
    activeTabId: 'embedded-a',
    tabs: [{ tabId: 'embedded-a', embedding: { requested: true } }],
  });
  assert.equal(controller.viewportBounds({ visible: true }).visible, false);
  controller.setBrowserState({ visible: false, boundsVersion: frozen.boundsVersion + 3 });
  assert.ok(controller.viewportBounds().boundsVersion >= frozen.boundsVersion + 3);
  controller.dispose();
});

test('embedded viewport can be primed without entering the supersedable bounds queue', async () => {
  const published = [];
  const controller = createPurchaseBrowserCefWindowController({
    screen: {
      getDisplayMatching: () => ({
        scaleFactor: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    getParentWindow: () => fakeParent(),
    onBoundsChanged: async (bounds) => { published.push(bounds); return bounds; },
  });
  const primed = await controller.setEmbeddedViewport(
    { x: 400, y: 60, width: 780, height: 620, visible: true },
    { notify: false },
  );
  assert.equal(published.length, 0);
  assert.deepEqual(primed, {
    x: 400,
    y: 60,
    width: 780,
    height: 620,
    visible: false,
    boundsVersion: 1,
  });
  controller.dispose();
});

test('embedded child keeps desired bounds while Windows suppresses it with a minimized parent', async () => {
  const listeners = new Map();
  let minimized = false;
  const parent = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => minimized,
    getBounds: () => ({ x: 100, y: 80, width: 1200, height: 800 }),
    getContentBounds: () => ({ x: 100, y: 80, width: 1200, height: 800 }),
    on(eventName, listener) { listeners.set(eventName, listener); },
    removeListener(eventName) { listeners.delete(eventName); },
    emit(eventName) { listeners.get(eventName)?.(); },
  };
  const published = [];
  const controller = createPurchaseBrowserCefWindowController({
    screen: {
      getDisplayMatching: () => ({
        scaleFactor: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    getParentWindow: () => parent,
    onBoundsChanged: async (bounds) => { published.push(bounds); return bounds; },
  });

  await controller.setEmbeddedViewport({ x: 420, y: 70, width: 800, height: 600, visible: true });
  await controller.showReady({ embedded: true });
  assert.equal(published.at(-1).visible, true);

  minimized = true;
  parent.emit('minimize');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.at(-1).visible, true);
  // A stale observed snapshot cannot close the still-visible React card.
  minimized = false;
  controller.setBrowserState({ visible: false });

  parent.emit('restore');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.at(-1).visible, true);
  controller.dispose();
});

test('standalone native login window remains visible when the Electron owner is hidden', async () => {
  const parent = {
    ...fakeParent(),
    isVisible: () => false,
    isMinimized: () => true,
  };
  const published = [];
  const controller = createPurchaseBrowserCefWindowController({
    screen: {
      getDisplayMatching: () => ({
        scaleFactor: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    getParentWindow: () => parent,
    onBoundsChanged: async (bounds) => { published.push(bounds); return bounds; },
  });

  await controller.showReady({ embedded: false });

  assert.equal(published.at(-1).visible, true);
  assert.equal(controller.viewportBounds({ visible: true }).visible, true);
  controller.dispose();
});

