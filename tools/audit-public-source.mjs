import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const forbiddenFiles = new Set([
  'desktop/resources/distribution.json',
  'desktop/resources/project.json',
  'desktop/resources/protected-compute/configuration-public.pem',
  'desktop/resources/protected-compute/protected-compute.signed-public.json',
  'local-api/config/local-api.config.json',
]);
const localDirectories = new Set(['node_modules', '.git', 'dist', 'dist-package', '.tools', '.venv', '__pycache__', '.pytest_cache', '.ruff_cache']);
const rules = [
  ['private-key-material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}\s*-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/gu],
  ['provider-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{12,})\b/gu],
  ['personal-home-path', /(?:[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|example\b)[^\\/\s"'`]+|\/home\/(?!example\b)[^/\s"'`]+)/gu],
  ['dated-shop-identifier', /\bozon-shop-\d{10,}\b/gu],
  ['private-wiki-reference', /https?:\/\/[a-z0-9-]+\.feishu\.cn\/(?:wiki|docx)\/[A-Za-z0-9]+/giu],
];

// This check only audits the preparation snapshot. Gitleaks, image review,
// third-party licensing and release-readiness remain independent requirements.
export function auditPublicSource(root, { trackedOnly = false } = {}) {
  const tracked = trackedOnly ? new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean)) : null;
  if (tracked && !tracked.size) throw new Error('PUBLIC_SOURCE_TRACKED_SCOPE_EMPTY');
  const findings = [];
  let textFiles = 0;
  let binaryFiles = 0;
  const omittedLocalDirectories = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (tracked && !tracked.has(relative) && ![...tracked].some(file => file.startsWith(`${relative}/`))) continue;
      if (entry.isSymbolicLink()) {
        findings.push({ path: relative, rule: 'symlink-not-audited' });
        continue;
      }
      if (entry.isDirectory()) {
        if (localDirectories.has(entry.name) || entry.name.startsWith('dist-')) {
          omittedLocalDirectories.push(relative);
          continue;
        }
        if (/^(?:\.runtime(?:-|$)|artifacts$|安装包$|本地数据$|private-audit$)/u.test(entry.name)) {
          findings.push({ path: relative, rule: 'local-data-directory' });
          continue;
        }
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        findings.push({ path: relative, rule: 'not-regular-file' });
        continue;
      }
      if (forbiddenFiles.has(relative)
          || /\.(?:key|pem|p12|pfx|sqlite\d*|db|exe|dll|zip|log)$/iu.test(entry.name)
          || (/^\.env(?:\.|$)/u.test(entry.name) && !entry.name.endsWith('.example'))
          || entry.name === '.npmrc') {
        findings.push({ path: relative, rule: 'private-or-runtime-file' });
        continue;
      }
      const bytes = fs.readFileSync(absolute);
      if (bytes.subarray(0, 8192).includes(0)) {
        binaryFiles += 1;
        if (!/\.(?:png|ico)$/iu.test(entry.name)) findings.push({ path: relative, rule: 'unreviewed-binary-type' });
        continue;
      }
      textFiles += 1;
      const source = bytes.toString('utf8');
      for (const [rule, pattern] of rules) {
        for (const match of source.matchAll(pattern)) {
          // Apache RocketMQ's published container uses this fixed service home.
          // This exact deployment file/path is not a developer home directory.
          if (rule === 'personal-home-path' && relative === 'deploy/jeepay/docker-compose.yml'
              && match[0] === ['', 'home', 'rocketmq'].join('/')) continue;
          // Deliberately recognizable synthetic provider IDs in isolated tests;
          // real key material remains checked even when stored in a test file.
          if (rule === 'provider-token' && /(?:^|\/)tests?\//u.test(relative)
              && /^(?:LTAI5tExample[A-Za-z]+|sk-test-fixture-[A-Za-z0-9_-]+)$/u.test(match[0])) continue;
          findings.push({ path: relative, line: source.slice(0, match.index).split('\n').length, rule });
        }
      }
    }
  }
  visit(path.resolve(root));
  return { ok: findings.length === 0, textFiles, binaryFiles, omittedLocalDirectories, findings,
    limitation: 'Images and third-party rights are not verified; a clean scan is not publication approval.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  const root = directory ? path.resolve(directory) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = auditPublicSource(root, { trackedOnly: process.argv.includes('--tracked') });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
