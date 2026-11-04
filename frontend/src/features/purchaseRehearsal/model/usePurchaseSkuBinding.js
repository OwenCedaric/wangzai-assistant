import React from 'react';
import { readRubCnyExchangeRateContext } from '../../../services/exchangeRateClient.js';

import {
  loadSkuNameBindings,
  purchaseSkuBindingErrorMessage,
  readSkuCatalogFromLink,
  saveSkuNameBinding,
} from '../services/purchaseSkuBindingService.js';
const EMPTY_DOCUMENT = Object.freeze({ version: 1, bindings: [] });

export function usePurchaseSkuBinding({ initialOzonUrl = '', initialSourceUrl = '', scope = {}, isActive = true } = {}) {
  const [ozonUrl, setOzonUrl] = React.useState(() => String(initialOzonUrl || '').trim());
  const [sourceUrl, setSourceUrl] = React.useState(() => String(initialSourceUrl || '').trim());
  const [ozonCatalog, setOzonCatalog] = React.useState(null);
  const [sourceCatalog, setSourceCatalog] = React.useState(null);
  const [selections, setSelections] = React.useState({});
  const [document, setDocument] = React.useState(EMPTY_DOCUMENT);
  const [loadingRole, setLoadingRole] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [errorMessage, setErrorMessage] = React.useState('');
  const [rubToCnyRate, setRubToCnyRate] = React.useState(null);

  React.useEffect(() => {
    if (!isActive) return undefined;
    let disposed = false;
    loadSkuNameBindings()
      .then((value) => { if (!disposed) setDocument(value); })
      .catch((error) => { if (!disposed) setErrorMessage(purchaseSkuBindingErrorMessage(error)); });
    return () => { disposed = true; };
  }, [isActive]);

  React.useEffect(() => {
    if (!isActive) return undefined;
    let disposed = false;
    readRubCnyExchangeRateContext([], { includeRealtime: true, skipDailyRates: true, timeoutMs: 5000 })
      .then((context) => {
        const rate = Number(context?.realtime?.rubToCnyRate);
        if (!disposed && Number.isFinite(rate) && rate > 0) setRubToCnyRate(rate);
      })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [isActive]);

  const readCatalog = React.useCallback(async (role) => {
    const url = role === 'ozon' ? ozonUrl : sourceUrl;
    setLoadingRole(role);
    setErrorMessage('');
    setMessage('');
    try {
      const catalog = await readSkuCatalogFromLink(url, role, { scope });
      if (role === 'ozon') setOzonCatalog(catalog);
      else setSourceCatalog(catalog);
      setSelections({});
      setMessage(`${catalog.title}：${catalog.cacheHit ? '已从本地缓存读取' : '已读取'} ${catalog.skus.length} 个具名 SKU。`);
      return catalog;
    } catch (error) {
      if (role === 'ozon') setOzonCatalog(null);
      else setSourceCatalog(null);
      setErrorMessage(purchaseSkuBindingErrorMessage(error));
      return null;
    } finally {
      setLoadingRole('');
    }
  }, [ozonUrl, scope, sourceUrl]);

  const selectSourceSku = React.useCallback((ozonSkuId, sourceSkuId) => {
    setSelections((current) => ({ ...current, [ozonSkuId]: sourceSkuId }));
    setMessage('');
    setErrorMessage('');
  }, []);

  const changeOzonUrl = React.useCallback((value) => {
    setOzonUrl(value);
    setOzonCatalog(null);
    setSelections({});
    setMessage('');
  }, []);

  const changeSourceUrl = React.useCallback((value) => {
    setSourceUrl(value);
    setSourceCatalog(null);
    setSelections({});
    setMessage('');
  }, []);

  const saveBinding = React.useCallback(async () => {
    setSaving(true);
    setMessage('');
    setErrorMessage('');
    try {
      const result = await saveSkuNameBinding({
        ozonCatalog,
        sourceCatalog,
        selections,
        scope,
        rubToCnyRate,
      });
      setDocument(result.document);
      setMessage(`已保存 ${result.binding.pairs.length} 组 SKU 名称对应关系。`);
      return result;
    } catch (error) {
      setErrorMessage(purchaseSkuBindingErrorMessage(error));
      return null;
    } finally {
      setSaving(false);
    }
  }, [ozonCatalog, rubToCnyRate, scope, selections, sourceCatalog]);

  return {
    ozonUrl,
    sourceUrl,
    ozonCatalog,
    sourceCatalog,
    selections,
    bindings: document.bindings,
    loadingRole,
    saving,
    message,
    errorMessage,
    rubToCnyRate,
    setOzonUrl: changeOzonUrl,
    setSourceUrl: changeSourceUrl,
    readCatalog,
    selectSourceSku,
    saveBinding,
  };
}
