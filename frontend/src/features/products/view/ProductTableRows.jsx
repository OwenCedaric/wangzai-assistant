import { ProductMaterialTags } from '../../../entities/order/orderSourceLinks.jsx';
import { SourceLinkDropdownField } from '../../../entities/order/orderSourceLinkFields.jsx';
import { getProductFeeBreakdown, getProductSelectionKey } from '../../../entities/product/productWriteHelpers.jsx';
import { canResolveProductOzonOperation } from '../../../entities/product/productViewRuntime.jsx';
import { ProductListImageThumb } from '../ui/ProductListImageThumb.jsx';
import {
  isRendererTreeTelemetryEnabled,
  markRendererTreeRender,
} from '../../../app/performance/rendererTreeTelemetry.js';
import React from 'react';
import { scheduleProductRenderTask } from './progressiveProductRender.js';

const PRODUCT_STOCK_FACET_STATUS_ALIASES = Object.freeze({
  pending: 'pending',
  returned: 'returned',
  returnedempty: 'returned_empty',
  returned_empty: 'returned_empty',
  unavailable: 'unavailable',
  notreturned: 'not_returned',
  not_returned: 'not_returned',
  contractinvalid: 'contract_invalid',
  contract_invalid: 'contract_invalid',
  failed: 'failed',
  notapplicable: 'not_applicable',
  not_applicable: 'not_applicable',
  staleprevious: 'stale_previous',
  stale_previous: 'stale_previous',
});

const PRODUCT_STOCK_STALE_VALUE_STATUSES = new Set(['not_returned', 'failed', 'contract_invalid', 'stale_previous']);

function normalizeProductStockFacetStatus(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!normalized) return '';
  return PRODUCT_STOCK_FACET_STATUS_ALIASES[normalized] || 'contract_invalid';
}

function getProductStockFacetObservation(product = {}) {
  const observations =
    product.facetObservations ||
    product.facet_observations ||
    product.raw?.facetObservations ||
    product.raw?.facet_observations ||
    {};
  const observation =
    product.stockFacetObservation ||
    product.stock_facet_observation ||
    observations.stocks ||
    observations.stock ||
    null;
  return observation && typeof observation === 'object' && !Array.isArray(observation) ? observation : null;
}

function getProductStockFacetStatus(product = {}, observation = getProductStockFacetObservation(product)) {
  return normalizeProductStockFacetStatus(
    observation?.status ??
      product.stockFacetStatus ??
      product.stock_facet_status ??
      product.raw?.stockFacetStatus ??
      product.raw?.stock_facet_status
  );
}

function getProductStockCellValue(product = {}) {
  const value = product.stock ?? product.stockValue ?? product.raw?.stockValue ?? product.raw?.stock_value;
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value === 'boolean' || typeof value === 'object') return Number.NaN;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : Number.NaN;
}

function hasProductStockSyncEvidence(product = {}, observation = getProductStockFacetObservation(product)) {
  const coverage =
    product.hydrationCoverage ||
    product.hydration_coverage ||
    product.raw?.hydrationCoverage ||
    product.raw?.hydration_coverage ||
    {};
  return Boolean(
    observation?.observedAt ||
    observation?.observed_at ||
    product.stocksSyncedAt ||
    product.stocks_synced_at ||
    product.stockSyncedAt ||
    product.stock_synced_at ||
    coverage.stocks === true ||
    coverage.stock === true ||
    product.hydrationComplete === true ||
    product.hydration_complete === true
  );
}

export function getProductStockCellPresentation(product = {}) {
  const observation = getProductStockFacetObservation(product);
  const facetStatus = getProductStockFacetStatus(product, observation);
  const value = getProductStockCellValue(product);
  const hasNumericValue = Number.isFinite(value);

  if (facetStatus === 'returned' || !facetStatus) {
    if (hasNumericValue) {
      return {
        value,
        display: value,
        state: value === 0 ? 'confirmed_zero' : 'returned',
        title: value === 0 ? 'Ozon 已明确返回 0 库存' : `Ozon 已返回库存 ${value}`,
      };
    }
    if (facetStatus === 'returned' || Number.isNaN(value)) {
      return {
        value: null,
        display: '数据异常',
        state: 'contract_invalid',
        title:
          facetStatus === 'returned'
            ? 'Ozon 库存分面标记已返回，但没有有效的非负库存数量'
            : 'Ozon 库存值不是有效的非负数量',
      };
    }
    return hasProductStockSyncEvidence(product, observation)
      ? {
          value: null,
          display: '未返回',
          state: 'not_returned',
          title: '库存同步已经执行，但没有可用的 Ozon 库存事实',
        }
      : { value: null, display: '待同步', state: 'awaiting', title: '尚未获得 Ozon 库存回读证据' };
  }

  if (facetStatus === 'pending') {
    return hasNumericValue
      ? {
          value,
          display: `${value}（上次）`,
          state: 'pending_previous',
          title: 'Ozon 库存正在同步，当前显示上次成功同步的库存',
        }
      : { value: null, display: '同步中', state: 'pending', title: 'Ozon 库存正在同步' };
  }

  if (PRODUCT_STOCK_STALE_VALUE_STATUSES.has(facetStatus) && hasNumericValue) {
    return {
      value,
      display: `${value}（上次）`,
      state: 'stale_previous',
      title: 'Ozon 本次库存回读未成功，当前显示上次成功同步的库存',
    };
  }

  switch (facetStatus) {
    case 'returned_empty':
      return {
        value: null,
        display: '无库存明细',
        state: 'returned_empty',
        title: 'Ozon 库存回读已完成，但没有返回可计算数量的库存明细',
      };
    case 'unavailable':
      return {
        value: null,
        display: '不可用',
        state: 'unavailable',
        title: 'Ozon 库存接口已完成，但当前商品没有可用库存字段',
      };
    case 'not_returned':
      return {
        value: null,
        display: '未返回',
        state: 'not_returned',
        title: 'Ozon 库存接口未返回该商品',
      };
    case 'contract_invalid':
      return {
        value: null,
        display: '数据异常',
        state: 'contract_invalid',
        title: 'Ozon 库存返回结构不符合当前接口契约',
      };
    case 'failed':
      return { value: null, display: '同步失败', state: 'failed', title: 'Ozon 库存同步失败，等待重试' };
    case 'not_applicable':
      return { value: null, display: '不适用', state: 'not_applicable', title: '该商品不适用当前库存接口' };
    case 'stale_previous':
      return {
        value: null,
        display: '旧值缺失',
        state: 'stale_previous',
        title: 'Ozon 本次库存回读未成功，且没有可显示的上次库存',
      };
    default:
      return {
        value: null,
        display: '数据异常',
        state: 'contract_invalid',
        title: 'Ozon 库存分面返回了未知状态',
      };
  }
}

function isProductLowStock(stockPresentation = {}) {
  return typeof stockPresentation.value === 'number' && stockPresentation.value <= 40;
}

const ProductTableRow = React.memo(function ProductTableRow({
  product,
  staged = false,
  selected,
  productSourceLink,
  productSourceRecord,
  productSourceSlot,
  productArchiveOperationKey,
  productArchiveOperationPending,
  savingProductId,
  canReadOzon,
  toggleProductSelection,
  selectProductSourceSlot,
  updateProductSourceLink,
  saveProductSourceLink,
  handleEditProduct,
  handleProductArchiveAction,
  handleOpenOzonProductPage,
}) {
  const productWritePending = Boolean(product.optimisticWritePending);
  const productStockCell = getProductStockCellPresentation(product);
  const productOzonOperationDisabled =
    productArchiveOperationPending ||
    productWritePending ||
    Boolean(savingProductId) ||
    !canReadOzon ||
    !canResolveProductOzonOperation(product);
  return (
    <tr
      className="product-native-row"
      data-product-row="true"
      data-product-row-stage={staged ? 'preparing' : 'visible'}
      hidden={staged}
      aria-hidden={staged ? 'true' : undefined}
    >
      <td className="product-native-cell product-native-select-cell">
        <input
          type="checkbox"
          className="product-native-checkbox"
          aria-label={`选择 ${product.name || product.sku || '商品'}`}
          checked={selected}
          onChange={() => toggleProductSelection(product)}
          disabled={Boolean(savingProductId) || product.localMirror}
        />
      </td>
      <td className="product-native-cell product-name-cell">
        <div className="product-name-inline">
          <ProductListImageThumb product={product} />
          <div className="product-name-content">
            <button
              type="button"
              className="product-title-text ozon-product-title-button"
              title={`${product.name}｜打开 Ozon 商品页面`}
              onClick={() => handleOpenOzonProductPage?.(product)}
            >
              {product.name}
            </button>
            <div
              className="product-source-link-row compact-source-link-row"
              onClick={(event) => event.stopPropagation()}
            >
              <SourceLinkDropdownField
                className="product-source-list-input compact-source-link-input"
                placeholder="粘贴货源链接"
                value={productSourceLink}
                record={productSourceRecord}
                selectedIndex={productSourceSlot}
                onSelectSlot={(index) => selectProductSourceSlot(product, index)}
                onChange={(value, slotIndex, sourceEntry) =>
                  updateProductSourceLink(product, value, slotIndex, sourceEntry)
                }
              />
              <button
                type="button"
                className="product-native-button product-source-list-save compact-source-save-button tone-primary"
                onClick={(event) => {
                  event.stopPropagation();
                  saveProductSourceLink(product);
                }}
                aria-label="保存货源"
                title="保存货源"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      </td>
      <td className="product-native-cell product-offer-cell">
        <div className="product-offer-content">
          <span className="product-nowrap-cell product-offer-text" title={product.sku}>
            {product.sku}
          </span>
          <ProductMaterialTags product={product} />
        </div>
      </td>
      <td className="product-native-cell">
        <span className="product-nowrap-cell" title={product.category}>
          {product.category}
        </span>
      </td>
      <td className="product-native-cell">
        <span className="product-nowrap-cell" title={product.shop}>
          {product.shop}
        </span>
      </td>
      <td className="product-native-cell product-native-cell-right">{product.price}</td>
      <td className="product-native-cell product-native-cell-right">
        <strong
          className={`product-stock-value${isProductLowStock(productStockCell) ? ' low-stock' : ''}`}
          data-stock-state={productStockCell.state}
          title={productStockCell.title}
        >
          {productStockCell.display}
        </strong>
      </td>
      <td className="product-native-cell">
        <div className="product-fee-block">
          {getProductFeeBreakdown(product).map((item) => (
            <span key={item.label} className={`product-fee-row${item.total ? ' product-fee-total' : ''}`}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </span>
          ))}
        </div>
      </td>
      <td className="product-native-cell product-native-cell-right">{product.estimatedProfit}</td>
      <td className="product-native-cell product-native-cell-right">{product.weight ? `${product.weight} kg` : '-'}</td>
      <td className="product-native-cell">
        <div className="product-status-tags">
          <span className={`product-status-chip tone-${product.tone || 'default'}`}>{product.status}</span>
          {productWritePending ? <span className="product-status-chip tone-warning">待回读</span> : null}
        </div>
      </td>
      <td className="product-native-cell product-native-cell-center">
        <div className="product-row-actions">
          <button
            type="button"
            className="product-native-button tone-primary"
            disabled={productOzonOperationDisabled}
            onClick={() => handleEditProduct(product)}
          >
            编辑
          </button>
          <button
            type="button"
            className="product-native-button tone-success"
            disabled={productOzonOperationDisabled}
            onClick={() => handleProductArchiveAction(product, 'unarchive')}
          >
            {productArchiveOperationPending || productWritePending ? '处理中' : '上架'}
          </button>
          <button
            type="button"
            className="product-native-button tone-error"
            disabled={productOzonOperationDisabled}
            onClick={() => handleProductArchiveAction(product, 'archive')}
          >
            {productArchiveOperationPending || productWritePending ? '处理中' : '下架'}
          </button>
        </div>
      </td>
    </tr>
  );
});

const PRODUCT_INITIAL_ROW_RENDER_COUNT = 1;
const PRODUCT_ROW_RENDER_BATCH_SIZE = 19;

export function ProductTableRows({
  products,
  renderEnabled = true,
  selectedProductKeys,
  toggleProductSelection,
  savingProductId,
  getProductSourceLinkValue,
  getProductSourceRecord,
  getProductSourceSelectedSlot,
  selectProductSourceSlot,
  updateProductSourceLink,
  saveProductSourceLink,
  getProductArchiveOperationKey,
  pendingProductArchiveKeys,
  canReadOzon,
  handleEditProduct,
  handleProductArchiveAction,
  handleOpenOzonProductPage,
}) {
  const productSignature = products
    .map((product, index) => String(product?.productId || product?.sku || index))
    .join('\u0001');
  const initialVisibleCount =
    products.length <= 2 ? products.length : Math.min(products.length, PRODUCT_INITIAL_ROW_RENDER_COUNT);
  const [committedPage, setCommittedPage] = React.useState(() => ({
    signature: productSignature,
    rows: products,
  }));
  const [progress, setProgress] = React.useState(() => ({
    signature: productSignature,
    count: initialVisibleCount,
  }));
  const [stagingProgress, setStagingProgress] = React.useState(null);
  const productPageIsCommitted = committedPage.signature === productSignature;
  const committedRows = productPageIsCommitted ? products : committedPage.rows;
  const committedInitialVisibleCount =
    committedRows.length <= 2 ? committedRows.length : Math.min(committedRows.length, PRODUCT_INITIAL_ROW_RENDER_COUNT);
  const visibleCount =
    progress.signature === committedPage.signature
      ? Math.min(committedRows.length, progress.count)
      : committedInitialVisibleCount;

  React.useEffect(() => {
    if (!productPageIsCommitted) return;
    setCommittedPage((current) => (current.rows === products ? current : { ...current, rows: products }));
  }, [productPageIsCommitted, products]);

  React.useEffect(() => {
    if (productPageIsCommitted) {
      setStagingProgress((current) => (current ? null : current));
      return;
    }
    if (committedPage.rows.length === 0) {
      setCommittedPage({ signature: productSignature, rows: products });
      setProgress({ signature: productSignature, count: initialVisibleCount });
      setStagingProgress(null);
      return;
    }
    setStagingProgress((current) =>
      current?.signature === productSignature ? current : { signature: productSignature, count: initialVisibleCount }
    );
  }, [committedPage.rows.length, initialVisibleCount, productPageIsCommitted, productSignature, products]);

  React.useEffect(() => {
    if (!renderEnabled || progress.signature !== committedPage.signature || progress.count >= committedRows.length)
      return undefined;
    return scheduleProductRenderTask(() =>
      setProgress((current) => ({
        signature: committedPage.signature,
        count: Math.min(committedRows.length, current.count + PRODUCT_ROW_RENDER_BATCH_SIZE),
      }))
    );
  }, [committedPage.signature, committedRows.length, progress, renderEnabled]);

  React.useEffect(() => {
    if (!stagingProgress || stagingProgress.signature !== productSignature || !renderEnabled) return undefined;
    if (stagingProgress.count >= products.length) {
      setCommittedPage({ signature: productSignature, rows: products });
      setProgress({ signature: productSignature, count: products.length });
      setStagingProgress(null);
      return undefined;
    }
    return scheduleProductRenderTask(() =>
      setStagingProgress((current) => {
        if (!current || current.signature !== productSignature) return current;
        return {
          signature: productSignature,
          count: Math.min(products.length, current.count + PRODUCT_ROW_RENDER_BATCH_SIZE),
        };
      })
    );
  }, [productSignature, products, renderEnabled, stagingProgress]);

  const treeTelemetryEnabled = isRendererTreeTelemetryEnabled();
  const treeRenderStartedAt = treeTelemetryEnabled && typeof performance !== 'undefined' ? performance.now() : 0;
  const createRows = (rowsForRender, signature, staged = false) =>
    rowsForRender.map((product, index) => {
      const productArchiveOperationKey = getProductArchiveOperationKey(product);
      return (
        <ProductTableRow
          key={`${signature}:${product.productId || product.sku || index}`}
          product={product}
          staged={staged}
          selected={selectedProductKeys.has(getProductSelectionKey(product))}
          productSourceLink={getProductSourceLinkValue(product)}
          productSourceRecord={getProductSourceRecord(product)}
          productSourceSlot={getProductSourceSelectedSlot(product)}
          productArchiveOperationKey={productArchiveOperationKey}
          productArchiveOperationPending={pendingProductArchiveKeys.has(productArchiveOperationKey)}
          savingProductId={savingProductId}
          canReadOzon={canReadOzon}
          toggleProductSelection={toggleProductSelection}
          selectProductSourceSlot={selectProductSourceSlot}
          updateProductSourceLink={updateProductSourceLink}
          saveProductSourceLink={saveProductSourceLink}
          handleEditProduct={handleEditProduct}
          handleProductArchiveAction={handleProductArchiveAction}
          handleOpenOzonProductPage={handleOpenOzonProductPage}
        />
      );
    });
  const rows = [
    ...createRows(committedRows.slice(0, visibleCount), committedPage.signature),
    ...createRows(
      stagingProgress?.signature === productSignature ? products.slice(0, stagingProgress.count) : [],
      productSignature,
      true
    ),
  ];
  if (treeTelemetryEnabled) markRendererTreeRender('products:table-rows', treeRenderStartedAt);
  return rows;
}
