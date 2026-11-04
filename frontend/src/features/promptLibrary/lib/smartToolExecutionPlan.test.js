import { describe, expect, it } from 'vitest';
import { compileSmartToolExecutionPlan } from './smartToolExecutionPlan.js';

describe('smartToolExecutionPlan', () => {
  it('compiles registered read, text and image capabilities into real executors', () => {
    const plan = compileSmartToolExecutionPlan({}, [
      { id: 'ozon.products.read', label: '商品读取', access: 'read' },
      { id: 'model.text.generate', label: '文本模型', access: 'read' },
      { id: 'model.image.generate', label: '图片模型', access: 'read' },
      { id: 'product-image-storage', label: '图片存储', access: 'read' },
    ]);

    expect(plan.canStart).toBe(true);
    expect(plan.executableCount).toBe(4);
    expect(plan.requiresImageExecution).toBe(true);
    expect(plan.steps.every((step) => step.executor)).toBe(true);
  });

  it('fails closed when an installed capability only has an interface definition', () => {
    const plan = compileSmartToolExecutionPlan({}, [
      { id: 'purchase-browser.read', label: '采购浏览器读取', access: 'read' },
    ]);

    expect(plan.canStart).toBe(false);
    expect(plan.unsupportedCount).toBe(1);
    expect(plan.steps[0]).toMatchObject({ compileStatus: 'unsupported', executor: '' });
  });

  it('routes write capabilities to the business safety gate', () => {
    const plan = compileSmartToolExecutionPlan({}, [{ id: 'ozon.products.write', label: '商品写入', access: 'write' }]);

    expect(plan.canStart).toBe(true);
    expect(plan.guardedCount).toBe(1);
    expect(plan.canCompleteWithoutGuard).toBe(false);
  });
});
