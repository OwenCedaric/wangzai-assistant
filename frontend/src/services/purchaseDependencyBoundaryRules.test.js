import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const purchaseLibRoot = join(process.cwd(), 'src/features/orders/purchase/lib');

describe('purchase dependency boundaries', () => {
  it('keeps order normalization independent from the image-rule facade', () => {
    const normalizeSource = readFileSync(join(purchaseLibRoot, 'purchaseOrderNormalize.jsx'), 'utf8');

    expect(normalizeSource).toContain(
      "import { getPurchaseCrossBorderStrictOrderId } from '../../../../services/purchaseImageRuntime.js';"
    );
    expect(normalizeSource).not.toContain("from './purchaseImageRules.jsx'");
  });
});
