import {String as EffectString} from 'effect';
import {test, expect} from './fixtures/test.js';
import {createRepository} from './fixtures/repositories.js';
import {spawnSync} from '@threadnote/testing/node-child-process';
import {readFile, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {findExecutable} from './fixtures/environment.js';

test('S13 local Git team setup, cancel, rename, repository settings, sync and disconnect persist', async ({
  page,
  manager,
}) => {
  test.setTimeout(60_000);
  const remote = join(manager.root, 'shared.git');
  const git = (args: readonly string[]) => {
    const result = spawnSync(findExecutable('git'), [...args], {
      cwd: manager.root,
      env: manager.environment,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return EffectString.trim(result.stdout);
  };
  git(['init', '--bare', '--initial-branch=main', remote]);
  const sentinel = await manager.remember('Unshared personal sentinel.', 'personal-sentinel');
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Sharing', exact: true})
    .click();
  await page.getByRole('button', {name: 'Connect team', exact: true}).first().click();
  const dialog = page.getByRole('dialog', {name: 'Connect a team', exact: true});
  await dialog.getByRole('textbox', {name: 'Team name Required', exact: true}).fill('fixture-team');
  await dialog.getByRole('textbox', {name: 'Git repository URL Required', exact: true}).fill(remote);
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect((await manager.api('/api/shares')).shares).toEqual([]);
  await page.getByRole('button', {name: 'Connect team', exact: true}).first().click();
  await dialog.getByRole('textbox', {name: 'Team name Required', exact: true}).fill('fixture-team');
  await dialog.getByRole('textbox', {name: 'Git repository URL Required', exact: true}).fill(remote);
  await dialog.getByRole('button', {name: 'Connect team', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'fixture-team', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Actions for fixture-team', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Rename team…', exact: true}).click();
  const rename = page.getByRole('dialog', {name: 'Rename team', exact: true});
  await rename.getByRole('textbox', {name: 'Team name Required', exact: true}).fill('renamed-team');
  await rename.getByRole('button', {name: 'Save changes', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'renamed-team', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Actions for renamed-team', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Repository settings…', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Team repository', exact: true});
  await expect(settings.getByRole('textbox')).toHaveValue(remote);
  await settings.getByRole('button', {name: 'Save changes', exact: true}).click();
  await page.getByRole('button', {name: 'Sync', exact: true}).click();
  await expect(page.getByText('Sync finished. Review any conflicts below.', {exact: true})).toBeVisible();
  const tip = git(['--git-dir', remote, 'rev-parse', 'HEAD']);
  expect(tip).toMatch(/^[a-f0-9]{40}$/u);
  await page.reload();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Sharing', exact: true})
    .click();
  await page.getByRole('button', {name: 'Actions for renamed-team', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Disconnect team…', exact: true}).click();
  const disconnect = page.getByRole('dialog', {name: 'Disconnect renamed-team?', exact: true});
  await disconnect.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(git(['--git-dir', remote, 'rev-parse', 'HEAD'])).toBe(tip);
  await page.getByRole('button', {name: 'Actions for renamed-team', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Disconnect team…', exact: true}).click();
  await disconnect.getByRole('button', {name: 'Disconnect team', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'renamed-team', exact: true})).toHaveCount(0);
  expect((await manager.api('/api/shares')).shares).toEqual([]);
  expect(await manager.cli(['read', sentinel])).toContain('Unshared personal sentinel.');
  expect(git(['--git-dir', remote, 'rev-parse', 'HEAD'])).toBe(tip);
  expect(await readFile(join(remote, 'HEAD'), 'utf8')).toContain('refs/heads/main');
});

test('S13 publishing and unpublishing require review and preserve the original personal memory', async ({
  page,
  manager,
}) => {
  const remote = join(manager.root, 'publication.git');
  const git = (args: readonly string[]) => {
    const result = spawnSync(findExecutable('git'), [...args], {
      cwd: manager.root,
      env: manager.environment,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return EffectString.trim(result.stdout);
  };
  git(['init', '--bare', '--initial-branch=main', remote]);
  await manager.cli(['share', 'init', remote, '--team', 'publication-team', '--set-default']);
  const uri = await manager.remember(
    'Exact reviewed publication body.',
    'publication-memory',
    'manager-e2e',
    'durable',
  );
  const before = await manager.cli(['read', uri]);
  const tip = git(['--git-dir', remote, 'rev-parse', 'HEAD']);
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Library', exact: true})
    .click();
  await page.getByRole('searchbox', {name: 'Search Library'}).fill('publication-memory');
  await page.locator('.tree-file').filter({hasText: 'Publication memory'}).click();
  await page.getByRole('searchbox', {name: 'Search Library'}).fill('');
  const action = async (label: string) => {
    await page
      .locator('.reader-head')
      .getByRole('button', {name: /^Actions for /u})
      .click();
    await page.getByRole('menuitem', {name: label, exact: true}).click();
  };
  await action('Publish…');
  const publish = page.getByRole('dialog', {name: 'Publish memory', exact: true});
  await publish.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(git(['--git-dir', remote, 'rev-parse', 'HEAD'])).toBe(tip);
  await action('Publish…');
  await publish.getByRole('button', {name: 'Publish memory', exact: true}).click();
  await expect(publish).toHaveCount(0);
  await expect
    .poll(() => git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'HEAD']))
    .toContain('publication-memory.md');
  const published = git(['--git-dir', remote, 'rev-parse', 'HEAD']);
  await page.getByRole('button', {name: 'Team', exact: true}).click();
  await page.getByRole('searchbox', {name: 'Search Library'}).fill('publication-memory');
  await page.locator('.tree-file').filter({hasText: 'Publication memory'}).click();
  await page.getByRole('searchbox', {name: 'Search Library'}).fill('');
  await expect(page.locator('.library-article')).toContainText('Exact reviewed publication body.');
  await action('Unpublish…');
  const unpublish = page.getByRole('dialog', {name: 'Unpublish this memory?', exact: true});
  await unpublish.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(git(['--git-dir', remote, 'rev-parse', 'HEAD'])).toBe(published);
  await action('Unpublish…');
  await unpublish.getByRole('button', {name: 'Unpublish memory', exact: true}).click();
  await expect
    .poll(() => git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'HEAD']))
    .not.toContain('publication-memory.md');
  expect(await manager.cli(['read', uri])).toBe(before);
});

test('S13 shared conflicts bind the chosen resolution to exact reviewed versions', async ({page, manager}) => {
  test.setTimeout(60_000);
  const remote = join(manager.root, 'conflicts.git');
  const peer = join(manager.root, 'peer');
  const git = (args: readonly string[], cwd = manager.root) => {
    const result = spawnSync(findExecutable('git'), [...args], {cwd, env: manager.environment, encoding: 'utf8'});
    expect(result.status, result.stderr).toBe(0);
    return EffectString.trim(result.stdout);
  };
  git(['init', '--bare', '--initial-branch=main', remote]);
  await manager.cli(['share', 'init', remote, '--team', 'conflict-team']);
  const sentinel = await manager.remember('Unrelated conflict sentinel.', 'conflict-sentinel');
  const personal = await manager.remember('Exact seed body.', 'conflict-memory', 'manager-e2e', 'durable');
  await manager.cli(['share', 'publish', personal, '--team', 'conflict-team']);
  const shared = EffectString.replace('/memories/', '/memories/shared/conflict-team/')(personal);
  const original = (await manager.api(`/api/memory?uri=${encodeURIComponent(shared)}`)).content;
  if (typeof original !== 'string') throw new Error('Shared fixture did not return canonical content.');
  // Model an external, unpublished edit to this owned canonical file.
  // Manager's own shared editor immediately publishes and cannot seed this conflict.
  const sharedPath = join(manager.home, 'data/manager-e2e', EffectString.slice('threadnote://'.length)(shared));
  await writeFile(sharedPath, EffectString.replace('Exact seed body.', 'Locally edited body.')(original));
  git(['clone', remote, peer]);
  const path = EffectString.trim(git(['ls-files', '*conflict-memory.md'], peer));
  expect(path).toContain('conflict-memory.md');
  const remoteBefore = await readFile(join(peer, path), 'utf8');
  const identity = /memory_id: (tn_\S+)/u.exec(await manager.cli(['read', shared]))?.[1];
  if (!identity) throw new Error('Missing shared memory identity.');
  const remoteContent = EffectString.replace(
    identity,
    'tn_cccccccccccccccccccccccccccccccc',
  )(EffectString.replace('Exact seed body.', 'Remotely edited body.')(remoteBefore));
  await writeFile(join(peer, path), remoteContent);
  git(['add', path], peer);
  git(['commit', '-m', 'Synthetic peer edit'], peer);
  git(['push', 'origin', 'main'], peer);
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Sharing', exact: true})
    .click();
  await page.getByRole('button', {name: 'Sync', exact: true}).click();
  const row = page.locator('.conflict-list-row');
  await expect(row).toHaveCount(1);
  await row.click();
  const dialog = page.getByRole('dialog', {name: /^Resolve:/u});
  await expect(dialog).toContainText('Locally edited body.');
  await expect(dialog).toContainText('Remotely edited body.');
  await dialog.getByText('See exact changes and metadata', {exact: true}).click();
  await expect(dialog.locator('.conflict-diff')).toContainText('memory_id:');
  await dialog.getByRole('button', {name: 'Close details', exact: true}).click();
  expect(await manager.cli(['read', shared])).toContain('Locally edited body.');
  await row.click();
  await expect(dialog.getByRole('button', {name: /^Use shared/u})).toBeDisabled();
  await dialog.getByRole('button', {name: /^Keep local/u}).click();
  const current = (await manager.api(`/api/memory?uri=${encodeURIComponent(shared)}`)).content;
  if (typeof current !== 'string') throw new Error('Shared fixture did not return canonical content.');
  await writeFile(sharedPath, EffectString.replace('Locally edited body.', 'Newer local edit.')(current));
  const error = 'This conflict changed after you opened it. Reload the versions before resolving it.';
  manager.expectedErrors.push({path: '/api/shares/conflicts/resolve', status: 409, error});
  await dialog.getByRole('button', {name: 'Keep local and share', exact: true}).click();
  await expect(dialog.getByRole('alert')).toContainText(error);
  expect(await manager.cli(['read', shared])).toContain('Newer local edit.');
  await dialog.getByRole('button', {name: 'Reload versions', exact: true}).click();
  await expect(dialog).toContainText('Newer local edit.');
  await expect(dialog.getByRole('button', {name: /^Use shared/u})).toBeDisabled();
  await dialog.getByRole('button', {name: /^Keep local/u}).click();
  await dialog.getByRole('button', {name: 'Keep local and share', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect(await manager.cli(['read', shared])).toContain('Newer local edit.');
  expect(git(['--git-dir', remote, 'show', `HEAD:${path}`])).toContain('Newer local edit.');
  expect(await manager.cli(['read', shared])).toContain(`memory_id: ${identity}`);
  expect(await manager.cli(['read', sentinel])).toContain('Unrelated conflict sentinel.');
});

test('S13 a pending code citation cannot publish to a configured local team', async ({page, manager}) => {
  const repository = await createRepository(manager);
  const remote = join(manager.root, 'pending.git');
  const result = spawnSync(findExecutable('git'), ['init', '--bare', '--initial-branch=main', remote], {
    cwd: manager.root,
    env: manager.environment,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  await manager.cli(['share', 'init', remote, '--team', 'pending-team']);
  await manager.cli(
    [
      'remember',
      '--kind',
      'durable',
      '--project',
      'alpha',
      '--topic',
      'pending-publication',
      '--code-ref',
      'src/entry.ts',
      '--defer-code-refs',
      '--text',
      'Keep this citation private until verified.',
    ],
    undefined,
    30_000,
    repository.root,
  );
  const tip = spawnSync(findExecutable('git'), ['--git-dir', remote, 'rev-parse', 'HEAD'], {
    env: manager.environment,
    encoding: 'utf8',
  }).stdout;
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Library', exact: true})
    .click();
  await page.getByRole('searchbox', {name: 'Search Library'}).fill('pending-publication');
  await page.locator('.tree-file').filter({hasText: 'Pending publication'}).click();
  await page.getByRole('searchbox', {name: 'Search Library'}).fill('');
  await page
    .locator('.reader-head')
    .getByRole('button', {name: /^Actions for /u})
    .click();
  await page.getByRole('menuitem', {name: 'Publish…', exact: true}).click();
  const uri = 'threadnote://user/playwright/memories/durable/projects/alpha/pending-publication.md';
  const error = `Refusing to publish ${uri}: code citations are still pending. Prepare the graph and run \`threadnote finalize-code-refs --uri ${uri}\`, or explicitly pass --allow-uncited-pending-code-refs to publish without them and discard the private intent.`;
  manager.expectedErrors.push({path: '/api/memory/publish', status: 500, error});
  const dialog = page.getByRole('dialog', {name: 'Publish memory', exact: true});
  await expect(dialog.getByRole('combobox', {name: 'Team Required', exact: true})).toHaveValue('pending-team');
  const refused = page.waitForResponse(response => new URL(response.url()).pathname === '/api/memory/publish');
  await dialog.getByRole('button', {name: 'Publish memory', exact: true}).click();
  expect((await refused).status()).toBe(500);
  expect(
    spawnSync(findExecutable('git'), ['--git-dir', remote, 'rev-parse', 'HEAD'], {
      env: manager.environment,
      encoding: 'utf8',
    }).stdout,
  ).toBe(tip);
});
