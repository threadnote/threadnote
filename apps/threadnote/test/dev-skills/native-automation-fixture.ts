import {Effect, FileSystem, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runWorkflowAutomation} from '../../src/workflow_automation/index.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  classifyNativeProgress,
  CurrentNativeProgress,
  makeNativeProgressDiagnostics,
  nativeProgressMethod,
  nativeProgressFacades,
  observeNativeBody,
  reportNativeFailure,
} from './native-authoring-progress-diagnostics.js';

export const provideNative = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const observer = makeNativeProgressDiagnostics(yield* Effect.tracer);
    const inner = observeNativeBody(program, observer).pipe(Effect.provideService(CurrentNativeProgress, observer));
    return yield* reportNativeFailure(
      inner.pipe(provideTestLayer(ApplicationLayer), Effect.withTracer(observer.tracer)),
      observer,
    );
  });

export const nativeFixture = Effect.fn('test.nativeAutomation.fixture')(function* (
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  const observer = yield* CurrentNativeProgress;
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
  const scopedSystem = {...system, currentDirectory: () => repo, environment: () => environment};
  const originalCall = (input: unknown, current = config) =>
    runWorkflowAutomation(current, input).pipe(Effect.provideService(SystemInfo, scopedSystem));
  const call = observer
    ? nativeProgressMethod(undefined, originalCall, classifyNativeProgress, observer)
    : originalCall;
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
  const returned = nativeProgressFacades(store, fs, statePath(), observer);
  return {
    base,
    call,
    config,
    fs: returned.fs,
    home,
    init,
    journalPath,
    location,
    path,
    repo,
    root,
    statePath,
    store: returned.store,
    write,
  };
});
