import { describe, expect, it } from 'vitest';
import {
  OZON_RICH_CONTENT_ATTRIBUTE_ID,
  readProductRichContent,
  replaceProductRichContentAttribute,
  syncProductRichContentImages,
} from './productRichContent.js';

describe('product Rich Content image synchronization', () => {
  it('reorders, removes and appends image widgets while preserving non-image content', () => {
    const source = {
      version: 2,
      content: [
        { widgetName: 'image', props: { src: 'https://old/1.jpg', srcMobile: 'https://old/1.jpg', alt: '保留' } },
        { widgetName: 'text', text: '详情文案不得删除' },
        { widgetName: 'image', props: { src: 'https://old/2.jpg', srcMobile: 'https://old/2.jpg' } },
      ],
    };
    const next = syncProductRichContentImages(source, [
      'https://new/2.jpg',
      'https://new/1.jpg',
      'https://new/3.jpg',
    ]);
    expect(next.content[0].props).toMatchObject({ src: 'https://new/2.jpg', srcMobile: 'https://new/2.jpg', alt: '保留' });
    expect(next.content[1]).toEqual(source.content[1]);
    expect(next.content[2].props.src).toBe('https://new/1.jpg');
    expect(next.content[3].props.src).toBe('https://new/3.jpg');
    expect(source.content[0].props.src).toBe('https://old/1.jpg');
  });

  it('creates a Rich Content document and reads it back from attribute 11254', () => {
    const richContent = syncProductRichContentImages(null, ['https://new/detail.jpg']);
    const attributes = replaceProductRichContentAttribute([{ id: 10, values: [{ value: 'Blue' }] }], richContent);
    expect(attributes.at(-1).id).toBe(OZON_RICH_CONTENT_ATTRIBUTE_ID);
    expect(readProductRichContent({ attributes })).toEqual(richContent);
  });

  it('removes only image widgets when the detail image list is empty', () => {
    const next = syncProductRichContentImages({
      version: 2,
      content: [
        { widgetName: 'image', props: { src: 'https://old/1.jpg' } },
        { widgetName: 'text', text: '保留文案' },
      ],
    }, []);
    expect(next.content).toEqual([{ widgetName: 'text', text: '保留文案' }]);
  });
});
