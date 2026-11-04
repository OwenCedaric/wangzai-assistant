import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(currentDirectory, '..', '..', 'App.jsx');
const stylesPath = path.resolve(currentDirectory, '..', '..', 'styles.css');

describe('critical route loading', () => {
  it('keeps the product workspace synchronous so first navigation cannot wait on a lazy suspense commit', async () => {
    const source = await fs.readFile(appPath, 'utf8');

    expect(source).toContain("import ProductListPage from './features/products/ProductListPage.jsx';");
    expect(source).not.toContain("const ProductListPage = lazyNamed(");
  });

  it('keeps the smart-tool workspace synchronous so opening it cannot fail on a late route chunk request', async () => {
    const source = await fs.readFile(appPath, 'utf8');

    expect(source).toContain("import PromptLibraryPage from './features/promptLibrary/PromptLibraryPage.jsx';");
    expect(source).not.toContain("const PromptLibraryPage = lazyNamed(");
  });

  it('splits hidden full-tree construction from the layout-producing activation', async () => {
    const [source, styles] = await Promise.all([
      fs.readFile(appPath, 'utf8'),
      fs.readFile(stylesPath, 'utf8'),
    ]);

    expect(source).toContain('React.startTransition(() => {');
    expect(source).toContain('setWorkspaceTabs((current) => appendWorkspaceTabUnique(current, nextTab));');
    expect(source).toContain('setPendingWorkspacePage(pageId);');
    expect(source).toContain('setPreparingWorkspacePage(pageId);');
    expect(source).not.toContain('const prepareLayout = () =>');
    expect(source).toContain('const activate = () => {');
    expect(source).toContain('setCurrentPage(preparingWorkspacePage);');
    expect(source).toContain('window.requestAnimationFrame(activate)');
    expect(source).not.toMatch(
      /setWorkspaceTabs\(\(current\)[\s\S]*?\);\s*navigateWorkspacePage\(pageId\);/u
    );
    expect(styles).toMatch(
      /\.page-panel\[hidden\]\s*\{[^}]*position:\s*absolute;[^}]*display:\s*block\s*!important;[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;[^}]*inset:\s*0;/u
    );
    expect(styles).not.toMatch(/\.page-panel\[hidden\]\s*\{[^}]*display:\s*none/u);
  });

  it('warms the settings code without mounting modal DOM and opens it as interruptible work', async () => {
    const source = await fs.readFile(appPath, 'utf8');

    expect(source).toContain("shopSettingsDialogLoadPromise ??= import('./features/settings/ShopSettingsDialog.jsx')");
    expect(source).toMatch(/React\.useEffect\(\(\) => \{[\s\S]*?void loadShopSettingsDialog\(\);[\s\S]*?\}, \[\]\);/u);
    expect(source).toMatch(/const handleOpen = [\s\S]*?React\.startTransition\(\(\) => setOpen\(true\)\)/u);
    expect(source).toContain("window.addEventListener('wangzai-settings-open', handleOpen)");
    expect(source).toContain("new CustomEvent('wangzai-settings-open', { detail: { moduleId } })");
    expect(source).toContain('React.startTransition(() => setOpen(true))');
    expect(source).toContain('setOpen(false)');
    expect(source).not.toContain("settingsRoot?.setAttribute('data-settings-open'");
    expect(source).toContain("window.dispatchEvent(new Event('wangzai-settings-closed'))");
    expect(source).not.toContain('settingsOpen={shopSettingsOpen}');
  });
});
