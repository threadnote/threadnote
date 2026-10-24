import {Effect, FileSystem, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runWorkflowAutomation} from '../../src/workflow_automation/index.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

export const provideNative = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(provideTestLayer(ApplicationLayer));

export const nativeFixture = Effect.fn('test.nativeAutomation.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const store = yield* ResourceStore;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-automation-'});
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(repo);
  yield* fs.writeFileString(path.join(repo, 'source.ts'), 'export const fixture = true;\n');
  yield* runCommandEffect('git', ['init', '--initial-branch=main', repo]);
  const config = {
    account: 'local',
    user: 'tester',
    agentId: 'test',
    agentContextHome: home,
    manifestPath: path.join(home, 'manifest.json'),
  };
  const scopedSystem = {...system, currentDirectory: () => repo, environment: () => ({})};
  const call = (input: unknown, current = config) =>
    runWorkflowAutomation(current, input).pipe(Effect.provideService(SystemInfo, scopedSystem));
  const base = (action: string, runId = 'native-run', generation = 'skill-generation-v1') => ({
    protocolVersion: 1,
    executorVersion: 1,
    action,
    runId,
    generation,
  });
  const init = (runId = 'native-run', generation = 'skill-generation-v1', project = 'fixture') =>
    call({...base('init', runId, generation), project, featureId: 'feature', profile: 'desktop'}).pipe(
      Effect.map(result => {
        if (!('bindingId' in result)) throw new Error('Expected initialized native run');
        return result;
      }),
    );
  const write = (changes: Record<string, unknown> = {}) => ({
    ...base('write'),
    operationId: 'write-1',
    artifactKey: 'plan-root',
    role: 'root',
    body: 'A Unicode plan — 日本語 and 🌊.\n',
    expectedRevision: null,
    storageKind: 'durable',
    ...changes,
  });
  const statePath = (runId = 'native-run') => path.join(home, 'workflow-automations', 'native-v1', `${runId}.json`);
  const journalPath = (bindingId: string) => path.join(home, 'workflow-memory', `${bindingId}.json`);
  const location = {account: config.account, home, user: config.user};
  return {base, call, config, fs, home, init, journalPath, location, path, repo, root, statePath, store, write};
});
