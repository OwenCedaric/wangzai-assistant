import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCefBrowserRuntime,
  createCefHostArguments,
  pruneCefTransientCache,
} from './cefBrowserRuntime.js';

test('CEF host arguments install managed browser extensions before Chromium starts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cef-runtime-args-'));
  const extension = path.join(root, 'browser extensions', 'ozon-observer');
  const args = createCefHostArguments({
    ipcPipe: 'wangzai-test-pipe',
    rootCachePath: path.join(root, 'cache'),
    extensionsRoot: path.join(root, 'extensions'),
    builtInExtensionDirectories: [extension, extension],
  });
  assert.deepEqual(args.filter((value) => value.startsWith('--wangzai-built-in-extension=')), [
    '--wangzai-built-in-extension=' + path.resolve(extension),
  ]);
});

test('CEF runtime exposes one shared native host lifecycle and never falls back to a system browser', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cef-runtime-'));
  const runtime = createCefBrowserRuntime({
    executable: path.join(root, 'missing.exe'),
    rootCachePath: path.join(root, 'cache'),
  });
  assert.equal(typeof runtime.open, 'function');
  assert.equal(typeof runtime.shutdown, 'function');
  await assert.rejects(
    runtime.open({
      profile: {
        ownerRef: '0123456789abcdef0123456789abcdef01234567',
      },
      profileRoot: path.join(root, 'profiles'),
      downloadsDirectory: path.join(root, 'downloads'),
      url: 'https://example.com/',
    }),
    (error) => error.code === 'PURCHASE_BROWSER_CEF_HOST_MISSING',
  );
  await runtime.shutdown();
});

test('CEF runtime keeps browser profile data under the caller-owned data root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cef-runtime-data-'));
  const runtime = createCefBrowserRuntime({
    executable: path.join(root, 'missing.exe'),
    rootCachePath: path.join(root, 'cache-root'),
  });
  assert.equal(runtime.nativeWindowHandle(), '0');
  runtime.dispose();
});

test('CEF runtime fences every stale session after the shared native host crashes', () => {
  const source = fs.readFileSync(new URL('./cefBrowserRuntime.js', import.meta.url), 'utf8');
  const crashBranch = source.match(/if \(event === 'crashed'\) \{([\s\S]*?)\n    \}/u)?.[1] || '';

  assert.match(crashBranch, /for \(const session of sessions\.values\(\)\) session\.invalidated = true;/u);
  assert.match(crashBranch, /sessions\.clear\(\);/u);
  assert.ok(crashBranch.indexOf('sessions.clear();') < crashBranch.indexOf('connection = null;'));
});

test('cache maintenance prunes transient data across ten profiles and preserves cookies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cef-runtime-prune-'));
  try {
    for (let index = 0; index < 10; index += 1) {
      const owner = index.toString(16).padStart(40, '0');
      const profile = path.join(root, owner);
      fs.mkdirSync(path.join(profile, 'Cache'), { recursive: true });
      fs.writeFileSync(path.join(profile, 'Cache', 'payload.bin'), Buffer.alloc(200, index));
      fs.writeFileSync(path.join(profile, 'Cookies'), Buffer.alloc(20, index));
    }
    const result = pruneCefTransientCache({
      rootCachePath: root,
      hardLimitBytes: 1_000,
      targetBytes: 220,
    });
    assert.equal(result.removed, 10);
    for (let index = 0; index < 10; index += 1) {
      const owner = index.toString(16).padStart(40, '0');
      assert.equal(fs.existsSync(path.join(root, owner, 'Cache')), false);
      assert.equal(fs.existsSync(path.join(root, owner, 'Cookies')), true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
