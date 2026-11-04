import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

function readAppSource() {
  return readSplitAppSource();
}

function readProductModuleClientSource() {
  return readFileSync(join(process.cwd(), 'src', 'services', 'productModuleClient.js'), 'utf8');
}

function readProductWriteClientSource() {
  return readFileSync(join(process.cwd(), 'src', 'services', 'productWriteClient.js'), 'utf8');
}

function readProductWriteHelpersSource() {
  return readFileSync(join(process.cwd(), 'src', 'entities', 'product', 'productWriteHelpers.jsx'), 'utf8');
}

function readProductBatchStateSource() {
  return readFileSync(join(process.cwd(), 'src', 'features', 'products', 'model', 'useProductBatchState.jsx'), 'utf8');
}

function readProductWriteStateSource() {
  return readFileSync(join(process.cwd(), 'src', 'features', 'products', 'model', 'useProductWriteState.jsx'), 'utf8');
}

function readProductEditingSource() {
  return readFileSync(join(process.cwd(), 'src', 'features', 'products', 'lib', 'productEditing.jsx'), 'utf8');
}

function readProductRowRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'services', 'productRowRuntime.js'), 'utf8');
}

describe('product write safety wiring rules', () => {
  it('keeps product Ozon write endpoints out of legacy App.jsx requestOzonWrite calls', () => {
    const source = readAppSource();
    expect(source).not.toMatch(/requestOzonWrite\('\/v3\/product\/import/u);
    expect(source).not.toMatch(/requestOzonWrite\('\/v1\/product\/import\/prices/u);
    expect(source).not.toMatch(/requestOzonWrite\('\/v2\/products\/stocks/u);
    expect(source).not.toMatch(/requestOzonWrite\('\/v1\/product\/archive/u);
    expect(source).not.toMatch(/requestOzonWrite\('\/v1\/product\/unarchive/u);
  });

  it('wires product card actions to productModuleClient write guard helpers', () => {
    const source = readAppSource();
    const clientSource = readProductModuleClientSource();
    const writeClientSource = readProductWriteClientSource();
    expect(source).toContain('submitProductInfoWrite');
    expect(source).toContain('submitProductPriceWrite');
    expect(source).toContain('submitProductStockWrite');
    expect(source).toContain('submitProductArchiveWrite');
    expect(source).toContain('submitProductUnarchiveWrite');
    expect(clientSource).toContain("export * from './productWriteClient.js'");
    expect(writeClientSource).toContain('previewProductInfoSave');
    expect(writeClientSource).toContain('previewProductPriceUpdate');
    expect(writeClientSource).toContain('previewProductStockUpdate');
    expect(writeClientSource).toContain('previewProductArchive');
    expect(writeClientSource).toContain('previewProductUnarchive');
    expect(writeClientSource).toContain("previewDomainWrite('products'");
    expect(writeClientSource).toContain("confirmDomainWrite('products'");
    expect(writeClientSource).not.toContain('api-seller.ozon.ru');
  });

  it('defaults confirmed product writes to real Ozon execution unless explicitly disabled', () => {
    const writeClientSource = readProductWriteClientSource();
    const batchStateSource = readProductBatchStateSource();
    const writeStateSource = readProductWriteStateSource();
    expect(writeClientSource).toContain('realWrite: options.realWrite !== false');
    expect(writeClientSource).toContain('dryRun: options.dryRun === true');
    expect(writeClientSource).not.toContain('realWrite: options.realWrite === true');
    expect(writeClientSource).not.toContain('dryRun: options.dryRun === false ? false : true');
    expect(batchStateSource).toContain('humanConfirmed: true, realWrite: true, dryRun: false');
    expect(writeStateSource).toContain('humanConfirmed: true');
    expect(writeStateSource).toContain('realWrite: true');
    expect(writeStateSource).toContain('dryRun: false');
  });

  it('does not show product write copy that pretends Ozon execution succeeded while executor is disabled', () => {
    const source = readAppSource();
    const helperSource = readProductWriteHelpersSource();
    expect(source).not.toContain('已提交到 Ozon，但回读结果仍待核对');
    expect(source).not.toContain('已同步到 Ozon，并回读确认成功');
    expect(source).not.toContain('确认保存到 Ozon？');
    expect(source).toContain('真实 Ozon 写入执行器未连接');
    expect(helperSource).toContain('真实写入未开启，本次不会提交 Ozon。');
    expect(helperSource).toContain('店铺缺少真实写入配置，本次不会提交 Ozon。');
    expect(helperSource).toContain('已提交或请求超时，正在等待 Ozon 回读，不能标记为完成。');
    expect(helperSource).not.toContain('需要设置 LOCAL_API_ENABLE_REAL_OZON_WRITE=1 并重启 local-api');
  });

  it('treats partial product write jobs as unsafe until Ozon readback confirms every item', () => {
    const batchStateSource = readProductBatchStateSource();
    const writeStateSource = readProductWriteStateSource();
    const writeClientSource = readProductWriteClientSource();
    expect(writeClientSource).toContain("=== 'merged'");
    expect(writeClientSource).not.toContain("=== 'partial'");
    expect(batchStateSource).toContain('!isProductWriteReadbackComplete(result)');
    expect(writeStateSource).toContain('writeResults.every(isProductWriteReadbackComplete)');
    expect(batchStateSource).toContain('不能标记完成');
    expect(writeStateSource).toContain('不能标记完成');
  });

  it('does not optimistically replace visible stock before Ozon readback is merged', () => {
    const batchStateSource = readProductBatchStateSource();
    const writeStateSource = readProductWriteStateSource();
    expect(writeStateSource).not.toContain('patch.stock = stockValue');
    expect(writeStateSource).not.toContain('patch.stockValue = stockValue');
    expect(batchStateSource).not.toContain('stock: stockValue,');
    expect(batchStateSource).toContain('await reloadCurrentProductPageFromSqlite(ownerShop)');
    expect(batchStateSource).toContain('isProductWriteReadbackComplete(result)');
  });

  it('reports batch stock success as readback merged instead of still waiting', () => {
    const batchStateSource = readProductBatchStateSource();
    expect(batchStateSource).toContain('库存已由 Ozon 回读确认并合并到 SQLite。');
    expect(batchStateSource).toContain('批量库存已提交，但尚未完成 Ozon 回读与 SQLite 合并，不能标记完成。');
    expect(batchStateSource).toContain('!isProductWriteReadbackComplete(result)');
    expect(batchStateSource).not.toContain('仍需等待回读确认');
    expect(batchStateSource).not.toContain('库存设置已提交 Ozon，但后台确认超时');
  });

  it('keeps product archive status unchanged until readback and refreshes the current SQLite page after success', () => {
    const batchStateSource = readProductBatchStateSource();
    const writeStateSource = readProductWriteStateSource();

    expect(batchStateSource).not.toContain('status: statusLabel');
    expect(batchStateSource).not.toContain('productSnapshotVisibilities: [visibility]');
    expect(batchStateSource).toContain('reloadCurrentProductPageFromSqlite');
    expect(batchStateSource).toContain('await loadOzonProducts({ localOnly: true, force: true });');
    expect(writeStateSource).toContain('reloadCurrentProductPageFromSqlite');
    expect(writeStateSource).toContain('await loadOzonProducts({ localOnly: true, force: true });');
    expect(writeStateSource).not.toContain('void loadOzonProducts({ localOnly: true, force: true });');
  });

  it('keeps product module source free of the old garbled unknown status constant', () => {
    const editingSource = readProductEditingSource();
    const rowRuntimeSource = readProductRowRuntimeSource();
    expect(editingSource).not.toContain('δ֪״̬');
    expect(rowRuntimeSource).not.toContain('δ֪״̬');
    expect(rowRuntimeSource).toContain('未知状态');
  });
});
