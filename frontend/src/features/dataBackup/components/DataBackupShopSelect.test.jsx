import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataBackupShopSelect } from './DataBackupShopSelect.jsx';

const shops = [{
  shopId: 'ozon-shop-internal-a',
  shopExternalId: '46000123',
  shopName: 'Ozon 官方旗舰店',
  shopAlias: '俄罗斯主店',
  displayName: '俄罗斯主店',
}, {
  shopId: 'ozon-shop-internal-b',
  shopExternalId: '46000456',
  shopName: 'Ozon 第二店',
  shopAlias: '',
  displayName: 'Ozon 第二店',
}];

describe('DataBackupShopSelect', () => {
  it('shows seller name and business shop id in both the selected field and compact popup', () => {
    const onChange = vi.fn();
    render(<DataBackupShopSelect
      idPrefix="test-backup-shop"
      label="备份店铺"
      value="ozon-shop-internal-a"
      options={shops}
      onChange={onChange}
    />);

    expect(screen.getByText('Ozon 官方旗舰店')).toBeInTheDocument();
    expect(screen.getByText(/店铺 ID：46000123/u)).toBeInTheDocument();
    expect(screen.getByText(/简称：俄罗斯主店/u)).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '备份店铺' }));
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('Ozon 官方旗舰店')).toBeInTheDocument();
    expect(within(listbox).getByText('店铺 ID：46000123')).toBeInTheDocument();
    expect(within(listbox).getByText('简称：俄罗斯主店')).toBeInTheDocument();
    expect(within(listbox).getByText('Ozon 第二店')).toBeInTheDocument();

    fireEvent.click(within(listbox).getByText('Ozon 第二店'));
    expect(onChange).toHaveBeenCalledWith('ozon-shop-internal-b');
  });
});
