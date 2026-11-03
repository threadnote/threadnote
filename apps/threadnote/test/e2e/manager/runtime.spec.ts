import {Array as EffectArray, String as EffectString} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';
import {readFile, readdir, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {test, expect} from './fixtures/test.js';
import {candidateBinary} from './fixtures/environment.js';
import {releaseRoutes} from './fixtures/releases.js';
import {providerRoutes} from './fixtures/providers.js';
import {proposeMemory} from './fixtures/reviews.js';

async function runtimeSection(page: import('@playwright/test').Page) {
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Runtime Health', exact: true})
    .click();
}

test('S17 process inspection and guarded termination affect only a benign owned runtime', async ({
  page,
  manager,
}, testInfo) => {
  const sentinel = await manager.remember('Preserve the runtime sentinel.', 'runtime-sentinel');
  const before = await manager.cli(['read', sentinel]);
  const child = manager.launch(candidateBinary, [
    '--home',
    manager.home,
    '--manifest',
    manager.manifest,
    'manage',
    '--ui-port',
    '0',
    '--no-open',
  ]);
  const pid = child.pid;
  if (!pid) throw Error('Owned process did not start.');
  await expect.poll(async () => JSON.stringify(await manager.api('/api/processes'))).toContain(`"processId":${pid}`);
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Processes', exact: true})
    .click();
  const stop = page.getByRole('button', {name: new RegExp(`^Terminate .+ process ${pid}$`, 'u')});
  const row = page.getByRole('listitem').filter({has: stop});
  await expect(row).toContainText(`PID ${pid}`);
  for (const field of ['CPU', 'Memory', 'Parent', 'Age', 'Version', 'Worktree', 'Branch', 'Idle'])
    await expect(row).toContainText(new RegExp(field, 'iu'));
  await expect(row.getByRole('button', {name: /Inspect|Details/u})).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row.locator('dt').filter({hasText: /^CPU$/u}).locator('..').locator('dd')).toHaveText(/^\d+\.\d%$/u);
  for (const theme of ['Light', 'Dark']) {
    await page.setViewportSize({width: 1280, height: 900});
    await page.getByRole('button', {name: theme, exact: true}).click();
    const cpuColors = await page.locator('html').evaluate(element => {
      const style = getComputedStyle(element);
      const colors: string[][] = [];
      for (const [foreground, background] of [
        ['--warn', '--warn-soft'],
        ['--danger', '--danger-soft'],
      ]) {
        colors.push([style.getPropertyValue(foreground), style.getPropertyValue(background)]);
      }
      return colors;
    });
    for (const [foreground, background] of cpuColors)
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);

    for (const width of [1280, 360]) {
      await page.setViewportSize({width, height: 900});
      await row.scrollIntoViewIfNeeded();
      await expect(stop).toBeVisible();
      expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (width === 1280) expect((await row.boundingBox())!.height).toBeLessThan(180);
      await row.screenshot({path: testInfo.outputPath(`process-lane-${EffectString.toLowerCase(theme)}-${width}.png`)});
    }
  }
  await page.setViewportSize({width: 1280, height: 900});
  await stop.click();
  const confirm = page.getByRole('dialog', {name: 'Terminate Threadnote process?', exact: true});
  await confirm.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(child.exitCode).toBeNull();
  await stop.click();
  await confirm.getByRole('button', {name: 'Terminate process', exact: true}).click();
  await expect.poll(() => child.exitCode).not.toBeNull();
  expect(await manager.cli(['read', sentinel])).toBe(before);
  expect((await manager.api('/api/state')).config).toMatchObject({user: 'playwright', agentContextHome: manager.home});
});

test('S17 diagnostics, repair preview/cancel and local value reports preserve canonical knowledge', async ({
  page,
  manager,
}) => {
  const sentinel = await manager.remember('Private report canary stays out of count-only diagnostics.', 'value-canary');
  const before = await manager.cli(['read', sentinel]);
  const manifest = await readFile(manager.manifest, 'utf8');
  await proposeMemory(manager, 'counted-review');
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await runtimeSection(page);
  const checked = page.waitForResponse(r => new URL(r.url()).pathname === '/api/doctor');
  await page.getByRole('button', {name: 'Run diagnostics', exact: true}).click();
  const diagnostics: unknown = await (await checked).json();
  if (!isJsonObject(diagnostics) || !EffectArray.isArray(diagnostics.checks))
    throw Error('Actual diagnostic checks missing.');
  expect(diagnostics.checks).toEqual(
    expect.arrayContaining([expect.objectContaining({name: 'Threadnote home', detail: manager.home, status: 'ok'})]),
  );
  await page.getByText('Technical diagnostic output', {exact: true}).click();
  await expect(page.locator('.health-technical')).toContainText(manager.home);
  await page.getByRole('tab', {name: 'Repair', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Apply repair…', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: 'Preview repair', exact: true}).click();
  await page.getByRole('button', {name: 'Apply repair…', exact: true}).click();
  await page
    .getByRole('dialog', {name: 'Repair Threadnote?', exact: true})
    .getByRole('button', {name: 'Cancel', exact: true})
    .click();
  expect(await readFile(manager.manifest, 'utf8')).toBe(manifest);
  expect(await manager.cli(['read', sentinel])).toBe(before);
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Context', exact: true})
    .click();
  await page.getByRole('tab', {name: 'Value', exact: true}).click();
  const reported = page.waitForResponse(r => new URL(r.url()).pathname === '/api/value/report');
  await page.getByRole('button', {name: 'Load value report', exact: true}).click();
  const report = await (await reported).json();
  expect(report.knowledgeDelta.proposed).toBeGreaterThan(0);
  const text = JSON.stringify(report);
  expect(text).not.toContain(manager.home);
  expect(text).not.toContain('Private report canary');
  expect(text).not.toContain(sentinel);
  await expect(page.locator('.value-workspace')).toContainText(
    `${report.knowledgeDelta.approved}/${report.knowledgeDelta.proposed}`,
  );
  expect(await manager.cli(['read', sentinel])).toBe(before);
});

test('S17 update checks fail visibly, retry successfully and reject an incomplete release before installation', async ({
  page,
  manager,
}) => {
  await runtimeSection(page);
  await page.getByRole('tab', {name: 'Updates', exact: true}).click();
  const setup = page.locator('.model-setup-card');
  await expect(setup).toContainText('Automatic setup is managed off');
  await expect(setup.getByRole('switch', {name: 'Automatic local model setup', exact: true})).toBeDisabled();
  await expect(page.getByRole('switch', {name: 'Automatic updates', exact: true})).toBeDisabled();
  await manager.setNetwork(
    EffectArray.map(releaseRoutes(manager.expectedVersion), route => ({
      ...route,
      status: 503,
      body: {error: 'Synthetic release service failure'},
    })),
  );
  await page.getByRole('button', {name: 'Check for updates', exact: true}).click();
  await expect(page.getByText('Check failed', {exact: true})).toBeVisible();
  await expect(page.getByRole('alert').filter({hasText: 'Could not check for updates.'})).toBeVisible();
  await manager.setNetwork(releaseRoutes(manager.expectedVersion));
  await page.getByRole('button', {name: 'Check for updates', exact: true}).click();
  await expect(page.getByText('Up to date', {exact: true})).toBeVisible();
  await manager.setNetwork(releaseRoutes('999.0.0'));
  await page.getByRole('button', {name: 'Check for updates', exact: true}).click();
  await expect(page.getByText('v999.0.0 available', {exact: true})).toBeVisible();
  const before = new Bun.CryptoHasher('sha256').update(await readFile(candidateBinary)).digest('hex');
  await page.getByRole('button', {name: 'Update Threadnote', exact: true}).click();
  await expect(page.getByRole('alert').filter({hasText: 'Update needs attention'})).toContainText(
    'Release 999.0.0 does not publish',
  );
  expect(new Bun.CryptoHasher('sha256').update(await readFile(candidateBinary)).digest('hex')).toBe(before);
  expect(await manager.api('/api/runtime/updates?view=status')).toMatchObject({
    runningVersion: manager.expectedVersion,
    job: {status: 'failed'},
  });
});

test.describe('local model setup external boundary', () => {
  test.use({managerScenario: 'model-setup'});
  test('S17 model setup exposes progress, bounded access failure, explicit retry and stop without accepting an artifact', async ({
    page,
    manager,
  }) => {
    test.setTimeout(60_000);
    await runtimeSection(page);
    await page.getByRole('tab', {name: 'Updates', exact: true}).click();
    const setup = page.locator('.model-setup-card');
    const policy = setup.getByRole('switch', {name: 'Automatic local model setup', exact: true});
    await expect(policy).not.toBeChecked();
    await policy.click();
    const current = await manager.api('/api/models/setup');
    if (current.reason === 'insufficient-memory' || current.reason === 'unsupported-platform') {
      test.info().annotations.push({type: 'model-setup-capability', description: String(current.reason)});
      await setup.getByText('Setup details', {exact: true}).click();
      await expect(setup).toContainText(
        current.reason === 'insufficient-memory'
          ? 'does not have enough memory'
          : 'does not support automatic local model setup',
      );
    } else {
      await expect(setup.getByRole('progressbar', {name: 'Local model download', exact: true})).toBeVisible();
      await expect
        .poll(async () =>
          EffectArray.filter(await manager.networkJournal(), request => request.origin !== 'https://api.github.com'),
        )
        .toEqual(expect.arrayContaining([expect.objectContaining({method: 'GET', matched: true})]));
      expect((await manager.api('/api/models/setup')).artifactReady).toBe(false);
      await writeFile(join(manager.root, 'model-download-ready'), 'ready');
      await expect(setup).toContainText('Model setup needs attention');
      await setup.getByText('Setup details', {exact: true}).click();
      await expect(setup).toContainText('The model download requires access.');
      const before = (await manager.networkJournal()).length;
      await setup.getByRole('button', {name: 'Retry setup', exact: true}).click();
      await expect.poll(async () => (await manager.networkJournal()).length).toBeGreaterThan(before);
      await expect(setup).toContainText('Model setup needs attention');
    }
    await policy.click();
    await expect(policy).not.toBeChecked();
    expect(await manager.api('/api/models/setup')).toMatchObject({policy: 'off', artifactReady: false});
    expect(await manager.api('/api/consolidation-models?agent=local-ai')).toEqual({models: []});
  });
});

test('S17 operations footer opens the real process inventory for a fixture-owned sync', async ({page, manager}) => {
  await manager.setNetwork(
    EffectArray.map(providerRoutes(manager.expectedVersion), route =>
      route.path === '/repositories/7/issues' ? {...route, gate: 'provider-operation'} : route,
    ),
  );
  await manager.cli([
    'source',
    'add',
    '--type',
    'github',
    '--id',
    'fixture-github',
    '--project',
    'manager-e2e',
    '--credential-env',
    'E2E_GITHUB_TOKEN',
    '--repo',
    'fixture/repository',
    '--apply',
  ]);
  const syncing = manager.api('/api/integrations/github', {
    action: 'sync-source',
    id: 'fixture-github',
    apply: true,
    confirm: true,
  });
  try {
    await expect
      .poll(async () =>
        EffectArray.some(await manager.networkJournal(), request => request.path === '/repositories/7/issues'),
      )
      .toBe(true);
    const operations = page.getByRole('button', {name: 'Inspect active operations', exact: true});
    await expect(operations).toContainText(/active operation/u);
    await operations.click();
    await expect(page.getByRole('navigation', {name: 'Breadcrumb'})).toContainText('Processes');
    await expect(page.getByRole('listitem').filter({hasText: 'Integration sync worker'})).toBeVisible();
  } finally {
    await writeFile(join(manager.root, 'provider-operation'), 'ready');
    expect(await syncing).not.toHaveProperty('error');
  }
  const directory = join(manager.home, 'data/manager-e2e/resources/external/github');
  const files = EffectArray.filter(await readdir(directory, {recursive: true}), EffectString.endsWith('.md'));
  const contents = await Promise.all(EffectArray.map(files, file => readFile(join(directory, file), 'utf8')));
  expect(EffectArray.join(contents, '\n')).toContain('github-e2e-needle');
});

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(EffectString.trim(color));
    if (!match) throw Error(`Expected an RGB hex color, received ${color}`);
    const channels = EffectArray.map([match[1], match[2], match[3]], value => {
      const channel = Number.parseInt(value, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
