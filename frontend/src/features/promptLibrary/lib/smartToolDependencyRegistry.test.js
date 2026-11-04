import { describe, expect, it } from 'vitest';
import {
  createSmartToolDependencyManifest,
  normalizeSmartToolDependencyBindings,
  resolveSmartToolDependencyState,
  SMART_TOOL_DEPENDENCY_REQUIREMENT,
  SMART_TOOL_DEPENDENCY_RESOLUTION,
} from './smartToolDependencyRegistry.js';

function reference(id, heading) {
  return {
    id,
    label: id.slice(1),
    sourcePaths: ['SKILL.md'],
    sourceSections: [heading],
  };
}

describe('smartToolDependencyRegistry', () => {
  it('classifies mentioned tools as embedded or conditional instead of treating all as required', () => {
    const manifest = createSmartToolDependencyManifest({
      referencedTools: [
        reference('$imagegen', 'Generate images'),
        reference('$grill-me', 'Evidence interview'),
        reference('$drive-cross-border-ecommerce', 'Project work'),
      ],
      ruleCatalog: [
        {
          sourcePath: 'SKILL.md',
          heading: 'Generate images',
          content: 'Use $imagegen for actual image generation when Step4 images is requested.',
        },
        {
          sourcePath: 'SKILL.md',
          heading: 'Evidence interview',
          content: 'Adapt only the useful interview behavior from $grill-me.',
        },
        {
          sourcePath: 'SKILL.md',
          heading: 'Project work',
          content: 'Use $drive-cross-border-ecommerce when this work is part of a broader project.',
        },
      ],
    });

    expect(manifest.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: '$imagegen',
          requirement: SMART_TOOL_DEPENDENCY_REQUIREMENT.CONDITIONAL,
          recommendedResolution: SMART_TOOL_DEPENDENCY_RESOLUTION.BUILTIN,
        }),
        expect.objectContaining({
          id: '$grill-me',
          requirement: SMART_TOOL_DEPENDENCY_REQUIREMENT.EMBEDDED,
          recommendedResolution: SMART_TOOL_DEPENDENCY_RESOLUTION.BUILTIN,
        }),
        expect.objectContaining({
          id: '$drive-cross-border-ecommerce',
          requirement: SMART_TOOL_DEPENDENCY_REQUIREMENT.CONDITIONAL,
          recommendedResolution: SMART_TOOL_DEPENDENCY_RESOLUTION.DISABLED,
        }),
      ])
    );
    expect(manifest.requiredCount).toBe(0);
    expect(manifest.conditionalCount).toBe(2);
    expect(manifest.embeddedCount).toBe(1);
  });

  it('checks only dependencies activated by the selected run scope', () => {
    const manifest = createSmartToolDependencyManifest({
      referencedTools: [
        reference('$imagegen', 'Generate images'),
        reference('$ozon-step4-prompt-library', 'Style library'),
      ],
      ruleCatalog: [
        {
          sourcePath: 'SKILL.md',
          heading: 'Generate images',
          content: 'Use $imagegen when Step4 images is requested.',
        },
        {
          sourcePath: 'SKILL.md',
          heading: 'Style library',
          content: 'Use $ozon-step4-prompt-library when learning a reusable style.',
        },
      ],
    });
    const bindings = normalizeSmartToolDependencyBindings(manifest);
    const tool = {
      id: 'installed-card-skill',
      skillProfile: {
        dependencyManifest: manifest,
        dependencyBindings: bindings,
        executionPlan: {
          version: 1,
          steps: [
            { id: 'model.image.generate', compileStatus: 'executable' },
            { id: 'product-image-storage', compileStatus: 'executable' },
          ],
        },
      },
    };

    const imageRun = resolveSmartToolDependencyState(tool, { 处理模式: 'Step4 images' });
    expect(imageRun.canStart).toBe(true);
    expect(imageRun.dependencies.find((item) => item.id === '$imagegen')).toMatchObject({
      active: true,
      ready: true,
    });
    expect(imageRun.dependencies.find((item) => item.id === '$ozon-step4-prompt-library')).toMatchObject({
      active: false,
      ready: true,
    });

    const styleRun = resolveSmartToolDependencyState(tool, { 处理模式: '学习复用风格' });
    expect(styleRun.canStart).toBe(false);
    expect(styleRun.blocked).toEqual([
      expect.objectContaining({ id: '$ozon-step4-prompt-library', status: 'disabled' }),
    ]);
  });
});
