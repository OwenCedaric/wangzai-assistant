function normalizeText(value, maximum = 500) {
  const text = value == null ? '' : String(value).trim();
  return text.slice(0, maximum);
}

function normalizeMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/[^0-9.+-]/gu, ''));
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundAccounting(value) {
  return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000;
}

const INCOME_REASON_PATTERN = /(?:退还|退回|退款|返还|返款|返费|冲正|撤销[^,，;；]*(?:退|返)|取消[^,，;；]*(?:退|返))/u;
const EXPENSE_REASON_PATTERN = /(?:支付|发货费用|补收|扣费|扣款|消费|收费|实际服务费|系统服务费)/u;

function normalizeDeclaredDirection(value) {
  const text = normalizeText(value, 80).toLowerCase();
  if (text === 'income' || text === '收入' || text === 'in'
    || text.includes('退款') || text.includes('返')) return 'income';
  if (text === 'expense' || text === '支出' || text === 'out'
    || text.includes('消费') || text.includes('扣')) return 'expense';
  return '';
}

/**
 * Cross-Border Bus currently marks refund rows as “支出” in some API
 * responses.  The business reason is therefore authoritative; the declared
 * type and signed amount are fallbacks only.
 */
export function inferCrossBorderChargeDirection(input = {}) {
  const reason = normalizeText(input.reason, 300);
  if (INCOME_REASON_PATTERN.test(reason)) return 'income';
  if (EXPENSE_REASON_PATTERN.test(reason)) return 'expense';

  const declared = normalizeDeclaredDirection(input.direction ?? input.type);
  if (declared) return declared;

  const amount = normalizeMoney(input.amountCny ?? input.amount_cny ?? input.money ?? input.amount);
  return amount !== null && amount < 0 ? 'income' : 'expense';
}

export function createCrossBorderChargePhysicalIdentity(input = {}) {
  const amount = normalizeMoney(input.amountCny ?? input.amount_cny ?? input.money ?? input.amount);
  return {
    collectionNumber: normalizeText(
      input.collectionNumber ?? input.collection_number ?? input.oid,
      180,
    ),
    occurredAt: normalizeText(input.occurredAt ?? input.occurred_at ?? input.time, 80),
    amountCny: amount === null ? null : Math.abs(amount),
    balanceAfterCny: normalizeMoney(
      input.balanceAfterCny
      ?? input.balance_after_cny
      ?? input.afterMoney
      ?? input.after_money,
    ),
    reason: normalizeText(input.reason, 300),
    warehouse: normalizeText(
      input.warehouse ?? input.storehoursName ?? input.storehours_name,
      240,
    ),
    serviceCompany: normalizeText(
      input.serviceCompany
      ?? input.service_company
      ?? input.brandName
      ?? input.brand_name,
      300,
    ),
  };
}

export function summarizeCrossBorderLedger(rows = [], options = {}) {
  const resolveCashRate = typeof options.resolveCashRate === 'function'
    ? options.resolveCashRate
    : () => ({ rate: 1, entryId: 'one-to-one', source: 'one-to-one' });
  const normalizedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
    row,
    index,
    occurredAt: normalizeText(row?.occurredAt ?? row?.occurred_at ?? row?.time, 80),
  })).sort((left, right) => {
    const leftNumber = Number(left.occurredAt);
    const rightNumber = Number(right.occurredAt);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    if (left.occurredAt !== right.occurredAt) return left.occurredAt.localeCompare(right.occurredAt);
    return left.index - right.index;
  });
  let expenseCny = 0;
  let incomeCny = 0;
  let cashExpenseCny = 0;
  let cashIncomeCny = 0;
  const expenseLots = [];
  const conversions = [];
  normalizedRows.forEach(({ row, index, occurredAt }) => {
    const rawAmount = normalizeMoney(row?.amountCny ?? row?.amount_cny ?? row?.money ?? row?.amount);
    if (rawAmount === null) return;
    const amount = Math.abs(rawAmount);
    const direction = inferCrossBorderChargeDirection(row);
    const scheduled = resolveCashRate(occurredAt, row) || {};
    const scheduledRate = Number(scheduled.rate);
    const safeScheduledRate = Number.isFinite(scheduledRate) && scheduledRate > 0 ? scheduledRate : 1;
    let cashAmount = 0;
    const allocations = [];
    if (direction === 'income') {
      incomeCny += amount;
      let remaining = amount;
      for (let lotIndex = expenseLots.length - 1; lotIndex >= 0 && remaining > 0; lotIndex -= 1) {
        const lot = expenseLots[lotIndex];
        if (lot.remaining <= 0) continue;
        const allocated = Math.min(remaining, lot.remaining);
        cashAmount += allocated * lot.rate;
        lot.remaining = roundAccounting(lot.remaining - allocated);
        remaining = roundAccounting(remaining - allocated);
        allocations.push({ amountCny: allocated, rate: lot.rate, entryId: lot.entryId, source: 'original-expense' });
      }
      if (remaining > 0) {
        cashAmount += remaining * safeScheduledRate;
        allocations.push({ amountCny: remaining, rate: safeScheduledRate, entryId: scheduled.entryId || '', source: 'scheduled-fallback' });
      }
      cashIncomeCny += cashAmount;
    } else {
      expenseCny += amount;
      cashAmount = amount * safeScheduledRate;
      cashExpenseCny += cashAmount;
      expenseLots.push({
        remaining: amount,
        rate: safeScheduledRate,
        entryId: scheduled.entryId || '',
      });
      allocations.push({ amountCny: amount, rate: safeScheduledRate, entryId: scheduled.entryId || '', source: 'scheduled-expense' });
    }
    conversions.push({
      index,
      direction,
      occurredAt,
      amountCny: amount,
      cashAmountCny: roundAccounting(cashAmount),
      scheduledRate: safeScheduledRate,
      entryId: scheduled.entryId || '',
      effectiveAt: scheduled.effectiveAt || '',
      source: scheduled.source || '',
      allocations,
    });
  });
  expenseCny = roundMoney(expenseCny);
  incomeCny = roundMoney(incomeCny);
  cashExpenseCny = roundAccounting(cashExpenseCny);
  cashIncomeCny = roundAccounting(cashIncomeCny);
  const ledgerNetCny = roundMoney(expenseCny - incomeCny);
  const cashNetCny = roundAccounting(cashExpenseCny - cashIncomeCny);
  return {
    statementCount: normalizedRows.length,
    expenseCny,
    incomeCny,
    ledgerNetCny,
    cashExpenseCny,
    cashIncomeCny,
    cashNetCny,
    actualFeeCny: roundMoney(Math.max(0, cashNetCny)),
    conversions,
  };
}

function uniqueText(rows, selector, maximum = 180) {
  return [...new Set(rows.map((row) => normalizeText(selector(row), maximum)).filter(Boolean))];
}

/**
 * Profit is written once per Ozon order.  Individual collection numbers stay
 * available as audit links, but clamping to zero happens only after all of an
 * Ozon order's ledgers have been combined.
 */
export function aggregateCrossBorderOrderCharges(rows = []) {
  const groups = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (!row || row.matchStatus !== 'exact') return;
    const shopId = normalizeText(row.shopId ?? row.shop_id, 180);
    const orderKey = normalizeText(
      row.ozonOrderKey ?? row.ozon_order_key ?? row.postingNumber ?? row.posting_number,
      180,
    );
    if (!shopId || !orderKey) return;
    const tenantId = normalizeText(row.tenantId ?? row.tenant_id, 128);
    const userId = normalizeText(row.userId ?? row.user_id, 128);
    const profileId = normalizeText(row.profileId ?? row.profile_id, 128);
    const key = [tenantId, userId, profileId, shopId, orderKey].join('\u001f');
    const group = groups.get(key) || {
      key,
      tenantId,
      userId,
      profileId,
      shopId,
      orderKey,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  });

  return [...groups.values()].map((group) => {
    const expenseCny = roundMoney(group.rows.reduce(
      (sum, row) => sum + (normalizeMoney(row.expenseCny ?? row.expense_cny) || 0),
      0,
    ));
    const incomeCny = roundMoney(group.rows.reduce(
      (sum, row) => sum + (normalizeMoney(row.incomeCny ?? row.income_cny) || 0),
      0,
    ));
    const ledgerNetCny = roundMoney(expenseCny - incomeCny);
    const cashExpenseCny = roundAccounting(group.rows.reduce(
      (sum, row) => sum + (Number(
        row.cashExpenseCny ?? row.cash_expense_cny ?? row.expenseCny ?? row.expense_cny,
      ) || 0),
      0,
    ));
    const cashIncomeCny = roundAccounting(group.rows.reduce(
      (sum, row) => sum + (Number(
        row.cashIncomeCny ?? row.cash_income_cny ?? row.incomeCny ?? row.income_cny,
      ) || 0),
      0,
    ));
    const cashNetCny = roundAccounting(cashExpenseCny - cashIncomeCny);
    const first = group.rows[0] || {};
    return {
      ...group,
      postingNumber: normalizeText(first.postingNumber ?? first.posting_number, 180) || group.orderKey,
      ozonOrderKey: group.orderKey,
      collectionNumbers: uniqueText(group.rows, (row) => row.collectionNumber ?? row.collection_number),
      internalOrderIds: uniqueText(group.rows, (row) => row.internalOrderId ?? row.internal_order_id),
      purchaseOrderNumbers: uniqueText(group.rows, (row) => row.purchaseOrderNumber ?? row.purchase_order_number),
      crossBorderAccountIds: uniqueText(group.rows, (row) => row.crossBorderAccountId ?? row.cross_border_account_id),
      browserAccountRefs: uniqueText(group.rows, (row) => row.browserAccountRef ?? row.browser_account_ref),
      externalAccountRefs: uniqueText(group.rows, (row) => row.externalAccountRef ?? row.external_account_ref),
      statementCount: group.rows.reduce(
        (sum, row) => sum + Math.max(Number(row.statements?.length ?? row.statementCount ?? 0) || 0, 0),
        0,
      ),
      expenseCny,
      incomeCny,
      ledgerNetCny,
      cashExpenseCny,
      cashIncomeCny,
      cashNetCny,
      actualFeeCny: roundMoney(Math.max(0, cashNetCny)),
      collections: group.rows.map((row) => ({
        collectionNumber: normalizeText(row.collectionNumber ?? row.collection_number, 180),
        internalOrderId: normalizeText(row.internalOrderId ?? row.internal_order_id, 180),
        statementCount: Math.max(Number(row.statements?.length ?? row.statementCount ?? 0) || 0, 0),
        expenseCny: roundMoney(row.expenseCny ?? row.expense_cny),
        incomeCny: roundMoney(row.incomeCny ?? row.income_cny),
        ledgerNetCny: roundMoney(row.ledgerNetCny ?? row.ledger_net_cny),
        cashExpenseCny: roundAccounting(row.cashExpenseCny ?? row.cash_expense_cny),
        cashIncomeCny: roundAccounting(row.cashIncomeCny ?? row.cash_income_cny),
        cashNetCny: roundAccounting(row.cashNetCny ?? row.cash_net_cny),
        actualFeeCny: roundMoney(row.actualFeeCny ?? row.actual_fee_cny),
        conversions: Array.isArray(row.conversions) ? row.conversions : [],
        sourceHash: normalizeText(row.sourceHash ?? row.source_hash, 80),
      })),
    };
  });
}
