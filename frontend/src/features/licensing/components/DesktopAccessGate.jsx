import LockOutlined from '@mui/icons-material/LockOutlined';
import MailOutlineRounded from '@mui/icons-material/MailOutlineRounded';
import VpnKeyRounded from '@mui/icons-material/VpnKeyRounded';
import VisibilityOffOutlined from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import React from 'react';
import appIcon from '../assets/wangzai-original-logo.png';
import { DesktopAuthProvider } from '../model/DesktopAuthContext.jsx';
import { useDesktopUiUpdateHealth } from '../model/useDesktopUiUpdateHealth.js';
import { DesktopAccessCharacters } from './DesktopAccessCharacters.jsx';
import {
  activatePurchasedLicense,
  beginFreshLicenseLogin,
  checkDesktopLicense,
  clearRememberedLicenseLogin,
  getCurrentLicenseAccount,
  getLicenseRuntime,
  getLicenseSession,
  getRememberedLicenseLogin,
  heartbeatDesktopLicense,
  listShopLicenseEntitlements,
  loginLicenseAccount,
  loginWithRememberedLicenseAccount,
  logoutLicenseAccount,
  registerLicenseAccount,
  renewPurchasedLicense,
  saveRememberedLicenseLogin,
} from '../services/licenseCenterClient.js';
import './DesktopAccessGate.css';

const EMPTY_FORM = Object.freeze({
  email: '',
  password: '',
  confirmPassword: '',
  cardKey: '',
});

const ACTIVATION_REQUIRED_MESSAGE = '当前账号尚未激活，请输入管理系统发放的卡密。';
const RENEWAL_REQUIRED_MESSAGE = '当前店铺授权已到期，请选择店铺并输入月卡或年卡续费。';
const REMEMBERED_PASSWORD_MASK = '••••••••••••';
const LICENSE_VALIDATION_INTERVAL_MS = 10 * 60 * 1000;
// Server overload / gateway errors are temporary like a lost connection: keep the
// workspace while Main still reports a fresh grant, instead of logging every online
// client out at once (and then having them all log back in during the overload).
const TRANSIENT_SERVER_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isLicenseMissing(error) {
  return String(error?.message || error || '').trim() === 'License not found';
}

function isLicenseExpired(error) {
  return String(error?.message || error || '').trim() === 'License has expired';
}

function userMessage(error, fallback = '操作失败，请稍后重试。') {
  const message = String(error?.message || error || '').trim();
  if (!message) return fallback;
  const translations = {
    'Project not found': '当前软件尚未在账户中心启用。',
    'Client version is not supported': '当前软件版本需要更新后才能登录。',
    'Client version hash does not match': '当前安装包校验失败，请重新安装正式版本。',
    'Invalid username or password': '邮箱或密码错误。',
    'User is not active': '账号已停用，请联系管理员。',
    'Activation code is invalid': '卡密无效，请核对后重试。',
    'Activation code is unavailable': '卡密已使用、已禁用或当前不可用。',
    'Activation code has expired': '卡密已过期，请联系管理员更换。',
    'Activation code belongs to another project': '该卡密不属于当前软件。',
    'Activation code is bound to another account': '该卡密已绑定其他账号。',
    'Registration requires a first-shop introductory card': '注册必须使用首店 19.9 元专用卡。',
    'The first-shop introductory offer has already been used by this account': '该账号已经使用过一次首店优惠。',
    'The first-shop introductory card can only be used during registration': '首店 19.9 元卡只能在注册时使用一次。',
    'Renewal requires a standard shop card': '续费必须使用标准月卡或年卡。',
    'Only active shop licenses can be renewed': '该店铺授权状态异常，暂时不能续费。',
    'License not found': ACTIVATION_REQUIRED_MESSAGE,
    'Device limit reached': '该授权绑定的设备数量已达到上限。',
    'License has expired': '授权已到期，请联系管理员续费后再登录。',
  };
  return translations[message] || message;
}

function validateForm(mode, form) {
  if (mode === 'activate' || mode === 'renew') {
    return /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/u.test(form.cardKey.trim().toUpperCase())
      ? ''
      : '请输入管理系统发放的 16 位卡密。';
  }
  const email = form.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return '请输入正确的邮箱地址。';
  if (form.password.length < 8) return '密码至少需要 8 位。';
  if (mode === 'register' && form.password !== form.confirmPassword) {
    return '两次输入的密码不一致。';
  }
  if (mode === 'register' && !/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/u.test(form.cardKey.trim().toUpperCase())) {
    return '请输入管理系统发放的 16 位卡密。';
  }
  return '';
}

async function setWindowMode(mode) {
  return globalThis.window?.wangzaiDesktop?.setWindowMode?.(mode);
}

export function DesktopAccessGate({ children }) {
  const isDashboardVisualFixture =
    typeof globalThis.window?.wangzaiDesktop?.captureDashboardVisual === 'function';
  const [runtime, setRuntime] = React.useState(null);
  const [session, setSession] = React.useState(null);
  const [phase, setPhase] = React.useState('checking');
  useDesktopUiUpdateHealth(phase === 'ready');
  const [mode, setMode] = React.useState('login');
  const [pendingAccount, setPendingAccount] = React.useState(null);
  const [renewalOptions, setRenewalOptions] = React.useState([]);
  const [renewalLicenseId, setRenewalLicenseId] = React.useState('');
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);
  const [activeField, setActiveField] = React.useState('');
  const [rememberLogin, setRememberLogin] = React.useState(false);
  const [usingRememberedCredential, setUsingRememberedCredential] = React.useState(false);

  const applyRememberedLogin = React.useCallback((saved) => {
    if (saved?.remembered && saved?.email) {
      setForm({ ...EMPTY_FORM, email: saved.email, password: REMEMBERED_PASSWORD_MASK });
      setRememberLogin(true);
      setUsingRememberedCredential(true);
      return;
    }
    setForm(EMPTY_FORM);
    setRememberLogin(false);
    setUsingRememberedCredential(false);
  }, []);

  const loadRememberedLogin = React.useCallback(async () => {
    const saved = await getRememberedLicenseLogin();
    applyRememberedLogin(saved);
    return saved;
  }, [applyRememberedLogin]);

  const enterWorkspace = React.useCallback(async (accountPayload = null) => {
    const latest = await getLicenseSession();
    const account = accountPayload?.user || latest?.user || null;
    setSession({ ...latest, authenticated: true, user: account });
    setPhase('authenticated');
    setError('');
    await setWindowMode('workspace');
  }, []);

  const returnToLogin = React.useCallback(async ({ revoke = true } = {}) => {
    if (revoke) await logoutLicenseAccount().catch(() => undefined);
    else await beginFreshLicenseLogin().catch(() => undefined);
    setSession(null);
    setPhase('ready');
    setMode('login');
    setPendingAccount(null);
    setRenewalOptions([]);
    setRenewalLicenseId('');
    setError('');
    setBusy(false);
    setShowPassword(false);
    setActiveField('');
    await loadRememberedLogin().catch(() => applyRememberedLogin(null));
    await setWindowMode('login');
  }, [applyRememberedLogin, loadRememberedLogin]);

  React.useEffect(() => {
    let active = true;
    // Electron clears the private license session on every real process start.
    // Vite Fast Refresh can rerun this effect while preserving React state,
    // though, so clear the visible workspace state before beginLogin as well.
    // Otherwise the renderer can keep showing the workspace after Main has
    // already revoked the session, and every local API action fails with 403.
    setSession(null);
    setPhase('checking');
    setError('');
    void setWindowMode('login');
    (async () => {
      try {
        await beginFreshLicenseLogin();
        const [nextRuntime, savedLogin] = await Promise.all([
          getLicenseRuntime(),
          getRememberedLicenseLogin(),
        ]);
        if (!active) return;
        setRuntime(nextRuntime);
        // Dashboard visual runs are a source-only Electron automation surface.
        // They use license mode "off", an isolated userData directory and
        // loopback-only services.  Keeping this opt-in here lets UI smoke tests
        // exercise the real workspace without weakening normal/enforce starts,
        // which still require a fresh account login every time.
        if (isDashboardVisualFixture && nextRuntime?.mode === 'off') {
          setSession({
            authenticated: true,
            authorized: true,
            user: { id: 'dashboard-visual-fixture', email: 'dashboard-visual@fixture.invalid' },
          });
          setPhase('authenticated');
          setError('');
          await setWindowMode('workspace');
          return;
        }
        applyRememberedLogin(savedLogin);
        setPhase('ready');
      } catch (requestError) {
        if (!active) return;
        setError(userMessage(requestError, '账户中心暂时无法连接，请稍后重试。'));
        setPhase('ready');
      }
    })();
    return () => {
      active = false;
    };
  }, [applyRememberedLogin, isDashboardVisualFixture]);

  React.useEffect(() => {
    if (phase !== 'authenticated' || isDashboardVisualFixture) return undefined;
    let active = true;
    let authorizationCheckRunning = false;

    const validate = async ({ checkAccount = false } = {}) => {
      if (authorizationCheckRunning) return;
      authorizationCheckRunning = true;
      try {
        const activeRuntime = runtime || await getLicenseRuntime();
        if (active) setRuntime(activeRuntime);
        await heartbeatDesktopLicense(activeRuntime);
        if (checkAccount) await getCurrentLicenseAccount();
        const latestSession = await getLicenseSession();
        if (!latestSession?.authorized) {
          throw Object.assign(new Error('软件授权已失效，请重新登录。'), { status: 403 });
        }
        if (active) setSession(latestSession);
      } catch (requestError) {
        if (!active) return;
        const status = Number(requestError?.status || 0);
        const latestSession = await getLicenseSession().catch(() => null);
        const definitiveFailure = status > 0 && !TRANSIENT_SERVER_STATUSES.has(status);
        if (definitiveFailure || latestSession?.authorized === false) {
          await returnToLogin({ revoke: false });
          if (active) setError(userMessage(requestError, '软件授权已失效，请重新登录。'));
        }
      } finally {
        authorizationCheckRunning = false;
      }
    };

    void validate({ checkAccount: true });
    const validationTimer = globalThis.setInterval(
      () => validate({ checkAccount: true }),
      LICENSE_VALIDATION_INTERVAL_MS,
    );
    return () => {
      active = false;
      globalThis.clearInterval(validationTimer);
    };
  }, [isDashboardVisualFixture, phase, returnToLogin, runtime]);

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setPendingAccount(null);
    setRenewalOptions([]);
    setRenewalLicenseId('');
    setError('');
    setShowPassword(false);
    setActiveField('');
    if (nextMode === 'login') {
      void loadRememberedLogin().catch(() => applyRememberedLogin(null));
    } else {
      setForm(EMPTY_FORM);
      setUsingRememberedCredential(false);
    }
  };

  const updateField = (field) => (event) => {
    if (field === 'email' && usingRememberedCredential) {
      setUsingRememberedCredential(false);
      setForm((current) => ({ ...current, email: event.target.value, password: '' }));
      void clearRememberedLicenseLogin();
      return;
    }
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };

  const updatePassword = (field) => (event) => {
    const value = field === 'password' && usingRememberedCredential
      ? String(event.target.value || '').replace(REMEMBERED_PASSWORD_MASK, '')
      : event.target.value;
    if (field === 'password' && usingRememberedCredential) {
      setUsingRememberedCredential(false);
      void clearRememberedLicenseLogin();
    }
    setForm((current) => ({ ...current, [field]: value }));
  };

  const beginPasswordEdit = (event) => {
    if (!usingRememberedCredential) return;
    const printable = event.key?.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    const removing = event.key === 'Backspace' || event.key === 'Delete';
    if (!printable && !removing) return;
    event.preventDefault();
    setUsingRememberedCredential(false);
    setForm((current) => ({ ...current, password: printable ? event.key : '' }));
    void clearRememberedLicenseLogin();
  };

  const pastePassword = (event) => {
    if (!usingRememberedCredential) return;
    event.preventDefault();
    setUsingRememberedCredential(false);
    setForm((current) => ({
      ...current,
      password: String(event.clipboardData?.getData('text') || ''),
    }));
    void clearRememberedLicenseLogin();
  };

  const updateRememberLogin = (event) => {
    const checked = event.target.checked;
    setRememberLogin(checked);
    if (checked) return;
    setUsingRememberedCredential(false);
    setForm((current) => ({
      ...current,
      password: current.password === REMEMBERED_PASSWORD_MASK ? '' : current.password,
    }));
    void clearRememberedLicenseLogin();
  };

  const togglePasswordVisibility = () => {
    setShowPassword((current) => !current);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const validationError = validateForm(mode, form);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const activeRuntime = runtime || (await getLicenseRuntime());
      setRuntime(activeRuntime);
      if (mode === 'activate') {
        await activatePurchasedLicense(activeRuntime, form.cardKey.trim().toUpperCase());
        await checkDesktopLicense(activeRuntime);
        const authorizedSession = await getLicenseSession();
        if (!authorizedSession?.authorized) throw Object.assign(new Error('当前账号没有有效授权。'), { status: 403 });
        await enterWorkspace({ user: pendingAccount || authorizedSession?.user || null });
        return;
      }
      if (mode === 'renew') {
        if (!renewalLicenseId) throw new Error('请选择需要续费的店铺。');
        await renewPurchasedLicense(
          activeRuntime,
          Number(renewalLicenseId),
          form.cardKey.trim().toUpperCase(),
        );
        await checkDesktopLicense(activeRuntime);
        const authorizedSession = await getLicenseSession();
        if (!authorizedSession?.authorized) throw Object.assign(new Error('当前账号没有有效授权。'), { status: 403 });
        await enterWorkspace({ user: pendingAccount || authorizedSession?.user || null });
        return;
      }
      const payload =
        mode === 'register'
          ? await registerLicenseAccount(activeRuntime, {
              email: form.email,
              password: form.password,
              cardKey: form.cardKey,
            })
          : usingRememberedCredential
            ? await loginWithRememberedLicenseAccount()
            : await loginLicenseAccount(activeRuntime, form.email, form.password);
      if (mode === 'login' && !usingRememberedCredential) {
        if (rememberLogin) {
          await saveRememberedLicenseLogin(form.email, form.password);
        } else {
          await clearRememberedLicenseLogin();
        }
      }
      try {
        await checkDesktopLicense(activeRuntime);
      } catch (licenseError) {
        if (mode === 'login' && (isLicenseMissing(licenseError) || isLicenseExpired(licenseError))) {
          const user = payload?.user || { email: form.email.trim() };
          const entitlements = await listShopLicenseEntitlements(activeRuntime).catch(() => []);
          const renewable = entitlements.filter((item) => Number(item?.license_id) > 0);
          setSession({ authenticated: true, authorized: false, user });
          setPendingAccount(user);
          setRenewalOptions(renewable);
          setRenewalLicenseId(renewable[0]?.license_id ? String(renewable[0].license_id) : '');
          setMode(renewable.length ? 'renew' : 'activate');
          setForm({ ...EMPTY_FORM, email: user?.email || form.email.trim() });
          setUsingRememberedCredential(false);
          setError(renewable.length ? RENEWAL_REQUIRED_MESSAGE : ACTIVATION_REQUIRED_MESSAGE);
          return;
        }
        throw licenseError;
      }
      const authorizedSession = await getLicenseSession();
      if (!authorizedSession?.authorized) throw Object.assign(new Error('当前账号没有有效授权。'), { status: 403 });
      await enterWorkspace(payload);
    } catch (requestError) {
      if (mode === 'login' && Number(requestError?.status || 0) === 401) {
        setUsingRememberedCredential(false);
        setRememberLogin(false);
        setForm((current) => ({ ...current, password: '' }));
      }
      setError(userMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const authContext = React.useMemo(
    () => ({
      session,
      logout: () => returnToLogin({ revoke: true }),
    }),
    [returnToLogin, session]
  );

  if (phase === 'authenticated') {
    return <DesktopAuthProvider value={authContext}>{children}</DesktopAuthProvider>;
  }

  const passwordAdornment = (
    <InputAdornment position="end">
      <IconButton
        aria-label={showPassword ? '隐藏密码' : '显示密码'}
        edge="end"
        size="small"
        onMouseDown={(event) => event.preventDefault()}
        onClick={togglePasswordVisibility}
        disabled={busy}
      >
        {showPassword ? <VisibilityOffOutlined fontSize="small" /> : <VisibilityOutlined fontSize="small" />}
      </IconButton>
    </InputAdornment>
  );

  const heading = mode === 'register'
    ? '创建旺崽账号'
    : mode === 'activate'
      ? '激活软件授权'
      : mode === 'renew'
        ? '续费店铺授权'
        : '欢迎回来';
  const description = mode === 'register'
    ? '使用注册邮箱和管理系统卡密完成账号激活。'
    : mode === 'activate'
      ? `${pendingAccount?.email || form.email || '当前账号'} 已登录，请输入卡密完成授权。`
      : mode === 'renew'
        ? `${pendingAccount?.email || form.email || '当前账号'} 已登录，卡密只续费所选店铺。`
      : '使用注册邮箱登录旺崽助手';
  const animatedPasswordLength = usingRememberedCredential ? 0 : form.password.length;
  const focusField = (field) => () => setActiveField(field);
  const blurField = () => setActiveField('');

  return (
    <main className="desktop-access-shell">
      <section className="desktop-access-panel" aria-label="旺崽账户登录">
        <aside className="desktop-access-visual">
          <div className="desktop-access-brand">
            <img src={appIcon} alt="" aria-hidden="true" />
            <div>
              <strong>旺崽助手</strong>
              <span>Wangzai Workspace</span>
            </div>
          </div>

          <div className="desktop-access-character-stage">
            <DesktopAccessCharacters
              isTyping={Boolean(activeField)}
              showPassword={showPassword}
              passwordLength={animatedPasswordLength}
            />
          </div>

          <div className="desktop-access-visual-footer" aria-hidden="true">
            <span>跨境店铺运营工作台</span>
            <span>订单、商品、推广和数据，集中处理更省心</span>
          </div>
        </aside>

        <div className={`desktop-access-form-panel${mode === 'register' ? ' is-scrollable' : ''}`}>
          {phase === 'checking' ? (
            <div className="desktop-access-checking" role="status">
              <img src={appIcon} alt="" aria-hidden="true" />
              <CircularProgress size={24} thickness={4} />
              <span>正在确认登录状态</span>
            </div>
          ) : (
            <div className="desktop-access-form-wrap">
              <div className="desktop-access-heading">
                <h1>{heading}</h1>
                <p>{description}</p>
              </div>

              {error ? (
                <Alert severity={mode === 'activate' || mode === 'renew' ? 'warning' : 'error'} className="desktop-access-alert">
                  {error}
                </Alert>
              ) : null}

              <form className="desktop-access-form" onSubmit={handleSubmit} noValidate>
                {mode !== 'activate' && mode !== 'renew' ? (
                  <TextField
                    label="邮箱"
                    value={form.email}
                    onChange={updateField('email')}
                    onFocus={focusField('email')}
                    onBlur={blurField}
                    type="email"
                    autoComplete="email"
                    autoFocus
                    fullWidth
                    disabled={busy}
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <MailOutlineRounded fontSize="small" />
                        </InputAdornment>
                      ),
                    }}
                  />
                ) : null}

                {mode !== 'activate' && mode !== 'renew' ? (
                  <TextField
                    label="密码"
                    value={form.password}
                    onChange={updatePassword('password')}
                    onKeyDown={beginPasswordEdit}
                    onPaste={pastePassword}
                    onFocus={focusField('password')}
                    onBlur={blurField}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                    fullWidth
                    disabled={busy}
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <LockOutlined fontSize="small" />
                        </InputAdornment>
                      ),
                      endAdornment: passwordAdornment,
                    }}
                  />
                ) : null}

                {mode === 'register' ? (
                  <>
                    <TextField
                      label="确认密码"
                      value={form.confirmPassword}
                      onChange={updatePassword('confirmPassword')}
                      onFocus={focusField('confirmPassword')}
                      onBlur={blurField}
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      fullWidth
                      disabled={busy}
                      InputProps={{
                        startAdornment: (
                          <InputAdornment position="start">
                            <LockOutlined fontSize="small" />
                          </InputAdornment>
                        ),
                        endAdornment: passwordAdornment,
                      }}
                    />
                    <TextField
                      label="激活卡密"
                      value={form.cardKey}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          cardKey: event.target.value
                            .toUpperCase()
                            .replace(/[^A-Z0-9-]/gu, '')
                            .slice(0, 19),
                        }))
                      }
                      onFocus={focusField('cardKey')}
                      onBlur={blurField}
                      placeholder="AAAA-BBBB-CCCC-DDDD"
                      autoComplete="off"
                      fullWidth
                      disabled={busy}
                      InputProps={{
                        startAdornment: (
                          <InputAdornment position="start">
                            <VpnKeyRounded fontSize="small" />
                          </InputAdornment>
                        ),
                      }}
                    />
                  </>
                ) : mode === 'activate' || mode === 'renew' ? (
                  <>
                    {mode === 'renew' ? (
                      <TextField
                        select
                        label="续费店铺"
                        value={renewalLicenseId}
                        onChange={(event) => setRenewalLicenseId(event.target.value)}
                        fullWidth
                        disabled={busy}
                      >
                        {renewalOptions.map((item) => {
                          const shop = item.shops?.[0];
                          const label = shop?.shop_name || shop?.shop_id || item.plan_name || `授权 ${item.license_id}`;
                          return <MenuItem key={item.license_id} value={String(item.license_id)}>{label}</MenuItem>;
                        })}
                      </TextField>
                    ) : null}
                    <TextField
                      label={mode === 'renew' ? '续费卡密' : '激活卡密'}
                      value={form.cardKey}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          cardKey: event.target.value
                            .toUpperCase()
                            .replace(/[^A-Z0-9-]/gu, '')
                            .slice(0, 19),
                        }))
                      }
                      onFocus={focusField('cardKey')}
                      onBlur={blurField}
                      placeholder="AAAA-BBBB-CCCC-DDDD"
                      autoComplete="off"
                      autoFocus
                      fullWidth
                      disabled={busy}
                      InputProps={{
                        startAdornment: (
                          <InputAdornment position="start">
                            <VpnKeyRounded fontSize="small" />
                          </InputAdornment>
                        ),
                      }}
                    />
                  </>
                ) : null}

                {mode === 'login' ? (
                  <div className="desktop-access-remember-block">
                    <FormControlLabel
                      className="desktop-access-remember-control"
                      control={(
                        <Checkbox
                          checked={rememberLogin}
                          onChange={updateRememberLogin}
                          size="small"
                          disabled={busy}
                          inputProps={{ 'aria-label': '记住账号和密码' }}
                        />
                      )}
                      label="记住账号和密码"
                    />
                    <span>启动时仍会实时验证授权</span>
                  </div>
                ) : null}

                <Button
                  variant="contained"
                  type="submit"
                  fullWidth
                  disableElevation
                  disabled={busy}
                  className="desktop-access-primary"
                >
                  {busy ? '请稍候…' : mode === 'register' ? '注册并激活' : mode === 'activate' ? '激活并进入' : mode === 'renew' ? '续费并进入' : '登录'}
                </Button>
              </form>

              <div className="desktop-access-switch">
                <span>
                  {mode === 'register' ? '已经有账号？' : mode === 'activate' || mode === 'renew' ? '不是这个账号？' : '还没有账号？'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (mode === 'activate' || mode === 'renew') {
                      void returnToLogin({ revoke: true });
                      return;
                    }
                    switchMode(mode === 'register' ? 'login' : 'register');
                  }}
                  disabled={busy}
                >
                  {mode === 'register' ? '返回登录' : mode === 'activate' || mode === 'renew' ? '切换账号' : '注册账号'}
                </button>
              </div>

              <div className="desktop-access-session-note" aria-hidden="true">
                本机加密保存 · 每次启动重新验证
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
