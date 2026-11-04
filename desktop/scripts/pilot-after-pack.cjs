const fs = require('node:fs');
const path = require('node:path');

module.exports = async function removePilotElectronExample(context) {
  const project = path.resolve(context.packager.projectDir);
  const output = path.resolve(context.appOutDir);
  const allowed = path.resolve(__dirname, '../../.codex-temp') + path.sep;
  const expected = path.resolve(project, '../installer-output/win-unpacked');
  if (!project.startsWith(allowed) || output !== expected) throw new Error('PILOT_AFTER_PACK_SCOPE_INVALID');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(project, '../stage-manifest.json'), 'utf8'));
  if (manifest.contract !== 'wangzai-pilot-installer-stage/v1' || path.resolve(manifest.appDirectory) !== project
    || manifest.identity.appId !== 'com.wangzai.assistant.desktop.pilot') throw new Error('PILOT_AFTER_PACK_IDENTITY_INVALID');
  const file = path.join(output, 'resources/default_app.asar');
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('PILOT_ELECTRON_EXAMPLE_PATH_UNSAFE');
  fs.unlinkSync(file);
};
