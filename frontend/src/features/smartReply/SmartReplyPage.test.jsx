import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SmartReplyPage } from './SmartReplyPage.jsx';

describe('SmartReplyPage', () => {
  it('shows the product-facing smart reply experience without internal rules or capsule labels', async () => {
    const { container } = render(<SmartReplyPage />);

    expect(screen.getByRole('heading', { name: '智能回复', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '催护照' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '催取货' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '发货通知' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '索要好评' })).toBeInTheDocument();
    expect(screen.getByTestId('smart-reply-scene-row')).toHaveAttribute('data-layout', 'single-row');
    expect(screen.getByText(/为订单不同阶段准备俄语消息/u)).toBeInTheDocument();
    expect(screen.getAllByText(/Для успешного оформления/u)).toHaveLength(2);
    expect(container.querySelector('.MuiChip-root')).not.toBeInTheDocument();
    expect(screen.queryByText('最近发送记录')).not.toBeInTheDocument();
    expect(screen.queryByText(/未启用任何自动发送规则/u)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/重复发送|发送回读|店铺缓存|模板规则|妙手默认内容|当前页面草稿/u)
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发送记录' }));
    expect(screen.getByRole('heading', { name: '发送记录' })).toBeInTheDocument();
    expect(screen.getByText('暂无发送记录')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭发送记录' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: '发送记录' })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '接入店铺' }));
    expect(screen.getByRole('heading', { name: '接入自动发送店铺' })).toBeInTheDocument();
    expect(screen.getByText(/无需再次填写 API Key/u)).toBeInTheDocument();
    expect(screen.queryByLabelText('Ozon API Key')).not.toBeInTheDocument();
  });

  it('switches scenes, applies another template and previews replaced order variables', () => {
    render(<SmartReplyPage />);

    fireEvent.click(screen.getByRole('button', { name: /催取货/u }));
    expect(screen.getByRole('heading', { name: '催取货模板' })).toBeInTheDocument();
    expect(screen.getAllByText(/уже доставлена в пункт выдачи/u)).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: '应用此模板' })[0]);
    expect(screen.getAllByText(/Ваша посылка по заказу/u)).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('买家昵称'), { target: { value: 'Ирина' } });
    expect(screen.getByText(/Добрый день, Ирина!/u)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('产品名称'), { target: { value: '' } });
    expect(screen.getByText(/请填写：产品名称/u)).toBeInTheDocument();
  });

  it('creates a session-only template with the same variable insertion and 500-character contract', async () => {
    render(<SmartReplyPage />);

    fireEvent.click(screen.getByRole('button', { name: '创建模板' }));
    expect(screen.getByRole('heading', { name: '创建模板消息' })).toBeInTheDocument();

    const russianEditor = screen.getByLabelText('俄语模板内容');
    expect(russianEditor).toHaveAttribute('maxlength', '500');
    fireEvent.change(russianEditor, { target: { value: 'Тестовое сообщение' } });
    fireEvent.click(screen.getByRole('button', { name: '运单号' }));
    expect(russianEditor).toHaveValue('Тестовое сообщение {{运单号}}');
    fireEvent.change(screen.getByLabelText('中文译文'), { target: { value: '测试消息' } });
    fireEvent.click(screen.getByRole('button', { name: '保存模板' }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: '创建模板消息' })).not.toBeInTheDocument();
    });
    expect(screen.getByText('模板 4')).toBeInTheDocument();
    expect(screen.getByText(/Тестовое сообщение RU123456789/u)).toBeInTheDocument();
  });

  it('loads local mode from the customer computer and reuses the bound shop authorization', async () => {
    const previousDesktop = window.wangzaiDesktop;
    window.wangzaiDesktop = {
      localApiRequest: vi.fn(async ({ path }) => {
        const data = {
          '/api/smart-reply/mode': { ok: true, mode: 'local' },
          '/api/smart-reply/local/status': {
            ok: true, mode: 'local', worker_running: true, polling_active: true, configured_shop_count: 1,
          },
          '/api/smart-reply/local/credentials': [
            { client_id: '50001', shop_name: '本地一店', configured: true, status: 'active' },
          ],
          '/api/smart-reply/local/rules': [],
          '/api/smart-reply/local/tasks?limit=100': {
            items: [{
              task_id: 'local-task-1',
              rule_id: 'local-rule-1',
              client_id: '50001',
              shop_name: '本地一店',
              posting_number: '50000001-0001-1',
              scene: 'shipmentNotice',
              status: 'sent',
              sent_at: '2026-08-25T01:30:00.000Z',
            }],
            total: 1,
          },
        }[path];
        return { ok: true, status: 200, data };
      }),
    };
    try {
      render(<SmartReplyPage
        isActive
        activeShopId="shop-1"
        shops={[{ id: 'shop-1', clientId: '50001', alias: '本地一店' }]}
      />);

      expect(await screen.findByText(/本地模式在电脑和软件运行时监听订单并发送/u)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /使用本地授权/u })).toBeEnabled();
      expect(screen.getByRole('combobox', { name: '执行模式' })).toHaveTextContent('本地模式');

      fireEvent.click(screen.getByRole('button', { name: '发送记录' }));
      expect(await screen.findByText('50000001-0001-1')).toBeInTheDocument();
      expect(screen.getAllByText('发货通知').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('发送成功')).toBeInTheDocument();
      expect(screen.getAllByText('本地模式').length).toBeGreaterThanOrEqual(2);
    } finally {
      window.wangzaiDesktop = previousDesktop;
    }
  });
});
