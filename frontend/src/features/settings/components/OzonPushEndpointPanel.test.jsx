import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import OzonPushEndpointPanel from './OzonPushEndpointPanel.jsx';

afterEach(() => {
  delete window.wangzaiDesktop;
  vi.restoreAllMocks();
});

describe('OzonPushEndpointPanel', () => {
  it('reads the exact shop, generates its address, copies it, and rotates it', async () => {
    const copied = [];
    const firstUrl = 'https://node.example.ts.net:8443/api/ozon/push/binding-a.signature-a';
    const secondUrl = 'https://node.example.ts.net:8443/api/ozon/push/binding-b.signature-b';
    const command = vi.fn(async (input) => {
      if (input.command === 'read') return { ok: true, binding: null };
      if (input.command === 'ensure') return {
        ok: true,
        binding: { shopId: 'shop-a', mode: 'desktop', status: 'generated', url: firstUrl },
      };
      return {
        ok: true,
        binding: { shopId: 'shop-a', mode: 'desktop', status: 'generated', url: secondUrl },
      };
    });
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: { ozonPushEndpoint: { command } },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async (value) => copied.push(value)) },
    });

    render(<OzonPushEndpointPanel activeShop={{ id: 'shop-a', clientId: '1001' }} activeClientId="1001" />);
    await waitFor(() => expect(command).toHaveBeenCalledWith({ command: 'read', shopId: 'shop-a' }));
    fireEvent.click(await screen.findByRole('button', { name: '一键生成通知地址' }));
    expect(await screen.findByDisplayValue(firstUrl)).toBeInTheDocument();
    expect(screen.getByText(/当前电脑公网地址/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '复制地址' }));
    await waitFor(() => expect(copied).toEqual([firstUrl]));
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
    expect(await screen.findByDisplayValue(secondUrl)).toBeInTheDocument();
    expect(command).toHaveBeenCalledWith({ command: 'rotate', shopId: 'shop-a' });
  });

  it('does not generate a callback until the selected shop has a Client ID', async () => {
    const command = vi.fn();
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: { ozonPushEndpoint: { command } },
    });
    render(<OzonPushEndpointPanel activeShop={{ id: 'shop-empty', clientId: '' }} />);
    expect(screen.getByRole('button', { name: '一键生成通知地址' })).toBeDisabled();
    expect(screen.getByText('请先保存当前店铺的 Client ID。')).toBeInTheDocument();
  });

  it('keeps generation disabled until the shop is durably saved, then re-reads after save', async () => {
    let saved = false;
    const command = vi.fn(async (input) => {
      if (input.command === 'read') {
        return saved
          ? { ok: true, shopSaved: true, savedClientId: '2002', binding: null }
          : { ok: true, shopSaved: false, savedClientId: '', binding: null };
      }
      return { ok: true, binding: { shopId: 'shop-new', mode: 'desktop', status: 'generated', url: 'https://n.ts.net:8443/api/ozon/push/x.y' } };
    });
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: { ozonPushEndpoint: { command } },
    });
    const { rerender } = render(<OzonPushEndpointPanel activeShop={{ id: 'shop-new', clientId: '2002', savedAt: '' }} activeClientId="2002" />);
    expect(await screen.findByText(/当前店铺还没有保存成功/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键生成通知地址' })).toBeDisabled();
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'ensure' }));

    saved = true;
    rerender(<OzonPushEndpointPanel activeShop={{ id: 'shop-new', clientId: '2002', savedAt: '10:00:00' }} activeClientId="2002" />);
    await waitFor(() => expect(screen.getByRole('button', { name: '一键生成通知地址' })).toBeEnabled());
    expect(screen.queryByText(/还没有保存成功/u)).not.toBeInTheDocument();
    expect(command.mock.calls.filter(([input]) => input.command === 'read')).toHaveLength(2);
  });

  it('blocks generation when the Client ID in the form differs from the saved one', async () => {
    const command = vi.fn(async () => ({ ok: true, shopSaved: true, savedClientId: '1001', binding: null }));
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: { ozonPushEndpoint: { command } },
    });
    render(<OzonPushEndpointPanel activeShop={{ id: 'shop-a', clientId: '9999' }} activeClientId="9999" />);
    expect(await screen.findByText(/Client ID 已修改但尚未保存/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键生成通知地址' })).toBeDisabled();
  });
});
