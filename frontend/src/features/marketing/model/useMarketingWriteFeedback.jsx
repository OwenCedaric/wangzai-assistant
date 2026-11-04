import {
  getMarketingProductIssue,
  normalizeMarketingPercent,
  parseMarketingNumber,
} from '../../../entities/order/orderShopScope.jsx';
import {
  getMarketingActivityDisplaySource,
  getMarketingActivityDisplayTitle,
} from '../../../entities/marketing/marketingActivityPresentation.jsx';
import {
  getFriendlyOzonReadError,
  getMarketingProductNumericId,
  requestOzonMarketingActivateProducts,
  requestOzonMarketingDeactivateProducts,
} from '../../orders/purchase/lib/purchaseMarketingApi.jsx';

export function useMarketingWriteFeedback({
  selectedProducts,
  hasLiveActivityData,
  selectedActivity,
  setReadNoticeTone,
  setReadNotice,
  isShowingCachedMarketingData,
  isReadingActivities,
  discountPercent,
  applyDiscountPercent,
  marketingWriteDialogOpenRef,
  setMarketingWriteDialog,
  marketingWriteDialog,
  isMarketingWriting,
  setIsMarketingWriting,
  selectedShop,
  productPoolCacheRef,
  setSelectedProductIds,
  currentPageProductIds,
  isCurrentPageSelected,
  allProductIds,
  isAllProductsSelected,
  setSelectedActivityId,
  setSelectedSourceType,
  setProductPage,
  setIsReadingProducts,
  productReadSeqRef,
  loadActivityProductPool,
  productScope,
  setProductPool,
  setMarketingBackgroundNotice,
  marketingScopeGenerationRef,
} = {}) {
  const getMarketingWritableSelection = (action) => {
    if (action === 'cancel') {
      return selectedProducts.filter(
        (product) => product.status === '已添加' && getMarketingProductNumericId(product) !== null
      );
    }
    if (action === 'ratio') {
      return selectedProducts.filter(
        (product) => getMarketingProductNumericId(product) !== null && parseMarketingNumber(product.price) !== null
      );
    }
    return selectedProducts.filter(
      (product) => !getMarketingProductIssue(product) && getMarketingProductNumericId(product) !== null
    );
  };
  const getMarketingEmptySelectionMessage = (action) => {
    if (selectedProducts.length === 0) return '请先勾选商品。';
    if (action === 'cancel') return '请先选择已添加、可取消活动的商品。';
    if (action === 'ratio') return '选中商品缺少售价或商品 ID，无法按比例计算活动价。';
    return '选中商品暂无可提交项，请先处理缺售价或库存不足的商品。';
  };
  const openMarketingWriteDialog = (action) => {
    if (!hasLiveActivityData || !selectedActivity.id) {
      setReadNoticeTone('error');
      setReadNotice('请先读取并选择活动。');
      return;
    }
    if (isShowingCachedMarketingData || isReadingActivities) {
      setReadNoticeTone('info');
      setReadNotice('正在刷新最新活动，完成后再同步到 Ozon。');
      return;
    }

    const products = getMarketingWritableSelection(action);
    if (products.length === 0) {
      setReadNoticeTone('error');
      setReadNotice(getMarketingEmptySelectionMessage(action));
      return;
    }

    const nextPercent = action === 'cancel' ? normalizeMarketingPercent(discountPercent) : applyDiscountPercent();
    const config = {
      ratio: {
        title: '确认修改比例',
        confirmLabel: '确认写入',
        tone: 'warning',
        actionText: `按 ${nextPercent}% 修改活动价`,
        description: '确认后会把选中商品的新活动价写入 Ozon 后台。',
      },
      submit: {
        title: '确认提交修改',
        confirmLabel: '确认提交',
        tone: 'primary',
        actionText: '提交选中商品到当前活动',
        description: '确认后会把选中商品提交到 Ozon 当前活动。',
      },
      cancel: {
        title: '确认取消活动',
        confirmLabel: '确认取消',
        tone: 'error',
        actionText: '从当前活动移出选中商品',
        description: '确认后会把选中商品从 Ozon 当前活动移出。',
      },
    }[action];

    marketingWriteDialogOpenRef.current = true;
    setMarketingWriteDialog({
      action,
      percent: nextPercent,
      productCount: products.length,
      activityTitle: getMarketingActivityDisplayTitle(selectedActivity),
      source: getMarketingActivityDisplaySource(selectedActivity),
      ...config,
    });
  };
  const handleConfirmMarketingWrite = async () => {
    if (!marketingWriteDialog || isMarketingWriting) return;
    const action = marketingWriteDialog.action;
    const products = getMarketingWritableSelection(action);
    if (products.length === 0) {
      setReadNoticeTone('error');
      setReadNotice(getMarketingEmptySelectionMessage(action));
      marketingWriteDialogOpenRef.current = false;
      setMarketingWriteDialog(null);
      return;
    }

    const writeScopeGeneration = marketingScopeGenerationRef?.current ?? 0;
    setIsMarketingWriting(true);
    try {
      const result =
        action === 'cancel'
          ? await requestOzonMarketingDeactivateProducts(selectedShop, selectedActivity, products, { confirmed: true })
          : await requestOzonMarketingActivateProducts(
              selectedShop,
              selectedActivity,
              products,
              marketingWriteDialog.percent,
              {
                confirmed: true,
              }
            );
      if ((marketingScopeGenerationRef?.current ?? 0) !== writeScopeGeneration) return;
      const writeStatus = result?.writeStatus || result?.localApiWrite?.writeStatus || '';
      const readBackStatus = result?.readBack?.status || result?.localApiWrite?.readBack?.status || '';
      const schedulerStatus = result?.schedulerResult?.status || result?.status || '';
      const writeAccepted =
        ['submitted_waiting_readback', 'readback_merged', 'dry_run_recorded'].includes(writeStatus) ||
        ['success', 'partial', 'accepted', 'running'].includes(schedulerStatus);
      if (schedulerStatus && !writeAccepted) {
        throw new Error(
          result?.schedulerResult?.error?.message || result?.error?.message || `Ozon 写入返回异常：${schedulerStatus}`
        );
      }
      const readbackMerged = writeStatus === 'readback_merged' || readBackStatus === 'merged';
      const submittedMessage =
        result?.message ||
        result?.localApiWrite?.message ||
        (action === 'cancel'
          ? '营销取消已提交 Ozon，等待活动商品池回读确认；SQLite 合并完成前不算完成。'
          : '营销修改已提交 Ozon，等待活动商品池回读确认；SQLite 合并完成前不算完成。');
      setReadNoticeTone(readbackMerged ? 'success' : 'info');
      setReadNotice(readbackMerged ? '营销写入回读成功，SQLite 已合并。' : submittedMessage);
      marketingWriteDialogOpenRef.current = false;
      setMarketingWriteDialog(null);
      productPoolCacheRef.current.clear();
      await refreshCurrentProductPool();
      if ((marketingScopeGenerationRef?.current ?? 0) !== writeScopeGeneration) return;
      setSelectedProductIds([]);
      setReadNoticeTone(readbackMerged ? 'success' : 'info');
      setReadNotice(
        readbackMerged
          ? action === 'cancel'
            ? '取消活动回读成功，SQLite 已合并。'
            : '活动修改回读成功，SQLite 已合并。'
          : action === 'cancel'
            ? '取消活动已提交 Ozon，正在等待活动商品池回读确认；回读成功并合并 SQLite 前不显示完成。'
            : '活动修改已提交 Ozon，正在等待活动商品池回读确认；回读成功并合并 SQLite 前不显示完成。'
      );
    } catch (error) {
      if ((marketingScopeGenerationRef?.current ?? 0) !== writeScopeGeneration) return;
      setReadNoticeTone('error');
      setReadNotice(getFriendlyOzonReadError(error));
    } finally {
      if ((marketingScopeGenerationRef?.current ?? 0) === writeScopeGeneration) setIsMarketingWriting(false);
    }
  };
  const handleSubmitMarketingChanges = () => {
    openMarketingWriteDialog('submit');
  };
  const handleCancelMarketingActivity = () => {
    openMarketingWriteDialog('cancel');
  };
  const selectCurrentPage = () => {
    const pageIdSet = new Set(currentPageProductIds);
    setSelectedProductIds((current) =>
      isCurrentPageSelected
        ? current.filter((productId) => !pageIdSet.has(productId))
        : Array.from(new Set([...current, ...currentPageProductIds]))
    );
  };
  const selectAllProducts = () => {
    const allIdSet = new Set(allProductIds);
    setSelectedProductIds((current) =>
      isAllProductsSelected
        ? current.filter((productId) => !allIdSet.has(productId))
        : Array.from(new Set([...current, ...allProductIds]))
    );
  };
  const handleSelectActivity = async (activity) => {
    setSelectedActivityId(activity.id);
    setSelectedSourceType(activity.sourceType || 'official');
    setProductPage(1);
    if (!hasLiveActivityData) return;

    setIsReadingProducts(true);
    setReadNoticeTone('info');
    setReadNotice('正在读取当前活动商品池。');
    const productReadSeq = productReadSeqRef.current + 1;
    productReadSeqRef.current = productReadSeq;
    try {
      const cachedResult = await loadActivityProductPool(activity, selectedShop, productScope, {
        allowRemote: true,
        forceRefresh: true,
        canApply: () => productReadSeqRef.current === productReadSeq,
      });
      if (productReadSeqRef.current !== productReadSeq) return;
      if (!cachedResult) {
        setProductPool([]);
        setSelectedProductIds([]);
        setReadNoticeTone('info');
        setReadNotice('当前活动暂未返回商品池，已发起 Ozon 读取，稍后会自动刷新。');
        return;
      }
      setReadNoticeTone(cachedResult.pending ? 'info' : 'success');
      setReadNotice(cachedResult.pending ? '已先显示当前活动商品池，Ozon 后台正在复核。' : '活动商品已更新。');
    } catch (error) {
      if (productReadSeqRef.current !== productReadSeq) return;
      setMarketingBackgroundNotice('error', getFriendlyOzonReadError(error));
    } finally {
      if (productReadSeqRef.current === productReadSeq) setIsReadingProducts(false);
    }
  };
  const refreshCurrentProductPool = async () => {
    if (!hasLiveActivityData || !selectedActivity.id) return;
    setIsReadingProducts(true);
    setReadNotice('');
    const productReadSeq = productReadSeqRef.current + 1;
    productReadSeqRef.current = productReadSeq;
    try {
      const result = await loadActivityProductPool(selectedActivity, selectedShop, productScope, {
        force: true,
        canApply: () => productReadSeqRef.current === productReadSeq,
      });
      if (productReadSeqRef.current !== productReadSeq) return;
      setReadNoticeTone(result?.pending ? 'info' : 'success');
      setReadNotice(result?.pending ? '已显示本地商品池，Ozon 后台正在复核。' : '当前商品池已更新。');
    } catch (error) {
      if (productReadSeqRef.current !== productReadSeq) return;
      setMarketingBackgroundNotice('error', getFriendlyOzonReadError(error));
    } finally {
      if (productReadSeqRef.current === productReadSeq) setIsReadingProducts(false);
    }
  };

  return {
    openMarketingWriteDialog,
    handleConfirmMarketingWrite,
    handleSubmitMarketingChanges,
    handleCancelMarketingActivity,
    selectCurrentPage,
    selectAllProducts,
    handleSelectActivity,
    refreshCurrentProductPool,
  };
}
