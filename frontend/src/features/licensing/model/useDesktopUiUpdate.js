import React from 'react';

export function useDesktopUiUpdate() {
  const [enabled, setEnabled] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [message, setMessage] = React.useState('');
  React.useEffect(() => {
    let cancelled = false;
    globalThis.wangzaiDesktop?.uiUpdates?.status().then(result => {
      if (!cancelled) setEnabled(result?.enabled === true);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const check = async () => {
    setOpen(true); setChecking(true); setMessage('正在检查并校验更新…');
    try {
      const result = await globalThis.wangzaiDesktop.uiUpdates.check();
      setMessage(result?.ok
        ? result.state === 'staged' ? '更新已下载并验证。请完成当前操作后，从托盘完全退出软件，再重新打开生效。' : '当前没有新更新。'
        : `更新未应用，继续使用当前版本。${result?.code === 'UI_UPDATE_LOGIN_REQUIRED' ? '请先登录并激活卡密。' : '请稍后重试或联系管理员。'}`);
    } catch { setMessage('更新检查失败，继续使用当前版本，请稍后重试。'); }
    finally { setChecking(false); }
  };
  return { enabled, open, checking, message, check, close: () => setOpen(false) };
}
