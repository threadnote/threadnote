import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
import {DevSkillsSource, loadDevSkillsBundleAt, nativeRequirements} from '../../src/dev_skills/manifest.js';

export const devSkillsTestLayer = Layer.mergeAll(
  BunServices.layer,
  TestSystemInfoLayer,
  TestCommandExecutorLayer.pipe(Layer.provideMerge(BunServices.layer), Layer.provide(TestSystemInfoLayer)),
);
export const fixture = Effect.fn('test.devSkills.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* SystemInfo;
  const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-dev-skills-'});
  const root = yield* fs.realPath(temporary);
  const source = path.join(root, 'source');
  const host = path.join(root, 'host');
  yield* fs.makeDirectory(host);
  const inventory = {
    schemaVersion: 2,
    nativeRequirements,
    workflowProtocol: 1,
    stateSchema: 1,
    minimumRuntime: '5.3.0-beta.4',
    skills: ['dev-spec', 'dev-plan', 'dev-cycle', 'watch-pr'].map(id => ({
      id,
      role: id === 'watch-pr' ? 'support' : 'primary',
      files: ['SKILL.md', 'scripts/helper.py', 'references/notes.md'],
    })),
  };
  for (const member of inventory.skills) {
    const directory = path.join(source, 'config', 'agent-skills', member.id);
    yield* fs.makeDirectory(path.join(directory, 'scripts'), {recursive: true});
    yield* fs.makeDirectory(path.join(directory, 'references'), {recursive: true});
    yield* fs.writeFileString(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${member.id}\n---\n{{THREADNOTE_SKILL_ROOT}}/scripts/helper.py\n{{THREADNOTE_BUNDLE_ROOT}}/dev-plan\n`,
    );
    yield* fs.writeFileString(
      path.join(directory, 'scripts/helper.py'),
      'print("{{THREADNOTE_SKILL_ROOT}} stays literal")\n',
    );
    yield* fs.writeFileString(
      path.join(directory, 'references/notes.md'),
      '{{THREADNOTE_BUNDLE_ROOT}} resource stays literal\n',
    );
  }
  const manifest = path.join(source, 'config/dev-skills.json');
  yield* fs.writeFileString(manifest, JSON.stringify(inventory));
  const home = path.join(root, 'home');
  const runtime = path.join(root, 'runtime');
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'manifest.yaml'),
    user: 'fixture',
  };
  const environment: NodeJS.ProcessEnv = {PATH: '', THREADNOTE_INSTALL_ROOT: runtime};
  const system = SystemInfo.of({
    ...base,
    homeDirectory: host,
    currentDirectory: () => root,
    environment: () => environment,
  });
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(SystemInfo, system),
      Effect.provideService(DevSkillsSource, {root: source, runtimeVersion: '5.3.0-beta.4'}),
    );
  return {fs, path, root, source, manifest, inventory, home, host, runtime, config, system, environment, run};
});
/** Independent whole-fixture content/directory snapshot: detects even empty lock/home directory creation. */
export const snapshot = Effect.fn('test.devSkills.snapshot')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const result: Record<string, string> = {};
  const pending = [''];
  while (pending.length) {
    const relative = pending.pop()!;
    const absolute = path.join(root, relative);
    const info = yield* fs.stat(absolute);
    if (info.type === 'Directory') {
      result[relative] = '<directory>';
      for (const child of yield* fs.readDirectory(absolute)) pending.push(relative ? `${relative}/${child}` : child);
    } else if (info.type === 'File') result[relative] = Buffer.from(yield* fs.readFile(absolute)).toString('base64');
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
});
/** Two-release updater fixtures use real enriched manifests and versioned metadata. */
export const devSkillsReleaseFixture = Effect.fn('test.devSkills.release')(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  version: string,
  staged = false,
) {
  const bundle = yield* loadDevSkillsBundleAt(f.source, version, false);
  const releaseRoot = f.path.join(f.runtime, 'versions', version);
  const bundleRoot = staged ? f.path.join(f.runtime, 'versions', '.threadnote-update-fixture', 'release') : releaseRoot;
  const executableName = f.system.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
  for (const [relative, content] of Object.entries(bundle.files)) {
    const file = f.path.join(bundleRoot, 'config', 'agent-skills', relative);
    yield* f.fs.makeDirectory(f.path.dirname(file), {recursive: true});
    yield* f.fs.writeFile(file, Buffer.from(content, 'base64'));
  }
  yield* f.fs.writeFileString(f.path.join(bundleRoot, 'config/dev-skills.json'), JSON.stringify(bundle.manifest));
  yield* f.fs.writeFileString(f.path.join(bundleRoot, 'release.json'), JSON.stringify({version}));
  yield* f.fs.writeFileString(f.path.join(bundleRoot, executableName), 'fixture executable metadata only');
  const capabilities = {
    schemaVersion: 2 as const,
    manifestSchemas: [1, 2],
    nativeFeatures: nativeRequirements,
    runtimeVersion: version,
    workflowProtocols: [1],
    stateSchemas: [1],
    enrollmentSchemas: [1, 2],
  };
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(SystemInfo, {...f.system, executablePath: f.path.join(releaseRoot, executableName)}),
      Effect.provideService(DevSkillsSource, {root: releaseRoot, runtimeVersion: version}),
    );
  const activate = f.fs.writeFileString(
    f.path.join(f.runtime, 'active-release.json'),
    JSON.stringify({version, releaseRoot}),
  );
  return {releaseRoot, releaseVersion: version, bundleRoot, bundle, capabilities, run, activate};
});
