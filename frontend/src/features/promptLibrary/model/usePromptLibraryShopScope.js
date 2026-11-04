import React from 'react';
import { normalizeOzonShopOption } from '../../../shared/ozon/ozonShopOption.js';

export function buildPromptLibraryShopOptions(shops = []) {
  const seen = new Set();
  return (Array.isArray(shops) ? shops : [])
    .map((shop) => ({
      ...normalizeOzonShopOption(shop),
      sourceShop: shop,
    }))
    .filter((shop) => {
      if (!shop.shopId || seen.has(shop.shopId)) return false;
      seen.add(shop.shopId);
      return true;
    });
}

export function usePromptLibraryShopScope({
  shops = [],
  activeShopId = '',
  onActiveShopChange = () => {},
} = {}) {
  const shopOptions = React.useMemo(() => buildPromptLibraryShopOptions(shops), [shops]);
  const [selectedShopId, setSelectedShopId] = React.useState(() => String(activeShopId || '').trim());
  const previousActiveShopIdRef = React.useRef(String(activeShopId || '').trim());

  React.useEffect(() => {
    const normalizedActiveShopId = String(activeShopId || '').trim();
    const activeShopChanged = previousActiveShopIdRef.current !== normalizedActiveShopId;
    previousActiveShopIdRef.current = normalizedActiveShopId;
    setSelectedShopId((current) => {
      if (activeShopChanged && shopOptions.some((shop) => shop.shopId === normalizedActiveShopId)) {
        return normalizedActiveShopId;
      }
      if (shopOptions.some((shop) => shop.shopId === current)) return current;
      if (shopOptions.some((shop) => shop.shopId === normalizedActiveShopId)) return normalizedActiveShopId;
      return shopOptions[0]?.shopId || '';
    });
  }, [activeShopId, shopOptions]);

  const selectShop = React.useCallback((shopId) => {
    const normalizedShopId = String(shopId || '').trim();
    if (!shopOptions.some((shop) => shop.shopId === normalizedShopId)) return false;
    setSelectedShopId(normalizedShopId);
    onActiveShopChange(normalizedShopId);
    return true;
  }, [onActiveShopChange, shopOptions]);

  const selectedShopOption = React.useMemo(
    () => shopOptions.find((shop) => shop.shopId === selectedShopId) || null,
    [selectedShopId, shopOptions]
  );

  return {
    shopOptions,
    selectedShopId: selectedShopOption?.shopId || '',
    selectedShopOption,
    selectedShop: selectedShopOption?.sourceShop || null,
    selectShop,
  };
}
