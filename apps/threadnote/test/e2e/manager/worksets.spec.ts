import {test, expect} from './fixtures/test.js';
import {createRepository} from './fixtures/repositories.js';
import {readFile, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';

test('S07 project and workset definitions create, edit and delete without indexing or changing source', async ({
  page,
  manager,
}) => {
  const repository = await createRepository(manager, 'alpha', false);
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Worksets', exact: true})
    .click();
  await page.getByRole('tab', {name: /^Projects/u}).click();
  await page.getByRole('button', {name: 'Create project', exact: true}).click();
  const project = page.getByRole('dialog', {name: 'Create project', exact: true});
  await expect(project.getByRole('button', {name: 'Save project', exact: true})).toBeDisabled();
  await project.getByRole('textbox', {name: 'Project name', exact: true}).fill('alpha');
  await project.getByRole('textbox', {name: 'Repository path', exact: true}).fill(repository.root);
  await project.getByRole('textbox', {name: 'Resource URI', exact: true}).fill('threadnote://resources/repos/alpha');
  await project.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(JSON.parse(await readFile(manager.manifest, 'utf8')).projects).toEqual([]);
  await page.getByRole('button', {name: 'Create project', exact: true}).click();
  await project.getByRole('textbox', {name: 'Project name', exact: true}).fill('alpha');
  await project.getByRole('textbox', {name: 'Repository path', exact: true}).fill(repository.root);
  await project.getByRole('textbox', {name: 'Resource URI', exact: true}).fill('threadnote://resources/repos/alpha');
  await project.getByRole('button', {name: 'Save project', exact: true}).click();
  await expect(project).toHaveCount(0);
  expect(await manager.cli(['project', 'show', 'alpha', '--json'])).toContain(repository.root);
  expect((await manager.api('/api/graphs')).repositories).toEqual([]);
  await page.getByRole('tab', {name: /^Worksets/u}).click();
  await page.getByRole('button', {name: 'Create workset', exact: true}).click();
  const workset = page.getByRole('dialog', {name: 'Create workset', exact: true});
  await workset.getByRole('textbox', {name: 'Name', exact: true}).fill('browser-workset');
  await workset.getByRole('textbox', {name: 'Description', exact: true}).fill('Synthetic workset description.');
  await workset.getByRole('checkbox', {name: /alpha/u}).check();
  await workset.getByRole('button', {name: 'Save definition', exact: true}).click();
  await expect(workset).toHaveCount(0);
  expect(await manager.cli(['workset', 'show', 'browser-workset', '--json'])).toContain('alpha');
  expect((await manager.api('/api/graphs')).repositories).toEqual([]);
  await page.getByRole('button', {name: 'Open workset', exact: true}).click();
  await page.getByRole('button', {name: 'Edit', exact: true}).click();
  const editing = page.getByRole('dialog', {name: 'Edit workset', exact: true});
  await expect(editing.getByRole('alert')).toHaveCount(0);
  await editing.getByRole('textbox', {name: 'Description', exact: true}).fill('Updated reviewed definition.');
  await editing.getByRole('button', {name: 'Save definition', exact: true}).click();
  await expect(editing).toHaveCount(0);
  expect(await manager.cli(['workset', 'show', 'browser-workset', '--json'])).toContain('Updated reviewed definition.');
  await page.getByRole('button', {name: 'Delete', exact: true}).click();
  const deletion = page.getByRole('dialog');
  await expect(deletion).toContainText('browser-workset');
  await deletion.getByRole('button', {name: 'Keep workset', exact: true}).click();
  expect(await manager.cli(['workset', 'show', 'browser-workset', '--json'])).toContain('alpha');
  await page.getByRole('button', {name: 'Delete', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Delete definition', exact: true}).click();
  await expect(page.getByText('browser-workset', {exact: true})).toHaveCount(0);
  await page.getByRole('tab', {name: /^Projects/u}).click();
  await page.getByRole('button', {name: 'Project settings', exact: true}).click();
  await page.getByRole('button', {name: 'Edit project', exact: true}).click();
  const editor = page.getByRole('dialog', {name: 'Edit project', exact: true});
  await editor.getByRole('textbox', {name: 'Project name', exact: true}).fill('renamed-alpha');
  await editor.getByRole('button', {name: 'Save project', exact: true}).click();
  await expect(editor).toHaveCount(0);
  expect(await manager.cli(['project', 'show', 'renamed-alpha', '--json'])).toContain(repository.root);
  await page.getByRole('button', {name: 'Delete project', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Confirm project deletion', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'renamed-alpha', exact: true})).toHaveCount(0);
  expect(JSON.parse(await manager.cli(['project', 'list', '--json'])).projects).toEqual([]);
  expect(await readFile(join(repository.root, 'src/entry.ts'), 'utf8')).toBe(repository.source);
});

test('S07 S09 workset preparation publishes real repositories and converges after source changes', async ({
  page,
  manager,
}) => {
  test.setTimeout(90_000);
  const alpha = await createRepository(manager);
  await createRepository(manager, 'beta');
  await manager.cli(['workset', 'create', 'prepared-workset', '--project', 'alpha', '--project', 'beta']);
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Worksets', exact: true})
    .click();
  await page.getByRole('button', {name: 'Open workset', exact: true}).click();
  await page.getByRole('button', {name: 'Prepare', exact: true}).click();
  await expect(page.locator('.worksets-job > div > strong')).toHaveText('prepared-workset · completed', {
    timeout: 60_000,
  });
  await expect(page.locator('.worksets-job-receipts').getByText('ready', {exact: true})).toHaveCount(2);
  const status = JSON.parse(await manager.cli(['workset', 'status', 'prepared-workset', '--json']));
  expect(status.coverage.current).toBe(2);
  await page.getByRole('textbox', {name: 'Concept or symbol', exact: true}).fill('alphaGreeting');
  await page.getByRole('button', {name: 'Search published workset', exact: true}).click();
  await expect(page.locator('.worksets-evidence-list')).toContainText('alphaGreeting');
  await expect(page.locator('.worksets-evidence-list')).not.toContainText('betaGreeting');
  let release = () => {};
  let entered = () => {};
  let completed = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const pending = new Promise<void>(resolve => {
    entered = resolve;
  });
  const fulfilled = new Promise<void>(resolve => {
    completed = resolve;
  });
  await page.route(
    '**/api/worksets/query',
    async route => {
      try {
        const response = await route.fetch();
        entered();
        await gate;
        await route.fulfill({response});
      } finally {
        completed();
      }
    },
    {times: 1},
  );
  try {
    await page.getByRole('textbox', {name: 'Concept or symbol', exact: true}).fill('betaGreeting');
    await page.getByRole('button', {name: 'Search published workset', exact: true}).click();
    await pending;
    await page.getByRole('button', {name: 'Cancel request', exact: true}).click();
    release();
    await fulfilled;
    await expect(page.getByRole('button', {name: 'Cancel request', exact: true})).toHaveCount(0);
    await expect(page.locator('.worksets-evidence-list article')).toHaveCount(0);
  } finally {
    release();
  }
  await writeFile(join(alpha.root, 'src/entry.ts'), alpha.source + '\nexport const addedAfterPrepare = 42;\n');
  const stale = JSON.parse(await manager.cli(['workset', 'status', 'prepared-workset', '--json']));
  expect(stale.coverage.current).toBeLessThan(2);
  await page
    .getByRole('region', {name: 'Workset readiness'})
    .getByRole('button', {name: 'Refresh', exact: true})
    .click();
  await expect(page.locator('.worksets-member-grid')).toContainText(/stale|changed/iu);
  await page.getByRole('button', {name: 'Prepare', exact: true}).click();
  await expect
    .poll(
      async () => JSON.parse(await manager.cli(['workset', 'status', 'prepared-workset', '--json'])).coverage.current,
      {timeout: 60_000},
    )
    .toBe(2);
  await page.getByRole('textbox', {name: 'Concept or symbol', exact: true}).fill('addedAfterPrepare');
  await page.getByRole('button', {name: 'Search published workset', exact: true}).click();
  await expect(page.locator('.worksets-evidence-list')).toContainText('addedAfterPrepare');
  await page.getByRole('tab', {name: 'Context brief', exact: true}).click();
  await page
    .getByRole('textbox', {name: 'Engineering task', exact: true})
    .fill('Explain betaGreeting across this workset.');
  await page.getByRole('button', {name: 'Compile context brief', exact: true}).click();
  await expect(page.locator('#worksets-panel-brief')).toContainText(/betaGreeting|src\/entry.ts/u);
});

test('S07 invalid paths and duplicate project/workset definitions leave canonical configuration unchanged', async ({
  page,
  manager,
}) => {
  const repository = await createRepository(manager);
  await manager.cli(['workset', 'create', 'existing', '--project', 'alpha']);
  const before = await readFile(manager.manifest, 'utf8');
  const worksetBefore = await manager.cli(['workset', 'show', 'existing', '--json']);
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Worksets', exact: true})
    .click();
  await page.getByRole('tab', {name: /^Projects/u}).click();
  await page.getByRole('button', {name: 'Create project', exact: true}).click();
  const project = page.getByRole('dialog', {name: 'Create project', exact: true});
  await project.getByRole('textbox', {name: 'Project name', exact: true}).fill('new-project');
  await project.getByRole('textbox', {name: 'Repository path', exact: true}).fill('relative/path');
  await project
    .getByRole('textbox', {name: 'Resource URI', exact: true})
    .fill('threadnote://resources/repos/new-project');
  const invalid = 'Project path must be absolute or start with ~/.';
  manager.expectedErrors.push({path: '/api/worksets/projects', status: 400, code: 'invalid-input', error: invalid});
  await project.getByRole('button', {name: 'Save project', exact: true}).click();
  await expect(project.getByRole('alert')).toHaveText(invalid);
  expect(await readFile(manager.manifest, 'utf8')).toBe(before);
  await project.getByRole('textbox', {name: 'Project name', exact: true}).fill('alpha');
  await project.getByRole('textbox', {name: 'Repository path', exact: true}).fill(repository.root);
  const duplicateProject = 'A project with that name already exists.';
  manager.expectedErrors.push({
    path: '/api/worksets/projects',
    status: 409,
    code: 'name-conflict',
    error: duplicateProject,
  });
  await project.getByRole('button', {name: 'Save project', exact: true}).click();
  await expect(project.getByRole('alert')).toHaveText(duplicateProject);
  await project.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(await readFile(manager.manifest, 'utf8')).toBe(before);
  await page.getByRole('tab', {name: /^Worksets/u}).click();
  await page.getByRole('button', {name: 'Create workset', exact: true}).click();
  const workset = page.getByRole('dialog', {name: 'Create workset', exact: true});
  await workset.getByRole('textbox', {name: 'Name', exact: true}).fill('existing');
  await workset.getByRole('checkbox', {name: /alpha/u}).check();
  const duplicateWorkset = 'A workset with that name already exists.';
  manager.expectedErrors.push({
    path: '/api/worksets/definitions',
    status: 409,
    code: 'name-conflict',
    error: duplicateWorkset,
  });
  await workset.getByRole('button', {name: 'Save definition', exact: true}).click();
  await expect(workset.getByRole('alert')).toHaveText(duplicateWorkset);
  await workset.getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.getByRole('button', {name: 'Create workset', exact: true}).click();
  await expect(workset.getByRole('alert')).toHaveCount(0);
  await expect(workset.getByRole('textbox', {name: 'Name', exact: true})).toHaveValue('');
  expect(await manager.cli(['workset', 'show', 'existing', '--json'])).toBe(worksetBefore);
  expect(await readFile(manager.manifest, 'utf8')).toBe(before);
});
