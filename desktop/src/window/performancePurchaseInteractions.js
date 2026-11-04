import assert from 'node:assert/strict';

// Serialized into the real hidden renderer. Uses only normal controls, never
// React internals, injected order data, platform writes or native input.
async function performPurchaseStep(step) {
  const startedAt = performance.now();
  const panel = () => document.querySelector('.page-panel:not([hidden])');
  const text = node => String(node?.textContent || '').replace(/[\s,，]/g, '');
  const rows = () => [...panel().querySelectorAll('.purchase-orders-table tbody tr')]
    .filter(row => row.querySelector('input[type="checkbox"]'));
  const ids = () => rows().map(row => row.querySelector('.purchase-order-id-cell [title]')?.getAttribute('title') || '');
  const wait = predicate => new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (performance.now() - startedAt > 16000) return reject(new Error('PURCHASE_INTERACTION_TIMEOUT:' + step.kind));
      requestAnimationFrame(tick);
    };
    tick();
  });
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const summary = () => text(panel().querySelector('.purchase-order-pagination .sales-order-pagination-summary'));
  const complete = count => summary().startsWith('共' + count + '条') && rows().length === Math.min(count, 20);
  const searchInput = () => panel().querySelector('.purchase-order-filter-toolbar input[placeholder="搜索单号 / 货号 / SKU"]');
  const before = ids();
  if (step.kind === 'shop') {
    const select = panel().querySelector('.purchase-order-filter-toolbar [role="combobox"]');
    if (!select) throw new Error('PURCHASE_SHOP_SELECTOR_MISSING');
    select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await wait(() => document.querySelector('[role="option"][data-value="' + step.shopId + '"]'));
    document.querySelector('[role="option"][data-value="' + step.shopId + '"]').click();
    await wait(() => complete(step.count) && select.parentElement.querySelector('input')?.value === step.shopId);
    if (step.shopId !== 'all') {
      const index = Number(step.shopId.split('-').at(-1)) - 1;
      if (!ids().every(id => /^\d{8}-0001-1$/.test(id) && (Number(id.slice(0, 8)) - 10000000) % step.shopCount === index)) {
        throw new Error('PURCHASE_WRONG_SHOP_ROWS:' + step.shopId);
      }
    }
  } else if (step.kind === 'search' || step.kind === 'clear-search') {
    const input = searchInput();
    if (!input) throw new Error('PURCHASE_SEARCH_MISSING');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, step.query || '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(() => complete(step.count));
    if (step.query && (ids().length !== 1 || ids()[0] !== step.query)) throw new Error('PURCHASE_SEARCH_WRONG_ORDER');
  } else if (step.kind === 'page') {
    const button = panel().querySelector('.purchase-order-pagination button[aria-label="Go to page 2"]');
    if (!button) throw new Error('PURCHASE_PAGE_TWO_MISSING');
    button.click();
    await wait(() => panel().querySelector('.purchase-order-pagination [aria-current="page"], .purchase-order-pagination [aria-current="true"]')?.textContent === '2'
      && summary().endsWith('21-40') && rows().length === 20);
    if (ids().some(id => before.includes(id))) throw new Error('PURCHASE_PAGE_OVERLAP');
  } else if (step.kind === 'selection') {
    const find = label => [...panel().querySelectorAll('.purchase-order-selection-bar button')].find(button => text(button) === label);
    const select = find('全选本页');
    if (!select || select.disabled) throw new Error('PURCHASE_PAGE_SELECTION_DISABLED');
    select.click();
    await wait(() => rows().every(row => row.querySelector('input[type="checkbox"]').checked));
    find('清空')?.click();
    await wait(() => rows().every(row => !row.querySelector('input[type="checkbox"]').checked));
    const all = find('全选所有页');
    if (!all || all.disabled) throw new Error('PURCHASE_ALL_PAGES_SELECTION_DISABLED');
    all.click();
    const selectedCount = () => text(panel().querySelector('.sales-order-selection-count'));
    await wait(() => selectedCount() === '已选' + step.total + '个'
      && rows().every(row => row.querySelector('input[type="checkbox"]').checked));
    panel().querySelector('.purchase-order-pagination button[aria-label="Go to page 1"]')?.click();
    // Existing page navigation deliberately clears selection. Do not turn a
    // full-filter selection check into a new keep-selection-across-navigation rule.
    await wait(() => summary().endsWith('1-20') && selectedCount() === '已选0个'
      && rows().every(row => !row.querySelector('input[type="checkbox"]').checked));
    panel().querySelector('.purchase-order-pagination button[aria-label="Go to page 2"]')?.click();
    await wait(() => summary().endsWith('21-40') && selectedCount() === '已选0个');
    find('全选所有页')?.click();
    await wait(() => selectedCount() === '已选' + step.total + '个');
    find('清空')?.click();
    await wait(() => selectedCount() === '已选0个'
      && rows().every(row => !row.querySelector('input[type="checkbox"]').checked));
  } else throw new Error('PURCHASE_UNKNOWN_INTERACTION');
  await frame(); await frame();
  return { kind: step.kind, shopId: step.shopId || '', expectedCount: step.count ?? null,
    durationMs: performance.now() - startedAt, rowCount: rows().length, ids: ids(), summary: summary(),
    ...(step.kind === 'selection' ? { allPagesSelectionVerified: true, allPagesSelectedCount: step.total } : {}) };
}

export async function collectPurchaseOrderInteractions(window, fixture, onProgress = () => {}) {
  assert.ok(Array.isArray(fixture.shops) && fixture.shops.length > 0 && fixture.shops.length <= 20);
  for (const shop of fixture.shops) {
    assert.match(shop.shopId, /^ux-fixture-shop-\d+$/);
    assert.ok(Number.isSafeInteger(shop.orders) && shop.orders >= 40);
  }
  const total = fixture.shops.reduce((sum, shop) => sum + shop.orders, 0);
  const steps = [
    ...fixture.shops.map(shop => ({ kind: 'shop', shopId: shop.shopId, count: shop.orders, shopCount: fixture.shops.length })),
    { kind: 'shop', shopId: 'all', count: total, shopCount: fixture.shops.length },
    { kind: 'search', query: '10000000-0001-1', count: 1 },
    { kind: 'clear-search', count: total },
    { kind: 'page' }, { kind: 'selection', total },
  ];
  const samples = [];
  try {
    for (const step of steps) {
      onProgress({ phase: 'start', kind: step.kind, shopId: step.shopId });
      const sample = await window.webContents.executeJavaScript(`(${performPurchaseStep.toString()})(${JSON.stringify(step)})`);
      // MUI's real menu auto-focus stays in a hidden webview. Relinquish it
      // before inspecting context; do not replace document.hasFocus().
      window.blurWebView(); window.blur();
      sample.context = { isVisible: window.isVisible(), isFocused: window.isFocused(),
        documentHasFocus: await window.webContents.executeJavaScript('document.hasFocus()') };
      assert.equal(sample.context.isVisible, false);
      assert.equal(sample.context.isFocused, false);
      assert.equal(sample.context.documentHasFocus, false);
      samples.push(sample);
      onProgress({ phase: 'complete', ...sample });
    }
    return { ok: true, samples, expectedSteps: steps.length, nativeInputUsed: false };
  } catch (error) {
    const lastVisibleState = await window.webContents.executeJavaScript(`({
      pagination: document.querySelector('.page-panel:not([hidden]) .purchase-order-pagination')?.textContent,
      selectedPage: document.querySelector('.page-panel:not([hidden]) .purchase-order-pagination [aria-current="page"], .page-panel:not([hidden]) .purchase-order-pagination [aria-current="true"]')?.textContent,
    })`).catch(() => null);
    return { ok: false, samples, expectedSteps: steps.length, error: error.message, lastVisibleState, nativeInputUsed: false };
  }
}
