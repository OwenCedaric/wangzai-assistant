function text(value) {
  return String(value ?? '').trim();
}

const ERROR_RULES = Object.freeze([
  [['FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT'], '今天的同类投诉次数已经用完，证据和跟卖 SKU 已保留，请在 24 小时后重试。'],
  [['FOLLOW_SELLER_SCHEME1_BACKEND_ROUTE_CHANGED'], 'Ozon 客服页面发生了变化，系统没有找到下一步。本次材料已保留，请稍后重新提交。'],
  [['FOLLOW_SELLER_COMPLAINT_CAPTCHA_REQUIRED', 'OZON_RR_CHALLENGE', 'OZON_RISK_CONTROL'], 'Ozon 要求人机验证，请完成滑块或验证码后重新提交。'],
	[['OZON_LOGIN_VERIFICATION_PENDING'], 'Ozon 卖家页面仍在启动并确认登录状态，系统没有当作退出登录；本次尚未发送，请点击“继续剔除”重试。'],
  [['FOLLOW_SELLER_COMPLAINT_LOGIN_REQUIRED', 'OZON_LOGIN_REQUIRED'], 'Ozon 卖家网页已经退出登录，请重新登录后再提交。'],
	[['OZON_SELLER_BROWSER_PROFILE_REQUIRED', 'OZON_BROWSER_PROFILE_REQUIRED'], '当前店铺没有找到可用的 Ozon 卖家网页登录配置，请在店铺设置核对绑定账号。'],
	[['FOLLOW_SELLER_COMPLAINT_ATTACHMENT_UPLOAD_FAILED'], '图片仍在上传或网络过慢，系统没有提前发送；请等待网络恢复后继续剔除。'],
	[['FOLLOW_SELLER_COMPLAINT_ATTACHMENT_SUBMIT_NOT_CONFIRMED', 'FOLLOW_SELLER_COMPLAINT_BUNDLE_SUBMIT_NOT_CONFIRMED'], '图片和文案已经放入输入框，但 Ozon 没有确认发送成功；请点击“继续剔除”接着处理原工单。'],
	[['FOLLOW_SELLER_SCHEME1_CONTINUATION_NOT_FOUND', 'FOLLOW_SELLER_SCHEME1_CONTINUATION_INVALID', 'FOLLOW_SELLER_SCHEME1_RESUME_TICKET_MISMATCH'], '没有准确找到上次失败的 Ozon 工单，系统已停止，避免接错对话。'],
	[['FOLLOW_SELLER_SCHEME1_TICKET_VIEW_MISMATCH'], 'Ozon 当前显示的聊天不是本次精确工单，系统已停止，避免读取或发送到历史工单。'],
	[['FOLLOW_SELLER_SCHEME1_REPEATED_PROMPT_LIMIT'], 'Ozon 机器人第三次发送了完全相同的索要信息，系统已停止，避免无限重复发送。'],
	[['FOLLOW_SELLER_SCHEME1_PROMPT_REPLAY_STATE_INVALID', 'FOLLOW_SELLER_SCHEME1_PROMPT_REPLAY_STATE_SAVE_FAILED'], '相同问题的一次性重发记录无法确认，系统已停止，避免重复发送。'],
  [['FOLLOW_SELLER_SCHEME1_PRODUCT_PAGE_NETWORK_FAILED', 'FOLLOW_SELLER_SCHEME1_ORIGINAL_PRODUCT_PAGE_INVALID', 'FOLLOW_SELLER_SCHEME1_FOLLOWER_PRODUCT_PAGE_INVALID'], '我方或跟卖商品页面没有完整打开，系统没有使用空白截图，请检查网络后重试。'],
  [['FOLLOW_SELLER_SCHEME1_SELLER_LIST_NETWORK_FAILED'], 'Ozon 卖家后台商品列表没有完整打开，请检查网络后重试。'],
  [['FOLLOW_SELLER_SCHEME1_LISTING_DATE_NOT_FOUND', 'FOLLOW_SELLER_SCHEME1_SELLER_LIST_NOT_FOUND'], '后台商品列表没有同时找到货号、Ozon SKU 和上架时间，系统已停止提交错误证据。'],
  [['FOLLOW_SELLER_SCHEME1_ORIGINAL_SKU_NOT_FOUND'], 'Ozon 没有在当前店铺找到我方商品 SKU，请核对商品和店铺是否对应。'],
  [['FOLLOW_SELLER_SCHEME1_FOLLOWER_SKU_NOT_FOUND', 'FOLLOW_SELLER_SCHEME1_ALL_FOLLOWERS_NOT_FOUND'], '原跟卖商品已经找不到，系统没有继续提交无效投诉。'],
  [['FOLLOW_SELLER_SCHEME1_SUPPLEMENT_REJECTED'], '补交商品列表截图后，Ozon 仍认为证据不足。本次没有重复发送旧证据。'],
	[['FOLLOW_SELLER_SCHEME1_TICKET_CREATE_TIMEOUT'], 'Ozon 没有在限定时间内建立客服工单，本次尚未发送，证据已保留。'],
	[['FOLLOW_SELLER_SCHEME1_CONVERSATION_LOAD_TIMEOUT'], 'Ozon 客服会话长时间没有恢复显示，原工单和证据已保留，请稍后继续剔除。'],
	[['FOLLOW_SELLER_SCHEME1_ROUTE_REPLY_TIMEOUT'], '选择客服分类后，Ozon 没有返回下一层菜单；本次尚未发送，证据已保留。'],
	[['FOLLOW_SELLER_SCHEME1_FOLLOWER_PROMPT_TIMEOUT'], '我方 SKU 已发送，但 Ozon 没有继续索要跟卖 SKU；请点击“继续剔除”读取原工单。'],
	[['FOLLOW_SELLER_SCHEME1_EVIDENCE_PROMPT_TIMEOUT'], '跟卖 SKU 已发送，但 Ozon 没有继续索要版权证据；请点击“继续剔除”读取原工单。'],
	[['FOLLOW_SELLER_SCHEME1_INITIAL_REPLY_TIMEOUT'], '首次图文证据已发送，但 Ozon 暂未回复；请点击“继续剔除”读取原工单。只有机器人连续发送完全相同的索要信息时，系统才会原样重发一次。'],
	[['FOLLOW_SELLER_SCHEME1_SUPPLEMENT_REPLY_TIMEOUT'], '补充证据已发送，但 Ozon 暂未回复；请点击“继续剔除”读取原工单。相同索要信息最多原样重发一次。'],
	[['FOLLOW_SELLER_SCHEME1_RECEIPT_CONFIRM_TIMEOUT', 'FOLLOW_SELLER_SCHEME1_STAGE_TIMEOUT'], '当前客服阶段等待超时，工单和证据已保留；请点击“继续剔除”从原工单恢复。'],
  [['FOLLOW_SELLER_COMPLAINT_RECEIPT_TIMEOUT', 'FOLLOW_SELLER_COMPLAINT_RECEIPT_REQUIRED'], '提交后没有取得明确的 Ozon 工单编号，暂时不能算提交成功，请重试。'],
  [['FOLLOW_SELLER_COMPLAINT_SUBMIT_NOT_CONFIRMED'], 'Ozon 没有确认收到完整投诉内容，本次没有记为提交成功，请重试。'],
  [['FOLLOW_SELLER_SCHEME1_SUBMISSION_INVALID', 'FOLLOW_SELLER_SCHEME1_MATERIAL_INVALID'], '方案1材料不完整，系统已停止提交，请重新生成材料。'],
  [['PURCHASE_BROWSER_INTEGRATION_LOGIN_STATUS_PERSIST_FAILED', 'PURCHASE_BROWSER_LOCAL_API_TRANSPORT_FAILED'], '本地服务连接曾中断，系统已在发送前安全重试；本次仍未发送，材料已保留，请点击“继续剔除”。'],
  [['LOCAL_API_REQUEST_TIMEOUT', 'LOCAL-API 请求超时', 'LOCAL_API'], '提交结果保存超时，请刷新列表查看实际状态；已经取得的证据不会丢失。'],
  [['FOLLOW_SELLER_SCHEME1_BROWSER_TRANSIENT_FAILED', 'FOLLOW_SELLER_SCHEME1_PAGE_SCRIPT_FAILED', 'FOLLOW_SELLER_SCHEME1_PAGE_STATE_INVALID'], 'Ozon 页面连续加载失败，系统已经自动恢复并重试过一次；本次尚未发送，材料已保留。'],
  [['PURCHASE_BROWSER_CEF_FAILED', 'PURCHASE_BROWSER_CEF_HOST_FAILED', 'PURCHASE_BROWSER_CEF_PROTOCOL', 'FOLLOW_SELLER_SCHEME1_BROWSER_CREATE_FAILED', 'FOLLOW_SELLER_SCHEME1_BROWSER_CLOSED', 'FOLLOW_SELLER_SCHEME1_BROWSER_TIMEOUT'], '内置浏览器运行失败，本次材料已保留，请重新提交。'],
  [['FOLLOW_SELLER_CAPTURE_UNCONFIRMED', 'FOLLOW_SELLER_CAPTURE_MISSING'], '没有取得这个商品的准确跟卖数量，请重新巡查。'],
  [['FOLLOW_SELLER_SCHEME1_SUBMIT_FAILED', 'FOLLOW_SELLER_COMPLAINT_SUBMIT_FAILED'], '投诉没有提交完成，材料已经保留，请重新提交。'],
]);

const BRIEF_ERROR_RULES = Object.freeze([
  [['FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT'], '当日投诉次数已达上限'],
  [['FOLLOW_SELLER_SCHEME1_BACKEND_ROUTE_CHANGED', 'OZON 客服页面发生了变化'], 'Ozon 客服页面已变化'],
  [['FOLLOW_SELLER_COMPLAINT_CAPTCHA_REQUIRED', 'OZON_RR_CHALLENGE', 'OZON_RISK_CONTROL'], '需要完成人机验证'],
  [['OZON_LOGIN_VERIFICATION_PENDING'], '登录状态仍在确认'],
  [['FOLLOW_SELLER_COMPLAINT_LOGIN_REQUIRED', 'OZON_LOGIN_REQUIRED', '卖家网页已经退出登录'], 'Ozon 登录已失效'],
  [['OZON_SELLER_BROWSER_PROFILE_REQUIRED', 'OZON_BROWSER_PROFILE_REQUIRED'], '未绑定卖家网页登录'],
  [['FOLLOW_SELLER_COMPLAINT_ATTACHMENT_UPLOAD_FAILED'], '附件上传未完成'],
  [['FOLLOW_SELLER_COMPLAINT_ATTACHMENT_SUBMIT_NOT_CONFIRMED', 'FOLLOW_SELLER_COMPLAINT_BUNDLE_SUBMIT_NOT_CONFIRMED'], '图文发送未确认'],
  [['FOLLOW_SELLER_SCHEME1_CONTINUATION_NOT_FOUND', 'FOLLOW_SELLER_SCHEME1_CONTINUATION_INVALID', 'FOLLOW_SELLER_SCHEME1_RESUME_TICKET_MISMATCH'], '未找到原 Ozon 工单'],
  [['FOLLOW_SELLER_SCHEME1_TICKET_VIEW_MISMATCH'], '当前不是原 Ozon 工单'],
  [['FOLLOW_SELLER_SCHEME1_REPEATED_PROMPT_LIMIT', '机器人第三次发送了完全相同'], '重复索要已达上限'],
  [['FOLLOW_SELLER_SCHEME1_PROMPT_REPLAY_STATE_INVALID', 'FOLLOW_SELLER_SCHEME1_PROMPT_REPLAY_STATE_SAVE_FAILED'], '重发记录无法确认'],
  [['FOLLOW_SELLER_SCHEME1_PRODUCT_PAGE_NETWORK_FAILED', 'FOLLOW_SELLER_SCHEME1_ORIGINAL_PRODUCT_PAGE_INVALID', 'FOLLOW_SELLER_SCHEME1_FOLLOWER_PRODUCT_PAGE_INVALID'], '商品页面加载失败'],
  [['FOLLOW_SELLER_SCHEME1_SELLER_LIST_NETWORK_FAILED'], '后台商品列表加载失败'],
  [['FOLLOW_SELLER_SCHEME1_LISTING_DATE_NOT_FOUND', 'FOLLOW_SELLER_SCHEME1_SELLER_LIST_NOT_FOUND'], '未找到完整商品资料'],
  [['FOLLOW_SELLER_SCHEME1_ORIGINAL_SKU_NOT_FOUND'], '未找到我方商品 SKU'],
  [['FOLLOW_SELLER_SCHEME1_FOLLOWER_SKU_NOT_FOUND', 'FOLLOW_SELLER_SCHEME1_ALL_FOLLOWERS_NOT_FOUND'], '跟卖商品已失效'],
  [['FOLLOW_SELLER_SCHEME1_SUPPLEMENT_REJECTED'], 'Ozon 判定补证不足'],
  [['FOLLOW_SELLER_SCHEME1_TICKET_CREATE_TIMEOUT'], 'Ozon 工单创建超时'],
  [['FOLLOW_SELLER_SCHEME1_CONVERSATION_LOAD_TIMEOUT'], '原工单加载超时'],
  [['FOLLOW_SELLER_SCHEME1_ROUTE_REPLY_TIMEOUT'], 'Ozon 菜单未响应'],
  [['FOLLOW_SELLER_SCHEME1_FOLLOWER_PROMPT_TIMEOUT'], 'Ozon 未索要跟卖 SKU'],
  [['FOLLOW_SELLER_SCHEME1_EVIDENCE_PROMPT_TIMEOUT'], 'Ozon 未索要版权证据'],
  [['FOLLOW_SELLER_SCHEME1_INITIAL_REPLY_TIMEOUT'], 'Ozon 暂未回复首次证据'],
  [['FOLLOW_SELLER_SCHEME1_SUPPLEMENT_REPLY_TIMEOUT'], 'Ozon 暂未回复补充证据'],
  [['FOLLOW_SELLER_SCHEME1_RECEIPT_CONFIRM_TIMEOUT', 'FOLLOW_SELLER_SCHEME1_STAGE_TIMEOUT'], 'Ozon 客服阶段超时'],
  [['FOLLOW_SELLER_COMPLAINT_RECEIPT_TIMEOUT', 'FOLLOW_SELLER_COMPLAINT_RECEIPT_REQUIRED'], '未取得 Ozon 工单号'],
  [['FOLLOW_SELLER_COMPLAINT_SUBMIT_NOT_CONFIRMED'], 'Ozon 未确认投诉内容'],
  [['FOLLOW_SELLER_SCHEME1_SUBMISSION_INVALID', 'FOLLOW_SELLER_SCHEME1_MATERIAL_INVALID'], '方案1材料不完整'],
  [['PURCHASE_BROWSER_INTEGRATION_LOGIN_STATUS_PERSIST_FAILED', 'PURCHASE_BROWSER_LOCAL_API_TRANSPORT_FAILED'], '本地服务连接中断'],
  [['LOCAL_API_REQUEST_TIMEOUT', 'LOCAL-API 请求超时', 'LOCAL_API'], '结果保存超时'],
  [['FOLLOW_SELLER_SCHEME1_BROWSER_TRANSIENT_FAILED', 'FOLLOW_SELLER_SCHEME1_PAGE_SCRIPT_FAILED', 'FOLLOW_SELLER_SCHEME1_PAGE_STATE_INVALID'], 'Ozon 页面连续加载失败'],
  [['PURCHASE_BROWSER_CEF_FAILED', 'PURCHASE_BROWSER_CEF_HOST_FAILED', 'PURCHASE_BROWSER_CEF_PROTOCOL', 'FOLLOW_SELLER_SCHEME1_BROWSER_CREATE_FAILED', 'FOLLOW_SELLER_SCHEME1_BROWSER_CLOSED', 'FOLLOW_SELLER_SCHEME1_BROWSER_TIMEOUT'], '内置浏览器运行失败'],
  [['FOLLOW_SELLER_CAPTURE_UNCONFIRMED', 'FOLLOW_SELLER_CAPTURE_MISSING'], '未取得准确跟卖数量'],
  [['FOLLOW_SELLER_SCHEME1_SUBMIT_FAILED', 'FOLLOW_SELLER_COMPLAINT_SUBMIT_FAILED'], '投诉未提交完成'],
  [['输入上限'], '消息超过 Ozon 输入上限'],
]);

function readableChinese(message) {
  if (!/[\u3400-\u9fff]/u.test(message)) return '';
  return message
    .replace(/^Error invoking remote method[^:]*:\s*(?:Error:\s*)?/iu, '')
    .replace(/^Error:\s*/iu, '')
    .trim();
}

export function formatFollowSellerError(input = {}) {
  const value = typeof input === 'string' ? { message: input } : input;
  const code = text(value?.code || value?.lastErrorCode).toUpperCase();
  const message = text(value?.message || value?.lastErrorMessage);
  if (!code && !message) return '';
  const search = `${code}\n${message}`.toUpperCase();
  const matched = ERROR_RULES.find(([needles]) => needles.some((needle) => search.includes(needle.toUpperCase())));
  if (matched) return matched[1];
  const chinese = readableChinese(message);
  if (chinese) return chinese;
  return '操作没有完成，请点击重试；详细原因已经保留在后台诊断记录中。';
}

export function formatFollowSellerErrorBrief(input = {}) {
  const value = typeof input === 'string' ? { message: input } : input;
  const code = text(value?.code || value?.lastErrorCode).toUpperCase();
  const message = text(value?.message || value?.lastErrorMessage);
  if (!code && !message) return '';
  const search = `${code}\n${message}`.toUpperCase();
  const matched = BRIEF_ERROR_RULES.find(([needles]) => needles.some((needle) => search.includes(needle.toUpperCase())));
  if (matched) return matched[1];
  const detailed = formatFollowSellerError(value);
  if (!detailed) return '';
  if (detailed === '操作没有完成，请点击重试；详细原因已经保留在后台诊断记录中。') {
    return '操作未完成，请重试';
  }
  const firstClause = detailed.split(/[，,；;。！？\n]/u).map((part) => part.trim()).find(Boolean) || detailed;
  const characters = [...firstClause];
  return characters.length > 26 ? `${characters.slice(0, 26).join('')}…` : firstClause;
}
