import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphStoreBusyError} from '@threadnote/graph/types';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {runCommandEffect} from '@threadnote/platform/command';
import {ResourceStore} from '@threadnote/store/resource-store';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);
const errorShape = {failure: {code: 'evidence-busy', retryable: true}};

const readyFixture = Effect.fn('test.nativeAutomationEvidence.fixture')(function* () {
  const f = yield* nativeFixture();
  const config = {
    ...f.config,
    manifestPath: f.path.join(f.home, 'manifest.yaml'),
    manifestSource: 'bundled-example' as const,
  };
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', f.repo, ...args]);
  yield* git(['config', 'user.email', 'test@example.invalid']);
  yield* git(['config', 'user.name', 'Native Evidence Test']);
  yield* git(['remote', 'add', 'origin', 'https://example.invalid/native-evidence.git']);
  yield* git(['add', '.']);
  yield* git(['commit', '-m', 'fixture']);
  const initialized = yield* f.call(
    {...f.base('init'), project: 'fixture', featureId: 'feature', profile: 'desktop'},
    config,
  );
  if (!('bindingId' in initialized)) throw new Error('Expected initialized native run');
  const rootRequest = f.write({operationId: 'old-root', artifactKey: 'old-root', body: 'Existing project root.\n'});
  const rootResult = yield* f.call(rootRequest, config);
  const rootUri = (rootResult as {artifact: {uri: string}}).artifact.uri;
  const rootBytes = yield* f.store.read(f.location, rootUri);
  yield* (yield* CodeGraphIndexer).index({threadnoteHome: f.home, cwd: f.repo, ensureVectors: false});
  return {f, config, initialized, rootUri, rootBytes};
});

const citationWrite = (f: Effect.Success<ReturnType<typeof readyFixture>>, operationId: string) =>
  f.f.write({
    operationId,
    artifactKey: operationId,
    body: `Evidence-backed draft ${operationId}.\n`,
    codeRefs: ['source.ts'],
  });

const checkedCitations = (content: string) => {
  const record = parseMemoryDocument('threadnote://user/tester/memories/durable/projects/fixture/x.md', content);
  expect(record?.metadata.codeCitations).toHaveLength(1);
  expect(record?.metadata.codeCitations?.[0]?.path).toBe('source.ts');
  return record?.metadata.codeCitations?.[0];
};

describe('native workflow graph evidence contention', () => {
  effectIt.effect('bounds busy initial preflight without preparing a new operation or changing existing bytes', () =>
    Effect.gen(function* () {
      const f = yield* readyFixture();
      const statePath = f.f.statePath();
      const journalPath = f.f.journalPath(f.initialized.bindingId);
      const beforeState = yield* f.f.fs.readFileString(statePath);
      const beforeJournal = yield* f.f.fs.readFileString(journalPath);
      const beforeRoot = yield* f.f.store.read(f.f.location, f.rootUri);
      const graph = yield* CodeGraphStore;
      let attempts = 0;
      const busyGraph = CodeGraphStore.of({
        ...graph,
        acquireSnapshotLease: () => {
          attempts++;
          return Effect.fail(CodeGraphStoreBusyError.of('synthetic snapshot lease contention'));
        },
      });
      const denied = yield* failure(
        f.f.call(citationWrite(f, 'busy-preflight'), f.config).pipe(Effect.provideService(CodeGraphStore, busyGraph)),
      );
      expect(denied).toMatchObject(errorShape);
      expect(attempts).toBe(2);
      expect(yield* f.f.fs.readFileString(statePath)).toBe(beforeState);
      expect(yield* f.f.fs.readFileString(journalPath)).toBe(beforeJournal);
      expect(yield* f.f.store.read(f.f.location, f.rootUri)).toBe(beforeRoot);
      expect(
        JSON.parse(beforeState).operations.map(
          (operation: {intent: {operationId: string}}) => operation.intent.operationId,
        ),
      ).toEqual(['old-root']);
    }).pipe(run),
  );

  effectIt.effect(
    'keeps one prepared intent across bounded preparation contention and recovers it with citations',
    () =>
      Effect.gen(function* () {
        const f = yield* readyFixture();
        const graph = yield* CodeGraphStore;
        let attempts = 0;
        const busyAfterInitialPreflight = CodeGraphStore.of({
          ...graph,
          acquireSnapshotLease: (...args: Parameters<typeof graph.acquireSnapshotLease>) => {
            attempts++;
            return attempts === 1
              ? graph.acquireSnapshotLease(...args)
              : Effect.fail(CodeGraphStoreBusyError.of('synthetic preparation contention'));
          },
        });
        const request = citationWrite(f, 'resume-citations');
        const denied = yield* failure(
          f.f.call(request, f.config).pipe(Effect.provideService(CodeGraphStore, busyAfterInitialPreflight)),
        );
        expect(denied).toMatchObject(errorShape);
        expect(attempts).toBe(3);
        const stateBeforeRecovery = JSON.parse(yield* f.f.fs.readFileString(f.f.statePath()));
        const prepared = stateBeforeRecovery.operations.filter(
          (operation: {intent: {operationId: string}}) => operation.intent.operationId === 'resume-citations',
        );
        expect(prepared).toHaveLength(1);
        expect(prepared[0]).toMatchObject({
          status: 'prepared',
          intent: {operationId: 'resume-citations', codeRefs: ['source.ts']},
        });
        expect(yield* f.f.store.read(f.f.location, f.rootUri)).toBe(f.rootBytes);
        const recovered = (yield* f.f.call({...f.f.base('recover'), operationId: 'resume-citations'}, f.config)) as {
          artifact: {uri: string; body: string; revision: string};
        };
        expect(recovered.artifact.body).toBe(request.body);
        const content = yield* f.f.store.read(f.f.location, recovered.artifact.uri);
        const citation = checkedCitations(content)!;
        expect(citation.fileContentHash.value).toMatch(/^[a-f0-9]{64}$/u);
        const after = JSON.parse(yield* f.f.fs.readFileString(f.f.statePath()));
        expect(after.bindingId).toBe(f.initialized.bindingId);
        expect(
          after.operations.filter(
            (operation: {intent: {operationId: string}}) => operation.intent.operationId === 'resume-citations',
          ),
        ).toHaveLength(1);
        expect(
          after.operations.find(
            (operation: {intent: {operationId: string}}) => operation.intent.operationId === 'resume-citations',
          ).status,
        ).toBe('verified');
        expect(yield* f.f.store.read(f.f.location, f.rootUri)).toBe(f.rootBytes);
      }).pipe(run),
  );

  effectIt.effect('retains the same prepared receipt when graph evidence is busy during post-write readback', () =>
    Effect.gen(function* () {
      const f = yield* readyFixture();
      const request = citationWrite(f, 'readback-citations');
      const bindingId = f.initialized.bindingId;
      const targetUri = `threadnote://user/tester/memories/durable/projects/fixture/workflow-${bindingId}-readback-citations.md`;
      const store = yield* ResourceStore;
      let wrote = false;
      let busyReads = 0;
      const contendedStore = {
        ...store,
        writeChecked: (...args: Parameters<typeof store.writeChecked>) =>
          store.writeChecked(...args).pipe(
            Effect.tap(result =>
              Effect.sync(() => {
                if (result.uri === targetUri) wrote = true;
              }),
            ),
          ),
        read: (location: Parameters<typeof store.read>[0], uri: string, options?: Parameters<typeof store.read>[2]) => {
          if (wrote && uri === targetUri && busyReads < 2) {
            busyReads++;
            return Effect.fail(CodeGraphStoreBusyError.of('synthetic post-write graph contention') as never);
          }
          return store.read(location, uri, options);
        },
      };
      const denied = yield* failure(
        f.f.call(request, f.config).pipe(Effect.provideService(ResourceStore, contendedStore)),
      );
      expect(denied).toMatchObject(errorShape);
      expect(wrote).toBe(true);
      expect(busyReads).toBe(2);
      const pending = JSON.parse(yield* f.f.fs.readFileString(f.f.statePath())).operations.filter(
        (operation: {intent: {operationId: string}}) => operation.intent.operationId === 'readback-citations',
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({status: 'prepared', intent: {operationId: 'readback-citations'}});
      expect(yield* f.f.store.read(f.f.location, f.rootUri)).toBe(f.rootBytes);
      const recovered = (yield* f.f.call({...f.f.base('recover'), operationId: 'readback-citations'}, f.config)) as {
        artifact: {uri: string; body: string; revision: string};
      };
      expect(recovered.artifact.body).toBe(request.body);
      const content = yield* f.f.store.read(f.f.location, recovered.artifact.uri);
      checkedCitations(content);
      const finalState = JSON.parse(yield* f.f.fs.readFileString(f.f.statePath()));
      expect(
        finalState.operations.filter(
          (operation: {intent: {operationId: string}}) => operation.intent.operationId === 'readback-citations',
        ),
      ).toHaveLength(1);
      expect(
        finalState.operations.find(
          (operation: {intent: {operationId: string}}) => operation.intent.operationId === 'readback-citations',
        ).status,
      ).toBe('verified');
      expect(yield* f.f.store.read(f.f.location, f.rootUri)).toBe(f.rootBytes);
    }).pipe(run),
  );
});
