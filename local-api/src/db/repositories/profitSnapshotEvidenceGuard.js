export const PROFIT_EVIDENCE_COMPATIBLE_VERSIONS = Object.freeze([
  'profit-ledger-v15-final-cancel-zero-bus-without-exact-charge',
  'profit-ledger-v16-per-order-finance-exchange-rate',
  'profit-ledger-v16-partial-compensation-net-income',
]);
const COMPATIBLE_RULES = new Set(PROFIT_EVIDENCE_COMPATIBLE_VERSIONS);
const ACTUAL_FIELDS = Object.freeze([
  'actualSalesAmountCny', 'actualCommissionFeeCny', 'actualPenaltyFeeCny', 'actualAcquiringFeeCny',
  'actualDeliveryServiceFeeCny', 'actualLogisticsFeeCny', 'actualCrossBorderBusFeeCny', 'actualOzonFeeCny', 'sourcePurchaseCostCny',
]);
const RETAINED_FINANCE_FIELDS = Object.freeze([
  'actualSalesAmountCny', 'actualCommissionFeeCny', 'actualPenaltyFeeCny',
  'actualAcquiringFeeCny', 'actualDeliveryServiceFeeCny', 'actualLogisticsFeeCny',
  'actualOzonFeeCny', 'platformNetCny', 'refundOrderDeductionFeeCny',
  'buyerCompensationCny',
]);
const text = (value) => value == null ? '' : String(value).trim();
export function getProfitEvidenceRowIdentity(row) {
  const order = row.orderSnapshot || {};
  const shop = text(row.shopId || order.shopId || row.shopClientId || order.shopClientId);
  const posting = text(order.posting || order.postingNumber || order.posting_number || order.id);
  let key = posting || text(row.ledgerKey || row.orderKey);
  // Cache generations may encode posting as client:posting or shop:posting.
  // Strip only this row's verified owner aliases, never another shop prefix.
  for (const owner of new Set([shop, text(row.shopClientId || order.shopClientId)])) {
    if (owner && key.startsWith(`${owner}:`)) key = key.slice(owner.length + 1);
  }
  return shop && key ? `${shop}\u001f${key}` : '';
}
function ready(entry) {
  return entry?.status === 'ready' && entry.value != null && entry.value !== '' && Number.isFinite(Number(entry.value));
}
/** Last safety barrier: never persist a migration/cache miss as loss of confirmed financial evidence. */
export function assertNoProfitEvidenceDowngrade(previous, incoming) {
  if (!incoming) return;
  const oldByKey = new Map((previous?.rows || []).map((row) => [getProfitEvidenceRowIdentity(row), row]).filter(([key]) => key));
  for (const row of incoming.rows || []) {
    if (row.financeReadbackState === 'empty-confirmed') {
      const proof = row.financeEmptyReceipt;
      const posting = text(row.orderSnapshot?.posting || row.orderSnapshot?.id);
      const keys = [...new Set([posting, posting.replace(/^(\d+-\d+)-\d+$/, '$1')])];
      const checkedAt = Date.parse(proof?.checkedAt);
      if (proof?.version !== 1 || proof.source !== 'ozon-posting-finance' || proof.scope !== 'posting-all-history'
        || proof.operationCount !== 0 || row.financeOperationCount !== 0 || row.financeLookupChecked !== true
        || proof.shopId !== text(row.shopId) || proof.clientId !== text(row.shopClientId)
        || !/^\d{6,}-\d{3,}(?:-\d+)?$/.test(posting) || !Array.isArray(proof.postingNumbers)
        || proof.postingNumbers.length !== keys.length || !keys.every(key => proof.postingNumbers.includes(key))
        || !Number.isFinite(checkedAt) || checkedAt > Date.now() + 60_000) {
        const error = new Error('确认无流水必须包含同店铺、父子单号的完整官方核验回执。');
        error.code = 'PROFIT_LEDGER_EMPTY_FINANCE_EVIDENCE_INVALID';
        throw error;
      }
    }
    const old = oldByKey.get(getProfitEvidenceRowIdentity(row));
    if (!old || !COMPATIBLE_RULES.has(old.calculationVersion || previous.calculationVersion)
      || !COMPATIBLE_RULES.has(row.calculationVersion || incoming.calculationVersion)) continue;
    const fields = ACTUAL_FIELDS.filter((key) => ready(old.amounts?.[key]) && !ready(row.amounts?.[key]));
    if (row.financeReadbackState === 'retained') {
      // The caller explicitly did not reread finance. A ready flag alone must
      // not authorize replacing confirmed amounts with synthesized zeroes.
      for (const key of RETAINED_FINANCE_FIELDS) {
        if (ready(old.amounts?.[key]) && Number(old.amounts[key].value) !== Number(row.amounts?.[key]?.value)) fields.push(key);
      }
      if (old.orderSnapshot?.hasFinanceRefund === true && row.orderSnapshot?.hasFinanceRefund !== true) fields.push('hasFinanceRefund');
    }
    const previousCost = old.amounts?.sourcePurchaseCostCny;
    const incomingCost = row.amounts?.sourcePurchaseCostCny;
    if (ready(previousCost) && Number(previousCost.value) > 0
      && Number(incomingCost?.value) === 0 && incomingCost?.source === 'missing-purchase-cost-zero') {
      fields.push('sourcePurchaseCostCny');
    }
    if (ready(old.results?.actualProfitCny) && !ready(row.results?.actualProfitCny)) fields.push('results.actualProfitCny');
    if (old.hasActualFinance === true && row.hasActualFinance === false) fields.push('hasActualFinance');
    if (fields.length) {
      const error = new Error('已确认的利润流水字段不能被未读取或迁移结果覆盖，请重新读取已保存证据。');
      error.code = 'PROFIT_LEDGER_EVIDENCE_DOWNGRADE';
      error.fields = fields;
      throw error;
    }
  }
}
