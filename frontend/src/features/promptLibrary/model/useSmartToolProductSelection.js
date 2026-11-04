import React from 'react';
import { filterLocalProductSearchRows, readLocalProductSearchRows } from '../services/smartToolProductSearchService.js';

export function useSmartToolProductSelection({ enabled = false, shops = [] } = {}) {
  const [products, setProducts] = React.useState([]);
  const [query, setQuery] = React.useState('');
  const [selectedProduct, setSelectedProduct] = React.useState(null);
  const [selectedSku, setSelectedSku] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(async () => {
    if (!shops.length) {
      setProducts([]);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const nextProducts = await readLocalProductSearchRows(shops);
      setProducts(nextProducts);
    } catch {
      setProducts([]);
      setError('本地商品快照读取失败，请先到商品列表同步后重试。');
    } finally {
      setLoading(false);
    }
  }, [shops]);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setSelectedProduct(null);
    setSelectedSku(null);
    setQuery('');
    setError('');
    if (!shops.length) return undefined;
    setLoading(true);
    readLocalProductSearchRows(shops)
      .then((nextProducts) => {
        if (!cancelled) setProducts(nextProducts);
      })
      .catch(() => {
        if (!cancelled) {
          setProducts([]);
          setError('本地商品快照读取失败，请先到商品列表同步后重试。');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, shops]);

  const filteredProducts = React.useMemo(() => filterLocalProductSearchRows(products, query), [products, query]);
  const visibleProducts = React.useMemo(() => filteredProducts.slice(0, 20), [filteredProducts]);

  const selectProduct = React.useCallback((product) => {
    setSelectedProduct(product);
    setSelectedSku(product?.skuOptions?.[0] || null);
  }, []);

  const selectSku = React.useCallback(
    (skuId) => {
      const nextSku = selectedProduct?.skuOptions?.find((item) => item.id === skuId) || null;
      setSelectedSku(nextSku);
    },
    [selectedProduct]
  );

  return {
    products,
    filteredProducts,
    visibleProducts,
    query,
    selectedProduct,
    selectedSku,
    loading,
    error,
    hasLocalProducts: products.length > 0,
    onQueryChange: setQuery,
    onSelectProduct: selectProduct,
    onSelectSku: selectSku,
    onRefresh: refresh,
  };
}
