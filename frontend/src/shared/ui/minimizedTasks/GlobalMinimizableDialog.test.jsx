import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { GlobalMinimizableDialog } from './GlobalMinimizableDialog.jsx';
import { MinimizedTaskBar } from './MinimizedTaskBar.jsx';
import { MinimizedTaskProvider } from './MinimizedTaskProvider.jsx';

function DialogHarness({ onCloseSpy = () => {} }) {
  const [open, setOpen] = React.useState(true);
  return (
    <MinimizedTaskProvider>
      <GlobalMinimizableDialog
        open={open}
        onClose={(event, reason) => {
          onCloseSpy(event, reason);
          setOpen(false);
        }}
      >
        <DialogTitle>编辑商品</DialogTitle>
        <DialogContent>
          <TextField label="商品标题" defaultValue="原始标题" />
        </DialogContent>
      </GlobalMinimizableDialog>
      <MinimizedTaskBar />
    </MinimizedTaskProvider>
  );
}

describe('GlobalMinimizableDialog', () => {
  it('minimizes every standard dialog and restores its mounted form state', async () => {
    render(<DialogHarness />);

    const input = screen.getByLabelText('商品标题');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('button').slice(0, 2).map((button) => button.getAttribute('aria-label'))).toEqual([
      '最小化编辑商品',
      '关闭编辑商品',
    ]);
    fireEvent.change(input, { target: { value: '保留中的标题' } });
    fireEvent.click(screen.getByRole('button', { name: '最小化编辑商品' }));

    const taskBar = await screen.findByRole('region', { name: '已最小化的订单任务' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(within(taskBar).getByRole('button', { name: '恢复编辑商品' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('商品标题')).toHaveValue('保留中的标题');
  });

  it('closes a minimized dialog through its original controlled close flow', async () => {
    const onCloseSpy = vi.fn();
    render(<DialogHarness onCloseSpy={onCloseSpy} />);

    fireEvent.click(screen.getByRole('button', { name: '最小化编辑商品' }));
    const taskBar = await screen.findByRole('region', { name: '已最小化的订单任务' });
    fireEvent.click(within(taskBar).getByRole('button', { name: '关闭编辑商品' }));

    expect(onCloseSpy).toHaveBeenCalledWith(undefined, 'taskClose');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '已最小化的订单任务' })).not.toBeInTheDocument();
  });

  it('keeps the minimized task closable state aligned with busy dialogs', async () => {
    render(
      <MinimizedTaskProvider>
        <GlobalMinimizableDialog open>
          <DialogTitle>正在提交</DialogTitle>
          <DialogContent>处理进行中</DialogContent>
        </GlobalMinimizableDialog>
        <MinimizedTaskBar />
      </MinimizedTaskProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: '最小化正在提交' }));
    const taskBar = await screen.findByRole('region', { name: '已最小化的订单任务' });
    expect(within(taskBar).getByRole('button', { name: '关闭正在提交' })).toBeDisabled();
    expect(within(taskBar).getByRole('button', { name: '恢复正在提交' })).toBeEnabled();
  });
});
