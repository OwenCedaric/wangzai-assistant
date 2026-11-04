import React from 'react';
import { firstFiniteNumber } from '../../../entities/product/productAttributes.jsx';
import { PROFIT_MANUAL_OVERRIDE_FIELDS, upsertProfitManualOverrideAmount } from '../../../entities/profit/profitFinanceEvidence.jsx';
import { applyProfitLedgerToProfitOrder, getProfitLedgerEntryValue } from '../../../entities/profit/profitDisplayRules.jsx';
import { rebuildProfitLedgerForExecution } from '../../../services/profitCalculationExecution.js';
import { getProfitOrderRecordKey } from '../../../entities/profit/profitOrderRecordRules.jsx';
import { PROFIT_FINANCE_CACHE_VERSION } from '../../../shared/config/appConfigCore.jsx';

export function useProfitInlineEditing({
  selectedOrder, selectedOrderKey, editor, setEditor, setLedgerRows, setFinanceRows, persistOrders, onSavedOverrides,
  upsert = upsertProfitManualOverrideAmount, rebuild = rebuildProfitLedgerForExecution,
}) {
  const inFlightRef = React.useRef(null);
  const committedSourceRef = React.useRef(null);
  const controllerRef = React.useRef(null);
  const selectedKeyRef = React.useRef(selectedOrderKey);
  selectedKeyRef.current = selectedOrderKey;
  React.useEffect(() => () => controllerRef.current?.abort(), [selectedOrderKey]);
  const begin = React.useCallback(fieldId => {
    if (!selectedOrder || !PROFIT_MANUAL_OVERRIDE_FIELDS[fieldId] || inFlightRef.current) return;
    committedSourceRef.current = null;
    const value = getProfitLedgerEntryValue(selectedOrder.profitLedger?.amounts?.[fieldId]);
    setEditor({ fieldId, orderKey: selectedOrderKey, value: value === null ? '' : String(Math.abs(value)) });
  }, [selectedOrder, selectedOrderKey, setEditor]);
  const cancel = React.useCallback(() => {
    if (!inFlightRef.current) { committedSourceRef.current = null; setEditor(null); }
  }, [setEditor]);
  const save = React.useCallback(() => {
    if (inFlightRef.current) return inFlightRef.current;
    if (!selectedOrder || !editor || editor.orderKey !== selectedOrderKey) return Promise.resolve(false);
    const matches = current => current?.orderKey === editor.orderKey && current?.fieldId === editor.fieldId && current?.value === editor.value;
    const amount = firstFiniteNumber(editor.value);
    if (amount === null || amount < 0) {
      setEditor(current => matches(current) ? { ...current, error: '请输入大于或等于 0 的有效金额。' } : current);
      return Promise.resolve(false);
    }
    setEditor(current => matches(current) ? { ...current, saving: true, error: '' } : current);
    const sourceKey = JSON.stringify([editor.orderKey, editor.fieldId, amount]);
    const controller = new AbortController();
    controllerRef.current = controller;
    const assertCurrent = () => {
      if (controller.signal.aborted || selectedKeyRef.current !== selectedOrderKey) throw new Error('PROFIT_OVERRIDE_SCOPE_CHANGED');
    };
    const request = (async () => {
      let sourceSaved = false;
      try {
        assertCurrent();
        let saved = committedSourceRef.current?.key === sourceKey ? committedSourceRef.current.saved : null;
        if (!saved) {
          saved = upsert(selectedOrder, editor.fieldId, amount);
          if (!saved?.persistence) throw new Error('PROFIT_OVERRIDE_PERSISTENCE_MISSING');
          const receipt = await saved.persistence;
          if (!receipt || receipt.ok === false || !Array.isArray(receipt.failedKeys) || receipt.failedKeys.length) {
            throw new Error('PROFIT_OVERRIDE_SAVE_FAILED');
          }
          committedSourceRef.current = { key: sourceKey, saved };
        }
        sourceSaved = true;
        assertCurrent();
        const rebuiltLedger = await rebuild(selectedOrder, editor.fieldId, amount, { signal: controller.signal });
        assertCurrent();
        if (!rebuiltLedger) throw new Error('PROFIT_OVERRIDE_LEDGER_REBUILD_FAILED');
        const updatedOrder = applyProfitLedgerToProfitOrder({ ...selectedOrder, profitFinanceVersion: PROFIT_FINANCE_CACHE_VERSION }, rebuiltLedger);
        const ledgerReceipt = await persistOrders([updatedOrder], []);
        if (!ledgerReceipt?.snapshot || ledgerReceipt.stats?.partial === true) throw new Error('PROFIT_OVERRIDE_LEDGER_SAVE_UNCONFIRMED');
        assertCurrent();
        const key = getProfitOrderRecordKey(selectedOrder) || selectedOrderKey;
        setLedgerRows(current => ({ ...current, [key]: rebuiltLedger }));
        setFinanceRows(current => ({ ...current, [key]: updatedOrder }));
        if (saved.allOverrides) onSavedOverrides?.(saved.allOverrides, saved);
        committedSourceRef.current = null;
        setEditor(current => matches(current) ? null : current);
        return true;
      } catch {
        if (controller.signal.aborted) return false;
        setEditor(current => matches(current) ? {
          ...current, saving: false,
          error: sourceSaved ? '金额已保存，但利润账本更新未完成。请按回车重试计算和保存。' : '保存失败，修改尚未确认。请按回车重试。',
        } : current);
        return false;
      }
    })();
    inFlightRef.current = request;
    void request.finally(() => { if (inFlightRef.current === request) inFlightRef.current = null; });
    return request;
  }, [editor, onSavedOverrides, persistOrders, rebuild, selectedOrder, selectedOrderKey, setEditor, setFinanceRows, setLedgerRows, upsert]);
  return { begin, cancel, save };
}
