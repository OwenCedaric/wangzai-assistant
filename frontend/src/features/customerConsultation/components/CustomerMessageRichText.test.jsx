import { CustomerMessageRichText } from './CustomerMessageRichText.jsx';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const previousBridge = globalThis.window.wangzaiDesktop;

afterEach(() => {
  if (previousBridge === undefined) delete globalThis.window.wangzaiDesktop;
  else globalThis.window.wangzaiDesktop = previousBridge;
});

describe('CustomerMessageRichText', () => {
  it('routes safe links to the internal browser and stops the parent selection click', () => {
    const onParentClick = vi.fn();
    const command = vi.fn(async () => ({ ok: true }));
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    render(
      <div onClick={onParentClick}>
        <CustomerMessageRichText text="打开 https://example.com/a。" />
      </div>
    );
    const link = screen.getByRole('link', { name: 'https://example.com/a' });
    expect(link).not.toHaveAttribute('target');
    expect(link).not.toHaveAttribute('rel');
    fireEvent.click(link);
    expect(onParentClick).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledWith({
      command: 'open-external',
      url: 'https://example.com/a',
    });
    expect(document.body.textContent).toContain('。');
  });
});
