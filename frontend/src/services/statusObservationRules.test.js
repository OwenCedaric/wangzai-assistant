import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../test/appSource';

describe('status observation rules', () => {
  it('uses Chinese status observation wording for the Ozon and local-api monitors', () => {
    const appSource = readProjectSource('src/App.jsx');
    const popoverSource = readProjectSource('src/app/shell/StatusObservationPopover.jsx');
    const localApiClient = readProjectSource('src/api/localApiClient.js');
    const ozonRequestControl = readProjectSource('src/services/ozonRequestControl.js');
    const styles = readProjectSource('src/styles.css');
    const appConfig = readProjectSource('src/shared/config/appConfigCore.jsx');
    const settingsDialog = readProjectSource('src/features/settings/ShopSettingsDialog.jsx');

    expect(appSource).toContain('const StatusObservationPopover = lazyNamed(');
    expect(appSource).toContain("() => import('./app/shell/StatusObservationPopover.jsx'),");
    expect(appSource).toContain('<Tooltip title="运行状态">');
    expect(appSource).toContain('aria-label="运行状态"');
    expect(appSource).toContain('<StatusObservationPopover');

    expect(popoverSource).toContain('查看哪些数据正在更新、排队、失败或等待重试');
    expect(popoverSource).toContain('当前没有需要处理的问题');
    expect(popoverSource).toContain("card.userActionRequired ? '需要你操作：' : '无需操作：'");
    expect(popoverSource).toContain('退出旺崽助手后重新打开');
    expect(popoverSource).toContain('Ozon 暂时限制继续读取');
    expect(popoverSource).toContain('buildSyncJobCard');
    expect(popoverSource).toContain('buildOverviewCard');
    expect(popoverSource).toContain('buildSchedulerRunningCards');
    expect(popoverSource).toContain('buildMaintenanceObservationCards');
    expect(popoverSource).toContain("if (card.category !== 'all')");
    expect(popoverSource).toContain('已处理');
    expect(popoverSource).toContain('等待任务进度返回');
    expect(popoverSource).toContain('STATUS_OBSERVATION_CATEGORIES');
    expect(popoverSource).toContain("label: '同步进度查询'");
    expect(popoverSource).toContain("stage: '读取任务进度'");
    expect(popoverSource).toContain("text.includes('posting/fbs/list')");
    expect(popoverSource).not.toContain('LOCAL_API_TIMEOUT,');
    expect(popoverSource).not.toContain('local-api 请求超时');

    expect(localApiClient).toContain('export function getLocalApiRequestStats()');
    expect(localApiClient).toContain('export function getMaintenanceStatus(options = {})');
    expect(localApiClient).toContain('export function subscribeLocalApiRequestStats(listener)');
    expect(localApiClient).toContain('currentIssues');
    expect(localApiClient).toContain('syncJobs');
    expect(localApiClient).toContain('rememberLocalApiSyncJobs(payload)');
    expect(localApiClient).toContain('localApiActiveIssues.delete(observedPath)');
    expect(localApiClient).toContain('cancel()');
    expect(localApiClient).toContain("abortSource = 'external'");
    expect(localApiClient).toContain("abortSource === 'external'");
    expect(localApiClient).toContain('signal: controller.signal');
    expect(localApiClient).toContain('observer.cancel();');
    expect(localApiClient).toContain('options.observe === false');
    expect(localApiClient).toContain('observe: options.observe');
    expect(localApiClient).toContain('LOCAL_API_TIMEOUT');
    expect(ozonRequestControl).toContain('currentIssues');
    expect(ozonRequestControl).toContain('nextRetryAt');
    expect(ozonRequestControl).toContain('clearOzonIssue(endpoint, shopKey)');
    expect(styles).toContain('.status-observation-category-list');
    expect(styles).toContain('.status-observation-card');
    expect(styles).toContain('grid-template-rows: minmax(0, 1fr);');
    expect(styles).not.toContain('.status-observation-counts');

    expect(appConfig).toContain("{ id: 'dataMaintenance', label: '数据维护', caption: '归属 / 清理', hidden: true }");
    expect(appConfig).toContain('visibleSettingsModuleTabs = settingsModuleTabs.filter');
    expect(settingsDialog).toContain('visibleSettingsModuleTabs.map');

    const monitorBlock = appSource.slice(
      appSource.indexOf('<Tooltip title="运行状态">'),
      appSource.indexOf('<Tooltip title="通知">')
    );
    expect(monitorBlock).not.toContain('同步状态');
  });
});
