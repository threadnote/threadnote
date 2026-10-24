import {spawnSync} from '@threadnote/testing/node-child-process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {fileURLToPath} from '@threadnote/testing/node-url';
import {afterEach, describe, expect, it} from 'vitest';
import {workflowScenarios} from '../src/scenarios.js';
import {captureBaseline} from './helpers/capture-baseline.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

async function makeGitFixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-baseline-'));
  roots.push(root);
  const docs = join(root, 'config/agent-skills/dev-spec');
  await mkdir(join(docs, 'references'), {recursive: true});
  await mkdir(join(docs, 'scripts'), {recursive: true});
  const manifest = {
    workflowProtocol: 7,
    stateSchema: 3,
    skills: [{id: 'dev-spec', files: ['SKILL.md', 'references/contract.md', 'scripts/helper.py']}],
  };
  await writeFile(join(root, 'config/dev-skills.json'), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(docs, 'SKILL.md'), 'Workflow café 🧭\n');
  await writeFile(join(docs, 'references/contract.md'), 'Résumé: naïve façade\n');
  await writeFile(join(docs, 'scripts/helper.py'), '# π workflow helper\n');
  await writeFile(join(root, 'ignored.txt'), 'not shipped\n');
  for (const args of [
    ['init', '-q'],
    [
      'add',
      'config/dev-skills.json',
      'config/agent-skills/dev-spec/SKILL.md',
      'config/agent-skills/dev-spec/references/contract.md',
      'config/agent-skills/dev-spec/scripts/helper.py',
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
    [join(currentPackage, 'src/inventory.ts'), join(packagePath, 'src/inventory.ts')],
    [join(currentPackage, 'src/scenarios.ts'), join(packagePath, 'src/scenarios.ts')],
  ])
    await writeFile(target, await readFile(source));
  const testingShim = join(checkout, 'node_modules/@threadnote/testing');
  await mkdir(testingShim, {recursive: true});
  const exports = Object.fromEntries(
    [
      ['node-child-process', 'child_process'],
      ['node-crypto', 'crypto'],
      ['node-fs-promises', 'fs/promises'],
      ['node-path', 'path'],
      ['node-url', 'url'],
    ].map(([name]) => [`./${name}`, `./${name}.js`]),
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
    const firstMeasurements = first.sourceMeasurements as {
      skillDocuments: {files: {path: string; bytes: number}[]; totalBytes: number};
      shippedPython: {files: {path: string; bytes: number}[]; totalBytes: number};
      scenarios: {count: number; cases: {id: string; expectedInvariants: string[]; measurementUnits: string[]}[]};
    };
    const secondMeasurements = second.sourceMeasurements as typeof firstMeasurements;
    expect(first.source).toEqual(second.source);
    expect(firstMeasurements).toEqual(secondMeasurements);
    for (const collection of [firstMeasurements.skillDocuments, firstMeasurements.shippedPython]) {
      let total = 0;
      for (const file of collection.files) {
        const bytes = await readFile(join(root, file.path));
        expect(file.bytes).toBe(bytes.byteLength);
        total += bytes.byteLength;
      }
      expect(collection.totalBytes).toBe(total);
    }
    expect(firstMeasurements.skillDocuments.files.map(file => file.path)).toEqual([
      'config/agent-skills/dev-spec/SKILL.md',
      'config/agent-skills/dev-spec/references/contract.md',
    ]);
    expect(firstMeasurements.shippedPython.files.map(file => file.path)).toEqual([
      'config/agent-skills/dev-spec/scripts/helper.py',
    ]);
    expect(firstMeasurements.skillDocuments.totalBytes).toBeGreaterThan(0);
    expect(firstMeasurements.scenarios.count).toBe(workflowScenarios.length);
    expect(firstMeasurements.scenarios.cases.map(item => item.id)).toEqual(workflowScenarios.map(item => item.id));
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
    const runtime = baseline.runtime as {
      startup: {durationsMilliseconds: number[]};
      fileSize: {bytes: number; label: string};
    };
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
    expect(run.status).toBe(0);
    const capture = JSON.parse(await readFile(output, 'utf8')) as {source: {repositoryHead: string}};
    expect(capture.source.repositoryHead.length).toBeGreaterThan(0);
  });
});
