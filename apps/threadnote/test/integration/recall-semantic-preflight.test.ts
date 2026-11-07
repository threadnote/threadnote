import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {
  Array as EffectArray,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Schema,
  String as EffectString,
} from 'effect';
import fc from 'fast-check';
import {TestClock} from 'effect/testing';
import {describe, expect, vi} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {ensureVectorIndex, recallVectorStorage, vectorIndexDatabaseFilename} from '@threadnote/recall/vector-index';
import {negativeSemanticReadinessHint} from '@threadnote/recall/vector/negative-readiness';
import {
  RecallReadyReadBoundary,
  recallReadySectionsOptionsSchema,
  recallSemanticPreflightSchema,
} from '@threadnote/recall/read_boundary';
import {
  createMcpRecallSemanticRetrievalGate,
  prepareRecallSemanticPreflight,
  recallPreflightSkipsSemanticRead,
} from '@threadnote/recall/runtime';
import {decodeRecallReadySectionsResult} from '@threadnote/recall/sections_read';
import {CallerReadCancellation, makeReadDeadline, ReadDeadlineContext} from '@threadnote/platform/read_deadline';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {serveRecallReadyRead} from '../../src/recall/ready_read_worker.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const manifest = Option.getOrThrow(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, value => value.id === 'bge-small-en-v1.5-q8'),
);
const model = {
  id: manifest.id,
  sha256: manifest.sha256,
  dimensions: manifest.dimensions ?? 0,
  promptPrefixes: manifest.promptPrefixes,
};
const uri = 'threadnote://user/test/memories/durable/entry.md';
const body = (project = 'allowed', suffix = '') =>
  formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      status: 'active',
      project,
      memoryId: 'tn_preflight_entry',
      topic: 'zebra proof',
      keywords: ['zebra'],
      sourceAgentClient: 'test',
      timestamp: '2026-11-04T00:00:00.000Z',
    },
    `zebra proof ${suffix}`,
  );
const options = {
  mode: 'baseline' as const,
  allowExactRescue: true,
  feedbackQuery: 'zebra',
  query: 'zebra',
  includeInactive: false,
  minimumScore: 0,
  limit: 4,
  eligibility: {
    kind: 'candidate-policy' as const,
    authority: 'any' as const,
    projects: {mode: 'allow-projects-and-projectless' as const, projects: ['allowed']},
  },
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-negative-preflight-'});
  const config = {account: 'local', user: 'test', agentContextHome: home};
  const filename = path.join(home, 'data/local/user/test/memories/durable/entry.md');
  yield* fs.makeDirectory(path.dirname(filename), {recursive: true});
  yield* fs.writeFileString(filename, body());
  const lexical = yield* loadRecallIndexData(config, {includeInactive: false});
  const installation = {
    installed: true,
    bytes: manifest.size,
    modelId: manifest.id,
    path: path.join(home, 'unused.gguf'),
    partialBytes: 0,
    verified: false,
  };
  const store = LocalModelStore.of({
    status: () => Effect.succeed(installation),
    path: () => installation.path,
    install: () => Effect.die('No preflight install'),
    verify: () => Effect.die('No preflight weights verification'),
    remove: () => Effect.die('No preflight removal'),
  });
  const runtime = LocalModelRuntime.of({
    diagnostics: Effect.die('No diagnostics'),
    generate: () => Effect.die('No generation'),
    rerank: () => Effect.die('No rerank'),
    embedMany: ({inputs}) =>
      Effect.succeed(
        EffectArray.map(inputs, () => Array.from({length: model.dimensions}, (_, i) => (i === 0 ? 1 : 0))),
      ),
  });
  return {fs, path, home, config, filename, lexical, store, runtime};
});

describe('negative semantic preflight', () => {
  fcEffectProp(
    effectIt,
    'only matching definitive negatives can omit the optional semantic probe',
    {readiness: fc.constantFrom('missing', 'stale', 'current', 'unknown'), match: fc.boolean()},
    ({readiness, match}) =>
      Effect.gen(function* () {
        const hint = yield* Schema.decodeEffect(recallSemanticPreflightSchema)({
          model: {...model, sha256: match ? model.sha256 : EffectString.repeat(64)('a')},
          readiness,
        });
        expect(recallPreflightSkipsSemanticRead(model, hint)).toBe(match && ['missing', 'stale'].includes(readiness));
        expect(recallPreflightSkipsSemanticRead(undefined, hint)).toBe(false);
        expect(recallPreflightSkipsSemanticRead(model, undefined)).toBe(false);
      }),
    {fastCheck: {numRuns: 64}},
  );

  effectIt.effect('accepts only the baseline descriptor and preserves strict schema/model fields', () =>
    Effect.gen(function* () {
      const request = {...options, semanticPreflightModel: model};
      expect(
        yield* Schema.decodeEffect(recallReadySectionsOptionsSchema, {onExcessProperty: 'error'})(
          JSON.parse(JSON.stringify(request)),
        ),
      ).toEqual(request);
      for (const extra of [
        {semanticPreflightModel: {...model, dimensions: 0}},
        {semanticPreflightModel: {...model, path: '/must-not-open'}},
      ]) {
        expect(
          (yield* Schema.decodeEffect(recallReadySectionsOptionsSchema, {onExcessProperty: 'error'})({
            ...options,
            ...extra,
          }).pipe(Effect.result))._tag,
        ).toBe('Failure');
      }
      expect(
        (yield* Schema.decodeEffect(recallReadySectionsOptionsSchema, {onExcessProperty: 'error'})({
          ...request,
          mode: 'closing',
          candidateUris: [],
          semantic: {},
          rerankerScores: [],
        }).pipe(Effect.result))._tag,
      ).toBe('Failure');
    }),
  );

  effectIt.effect('does not reuse a negative hint after any embedding-space identity change', () =>
    Effect.sync(() => {
      const hint = {model, readiness: 'stale' as const};
      for (const changed of [
        {...model, id: 'other'},
        {...model, sha256: EffectString.repeat(64)('a')},
        {...model, dimensions: model.dimensions + 1},
        {...model, promptPrefixes: {query: 'changed'}},
      ])
        expect(recallPreflightSkipsSemanticRead(changed, hint)).toBe(false);
    }),
  );

  for (const selection of ['valid', 'malformed', 'oversized', 'reranker', 'missing'] as const) {
    effectIt.effect(`bounded strict selection treats ${selection} truthfully without initializing models`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const allocations: number[] = [];
        let statusReads = 0;
        yield* f.fs.makeDirectory(f.path.join(f.home, 'models'), {recursive: true});
        if (selection !== 'missing')
          yield* f.fs.writeFileString(
            f.path.join(f.home, 'models/selection.json'),
            selection === 'malformed'
              ? '{'
              : selection === 'oversized'
                ? EffectString.repeat(8193)(' ')
                : JSON.stringify({
                    version: 1,
                    roles: {
                      embedding: manifest.id,
                      ...(selection === 'reranker' ? {reranker: 'unknown-potential'} : {}),
                    },
                  }),
          );
        const observedFs = FileSystem.FileSystem.of({
          ...f.fs,
          open: (...args) =>
            f.fs.open(...args).pipe(
              Effect.flatMap(file =>
                Effect.gen(function* () {
                  const original = file.readAlloc.bind(file);
                  const spy = vi.spyOn(file, 'readAlloc').mockImplementation((size, readOptions) => {
                    allocations.push(size);
                    return original(size, readOptions);
                  });
                  yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
                  return file;
                }),
              ),
            ),
        });
        const descriptor = yield* prepareRecallSemanticPreflight(f.config).pipe(
          Effect.provideService(FileSystem.FileSystem, observedFs),
          Effect.provideService(RecallReadyReadBoundary, {
            read: () => Effect.die('No worker during parent capability read'),
          }),
          Effect.provideService(ReadDeadlineContext, yield* makeReadDeadline(2000)),
          Effect.provideService(LocalModelStore, {
            ...f.store,
            status: (...args) => {
              statusReads++;
              return f.store.status(...args);
            },
          }),
        );
        expect(descriptor).toEqual(selection === 'valid' || selection === 'reranker' ? model : undefined);
        expect(allocations).toEqual(selection === 'missing' || selection === 'oversized' ? [] : [8193]);
        expect(statusReads).toBe(selection === 'valid' || selection === 'reranker' ? 1 : 0);
        expect(yield* prepareRecallSemanticPreflight(f.config)).toBeUndefined();
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  }

  effectIt.effect('caller semantic retrieval waits beyond its former gate and ignores only that gate cooldown', () =>
    Effect.gen(function* () {
      const gate = createMcpRecallSemanticRetrievalGate();
      const runtime = {};
      const bounded = yield* gate(runtime, Effect.never).pipe(Effect.forkScoped);
      yield* TestClock.adjust(30_000);
      expect((yield* Fiber.join(bounded)).status).toBe('timed-out');
      expect((yield* gate(runtime, Effect.succeed('bounded'))).status).toBe('cooldown');
      const release = yield* Deferred.make<void>();
      const caller = yield* gate(runtime, Deferred.await(release).pipe(Effect.as('available'))).pipe(
        Effect.provideService(CallerReadCancellation, true),
        Effect.forkScoped,
      );
      yield* TestClock.adjust(600_001);
      expect(caller.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(caller)).toEqual({status: 'completed', value: 'available'});
    }),
  );

  effectIt.effect('parent metadata timeout returns no hint and closes the acquired selection FD', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.makeDirectory(f.path.join(f.home, 'models'), {recursive: true});
      yield* f.fs.writeFileString(
        f.path.join(f.home, 'models/selection.json'),
        JSON.stringify({version: 1, roles: {embedding: manifest.id}}),
      );
      const entered = yield* Deferred.make<void>();
      let finalized = 0;
      let closedRead: (() => Effect.Effect<Option.Option<Uint8Array>, unknown>) | undefined;
      const observed = FileSystem.FileSystem.of({
        ...f.fs,
        open: (...args) =>
          f.fs.open(...args).pipe(
            Effect.flatMap(file =>
              Effect.gen(function* () {
                const original = file.readAlloc.bind(file);
                closedRead = () => original(1);
                const spy = vi
                  .spyOn(file, 'readAlloc')
                  .mockImplementation(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)));
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    finalized++;
                    spy.mockRestore();
                  }),
                );
                return file;
              }),
            ),
          ),
      });
      const fiber = yield* prepareRecallSemanticPreflight(f.config).pipe(
        Effect.provideService(FileSystem.FileSystem, observed),
        Effect.provideService(RecallReadyReadBoundary, {read: () => Effect.die('No worker during parent preparation')}),
        Effect.provideService(ReadDeadlineContext, yield* makeReadDeadline(2000)),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(25);
      expect(yield* Fiber.join(fiber)).toBeUndefined();
      expect(finalized).toBe(1);
      if (!closedRead) return yield* Effect.die('Expected acquired selection FD');
      expect((yield* closedRead().pipe(Effect.result))._tag).toBe('Failure');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('caller metadata completion waits beyond prior limits and closes the selection FD', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.makeDirectory(f.path.join(f.home, 'models'), {recursive: true});
      yield* f.fs.writeFileString(
        f.path.join(f.home, 'models/selection.json'),
        JSON.stringify({version: 1, roles: {embedding: manifest.id}}),
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let finalized = 0;
      let closedRead: (() => Effect.Effect<Option.Option<Uint8Array>, unknown>) | undefined;
      const observed = FileSystem.FileSystem.of({
        ...f.fs,
        open: (...args) =>
          f.fs.open(...args).pipe(
            Effect.flatMap(file =>
              Effect.gen(function* () {
                const original = file.readAlloc.bind(file);
                closedRead = () => original(1);
                const spy = vi
                  .spyOn(file, 'readAlloc')
                  .mockImplementation(count =>
                    Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(original(count)),
                    ),
                  );
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    finalized++;
                    spy.mockRestore();
                  }),
                );
                return file;
              }),
            ),
          ),
      });
      const fiber = yield* prepareRecallSemanticPreflight(f.config).pipe(
        Effect.provideService(FileSystem.FileSystem, observed),
        Effect.provideService(RecallReadyReadBoundary, {read: () => Effect.die('No worker during parent preparation')}),
        Effect.provideService(CallerReadCancellation, true),
        Effect.provideService(LocalModelStore, f.store),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(600_001);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(fiber))?.id).toBe(manifest.id);
      expect(finalized).toBe(1);
      if (!closedRead) return yield* Effect.die('Expected acquired selection FD');
      expect((yield* closedRead().pipe(Effect.result))._tag).toBe('Failure');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('worker metadata timeout returns unknown and completes the original baseline proof', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const vectorFile = f.path.join(f.home, 'indexes', 'vectors', model.id, vectorIndexDatabaseFilename());
      const entered = yield* Deferred.make<void>();
      let finalized = 0;
      const observed = FileSystem.FileSystem.of({
        ...f.fs,
        exists: filename =>
          filename === vectorFile
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized++;
                  }),
                ),
              )
            : f.fs.exists(filename),
      });
      const fiber = yield* serveRecallReadyRead({
        operation: 'sections',
        config: f.config,
        options: {...options, semanticPreflightModel: model},
      }).pipe(Effect.provideService(FileSystem.FileSystem, observed), Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(25);
      const response = yield* Fiber.join(fiber);
      expect(finalized).toBe(1);
      expect(response.outcome).toBe('success');
      if (response.outcome !== 'success') return yield* Effect.die('Expected baseline after optional timeout');
      const result = yield* decodeRecallReadySectionsResult(JSON.parse(JSON.stringify(response.value)));
      expect(result.semanticPreflight?.readiness).toBe('unknown');
      expect(recallPreflightSkipsSemanticRead(model, result.semanticPreflight)).toBe(false);
      expect(EffectArray.some(result.ranked, hit => hit.uri === uri)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('caller worker metadata waits beyond prior limits and still closes the original baseline proof', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const vectorFile = f.path.join(f.home, 'indexes', 'vectors', model.id, vectorIndexDatabaseFilename());
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let finalized = 0;
      const observed = FileSystem.FileSystem.of({
        ...f.fs,
        exists: filename =>
          filename === vectorFile
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(f.fs.exists(filename)),
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized++;
                  }),
                ),
              )
            : f.fs.exists(filename),
      });
      const fiber = yield* serveRecallReadyRead({
        operation: 'sections',
        config: f.config,
        options: {...options, semanticPreflightModel: model},
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, observed),
        Effect.provideService(CallerReadCancellation, true),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(600_001);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      const response = yield* Fiber.join(fiber);
      expect(finalized).toBe(1);
      expect(response.outcome).toBe('success');
      if (response.outcome !== 'success') return yield* Effect.die('Expected baseline after optional timeout');
      const result = yield* decodeRecallReadySectionsResult(JSON.parse(JSON.stringify(response.value)));
      expect(result.semanticPreflight?.readiness).toBe('missing');
      expect(recallPreflightSkipsSemanticRead(model, result.semanticPreflight)).toBe(true);
      expect(EffectArray.some(result.ranked, hit => hit.uri === uri)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fixed metadata preflight never counts rows or scans authorization catalogs', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* ensureVectorIndex(f.config, manifest, f.lexical.candidates, {corpusGeneration: f.lexical.generation}).pipe(
        Effect.provideService(LocalModelRuntime, f.runtime),
        Effect.provideService(LocalModelStore, {...f.store, verify: () => f.store.status(f.home, manifest)}),
      );
      const current = yield* negativeSemanticReadinessHint(f.config, model, recallVectorStorage);
      expect(current).toBe('unknown');
      yield* f.fs.writeFileString(f.filename, body('allowed', 'changed'));
      yield* loadRecallIndexData(f.config, {includeInactive: false, forceRefresh: true});
      yield* Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(Database.prototype, 'query')),
        spy =>
          Effect.gen(function* () {
            expect(yield* negativeSemanticReadinessHint(f.config, model, recallVectorStorage)).toBe('stale');
            const queries = EffectArray.map(spy.mock.calls, call => String(call[0]));
            expect(EffectArray.some(queries, sql => EffectString.includes('COUNT(')(sql))).toBe(false);
            expect(EffectArray.some(queries, sql => EffectString.includes('FROM metadata')(sql))).toBe(true);
            expect(EffectArray.some(queries, sql => EffectString.includes('FROM vector_pointer')(sql))).toBe(true);
            expect(EffectArray.filter(queries, sql => EffectString.includes('FROM vector_pointer')(sql))).toHaveLength(
              1,
            );
            expect(
              EffectArray.some(queries, sql =>
                /FROM (?:documents|vector_chunks|vector_aliases|vector_values)/.test(sql),
              ),
            ).toBe(false);
          }),
        spy => Effect.sync(() => spy.mockRestore()),
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('malformed metadata and unsupported schemas remain unknown without hiding baseline content', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* ensureVectorIndex(f.config, manifest, f.lexical.candidates, {corpusGeneration: f.lexical.generation}).pipe(
        Effect.provideService(LocalModelRuntime, f.runtime),
        Effect.provideService(LocalModelStore, {...f.store, verify: () => f.store.status(f.home, manifest)}),
      );
      const file = f.path.join(f.home, 'indexes', 'vectors', model.id, vectorIndexDatabaseFilename());
      yield* Effect.sync(() => {
        const db = new Database(file);
        try {
          db.exec("UPDATE vector_generations SET model_id='unexpected-model'");
        } finally {
          db.close();
        }
      });
      expect(yield* negativeSemanticReadinessHint(f.config, model, recallVectorStorage)).toBe('unknown');
      yield* Effect.sync(() => {
        const db = new Database(file);
        try {
          db.exec('PRAGMA user_version=999');
        } finally {
          db.close();
        }
      });
      const response = yield* serveRecallReadyRead({
        operation: 'sections',
        config: f.config,
        options: {...options, semanticPreflightModel: model},
      });
      expect(response.outcome).toBe('success');
      if (response.outcome !== 'success') return yield* Effect.die('Expected completed baseline');
      const result = yield* decodeRecallReadySectionsResult(JSON.parse(JSON.stringify(response.value)));
      expect(result.semanticPreflight?.readiness).toBe('unknown');
      expect(EffectArray.some(result.ranked, hit => hit.uri === uri)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('unsupported octet_length keeps unknown and the original semantic fallback', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* ensureVectorIndex(f.config, manifest, f.lexical.candidates, {corpusGeneration: f.lexical.generation}).pipe(
        Effect.provideService(LocalModelRuntime, f.runtime),
        Effect.provideService(LocalModelStore, {...f.store, verify: () => f.store.status(f.home, manifest)}),
      );
      const original = Database.prototype.query;
      let rejected = 0;
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(Database.prototype, 'query').mockImplementation(function (this: Database, sql: string) {
            if (EffectString.includes('octet_length(')(sql)) {
              rejected++;
              throw new Error('no such function: octet_length');
            }
            return original.call(this, sql);
          }),
        ),
        () =>
          Effect.gen(function* () {
            const response = yield* serveRecallReadyRead({
              operation: 'sections',
              config: f.config,
              options: {...options, semanticPreflightModel: model},
            });
            expect(rejected).toBe(1);
            expect(response.outcome).toBe('success');
            if (response.outcome !== 'success')
              return yield* Effect.die('Expected baseline after unsupported optional SQL');
            const result = yield* decodeRecallReadySectionsResult(JSON.parse(JSON.stringify(response.value)));
            expect(result.semanticPreflight?.readiness).toBe('unknown');
            expect(recallPreflightSkipsSemanticRead(model, result.semanticPreflight)).toBe(false);
            expect(EffectArray.some(result.ranked, hit => hit.uri === uri)).toBe(true);
          }),
        spy => Effect.sync(() => spy.mockRestore()),
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  for (const mutation of ['delete', 'revoke-project'] as const) {
    effectIt.effect(`excludes canonical ${mutation} after preflight before final baseline proof`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let preflightObserved = false,
          mutated = false;
        const vectorFile = f.path.join(f.home, 'indexes', 'vectors', model.id, vectorIndexDatabaseFilename());
        const observed = FileSystem.FileSystem.of({
          ...f.fs,
          exists: filename =>
            f.fs.exists(filename).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (filename === vectorFile) preflightObserved = true;
                }),
              ),
            ),
          readFileString: (...args) =>
            Effect.gen(function* () {
              if (preflightObserved && !mutated && args[0] === f.filename) {
                mutated = true;
                if (mutation === 'delete') yield* f.fs.remove(f.filename);
                else yield* f.fs.writeFileString(f.filename, body('denied'));
              }
              return yield* f.fs.readFileString(...args);
            }),
        });
        const response = yield* serveRecallReadyRead({
          operation: 'sections',
          config: f.config,
          options: {...options, semanticPreflightModel: model},
        }).pipe(Effect.provideService(FileSystem.FileSystem, observed));
        expect(preflightObserved).toBe(true);
        expect(mutated).toBe(true);
        expect(response.outcome).toBe('success');
        if (response.outcome !== 'success') return yield* Effect.die('Expected baseline success');
        const result = yield* decodeRecallReadySectionsResult(JSON.parse(JSON.stringify(response.value)));
        expect(EffectArray.some(result.ranked, hit => hit.uri === uri)).toBe(false);
        expect(result.semanticPreflight?.readiness).toBe('missing');
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  }
});
