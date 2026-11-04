import { describe, expect, it } from 'vitest';
import pageSource from './PointsPackagesPage.jsx?raw';
import cardSource from './components/PointsPackageCard.jsx?raw';
import estimatorSource from './components/PointsPackageEstimator.jsx?raw';
import headerSource from './components/PointsPackageHeader.jsx?raw';

describe('points packages desktop presentation', () => {
  it('inherits the desktop workspace background instead of installing a standalone page theme', () => {
    expect(pageSource).toContain("bgcolor: 'transparent'");
    expect(pageSource).not.toContain('--points-');
    expect(pageSource).not.toContain('#f1f4ef');
  });

  it('keeps the embedded module free of landing-page branding and gradients', () => {
    expect(headerSource).not.toContain('AI 能力中心');
    expect(headerSource).not.toContain('linear-gradient');
    expect(cardSource).not.toContain('radial-gradient');
  });

  it('uses a light apricot and caramel palette instead of the previous blue, green, or plum theme', () => {
    const source = `${pageSource}\n${headerSource}\n${cardSource}\n${estimatorSource}`;
    expect(source).toContain('#a06e2f');
    expect(source).not.toContain('#5d87ff');
    expect(source).not.toContain('#176b5b');
    expect(source).not.toContain('#6f4f68');
  });
});
