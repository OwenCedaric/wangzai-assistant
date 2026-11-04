import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../../../test/appSource.js';
import { buildTrafficTrendSeries, DataAnalysisTrafficFunnel } from './DataAnalysisTrafficPanels.jsx';
import React from 'react';

describe('data analysis traffic layout', () => {
  it('lets only the traffic module use natural-height paired cards', () => {
    const source = readProjectSource('src/features/dataAnalysis/components/DataAnalysisModuleContent.jsx');
    const naturalHeightLayouts = source.match(/<ResponsiveTwoColumn[^>]*equalHeight=\{false\}[^>]*>/g) || [];

    expect(source).toContain('function ResponsiveTwoColumn({ children, wideLeft = false, equalHeight = true })');
    expect(source).toContain("alignItems: equalHeight ? 'stretch' : 'start'");
    expect(naturalHeightLayouts).toEqual(['<ResponsiveTwoColumn wideLeft equalHeight={false}>']);
    expect(source).toMatch(/<ResponsiveTwoColumn wideLeft equalHeight=\{false\}>\s*<DataAnalysisTrafficTrend/);
    expect(source).toMatch(/<DataAnalysisTrafficFunnel[\s\S]*?showExtendedInsights/);
  });

  it('fills the traffic detail funnel with source-derived conversion metrics', () => {
    render(
      React.createElement(DataAnalysisTrafficFunnel, {
        funnel: [
          { id: 'sessions', label: '访问次数', value: 10538 },
          { id: 'views', label: '商品浏览', value: 15361 },
          { id: 'cart', label: '加入购物车', value: 77 },
          { id: 'orders', label: '下单件数', value: 28 },
        ],
        coverage: { startDate: '2026-06-12', endDate: '2026-07-10', dayCount: 29 },
        showExtendedInsights: true,
      })
    );

    expect(screen.getByText('访问到加购')).toBeInTheDocument();
    expect(screen.getByText('0.73%')).toBeInTheDocument();
    expect(screen.getByText('访问到下单件')).toBeInTheDocument();
    expect(screen.getByText('0.27%')).toBeInTheDocument();
    expect(screen.getByText('浏览到下单件')).toBeInTheDocument();
    expect(screen.getByText('0.18%')).toBeInTheDocument();
  });

  it('keeps missing traffic values distinct from confirmed zero values', () => {
    expect(buildTrafficTrendSeries([
      { visitorSessions: null },
      { visitorSessions: 0 },
      { visitorSessions: 12 },
    ], 'visitorSessions')).toEqual([null, 0, 12]);

    render(
      React.createElement(DataAnalysisTrafficFunnel, {
        funnel: [
          { id: 'sessions', label: '访问次数', value: 0 },
          { id: 'views', label: '商品浏览', value: null },
          { id: 'cart', label: '加入购物车', value: null, rate: null },
          { id: 'orders', label: '下单件数', value: null, rate: null },
        ],
      })
    );

    const confirmedZeroRow = within(screen.getByTestId('traffic-funnel-row-sessions'));
    const missingRow = within(screen.getByTestId('traffic-funnel-row-views'));
    expect(confirmedZeroRow.getByText('0')).toBeInTheDocument();
    expect(missingRow.queryByText('0')).not.toBeInTheDocument();
    expect(missingRow.getAllByText('—').length).toBeGreaterThan(0);
  });
});
