export function stripJsonBom(text) {
  return String(text ?? '').replace(/^\uFEFF/u, '');
}

export function parseJsonText(text) {
  return JSON.parse(stripJsonBom(text));
}
