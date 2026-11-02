import {test, expect} from './fixtures/test.js';

test('S01 opens the actual compiled Manager with protected APIs @compat', async ({page, manager, request}) => {
  await expect(page.getByRole('heading', {name: 'Threadnote', exact: true})).toBeVisible();
  expect((await manager.api('/api/state')).version).toBe(manager.expectedVersion);
  const denied = await request.get(manager.origin + '/api/tree');
  expect(denied.status()).toBe(401);
  const mutation = await request.post(manager.origin + '/api/memory/save', {data: {content: 'unauthorized'}});
  expect(mutation.status()).toBe(401);
  expect(
    (
      await request.get(manager.origin + '/api/tree', {headers: {authorization: 'Bearer invalid-fixture-token'}})
    ).status(),
  ).toBe(401);
  for (const authorization of ['', 'Bearer invalid-fixture-token']) {
    const live = await request.post(manager.origin + '/api/live-session', {
      headers: {origin: manager.origin, ...(authorization ? {authorization} : {})},
      data: {topics: ['library']},
    });
    expect(live.status()).toBe(401);
  }
  expect(
    (
      await request.get(manager.origin + '/api/live?ticket=invalid-fixture-ticket', {headers: {origin: manager.origin}})
    ).status(),
  ).toBe(401);
  await expect(page.locator('link[href="/app.css"]')).toHaveCount(1);
  expect(
    await page
      .locator('.brand-logo')
      .first()
      .evaluate(image => image instanceof HTMLImageElement && image.naturalWidth > 0),
  ).toBe(true);
});

test.describe('source asset resolution', () => {
  test.use({managerMode: 'source'});
  test('S01 source mode renders the same real Manager bundle', async ({page}) => {
    await expect(page.getByRole('navigation', {name: 'Manager sections'})).toBeVisible();
    await page.getByRole('button', {name: 'Library', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Your private memory library', exact: true})).toBeVisible();
  });
});

test.describe('populated disposable home', () => {
  test.use({managerScenario: 'populated'});
  test('S01 reads a real CLI-authored memory in the browser @compat', async ({page}) => {
    await page.getByRole('button', {name: 'Library', exact: true}).click();
    await page.locator('.tree-file').filter({hasText: 'Browser fixture'}).click();
    await expect(page.getByText('A synthetic memory for Manager browser coverage.', {exact: true})).toBeVisible();
    await expect(page.frameLocator('iframe[title="Mermaid diagram"]').locator('svg')).toBeVisible();
    await page.getByRole('button', {name: 'Edit', exact: true}).click();
    await expect(page.getByRole('textbox', {name: 'editable markdown', exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Preview', exact: true}).click();
  });
});
