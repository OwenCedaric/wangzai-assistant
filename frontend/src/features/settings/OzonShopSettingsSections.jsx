import { SAVED_CREDENTIAL_MASK, selectCredentialMaskOnFocus, toStoredCredentialValue } from './lib/credentialMask.js';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import StorefrontRounded from '@mui/icons-material/StorefrontRounded';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { OzonShopSellerLoginPanel } from './components/OzonShopSellerLoginPanel.jsx';
import OzonPushEndpointPanel from './components/OzonPushEndpointPanel.jsx';

const OzonShopListCard = React.memo(function OzonShopListCard({
  shops,
  activeShopId,
  onSelect,
  onAdd,
  onRemove,
  removalBusy = false,
}) {
  return (
    <Box className="shop-list-card">
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} mb={1.5}>
        <Box>
          <Typography variant="h6">店铺列表</Typography>
          <Typography variant="body2" color="text.secondary">共 {shops.length} 个店铺</Typography>
        </Box>
        <Button size="small" variant="contained" onClick={onAdd} disabled={removalBusy}>新增</Button>
      </Stack>
      <Stack spacing={1} className="shop-list">
        {shops.map((shop) => (
          <Box
            key={shop.id}
            component="button"
            type="button"
            className={`shop-list-item${shop.id === activeShopId ? ' active' : ''}`}
            onClick={() => {
              if (!removalBusy) onSelect(shop.id);
            }}
            disabled={removalBusy}
          >
            <Box>
              <Typography variant="subtitle1">{shop.shopAlias || '未命名店铺'}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {shop.clientId || (shop.hasClientId ? 'Client ID 已保存' : '未填写 Client ID')}
              </Typography>
            </Box>
            <Chip
              size="small"
              color={shop.connectionStatus === '连接成功' ? 'success' : 'default'}
              label={shop.connectionStatus}
              variant="outlined"
            />
          </Box>
        ))}
      </Stack>
      <Button
        className="shop-remove-button"
        size="small"
        color="error"
        variant="outlined"
        onClick={() => {
          if (!removalBusy) onRemove(activeShopId);
        }}
        disabled={!activeShopId || removalBusy}
      >
        {removalBusy ? '店铺删除处理中…' : '删除当前店铺'}
      </Button>
    </Box>
  );
});

const OzonShopMainPanel = React.memo(function OzonShopMainPanel({
  activeShop,
  activeClientId,
  apiKeyInputValue,
  onChange,
  onResetPurchaseBinding,
  onConfirmPurchaseBinding,
  onRenewLicense,
  onApiKeyEditingChange,
  deferInitialRender = false,
}) {
  const readyStage = 4;
  const [renderStage, setRenderStage] = React.useState(() => (deferInitialRender ? 0 : readyStage));

  React.useLayoutEffect(() => {
    if (globalThis.__wangzaiRendererTreeTelemetryEnabled && globalThis.performance?.mark) {
      globalThis.performance.mark(`wangzai-settings-main-stage:${renderStage}`);
    }
  }, [renderStage]);

  React.useLayoutEffect(() => {
    if (!deferInitialRender && renderStage < readyStage) {
      setRenderStage(readyStage);
    }
  }, [deferInitialRender, readyStage, renderStage]);

  React.useEffect(() => {
    if (!deferInitialRender || renderStage >= readyStage) return undefined;
    const timerId = globalThis.setTimeout(() => {
      setRenderStage((current) => Math.min(readyStage, current + 1));
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [deferInitialRender, renderStage]);

  const handleFieldChange = (field) => (event) => {
    if (field === 'apiKey') onApiKeyEditingChange(true);
    const value = field === 'apiKey' ? toStoredCredentialValue(event.target.value) : event.target.value;
    onChange(field, value);
  };

  return (
    <Box
      className="shop-settings-main"
      data-settings-main-ready={renderStage >= readyStage ? 'true' : 'false'}
      data-settings-main-stage={renderStage}
    >
      <Stack
        className="shop-settings-main-header"
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1.5}
        mb={2}
      >
        <Box>
          <Typography variant="h6">Ozon 店铺资料</Typography>
          <Typography variant="body2" color="text.secondary">连接必填：Client ID 和 API Key</Typography>
        </Box>
        <Box className="shop-bind-actions">
          <Button size="small" variant="outlined" startIcon={<RefreshRounded />} onClick={onResetPurchaseBinding}>
            重置店铺
          </Button>
          <Button size="small" variant="contained" startIcon={<CheckCircleRounded />} onClick={onConfirmPurchaseBinding}>
            确定绑定
          </Button>
          <Button size="small" variant="outlined" onClick={onRenewLicense}>
            续费卡密
          </Button>
        </Box>
      </Stack>
      <Box className="shop-form-grid">
        {renderStage >= 1 ? (
          <>
            <TextField size="small" label="店铺简称" value={activeShop.shopAlias} onChange={handleFieldChange('shopAlias')} />
            <TextField size="small" label="店铺名称" value={activeShop.sellerName} onChange={handleFieldChange('sellerName')} />
          </>
        ) : null}
        {renderStage >= 2 ? (
          <>
            <TextField
              size="small"
              label="Ozon Client ID"
              value={activeClientId}
              onChange={handleFieldChange('clientId')}
              placeholder="例如 client-id-placeholder"
            />
            <TextField
              size="small"
              label="Ozon API Key"
              type="password"
              value={apiKeyInputValue}
              onChange={handleFieldChange('apiKey')}
              placeholder={activeShop.hasApiKey ? '' : '填写 Ozon 后台生成的 API Key'}
              onFocus={selectCredentialMaskOnFocus}
              inputProps={{ 'aria-label': 'Ozon API Key' }}
            />
          </>
        ) : null}
        {renderStage >= 3 ? (
          <TextField
            className="shop-remark-field"
            size="small"
            label="备注"
            value={activeShop.remark}
            onChange={handleFieldChange('remark')}
            multiline
            minRows={2}
          />
        ) : null}
      </Box>
      {renderStage >= 4 && activeShop?.id ? (
        <OzonShopSellerLoginPanel key={activeShop.id} activeShop={activeShop} />
      ) : null}
    </Box>
  );
});

const OzonShopProfileCard = React.memo(function OzonShopProfileCard({
  activeShop,
  activeClientId,
  hasStoredApiKey,
  connectionColor,
  purchaseManagementStartedAtText,
  licenseExpirationText,
}) {
  return (
    <Box className="shop-profile-card">
      <Stack direction="row" alignItems="center" spacing={1.5}>
        <Avatar className="store-avatar store-primary"><StorefrontRounded /></Avatar>
        <Box>
          <Typography variant="subtitle1">{activeShop.shopAlias || '未命名店铺'}</Typography>
          <Typography variant="caption" color="text.secondary">{activeShop.connectionMessage}</Typography>
        </Box>
      </Stack>
      <Divider sx={{ my: 1.5 }} />
      <Box className="shop-profile-grid">
        <Box>
          <Typography variant="caption" color="text.secondary">Client ID</Typography>
          <Typography variant="subtitle1" noWrap title={activeClientId || '未填写'}>
            {activeClientId || (activeShop.hasClientId ? '已加密保存' : '未填写')}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">API Key</Typography>
          <Typography variant="subtitle1">{hasStoredApiKey ? SAVED_CREDENTIAL_MASK : '未填写'}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">连接状态</Typography>
          <Chip size="small" color={connectionColor} label={activeShop.connectionStatus} variant="outlined" />
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">测试时间</Typography>
          <Typography variant="subtitle1">{activeShop.lastTestAt || '未测试'}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">保存</Typography>
          <Typography variant="subtitle1">{activeShop.savedAt || '未保存'}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">拍单生效</Typography>
          <Typography variant="subtitle1" noWrap title={purchaseManagementStartedAtText}>
            {purchaseManagementStartedAtText}
          </Typography>
        </Box>
      </Box>
      <Box className="shop-test-result">
        <Typography variant="caption" color="text.secondary">卡密到期时间</Typography>
        <Typography variant="body2">{licenseExpirationText}</Typography>
      </Box>
    </Box>
  );
});

const OzonShopSidePanel = React.memo(function OzonShopSidePanel({
  activeShop,
  activeClientId,
  hasStoredApiKey,
  connectionColor,
  purchaseManagementStartedAtText,
  licenseExpirationText,
  deferInitialRender = false,
}) {
  const readyStage = 1;
  const [renderStage, setRenderStage] = React.useState(() => (deferInitialRender ? 0 : readyStage));

  React.useLayoutEffect(() => {
    if (globalThis.__wangzaiRendererTreeTelemetryEnabled && globalThis.performance?.mark) {
      globalThis.performance.mark(`wangzai-settings-side-stage:${renderStage}`);
    }
  }, [renderStage]);

  React.useLayoutEffect(() => {
    if (!deferInitialRender && renderStage < readyStage) {
      setRenderStage(readyStage);
    }
  }, [deferInitialRender, readyStage, renderStage]);

  React.useEffect(() => {
    if (!deferInitialRender || renderStage >= readyStage) return undefined;
    const timerId = globalThis.setTimeout(() => {
      setRenderStage((current) => Math.min(readyStage, current + 1));
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [deferInitialRender, readyStage, renderStage]);

  return (
    <Box
      className="shop-settings-side"
      data-settings-side-stage={renderStage}
    >
      {renderStage >= 1 ? (
        <>
          <OzonShopProfileCard
            activeShop={activeShop}
            activeClientId={activeClientId}
            hasStoredApiKey={hasStoredApiKey}
            connectionColor={connectionColor}
            purchaseManagementStartedAtText={purchaseManagementStartedAtText}
            licenseExpirationText={licenseExpirationText}
          />
          <OzonPushEndpointPanel activeShop={activeShop} activeClientId={activeClientId} />
        </>
      ) : null}
    </Box>
  );
});

export {
  OzonShopListCard,
  OzonShopMainPanel,
  OzonShopProfileCard,
  OzonShopSidePanel,
};
