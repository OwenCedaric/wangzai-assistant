import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const READABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml']);
const EXECUTABLE_EXTENSIONS = new Set(['.bat', '.cmd', '.com', '.exe', '.js', '.mjs', '.ps1', '.py', '.sh']);

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : fallback;
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith('---')) return {};
  const endIndex = markdown.indexOf('\n---', 3);
  if (endIndex < 0) return {};
  return Object.fromEntries(
    markdown
      .slice(3, endIndex)
      .split(/\r?\n/u)
      .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u))
      .filter(Boolean)
      .map((match) => [match[1], match[2].replace(/^['"]|['"]$/gu, '').trim()])
  );
}

function unquoteYamlValue(value = '') {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/gu, '')
    .trim();
}

function parseAgentPresentation(content = '') {
  return {
    displayName: unquoteYamlValue(String(content).match(/^\s*display_name:\s*(.+)$/imu)?.[1]),
    shortDescription: unquoteYamlValue(String(content).match(/^\s*short_description:\s*(.+)$/imu)?.[1]),
  };
}

async function collectFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, filePath)));
    else if (entry.isFile()) files.push(filePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function relativePath(root, filePath) {
  return path.relative(root, filePath).replace(/\\/gu, '/');
}

const sourceDirectory = path.resolve(argument('source'));
const outputPath = path.resolve(argument('output'));
if (!argument('source') || !argument('output')) {
  throw new Error('用法：--source <Skill目录> --output <安装包.json>');
}

const skillPath = path.join(sourceDirectory, 'SKILL.md');
const markdown = await readFile(skillPath, 'utf8');
const frontmatter = parseFrontmatter(markdown);
const name = String(frontmatter.name || path.basename(sourceDirectory)).trim();
const description = String(frontmatter.description || '导入后按 Skill 自带流程生成本地预览。').trim();
const files = await collectFiles(sourceDirectory);
const manifest = await Promise.all(
  files.map(async (filePath) => {
    const content = await readFile(filePath);
    const metadata = await stat(filePath);
    return {
      path: relativePath(sourceDirectory, filePath),
      size: metadata.size,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  })
);
const referenceFiles = [];
for (const filePath of files) {
  const packagePath = relativePath(sourceDirectory, filePath);
  if (packagePath === 'SKILL.md' || !READABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
  referenceFiles.push({ path: packagePath, content: await readFile(filePath, 'utf8') });
}
const executableFiles = manifest
  .map((item) => item.path)
  .filter((filePath) => EXECUTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
const agentPresentation = parseAgentPresentation(
  referenceFiles.find((item) => item.path.replace(/\\/gu, '/').toLowerCase() === 'agents/openai.yaml')?.content
);
const packageHash = createHash('sha256');
packageHash.update(markdown, 'utf8');
referenceFiles.forEach((file) => {
  packageHash.update(`\n${file.path}\n`, 'utf8');
  packageHash.update(file.content, 'utf8');
});

const packagePayload = {
  packageFormat: 'wangzai-smart-tool-skill',
  packageVersion: 1,
  manifestVersion: 1,
  name,
  title: agentPresentation.displayName || name,
  description: agentPresentation.shortDescription || description,
  sourceName: name,
  sourceUrl: argument('source-url'),
  repository: argument('repository'),
  ref: argument('ref', 'main'),
  installType: 'wangzai-skill-package',
  body: markdown,
  referenceFiles,
  manifest,
  executableFiles,
  sourceHash: packageHash.digest('hex'),
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(packagePayload, null, 2)}\n`, 'utf8');
console.log(
  JSON.stringify(
    {
      outputPath,
      name,
      files: manifest.length,
      referenceFiles: referenceFiles.length,
      executableFiles,
      sourceHash: packagePayload.sourceHash,
    },
    null,
    2
  )
);
