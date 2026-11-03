import {String as EffectString, Array as EffectArray} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';
import {test, expect} from './fixtures/test.js';
import {createRepository, indexRepository, rememberCited} from './fixtures/repositories.js';
import {readFile, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';

test('S12 Context Health exposes current evidence and maintenance controls without hidden memory edits', async ({
  page,
  manager,
}) => {
  test.setTimeout(90_000);
  const repository = await createRepository(manager);
  await indexRepository(manager, repository);
  const uri = await rememberCited(manager, repository);
  const before = await manager.cli(['read', uri]);
  await writeFile(
    join(repository.root, 'src/entry.ts'),
    EffectString.replace('return normalize(name)', "return normalize(name) + '!'")(repository.source),
  );
  await indexRepository(manager, repository);
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Context Health', exact: true})
    .click();
  await page.getByRole('combobox', {name: 'Workspace project', exact: true}).selectOption('alpha');
  await expect(page.getByRole('region', {name: 'Automatic maintenance controls', exact: true})).toBeVisible();
  const controls = page.getByRole('region', {name: 'Automatic maintenance controls', exact: true});
  await controls.getByRole('button', {name: 'Enable automatic maintenance', exact: true}).click();
  await expect(controls.getByRole('button', {name: 'Pause automatic maintenance', exact: true})).toBeVisible();
  expect(await manager.api('/api/attention/context-maintenance?view=controls')).toMatchObject({paused: false});
  await page.getByRole('tab', {name: 'Automatic recovery', exact: true}).click();
  const running = page.waitForResponse(
    response =>
      new URL(response.url()).pathname === '/api/attention/context-maintenance' &&
      response.request().postDataJSON()?.action === 'run-now',
  );
  await page.getByRole('button', {name: 'Run maintenance now', exact: true}).click();
  expect((await running).ok()).toBe(true);
  await expect
    .poll(
      async () => {
        const status = await manager.api('/api/attention/context-maintenance?project=alpha');
        if (!EffectArray.isArray(status.projects)) return 0;
        for (const project of status.projects)
          if (isJsonObject(project) && project.project === 'alpha' && typeof project.checked === 'number')
            return project.checked;
        return 0;
      },
      {timeout: 20_000},
    )
    .toBeGreaterThan(0);
  await controls.getByRole('button', {name: 'Pause automatic maintenance', exact: true}).click();
  await expect(controls.getByRole('button', {name: 'Enable automatic maintenance', exact: true})).toBeVisible();
  expect(await manager.api('/api/attention/context-maintenance?view=controls')).toMatchObject({paused: true});
  await page.getByRole('tab', {name: 'Automatic recovery', exact: true}).click();
  await expect(page.locator('.health-coverage-card > header .health-status-badge')).toHaveText('partial');
  await page.getByRole('tab', {name: /^Needs a decision/u}).click();
  await page.getByRole('button', {name: 'Compare evidence and preview change', exact: true}).click();
  const detail = page.getByRole('dialog', {name: 'Citation changed', exact: true});
  await expect(detail).toContainText('Keep the alphaGreeting greeting contract stable.');
  const preview = page.waitForResponse(response => new URL(response.url()).pathname === '/api/context-health/preview');
  await detail.getByRole('button', {name: 'Preview repair', exact: true}).click();
  expect((await preview).ok()).toBe(true);
  await expect(detail).toContainText(/manual review|review.only|current source|proposed/iu);
  await detail.getByRole('button', {name: 'Close details', exact: true}).click();
  expect(await manager.cli(['read', uri])).toBe(before);
  expect(await readFile(join(repository.root, 'src/entry.ts'), 'utf8')).toContain("'!'");
});

test('S12 unresolved relations require a reviewed edit and preserve authored content', async ({page, manager}) => {
  test.setTimeout(60_000);
  const repository = await createRepository(manager);
  await indexRepository(manager, repository);
  const target = await manager.remember('A temporary relation target.', 'retired-target', 'alpha', 'durable');
  const output = await manager.cli([
    'remember',
    '--kind',
    'durable',
    '--project',
    'alpha',
    '--topic',
    'relation-owner',
    '--relation',
    `related_to=${target}`,
    '--text',
    'Keep this authored body exactly.',
  ]);
  const uri = /Stored memory: (threadnote:\/\/\S+)/u.exec(output)?.[1];
  if (!uri) throw new Error('Missing relation owner receipt.');
  const before = await manager.cli(['read', uri]);
  await manager.cli(['forget', target]);
  expect(await manager.cli(['read', uri])).toBe(before);
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: /^Context Health/u})
    .click();
  await page.getByRole('combobox', {name: 'Workspace project', exact: true}).selectOption('alpha');
  await page.getByRole('tab', {name: 'Automatic recovery', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Run maintenance now', exact: true})).toBeDisabled();
  const controls = page.getByRole('region', {name: 'Automatic maintenance controls', exact: true});
  await controls.getByRole('button', {name: 'Enable automatic maintenance', exact: true}).click();
  await expect(controls.getByRole('button', {name: 'Pause automatic maintenance', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Run maintenance now', exact: true}).click();
  await page.getByRole('tab', {name: /^Needs a decision/u}).click();
  await page.getByRole('button', {name: 'Review memory and evidence', exact: true}).click();
  const decision = page.getByRole('dialog');
  await expect(decision).toContainText('Keep this authored body exactly.');
  await decision.getByRole('button', {name: 'Close details', exact: true}).click();
  expect(await manager.cli(['read', uri])).toBe(before);
  await controls.getByRole('button', {name: 'Pause automatic maintenance', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Context', exact: true})
    .click();
  await page.getByRole('tab', {name: 'Recall', exact: true}).click();
  await page.getByRole('textbox', {name: 'Recall query', exact: true}).fill('relation-owner');
  await page.getByRole('button', {name: 'Recall context', exact: true}).click();
  await page.locator('.context-recall-card').filter({hasText: 'relation-owner'}).getByRole('button').first().click();
  const reader = page.getByRole('complementary', {name: 'Canonical context reader'});
  await reader.getByRole('tab', {name: 'Connections', exact: true}).click();
  await reader.locator('.context-relation-editor').getByRole('button', {name: 'Remove', exact: true}).click();
  await reader.getByRole('button', {name: 'Save relations', exact: true}).click();
  await expect.poll(() => manager.cli(['read', uri])).not.toContain('relation: related_to');
  const after = await manager.cli(['read', uri]);
  expect(after).toContain('Keep this authored body exactly.');
  expect(/memory_id: (tn_\S+)/u.exec(after)?.[1]).toBe(/memory_id: (tn_\S+)/u.exec(before)?.[1]);
});

test('S12 missing repository evidence remains unknown and offers no unsupported repair', async ({page, manager}) => {
  const uri = await manager.remember('Unverified fixture knowledge.', 'unknown-evidence', 'manager-e2e', 'durable');
  const before = await manager.cli(['read', uri]);
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: /^Context Health/u})
    .click();
  await page.getByRole('combobox', {name: 'Workspace project', exact: true}).selectOption('manager-e2e');
  await expect(
    page.getByText(
      'Repository evidence is unavailable for this project. Citation and relation repairs require a configured local checkout.',
      {exact: true},
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', {name: 'Compare evidence and preview change', exact: true})).toHaveCount(0);
  expect(await manager.api('/api/context-health?project=manager-e2e')).toMatchObject({
    status: 'unknown',
    repositoryEvidence: {state: 'unavailable'},
  });
  expect(await manager.cli(['read', uri])).toBe(before);
});
