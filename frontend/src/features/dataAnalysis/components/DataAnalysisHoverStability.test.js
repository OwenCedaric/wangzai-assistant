import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../../../test/appSource.js';

describe('data analysis hover stability', () => {
  it('keeps large interactive hit areas stationary while hovered', () => {
    const metricGridSource = readProjectSource('src/features/dataAnalysis/components/DataAnalysisMetricGrid.jsx');
    const stylesSource = readProjectSource('src/styles.css');

    expect(metricGridSource).toContain('className="data-analysis-kpi-card"');
    expect(metricGridSource).not.toMatch(/transform:\s*['"]translateY\(/);
    expect(stylesSource).toContain(
      ".data-analysis-page :where(button, [role='button'], .MuiButtonBase-root, .MuiButton-root, .MuiIconButton-root)"
    );
    expect(stylesSource).toContain(
      '.data-analysis-page .data-analysis-kpi-card:hover {\n  transform: none !important;'
    );
  });
});
