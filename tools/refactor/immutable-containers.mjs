// Container consts (`new Set([...])`, `new Map([...])`) declared --immutable are treated
// as plain constants by module-graph / move-declarations. This check refuses (exit 1)
// when the file mutates one of them, so the claim cannot silently be wrong.
// Exported containers can also be mutated by importers: grep the repo for those too.
const MUTATORS = 'add|set|delete|clear';

export function assertImmutable(source, names) {
  const problems = [];
  const warnings = [];
  const lines = source.split(/\r?\n/);
  for (const name of names) {
    if (!new RegExp(String.raw`\b(?:const|let|var)\s+${name}\s*=`).test(source)) {
      problems.push(`${name}: no top-level declaration found`);
    }
    const mutation = new RegExp(
      String.raw`\b${name}\s*\??\.\s*(?:${MUTATORS})\s*\(|\b${name}\s*(?:\+|-)?=(?!=)|\b${name}\s*\[[^\]]*\]\s*=(?!=)`,
    );
    const mutated = lines.findIndex((line) => mutation.test(line) && !/\b(?:const|let|var)\s/.test(line));
    if (mutated >= 0) problems.push(`${name}: mutated at line ${mutated + 1}`);
    // Passing the container somewhere else could let that code mutate it.
    const escapes = new RegExp(String.raw`[(,]\s*${name}\s*[,)]`);
    const escaped = lines.findIndex((line) => escapes.test(line));
    if (escaped >= 0) warnings.push(`${name}: passed as an argument at line ${escaped + 1} - review that callee only reads it`);
  }
  if (warnings.length) console.error(`IMMUTABLE CHECK WARNINGS:\n- ${warnings.join('\n- ')}`);
  if (problems.length) {
    console.error(`IMMUTABLE CHECK FAILED:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
}
