import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { PromptLibraryRepeatableInputList } from './PromptLibraryRepeatableInputList.jsx';

function RepeatableInputHarness() {
  const [value, setValue] = React.useState('');
  return (
    <PromptLibraryRepeatableInputList
      tool={{ id: 'linkfox-seerfar-ozon-product-filter' }}
      label="商品关键词、SKU 或链接（可多个）"
      value={value}
      inputSpec={{ control: 'repeatable', maxItems: 20 }}
      placeholder="输入关键词、SKU 或商品链接"
      onChange={setValue}
    />
  );
}

describe('PromptLibraryRepeatableInputList', () => {
  it('keeps the add control in the first input row and uses remove controls afterwards', () => {
    render(<RepeatableInputHarness />);

    const addButton = screen.getByRole('button', {
      name: '增加商品关键词、SKU 或链接（可多个）',
    });
    const firstRow = addButton.closest('.prompt-library-repeatable-row');

    expect(firstRow).toBeTruthy();
    expect(within(firstRow).getByLabelText('商品关键词、SKU 或链接（可多个）')).toBeVisible();
    expect(screen.queryByRole('button', { name: /删除商品关键词/u })).not.toBeInTheDocument();

    fireEvent.click(addButton);

    expect(screen.getByLabelText('商品关键词、SKU 或链接（可多个） 第2条')).toBeVisible();
    expect(screen.getByRole('button', {
      name: '删除商品关键词、SKU 或链接（可多个）第2条',
    })).toBeVisible();
  });
});
