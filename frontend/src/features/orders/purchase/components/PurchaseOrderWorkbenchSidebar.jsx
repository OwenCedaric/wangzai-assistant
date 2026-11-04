import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import PaidRounded from '@mui/icons-material/PaidRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import SyncRounded from '@mui/icons-material/SyncRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';

function display(value, fallback = '未返回') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function WorkbenchField({ label, value, wide = false, compact = false }) {
  return (
    <Box className={`purchase-order-workbench-field${wide ? ' is-wide' : ''}${compact ? ' is-compact' : ''}`}>
      <Typography component="dt">{label}</Typography>
      <Typography component="dd" title={display(value)}>{display(value)}</Typography>
    </Box>
  );
}

function WorkbenchSection({ title, children }) {
  return (
    <Box component="section" className="purchase-order-workbench-section">
      <Typography variant="overline">{title}</Typography>
      <Box component="dl" className="purchase-order-workbench-field-grid">
        {children}
      </Box>
    </Box>
  );
}

function MetricGrid({ items = [] }) {
  if (!items.length) return null;
  return (
    <Box className="purchase-order-workbench-profit-grid">
      {items.map((item, index) => (
        <Box
          key={`${item.label}-${index}`}
          className={`purchase-order-workbench-profit-item ${item.tone || ''}`.trim()}
          title={item.hint || undefined}
        >
          <Typography variant="caption">{item.label}</Typography>
          <Typography variant="subtitle2">{display(item.value, '待确认')}</Typography>
        </Box>
      ))}
    </Box>
  );
}

function DefaultOrderSidebar({
  presentation,
  operation = '',
  disabled = false,
  refreshDisabled = disabled,
  pendingSave = false,
  onReadPaymentInfo = () => {},
  onRefreshOrderStatus = () => {},
  onSavePurchaseInfo = () => {},
}) {
  const order = presentation.order || {};
  const source = presentation.source || {};
  const logistics = presentation.logistics || {};
  const profitItems = Array.isArray(presentation.profitItems) ? presentation.profitItems : [];
  return (
    <>
      <WorkbenchSection title="订单信息">
        <WorkbenchField label="销售订单号" value={order.orderNo} />
        <WorkbenchField label="Ozon 订单号" value={order.ozonOrderId} />
        <WorkbenchField label="店铺" value={order.shop} />
        <WorkbenchField label="状态" value={order.status} />
        <WorkbenchField label="货号" value={order.goodsNo} />
        <WorkbenchField label="付款时间" value={order.paymentTime} />
      </WorkbenchSection>
      <WorkbenchSection title="采购信息">
        <WorkbenchField label="采购平台" value={source.platform || order.purchasePlatform} />
        <WorkbenchField label="货源金额" value={source.amount} />
        <WorkbenchField label="采购单号" value={order.purchaseOrderNo} wide />
        <WorkbenchField label="销售金额" value={order.salesAmount} />
        <WorkbenchField label="Ozon 状态" value={order.ozonStatus} />
      </WorkbenchSection>
      <Box className="purchase-order-workbench-read-actions">
        <Button
          variant="contained"
          size="small"
          disabled={disabled || Boolean(operation)}
          startIcon={operation === 'read-payment-info' ? <CircularProgress size={13} color="inherit" /> : <PaidRounded />}
          onClick={onReadPaymentInfo}
        >
          {operation === 'read-payment-info' ? '正在读取' : '读取付款信息'}
        </Button>
        <Button
          variant="outlined"
          size="small"
          disabled={refreshDisabled || Boolean(operation)}
          startIcon={operation === 'refresh-order-status' ? <CircularProgress size={13} color="inherit" /> : <SyncRounded />}
          onClick={onRefreshOrderStatus}
        >
          {operation === 'refresh-order-status' ? '正在刷新' : '刷新订单状态'}
        </Button>
        <Button
          className="is-save"
          variant={pendingSave ? 'contained' : 'outlined'}
          size="small"
          disabled={disabled || Boolean(operation) || !pendingSave}
          startIcon={operation === 'save-payment-info' ? <CircularProgress size={13} color="inherit" /> : <SaveRounded />}
          onClick={onSavePurchaseInfo}
        >
          {operation === 'save-payment-info' ? '正在保存' : '保存信息'}
        </Button>
      </Box>
      <WorkbenchSection title="物流信息">
        <WorkbenchField label="包裹重量" value={logistics.weight} />
        <WorkbenchField label="包裹尺寸" value={logistics.size} />
        <WorkbenchField label="物流路线" value={logistics.route} wide compact />
        <WorkbenchField label="读取状态" value={logistics.readStatus} wide compact />
      </WorkbenchSection>
      {profitItems.length ? (
        <Box component="section" className="purchase-order-workbench-section">
          <Typography variant="overline">金额概览</Typography>
          <MetricGrid items={profitItems} />
        </Box>
      ) : null}
    </>
  );
}

function ProfitSidebar({ presentation }) {
  const order = presentation.order || {};
  const source = presentation.source || {};
  const profit = presentation.profit || {};
  const estimateItems = Array.isArray(profit.estimateItems) ? profit.estimateItems : [];
  const actualFeeItems = Array.isArray(profit.actualFeeItems) ? profit.actualFeeItems : [];
  return (
    <>
      <WorkbenchSection title="核算订单">
        <WorkbenchField label="Ozon 订单号" value={order.ozonOrderId || order.orderNo} />
        <WorkbenchField label="货号" value={order.goodsNo} />
        <WorkbenchField label="所属店铺" value={order.shop} />
        <WorkbenchField label="付款时间" value={order.paymentTime} />
        <WorkbenchField label="订单状态" value={profit.realStatus || order.ozonStatus} />
        <WorkbenchField label="核算结果" value={profit.resultStatus} />
      </WorkbenchSection>
      <WorkbenchSection title="采购成本">
        <WorkbenchField label="采购平台" value={source.platform || order.purchasePlatform} />
        <WorkbenchField label="采购订单号" value={order.purchaseOrderNo} />
        <WorkbenchField label="货源价格" value={source.amount} />
        <WorkbenchField label="销售金额" value={order.salesAmount} />
      </WorkbenchSection>
      <Box component="section" className="purchase-order-workbench-section">
        <Typography variant="overline">预估利润</Typography>
        <MetricGrid items={estimateItems} />
      </Box>
      <Box component="section" className="purchase-order-workbench-section">
        <Typography variant="overline">实际利润与扣费</Typography>
        <MetricGrid items={[
          { label: '实际利润', value: profit.actualProfit, tone: profit.actualProfitTone },
          ...actualFeeItems,
        ]} />
      </Box>
    </>
  );
}

function AfterSalesSidebar({ presentation }) {
  const afterSales = presentation.afterSales || {};
  return (
    <>
      <WorkbenchSection title="售后订单">
        <WorkbenchField label="原订单" value={afterSales.originalOrderNo} />
        <WorkbenchField label="售后单" value={afterSales.afterSalesId} />
        <WorkbenchField label="售后类型" value={afterSales.type} />
        <WorkbenchField label="售后状态" value={afterSales.status} />
        <WorkbenchField label="店铺" value={afterSales.shop} />
        <WorkbenchField label="物流状态" value={afterSales.logistics} compact />
      </WorkbenchSection>
      <WorkbenchSection title="退款信息">
        <WorkbenchField label="退款金额" value={afterSales.refundAmount} />
        <WorkbenchField label="责任方" value={afterSales.responsibilityParty} />
        <WorkbenchField label="退款状态" value={afterSales.refundStatus} />
        <WorkbenchField label="退款时间" value={afterSales.refundTime} />
        <WorkbenchField label="售后来源" value={afterSales.sourceLabel} />
        <WorkbenchField label="更新时间" value={afterSales.updatedAt} />
      </WorkbenchSection>
      <WorkbenchSection title="采购关联">
        <WorkbenchField label="采购平台" value={afterSales.purchasePlatform} />
        <WorkbenchField label="采购订单号" value={afterSales.purchaseOrderNo} />
        <WorkbenchField label="售后原因" value={afterSales.reason} wide compact />
      </WorkbenchSection>
    </>
  );
}

function ProductAnalysisSidebar({ presentation }) {
  const analysis = presentation.productAnalysis || {};
  const visibleFields = Array.isArray(analysis.visibleFields) ? new Set(analysis.visibleFields) : null;
  const show = (field) => !visibleFields || visibleFields.has(field);
  return (
    <>
      <WorkbenchSection title="商品市场数据">
        {show('price') ? <WorkbenchField label="当前售价" value={analysis.price} /> : null}
        {show('cardPrice') ? <WorkbenchField label="Ozon Card" value={analysis.cardPrice} /> : null}
        {show('sales') ? <WorkbenchField label="销量" value={analysis.sales} /> : null}
        {show('orders') ? <WorkbenchField label="订单量" value={analysis.orders} /> : null}
        {show('revenue') ? <WorkbenchField label="GMV" value={analysis.revenue} /> : null}
        {show('stock') ? <WorkbenchField label="库存" value={analysis.stock} /> : null}
      </WorkbenchSection>
      <WorkbenchSection title="商品与流量">
        {show('brand') ? <WorkbenchField label="品牌" value={analysis.brand} /> : null}
        {show('seller') ? <WorkbenchField label="卖家" value={analysis.seller} /> : null}
        {show('category') ? <WorkbenchField label="类目" value={analysis.category} wide compact /> : null}
        {show('averageDailyRevenue') ? <WorkbenchField label="日均销售额" value={analysis.averageDailyRevenue} /> : null}
        {show('averageDailyUnits') ? <WorkbenchField label="日均销量" value={analysis.averageDailyUnits} /> : null}
        {show('ratingReviews') ? <WorkbenchField label="评分 / 评价" value={`${display(analysis.rating)} / ${display(analysis.reviews)}`} /> : null}
        {show('adSpendShare') ? <WorkbenchField label="广告占比" value={analysis.adSpendShare} /> : null}
        {show('productCardViews') ? <WorkbenchField label="商品卡浏览" value={analysis.productCardViews} /> : null}
        {show('productCardToCartRate') ? <WorkbenchField label="商品卡加购" value={analysis.productCardToCartRate} /> : null}
        {show('searchCatalogViews') ? <WorkbenchField label="搜索浏览" value={analysis.searchCatalogViews} /> : null}
        {show('searchCatalogToCartRate') ? <WorkbenchField label="搜索加购" value={analysis.searchCatalogToCartRate} /> : null}
        {show('impressionToOrderRate') ? <WorkbenchField label="展示下单" value={analysis.impressionToOrderRate} /> : null}
      </WorkbenchSection>
      <WorkbenchSection title="履约与竞争">
        {show('fulfillmentModel') ? <WorkbenchField label="发货模式" value={analysis.fulfillmentModel} /> : null}
        {show('redemptionRate') ? <WorkbenchField label="核销率" value={analysis.redemptionRate} /> : null}
        {show('returnCancelRate') ? <WorkbenchField label="退货取消" value={analysis.returnCancelRate} /> : null}
        {show('packageWeight') ? <WorkbenchField label="包裹重量" value={analysis.packageWeight} /> : null}
        {show('packageDimensions') ? <WorkbenchField label="包裹尺寸" value={analysis.packageDimensions} wide compact /> : null}
        {show('listingDays') ? <WorkbenchField label="上架天数" value={analysis.listingDays} /> : null}
        {show('followSellerCount') ? <WorkbenchField label="跟卖数量" value={analysis.followSellerCount} /> : null}
        {show('followPriceRange') ? <WorkbenchField label="跟卖价格" value={analysis.followPriceRange} wide compact /> : null}
      </WorkbenchSection>
    </>
  );
}

export function PurchaseOrderWorkbenchSidebar({
  presentation = {},
  operation = '',
  disabled = false,
  refreshDisabled = disabled,
  pendingSave = false,
  onReadPaymentInfo = () => {},
  onRefreshOrderStatus = () => {},
  onSavePurchaseInfo = () => {},
}) {
  const product = presentation.product || {};
  const sidebarKind = String(presentation.sidebarKind || 'order');
  return (
    <Box component="aside" className={`purchase-order-workbench-sidebar is-${sidebarKind}`}>
      <Box className="purchase-order-workbench-product-card">
        {product.imageUrl ? (
          <Box component="img" src={product.imageUrl} alt="订单商品" referrerPolicy="no-referrer" />
        ) : (
          <Box className="purchase-order-workbench-product-image-empty">
            <Inventory2Rounded />
          </Box>
        )}
        <Box minWidth={0}>
          <Typography variant="subtitle1">{display(product.title, '暂无商品信息')}</Typography>
          <Typography variant="body2" color="text.secondary">
            SKU：{display(product.sku)}
            {sidebarKind === 'product-analysis' ? '' : ` · ${display(product.quantity, 'x1')}`}
          </Typography>
        </Box>
      </Box>
      {sidebarKind === 'profit' ? (
        <ProfitSidebar presentation={presentation} />
      ) : sidebarKind === 'after-sales' ? (
        <AfterSalesSidebar presentation={presentation} />
      ) : sidebarKind === 'product-analysis' ? (
        <ProductAnalysisSidebar presentation={presentation} />
      ) : (
        <DefaultOrderSidebar
          presentation={presentation}
          operation={operation}
          disabled={disabled}
          refreshDisabled={refreshDisabled}
          pendingSave={pendingSave}
          onReadPaymentInfo={onReadPaymentInfo}
          onRefreshOrderStatus={onRefreshOrderStatus}
          onSavePurchaseInfo={onSavePurchaseInfo}
        />
      )}
    </Box>
  );
}
