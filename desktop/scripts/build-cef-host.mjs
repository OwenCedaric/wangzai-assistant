import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(
  desktopRoot,
  'native',
  'Wangzai.CefBrowserHost',
  'Wangzai.CefBrowserHost.csproj',
);
const publishDirectory = path.join(
  desktopRoot,
  'native',
  'Wangzai.CefBrowserHost',
  'publish',
);
const projectDotnet = path.join(desktopRoot, '.tools', 'dotnet', 'dotnet.exe');
const legacyLocalDotnet = path.join(desktopRoot, '..', '.tools', 'dotnet', 'dotnet.exe');
const dotnet = fs.existsSync(projectDotnet)
  ? projectDotnet
  : fs.existsSync(legacyLocalDotnet)
    ? legacyLocalDotnet
    : 'dotnet';

// dotnet publish does not remove files produced by earlier smoke runs. A
// clean output prevents cef-runtime.log/cef-host-error.log from leaking into
// the signed installation bundle.
fs.rmSync(publishDirectory, { recursive: true, force: true });
fs.mkdirSync(publishDirectory, { recursive: true });

execFileSync(dotnet, [
  'publish',
  project,
  '--configuration',
  'Release',
  '--runtime',
  'win-x64',
  '--self-contained',
  'true',
  '--output',
  publishDirectory,
], {
  cwd: desktopRoot,
  stdio: 'inherit',
});

const executable = path.join(publishDirectory, 'Wangzai.CefBrowserHost.exe');
if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
  throw new Error('PURCHASE_BROWSER_CEF_HOST_PUBLISH_MISSING');
}
console.log(JSON.stringify({
  ok: true,
  engine: 'cef',
  executable,
  publishDirectory,
}));
