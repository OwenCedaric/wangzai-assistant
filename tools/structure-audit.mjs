import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import {
  collectModuleGraph,
  findStronglyConnectedComponents,
} from '../frontend/scripts/architecture-guard-core.mjs';

const workspaceRoot = resolve(import.meta.dirname, '..');
const baselinePath = resolve(import.meta.dirname, 'structure-audit-baseline.json');
const sourceRoots = Object.freeze([
  { id: 'frontend', path: resolve(workspaceRoot, 'frontend', 'src') },
  { id: 'local-api', path: resolve(workspaceRoot, 'local-api', 'src') },
  { id: 'desktop', path: resolve(workspaceRoot, 'desktop', 'src') },
]);
const sourceExtensions = new Set(['.js', '.jsx', '.cjs', '.mjs']);
const newFileLineLimit = 1_200;

function relativeWorkspacePath(filePath) {
  return relative(workspaceRoot, filePath).replaceAll('\\', '/');
}

function isProductionSource(filePath) {
  const name = filePath.replaceAll('\\', '/');
  return sourceExtensions.has(extname(filePath))
    && !/\.(?:test|spec)\.[cm]?jsx?$/u.test(name)
    && !/(?:^|\/)__tests__(?:\/|$)/u.test(name)
    && !/(?:^|\/)fixtures?(?:\/|$)/u.test(name);
}

function listProductionFiles(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const filePath = resolve(directory, entry);
      const stat = statSync(filePath);
      if (stat.isDirectory()) return listProductionFiles(filePath);
      return isProductionSource(filePath) ? [filePath] : [];
    });
}

function lineCount(filePath) {
  const source = readFileSync(filePath, 'utf8');
  return source ? source.split(/\r?\n/u).length : 0;
}

function currentOversizedFiles() {
  return Object.fromEntries(
    sourceRoots
      .flatMap(({ path }) => listProductionFiles(path))
      .map((filePath) => [relativeWorkspacePath(filePath), lineCount(filePath)])
      .filter(([, lines]) => lines > newFileLineLimit)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function readBaseline() {
  return JSON.parse(readFileSync(baselinePath, 'utf8'));
}

function audit() {
  const baseline = readBaseline();
  const oversizedBaseline = baseline.oversizedFiles || {};
  const violations = [];
  const summaries = [];

  for (const root of sourceRoots) {
    const files = listProductionFiles(root.path);
    const { graph } = collectModuleGraph(root.path);
    const cycles = findStronglyConnectedComponents(graph);
    for (const cycle of cycles) {
      violations.push({
        rule: 'GS-01',
        root: root.id,
        message: `新增循环依赖：${cycle.map(relativeWorkspacePath).join(' -> ')}`,
      });
    }

    let oversized = 0;
    for (const filePath of files) {
      const file = relativeWorkspacePath(filePath);
      const lines = lineCount(filePath);
      const allowed = Number(oversizedBaseline[file] || newFileLineLimit);
      if (lines > newFileLineLimit) oversized += 1;
      if (lines > allowed) {
        violations.push({
          rule: 'GS-02',
          root: root.id,
          message: oversizedBaseline[file]
            ? `现有超大文件继续增长：${file} ${lines} > ${allowed}`
            : `新增超大文件：${file} ${lines} > ${newFileLineLimit}`,
        });
      }
    }
    summaries.push({ root: root.id, modules: files.length, cycles: cycles.length, oversized });
  }

  const desktopPackage = JSON.parse(
    readFileSync(resolve(workspaceRoot, 'desktop', 'package.json'), 'utf8'),
  );
  const packagedFiles = Array.isArray(desktopPackage?.build?.files)
    ? desktopPackage.build.files.map(String)
    : [];
  if (packagedFiles.some((entry) => entry.includes('test-support'))) {
    violations.push({
      rule: 'GS-03',
      root: 'desktop',
      message: 'desktop 正式安装包不得包含 test-support。',
    });
  }

  return { ok: violations.length === 0, summaries, violations };
}

if (process.argv.includes('--write-baseline')) {
  const baseline = {
    version: 1,
    newFileLineLimit,
    oversizedFiles: currentOversizedFiles(),
  };
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  process.stdout.write(`global structure baseline: oversized=${Object.keys(baseline.oversizedFiles).length}\n`);
} else {
  const report = audit();
  process.stdout.write(
    `global structure audit: ${report.summaries
      .map((item) => `${item.root}=${item.modules}/${item.cycles}/${item.oversized}`)
      .join(' ')} violations=${report.violations.length}\n`,
  );
  report.violations.forEach((violation) => {
    process.stdout.write(`[${violation.rule}] ${violation.message}\n`);
  });
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes('--enforce') && !report.ok) process.exitCode = 1;
}
