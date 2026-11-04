import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../services/warehouseWriteClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requestWarehouseWriteOperation: runtime.request,
}));

import { WarehouseOzonManagementDialog } from './WarehouseOzonManagementDialog.jsx';

const warehouse = {
  id: '1020005007227510',
  rawId: '1020005007227510',
  name: 'guoo 陆运',
  status: 'created',
  raw: { is_rfbs: true, phone: '+86 188 0537 2111', is_auto_assembly: false },
};

describe('WarehouseOzonManagementDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.request.mockResolvedValue({ ok: true, writeStatus: 'readback_merged', message: '完成' });
  });

  it('submits current rFBS pause through the warehouse safety client', async () => {
    render(
      <WarehouseOzonManagementDialog
        open
        shopId="shop-a"
        warehouse={warehouse}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '暂停仓库接单' }));
    await waitFor(() => expect(runtime.request).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-a',
      action: 'warehouse.rfbs.pause',
      endpointKey: 'warehouse.rfbsPause',
      payload: { warehouse_id: 1020005007227510 },
    }), expect.any(Object)));
  });

  it('selects the aggregator delivery-method endpoint and keeps warehouse scope', async () => {
    render(
      <WarehouseOzonManagementDialog
        open
        shopId="shop-a"
        warehouse={warehouse}
        deliveryMethod={{
          id: '20296961', rawId: '20296961', warehouseId: '1020005007227510',
          name: '0-500g PUDO', raw: { tpl_integration_type: 'aggregator', cut_in: 120, sla_cut_in: 4320 },
        }}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '保存配送方式' }));
    await waitFor(() => expect(runtime.request).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delivery-method.update',
      endpointKey: 'warehouse.erfbsAggregatorDeliveryMethodUpdate',
      payload: expect.objectContaining({
        warehouse_id: 1020005007227510,
        delivery_method_id: 20296961,
        name: '0-500g PUDO',
        cut_in: 120,
      }),
    }), expect.any(Object)));
  });
});
