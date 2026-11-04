import { CustomerMessageComposer } from './CustomerMessageComposer.jsx';
import { CustomerQuickRepliesPanel } from './CustomerQuickRepliesPanel.jsx';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

describe('customer message composer', () => {
  it('uses a taller editor, removes the old draft footer, and sends with Enter', () => {
    const onOpenQuickReplies = vi.fn();
    const onRequestSend = vi.fn();
    render(
      <CustomerMessageComposer
        conversationId="chat-1"
        draftText="Здравствуйте!"
        onChangeDraft={vi.fn()}
        onOpenQuickReplies={onOpenQuickReplies}
        onRequestSend={onRequestSend}
      />
    );

    expect(screen.queryByText('回复将在接入 Ozon 写入流程后提交')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存草稿' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '快捷回复' }));
    expect(onOpenQuickReplies).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: false });
    expect(onRequestSend).toHaveBeenCalledWith('Здравствуйте!');
  });

  it('keeps Shift + Enter for line breaks', () => {
    const onRequestSend = vi.fn();
    render(
      <CustomerMessageComposer
        conversationId="chat-1"
        draftText="line"
        onChangeDraft={vi.fn()}
        onOpenQuickReplies={vi.fn()}
        onRequestSend={onRequestSend}
      />
    );

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    expect(onRequestSend).not.toHaveBeenCalled();
  });

  it('opens the existing attachment flow when an image is pasted into the editor', () => {
    const onRequestFile = vi.fn();
    const image = new File(['image-bytes'], 'clipboard-test.png', { type: 'image/png' });
    render(
      <CustomerMessageComposer
        conversationId="chat-1"
        draftText=""
        onChangeDraft={vi.fn()}
        onOpenQuickReplies={vi.fn()}
        onRequestSend={vi.fn()}
        onRequestFile={onRequestFile}
      />
    );

    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { files: [image], items: [] },
    });

    expect(onRequestFile).toHaveBeenCalledTimes(1);
    expect(onRequestFile).toHaveBeenCalledWith(image);
  });

  it('keeps normal text paste inside the editor', () => {
    const onRequestFile = vi.fn();
    render(
      <CustomerMessageComposer
        conversationId="chat-1"
        draftText=""
        onChangeDraft={vi.fn()}
        onOpenQuickReplies={vi.fn()}
        onRequestSend={vi.fn()}
        onRequestFile={onRequestFile}
      />
    );

    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { files: [], items: [{ kind: 'string', type: 'text/plain' }] },
    });

    expect(onRequestFile).not.toHaveBeenCalled();
  });
});

describe('customer quick replies panel', () => {
  it('keeps phrases in the right-side panel and starts send preview when selected', () => {
    const phrase = { id: 'shipping', title: '发货进度', text: 'Здравствуйте!' };
    const onUsePhrase = vi.fn();
    render(
      <CustomerQuickRepliesPanel
        phrases={[phrase]}
        searchText=""
        newPhraseText=""
        onSearchChange={vi.fn()}
        onNewPhraseChange={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemovePhrase={vi.fn()}
        onUsePhrase={onUsePhrase}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('快捷短语')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /发货进度/ }));
    expect(onUsePhrase).toHaveBeenCalledWith(phrase);
  });
});
