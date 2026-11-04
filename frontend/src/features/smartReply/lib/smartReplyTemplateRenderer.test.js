import { describe, expect, it } from 'vitest';
import { smartReplyScenes } from '../constants/smartReplyScenes.js';
import {
  getSmartReplyTemplates,
  smartReplyTemplateCatalog,
  smartReplyVariables,
} from '../constants/smartReplyTemplateCatalog.js';
import {
  createSmartReplySampleValues,
  findMissingSmartReplyVariables,
  renderSmartReplyTemplate,
} from './smartReplyTemplateRenderer.js';

describe('smart reply Miaoshou template catalog', () => {
  it('keeps four scenes, three templates per scene and five system variables', () => {
    expect(smartReplyScenes.map((scene) => scene.value)).toEqual([
      'passportRequired',
      'pickupReminder',
      'shipmentNotice',
      'reviewRequest',
    ]);
    expect(Object.keys(smartReplyTemplateCatalog)).toEqual([
      'passportRequired',
      'pickupReminder',
      'shipmentNotice',
      'reviewRequest',
    ]);
    expect(Object.values(smartReplyTemplateCatalog).map((templates) => templates.length)).toEqual([3, 3, 3, 3]);
    expect(smartReplyVariables.map((variable) => variable.placeholder)).toEqual([
      '{{买家昵称}}',
      '{{产品名称}}',
      '{{下单日期}}',
      '{{货件编号}}',
      '{{运单号}}',
    ]);

    const templates = Object.values(smartReplyTemplateCatalog).flat();
    const knownPlaceholders = new Set(smartReplyVariables.map((variable) => variable.placeholder));
    expect(new Set(templates.map((template) => template.id)).size).toBe(12);
    for (const template of templates) {
      expect(template.messageRu.length).toBeLessThanOrEqual(500);
      expect(template.messageZh.trim()).not.toBe('');
      const placeholders = template.messageRu.match(/\{\{[^}]+\}\}/gu) || [];
      expect(placeholders.every((placeholder) => knownPlaceholders.has(placeholder))).toBe(true);
    }
  });

  it('replaces present variables and reports only required missing values', () => {
    const template = getSmartReplyTemplates('shipmentNotice')[0];
    const values = createSmartReplySampleValues();
    values.buyerNickname = 'Ирина';

    const rendered = renderSmartReplyTemplate(template.messageRu, values);
    expect(rendered).toContain('Ирина');
    expect(rendered).toContain(values.postingNumber);
    expect(rendered).not.toContain('{{买家昵称}}');
    expect(findMissingSmartReplyVariables(template.messageRu, values)).toEqual([]);

    values.productName = '';
    expect(findMissingSmartReplyVariables(template.messageRu, values).map((variable) => variable.code)).toEqual([
      'productName',
    ]);
    expect(findMissingSmartReplyVariables(template.messageRu, { trackingNumber: '' })).not.toContainEqual(
      expect.objectContaining({ code: 'trackingNumber' })
    );
  });
});
