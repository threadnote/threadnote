import {test, expect} from './fixtures/test.js';
import {createRepository, indexRepository, rememberCited} from './fixtures/repositories.js';
import {readFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';

test('S08 the real graph scene queries a symbol and opens indexed source and relationships', async ({
  page,
  manager,
}) => {
  test.setTimeout(90_000);
  const repository = await createRepository(manager);
  expect(await indexRepository(manager, repository)).toContain('ready');
  const uri = await rememberCited(manager, repository);
  expect(await manager.cli(['read', uri])).toContain('code_citation:');
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Graph', exact: true})
    .click();
  await page.getByText('Search and relationship filters', {exact: true}).click();
  await page.getByRole('searchbox', {name: 'Query the code graph', exact: true}).fill(repository.symbol);
  const querying = page.waitForResponse(response => new URL(response.url()).pathname === '/api/graph/query');
  await page.getByRole('button', {name: 'Query graph', exact: true}).click();
  expect((await querying).ok()).toBe(true);
  await expect(page.getByRole('button', {name: 'Query graph', exact: true})).toBeEnabled();
  await page.getByText('Search and relationship filters', {exact: true}).click();
  await expect(page.locator('canvas')).toBeVisible();
  expect(
    await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('webgl2');
      return context !== null && !context.isContextLost();
    }),
  ).toBe(true);
  await page.getByRole('searchbox', {name: 'Find in current view', exact: true}).fill(repository.symbol);
  const result = page.locator('.graph-search-results').getByRole('button').filter({hasText: repository.symbol});
  await expect(result).toBeVisible();
  await result.click();
  const inspector = page.locator('.node-inspector');
  await expect(inspector.getByRole('heading', {name: repository.symbol, exact: true})).toBeVisible();
  await expect(inspector.locator('.source-location')).toContainText('src/entry.ts');
  await expect(inspector.locator('.node-signature')).toContainText('name: string');
  await inspector.getByRole('tab', {name: 'Relations', exact: true}).click();
  await expect(inspector.locator('.relationship-view')).toContainText(/calls|normalize/iu);
  await inspector.getByRole('tab', {name: 'Evidence', exact: true}).click();
  await expect(inspector).toContainText('src/entry.ts');
});

test('S09 graph view removal uses an exact preview, cancellation preserves it and confirmation preserves source', async ({
  page,
  manager,
}) => {
  test.setTimeout(60_000);
  const repository = await createRepository(manager);
  await indexRepository(manager, repository);
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Graph', exact: true})
    .click();
  await page.getByRole('tab', {name: /^Indexes & administration/u}).click();
  const remove = page.getByRole('button', {name: /^Remove active worktree view /u});
  await expect(remove).toBeVisible();
  await remove.click();
  const dialog = page.getByRole('dialog', {name: 'Remove this indexed view?', exact: true});
  await expect(dialog).toContainText(/alpha|snapshot|view/iu);
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(remove).toBeVisible();
  expect((await manager.api('/api/graphs')).repositories).toHaveLength(1);
  await remove.click();
  await dialog.getByRole('button', {name: 'Remove view', exact: true}).click();
  await expect(remove).toHaveCount(0);
  expect((await manager.api('/api/graphs')).repositories).toHaveLength(0);
  expect(await readFile(join(repository.root, 'src/entry.ts'), 'utf8')).toBe(repository.source);
});

const graphPairTest = test.extend({managerScenario: 'graph-pair'});

graphPairTest('S09 a delayed query from the old repository cannot replace the selected repository', async ({page}) => {
  test.setTimeout(60_000);
  const alpha = {symbol: 'alphaGreeting'};
  const beta = {symbol: 'betaGreeting'};
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Graph', exact: true})
    .click();
  await page.getByRole('combobox', {name: 'Repository', exact: true}).selectOption({label: 'alpha'});
  let release = () => {};
  let admitted = () => {};
  let completed = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const pending = new Promise<void>(resolve => {
    admitted = resolve;
  });
  const fulfilled = new Promise<void>(resolve => {
    completed = resolve;
  });
  await page.route('**/api/graph/query?*', async route => {
    const response = await route.fetch();
    if (new URL(route.request().url()).searchParams.get('query') === alpha.symbol) {
      admitted();
      await gate;
      try {
        await route.fulfill({response});
      } finally {
        completed();
      }
      return;
    }
    await route.fulfill({response});
  });
  try {
    await page.getByText('Search and relationship filters', {exact: true}).click();
    await page.getByRole('searchbox', {name: 'Query the code graph', exact: true}).fill(alpha.symbol);
    await page.getByRole('button', {name: 'Query graph', exact: true}).click();
    await pending;
    await page.getByRole('combobox', {name: 'Repository', exact: true}).selectOption({label: 'beta'});
    await expect(page.getByRole('searchbox', {name: 'Query the code graph', exact: true})).toHaveValue('');
    await page.getByRole('searchbox', {name: 'Query the code graph', exact: true}).fill(beta.symbol);
    const querying = page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/graph/query' &&
        new URL(response.url()).searchParams.get('query') === beta.symbol,
    );
    await page.getByRole('button', {name: 'Query graph', exact: true}).click();
    expect((await querying).ok()).toBe(true);
    await expect(page.getByRole('button', {name: 'Query graph', exact: true})).toBeEnabled();
    await page.getByText('Search and relationship filters', {exact: true}).click();
    await page.getByRole('searchbox', {name: 'Find in current view', exact: true}).fill(beta.symbol);
    const result = page.locator('.graph-search-results').getByRole('button').filter({hasText: beta.symbol});
    await expect(result).toBeVisible();
    await result.click();
    await expect(page.locator('.node-inspector h3')).toHaveText(beta.symbol);
    release();
    await fulfilled;
    await page.evaluate(
      () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect(page.locator('.node-inspector h3')).toHaveText(beta.symbol);
    await expect(page.locator('.node-inspector')).not.toContainText(alpha.symbol);
  } finally {
    release();
  }
});
