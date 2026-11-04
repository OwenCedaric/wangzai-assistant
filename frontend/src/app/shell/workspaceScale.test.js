import { describe, expect, it } from 'vitest';
import {
  calculateWorkspaceScale,
  WORKSPACE_DESIGN_WIDTH,
  WORKSPACE_MIN_SCALE,
  WORKSPACE_SIDEBAR_COLLAPSED_WIDTH,
  WORKSPACE_SIDEBAR_WIDTH,
} from './workspaceScale.js';

describe('workspace scale', () => {
  it('keeps a wide workspace at native size', () => {
    const layout = calculateWorkspaceScale({ viewportWidth: 2048, viewportHeight: 1080, sidebarOpen: true });

    expect(layout.availableWidth).toBe(2048 - WORKSPACE_SIDEBAR_WIDTH);
    expect(layout.scale).toBe(1);
    expect(layout.designWidth).toBe(layout.availableWidth);
    expect(layout.overflowWidth).toBe(0);
    expect(layout.designHeight).toBe(1080);
  });

  it('proportionally scales the full design surface when the sidebar opens', () => {
    const layout = calculateWorkspaceScale({ viewportWidth: 1427, viewportHeight: 900, sidebarOpen: true });

    expect(layout.availableWidth).toBe(1427 - WORKSPACE_SIDEBAR_WIDTH);
    expect(layout.designWidth).toBe(WORKSPACE_DESIGN_WIDTH);
    expect(layout.scale).toBeCloseTo((1427 - WORKSPACE_SIDEBAR_WIDTH) / WORKSPACE_DESIGN_WIDTH, 4);
    expect(layout.visualWidth).toBeCloseTo(layout.availableWidth, 1);
    expect(layout.overflowWidth).toBe(0);
    expect(layout.designHeight * layout.scale).toBeCloseTo(900, 1);
  });

  it('expands smoothly without changing the design width when the sidebar closes', () => {
    const openLayout = calculateWorkspaceScale({ viewportWidth: 1427, sidebarOpen: true });
    const closedLayout = calculateWorkspaceScale({ viewportWidth: 1427, sidebarOpen: false });

    expect(closedLayout.designWidth).toBe(openLayout.designWidth);
    expect(closedLayout.availableWidth).toBe(1427 - WORKSPACE_SIDEBAR_COLLAPSED_WIDTH);
    expect(closedLayout.scale).toBeGreaterThan(openLayout.scale);
    expect(closedLayout.visualWidth).toBeCloseTo(closedLayout.availableWidth, 1);
  });

  it('uses a readability floor for narrow windows and reflows instead of clipping', () => {
    const layout = calculateWorkspaceScale({ viewportWidth: 900, sidebarOpen: true });

    expect(layout.scale).toBe(WORKSPACE_MIN_SCALE);
    expect(layout.designWidth).toBeLessThan(WORKSPACE_DESIGN_WIDTH);
    expect(layout.visualWidth).toBeCloseTo(layout.availableWidth, 1);
    expect(layout.overflowWidth).toBe(0);
  });

  it('never overflows horizontally down to the minimum desktop window size', () => {
    for (const viewportWidth of [760, 800, 868, 900, 1016, 1024, 1180, 1280, 1366]) {
      for (const sidebarOpen of [true, false]) {
        const layout = calculateWorkspaceScale({ viewportWidth, viewportHeight: 600, sidebarOpen });
        expect(layout.overflowWidth, `${viewportWidth}px sidebarOpen=${sidebarOpen}`).toBe(0);
        expect(layout.scale).toBeGreaterThanOrEqual(WORKSPACE_MIN_SCALE);
        expect(layout.designWidth).toBeLessThanOrEqual(WORKSPACE_DESIGN_WIDTH);
      }
    }
  });
});
