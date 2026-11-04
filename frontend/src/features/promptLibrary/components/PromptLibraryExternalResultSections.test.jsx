import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PromptLibraryExternalResultSections } from './PromptLibraryExternalResultSections.jsx';

describe('PromptLibraryExternalResultSections', () => {
  it('keeps every returned row and pages the visible DOM in groups of one hundred', () => {
    const rows = Array.from({ length: 205 }, (_, index) => `结果-${index + 1}`);
    render(<PromptLibraryExternalResultSections sections={[{ title: '全量结果', rows }]} />);

    expect(screen.getByText('结果-1')).toBeVisible();
    expect(screen.getByText('结果-100')).toBeVisible();
    expect(screen.queryByText('结果-101')).not.toBeInTheDocument();
    expect(screen.getByText('1-100 / 205')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    expect(screen.queryByText('结果-1')).not.toBeInTheDocument();
    expect(screen.getByText('结果-101')).toBeVisible();
    expect(screen.getByText('结果-200')).toBeVisible();
    expect(screen.getByText('第 2 / 3 页')).toBeVisible();
  });
});
