import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('native Chromium errors use the supervised stderr sink without an independently growing file', () => {
  const program = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/Program.cs', import.meta.url), 'utf8');
  const policy = fs.readFileSync(new URL('../../native/Wangzai.CefBrowserHost/NativeCefLogPolicy.cs', import.meta.url), 'utf8');
  assert.match(program, /NativeCefLogPolicy\.Apply\(settings\)/u);
  assert.match(policy, /CefCommandLineArgs\["enable-logging"\]\s*=\s*"stderr"/u);
  assert.match(policy, /LogSeverity\s*=\s*LogSeverity\.Error/u, 'keep error/fatal diagnostics, not disable logging');
  assert.doesNotMatch(program, /LogFile\s*=|RotateLog\(|cef-runtime\.log/u);
  const runtime = fs.readFileSync(new URL('./cefBrowserRuntime.js', import.meta.url), 'utf8');
  assert.match(runtime, /stdio:\s*\['ignore',\s*'ignore',\s*'pipe'\]/u);
  assert.match(runtime, /this\.appendLog\('desktop-main'/u);
});
