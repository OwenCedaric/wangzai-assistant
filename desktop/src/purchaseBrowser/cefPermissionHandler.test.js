import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..');
const permissionHandlerSource = fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'InternalPermissionHandler.cs'),
  'utf8',
);

test('CEF browser denies media and unsolicited page permissions without showing a native prompt', () => {
  assert.match(permissionHandlerSource, /callback\.Cancel\(\)/u);
  assert.match(permissionHandlerSource, /callback\.Continue\(PermissionRequestResult\.Deny\)/u);
  assert.doesNotMatch(permissionHandlerSource, /MessageBox\.Show/u);
  assert.doesNotMatch(permissionHandlerSource, /浏览器权限/u);
  assert.doesNotMatch(permissionHandlerSource, /PermissionRequestResult\.Accept/u);
});
