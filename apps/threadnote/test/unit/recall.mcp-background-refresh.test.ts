import {nativeVectorTestsEnabled} from '@threadnote/testing/native-vector-fixture';
import {EffectMcpServerRegistry} from '@threadnote/threadnote/effect/ai/mcp';
import {registerStoreTool} from '@threadnote/threadnote/mcp/server/store';
import {
  completeRecallEmbeddingDemand,
  observeRecallEmbeddingDemand,
  readRecallEmbeddingDemand,
  recallEmbeddingModelIdentity,
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
import * as RecallIndexBoundary from '@threadnote/recall/index';
import {
  refreshRecallDerivedIndexesFromSelection,
  scheduleMcpRecallBackgroundRefresh,
} from '@threadnote/recall/mcp/refresh';
import {prepareRecallSections} from '@threadnote/recall/runtime';
import {loadMcpRecallSemanticScoresResult, loadRecallSemanticScoresResult} from '@threadnote/recall/semantic_scores';
import {
  ensureVectorIndex,
  loadRecallVectorAuthorizationKey,
  recallVectorStorage,
  VectorCorpusGenerationChanged,
  vectorIndexDatabaseFilename,
  vectorIndexStatus,
} from '@threadnote/recall/vector-index';
import {
  openSelectedSemanticVectorRead,
  readSelectedSemanticVectorScores,
  readSelectedSemanticVectorState,
  vectorIndexGenerationReadiness,
} from '@threadnote/recall/vector/semantic-read';
import {negativeSemanticReadinessHint} from '@threadnote/recall/vector/negative-readiness';
import {RECALL_CHUNKER_VERSION} from '@threadnote/recall/chunker';
import {
  RECALL_MASKED_READ_MAX_URIS,
  RecallReadyReadBoundary,
  RecallReadyReadBoundaryError,
  recallReadyReadResponseSchema,
  recallVectorQueryStateSchema,
} from '@threadnote/recall/read_boundary';
import {readLocalMemoryRecordsByUri} from '@threadnote/memory/local-path';
import {Context, Record as EffectRecord} from 'effect';
import {serveRecallReadyRead} from '../../src/recall/ready_read_worker.js';
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
          const original = RefreshBoundary.scheduleMcpRecallBackgroundRefreshReceipt;
          let first = true;
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(RefreshBoundary, 'scheduleMcpRecallBackgroundRefreshReceipt').mockImplementation((...args) => {
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

  effectIt.effect('schedules a stale read as a read-triggered enqueue that keeps demand and wakes once', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'mcp-recall-read-enqueue-'});
      const config = {account: 'local', agentContextHome: home, user: 'tester'};
      const lexical = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
      yield* requestRecallEmbeddings(config);
      const desired = (yield* readRecallEmbeddingDemand(config))!.desired!;
      yield* observeRecallEmbeddingDemand(config, desired, {
        state: 'running',
        failures: 2,
        model: recallEmbeddingModelIdentity(manifest),
        corpusGeneration: recallGeneration(lexical),
      });
      const before = yield* readRecallEmbeddingDemand(config);
      let wakes = 0;
      expect(
        yield* scheduleMcpRecallBackgroundRefresh(config, manifest).pipe(
          Effect.provideService(RecallEmbeddingWakePort, () => Effect.sync(() => void wakes++)),
        ),
      ).toBe('coalesced');
      expect(yield* readRecallEmbeddingDemand(config)).toEqual(before);
      expect(wakes).toBe(1);
    }).pipe(provideTestLayer(ApplicationLayer)),
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
                .spyOn(RefreshBoundary, 'scheduleMcpRecallBackgroundRefreshReceipt')
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

// P3: masked semantic read from an older vector generation. Each fixture builds the served generation with
// the background worker, so its identity binds the current authorization key, then publishes a lexical write.
const maskedModel = {
  id: manifest.id,
  sha256: manifest.sha256,
  dimensions: manifest.dimensions ?? 0,
  promptPrefixes: manifest.promptPrefixes,
};
const STALE_WARNING =
  'Local AI recall warning: semantic indexes are stale or missing; background refresh is queued for idle. Lexical recall continued without waiting.';
const BLOCKED_WARNING =
  'Local AI recall warning: semantic indexes are stale or missing; background refresh is blocked. Lexical recall continued. Run threadnote doctor --dry-run.';

function keywordVector(input: string, dimensions: number): readonly number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const text = EffectString.toLowerCase(input);
  vector[EffectString.includes('alpha')(text) ? 0 : EffectString.includes('beta')(text) ? 1 : 2] = 1;
  return vector;
}

const maskedFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'mcp-recall-masked-'});
  // A configured manifest is part of the lexical scope; every masked read must carry it.
  const config = {account: 'local', agentContextHome: home, user: 'tester', manifestPath: path.join(home, 'm.yaml')};
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const uri = (name: string) => `threadnote://user/tester/memories/durable/${name}.md`;
  const file = (name: string) => path.join(home, 'data/local/user/tester/memories/durable', `${name}.md`);
  const write = (
    name: string,
    body: string,
    metadata: {
      readonly project?: string;
      readonly memoryId?: string;
      readonly status?: 'active' | 'archived';
      readonly topic?: string;
    } = {},
  ) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file(name)), {recursive: true});
      yield* fs.writeFileString(
        file(name),
        formatMemoryDocument(
          'MEMORY',
          {
            kind: 'durable',
            status: metadata.status ?? 'active',
            project: metadata.project ?? 'allowed',
            memoryId: metadata.memoryId ?? `tn_${name}`,
            ...(metadata.topic === undefined ? {} : {topic: metadata.topic}),
            sourceAgentClient: 'test',
            timestamp: '2026-11-04T00:00:00.000Z',
          },
          body,
        ),
      );
    });
  const remove = (name: string) => fs.remove(file(name));
  /** One ordinary lexical publication after canonical writes, as a mutation hook runs it. */
  const publish = (names: readonly string[]) =>
    Effect.gen(function* () {
      yield* expireRecallIndexValidation(home, false, EffectArray.map(names, uri));
      return recallGeneration(yield* loadRecallIndexData(config, {includeInactive: false, memoryIds: []}));
    });
  const runtime = fakeRuntime((inputs, dimensions) =>
    Effect.succeed(EffectArray.map(inputs, input => keywordVector(input, dimensions))),
  );
  const vectorDatabase = path.join(home, 'indexes', 'vectors', manifest.id, vectorIndexDatabaseFilename());
  const lexicalDatabase = Effect.gen(function* () {
    const status = yield* recallIndexStatus(config, false);
    if (status.databasePath === undefined) return yield* TestError.make({message: 'Expected a lexical database.'});
    return status.databasePath;
  });
  const useDatabase = <A>(filename: string, use: (db: Database) => A) =>
    Effect.acquireUseRelease(
      Effect.sync(() => new Database(filename)),
      db => Effect.sync(() => use(db)),
      db => Effect.sync(() => db.close()),
    );
  /** Writes the initial memories, serves them from a worker-built generation, then applies the change. */
  const prepare = (
    initial: Readonly<Record<string, string>>,
    change: Effect.Effect<readonly string[], unknown, FileSystem.FileSystem>,
  ) =>
    Effect.gen(function* () {
      yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
      for (const [name, body] of EffectRecord.toEntries(initial)) yield* write(name, body);
      yield* publish(EffectRecord.keys(initial));
      const served = yield* finishQueuedRecall(config);
      const current = yield* publish(yield* change);
      expect(current).not.toBe(served);
      return {served, current};
    });
  return {
    fs,
    path,
    home,
    config,
    uri,
    write,
    remove,
    publish,
    prepare,
    runtime,
    vectorDatabase,
    lexicalDatabase,
    useDatabase,
  };
});

const clearDemand = (config: {readonly account: string; readonly agentContextHome: string; readonly user: string}) =>
  Effect.gen(function* () {
    const desired = (yield* readRecallEmbeddingDemand(config))?.desired;
    if (desired !== undefined) yield* completeRecallEmbeddingDemand(config, desired.token, desired.revision);
  });

const provideMaskedServices =
  (f: Pick<Effect.Success<typeof maskedFixture>, 'home' | 'runtime'>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(LocalModelRuntime, f.runtime),
      Effect.provideService(LocalModelStore, installedModelStore(f.home)),
    );

/** The production worker program served in process, with the JSON transport of the real boundary. */
const inProcessReadyReadBoundary = Effect.gen(function* () {
  const context = (yield* Effect.context<Effect.Services<ReturnType<typeof serveRecallReadyRead>>>()).pipe(
    Context.omit(RecallReadyReadBoundary),
  );
  return RecallReadyReadBoundary.of({
    read: request =>
      serveRecallReadyRead(JSON.parse(JSON.stringify(request))).pipe(
        Effect.setContext(context),
        Effect.mapBoth({
          onSuccess: response =>
            Schema.decodeUnknownSync(recallReadyReadResponseSchema)(JSON.parse(JSON.stringify(response))),
          onFailure: () => RecallReadyReadBoundaryError.make({reason: 'worker-failed'}),
        }),
      ),
  });
});

const workerMaskedState = (config: {
  readonly account: string;
  readonly agentContextHome: string;
  readonly user: string;
}) =>
  Effect.gen(function* () {
    const response = yield* serveRecallReadyRead({operation: 'vector-state', config, options: {model: maskedModel}});
    expect(response.outcome).toBe('success');
    return yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(
      JSON.parse(JSON.stringify('value' in response ? response.value : null)),
    );
  });

/** A servable opening whose scores are withdrawn mid-read keeps the refresh queued on every path. */
const withdrawnScoresOnEveryPath = (older: boolean) =>
  Effect.gen(function* () {
    const f = yield* maskedFixture;
    let withdraw = false;
    const runtime = fakeRuntime((inputs, dimensions) =>
      Effect.gen(function* () {
        // The query embedding runs between the opening and the scoring: bind the identity to another key.
        if (withdraw)
          yield* f.useDatabase(f.vectorDatabase, db =>
            db.query('UPDATE vector_generations SET job_id = ?').run(`idle-recall-v2:${EffectString.repeat(64)('e')}`),
          );
        return EffectArray.map(inputs, input => keywordVector(input, dimensions));
      }),
    );
    yield* Effect.gen(function* () {
      if (older)
        yield* f.prepare(
          {keep: 'alpha keep body', edit: 'alpha edit body'},
          f.write('edit', 'alpha edit body, revised').pipe(Effect.as(['edit'])),
        );
      else {
        // A current generation: no publication after the build.
        yield* selectLocalModel(f.home, yield* LocalModelCatalog, 'embedding', manifest.id);
        yield* f.write('keep', 'alpha keep body');
        yield* f.publish(['keep']);
        yield* finishQueuedRecall(f.config);
      }
      const jobId = yield* f.useDatabase(f.vectorDatabase, db =>
        String(db.query<{job_id: string}, []>('SELECT job_id FROM vector_generations').get()?.job_id),
      );
      const boundary = yield* inProcessReadyReadBoundary;
      const cli = (withBoundary: boolean) =>
        loadRecallSemanticScoresResult(f.config, 'alpha', 5).pipe(
          Effect.map(result => ({result})),
          effect => (withBoundary ? effect.pipe(Effect.provideService(RecallReadyReadBoundary, boundary)) : effect),
        );
      const mcp = (withBoundary: boolean) =>
        loadMcpRecallSemanticScoresResult(f.config, 'alpha', 5).pipe(effect =>
          withBoundary ? effect.pipe(Effect.provideService(RecallReadyReadBoundary, boundary)) : effect,
        );
      const outcomes: unknown[] = [];
      for (const [path, read] of [
        ['mcp', mcp(false)],
        ['mcp-worker', mcp(true)],
        ['cli', cli(false)],
        ['cli-worker', cli(true)],
      ] as const) {
        yield* f.useDatabase(f.vectorDatabase, db => db.query('UPDATE vector_generations SET job_id = ?').run(jobId));
        yield* clearDemand(f.config);
        withdraw = true;
        const outcome = yield* read;
        withdraw = false;
        outcomes.push({
          path,
          scores: Option.isSome(outcome.result.scores),
          warning: Option.getOrUndefined(outcome.result.warning),
          queued: (yield* readRecallEmbeddingDemand(f.config))?.desired !== undefined,
        });
      }
      expect(outcomes).toEqual([
        {path: 'mcp', scores: false, warning: STALE_WARNING, queued: true},
        {path: 'mcp-worker', scores: false, warning: STALE_WARNING, queued: true},
        {path: 'cli', scores: false, warning: undefined, queued: true},
        {path: 'cli-worker', scores: false, warning: undefined, queued: true},
      ]);
    }).pipe(
      Effect.provideService(LocalModelRuntime, runtime),
      Effect.provideService(LocalModelStore, installedModelStore(f.home)),
    );
  }).pipe(provideTestLayer(ApplicationLayer));

describe('masked semantic read from an older vector generation', () => {
  // P3-A4: each incompatible case gives lexical results only and today's warning. These run without the native reader.
  for (const [label, mutate, warning] of [
    // Pure compatibility inputs (scope mapping, authorization key) are decision tests in vector-masked-read.test.ts.
    ['an identity without an authorization key', 'unbound', STALE_WARNING],
    ['a failed decision read', 'unreadable', STALE_WARNING],
    ['an unknown change set', 'unknown', STALE_WARNING],
    ['a mask over the cap', 'over-cap', STALE_WARNING],
    ['a changed model selection', 'model', STALE_WARNING],
    // A chunker version change makes the stored generation incompatible storage today, not merely stale.
    [
      'a chunker version change',
      'chunker',
      'Local AI recall warning: semantic index storage failed read-only validation. Lexical recall continued; no automatic repair ran. Run threadnote doctor --dry-run.',
    ],
  ] as const)
    effectIt.effect(`keeps lexical recall and today's warning for ${label}`, () =>
      Effect.gen(function* () {
        const f = yield* maskedFixture;
        yield* Effect.gen(function* () {
          const {current} = yield* f.prepare(
            {keep: 'alpha keep body', edit: 'alpha edit body'},
            f.write('edit', 'alpha edit body, revised').pipe(Effect.as(['edit'])),
          );
          const key = yield* loadRecallVectorAuthorizationKey(f.config);
          expect(yield* vectorIndexGenerationReadiness(f.home, manifest, current, key, f.config)).toBe('serving-older');
          const lexical = yield* f.lexicalDatabase;
          expect(
            (yield* readSelectedSemanticVectorState(f.config, manifest, {corpusGeneration: current}))?.mask,
          ).toEqual({
            contentGeneration: current,
            uris: [f.uri('edit')],
          });
          yield* clearDemand(f.config);
          if (mutate === 'unbound')
            yield* f.useDatabase(f.vectorDatabase, db =>
              db.query('UPDATE vector_generations SET job_id = ?').run(EffectString.repeat(64)('e')),
            );
          if (mutate === 'unreadable')
            yield* f.useDatabase(lexical, db =>
              db.exec('ALTER TABLE recall_change_entries RENAME COLUMN before_memory_id TO renamed_memory_id'),
            );
          if (mutate === 'unknown')
            yield* f.useDatabase(lexical, db => db.exec('DELETE FROM recall_change_publications'));
          if (mutate === 'over-cap')
            yield* f.useDatabase(lexical, db => {
              const insert = db.query(
                `INSERT INTO recall_change_entries (publication_sequence, uri, change_kind)
                 VALUES ((SELECT MAX(sequence) FROM recall_change_publications), ?, 'changed')`,
              );
              for (let index = 0; index < RECALL_MASKED_READ_MAX_URIS; index++) insert.run(f.uri(`missing-${index}`));
            });
          if (mutate === 'model') yield* selectLocalModel(f.home, yield* LocalModelCatalog, 'embedding', 'bge-m3-q8');
          if (mutate === 'chunker')
            yield* f.useDatabase(f.vectorDatabase, db =>
              db.query('UPDATE vector_generations SET chunker_version = ?').run(RECALL_CHUNKER_VERSION + 1),
            );
          const result = yield* loadMcpRecallSemanticScoresResult(f.config, 'alpha', 5);
          expect(Option.isNone(result.result.scores)).toBe(true);
          expect(Option.getOrUndefined(result.result.warning)).toBe(warning);
          if (mutate !== 'chunker') expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toBeDefined();
          if (mutate !== 'model' && mutate !== 'chunker')
            expect(yield* vectorIndexGenerationReadiness(f.home, manifest, current, key, f.config)).toBe('stale');
        }).pipe(provideMaskedServices(f));
      }).pipe(provideTestLayer(ApplicationLayer)),
    );

  // The worker boundary path of a refused generation is stale too, with the refresh queued.
  effectIt.effect('keeps lexical recall and the stale warning through the worker for an unbound identity', () =>
    Effect.gen(function* () {
      const f = yield* maskedFixture;
      yield* Effect.gen(function* () {
        yield* f.prepare(
          {keep: 'alpha keep body', edit: 'alpha edit body'},
          f.write('edit', 'alpha edit body, revised').pipe(Effect.as(['edit'])),
        );
        yield* f.useDatabase(f.vectorDatabase, db =>
          db.query('UPDATE vector_generations SET job_id = ?').run(EffectString.repeat(64)('e')),
        );
        yield* clearDemand(f.config);
        const boundary = yield* inProcessReadyReadBoundary;
        const result = yield* loadMcpRecallSemanticScoresResult(f.config, 'alpha', 5).pipe(
          Effect.provideService(RecallReadyReadBoundary, boundary),
        );
        expect(Option.isNone(result.result.scores)).toBe(true);
        expect(Option.getOrUndefined(result.result.warning)).toBe(STALE_WARNING);
        expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toBeDefined();
      }).pipe(provideMaskedServices(f));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  // A write that races the worker's opening is stale for that request; the in-process path propagates it.
  effectIt.effect('opens a worker read as stale when a lexical write races its masked decision', () =>
    Effect.gen(function* () {
      const f = yield* maskedFixture;
      yield* Effect.gen(function* () {
        const {current: previous} = yield* f.prepare(
          {keep: 'alpha keep body', edit: 'alpha edit body'},
          f.write('edit', 'alpha edit body, revised').pipe(Effect.as(['edit'])),
        );
        yield* f.write('edit', 'alpha edit body, revised twice');
        yield* f.publish(['edit']);
        const original = RecallIndexBoundary.currentRecallCorpusGeneration;
        let reads = 0;
        // The worker's first generation read sees the generation before the racing write.
        const response = yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi
              .spyOn(RecallIndexBoundary, 'currentRecallCorpusGeneration')
              .mockImplementation(config => (++reads === 1 ? Effect.succeedSome(previous) : original(config))),
          ),
          () => serveRecallReadyRead({operation: 'vector-state', config: f.config, options: {model: maskedModel}}),
          spy => Effect.sync(() => spy.mockRestore()),
        );
        expect(reads).toBeGreaterThanOrEqual(1);
        expect(response.outcome).toBe('success');
        expect('value' in response ? response.value : undefined).toEqual({
          readiness: 'stale',
          corpusGeneration: previous,
        });
      }).pipe(provideMaskedServices(f));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  // Contract 8: a read that joins a blocked demand must not claim that the refresh is queued.
  effectIt.effect('says the background refresh is blocked when a stale read joins a blocked demand', () =>
    Effect.gen(function* () {
      const f = yield* maskedFixture;
      yield* Effect.gen(function* () {
        const {current} = yield* f.prepare(
          {keep: 'alpha keep body'},
          f.write('keep', 'alpha keep body, revised').pipe(Effect.as(['keep'])),
        );
        yield* f.useDatabase(f.vectorDatabase, db =>
          db.query('UPDATE vector_generations SET job_id = ?').run(EffectString.repeat(64)('e')),
        );
        const queued = yield* loadMcpRecallSemanticScoresResult(f.config, 'alpha', 5);
        expect(Option.getOrUndefined(queued.result.warning)).toBe(STALE_WARNING);
        const desired = (yield* readRecallEmbeddingDemand(f.config))!.desired!;
        yield* observeRecallEmbeddingDemand(f.config, desired, {
          state: 'blocked',
          reason: 'embedding-preparation-failed',
          failures: 8,
          model: recallEmbeddingModelIdentity(manifest),
          corpusGeneration: current,
        });
        const blocked = yield* loadMcpRecallSemanticScoresResult(f.config, 'alpha', 5);
        expect(blocked.status).toBe('unavailable');
        expect(Option.getOrUndefined(blocked.result.warning)).toBe(BLOCKED_WARNING);
        expect(new TextEncoder().encode(BLOCKED_WARNING).byteLength).toBeLessThanOrEqual(180);
        expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toEqual(desired);
      }).pipe(provideMaskedServices(f));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  // A mask computed for a newer lexical generation never serves an older requested one.
  effectIt.effect('binds a masked read to exactly the requested lexical generation', () =>
    Effect.gen(function* () {
      const f = yield* maskedFixture;
      yield* Effect.gen(function* () {
        const {current: previous} = yield* f.prepare(
          {keep: 'alpha keep body', edit: 'alpha edit body'},
          f.write('edit', 'alpha edit body, revised').pipe(Effect.as(['edit'])),
        );
        yield* f.write('edit', 'alpha edit body, revised twice');
        expect(yield* f.publish(['edit'])).not.toBe(previous);
        const key = yield* loadRecallVectorAuthorizationKey(f.config);
        expect(yield* vectorIndexGenerationReadiness(f.home, manifest, previous, key, f.config)).toBe('stale');
        // A publication after the requested generation raced the read: it propagates to the retry loop.
        const raced = yield* readSelectedSemanticVectorState(f.config, manifest, {corpusGeneration: previous}).pipe(
          Effect.flip,
        );
        expect(Schema.is(VectorCorpusGenerationChanged)(raced)).toBe(true);
        const opening = yield* openSelectedSemanticVectorRead(f.config, manifest, {corpusGeneration: previous}).pipe(
          Effect.flip,
        );
        expect(Schema.is(VectorCorpusGenerationChanged)(opening)).toBe(true);
      }).pipe(provideMaskedServices(f));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  // Item 6 parity: a masked opening whose scores are withdrawn mid-read keeps the refresh queued on every path.
  effectIt.effect('queues the refresh on every path when a masked read loses its scores mid-read', () =>
    withdrawnScoresOnEveryPath(true),
  );

  // P3-A6 (snapshot fence): a masked result is accepted only for the lexical snapshot of its mask generation.
  effectIt.effect('accepts a masked result only for the lexical snapshot its mask was computed for', () =>
    Effect.gen(function* () {
      const f = yield* maskedFixture;
      yield* Effect.gen(function* () {
        const {current} = yield* f.prepare(
          {keep: 'alpha keep body', edit: 'alpha edit body'},
          f.write('edit', 'alpha edit body, revised').pipe(Effect.as(['edit'])),
        );
        const sections = (corpusGeneration: string) =>
          prepareRecallSections(f.config, {
            query: 'alpha keep',
            feedbackQuery: 'alpha keep',
            limit: 5,
            includeInactive: false,
            allowExactRescue: false,
            exactMatches: [],
            passes: [],
            semanticResult: Option.some({
              corpusGeneration: Option.some(corpusGeneration),
              scores: Option.some(new Map([[f.uri('keep'), 1]])),
              warning: Option.none(),
            }),
            semanticGenerationMismatchPolicy: 'fallback',
            readRecords: uris => readLocalMemoryRecordsByUri(f.config, uris),
          });
        const matching = yield* sections(current);
        expect(Option.getOrUndefined(matching.semanticResult.scores)?.get(f.uri('keep'))).toBe(1);
        const mismatched = yield* sections('another-lexical-generation');
        expect(Option.isNone(mismatched.semanticResult.scores)).toBe(true);
      }).pipe(provideMaskedServices(f));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  describe.skipIf(!nativeVectorTestsEnabled)('native masked scoring', () => {
    // A current read whose scores are withdrawn mid-read (native read absent) behaves the same on every path.
    effectIt.effect('queues the refresh on every path when a current read loses its scores mid-read', () =>
      withdrawnScoresOnEveryPath(false),
    );

    // P3-A1, P3-A2 and P3-A5: one write, then every read path serves the unchanged memory only.
    effectIt.effect('serves unchanged memories through every path and masks changed, removed and moved ones', () =>
      Effect.gen(function* () {
        const f = yield* maskedFixture;
        yield* Effect.gen(function* () {
          const {served, current} = yield* f.prepare(
            {
              keep: 'alpha keep body',
              edit: 'alpha edit body',
              gone: 'alpha gone body',
              archive: 'alpha archive body',
              moved: 'alpha moved body',
            },
            Effect.gen(function* () {
              yield* f.write('edit', 'alpha edit body, revised');
              yield* f.remove('gone');
              yield* f.write('archive', 'alpha archive body', {status: 'archived'});
              yield* f.write('moved', 'alpha moved body', {project: 'elsewhere'});
              return ['edit', 'gone', 'archive', 'moved'];
            }),
          );
          const key = yield* loadRecallVectorAuthorizationKey(f.config);
          expect(yield* vectorIndexGenerationReadiness(f.home, manifest, current, key, f.config)).toBe('serving-older');
          const preflight = {
            model: maskedModel,
            readiness: yield* negativeSemanticReadinessHint(f.config, maskedModel, recallVectorStorage),
          };
          expect(preflight.readiness).toBe('unknown');
          const expected = [[f.uri('keep'), 1]];

          const opening = yield* workerMaskedState(f.config);
          expect(opening).toMatchObject({
            readiness: 'serving-older',
            corpusGeneration: current,
            state: {
              corpusGeneration: served,
              mask: {
                contentGeneration: current,
                uris: [f.uri('archive'), f.uri('edit'), f.uri('gone'), f.uri('moved')],
              },
            },
          });
          if (opening.readiness !== 'serving-older') return yield* TestError.make({message: 'Expected a mask.'});
          const worker = yield* serveRecallReadyRead({
            operation: 'vector-scores',
            config: f.config,
            options: {
              model: maskedModel,
              state: opening.state,
              queryVector: keywordVector('alpha', maskedModel.dimensions),
            },
          });
          expect(worker.outcome).toBe('success');
          expect('value' in worker ? worker.value : undefined).toEqual(expected);

          const mcp = yield* loadMcpRecallSemanticScoresResult(f.config, 'alpha', 5, undefined, undefined, preflight);
          expect(mcp.status).toBe('available');
          expect(Option.getOrUndefined(mcp.result.warning)).toBeUndefined();
          expect(Option.getOrUndefined(mcp.result.corpusGeneration)).toBe(current);
          expect([...Option.getOrThrow(mcp.result.scores)]).toEqual(expected);

          const boundary = yield* inProcessReadyReadBoundary;
          const viaWorker = yield* loadMcpRecallSemanticScoresResult(
            f.config,
            'alpha',
            5,
            undefined,
            undefined,
            preflight,
          ).pipe(Effect.provideService(RecallReadyReadBoundary, boundary));
          expect(viaWorker.status).toBe('available');
          expect(Option.getOrUndefined(viaWorker.result.warning)).toBeUndefined();
          expect(Option.getOrUndefined(viaWorker.result.corpusGeneration)).toBe(current);
          expect([...Option.getOrThrow(viaWorker.result.scores)]).toEqual(expected);

          const cli = yield* loadRecallSemanticScoresResult(f.config, 'alpha', 5, undefined, undefined, preflight);
          expect(Option.getOrUndefined(cli.warning)).toBeUndefined();
          expect(Option.getOrUndefined(cli.corpusGeneration)).toBe(current);
          expect([...Option.getOrThrow(cli.scores)]).toEqual(expected);

          // The masked read keeps the read-triggered refresh queued.
          const desired = (yield* readRecallEmbeddingDemand(f.config))?.desired;
          expect(desired).toBeDefined();
          // A masked read that joins a blocked refresh keeps its scores and says that the refresh is blocked.
          if (desired === undefined) return yield* TestError.make({message: 'Expected queued demand.'});
          yield* observeRecallEmbeddingDemand(f.config, desired, {
            state: 'blocked',
            reason: 'embedding-preparation-failed',
            failures: 8,
            model: recallEmbeddingModelIdentity(manifest),
            corpusGeneration: current,
          });
          const blocked = yield* loadMcpRecallSemanticScoresResult(
            f.config,
            'alpha',
            5,
            undefined,
            undefined,
            preflight,
          );
          expect([...Option.getOrThrow(blocked.result.scores)]).toEqual(expected);
          expect(Option.isSome(blocked.result.warning)).toBe(true);
        }).pipe(provideMaskedServices(f));
      }).pipe(provideTestLayer(ApplicationLayer)),
    );

    // P3-A2, independent of the mask: the current lexical document decides eligibility.
    effectIt.effect('drops a URI that the current lexical document excludes when the change log is empty', () =>
      Effect.gen(function* () {
        const f = yield* maskedFixture;
        yield* Effect.gen(function* () {
          const {current} = yield* f.prepare(
            {keep: 'alpha keep body', drift: 'alpha drift body'},
            f.write('drift', 'alpha drift body', {project: 'denied'}).pipe(Effect.as(['drift'])),
          );
          yield* f.useDatabase(yield* f.lexicalDatabase, db => db.exec('DELETE FROM recall_change_entries'));
          const opening = yield* workerMaskedState(f.config);
          expect(opening).toMatchObject({
            readiness: 'serving-older',
            state: {mask: {contentGeneration: current, uris: []}},
          });
          const eligibility = {
            kind: 'candidate-policy' as const,
            authority: 'any' as const,
            projects: {mode: 'allow-projects-and-projectless' as const, projects: ['allowed']},
          };
          const result = yield* loadMcpRecallSemanticScoresResult(f.config, 'alpha', 5, eligibility);
          expect([...Option.getOrThrow(result.result.scores)]).toEqual([[f.uri('keep'), 1]]);
        }).pipe(provideMaskedServices(f));
      }).pipe(provideTestLayer(ApplicationLayer)),
    );

    // P3-A3: a changed group member masks its group; a new member that joins an unchanged memory masks it.
    effectIt.effect('masks a whole old group and the unchanged memory that a new member joins', () =>
      Effect.gen(function* () {
        const f = yield* maskedFixture;
        yield* Effect.gen(function* () {
          // Equal memory ID, body and topic form one logical group; the vector index stores it as aliases.
          const twin = {memoryId: 'tn_twin', topic: 'twin'};
          const solo = {memoryId: 'tn_solo', topic: 'solo'};
          yield* f.write('twin-a', 'alpha twin body', twin);
          yield* f.write('twin-b', 'alpha twin body', twin);
          yield* f.write('solo', 'alpha solo body', solo);
          const {current} = yield* f.prepare(
            {keep: 'alpha keep body'},
            Effect.gen(function* () {
              yield* f.write('twin-b', 'alpha twin body, revised', twin);
              yield* f.write('joiner', 'alpha solo body', solo);
              return ['twin-b', 'joiner'];
            }),
          );
          const aliases = yield* f.useDatabase(f.vectorDatabase, db =>
            db.query('SELECT uri, representative_uri FROM vector_aliases ORDER BY uri').all(),
          );
          expect(aliases).toContainEqual({uri: f.uri('twin-b'), representative_uri: f.uri('twin-a')});
          const opening = yield* workerMaskedState(f.config);
          expect(opening).toMatchObject({
            readiness: 'serving-older',
            state: {
              mask: {
                contentGeneration: current,
                uris: [f.uri('joiner'), f.uri('solo'), f.uri('twin-a'), f.uri('twin-b')],
              },
            },
          });
          const result = yield* loadMcpRecallSemanticScoresResult(f.config, 'alpha', 5);
          expect([...Option.getOrThrow(result.result.scores)]).toEqual([[f.uri('keep'), 1]]);
        }).pipe(provideMaskedServices(f));
      }).pipe(provideTestLayer(ApplicationLayer)),
    );

    // P3-A3 defense in depth: an alias row of a masked URI never takes its unmasked representative's score.
    effectIt.effect('excludes a masked alias row whose representative is not masked', () =>
      Effect.gen(function* () {
        const f = yield* maskedFixture;
        yield* Effect.gen(function* () {
          yield* selectLocalModel(f.home, yield* LocalModelCatalog, 'embedding', manifest.id);
          yield* f.write('rep', 'alpha rep body');
          yield* f.write('side', 'beta side body');
          const generation = yield* f.publish(['rep', 'side']);
          yield* finishQueuedRecall(f.config);
          yield* f.useDatabase(f.vectorDatabase, db =>
            db.query('UPDATE vector_aliases SET representative_uri = ? WHERE uri = ?').run(f.uri('rep'), f.uri('side')),
          );
          const state = yield* readSelectedSemanticVectorState(f.config, manifest, {corpusGeneration: generation});
          if (state === undefined) return yield* TestError.make({message: 'Expected a current vector state.'});
          const scores = yield* readSelectedSemanticVectorScores(
            f.config,
            manifest,
            {...state, mask: {contentGeneration: generation, uris: [f.uri('side')]}},
            Option.some(keywordVector('alpha', maskedModel.dimensions)),
            {corpusGeneration: generation},
          );
          expect([...(scores ?? [])]).toEqual([[f.uri('rep'), 1]]);
        }).pipe(provideMaskedServices(f));
      }).pipe(provideTestLayer(ApplicationLayer)),
    );

    // P3-A6: a lexical publication during a masked read discards its scores on every path.
    effectIt.effect('discards masked scores when the lexical generation changes during the read', () =>
      Effect.gen(function* () {
        const f = yield* maskedFixture;
        yield* Effect.gen(function* () {
          const {current} = yield* f.prepare(
            {keep: 'alpha keep body', edit: 'alpha edit body'},
            f.write('edit', 'alpha edit body, revised').pipe(Effect.as(['edit'])),
          );
          const state = yield* readSelectedSemanticVectorState(f.config, manifest, {corpusGeneration: current});
          expect(state?.mask?.contentGeneration).toBe(current);
          const opening = yield* workerMaskedState(f.config);
          if (state === undefined || opening.readiness !== 'serving-older')
            return yield* TestError.make({message: 'Expected a masked opening.'});
          yield* f.write('edit', 'alpha edit body, revised twice');
          const next = yield* f.publish(['edit']);
          expect(next).not.toBe(current);
          const vector = keywordVector('alpha', maskedModel.dimensions);
          const query = Option.some(vector);
          // Without a caller fence callback, too.
          const direct = yield* readSelectedSemanticVectorScores(f.config, manifest, state, query, {
            corpusGeneration: current,
          }).pipe(Effect.flip);
          expect(Schema.is(VectorCorpusGenerationChanged)(direct)).toBe(true);
          const worker = yield* serveRecallReadyRead({
            operation: 'vector-scores',
            config: f.config,
            options: {model: maskedModel, state: opening.state, queryVector: vector},
          });
          expect(worker.outcome).toBe('failed');
          expect('value' in worker ? worker.value : undefined).toBeUndefined();
        }).pipe(provideMaskedServices(f));
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  });
});
