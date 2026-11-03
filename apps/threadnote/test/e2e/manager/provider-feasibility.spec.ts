import {readFile, readdir} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {test, expect} from './fixtures/test.js';
import {providerNames} from './fixtures/providers.js';
import {Array as EffectArray, pipe} from 'effect';
import * as EffectString from 'effect/String';

test.use({managerScenario: 'providers'});

test('S01 fixture boundaries reach every configured provider through the compiled coordinator', async ({manager}) => {
  test.setTimeout(60_000);
  for (const provider of providerNames) {
    const result = await manager.api(`/api/integrations/${provider}`, {
      action: 'sync-source',
      id: `fixture-${provider}`,
      apply: true,
      confirm: true,
    });
    expect(result, provider).not.toHaveProperty('error');
    const directory = join(manager.home, 'data/manager-e2e/resources/external', provider);
    const files = await readdir(directory, {recursive: true});
    const markdown = await Promise.all(
      EffectArray.map(
        EffectArray.filter(files, file => pipe(file, EffectString.endsWith('.md'))),
        file => readFile(join(directory, file), 'utf8'),
      ),
    );
    expect(EffectArray.join(markdown, '\n'), provider).toContain(`${provider}-e2e-needle`);
  }
  const processes = await readdir(join(manager.root, 'processes'));
  const markers = await Promise.all(
    EffectArray.map(processes, async file => JSON.parse(await readFile(join(manager.root, 'processes', file), 'utf8'))),
  );
  expect(markers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({argv: expect.arrayContaining(['--threadnote-integration-sync-worker'])}),
    ]),
  );
  for (const marker of markers) expect(marker).toMatchObject({home: manager.home});
  const unexpected = EffectArray.filter(await manager.networkJournal(), request => request.matched !== true);
  expect(unexpected.length, JSON.stringify(EffectArray.take(unexpected, 5))).toBe(0);
});
