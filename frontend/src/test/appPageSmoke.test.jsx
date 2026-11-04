import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import App from '../App.jsx';
import { appTheme } from '../theme.js';

vi.mock('../shared/ui/CommunityChart.jsx', async () => {
  const ReactModule = await import('react');
  return {
    default: function MockCommunityChart() {
      return ReactModule.default.createElement('div', { 'data-testid': 'apex-chart' });
    },
  };
});

const pageSmokeCases = [
  { navLabel: '旺崽汇总', expectedContent: /旺崽汇总|销售与利润趋势/u },
  { navLabel: '商品列表', expectedContent: /商品列表|商品总览/u },
  { navLabel: '剔除跟卖', expectedContent: /剔除跟卖|单货号处理/u },
  { navLabel: '销售订单', expectedContent: /销售订单|订单列表/u },
  { navLabel: '售后订单', expectedContent: /售后订单|售后订单列表/u },
  { navLabel: '待处理单', expectedContent: /待处理单|售后订单列表/u },
  { navLabel: '拍单管理', expectedContent: /拍单管理|拍单列表/u },
  { navLabel: '打单发货', expectedContent: /打单发货|打印面单/u },
  { navLabel: '自动拍单', expectedContent: /自动拍单|自动流程/u },
  { navLabel: '仓储物流', expectedContent: /仓储物流|库存|物流/u },
  { navLabel: '营销活动', expectedContent: /营销活动|活动列表/u },
  { navLabel: '付费推广', expectedContent: /付费推广|广告/u },
  { navLabel: '订单利润', parentLabel: '利润核算', expectedContent: /利润核算|经营损益/u },
  { navLabel: '利润报表', parentLabel: '利润核算', expectedContent: /利润报表|结算明细/u },
  { navLabel: '数据分析', expectedContent: /数据分析|经营报告/u },
  { navLabel: '在线客服', parentLabel: '客服咨询', expectedContent: /在线客服|买家聊天|商品问答/u },
  { navLabel: '智能回复', parentLabel: '客服咨询', expectedContent: /智能回复|催护照|催取货/u },
  { navLabel: '智能工具', expectedContent: /智能工具|工具列表/u },
  { navLabel: '采集核价', expectedContent: /商品采集|采购来源商品/u },
  { navLabel: '积分套餐', expectedContent: /积分套餐|充值套餐|AI 额度充值/u },
  { navLabel: '数据备份', expectedContent: /数据备份|备份/u },
];

class TestErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-error-fallback">
          <strong>页面显示异常</strong>
          <span>{this.state.error?.message || 'unknown error'}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createGenericFetchResponse(url) {
  const text = String(url);
  if (text.includes('/api/shops')) {
    return { ok: true, shops: [] };
  }
  if (text.includes('/api/cache/dashboard-business-share')) {
    return {
      ok: true,
      source: 'sqlite',
      counts: { salesOrderCount: 0, pendingPurchaseCount: 0, afterSalesTodoCount: 0, stockWarningCount: 0 },
    };
  }
  if (text.includes('/api/cache/orders')) {
    return { ok: true, rows: [], total: 0, source: 'sqlite' };
  }
  if (text.includes('/api/cache/returns')) {
    return { ok: true, rows: [], returns: [], total: 0, source: 'sqlite' };
  }
  if (text.includes('/api/cache/products')) {
    return { ok: true, rows: [], total: 0, source: 'sqlite' };
  }
  if (text.includes('/api/cache/marketing')) {
    return { ok: true, rows: [], total: 0, source: 'sqlite' };
  }
  if (text.includes('/api/cache/finance') || text.includes('/api/cache/profit')) {
    return { ok: true, rows: [], total: 0, source: 'sqlite' };
  }
  if (text.includes('/api/sync/')) {
    return { ok: true, accepted: true, jobId: 'smoke-job', status: 'queued' };
  }
  if (text.includes('/local-data-api/')) {
    return { ok: true, data: {} };
  }
  return { ok: true, rows: [], total: 0, result: {}, data: {} };
}

function renderAppForSmoke() {
  return render(
    <ThemeProvider theme={appTheme}>
      <CssBaseline />
      <TestErrorBoundary>
        <App />
      </TestErrorBoundary>
    </ThemeProvider>
  );
}

function clickSidebarPage(label) {
  const candidates = [...document.querySelectorAll('.subnav-item, .nav-item, button, [role="button"]')];
  const target =
    candidates.find((node) => node.textContent?.trim() === label) ||
    candidates.find((node) => node.textContent?.includes(label));
  if (!target) {
    throw new Error(`未找到页面入口：${label}`);
  }
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function expectAppNotCrashed(expectedContent) {
  await waitFor(
    () => {
      expect(document.body).not.toHaveTextContent('页面显示异常');
      expect(document.querySelector('.content-shell')).toHaveTextContent(expectedContent);
    },
    { timeout: 5000 }
  );
}

describe('App page smoke guard', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => jsonResponse(createGenericFetchResponse(url)))
    );
    vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0));
    vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
    window.matchMedia ??= vi.fn().mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      const text = args.map((item) => String(item?.message || item)).join(' ');
      if (/ReferenceError|TypeError|The above error occurred|AppErrorBoundary/u.test(text)) {
        throw new Error(`页面运行时错误：${text}`);
      }
    });
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  it('opens every main workspace page without entering the error boundary', async () => {
    renderAppForSmoke();
    await expectAppNotCrashed(pageSmokeCases[0].expectedContent);

    for (const pageCase of pageSmokeCases) {
      if (pageCase.parentLabel) {
        const parent = [...document.querySelectorAll('.nav-item, button, [role="button"]')]
          .find((node) => node.textContent?.trim() === pageCase.parentLabel);
        if (parent?.getAttribute('aria-expanded') === 'false') clickSidebarPage(pageCase.parentLabel);
      }
      clickSidebarPage(pageCase.navLabel);
      await expectAppNotCrashed(pageCase.expectedContent);
    }
  }, 30000);

});
