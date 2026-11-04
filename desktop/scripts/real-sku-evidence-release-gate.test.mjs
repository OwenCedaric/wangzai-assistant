import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(desktopRoot, '..');
const desktopPackage = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
);

test('every Windows release path fails before build when durable real-SKU evidence is missing', () => {
  assert.equal(
    desktopPackage.scripts['verify:sku-evidence'],
    'npm --prefix ../local-api run evidence:sku',
  );
  for (const scriptName of [
    'pack:win',
    'dist:win',
    'dist:win:installer',
    'dist:win:portable',
  ]) {
    const command = desktopPackage.scripts[scriptName];
    const evidenceIndex = command.indexOf('npm run verify:sku-evidence');
    const buildIndex = command.indexOf('npm run build:frontend:clean');
    assert.ok(evidenceIndex >= 0, `${scriptName} 缺少真实 SKU 证据门禁`);
    assert.ok(buildIndex > evidenceIndex, `${scriptName} 必须在昂贵构建前验证证据`);
  }
  for (const [scriptName, smokeCommand] of [
    ['dist:win:installer', 'npm run smoke:installer'],
    ['dist:win:portable', 'npm run smoke:portable'],
  ]) {
    const command = desktopPackage.scripts[scriptName];
    const verifyIndex = command.indexOf('npm run verify:package');
    const smokeIndex = command.indexOf(smokeCommand);
    assert.ok(verifyIndex >= 0, `${scriptName} 缺少 package verifier`);
    assert.ok(smokeIndex > verifyIndex, `${scriptName} 必须验证后启动对应正式产物`);
  }
});

test('real-SKU tests and verifier use the tracked compact proof without skip or .tmp fallback', () => {
  const testSource = fs.readFileSync(
    path.join(workspaceRoot, 'local-api', 'test', 'productRealSkuEvidence.test.js'),
    'utf8',
  );
  const verifierSource = fs.readFileSync(
    path.join(workspaceRoot, 'local-api', 'scripts', 'verify-real-sku-evidence.mjs'),
    'utf8',
  );
  assert.doesNotMatch(testSource, /\bskip\s*:/u);
  assert.match(verifierSource, /target-only\.proofdb/u);
  assert.doesNotMatch(verifierSource, /sku-real-readonly-proof\.sqlite/u);
  for (const fileName of [
    'mzr-20260520-638834907-9348.real-ozon.json',
    'mzr-20260520-638834907-9348.evidence-manifest.json',
    'mzr-20260520-638834907-9348.target-only.proofdb',
  ]) {
    const filePath = path.join(workspaceRoot, 'local-api', 'evidence', fileName);
    assert.ok(fs.statSync(filePath).isFile(), `缺少 durable evidence：${fileName}`);
  }
});

test('installer and portable package smoke exercise profile retention and full-profile restore', () => {
  const smokeSource = fs.readFileSync(
    path.join(desktopRoot, 'scripts', 'smoke-package.mjs'),
    'utf8',
  );
  assert.match(smokeSource, /installer-uninstall-profile-retention\/v1/u);
  assert.match(smokeSource, /uninstallAndVerifyProfileRetention/u);
  assert.match(smokeSource, /profileRetentionChecked:\s*true/u);
  assert.match(smokeSource, /captureInstallerShellShortcuts/u);
  assert.match(smokeSource, /restoreInstallerShellShortcuts/u);
  assert.match(smokeSource, /await restoreInstallerShellShortcuts\(installerShellShortcutSnapshots\)/u);
  assert.match(smokeSource, /runPortableProfileCopyRestoreRoundtrip/u);
  assert.match(smokeSource, /fullProfileCopied:\s*true/u);
  assert.match(smokeSource, /canonicalFactsReadBackAfterRestart/u);
});
