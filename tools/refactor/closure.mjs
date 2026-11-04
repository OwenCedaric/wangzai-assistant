// Given a module-graph JSON and a line range (or names), prints the pure
// declarations in range and the extra top-level names their closure pulls in.
// Usage: node tools/refactor/closure.mjs <graph.json> <fromLine> <toLine> [--exclude a,b]
import { readFileSync } from 'node:fs';

const [graphFile, fromArg, toArg] = process.argv.slice(2);
const exclude = new Set((process.argv.includes('--exclude') ? process.argv[process.argv.indexOf('--exclude') + 1] : '').split(',').filter(Boolean));
const graph = JSON.parse(readFileSync(graphFile, 'utf8')).declarations;
const from = Number(fromArg);
const to = Number(toArg);
const seed = Object.entries(graph)
  .filter(([name, info]) => !info.stateful && info.start >= from && info.end <= to && !exclude.has(name))
  .map(([name]) => name);
const closure = new Set(seed);
const queue = [...seed];
while (queue.length) {
  for (const dependency of graph[queue.pop()].deps) {
    if (!closure.has(dependency)) { closure.add(dependency); queue.push(dependency); }
  }
}
const extra = [...closure].filter((name) => !seed.includes(name));
const statefulPulled = [...closure].filter((name) => graph[name].stateful);
const usedBy = (name) => Object.entries(graph).filter(([, info]) => info.deps.includes(name)).map(([other]) => other);
console.log(JSON.stringify({
  seed: seed.length,
  seedLines: seed.reduce((sum, name) => sum + graph[name].lines, 0),
  extraPulledIn: extra.map((name) => `${name}@${graph[name].start}`),
  statefulPulled,
  names: [...closure].sort((a, b) => graph[a].start - graph[b].start).join(','),
  usedOnlyInsideGroup: [...closure].filter((name) => usedBy(name).every((user) => closure.has(user))).length,
}, null, 2));
