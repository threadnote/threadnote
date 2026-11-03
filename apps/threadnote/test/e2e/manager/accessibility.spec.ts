import {test, expect} from './fixtures/test.js';
import {String as EffectString} from 'effect';

test('S19 keyboard navigation, dialog focus containment and cancellation return focus without mutation', async ({
  page,
  manager,
}) => {
  const uri = await manager.remember('Keyboard cancellation sentinel.', 'keyboard-sentinel');
  const before = await manager.cli(['read', uri]);
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  const navigation = page.getByRole('navigation', {name: 'Manager sections'});
  await navigation.getByRole('button', {name: 'Home', exact: true}).focus();
  await page.keyboard.press('Tab');
  const library = navigation.getByRole('button', {name: 'Library', exact: true});
  await expect(library).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(library).toHaveAttribute('aria-current', 'page');
  const search = page.getByRole('searchbox', {name: 'Search Library'});
  await search.focus();
  await page.keyboard.insertText(uri);
  await page.keyboard.press('Enter');
  await search.fill('');
  const selected = page.getByRole('checkbox', {name: 'Select keyboard-sentinel.md', exact: true});
  await selected.focus();
  await page.keyboard.press('Space');
  await expect(selected).toBeChecked();
  const opener = page.getByRole('button', {name: 'Forget…', exact: true});
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {name: /^Forget 1 selected memor/u});
  const cancel = dialog.getByRole('button', {name: 'Cancel', exact: true});
  const confirm = dialog.getByRole('button', {name: 'Forget', exact: true});
  await expect(cancel).toBeFocused();
  await navigation.getByRole('button', {name: 'Home', exact: true}).focus();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await selected.uncheck();
  const actions = page.locator('.reader-head').getByRole('button', {name: /^Actions for /u});
  await actions.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', {name: 'Archive…', exact: true}).focus();
  await page.keyboard.press('Enter');
  const archive = page.getByRole('dialog', {name: 'Archive this memory?', exact: true});
  await expect(archive.getByRole('button', {name: 'Archive memory', exact: true})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(archive).toHaveCount(0);
  await expect(actions).toBeFocused();
  expect(await manager.cli(['read', uri])).toBe(before);
});

for (const layout of [
  {name: 'narrow desktop', width: 840, zoom: '1'},
  {name: '200 percent page zoom', width: 1280, zoom: '2'},
]) {
  test(`S19 ${layout.name} keeps long Unicode content and keyboard editing reachable`, async ({page, manager}) => {
    const marker = 'Mémoire — 日本語 🧭 العربية e\u0301';
    const body = `# Long Unicode content\n\n${EffectString.repeat(100)(`${marker} stays readable.\n\n`)}End of canonical Unicode content.`;
    const uri = await manager.remember(body, 'unicode-layout');
    await page
      .getByRole('navigation', {name: 'Manager sections'})
      .getByRole('button', {name: 'Library', exact: true})
      .click();
    const search = page.getByRole('searchbox', {name: 'Search Library'});
    await search.fill(uri);
    await search.press('Enter');
    await page.getByRole('button', {name: 'Collapse sidebar', exact: true}).click();
    await page.setViewportSize({width: layout.width, height: 800});
    await page.evaluate(zoom => {
      document.documentElement.style.zoom = zoom;
    }, layout.zoom);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).zoom)).toBe(layout.zoom);
    await expect(page.locator('.markdown-viewer')).toContainText(marker);
    await expect(page.locator('.markdown-viewer')).toContainText('End of canonical Unicode content.');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
    const edit = page.getByRole('button', {name: 'Edit', exact: true});
    await expect(edit).toBeInViewport({ratio: 1});
    await edit.focus();
    await page.keyboard.press('Enter');
    const editor = page.getByRole('textbox', {name: 'editable markdown', exact: true});
    await editor.focus();
    await editor.press('ControlOrMeta+End');
    await editor.press('Enter');
    await page.keyboard.insertText('Keyboard addition — 日本語 🧭.');
    const save = page.getByRole('button', {name: 'Save', exact: true});
    await save.focus();
    await expect(save).toBeInViewport({ratio: 1});
    await page.keyboard.press('Enter');
    await expect.poll(() => manager.cli(['read', uri])).toContain('Keyboard addition — 日本語 🧭.');
    const saved = await manager.cli(['read', uri]);
    expect(saved).toContain(marker);
    expect(saved).toContain('End of canonical Unicode content.');
  });
}

test('S20 pinned Chromium exposes real WebGL2 and compiled runtime identity', async ({page, browser, manager}) => {
  const rendering = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2');
    const available = context !== null && !context.isContextLost();
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return available;
  });
  expect(rendering).toBe(true);
  const runtime = await manager.api('/api/runtime/updates?view=status');
  expect(runtime.runningVersion).toBe(manager.expectedVersion);
  expect(browser.browserType().name()).toBe(test.info().project.name);
  await test.info().attach('runtime-provenance.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      engine: browser.browserType().name(),
      browserVersion: browser.version(),
      runningVersion: runtime.runningVersion,
      webgl2: rendering,
    }),
  });
});
