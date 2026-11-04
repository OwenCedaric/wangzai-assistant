import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CollectionProductCategoryPickerDialog } from './CollectionProductCategoryPickerDialog.jsx';

const category = {
  descriptionCategoryId: '10',
  typeId: '20',
  name: '电脑音响系统',
  pathText: '电子产品 > 音响和扬声器 > 电脑音响系统',
};

describe('CollectionProductCategoryPickerDialog', () => {
  it('shows a complete loaded template and confirms the selected leaf', () => {
    const onConfirm = vi.fn();
    render(
      <CollectionProductCategoryPickerDialog
        open
        options={[category]}
        value={category}
        templateState={{
          status: 'ready',
          categoryKey: '10:20',
          template: {
            ...category,
            shopId: 'shop-1',
            definitions: [
              { id: '1', name: '原产国', is_required: true, isDictionary: true },
              { id: '2', name: '车身材料', isDictionary: true },
              { id: '3', name: '低音炮功率', valueType: 'DECIMAL' },
            ],
            optionsByAttributeId: { 2: [{ id: '200', label: '塑料' }] },
            dictionaryLoadedIds: ['1', '2'],
            dictionaryFailedIds: [],
          },
        }}
        onConfirm={onConfirm}
        onClose={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expect(screen.getByText('已就绪：电脑音响系统')).toBeInTheDocument();
    expect(screen.getByText('系统填写：中国')).toBeInTheDocument();
    expect(screen.getByText('已加载（1）')).toBeInTheDocument();
    expect(screen.getByText('低音炮功率')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认选择' }));
    expect(onConfirm).toHaveBeenCalledWith(category);
  });

  it('searches the full path without changing the confirmed category', () => {
    const onPreview = vi.fn();
    render(
      <CollectionProductCategoryPickerDialog
        open
        options={[category]}
        templateState={{ status: 'idle', categoryKey: '', template: null }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
        onPreview={onPreview}
      />,
    );
    fireEvent.change(screen.getByLabelText('搜索类目名称'), { target: { value: '电脑音响' } });
    fireEvent.click(screen.getByRole('button', { name: category.pathText }));
    expect(onPreview).toHaveBeenCalledWith(category);
    expect(screen.getByRole('button', { name: '确认选择' })).toBeDisabled();
  });
});
