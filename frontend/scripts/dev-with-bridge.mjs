import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const viteBin = resolve(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const extraArgs = process.argv.slice(2);

const children = [];

function startProcess(command, args, name) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: process.env,
  });
  child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  children.push(child);
  child.on('exit', (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      stopAll();
      process.exit(code);
    }
  });
  child.on('error', (error) => {
    console.error(`[${name}] 启动失败:`, error);
    stopAll();
    process.exit(1);
  });
  return child;
}

function stopAll() {
  children.forEach((child) => {
    if (!child.killed) child.kill();
  });
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});

startProcess(process.execPath, ['scripts/purchase-search-bridge.mjs'], 'purchase-search-bridge');
startProcess(process.execPath, [viteBin, '--host', '127.0.0.1', ...extraArgs], 'vite');
