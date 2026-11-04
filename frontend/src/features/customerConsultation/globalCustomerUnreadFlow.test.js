import appSource from '../../App.jsx?raw';
import pageModelSource from './model/useCustomerConsultationPageModel.js?raw';
import pageSource from './CustomerConsultationPage.jsx?raw';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

describe('global customer unread flow wiring', () => {
  it('keeps the listener global and opens the exact unread shop/chat from the badge', () => {
    expect(appSource).toContain('<CustomerGlobalUnreadBridge');
    expect(appSource).toContain('snapshotRequest={customerUnreadRefreshRequest}');
    expect(appSource).toContain('setCustomerConversationOpenTarget({');
    expect(appSource).toContain("selectWorkspaceTab('customer-consultation')");
    expect(appSource).toContain('<GlobalCustomerUnreadBadge');
  });

  it('uses only observed Ozon customer push bindings and accepts the page readback snapshot', () => {
    expect(appSource).toContain('...snapshot,');
    expect(pageSource).toContain('onUnreadChange?.(pageModel.globalUnreadSnapshot)');
    expect(pageModelSource).toContain('buildCustomerShopUnreadSnapshot');
  });

  it('resets hidden list filters and selects the exact pushed conversation', () => {
    expect(appSource).toContain('openTarget={customerConversationOpenTarget}');
    expect(pageSource).toContain('openTarget = null');
    expect(pageModelSource).toContain('targetShopId !== activeShopId');
    expect(pageModelSource).toContain('row.chatId === targetChatId');
    expect(pageModelSource).toContain("selectFilter('all')");
    expect(pageModelSource).toContain("selectStatus('all')");
    expect(pageModelSource).toContain('setUnreadOnly(false)');
    expect(pageModelSource).toContain('selectConversation(matching.id)');
  });

  it('uses a fixed high-definition assistant badge that cannot move with workspace scaling', () => {
    expect(styles).toContain('.global-customer-unread-badge {');
    expect(styles).toContain('position: fixed;');
    expect(styles).toContain('.global-customer-unread-badge-button img {');
  });
});
