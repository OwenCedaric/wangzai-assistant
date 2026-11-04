// Lists the request handler's top-level route statements as contiguous runs per
// URL area, to choose blocks that can be extracted without reordering routes.
// Usage: node tools/refactor/route-runs.mjs <createApp.js> [depth=3]
import { readFileSync } from 'node:fs';

const [file, depthArg] = process.argv.slice(2);
const depth = Number(depthArg) || 3;
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const handlerStart = lines.findIndex((line) => line.includes('const server = createServer'));
const statement = /^ {4}(if \(|const [A-Za-z]+ = )/;
const pathPattern = /["'`](\/api\/[A-Za-z0-9_\-/]+)|\/\^\\\/api\\\/([A-Za-z0-9_-]+)(?:\\\/([A-Za-z0-9_-]+))?/;

const runs = [];
let current = null;
for (let index = handlerStart; index < lines.length; index += 1) {
  if (!statement.test(lines[index])) continue;
  let path = '';
  for (let probe = index; probe < Math.min(lines.length, index + 12); probe += 1) {
    const match = lines[probe].match(pathPattern);
    if (match) {
      path = match[1] || `/api/${match[2]}${match[3] ? `/${match[3]}` : ''}`;
      break;
    }
  }
  const area = path ? path.split('/').slice(0, depth + 1).join('/') : '(none)';
  if (!current || current.area !== area) {
    current = { area, start: index + 1, end: index + 1, statements: 0 };
    runs.push(current);
  }
  current.end = index + 1;
  current.statements += 1;
}
for (const run of runs) {
  console.log(`${String(run.start).padStart(5)} ${String(run.end).padStart(5)} ${String(run.statements).padStart(3)}  ${run.area}`);
}
