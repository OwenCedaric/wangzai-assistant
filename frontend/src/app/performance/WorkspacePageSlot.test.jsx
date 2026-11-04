import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePageSlot } from './WorkspacePageSlot.jsx';
import { workspacePerformanceRuntime } from './workspacePerformanceRuntime.js';

afterEach(() => {
  workspacePerformanceRuntime.reset();
  vi.unstubAllGlobals();
});

describe('WorkspacePageSlot', () => {
  it('reports an active page as ready on the next frame without rendering inactive content as active', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      callback();
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    workspacePerformanceRuntime.beginNavigation('products');
    const renderPage = vi.fn(() => <div>商品主体</div>);
    const { rerender } = render(<WorkspacePageSlot pageId="products" isActive renderPage={renderPage} />);

    await waitFor(() => expect(workspacePerformanceRuntime.snapshot().navigation.last).toMatchObject({ pageId: 'products' }));
    expect(renderPage).toHaveBeenCalledWith('products', true, true);

    rerender(<WorkspacePageSlot pageId="products" isActive={false} renderPage={renderPage} />);
    expect(document.querySelector('.page-panel')).toHaveAttribute('hidden');
  });

  it('updates the page factory active flag while keeping a memoized page body stable', () => {
    let renderCount = 0;
    const MemoizedPage = React.memo(function MemoizedPage() {
      renderCount += 1;
      return <div>已访问页面</div>;
    });
    const renderPage = vi.fn(() => <MemoizedPage />);
    const { rerender } = render(<WorkspacePageSlot pageId="dashboard" isActive renderPage={renderPage} />);

    rerender(<WorkspacePageSlot pageId="dashboard" isActive={false} renderPage={renderPage} />);

    expect(renderPage).toHaveBeenCalledTimes(2);
    expect(renderCount).toBe(1);
    expect(document.querySelector('.page-panel')).toHaveAttribute('hidden');
  });

  it('commits visibility separately from deferred page activity', () => {
    const renderPage = vi.fn(() => <div>已准备页面</div>);
    const { rerender } = render(
      <WorkspacePageSlot pageId="products" isActive={false} isVisible={false} renderPage={renderPage} />
    );

    rerender(
      <WorkspacePageSlot pageId="products" isActive={false} isVisible renderPage={renderPage} />
    );

    expect(document.querySelector('.page-panel')).not.toHaveAttribute('hidden');
    expect(renderPage).toHaveBeenCalledTimes(2);
    expect(renderPage).toHaveBeenLastCalledWith('products', false, true);
  });

  it('does not call a replacement page factory while the workspace remains hidden', () => {
    const initialFactory = vi.fn(() => <div>已访问页面</div>);
    const replacementFactory = vi.fn(() => <div>不应在隐藏时协调</div>);
    const { rerender } = render(<WorkspacePageSlot pageId="dashboard" isActive={false} renderPage={initialFactory} />);

    rerender(<WorkspacePageSlot pageId="dashboard" isActive={false} renderPage={replacementFactory} />);

    expect(initialFactory).toHaveBeenCalledTimes(1);
    expect(replacementFactory).not.toHaveBeenCalled();
  });

  it('pre-activates a user-requested tree during isolated layout while its wrapper stays hidden', () => {
    const renderPage = vi.fn(() => <div>待激活页面</div>);
    render(
      <WorkspacePageSlot
        pageId="products"
        isActive={false}
        isPreparing
        renderPage={renderPage}
      />
    );

    expect(renderPage).toHaveBeenCalledWith('products', true, false);
    expect(document.querySelector('.page-panel')).toHaveAttribute('hidden');
    expect(document.querySelector('.page-panel')).toHaveAttribute('data-workspace-preparing', 'true');
  });

});
