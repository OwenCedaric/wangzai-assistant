import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const reportPath = path.resolve(process.argv[3] || path.join(root, 'artifacts', 'ci-source-scan.json'));
const markerPath = path.join(root, '.wangzai-v2-ci-mirror');
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const BINARY_EXTENSIONS = new Set([
  '.7z', '.bin', '.bmp', '.dll', '.dmp', '.exe', '.gif', '.ico', '.jpg', '.jpeg',
  '.node', '.pdf', '.png', '.rar', '.so', '.tar', '.webp', '.woff', '.woff2', '.zip',
]);
const FORBIDDEN_PATHS = [
  /(^|\/)\.env(?:\.|$)/iu,
  /(^|\/)\.secrets?(?:\/|$)/iu,
  /(^|\/)deploy\/secrets?(?:\/|$)/iu,
  /(^|\/)(?:admin-runtime|test-runtime|\.runtime)(?:\/|$)/iu,
  /(?:^|\/)(?:credentials?|admin-credentials|tester-accounts)(?:\.|$)/iu,
  /\.(?:db|db-wal|db-shm|sqlite|sqlite3|duckdb|log|dmp|p12|pfx|key)$/iu,
  /(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/iu,
];
const FORBIDDEN_RUNTIME_DIRECTORY = /(^|\/)(?:data|logs?|cache|user-?data|appdata)(?:\/|$)/iu;
const ALLOWED_SOURCE_DIRECTORY = /^(?:desktop|frontend|local-api|local-cache-agent)\/src\/(?:data|cache)(?:\/|$)/iu;
const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s+(?:[A-Za-z0-9+/]{40,}={0,2}\s+){2,}-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/gu],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/gu],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
  ['aliyun-access-key', /\bLTAI[A-Za-z0-9]{12,30}\b/gu],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}\b/gu],
  ['stripe-live-key', /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/gu],
  ['generic-live-bearer', /\bBearer\s+[A-Za-z0-9._~+\/-]{40,}={0,2}\b/giu],
];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (!fs.existsSync(markerPath)) {
  throw new Error(`CI_MIRROR_MARKER_MISSING:${markerPath}`);
}

const findings = [];
const manifest = [];
for (const file of walk(root)) {
  const name = relative(file);
  if (name === relative(reportPath)) continue;
  const stats = fs.statSync(file);
  manifest.push({ path: name, bytes: stats.size, sha256: sha256(file) });
  for (const pattern of FORBIDDEN_PATHS) {
    if (pattern.test(name)) findings.push({ code: 'FORBIDDEN_PATH', path: name, rule: String(pattern) });
  }
  if (FORBIDDEN_RUNTIME_DIRECTORY.test(name) && !ALLOWED_SOURCE_DIRECTORY.test(name)) {
    findings.push({ code: 'FORBIDDEN_PATH', path: name, rule: String(FORBIDDEN_RUNTIME_DIRECTORY) });
  }
  if (stats.size > MAX_TEXT_BYTES || BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes('\u0000')) continue;
  for (const [code, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = [...content.matchAll(pattern)];
    if (matches.length) findings.push({ code: `SECRET_${code.toUpperCase()}`, path: name, count: matches.length });
  }
}

manifest.sort((left, right) => left.path.localeCompare(right.path, 'en'));
const report = {
  ok: findings.length === 0,
  contract: 'wangzai-v2-private-ci-source-scan/v1',
  root,
  scannedAt: new Date().toISOString(),
  fileCount: manifest.length,
  totalBytes: manifest.reduce((sum, item) => sum + item.bytes, 0),
  findings,
  manifest,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  fileCount: report.fileCount,
  totalBytes: report.totalBytes,
  findingCount: findings.length,
  reportPath,
})}\n`);
if (!report.ok) process.exitCode = 1;
