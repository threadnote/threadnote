import {test, expect} from './fixtures/test.js';
import {providerNames} from './fixtures/providers.js';
import {readFile, readdir} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {Array as EffectArray, Option as EffectOption, String as EffectString} from 'effect';

const labels = {
  obsidian: 'Obsidian',
  github: 'GitHub',
  linear: 'Linear',
  pocket: 'Pocket',
  superhuman: 'Superhuman Docs',
};

test.describe('configured provider journeys', () => {
  test.use({managerScenario: 'providers'});
  for (const provider of providerNames) {
    test(`S15 ${provider} settings, sync, read and reviewed disconnection preserve unmanaged source`, async ({
      page,
      manager,
    }) => {
      test.setTimeout(60_000);
      const id = `fixture-${provider}`;
      await page
        .getByRole('navigation', {name: 'Manager sections'})
        .getByRole('button', {name: 'Integrations', exact: true})
        .click();
      const row = page
        .locator('.integration-row')
        .filter({has: page.getByRole('heading', {name: new RegExp(id, 'u')})});
      await expect(row).toBeVisible();
      await row.getByRole('button', {name: /^Actions for /u}).click();
      await page.getByRole('menuitem', {name: 'Connection settings…', exact: true}).click();
      const settings = page.getByRole('dialog');
      await expect(settings.getByRole('textbox', {name: 'Connection name', exact: true})).toHaveValue(id);
      if (provider === 'obsidian')
        await settings.getByRole('textbox', {name: /^Include patterns/u}).fill('Browser*.md');
      else {
        await settings.getByText('Advanced settings', {exact: true}).click();
        await settings.getByRole('spinbutton', {name: 'Maximum stale age (hours)', exact: true}).fill('48');
      }
      if (provider === 'linear') {
        await settings.getByRole('button', {name: 'Verify selection', exact: true}).click();
        await expect(settings.getByRole('status')).toContainText('Verified for this Linear account:');
      }
      await settings.getByRole('button', {name: 'Save settings', exact: true}).click();
      await expect(settings).toHaveCount(0);
      expect((await manager.api('/api/integrations'))[provider]).toMatchObject({
        sources: expect.arrayContaining([
          expect.objectContaining({
            id,
            ...(provider === 'obsidian' ? {include: ['Browser*.md']} : {maxStaleHours: 48}),
          }),
        ]),
      });
      await row
        .getByRole('button', {name: provider === 'obsidian' ? 'Preview import' : 'Sync now', exact: true})
        .click();
      if (provider === 'obsidian') {
        const preview = page.getByRole('dialog', {name: 'Preview vault import', exact: true});
        await expect(preview).toContainText('Browser fixture.md');
        await preview.getByRole('button', {name: 'Apply changes', exact: true}).click();
        await expect(preview.getByRole('status')).toContainText('Completed.');
        await preview.getByRole('button', {name: 'Done', exact: true}).click();
      } else {
        const result = page.getByRole('dialog');
        if (provider === 'linear') {
          // Verification and save consume this account's first admission window.
          // The real coordinator resumes the queued sync after its quota delay.
          await expect(result.getByRole('status')).toHaveText('Sync finished with warnings.');
          await expect(result).toContainText('Linear refresh: transport-rejected.');
        } else await expect(result).toContainText(/completed/iu);
        await result.getByRole('button', {name: 'Close details', exact: true}).click();
      }
      const directory = join(manager.home, 'data/manager-e2e/resources/external', provider);
      await expect
        .poll(
          async () => {
            const paths = EffectArray.filter(
              await readdir(directory, {recursive: true}).catch(() => []),
              EffectString.endsWith('.md'),
            );
            return EffectArray.join(
              await Promise.all(EffectArray.map(paths, path => readFile(join(directory, path), 'utf8'))),
              '\n',
            );
          },
          {timeout: 30_000},
        )
        .toContain(`${provider}-e2e-needle`);
      const files = EffectArray.filter(await readdir(directory, {recursive: true}), path =>
        EffectString.endsWith('.md')(path),
      );
      expect(files.length).toBeGreaterThan(0);
      const contents = await Promise.all(EffectArray.map(files, path => readFile(join(directory, path), 'utf8')));
      expect(EffectArray.join(contents, '\n')).toContain(`${provider}-e2e-needle`);
      const payload = EffectOption.getOrThrow(
        EffectArray.findFirstIndex(contents, content => EffectString.includes(`${provider}-e2e-needle`)(content)),
      );
      const uri = `threadnote://resources/external/${provider}/${files[payload]}`;
      expect(await manager.cli(['read', uri])).toContain(`${provider}-e2e-needle`);
      await row.getByRole('button', {name: /^Actions for /u}).click();
      await page
        .getByRole('menuitem', {name: provider === 'obsidian' ? 'Disconnect source…' : 'Disconnect…', exact: true})
        .click();
      const disconnect = page.getByRole('dialog', {
        name: provider === 'obsidian' ? 'Disconnect vault source' : `Disconnect ${labels[provider]}?`,
        exact: true,
      });
      await disconnect.getByRole('button', {name: 'Cancel', exact: true}).click();
      await expect(row).toBeVisible();
      expect(await readFile(join(directory, files[0]), 'utf8')).toBe(contents[0]);
      await row.getByRole('button', {name: /^Actions for /u}).click();
      await page
        .getByRole('menuitem', {name: provider === 'obsidian' ? 'Disconnect source…' : 'Disconnect…', exact: true})
        .click();
      await disconnect.getByRole('button', {name: 'Disconnect', exact: true}).click();
      if (provider === 'obsidian') await disconnect.getByRole('button', {name: 'Done', exact: true}).click();
      await expect(row).toHaveCount(0);
      expect(await manager.cli(['source', 'list'])).not.toContain(id);
      expect(await readFile(join(manager.root, 'vault/Browser fixture.md'), 'utf8')).toContain('obsidian-e2e-needle');
    });
  }
});

test('S15 all five catalog forms require valid names and credentials before saving', async ({page, manager}) => {
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Integrations', exact: true})
    .click();
  await page.getByRole('tab', {name: /^Available integrations/u}).click();
  await expect(page.locator('.integration-product')).toHaveCount(5);
  for (const setup of [
    'Import notes',
    'Connect GitHub',
    'Connect Linear',
    'Connect Pocket',
    'Connect Superhuman Docs',
  ]) {
    await page.getByRole('button', {name: setup, exact: true}).click();
    const dialog = page.getByRole('dialog');
    const name = dialog.getByRole('textbox', {name: 'Connection name', exact: true});
    const credential =
      setup === 'Import notes'
        ? dialog.getByRole('textbox', {name: 'Vault path', exact: true})
        : dialog.locator('input[type=password]');
    await expect(credential).toHaveValue('');
    expect(await credential.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    await expect(name).toHaveValue('');
    expect(await name.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    await name.fill('invalid/name');
    expect(await name.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
    await name.fill('valid-name_9');
    expect(await name.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
    await dialog.getByRole('button', {name: 'Close details', exact: true}).click();
    await page
      .getByRole('dialog', {name: 'Discard connection changes?', exact: true})
      .getByRole('button', {name: 'Discard changes', exact: true})
      .click();
    await expect(dialog).toHaveCount(0);
  }
  expect(await manager.cli(['source', 'list'])).not.toContain('valid-name_9');
});
