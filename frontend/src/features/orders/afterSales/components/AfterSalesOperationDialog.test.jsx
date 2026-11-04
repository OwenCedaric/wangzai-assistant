import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AfterSalesOperationDialog } from './AfterSalesOperationDialog.jsx';

describe('AfterSalesOperationDialog', () => {
  it('keeps the existing Ozon detail, evidence and exact operation controls after extraction', () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    const onOpenSeller = vi.fn();
    render(
      <AfterSalesOperationDialog
        afterSalesOperationDialog={{
          open: true,
          loading: false,
          submitting: false,
          order: { products: [{ sku: 'SKU-1' }] },
          plan: {
            actionable: true,
            actions: [{ key: 'reject', label: '拒绝退款' }],
            rejectionReasons: [{ id: 'reason-1', name: '证据不完整' }],
          },
          error: '',
        }}
        afterSalesOperationDetail={{
          fields: [['退款金额', '¥100.00']],
          product: {
            name: '测试商品',
            offerId: 'offer-1',
            sku: 'SKU-1',
            price: '100.00',
            currency: 'RUB',
            image: '',
          },
          buyerComment: '买家说明内容',
          clientPhotos: ['https://example.test/evidence.jpg'],
        }}
        afterSalesOperationForm={{
          actionKey: 'reject',
          rejectionReasonId: 'reason-1',
          comment: '拒绝说明',
        }}
        setAfterSalesOperationForm={() => undefined}
        selectedAfterSalesOperation={{ kind: 'reject', label: '拒绝退款' }}
        selectedAfterSalesRejectionReason={{ id: 'reason-1', hint: '请核对凭证', commentRequired: true }}
        afterSalesOperationSellerTarget={{ url: 'https://seller.ozon.ru/app/returns/1', targetKind: 'after-sales-detail' }}
        afterSalesDisplayId="after-sales-1"
        openAfterSalesSellerDetail={onOpenSeller}
        closeAfterSalesOperationDialog={onClose}
        submitAfterSalesOperation={onSubmit}
      />,
    );

    for (const text of [
      '售后详情与处理',
      '售后单：after-sales-1',
      '退款金额',
      '¥100.00',
      '测试商品',
      '货号：offer-1',
      'SKU：SKU-1',
      '买家说明内容',
      '买家上传图片',
      '证据不完整',
      '处理说明（必填）',
      '上传图片 / 在 Ozon 处理',
    ]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }

    fireEvent.click(screen.getByRole('button', { name: '拒绝退款' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '上传图片 / 在 Ozon 处理' }));
    expect(onOpenSeller).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
