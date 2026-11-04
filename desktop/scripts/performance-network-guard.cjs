'use strict';

// Test-process preload only. Never mocks a response or reads an account token.
// All platform traffic is denied; only this run's local service ports may be used.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');
const allowedPorts = new Set(String(process.env.WANGZAI_PERFORMANCE_ALLOWED_PORTS || '').split(',').map(Number));
const logPath = process.env.WANGZAI_PERFORMANCE_NETWORK_LOG;
if (!logPath || !allowedPorts.size || allowedPorts.has(0)) throw new Error('PERFORMANCE_NETWORK_GUARD_CONFIG_REQUIRED');
const loopback = (host) => ['localhost', '127.0.0.1', '::1'].includes(String(host || '').toLowerCase().replace(/^\[|\]$/g, ''));
let logEntries = 0;
function record(row) {
  if (++logEntries > 20000) throw new Error('PERFORMANCE_NETWORK_EVIDENCE_LIMIT');
  fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, at: Date.now(), ...row }) + '\n');
}
function check(host, port, kind, pathname = '') {
  if (loopback(host) && allowedPorts.has(Number(port))) return;
  record({ event: 'blocked', kind, host: String(host || ''), port: Number(port) || 0, pathname });
  throw Object.assign(new Error('PERFORMANCE_NON_FIXTURE_NETWORK_BLOCKED'), { code: 'PERFORMANCE_NON_FIXTURE_NETWORK_BLOCKED' });
}
function target(first, options, protocol) {
  const base = typeof first === 'string' || first instanceof URL ? new URL(first) : null;
  const opts = base ? options || {} : first || {};
  const host = opts.hostname || opts.host || base?.hostname || 'localhost';
  return { host, port: opts.port || base?.port || (protocol === 'https:' ? 443 : 80),
    pathname: String(opts.path || base?.pathname || '/').split('?')[0], method: String(opts.method || 'GET').toUpperCase() };
}
for (const [module, protocol] of [[http, 'http:'], [https, 'https:']]) {
  const request = module.request;
  module.request = function (...args) {
    const item = target(args[0], typeof args[1] === 'object' ? args[1] : {}, protocol);
    check(item.host, item.port, protocol, item.pathname);
    const result = request.apply(this, args);
    result.once('response', (response) => record({ event: 'response', kind: protocol, ...item, status: response.statusCode }));
    return result;
  };
  module.get = function (...args) { const result = module.request(...args); result.end(); return result; };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const input = Array.isArray(args[0]) ? args[0] : args;
  const first = input[0];
  const opts = first && typeof first === 'object' ? first : { port: first, host: input[1] };
  // Local named pipes carry child-process IPC, not platform requests.
  if (!opts.path && !(typeof first === 'string' && !/^\d+$/.test(first))) {
    check(typeof opts.host === 'string' ? opts.host : 'localhost', opts.port, 'socket');
  }
  return connect.apply(this, args);
};
const tlsConnect = tls.connect;
tls.connect = function (...args) {
  const opts = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
  check(typeof opts.host === 'string' ? opts.host : 'localhost', opts.port, 'tls');
  return tlsConnect.apply(this, args);
};
function guardFetch(original, owner, kind) {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const item = { host: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      pathname: url.pathname, method: String(init?.method || input?.method || 'GET').toUpperCase() };
    check(item.host, item.port, kind, item.pathname);
    const response = await original.call(owner, input, init);
    record({ event: 'response', kind, ...item, status: response.status });
    if (process.env.WANGZAI_PERFORMANCE_DIAGNOSTICS === '1' && item.pathname === '/api/cache/products') {
      const body = await response.clone().json().catch(() => null);
      record({ event: 'product-cache-diagnostic',
        query: Object.fromEntries(['shopId', 'shopIds', 'page', 'pageSize', 'visibility', 'status'].flatMap(key =>
          url.searchParams.has(key) ? [[key, url.searchParams.get(key)]] : [])),
        total: body?.total, rows: Array.isArray(body?.rows) ? body.rows.length : null,
        source: body?.source, errorCode: body?.error?.code });
    }
    return response;
  };
}
if (globalThis.fetch) globalThis.fetch = guardFetch(globalThis.fetch, globalThis, 'fetch');
function installElectronGuard(electron) {
  if (!electron?.app || !electron?.net) throw new Error('PERFORMANCE_ELECTRON_GUARD_NOT_READY');
  if (electron.net?.fetch) electron.net.fetch = guardFetch(electron.net.fetch, electron.net, 'electron-net-fetch');
  if (electron.net?.request) {
    const request = electron.net.request;
    electron.net.request = function (input) {
      const item = target(typeof input === 'object' && input.url ? input.url : input, input, 'https:');
      check(item.host, item.port, 'electron-net', item.pathname);
      return request.call(this, input);
    };
  }
  record({ event: 'electron-net-guard-installed' });
}
let cpuSession;
let cpuStopped = false;
let cpuPart = 0;
let cpuTimer;
function saveCpuProfile(result) {
  if (!result?.profile) return;
  fs.writeFileSync(path.join(path.dirname(logPath), `node-${process.pid}-${++cpuPart}.cpuprofile`), JSON.stringify({
    processName: path.basename(process.argv[1] || ''), profile: result.profile,
  }));
}
if (process.env.WANGZAI_PERFORMANCE_CPU_PROFILE === '1') {
  try {
    const { Session } = require('node:inspector');
    cpuSession = new Session(); cpuSession.connect();
    cpuSession.post('Profiler.enable'); cpuSession.post('Profiler.start');
    if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1') {
      cpuTimer = setInterval(() => {
        if (cpuStopped) return;
        cpuSession.post('Profiler.stop', (error, result) => {
          if (!error) saveCpuProfile(result);
          if (!cpuStopped && cpuPart < 36) cpuSession.post('Profiler.start');
          else clearInterval(cpuTimer);
        });
      }, 10000);
      cpuTimer.unref();
    }
  } catch (error) { record({ event: 'cpu-profile-error', message: error.message }); }
}
function stopCpuProfile() {
  return new Promise(resolve => {
    if (!cpuSession || cpuStopped) return resolve();
    cpuStopped = true;
    clearInterval(cpuTimer);
    cpuSession.post('Profiler.stop', (error, result) => {
      if (!error) saveCpuProfile(result);
      cpuSession.disconnect(); resolve();
    });
  });
}
process.once('exit', () => { void stopCpuProfile(); });
// NODE_OPTIONS runs before Electron installs its native module loader. Requiring
// electron there can cache the npm executable-path shim instead of the API.
module.exports = { installElectronGuard, stopCpuProfile };
syncBuiltinESMExports();
record({ event: 'loaded', electron: Boolean(process.versions.electron), nodeMode: process.env.ELECTRON_RUN_AS_NODE === '1' });
