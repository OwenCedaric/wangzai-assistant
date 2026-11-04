import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonText, stripJsonBom } from '../src/utils/jsonText.js';

test('json text parser accepts UTF-8 BOM payloads', () => {
  const text = '\uFEFF{"ok":true}';
  assert.equal(stripJsonBom(text), '{"ok":true}');
  assert.deepEqual(parseJsonText(text), { ok: true });
});
