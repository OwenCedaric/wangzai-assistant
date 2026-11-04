import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectExpiredManagedDevScratch, withManagedDevScratch } from './managed-dev-scratch.mjs';

const args = process.argv.slice(2);
const action = args.shift() || 'cleanup';
let workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let apply = false, automatic = false, purpose = 'tool-scratch', ttlMs;
let command = [];
try {
  while (args.length) {
    const arg = args.shift();
    if (arg === '--') { command = args.splice(0); break; }
    if (arg === '--workspace' && args.length) workspaceRoot = path.resolve(args.shift());
    else if (arg === '--apply') apply = true;
    else if (arg === '--automatic') automatic = true;
    else if (arg === '--purpose' && args.length) purpose = args.shift();
    else if (arg === '--ttl-hours' && args.length) ttlMs = Number(args.shift()) * 60 * 60 * 1000;
    else throw new Error('MANAGED_SCRATCH_ARGUMENT_INVALID');
  }
  if (action === 'cleanup' && !command.length) {
    const report = collectExpiredManagedDevScratch({ workspaceRoot, apply,
      ...(automatic ? { timeBudgetMs: 250, maxRuns: 4 } : {}) });
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } else if (action === 'run' && command.length && !apply && !automatic) {
    await withManagedDevScratch({ workspaceRoot, purpose, ttlMs }, async scope => {
      // The producer must send disposable output here; source, final evidence,
      // activated runtime and rollback copies remain outside this directory.
      const child = spawn(command[0], command.slice(1), { cwd: workspaceRoot,
        windowsHide: true, stdio: 'inherit', env: { ...process.env, WANGZAI_MANAGED_DEV_SCRATCH: scope.directory } });
      await scope.trackChild(child);
      if (child.exitCode !== 0) throw new Error('MANAGED_SCRATCH_COMMAND_FAILED');
      console.log(JSON.stringify({ ok: true, runId: scope.runId, completed: true }));
    });
  } else throw new Error('MANAGED_SCRATCH_ACTION_INVALID');
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: String(error?.code || error?.message || 'MANAGED_SCRATCH_FAILED') }));
  process.exitCode = 1;
}
