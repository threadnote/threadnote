import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Schema} from 'effect';
import {describe, expect} from 'vitest';
import * as FC from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CODE_GRAPH_CACHE_TRANSACTION_LIMITS, codeGraphFileBlobCapacityBytes} from '@threadnote/graph/cache_capacity';
import {codeGraphBlobReuseCacheKey} from '@threadnote/graph/blob_reuse';
import {
  EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE,
  makeCodeGraphBuildResourceCoordinator,
} from '@threadnote/graph/build/resources';
import {
  isBoundedCodeGraphFact,
  serializeBoundedCodeGraphFact,
  type CodeGraphCacheFactInput,
} from '@threadnote/graph/fact/budget';
import {codeGraphExtractionWindowSize} from '@threadnote/graph/extraction_lanes';
import {
  cacheContentBatch,
  type CodeGraphCacheContentStore,
  type CodeGraphCacheExtractedRow,
} from '@threadnote/graph/indexer';
import {classifyCodeGraphStoreFailure} from '@threadnote/graph/store/failure';
import type {CodeGraphIndexResourceGate} from '@threadnote/graph/indexer/types';
import type {CodeGraphBuildResourceOrderError} from '@threadnote/graph/build/resources';
import type {CodeGraphContentBatchContext} from '@threadnote/graph/inventory';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  type CodeGraphLanguagePackRegistryShape,
} from '@threadnote/graph/languages/registry';
import {extractStructuredSchemaFacts} from '@threadnote/graph/languages/schemas/extractor';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {
  pendingCandidateQueuePath,
  persistGraphSharePendingSignedCandidates,
} from '@threadnote/graph/sharing/signed/candidate';
import type {CodeGraphParserPoolShape, CodeGraphParserResult} from '@threadnote/graph/parser_worker';
import type {CodeGraphDirectPersistentCapacityProtector} from '@threadnote/graph/store';
import type {TreeSitterRuntimeShape} from '@threadnote/graph/tree_sitter/runtime';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphStoreFailure} from '@threadnote/graph/types';

import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class InjectedProgressError extends Schema.TaggedError<InjectedProgressError, {readonly brand: unique symbol}>()(
  'InjectedProgressError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

interface CacheCall {
  readonly cacheIdentity: string;
  readonly facts: readonly {readonly facts: CodeGraphFileFacts; readonly json: string}[];
  readonly files: readonly CodeGraphInventoryFile[];
}

const unprotectedCacheWrite: CodeGraphDirectPersistentCapacityProtector = (_boundary, transaction) => transaction;
const journalTestLayer = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));

describe('code graph parser cache coalescer', () => {
  effectIt.effect('extracts bounded manifest control files without parser-worker IPC', () =>
    Effect.gen(function* () {
      const content = '{"name":"bounded-manifest"}\n';
      const file = {
        ...cacheFile(1, 'root'),
        content,
        language: 'npm-manifest',
        path: 'package.json',
        size: new TextEncoder().encode(content).byteLength,
      };
      const harness = coalescerHarness({
        capacity: 1,
        facts: () => Effect.die('manifest extraction must not enter the parser worker'),
        languagePacks: BUILTIN_LANGUAGE_PACK_REGISTRY,
      });

      yield* harness.run([file], cacheContext(1));
      yield* harness.flush;

      expect(harness.calls).toHaveLength(1);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(harness.calls[0]?.facts[0]?.facts.symbols), __effectOptionalArrayReceiver =>
            EffectArray.some(__effectOptionalArrayReceiver, symbol => symbol.name === 'bounded-manifest'),
          ),
        ),
      ).toBe(true);
    }),
  );

  effectIt.effect(
    'does not commit parser facts when the pending journal quota refuses admission',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-cache-journal-quota-'});
        const repositoryId = Effect2.pipe('b', EffectString.repeat(64));
        const manifestPath = pendingCandidateQueuePath(path, home, repositoryId);
        yield* fs.makeDirectory(path.dirname(manifestPath), {recursive: true});
        const commit = Effect2.pipe('c', EffectString.repeat(40));
        const candidate = {
          actionKey: Effect2.pipe('a', EffectString.repeat(64)),
          batchId: commit,
          casRoot: '/private/cas',
          extractorSet: Effect2.pipe('d', EffectString.repeat(64)),
          organization: 'acme',
          platform: {architecture: 'arm64' as const, os: 'darwin' as const},
          profileDigest: sha256Digest('profile'),
          queuedAtMilliseconds: 1,
          releaseIdentity: 'fixture',
          resultDigest: sha256Digest('result'),
          resultSize: 1,
          semanticDigest: sha256Digest('semantic'),
          sourceCommit: commit,
        };
        yield* fs.makeDirectory(`${manifestPath}.d`, {recursive: true});
        const segments = [];
        for (let index = 0; index < 2_048; index++) {
          const bytes = `${JSON.stringify({candidates: [{...candidate, actionKey: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0'))}], schemaVersion: 1})}\n`;
          const id = sha256HexSync(bytes);
          yield* fs.writeFileString(path.join(`${manifestPath}.d`, `${id}.json`), bytes);
          segments.push({count: 1, id, size: new TextEncoder().encode(bytes).byteLength});
        }
        yield* fs.writeFileString(manifestPath, JSON.stringify({schemaVersion: 2, segments}));
        const harness = coalescerHarness({
          capacity: 1,
          onSource: () =>
            persistGraphSharePendingSignedCandidates({
              candidates: [candidate],
              repositoryId,
              threadnoteHome: home,
            }).pipe(Effect.asVoid, provideTestLayer(journalTestLayer)),
        });
        const source = cacheFile(1, 'src/alpha');
        const attempt = yield* Effect.exit(
          Effect.gen(function* () {
            yield* harness.acceptExtracted([extractedRow(source)], cacheContext(1));
            yield* harness.flush;
          }),
        );
        expect(attempt._tag).toBe('Failure');
        if (attempt._tag === 'Failure') expect(Cause.pretty(attempt.cause)).toContain('quota');
        expect(harness.calls).toEqual([]);
      }).pipe(provideTestLayer(journalTestLayer)),
    30_000,
  );

  effectIt.effect(
    'coalesces 73,000 tiny rows across 128-file callbacks into 143 bounded receipts',
    () =>
      Effect.gen(function* () {
        const files = Array.from({length: 73_000}, (_, index) => cacheFile(index, 'src/alpha'));
        const harness = coalescerHarness({capacity: 128});

        for (let offset = 0; offset < files.length; offset += 128) {
          const batch = files.slice(offset, offset + 128);
          yield* harness.acceptExtracted(
            EffectArray.map(batch, file => extractedRow(file)),
            cacheContext(batch.length),
          );
        }
        expect(harness.calls).toHaveLength(142);
        yield* harness.flush;

        expect(harness.calls).toHaveLength(143);
        expect(EffectArray.every(harness.calls.slice(0, -1), call => call.files.length === 512)).toBe(true);
        expect(harness.calls.at(-1)?.files.length).toBe(296);
        expect(EffectArray.reduce(harness.calls, 0, (total, call) => total + call.files.length)).toBe(73_000);
        expect(harness.calls[0]?.files[0]?.path).toBe('src/alpha/file-000000.ts');
        expect(harness.calls.at(-1)?.files.at(-1)?.path).toBe('src/alpha/file-072999.ts');
        assertCacheCallsBounded(harness.calls);
      }),
    30_000,
  );

  effectIt.effect('groups mixed durable/degraded identities deterministically under one global envelope', () =>
    Effect.gen(function* () {
      const files = Array.from({length: 1_025}, (_, index) =>
        cacheFile(index, index % 2 === 0 ? 'src/alpha' : 'src/beta'),
      );
      const facts = (file: CodeGraphInventoryFile): CodeGraphParserResult => ({
        degraded:
          Number(
            Effect2.pipe(
              file.path,
              EffectString.match(/(\d+)\.ts$/u),
              Effect2.Option.getOrElse(() => null),
            )?.[1] ?? 0,
          ) %
            5 ===
          0,
        facts: emptyFacts(file.path),
        parseMilliseconds: 0,
      });
      const persistenceProgress: Array<{readonly completed: number; readonly total: number}> = [];
      const first = coalescerHarness({
        capacity: 7,
        facts,
        onProgress: progress =>
          Effect.sync(() => {
            if (progress.phase === 'scanning' && progress.activity?.stage === 'persisting') {
              persistenceProgress.push({
                completed: progress.activity.batchCompleted,
                total: progress.activity.batchTotal,
              });
            }
          }),
      });
      const second = coalescerHarness({capacity: 7, facts});

      for (let offset = 0; offset < files.length; offset += 128) {
        const batch = files.slice(offset, offset + 128);
        yield* first.run(batch, cacheContext(batch.length));
        yield* second.run([...batch].reverse(), cacheContext(batch.length));
      }
      yield* first.flush;
      yield* second.flush;

      expect(cacheCallIdentity(first.calls)).toEqual(cacheCallIdentity(second.calls));
      expect(EffectArray.reduce(first.calls, 0, (total, call) => total + call.files.length)).toBe(files.length);
      for (const call of first.calls) {
        const baseIdentities = new Set(EffectArray.map(call.files, file => cacheIdentityForPath(file.path)));
        const degradationStates = new Set(
          EffectArray.map(call.files, file =>
            Number(
              Effect2.pipe(
                file.path,
                EffectString.match(/(\d+)\.ts$/u),
                Effect2.Option.getOrElse(() => null),
              )?.[1] ?? 0,
            ) %
              5 ===
            0
              ? 'degraded'
              : 'durable',
          ),
        );
        expect(baseIdentities.size).toBe(1);
        expect(degradationStates.size).toBe(1);
      }
      assertCacheCallsBounded(first.calls);
      expect(persistenceProgress).toEqual(
        EffectArray.flatMap(first.calls, call => [
          {completed: 0, total: call.files.length},
          {completed: call.files.length, total: call.files.length},
        ]),
      );
      expect(
        EffectArray.every(persistenceProgress, value => value.completed >= 0 && value.completed <= value.total),
      ).toBe(true);
      expect(EffectArray.reduce(persistenceProgress, 0, (total, value) => total + value.completed)).toBe(files.length);
      expect(
        EffectArray.every(
          EffectArray.filter(persistenceProgress, value => value.completed > 0),
          value => value.completed === value.total,
        ),
      ).toBe(true);
    }),
  );

  effectIt.effect('stops before the next cache group when the first durable receipt fails', () =>
    checkCacheGroupCheckpoint(2, 1, 'failure'),
  );

  effectIt.effect('interrupts at a durable cache-group receipt without committing the next group', () =>
    checkCacheGroupCheckpoint(2, 1, 'interruption'),
  );

  fcEffectProp(
    effectIt,
    'reports exactly the durable group prefix across cancellation and retry',
    {
      firstRows: FC.integer({min: 1, max: 20}),
      secondRows: FC.integer({min: 1, max: 20}),
      stop: FC.constantFrom('failure' as const, 'interruption' as const),
    },
    ({firstRows, secondRows, stop}) => checkCacheGroupCheckpoint(firstRows, secondRows, stop),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('releases preparation before a threshold-triggered cache writer acquisition', () =>
    Effect.gen(function* () {
      const resources = yield* makeCodeGraphBuildResourceCoordinator(() => Effect.void);
      const preparationGate: CodeGraphIndexResourceGate = effect =>
        Effect.acquireUseRelease(
          resources.acquirePreparation,
          () => effect,
          () => resources.releasePreparation,
        );
      const files = Array.from({length: CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows + 1}, (_, index) =>
        cacheFile(index, 'src/resource-order'),
      );
      const harness = coalescerHarness({
        capacity: 8,
        facts: file =>
          resources.current.pipe(
            Effect.tap(state => Effect.sync(() => expect(state.preparation).toBe(true))),
            Effect.as({degraded: false, facts: emptyFacts(file.path), parseMilliseconds: 0}),
          ),
        onCache: () =>
          resources.assertWriterMayWait.pipe(
            Effect.andThen(
              Effect.acquireUseRelease(
                resources.acquireWriter,
                () => Effect.void,
                () => resources.releaseWriter,
              ),
            ),
          ),
        preparationGate,
      });

      for (let offset = 0; offset < files.length; offset += 128) {
        const batch = files.slice(offset, offset + 128);
        yield* harness.run(batch, cacheContext(batch.length));
      }

      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]?.files).toHaveLength(CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows);
      expect(yield* resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      yield* harness.flush;
      expect(harness.calls).toHaveLength(2);
      expect(yield* resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
    }),
  );

  effectIt.effect(
    'accepts each bounded extraction window before admitting the next window',
    () =>
      Effect.gen(function* () {
        const resources = yield* makeCodeGraphBuildResourceCoordinator(() => Effect.void);
        const diagnostic = Effect2.pipe('界', EffectString.repeat(650_000));
        const windowSize = codeGraphExtractionWindowSize(1);
        let admissions = 0;
        let writes = 0;
        const preparationGate: CodeGraphIndexResourceGate = effect =>
          Effect.sync(() => {
            admissions += 1;
            if (admissions > 1) expect(writes).toBeGreaterThan(0);
          }).pipe(
            Effect.andThen(
              Effect.acquireUseRelease(
                resources.acquirePreparation,
                () => effect,
                () => resources.releasePreparation,
              ),
            ),
          );
        const harness = coalescerHarness({
          capacity: 1,
          facts: file => ({
            degraded: false,
            facts: {...emptyFacts(file.path), diagnostics: [diagnostic]},
            parseMilliseconds: 0,
          }),
          onCache: () =>
            resources.assertWriterMayWait.pipe(
              Effect.andThen(
                Effect.acquireUseRelease(
                  resources.acquireWriter,
                  () =>
                    Effect.sync(() => {
                      writes += 1;
                    }),
                  () => resources.releaseWriter,
                ),
              ),
            ),
          preparationGate,
        });
        const files = Array.from({length: windowSize + 1}, (_, index) => cacheFile(index, 'src/window-boundary'));

        yield* harness.run(files, cacheContext(files.length));

        expect(admissions).toBe(2);
        expect(writes).toBeGreaterThan(0);
        expect(harness.calls[0]?.files.length).toBeLessThanOrEqual(windowSize);
        expect(yield* resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
        yield* harness.flush;
        expect(EffectArray.reduce(harness.calls, 0, (total, call) => total + call.files.length)).toBe(files.length);
      }),
    30_000,
  );

  effectIt.effect(
    'keeps an exact committed prefix when interrupted after a payload flush and converges on retry',
    () =>
      Effect.gen(function* () {
        const diagnostic = Effect2.pipe('界', EffectString.repeat(2_300_000));
        const files = Array.from({length: 5}, (_, index) => cacheFile(index, 'src/payload'));
        const secondWriterEntered = yield* Deferred.make<void>();
        const committed = new Map<string, string>();
        let writes = 0;
        const harness = coalescerHarness({
          capacity: 3,
          facts: file => ({
            degraded: false,
            facts: {...emptyFacts(file.path), diagnostics: [diagnostic]},
            parseMilliseconds: 0,
          }),
          onCache: call => {
            writes += 1;
            return writes === 1
              ? Effect.sync(() => {
                  for (let index = 0; index < call.files.length; index += 1) {
                    committed.set(call.files[index].path, call.facts[index].json);
                  }
                })
              : Deferred.succeed(secondWriterEntered, undefined).pipe(Effect.andThen(Effect.never));
          },
        });

        yield* harness.run(files, cacheContext(files.length));
        expect(harness.calls).toHaveLength(1);
        const interrupted = yield* harness.flush.pipe(Effect.ensuring(harness.discard), Effect.forkChild);
        yield* Deferred.await(secondWriterEntered);
        yield* Fiber.interrupt(interrupted);

        expect(harness.calls).toHaveLength(2);
        expect(committed.size).toBe(harness.calls[0].files.length);
        expect(committed.size).toBeGreaterThan(0);
        expect(committed.size).toBeLessThan(files.length);
        assertCacheCallsBounded(harness.calls);
        yield* harness.flush;
        expect(harness.calls).toHaveLength(2);

        const retry = coalescerHarness({
          capacity: 3,
          facts: file => ({
            degraded: false,
            facts: {...emptyFacts(file.path), diagnostics: [diagnostic]},
            parseMilliseconds: 0,
          }),
          onCache: call =>
            Effect.sync(() => {
              for (let index = 0; index < call.files.length; index += 1) {
                committed.set(call.files[index].path, call.facts[index].json);
              }
            }),
        });
        yield* retry.run(files, cacheContext(files.length));
        yield* retry.flush;

        expect([...committed.keys()].sort()).toEqual(EffectArray.map(files, file => file.path));
        expect(retry.calls).toHaveLength(2);
        assertCacheCallsBounded(retry.calls);
      }),
    30_000,
  );

  effectIt.effect('drops heavyweight source payloads while retaining rows across inventory callbacks', () =>
    Effect.gen(function* () {
      const sharedLargeSource = new Uint8Array(8 * 1_048_576);
      const files = Array.from({length: 513}, (_, index) => ({
        ...cacheFile(index, 'src/source-memory'),
        bytes: sharedLargeSource,
        content: 'source content must not survive its extraction callback',
        size: sharedLargeSource.byteLength,
      }));
      const harness = coalescerHarness({capacity: 8});

      for (let offset = 0; offset < files.length; offset += 128) {
        const batch = files.slice(offset, offset + 128);
        yield* harness.acceptExtracted(
          EffectArray.map(batch, file => extractedRow(file)),
          cacheContext(batch.length),
        );
      }
      expect(harness.calls).toHaveLength(1);
      yield* harness.flush;

      expect(harness.calls).toHaveLength(2);
      expect(
        EffectArray.every(harness.calls, call =>
          EffectArray.every(call.files, file => !('bytes' in file) && !('content' in file)),
        ),
      ).toBe(true);
      expect(EffectArray.reduce(harness.calls, 0, (total, call) => total + call.files.length)).toBe(files.length);
    }),
  );

  effectIt.effect('flushes a committed path before accepting its dirty-overlay hash', () =>
    Effect.gen(function* () {
      const committed = {
        ...cacheFile(1, 'src/duplicate'),
        contentHash: Effect2.pipe('a', EffectString.repeat(64)),
        source: 'commit' as const,
      };
      const overlay = {
        ...committed,
        contentHash: Effect2.pipe('b', EffectString.repeat(64)),
        source: 'worktree' as const,
      };
      const harness = coalescerHarness({capacity: 2});

      yield* harness.acceptExtracted([extractedRow(committed)], cacheContext(1));
      expect(harness.calls).toEqual([]);
      yield* harness.acceptExtracted([extractedRow(overlay)], cacheContext(1));
      expect(harness.calls).toHaveLength(1);
      yield* harness.flush;

      expect(harness.calls).toHaveLength(2);
      expect(EffectArray.map(harness.calls, call => EffectArray.map(call.files, file => file.contentHash))).toEqual([
        [Effect2.pipe('a', EffectString.repeat(64))],
        [Effect2.pipe('b', EffectString.repeat(64))],
      ]);
      expect(EffectArray.every(harness.calls, call => call.files[0]?.path === committed.path)).toBe(true);
    }),
  );

  effectIt.effect('extracts one eligible Git blob once across committed inventory callbacks', () =>
    Effect.gen(function* () {
      const content = '{"nested":{"enabled":true},"items":[{"name":"one"}]}';
      const donor = structuredCacheFile('config/donor.json', content);
      const target = structuredCacheFile('config/copies/target.json', content);
      const reuseKey = codeGraphBlobReuseCacheKey(donor, cacheIdentityForPath(donor.path))!;
      const context = {...cacheContext(2), blobReuseCounts: new Map([[reuseKey, 2]])};
      let extractions = 0;
      const harness = coalescerHarness({
        capacity: 2,
        facts: file => {
          extractions += 1;
          return {
            degraded: false,
            facts: extractStructuredSchemaFacts(file, {packageName: Option.none(), project: Option.none()}),
            parseMilliseconds: 1,
          };
        },
      });

      yield* harness.run([donor], context);
      yield* harness.run([target], context);
      yield* harness.flush;

      expect(extractions).toBe(1);
      const cachedFacts = new Map(
        EffectArray.flatMap(harness.calls, call =>
          EffectArray.map(call.facts, fact => [fact.facts.path, fact.facts] as const),
        ),
      );
      expect(cachedFacts.get(donor.path)).toEqual(
        extractStructuredSchemaFacts(donor, {packageName: Option.none(), project: Option.none()}),
      );
      expect(cachedFacts.get(target.path)).toEqual(
        extractStructuredSchemaFacts(target, {packageName: Option.none(), project: Option.none()}),
      );
    }),
  );

  effectIt.effect('publishes extraction dimensions for path-free persisted build status', () =>
    Effect.gen(function* () {
      const observed: Parameters<NonNullable<Parameters<typeof cacheContentBatch>[0]['onProgress']>>[0][] = [];
      const file = {...cacheFile(0, 'src/telemetry'), size: 70 * 1_024};
      const harness = coalescerHarness({
        capacity: 1,
        facts: candidate => ({
          degraded: false,
          facts: {
            ...emptyFacts(candidate.path),
            symbols: [
              {
                contentHash: candidate.contentHash,
                exported: true,
                id: 'cgs_telemetry',
                kind: 'module',
                language: 'typescript',
                name: 'telemetry',
                path: candidate.path,
                qualifiedName: candidate.path,
                span: {column: 1, endColumn: 1, endLine: 1, line: 1},
              },
            ],
          },
          parseMilliseconds: 1_250,
        }),
        onProgress: value =>
          Effect.sync(() => {
            observed.push(value);
          }),
      });

      yield* harness.run([file], cacheContext(1));
      yield* harness.flush;

      const completed = Option.getOrUndefined(
        EffectArray.findFirst(
          observed,
          value =>
            value.phase === 'scanning' &&
            value.activity?.stage === 'extracting' &&
            value.activity.parseMilliseconds !== undefined,
        ),
      );
      expect(completed).toMatchObject({
        activity: {
          bytes: 70 * 1_024,
          classifier: 'typescript',
          factsBytes: expect.any(Number),
          language: 'typescript',
          parseMilliseconds: 1_250,
          role: 'source',
          sizeBucket: '64-256KiB',
          symbols: 1,
        },
        phase: 'scanning',
      });
      expect(JSON.stringify(completed)).toContain(file.path);
    }),
  );

  effectIt.effect('never reuses or publishes blob metadata for a degraded extraction', () =>
    Effect.gen(function* () {
      const content = '{"nested":{"enabled":true}}';
      const donor = structuredCacheFile('config/degraded.json', content);
      const target = structuredCacheFile('config/copies/degraded.json', content);
      const reuseKey = codeGraphBlobReuseCacheKey(donor, cacheIdentityForPath(donor.path))!;
      const context = {...cacheContext(2), blobReuseCounts: new Map([[reuseKey, 2]])};
      let extractions = 0;
      const harness = coalescerHarness({
        capacity: 2,
        facts: file => {
          extractions += 1;
          return {degraded: true, facts: emptyFacts(file.path), parseMilliseconds: 1};
        },
      });

      yield* harness.run([donor], context);
      yield* harness.run([target], context);
      yield* harness.flush;

      expect(extractions).toBe(2);
      expect(
        EffectArray.every(
          EffectArray.flatMap(harness.calls, call => call.files),
          file => file.blobId === '',
        ),
      ).toBe(true);
    }),
  );

  effectIt.effect('discards an interrupted pending window without starting a cache writer', () =>
    Effect.gen(function* () {
      const thirdExtractionEntered = yield* Deferred.make<void>();
      let extractions = 0;
      const harness = coalescerHarness({
        capacity: 1,
        facts: file => {
          extractions += 1;
          const result = {
            degraded: false,
            facts: emptyFacts(file.path),
            parseMilliseconds: 0,
          } satisfies CodeGraphParserResult;
          return extractions === 3
            ? Deferred.succeed(thirdExtractionEntered, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(result);
        },
      });
      const files = Array.from({length: 3}, (_, index) => cacheFile(index, 'src/cancel'));

      const caching = yield* harness
        .run(files, cacheContext(files.length))
        .pipe(Effect.ensuring(harness.discard), Effect.forkChild);
      yield* Deferred.await(thirdExtractionEntered);
      yield* Fiber.interrupt(caching);

      expect(extractions).toBe(3);
      expect(harness.calls).toEqual([]);
    }),
  );

  effectIt.effect('discards pending rows after a later-window failure without starting a cache writer', () =>
    Effect.gen(function* () {
      const harness = coalescerHarness({
        capacity: 1,
        onProgress: progress =>
          progress.phase === 'scanning' &&
          progress.activity?.stage === 'extracting' &&
          Effect2.pipe(progress.activity.path, EffectString.endsWith('000002.ts'))
            ? Effect.fail(InjectedProgressError.make({message: 'injected later-window progress failure'}))
            : Effect.void,
      });
      const files = Array.from({length: 3}, (_, index) => cacheFile(index, 'src/failure'));

      const failure = yield* harness
        .run(files, cacheContext(files.length))
        .pipe(Effect.ensuring(harness.discard), Effect.flip);

      expect(failure).toBeInstanceOf(Error);
      expect(harness.calls).toEqual([]);
    }),
  );

  effectIt.effect('retains exact extracted fact bytes across multiple dirty-overlay batches', () =>
    Effect.gen(function* () {
      const harness = coalescerHarness({capacity: 1});
      const committed = cacheFile(0, 'src/committed');
      const firstOverlay = {...cacheFile(1, 'src/overlay'), source: 'worktree' as const};
      const secondOverlay = {...cacheFile(2, 'src/overlay'), source: 'worktree' as const};

      yield* harness.run([committed], plannedCacheContext(1));
      yield* harness.beginSparseExtractionTracking;
      yield* harness.beginOverlayExtraction;
      expect(yield* harness.extractedFactBytes).toBe(0);
      yield* harness.run([firstOverlay], cacheContext(1));
      const firstBytes = yield* harness.extractedFactBytes;
      yield* harness.run([secondOverlay], cacheContext(1));
      const secondBytes = yield* harness.extractedFactBytes;

      const expectedFirst = serializeBoundedCodeGraphFact(emptyFacts(firstOverlay.path)).bytes;
      const expectedSecond = serializeBoundedCodeGraphFact(emptyFacts(secondOverlay.path)).bytes;
      expect(firstBytes).toBe(expectedFirst);
      expect(secondBytes).toBe(expectedFirst + expectedSecond);
      expect(secondBytes).toBeGreaterThan(0);
      yield* harness.endSparseExtractionTracking;
      expect(yield* harness.sparseExtractedFiles).toBe(2);
    }),
  );
});

function checkCacheGroupCheckpoint(firstRows: number, secondRows: number, stop: 'failure' | 'interruption') {
  return Effect.gen(function* () {
    const first = Array.from({length: firstRows}, (_, index) => cacheFile(index, 'src/alpha'));
    const second = Array.from({length: secondRows}, (_, index) => cacheFile(index, 'src/beta'));
    const files = [...first, ...second];
    const committed = new Map<string, string>();
    const sources: string[] = [];
    const receipts: Array<{readonly completed: number; readonly total: number}> = [];
    const receiptReached = yield* Deferred.make<void>();
    const persist = (call: CacheCall) =>
      Effect.sync(() => {
        for (let index = 0; index < call.files.length; index += 1) {
          committed.set(call.files[index].path, call.facts[index].json);
        }
      });
    const harness = coalescerHarness({
      capacity: 2,
      onCache: persist,
      onSource: group => Effect.sync(() => sources.push(group.cacheIdentity)).pipe(Effect.asVoid),
      onProgress: progress =>
        Effect.gen(function* () {
          if (progress.phase !== 'scanning' || progress.activity?.stage !== 'persisting') return;
          const activity = progress.activity;
          receipts.push({completed: activity.batchCompleted, total: activity.batchTotal});
          if (activity.batchCompleted === 0) return;
          if (stop === 'failure') return yield* InjectedProgressError.make({message: 'stop after durable receipt'});
          yield* Deferred.succeed(receiptReached, undefined);
          return yield* Effect.never;
        }),
    });
    yield* harness.acceptExtracted(EffectArray.map(files, extractedRow), cacheContext(files.length));
    expect(harness.calls).toEqual([]);
    const flushing = harness.flush.pipe(Effect.ensuring(harness.discard));
    if (stop === 'failure') {
      const failure = yield* flushing.pipe(Effect.flip);
      expect(failure).toBeInstanceOf(InjectedProgressError);
    } else {
      const fiber = yield* flushing.pipe(Effect.forkChild);
      yield* Deferred.await(receiptReached);
      yield* Fiber.interrupt(fiber);
    }

    expect(harness.calls).toHaveLength(1);
    expect(sources).toEqual([cacheIdentityForPath(first[0].path)]);
    expect([...committed.keys()]).toEqual(EffectArray.map(first, file => file.path));
    expect(receipts).toEqual([
      {completed: 0, total: firstRows},
      {completed: firstRows, total: firstRows},
    ]);
    yield* harness.flush;
    expect(harness.calls).toHaveLength(1);

    const retry = coalescerHarness({capacity: 2, onCache: persist});
    yield* retry.acceptExtracted(
      EffectArray.map(
        EffectArray.filter(files, file => !committed.has(file.path)),
        extractedRow,
      ),
      cacheContext(secondRows),
    );
    yield* retry.flush;
    expect(retry.calls).toHaveLength(1);
    expect([...committed.keys()]).toEqual(EffectArray.map(files, file => file.path));
    for (const file of files)
      expect(committed.get(file.path)).toBe(serializeBoundedCodeGraphFact(emptyFacts(file.path)).json);
  });
}

function coalescerHarness(options: {
  readonly capacity: number;
  readonly facts?: (
    file: CodeGraphInventoryFile,
  ) => CodeGraphParserResult | Effect.Effect<CodeGraphParserResult, never>;
  readonly languagePacks?: CodeGraphLanguagePackRegistryShape;
  readonly onCache?: (call: CacheCall) => Effect.Effect<void, CodeGraphStoreFailure | CodeGraphBuildResourceOrderError>;
  readonly onSource?: Parameters<typeof cacheContentBatch>[0]['onSourceParserBatch'];
  readonly onProgress?: Parameters<typeof cacheContentBatch>[0]['onProgress'];
  readonly preparationGate?: CodeGraphIndexResourceGate;
}) {
  const calls: CacheCall[] = [];
  const extract = (file: CodeGraphInventoryFile) => {
    const result = options.facts?.(file) ?? {
      degraded: false,
      facts: emptyFacts(file.path),
      parseMilliseconds: 0,
    };
    return Effect.isEffect(result) ? result : Effect.succeed(result);
  };
  const parserPool = {
    capacity: options.capacity,
    extract,
    withParserSlot: (_threadnoteHome, _files, use) => use(extract),
    warm: () => Effect.void,
    trimIdle: Effect.void,
  } satisfies CodeGraphParserPoolShape;
  const recordCache = (files: readonly CodeGraphInventoryFile[], facts: CacheCall['facts'], cacheIdentity: string) =>
    Effect.sync(() => {
      const call = {cacheIdentity, facts, files};
      calls.push(call);
      return call;
    }).pipe(
      Effect.flatMap(call => options.onCache?.(call) ?? Effect.void),
      Effect.mapError(error => classifyCodeGraphStoreFailure('cache code graph facts', error)),
    );
  const store = {
    cacheFacts: (
      _databasePath: string,
      files: readonly CodeGraphInventoryFile[],
      facts: readonly CodeGraphCacheFactInput[],
      cacheIdentity: string,
      _persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector,
    ) =>
      recordCache(
        files,
        EffectArray.map(facts, fact => {
          const bounded = isBoundedCodeGraphFact(fact) ? fact : serializeBoundedCodeGraphFact(fact);
          return {facts: bounded.facts, json: bounded.json};
        }),
        cacheIdentity,
      ),
  } satisfies CodeGraphCacheContentStore;
  const coalescer = cacheContentBatch({
    databasePath: '/bounded/cache.sqlite',
    languagePacks:
      options.languagePacks ??
      ({
        ...BUILTIN_LANGUAGE_PACK_REGISTRY,
        cacheIdentityForPath: path =>
          Option.map(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), () => cacheIdentityForPath(path)),
        match: path =>
          Option.map(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), match => ({
            ...match,
            cacheIdentity: cacheIdentityForPath(path),
          })),
      } satisfies CodeGraphLanguagePackRegistryShape),
    onProgress: options.onProgress,
    onSourceParserBatch: options.onSource,
    parserPool,
    preparationGate: options.preparationGate,
    persistentCapacityProtector: unprotectedCacheWrite,
    store,
    threadnoteHome: '/bounded/home',
    treeSitter: {
      withParsedSource: () => Effect.die(new Error('Parser fixture does not use Tree-sitter.')),
    } satisfies TreeSitterRuntimeShape,
  });
  return {...coalescer, calls, run: coalescer.onContentBatch};
}

function cacheFile(index: number, directory: string): CodeGraphInventoryFile {
  const suffix = Effect2.pipe(index.toString(), EffectString.padStart(6, '0'));
  return {
    blobId: Effect2.pipe(index.toString(16), EffectString.padStart(40, '0')),
    contentHash: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
    language: 'typescript',
    mode: '100644',
    path: `${directory}/file-${suffix}.ts`,
    size: 1,
    source: 'commit',
  };
}

function structuredCacheFile(path: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: Effect2.pipe('a', EffectString.repeat(40)),
    content,
    contentHash: Effect2.pipe('b', EffectString.repeat(64)),
    language: 'json',
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}

function cacheIdentityForPath(path: string): string {
  return Effect2.pipe(path, EffectString.includes('/beta/')) ? 'cache-beta-v1' : 'cache-alpha-v1';
}

function emptyFacts(path: string): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, symbols: []};
}

function extractedRow(file: CodeGraphInventoryFile): CodeGraphCacheExtractedRow {
  return {
    cacheFact: serializeBoundedCodeGraphFact(emptyFacts(file.path)),
    cacheIdentity: cacheIdentityForPath(file.path),
    degraded: false,
    file,
  };
}

function cacheContext(total: number): CodeGraphContentBatchContext {
  return {
    progress: {accepted: total, completed: total, excluded: 0, phase: 'scanning', skipped: 0, total, unit: 'files'},
    readingMilliseconds: 0,
    sourceBytes: total,
  };
}

function plannedCacheContext(total: number): CodeGraphContentBatchContext {
  return {
    ...cacheContext(total),
    extractionPlan: {sourceBytesTotal: total, workUnitsTotal: Number.MAX_SAFE_INTEGER},
  };
}

function cacheCallIdentity(calls: readonly CacheCall[]) {
  return EffectArray.map(calls, call => ({
    cacheIdentity: call.cacheIdentity,
    paths: EffectArray.map(call.files, file => file.path),
  }));
}

function assertCacheCallsBounded(calls: readonly CacheCall[]) {
  for (const call of calls) {
    const payloadBytes = EffectArray.reduce(
      call.files,
      0,
      (total, file, index) =>
        total +
        codeGraphFileBlobCapacityBytes({
          contentHash: file.contentHash,
          createdAt: '1970-01-01T00:00:00.000Z',
          extractorSet: call.cacheIdentity,
          factsJson: call.facts[index].json,
          path: file.path,
        }),
    );
    expect(call.files.length).toBeGreaterThan(0);
    expect(call.files.length).toBeLessThanOrEqual(CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows);
    expect(payloadBytes).toBeLessThanOrEqual(CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes);
  }
}
