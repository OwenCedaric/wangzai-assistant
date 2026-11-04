import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const attachments = readFileSync(
  join(process.cwd(), 'src', 'features', 'customerConsultation', 'components', 'CustomerMessageAttachments.jsx'),
  'utf8'
);

describe('customer consultation visual rules', () => {
  it('locks the outer desktop page while keeping the conversation list independently scrollable', () => {
    expect(styles).toContain('.app-root.customer-consultation-active {');
    expect(styles).toContain('max-height: 100dvh !important;');
    expect(styles).toContain('.app-root.customer-consultation-active .workspace-scale-surface {');
    expect(styles).toContain('.app-root.customer-consultation-active .page-stack,');
    expect(styles).toContain('.app-root.customer-consultation-active .page-panel,');
    expect(styles).toContain('.app-root.customer-consultation-active .content-shell {');
    expect(styles).toContain('height: calc(100% - 78px) !important;');
    expect(styles).toContain('height: auto !important;');
    expect(styles).toContain('.app-root.customer-consultation-active .customer-chat-list::-webkit-scrollbar {');
    expect(styles).toContain('display: block !important;');
    expect(styles).toContain('scrollbar-width: thin !important;');
    expect(styles).toContain('.app-root.customer-consultation-active .customer-chat-context-panel {');
    expect(styles).toContain('overflow-y: auto !important;');
    expect(styles).toContain('scrollbar-width: none;');
    expect(styles).toContain('overscroll-behavior: contain;');
  });

  it('keeps low-resolution Ozon files crisp and exposes source-aware preview zoom', () => {
    expect(styles).toContain('grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 320px));');
    expect(styles).toContain('height: 210px;');
    expect(styles).toContain('width: calc(100vw - 40px) !important;');
    expect(styles).toContain('height: calc(100dvh - 40px) !important;');
    expect(styles).toContain('.customer-chat-image-button img.customer-chat-image-low-resolution {');
    expect(styles).toContain('.customer-chat-image-preview-stage.zoomed > img {');
    expect(styles).toContain('image-rendering: pixelated;');
    expect(styles).toContain('filter: contrast(1.14);');
    expect(styles).toContain('object-fit: contain;');
    expect(attachments).toContain('Ozon 源图');
    expect(attachments).toContain('低分辨率，已启用清晰放大');
    expect(attachments).toContain('recommendedZoom');
    expect(attachments).toContain('maxWidth={false}');
    expect(attachments).toContain('scroll="paper"');
  });
});
