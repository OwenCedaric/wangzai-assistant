import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LEGACY_RETIREMENT_CANONICAL_TARGETS } from './legacyRetirementFault.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(currentDirectory, '..', '..');
const retiredReaderKeys = Object.freeze([
  ['fee-plan-state', 'wangzai-fee-plan-state'],
  ['fee-settings', 'wangzai-fee-settings'],
  ['prompt-library-categories', 'wangzai-prompt-library-categories'],
  ['prompt-library-items', 'wangzai-prompt-library-items'],
  ['model-api-settings', 'wangzai-image2-model-api-settings'],
  ['purchase-account-settings', 'wangzai-structured-settings-records:purchaseAccount'],
  ['platform-api-settings', 'wangzai-structured-settings-records:platformApi'],
  ['watermark-settings', 'wangzai-active-watermark-template-id'],
  ['cross-border-settings', 'wangzai-cross-border-bus-settings'],
]);

test('retired reader keys have no Electron fixture seed, runner option, or fault target', async () => {
  const [windowSource, runnerSource] = await Promise.all([
    fs.readFile(path.join(desktopRoot, 'src', 'window', 'mainWindow.js'), 'utf8'),
    fs.readFile(path.join(desktopRoot, 'scripts', 'legacy-browser-retirement-roundtrip.mjs'), 'utf8'),
  ]);

  retiredReaderKeys.forEach(([fixtureId, key]) => {
    assert.doesNotMatch(windowSource, new RegExp(key, 'u'));
    assert.doesNotMatch(runnerSource, new RegExp(key, 'u'));
    assert.equal(Object.hasOwn(LEGACY_RETIREMENT_CANONICAL_TARGETS, fixtureId), false);
  });
});

test('both retired watermark keys and their obsolete file route are absent', async () => {
  const [windowSource, runnerSource, protocolSource] = await Promise.all([
    fs.readFile(path.join(desktopRoot, 'src', 'window', 'mainWindow.js'), 'utf8'),
    fs.readFile(path.join(desktopRoot, 'scripts', 'legacy-browser-retirement-roundtrip.mjs'), 'utf8'),
    fs.readFile(path.join(desktopRoot, 'src', 'protocol', 'appProtocol.js'), 'utf8'),
  ]);

  assert.doesNotMatch(windowSource, /wangzai-watermark-templates/u);
  assert.doesNotMatch(runnerSource, /wangzai-watermark-templates/u);
  assert.doesNotMatch(windowSource, /wangzai-active-watermark-template-id/u);
  assert.doesNotMatch(runnerSource, /wangzai-active-watermark-template-id/u);
  assert.doesNotMatch(windowSource, /"watermark-settings"/u);
  assert.doesNotMatch(runnerSource, /"watermark-settings"/u);
  assert.doesNotMatch(protocolSource, /'watermark-settings'/u);
  assert.equal(Object.hasOwn(LEGACY_RETIREMENT_CANONICAL_TARGETS, 'watermark-settings'), false);
});

test('the retired cross-border fixture and obsolete file route are absent', async () => {
  const [windowSource, runnerSource, protocolSource] = await Promise.all([
    fs.readFile(path.join(desktopRoot, 'src', 'window', 'mainWindow.js'), 'utf8'),
    fs.readFile(path.join(desktopRoot, 'scripts', 'legacy-browser-retirement-roundtrip.mjs'), 'utf8'),
    fs.readFile(path.join(desktopRoot, 'src', 'protocol', 'appProtocol.js'), 'utf8'),
  ]);

  assert.doesNotMatch(windowSource, /"cross-border-settings"/u);
  assert.doesNotMatch(runnerSource, /"cross-border-settings"/u);
  assert.doesNotMatch(protocolSource, /'cross-border-bus-settings'/u);
  assert.equal(Object.hasOwn(LEGACY_RETIREMENT_CANONICAL_TARGETS, 'cross-border-settings'), false);
});

test('the retired Ozon shop-account browser key is not seeded or read by the desktop harness', async () => {
  const [windowSource, runnerSource] = await Promise.all([
    fs.readFile(path.join(desktopRoot, 'src', 'window', 'mainWindow.js'), 'utf8'),
    fs.readFile(path.join(desktopRoot, 'scripts', 'legacy-browser-retirement-roundtrip.mjs'), 'utf8'),
  ]);
  assert.doesNotMatch(windowSource, /wangzai-ozon-shops/u);
  assert.doesNotMatch(runnerSource, /wangzai-ozon-shops/u);
});

test('the retired active-Ozon-shop browser key is not seeded or read by the desktop harness', async () => {
  const [windowSource, runnerSource] = await Promise.all([
    fs.readFile(path.join(desktopRoot, 'src', 'window', 'mainWindow.js'), 'utf8'),
    fs.readFile(path.join(desktopRoot, 'scripts', 'legacy-browser-retirement-roundtrip.mjs'), 'utf8'),
  ]);
  assert.doesNotMatch(windowSource, /wangzai-active-ozon-shop-id/u);
  assert.doesNotMatch(runnerSource, /wangzai-active-ozon-shop-id/u);
});

test('all final R8 browser keys are absent from desktop fixture and runner source', async () => {
  const [windowSource, runnerSource] = await Promise.all([
    fs.readFile(path.join(desktopRoot, 'src', 'window', 'mainWindow.js'), 'utf8'),
    fs.readFile(path.join(desktopRoot, 'scripts', 'legacy-browser-retirement-roundtrip.mjs'), 'utf8'),
  ]);
  [
    'wangzai-ozon-default-warehouse-by-shop',
    'wangzai-product-material-profiles-v1',
    'wangzai-marketing-activity-cache-v1',
    'wz-product-source-links',
    'wz-purchase-order-local-overrides',
    'wz-purchase-source-links',
    'wz-sales-source-links',
    'wz-purchase-source-plugin-context',
  ].forEach((key) => {
    assert.doesNotMatch(windowSource, new RegExp(key, 'u'));
    assert.doesNotMatch(runnerSource, new RegExp(key, 'u'));
  });
});
