import { describe, expect, it } from 'vitest';
import { normalizeCrossBorderWarehouses } from '../shared/ozon/ozonRuntime.jsx';

describe('crossBorderWarehouseNormalize', () => {
  it('keeps every cooperation warehouse and shows warehouse code instead of internal id prefix', () => {
    const options = normalizeCrossBorderWarehouses({
      code: 1,
      data: [
        {
          section_id: '123',
          section_name: 'OZON GUOO',
          storehouse_list: [
            { id: '362', code: '2311', name: '2311济南七号仓' },
            { id: '768', code: '3011', name: '3011泰安聚圆国际贸易仓' },
          ],
        },
      ],
    });

    expect(options).toHaveLength(2);
    expect(options.map((option) => option.value)).toEqual(['123:362', '123:768']);
    expect(options.map((option) => option.code)).toEqual(['2311', '3011']);
    expect(options.map((option) => option.label)).toEqual([
      '2311济南七号仓 / OZON GUOO',
      '3011泰安聚圆国际贸易仓 / OZON GUOO',
    ]);
  });
});
