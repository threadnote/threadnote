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
import {runIndexRebuild, runIndexStatus} from '../../src/search/commands.js';
import {readRecallVectorStatusDetails} from '../../src/lifecycle.js';
import {
  observeRecallEmbeddingDemand,
  readRecallEmbeddingDemand,
  requestRecallEmbeddingsReceipt,
} from '@threadnote/recall/background/demand';
import {stepRecallVectorPreparation} from '@threadnote/recall/background/vector-step';
import {CliOutput} from '../../src/effect/cli/output.js';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {InferenceInterrupted} from '@threadnote/inference/engine/errors';
import {writeModelSelection} from '@threadnote/inference/models/selection';
import {expireRecallIndexValidation, loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import {vectorIndexStatus} from '@threadnote/recall/vector-index';
import {vectorIndexGenerationReadiness} from '@threadnote/recall/vector/semantic-read';
import {runRecallVectorCompaction} from '@threadnote/recall/vector/compaction';
import {RecallVectorCompactionThresholds} from '@threadnote/recall/vector/sqlite-pages';
import {Database} from 'bun:sqlite';
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
  const cliOutput = CliOutput.of({
    drain: Effect.void,
    enqueueError: line => {
      output.push(line);
    },
    enqueueOutput: line => {
      output.push(line);
    },
    flush: Effect.void,
    writeError: line =>
      Effect.sync(() => {
        output.push(line);
      }),
    writeFinal: line =>
      Effect.sync(() => {
        output.push(line);
      }),
  });
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
        Effect.provideService(CliOutput, cliOutput),
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
  const status = Console.consoleWith(parent =>
    runIndexStatus(config).pipe(
      Effect.provideService(Console.Console, {
        ...parent,
        log: (...args) => {
          output.push(EffectArray.join(EffectArray.map(args, String), ' '));
        },
      }),
    ),
  );
  const background = Effect.gen(function* () {
    yield* loadRecallIndexData(config, {includeInactive: false, memoryIds: []});
    for (let attempt = 0; attempt < 40; attempt++) {
      const outcome = yield* stepRecallVectorPreparation(config, manifest, Effect.succeed(true));
      if (outcome.state === 'current') return;
    }
    return yield* Effect.die('The test background refresh did not converge.');
  }).pipe(Effect.provideService(LocalModelStore, store), Effect.provideService(LocalModelRuntime, runtime));
  return {
    fs,
    home,
    config,
    resource,
    output,
    run,
    status,
    background,
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

/** Free pages above test-sized thresholds; a compaction whose free-space probe waits for `release`. */
const heldCompaction = (home: string) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      const db = new Database(`${home}/indexes/vectors/${manifest.id}/vectors-v5.sqlite`);
      try {
        db.exec('CREATE TABLE padding (body BLOB)');
        for (let row = 0; row < 256; row++) db.query('INSERT INTO padding VALUES (?)').run(new Uint8Array(16 * 1024));
        db.exec('DROP TABLE padding');
      } finally {
        db.close();
      }
    });
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const system = yield* SystemInfo;
    const fiber = yield* runRecallVectorCompaction(home, manifest).pipe(
      Effect.provideService(RecallVectorCompactionThresholds, {
        minimumReclaimableBytes: 1024 * 1024,
        minimumReclaimableRatio: 0.2,
        safetyMarginBytes: 0,
      }),
      Effect.provideService(SystemInfo, {
        ...system,
        availableDiskBytes: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(1e15)),
      }),
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    return {fiber, release: Deferred.succeed(release, undefined)};
  });

describe('index storage status', () => {
  effectIt.effect('shows the file size, the reclaimable size and the compaction state', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.run();
        const held = yield* heldCompaction(f.home);
        f.output.length = 0;
        yield* f.status;
        const running = EffectArray.findFirst(f.output, EffectString.startsWith(`${manifest.id}\t`));
        expect(Option.getOrUndefined(running)).toContain('compaction running selected\tread state current');
        yield* held.release;
        expect(yield* Fiber.join(held.fiber)).toMatchObject({state: 'complete'});
        f.output.length = 0;
        yield* f.status;
        const line = EffectArray.findFirst(f.output, EffectString.startsWith(`${manifest.id}\t`));
        expect(Option.getOrUndefined(line)).toMatch(
          /\tready\t1 chunks\t.+\tfile \d.* (B|KiB|MiB)\treclaimable \d.* (B|KiB|MiB)\tcompaction complete selected\t/u,
        );
        expect(Option.getOrUndefined(line)).toMatch(
          /read state current; waiting 0; last refresh full, changed 1, copied chunks 0, reused chunks 0, embedded chunks 1, build \d+ ms, stale unknown$/u,
        );
      }),
    ),
  );

  effectIt.effect('shows an older generation and counts only memories still present in the mask', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.background;
        yield* f.fs.remove(f.resource);
        const path = yield* Path.Path;
        const changed = path.join(path.dirname(f.resource), 'added.md');
        yield* f.fs.writeFileString(changed, '# Added\n\nThe changed vector is still pending.');
        yield* expireRecallIndexValidation(f.home, false, [
          'threadnote://resources/repos/demo/document.md',
          'threadnote://resources/repos/demo/added.md',
        ]);
        yield* loadRecallIndexData(f.config, {includeInactive: false, memoryIds: []});
        yield* f.status;
        const line = Option.getOrUndefined(
          EffectArray.findFirst(f.output, EffectString.startsWith(`${manifest.id}\t`)),
        );
        expect(line).toContain('read state serving-older; waiting 1; last refresh full');
        expect(line).not.toContain('lexical-only reason');
      }),
    ),
  );

  effectIt.effect('does not classify a replaced vector generation as current', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.run();
        const previous = yield* vectorIndexStatus(f.home, manifest);
        yield* f.fs.writeFileString(f.resource, '# Updated\n\nA different resource now has vectors.');
        yield* f.run();
        const current = yield* vectorIndexStatus(f.home, manifest);
        expect(current.ready).toBe(true);
        expect(current.generation).not.toBe(previous.generation);
        const lexical = yield* recallIndexStatus(f.config);
        const report = yield* readRecallVectorStatusDetails(f.config, manifest, lexical, previous);
        expect(report.state).toBe('unknown');
        expect(report.detail).toContain('inspection reason vector generation changed during inspection');
      }),
    ),
  );

  effectIt.effect('stops a rebuild that cannot take the vector lock from a compaction and names it', () =>
    Effect.scoped(
      Layer.build(platform).pipe(
        Effect.flatMap(context =>
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* TestClock.withLive(f.run());
            const held = yield* TestClock.withLive(heldCompaction(f.home));
            const rebuild = yield* f.run().pipe(Effect.result, Effect.forkChild);
            // The rebuild waits up to 120 seconds for the lock; the test clock runs that wait out.
            for (let turn = 0; turn < 400 && rebuild.pollUnsafe() === undefined; turn++) {
              yield* TestClock.withLive(Effect.sleep('10 millis'));
              yield* TestClock.adjust('1 second');
            }
            const result = yield* Fiber.join(rebuild);
            yield* held.release;
            yield* Fiber.join(held.fiber);
            expect(result).toMatchObject({
              failure: {_tag: 'SearchCommandError', message: expect.stringContaining('compaction')},
            });
            expect((yield* vectorIndexStatus(f.home, manifest)).ready).toBe(true);
          }).pipe(Effect.provide(context)),
        ),
      ),
    ),
  );
});

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

  effectIt.effect('settles a blocked background demand but keeps a write that arrives during the rebuild', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        const blocked = yield* requestRecallEmbeddingsReceipt(f.config);
        yield* observeRecallEmbeddingDemand(f.config, blocked, {state: 'blocked', failures: 8});
        yield* f.run();
        expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toBeUndefined();

        const again = yield* requestRecallEmbeddingsReceipt(f.config);
        yield* observeRecallEmbeddingDemand(f.config, again, {state: 'blocked', failures: 8});
        // A changed body makes the second rebuild embed, so the write lands mid-build.
        yield* f.fs.writeFileString(f.resource, 'Changed synthetic body for the second rebuild.');
        let write: {token: string; revision: string} | undefined;
        f.beforeEmbedding(
          requestRecallEmbeddingsReceipt(f.config, true).pipe(
            Effect.map(receipt => {
              write ??= receipt;
            }),
          ),
        );
        yield* f.run();
        const kept = (yield* readRecallEmbeddingDemand(f.config))?.desired;
        expect(kept?.token).toBe(again.token);
        expect(kept?.revision).toBe(write?.revision);
      }),
    ),
  );

  effectIt.effect('keeps background demand of another manifest path after a rebuild', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        const demand = yield* requestRecallEmbeddingsReceipt({...f.config, manifestPath: '/abs/other/manifest.json'});
        yield* f.run();
        expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toMatchObject({
          token: demand.token,
          revision: demand.revision,
        });
      }),
    ),
  );

  effectIt.effect('keeps background demand after a rebuild of a model that is not selected', () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        const demand = yield* requestRecallEmbeddingsReceipt(f.config);
        yield* f.run({model: alternate.id});
        expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toMatchObject({
          token: demand.token,
          revision: demand.revision,
        });
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
        const demand = yield* requestRecallEmbeddingsReceipt(f.config);
        f.failEmbedding();
        expect(Result.isFailure(yield* f.run().pipe(Effect.result))).toBe(true);
        expect((yield* readRecallEmbeddingDemand(f.config))?.desired).toMatchObject({
          token: demand.token,
          revision: demand.revision,
        });
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
          const path = yield* Path.Path;
          const latePath = path.join(f.home, 'indexes', 'vectors', manifest.id, 'active.json');
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
                    if (!fired && filename === latePath) {
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
