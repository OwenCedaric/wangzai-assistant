import {
  getMarketingActivityIdentityKey,
  getMarketingProductOfferDisplay,
  getMarketingProductSkuDisplay,
} from '../../../entities/order/orderShopScope.jsx';
import {
  getMarketingActivityDisplaySource,
  getMarketingActivityDisplayTitle,
} from '../../../entities/marketing/marketingActivityPresentation.jsx';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

export function MarketingActivitiesPageView({ model }) {
  const {
    showReadNotice,
    activityRows,
    productScope,
    setProductPage,
    isReadingActivities,
    isReadingProducts,
    readNotice,
    setReadNotice,
    readNoticeTone,
    selectedProductIds,
    productCardRef,
    selectedActivity,
    productRows,
    totalProductPages,
    currentProductPage,
    visibleProductRows,
    allProductIds,
    currentPageProductIds,
    isAllProductsSelected,
    isCurrentPageSelected,
    selectedCount,
    marketingStats,
    toggleProduct,
    handleReadActivities,
    handleProductScopeChange,
    selectCurrentPage,
    selectAllProducts,
    handleSelectActivity,
    marketingFilterCard,
    sideProductSearch,
    currentActivityCard,
    reviewResultCard,
    executionPlanCard,
    marketingWriteConfirmDialog,
    reminderCard,
  } = model;

  return (
    <>
      <Box className="marketing-page">
        <Box className="marketing-hero">
          <Typography variant="h4">营销活动</Typography>
          <Typography variant="body2" color="text.secondary">
            选择店铺后读取 Ozon 后台活动，再处理活动商品和折扣计划。
          </Typography>
        </Box>

        <Box className="marketing-stat-grid">
          {marketingStats.map((stat) => (
            <Card key={stat.title} className="marketing-stat-card">
              <CardContent>
                <Box className={`marketing-stat-icon marketing-stat-${stat.tone}`} />
                <Box className="marketing-stat-copy">
                  <Typography variant="subtitle2">{stat.title}</Typography>
                  <Typography variant="h4">{stat.value}</Typography>
                </Box>
                <Typography variant="body2" color="text.secondary">
                  {stat.hint}
                </Typography>
              </CardContent>
            </Card>
          ))}
        </Box>

        <Snackbar
          className="marketing-read-snackbar"
          open={showReadNotice && Boolean(readNotice)}
          anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
          onClose={() => setReadNotice('')}
        >
          <Alert
            className="marketing-read-alert"
            severity={readNoticeTone === 'error' ? 'error' : readNoticeTone === 'success' ? 'success' : 'info'}
            variant="filled"
            onClose={() => setReadNotice('')}
          >
            {readNotice}
          </Alert>
        </Snackbar>

        <Box className="marketing-layout">
          <Box className="marketing-main marketing-main-top">
            <Card className="marketing-activity-card">
              <CardContent>
                <Box className="marketing-section-head">
                  <Box className="marketing-section-copy">
                    <Typography variant="h6">活动</Typography>
                    <Typography variant="body2" color="text.secondary">
                      长期活动优先，切换活动后商品池同步更新。
                    </Typography>
                  </Box>
                  <Button
                    className="marketing-action-button marketing-action-read"
                    variant="contained"
                    onClick={handleReadActivities}
                    disabled={isReadingActivities}
                  >
                    {isReadingActivities ? '读取中' : '读取活动'}
                  </Button>
                </Box>

                <Box className="marketing-activity-grid">
                  {activityRows.length === 0 ? (
                    <Box className="marketing-activity-empty">
                      <Typography variant="body2" color="text.secondary">
                        暂无活动，先读取店铺活动。
                      </Typography>
                    </Box>
                  ) : (
                    activityRows.map((activity) => (
                      <Box
                        key={getMarketingActivityIdentityKey(activity)}
                        component="button"
                        type="button"
                        className={`marketing-activity-item${
                          getMarketingActivityIdentityKey(activity) === getMarketingActivityIdentityKey(selectedActivity)
                            ? ' active'
                            : ''
                        }`}
                        onClick={() => handleSelectActivity(activity)}
                      >
                        <Typography variant="subtitle1" noWrap title={getMarketingActivityDisplayTitle(activity)}>
                          {getMarketingActivityDisplayTitle(activity)}
                        </Typography>
                        <Box className="marketing-activity-meta">
                          <Chip
                            size="small"
                            color={activity.sourceTone}
                            label={getMarketingActivityDisplaySource(activity)}
                            className="marketing-soft-chip"
                          />
                          <Typography variant="body2">{activity.count} 个商品</Typography>
                        </Box>
                      </Box>
                    ))
                  )}
                </Box>
              </CardContent>
            </Card>
          </Box>

          <Box className="marketing-side marketing-side-top">{currentActivityCard}</Box>

          {marketingFilterCard}

          <Box className="marketing-main marketing-main-lower">
            {executionPlanCard}

            <Card ref={productCardRef} className="marketing-products-card">
              <CardContent>
                <Box className="marketing-products-head">
                  <Stack direction="row" alignItems="center" spacing={1.5}>
                    <Typography variant="h6">商品池</Typography>
                    <Box className="marketing-product-tabs">
                      <Box
                        component="button"
                        type="button"
                        className={`marketing-product-tab${productScope === 'joined' ? ' active' : ''}`}
                        onClick={() => handleProductScopeChange('joined')}
                        disabled={isReadingProducts}
                      >
                        已添加 {selectedActivity.count}
                      </Box>
                      <Box
                        component="button"
                        type="button"
                        className={`marketing-product-tab${productScope === 'available' ? ' active' : ''}`}
                        onClick={() => handleProductScopeChange('available')}
                        disabled={isReadingProducts}
                      >
                        可添加 {selectedActivity.available}
                      </Box>
                    </Box>
                  </Stack>
                  <Stack className="marketing-products-actions" direction="row" alignItems="center" spacing={1.5}>
                    <Typography variant="body2" color="text.secondary">
                      已选择 {selectedCount} 个商品
                    </Typography>
                    <Button
                      variant="contained"
                      className="marketing-select-all-button"
                      onClick={selectAllProducts}
                      disabled={allProductIds.length === 0}
                    >
                      {isAllProductsSelected ? '取消选择所有品' : '全选所有品'}
                    </Button>
                    <Button
                      variant="outlined"
                      className="marketing-select-page-button"
                      onClick={selectCurrentPage}
                      disabled={currentPageProductIds.length === 0}
                    >
                      {isCurrentPageSelected ? '取消选择本页' : '全选本页'}
                    </Button>
                  </Stack>
                </Box>

                <TableContainer className="wide-table-container">
                  <Table className="data-table marketing-products-table">
                    <TableHead>
                      <TableRow>
                        <TableCell className="marketing-select-cell" />
                        <TableCell>商品货号 / Ozon SKU</TableCell>
                        <TableCell align="right">售价</TableCell>
                        <TableCell align="right">活动价</TableCell>
                        <TableCell align="right">库存</TableCell>
                        <TableCell>状态</TableCell>
                        <TableCell>复核</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {productRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} align="center">
                            <Typography variant="body2" color="text.secondary">
                              暂无符合条件的商品
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ) : (
                        visibleProductRows.map((product) => {
                          const productOfferDisplay = getMarketingProductOfferDisplay(product);
                          const productSkuDisplay = getMarketingProductSkuDisplay(product);
                          return (
                            <TableRow
                              key={product.id}
                              hover
                              className={selectedProductIds.includes(product.id) ? 'selected-row' : ''}
                              onClick={() => toggleProduct(product.id)}
                            >
                              <TableCell
                                className="marketing-select-cell"
                                padding="checkbox"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <Checkbox
                                  size="small"
                                  checked={selectedProductIds.includes(product.id)}
                                  onChange={() => toggleProduct(product.id)}
                                  inputProps={{
                                    'aria-label': `选择 ${productOfferDisplay || productSkuDisplay || product.id}`,
                                  }}
                                />
                              </TableCell>
                              <TableCell>
                                <Box className="marketing-product-identity">
                                  <Typography variant="subtitle2" title={productOfferDisplay}>
                                    <Box component="span">商品货号：</Box>
                                    {productOfferDisplay}
                                  </Typography>
                                  <Typography variant="caption" title={productSkuDisplay}>
                                    <Box component="span">Ozon SKU：</Box>
                                    {productSkuDisplay}
                                  </Typography>
                                </Box>
                              </TableCell>
                              <TableCell align="right">{product.price}</TableCell>
                              <TableCell align="right">{product.activityPrice}</TableCell>
                              <TableCell align="right">{product.stock}</TableCell>
                              <TableCell>
                                <Chip size="small" color={product.statusTone} label={product.status} />
                              </TableCell>
                              <TableCell>
                                <Chip size="small" color={product.reviewTone} label={product.review} />
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
                <Box className="marketing-pagination">
                  <Typography variant="body2" color="text.secondary">
                    第 {productRows.length === 0 ? 0 : currentProductPage} /{' '}
                    {productRows.length === 0 ? 0 : totalProductPages} 页
                  </Typography>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={currentProductPage <= 1}
                    onClick={() => setProductPage((current) => Math.max(1, current - 1))}
                  >
                    上一页
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={currentProductPage >= totalProductPages || productRows.length === 0}
                    onClick={() => setProductPage((current) => Math.min(totalProductPages, current + 1))}
                  >
                    下一页
                  </Button>
                </Box>
              </CardContent>
            </Card>
          </Box>

          <Box className="marketing-side marketing-side-lower">
            {sideProductSearch}
            {reviewResultCard}
            {reminderCard}
          </Box>
        </Box>
      </Box>
      {marketingWriteConfirmDialog}
    </>
  );
}
