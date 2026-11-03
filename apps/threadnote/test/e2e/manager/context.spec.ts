import {test, expect} from './fixtures/test.js';
import {createRepository, indexRepository, rememberCited} from './fixtures/repositories.js';
import {Array as EffectArray, pipe} from 'effect';

test('S10 repository Context Brief reads real graph anchors and cited canonical memory', async ({page, manager}) => {
  test.setTimeout(60_000);
  const repository = await createRepository(manager);
  await indexRepository(manager, repository);
  const uri = await rememberCited(manager, repository);
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Context', exact: true})
    .click();
  await page
    .getByRole('textbox', {name: 'Task', exact: true})
    .fill('Explain alphaGreeting and the greeting-contract decision.');
  await page.getByRole('combobox', {name: 'Repository', exact: true}).selectOption(repository.root);
  await page.getByRole('combobox', {name: 'Mode', exact: true}).selectOption('explain');
  await page.getByText('Evidence and budget', {exact: true}).click();
  await page.getByRole('textbox', {name: /^Code anchors/u}).fill('src/entry.ts');
  await page.getByRole('combobox', {name: 'Evidence detail', exact: true}).selectOption('source');
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/context/brief');
  await page.getByRole('button', {name: 'Build brief', exact: true}).click();
  expect((await response).ok()).toBe(true);
  const result = page.locator('.context-brief-result');
  await expect(result).toContainText('src/entry.ts');
  await expect(result).toContainText('Keep the alphaGreeting greeting contract stable.');
  const memory = result
    .locator('.context-memory-card')
    .filter({hasText: 'Keep the alphaGreeting greeting contract stable.'});
  await memory.getByRole('button', {name: 'Open memory', exact: true}).click();
  const reader = page.getByRole('complementary', {name: 'Canonical context reader'});
  await expect(reader).toContainText(uri);
  await expect(reader.locator('pre')).toContainText('Keep the alphaGreeting greeting contract stable.');
  expect(
    await manager.cli([
      'context',
      'brief',
      '--cwd',
      repository.root,
      '--project',
      repository.name,
      '--task',
      'Explain alphaGreeting and the greeting-contract decision.',
      '--code-ref',
      'src/entry.ts',
    ]),
  ).toContain('src/entry.ts');
});

test('S10 empty scope and unsafe anchors are refused, and an interrupted request can be retried', async ({
  page,
  manager,
  browserName,
}) => {
  const repository = await createRepository(manager);
  await indexRepository(manager, repository);
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Context', exact: true})
    .click();
  await page.getByRole('textbox', {name: 'Task', exact: true}).fill('Explain alphaGreeting.');
  await expect(page.getByRole('button', {name: 'Build brief', exact: true})).toBeDisabled();
  await page.getByRole('combobox', {name: 'Repository', exact: true}).selectOption(repository.root);
  await page.getByText('Evidence and budget', {exact: true}).click();
  const anchors = page.getByRole('textbox', {name: /^Code anchors/u});
  await anchors.fill('../outside.ts');
  await expect(page.getByRole('button', {name: 'Build brief', exact: true})).toBeDisabled();
  await expect(page.locator('.context-code-refs').getByRole('alert')).toBeVisible();
  await anchors.fill('src/entry.ts');
  const timeoutError = {
    chromium: 'net::ERR_TIMED_OUT',
    firefox: 'NS_ERROR_NET_TIMEOUT',
    webkit: 'Blocked by Web Inspector',
  }[browserName];
  manager.expectedRequestErrors.push({path: '/api/context/brief', error: timeoutError});
  await page.route('**/api/context/brief', route => route.abort('timedout'), {times: 1});
  await page.getByRole('button', {name: 'Build brief', exact: true}).click();
  await expect(page.locator('.context-evidence-card').getByRole('alert')).toContainText(
    /fetch|failed|timeout|network/iu,
  );
  await expect(page.locator('.context-brief-result')).toHaveCount(0);
  await page.getByRole('button', {name: 'Build brief', exact: true}).click();
  await expect(page.locator('.context-brief-result')).toContainText('src/entry.ts');
});

test('S10 an unprepared repository reports missing graph evidence without silently indexing it', async ({
  page,
  manager,
}) => {
  const repository = await createRepository(manager);
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Context', exact: true})
    .click();
  await page
    .getByRole('textbox', {name: 'Task', exact: true})
    .fill('Explain alphaGreeting in this unprepared repository.');
  await page.getByRole('combobox', {name: 'Repository', exact: true}).selectOption(repository.root);
  await page.getByRole('button', {name: 'Build brief', exact: true}).click();
  await expect(page.locator('.context-brief-result')).toContainText('0/1 ready');
  await expect(page.locator('.context-evidence-card')).toContainText(/missing|unavailable|not.ready/iu);
  expect((await manager.api('/api/graphs')).repositories).toEqual([]);
});

test('S10 bounded canonical pages retain the entire Unicode memory and scoped recall excludes neighbors', async ({
  page,
  manager,
}) => {
  const body = pipe(
    EffectArray.range(0, 179),
    EffectArray.map(
      index =>
        `Paragraph ${index}: paging-fixture-needle — café 日本語 🧭. Keep this complete synthetic decision and its evidence.`,
    ),
    EffectArray.join('\n\n'),
  );
  const uri = await manager.remember(body, 'paging-fixture-needle', 'project-a');
  await manager.remember('paging-fixture-needle unrelated neighbor.', 'excluded-neighbor', 'project-b');
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Context', exact: true})
    .click();
  await page.getByRole('tab', {name: 'Recall', exact: true}).click();
  await page.getByRole('combobox', {name: 'Memory project', exact: true}).selectOption('project-a');
  await page.getByRole('textbox', {name: 'Recall query', exact: true}).fill('paging-fixture-needle');
  await page.getByRole('button', {name: 'Recall context', exact: true}).click();
  const results = page.locator('.context-recall-card');
  await expect(results).toHaveCount(1);
  await results.getByRole('button').first().click();
  const reader = page.getByRole('complementary', {name: 'Canonical context reader'});
  await expect(reader).toContainText(uri);
  await expect(reader.locator('pre')).toContainText('Paragraph 0:');
  const parts: string[] = [];
  for (let count = 0; count < 20; count++) {
    parts.push((await reader.locator('pre').textContent()) ?? '');
    const next = reader.getByRole('button', {name: 'Next page', exact: true});
    if (!(await next.isEnabled())) break;
    const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/context/read');
    await next.click();
    const reply = await response;
    expect(reply.ok()).toBe(true);
    const result = await reply.json();
    await expect.poll(() => reader.locator('pre').textContent()).toBe(result.content);
  }
  expect(parts.length).toBeGreaterThan(1);
  expect(EffectArray.join(parts, '')).toBe(body);
  expect(await manager.cli(['read', uri])).toContain(body);
});
