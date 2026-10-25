import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path, PlatformError} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {TestError} from '@threadnote/testing/test-error';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import {executeCodeGraphVectorGeneration, type CodeGraphVectorPublication} from '../../src/embedding.js';
import {codeGraphLayout} from '../../src/layout.js';
import {CodeGraphStoreBusyError, type CodeGraphSnapshot, type CodeGraphSymbol} from '../../src/types.js';
import {isCodeGraphEmbeddingWorkerContention} from '../../src/vector/worker.js';

const manifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'bge-small-en-v1.5-q8')!;
const target: CodeGraphSnapshot = {
  id: 'publication-retry',
  commit: 'c'.repeat(40),
  repositoryId: 'a'.repeat(64),
  worktreeId: 'b'.repeat(64),
  dirty: false,
  extractorSet: 'test',
  state: 'ready',
  fileCount: 2,
  symbolCount: 2,
  edgeCount: 0,
};
const symbols: readonly CodeGraphSymbol[] = ['Alpha', 'Beta'].map((name, index) => ({
  id: `publication-${index}`,
  contentHash: String(index).repeat(64),
  documentation: `Coordinates ${name} publication.`,
  exported: true,
  kind: 'class',
  language: 'typescript',
  name,
  path: `src/${name}.ts`,
  qualifiedName: name,
  span: {column: 1, endColumn: 2, endLine: 1, line: 1},
}));
interface GenerationRow {
  readonly generation: string;
  readonly snapshot_id: string;
  readonly state: string;
  readonly count: number;
}
interface ProgressRow {
  readonly generation: string;
  readonly owner_token: string;
  readonly expires_at: number;
}
interface PayloadRow {
  readonly generation: string;
  readonly symbol_id: string;
  readonly fingerprint: string;
  readonly vector: string;
}
const inspect = (filename: string, attemptRetirement = false) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Database(filename, {strict: true})),
    db =>
      Effect.sync(() => {
        if (attemptRetirement)
          db.exec(
            'INSERT INTO vector_generation_retirements (generation, snapshot_id) SELECT generation, snapshot_id FROM vector_generations',
          );
        return {
          generations: db
            .query<GenerationRow, []>('SELECT generation, snapshot_id, state, count FROM vector_generations')
            .all(),
          progress: db
            .query<ProgressRow, []>('SELECT generation, owner_token, expires_at FROM vector_generation_progress')
            .all(),
          payload: db
            .query<PayloadRow, []>(
              'SELECT generation, symbol_id, fingerprint, hex(vector) AS vector FROM vectors ORDER BY symbol_id',
            )
            .all(),
          pointers: db.query<{worktree_id: string; generation: string}, []>('SELECT * FROM vector_pointers').all(),
          retirements: db.query<{generation: string}, []>('SELECT generation FROM vector_generation_retirements').all(),
        };
      }),
    db => Effect.sync(() => db.close()),
  );

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const catalog = yield* LocalModelCatalog;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-publication-retry-'});
  yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
  const layout = codeGraphLayout(path, home, target.repositoryId, target.worktreeId);
  const batches: number[] = [];
  const installation = {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: path.join(home, 'fake.gguf'),
    verified: true,
  };
  const unexpected = () => Effect.die(TestError.make({message: 'Unexpected model operation'}));
  const modelStore = LocalModelStore.of({
    install: unexpected,
    path: () => installation.path,
    remove: () => Effect.succeed(false),
    status: () => Effect.succeed(installation),
    verify: () => Effect.succeed(installation),
  });
  const runtime = LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fixture', buildType: 'prebuilt', cpuMathCores: 1}),
    embedMany: ({inputs}) =>
      Effect.sync(() => {
        batches.push(inputs.length);
        return inputs.map((_, axis) => Array.from({length: manifest.dimensions}, (__, n) => (axis === n ? 1 : 0)));
      }),
    generate: unexpected,
    rerank: unexpected,
  });
  const run = (
    ownerToken: string,
    publication: CodeGraphVectorPublication,
    retainPublicationClaimOnFailure?: (cause: unknown) => boolean,
  ) =>
    executeCodeGraphVectorGeneration({
      catalog,
      force: false,
      fs,
      layout,
      modelStore,
      path,
      runtime,
      snapshot: target,
      symbols,
      threadnoteHome: home,
      ownerToken,
      maximumSteps: 1,
      publication,
      ...(retainPublicationClaimOnFailure === undefined ? {} : {retainPublicationClaimOnFailure}),
    });
  return {run, batches, layout, filename: path.join(layout.vectorRoot, manifest.id, 'vectors-v2.sqlite')};
});

const attach: CodeGraphVectorPublication = {validate: Effect.void, attach: commit => commit};
const permissionDenied = () =>
  PlatformError.systemError({
    _tag: 'PermissionDenied',
    module: 'FileSystem',
    method: 'open',
    pathOrDescriptor: 'C:\\fixture\\publication.lock',
    cause: {code: 'EPERM', syscall: 'open'},
  });

effectIt.layer(Layer.mergeAll(citationPlatformLayer, LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS)))(it => {
  for (const scenario of [
    {name: 'Windows-shaped permission denial', error: permissionDenied, retain: isCodeGraphEmbeddingWorkerContention},
    {name: 'ordinary publication failure with the default release policy', error: () => new Error('Attachment failed')},
  ]) {
    it.effect(`releases a completed claim after ${scenario.name} so a fresh owner adopts without inference`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const failure = scenario.error();
        expect(isCodeGraphEmbeddingWorkerContention(failure)).toBe(false);
        let originalExpiry = 0;
        const rejected = yield* f
          .run(
            'first-owner',
            {
              validate: Effect.void,
              attach: () =>
                Effect.gen(function* () {
                  const completed = yield* inspect(f.filename);
                  expect(completed.generations).toMatchObject([{snapshot_id: target.id, state: 'ready', count: 2}]);
                  originalExpiry = completed.progress[0].expires_at;
                  return yield* Effect.fail(failure);
                }),
            },
            scenario.retain,
          )
          .pipe(Effect.result);
        expect(rejected).toMatchObject({_tag: 'Failure', failure});
        const before = yield* inspect(f.filename);
        expect(before.progress).toMatchObject([{owner_token: 'first-owner', expires_at: 0}]);
        expect(before.pointers).toEqual([]);
        expect(f.batches).toEqual([2]);
        expect(yield* Clock.currentTimeMillis).toBeLessThan(originalExpiry);
        expect(yield* f.run('fresh-owner', attach)).toMatchObject({ready: true, embedded: 0, reused: 2});
        const after = yield* inspect(f.filename);
        expect(after.generations).toEqual(before.generations);
        expect(after.payload).toEqual(before.payload);
        expect(after.progress).toEqual([]);
        expect(after.pointers).toEqual([
          {worktree_id: f.layout.worktreeId, generation: before.generations[0].generation},
        ]);
        expect(f.batches).toEqual([2]);
      }).pipe(TestClock.withLive),
    );
  }

  it.effect('retains a contention claim and retirement pin until the same owner retries attachment', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const failure = CodeGraphStoreBusyError.of('Publication is busy', {operation: 'publish vectors'});
      expect(isCodeGraphEmbeddingWorkerContention(failure)).toBe(true);
      const rejected = yield* f
        .run(
          'retained-owner',
          {validate: Effect.void, attach: () => Effect.fail(failure)},
          isCodeGraphEmbeddingWorkerContention,
        )
        .pipe(Effect.result);
      expect(rejected).toMatchObject({_tag: 'Failure', failure});
      const pinned = yield* inspect(f.filename, true);
      expect(pinned.generations).toMatchObject([{state: 'ready', count: 2}]);
      expect(pinned.progress).toMatchObject([{owner_token: 'retained-owner'}]);
      expect(pinned.progress[0].expires_at).toBeGreaterThan(yield* Clock.currentTimeMillis);
      expect(pinned.retirements).toEqual([]);
      expect(pinned.pointers).toEqual([]);
      expect(yield* f.run('other-owner', attach)).toMatchObject({ready: false, state: 'deferred'});
      const deferred = yield* inspect(f.filename, true);
      expect(deferred.progress).toEqual(pinned.progress);
      expect(deferred.retirements).toEqual([]);
      expect(deferred.payload).toEqual(pinned.payload);
      expect(yield* f.run('retained-owner', attach)).toMatchObject({ready: true, embedded: 0, reused: 2});
      const attached = yield* inspect(f.filename);
      expect(attached.generations).toEqual(pinned.generations);
      expect(attached.payload).toEqual(pinned.payload);
      expect(attached.progress).toEqual([]);
      expect(attached.pointers).toEqual([
        {worktree_id: f.layout.worktreeId, generation: pinned.generations[0].generation},
      ]);
      expect(f.batches).toEqual([2]);
    }).pipe(TestClock.withLive),
  );
});
