import React from 'react';
import { readProfitLedgerLocalSnapshot } from '../../../entities/profit/profitLedgerPersistence.jsx';
import { mapProfitLedgerRowsByKey } from '../../../entities/profit/profitDisplayRules.jsx';
import { PROFIT_LEDGER_CHUNKED_FORMAT } from '../../../services/profitLedgerPersistenceCompaction.js';

const ownerOf = row => String(row?.shopId || row?.orderSnapshot?.shopId || '').trim();
const belongsTo = (row, partition) => partition.shopId
  ? ownerOf(row) === partition.shopId
  : !partition.excludedShopIds.includes(ownerOf(row));

export function mergeProfitPartitionReadback(current, partition) {
  if (partition.status !== 'fulfilled') return current;
  return {
    ...Object.fromEntries(Object.entries(current).filter(([, row]) => !belongsTo(row, partition))),
    ...mapProfitLedgerRowsByKey(partition.snapshot?.rows || []),
  };
}

export function useProfitLedgerReadback({
  isActive, hasShops, sourceKey, fileKey, snapshotKeys, snapshotKeyToken,
  setRows, setPenaltyDetails, setCacheInfo, persistSignatureRef, createPersistSignature,
  read = readProfitLedgerLocalSnapshot,
}) {
  const loadedKeyRef = React.useRef('');
  const [retryRevision, setRetryRevision] = React.useState(0);
  const retry = React.useCallback(() => {
    loadedKeyRef.current = '';
    setRetryRevision(current => current + 1);
  }, []);

  React.useEffect(() => {
    if (!hasShops) {
      loadedKeyRef.current = '';
      setRows({});
      setPenaltyDetails({});
      setCacheInfo({ status: 'idle', rowCount: 0, updatedAt: '', partial: false, partitionErrors: [] });
      return undefined;
    }
    if (!isActive || loadedKeyRef.current === snapshotKeyToken) return undefined;
    const controller = new AbortController();
    const completed = new Map();
    setCacheInfo(current => ({ ...current, status: 'loading', partial: true, partitionErrors: [] }));
    const onPartition = partition => {
      if (controller.signal.aborted) return;
      completed.set(partition.shopId || 'shared', partition);
      if (partition.status === 'fulfilled') {
        setRows(current => mergeProfitPartitionReadback(current, partition));
        setPenaltyDetails(current => ({
          ...Object.fromEntries(Object.entries(current).filter(([, row]) => !belongsTo(row, partition))),
          ...(partition.snapshot?.profitPenaltyDetails ?? partition.snapshot?.penaltyDetails ?? {}),
        }));
      }
      const partitions = [...completed.values()];
      setCacheInfo(current => ({
        ...current, status: 'loading', partial: true,
        rowCount: partitions.reduce((sum, part) => sum + (part.snapshot?.rows?.length || 0), 0),
        partitionErrors: partitions.filter(part => part.status === 'rejected').map(part => part.error),
      }));
    };
    read(fileKey, snapshotKeys, { signal: controller.signal, onPartition }).then(snapshot => {
      if (controller.signal.aborted) return;
      const rows = snapshot?.rows || [];
      const partial = snapshot?.partial === true || snapshot?.readComplete === false;
      if (!partial) {
        setRows(mapProfitLedgerRowsByKey(rows));
        setPenaltyDetails(snapshot?.profitPenaltyDetails ?? snapshot?.penaltyDetails ?? {});
        loadedKeyRef.current = snapshotKeyToken;
      } else if (!completed.size) {
        // Compatibility with readers that return a partial result without progress events.
        setRows(current => ({ ...current, ...mapProfitLedgerRowsByKey(rows) }));
        setPenaltyDetails(current => ({ ...current, ...(snapshot?.profitPenaltyDetails ?? snapshot?.penaltyDetails ?? {}) }));
      }
      persistSignatureRef.current = !partial && [PROFIT_LEDGER_CHUNKED_FORMAT, 'profit-ledger-partitioned-v1'].includes(snapshot?.persistenceFormat)
        ? createPersistSignature(rows, snapshotKeyToken) : '';
      setCacheInfo({
        status: partial ? 'partial' : rows.length ? 'hit' : 'miss', partial,
        rowCount: rows.length, updatedAt: snapshot?.updatedAt || snapshot?.fetchedAt || '',
        partitionErrors: snapshot?.partitionErrors || [],
      });
    }).catch(error => {
      if (controller.signal.aborted) return;
      persistSignatureRef.current = '';
      setCacheInfo(current => ({
        ...current, status: 'error', partial: true,
        partitionErrors: [{ code: 'PROFIT_LEDGER_READ_FAILED', message: error instanceof Error ? error.message : String(error) }],
      }));
    });
    return () => controller.abort();
  }, [createPersistSignature, fileKey, hasShops, isActive, persistSignatureRef, read, retryRevision, setCacheInfo, setPenaltyDetails, setRows, snapshotKeys, snapshotKeyToken, sourceKey]);

  return retry;
}
