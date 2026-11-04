import crypto from 'node:crypto';
import path from 'node:path';

const INTERACTIVE_TAGS = new Set([
  'Button', 'IconButton', 'MenuItem', 'Tab', 'Switch', 'Checkbox', 'Radio', 'Select',
  'ToggleButton', 'Fab', 'SpeedDialAction', 'button', 'a', 'input', 'select', 'textarea',
]);

function lineAndColumn(source, offset) {
  const before = source.slice(0, offset);
  const lines = before.split(/\r?\n/u);
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function openingTagEnd(source, start) {
  let quote = '';
  let escaped = false;
  let braces = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') braces += 1;
    else if (char === '}') braces = Math.max(0, braces - 1);
    else if (char === '>' && braces === 0) return index + 1;
  }
  return -1;
}

function hasShorthandAttribute(opening, name) {
  let quote = '';
  let escaped = false;
  let braces = 0;
  for (let index = 0; index < opening.length; index += 1) {
    const char = opening[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      braces += 1;
      continue;
    }
    if (char === '}') {
      braces = Math.max(0, braces - 1);
      continue;
    }
    if (braces !== 0 || !opening.startsWith(name, index)) continue;
    const previous = opening[index - 1] || '';
    const next = opening[index + name.length] || '';
    if (/[A-Za-z0-9_$-]/u.test(previous) || /[A-Za-z0-9_$-]/u.test(next)) continue;
    let cursor = index + name.length;
    while (/\s/u.test(opening[cursor] || '')) cursor += 1;
    if (opening[cursor] !== '=') return true;
  }
  return false;
}

function sourceId(relative, line, column, tag) {
  return `ui_${crypto.createHash('sha256').update(`${relative}:${line}:${column}:${tag}`).digest('hex').slice(0, 16)}`;
}

function hasLiteralDisabledAncestor(source, offset) {
  for (const tag of ['TextField', 'Select']) {
    const openingStart = source.lastIndexOf(`<${tag}`, offset);
    const closingStart = source.lastIndexOf(`</${tag}>`, offset);
    if (openingStart <= closingStart) continue;
    const end = openingTagEnd(source, openingStart + tag.length + 1);
    if (end > openingStart && end < offset && hasShorthandAttribute(source.slice(openingStart, end), 'disabled')) return true;
  }
  return false;
}

export function v2UiCoveragePlugin({ enabled = process.env.WANGZAI_V2_E2E_INSTRUMENT === '1' } = {}) {
  const sourceRoot = path.resolve(process.cwd(), 'src');
  return {
    name: 'wangzai-v2-ui-coverage',
    enforce: 'pre',
    transform(source, id) {
      if (!enabled) return null;
      const cleanId = String(id || '').split('?')[0];
      const absolute = path.resolve(cleanId);
      if (
        !absolute.startsWith(`${sourceRoot}${path.sep}`)
        || !/\.(?:js|jsx)$/u.test(absolute)
        || /\.(?:test|spec)\.(?:js|jsx)$/u.test(absolute)
      ) return null;
      const relative = path.relative(sourceRoot, absolute).replaceAll('\\', '/');
      const insertions = [];
      for (const match of source.matchAll(/<([A-Za-z][A-Za-z0-9.]*)\b/gu)) {
        const tag = match[1].split('.').at(-1);
        if (!INTERACTIVE_TAGS.has(tag)) continue;
        const end = openingTagEnd(source, match.index + match[0].length);
        if (end < 0) continue;
        const opening = source.slice(match.index, end);
        if (/\bdata-v2-source-id\s*=/u.test(opening)) continue;
        if (tag === 'input' && /\btype\s*=\s*["']hidden["']/u.test(opening)) continue;
        if (hasShorthandAttribute(opening, 'hidden') || /\b(?:sx|style)\s*=\s*\{\{[\s\S]*?\bdisplay\s*:\s*["']none["']/u.test(opening)) continue;
        if (/\baria-disabled\s*=\s*["']true["']/u.test(opening)) continue;
        if (hasShorthandAttribute(opening, 'disabled')) continue;
        if (hasLiteralDisabledAncestor(source, match.index)) continue;
        const location = lineAndColumn(source, match.index);
        insertions.push({
          offset: match.index + match[0].length,
          value: ` data-v2-source-id="${sourceId(relative, location.line, location.column, tag)}"`,
        });
      }
      if (!insertions.length) return null;
      let code = source;
      for (const insertion of insertions.sort((left, right) => right.offset - left.offset)) {
        code = `${code.slice(0, insertion.offset)}${insertion.value}${code.slice(insertion.offset)}`;
      }
      return { code, map: null };
    },
  };
}
