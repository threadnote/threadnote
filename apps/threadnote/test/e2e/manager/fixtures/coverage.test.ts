import {expect, it} from 'vitest';
import {Array as EffectArray, Record as EffectRecord, Schema, String as EffectString} from 'effect';
import {spawnSync} from '@threadnote/testing/node-child-process';
import {mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import inventory from '../coverage-inventory.json' with {type: 'json'};
import {findExecutable, repositoryRoot} from './environment.js';
import {managerIntegrations} from '../../../../src/manager/integrations_ui.js';

interface ListedSuite {
  readonly suites?: readonly ListedSuite[];
  readonly specs?: readonly {
    readonly file: string;
    readonly title: string;
    readonly tests: readonly {readonly projectName: string; readonly expectedStatus: string}[];
  }[];
}

const listedSuite: Schema.Codec<ListedSuite> = Schema.Struct({
  suites: Schema.optionalKey(Schema.Array(Schema.suspend(() => listedSuite))),
  specs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        file: Schema.String,
        title: Schema.String,
        tests: Schema.Array(Schema.Struct({projectName: Schema.String, expectedStatus: Schema.String})),
      }),
    ),
  ),
});

it('maps every discovered Chromium case, requirement, section and registered provider without missing tests', () => {
  const result = spawnSync(
    findExecutable('bun'),
    [
      '--bun',
      'node_modules/@playwright/test/cli.js',
      'test',
      '--config',
      'playwright.manager.config.ts',
      '--list',
      '--reporter=json',
    ],
    {cwd: repositoryRoot, encoding: 'utf8', timeout: 30_000, env: {...process.env, CI: 'true'}},
  );
  expect(result.status, result.stderr).toBe(0);
  const report = Schema.decodeUnknownSync(
    Schema.Struct({
      suites: Schema.Array(listedSuite),
      config: Schema.Struct({projects: Schema.Array(Schema.Struct({name: Schema.String}))}),
    }),
  )(JSON.parse(result.stdout));
  expect(EffectArray.map(report.config.projects, project => project.name)).toEqual(['chromium']);
  const discovered = new Set<string>();
  const visit = (suite: ListedSuite): void => {
    for (const spec of suite.specs ?? []) {
      expect(spec.title).toMatch(/\bS\d{2}\b/u);
      for (const test of spec.tests) {
        expect(test.projectName).toBe('chromium');
        expect(test.expectedStatus).toBe('passed');
      }
      discovered.add(`${spec.file}:${spec.title}`);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites) visit(suite);
  const mapped = new Set<string>();
  expect(EffectArray.map(inventory.scenarios, scenario => scenario.id)).toEqual(
    Array.from({length: 20}, (_, index) => `S${EffectString.padStart(2, '0')(String(index + 1))}`),
  );
  for (const scenario of inventory.scenarios) {
    expect(scenario.tests.length, scenario.id).toBeGreaterThan(0);
    for (const test of scenario.tests) {
      const key = `${test.file}:${test.title}`;
      expect(discovered.has(key), key).toBe(true);
      mapped.add(key);
    }
  }
  expect([...mapped].sort()).toEqual([...discovered].sort());
  expect(EffectRecord.keys(inventory.requirements)).toEqual(Array.from({length: 10}, (_, index) => `R${index + 1}`));
  expect(EffectRecord.keys(inventory.sections)).toHaveLength(12);
  const ids = new Set(EffectArray.map(inventory.scenarios, scenario => scenario.id));
  for (const scenarios of [
    ...EffectRecord.values(inventory.requirements),
    ...EffectRecord.values(inventory.sections),
  ]) {
    expect(scenarios.length).toBeGreaterThan(0);
    for (const id of scenarios) expect(ids.has(id)).toBe(true);
  }
  expect(EffectRecord.keys(inventory.providers).sort()).toEqual(
    EffectArray.map(managerIntegrations, integration => integration.product.id).sort(),
  );
  for (const provider of EffectRecord.values(inventory.providers))
    expect(discovered.has(`${provider.file}:${provider.title}`)).toBe(true);
});

for (const probe of ['passed', 'skipped', 'flaky', 'expected-failure'] as const) {
  it(`qualifies the actual ${probe} runner result`, async () => {
    const root = await mkdtemp(join(repositoryRoot, '.context/manager-e2e-contract-'));
    try {
      const reporter = join(repositoryRoot, 'apps/threadnote/test/e2e/manager/fixtures/required-cases-reporter.ts');
      await writeFile(
        join(root, 'playwright.config.ts'),
        `export default {testDir: '.', testMatch: 'probe.spec.ts', outputDir: ${JSON.stringify(join(root, 'results'))}, retries: 1, failOnFlakyTests: true, reporter: [[${JSON.stringify(reporter)}], ['json', {outputFile: ${JSON.stringify(join(root, 'report.json'))}}]]};`,
      );
      await writeFile(
        join(root, 'probe.spec.ts'),
        probe === 'passed'
          ? "import {test} from '@playwright/test'; test('required case', () => {});"
          : probe === 'skipped'
            ? "import {test} from '@playwright/test'; test.skip('required case', () => {});"
            : probe === 'expected-failure'
              ? "import {test, expect} from '@playwright/test'; test.fail('required case', () => {expect(false).toBe(true)});"
              : "import {test, expect} from '@playwright/test'; test('required case', () => {expect(test.info().retry).toBe(1)});",
      );
      const result = spawnSync(
        findExecutable('bun'),
        ['--bun', 'node_modules/@playwright/test/cli.js', 'test', '--config', join(root, 'playwright.config.ts')],
        {cwd: repositoryRoot, encoding: 'utf8', timeout: 20_000},
      );
      expect(result.status, result.stdout + result.stderr).toBe(probe === 'passed' ? 0 : 1);
      const report = Schema.decodeUnknownSync(
        Schema.Struct({stats: Schema.Struct({expected: Schema.Finite, skipped: Schema.Finite, flaky: Schema.Finite})}),
      )(JSON.parse(await readFile(join(root, 'report.json'), 'utf8')));
      expect(report.stats[probe === 'passed' || probe === 'expected-failure' ? 'expected' : probe]).toBe(1);
      if (probe === 'skipped' || probe === 'expected-failure')
        expect(result.stderr).toContain('cannot pass with non-passing cases');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
}
