import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const profitPageSource = readFileSync(resolve(process.cwd(), 'src/features/profit/ProfitPage.jsx'), 'utf8');
const executionSource = readFileSync(resolve(process.cwd(), 'src/services/profitCalculationExecution.js'), 'utf8');

describe('profit page shared order hot-cache rules', () => {
  it('renders from the canonical order cache while the private profit snapshot hydrates', () => {
    expect(profitPageSource).toContain('readProfitOrdersFromSharedCache');
    expect(profitPageSource).toContain('profitSharedOrderRows');
    expect(profitPageSource).toContain(
      'mergeProfitSnapshotWithSharedOrders(profitSharedOrderRows, profitSnapshotRows)'
    );
    expect(profitPageSource).toContain('deferExchangeRates: true');
    expect(profitPageSource).toContain('hydrateProfitSharedOrderExchangeRates(profitSharedOrderRows)');
  });

  it('keeps the shared-cache reader as an input adapter and preserves the existing profit calculation pipeline', () => {
    expect(profitPageSource).toContain('prepareProfitCalculationOrder(materialReadyOrder, financeBaselineLedger)');
    expect(profitPageSource).toContain("operation: 'normalize', input: { order: calculationOrder, context: profitRowContext }");
    expect(profitPageSource).toContain("operation: 'ledger', input: { order: normalizedOrder, context: {");
    expect(executionSource).toContain('normalizeOzonProfitOrder(input.order, input.context)');
    expect(executionSource).toContain('createProfitLedgerRow(input.order, input.context)');
    expect(profitPageSource).toContain('calculateProfitBatch: usesPrivateProfitExecution ? calculateProfitBatch : undefined');
    expect(profitPageSource).toContain('applyProfitLedgerToProfitOrder(normalizedOrder, profitLedger)');
  });
});
