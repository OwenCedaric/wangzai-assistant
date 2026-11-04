import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../test/appSource';

function readProjectFile(relativePath) {
  return readProjectSource(relativePath);
}

describe('notification center rules', () => {
  it('uses local-api notification endpoints for the bell message center', () => {
    const localApiClient = readProjectFile('src/api/localApiClient.js');
    const appSource = readProjectFile('src/App.jsx');
    const notificationCenter = readProjectFile('src/app/shell/NotificationCenterPopover.jsx');

    expect(localApiClient).toContain('export function listOzonNotifications');
    expect(localApiClient).toContain("'/api/ozon/notifications");
    expect(localApiClient).toContain('export function markOzonNotificationsRead');
    expect(localApiClient).toContain("'/api/ozon/notifications/read'");
    expect(localApiClient).toContain('export function clearOzonNotifications');
    expect(localApiClient).toContain("'/api/ozon/notifications/clear'");
    expect(localApiClient).toContain('export function listOzonNotificationSettings');
    expect(localApiClient).toContain("'/api/ozon/notification-settings");
    expect(localApiClient).toContain('export function saveOzonNotificationSetting');
    expect(localApiClient).toContain('export function pollLocalSmartReplyNotifications');
    expect(localApiClient).toContain("'/api/smart-reply/local/notification-poll'");

    expect(appSource).toContain('const NotificationCenterPopover = lazyNamed(');
    expect(appSource).toContain("() => import('./app/shell/NotificationCenterPopover.jsx'),");
    expect(appSource).toContain('backendNotificationUnreadCount');
    expect(appSource).toContain("listOzonNotifications({ read: 'unread', limit: 1, shopIds: shopIds.join(',') }");
    expect(appSource).toContain('pollLocalSmartReplyNotifications({ timeoutMs: 5000 })');
    expect(notificationCenter).toContain('listOzonNotifications({');
    expect(notificationCenter).toContain("shopIds: shopId ? undefined : authorizedShopIds.join(',')");
    expect(notificationCenter).toContain('await markOzonNotificationsRead(');
    expect(notificationCenter).toContain('clearOzonNotifications(payload');
    expect(notificationCenter).toContain('onUnreadChange(0)');
  });

  it('keeps the bell UI grouped by shop and notification domain like the planned Qianniu-style panel', () => {
    const notificationCenter = readProjectFile('src/app/shell/NotificationCenterPopover.jsx');

    expect(notificationCenter).toContain('className="notification-shop-tabs"');
    expect(notificationCenter).toContain('全部店铺');
    expect(notificationCenter).toContain('className="notification-domain-list"');
    expect(notificationCenter).toContain('商品变化');
    expect(notificationCenter).toContain('订单进度');
    expect(notificationCenter).toContain('售后处理');
    expect(notificationCenter).toContain('采购跟进');
    expect(notificationCenter).toContain('className="notification-message-pane"');
    expect(notificationCenter).toContain('getVisibleNotifications(mergedRows, selectedDomain)');
    expect(notificationCenter).toContain('全部已读');
    expect(notificationCenter).toContain('清空当前');
  });

  it('keeps the bell panel reference-sized, scrollable and card-based instead of page-sized', () => {
    const notificationCenter = readProjectFile('src/app/shell/NotificationCenterPopover.jsx');
    const styles = readProjectFile('src/styles.css');

    expect(notificationCenter).toContain('className="notification-center-actions"');
    expect(styles).toContain('width: min(960px, calc(100vw - 24px));');
    expect(styles).toContain('max-height: min(620px, calc(100vh - 48px));');
    expect(styles).toContain('height: min(620px, calc(100vh - 48px));');
    expect(styles).toContain('grid-template-columns: 180px minmax(0, 1fr);');
    expect(styles).toContain('font-size: 20px;');
    expect(styles).toContain('font-size: 16px !important;');
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr) 32px;');
    expect(styles).toContain('text-align: center;');
    expect(styles).toContain('.notification-message-list');
    expect(styles).toContain('overflow-y: auto;');
    expect(styles).toContain('.notification-message-item');
    expect(styles).toContain('border-radius: 8px;');
    expect(styles).toContain('-webkit-line-clamp: 2;');
    expect(styles).not.toContain('width: min(760px, calc(100vw - 32px));');
    expect(styles).not.toContain('max-height: min(620px, calc(100vh - 96px));');
  });

  it('marks messages read without deleting the inspectable message history', () => {
    const appSource = readProjectFile('src/App.jsx');
    const notificationCenter = readProjectFile('src/app/shell/NotificationCenterPopover.jsx');
    const markReadBlock = notificationCenter.slice(
      notificationCenter.indexOf('const handleMarkAllRead = async () =>'),
      notificationCenter.indexOf('const handleClearNotifications = async () =>')
    );

    expect(notificationCenter).toContain('const handleMarkAllRead = async () =>');
    expect(notificationCenter).toContain("? { shopId: selectedShopId }");
    expect(notificationCenter).toContain(': { shopIds: authorizedShopIds }');
    expect(notificationCenter).toContain('onUnreadChange(0)');
    expect(markReadBlock).toContain('await loadNotifications();');
    expect(markReadBlock).not.toContain('clearOzonNotifications');
    expect(notificationCenter).not.toContain('onMarkLocalOrderNotificationsRead');
    expect(notificationCenter).not.toContain('onClearLocalOrderNotifications');
    expect(notificationCenter).not.toContain("listOzonNotifications({ shopId, read: 'unread', limit: 100 }");
    expect(appSource).toContain('const notificationBadgeCount = backendNotificationUnreadCount;');
    expect(appSource).not.toContain('unreadOrderNotificationCount');
  });

  it('only clears notification rows through the explicit manual clear action', () => {
    const notificationCenter = readProjectFile('src/app/shell/NotificationCenterPopover.jsx');

    expect(notificationCenter).toContain('const handleClearNotifications = async () =>');
    expect(notificationCenter).toContain('await clearOzonNotifications(payload, { timeoutMs: 12000 })');
    expect(notificationCenter).toContain(
      "if (selectedShopId && selectedShopId !== 'all') payload.shopId = selectedShopId;"
    );
    expect(notificationCenter).toContain(
      "if (selectedDomain && selectedDomain !== 'all') payload.domain = selectedDomain;"
    );
  });

  it('saves notification switches per shop and domain without disabling every module at once', () => {
    const notificationCenter = readProjectFile('src/app/shell/NotificationCenterPopover.jsx');
    const saveBlock = notificationCenter.slice(
      notificationCenter.indexOf('const handleDomainToggle = async'),
      notificationCenter.indexOf('return (', notificationCenter.indexOf('const handleDomainToggle = async'))
    );

    expect(saveBlock).toContain("if (selectedDomain === 'all') return;");
    expect(saveBlock).toContain('domain: selectedDomain');
    expect(saveBlock).toContain("eventType: '*'");
    expect(saveBlock).toContain("shopId: selectedShopId === 'all' ? '' : selectedShopId");
    expect(saveBlock).not.toContain("domain: '*'");
    expect(saveBlock).not.toContain('eventType: selectedDomain');
  });

  it('uses the durable Ozon push ledger instead of the retired page-diff bell scheme', () => {
    const appSource = readProjectFile('src/App.jsx');
    const notificationCenter = readProjectFile('src/app/shell/NotificationCenterPopover.jsx');
    const localApp = readProjectFile('../local-api/src/app/createApp.js');
    const pushService = readProjectFile('../local-api/src/domain/notifications/ozonPushNotificationService.js');

    expect(notificationCenter).toContain('直接说明哪个订单或商品发生了什么变化');
    expect(notificationCenter).toContain('暂时没有新的订单、商品或售后变化');
    expect(notificationCenter).not.toContain('同步订单变化');
    expect(notificationCenter).not.toContain('页面实时发现');
    expect(appSource).not.toContain('visibleOrderNotifications');
    expect(localApp).toContain('requestUrl.pathname === OZON_PUSH_SINK_PATH');
    expect(pushService).toContain('OZON_PUSH_SIGNATURE_INVALID');
    expect(pushService).toContain('TYPE_FBO_POSTING_NEW');
  });

  it('shows exact event, product, value change and occurrence time instead of a generic notice', () => {
    const notificationCenter = readProjectFile('src/app/shell/NotificationCenterPopover.jsx');
    const formatter = readProjectFile('src/app/shell/notificationEventFormatter.js');
    const styles = readProjectFile('src/styles.css');

    expect(notificationCenter).toContain('formatNotificationEvent(notification)');
    expect(notificationCenter).toContain('发生时间：');
    expect(notificationCenter).toContain('SKU/货号：');
    expect(notificationCenter).toContain('notification-product-image');
    expect(notificationCenter).toContain('notification-change-line');
    expect(formatter).toContain('return `${orderPrefix} 已发货`');
    expect(formatter).toContain('return `${orderPrefix} 已退款${refundFacts.amount');
    expect(formatter).toContain("label: '退款金额'");
    expect(formatter).toContain("label: '退款原因'");
    expect(formatter).toContain("label: '销售价'");
    expect(formatter).toContain("label: '库存'");
    expect(styles).toContain('.notification-product-image');
    expect(styles).toContain('.notification-fact-list');
  });

  it('keeps returns in the SQLite ledger and adds the push-backed buyer-message domain', () => {
    const notificationCenter = readProjectFile('src/app/shell/NotificationCenterPopover.jsx');
    const afterSalesSnapshot = readProjectFile('src/entities/profit/profitAfterSalesSnapshot.jsx');

    expect(notificationCenter).toContain("{ domain: 'returns', title: '售后处理'");
    expect(notificationCenter).toContain("{ domain: 'customer', title: '买家消息'");
    expect(notificationCenter).not.toContain('normalizeLocalOrderNotifications');
    expect(afterSalesSnapshot).not.toContain("startsWith('after-sales:')");
  });
});
