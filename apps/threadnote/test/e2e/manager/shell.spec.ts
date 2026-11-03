import {test, expect} from './fixtures/test.js';

test('S02 every shipped section opens in an empty account @compat', async ({page}) => {
  const navigation = page.getByRole('navigation', {name: 'Manager sections'});
  const sections = [
    'Home',
    'Library',
    'Context',
    'Reviews',
    'Context Health',
    'Graph',
    'Worksets',
    'Development workflows',
    'Sharing',
    'Integrations',
    'Processes',
    'Runtime Health',
  ];
  await expect(navigation.getByRole('button')).toHaveCount(sections.length);
  for (const section of sections) {
    const button = navigation.getByRole('button', {name: section, exact: true});
    await button.click();
    await expect(button).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.topbar .page-title > span')).toHaveText(section);
    await expect(page.locator('.manager-content')).toBeVisible();
  }
});

test('S02 theme, keyboard navigation width and collapse persist after reload @compat', async ({page}) => {
  await page.getByRole('button', {name: 'Dark', exact: true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const resize = page.getByRole('separator', {name: 'Resize navigation panel'});
  const original = Number(await resize.getAttribute('aria-valuenow'));
  await resize.focus();
  await resize.press('ArrowRight');
  await expect.poll(async () => Number(await resize.getAttribute('aria-valuenow'))).toBeGreaterThan(original);
  const changed = await resize.getAttribute('aria-valuenow');
  await page.getByRole('button', {name: 'Collapse sidebar'}).click();
  await expect(page.getByRole('button', {name: 'Expand sidebar'})).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', {name: 'Expand sidebar'}).click();
  await expect(resize).toHaveAttribute('aria-valuenow', changed!);
});

test('S02 Home authors a user memory and the saved record survives reload @compat', async ({page, manager}) => {
  await page.getByRole('button', {name: 'New memory', exact: true}).first().click();
  await page.getByRole('textbox', {name: 'Memory title'}).fill('created-from-home');
  await page.getByPlaceholder('project', {exact: true}).fill('manager-e2e');
  await page
    .getByRole('textbox', {name: 'editable markdown', exact: true})
    .fill('A user-authored mémoire — 日本語 🧭.');
  await page.getByRole('button', {name: 'Save memory', exact: true}).click();
  await expect(page.getByText('Saved local memory', {exact: true})).toBeVisible();
  const uri = 'threadnote://user/playwright/memories/durable/projects/manager-e2e/created-from-home.md';
  const canonical = await manager.cli(['read', uri]);
  expect(canonical).toContain('A user-authored mémoire — 日本語 🧭.');
  expect(canonical).toContain('source_agent_client: user');
  await page.reload();
  await page.getByRole('button', {name: 'Library', exact: true}).click();
  await page.locator('.tree-file').filter({hasText: 'Created from home'}).click();
  await expect(page.getByText('A user-authored mémoire — 日本語 🧭.', {exact: true})).toBeVisible();
});

test('S02 project scope changes Home counts and the default project for authoring', async ({page, manager}) => {
  await manager.remember('First project handoff.', 'first-project', 'project-a');
  await manager.remember('Second project handoff.', 'second-project', 'project-b');
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  const memories = page.locator('.home-overview').getByRole('button', {name: /^Memories/u});
  await expect(memories.locator('strong')).toHaveText('2');
  await page.getByRole('combobox', {name: 'Workspace project', exact: true}).selectOption('project-a');
  await expect(page.locator('.home-overview')).toHaveAttribute('aria-label', 'Project overview');
  await expect(memories.locator('strong')).toHaveText('1');
  await page.getByRole('button', {name: 'New memory', exact: true}).first().click();
  await expect(page.getByPlaceholder('project', {exact: true})).toHaveValue('project-a');
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Home', exact: true})
    .click();
  await page.getByRole('combobox', {name: 'Workspace project', exact: true}).selectOption('');
  await expect(memories.locator('strong')).toHaveText('2');
});
