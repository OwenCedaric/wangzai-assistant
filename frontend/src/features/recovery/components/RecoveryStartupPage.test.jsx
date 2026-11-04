import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RecoveryStartupPage } from './RecoveryStartupPage.jsx';

describe('RecoveryStartupPage', () => {
  it('exposes a stable readiness marker for desktop recovery smoke tests', () => {
    const { container } = render(<RecoveryStartupPage />);

    expect(container.querySelector('[data-recovery-startup-ready="true"]')).toBeTruthy();
    expect(screen.getByText(/当前本机业务数据库不可用/)).toBeTruthy();
  });
});
