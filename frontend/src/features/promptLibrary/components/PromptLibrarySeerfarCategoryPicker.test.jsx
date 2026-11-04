import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadOptions: vi.fn(),
}));

vi.mock('../services/smartToolSeerfarCategoryService.js', () => ({
  loadSmartToolSeerfarCategoryOptions: mocks.loadOptions,
}));

import { PromptLibrarySeerfarCategoryPicker } from './PromptLibrarySeerfarCategoryPicker.jsx';

describe('PromptLibrarySeerfarCategoryPicker', () => {
  it('保持输入焦点并按中文搜索类目', async () => {
    const onChange = vi.fn();
    mocks.loadOptions.mockResolvedValue({
      nodes: [{
        id: '15621031_200000933_93182',
        parentId: '15621031_200000933',
        cnTitle: '连衣裙',
        title: 'Платье',
        pathText: '服装 / 连衣裙',
        hasChildren: false,
      }],
    });

    render(
      <PromptLibrarySeerfarCategoryPicker
        label="Seerfar 类目 ID"
        onChange={onChange}
      />
    );

    const input = screen.getByLabelText('Seerfar 类目 ID');
    input.focus();
    fireEvent.change(input, { target: { value: '连衣裙' } });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('连衣裙');

    await waitFor(() => expect(mocks.loadOptions).toHaveBeenCalledWith(expect.objectContaining({
      query: '连衣裙',
      parentId: '0',
      limit: 80,
    })));
    fireEvent.click(await screen.findByText('连衣裙'));
    expect(onChange).toHaveBeenCalledWith('15621031_200000933_93182');
  });
});
