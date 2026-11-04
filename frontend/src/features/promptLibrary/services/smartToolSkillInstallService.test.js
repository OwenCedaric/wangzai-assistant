import { describe, expect, it, vi } from 'vitest';
import { resolveSmartToolSkillInstallUrl } from './smartToolSkillInstallService.js';

describe('smartToolSkillInstallService', () => {
  it('resolves a GitHub Skill package only through local-api', async () => {
    const requester = vi.fn().mockResolvedValue({
      source: {
        fileName: 'SKILL.md',
        installType: 'github-skill',
        sourceUrl: 'https://github.com/acme/skill',
        repository: 'acme/skill',
        ref: 'main',
        markdown: '---\nname: demo\n---\n# Demo',
        referenceFiles: [{ path: 'references/workflow.md', content: '# Workflow' }],
        executableFiles: [],
        sourceHash: 'abc123',
      },
    });

    const source = await resolveSmartToolSkillInstallUrl('https://github.com/acme/skill', { requester });

    expect(requester).toHaveBeenCalledWith('/api/prompt-library/skill-source/resolve', {
      method: 'POST',
      body: { url: 'https://github.com/acme/skill' },
      timeoutMs: 60_000,
      signal: undefined,
    });
    expect(source).toMatchObject({
      repository: 'acme/skill',
      ref: 'main',
      referenceFiles: [{ path: 'references/workflow.md', content: '# Workflow' }],
    });
  });

  it('rejects non-HTTPS links before contacting local-api', async () => {
    const requester = vi.fn();
    await expect(resolveSmartToolSkillInstallUrl('http://example.com/SKILL.md', { requester })).rejects.toThrow(
      '必须使用 HTTPS'
    );
    expect(requester).not.toHaveBeenCalled();
  });
});
