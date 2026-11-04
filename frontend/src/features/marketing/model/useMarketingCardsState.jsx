import FilterAltRounded from '@mui/icons-material/FilterAltRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputAdornment from '@mui/material/InputAdornment';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  getMarketingActivityDisplayDescription,
  getMarketingActivityDisplaySource,
  getMarketingActivityDisplayTitle,
} from '../../../entities/marketing/marketingActivityPresentation.jsx';
import { getMarketingActivityIdentityKey } from '../../../entities/order/orderShopScope.jsx';

export function useMarketingCardsState({
  selectedShopId,
  handleMarketingShopChange,
  safeShops,
  activityFilter,
  setActivityFilter,
  activityRows,
  handleSelectActivity,
  productScope,
  handleProductScopeChange,
  pageSize,
  setPageSize,
  setProductPage,
  keyword,
  setKeyword,
  showSideProductSearch,
  selectedActivity,
  marketingReviewRows,
  isReadingProducts,
  hasLiveActivityData,
  refreshCurrentProductPool,
  selectedCount,
  planSubmitCount,
  skippedCount,
  discountPercent,
  setDiscountPercent,
  handleCancelMarketingActivity,
  openMarketingWriteDialog,
  handleSubmitMarketingChanges,
  marketingWriteDialog,
  isMarketingWriting,
  marketingWriteDialogOpenRef,
  setMarketingWriteDialog,
  handleConfirmMarketingWrite,
  marketingReminder,
  reviewIssueCount,
} = {}) {
  const marketingFilterCard = (
    <Card className="marketing-filter-card">
      <CardContent>
        <Box className="marketing-filter-row">
          <Box className="marketing-filter-title">
            <FilterAltRounded />
            <Typography variant="h6">筛选</Typography>
          </Box>
          <Box className="marketing-filter-controls">
            <FormControl size="small" className="marketing-select">
              <Select value={selectedShopId} onChange={(event) => handleMarketingShopChange(event.target.value)}>
                {safeShops.map((shop) => (
                  <MenuItem key={shop.id} value={shop.id}>
                    {shop.shopAlias || shop.sellerName || '未命名店铺'}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" className="marketing-select">
              <Select
                value={activityFilter}
                onChange={(event) => {
                  const value = event.target.value;
                  setActivityFilter(value);
                  if (value !== 'all') {
                    const nextActivity = activityRows.find(
                      (activity) => getMarketingActivityIdentityKey(activity) === value
                    );
                    if (nextActivity) handleSelectActivity(nextActivity);
                  }
                }}
              >
                <MenuItem value="all">全部活动</MenuItem>
                {activityRows.map((activity) => (
                  <MenuItem key={getMarketingActivityIdentityKey(activity)} value={getMarketingActivityIdentityKey(activity)}>
                    {getMarketingActivityDisplayTitle(activity)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" className="marketing-select">
              <Select value={productScope} onChange={(event) => handleProductScopeChange(event.target.value)}>
                <MenuItem value="joined">已添加商品</MenuItem>
                <MenuItem value="available">可添加商品</MenuItem>
                <MenuItem value="all">全部商品</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" className="marketing-select marketing-page-size">
              <Select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(event.target.value);
                  setProductPage(1);
                }}
              >
                <MenuItem value="20">20 条/页</MenuItem>
                <MenuItem value="50">50 条/页</MenuItem>
                <MenuItem value="100">100 条/页</MenuItem>
              </Select>
            </FormControl>
          </Box>
          <TextField
            className="marketing-search-field"
            size="small"
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value);
              setProductPage(1);
            }}
            placeholder="搜索商品货号、Ozon SKU"
          />
        </Box>
      </CardContent>
    </Card>
  );
  const sideProductSearch = (
    <Box
      className={`marketing-side-search${showSideProductSearch ? ' is-visible' : ''}`}
      aria-hidden={!showSideProductSearch}
    >
      <TextField
        className="marketing-side-search-field"
        size="small"
        value={keyword}
        onChange={(event) => {
          setKeyword(event.target.value);
          setProductPage(1);
        }}
        placeholder="搜索商品货号、Ozon SKU"
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchRounded />
            </InputAdornment>
          ),
        }}
      />
    </Box>
  );
  const currentActivityCard = (
    <Card>
      <CardContent>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={2}>
          <Typography variant="h6">当前活动</Typography>
          <Chip
            size="small"
            color={selectedActivity.sourceTone}
            label={getMarketingActivityDisplaySource(selectedActivity)}
            className="marketing-source-chip"
          />
        </Stack>
        <Typography variant="h5" mb={0.5}>
          {getMarketingActivityDisplayTitle(selectedActivity)}
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={2.5}>
          {getMarketingActivityDisplayDescription(selectedActivity)}
        </Typography>
        <Box className="marketing-summary-grid">
          <Box>
            <Typography variant="caption" color="text.secondary">
              已添加
            </Typography>
            <Typography variant="h6">{selectedActivity.count}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              可添加
            </Typography>
            <Typography variant="h6">{selectedActivity.available}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              预计成交
            </Typography>
            <Typography variant="h6">{selectedActivity.estimate}</Typography>
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
  const reviewResultCard = (
    <Card>
      <CardContent>
        <Typography variant="h6" mb={2}>
          复核结果
        </Typography>
        <Box className="marketing-review-list">
          {marketingReviewRows.map((row) => (
            <Box className="marketing-review-row" key={row.label}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="subtitle2">{row.label}</Typography>
                <Typography variant="subtitle2">{row.value}</Typography>
              </Stack>
              <LinearProgress className="progress-line" variant="determinate" value={row.progress} color={row.color} />
            </Box>
          ))}
        </Box>
        <Button
          className="marketing-review-button"
          variant="outlined"
          fullWidth
          disabled={isReadingProducts || !hasLiveActivityData || !selectedActivity.id}
          onClick={refreshCurrentProductPool}
        >
          {isReadingProducts ? '读取中' : '再次读取并复核'}
        </Button>
      </CardContent>
    </Card>
  );
  const executionPlanCard = (
    <Card className="marketing-plan-card">
      <CardContent>
        <Box className="marketing-plan-row">
          <Box className="marketing-plan-title">
            <Typography variant="h6">执行计划</Typography>
          </Box>
          <Box className="marketing-plan-stats">
            <Box className="marketing-plan-stat-item">
              <Typography variant="caption" color="text.secondary">
                已选择
              </Typography>
              <Typography variant="h4">{selectedCount}</Typography>
            </Box>
            <Box className="marketing-plan-stat-item">
              <Typography variant="caption" color="text.secondary">
                可提交
              </Typography>
              <Typography variant="h4">{planSubmitCount}</Typography>
            </Box>
            <Box className="marketing-plan-stat-item">
              <Typography variant="caption" color="text.secondary">
                异常商品
              </Typography>
              <Typography variant="h4">{skippedCount}</Typography>
            </Box>
          </Box>
          <Box className="marketing-plan-actions">
            <TextField
              className="marketing-discount-input"
              size="small"
              type="number"
              value={discountPercent}
              onChange={(event) => setDiscountPercent(event.target.value)}
              inputProps={{ min: 1, max: 99, step: 1 }}
              InputProps={{
                endAdornment: <InputAdornment position="end">%</InputAdornment>,
              }}
            />
            <Button
              className="marketing-action-button marketing-action-cancel"
              variant="outlined"
              onClick={handleCancelMarketingActivity}
            >
              取消活动
            </Button>
            <Button
              className="marketing-action-button marketing-action-plan"
              variant="outlined"
              onClick={() => openMarketingWriteDialog('ratio')}
            >
              修改比例
            </Button>
            <Button
              className="marketing-action-button marketing-action-submit"
              variant="contained"
              onClick={handleSubmitMarketingChanges}
            >
              提交修改
            </Button>
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
  const marketingWriteConfirmDialog = (
    <Dialog
      className={`marketing-write-dialog marketing-write-${marketingWriteDialog?.tone || 'primary'}`}
      open={Boolean(marketingWriteDialog)}
      maxWidth="sm"
      fullWidth
      onClose={() => {
        if (!isMarketingWriting) {
          marketingWriteDialogOpenRef.current = false;
          setMarketingWriteDialog(null);
        }
      }}
    >
      {marketingWriteDialog ? (
        <>
          <DialogTitle className="marketing-write-title">
            <Box className="marketing-write-title-main">
              <Box className="marketing-write-icon">
                <WarningAmberRounded fontSize="small" />
              </Box>
              <Box>
                <Typography variant="h6">{marketingWriteDialog.title}</Typography>
                <Typography variant="body2" color="text.secondary">
                  这是可以写入 Ozon 后台的操作。
                </Typography>
              </Box>
            </Box>
          </DialogTitle>
          <DialogContent className="marketing-write-content">
            <Box className="marketing-write-alert">
              <WarningAmberRounded fontSize="small" />
              <Typography variant="body2">
                点击确认后会同步真实 Ozon 后台数据，请先核对活动、商品数量和比例。
              </Typography>
            </Box>
            <Box className="marketing-write-summary">
              <Box>
                <Typography variant="caption" color="text.secondary">
                  当前活动
                </Typography>
                <Typography variant="subtitle2" noWrap title={marketingWriteDialog.activityTitle}>
                  {marketingWriteDialog.activityTitle}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  写入动作
                </Typography>
                <Typography variant="subtitle2">{marketingWriteDialog.actionText}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  商品数量
                </Typography>
                <Typography variant="subtitle2">{marketingWriteDialog.productCount} 个商品</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  活动比例
                </Typography>
                <Typography variant="subtitle2">
                  {marketingWriteDialog.action === 'cancel' ? '不修改' : `${marketingWriteDialog.percent}%`}
                </Typography>
              </Box>
            </Box>
            <Typography className="marketing-write-description" variant="body2" color="text.secondary">
              {marketingWriteDialog.description}
            </Typography>
          </DialogContent>
          <DialogActions className="marketing-write-actions">
            <Button variant="outlined" onClick={() => setMarketingWriteDialog(null)} disabled={isMarketingWriting}>
              再检查一下
            </Button>
            <Button
              className={`marketing-write-confirm marketing-write-confirm-${marketingWriteDialog.tone}`}
              variant="contained"
              onClick={handleConfirmMarketingWrite}
              disabled={isMarketingWriting}
            >
              {isMarketingWriting ? '同步中' : marketingWriteDialog.confirmLabel}
            </Button>
          </DialogActions>
        </>
      ) : null}
    </Dialog>
  );
  const reminderCard = (
    <Card>
      <CardContent>
        <Typography variant="h6" mb={2}>
          处理提醒
        </Typography>
        <Box className="marketing-alert-box">
          <Typography variant="subtitle2">{marketingReminder}</Typography>
        </Box>
        <Typography variant="body2" color="text.secondary" mt={2}>
          {reviewIssueCount > 0 ? '建议先补齐价格和库存，再重新修改比例。' : '当前商品池可以继续处理活动比例。'}
        </Typography>
      </CardContent>
    </Card>
  );

  return {
    marketingFilterCard,
    sideProductSearch,
    currentActivityCard,
    reviewResultCard,
    executionPlanCard,
    marketingWriteConfirmDialog,
    reminderCard,
  };
}
