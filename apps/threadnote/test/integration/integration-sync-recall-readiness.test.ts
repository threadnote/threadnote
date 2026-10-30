import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Console, Effect, FileSystem, Option, Path, Ref, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import * as FC from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {EmbeddingFailed} from '@threadnote/inference/engine/errors';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {writeModelSelection} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {SourceCoordinator, type SourceWorkResult} from '@threadnote/integration-core/source-coordinator';
import {makeCoordinatorEngine, openCoordinatorStore} from '@threadnote/integration-runtime/coordinator';
import {loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import {ensureVectorIndex, vectorIndexGenerationReadiness} from '@threadnote/recall/vector-index';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  externalDocumentManifestUri,
  readExternalDocumentManifest,
  serializeExternalDocumentManifest,
} from '@threadnote/store/external-resource';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  sourceWorkRegistrations,
  sourceRecallDeferredWarning,
  withSourceRecallCompletion,
  withSourceRecallWarnings,
} from '@threadnote/threadnote/integrations/coordinator';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const uri = 'threadnote://user/fixture/memories/durable/projects/threadnote/source-anchor.md';
const memory = (text: string) =>
  `MEMORY\nkind: durable\nstatus: active\nvisibility: personal\nproject: threadnote\ntopic: source-anchor\nmemory_id: tn_source_anchor\n\n${text}\n`;
const embedding = Option.getOrThrow(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, value => value.id === 'bge-small-en-v1.5-q8'),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const config: RuntimeConfig = {
    account: 'local',
    user: 'fixture',
    agentId: 'test',
    agentContextHome: home,
    manifestPath: path.join(home, 'manifest.yaml'),
  };
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const store = yield* ResourceStore;
  const location = {home, account: config.account, user: config.user};
  yield* store.write(location, uri, memory('Original source anchor.'), {mode: 'create'});
  yield* loadRecallIndexData(config, {includeInactive: false});
  const receipt = (fetchedAt: number) =>
    store.write(
      location,
      externalDocumentManifestUri('source-one', 'doc-one'),
      serializeExternalDocumentManifest({
        version: 1,
        sourceId: 'source-one',
        documentId: 'doc-one',
        configFingerprint: EffectString.repeat(64)('a'),
        status: 'active',
        fetchedAt,
        maxStaleMilliseconds: 300_000,
        chunks: {},
      }),
      {mode: 'upsert'},
    );
  const generation = () => readCanonicalMutationGeneration(fs, path, home, config.account);
  return {config, home, store, location, receipt, generation};
});

function quantum<R>(config: RuntimeConfig, work: Effect.Effect<SourceWorkResult, unknown, R>) {
  return Effect.gen(function* () {
    const descriptor = {
      provider: 'synthetic',
      sourceId: 'source-one',
      accountKey: 'account',
      fingerprint: 'fingerprint',
      refreshIntervalMs: 60_000,
    };
    const store = yield* openCoordinatorStore(config);
    const [ticket] = yield* store.enqueue(config, [descriptor], 'explicit');
    const registration = withSourceRecallCompletion({
      provider: descriptor.provider,
      list: () => Effect.succeed([descriptor]),
      run: () => work,
    });
    const engine = yield* makeCoordinatorEngine({store, registrations: [registration]});
    yield* engine.dispatch;
    yield* engine.consume;
    return {reply: engine.result(ticket), receipt: yield* store.receipt(ticket)};
  });
}

const result = (value: unknown = {provider: true}): SourceWorkResult => ({
  sourceId: 'source-one',
  syncedDocuments: ['doc-one'],
  warnings: ['provider warning'],
  value,
});
function withEmbedding<A, E, R>(
  home: string,
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly fail?: Ref.Ref<boolean>;
  } = {},
) {
  const installation = {
    bytes: embedding.size,
    installed: true,
    modelId: embedding.id,
    partialBytes: 0,
    path: `${home}/fake-model.gguf`,
    verified: true,
  };
  const unexpected = () => Effect.die(TestError.make({message: 'Unexpected model operation'}));
  const runtime = LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 1}),
    embedMany: ({inputs}) =>
      (options.fail ? Ref.get(options.fail) : Effect.succeed(false)).pipe(
        Effect.flatMap(failed =>
          failed
            ? Effect.fail(
                EmbeddingFailed.make({
                  cause: TestError.make({message: 'Synthetic embedding failure'}),
                  message: 'Synthetic embedding failure',
                  modelId: embedding.id,
                }),
              )
            : Effect.succeed(
                EffectArray.map(inputs, () =>
                  Array.from({length: embedding.dimensions ?? 0}, (_, i) => (i === 0 ? 1 : 0)),
                ),
              ),
        ),
      ),
    generate: unexpected,
    rerank: unexpected,
  });
  const store = LocalModelStore.of({
    install: unexpected,
    remove: unexpected,
    path: () => installation.path,
    status: () => Effect.succeed(installation),
    verify: () => Effect.succeed(installation),
  });
  return effect.pipe(Effect.provideService(LocalModelRuntime, runtime), Effect.provideService(LocalModelStore, store));
}

describe('integration source recall completion', () => {
  effectIt.effect('completes JSON-only receipt writes without changing source Markdown or provider value', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const original = yield* f.store.read(f.location, uri);
      const before = yield* f.generation();
      const value = {opaque: 'unchanged', warnings: ['provider warning']};
      const observed = yield* quantum(f.config, f.receipt(2).pipe(Effect.as(result(value))));
      expect(yield* f.generation()).not.toBe(before);
      expect(yield* f.store.read(f.location, uri)).toBe(original);
      expect(yield* recallIndexStatus(f.config, false)).toMatchObject({ready: true, documentCount: 1});
      expect(observed.receipt?.failed).toBe(false);
      expect(observed.reply?.warnings).toEqual(['provider warning']);
      expect(observed.reply?.value).toBe(value);
      expect(sourceWorkRegistrations).toHaveLength(5);
      expect(EffectArray.every(sourceWorkRegistrations, registration => registration.completion !== undefined)).toBe(
        true,
      );
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('refreshes partial canonical writes while preserving provider failure signaling', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const observed = yield* quantum(
        f.config,
        f.receipt(3).pipe(Effect.andThen(Effect.fail(TestError.make({message: 'provider rejected'})))),
      );
      expect(observed.receipt?.failed).toBe(true);
      expect(yield* recallIndexStatus(f.config, false)).toMatchObject({ready: true});
      expect((yield* readExternalDocumentManifest(f.location, 'source-one', 'doc-one'))?.fetchedAt).toBe(3);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('refreshes an existing selected vector generation after a source quantum', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* withEmbedding(
        f.home,
        Effect.gen(function* () {
          yield* writeModelSelection(f.home, {version: 1, roles: {embedding: embedding.id}});
          const initial = yield* loadRecallIndexData(f.config, {includeInactive: false});
          yield* ensureVectorIndex(f.config, embedding, initial.candidates, {corpusGeneration: initial.generation});
          yield* quantum(
            f.config,
            f.store
              .write(f.location, uri, memory('New selected-vector anchor.'), {mode: 'replace'})
              .pipe(Effect.as(result())),
          );
          const current = yield* recallIndexStatus(f.config, false);
          expect(current.ready).toBe(true);
          expect(yield* vectorIndexGenerationReadiness(f.home, embedding, current.generation!)).toBe('current');
        }),
      );
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('delivers the fixed deferred warning without changing the explicit provider value', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fail = yield* Ref.make(false);
      yield* withEmbedding(
        f.home,
        Effect.gen(function* () {
          yield* writeModelSelection(f.home, {version: 1, roles: {embedding: embedding.id}});
          const initial = yield* loadRecallIndexData(f.config, {includeInactive: false});
          yield* ensureVectorIndex(f.config, embedding, initial.candidates, {corpusGeneration: initial.generation});
          yield* Ref.set(fail, true);
          const value = {opaque: 'provider value', warnings: ['provider warning']};
          const observed = yield* quantum(
            f.config,
            f.store
              .write(f.location, uri, memory('Committed despite derived failure.'), {mode: 'replace'})
              .pipe(Effect.as(result(value))),
          );
          const reply = observed.reply!;
          expect(reply.warnings).toEqual(['provider warning', sourceRecallDeferredWarning]);
          expect(reply.value).toBe(value);
          expect(observed.receipt?.failed).toBe(false);
          expect(yield* f.store.read(f.location, uri)).toContain('Committed despite derived failure.');
          const warnings: unknown[][] = [];
          const parent = yield* Console.Console;
          const client = withSourceRecallWarnings(
            SourceCoordinator.of({requestRefresh: () => Effect.void, sync: () => Effect.succeed(reply)}),
          );
          const delivered = yield* client.sync(f.config, 'source-one').pipe(
            Effect.provideService(Console.Console, {
              ...parent,
              warn: (...args) => {
                warnings.push([...args]);
              },
            }),
          );
          expect(delivered).toBe(reply);
          expect(delivered.value).toBe(value);
          expect(warnings).toEqual([[sourceRecallDeferredWarning]]);
          const lexical = yield* recallIndexStatus(f.config, false);
          expect(yield* vectorIndexGenerationReadiness(f.home, embedding, lexical.generation!)).toBe('stale');
        }),
        {fail},
      );
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  fcEffectProp(
    effectIt,
    'keeps independent content and mutation-clock invariants through bounded source/no-op quanta',
    {steps: FC.array(FC.boolean(), {minLength: 1, maxLength: 4})},
    ({steps}) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        let expected = 'Original source anchor.';
        for (let i = 0; i < steps.length; i++) {
          const before = yield* f.generation();
          if (steps[i]) expected = `Source anchor ${i}.`;
          const write = steps[i] ? f.store.write(f.location, uri, memory(expected), {mode: 'replace'}) : Effect.void;
          yield* quantum(f.config, write.pipe(Effect.as(result())));
          const after = yield* f.generation();
          expect(after === before).toBe(!steps[i]);
          expect(yield* recallIndexStatus(f.config, false)).toMatchObject({ready: true, documentCount: 1});
          const index = yield* loadRecallIndexData(f.config, {includeInactive: false});
          expect(index.candidates[0]?.text).toContain(expected);
          expect(yield* fs.exists(path.join(f.home, 'models'))).toBe(false);
        }
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {fastCheck: {numRuns: 6}},
  );
});
