import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GIT_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const SOURCE_ARCHIVE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_PROJECTS = ['frontend', 'desktop', 'local-api', 'local-cache-agent'];
const SOURCE_ARCHIVE_TREES = [
  ...SOURCE_PROJECTS.flatMap((project) => [`${project}/src`, `${project}/scripts`]),
  'frontend/public',
  'desktop/native',
  'tools',
];
const BUILD_CONFIG_NAME_RE =
  /^(?:package(?:-lock)?\.json|current-version\.json|tsconfig(?:\.[\w-]+)?\.json|(?:vite|vitest|eslint|postcss|tailwind|electron-builder)\.config\.[cm]?[jt]s|\.npmrc|\.prettierrc(?:\.json)?)$/iu;
const PRIVATE_DATA_FILE_RE =
  /(?:^|\/)(?:\.env(?:\..*)?|(?:credentials?|secrets?|private[-_]?key|service[-_]?account|license-session|payment-credentials)(?:[.-][a-z0-9_-]+)*\.(?:json|ya?ml|toml|txt|ini|conf|env)|id_(?:rsa|dsa|ecdsa|ed25519))$|\.(?:key|pem|p12|pfx|db|sqlite|sqlite3|log|bin|enc(?:\.json)?|local\.json)$/iu;

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.env',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.ps1',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
  '.cs',
  '.csproj',
  '.props',
  '.targets',
  '.py',
  '.sh',
  '.sql',
  '.toml',
  '.xml',
]);

const SKIP_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vite',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.codex-temp',
  '.runtime',
  '.runtime-profile',
  '.tmp',
  '.venv',
  '__pycache__',
  'artifacts',
  'test-results',
  'verification',
  'bin',
  'obj',
  'publish',
  'publish-pending',
  'packages',
  'openclaw-runtime',
  'test-support',
  'fixtures',
  '\u672c\u5730\u6570\u636e',
]);
const TEST_FIXTURE_PATH_RE = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/iu;

const PLACEHOLDER_RE =
  /^(?:[-_*xX]+|0+|example|sample|dummy|test|placeholder|changeme|change-me|replace-me|redacted|your[_-]?|<.+>|\$\{.+\})/i;
const SAFE_LINE_RE =
  /placeholder|example|sample|dummy|test[-_ ]?(key|token|secret|password)|redacted|replace[-_ ]?me|changeme|your[-_ ]?(api|token|secret|password)|\u5360\u4f4d|\u793a\u4f8b|\u8131\u654f|\u586b\u5199/i;

const RULES = [
  {
    name: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
    highConfidence: true,
  },
  {
    name: 'jwt-token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    highConfidence: true,
  },
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})\b/gi,
    highConfidence: true,
  },
  {
    name: 'secret-assignment',
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|companySecret)\b[^\S\r\n]*(?::|=)[^\S\r\n]*(["'`])([^"'`\r\n]{8,})\2/gi,
    highConfidence: true,
  },
];

function scanError(code) {
  return Object.assign(new Error(code), { code });
}

function gitOutput(args, root, execGit = execFileSync) {
  return execGit('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
}

export function isNotGitRepositoryError(error) {
  return (
    error?.status === 128 &&
    !error?.code &&
    /^fatal: not a git repository(?:[ (:]|$)/imu.test(String(error.stderr || ''))
  );
}

export function resolveScanRoot({
  cwd = process.cwd(),
  archiveRoot = SOURCE_ARCHIVE_ROOT,
  execGit = execFileSync,
} = {}) {
  try {
    const root = String(gitOutput(['rev-parse', '--show-toplevel'], cwd, execGit)).trim();
    if (!root) throw scanError('SECRET_SCAN_GIT_ROOT_EMPTY');
    return { root: path.resolve(root), git: true };
  } catch (error) {
    if (isNotGitRepositoryError(error)) return { root: path.resolve(archiveRoot), git: false };
    // Do not hide corrupt repositories, dubious ownership, missing Git, or
    // command failures as a clean source archive scan. Never echo Git stderr.
    throw scanError('SECRET_SCAN_GIT_DISCOVERY_FAILED');
  }
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

export function isTestFixturePath(relativePath) {
  return TEST_FIXTURE_PATH_RE.test(normalizePath(relativePath));
}

function isSkipped(relativePath) {
  const normalized = normalizePath(relativePath);
  if (!normalized || normalized.endsWith('/')) return true;
  const segments = normalized.split('/');
  if (segments.at(-1)?.toLowerCase() === '.npmrc') return true;
  if (
    segments.some(
      (segment) =>
        SKIP_SEGMENTS.has(segment.toLowerCase()) || /^(?:dist(?:-|$)|\.runtime(?:-|$)|\.desktop-)/iu.test(segment)
    )
  )
    return true;
  if (PRIVATE_DATA_FILE_RE.test(normalized)) return true;
  // src/data and src/runtime contain real implementation modules. The same
  // names outside a source tree are profiles/caches, not release source.
  if (
    !SOURCE_PROJECTS.some((project) => normalized.startsWith(`${project}/src/`)) &&
    segments.some((segment) => /^(?:data|logs?|cache|runtime|profiles?|user-?data|appdata|backups?)$/iu.test(segment))
  )
    return true;
  // Test fixtures are not shipped. They deliberately contain credential-shaped values to
  // exercise migrations and redaction; production files remain fully scanned.
  if (isTestFixturePath(normalized)) return true;
  if (normalized === 'frontend/.env.example') return true;
  if (normalized.endsWith('.lock') && !normalized.endsWith('package-lock.json')) return true;
  return false;
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (BUILD_CONFIG_NAME_RE.test(path.basename(filePath))) return true;
  return path.basename(filePath).startsWith('.env');
}

function listGitFiles(root, execGit) {
  const tracked = gitOutput(['ls-files', '-z'], root, execGit).split('\0').filter(Boolean);
  const staged = gitOutput(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root, execGit)
    .split('\0')
    .filter(Boolean);
  return Array.from(new Set([...tracked, ...staged]));
}

function containedRegularPath(root, relativePath) {
  const normalized = normalizePath(relativePath);
  if (!normalized || path.isAbsolute(relativePath) || normalized.split('/').includes('..')) return null;
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) return null;
  let current = path.resolve(root);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current)) return null;
    if (lstatSync(current).isSymbolicLink()) return null;
  }
  return absolute;
}

export function listSourceArchiveFiles(root) {
  const files = [];
  const visit = (relativeDirectory) => {
    if (isSkipped(relativeDirectory)) return;
    const absoluteDirectory = containedRegularPath(root, relativeDirectory);
    if (!absoluteDirectory || !lstatSync(absoluteDirectory).isDirectory()) return;
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relative = normalizePath(path.join(relativeDirectory, entry.name));
      if (entry.isSymbolicLink() || isSkipped(relative)) continue;
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile() && isTextFile(relative)) files.push(relative);
    }
  };
  for (const tree of SOURCE_ARCHIVE_TREES) visit(tree);
  // Only known build metadata at the repository/project roots. In particular,
  // never recursively scan desktop/resources, runtime profiles, or key stores.
  for (const project of ['', ...SOURCE_PROJECTS]) {
    const directory = project ? containedRegularPath(root, project) : path.resolve(root);
    if (!directory || !existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !BUILD_CONFIG_NAME_RE.test(entry.name)) continue;
      const relative = normalizePath(path.join(project, entry.name));
      if (!isSkipped(relative)) files.push(relative);
    }
  }
  return [...new Set(files)].sort();
}

function isPlaceholder(value) {
  const trimmed = String(value ?? '').trim();
  return !trimmed || PLACEHOLDER_RE.test(trimmed);
}

function hasTemplateInterpolation(value) {
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] !== '$' || value[index + 1] !== '{') continue;
    let escapes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) escapes += 1;
    if (escapes % 2 === 0 && value.indexOf('}', index + 2) > index + 2) return true;
  }
  return false;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function isSafeFinding(rule, match, line) {
  if (SAFE_LINE_RE.test(line)) return true;
  if (rule.name === 'secret-assignment' && isPlaceholder(match[3])) return true;
  if (rule.name === 'secret-assignment' && match[2] === '`' && hasTemplateInterpolation(match[3])) return true;
  if (rule.name === 'bearer-token' && isPlaceholder(match[1])) return true;
  return false;
}

export function scanText(text, relativePath = '<memory>') {
  const findings = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match = rule.pattern.exec(text);
    while (match) {
      const lineNumber = lineNumberAt(text, match.index);
      const line = text.split(/\r?\n/)[lineNumber - 1] ?? '';
      if (!isSafeFinding(rule, match, line)) {
        findings.push({
          path: relativePath,
          line: lineNumber,
          rule: rule.name,
        });
      }
      match = rule.pattern.exec(text);
    }
  }
  return findings;
}

function readFileText(filePath) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 1024 * 1024 * 2) return null;
  if (!isTextFile(filePath)) return null;
  const content = readFileSync(filePath);
  if (content.includes(0)) return null;
  return content.toString('utf8');
}

export function scanFiles(root, files, options = {}) {
  const findings = [];
  for (const relativePath of files) {
    if (!options.includeSkipped && isSkipped(relativePath)) continue;
    const absolutePath = containedRegularPath(root, relativePath);
    if (!absolutePath) continue;
    const text = readFileText(absolutePath);
    if (text === null) continue;
    findings.push(...scanText(text, normalizePath(relativePath)));
  }
  return findings;
}

function parseArgs(argv) {
  const files = [];
  let all = false;
  let selfTest = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      all = true;
    } else if (arg === '--self-test') {
      selfTest = true;
    } else if (arg === '--file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--file requires a path');
      files.push(value);
      index += 1;
    }
  }
  return { all, files, selfTest };
}

function listAllCandidateFiles(root, execGit) {
  const tracked = listGitFiles(root, execGit);
  const others = gitOutput(['ls-files', '--others', '--exclude-standard', '-z'], root, execGit)
    .split('\0')
    .filter(Boolean);
  return Array.from(new Set([...tracked, ...others]));
}

function runSelfTest() {
  const sample = [
    ['access_', 'token', ' = ', '"realistic-access-token-value";'].join(''),
    ['company', 'Secret', ' = ', '"realistic-company-secret-value";'].join(''),
    ['api_', 'key', ': ', '"realistic-api-key-value";'].join(''),
    ['Authorization: ', 'Bearer ', 'abcdefghijklmnopqrstuvwxyz1234567890'].join(''),
    '-----BEGIN ' + 'PRIVATE KEY-----',
    'placeholder_api_key = "your_api_key_here"',
  ].join('\n');
  const findings = scanText(sample, 'self-test.txt');
  if (findings.length < 5) {
    throw new Error(`Self-test expected at least 5 findings, got ${findings.length}`);
  }
  console.log('Secret scan self-test passed.');
}

export function runSecretScan({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  archiveRoot = SOURCE_ARCHIVE_ROOT,
  execGit = execFileSync,
  log = console.log,
  error = console.error,
} = {}) {
  const args = parseArgs(argv);
  if (args.selfTest) {
    runSelfTest();
    return 0;
  }
  const scope = resolveScanRoot({ cwd, archiveRoot, execGit });
  const { root } = scope;
  let files;
  if (args.files.length) {
    files = args.files.map((file) => path.relative(root, path.resolve(cwd, file)));
    if (files.some((file) => !containedRegularPath(root, file))) throw scanError('SECRET_SCAN_EXPLICIT_FILE_INVALID');
  } else if (!scope.git) {
    files = listSourceArchiveFiles(root);
  } else {
    try {
      files = args.all ? listAllCandidateFiles(root, execGit) : listGitFiles(root, execGit);
    } catch {
      throw scanError('SECRET_SCAN_GIT_LIST_FAILED');
    }
  }
  if (!files.length) throw scanError('SECRET_SCAN_SOURCE_SCOPE_EMPTY');
  const findings = scanFiles(root, files, { includeSkipped: args.files.length > 0 });
  if (findings.length > 0) {
    error(`Secret scan found ${findings.length} potential issue(s). Values are redacted.`);
    for (const finding of findings) {
      const diagnosticPath = Array.from(finding.path, (character) =>
        character.codePointAt(0) < 32 || character.codePointAt(0) === 127 ? '?' : character
      ).join('');
      error(`${diagnosticPath}:${finding.line} ${finding.rule}`);
    }
    return 1;
  }
  const scopeLabel = args.files.length
    ? 'selected'
    : !scope.git
      ? 'source-archive allowlisted'
      : args.all
        ? 'tracked/untracked'
        : 'tracked/staged';
  log(
    `Secret scan passed. Checked ${files.length} ${scopeLabel} candidate path(s); excluded data/binary/oversize files are not audited.`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runSecretScan();
  } catch (error) {
    const code = /^SECRET_SCAN_[A-Z_]+$/u.test(error?.code || '') ? error.code : 'SECRET_SCAN_FAILED';
    console.error(`Secret scan could not complete (${code}). No file contents or command output are printed.`);
    process.exitCode = 2;
  }
}
