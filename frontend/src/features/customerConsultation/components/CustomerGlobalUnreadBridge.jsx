import { getOzonGenerationAwareShopSourceKey } from '../../../shared/ozon/ozonShopGeneration.js';
import { listOzonPushBindings } from '../../../api/localApiClient.js';
import {
  buildCustomerShopUnreadSnapshot,
  mergeCustomerShopUnreadSnapshots,
} from '../lib/customerGlobalUnread.js';
import { useCustomerOzonConversations } from '../model/useCustomerOzonConversations.js';
import { useCustomerConsultationRealtime } from '../model/useCustomerConsultationRealtime.js';
import React from 'react';

export { buildCustomerShopUnreadSnapshot, mergeCustomerShopUnreadSnapshots } from '../lib/customerGlobalUnread.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function getShopName(shop = {}) {
  return normalizeText(shop.sellerName || shop.shopAlias || shop.name || shop.alias) || 'Ozon 店铺';
}

function CustomerShopUnreadWatcher({ shop, pushBound, snapshotRequest, onPushObserved, onSnapshot }) {
  const shopId = normalizeText(shop?.id);
  const [activePushBinding, setActivePushBinding] = React.useState(Boolean(pushBound));
  const authoritativeSnapshotRef = React.useRef(null);
  const accountScopeKey = React.useMemo(
    () => (shopId ? getOzonGenerationAwareShopSourceKey(shop) : ''),
    [shop, shopId]
  );
  const conversationState = useCustomerOzonConversations(shopId, {
    enabled: Boolean(shopId && activePushBinding),
    accountScopeKey,
    shopName: getShopName(shop),
  });
  const refreshList = conversationState.refreshList;

  React.useEffect(() => {
    if (pushBound) setActivePushBinding(true);
  }, [pushBound]);

  const handleRealtimeEvent = React.useCallback(
    () => {
      authoritativeSnapshotRef.current = null;
      if (!activePushBinding) {
        setActivePushBinding(true);
        onPushObserved(shopId);
        return undefined;
      }
      return refreshList({ forceRefresh: false });
    },
    [activePushBinding, onPushObserved, refreshList, shopId]
  );
  useCustomerConsultationRealtime({
    shopId,
    enabled: Boolean(shopId),
    onEvent: handleRealtimeEvent,
  });

  React.useEffect(() => {
    if (!activePushBinding) {
      onSnapshot(shopId, null);
      return;
    }
    const authoritative = authoritativeSnapshotRef.current;
    onSnapshot(
      shopId,
      authoritative?.snapshot || buildCustomerShopUnreadSnapshot(shop, conversationState.rows)
    );
  }, [activePushBinding, conversationState.rows, onSnapshot, shop, shopId]);

  React.useEffect(() => {
    if (!snapshotRequest?.sequence || normalizeText(snapshotRequest.shopId) !== shopId) return;
    if (!activePushBinding) return;
    const snapshot = {
      shopId,
      shopName: normalizeText(snapshotRequest.shopName) || getShopName(shop),
      unreadCount: Number(snapshotRequest.unreadCount) || 0,
      latest: snapshotRequest.latest || null,
    };
    authoritativeSnapshotRef.current = { sequence: snapshotRequest.sequence, snapshot };
    onSnapshot(shopId, snapshot);
  }, [activePushBinding, onSnapshot, shop, shopId, snapshotRequest]);

  return null;
}

export function CustomerGlobalUnreadBridge({ shops = [], snapshotRequest = null, onChange }) {
  const snapshotsRef = React.useRef(new Map());
  const [pushBoundShopIds, setPushBoundShopIds] = React.useState(() => new Set());
  const shopRows = React.useMemo(
    () => (Array.isArray(shops) ? shops : []).filter((shop) => normalizeText(shop?.id)),
    [shops]
  );
  const shopIdsKey = shopRows.map((shop) => normalizeText(shop.id)).sort().join('|');

  const publishSnapshot = React.useCallback(
    (shopId, snapshot) => {
      if (!shopId) return;
      if (snapshot) snapshotsRef.current.set(shopId, snapshot);
      else snapshotsRef.current.delete(shopId);
      onChange?.(mergeCustomerShopUnreadSnapshots([...snapshotsRef.current.values()]));
    },
    [onChange]
  );

  const markPushObserved = React.useCallback((shopId) => {
    if (!shopId) return;
    setPushBoundShopIds((current) => {
      if (current.has(shopId)) return current;
      const next = new Set(current);
      next.add(shopId);
      return next;
    });
  }, []);

  React.useEffect(() => {
    const licensedShopIds = shopRows.map((shop) => normalizeText(shop.id)).filter(Boolean);
    if (!licensedShopIds.length) {
      setPushBoundShopIds(new Set());
      return undefined;
    }
    const controller = new AbortController();
    void listOzonPushBindings(
      { domain: 'customer', shopIds: licensedShopIds.join(',') },
      { timeoutMs: 8000, signal: controller.signal }
    )
      .then((payload) => {
        if (controller.signal.aborted || payload?.ok === false) return;
        setPushBoundShopIds(
          new Set((Array.isArray(payload?.shopIds) ? payload.shopIds : []).map(normalizeText).filter(Boolean))
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [shopIdsKey]);

  React.useEffect(() => {
    const activeShopIds = new Set(shopRows.map((shop) => normalizeText(shop.id)));
    for (const shopId of snapshotsRef.current.keys()) {
      if (!activeShopIds.has(shopId)) snapshotsRef.current.delete(shopId);
    }
    onChange?.(mergeCustomerShopUnreadSnapshots([...snapshotsRef.current.values()]));
  }, [onChange, shopIdsKey, shopRows]);

  return shopRows.map((shop) => (
    <CustomerShopUnreadWatcher
      key={shop.id}
      shop={shop}
      pushBound={pushBoundShopIds.has(normalizeText(shop.id))}
      snapshotRequest={snapshotRequest}
      onPushObserved={markPushObserved}
      onSnapshot={publishSnapshot}
    />
  ));
}

export default CustomerGlobalUnreadBridge;
