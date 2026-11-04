export async function requestWechatAssistant(input = {}) {
  const command = window.wangzaiDesktop?.wechatAssistant?.command;
  if (typeof command !== 'function') {
    return { ok: false, error: '当前不是旺崽桌面端环境，无法启动内置小龙虾。' };
  }
  try {
    return await command(input);
  } catch {
    return { ok: false, error: '微信助理操作未完成，请重试；如仍失败请查看运行日志。' };
  }
}
