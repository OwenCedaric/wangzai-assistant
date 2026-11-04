import { appendOzonSnapshotScopeKey } from '../../../../entities/order/orderShopScope.jsx';
import { readProfitLedgerLocalSnapshot } from '../../../../entities/profit/profitLedgerPersistence.jsx';
import { mapProfitLedgerRowsByKey } from '../../../../entities/profit/profitDisplayRules.jsx';
import { getProfitLedgerSnapshotCacheKeyCandidates } from '../../../../services/profitLedgerService';
import { LOCAL_PROFIT_DATA_FILE_KEY } from '../../../../shared/config/appConfigCore.jsx';

function shiftDateKey(dateKey, offsetDays) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function createRollingScopes(scope = null, lookbackDays = 7) {
  if (!scope?.startDateKey || !scope?.endDateKey) return [scope].filter(Boolean);
  const scopes = [scope];
  for (let day = 1; day <= lookbackDays; day += 1) {
    const startDateKey = shiftDateKey(scope.startDateKey, -day);
    const endDateKey = shiftDateKey(scope.endDateKey, -day);
    if (!startDateKey || !endDateKey) continue;
    scopes.push({
      ...scope,
      startDateKey,
      endDateKey,
      cachePart: `${scope.page}:range:${startDateKey}_${endDateKey}:filter:${scope.filterScope}:v:${scope.version}`,
      apiRange: {
        since: scope.apiRange?.since ? scope.apiRange.since.replace(scope.startDateKey, startDateKey) : scope.since,
        to: scope.apiRange?.to ? scope.apiRange.to.replace(scope.endDateKey, endDateKey) : scope.to,
      },
    });
  }
  return scopes;
}

export function createPurchaseProfitLedgerSnapshotKeys(readableShops = [], timeScope = null, lookbackDays = 7) {
  const baseKeys = getProfitLedgerSnapshotCacheKeyCandidates(readableShops);
  return [
    ...new Set(
      createRollingScopes(timeScope, lookbackDays).flatMap((scope) =>
        baseKeys.map((key) => appendOzonSnapshotScopeKey(key, scope))
      )
    ),
  ].filter(Boolean);
}

export async function readPurchaseProfitLedgerSnapshot(readableShops = [], timeScope = null) {
  const snapshotKeys = createPurchaseProfitLedgerSnapshotKeys(readableShops, timeScope);
  if (!snapshotKeys.length) return { rowsByKey: {}, rows: [], updatedAt: '', snapshotKeys };

  const snapshot = await readProfitLedgerLocalSnapshot(LOCAL_PROFIT_DATA_FILE_KEY, snapshotKeys);
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  return {
    rowsByKey: mapProfitLedgerRowsByKey(rows),
    rows,
    updatedAt: snapshot?.updatedAt || snapshot?.fetchedAt || '',
    snapshotKeys,
  };
}
