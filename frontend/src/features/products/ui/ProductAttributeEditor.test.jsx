import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProductAttributeEditor } from './ProductAttributeEditor.jsx';

describe('ProductAttributeEditor', () => {
  it('shows filled and unfilled fields from the current product scope', () => {
    const rows = [
      { id: '1', attributeId: '1', label: '品牌', value: '无品牌', filled: true, required: true },
      { id: '2', attributeId: '2', label: '适用场景', value: '', filled: false, required: false },
      { id: '3', attributeId: '3', label: '商品描述', value: '一段较长的商品描述', filled: true, required: false },
      { id: '4', attributeId: '4', label: '平台内部编号', value: '', filled: false, required: false },
      { id: '4180', attributeId: '4180', label: '商品标题', value: '商品标题', filled: true, required: false },
      { id: '11254', attributeId: '11254', label: '富内容', value: '{"content":[]}', filled: true, required: false },
      {
        id: '23171',
        attributeId: '23171',
        label: '话题标签',
        value: '#Игрушка #ДетскиеПодарки',
        filled: true,
        required: false,
      },
      { id: '21837', attributeId: '21837', label: '视频名称', value: '商品演示', filled: true, required: false },
      {
        id: '21841',
        attributeId: '21841',
        label: '视频链接',
        value: 'https://example.com/video.mp4',
        filled: true,
        required: false,
      },
      {
        id: '8790',
        attributeId: '8790',
        label: 'PDF 文档',
        value: 'https://example.com/manual.pdf',
        filled: true,
        required: false,
      },
    ];

    const { container } = render(
      <ProductAttributeEditor
        attributeRows={rows}
        form={{
          attributeValues: {
            1: '无品牌',
            2: '',
            3: '一段较长的商品描述',
            4: '',
            4180: '商品标题',
            11254: '{"content":[]}',
            23171: '#Игрушка #ДетскиеПодарки',
            21837: '商品演示',
            21841: 'https://example.com/video.mp4',
            8790: 'https://example.com/manual.pdf',
          },
        }}
        updateAttributeField={() => vi.fn()}
        saving={false}
        attributeLoading={false}
        attributeContextMeta={{ scope: { categoryId: '10', typeId: '20' } }}
      />
    );

    expect(screen.queryByText('仅显示当前类目字段；建议加分表示优先完善项')).not.toBeInTheDocument();
    expect(screen.queryByText('可输入搜索，但必须选择 Ozon 有效选项')).not.toBeInTheDocument();
    expect(screen.queryByText('多个标签会一起保存，不限制为一个标签')).not.toBeInTheDocument();
    expect(screen.getByText('已填 4 / 可填 6')).toBeInTheDocument();
    expect(screen.getByText('建议加分 3')).toBeInTheDocument();
    expect(screen.getAllByText('建议加分')).toHaveLength(3);
    expect(screen.getByText('适用场景')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('可填写多个标签，用逗号或换行分隔')).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('未填写').some((element) => element.value === '')).toBe(true);
    expect(
      [...container.querySelectorAll('.product-attribute-item.is-wide')].some((element) =>
        element.textContent.includes('商品描述')
      )
    ).toBe(true);
    expect(screen.queryByText('富内容')).not.toBeInTheDocument();
    expect(screen.queryByText('视频名称')).not.toBeInTheDocument();
    expect(screen.queryByText('视频链接')).not.toBeInTheDocument();
    expect(screen.queryByText('PDF 文档')).not.toBeInTheDocument();
    const visibleLabels = [...container.querySelectorAll('.product-attribute-label-row [title]')].map((element) =>
      element.getAttribute('title')
    );
    expect(visibleLabels[0]).toBe('商品标题');
  });

  it('renders Ozon dictionary fields as single-select and multi-select controls', () => {
    const rows = [
      {
        id: '8229',
        attributeId: '8229',
        label: '商品类型（Ozon 类目）',
        value: '',
        filled: false,
        required: true,
        isDictionary: true,
        isCollection: false,
        valueType: 'String',
      },
      {
        id: '7173',
        attributeId: '7173',
        label: '毛绒玩具类型',
        value: '毛绒公仔',
        filled: true,
        required: false,
        isDictionary: true,
        isCollection: true,
        valueType: 'String',
      },
      {
        id: '9070',
        attributeId: '9070',
        label: '18+ 成人商品标识',
        value: 'false',
        filled: true,
        required: false,
        isDictionary: false,
        isCollection: false,
        valueType: 'Boolean',
      },
    ];
    render(
      <ProductAttributeEditor
        attributeRows={rows}
        attributeOptionsById={{
          8229: [{ id: '1', value: '毛绒玩具', label: '毛绒玩具' }],
          7173: [
            { id: '2', value: '毛绒公仔', label: '毛绒公仔' },
            { id: '3', value: '抱枕玩偶', label: '抱枕玩偶' },
          ],
        }}
        attributeOptionsLoading={{}}
        loadAttributeOptions={() => {}}
        form={{ attributeValues: { 8229: '', 7173: '毛绒公仔', 9070: 'false' } }}
        updateAttributeField={() => () => {}}
        saving={false}
        attributeLoading={false}
        attributeContextMeta={{ scope: { categoryId: '10', typeId: '20' } }}
      />
    );

    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    expect(screen.getByText('商品类型（Ozon 类目）')).toBeInTheDocument();
    expect(screen.getByText('毛绒玩具类型')).toBeInTheDocument();
    expect(screen.getByText('18+ 成人商品标识')).toBeInTheDocument();
    expect(screen.queryByText('必填')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('请选择或直接输入 Ozon 选项')).not.toBeInTheDocument();
  });

  it('keeps ordinary text and number attributes directly editable', () => {
    const { container } = render(
      <ProductAttributeEditor
        attributeRows={[
          { id: '4180', attributeId: '4180', label: '商品标题', value: '', valueType: 'String', isDictionary: '0' },
          {
            id: '4383',
            attributeId: '4383',
            label: '商品重量（克）',
            value: '',
            valueType: 'Decimal',
            isDictionary: false,
          },
          {
            id: '8229',
            attributeId: '8229',
            label: '商品类型（Ozon 类目）',
            value: '',
            valueType: 'String',
            isDictionary: true,
          },
        ]}
        attributeOptionsById={{ 8229: [{ id: '1', value: '毛绒玩具', label: '毛绒玩具' }] }}
        form={{ attributeValues: { 4180: '', 4383: '', 8229: '' } }}
        updateAttributeField={() => () => {}}
        saving={false}
        attributeLoading={false}
        attributeContextMeta={{ scope: { categoryId: '10', typeId: '20' } }}
      />
    );

    const items = [...container.querySelectorAll('.product-attribute-item')];
    expect(items[0].querySelector('input')).toHaveAttribute('type', 'text');
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('allows typing to search Ozon dictionary options without accepting arbitrary text', () => {
    vi.useFakeTimers();
    try {
      const loadAttributeOptions = vi.fn();
      const updateAttributeField = vi.fn(() => vi.fn());
      render(
        <ProductAttributeEditor
          attributeRows={[
            {
              id: '4389',
              attributeId: '4389',
              label: '生产国家或地区',
              value: '',
              valueType: 'String',
              isDictionary: true,
              isCollection: true,
            },
          ]}
          attributeOptionsById={{ 4389: [{ id: '1', value: 'Китай', label: 'Китай' }] }}
          form={{ attributeValues: { 4389: '' } }}
          loadAttributeOptions={loadAttributeOptions}
          updateAttributeField={updateAttributeField}
          saving={false}
          attributeLoading={false}
          attributeContextMeta={{ scope: { categoryId: '10', typeId: '20' } }}
        />
      );

      const input = screen.getByRole('combobox', { name: '生产国家或地区' });
      fireEvent.change(input, { target: { value: '巴西' } });
      act(() => vi.advanceTimersByTime(450));

      expect(loadAttributeOptions).toHaveBeenCalledWith(expect.objectContaining({ attributeId: '4389' }), '巴西');
      expect(updateAttributeField).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts manual values only for dictionary fields whose Ozon description allows it', () => {
    const onAttributeChange = vi.fn();
    const updateAttributeField = vi.fn(() => onAttributeChange);
    render(
      <ProductAttributeEditor
        attributeRows={[
          {
            id: '4389',
            attributeId: '4389',
            label: '生产国家或地区',
            value: '',
            valueType: 'String',
            isDictionary: true,
            isCollection: true,
            definition: { description: 'Выберите из списка или укажите вручную.' },
          },
        ]}
        attributeOptionsById={{ 4389: [] }}
        form={{ attributeValues: { 4389: '' } }}
        updateAttributeField={updateAttributeField}
        saving={false}
        attributeLoading={false}
        attributeContextMeta={{ scope: { categoryId: '10', typeId: '20' } }}
      />
    );

    const input = screen.getByRole('combobox', { name: '生产国家或地区' });
    fireEvent.change(input, { target: { value: '巴西' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onAttributeChange).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ value: '巴西', dictionaryValueIds: [null] }),
      })
    );
  });
});
