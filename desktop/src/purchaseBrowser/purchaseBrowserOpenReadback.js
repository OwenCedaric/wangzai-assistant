function text(value) {
  return String(value ?? '').trim();
}

export function evaluatePurchaseBrowserOpenReadback({
  state = {},
  accountId = '',
  requestedUrl = '',
  requestedEmbedded = false,
} = {}) {
  const activeTab = Array.isArray(state?.tabs)
    ? state.tabs.find((tab) => tab.tabId === state.activeTabId)
    : null;
  const targetMatched = Boolean(
    activeTab
    && state.visible === true
    && text(activeTab.accountId) === text(accountId)
    && text(activeTab.requestedUrl) === text(requestedUrl)
  );
  if (!targetMatched) return { ok: false, code: 'PURCHASE_BROWSER_TARGET_MISMATCH', mode: 'mismatch' };
  if (!requestedEmbedded) return { ok: true, code: '', mode: 'window' };

  const embedding = activeTab.embedding;
  const dedicatedWindow = activeTab.displayMode === 'window'
    && activeTab.browserLayout === 'pinduoduo-dedicated'
    && embedding?.requested !== true
    && embedding?.embedded !== true
    && embedding?.childStyle !== true;
  if (dedicatedWindow) return { ok: true, code: '', mode: 'pinduoduo-dedicated' };

  const embeddedReady = embedding?.embedded === true
    && embedding?.childStyle === true
    && text(embedding?.parentHwnd) !== '0'
    && text(embedding?.actualParentHwnd) === text(embedding?.parentHwnd);
  return embeddedReady
    ? { ok: true, code: '', mode: 'embedded' }
    : { ok: false, code: 'PURCHASE_BROWSER_EMBED_READBACK_FAILED', mode: 'embedded' };
}
