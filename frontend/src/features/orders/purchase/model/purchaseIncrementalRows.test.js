import { expect, it, vi } from 'vitest';
import { createPurchaseRowMapper } from './purchaseIncrementalRows.js';

it('updates only 20 changed supplementary rows out of 20000 and propagates current objects through stages', () => {
  const rows = Array.from({ length: 20000 }, (_, i) => ({ id: `same-posting-${i}`, shopId: i % 10 }));
  const images = createPurchaseRowMapper(), normalized = createPurchaseRowMapper();
  const supplements = new Map();
  const merge = vi.fn((row, [image]) => image ? { ...row, image } : row);
  const annotate = vi.fn(row => ({ ...row, annotated: true }));
  const run = () => normalized(images(rows, 'profile:shop-generation1', row => [supplements.get(row.id)], merge),
    'profile:shop-generation1', () => [], annotate);
  const before = run();
  merge.mockClear(); annotate.mockClear();
  expect(run()).toBe(before);
  expect(merge).not.toHaveBeenCalled(); expect(annotate).not.toHaveBeenCalled();
  rows.slice(0, 20).forEach(row => supplements.set(row.id, `image-${row.id}`));
  const after = run();
  expect(merge).toHaveBeenCalledTimes(20); expect(annotate).toHaveBeenCalledTimes(20);
  expect(after[0].image).toBe('image-same-posting-0');
  expect(after.slice(20).every((row, index) => row === before[index + 20])).toBe(true);
});

it('invalidates changed dependencies, inputs, scope and order without collapsing duplicate ids', () => {
  const map = createPurchaseRowMapper(), rows = [{ id: 'same', shopId: 'a' }, { id: 'same', shopId: 'b' }];
  const project = vi.fn((row, [value]) => ({ ...row, value }));
  const before = map(rows, 'owner-1', () => [1], project);
  expect(map(rows.slice().reverse(), 'owner-1', () => [1], project)).toEqual(before.slice().reverse());
  expect(project).toHaveBeenCalledTimes(2);
  const changed = map(rows, 'owner-1', () => [2], project);
  expect(changed.every(row => row.value === 2)).toBe(true);
  expect(map(rows, 'owner-2', () => [2], project)[0]).not.toBe(changed[0]);
  expect(map([{ ...rows[0], newField: true }], 'owner-2', () => [2], project)[0].newField).toBe(true);
  expect(map([], 'owner-2', () => [], project)).toEqual([]);
});

it('propagates projection failures instead of silently returning an earlier complete array', () => {
  const map = createPurchaseRowMapper(), row = {};
  const good = map([row], 'scope', () => [1], () => ({ ok: true }));
  expect(() => map([row], 'scope', () => [2], () => { throw new Error('read-failed'); })).toThrow('read-failed');
  expect(map([row], 'scope', () => [1], () => null)).toBe(good);
});
