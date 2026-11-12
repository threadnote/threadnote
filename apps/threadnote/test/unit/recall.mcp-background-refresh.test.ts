import {nativeVectorTestsEnabled} from '@threadnote/testing/native-vector-fixture';
import {EffectMcpServerRegistry} from '@threadnote/threadnote/effect/ai/mcp';
import {registerStoreTool} from '@threadnote/threadnote/mcp/server/store';
import {
  completeRecallEmbeddingDemand,
  readRecallEmbeddingDemand,
  requestRecallEmbeddings,
  RecallEmbeddingDemandUnavailable,
  RecallEmbeddingWakePort,
  recallEmbeddingDemandKey,
} from '@threadnote/recall/background/demand';
import {stepRecallVectorPreparation} from '@threadnote/recall/background/vector-step';
import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Fiber, FileSystem, Option, Path, Ref, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import * as LockBoundary from '@threadnote/platform/file/lock';
import * as RefreshBoundary from '@threadnote/recall/mcp/refresh';
import {describe, expect, vi} from 'vitest';
import {EmbeddingFailed} from '@threadnote/inference/engine/errors';
import {LocalModelRuntime, type LocalEmbeddingError} from '@threadnote/inference/engine/local-model-runtime';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel, writeModelSelection} from '@threadnote/inference/models/selection';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  CurrentResourceRecallInvalidationObserver,
  makeResourceRecallInvalidationObservation,
  type ResourceRecallInvalidationReceipt,
} from '@threadnote/store/resource/recall-invalidation';
import {
  applyMaintenanceMetadata,
  previewMaintenanceMetadata,
} from '@threadnote/threadnote/memory/maintenance/metadata_commands';
import {storeMemory} from '@threadnote/threadnote/memory/commands';
import {expireRecallIndexValidation, loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import {
  refreshRecallDerivedIndexesFromSelection,
  scheduleMcpRecallBackgroundRefresh,
} from '@threadnote/recall/mcp/refresh';
import {loadMcpRecallSemanticScoresResult} from '@threadnote/recall/runtime';
import {
  ensureVectorIndex,
  vectorIndexDatabaseFilename,
  vectorIndexGenerationReadiness,
  vectorIndexStatus,
} from '@threadnote/recall/vector-index';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function recallGeneration(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'generation' in value && typeof value.generation === 'string')
    return value.generation;
  throw new Error('Expected a materialized recall-index generation.');
}

const manifest = Option.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'bge-small-en-v1.5-q8'),
)!;

// Same existing private concurrent fixture; execution needs separate admission.
const concurrentRefreshFixture = (callers: number, failOneEnqueue = false) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeDetachedRefreshFixtureHome(fs, 'threadnote-mcp-recall-refresh-');
      const config = {account: 'local', agentContextHome: home, user: 'tester'};
      const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'refresh.md');
      const uri = 'threadnote://resources/repos/threadnote/refresh.md';
      yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
      yield* fs.writeFileString(resource, '# Refresh\n\nOriginal semantic content.\n');

      const calls = yield* Ref.make(0);
      const refreshStarted = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const requestsCompleted = yield* Deferred.make<void>();
      const runtime = fakeRuntime((inputs, dimensions) =>
        Ref.updateAndGet(calls, count => count + 1).pipe(
          Effect.flatMap(call =>
            call === 2
              ? Deferred.succeed(refreshStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseRefresh)))
              : Effect.void,
          ),
          Effect.as(EffectArray.map(inputs, () => unitVector(dimensions))),
        ),
      );
      const store = installedModelStore(home);

      yield* Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
        const initial = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
        yield* ensureVectorIndex(config, manifest, initial.candidates, {corpusGeneration: initial.generation});

        yield* fs.writeFileString(resource, '# Refresh\n\nChanged semantic content.\n');
        yield* expireRecallIndexValidation(home, false, [uri]);
        expect(yield* recallIndexStatus(config)).toMatchObject({
          ready: false,
          reason: 'canonical documents changed; run `threadnote repair`',
        });

        if (failOneEnqueue) {
          const original = RefreshBoundary.scheduleMcpRecallBackgroundRefresh;
          let first = true;
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(RefreshBoundary, 'scheduleMcpRecallBackgroundRefresh').mockImplementation((...args) => {
                if (!first) return original(...args);
                first = false;
                return Effect.fail(
                  RecallEmbeddingDemandUnavailable.make({
                    message: 'Synthetic enqueue guard failure.',
                    stage: 'guard',
                    reason: 'io',
                  }),
                );
              }),
            ),
            spy => Effect.sync(() => spy.mockRestore()),
          );
        }

        const requests = yield* Effect.all(
          Array.from({length: callers}, () => loadMcpRecallSemanticScoresResult(config, 'changed semantic content', 5)),
          {concurrency: 'unbounded'},
        ).pipe(Effect.ensuring(Deferred.succeed(requestsCompleted, undefined)), Effect.forkChild);
        const results = yield* Fiber.join(requests);
        yield* Effect.forEach(Array.from({length: 20}), () => Effect.yieldNow, {discard: true});
        expect(Option.isSome(yield* Deferred.poll(requestsCompleted))).toBe(true);
        expect(results).toHaveLength(callers);
        const unexpected = EffectArray.map(
          EffectArray.filter(results, result => result.status !== 'unavailable').slice(0, 5),
          result => ({
            status: result.status,
            warning: EffectString.slice(0, 180)(Option.getOrElse(result.result.warning, () => '')),
          }),
        );
        // Concurrent callers may fail the bounded enqueue guard without
        // acknowledging demand. At least one caller must actually enqueue;
        // every fallback remains scoreless and reports its own outcome.
        expect(
          EffectArray.some(results, result => result.status === 'unavailable'),
          JSON.stringify(unexpected),
        ).toBe(true);
        if (failOneEnqueue) expect(EffectArray.some(results, result => result.status === 'failed')).toBe(true);
        for (const result of results) {
          const warning = Option.getOrElse(result.result.warning, () => '');
          expect(Option.isNone(result.result.scores)).toBe(true);
          expect(Option.isNone(result.result.corpusGeneration)).toBe(true);
          expect(warning).toContain('background refresh');
          if (result.status === 'failed') {
            expect(warning).toMatch(/\[guard\/(?:io|guard-timeout)\]/u);
            expect(warning).toContain('enqueue not confirmed');
            expect(warning).not.toMatch(/queued|scheduled/u);
          } else {
            expect(result.status).toBe('unavailable');
            expect(warning).toContain('without waiting');
          }
          expect(new TextEncoder().encode(warning).byteLength).toBeLessThanOrEqual(180);
        }
        expect(yield* Ref.get(calls)).toBe(1);
        expect((yield* readRecallEmbeddingDemand(config))?.desired).toBeDefined();
        const worker = yield* finishQueuedRecall(config).pipe(Effect.forkScoped);
        yield* Deferred.await(refreshStarted);
        expect(yield* Ref.get(calls)).toBe(2);

        yield* Deferred.succeed(releaseRefresh, undefined);
        const refreshedGeneration = yield* Fiber.join(worker);
        expect(yield* vectorIndexGenerationReadiness(home, manifest, refreshedGeneration)).toBe('current');
        expect((yield* recallIndexStatus(config)).ready).toBe(true);
        const available = yield* loadMcpRecallSemanticScoresResult(config, 'changed semantic content', 5);
        expect(available.status).toBe('available');
        expect(yield* fs.exists(home)).toBe(true);
      }).pipe(
        Effect.provideService(LocalModelRuntime, runtime),
        Effect.provideService(LocalModelStore, store),
        Effect.ensuring(Deferred.succeed(releaseRefresh, undefined)),
      );
    }),
  ).pipe(
    TestClock.withLive,
    provideTestLayer(ApplicationLayer),
    Effect.tapError(error =>
      Schema.is(RecallEmbeddingDemandUnavailable)(error)
        ? Effect.logError('Recall demand enqueue failed', {
            stage: error.stage ?? 'unknown',
            reason: error.reason ?? 'unknown',
          })
        : Effect.void,
    ),
  );

describe('MCP recall background vector refresh', () => {
  effectIt.effect('retains a new event when canonical invalidation makes the closing lexical status stale', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'mcp-closing-stale-event-'});
      const config = {account: 'local', agentContextHome: home, user: 'tester'};
      const uri = 'threadnote://resources/repos/threadnote/document.md';
      const resource = path.join(home, 'data/local/resources/repos/threadnote/document.md');
      yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
      yield* fs.writeFileString(resource, 'Initial closing-status document.');
      yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
      const initial = yield* loadRecallIndexData(config, {includeInactive: false});
      yield* requestRecallEmbeddings(config, true);
      const observed = (yield* readRecallEmbeddingDemand(config))!.desired!;
      const installed = installedModelStore(home);
      const context = yield* Effect.context<Effect.Services<ReturnType<typeof expireRecallIndexValidation>>>();
      let invalidated = false;
      const modelStore = LocalModelStore.of({
        ...installed,
        status: (...args) =>
          Effect.gen(function* () {
            if (!invalidated) {
              invalidated = true;
              yield* fs.writeFileString(resource, 'Concurrent canonical mutation after lexical refresh.');
              yield* expireRecallIndexValidation(home, false, [uri]);
            }
            return yield* installed.status(...args);
          }).pipe(Effect.provide(context), Effect.orDie),
      });
      yield* refreshRecallDerivedIndexesFromSelection(config, []).pipe(
        Effect.provideService(LocalModelStore, modelStore),
      );
      expect(invalidated).toBe(true);
      expect(yield* recallIndexStatus(config, false)).toMatchObject({ready: false, generation: initial.generation});
      const latest = (yield* readRecallEmbeddingDemand(config))!.desired!;
      expect(latest.token).toBe(observed.token);
      expect(latest.revision).not.toBe(observed.revision);
      expect(yield* completeRecallEmbeddingDemand(config, observed.token, observed.revision)).toBe(false);
      expect((yield* readRecallEmbeddingDemand(config))!.desired).toEqual(latest);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect(
    'the actual citation-free MCP handoff handler commits canonical and lexical state without invoking a held embedding runtime',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'mcp-handoff-no-embedding-'});
        const config = {
          account: 'local',
          agentContextHome: home,
          user: 'tester',
          agentId: 'test',
          manifestPath: path.join(home, 'manifest.json'),
        };
        yield* fs.writeFileString(config.manifestPath, JSON.stringify({version: 1, projects: []}));
        const seed = path.join(home, 'data/local/resources/repos/threadnote/seed.md');
        yield* fs.makeDirectory(path.dirname(seed), {recursive: true});
        yield* fs.writeFileString(seed, 'Initial vector seed.');
        yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
        const initial = yield* loadRecallIndexData(config, {includeInactive: false});
        const fast = fakeRuntime((inputs, dimensions) =>
          Effect.succeed(EffectArray.map(inputs, () => unitVector(dimensions))),
        );
        yield* ensureVectorIndex(config, manifest, initial.candidates, {corpusGeneration: initial.generation}).pipe(
          Effect.provideService(LocalModelRuntime, fast),
          Effect.provideService(LocalModelStore, installedModelStore(home)),
        );
        let calls = 0;
        const held = fakeRuntime(() =>
          Effect.sync(() => {
            calls++;
          }).pipe(Effect.andThen(Effect.never)),
        );
        const server = new EffectMcpServerRegistry();
        registerStoreTool(server, config, 'remember_context', 'Store memory.');
        const saved = yield* server
          .invokeTool('remember_context', {
            kind: 'handoff',
            project: 'threadnote',
            topic: 'bounded-handoff',
            text: 'Synthetic boundedhandoff search token. Task and next step retained.',
          })
          .pipe(
            Effect.provideService(LocalModelRuntime, held),
            Effect.provideService(LocalModelStore, installedModelStore(home)),
          );
        expect(saved.isError).not.toBe(true);
        const uri: unknown =
          typeof saved.structuredContent === 'object' &&
          saved.structuredContent !== null &&
          'memoryUri' in saved.structuredContent
            ? saved.structuredContent.memoryUri
            : undefined;
        expect(typeof uri).toBe('string');
        if (typeof uri !== 'string') return yield* Effect.die('missing canonical receipt');
        expect(yield* (yield* ResourceStore).read({home, account: 'local', user: 'tester'}, uri)).toContain(
          'Synthetic boundedhandoff search token.',
        );
        const lexical = yield* loadRecallIndexData(config, {includeInactive: false, query: 'boundedhandoff'});
        expect(EffectArray.some(lexical.candidates, candidate => candidate.uri === uri)).toBe(true);
        expect(yield* vectorIndexGenerationReadiness(home, manifest, lexical.generation)).not.toBe('current');
        expect((yield* readRecallEmbeddingDemand(config))?.desired).toBeDefined();
        expect(calls).toBe(0);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('reports a canonical-committed partial outcome when required lexical refresh fails', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'mcp-handoff-lexical-partial-'});
      const config = {
        account: 'local',
        agentContextHome: home,
        user: 'tester',
        agentId: 'test',
        manifestPath: path.join(home, 'manifest.json'),
      };
      yield* fs.writeFileString(config.manifestPath, JSON.stringify({version: 1, projects: []}));
      yield* loadRecallIndexData(config, {includeInactive: false});
      const status = yield* recallIndexStatus(config, false);
      yield* Effect.sync(() => {
        const db = new Database(status.databasePath);
        try {
          db.exec("UPDATE metadata SET value = '999' WHERE key = 'schema_version'");
        } finally {
          db.close();
        }
      });
      const server = new EffectMcpServerRegistry();
      registerStoreTool(server, config, 'remember_context', 'Store memory.');
      const result = yield* server.invokeTool('remember_context', {
        kind: 'handoff',
        project: 'threadnote',
        topic: 'partial-lexical',
        text: 'Canonical partial outcome remains independently readable.',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        mutationOutcome: 'canonical-committed',
        recallReadiness: 'lexical-pending',
      });
      const structured = result.structuredContent;
      const uri: unknown =
        typeof structured === 'object' && structured !== null && 'memoryUri' in structured
          ? structured.memoryUri
          : undefined;
      if (typeof uri !== 'string') return yield* Effect.die('missing committed canonical identity');
      expect(yield* (yield* ResourceStore).read({home, account: 'local', user: 'tester'}, uri)).toContain(
        'Canonical partial outcome remains independently readable.',
      );
      expect(
        EffectArray.some(
          result.content,
          block => block.type === 'text' && EffectString.includes('instead of creating it again')(block.text),
        ),
      ).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  for (const unavailable of ['unselected', 'wrong-role', 'uninstalled', 'not-built'] as const) {
    effectIt.effect(
      `updates lexical data without materializing candidates when the vector model is ${unavailable}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-lexical-metadata-refresh-'});
            const config = {account: 'local', agentContextHome: home, user: 'tester'};
            const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'metadata.md');
            const uri = 'threadnote://resources/repos/threadnote/metadata.md';
            yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
            yield* fs.writeFileString(resource, '# Lexical metadata\n\nPrevious materialization token.\n');
            const initial = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
            if (unavailable !== 'unselected') {
              const selected =
                unavailable === 'wrong-role'
                  ? Option.getOrUndefined(
                      EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.role !== 'embedding'),
                    )!
                  : manifest;
              yield* writeModelSelection(home, {version: 1, roles: {embedding: selected.id}});
            }
            yield* fs.writeFileString(resource, '# Lexical metadata\n\nLatest materialization token.\n');
            const modelStore = installedModelStore(home);
            const selectedStore =
              unavailable === 'uninstalled'
                ? LocalModelStore.of({
                    ...modelStore,
                    status: (...args) =>
                      modelStore.status(...args).pipe(Effect.map(value => ({...value, installed: false}))),
                  })
                : modelStore;
            const queries = yield* observeCandidateMaterialization;
            const outcome = yield* refreshRecallDerivedIndexesFromSelection(config, [uri]).pipe(
              Effect.provideService(LocalModelStore, selectedStore),
            );
            expect(outcome.state).toBe(unavailable === 'not-built' ? 'deferred' : 'unavailable');
            expect(queries).toHaveLength(0);
            const status = yield* recallIndexStatus(config);
            expect(status.ready).toBe(true);
            expect(recallGeneration(status)).not.toBe(initial.generation);
            const current = yield* loadRecallIndexData(config, {
              includeInactive: false,
              query: 'Latest materialization',
            });
            expect(EffectArray.map(current.candidates, candidate => candidate.uri)).toContain(uri);
            expect(
              EffectArray.some(current.candidates, candidate =>
                Effect2.pipe(candidate.text, EffectString.includes('Previous materialization token')),
              ),
            ).toBe(false);
            expect(yield* vectorIndexStatus(home, manifest)).toMatchObject({ready: false, reason: 'not built'});
          }),
        ).pipe(provideTestLayer(ApplicationLayer)),
    );
  }
  effectIt.effect('keeps lexical and selected vector indexes current after an approved metadata write', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-metadata-recall-refresh-'});
        const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/metadata-refresh.md';
        const resource = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'metadata-refresh.md',
        );
        const config = {
          account: 'local',
          agentContextHome: home,
          agentId: 'test',
          manifestPath: path.join(home, 'manifest.json'),
          user: 'tester',
        };
        yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
        yield* fs.writeFileString(
          resource,
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              memoryId: 'tn_metadata_refresh',
              project: 'threadnote',
              sourceAgentClient: 'test',
              status: 'active',
              timestamp: '2026-09-18T00:00:00.000Z',
              topic: 'metadata-refresh',
            },
            'Synthetic metadata refresh regression body.',
          ),
        );
        const runtime = fakeRuntime((inputs, dimensions) =>
          Effect.succeed(EffectArray.map(inputs, () => unitVector(dimensions))),
        );

        yield* Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          const initial = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
          yield* ensureVectorIndex(config, manifest, initial.candidates, {corpusGeneration: initial.generation});
          const preview = yield* previewMaintenanceMetadata(config, {owner: 'maintainer', uri});
          expect(preview.status).toBe('preview');
          if (preview.status !== 'preview') return;

          const applied = yield* applyMaintenanceMetadata(config, {
            approved: true,
            expectedContentHash: preview.proposal.expectedContentHash,
            owner: 'maintainer',
            proposalId: preview.proposal.proposalId,
            revision: preview.proposal.revision,
            uri,
          });

          expect(applied.status).toBe('applied');
          const refreshed = yield* recallIndexStatus(config);
          expect(refreshed.ready).toBe(true);
          expect(recallGeneration(refreshed)).not.toBe(initial.generation);
          expect(yield* vectorIndexGenerationReadiness(home, manifest, recallGeneration(refreshed))).not.toBe(
            'current',
          );
          expect((yield* readRecallEmbeddingDemand(config))?.desired).toBeDefined();
          yield* finishQueuedRecall(config);
          expect(yield* vectorIndexGenerationReadiness(home, manifest, recallGeneration(refreshed))).toBe('current');

          const replacementUri = yield* storeMemory(config, {
            bodyText: 'Synthetic direct replacement regression body.',
            dryRun: false,
            expectedReplaceContent: yield* fs.readFileString(resource),
            expectedReplaceMemoryId: 'tn_metadata_refresh',
            metadata: {
              kind: 'durable',
              memoryId: 'tn_metadata_refresh',
              project: 'threadnote',
              sourceAgentClient: 'test',
              status: 'active',
              timestamp: '2026-09-18T00:01:00.000Z',
              topic: 'metadata-refresh',
            },
            replaceUri: uri,
            title: 'MEMORY',
          });

          expect(replacementUri).toBe(uri);
          const replaced = yield* recallIndexStatus(config);
          expect(replaced.ready).toBe(true);
          expect(recallGeneration(replaced)).not.toBe(recallGeneration(refreshed));
          expect(yield* vectorIndexGenerationReadiness(home, manifest, recallGeneration(replaced))).not.toBe('current');
          expect((yield* readRecallEmbeddingDemand(config))?.desired).toBeDefined();
          yield* finishQueuedRecall(config);
          expect(yield* vectorIndexGenerationReadiness(home, manifest, recallGeneration(replaced))).toBe('current');
        }).pipe(
          Effect.provideService(LocalModelRuntime, runtime),
          Effect.provideService(LocalModelStore, installedModelStore(home)),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  for (const covered of [false, true])
    effectIt.effect(
      `restores lexical and selected installed vector indexes after a trusted mutation (covered=${covered})`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-trusted-recall-refresh-'});
            const config = {account: 'local', agentContextHome: home, user: 'tester'};
            const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'trusted.md');
            const uri = 'threadnote://resources/repos/threadnote/trusted.md';
            const store = yield* ResourceStore;
            const addedUri = 'threadnote://resources/repos/threadnote/added-during-model-check.md';
            let addDuringModelCheck = false;
            const embedded = yield* Ref.make<readonly string[]>([]);
            yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
            yield* fs.writeFileString(resource, '# Trusted mutation\n\nOriginal semantic content.\n');
            const runtime = fakeRuntime((inputs, dimensions) =>
              Ref.update(embedded, prior => [...prior, ...inputs]).pipe(
                Effect.as(EffectArray.map(inputs, () => unitVector(dimensions))),
              ),
            );
            const modelStore = installedModelStore(home);
            const observedStore = LocalModelStore.of({
              ...modelStore,
              status: (...args) =>
                Effect.gen(function* () {
                  if (addDuringModelCheck) {
                    addDuringModelCheck = false;
                    yield* store
                      .write(
                        {account: 'local', home, user: 'tester'},
                        addedUri,
                        '# Added during model check\n\nLatest unrelated corpus member.\n',
                        {mode: 'create'},
                      )
                      .pipe(Effect.orDie);
                  }
                  return yield* modelStore.status(...args);
                }),
            });

            yield* Effect.gen(function* () {
              const catalog = yield* LocalModelCatalog;
              yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
              const initial = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
              yield* ensureVectorIndex(config, manifest, initial.candidates, {corpusGeneration: initial.generation});

              let receipt: ResourceRecallInvalidationReceipt | undefined;
              if (covered) {
                const location = {account: config.account, home, user: config.user};
                const observation = makeResourceRecallInvalidationObservation(location);
                observation.expect([uri]);
                yield* store
                  .write(location, uri, '# Trusted mutation\n\nChanged semantic content.\n', {mode: 'replace'})
                  .pipe(Effect.provideService(CurrentResourceRecallInvalidationObserver, observation.observer));
                observation.verify([uri]);
                receipt = observation.finish(true, [uri]);
                expect(receipt).toBeDefined();
                // Foreground identity admission has already consumed the lexical marker;
                // selected vectors still need the changed member of the full corpus.
                yield* loadRecallIndexData(config, {includeInactive: false});
              } else {
                yield* fs.writeFileString(resource, '# Trusted mutation\n\nChanged semantic content.\n');
              }
              expect((yield* recallIndexStatus(config)).ready).toBe(true);
              yield* Ref.set(embedded, []);
              addDuringModelCheck = true;

              const outcome = yield* refreshRecallDerivedIndexesFromSelection(config, [uri], receipt);
              expect(outcome.state).toBe('deferred');
              expect(yield* Ref.get(embedded)).toEqual([]);
              yield* finishQueuedRecall(config);

              const refreshed = yield* recallIndexStatus(config);
              expect(refreshed.ready).toBe(true);
              expect(recallGeneration(refreshed)).not.toBe(initial.generation);
              expect(yield* vectorIndexGenerationReadiness(home, manifest, recallGeneration(refreshed))).toBe(
                'current',
              );
              const inputs = yield* Ref.get(embedded);
              expect(
                EffectArray.some(inputs, input =>
                  Effect2.pipe(input, EffectString.includes('Changed semantic content')),
                ),
              ).toBe(true);
              expect(
                EffectArray.some(inputs, input =>
                  Effect2.pipe(input, EffectString.includes('Latest unrelated corpus member')),
                ),
              ).toBe(true);
            }).pipe(
              Effect.provideService(LocalModelRuntime, runtime),
              Effect.provideService(LocalModelStore, observedStore),
            );
          }),
        ).pipe(provideTestLayer(ApplicationLayer)),
    );

  effectIt.effect('does not construct an absent vector index while healing lexical mutation readiness', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-trusted-lexical-only-refresh-'});
        const config = {account: 'local', agentContextHome: home, user: 'tester'};
        const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'lexical-only.md');
        const uri = 'threadnote://resources/repos/threadnote/lexical-only.md';
        yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
        yield* fs.writeFileString(resource, '# Lexical only\n\nOriginal content.\n');

        yield* Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
          yield* fs.writeFileString(resource, '# Lexical only\n\nChanged content.\n');

          yield* refreshRecallDerivedIndexesFromSelection(config, [uri]);

          expect((yield* recallIndexStatus(config)).ready).toBe(true);
          expect(yield* vectorIndexStatus(home, manifest)).toMatchObject({ready: false, reason: 'not built'});
        }).pipe(Effect.provideService(LocalModelStore, installedModelStore(home)));
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('commits lexical freshness and durable demand without waiting for a held embedding runtime', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-trusted-vector-timeout-'});
        const config = {account: 'local', agentContextHome: home, user: 'tester'};
        const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'bounded.md');
        const uri = 'threadnote://resources/repos/threadnote/bounded.md';
        yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
        yield* fs.writeFileString(resource, '# Bounded\n\nOriginal content.\n');
        const calls = yield* Ref.make(0);
        const vectorRefreshStarted = yield* Deferred.make<void>();
        const releaseVectorRefresh = yield* Deferred.make<void>();
        const refreshCompleted = yield* Deferred.make<void>();
        const runtime = fakeRuntime((inputs, dimensions) =>
          Ref.updateAndGet(calls, count => count + 1).pipe(
            Effect.flatMap(call =>
              call === 1
                ? Effect.succeed(EffectArray.map(inputs, () => unitVector(dimensions)))
                : Deferred.succeed(vectorRefreshStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseVectorRefresh)),
                    Effect.as(EffectArray.map(inputs, () => unitVector(dimensions))),
                  ),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          const initial = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
          yield* ensureVectorIndex(config, manifest, initial.candidates, {corpusGeneration: initial.generation});
          yield* fs.writeFileString(resource, '# Bounded\n\nChanged content.\n');

          const refresh = yield* refreshRecallDerivedIndexesFromSelection(config, [uri]).pipe(
            Effect.ensuring(Deferred.succeed(refreshCompleted, undefined)),
            Effect.forkScoped,
          );
          yield* Fiber.join(refresh);
          expect(Option.isSome(yield* Deferred.poll(refreshCompleted))).toBe(true);
          expect(Option.isNone(yield* Deferred.poll(vectorRefreshStarted))).toBe(true);
          const worker = yield* finishQueuedRecall(config).pipe(Effect.forkScoped);
          yield* Deferred.await(vectorRefreshStarted);
          yield* TestClock.adjust('1 second');
          yield* Effect.forEach(Array.from({length: 20}), () => Effect.yieldNow, {discard: true});
          expect(Option.isSome(yield* Deferred.poll(refreshCompleted))).toBe(true);

          const lexical = yield* recallIndexStatus(config);
          expect(lexical.ready).toBe(true);
          expect(recallGeneration(lexical)).not.toBe(initial.generation);
          expect(yield* vectorIndexGenerationReadiness(home, manifest, recallGeneration(lexical))).not.toBe('current');

          yield* Deferred.succeed(releaseVectorRefresh, undefined);
          yield* Fiber.join(worker);
          expect(yield* vectorIndexGenerationReadiness(home, manifest, recallGeneration(lexical))).toBe('current');
          expect(yield* Ref.get(calls)).toBe(2);
        }).pipe(
          Effect.provideService(LocalModelRuntime, runtime),
          Effect.provideService(LocalModelStore, installedModelStore(home)),
          Effect.ensuring(Deferred.succeed(releaseVectorRefresh, undefined)),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reruns the latest generation when a mutation coalesces into an active refresh', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeDetachedRefreshFixtureHome(fs, 'threadnote-mcp-recall-generation-rerun-');
        const config = {account: 'local', agentContextHome: home, user: 'tester'};
        const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'rerun.md');
        const uri = 'threadnote://resources/repos/threadnote/rerun.md';
        yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
        yield* fs.writeFileString(resource, '# Rerun\n\nGeneration zero.\n');

        const calls = yield* Ref.make(0);
        const firstRefreshStarted = yield* Deferred.make<void>();
        const releaseFirstRefresh = yield* Deferred.make<void>();
        const runtime = fakeRuntime((inputs, dimensions) =>
          Ref.updateAndGet(calls, count => count + 1).pipe(
            Effect.flatMap(call =>
              call === 2
                ? Deferred.succeed(firstRefreshStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstRefresh)),
                  )
                : Effect.void,
            ),
            Effect.as(EffectArray.map(inputs, () => unitVector(dimensions))),
          ),
        );

        yield* Effect.gen(function* () {
          yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
          const initial = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
          yield* ensureVectorIndex(config, manifest, initial.candidates, {corpusGeneration: initial.generation});

          yield* fs.writeFileString(resource, '# Rerun\n\nGeneration one.\n');
          yield* expireRecallIndexValidation(home, false, [uri]);
          expect(yield* scheduleMcpRecallBackgroundRefresh(config, manifest)).toBe('scheduled');
          const worker = yield* finishQueuedRecall(config).pipe(Effect.forkScoped);
          yield* Deferred.await(firstRefreshStarted);
          const firstGeneration = recallGeneration(yield* recallIndexStatus(config));
          expect(firstGeneration).toBeDefined();
          expect(firstGeneration).not.toBe(initial.generation);

          yield* fs.writeFileString(resource, '# Rerun\n\nGeneration two.\n');
          yield* expireRecallIndexValidation(home, false, [uri]);
          expect(yield* scheduleMcpRecallBackgroundRefresh(config, manifest)).toBe('coalesced');

          yield* Deferred.succeed(releaseFirstRefresh, undefined);
          const latestGeneration = yield* Fiber.join(worker);
          expect(latestGeneration).not.toBe(firstGeneration);
          expect(yield* vectorIndexGenerationReadiness(home, manifest, latestGeneration)).toBe('current');
          expect(yield* Ref.get(calls)).toBe(3);
        }).pipe(
          Effect.provideService(LocalModelRuntime, runtime),
          Effect.provideService(LocalModelStore, installedModelStore(home)),
          Effect.ensuring(Deferred.succeed(releaseFirstRefresh, undefined)),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains lexical fallback without acknowledging demand when the actual enqueue guard times out', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'mcp-recall-enqueue-held-'});
      const config = {account: 'local', agentContextHome: home, user: 'tester'};
      yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
      yield* requestRecallEmbeddings(config);
      const before = yield* readRecallEmbeddingDemand(config);
      const guard = path.join(home, 'recall', 'embedding-demand-v1', recallEmbeddingDemandKey(config) + '.lock');
      const acquired = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const contended = yield* Deferred.make<void>();
      const holder = yield* LockBoundary.withExclusiveFileLock(
        fs,
        guard,
        {
          createParentDirectory: false,
          retryIntervalMilliseconds: 10,
          staleAfterMilliseconds: 5000,
          waitTimeoutMilliseconds: 1000,
          useCanonicalProcessStartIdentity: true,
          onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
        },
        Deferred.await(release),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(acquired);
      const original = LockBoundary.withExclusiveFileLock;
      let wakes = 0;
      let embeddings = 0;
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(LockBoundary, 'withExclusiveFileLock').mockImplementation((fileSystem, lockPath, options, effect) =>
            original(
              fileSystem,
              lockPath,
              {
                ...options,
                onContention: location =>
                  Deferred.succeed(contended, undefined).pipe(
                    Effect.andThen(options.onContention?.(location) ?? Effect.void),
                  ),
              },
              effect,
            ),
          ),
        ),
        () =>
          Effect.gen(function* () {
            const caller = yield* loadMcpRecallSemanticScoresResult(config, 'held enqueue', 5).pipe(
              Effect.provideService(LocalModelStore, installedModelStore(home)),
              Effect.provideService(
                LocalModelRuntime,
                fakeRuntime((inputs, dimensions) =>
                  Effect.sync(() => {
                    embeddings++;
                    return EffectArray.map(inputs, () => unitVector(dimensions));
                  }),
                ),
              ),
              Effect.provideService(RecallEmbeddingWakePort, () =>
                Effect.sync(() => {
                  wakes++;
                }),
              ),
              Effect.forkScoped,
            );
            yield* Deferred.await(contended);
            yield* TestClock.adjust(1000);
            const result = yield* Fiber.join(caller);
            expect(result.status).toBe('failed');
            expect(Option.isNone(result.result.scores)).toBe(true);
            expect(Option.isNone(result.result.corpusGeneration)).toBe(true);
            const warning = Option.getOrElse(result.result.warning, () => '');
            expect(warning).toContain('[guard/guard-timeout]');
            expect(warning).toContain('enqueue not confirmed');
            expect(warning).not.toMatch(/queued|scheduled/u);
            expect(Buffer.byteLength(warning)).toBeLessThanOrEqual(180);
            expect(wakes).toBe(0);
            expect(embeddings).toBe(0);
            expect(yield* readRecallEmbeddingDemand(config)).toEqual(before);
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
        spy => Effect.sync(() => spy.mockRestore()),
      );
      yield* Fiber.join(holder);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'preserves unknown defects and mixed enqueue causes instead of flattening cancellation or cleanup',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'mcp-recall-enqueue-cause-'});
        const config = {account: 'local', agentContextHome: home, user: 'tester'};
        yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
        const unavailable = RecallEmbeddingDemandUnavailable.make({
          message: 'private unavailable',
          stage: 'guard',
          reason: 'guard-timeout',
        });
        const causes = [
          Cause.die(new Error('private unknown defect')),
          Cause.fromReasons([Cause.makeFailReason(unavailable), Cause.makeInterruptReason(123)]),
          Cause.fromReasons([Cause.makeFailReason(unavailable), Cause.makeDieReason({reason: 'cleanup-unconfirmed'})]),
          Cause.fromReasons([Cause.makeFailReason(unavailable), Cause.makeFailReason(unavailable)]),
        ];
        for (const cause of causes) {
          const exit = yield* Effect.acquireUseRelease(
            Effect.sync(() =>
              vi
                .spyOn(RefreshBoundary, 'scheduleMcpRecallBackgroundRefresh')
                .mockImplementation(() => Effect.failCause(cause)),
            ),
            () =>
              loadMcpRecallSemanticScoresResult(config, 'preserve failed enqueue', 5).pipe(
                Effect.provideService(LocalModelStore, installedModelStore(home)),
                Effect.exit,
              ),
            spy => Effect.sync(() => spy.mockRestore()),
          );
          expect(exit._tag).toBe('Failure');
          if (exit._tag === 'Failure') {
            const evidence = (input: Cause.Cause<unknown>) =>
              EffectArray.map(input.reasons, reason =>
                Cause.isFailReason(reason)
                  ? ['Fail', reason.error]
                  : Cause.isDieReason(reason)
                    ? ['Die', reason.defect]
                    : ['Interrupt', reason.fiberId],
              );
            expect(evidence(exit.cause)).toEqual(evidence(cause));
          }
        }
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  describe.skipIf(!nativeVectorTestsEnabled)('native semantic refresh qualification', () => {
    // The existing 20-caller example covers the interior. Exercise both bounds
    // separately so each real-SQLite fixture keeps the ordinary test deadline.
    for (const callers of [2, 24])
      effectIt.effect(
        `returns promptly and single-flights ${callers} concurrent refreshes for one canonical home${callers === 24 ? ' with a failed enqueue' : ''}`,
        () => concurrentRefreshFixture(callers, callers === 24),
      );
    effectIt.effect('fixed20 concurrent refresh diagnostic fixture preserves durable intent', () =>
      concurrentRefreshFixture(20),
    );

    effectIt.effect('builds missing lexical and vector indexes after a non-blocking first-use request', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* makeDetachedRefreshFixtureHome(fs, 'threadnote-mcp-recall-first-use-');
          const config = {account: 'local', agentContextHome: home, user: 'tester'};
          const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'first-use.md');
          yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
          yield* fs.writeFileString(resource, '# First use\n\nFirst-use semantic content.\n');
          const calls = yield* Ref.make(0);
          const runtime = fakeRuntime((inputs, dimensions) =>
            Ref.update(calls, count => count + 1).pipe(
              Effect.as(EffectArray.map(inputs, () => unitVector(dimensions))),
            ),
          );

          yield* Effect.gen(function* () {
            const catalog = yield* LocalModelCatalog;
            yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
            expect(yield* recallIndexStatus(config)).toMatchObject({
              ready: false,
              reason: 'not built; run `threadnote repair`',
            });

            const first = yield* loadMcpRecallSemanticScoresResult(config, 'first-use semantic content', 5);
            expect(first.status).toBe('unavailable');
            expect(Option.getOrUndefined(first.result.warning)).toContain('background refresh');
            const generation = yield* awaitRefreshedRecallReadiness(config);
            expect(yield* vectorIndexGenerationReadiness(home, manifest, generation)).toBe('current');

            const second = yield* loadMcpRecallSemanticScoresResult(config, 'first-use semantic content', 5);
            expect(second.status).toBe('available');
            expect(yield* Ref.get(calls)).toBeGreaterThanOrEqual(2);
          }).pipe(
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, installedModelStore(home)),
          );
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    );

    effectIt.effect('retains durable demand after a failed unit so another worker turn can retry', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* makeDetachedRefreshFixtureHome(fs, 'threadnote-mcp-recall-retry-');
          const config = {account: 'local', agentContextHome: home, user: 'tester'};
          const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'retry.md');
          yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
          yield* fs.writeFileString(resource, '# Retry\n\nRetry semantic content.\n');
          const index = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});

          const calls = yield* Ref.make(0);
          const firstAttempted = yield* Deferred.make<void>();
          const runtime = fakeRuntime((inputs, dimensions) =>
            Ref.updateAndGet(calls, count => count + 1).pipe(
              Effect.flatMap(call =>
                call === 1
                  ? Deferred.succeed(firstAttempted, undefined).pipe(
                      Effect.andThen(
                        Effect.fail(
                          EmbeddingFailed.make({
                            cause: TestError.make({message: 'synthetic background refresh failure'}),
                            message: 'Synthetic background refresh failure.',
                            modelId: manifest.id,
                          }),
                        ),
                      ),
                    )
                  : Effect.succeed(EffectArray.map(inputs, () => unitVector(dimensions))),
              ),
            ),
          );

          yield* Effect.gen(function* () {
            const catalog = yield* LocalModelCatalog;
            yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
            const first = yield* loadMcpRecallSemanticScoresResult(config, 'retry semantic content', 5);
            expect(first.status).toBe('unavailable');
            const worker = yield* finishQueuedRecall(config).pipe(Effect.forkScoped);
            yield* Deferred.await(firstAttempted);
            yield* Effect.forEach(Array.from({length: 20}), () => Effect.yieldNow, {discard: true});

            yield* Fiber.join(worker);
            const second = yield* loadMcpRecallSemanticScoresResult(config, 'retry semantic content', 5);
            expect(second.status).toBe('available');
            expect(yield* vectorIndexGenerationReadiness(home, manifest, index.generation)).toBe('current');
            expect(yield* Ref.get(calls)).toBe(3);
          }).pipe(
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, installedModelStore(home)),
          );
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    );

    effectIt.effect('leaves corrupt vector rows untouched and never schedules repair', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-recall-corrupt-'});
          const config = {account: 'local', agentContextHome: home, user: 'tester'};
          const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'corrupt.md');
          yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
          yield* fs.writeFileString(resource, '# Corrupt\n\nCorrupt semantic content.\n');
          const calls = yield* Ref.make(0);
          const runtime = fakeRuntime((inputs, dimensions) =>
            Ref.update(calls, count => count + 1).pipe(
              Effect.as(EffectArray.map(inputs, () => unitVector(dimensions))),
            ),
          );

          yield* Effect.gen(function* () {
            const catalog = yield* LocalModelCatalog;
            yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
            const index = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
            yield* ensureVectorIndex(config, manifest, index.candidates, {corpusGeneration: index.generation});
            const databasePath = path.join(home, 'indexes', 'vectors', manifest.id, vectorIndexDatabaseFilename());
            yield* Effect.sync(() => {
              const database = new Database(databasePath);
              try {
                database.exec('UPDATE vector_values SET vector = zeroblob(4)');
              } finally {
                database.close();
              }
            });

            const result = yield* loadMcpRecallSemanticScoresResult(config, 'corrupt semantic content', 5);
            expect(result.status).toBe('failed');
            expect(Option.getOrUndefined(result.result.warning)).toContain('deterministic lexical recall continued');
            yield* Effect.forEach(Array.from({length: 50}), () => Effect.yieldNow, {discard: true});
            expect(yield* Ref.get(calls)).toBe(2);
            expect((yield* vectorIndexStatus(home, manifest)).ready).toBe(false);
            expect(
              yield* Effect.sync(() => {
                const database = new Database(databasePath, {readonly: true});
                try {
                  return database.query('SELECT length(vector) AS bytes FROM vector_values').get();
                } finally {
                  database.close();
                }
              }),
            ).toEqual({bytes: 4});
          }).pipe(
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, installedModelStore(home)),
          );
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    );
  });
});

/** Observe full result materialization separately from the required lexical scan and update. */
const observeCandidateMaterialization = Effect.acquireRelease(
  Effect.sync(() => {
    const queries: string[] = [];
    const original = Database.prototype.query;
    const spy = vi.spyOn(Database.prototype, 'query').mockImplementation(function (
      this: Database,
      ...args: Parameters<Database['query']>
    ) {
      if (/SELECT\s+(?:d\.)?id,\s*(?:d\.)?uri,\s*(?:d\.)?candidate_json\s+FROM\s+documents\b/u.test(args[0]))
        queries.push(args[0]);
      return Reflect.apply(original, this, args);
    });
    return {queries, spy};
  }),
  ({spy}) => Effect.sync(() => spy.mockRestore()),
).pipe(Effect.map(({queries}) => queries));

function fakeRuntime(
  embed: (
    inputs: readonly string[],
    dimensions: number,
  ) => Effect.Effect<readonly (readonly number[])[], LocalEmbeddingError>,
) {
  return LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
    embedMany: ({inputs, manifest: requested}) => embed(inputs, requested.dimensions ?? 0),
    generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
    rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
  });
}

function installedModelStore(home: string): LocalModelStoreShape {
  const installation = {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: `${home}/models/fake.gguf`,
    verified: true,
  };
  return LocalModelStore.of({
    install: () => Effect.die(TestError.make({message: 'Unexpected install'})),
    path: () => installation.path,
    remove: () => Effect.succeed(false),
    status: () => Effect.succeed(installation),
    verify: () => Effect.succeed(installation),
  });
}

function makeDetachedRefreshFixtureHome(fs: FileSystem.FileSystem, prefix: string) {
  return Effect.acquireRelease(fs.makeTempDirectory({prefix}), directory =>
    fs.remove(directory, {force: true, recursive: true}).pipe(Effect.orDie),
  );
}

function unitVector(dimensions: number): readonly number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[0] = 1;
  return vector;
}

const finishQueuedRecall = Effect.fn('test.finishQueuedRecall')(function* (config: {
  readonly account: string;
  readonly agentContextHome: string;
  readonly user: string;
}) {
  for (let attempt = 0; attempt < 100; attempt++) {
    yield* loadRecallIndexData(config, {includeInactive: false, memoryIds: []});
    const demand = yield* readRecallEmbeddingDemand(config);
    const outcome = yield* stepRecallVectorPreparation(config, manifest, Effect.succeed(true)).pipe(Effect.result);
    if (outcome._tag === 'Success' && outcome.success.state === 'current') {
      if (demand?.desired) yield* completeRecallEmbeddingDemand(config, demand.desired.token, demand.desired.revision);
      return recallGeneration(yield* recallIndexStatus(config));
    }
  }
  return yield* TestError.make({message: 'Explicit test worker units did not converge.'});
});
const awaitRefreshedRecallReadiness = (
  config: {readonly account: string; readonly agentContextHome: string; readonly user: string},
  _previousGeneration?: string,
) => finishQueuedRecall(config);
