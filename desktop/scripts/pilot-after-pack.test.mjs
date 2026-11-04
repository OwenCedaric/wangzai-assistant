import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import hook from './pilot-after-pack.cjs';

const workspace = path.resolve(import.meta.dirname, '../..');
function setup(t) {
  const parent = path.join(workspace, '.codex-temp');
  const root = fs.mkdtempSync(path.join(parent, 'pilot-after-pack-unit-'));
  t.after(() => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('pilot-after-pack-unit-')); fs.rmSync(root, { recursive: true }); });
  const projectDir = path.join(root, 'desktop'), appOutDir = path.join(root, 'installer-output/win-unpacked');
  fs.mkdirSync(projectDir); fs.mkdirSync(path.join(appOutDir, 'resources'), { recursive: true });
  const example = path.join(appOutDir, 'resources/default_app.asar');
  const keep = path.join(appOutDir, 'resources/keep.txt');
  fs.writeFileSync(example, 'unused-example'); fs.writeFileSync(keep, 'keep');
  fs.writeFileSync(path.join(root, 'stage-manifest.json'), JSON.stringify({ contract: 'wangzai-pilot-installer-stage/v1', appDirectory: projectDir, identity: { appId: 'com.wangzai.assistant.desktop.pilot' } }));
  return { root, projectDir, appOutDir, example, keep };
}

test('afterPack removes only the copied Electron example in an identity-bound pilot output', async t => {
  const f = setup(t);
  await hook({ packager: { projectDir: f.projectDir }, appOutDir: f.appOutDir });
  assert.equal(fs.existsSync(f.example), false);
  assert.equal(fs.readFileSync(f.keep, 'utf8'), 'keep');
});

test('afterPack rejects an unrelated output before deleting anything', async t => {
  const f = setup(t);
  await assert.rejects(hook({ packager: { projectDir: f.projectDir }, appOutDir: f.projectDir }), /PILOT_AFTER_PACK_SCOPE_INVALID/);
  assert.equal(fs.readFileSync(f.example, 'utf8'), 'unused-example');
});

test('afterPack rejects a mismatched product identity', async t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.root, 'stage-manifest.json'), JSON.stringify({ contract: 'wangzai-pilot-installer-stage/v1', appDirectory: f.projectDir, identity: { appId: 'other' } }));
  await assert.rejects(hook({ packager: { projectDir: f.projectDir }, appOutDir: f.appOutDir }), /PILOT_AFTER_PACK_IDENTITY_INVALID/);
  assert.equal(fs.existsSync(f.example), true);
});
