import {Array as EffectArray, Predicate} from 'effect';
import {spawnSync} from '@threadnote/testing/node-child-process';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {fileURLToPath} from '@threadnote/testing/node-url';
import {afterEach, describe, expect, it} from 'vitest';
import {workflowScenarios} from '../src/scenarios.js';
import {captureBaseline} from './helpers/capture-baseline.js';
import * as EffectRecord from 'effect/Record';

type FileMeasurement = {readonly path: string; readonly bytes: number};
type ScenarioCase = {readonly id: string; readonly expectedInvariants: string[]; readonly measurementUnits: string[]};
type BaselineMeasurements = {
  readonly skillDocuments: {readonly files: FileMeasurement[]; readonly totalBytes: number};
  readonly scenarios: {readonly count: number; readonly cases: ScenarioCase[]};
};
type RuntimeMeasurements = {
  readonly startup: {readonly durationsMilliseconds: number[]};
  readonly fileSize: {readonly bytes: number; readonly label: string};
};

const isStringArray = (value: unknown): value is string[] =>
  EffectArray.isArray(value) && EffectArray.every(value, item => typeof item === 'string');
const isBaselineMeasurements = (value: unknown): value is BaselineMeasurements => {
  if (!Predicate.isObject(value)) return false;
  const skills = value.skillDocuments;
  const scenarios = value.scenarios;
  return (
    Predicate.isObject(skills) &&
    EffectArray.isArray(skills.files) &&
    EffectArray.every(
      skills.files,
      file => Predicate.isObject(file) && typeof file.path === 'string' && typeof file.bytes === 'number',
    ) &&
    typeof skills.totalBytes === 'number' &&
    Predicate.isObject(scenarios) &&
    typeof scenarios.count === 'number' &&
    EffectArray.isArray(scenarios.cases) &&
    EffectArray.every(
      scenarios.cases,
      item =>
        Predicate.isObject(item) &&
        typeof item.id === 'string' &&
        isStringArray(item.expectedInvariants) &&
        isStringArray(item.measurementUnits),
    )
  );
};
const isRuntimeMeasurements = (value: unknown): value is RuntimeMeasurements =>
  Predicate.isObject(value) &&
  Predicate.isObject(value.startup) &&
  EffectArray.isArray(value.startup.durationsMilliseconds) &&
  EffectArray.every(value.startup.durationsMilliseconds, duration => typeof duration === 'number') &&
  Predicate.isObject(value.fileSize) &&
  typeof value.fileSize.bytes === 'number' &&
  typeof value.fileSize.label === 'string';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(EffectArray.map(roots.splice(0), root => rm(root, {recursive: true, force: true})));
});

async function makeGitFixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-baseline-'));
  roots.push(root);
  const docs = join(root, 'config/agent-skills/dev-spec');
  await mkdir(join(docs, 'references'), {recursive: true});
  const manifest = {
    schemaVersion: 2,
    nativeRequirements: {executorVersion: 1, authoringVersion: 1, cycleVersion: 1, watchVersion: 1, closeoutVersion: 1},
    workflowProtocol: 7,
    stateSchema: 3,
    skills: [{id: 'dev-spec', files: ['SKILL.md', 'references/contract.md']}],
  };
  await writeFile(join(root, 'config/dev-skills.json'), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(docs, 'SKILL.md'), 'Workflow café 🧭\n');
  await writeFile(join(docs, 'references/contract.md'), 'Résumé: naïve façade\n');
  await writeFile(join(root, 'ignored.txt'), 'not shipped\n');
  for (const args of [
    ['init', '-q'],
    [
      'add',
      'config/dev-skills.json',
      'config/agent-skills/dev-spec/SKILL.md',
      'config/agent-skills/dev-spec/references/contract.md',
    ],
    ['-c', 'user.name=Baseline Test', '-c', 'user.email=baseline@example.invalid', 'commit', '-qm', 'fixture'],
  ]) {
    const result = spawnSync('git', args, {cwd: root, encoding: 'utf8', timeout: 4_000, maxBuffer: 4_096});
    if (result.status !== 0) throw new Error(`bounded git fixture command failed (${args[0]})`);
  }
  return {root};
}

async function makeEncodedPathCliCheckout() {
  const checkout = await mkdtemp(join(tmpdir(), 'baseline checkout café-'));
  roots.push(checkout);
  const packagePath = join(checkout, 'packages/workflow-automations');
  await mkdir(join(packagePath, 'test/helpers'), {recursive: true});
  await mkdir(join(packagePath, 'src'), {recursive: true});
  const currentPackage = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const [source, target] of [
    [join(currentPackage, 'test/helpers/capture-baseline.ts'), join(packagePath, 'test/helpers/capture-baseline.ts')],
    [join(currentPackage, 'src/scenarios.ts'), join(packagePath, 'src/scenarios.ts')],
  ])
    await writeFile(target, await readFile(source));
  const testingShim = join(checkout, 'node_modules/@threadnote/testing');
  await mkdir(testingShim, {recursive: true});
  // The copied CLI imports Effect, just as the real workspace package does.
  await symlink(
    dirname(fileURLToPath(import.meta.resolve('effect/package.json'))),
    join(checkout, 'node_modules/effect'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const exports = EffectRecord.fromEntries(
    EffectArray.map(
      [
        ['node-child-process', 'child_process'],
        ['node-crypto', 'crypto'],
        ['node-fs-promises', 'fs/promises'],
        ['node-path', 'path'],
        ['node-url', 'url'],
      ],
      ([name]) => [`./${name}`, `./${name}.js`],
    ),
  );
  await writeFile(join(testingShim, 'package.json'), JSON.stringify({name: '@threadnote/testing', exports}));
  for (const [name, builtin] of [
    ['node-child-process', 'node:child_process'],
    ['node-crypto', 'node:crypto'],
    ['node-fs-promises', 'node:fs/promises'],
    ['node-path', 'node:path'],
    ['node-url', 'node:url'],
  ])
    await writeFile(join(testingShim, `${name}.js`), `export * from '${builtin}';\n`);
  return join(packagePath, 'test/helpers/capture-baseline.ts');
}

describe('workflow baseline capture', () => {
  it('accounts UTF-8 bytes deterministically and includes the complete frozen scenario catalog', async () => {
    const {root} = await makeGitFixture();
    const first = await captureBaseline({repo: root});
    const second = await captureBaseline({repo: root});
    if (!isBaselineMeasurements(first.sourceMeasurements) || !isBaselineMeasurements(second.sourceMeasurements))
      throw new Error('Baseline source measurements are malformed.');
    const firstMeasurements = first.sourceMeasurements;
    const secondMeasurements = second.sourceMeasurements;
    expect(first.source).toEqual(second.source);
    expect(firstMeasurements).toEqual(secondMeasurements);
    const collection = firstMeasurements.skillDocuments;
    let total = 0;
    for (const file of collection.files) {
      const bytes = await readFile(join(root, file.path));
      expect(file.bytes).toBe(bytes.byteLength);
      total += bytes.byteLength;
    }
    expect(collection.totalBytes).toBe(total);
    expect(first.schemaVersion).toBe(2);
    expect(first.source).toMatchObject({
      manifestSchemaVersion: 2,
      workflowProtocol: 7,
      stateSchema: 3,
      nativeRequirements: {
        executorVersion: 1,
        authoringVersion: 1,
        cycleVersion: 1,
        watchVersion: 1,
        closeoutVersion: 1,
      },
    });
    expect(EffectArray.map(firstMeasurements.skillDocuments.files, file => file.path)).toEqual([
      'config/agent-skills/dev-spec/SKILL.md',
      'config/agent-skills/dev-spec/references/contract.md',
    ]);
    expect(firstMeasurements.skillDocuments.totalBytes).toBeGreaterThan(0);
    expect(firstMeasurements.scenarios.count).toBe(workflowScenarios.length);
    expect(EffectArray.map(firstMeasurements.scenarios.cases, item => item.id)).toEqual(
      EffectArray.map(workflowScenarios, item => item.id),
    );
    for (const [index, item] of workflowScenarios.entries()) {
      expect(firstMeasurements.scenarios.cases[index]).toEqual({
        id: item.id,
        category: item.category,
        expectedInvariants: [...item.expectedInvariants],
        measurementUnits: [...item.measurements],
      });
      expect(item.expectedInvariants.length).toBeGreaterThan(0);
      expect(item.measurements.length).toBeGreaterThan(0);
    }
  });

  it('marks usage metrics unavailable and keeps runtime capture opt-in', async () => {
    const {root} = await makeGitFixture();
    const baseline = await captureBaseline({repo: root});
    expect(baseline.unavailableMetrics).toMatchObject({
      tokenCounts: 'unavailable',
      pricing: 'unavailable',
      actualModelUsage: 'unavailable',
      qualityClaims: 'unavailable',
    });
    expect(baseline.runtime).toMatchObject({status: 'not-requested'});
    expect(baseline.observations).toEqual([]);
  });

  it('records bounded runtime startup samples only when an executable is supplied', async () => {
    const {root} = await makeGitFixture();
    await expect(captureBaseline({repo: root, runtime: 'relative-runtime'})).rejects.toThrow(
      'absolute executable path',
    );
    const baseline = await captureBaseline({repo: root, runtime: process.execPath});
    expect(baseline.runtime).toMatchObject({
      versionStatus: 'available',
      startup: {
        argument: '--version',
        samples: 3,
        successfulSamples: 3,
        method: expect.stringContaining('bounded to 2000ms'),
      },
      sourceIdentity: {path: 'withheld'},
    });
    if (!isRuntimeMeasurements(baseline.runtime)) throw new Error('Runtime measurements are malformed.');
    const runtime = baseline.runtime;
    expect(runtime.startup.durationsMilliseconds).toHaveLength(3);
    expect(runtime.fileSize.bytes).toBeGreaterThan(0);
    expect(['executable-binary-bytes', 'launcher-file-bytes']).toContain(runtime.fileSize.label);
    if (process.platform === 'win32') {
      for (const windowsPath of ['C:\\missing-runtime.exe', '\\\\server\\share\\missing-runtime.exe']) {
        const error = await captureBaseline({repo: root, runtime: windowsPath}).then(
          () => '',
          failure => String(failure),
        );
        expect(error).not.toContain('absolute executable path');
      }
    }
  });

  it('runs the documented CLI from an encoded checkout path and writes its artifact', async () => {
    const {root} = await makeGitFixture();
    const script = await makeEncodedPathCliCheckout();
    const output = join(root, 'private baseline résumé.json');
    const run = spawnSync(process.execPath, [script, '--repo', root, '--out', output], {
      cwd: root,
      encoding: 'utf8',
      timeout: 8_000,
      maxBuffer: 8_192,
    });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    const capture: unknown = JSON.parse(await readFile(output, 'utf8'));
    if (!Predicate.isObject(capture) || !Predicate.isObject(capture.source))
      throw new Error('Baseline CLI output is malformed.');
    if (typeof capture.source.repositoryHead !== 'string') throw new Error('Baseline repository head is malformed.');
    expect(capture.source.repositoryHead.length).toBeGreaterThan(0);
  });
});
