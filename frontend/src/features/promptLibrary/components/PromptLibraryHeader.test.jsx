import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptLibraryHeader } from './PromptLibraryHeader.jsx';

describe('PromptLibraryHeader shop selector', () => {
  it('replaces the retired safety entry with the current dynamic shop selector', () => {
    const onShopChange = vi.fn();
    render(
      <PromptLibraryHeader
        shopOptions={[
          { shopId: 'shop-1', displayName: 'Ozon 1店', shopExternalId: '1001' },
          { shopId: 'shop-2', displayName: 'Ozon 2店', shopExternalId: '1002' },
        ]}
        selectedShopId="shop-1"
        onShopChange={onShopChange}
        onShowAll={() => {}}
        onCreateTool={() => {}}
      />
    );

    expect(screen.queryByRole('button', { name: '安全规则' })).not.toBeInTheDocument();
    const selector = screen.getByRole('combobox', { name: '智能工具当前店铺' });
    expect(selector).toHaveTextContent('Ozon 1店');
    fireEvent.mouseDown(selector);
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Ozon 2店'));
    expect(onShopChange).toHaveBeenCalledWith('shop-2');
  });
});
