export async function readRecoveryStartupMode() {
  try {
    const info = await globalThis.window?.wangzaiDesktop?.getAppInfo?.();
    return info?.recoveryMode === true;
  } catch {
    return false;
  }
}
