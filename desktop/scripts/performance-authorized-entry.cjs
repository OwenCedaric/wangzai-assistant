// A test entry around the unchanged production bootstrap. Loading here (rather
// than NODE_OPTIONS) keeps Electron's native app module available.
const { app } = require('electron');
const fs = require('node:fs');
function mark(phase) { fs.appendFileSync(process.env.WANGZAI_PERFORMANCE_NETWORK_LOG, JSON.stringify({ event: 'auth-entry', phase, pid: process.pid }) + '\n'); }
function fail(error) { console.error('PERFORMANCE_AUTH_ENTRY_FAILED:' + error.message); if (app?.exit) app.exit(1); else process.exit(1); }
process.on('uncaughtException', fail);
process.on('unhandledRejection', error => fail(error instanceof Error ? error : new Error(String(error))));
try {
  mark('entry');
  const guard = require('./performance-network-guard.cjs');
  guard.installElectronGuard(require('electron'));
  app.on('before-quit', () => { void guard.stopCpuProfile(); });
  if (process.env.WANGZAI_PERFORMANCE_LICENSE_DIRECTORY) require('./performance-license-bootstrap.cjs');
  mark('adapter-loaded');
  app.once('ready', () => mark('app-ready'));
  require('../src/bootstrap.cjs');
  mark('production-bootstrap-loaded');
} catch (error) { fail(error); }
