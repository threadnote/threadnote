import type {Page} from '@playwright/test';
import {test, expect} from './fixtures/test.js';
import {access, chmod, mkdir, readFile, readdir, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {Array as EffectArray, pipe} from 'effect';
import * as EffectString from 'effect/String';

async function openMemory(page: Page, title: string): Promise<void> {
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Library', exact: true})
    .click();
  await page
    .getByRole('searchbox', {name: 'Search Library'})
    .fill(pipe(title, EffectString.toLocaleLowerCase(), EffectString.replace(/\s+/gu, '-')));
  await page.locator('.tree-file').filter({hasText: title}).click();
  await page.getByRole('searchbox', {name: 'Search Library'}).fill('');
  await expect(page.locator('.library-article h2')).toHaveText(title);
}

async function memoryAction(page: Page, action: string): Promise<void> {
  await page
    .locator('.reader-head')
    .getByRole('button', {name: /^Actions for /u})
    .click();
  await page.getByRole('menuitem', {name: action, exact: true}).click();
}

test('S03 library search, memory links and navigation preserve canonical identity @compat', async ({page, manager}) => {
  const second = await manager.remember('A second mémoire — 日本語 🧭.', 'linked-memory', 'other-project');
  const identity = /memory_id: (tn_\S+)/u.exec(await manager.cli(['read', second]))?.[1];
  expect(identity).toMatch(/^tn_/u);
  const first = await manager.remember(
    `# First memory\n\nunique-body-search-needle\n\n[Related memory](${second})\n\n[Stable pointer](threadnote://memory/${identity})`,
    'first-memory',
  );
  await openMemory(page, 'First memory');
  await expect(page.getByText('unique-body-search-needle', {exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'Related memory', exact: true}).click();
  await expect(page.locator('.library-article h2')).toHaveText('Linked memory');
  await expect(page.getByText('A second mémoire — 日本語 🧭.', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Back to previous memory'}).click();
  await expect(page.locator('.library-article h2')).toHaveText('First memory');
  await page.getByRole('link', {name: 'Stable pointer', exact: true}).click();
  await expect(page.locator('.library-article h2')).toHaveText('Linked memory');
  await page.getByRole('button', {name: 'Back to previous memory'}).click();
  const search = page.getByRole('searchbox', {name: 'Search Library'});
  await search.fill('unique-body-search-needle');
  await expect(page.locator('.tree-file').filter({hasText: 'First memory'})).toBeVisible();
  await expect(page.locator('.tree-file').filter({hasText: 'Linked memory'})).toHaveCount(0);
  await expect(page.locator('.explorer-search-status')).toContainText(/lexical|semantic/iu);
  await search.fill('impossible-fixture-no-results-7dff');
  await expect(page.getByText('No matching memories or resources.', {exact: true})).toBeVisible();
  await search.fill(first);
  await search.press('Enter');
  await expect(page.locator('.library-article h2')).toHaveText('First memory');
  expect(await manager.cli(['read', first])).toContain(`[Related memory](${second})`);
});

test('S04 rich editing and source mode save actual Markdown without changing identity @compat', async ({
  page,
  manager,
}) => {
  const uri = await manager.remember('# Original heading\n\nOriginal paragraph.', 'editable-memory');
  await openMemory(page, 'Editable memory');
  const before = await manager.cli(['read', uri]);
  await page.getByRole('button', {name: 'Edit', exact: true}).click();
  const rich = page.getByRole('textbox', {name: 'editable markdown', exact: true});
  await expect(rich).toContainText('Original heading');
  await rich.fill('Edited rich paragraph — café 日本語.');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect.poll(() => manager.cli(['read', uri])).toContain('Edited rich paragraph — café 日本語.');
  await page.getByRole('button', {name: 'Edit', exact: true}).click();
  await page.getByLabel('Source mode', {exact: true}).click();
  const source = page.locator('.mdxeditor-source-editor .cm-content');
  await source.fill('# Source heading\n\n- First item\n- Second item\n\n```ts\nconst value = 7;\n```');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect.poll(() => manager.cli(['read', uri])).toContain('const value = 7;');
  await expect(
    page.locator('.markdown-viewer').getByRole('heading', {name: 'Source heading', exact: true}),
  ).toBeVisible();
  await expect(page.locator('.markdown-viewer li')).toHaveText(['First item', 'Second item']);
  await expect(page.locator('.markdown-viewer code')).toHaveText('const value = 7;\n');
  const after = await manager.cli(['read', uri]);
  expect(/memory_id: (\S+)/u.exec(before)?.[1]).toMatch(/^tn_/u);
  expect(/memory_id: (\S+)/u.exec(after)?.[1]).toBe(/memory_id: (\S+)/u.exec(before)?.[1]);
  await page.reload();
  await openMemory(page, 'Editable memory');
  await expect(
    page.locator('.markdown-viewer').getByRole('heading', {name: 'Source heading', exact: true}),
  ).toBeVisible();
});

test('S04 unsupported rich Markdown remains editable verbatim through source fallback', async ({page, manager}) => {
  const body =
    '# Unsupported formatting\n\n<FixtureWidget value="synthetic" />\n\nKeep this exact punctuation: é — 日本語.';
  const uri = await manager.remember(body, 'source-fallback');
  await openMemory(page, 'Source fallback');
  await page.getByRole('button', {name: 'Edit', exact: true}).click();
  const source = page.getByRole('textbox', {name: 'Memory Markdown source', exact: true});
  await expect(source).toHaveValue(body);
  await source.fill(body + '\n\nA safely appended paragraph.');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect.poll(() => manager.cli(['read', uri])).toContain(body + '\n\nA safely appended paragraph.');
});

test('S05 archive and forget require confirmation and leave a neighboring sentinel intact', async ({page, manager}) => {
  const uri = await manager.remember('Lifecycle target.', 'lifecycle-target');
  const sentinel = await manager.remember('Neighbor must stay byte-identical.', 'sentinel');
  const original = await manager.cli(['read', uri]);
  const sentinelBefore = await manager.cli(['read', sentinel]);
  await openMemory(page, 'Lifecycle target');
  await memoryAction(page, 'Archive…');
  const dialog = page.getByRole('dialog', {name: 'Archive this memory?'});
  await expect(dialog).toContainText(uri);
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(await manager.cli(['read', uri])).toBe(original);
  await memoryAction(page, 'Archive…');
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/memory/archive');
  await dialog.getByRole('button', {name: 'Archive memory', exact: true}).click();
  const result = await (await response).json();
  const archived = /Stored memory: (threadnote:\/\/\S+)/u.exec(String(result.output))?.[1];
  if (!archived) throw new Error('Archive returned no canonical URI.');
  await expect.poll(() => manager.cli(['read', archived])).toContain('status: archived');
  await openMemory(page, 'Lifecycle target');
  await memoryAction(page, 'Forget…');
  await page
    .getByRole('dialog', {name: 'Forget this memory?'})
    .getByRole('button', {name: 'Cancel', exact: true})
    .click();
  expect(await manager.cli(['read', archived])).toContain('Lifecycle target.');
  await memoryAction(page, 'Forget…');
  await page
    .getByRole('dialog', {name: 'Forget this memory?'})
    .getByRole('button', {name: 'Forget memory', exact: true})
    .click();
  await expect(page.locator('.tree-file').filter({hasText: 'Lifecycle target'})).toHaveCount(0);
  expect(await manager.cli(['read', sentinel])).toBe(sentinelBefore);
});

test('S05 Library pack export and import round-trip real local records', async ({page, manager}) => {
  const uri = await manager.remember('Pack round-trip body — synthetic.', 'pack-target');
  await openMemory(page, 'Pack target');
  const before = await manager.cli(['read', uri]);
  const pack = join(manager.root, 'library.ovpack');
  await page.getByRole('button', {name: 'Library options', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Export pack…', exact: true}).click();
  await page.getByRole('textbox', {name: 'Local .ovpack path'}).fill(pack);
  await page
    .getByRole('dialog', {name: 'Export Library pack'})
    .getByRole('button', {name: 'Export', exact: true})
    .click();
  await page.getByRole('dialog', {name: 'Operation complete'}).getByRole('button', {name: 'Done', exact: true}).click();
  expect((await readFile(pack)).length).toBeGreaterThan(0);
  await memoryAction(page, 'Forget…');
  await page
    .getByRole('dialog', {name: 'Forget this memory?'})
    .getByRole('button', {name: 'Forget memory', exact: true})
    .click();
  await expect(page.locator('.tree-file').filter({hasText: 'Pack target'})).toHaveCount(0);
  await page.getByRole('button', {name: 'Library options', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Import pack…', exact: true}).click();
  await page.getByRole('textbox', {name: 'Local .ovpack path'}).fill(pack);
  await page
    .getByRole('dialog', {name: 'Import Library pack'})
    .getByRole('button', {name: 'Import', exact: true})
    .click();
  await page.getByRole('dialog', {name: 'Operation complete'}).getByRole('button', {name: 'Done', exact: true}).click();
  expect(await manager.cli(['read', uri])).toBe(before);
});

test('S06 consolidation requires paragraph review and confirmation before persistence', async ({page, manager}) => {
  await writeFile(
    join(manager.root, 'bin/claude'),
    "#!/bin/sh\nwhile IFS= read -r line; do :; done\nprintf '%s\\n' 'A synthetic consolidated decision.'\n",
    {mode: 0o755},
  );
  const first = await manager.remember('First source evidence.', 'consolidation-first');
  const second = await manager.remember('Second source evidence.', 'consolidation-second');
  const firstBefore = await manager.cli(['read', first]);
  const secondBefore = await manager.cli(['read', second]);
  await openMemory(page, 'Consolidation first');
  await page.getByRole('checkbox', {name: 'Select consolidation-first.md', exact: true}).check();
  await page.getByRole('checkbox', {name: 'Select consolidation-second.md', exact: true}).check();
  await page.getByRole('button', {name: 'Consolidate', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Consolidate memories', exact: true});
  await dialog.getByRole('textbox', {name: 'Consolidated memory topic'}).fill('reviewed-consolidation');
  await dialog.getByRole('textbox', {name: 'Consolidated memory project'}).fill('manager-e2e');
  await dialog.locator('label').filter({hasText: 'Generate with'}).getByRole('button').click();
  await page.getByRole('option', {name: 'Claude', exact: true}).click();
  await expect(dialog.getByRole('combobox', {name: 'Consolidation model'})).toHaveValue('sonnet');
  await dialog.getByRole('button', {name: 'Generate draft', exact: true}).click();
  await expect(dialog.getByRole('textbox', {name: 'Consolidation draft'})).toHaveValue(
    'A synthetic consolidated decision.',
  );
  await expect(dialog.getByRole('button', {name: 'Save memory', exact: true})).toBeDisabled();
  expect(await manager.cli(['read', first])).toBe(firstBefore);
  expect(await manager.cli(['read', second])).toBe(secondBefore);
  await dialog.getByRole('combobox', {name: 'Support for paragraph 1'}).selectOption('unsupported');
  await dialog.getByRole('button', {name: 'Save memory', exact: true}).click();
  const confirmation = page.getByRole('dialog', {name: 'Save this consolidated memory?'});
  await confirmation.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(await manager.cli(['read', first])).toBe(firstBefore);
  await dialog.getByRole('button', {name: 'Save memory', exact: true}).click();
  const applying = page.waitForRequest(request =>
    /\/api\/consolidations\/[^/]+\/apply$/u.test(new URL(request.url()).pathname),
  );
  const application = page.waitForResponse(response =>
    /\/api\/consolidations\/[^/]+\/apply$/u.test(new URL(response.url()).pathname),
  );
  await confirmation.getByRole('button', {name: 'Save and archive sources', exact: true}).click();
  const applied = await applying;
  expect((await application).ok()).toBe(true);
  const uri = 'threadnote://user/playwright/memories/durable/projects/manager-e2e/reviewed-consolidation.md';
  await expect.poll(() => manager.cli(['read', uri])).toContain('A synthetic consolidated decision.');
  expect(await manager.cli(['read', uri])).toContain('consolidation:');
  const memoryRoot = join(manager.home, 'data/manager-e2e/user/playwright/memories');
  const archiveRoot = join(memoryRoot, 'handoffs/archived/manager-e2e');
  const archived = await Promise.all(
    EffectArray.map(await readdir(archiveRoot), file => readFile(join(archiveRoot, file), 'utf8')),
  );
  expect(archived).toHaveLength(2);
  for (const [topic, original, body] of [
    ['consolidation-first', firstBefore, 'First source evidence.'],
    ['consolidation-second', secondBefore, 'Second source evidence.'],
  ]) {
    const identity = /memory_id: (tn_\S+)/u.exec(original)?.[1];
    if (!identity) throw new Error('Expected an identity-bearing source memory.');
    const preserved = EffectArray.filter(archived, content => pipe(content, EffectString.includes(identity)));
    expect(preserved).toHaveLength(1);
    expect(preserved[0]).toContain('status: archived');
    expect(preserved[0]).toContain(body);
    await expect(access(join(memoryRoot, 'handoffs/active/manager-e2e', `${topic}.md`))).rejects.toThrow();
  }
  const saved = await manager.cli(['read', uri]);
  const repeated = await page.request.post(applied.url(), {
    headers: {authorization: `Bearer ${manager.token}`},
    data: applied.postDataJSON(),
  });
  expect(repeated.ok()).toBe(true);
  expect(await manager.cli(['read', uri])).toBe(saved);
  const changed = await page.request.post(applied.url(), {
    headers: {authorization: `Bearer ${manager.token}`},
    data: {...applied.postDataJSON(), topic: 'different-unapproved-target'},
  });
  expect(changed.status()).toBe(500);
  expect(await changed.json()).toEqual({
    error:
      'Consolidation already saved with a different draft, target, support review, or cleanup approval. Resume the original receipt.',
  });
  expect(await manager.cli(['read', uri])).toBe(saved);
});

test('S06 a changed source invalidates reviewed consolidation before any result is saved', async ({page, manager}) => {
  await writeFile(
    join(manager.root, 'bin/claude'),
    "#!/bin/sh\nwhile IFS= read -r line; do :; done\nprintf '%s\\n' 'A stale synthetic draft.'\n",
    {mode: 0o755},
  );
  const first = await manager.remember('Original source revision.', 'stale-first');
  const second = await manager.remember('Unchanged second source.', 'stale-second');
  const before = await manager.cli(['read', first]);
  const secondBefore = await manager.cli(['read', second]);
  await openMemory(page, 'Stale first');
  await page.getByRole('checkbox', {name: 'Select stale-first.md', exact: true}).check();
  await page.getByRole('checkbox', {name: 'Select stale-second.md', exact: true}).check();
  await page.getByRole('button', {name: 'Consolidate', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Consolidate memories', exact: true});
  await dialog.getByRole('textbox', {name: 'Consolidated memory topic'}).fill('must-not-save');
  await dialog.getByRole('textbox', {name: 'Consolidated memory project'}).fill('manager-e2e');
  await dialog.locator('label').filter({hasText: 'Generate with'}).getByRole('button').click();
  await page.getByRole('option', {name: 'Claude', exact: true}).click();
  const generating = page.waitForResponse(response => new URL(response.url()).pathname === '/api/consolidations');
  await dialog.getByRole('button', {name: 'Generate draft', exact: true}).click();
  const {job} = await (await generating).json();
  await expect(dialog.getByRole('textbox', {name: 'Consolidation draft'})).toHaveValue('A stale synthetic draft.');
  await dialog.getByRole('combobox', {name: 'Support for paragraph 1'}).selectOption('unsupported');
  const changed = pipe(before, EffectString.replace('Original source revision.', 'New canonical source revision.'));
  await writeFile(
    join(manager.home, 'data/manager-e2e/user/playwright/memories/handoffs/active/manager-e2e/stale-first.md'),
    changed,
  );
  const changedRead = await manager.cli(['read', first]);
  const error = `Source ${first} changed after consolidation review. No newer revision will be cleaned up.`;
  manager.expectedErrors.push({path: `/api/consolidations/${job.id}/apply`, status: 500, error});
  await dialog.getByRole('button', {name: 'Save memory', exact: true}).click();
  await page
    .getByRole('dialog', {name: 'Save this consolidated memory?'})
    .getByRole('button', {name: 'Save and archive sources', exact: true})
    .click();
  await expect(page.getByText(error, {exact: true})).toBeVisible();
  expect(await manager.cli(['read', first])).toBe(changedRead);
  expect(
    await readFile(
      join(manager.home, 'data/manager-e2e/user/playwright/memories/handoffs/active/manager-e2e/stale-first.md'),
      'utf8',
    ),
  ).toBe(changed);
  expect(await manager.cli(['read', second])).toBe(secondBefore);
  await expect(
    access(
      join(manager.home, 'data/manager-e2e/user/playwright/memories/durable/projects/manager-e2e/must-not-save.md'),
    ),
  ).rejects.toThrow();
});

test('S04 move preserves memory identity and cancellation preserves the original document', async ({page, manager}) => {
  const uri = await manager.remember('Move this body without losing identity.', 'move-target');
  await manager.remember('Destination sentinel.', 'destination-sentinel', 'destination');
  const before = await manager.cli(['read', uri]);
  await openMemory(page, 'Move target');
  await memoryAction(page, 'Move…');
  const dialog = page.getByRole('dialog', {name: 'Move memory', exact: true});
  await dialog.getByRole('textbox', {name: 'Topic Required', exact: true}).fill('moved-target');
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(await manager.cli(['read', uri])).toBe(before);
  await memoryAction(page, 'Move…');
  await dialog.getByRole('textbox', {name: 'Topic Required', exact: true}).fill('moved-target');
  await dialog.getByRole('combobox', {name: 'Project Required', exact: true}).fill('destination');
  await dialog.getByRole('option', {name: 'destination', exact: true}).click();
  const reply = page.waitForResponse(response => new URL(response.url()).pathname === '/api/memory/move');
  await dialog.getByRole('button', {name: 'Move memory', exact: true}).click();
  expect((await reply).ok()).toBe(true);
  const moved = 'threadnote://user/playwright/memories/handoffs/active/destination/moved-target.md';
  const after = await manager.cli(['read', moved]);
  expect(/memory_id: (\S+)/u.exec(before)?.[1]).toMatch(/^tn_/u);
  expect(after).toContain('Move this body without losing identity.');
  expect(/memory_id: (\S+)/u.exec(after)?.[1]).toBe(/memory_id: (\S+)/u.exec(before)?.[1]);
  await page.reload();
  await openMemory(page, 'Moved target');
});

test('S05 folder confirmation includes hidden descendants and cancel leaves all records intact', async ({
  page,
  manager,
}) => {
  const first = await manager.remember('First folder record.', 'visible-child', 'folder-target');
  const hidden = await manager.remember('Hidden folder record.', 'hidden-child', 'folder-target');
  const sentinel = await manager.remember('Outside folder.', 'sentinel');
  const before = await manager.cli(['read', hidden]);
  const sentinelBefore = await manager.cli(['read', sentinel]);
  await openMemory(page, 'Visible child');
  await page.getByRole('searchbox', {name: 'Search Library'}).fill('visible-child');
  await page.getByRole('button', {name: 'Actions for folder-target', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Remove folder and forget…', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Remove folder and forget its memories?'});
  await expect(dialog).toContainText(first);
  await expect(dialog).toContainText(hidden);
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(await manager.cli(['read', hidden])).toBe(before);
  await page.getByRole('button', {name: 'Actions for folder-target', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Remove folder and forget…', exact: true}).click();
  await dialog.getByRole('button', {name: 'Remove folder', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Actions for folder-target', exact: true})).toHaveCount(0);
  expect(await manager.cli(['read', sentinel])).toBe(sentinelBefore);
});

test('S05 bulk keeps the real failed record selected after changing hidden descendants', async ({page, manager}) => {
  const success = await manager.remember('Bulk success.', 'bulk-success', 'bulk-success-project');
  const failure = await manager.remember('Bulk permission failure.', 'bulk-failure', 'bulk-failure-project');
  const failureBefore = await manager.cli(['read', failure]);
  await openMemory(page, 'Bulk success');
  await page.getByRole('checkbox', {name: 'Select bulk-success.md', exact: true}).check();
  await page.getByRole('searchbox', {name: 'Search Library'}).fill('bulk-failure');
  await page.getByRole('checkbox', {name: 'Select bulk-failure.md', exact: true}).check();
  await page.getByRole('searchbox', {name: 'Search Library'}).fill('bulk-success');
  await page.getByRole('button', {name: 'Forget…', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Forget 2 selected memories?'});
  await expect(dialog).toContainText(success);
  await expect(dialog).toContainText(failure);
  const folder = join(manager.home, 'data/manager-e2e/user/playwright/memories/handoffs/active/bulk-failure-project');
  await chmod(folder, 0o500);
  try {
    await dialog.getByRole('button', {name: 'Forget', exact: true}).click();
    await expect(page.getByText('Bulk action completed with failures', {exact: true})).toBeVisible();
    await expect(page.locator('.selection-bar')).toContainText('1 memory selected');
    await page.getByRole('searchbox', {name: 'Search Library'}).fill('bulk-failure');
    await expect(page.getByRole('checkbox', {name: 'Select bulk-failure.md', exact: true})).toBeChecked();
    expect(await manager.cli(['read', failure])).toBe(failureBefore);
    await expect(
      access(
        join(
          manager.home,
          'data/manager-e2e/user/playwright/memories/handoffs/active/bulk-success-project/bulk-success.md',
        ),
      ),
    ).rejects.toThrow();
  } finally {
    await chmod(folder, 0o700);
  }
});

test('S05 malformed and escaping packs fail through the import UI without collateral writes', async ({
  page,
  manager,
}) => {
  const uri = await manager.remember('Untouched import sentinel.', 'sentinel');
  const before = await manager.cli(['read', uri]);
  await openMemory(page, 'Sentinel');
  for (const [name, body, cause] of [
    ['malformed', {version: 0}, 'Unsupported Threadnote pack version or shape.'],
    [
      'escape',
      {
        version: 1,
        sourceUri: 'threadnote://user/playwright/memories',
        resources: [{relativeUri: '../escaped.md', content: 'must not be written'}],
      },
      'Unsafe pack relative URI: ../escaped.md.',
    ],
  ] as const) {
    const pack = join(manager.root, `${name}.ovpack`);
    await writeFile(pack, JSON.stringify(body));
    const error = `Invalid Threadnote pack ${pack}: ${cause}`;
    manager.expectedErrors.push({path: '/api/import-pack', status: 500, error});
    await page.getByRole('button', {name: 'Library options', exact: true}).click();
    await page.getByRole('menuitem', {name: 'Import pack…', exact: true}).click();
    await page.getByRole('textbox', {name: 'Local .ovpack path'}).fill(pack);
    await page
      .getByRole('dialog', {name: 'Import Library pack'})
      .getByRole('button', {name: 'Import', exact: true})
      .click();
    await expect(page.getByText(error, {exact: true})).toBeVisible();
    expect(await manager.cli(['read', uri])).toBe(before);
    await page
      .getByRole('dialog', {name: 'Operation failed'})
      .getByRole('button', {name: 'Cancel', exact: true})
      .click();
  }
  await expect(access(join(manager.home, 'data/manager-e2e/user/playwright/escaped.md'))).rejects.toThrow();
});

test('S03 resources are read-only, and removing an indexed copy preserves the source vault', async ({
  page,
  manager,
}) => {
  const vault = join(manager.root, 'vault');
  await mkdir(vault);
  const file = join(vault, 'Mémoire 日本語.md');
  const body = '# Resource source\n\nSource material stays in this synthetic vault.';
  await writeFile(file, body);
  await manager.cli([
    'source',
    'add',
    '--type',
    'obsidian',
    '--id',
    'library-vault',
    '--project',
    'manager-e2e',
    '--vault',
    vault,
    '--include',
    '**/*.md',
    '--apply',
  ]);
  await manager.api('/api/integrations/obsidian', {
    action: 'sync-source',
    id: 'library-vault',
    apply: true,
    confirm: true,
  });
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Library', exact: true})
    .click();
  await page.getByRole('button', {name: 'Resources', exact: true}).click();
  await page.getByRole('searchbox', {name: 'Search Library'}).fill('Mémoire');
  await page.locator('.tree-file').click();
  await expect(page.locator('.markdown-viewer')).toContainText('Source material stays');
  await expect(page.locator('.reader-head').getByRole('button', {name: 'Edit', exact: true})).toHaveCount(0);
  await memoryAction(page, 'Remove indexed copy…');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/source|original/iu);
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(await readFile(file, 'utf8')).toBe(body);
  await memoryAction(page, 'Remove indexed copy…');
  await page.getByRole('dialog').getByRole('button', {name: 'Remove indexed copy', exact: true}).click();
  await expect(page.locator('.tree-file')).toHaveCount(0);
  expect(await readFile(file, 'utf8')).toBe(body);
});

test('S04 structured relations resolve stable identities, survive reload and can be removed', async ({
  page,
  manager,
}) => {
  const first = await manager.remember('A relation-editor-anchor decision.', 'relation-editor-anchor');
  const second = await manager.remember('Neighbor relationship evidence.', 'relation-neighbor');
  const neighborId = /memory_id: (tn_\S+)/u.exec(await manager.cli(['read', second]))?.[1];
  expect(neighborId).toMatch(/^tn_/u);
  const stableNeighbor = `threadnote://memory/${neighborId}`;
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Context', exact: true})
    .click();
  await page.getByRole('tab', {name: 'Recall', exact: true}).click();
  await page.getByRole('textbox', {name: 'Recall query', exact: true}).fill('relation-editor-anchor');
  await page.getByRole('button', {name: 'Recall context', exact: true}).click();
  await page
    .locator('.context-recall-card')
    .filter({hasText: 'relation-editor-anchor'})
    .getByRole('button')
    .first()
    .click();
  const reader = page.getByRole('complementary', {name: 'Canonical context reader'});
  await expect(reader).toContainText(first);
  await reader.getByRole('tab', {name: 'Connections', exact: true}).click();
  await reader.getByRole('button', {name: 'Add relation', exact: true}).click();
  await reader.getByRole('textbox', {name: 'Target memory', exact: true}).fill(second);
  await reader.getByRole('button', {name: 'Save relations', exact: true}).click();
  await expect.poll(() => manager.cli(['read', first])).toContain('related_to');
  const saved = await manager.cli(['read', first]);
  expect(saved).toContain('memory_id: tn_');
  expect(saved).toContain(`relation: related_to ${stableNeighbor}`);
  await expect(reader.getByRole('button', {name: 'Open neighbor', exact: true})).toBeVisible();
  await page.reload();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Context', exact: true})
    .click();
  await page.getByRole('tab', {name: 'Recall', exact: true}).click();
  await page.getByRole('textbox', {name: 'Recall query', exact: true}).fill('relation-editor-anchor');
  await page.getByRole('button', {name: 'Recall context', exact: true}).click();
  await page
    .locator('.context-recall-card')
    .filter({hasText: 'relation-editor-anchor'})
    .getByRole('button')
    .first()
    .click();
  await reader.getByRole('tab', {name: 'Connections', exact: true}).click();
  await expect(reader.getByRole('textbox', {name: 'Target memory', exact: true})).toHaveValue(stableNeighbor);
  await reader.locator('.context-relation-editor').getByRole('button', {name: 'Remove', exact: true}).click();
  await reader.getByRole('button', {name: 'Save relations', exact: true}).click();
  await expect.poll(() => manager.cli(['read', first])).not.toContain('related_to');
  expect(await manager.cli(['read', second])).toContain('Neighbor relationship evidence.');
});
