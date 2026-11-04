import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '../..');

export async function verifyPilotStartup(stageDirectory) {
  const stage = path.resolve(stageDirectory);
  if (!stage.startsWith(path.join(workspace, '.codex-temp') + path.sep)) throw new Error('PILOT_SMOKE_STAGE_INVALID');
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'stage-manifest.json'), 'utf8'));
  if (manifest.identity?.appId !== 'com.wangzai.assistant.desktop.pilot') throw new Error('PILOT_SMOKE_IDENTITY_INVALID');
  const executable = path.join(stage, 'installer-output/win-unpacked', `${manifest.identity.productName}.exe`);
  if (!fs.existsSync(executable)) throw new Error('PILOT_SMOKE_EXECUTABLE_MISSING');
  const fixture = fs.mkdtempSync(path.join(stage, 'startup-fixture-'));
  const profile = path.join(fixture, 'pilot-profile');
  const sentinel = path.join(fixture, 'normal-profile-sentinel');
  fs.mkdirSync(sentinel); fs.writeFileSync(path.join(sentinel, 'untouched.txt'), 'do-not-use-this-profile', { flag: 'wx' });
  const env = { ...process.env, WANGZAI_PILOT_DATA_DIR: profile, WANGZAI_DESKTOP_DATA_DIR: sentinel };
  delete env.ELECTRON_RUN_AS_NODE;
  const stdout = fs.openSync(path.join(fixture, 'stdout.log'), 'wx');
  const stderr = fs.openSync(path.join(fixture, 'stderr.log'), 'wx');
  let child, timedOut = false;
  const result = await new Promise((resolve, reject) => {
    child = spawn(executable, ['--smoke-test'], { cwd: path.dirname(executable), env, windowsHide: true, stdio: ['ignore', stdout, stderr] });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }, 90_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  }).finally(() => { fs.closeSync(stdout); fs.closeSync(stderr); });
  const logFile = path.join(profile, 'logs/desktop-main.log');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const readyLine = log.split(/\r?\n/u).find(line => line.includes('[smoke] renderer-ready '));
  let renderer = null;
  if (readyLine) renderer = JSON.parse(readyLine.slice(readyLine.indexOf('[smoke] renderer-ready ') + '[smoke] renderer-ready '.length));
  const normalProfileUntouched = fs.readdirSync(sentinel).join('|') === 'untouched.txt'
    && fs.readFileSync(path.join(sentinel, 'untouched.txt'), 'utf8') === 'do-not-use-this-profile';
  const report = { contract: 'wangzai-pilot-packaged-startup/v1', ok: result.code === 0 && !timedOut && renderer?.ready === true
      && renderer.mode === 'authentication' && renderer.bridge?.exposed === true && normalProfileUntouched,
    ...result, timedOut, pid: child.pid, fixture, profile, normalProfileUntouched,
    rendererReady: renderer?.ready === true, rendererMode: renderer?.mode ?? null,
    preloadBridgeExposed: renderer?.bridge?.exposed === true,
    scope: 'Packaged EXE with fresh isolated profile; existing non-focusable smoke window; no real account login, platform actions, installation or user data restore.',
  };
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = process.argv[2];
  if (process.argv.length !== 3 || !arg?.startsWith('--stage=')) throw new Error('PILOT_SMOKE_STAGE_REQUIRED');
  const report = await verifyPilotStartup(arg.slice('--stage='.length));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
