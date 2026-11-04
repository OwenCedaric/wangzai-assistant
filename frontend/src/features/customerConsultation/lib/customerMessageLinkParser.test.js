import { normalizeCustomerMessageHref, parseCustomerMessageLinks } from './customerMessageLinkParser.js';
import { describe, expect, it } from 'vitest';

describe('customer message link parser', () => {
  it('parses plain, www and Markdown links without swallowing punctuation', () => {
    expect(parseCustomerMessageLinks('查看 https://example.com/a?x=1。')).toEqual([
      { type: 'text', text: '查看 ' },
      { type: 'link', text: 'https://example.com/a?x=1', href: 'https://example.com/a?x=1' },
      { type: 'text', text: '。' },
    ]);
    expect(parseCustomerMessageLinks('[课程大纲](https://example.com/course)')[0]).toEqual({
      type: 'link',
      text: '课程大纲',
      href: 'https://example.com/course',
    });
    expect(parseCustomerMessageLinks('www.example.com')[0].href).toBe('https://www.example.com/');
  });

  it('leaves unsafe protocols as ordinary text', () => {
    expect(normalizeCustomerMessageHref('javascript:alert(1)')).toBe('');
    expect(normalizeCustomerMessageHref('data:text/html,test')).toBe('');
    expect(parseCustomerMessageLinks('[打开](javascript:alert(1))')).toEqual([
      { type: 'text', text: '[打开](javascript:alert(1))' },
    ]);
  });
});
