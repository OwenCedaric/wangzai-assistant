import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('critical route bundle boundary', () => {
  it('keeps critical routes synchronous without mixing static and dynamic store imports', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/App.jsx'), 'utf8');
    expect(source).toContain("import ProductListPage from './features/products/ProductListPage.jsx'");
    expect(source).toContain("import PromptLibraryPage from './features/promptLibrary/PromptLibraryPage.jsx'");
    expect(source).toContain(
      "import { loadPromptLibraryStore } from './features/promptLibrary/lib/promptLibraryStore.jsx';"
    );
    expect(source).not.toContain("import('./features/promptLibrary/lib/promptLibraryStore.jsx')");
    const promptPageSource = readFileSync(
      path.resolve(process.cwd(), 'src/features/promptLibrary/PromptLibraryPage.jsx'),
      'utf8'
    );
    expect(promptPageSource).not.toContain(
      "import { PromptLibraryRunTask } from './components/PromptLibraryRunTask.jsx'"
    );
    expect(promptPageSource).toContain("import('./components/PromptLibraryRunTask.jsx')");
  });
});
