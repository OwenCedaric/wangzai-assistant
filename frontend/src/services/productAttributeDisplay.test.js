import { describe, expect, it } from 'vitest';
import {
  buildProductAttributeEditRows,
  isOzonAttributeManualEntryAllowed,
  translateProductAttributeName,
} from '../entities/product/productAttributes.jsx';
import { buildOzonEditableAttributes } from '../entities/product/productWriteHelpers.jsx';

describe('product attribute display labels', () => {
  it('uses stable Ozon attribute id labels when Ozon returns empty names', () => {
    expect(translateProductAttributeName('', 23171)).toBe('商品话题标签（可填写多个）');
    expect(translateProductAttributeName('', 11254)).toBe('\u5bcc\u5185\u5bb9');
    expect(translateProductAttributeName('', 10096)).toBe('商品颜色');
    expect(translateProductAttributeName('', 4180)).toBe('\u5546\u54c1\u6807\u9898');
    expect(translateProductAttributeName('Название', 4180)).toBe('\u5546\u54c1\u6807\u9898');
    expect(translateProductAttributeName('Название', 90001)).toBe('\u540d\u79f0');
    expect(translateProductAttributeName('Озон.Видео: название', 21837)).toBe('视频名称');
    expect(translateProductAttributeName('Название файла PDF', 8789)).toBe('PDF 文件名');
    expect(translateProductAttributeName('Озон.Видео: ссылка', 21841)).toBe('视频链接');
    expect(translateProductAttributeName('Документ PDF', 8790)).toBe('PDF 文档');
    expect(translateProductAttributeName('Тип', 8229)).toBe('商品类型（Ozon 类目）');
    expect(translateProductAttributeName('Вид мягкой игрушки', 7173)).toBe('毛绒玩具类型');
    expect(translateProductAttributeName('Способ применения', 8048)).toBe('使用方法');
    expect(translateProductAttributeName('SPF', 8198)).toBe('SPF 防晒指数');
    expect(translateProductAttributeName('Признак 18+', 9070)).toBe('18+ 成人商品标识');
    expect(translateProductAttributeName('Название модели (для объединения в одну карточку)', 9048)).toBe('型号名称（用于合并同一卡片）');
    expect(translateProductAttributeName('Форма рамы', 21890)).toBe('镜框形状');
    expect(translateProductAttributeName('Материал рамы', 21895)).toBe('镜框材质');
    expect(translateProductAttributeName('Количество товара в УЕИ', 23249)).toBe('单个销售单位内的商品数量');
    expect(translateProductAttributeName('Нужен код маркировки', 23536)).toBe('是否需要商品标识码');
    expect(translateProductAttributeName('Неизвестная характеристика', 99999)).toBe('Ozon 属性（中文名称待补充）');
    expect(translateProductAttributeName('', 99999)).toBe('Ozon 属性名称未返回');
  });

  it('does not show the missing-name placeholder for cached product attributes with ids', () => {
    const rows = buildProductAttributeEditRows({
      attributes: [
        { id: 23171, name: '', values: [{ value: '#tag' }] },
        { id: 23536, name: '', values: [{ value: 'false' }] },
      ],
    });

    expect(rows.map((row) => row.label)).toEqual(['商品话题标签（可填写多个）', '是否需要商品标识码']);
    expect(rows.some((row) => row.label === '\u5b57\u6bb5\u540d\u79f0\u672a\u8fd4\u56de')).toBe(false);
  });

  it('keeps hidden Ozon media values in the write payload', () => {
    const rows = buildProductAttributeEditRows({
      attributes: [
        { id: 21837, name: 'Озон.Видео: название', values: [{ value: '商品演示' }] },
        { id: 8789, name: 'Название файла PDF', values: [{ value: '说明书.pdf' }] },
      ],
    });

    expect(buildOzonEditableAttributes(rows, Object.fromEntries(rows.map((row) => [row.id, row.value])))).toEqual([
      { id: 21837, values: [{ value: '商品演示' }] },
      { id: 8789, values: [{ value: '说明书.pdf' }] },
    ]);
  });

  it('writes the selected dictionary value ids for Ozon dropdown attributes', () => {
    const rows = [{ id: '8229', attributeId: '8229', value: '旧类型', sourceAttribute: null }];
    expect(buildOzonEditableAttributes(rows, { 8229: '毛绒玩具' }, { 8229: ['12345'] })).toEqual([
      { id: 8229, values: [{ value: '毛绒玩具', dictionary_value_id: 12345 }] },
    ]);
  });

  it('follows Ozon descriptions for manual dictionary values', () => {
    expect(isOzonAttributeManualEntryAllowed({
      description: 'Выберите из списка или укажите вручную. Можно добавить несколько значений.',
    })).toBe(true);
    expect(isOzonAttributeManualEntryAllowed({
      description: 'Выберите из списка. Можно указать только одно значение.',
    })).toBe(false);
  });
});
