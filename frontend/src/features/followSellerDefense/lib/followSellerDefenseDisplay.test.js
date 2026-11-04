import { describe, expect, it } from 'vitest';
import { formatFollowSellerError, formatFollowSellerErrorBrief } from './followSellerDefenseDisplay.js';

describe('followSellerDefenseDisplay', () => {
  it('turns Electron and native route failures into plain Chinese', () => {
    expect(formatFollowSellerError({
      message: "Error invoking remote method 'desktop:purchase-browser-command': Error: FOLLOW_SELLER_SCHEME1_BACKEND_ROUTE_CHANGED",
    })).toBe('Ozon 客服页面发生了变化，系统没有找到下一步。本次材料已保留，请稍后重新提交。');
    expect(formatFollowSellerError({ message: 'PURCHASE_BROWSER_CEF_FAILED' }))
      .toBe('内置浏览器运行失败，本次材料已保留，请重新提交。');
  });

  it('keeps useful Chinese service messages and hides unknown English internals', () => {
    expect(formatFollowSellerError({ message: '证据文件读取失败，请重新生成。' }))
      .toBe('证据文件读取失败，请重新生成。');
    expect(formatFollowSellerError({ message: 'UNEXPECTED_INTERNAL_FAILURE' }))
      .toBe('操作没有完成，请点击重试；详细原因已经保留在后台诊断记录中。');
  });

  it('explains exhausted local login-status persistence retries without exposing fetch internals', () => {
    expect(formatFollowSellerError({
      message: "Error invoking remote method 'desktop:purchase-browser-command': Error: PURCHASE_BROWSER_INTEGRATION_LOGIN_STATUS_PERSIST_FAILED",
    })).toBe('本地服务连接曾中断，系统已在发送前安全重试；本次仍未发送，材料已保留，请点击“继续剔除”。');
  });

	it('does not claim that a pending evidence bundle already reached chat history', () => {
		expect(formatFollowSellerError({ message: 'FOLLOW_SELLER_COMPLAINT_BUNDLE_SUBMIT_NOT_CONFIRMED' }))
			.toBe('图片和文案已经放入输入框，但 Ozon 没有确认发送成功；请点击“继续剔除”接着处理原工单。');
	});

	it('distinguishes a missing shop binding from an actually signed-out browser', () => {
		expect(formatFollowSellerError({ message: 'OZON_SELLER_BROWSER_PROFILE_REQUIRED' }))
			.toBe('当前店铺没有找到可用的 Ozon 卖家网页登录配置，请在店铺设置核对绑定账号。');
		expect(formatFollowSellerError({ message: 'OZON_LOGIN_VERIFICATION_PENDING' }))
			.toBe('Ozon 卖家页面仍在启动并确认登录状态，系统没有当作退出登录；本次尚未发送，请点击“继续剔除”重试。');
		expect(formatFollowSellerError({ message: 'OZON_LOGIN_REQUIRED' }))
			.toBe('Ozon 卖家网页已经退出登录，请重新登录后再提交。');
	});

	it('explains a persistent browser transition only after automatic recovery was attempted', () => {
		expect(formatFollowSellerError({ message: 'FOLLOW_SELLER_SCHEME1_BROWSER_TRANSIENT_FAILED' }))
			.toBe('Ozon 页面连续加载失败，系统已经自动恢复并重试过一次；本次尚未发送，材料已保留。');
	});

	it('reports the exact scheme1 stage that timed out', () => {
		expect(formatFollowSellerError({ message: 'FOLLOW_SELLER_SCHEME1_ROUTE_REPLY_TIMEOUT' }))
			.toBe('选择客服分类后，Ozon 没有返回下一层菜单；本次尚未发送，证据已保留。');
		expect(formatFollowSellerError({ message: 'FOLLOW_SELLER_SCHEME1_INITIAL_REPLY_TIMEOUT' }))
			.toBe('首次图文证据已发送，但 Ozon 暂未回复；请点击“继续剔除”读取原工单。只有机器人连续发送完全相同的索要信息时，系统才会原样重发一次。');
	});

	it('explains exact-ticket fencing and the one-time identical-prompt replay limit', () => {
		expect(formatFollowSellerError({ message: 'FOLLOW_SELLER_SCHEME1_TICKET_VIEW_MISMATCH' }))
			.toBe('Ozon 当前显示的聊天不是本次精确工单，系统已停止，避免读取或发送到历史工单。');
		expect(formatFollowSellerError({ message: 'FOLLOW_SELLER_SCHEME1_REPEATED_PROMPT_LIMIT' }))
			.toBe('Ozon 机器人第三次发送了完全相同的索要信息，系统已停止，避免无限重复发送。');
	});

  it('provides compact table reasons while keeping detailed messages available separately', () => {
    expect(formatFollowSellerErrorBrief({ message: 'FOLLOW_SELLER_SCHEME1_REPEATED_PROMPT_LIMIT' }))
      .toBe('重复索要已达上限');
    expect(formatFollowSellerErrorBrief({ message: 'FOLLOW_SELLER_SCHEME1_INITIAL_REPLY_TIMEOUT' }))
      .toBe('Ozon 暂未回复首次证据');
    expect(formatFollowSellerErrorBrief({ message: '方案1单条消息超过 Ozon 输入上限，已停止提交。' }))
      .toBe('消息超过 Ozon 输入上限');
    expect(formatFollowSellerErrorBrief({ message: '证据文件读取失败，请重新生成。' }))
      .toBe('证据文件读取失败');
  });
});
