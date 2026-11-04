import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const crossBorderSource = readFileSync(join(process.cwd(), 'src', 'services', 'crossBorderOrderCache.js'), 'utf8');
const localDataLayerSource = ['ozonLocalDataLayer.js', 'ozonLocalDataLayerFieldMerge.js']
  .map((fileName) => readFileSync(join(process.cwd(), 'src', 'services', fileName), 'utf8'))
  .join('\n');
const protectionSource = readFileSync(join(process.cwd(), 'src', 'services', 'manualDataProtection.js'), 'utf8');

describe('manual data protection rules', () => {
  it('keeps the manual data protection checklist centralized', () => {
    [
      'manualBuyerPlatform',
      'manualPurchaseOrderNo',
      'manualPurchasePriceValue',
      'sourcePurchaseCostCny',
      'manualProfitLogisticsFeeCny',
      'manualProfitCrossBorderBusFeeCny',
      'manualSourceRecord',
      'productSourceLinks',
      'busOrderId',
      'order_id',
    ].forEach((field) => {
      expect(protectionSource).toContain(`'${field}'`);
    });
  });

  it('reuses the same protection helper in cross-border and Ozon local mirror merges', () => {
    expect(crossBorderSource).toContain("import { mergeProtectedManualData } from './manualDataProtection.js';");
    expect(crossBorderSource).toContain('return mergeProtectedManualData(current, fresh);');
    expect(localDataLayerSource).toContain(
      "import { hasProtectedManualValue, isProtectedManualDataField } from './manualDataProtection.js';"
    );
    expect(localDataLayerSource).toContain(
      '!isManualSource && isProtectedManualDataField(field) && hasProtectedManualValue(fields[field])'
    );
  });
});
