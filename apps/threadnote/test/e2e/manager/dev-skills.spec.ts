import {test, expect} from './fixtures/test.js';
import {access, mkdir, readFile, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';

test('S14 development workflows preview, cancel, install, update and remove only managed files', async ({
  page,
  manager,
}) => {
  const neighbor = join(manager.home, '.agents/skills/unmanaged/SKILL.md');
  await mkdir(join(manager.home, '.agents/skills/unmanaged'), {recursive: true});
  await writeFile(neighbor, '# Unmanaged neighbor\n');
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Development workflows', exact: true})
    .click();
  await expect(page.getByRole('combobox', {name: 'Host / profile', exact: true})).toHaveValue('codex-cli');
  const skill = join(manager.home, '.agents/skills/dev-plan/SKILL.md');
  await expect(page.getByRole('button', {name: 'Preview install', exact: true})).toBeEnabled();
  await expect(access(skill)).rejects.toThrow();
  await page.getByRole('button', {name: 'Preview install', exact: true}).click();
  await page.getByRole('button', {name: 'Review and confirm install', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Confirm install development workflows', exact: true});
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(access(skill)).rejects.toThrow();
  await page.getByRole('button', {name: 'Review and confirm install', exact: true}).click();
  await dialog.getByRole('button', {name: 'Confirm install', exact: true}).click();
  await expect(page.getByText('Completed: install.', {exact: true})).toBeVisible();
  expect(await readFile(skill, 'utf8')).toContain('dev-plan');
  expect(await readFile(neighbor, 'utf8')).toBe('# Unmanaged neighbor\n');
  await page.reload();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Development workflows', exact: true})
    .click();
  await expect(page.getByRole('combobox', {name: 'Host / profile', exact: true})).toHaveValue('codex-cli');
  await page.getByRole('button', {name: 'Preview update', exact: true}).click();
  await page.getByRole('button', {name: 'Review and confirm update', exact: true}).click();
  await page
    .getByRole('dialog', {name: 'Confirm update development workflows', exact: true})
    .getByRole('button', {name: 'Confirm update', exact: true})
    .click();
  await expect(page.getByText('No changes applied: update.', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Preview remove', exact: true}).click();
  await page.getByRole('button', {name: 'Review and confirm remove', exact: true}).click();
  await page
    .getByRole('dialog', {name: 'Confirm remove development workflows', exact: true})
    .getByRole('button', {name: 'Confirm remove', exact: true})
    .click();
  await expect(page.getByText('Completed: remove.', {exact: true})).toBeVisible();
  await expect(access(skill)).rejects.toThrow();
  expect(await readFile(neighbor, 'utf8')).toBe('# Unmanaged neighbor\n');
});

test('S14 unsupported hosts and unmanaged collisions cannot install workflows', async ({page, manager}) => {
  const collision = join(manager.home, '.agents/skills/dev-plan/SKILL.md');
  await mkdir(join(manager.home, '.agents/skills/dev-plan'), {recursive: true});
  await writeFile(collision, '# Personal workflow\n');
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Development workflows', exact: true})
    .click();
  const hosts = page.getByRole('combobox', {name: 'Host / profile', exact: true});
  await hosts.selectOption({label: 'GitHub Copilot CLI · unsupported'});
  await expect(page.getByRole('button', {name: 'Preview install', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Preview update', exact: true})).toBeDisabled();
  await hosts.selectOption({label: 'Codex · desktop'});
  await page.getByRole('button', {name: 'Preview install', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Review and confirm install', exact: true})).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('cannot be applied');
  expect(await readFile(collision, 'utf8')).toBe('# Personal workflow\n');
});
