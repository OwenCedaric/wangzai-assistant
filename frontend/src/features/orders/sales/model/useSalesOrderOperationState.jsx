import {
  addSalesOrderSplitPackageValue,
  buildSalesOperationNoticeMessage,
  buildSalesOperationPartialNoticeMessage,
  createInitialSalesOrderSplitPackages,
  formatSalesOperationFailure,
  formatSalesOrderSplitPlan,
  getSalesOperationNoticeSeverity,
  getSalesOrderSplitQuantity,
  normalizeSalesOrderSplitPackages,
  removeSalesOrderSplitPackageValue,
  requestOzonFbsCancelReasons,
  updateSalesOrderSplitPackageQuantity,
  validateSalesOrderSplitPackages,
} from '../../../../entities/marketing/marketingOrderFields.jsx';
import {
  submitSalesOrderCancel,
  submitSalesOrderShip,
  submitSalesOrderSplit,
} from '../../../../entities/marketing/marketingSnapshotRuntime.jsx';
import {
  canUseOzonShop,
  getOzonShopForOrder,
  getOzonStableShopSourceKey,
} from '../../../../entities/order/orderShopScope.jsx';
import { getSalesOrderStatusTags } from '../../../../entities/order/orderSourceLinkFields.jsx';
import { getOzonApiErrorMessage } from '../../../../entities/product/productOzonApi.jsx';
import { getSplitOrderLockReason, isSplitParentBusinessLocked } from '../../../../services/orderSplitRelationRules';
import React from 'react';

export function formatSalesOrderPartialErrorItem(item = {}) {
  const message = String(item.error?.message || item.message || '').trim();
  if (/被\s*Ozon\s*封禁/iu.test(message)) return message;
  const statusText = message.match(/HTTP\s+\d+/iu)?.[0] || '请求失败';
  return `${item.label || '订单接口'} ${statusText}`;
}

export function useSalesOrderOperationState({
  setSalesOperation,
  salesOperation,
  shops,
  activeShop,
  setSalesNotice,
  handleRefreshSalesOrders,
  detailOrder,
  fulfillment,
  status,
  orderSync,
} = {}) {
  const openSalesOperation = React.useCallback(
    (type, order) => {
      const splitPackages = type === 'split' ? createInitialSalesOrderSplitPackages(order) : [];
      setSalesOperation({
        open: true,
        type,
        order,
        orders: [],
        cancelReasonId: '',
        cancelReasonMessage: '',
        cancelReasons: [],
        cancelReasonsLoading: type === 'cancel',
        cancelReasonsError: '',
        splitPlan: formatSalesOrderSplitPlan(splitPackages),
        splitPackages,
        loading: false,
        error: '',
      });
    },
    [setSalesOperation]
  );
  const openSalesBatchOperation = React.useCallback(
    (type, orders) => {
      const batchOrders = Array.isArray(orders) ? orders.filter(Boolean) : [];
      if (!batchOrders.length) return;
      setSalesOperation({
        open: true,
        type,
        order: batchOrders[0],
        orders: batchOrders,
        cancelReasonId: '',
        cancelReasonMessage: '',
        cancelReasons: [],
        cancelReasonsLoading: type === 'batchCancel',
        cancelReasonsError: '',
        splitPlan: '',
        splitPackages: [],
        loading: false,
        error: '',
      });
    },
    [setSalesOperation]
  );
  const closeSalesOperation = React.useCallback(() => {
    setSalesOperation((current) => (current.loading ? current : { ...current, open: false, error: '' }));
  }, [setSalesOperation]);
  const updateSalesCancelReason = React.useCallback(
    (event) => {
      const reasonId = String(event.target.value);
      setSalesOperation((current) => {
        const reason = current.cancelReasons.find((item) => item.id === reasonId);
        return {
          ...current,
          cancelReasonId: reasonId,
          cancelReasonMessage: reason?.rawLabel || reason?.label || '',
          error: '',
        };
      });
    },
    [setSalesOperation]
  );
  const updateSalesSplitPackageQuantity = React.useCallback(
    (index, value) => {
      setSalesOperation((current) => {
        if (current.type !== 'split') return current;
        const splitPackages = updateSalesOrderSplitPackageQuantity(current.order, current.splitPackages, index, value);
        return {
          ...current,
          splitPackages,
          splitPlan: formatSalesOrderSplitPlan(splitPackages),
          error: '',
        };
      });
    },
    [setSalesOperation]
  );
  const addSalesSplitPackage = React.useCallback(() => {
    setSalesOperation((current) => {
      if (current.type !== 'split') return current;
      const splitPackages = addSalesOrderSplitPackageValue(current.order, current.splitPackages);
      return {
        ...current,
        splitPackages,
        splitPlan: formatSalesOrderSplitPlan(splitPackages),
        error: splitPackages.length === current.splitPackages.length ? '没有可转出的数量，无法继续新增货件。' : '',
      };
    });
  }, [setSalesOperation]);
  const removeSalesSplitPackage = React.useCallback(
    (index) => {
      setSalesOperation((current) => {
        if (current.type !== 'split') return current;
        const splitPackages = removeSalesOrderSplitPackageValue(current.order, current.splitPackages, index);
        return {
          ...current,
          splitPackages,
          splitPlan: formatSalesOrderSplitPlan(splitPackages),
          error: '',
        };
      });
    },
    [setSalesOperation]
  );
  const operationOrders = React.useMemo(
    () =>
      Array.isArray(salesOperation.orders) && salesOperation.orders.length
        ? salesOperation.orders
        : salesOperation.order
          ? [salesOperation.order]
          : [],
    [salesOperation.order, salesOperation.orders]
  );
  const isCancelSalesOperation = salesOperation.type === 'cancel' || salesOperation.type === 'batchCancel';
  const isSplitSalesOperation = salesOperation.type === 'split';
  const splitOperationOrder = isSplitSalesOperation ? (operationOrders[0] ?? salesOperation.order ?? null) : null;
  const splitPackages = React.useMemo(
    () =>
      splitOperationOrder ? normalizeSalesOrderSplitPackages(splitOperationOrder, salesOperation.splitPackages) : [],
    [salesOperation.splitPackages, splitOperationOrder]
  );
  const splitValidation = React.useMemo(
    () =>
      splitOperationOrder
        ? validateSalesOrderSplitPackages(splitOperationOrder, splitPackages)
        : { valid: false, reason: '没有可拆解的订单。', total: 0, parts: [], sum: 0 },
    [splitOperationOrder, splitPackages]
  );
  const executeSalesOperation = React.useCallback(async () => {
    const operationOrders =
      Array.isArray(salesOperation.orders) && salesOperation.orders.length
        ? salesOperation.orders
        : salesOperation.order
          ? [salesOperation.order]
          : [];
    if (!operationOrders.length) return;

    setSalesOperation((current) => ({ ...current, loading: true, error: '' }));
    try {
      let successMessage = '';
      let noticeSeverity = 'success';
      if (salesOperation.type === 'cancel' || salesOperation.type === 'batchCancel') {
        const failures = [];
        const successResults = [];
        for (const order of operationOrders) {
          try {
            const operationShop = getOzonShopForOrder(order, shops, activeShop);
            if (!canUseOzonShop(operationShop)) throw new Error('订单缺少可用 Ozon 店铺配置。');
            const result = await submitSalesOrderCancel(operationShop, order, {
              cancelReasonId: salesOperation.cancelReasonId,
              cancelReasonMessage: salesOperation.cancelReasonMessage,
            });
            successResults.push(result);
          } catch (error) {
            failures.push(formatSalesOperationFailure(order, error));
          }
        }
        if (failures.length) {
          if (!successResults.length) {
            const sample = failures.slice(0, 3).join('；');
            const more = failures.length > 3 ? `；另有 ${failures.length - 3} 个失败` : '';
            throw new Error(`取消订单结果：无订单提交成功，失败 ${failures.length} 个。${sample}${more}`);
          }
          successMessage = buildSalesOperationPartialNoticeMessage('取消订单', successResults, failures);
          noticeSeverity = 'warning';
        } else {
          successMessage = buildSalesOperationNoticeMessage('取消订单', successResults);
          noticeSeverity = getSalesOperationNoticeSeverity(successResults);
        }
      } else if (salesOperation.type === 'ship' || salesOperation.type === 'batchShip') {
        const failures = [];
        const successResults = [];
        for (const order of operationOrders) {
          try {
            const operationShop = getOzonShopForOrder(order, shops, activeShop);
            if (!canUseOzonShop(operationShop)) throw new Error('订单缺少可用 Ozon 店铺配置。');
            const result = await submitSalesOrderShip(operationShop, order);
            successResults.push(result);
          } catch (error) {
            failures.push(formatSalesOperationFailure(order, error));
          }
        }
        if (failures.length) {
          if (!successResults.length) {
            const sample = failures.slice(0, 3).join('；');
            const more = failures.length > 3 ? `；另有 ${failures.length - 3} 个失败` : '';
            throw new Error(`确认发货结果：无订单提交成功，失败 ${failures.length} 个。${sample}${more}`);
          }
          successMessage = buildSalesOperationPartialNoticeMessage('确认发货', successResults, failures);
          noticeSeverity = 'warning';
        } else {
          successMessage = buildSalesOperationNoticeMessage('确认发货', successResults);
          noticeSeverity = getSalesOperationNoticeSeverity(successResults);
        }
      } else if (salesOperation.type === 'split') {
        const order = operationOrders[0];
        const splitValidation = validateSalesOrderSplitPackages(order, salesOperation.splitPackages);
        if (!splitValidation.valid) throw new Error(splitValidation.reason || '拆解数量不正确。');
        const operationShop = getOzonShopForOrder(order, shops, activeShop);
        if (!canUseOzonShop(operationShop)) throw new Error('订单缺少可用 Ozon 店铺配置。');
        const result = await submitSalesOrderSplit(operationShop, order, splitValidation.parts);
        if (result?.simulated) {
          successMessage = result.message || '测试单已模拟拆解成功。';
          noticeSeverity = 'info';
        } else {
          successMessage = buildSalesOperationNoticeMessage('拆解订单', [result]);
          noticeSeverity = getSalesOperationNoticeSeverity([result]);
        }
      }

      const actionText =
        salesOperation.type === 'cancel' || salesOperation.type === 'batchCancel'
          ? '取消订单'
          : salesOperation.type === 'ship' || salesOperation.type === 'batchShip'
            ? '确认发货'
            : '拆解订单';
      setSalesNotice({
        open: true,
        severity: noticeSeverity,
        message: successMessage || `${actionText}已提交 Ozon，等待回读确认。`,
      });
      setSalesOperation((current) => ({ ...current, open: false, loading: false, error: '' }));
      handleRefreshSalesOrders();
    } catch (error) {
      setSalesOperation((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [activeShop, handleRefreshSalesOrders, salesOperation, shops, setSalesNotice, setSalesOperation]);
  const operationMeta = {
    cancel: {
      title: '取消订单',
      confirmText: '确认取消',
      body: '该操作会真实提交到 Ozon，订单可能被取消。',
      color: 'error',
    },
    ship: {
      title: '确认发货',
      confirmText: '确认发货',
      body: '该操作会真实提交到 Ozon，并修改发货状态。',
      color: 'primary',
    },
    split: {
      title: '拆解订单',
      confirmText: '确认提交拆单',
      body: '该操作会真实提交到 Ozon，把当前发货单拆成多个发货单。',
      color: 'warning',
    },
    batchCancel: {
      title: '批量取消订单',
      confirmText: '确认批量取消',
      body: '该操作会把已选可取消订单逐个真实提交到 Ozon，订单可能被取消。',
      color: 'error',
    },
    batchShip: {
      title: '批量确认发货',
      confirmText: '确认批量发货',
      body: '该操作会把已选可发货订单逐个真实提交到 Ozon，并修改发货状态。',
      color: 'primary',
    },
  }[salesOperation.type] ?? {
    title: '订单操作',
    confirmText: '确认',
    body: '该操作会真实提交到 Ozon。',
    color: 'primary',
  };
  const detailIsFbo = String(detailOrder?.fulfillment || '').toUpperCase() === 'FBO';
  const detailClosed = ['已经发货', '成功订单', '关闭订单', '售后订单'].includes(detailOrder?.status);
  const detailStatusTags = getSalesOrderStatusTags(detailOrder);
  const detailSplitLocked = isSplitParentBusinessLocked(detailOrder);
  const detailSplitLockReason = detailSplitLocked ? getSplitOrderLockReason(detailOrder) : '';
  const canCancelDetailOrder = Boolean(detailOrder && !detailIsFbo && !detailClosed && !detailSplitLocked);
  const canShipDetailOrder = Boolean(
    detailOrder && !detailIsFbo && detailStatusTags.includes('等待备货') && !detailSplitLocked
  );
  const canSplitDetailOrder = Boolean(canShipDetailOrder && getSalesOrderSplitQuantity(detailOrder) > 1);
  const cancelReasonShop = React.useMemo(() => {
    if (!salesOperation.open || !isCancelSalesOperation || !operationOrders.length) return null;
    return getOzonShopForOrder(operationOrders[0], shops, activeShop);
  }, [activeShop, isCancelSalesOperation, operationOrders, salesOperation.open, shops]);
  const cancelReasonShopKey = cancelReasonShop ? getOzonStableShopSourceKey(cancelReasonShop) : '';
  React.useEffect(() => {
    if (!salesOperation.open || !isCancelSalesOperation) return undefined;
    if (!canUseOzonShop(cancelReasonShop)) {
      setSalesOperation((current) => ({
        ...current,
        cancelReasonsLoading: false,
        cancelReasonsError: '订单缺少可用 Ozon 店铺配置。',
      }));
      return undefined;
    }

    let cancelled = false;
    setSalesOperation((current) => ({
      ...current,
      cancelReasonsLoading: true,
      cancelReasonsError: '',
      cancelReasons: [],
      cancelReasonId: '',
      cancelReasonMessage: '',
    }));

    requestOzonFbsCancelReasons(cancelReasonShop)
      .then((reasons) => {
        if (cancelled) return;
        const defaultReason = reasons[0];
        setSalesOperation((current) => ({
          ...current,
          cancelReasons: reasons,
          cancelReasonsLoading: false,
          cancelReasonsError: '',
          cancelReasonId: defaultReason?.id || '',
          cancelReasonMessage: defaultReason?.rawLabel || defaultReason?.label || '',
        }));
      })
      .catch((error) => {
        if (cancelled) return;
        setSalesOperation((current) => ({
          ...current,
          cancelReasons: [],
          cancelReasonsLoading: false,
          cancelReasonsError: `取消原因读取失败：${getOzonApiErrorMessage(error)}`,
          cancelReasonId: '',
          cancelReasonMessage: '',
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [cancelReasonShop, cancelReasonShopKey, isCancelSalesOperation, salesOperation.open, setSalesOperation]);
  const canSubmitSalesOperation =
    operationOrders.length > 0 &&
    operationOrders.every((order) => {
      const shopConfig = getOzonShopForOrder(order, shops, activeShop);
      return canUseOzonShop(shopConfig);
    }) &&
    (!isCancelSalesOperation ||
      (!salesOperation.cancelReasonsLoading &&
        !salesOperation.cancelReasonsError &&
        salesOperation.cancelReasons.length > 0 &&
        Boolean(salesOperation.cancelReasonId))) &&
    (!isSplitSalesOperation || splitValidation.valid);
  const salesOrderPartialErrorText = React.useMemo(() => {
    const errors = orderSync.data?.errors ?? [];
    if (!errors.length) return '';
    return errors.map(formatSalesOrderPartialErrorItem).join('；');
  }, [orderSync.data?.errors]);

  return {
    openSalesOperation,
    openSalesBatchOperation,
    closeSalesOperation,
    updateSalesCancelReason,
    updateSalesSplitPackageQuantity,
    addSalesSplitPackage,
    removeSalesSplitPackage,
    executeSalesOperation,
    operationMeta,
    detailSplitLocked,
    detailSplitLockReason,
    canCancelDetailOrder,
    canShipDetailOrder,
    canSplitDetailOrder,
    operationOrders,
    isSplitSalesOperation,
    splitOperationOrder,
    splitPackages,
    splitValidation,
    canSubmitSalesOperation,
    salesOrderPartialErrorText,
  };
}
