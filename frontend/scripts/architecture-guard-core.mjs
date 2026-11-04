import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

const SOURCE_EXTENSIONS = ['.js', '.jsx'];
const IMPORT_PATTERN = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DIRECT_FETCH_PATTERN = /(?<![\w$.])fetch\s*\(/g;

function listSourceFiles(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const filePath = resolve(directory, entry);
      const stat = statSync(filePath);
      if (stat.isDirectory()) return listSourceFiles(filePath);
      if (!SOURCE_EXTENSIONS.includes(extname(entry)) || /\.test\.[jt]sx?$/u.test(entry)) return [];
      return [filePath];
    });
}

function resolveLocalImport(sourceFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = resolve(dirname(sourceFile), specifier);
  const candidates = [candidate, ...SOURCE_EXTENSIONS.map((extension) => `${candidate}${extension}`)];
  if (!extname(candidate)) {
    candidates.push(...SOURCE_EXTENSIONS.map((extension) => resolve(candidate, `index${extension}`)));
  }
  return candidates.find((filePath) => {
    try {
      return statSync(filePath).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

function getImports(sourceFile, source) {
  const imports = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    const resolved = resolveLocalImport(sourceFile, specifier);
    if (resolved) imports.push(resolved);
  }
  return [...new Set(imports)];
}

export function collectModuleGraph(srcRoot) {
  const root = resolve(srcRoot);
  const files = listSourceFiles(root);
  const graph = new Map();
  const sourceByFile = new Map();
  for (const filePath of files) {
    const source = readFileSync(filePath, 'utf8');
    sourceByFile.set(filePath, source);
    graph.set(filePath, getImports(filePath, source).filter((target) => target.startsWith(root)));
  }
  return { root, files, graph, sourceByFile };
}

export function findStronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indexByNode = new Map();
  const lowLinkByNode = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graph.get(node) ?? []) {
      if (!graph.has(target)) continue;
      if (!indexByNode.has(target)) {
        visit(target);
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node), lowLinkByNode.get(target)));
      } else if (onStack.has(target)) {
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node), indexByNode.get(target)));
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    components.push(component.sort());
  }

  [...graph.keys()].sort().forEach((node) => {
    if (!indexByNode.has(node)) visit(node);
  });

  return components.filter((component) => {
    if (component.length > 1) return true;
    return (graph.get(component[0]) ?? []).includes(component[0]);
  });
}

function relativeId(root, filePath) {
  return relative(root, filePath).replaceAll('\\', '/');
}

function countDirectFetches(source) {
  return [...source.matchAll(DIRECT_FETCH_PATTERN)].length;
}

function normalizeBaseline(baseline = {}) {
  return {
    directFetchByFile: baseline.directFetchByFile ?? {},
    sharedUpwardEdges: new Set(baseline.sharedUpwardEdges ?? []),
  };
}

export function auditArchitecture({ srcRoot, baseline = {} }) {
  const { root, files, graph, sourceByFile } = collectModuleGraph(srcRoot);
  const normalizedBaseline = normalizeBaseline(baseline);
  const violations = [];
  const cycles = findStronglyConnectedComponents(graph);
  for (const cycle of cycles) {
    violations.push({
      rule: 'AG-01',
      severity: 'P0',
      kind: 'import-cycle',
      files: cycle.map((filePath) => relativeId(root, filePath)),
      evidence: '生产模块形成强连通依赖环。',
      remediation: '将纯 key/value/helper 下沉或通过组合层注入依赖。',
      baseline: false,
    });
  }

  for (const filePath of files) {
    const fileId = relativeId(root, filePath);
    const source = sourceByFile.get(filePath) ?? '';
    if (fileId.startsWith('features/')) {
      const count = countDirectFetches(source);
      const allowed = Number(normalizedBaseline.directFetchByFile[fileId] ?? 0);
      if (count > allowed) {
        violations.push({
          rule: 'AG-02',
          severity: 'P0',
          kind: 'feature-direct-fetch',
          file: fileId,
          evidence: `发现 ${count} 个直接 fetch，基线只允许 ${allowed} 个。`,
          remediation: '通过 typed local-api client 或独立 service 接入。',
          baseline: false,
        });
      }
    }

    if (!fileId.startsWith('shared/')) continue;
    for (const target of graph.get(filePath) ?? []) {
      const targetId = relativeId(root, target);
      if (!targetId.startsWith('features/') && !targetId.startsWith('entities/')) continue;
      const edge = `${fileId}->${targetId}`;
      if (normalizedBaseline.sharedUpwardEdges.has(edge)) continue;
      violations.push({
        rule: 'AG-01',
        severity: 'P0',
        kind: 'shared-upward-import',
        file: fileId,
        target: targetId,
        evidence: 'shared 层反向依赖 feature/entity。',
        remediation: '将公共能力下沉或由上层注入。',
        baseline: false,
      });
    }
  }

  return {
    ok: violations.length === 0,
    sourceRoot: root,
    summary: {
      modules: files.length,
      importCycles: cycles.length,
      newViolations: violations.length,
      baselineDirectFetchFiles: Object.keys(normalizedBaseline.directFetchByFile).length,
      baselineSharedUpwardEdges: normalizedBaseline.sharedUpwardEdges.size,
    },
    violations,
  };
}
