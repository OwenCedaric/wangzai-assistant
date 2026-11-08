import fs from 'node:fs';
import path from 'node:path';

export function resolveServerSourceRoot({ workspaceRoot, env = process.env, existsSync = fs.existsSync }) {
  const direct = String(env.WANGZAI_LICENSE_BACKEND_ROOT || '').trim();
  const legacy = String(env.LICENSE_CENTER_ROOT || '').trim();
  const candidates = direct ? [direct] : legacy
    ? [path.join(legacy, 'server'), path.join(legacy, 'backend'), legacy]
    : [path.join(workspaceRoot, 'server')];
  const root = candidates.map(candidate => path.resolve(candidate))
    .find(candidate => existsSync(path.join(candidate, 'app', 'main.py')));
  if (!root) throw new Error('SERVER_SOURCE_ROOT_NOT_FOUND');
  return root;
}
