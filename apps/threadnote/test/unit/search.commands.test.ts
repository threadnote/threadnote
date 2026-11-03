import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Clock,
  Console,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
} from 'effect';
import * as EffectString from 'effect/String';
import {SecureRandom} from 'effect/crypto';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {describe, expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {systemLayer} from '../../src/effect/runtime-bootstrap.js';
import {runIndexRebuild} from '../../src/search/commands.js';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {InferenceInterrupted} from '@threadnote/inference/engine/errors';
import {writeModelSelection} from '@threadnote/inference/models/selection';
import {expireRecallIndexValidation, recallIndexStatus} from '@threadnote/recall/index';
import {vectorIndexGenerationReadiness, vectorIndexStatus} from '@threadnote/recall/vector-index';
import {
  ExternalSourcePolicy,
  externalDocumentManifestUri,
  externalResourceUri,
  renderExternalResource,
  serializeExternalDocumentManifest,
} from '@threadnote/store/external-resource';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const manifest = {
  ...Option.getOrThrow(EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.role === 'embedding')),
  dimensions: 2,
};
const alternate = {...manifest, id: 'alternate-embedding'};
const generation = Option.getOrThrow(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.role === 'generation'),
);
const platform = Layer.mergeAll(
  BunServices.layer,
  cryptoLayer,
  systemLayer,
  LocalModelCatalog.layer([manifest, alternate, generation]),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-index-command-'});
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    user: 'test',
    manifestPath: path.join(home, 'seed-manifest.yaml'),
  };
  const resource = path.join(home, 'data/local/resources/repos/demo/document.md');
  yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
  yield* fs.writeFileString(resource, '# Example\n\nA synthetic canonical document.');
  yield* writeModelSelection(home, {version: 1, roles: {embedding: manifest.id}});
  let beforeEmbedding = Effect.void;
  let failEmbedding = false;
  let embeddedInputs = 0;
  let accessEnabled = true;
  let policyReads = 0;
  let changeAccessOnRead = 0;
  const output: string[] = [];
  const installation = {
    bytes: 1,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: path.join(home, 'fixture.gguf'),
    verified: true,
  };
  const store = LocalModelStore.of({
    install: () => Effect.die('Unexpected model installation'),
    path: () => installation.path,
    remove: () => Effect.die('Unexpected model removal'),
    status: () => Effect.succeed(installation),
    verify: () => Effect.succeed(installation),
  });
  const runtime = LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 1}),
    embedMany: request =>
      Effect.gen(function* () {
        yield* beforeEmbedding;
        if (failEmbedding)
          return yield* InferenceInterrupted.make({
            message: 'Synthetic embedding failure',
            modelId: request.manifest.id,
            operation: 'embedMany',
          });
        embeddedInputs += request.inputs.length;
        return EffectArray.map(request.inputs, input =>
          Option.getOrThrow(EffectString.charCodeAt(0)(sha256HexSync(input))) % 2 === 0 ? [1, 0] : [0, 1],
        );
      }),
    generate: () => Effect.die('Unexpected generation'),
    rerank: () => Effect.die('Unexpected reranking'),
  });
  const policy = ExternalSourcePolicy.of({
    current: () =>
      Effect.sync(() => {
        policyReads += 1;
        if (policyReads === changeAccessOnRead) accessEnabled = !accessEnabled;
        return {enabled: accessEnabled, configFingerprint: EffectString.repeat(64)('a'), project: 'demo'};
      }),
  });
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom | SystemInfo>();
  const run = (options: {readonly model?: string} = {}) =>
    Console.consoleWith(parent =>
      runIndexRebuild(config, options).pipe(
        Effect.provideService(LocalModelStore, store),
        Effect.provideService(LocalModelRuntime, runtime),
        Effect.provideService(ExternalSourcePolicy, policy),
        Effect.provideService(Console.Console, {
          ...parent,
          log: (...args) => {
            output.push(EffectArray.join(EffectArray.map(args, String), ' '));
          },
        }),
      ),
    );
  const addExternal = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const metadata = {
      version: 1 as const,
      sourceId: 'source',
      documentId: 'doc',
      pageId: 'page',
      chunkId: 'chunk',
      project: 'demo',
      title: 'Synthetic external',
      rendererVersion: '1',
      scrubberVersion: '1',
      coverage: 'canvas-plain-text' as const,
    };
    const uri = externalResourceUri(metadata);
    const bytes = renderExternalResource(metadata, 'Synthetic external content.');
    const filename = (value: string) => path.join(home, 'data/local/resources', new URL(value).pathname);
    for (const [name, text] of [
      [filename(uri), bytes],
      [
        filename(externalDocumentManifestUri('source', 'doc')),
        serializeExternalDocumentManifest({
          version: 1,
          sourceId: 'source',
          documentId: 'doc',
          configFingerprint: EffectString.repeat(64)('a'),
          status: 'active',
          fetchedAt: now,
          maxStaleMilliseconds: 60_000,
          chunks: {[uri]: sha256HexSync(bytes)},
        }),
      ],
    ]) {
      yield* fs.makeDirectory(path.dirname(name), {recursive: true});
      yield* fs.writeFileString(name, text);
    }
  });
  return {
    fs,
    home,
    config,
    resource,
    output,
    run,
    addExternal,
    embeddedInputs: () => embeddedInputs,
    failEmbedding: () => {
      failEmbedding = true;
    },
    changeAccess: () => {
      accessEnabled = !accessEnabled;
    },
    changeAccessDuringLexical: () => {
      changeAccessOnRead = 2;
    },
    beforeEmbedding: (
      effect: Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom | SystemInfo>,
    ) => {
      beforeEmbedding = effect.pipe(Effect.provide(context), Effect.orDie);
    },
  };
});

const test = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(platform).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context))))).pipe(
    TestClock.withLive,
  );

describe('foreground index rebuild', () => {
  effectIt.effect('waits for embedding and verifies both indexes before reporting ready', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.beforeEmbedding(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))));
        const fiber = yield* f.run().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        expect(EffectArray.some(f.output, EffectString.includes('indexes are ready'))).toBe(false);
        expect((yield* recallIndexStatus(f.config)).ready).toBe(true);
        expect((yield* vectorIndexStatus(f.home, manifest)).ready).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        const lexical = yield* recallIndexStatus(f.config);
        expect(lexical.ready).toBe(true);
        expect(yield* vectorIndexGenerationReadiness(f.home, manifest, lexical.generation!)).toBe('current');
        expect(f.output.at(-1)).toBe(`Lexical and vector recall indexes are ready for ${manifest.id}.`);
      }),
    ),
  );

  effectIt.effect('fails missing and non-embedding selections without claiming readiness', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* writeModelSelection(f.home, {version: 1, roles: {}});
        const missing = yield* f.run().pipe(Effect.result);
        const wrong = yield* f.run({model: generation.id}).pipe(Effect.result);
        expect(Result.isFailure(missing)).toBe(true);
        expect(Result.isFailure(wrong)).toBe(true);
        expect(f.embeddedInputs()).toBe(0);
        expect(f.output).toEqual([]);
      }),
    ),
  );

  effectIt.effect('does not report ready after an embedding failure', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.failEmbedding();
        expect(Result.isFailure(yield* f.run().pipe(Effect.result))).toBe(true);
        expect(EffectArray.some(f.output, EffectString.includes('indexes are ready'))).toBe(false);
        expect((yield* vectorIndexStatus(f.home, manifest)).ready).toBe(false);
      }),
    ),
  );

  effectIt.effect('rejects a default-model change during embedding but preserves explicit --model semantics', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.run();
        const previous = yield* vectorIndexStatus(f.home, manifest);
        yield* f.fs.writeFileString(f.resource, '# Changed\n\nA new synthetic input.');
        f.output.length = 0;
        f.beforeEmbedding(writeModelSelection(f.home, {version: 1, roles: {embedding: alternate.id}}));
        expect(Result.isFailure(yield* f.run().pipe(Effect.result))).toBe(true);
        expect(EffectArray.some(f.output, EffectString.includes('indexes are ready'))).toBe(false);
        expect((yield* vectorIndexStatus(f.home, manifest)).generation).toBe(previous.generation);
        yield* f.run({model: manifest.id});
        expect(f.output.at(-1)).toBe(`Lexical and vector recall indexes are ready for ${manifest.id}.`);
      }),
    ),
  );

  effectIt.effect('rejects lexical invalidation during embedding', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.beforeEmbedding(
          expireRecallIndexValidation(f.home, false, ['threadnote://resources/repos/demo/document.md']),
        );
        expect(Result.isFailure(yield* f.run().pipe(Effect.result))).toBe(true);
        expect(EffectArray.some(f.output, EffectString.includes('indexes are ready'))).toBe(false);
      }),
    ),
  );

  effectIt.effect.each([
    {change: 'grant', initiallyEnabled: false},
    {change: 'revocation', initiallyEnabled: true},
  ])('rejects external access $change during lexical preparation before inference', ({initiallyEnabled}) =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.addExternal;
        if (!initiallyEnabled) f.changeAccess();
        f.changeAccessDuringLexical();
        expect(Result.isFailure(yield* f.run().pipe(Effect.result))).toBe(true);
        expect(f.embeddedInputs()).toBe(0);
        expect(EffectArray.some(f.output, EffectString.includes('indexes are ready'))).toBe(false);
      }),
    ),
  );

  effectIt.effect('rejects external access revocation during vector preparation', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.addExternal;
        yield* f.run();
        const previous = yield* vectorIndexStatus(f.home, manifest);
        yield* f.fs.writeFileString(f.resource, '# Changed\n\nA fresh local input.');
        f.output.length = 0;
        f.beforeEmbedding(Effect.sync(f.changeAccess));
        expect(Result.isFailure(yield* f.run().pipe(Effect.result))).toBe(true);
        expect(EffectArray.some(f.output, EffectString.includes('indexes are ready'))).toBe(false);
        expect((yield* vectorIndexStatus(f.home, manifest)).generation).toBe(previous.generation);
      }),
    ),
  );

  effectIt.effect.each(['selection', 'authorization'] as const)(
    'rejects %s drift after vector activation and before final success',
    change =>
      test(
        Effect.gen(function* () {
          const f = yield* fixture;
          if (change === 'authorization') yield* f.addExternal;
          let fired = false;
          const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom>();
          const lateChange =
            change === 'selection'
              ? writeModelSelection(f.home, {version: 1, roles: {embedding: alternate.id}})
              : Effect.sync(f.changeAccess);
          const fs: FileSystem.FileSystem = {
            ...f.fs,
            remove: (filename, options) =>
              f.fs.remove(filename, options).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    if (!fired && filename === `${f.home}/indexes/vectors/${manifest.id}/active.json`) {
                      fired = true;
                      yield* lateChange.pipe(Effect.provide(context));
                    }
                  }),
                ),
              ),
          };
          const result = yield* f.run().pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.result);
          expect(fired).toBe(true);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toMatchObject({
              _tag: 'SearchCommandError',
              message: 'Recall inputs changed during preparation. Run `threadnote index rebuild` again.',
            });
          expect(EffectArray.some(f.output, EffectString.includes('indexes are ready'))).toBe(false);
          // The final fence rejects late drift; it does not promise rollback of an already activated mapping.
          expect((yield* vectorIndexStatus(f.home, manifest)).ready).toBe(true);
          expect((yield* recallIndexStatus(f.config)).ready).toBe(true);
        }),
      ),
  );

  fcEffectProp(
    effectIt,
    'repeated rebuild preserves canonical bytes and reuses verified vector values',
    {
      body: FC.string({minLength: 1, maxLength: 120}),
    },
    ({body}) =>
      test(
        Effect.gen(function* () {
          const f = yield* fixture;
          const original = `# Generated\n\n${body}`;
          yield* f.fs.writeFileString(f.resource, original);
          yield* f.run();
          const count = f.embeddedInputs();
          yield* f.run();
          expect(f.embeddedInputs()).toBe(count);
          expect(yield* f.fs.readFileString(f.resource)).toBe(original);
          expect(EffectArray.filter(f.output, EffectString.includes('indexes are ready'))).toHaveLength(2);
        }),
      ),
    {fastCheck: {numRuns: 6}, timeout: 30_000},
  );
});
