import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {workflowArtifactUri, workflowStateTopic} from '../../src/workflow_memory/naming.js';
import {assertWorkflowJournalIntegrity} from '../../src/workflow_memory/journal_validation.js';
import {
  CurrentWorkflowReadCache,
  immutableWorkflowImage,
  withWorkflowReadCache,
  type WorkflowReadCache,
} from '../../src/workflow_memory/read_cache.js';
import {inspectWorkflowJournal} from '../../src/workflow_memory/journal.js';
import {
  readNativeWorkflowState,
  withNativeWorkflowLock,
  writeNativeWorkflowState,
} from '../../src/workflow_automation/store.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {
  stableJson,
  type WorkflowArtifact,
  type WorkflowBinding,
  type WorkflowJournal,
} from '../../src/workflow_memory/protocol.js';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);

describe('native authoring request cache', () => {
  effectIt.effect('reuses only exact native and journal bytes within one request scope', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const journalFile = f.journalPath(initialized.bindingId);
      const nativeFile = f.statePath();
      const system = yield* SystemInfo;
      const fixtureSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
      const readJournal = () =>
        inspectWorkflowJournal(f.config, initialized.bindingId).pipe(Effect.provideService(SystemInfo, fixtureSystem));

      const observations = yield* withWorkflowReadCache(
        Effect.gen(function* () {
          const firstNative = yield* readNativeWorkflowState(f.config, 'native-run');
          if (!firstNative) throw new Error('Expected initialized native state');
          const secondNative = yield* readNativeWorkflowState(f.config, 'native-run');
          const firstJournal = yield* readJournal();
          const secondJournal = yield* readJournal();
          const beforeBytes = yield* f.fs.readFileString(nativeFile);

          // Case is not part of the canonical family slug, so this remains valid
          // while changing serialized bytes without changing their length.
          const changedState = {...firstNative.state, title: 'Feature'};
          yield* withNativeWorkflowLock(
            f.config,
            'native-run',
            false,
            writeNativeWorkflowState(f.config, changedState, firstNative.revision),
          ).pipe(Effect.provideService(CurrentWorkflowReadCache, undefined));
          const afterBytes = yield* f.fs.readFileString(nativeFile);
          const refreshedNative = yield* readNativeWorkflowState(f.config, 'native-run');
          if (!refreshedNative) throw new Error('Changed native state disappeared');

          return {
            firstNative: firstNative.state,
            secondNative: secondNative?.state,
            firstJournal: firstJournal.state,
            secondJournal: secondJournal.state,
            beforeBytes,
            afterBytes,
            refreshedNative: refreshedNative.state,
          };
        }),
      );

      expect(observations.secondNative).toBe(observations.firstNative);
      expect(observations.secondJournal).toBe(observations.firstJournal);
      expect(Object.isFrozen(observations.firstNative)).toBe(true);
      expect(Object.isFrozen(observations.firstNative.operations)).toBe(true);
      expect(observations.beforeBytes).not.toBe(observations.afterBytes);
      expect(new TextEncoder().encode(observations.beforeBytes).byteLength).toBe(
        new TextEncoder().encode(observations.afterBytes).byteLength,
      );
      expect(observations.refreshedNative).not.toBe(observations.firstNative);
      expect(observations.refreshedNative.title).toBe('Feature');

      const nextScope = yield* withWorkflowReadCache(readNativeWorkflowState(f.config, 'native-run'));
      expect(nextScope?.state).not.toBe(observations.refreshedNative);
      const journalAfterScope = yield* f.fs.readFileString(journalFile);
      expect(journalAfterScope).toBeTruthy();
    }).pipe(run),
  );

  effectIt.effect('does not let cached success hide changed native, journal, or manifest state', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const nativeFile = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'native-run.json',
      );
      const journalFile = f.journalPath(initialized.bindingId);
      const originalState = yield* f.fs.readFileString(nativeFile);
      const originalJournal = yield* f.fs.readFileString(journalFile);
      const journal = JSON.parse(originalJournal) as {manifestUri: string};
      const originalManifest = yield* f.store.read(f.location, journal.manifestUri);

      yield* withWorkflowReadCache(
        Effect.gen(function* () {
          const initial = yield* f.call(f.base('inspect'));
          expect(initial).toMatchObject({status: 'ok', runId: 'native-run'});

          const corruptState = '{"format":"threadnote-native-workflow",';
          yield* f.fs.writeFileString(nativeFile, corruptState);
          const nativeFailure = yield* f.call(f.base('inspect')).pipe(Effect.result);
          expect(Result.isFailure(nativeFailure)).toBe(true);
          if (Result.isFailure(nativeFailure)) expect(nativeFailure.failure).toMatchObject({code: 'invalid-state'});
          expect(yield* f.fs.readFileString(nativeFile)).toBe(corruptState);
          yield* f.fs.writeFileString(nativeFile, originalState);
          expect(yield* f.call(f.base('inspect'))).toMatchObject({status: 'ok', runId: 'native-run'});

          const corruptJournal = '{"protocolVersion":1,';
          yield* f.fs.writeFileString(journalFile, corruptJournal);
          const journalFailure = yield* f.call(f.base('inspect')).pipe(Effect.result);
          expect(Result.isFailure(journalFailure)).toBe(true);
          if (Result.isFailure(journalFailure)) expect(journalFailure.failure).toMatchObject({code: 'invalid-journal'});
          expect(yield* f.fs.readFileString(journalFile)).toBe(corruptJournal);
          yield* f.fs.writeFileString(journalFile, originalJournal);
          expect(yield* f.call(f.base('inspect'))).toMatchObject({status: 'ok', runId: 'native-run'});

          const corruptManifest = originalManifest.replace('workflow-feature', 'workflow-fEature');
          expect(corruptManifest).not.toBe(originalManifest);
          yield* f.store.write(f.location, journal.manifestUri, corruptManifest, {mode: 'replace'});
          const manifestFailure = yield* f.call(f.base('inspect')).pipe(Effect.result);
          expect(Result.isFailure(manifestFailure)).toBe(true);
          if (Result.isFailure(manifestFailure))
            expect(manifestFailure.failure).toMatchObject({code: 'task-state-lost'});
          expect(yield* f.store.read(f.location, journal.manifestUri)).toBe(corruptManifest);
          yield* f.store.write(f.location, journal.manifestUri, originalManifest, {mode: 'replace'});
          expect(yield* f.call(f.base('inspect'))).toMatchObject({status: 'ok', runId: 'native-run'});
        }),
      );

      expect(yield* f.fs.readFileString(nativeFile)).toBe(originalState);
      expect(yield* f.fs.readFileString(journalFile)).toBe(originalJournal);
      expect(yield* f.store.read(f.location, journal.manifestUri)).toBe(originalManifest);
    }).pipe(run),
  );

  effectIt.effect('observes missing and linked state/journal files despite a warm cache', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const nativeFile = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'native-run.json',
      );
      const journalFile = f.journalPath(initialized.bindingId);
      const system = yield* SystemInfo;
      const fixtureSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
      const readJournal = () =>
        inspectWorkflowJournal(f.config, initialized.bindingId).pipe(Effect.provideService(SystemInfo, fixtureSystem));
      const nativeBytes = yield* f.fs.readFileString(nativeFile);
      const journalBytes = yield* f.fs.readFileString(journalFile);
      const external = f.path.join(f.root, 'external-state.json');
      yield* f.fs.writeFileString(external, nativeBytes);

      yield* withWorkflowReadCache(
        Effect.gen(function* () {
          expect(yield* readNativeWorkflowState(f.config, 'native-run')).toBeTruthy();
          expect((yield* readJournal()).state.binding.bindingId).toBe(initialized.bindingId);

          yield* f.fs.remove(nativeFile);
          expect(yield* readNativeWorkflowState(f.config, 'native-run')).toBeUndefined();
          const missingRun = yield* f.call(f.base('inspect')).pipe(Effect.result);
          expect(Result.isFailure(missingRun)).toBe(true);
          if (Result.isFailure(missingRun)) expect(missingRun.failure).toMatchObject({code: 'run-not-found'});
          yield* f.fs.writeFileString(nativeFile, nativeBytes);

          yield* f.fs.remove(journalFile);
          const missingJournal = yield* readJournal().pipe(Effect.result);
          expect(Result.isFailure(missingJournal)).toBe(true);
          if (Result.isFailure(missingJournal)) expect(missingJournal.failure).toMatchObject({code: 'task-state-lost'});
          yield* f.fs.writeFileString(journalFile, journalBytes);

          const linkedFs = FileSystem.FileSystem.of({
            ...f.fs,
            readLink: file =>
              file === nativeFile || file === journalFile ? Effect.succeed(external) : f.fs.readLink(file),
          });
          const linkedRun = yield* readNativeWorkflowState(f.config, 'native-run').pipe(
            Effect.provideService(FileSystem.FileSystem, linkedFs),
            Effect.result,
          );
          expect(Result.isFailure(linkedRun)).toBe(true);
          if (Result.isFailure(linkedRun)) expect(linkedRun.failure).toMatchObject({code: 'unsafe-state'});

          const linkedJournal = yield* readJournal().pipe(
            Effect.provideService(FileSystem.FileSystem, linkedFs),
            Effect.result,
          );
          expect(Result.isFailure(linkedJournal)).toBe(true);
          if (Result.isFailure(linkedJournal)) expect(linkedJournal.failure).toMatchObject({code: 'unsafe-journal'});
        }),
      );
      expect(yield* f.fs.readFileString(external)).toBe(nativeBytes);
    }).pipe(run),
  );

  effectIt.effect('updates cached postimages after a real native write and verifies exact readback', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const journalFile = f.journalPath(initialized.bindingId);
      const nativeFile = f.statePath();
      const system = yield* SystemInfo;
      const fixtureSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
      const readJournal = () =>
        inspectWorkflowJournal(f.config, initialized.bindingId).pipe(Effect.provideService(SystemInfo, fixtureSystem));
      const nativeBefore = yield* f.fs.readFileString(nativeFile);
      const journalBefore = yield* f.fs.readFileString(journalFile);

      yield* withWorkflowReadCache(
        Effect.gen(function* () {
          const initialState = yield* readNativeWorkflowState(f.config, 'native-run');
          const initialJournal = yield* readJournal();
          expect(initialState?.state.operations).toHaveLength(0);
          expect(Object.keys(initialJournal.state.operations)).toHaveLength(0);

          const write = f.write();
          const result = yield* f.call(write).pipe(Effect.result);
          expect(Result.isSuccess(result)).toBe(true);
          if (Result.isFailure(result)) return;
          if (!('artifact' in result.success)) throw new Error('Expected a verified artifact');
          const artifact = result.success.artifact as {uri: string; body?: string};

          const writtenState = yield* readNativeWorkflowState(f.config, 'native-run');
          const writtenJournal = yield* readJournal();
          expect(writtenState?.state.operations.map(operation => operation.intent.operationId)).toContain('write-1');
          expect(Object.keys(writtenJournal.state.operations)).toContain('write-1');
          const readback = yield* f.call({...f.base('read'), uri: artifact.uri});
          expect(readback).toMatchObject({status: 'ok', artifact: {uri: artifact.uri, body: write.body}});

          expect(yield* f.fs.readFileString(nativeFile)).not.toBe(nativeBefore);
          expect(yield* f.fs.readFileString(journalFile)).not.toBe(journalBefore);
        }),
      );
    }).pipe(run),
  );
});

it('deep-freezes descendants even when the image root was already shallow-frozen', () => {
  const image = Object.freeze({nested: {leaf: {value: 'stable'}}, rows: [{value: 1}]});
  expect(immutableWorkflowImage(image)).toBe(image);
  expect(Object.isFrozen(image)).toBe(true);
  expect(Object.isFrozen(image.nested)).toBe(true);
  expect(Object.isFrozen(image.nested.leaf)).toBe(true);
  expect(Object.isFrozen(image.rows)).toBe(true);
  expect(Object.isFrozen(image.rows[0])).toBe(true);
});

const manifestCacheTimestamp = '2026-10-20T12:00:00.000Z';
const manifestCacheIdentity = {
  workflowRunId: 'run-1',
  profile: 'desktop' as const,
  project: 'fixture',
  featureId: 'feature',
  generation: 'v1',
  home: '/fixture/home',
  repo: '/fixture/repo',
  account: 'local',
  user: 'tester',
  agentId: 'test',
  sharedRoots: [],
  artifactLifetime: 'local-home' as const,
};
const manifestCacheBinding: WorkflowBinding = {
  ...manifestCacheIdentity,
  bindingId: sha256HexSync(stableJson(manifestCacheIdentity)),
};

function manifestCacheUri(value: WorkflowBinding): string {
  return `threadnote://user/${value.user}/memories/handoffs/active/${value.project}/${workflowStateTopic(value)}.md`;
}

function manifestCacheDocument(
  value: WorkflowBinding,
  artifacts: WorkflowJournal['artifacts'],
  stamp = manifestCacheTimestamp,
): string {
  return formatMemoryDocument(
    'MEMORY',
    {
      kind: 'handoff',
      status: 'active',
      project: value.project,
      topic: workflowStateTopic(value),
      memoryId: `tn_${value.bindingId.slice(0, 20)}`,
      timestamp: stamp,
      sourceAgentClient: 'threadnote',
      sourceSessionId: value.workflowRunId,
    },
    stableJson({protocolVersion: 1, binding: value, artifacts}),
  );
}

const manifestCacheArtifactKey = 'draft';
const manifestCacheArtifact: WorkflowArtifact = {
  artifactKey: manifestCacheArtifactKey,
  sourceRunId: 'writer',
  role: 'root',
  canonicalUri: workflowArtifactUri(manifestCacheBinding, {
    artifactKey: manifestCacheArtifactKey,
    storageKind: 'handoff',
  }),
  memoryId: `tn_${sha256HexSync(`${manifestCacheBinding.bindingId}\nwriter\n${manifestCacheArtifactKey}`).slice(0, 20)}`,
  revision: 'a'.repeat(64),
  bodySha256: 'b'.repeat(64),
  storageKind: 'handoff',
  state: 'active',
};
const manifestCacheArtifacts = {[manifestCacheArtifact.canonicalUri]: manifestCacheArtifact};

function manifestCacheState(
  value: WorkflowBinding = manifestCacheBinding,
  owned: WorkflowJournal['artifacts'] = manifestCacheArtifacts,
  content = manifestCacheDocument(value, owned),
  uri = manifestCacheUri(value),
): WorkflowJournal {
  return {
    protocolVersion: 1,
    binding: value,
    artifacts: owned,
    operations: {},
    manifestUri: uri,
    manifestContent: content,
    manifestCommitted: true,
  };
}

const withManifestCache = <A>(body: (cache: WorkflowReadCache) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    const cache = yield* CurrentWorkflowReadCache;
    if (!cache) throw new Error('Expected a request-local workflow read cache.');
    return yield* body(cache);
  }).pipe(withWorkflowReadCache);

describe('native authoring manifest cache', () => {
  effectIt.effect('reuses only exact manifest keys while retaining state and source authority checks', () =>
    withManifestCache(cache =>
      Effect.gen(function* () {
        const original = manifestCacheState();
        yield* Effect.sync(() => assertWorkflowJournalIntegrity(original, original.manifestContent, [], cache));
        expect(cache.manifests).toHaveLength(1);
        const firstEntry = cache.manifests[0];
        expect(firstEntry.binding).toBe(original.binding);
        expect(firstEntry.manifestUri).toBe(original.manifestUri);
        expect(firstEntry.content).toBe(original.manifestContent);
        expect(Object.isFrozen(firstEntry.binding)).toBe(true);
        expect(Object.isFrozen(firstEntry.artifacts)).toBe(true);
        expect(Object.isFrozen(firstEntry.artifacts[manifestCacheArtifact.canonicalUri])).toBe(true);
        expect(Reflect.set(firstEntry.artifacts[manifestCacheArtifact.canonicalUri], 'role', 'tampered')).toBe(false);

        yield* Effect.sync(() => assertWorkflowJournalIntegrity(original, original.manifestContent, [], cache));
        expect(cache.manifests[0]).toBe(firstEntry);

        const editedMap = {...original, artifacts: {}};
        expect(() => assertWorkflowJournalIntegrity(editedMap, editedMap.manifestContent, [], cache)).toThrow();
        expect(cache.manifests[0]).toBe(firstEntry);

        const changedUri = {...original, manifestUri: `${original.manifestUri}.other`};
        expect(() => assertWorkflowJournalIntegrity(changedUri, changedUri.manifestContent, [], cache)).toThrow();
        expect(cache.manifests[0]).toBe(firstEntry);

        const changedBinding = {...manifestCacheBinding, project: 'other'};
        const rebound = {...original, binding: changedBinding};
        expect(() => assertWorkflowJournalIntegrity(rebound, rebound.manifestContent, [], cache)).toThrow();
        expect(cache.manifests[0]).toBe(firstEntry);

        const newContent = manifestCacheDocument(
          manifestCacheBinding,
          manifestCacheArtifacts,
          '2026-10-21T12:00:00.000Z',
        );
        const changedManifest = manifestCacheState(manifestCacheBinding, manifestCacheArtifacts, newContent);
        yield* Effect.sync(() => assertWorkflowJournalIntegrity(changedManifest, newContent, [], cache));
        expect(cache.manifests[0].content).toBe(newContent);
        expect(cache.manifests).toHaveLength(2);

        const equalBindingClone = {...manifestCacheBinding};
        const sameBytesDifferentBinding = manifestCacheState(
          equalBindingClone,
          manifestCacheArtifacts,
          original.manifestContent,
        );
        yield* Effect.sync(() =>
          assertWorkflowJournalIntegrity(sameBytesDifferentBinding, original.manifestContent, [], cache),
        );
        expect(cache.manifests[0].binding).toBe(equalBindingClone);
        expect(cache.manifests[0].binding).not.toBe(original.binding);
        expect(cache.manifests).toHaveLength(2);

        const thirdContent = manifestCacheDocument(
          manifestCacheBinding,
          manifestCacheArtifacts,
          '2026-10-22T12:00:00.000Z',
        );
        const thirdManifest = manifestCacheState(manifestCacheBinding, manifestCacheArtifacts, thirdContent);
        yield* Effect.sync(() => assertWorkflowJournalIntegrity(thirdManifest, thirdContent, [], cache));
        expect(cache.manifests).toHaveLength(2);
        expect(cache.manifests[0].content).toBe(thirdContent);
      }),
    ),
  );

  effectIt.effect('keeps manifest entries isolated between workflow requests', () =>
    Effect.gen(function* () {
      const first = yield* withManifestCache(cache =>
        Effect.sync(() => {
          const current = manifestCacheState();
          assertWorkflowJournalIntegrity(current, current.manifestContent, [], cache);
          return cache;
        }),
      );
      const second = yield* withManifestCache(cache =>
        Effect.sync(() => {
          const current = manifestCacheState();
          assertWorkflowJournalIntegrity(current, current.manifestContent, [], cache);
          return cache;
        }),
      );
      expect(first).not.toBe(second);
      expect(first.manifests).toHaveLength(1);
      expect(second.manifests).toHaveLength(1);
      expect(first.manifests[0]).not.toBe(second.manifests[0]);
    }),
  );

  effectIt.effect('caches the desired and previous manifest images under their exact content keys', () =>
    withManifestCache(cache =>
      Effect.gen(function* () {
        const previousContent = manifestCacheDocument(manifestCacheBinding, {}, manifestCacheTimestamp);
        const desiredContent = manifestCacheDocument(manifestCacheBinding, {}, '2026-10-21T12:00:00.000Z');
        const pending: WorkflowJournal = {
          protocolVersion: 1,
          binding: manifestCacheBinding,
          artifacts: {},
          operations: {},
          manifestUri: manifestCacheUri(manifestCacheBinding),
          manifestContent: desiredContent,
          previousManifestContent: previousContent,
          manifestCommitted: false,
        };
        yield* Effect.sync(() => assertWorkflowJournalIntegrity(pending, previousContent, [], cache));
        expect(cache.manifests).toHaveLength(2);
        expect(cache.manifests.map(entry => entry.content)).toContain(desiredContent);
        expect(cache.manifests.map(entry => entry.content)).toContain(previousContent);
        const entries = [...cache.manifests];
        yield* Effect.sync(() => assertWorkflowJournalIntegrity(pending, previousContent, [], cache));
        expect(cache.manifests).toEqual(entries);
      }),
    ),
  );
});
