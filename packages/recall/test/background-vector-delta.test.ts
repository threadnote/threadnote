import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Array as EffectArray, Clock, Effect, FileSystem, Layer, Option, Path} from 'effect';
import * as EffectString from 'effect/String';
import {describe, expect, vi} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  ExternalSourcePolicy,
  externalDocumentManifestUri,
  externalResourceUri,
  renderExternalResource,
  serializeExternalDocumentManifest,
} from '@threadnote/store/external-resource';
import {recallResourceInvalidationLayer} from '../src/resource-invalidation.js';
import {loadRecallIndexData, recallIndexStatus} from '../src/index.js';
import {RecallDiagnosticsPort, type RecallDiagnostic} from '../src/diagnostics.js';
import * as PreparationSource from '../src/index/vector-preparation-source.js';
import {planRecallVectorDelta} from '../src/background/vector-delta.js';
import {stepRecallVectorPreparation} from '../src/background/vector-step.js';
import {ensureVectorIndex, recallVectorStorage, vectorIndexDatabaseFilename} from '../src/vector-index.js';
import {recallVectorPreparationIdentity, recallVectorPreparationJobId} from '../src/vector/preparation-identity.js';
import {vectorIndexGenerationReadiness} from '../src/vector/semantic-read.js';

const manifest = {
  ...Option.getOrThrow(EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.role === 'embedding')),
  dimensions: 2,
  promptPrefixes: {document: 'document: ', query: 'query: '},
};
const fingerprint = EffectString.repeat(64)('a');
const services = ResourceStore.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      BunServices.layer,
      cryptoLayer,
      recallResourceInvalidationLayer,
      LocalModelCatalog.layer([manifest]),
      Layer.succeed(ExternalSourcePolicy, {
        current: () => Effect.succeed({enabled: true, configFingerprint: fingerprint, project: 'threadnote'}),
      }),
      SystemInfo.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
            Layer.succeed(ChildEnvironmentPolicy, {
              preserveIntendedChild: environment => environment,
              sanitizeExternal: environment => environment,
            }),
          ),
        ),
      ),
    ),
  ),
);
const memoryUri = (name: string) => `threadnote://user/test/memories/durable/projects/threadnote/${name}.md`;
const external = {
  version: 1 as const,
  sourceId: 'source',
  documentId: 'doc',
  pageId: 'page',
  chunkId: 'chunk',
  project: 'threadnote',
  title: 'External',
  rendererVersion: '1',
  scrubberVersion: '1',
  coverage: 'canvas-plain-text' as const,
};
const externalUri = externalResourceUri(external);
const sections = (label: string, count: number) =>
  EffectArray.join(
    EffectArray.makeBy(count, n => `# ${label} section ${n}\n\nDistinct ${label} payload ${n}`),
    '\n\n',
  );

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* ResourceStore;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'recall-vector-delta-'}));
  const config = {account: 'local', user: 'test', agentContextHome: home};
  const location = {account: 'local', user: 'test', home};
  yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
  const filename = path.join(home, 'indexes/vectors', manifest.id, vectorIndexDatabaseFilename());
  const memory = (
    name: string,
    body: string,
    options: {readonly memoryId?: string; readonly status?: 'active' | 'archived'} = {},
  ) =>
    store.mutateChecked(
      location,
      [
        {
          type: 'write',
          uri: memoryUri(name),
          content: formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              memoryId: options.memoryId ?? `tn_${name}`,
              authority: 'agent_generated',
              trust: 'inferred',
              status: options.status ?? 'active',
              project: 'threadnote',
              topic: options.memoryId ?? name,
              sourceAgentClient: 'test',
              timestamp: '2026-11-01T00:00:00Z',
            },
            body,
          ),
          options: {mode: 'upsert'},
        },
      ],
      Effect.void,
    );
  const remove = (name: string) => store.mutateChecked(location, [{type: 'remove', uri: memoryUri(name)}], Effect.void);
  const writeExternal = (body: string) =>
    Effect.gen(function* () {
      const content = renderExternalResource(external, body);
      yield* store.mutateChecked(
        location,
        [
          {type: 'write', uri: externalUri, content, options: {mode: 'upsert'}},
          {
            type: 'write',
            uri: externalDocumentManifestUri('source', 'doc'),
            content: serializeExternalDocumentManifest({
              version: 1,
              sourceId: 'source',
              documentId: 'doc',
              configFingerprint: fingerprint,
              status: 'active',
              fetchedAt: yield* Clock.currentTimeMillis,
              maxStaleMilliseconds: 60_000,
              chunks: {[externalUri]: yield* store.fingerprint(content)},
            }),
            options: {mode: 'upsert'},
          },
        ],
        Effect.void,
      );
      return content;
    });
  // N = 7: one memory above one copy page of chunks, an approved shared memory, a dedup group and an
  // external source.
  const seed = Effect.gen(function* () {
    yield* memory('big', sections('big', 125));
    const shared = path.join(home, 'data/local/user/test/memories/shared/platform/durable/projects/threadnote/team.md');
    yield* fs.makeDirectory(path.dirname(shared), {recursive: true});
    yield* fs.writeFileString(
      shared,
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          memoryId: 'tn_team',
          status: 'active',
          project: 'threadnote',
          topic: 'team',
          sourceAgentClient: 'test',
          timestamp: '2026-11-01T00:00:00Z',
        },
        'Reviewed shared body.',
      ),
    );
    yield* memory('m1', sections('m1', 3));
    yield* memory('m2', 'Third standalone body.');
    yield* memory('group-a', 'Shared group body.', {memoryId: 'tn_group'});
    yield* memory('group-b', 'Shared group body.', {memoryId: 'tn_group'});
    return yield* writeExternal('External body.');
  });
  const refresh = loadRecallIndexData(config, {includeInactive: false, memoryIds: []}).pipe(
    Effect.map(index => index.generation),
  );
  let inputs = 0;
  let beforeInference: Effect.Effect<void, unknown> = Effect.void;
  const reads: string[] = [];
  const diagnostics: RecallDiagnostic[] = [];
  const runtime = LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 1}),
    embedMany: request =>
      beforeInference.pipe(
        Effect.andThen(
          Effect.sync(() => {
            inputs += request.inputs.length;
            return EffectArray.map(request.inputs, embeddingForInput);
          }),
        ),
        Effect.orDie,
      ),
    generate: () => Effect.die('unexpected generation'),
    rerank: () => Effect.die('unexpected rerank'),
  });
  const installed = {
    bytes: 1,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: '/fake/model.gguf',
    verified: true,
  };
  const models = LocalModelStore.of({
    install: () => Effect.die('unexpected install'),
    path: () => installed.path,
    remove: () => Effect.succeed(false),
    status: () => Effect.succeed(installed),
    verify: () => Effect.succeed(installed),
  });
  // Count body reads through the source port.
  const open = PreparationSource.openRecallVectorPreparationSource;
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      vi.spyOn(PreparationSource, 'openRecallVectorPreparationSource').mockImplementation(scope =>
        open(scope).pipe(
          Effect.map(source => ({
            ...source,
            hydrate: (metadata: Parameters<typeof source.hydrate>[0], options?: Parameters<typeof source.hydrate>[1]) =>
              Effect.sync(() => reads.push(...EffectArray.map(metadata, candidate => candidate.uri))).pipe(
                Effect.andThen(source.hydrate(metadata, options)),
              ),
          })),
        ),
      ),
    ),
    spy => Effect.sync(() => spy.mockRestore()),
  );
  const step = () =>
    stepRecallVectorPreparation(config, manifest, Effect.succeed(true)).pipe(
      Effect.provideService(LocalModelStore, models),
      Effect.provideService(LocalModelRuntime, runtime),
      Effect.provideService(RecallDiagnosticsPort, (_home, diagnostic) =>
        Effect.sync(() => {
          diagnostics.push(diagnostic);
        }),
      ),
    );
  const finish = Effect.gen(function* () {
    for (let turn = 0; turn < 1000; turn++) if ((yield* step()).state === 'current') return;
    return yield* Effect.die('builder did not converge');
  });
  const stepUntil = (phase: string) =>
    Effect.gen(function* () {
      for (let turn = 0; turn < 1000; turn++) if ((yield* step()).phase === phase) return;
      return yield* Effect.die(`builder did not reach ${phase}`);
    });
  const query = <T>(sql: string, ...params: readonly string[]) =>
    Effect.sync(() => {
      const db = new Database(filename, {readonly: true});
      try {
        return db.query<T, string[]>(sql).all(...params);
      } finally {
        db.close();
      }
    });
  const generationOf = (corpus: string) =>
    query<{generation: string}>('SELECT generation FROM vector_generations WHERE corpus_generation = ?', corpus).pipe(
      Effect.map(rows => rows[0]?.generation),
    );
  const pointer = query<{generation: string}>('SELECT generation FROM vector_pointer').pipe(
    Effect.map(rows => rows[0]?.generation),
  );
  /** A full-walk oracle: the foreground builder over the same lexical corpus in a clean home. */
  const fullWalkSnapshot = Effect.gen(function* () {
    const index = yield* loadRecallIndexData(config, {includeInactive: false});
    const cleanHome = yield* fs.makeTempDirectoryScoped({prefix: 'recall-vector-delta-oracle-'});
    yield* ensureVectorIndex({agentContextHome: cleanHome}, manifest, index.candidates, {
      corpusGeneration: index.generation,
    }).pipe(
      Effect.provideService(LocalModelStore, models),
      Effect.provideService(LocalModelRuntime, {
        ...runtime,
        embedMany: ({inputs: batch}) => Effect.succeed(EffectArray.map(batch, embeddingForInput)),
      }),
    );
    return yield* vectorSnapshot(path.join(cleanHome, 'indexes/vectors', manifest.id, vectorIndexDatabaseFilename()));
  });
  return {
    home,
    config,
    filename,
    fs,
    path,
    memory,
    remove,
    writeExternal,
    seed,
    refresh,
    step,
    finish,
    stepUntil,
    query,
    generationOf,
    pointer,
    fullWalkSnapshot,
    reads,
    diagnostics,
    inputs: () => inputs,
    before: (program: Effect.Effect<void, unknown, FileSystem.FileSystem>) => {
      beforeInference = program.pipe(Effect.provideService(FileSystem.FileSystem, fs));
    },
  };
});

const buildTables = [
  'idle_recall_metadata',
  'idle_recall_documents',
  'idle_recall_chunks',
  'idle_recall_document_preparations',
  'idle_recall_delta_uris',
];

describe('delta vector generation', () => {
  // P4-A1, P4-A2 and the job id that older binaries look targets up by.
  effectIt.effect('prepares only the changed groups and publishes the generation a full walk builds', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seed;
      yield* f.memory('m3', 'Fourth standalone body.');
      yield* f.memory('m4', 'Fifth standalone body.');
      yield* f.refresh;
      yield* f.finish;
      const base = yield* f.pointer;
      expect(f.reads).toHaveLength(8);
      // A removal only: nothing to prepare, so a stale copied row collides with nothing and only the
      // row-by-row comparison with a full walk can catch it.
      f.reads.length = 0;
      yield* f.remove('m3');
      yield* f.refresh;
      yield* f.finish;
      expect(f.reads).toEqual([]);
      expect(yield* vectorSnapshot(f.filename)).toEqual(yield* f.fullWalkSnapshot);
      f.reads.length = 0;
      yield* f.memory('m1', `${sections('m1', 3)}\n\nalpha βeta 😀 delta`);
      yield* f.memory('group-b', 'The group member diverges.', {memoryId: 'tn_group'});
      // Status is filtered at read time, so an archived memory stays in the corpus as a changed one.
      yield* f.memory('m4', 'Fifth standalone body.', {status: 'archived'});
      const corpus = yield* f.refresh;
      const source = yield* PreparationSource.openRecallVectorPreparationSource(f.config);
      const job = recallVectorPreparationJobId(
        recallVectorPreparationIdentity(
          source.generation,
          source.authorizationKey,
          manifest.id,
          recallVectorStorage.recipe(manifest),
        ),
      );
      const olderBinaryLookup = f.query(
        'SELECT t.generation FROM idle_recall_targets t JOIN vector_generations g USING(generation) WHERE g.job_id = ?',
        job,
      );
      yield* f.stepUntil('embed');
      expect(yield* olderBinaryLookup).toEqual([]);
      // P4-A2: during the delta, build rows exist only for the changed memories and their old group.
      const changed = [memoryUri('group-a'), memoryUri('group-b'), memoryUri('m1'), memoryUri('m4')];
      expect(
        EffectArray.map(
          yield* f.query<{uri: string}>('SELECT DISTINCT uri FROM idle_recall_chunks ORDER BY uri'),
          row => row.uri,
        ),
      ).toEqual(changed);
      expect(yield* f.query('SELECT COUNT(*) AS count FROM idle_recall_document_preparations')).toEqual([{count: 4}]);
      expect(yield* f.query('SELECT COUNT(*) AS count FROM idle_recall_documents')).toEqual([{count: 4}]);
      yield* f.finish;
      expect(yield* olderBinaryLookup).toEqual([{generation: yield* f.pointer}]);
      // P4-A1: only the changed bodies were read and chunked.
      expect([...f.reads].sort()).toEqual(changed);
      expect(yield* f.pointer).toBe(yield* f.generationOf(corpus));
      expect(yield* f.pointer).not.toBe(base);
      const published = yield* vectorSnapshot(f.filename);
      expect(published).toEqual(yield* f.fullWalkSnapshot);
      expect(published.chunks).toHaveLength(134);
      expect(EffectArray.filter(published.chunks, chunk => chunk.approved_authoritative === 1)).toHaveLength(1);
      // P4-A2: a ready target keeps no chunk text, metadata or changed set.
      for (const table of buildTables)
        expect(yield* f.query(`SELECT COUNT(*) AS count FROM ${table}`)).toEqual([{count: 0}]);
      const build = {event: 'recall.vector-build', scope: 'active', durationMilliseconds: 0} as const;
      expect(f.diagnostics).toEqual([
        {...build, kind: 'full', changedCount: 0, copiedChunkCount: 0, reusedChunkCount: 0, embeddedChunkCount: 134},
        {...build, kind: 'delta', changedCount: 1, copiedChunkCount: 133, reusedChunkCount: 0, embeddedChunkCount: 0},
        {...build, kind: 'delta', changedCount: 4, copiedChunkCount: 128, reusedChunkCount: 4, embeddedChunkCount: 2},
      ]);
    }).pipe(provideFixtureLayer(services)),
  );

  // A base that disappears, or a copy off its expected counts, must not stall the target, and the reset must
  // purge the copied rows in bounded steps.
  for (const fault of ['base-not-ready', 'short-chunk-copy', 'short-alias-copy'] as const)
    effectIt.effect(`turns a delta into a full walk when its base copy fails (${fault})`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.seed;
        yield* f.refresh;
        yield* f.finish;
        const base = yield* f.pointer;
        yield* f.memory('m2', 'Third standalone body, revised.');
        const corpus = yield* f.refresh;
        const copy = Effect.gen(function* () {
          const target = yield* f.generationOf(corpus);
          return (yield* f.query<{copy_stage: string | null; copied_chunks: number}>(
            'SELECT copy_stage, copied_chunks FROM idle_recall_targets WHERE generation = ?',
            target,
          ))[0];
        });
        // The base breaks after the chunk stage (131 rows copied) or after the first chunk page (100 rows).
        for (let turn = 0; turn < 20; turn++) {
          yield* f.step();
          const state = yield* copy;
          if (fault === 'base-not-ready' ? state?.copy_stage === 'aliases' : (state?.copied_chunks ?? 0) >= 100) break;
        }
        yield* Effect.sync(() => {
          const db = new Database(f.filename);
          try {
            if (fault === 'base-not-ready')
              db.query("UPDATE vector_generations SET state = 'building' WHERE generation = ?").run(base);
            else {
              const table = fault === 'short-chunk-copy' ? 'vector_chunks' : 'vector_aliases';
              const key = fault === 'short-chunk-copy' ? 'chunk_id' : 'uri';
              db.query(
                `DELETE FROM ${table} WHERE generation = ?1 AND ${key} = (SELECT MAX(${key}) FROM ${table} WHERE generation = ?1)`,
              ).run(base);
            }
          } finally {
            db.close();
          }
        });
        const target = yield* f.generationOf(corpus);
        const targetChunks = f
          .query<{count: number}>('SELECT COUNT(*) AS count FROM vector_chunks WHERE generation = ?', target)
          .pipe(Effect.map(rows => rows[0].count));
        f.reads.length = 0;
        const counts = [yield* targetChunks];
        for (let turn = 0; turn < 1000; turn++) {
          const result = yield* f.step();
          counts.push(yield* targetChunks);
          if (result.state === 'current') break;
        }
        // The purge drops the copied rows to zero at most 100 rows per step, then the full walk rebuilds them.
        const purged = counts.indexOf(0);
        expect(Math.max(...counts.slice(0, purged))).toBeGreaterThan(100);
        for (let index = 1; index <= purged; index++)
          expect(counts[index - 1] - counts[index]).toBeLessThanOrEqual(100);
        expect(f.reads).toHaveLength(6);
        expect(f.diagnostics.at(-1)).toMatchObject({kind: 'full', changedCount: 0, copiedChunkCount: 0});
        expect(yield* vectorSnapshot(f.filename)).toEqual(yield* f.fullWalkSnapshot);
      }).pipe(provideFixtureLayer(services)),
    );

  // P4-A3.
  effectIt.effect('keeps the base and the completed vectors when a write replaces a delta build', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seed;
      yield* f.refresh;
      yield* f.finish;
      const base = yield* f.pointer;
      yield* f.memory('m1', sections('m1-revised', 3));
      const replacedCorpus = yield* f.refresh;
      yield* f.stepUntil('embed');
      const replaced = yield* f.generationOf(replacedCorpus);
      const baseOf = (generation: string) =>
        f.query('SELECT base_generation FROM idle_recall_targets WHERE generation = ?', generation);
      const replacedBase = yield* baseOf(replaced);
      expect(replacedBase).toEqual([{base_generation: base}]);
      // Embed every prepared chunk of the replaced target, but stop before it activates.
      for (let turn = 0; turn < 10; turn++) {
        const [state] = yield* f.query<{prepared: number; embedded: number}>(
          `SELECT (SELECT COUNT(*) FROM idle_recall_chunks WHERE generation = ?1) AS prepared,
            (SELECT COUNT(*) FROM vector_chunks WHERE generation = ?1) - copied_chunks AS embedded
           FROM idle_recall_targets WHERE generation = ?1`,
          replaced,
        );
        if (state.prepared === state.embedded) break;
        yield* f.step();
      }
      expect(f.inputs()).toBe(132 + 3);
      yield* f.memory('m2', 'Third standalone body, revised.');
      const corpus = yield* f.refresh;
      const embeddedBefore = f.inputs();
      f.reads.length = 0;
      const observed: {replacedChunks: number; replacedExists: boolean; pointer: string | undefined}[] = [];
      for (let turn = 0; turn < 1000; turn++) {
        const result = yield* f.step();
        observed.push({
          replacedChunks: (yield* f.query<{count: number}>(
            'SELECT COUNT(*) AS count FROM vector_chunks WHERE generation = ?',
            replaced,
          ))[0].count,
          replacedExists:
            (yield* f.query('SELECT 1 FROM vector_generations WHERE generation = ?', replaced)).length === 1,
          pointer: yield* f.pointer,
        });
        if (result.state === 'current') break;
      }
      const target = yield* f.generationOf(corpus);
      // The same ready base, no full walk and no second inference of the replaced target's completed chunks.
      expect(yield* baseOf(target)).toEqual(replacedBase);
      expect([...f.reads].sort()).toEqual([memoryUri('m1'), memoryUri('m2')]);
      expect(f.inputs() - embeddedBefore).toBe(1);
      expect(f.diagnostics.at(-1)).toEqual({
        event: 'recall.vector-build',
        scope: 'active',
        kind: 'delta',
        changedCount: 2,
        copiedChunkCount: 128,
        reusedChunkCount: 3,
        embeddedChunkCount: 1,
        durationMilliseconds: 0,
      });
      // The replaced target goes in bounded steps, and only after the newer target serves.
      expect(EffectArray.some(observed, row => row.replacedChunks > 0 && row.replacedChunks < 132)).toBe(true);
      for (const row of observed) if (!row.replacedExists || row.replacedChunks < 132) expect(row.pointer).toBe(target);
      expect(observed.at(-1)).toEqual({replacedChunks: 0, replacedExists: false, pointer: target});
      expect(yield* f.query('SELECT generation FROM vector_generations')).toEqual([{generation: target}]);
      expect(base).not.toBe(target);
    }).pipe(provideFixtureLayer(services)),
  );

  // P4-A4.
  effectIt.effect('plans a full walk without a compatible base or a known changed set within the cap', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seed;
      yield* f.refresh;
      const plan = (cap?: number) =>
        PreparationSource.openRecallVectorPreparationSource(f.config).pipe(
          Effect.flatMap(source => planRecallVectorDelta(f.config, manifest, source, cap)),
          Effect.map(planned => planned.kind),
        );
      expect(yield* plan()).toBe('full');
      yield* f.finish;
      yield* f.memory('m1', 'Second standalone body, revised.');
      yield* f.memory('m2', 'Third standalone body, revised.');
      yield* f.refresh;
      expect(yield* plan()).toBe('delta');
      expect(yield* plan(1)).toBe('full');
      // Legacy identity without a recorded authorization key.
      const base = yield* f.pointer;
      const job = (yield* f.query<{job_id: string}>(
        'SELECT job_id FROM vector_generations WHERE generation = ?',
        base,
      ))[0].job_id;
      const setJob = (value: string) =>
        Effect.sync(() => {
          const db = new Database(f.filename);
          try {
            db.query('UPDATE vector_generations SET job_id = ? WHERE generation = ?').run(value, base);
          } finally {
            db.close();
          }
        });
      yield* setJob(sha256HexSync('legacy'));
      expect(yield* plan()).toBe('full');
      yield* setJob(job);
      expect(yield* plan()).toBe('delta');
      // A changed external source changes the authorization key.
      yield* f.writeExternal('External body, refetched.');
      yield* f.refresh;
      expect(yield* plan()).toBe('full');
      // Unknown changed set, from a base of the new key.
      yield* f.finish;
      yield* f.memory('m1', 'Second standalone body, revised again.');
      yield* f.refresh;
      expect(yield* plan()).toBe('delta');
      const lexical = (yield* recallIndexStatus(f.config, false)).databasePath;
      yield* Effect.sync(() => {
        const db = new Database(lexical);
        try {
          db.exec('PRAGMA foreign_keys = ON; DELETE FROM recall_change_publications');
        } finally {
          db.close();
        }
      });
      expect(yield* plan()).toBe('full');
    }).pipe(provideFixtureLayer(services)),
  );

  effectIt.effect('plans from the served base before a newer ready compatible generation', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seed;
      yield* f.refresh;
      yield* f.finish;
      const served = yield* f.pointer;
      yield* f.memory('m2', 'Third standalone body, revised.');
      yield* f.refresh;
      const source = yield* PreparationSource.openRecallVectorPreparationSource(f.config);
      const newerJob = recallVectorPreparationJobId(
        recallVectorPreparationIdentity(
          'other-corpus',
          source.authorizationKey,
          manifest.id,
          recallVectorStorage.recipe(manifest),
        ),
      );
      yield* Effect.sync(() => {
        const db = new Database(f.filename);
        try {
          db.query(
            `INSERT INTO vector_generations SELECT '9-newer', ?, 'other-corpus', model_id, model_sha256, dimensions,
               embedding_recipe, chunker_version, normalized, 0, 'ready', '2030-01-01T00:00:00.000Z', scope_mapping_version
             FROM vector_generations WHERE generation = ?`,
          ).run(newerJob, served);
        } finally {
          db.close();
        }
      });
      const planned = yield* planRecallVectorDelta(f.config, manifest, source);
      expect(planned.kind === 'delta' ? planned.base.generation : planned.kind).toBe(served);
    }).pipe(provideFixtureLayer(services)),
  );

  // P4-A5.
  for (const revoked of ['changed', 'copied'] as const)
    effectIt.effect(`stops publication when an external source is revoked before activation (${revoked})`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const content = yield* f.seed;
        yield* f.refresh;
        yield* f.finish;
        const base = yield* f.pointer;
        // A memory with the external body's content hash brings the unchanged source into the changed set.
        if (revoked === 'changed') yield* f.memory('mirror', content);
        else yield* f.memory('m2', 'Third standalone body, revised.');
        const corpus = yield* f.refresh;
        const source = yield* PreparationSource.openRecallVectorPreparationSource(f.config);
        const planned = yield* planRecallVectorDelta(f.config, manifest, source);
        expect(planned.kind === 'delta' && planned.changed.includes(externalUri)).toBe(revoked === 'changed');
        // Changed bytes keep the manifest map, so only authorization of the source itself can refuse it.
        f.before(
          Effect.gen(function* () {
            const filename = f.path.join(
              f.home,
              'data/local/resources',
              EffectString.slice('threadnote://resources/'.length)(externalUri),
            );
            yield* (yield* FileSystem.FileSystem).writeFileString(filename, content + 'changed');
          }),
        );
        let failure: unknown;
        for (let turn = 0; turn < 1000 && failure === undefined; turn++) {
          const result = yield* f.step().pipe(Effect.result);
          if (result._tag === 'Failure') failure = result.failure;
          else if (result.success.state === 'current') break;
        }
        expect(failure).toMatchObject({_tag: 'RecallVectorSourceChanged'});
        expect(yield* f.pointer).toBe(base);
        expect(yield* vectorIndexGenerationReadiness(f.home, manifest, corpus)).not.toBe('current');
        expect(EffectArray.map(f.diagnostics, diagnostic => 'kind' in diagnostic && diagnostic.kind)).toEqual(['full']);
      }).pipe(provideFixtureLayer(services)),
    );
});

function provideFixtureLayer<Services, E, R>(layer: Layer.Layer<Services, E, R>) {
  return <A, E2, R2>(program: Effect.Effect<A, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))));
}

function embeddingForInput(input: string): number[] {
  const hash = sha256HexSync(input);
  return [
    0.1 + Number.parseInt(EffectString.slice(0, 8)(hash), 16) / 0xffffffff,
    0.1 + Number.parseInt(EffectString.slice(8, 16)(hash), 16) / 0xffffffff,
  ];
}

/** The served generation's chunk rows with vector keys and values, scope columns and aliases. */
const vectorSnapshot = (filename: string) =>
  Effect.sync(() => {
    const db = new Database(filename, {readonly: true});
    try {
      return {
        chunks: db
          .query<{approved_authoritative: number}, []>(
            `SELECT c.chunk_id,c.uri,c.fingerprint,c.project,c.approved_authoritative,v.vector_key,hex(v.vector) AS vector
        FROM vector_pointer p JOIN vector_chunks c ON c.generation = p.generation JOIN vector_values v ON v.id = c.vector_id ORDER BY c.chunk_id`,
          )
          .all(),
        aliases: db
          .query(
            'SELECT a.uri,a.representative_uri FROM vector_pointer p JOIN vector_aliases a ON a.generation = p.generation ORDER BY a.uri',
          )
          .all(),
      };
    } finally {
      db.close();
    }
  });
