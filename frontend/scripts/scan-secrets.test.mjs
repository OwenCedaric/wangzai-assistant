import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isNotGitRepositoryError,
  listSourceArchiveFiles,
  resolveScanRoot,
  runSecretScan,
  scanFiles,
  scanText,
} from './scan-secrets.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-source-scan-test-'));
  return {
    root,
    write(relative, content = 'export const safe = true;') {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    },
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function notRepository() {
  throw Object.assign(new Error('command failed'), {
    status: 128,
    stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
  });
}

test('source archive fallback enumerates only source trees and build metadata, not runtime/key data', () => {
  const f = fixture();
  try {
    const included = [
      'frontend/src/runtime/credentials-helper.js',
      'frontend/src/data/catalog.js',
      'frontend/scripts/release.mjs',
      'frontend/vite.config.js',
      'frontend/package.json',
      'desktop/src/runtime/session.js',
      'desktop/scripts/verify.mjs',
      'desktop/current-version.json',
      'desktop/native/Host/Program.cs',
      'desktop/native/Host/Host.csproj',
      'local-api/src/server.js',
      'local-api/scripts/check.mjs',
      'local-cache-agent/src/store.js',
      'tools/ci/check.mjs',
    ];
    const excluded = [
      'frontend/node_modules/a/index.js',
      'frontend/dist-package/bundle.js',
      'frontend/src/module.test.js',
      'frontend/src/__tests__/secret.js',
      'frontend/src/keys/private-key.pem',
      'frontend/src/.env.production',
      'frontend/src/credentials.production.json',
      'frontend/src/service-account.json',
      'frontend/src/snapshot.local.json',
      'frontend/scripts/logs/runtime.json',
      'frontend/scripts/fixtures/credentials.json',
      'frontend/.env',
      'frontend/.npmrc',
      'desktop/resources/distribution.json',
      'desktop/native/Host/bin/package.json',
      'desktop/native/Host/obj/settings.json',
      'desktop/native/Host/publish/manifest.json',
      'desktop/.desktop-runtime-test/profile/session.json',
      '.runtime-profile/users.json',
      '.codex-temp/audit/evidence.json',
      '本地数据/shops.json',
      'artifacts/report.json',
      'docs/support.json',
      'local-api/data/shops.json',
      'local-api/config/credentials.json',
      'tools/test-release/runtime/account.json',
    ];
    for (const name of [...included, ...excluded]) f.write(name);
    assert.deepEqual(listSourceArchiveFiles(f.root), [...included].sort());
  } finally {
    f.close();
  }
});

test('missing repository falls back safely from frontend cwd and reports redacted findings', () => {
  const f = fixture();
  const printed = [];
  const value = 'live-value-8f4cb1de992bad';
  try {
    f.write('frontend/src/request.js', `api_key = "${value}";`);
    f.write('.runtime-profile/session.json', `token = "${value}";`);
    let commands = 0;
    const code = runSecretScan({
      argv: ['--all'],
      cwd: path.join(f.root, 'frontend'),
      archiveRoot: f.root,
      execGit: (...args) => {
        commands += 1;
        return notRepository(...args);
      },
      log: (line) => printed.push(line),
      error: (line) => printed.push(line),
    });
    assert.equal(code, 1);
    assert.equal(commands, 1, 'no ls-files commands are attempted outside a repository');
    assert.match(printed.join('\n'), /frontend\/src\/request\.js:1 secret-assignment/);
    assert.equal(printed.join('\n').includes(value), false);
    assert.equal(printed.join('\n').includes('.runtime-profile'), false);
    f.write('frontend/src/request.js');
    assert.equal(
      runSecretScan({
        argv: ['--all'],
        cwd: f.root,
        archiveRoot: f.root,
        execGit: notRepository,
        log: (line) => printed.push(line),
      }),
      0
    );
    assert.match(printed.at(-1), /source-archive allowlisted/);
  } finally {
    f.close();
  }
});

test('Git discovery errors other than not-a-repository are never swallowed or printed', () => {
  for (const error of [
    Object.assign(new Error('sensitive command body'), {
      status: 128,
      stderr: 'fatal: detected dubious ownership in repository at secret-path',
    }),
    Object.assign(new Error('sensitive command body'), { status: 128, stderr: 'fatal: bad object HEAD' }),
    Object.assign(new Error('sensitive command body'), { status: 1, stderr: 'fatal: not a git repository' }),
    Object.assign(new Error('sensitive command body'), { code: 'ENOENT', stderr: '' }),
  ]) {
    assert.equal(isNotGitRepositoryError(error), false);
    assert.throws(
      () =>
        resolveScanRoot({
          execGit: () => {
            throw error;
          },
        }),
      (caught) => {
        assert.equal(caught.code, 'SECRET_SCAN_GIT_DISCOVERY_FAILED');
        assert.equal(caught.message.includes('sensitive'), false);
        assert.equal(caught.message.includes('secret-path'), false);
        return true;
      }
    );
  }
});

test('Git listing failure fails closed instead of rescanning the filesystem', () => {
  const f = fixture();
  try {
    f.write('frontend/src/a.js');
    const lines = [];
    assert.throws(
      () =>
        runSecretScan({
          argv: ['--all'],
          cwd: f.root,
          archiveRoot: f.root,
          execGit: (_file, args) => {
            if (args[0] === 'rev-parse') return f.root;
            throw Object.assign(new Error('credential-shaped-git-output'), {
              status: 128,
              stderr: 'fatal: index corrupt',
            });
          },
          log: (line) => lines.push(line),
          error: (line) => lines.push(line),
        }),
      { code: 'SECRET_SCAN_GIT_LIST_FAILED' }
    );
    assert.deepEqual(lines, []);
  } finally {
    f.close();
  }
});

test('Git filenames are NUL-delimited, retaining Unicode and spaces without echoing contents', () => {
  const f = fixture();
  try {
    const relative = 'frontend/src/商品 request.js';
    f.write(relative, 'api_key = "live-secret-value-Ab12345";');
    const lines = [];
    const code = runSecretScan({
      argv: ['--all'],
      cwd: f.root,
      execGit: (_file, args, options) => {
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
        if (args[0] === 'rev-parse') return f.root;
        assert.ok(args.includes('-z'));
        return args[0] === 'ls-files' && !args.includes('--others') ? `${relative}\0` : '';
      },
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });
    assert.equal(code, 1);
    assert.ok(lines.includes(`${relative}:1 secret-assignment`));
    assert.equal(lines.join('\n').includes('live-secret-value-Ab12345'), false);
  } finally {
    f.close();
  }
});

test('source enumeration and scanning never follow directory links or linked file contents', () => {
  const f = fixture();
  const external = fixture();
  try {
    f.write('frontend/src/safe.js');
    const privateFile = external.write('private.js', 'api_key = "live-secret-value-Ab12345";');
    fs.symlinkSync(
      external.root,
      path.join(f.root, 'frontend/src/linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    fs.linkSync(privateFile, path.join(f.root, 'frontend/src/hardlinked.js'));
    const files = listSourceArchiveFiles(f.root);
    assert.equal(
      files.some((name) => name.includes('/linked/')),
      false
    );
    assert.deepEqual(scanFiles(f.root, [...files, 'frontend/src/linked/private.js', '../private.js']), []);
  } finally {
    f.close();
    external.close();
  }
});

test('explicit local diagnostic scans remain available but invalid/escaping files cannot pass silently', () => {
  const f = fixture();
  try {
    f.write('frontend/src/safe.js');
    f.write('本地数据/diagnostic.txt', 'api_key = "live-secret-value-Ab12345";');
    const lines = [];
    assert.equal(
      runSecretScan({
        argv: ['--file', '本地数据/diagnostic.txt'],
        cwd: f.root,
        archiveRoot: f.root,
        execGit: notRepository,
        error: (line) => lines.push(line),
      }),
      1
    );
    assert.match(lines.at(-1), /secret-assignment/);
    assert.throws(
      () =>
        runSecretScan({ argv: ['--file', '../outside.txt'], cwd: f.root, archiveRoot: f.root, execGit: notRepository }),
      { code: 'SECRET_SCAN_EXPLICIT_FILE_INVALID' }
    );
  } finally {
    f.close();
  }
});

test('an empty source archive is a failed scan, never a zero-file pass', () => {
  const f = fixture();
  try {
    assert.throws(() => runSecretScan({ argv: ['--all'], cwd: f.root, archiveRoot: f.root, execGit: notRepository }), {
      code: 'SECRET_SCAN_SOURCE_SCOPE_EMPTY',
    });
  } finally {
    f.close();
  }
});

test('dynamic template assignments are not hardcoded secrets while constant/escaped templates still are', () => {
  assert.deepEqual(scanText('token = `customer-file-${crypto.randomUUID()}`;'), []);
  assert.deepEqual(scanText('apiKey: `synthetic-${randomUUID()}`;'), []);
  assert.equal(scanText('token = `live-key-value-123456`;').length, 1);
  assert.equal(scanText('token = `live-key-value-\\${accountId}`;').length, 1);
  assert.equal(scanText('token = "live-key-value-${accountId}";').length, 1);
  assert.equal(scanText('token = `live-key-value-${}`;').length, 1);
});

test('the two read-only profit verification tools use random synthetic credentials, not scan exceptions', () => {
  const workspace = path.resolve(import.meta.dirname, '../..');
  const frontendScript = 'frontend/scripts/verify-profit-local-read-batches.mjs';
  const localApiScript = 'local-api/scripts/verify-shop-profit-pilot.mjs';
  const frontend = fs.readFileSync(path.join(workspace, frontendScript), 'utf8');
  const localApi = fs.readFileSync(path.join(workspace, localApiScript), 'utf8');
  for (const source of [frontend, localApi]) {
    assert.match(source, /apiKey:\s*`synthetic-\$\{randomUUID\(\)\}`/u);
    assert.match(source, /randomUUID[^\n]*from ['"]node:crypto['"]/u);
    assert.deepEqual(scanText(source), []);
    assert.equal(/\b(?:fetch|axios)\s*\(/u.test(source), false);
  }
  assert.match(frontend, /readOnly:\s*true/u);
  assert.match(frontend, /assert\.equal\(url\.pathname, '\/api\/cache\/finance'\)/u);
  assert.match(localApi, /new DatabaseSync\(sourcePath, \{ readOnly: true \}\)/u);
  assert.match(localApi, /mkdtempSync\(join\(tmpdir\(\)/u);
  assert.ok(listSourceArchiveFiles(workspace).includes(frontendScript));
  assert.ok(listSourceArchiveFiles(workspace).includes(localApiScript));
});
