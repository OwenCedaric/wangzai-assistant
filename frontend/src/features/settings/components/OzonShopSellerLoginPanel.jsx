import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { OzonBrowserLoginPanel } from './OzonBrowserLoginPanel.jsx';
import {
  completeOzonShopSellerLogin,
  ensureOzonShopSellerLoginProfile,
  isOzonShopSellerLoginConnected,
  readOzonShopSellerLoginProfile,
} from '../services/ozonShopSellerLoginService.js';

function text(value) {
  return String(value ?? '').trim();
}

function shopLabel(shop = {}) {
  return text(shop.shopAlias || shop.alias || shop.sellerName || shop.name || shop.id) || '当前店铺';
}

function identityNotice(profile = {}) {
  const status = text(profile.identityStatus);
  const browserId = text(profile.browserCompanyId);
  const apiId = text(profile.apiIdentityId);
  if (status === 'verified') {
    return {
      severity: 'success',
      message: `已自动对应：网页账号 ${browserId || '已识别'} = 店铺 API ${apiId || '已核对'}。`,
    };
  }
  if (status === 'mismatch') {
    return {
      severity: 'error',
      message: `账号不匹配：网页账号 ${browserId || '未识别'} 与店铺 API ${apiId || '未核对'} 不是同一个账号。`,
    };
  }
  if (status === 'browser-matched') {
    return { severity: 'info', message: '已识别网页账号，正在等待 Seller API 回读核对。' };
  }
  if (profile?.id) {
    return { severity: 'info', message: '当前 Cookie 尚未与店铺 API 身份核对；重新登录保存后会自动识别并对应。' };
  }
  return null;
}

export function OzonShopSellerLoginPanel({ activeShop = {} } = {}) {
  const shopId = text(activeShop.id);
  const name = shopLabel(activeShop);
  const shopLicensed = activeShop.licenseAuthorizationStatus === 'active'
    && activeShop.licenseAuthorized === true;
  const [profile, setProfile] = React.useState(null);
  const [loading, setLoading] = React.useState(Boolean(shopId && shopLicensed));
  const [error, setError] = React.useState('');
  const notice = identityNotice(profile || {});

  React.useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setProfile(null);
    setError('');
    setLoading(Boolean(shopId && shopLicensed));
    if (!shopId || !shopLicensed) return () => controller.abort();
    void readOzonShopSellerLoginProfile({ shopId }, { signal: controller.signal })
      .then((nextProfile) => {
        if (current) setProfile(nextProfile);
      })
      .catch((failure) => {
        if (current && failure?.name !== 'AbortError') {
          setError(failure?.message || '卖家后台登录状态读取失败。');
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [shopId, shopLicensed]);

  const ensureProfile = React.useCallback(async () => {
    setError('');
    const ensured = await ensureOzonShopSellerLoginProfile({ shopId, shopName: name });
    setProfile(ensured);
    return ensured;
  }, [name, shopId]);

  const handleConnected = React.useCallback(async ({ profile: verifiedProfile, result } = {}) => {
    setError('');
    try {
      const connected = await completeOzonShopSellerLogin({
        profile: verifiedProfile,
        shopId,
        shopName: name,
        result,
      });
      setProfile(connected);
      return connected;
    } catch (failure) {
      setError(failure?.message || '卖家后台 Cookie 状态保存失败。');
      throw failure;
    }
  }, [name, shopId]);

  if (!shopId) return <Alert severity="warning">请先选择一个 Ozon 店铺。</Alert>;
  if (!shopLicensed) {
    return (
      <Alert severity="warning" data-testid="ozon-shop-seller-license-required" sx={{ mt: 2 }}>
        当前店铺尚未绑定有效卡密，卖家后台登录和已保存 Cookie 均不会启用。请先完成当前 Client ID 的店铺卡密绑定。
      </Alert>
    );
  }

  return (
    <Box data-testid="ozon-shop-seller-login" data-shop-id={shopId} sx={{ mt: 2 }}>
      {loading ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          正在读取“{name}”的卖家后台登录状态…
        </Typography>
      ) : null}
      {error ? <Alert severity="error" sx={{ mb: 1.25 }}>{error}</Alert> : null}
      {!error && notice ? <Alert severity={notice.severity} sx={{ mb: 1.25 }}>{notice.message}</Alert> : null}
      <OzonBrowserLoginPanel
        connected={isOzonShopSellerLoginConnected(profile || {})}
        cookieStatus={profile?.tokenStatus || 'Cookie 未保存'}
        lastVerifiedAt={profile?.updatedAt || ''}
        title="Ozon 卖家后台登录"
        description={`“${name}”使用独立浏览器配置和 Cookie；方案1只调用本店登录，不会与其他店铺混用。`}
        loginButtonLabel="登录卖家后台"
        reloginButtonLabel="重新登录卖家后台"
        requireCompanyIdentity
        onEnsureProfile={ensureProfile}
        onConnected={handleConnected}
      />
    </Box>
  );
}

export default OzonShopSellerLoginPanel;
