import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowSellerDefensePage } from './FollowSellerDefensePage.jsx';
import pageSource from './FollowSellerDefensePage.jsx?raw';
import appSource from '../../App.jsx?raw';
import { useFollowSellerDefense } from './model/useFollowSellerDefense.js';

vi.mock('./model/useFollowSellerDefense.js', () => ({
  useFollowSellerDefense: vi.fn(),
}));

function flow(overrides = {}) {
  return {
    activeShop: { id: 'shop-1', name: 'Ozon 一店' },
    loginProfiles: [{
      id: 'follow-login-1',
      platformName: 'Ozon 前台巡查 1',
      connected: true,
    }],
    selectedLoginProfileId: 'follow-login-1',
    selectedLoginProfile: { id: 'follow-login-1', platformName: 'Ozon 前台巡查 1', connected: true },
    loginReady: true,
    loginPendingProfileId: '',
    overview: { cases: [], patrols: [], counts: { total: 0 } },
    currentPatrol: null,
    currentCases: [],
    progress: { done: 0, total: 0, failed: 0 },
    scheme1Progress: [],
	scheme1BrowserAvailable: false,
	scheme1BrowserOpening: false,
    operationBrowserAvailable: false,
    operationBrowserOpening: false,
    operationBrowserVisible: false,
    retryCaptureCount: 0,
    busyAction: '',
    error: '',
    notice: '',
    clearFeedback: vi.fn(),
    refresh: vi.fn().mockResolvedValue({ ok: true }),
    refreshLoginProfiles: vi.fn().mockResolvedValue({ ok: true }),
    chooseLoginProfile: vi.fn().mockResolvedValue({ ok: true }),
    createLoginProfile: vi.fn().mockResolvedValue({ ok: true }),
    openLoginProfile: vi.fn().mockResolvedValue({ ok: true }),
    scanManual: vi.fn().mockResolvedValue({ ok: true }),
    scanShop: vi.fn().mockResolvedValue({ ok: true }),
    retryFailedCaptures: vi.fn().mockResolvedValue({ ok: true }),
    cancelScan: vi.fn().mockReturnValue(true),
    cancelCurrentTask: vi.fn().mockReturnValue(true),
    canStopTask: false,
    prepare: vi.fn().mockResolvedValue({ ok: true }),
    confirm: vi.fn().mockResolvedValue({ ok: true }),
    resume: vi.fn().mockResolvedValue({ ok: true }),
	recheck: vi.fn().mockResolvedValue({ ok: true }),
	continueScheme1: vi.fn().mockResolvedValue({ ok: true }),
	showScheme1Browser: vi.fn().mockResolvedValue({ ok: true }),
    toggleOperationBrowser: vi.fn().mockResolvedValue({ ok: true }),
    runScheme1: vi.fn().mockResolvedValue({ ok: true }),
    runScheme2: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

describe('FollowSellerDefensePage', () => {
  beforeEach(() => useFollowSellerDefense.mockReturnValue(flow()));

  it('uses a full-width workspace with compact control corners', () => {
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);

    expect(screen.getByTestId('follow-seller-defense-page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新增前台账号' })).toHaveStyle({ borderRadius: '6px' });
    expect(screen.getByLabelText('Ozon 店铺').closest('.MuiOutlinedInput-root')).toHaveStyle({ borderRadius: '6px' });
  });

  it('shows the configured internal shop alias instead of the generated shop id', () => {
    render(<FollowSellerDefensePage shops={[{
      id: 'ozon-shop-example-02',
      name: 'ozon-shop-example-02',
      shopAlias: '俄罗斯主店',
    }]} activeShopId="ozon-shop-example-02" />);

    expect(screen.getByLabelText('Ozon 店铺')).toHaveTextContent('俄罗斯主店');
    expect(screen.queryByText('ozon-shop-example-02')).not.toBeInTheDocument();
  });

  it('removes the top refresh shortcut and keeps the table action column aligned', () => {
    useFollowSellerDefense.mockReturnValue(flow({
      currentCases: [{
        id: 'case-alignment-1',
        productName: '列宽对齐测试商品',
        productId: 'product-alignment-1',
        offerId: 'OFFER-ALIGNMENT-1',
        sku: '9000000001',
        status: 'verification_ready',
        followCountBefore: 2,
      }],
    }));
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);

    expect(screen.queryByRole('button', { name: '刷新记录' })).not.toBeInTheDocument();

    const table = screen.getByRole('table', { name: '跟卖巡查结果' });
    expect(pageSource).toContain("tableLayout: 'fixed'");
    expect(pageSource).toContain("overflowX: 'hidden'");
    expect(pageSource).toContain("width: '100%'");
    expect(pageSource).toContain('minWidth: 0');
    expect(Array.from(table.querySelectorAll('col')).map((column) => column.style.width)).toEqual([
      '4%',
      '28%',
      '19%',
      '7%',
      '12%',
      '14%',
      '16%',
    ]);

    expect(screen.getByRole('columnheader', { name: '处理状态' })).not.toHaveClass('MuiTableCell-alignCenter');
    expect(screen.getByRole('columnheader', { name: '操作' })).toHaveClass('MuiTableCell-alignCenter');
    expect(screen.getByTestId('follow-seller-status-label').closest('td')).not.toHaveClass('MuiTableCell-alignCenter');
    const actionButton = screen.getByRole('button', { name: '复查剔除结果' });
    expect(actionButton.closest('td')).toHaveClass('MuiTableCell-alignCenter');
    expect(actionButton.parentElement).toHaveStyle({ justifyContent: 'center' });
    expect(table.querySelector('.MuiChip-root')).toBeNull();
    expect(within(table).getByTestId('follow-seller-status-label')).toHaveTextContent('待复查结果');
  });

  it('offers a standalone recheck without replacing the complaint continuation action', () => {
    const currentFlow = flow({
      currentCases: [{
        id: 'case-recheck-1',
        productName: '单独复查商品',
        productId: 'product-recheck-1',
        offerId: 'OFFER-RECHECK-1',
        sku: '9000000099',
        status: 'submission_failed',
        followCountBefore: 2,
        writePayload: { workflow: 'ozon-seller-backend-content-complaint-v2' },
      }],
    });
    useFollowSellerDefense.mockReturnValue(currentFlow);
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);

    fireEvent.click(screen.getByRole('button', { name: '单独复查' }));
    expect(currentFlow.recheck).toHaveBeenCalledWith('case-recheck-1');
    expect(screen.getByRole('button', { name: '继续剔除' })).toBeInTheDocument();
  });

  it('keeps the follow-seller shop independent from the settings gear shop', () => {
    expect(appSource).toContain('const [followSellerShopId, setFollowSellerShopId] = React.useState(() => activeOzonShopId)');
    expect(appSource).toMatch(/<FollowSellerDefensePage[\s\S]*?activeShopId=\{followSellerShopId\}[\s\S]*?onActiveShopChange=\{setFollowSellerShopId\}/u);
    expect(appSource).toMatch(/setFollowSellerShopId\(\(current\) => \{[\s\S]*?readableOzonShops\.some\(\(shop\) => shop\.id === current\)[\s\S]*?return current/u);
  });

  it('keeps both processing schemes in the top tab bar and aligns the selected indicator', () => {
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);

    const topActions = screen.getByTestId('follow-seller-top-actions');
	    expect(within(topActions).getByRole('button', { name: '方案1：完整流程投诉' })).toBeInTheDocument();
    expect(within(topActions).getByRole('button', { name: '方案2：全自动提交证据' })).toBeInTheDocument();
	    expect(screen.getAllByRole('button', { name: '方案1：完整流程投诉' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '方案2：全自动提交证据' })).toHaveLength(1);

    const tabs = screen.getByRole('tab', { name: '单货号处理' }).closest('.MuiTabs-root');
    expect(tabs).toHaveStyle({ marginLeft: '16px' });
    expect(tabs).not.toHaveStyle({ paddingLeft: '16px' });

    fireEvent.click(screen.getByRole('tab', { name: '查看被跟卖（0）' }));
	    expect(screen.getAllByRole('button', { name: '方案1：完整流程投诉' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '方案2：全自动提交证据' })).toHaveLength(1);
  });

  it('keeps every page action row evenly spaced, wrap-safe, and free of joined button groups', () => {
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);

    const expectStableActionRow = (testId) => {
      const row = screen.getByTestId(testId);
      expect(within(row).queryAllByRole('button').length).toBeGreaterThan(0);
      expect(row.querySelector('.MuiButtonGroup-root')).toBeNull();
    };

    expect(pageSource).toContain('const FOLLOW_SELLER_ACTION_GAP = 1');
    expect(pageSource).toContain("flexShrink: 0,\n          whiteSpace: 'nowrap'");
	expect(pageSource.match(/spacing=\{FOLLOW_SELLER_ACTION_GAP\}/gu)).toHaveLength(7);
    expect(pageSource).not.toContain('<ButtonGroup');
    expectStableActionRow('follow-seller-top-actions');
    expectStableActionRow('follow-seller-manual-actions');

    fireEvent.click(screen.getByRole('tab', { name: '全店巡查' }));
    expectStableActionRow('follow-seller-patrol-actions');

    fireEvent.click(screen.getByRole('tab', { name: '查看被跟卖（0）' }));
    expectStableActionRow('follow-seller-saved-actions');

    fireEvent.click(screen.getByRole('tab', { name: '任务记录' }));
    expectStableActionRow('follow-seller-task-actions');
  });

  it('keeps the one-identifier entry and shop patrol entry separate', () => {
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);
    expect(screen.getByLabelText('货号 / Ozon SKU / 商品 ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '检查跟卖' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '全店巡查' }));
    expect(screen.getByRole('button', { name: '一键巡查全店' })).toBeInTheDocument();
    expect(screen.getByText(/独立隐藏浏览器完成后自动关闭/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '查看被跟卖（0）' })).toBeInTheDocument();
  });

  it('shows a separate saved patrol login selector and login actions', () => {
    const mockedFlow = flow();
    useFollowSellerDefense.mockReturnValue(mockedFlow);
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);

    expect(screen.getByLabelText('Ozon 前台巡查账号')).toHaveTextContent('Ozon 前台巡查 1');
    fireEvent.click(screen.getByRole('button', { name: '新增前台账号' }));
    expect(mockedFlow.createLoginProfile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }));
    expect(mockedFlow.openLoginProfile).toHaveBeenCalledTimes(1);
  });

  it('offers a real stop action while a full-shop patrol is running', () => {
    const mockedFlow = flow({
      busyAction: 'scanning',
      progress: { done: 100, total: 1808, failed: 2 },
      currentCases: [{
        id: 'case-1',
        offerId: 'OFFER-1',
        sku: '900000001',
        status: 'clear',
      }],
    });
    useFollowSellerDefense.mockReturnValue(mockedFlow);
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);
    fireEvent.click(screen.getByRole('tab', { name: '全店巡查' }));
    expect(screen.getByText('100/1808，失败 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '停止巡查' }));
    expect(mockedFlow.cancelScan).toHaveBeenCalledTimes(1);
  });

  it('shows one unified stop button beside saved-result detection and cancels the active task', () => {
    const mockedFlow = flow({
      busyAction: 'scheme1-submitting',
      canStopTask: true,
    });
    useFollowSellerDefense.mockReturnValue(mockedFlow);
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);

    fireEvent.click(screen.getByRole('tab', { name: '查看被跟卖（0）' }));
    const actions = screen.getByTestId('follow-seller-saved-actions');
    const stopButton = within(actions).getByRole('button', { name: '停止任务' });
    expect(stopButton).toBeEnabled();
    fireEvent.click(stopButton);
    expect(mockedFlow.cancelCurrentTask).toHaveBeenCalledTimes(1);
  });

  it('shows one-click retry for failed patrol rows and runs only after failures exist', () => {
    const mockedFlow = flow({ retryCaptureCount: 12 });
    useFollowSellerDefense.mockReturnValue(mockedFlow);
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);
    fireEvent.click(screen.getByRole('tab', { name: '全店巡查' }));
    fireEvent.click(screen.getByRole('button', { name: '一键重试巡查失败（12）' }));
    expect(mockedFlow.retryFailedCaptures).toHaveBeenCalledTimes(1);
  });

  it('selects and clears every processable saved followed row with two batch buttons', () => {
    useFollowSellerDefense.mockReturnValue(flow({
      overview: {
        counts: { total: 4, detected: 2 },
        patrols: [],
        cases: [
          { id: 'case-1', offerId: 'OFFER-1', sku: '900000001', status: 'detected' },
          { id: 'case-2', offerId: 'OFFER-2', sku: '900000002', status: 'submission_failed' },
          { id: 'case-3', offerId: 'OFFER-3', sku: '900000003', status: 'submission_ready' },
          { id: 'case-4', offerId: 'OFFER-4', sku: '900000004', status: 'clear' },
        ],
      },
    }));
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);
    fireEvent.click(screen.getByRole('tab', { name: '查看被跟卖（3）' }));

    fireEvent.click(screen.getByRole('button', { name: '取消全选' }));
    expect(screen.getByRole('checkbox', { name: '选择 OFFER-1' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 OFFER-2' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 OFFER-3' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByRole('checkbox', { name: '选择 OFFER-1' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 OFFER-2' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 OFFER-3' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: '选择 OFFER-4' })).not.toBeInTheDocument();
  });

  it('opens saved followed results without starting another patrol', () => {
    const mockedFlow = flow({
      overview: {
        counts: { total: 3, detected: 2 },
        patrols: [{ id: 'patrol-previous' }],
        cases: [
          { id: 'case-1', offerId: 'FOLLOWED-1', sku: '900000001', status: 'detected', followCountBefore: 3 },
          { id: 'case-2', offerId: 'CLEAR-1', sku: '900000002', status: 'clear', followCountBefore: 0 },
          { id: 'case-3', offerId: 'FOLLOWED-2', sku: '900000003', status: 'detached', followCountBefore: 1 },
        ],
      },
      currentCases: [],
    });
    useFollowSellerDefense.mockReturnValue(mockedFlow);
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);
    fireEvent.click(screen.getByRole('tab', { name: '查看被跟卖（2）' }));

    expect(screen.getByText('FOLLOWED-1')).toBeInTheDocument();
    expect(screen.getByText('FOLLOWED-2')).toBeInTheDocument();
    expect(screen.queryByText('CLEAR-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('scheme1-live-progress')).toHaveTextContent('点击方案1后，这里会显示浏览器的真实操作步骤');
    expect(screen.queryByText(/不会重新扫描，也不会打开巡查浏览器/)).not.toBeInTheDocument();
    expect(screen.getByTestId('followed-product-count')).toHaveTextContent('2');
    expect(mockedFlow.scanShop).not.toHaveBeenCalled();
  });

  it('keeps saved-product search as filtering only and removes duplicate detection', () => {
    const detectedCase = {
      id: 'case-search-2',
      productName: 'Toyota ignition switch',
      productId: '5461014640',
      offerId: 'SKU-202607122203-01-01',
      sku: '5045028848',
      status: 'detected',
      followCountBefore: 9,
    };
    const mockedFlow = flow({
      overview: {
        counts: { total: 2, detected: 2 },
        patrols: [],
        cases: [
          {
            id: 'case-search-1',
            productName: 'Chevrolet trim',
            productId: '5477782714',
            offerId: 'SKU-202607140433-01-07',
            sku: '5059279117',
            status: 'detected',
            followCountBefore: 11,
          },
          detectedCase,
        ],
      },
    });
    useFollowSellerDefense.mockReturnValue(mockedFlow);
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);
    fireEvent.click(screen.getByRole('tab', { name: '查看被跟卖（2）' }));

    const search = screen.getByLabelText('搜索货号 / SKU / 商品 ID / 商品名');
    fireEvent.change(search, { target: { value: '5045028848' } });
    expect(screen.getByText('SKU-202607122203-01-01')).toBeInTheDocument();
    expect(screen.queryByText('SKU-202607140433-01-07')).not.toBeInTheDocument();

    expect(screen.queryByRole('button', { name: '检测并选中' })).not.toBeInTheDocument();
    expect(mockedFlow.scanManual).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 SKU-202607122203-01-01' }));

    fireEvent.click(screen.getByRole('button', { name: '为已选商品生成处理预览' }));
    expect(mockedFlow.prepare).toHaveBeenCalledWith(['case-search-2']);
  });

  it('shows real scheme1 progress and converts historical native failures to plain Chinese', () => {
    useFollowSellerDefense.mockReturnValue(flow({
      busyAction: 'scheme1-submitting',
      scheme1Progress: [
        { id: 'p-1', stage: 'select:product-prices', status: 'running', message: '正在选择“商品和价格”', at: '2026-08-16T15:00:00.000Z' },
        { id: 'p-2', stage: 'send:original-sku', status: 'running', message: '正在发送我方商品 SKU：5059279142', offerId: 'SKU-1', at: '2026-08-16T15:00:01.000Z' },
      ],
      overview: {
        counts: { total: 1, submission_failed: 1 },
        patrols: [],
        cases: [{
          id: 'case-1',
          offerId: 'SKU-1',
          sku: '5059279142',
          status: 'submission_failed',
          followCountBefore: 3,
          lastErrorMessage: "Error invoking remote method 'desktop:purchase-browser-command': Error: PURCHASE_BROWSER_CEF_FAILED",
        }],
      },
    }));
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);
    fireEvent.click(screen.getByRole('tab', { name: '查看被跟卖（1）' }));

    expect(screen.getByTestId('scheme1-live-progress')).toHaveTextContent('正在选择“商品和价格”');
    expect(screen.getByTestId('scheme1-live-progress')).toHaveTextContent('正在发送我方商品 SKU：5059279142');
    expect(screen.getByText('内置浏览器运行失败')).toBeInTheDocument();
    expect(screen.queryByText('内置浏览器运行失败，本次材料已保留，请重新提交。')).not.toBeInTheDocument();
    expect(screen.queryByText(/PURCHASE_BROWSER_CEF_FAILED/)).not.toBeInTheDocument();
  });

  it('moves scheme1 feedback into the progress panel and removes duplicate top alerts', () => {
    const message = '我方或跟卖商品页面没有完整打开，系统没有使用空白截图，请检查网络后重试。';
    useFollowSellerDefense.mockReturnValue(flow({
      error: message,
      notice: '已显示方案1正在使用的内置浏览器。',
      scheme1Progress: [
        { id: 'p-1', stage: 'prepare-evidence', status: 'running', message: '正在核对证据页面', at: '2026-08-22T17:11:49.000Z' },
        { id: 'p-2', stage: 'failed', status: 'failed', message, offerId: 'WZ-5836165085694', at: '2026-08-22T17:11:50.000Z' },
        { id: 'p-3', stage: 'failed', status: 'failed', message, offerId: 'WZ-5836165085694', at: '2026-08-22T17:11:50.000Z' },
      ],
      overview: {
        counts: { total: 1, submission_failed: 1 },
        patrols: [],
        cases: [{ id: 'case-1', offerId: 'WZ-5836165085694', sku: '5059279142', status: 'submission_failed', followCountBefore: 3 }],
      },
    }));
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);
    fireEvent.click(screen.getByRole('tab', { name: '查看被跟卖（1）' }));

    const panel = screen.getByTestId('scheme1-live-progress');
    expect(within(screen.getByTestId('scheme1-feedback')).getByText(message)).toBeInTheDocument();
    expect(within(panel).getAllByText(message)).toHaveLength(1);
    expect(screen.queryByRole('alert', { name: message })).not.toBeInTheDocument();
    expect(panel).toHaveTextContent('正在核对证据页面');
  });

	it('reveals the running scheme1 native browser from the visualization button', () => {
	  const mockedFlow = flow({
		busyAction: 'scheme1-submitting',
		scheme1BrowserAvailable: true,
		operationBrowserAvailable: true,
	  });
	  useFollowSellerDefense.mockReturnValue(mockedFlow);
	  render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);

	  fireEvent.click(screen.getByRole('button', { name: '可视化操作页面' }));
	  expect(mockedFlow.toggleOperationBrowser).toHaveBeenCalledTimes(1);
	});

	it('uses the visualization button to hide the same visible recheck browser', () => {
	  const mockedFlow = flow({
		operationBrowserAvailable: true,
		operationBrowserVisible: true,
	  });
	  useFollowSellerDefense.mockReturnValue(mockedFlow);
	  render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);

	  fireEvent.click(screen.getByRole('button', { name: '隐藏操作页面' }));
	  expect(mockedFlow.toggleOperationBrowser).toHaveBeenCalledTimes(1);
	});

	it('shows continue removal for a failed scheme 1 ticket and resumes that exact case', () => {
	  const mockedFlow = flow({
		overview: {
		  counts: { total: 1, submission_failed: 1 },
		  patrols: [],
		  cases: [{
			id: 'case-continue-1',
			offerId: 'SKU-CONTINUE-1',
			sku: '5059279117',
			status: 'submission_failed',
			followCountBefore: 3,
			writePayload: { workflow: 'ozon-seller-backend-content-complaint-v2' },
		  }],
		},
	  });
	  useFollowSellerDefense.mockReturnValue(mockedFlow);
	  render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);
	  fireEvent.click(screen.getByRole('tab', { name: '查看被跟卖（1）' }));

	  fireEvent.click(screen.getByRole('button', { name: '继续剔除' }));
	  expect(mockedFlow.continueScheme1).toHaveBeenCalledWith('case-continue-1');
	});

  it('shows batch selection in task records and retries only selected capture failures', () => {
    const mockedFlow = flow({
      overview: {
        counts: { total: 2, capture_failed: 1 },
        patrols: [{ id: 'patrol-1', failedCount: 1 }],
        cases: [
          { id: 'failed-1', offerId: 'FAILED-1', sku: '930000001', status: 'capture_failed' },
          { id: 'clear-1', offerId: 'CLEAR-1', sku: '930000002', status: 'clear' },
        ],
      },
      retryCaptureCount: 1,
    });
    useFollowSellerDefense.mockReturnValue(mockedFlow);
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);
    fireEvent.click(screen.getByRole('tab', { name: '任务记录' }));

    expect(screen.getByRole('button', { name: '全选' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消全选' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByRole('checkbox', { name: '选择 FAILED-1' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 CLEAR-1' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试所选巡查失败（1）' }));
    expect(mockedFlow.retryFailedCaptures).toHaveBeenCalledWith(['failed-1']);

    fireEvent.click(screen.getByRole('button', { name: '取消全选' }));
    expect(screen.getByRole('checkbox', { name: '选择 FAILED-1' })).not.toBeChecked();
  });

  it('anchors the selected underline to each tab instead of the scrollable tabs track', () => {
    useFollowSellerDefense.mockReturnValue(flow());
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);

    expect(screen.getByTestId('follow-seller-native-tab-indicator')).toHaveStyle({ display: 'none' });
    const taskTab = screen.getByRole('tab', { name: '任务记录' });
    fireEvent.click(taskTab);
    expect(taskTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '单货号处理' })).toHaveAttribute('aria-selected', 'false');
  });

  it('shows the exact support complaint pair and blocks submit while original evidence is missing', () => {
    const item = {
      id: 'case-1',
      offerId: 'yy6970_ob_vJ6xY',
      sku: '3603974961',
      productId: '101',
      productName: '测试商品',
      status: 'preview_ready',
      previewId: 'preview-1',
      groupOfferIds: ['3771432837'],
      writePayload: {
        workflow: 'ozon-support-content-complaint',
        route: ['创建申请', '商品和价格', '质量监督', '卖家使用我的内容'],
        originalSku: '3603974961',
        followerSkus: ['3771432837'],
        sellers: [{ sku: '3771432837', sellerId: '4127044', sellerName: 'fanyuyanshaung' }],
        evidence: { status: 'missing', files: [] },
        submissionReady: false,
        blockedReason: '请补充能证明原创关系的分层源文件或原始设计文件。',
      },
    };
    const mockedFlow = flow({ currentCases: [item] });
    useFollowSellerDefense.mockReturnValue(mockedFlow);
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);

    fireEvent.click(screen.getByRole('button', { name: '查看并确认' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('创建申请');
    expect(dialog).toHaveTextContent('卖家使用我的内容');
    expect(dialog).toHaveTextContent('3603974961');
    expect(dialog).toHaveTextContent('3771432837');
    expect(dialog).toHaveTextContent('fanyuyanshaung · ID 4127044');
    expect(dialog).not.toHaveTextContent('9048');

    expect(screen.getByRole('button', { name: '缺少原创证据，暂不提交' })).toBeDisabled();
    expect(mockedFlow.confirm).not.toHaveBeenCalled();
  });

  it('offers one product follow-count verification instead of support readback', () => {
    const mockedFlow = flow({
      currentCases: [{
        id: 'case-1',
        offerId: 'OFFER-1',
        sku: '900000001',
        status: 'verification_ready',
      }],
    });
    useFollowSellerDefense.mockReturnValue(mockedFlow);
    render(<FollowSellerDefensePage shops={[{ id: 'shop-1', name: 'Ozon 一店' }]} activeShopId="shop-1" />);
    expect(screen.getByText('待复查结果')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '复查剔除结果' }));
    expect(mockedFlow.resume).toHaveBeenCalledWith('case-1');
  });
});
