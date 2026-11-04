import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDataAnalysisInsight } from './useDataAnalysisInsight.js';

function InsightHarness({ promptConfig }) {
  const insight = useDataAnalysisInsight({
    filters: { shopId: 'shop-1', startDate: '2026-07-01', endDate: '2026-07-21' },
    promptConfig,
    enabled: false,
  });
  return <span>{insight.status}</span>;
}

describe('useDataAnalysisInsight', () => {
  it('accepts a null Skill configuration when data analysis is opened from the page header', () => {
    render(<InsightHarness promptConfig={null} />);
    expect(screen.getByText('idle')).toBeInTheDocument();
  });
});
