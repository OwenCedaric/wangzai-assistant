import { CustomerConsultationDetailPanel } from './CustomerConsultationDetailPanel.jsx';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const conversation = {
  id: 'chat-1',
  channel: 'chat',
  chatId: 'chat_84291',
  updatedAt: '今天 14:28',
  orderNumber: '59724481-0031-1',
  orderStatus: '运输中',
  productName: '手机壳 黑色款',
  sku: 'WZ-CASE-118',
  productId: '4213816529',
  orderTimeline: [
    {
      id: 'ordered',
      type: 'ordered',
      title: '买家下单',
      detail: '买家提交订单。',
      source: 'Ozon 订单',
      occurredAt: '2026-07-01T06:00:00.000Z',
    },
  ],
  messages: [],
};

describe('CustomerConsultationDetailPanel', () => {
  it('shows the complete order number, clickable Ozon product and order timeline', () => {
    render(<CustomerConsultationDetailPanel conversation={conversation} />);

    expect(screen.getByText('59724481-0031-1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制订单号 59724481-0031-1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开 Ozon 商品页：手机壳 黑色款' })).toHaveAttribute(
      'href',
      'https://www.ozon.ru/product/4213816529/'
    );
    const routeList = screen.getByRole('list', { name: '订单完整时间链路' });
    expect(routeList).toBeInTheDocument();
    expect(
      within(routeList)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([expect.stringContaining('国内采购与快递'), expect.stringContaining('买家下单')]);
    expect(screen.getByText('买家下单')).toBeInTheDocument();
  });

  it('uses Chinese translations for the related product and right-side timeline', () => {
    const russianConversation = {
      ...conversation,
      id: 'chat-russian',
      productName: 'Картридж для смесителя',
      orderTimeline: [
        {
          id: 'ozon-bot-1',
          type: 'ozon_event',
          title: 'Ozon 自动消息',
          detail: 'Спасибо за отзыв, дождитесь ответа продавца',
          source: 'Ozon 助手',
          occurredAt: '2026-07-03T06:18:00.000Z',
        },
      ],
    };
    render(
      <CustomerConsultationDetailPanel
        conversation={russianConversation}
        translations={{
          'product:chat-russian': '水龙头混水阀芯',
          'timeline:ozon-bot-1:detail': '感谢您的反馈，请等待卖家回复',
        }}
      />
    );

    expect(screen.getByRole('link', { name: '打开 Ozon 商品页：水龙头混水阀芯' })).toBeInTheDocument();
    expect(screen.getByText('感谢您的反馈，请等待卖家回复')).toBeInTheDocument();
    expect(screen.queryByText('Спасибо за отзыв, дождитесь ответа продавца')).not.toBeInTheDocument();
  });
});
