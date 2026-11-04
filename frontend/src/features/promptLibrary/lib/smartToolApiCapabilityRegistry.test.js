import { describe, expect, it } from 'vitest';
import { listExternalInterfaceRegistrations } from '../../../services/externalInterfaceRegistry.js';
import {
  createSmartToolApiBindingManifest,
  listSmartToolApiCapabilities,
  matchSmartToolApiCapabilities,
} from './smartToolApiCapabilityRegistry.js';

describe('smartToolApiCapabilityRegistry', () => {
  it('把现有平台接口全部纳入预装能力注册表', () => {
    const externalInterfaces = listExternalInterfaceRegistrations();
    const capabilities = listSmartToolApiCapabilities();
    const registeredEndpointCount = capabilities.reduce((total, item) => total + item.endpointCount, 0);

    expect(externalInterfaces.length).toBeGreaterThan(100);
    expect(registeredEndpointCount).toBe(externalInterfaces.length);
    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ozon.products.read', installedByDefault: true }),
        expect.objectContaining({ id: 'ozon.products.write', installedByDefault: true }),
        expect.objectContaining({ id: 'cross-border.read', installedByDefault: true }),
      ])
    );
  });

  it('商品卡 Skill 自动匹配商品、图片和模型能力，不把禁止发布误判成写入', () => {
    const tool = {
      title: 'Ozon 商品卡优化与生图',
      goal: '生成俄语 SEO、详情和商品图方案',
      body: 'Never publish or change a live listing. Do not write to Ozon.',
      skillProfile: {
        runType: 'api-assisted-readonly',
        capabilities: ['核对 Ozon 商品事实', '生成俄语标题', '规划商品图片'],
      },
    };
    const manifest = createSmartToolApiBindingManifest(tool);
    const ids = manifest.map((item) => item.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        'ozon.products.read',
        'ozon.productImages.read',
        'model.text.generate',
        'model.image.generate',
      ])
    );
    expect(ids.some((id) => id.endsWith('.write'))).toBe(false);
  });

  it('按本机配置显示可用、待配置和写入安全门，不返回密钥', () => {
    const match = matchSmartToolApiCapabilities(
      {
        title: '跨境巴士订单物流同步',
        goal: '读取订单并提交物流预报',
        skillProfile: { runType: 'guard-required' },
      },
      { hasCrossBorderAccount: false }
    );

    expect(match.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'cross-border.read', status: 'missing_configuration' }),
        expect.objectContaining({ id: 'cross-border.write', status: 'business_guard' }),
      ])
    );
    expect(JSON.stringify(match)).not.toMatch(/apiKey|clientSecret|tokenValue/iu);
  });

  it('显式接口清单优先，避免保存后重新猜测', () => {
    const match = matchSmartToolApiCapabilities(
      {
        title: '任意名称',
        skillProfile: {
          apiBindings: [{ id: 'ozon.finance.read' }, { id: 'model.text.generate' }],
        },
      },
      { hasOzonShop: true, hasModelApi: true }
    );

    expect(match.bindings.map((item) => item.id)).toEqual(['ozon.finance.read', 'model.text.generate']);
    expect(match.readyCount).toBe(2);
  });
});
