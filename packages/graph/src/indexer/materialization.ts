import {degradedParserCacheIdentity, groupFilesByCacheIdentity} from './materialization_batch.js';
export {cachedFactsMetadata} from './materialization_batch.js';
import {Array as EffectArray} from 'effect';
import {Clock, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {codeGraphBlobExtractionReuseClass, codeGraphBlobReuseCacheKey} from '../blob_reuse.js';
import {CODE_GRAPH_CACHE_TRANSACTION_LIMITS, codeGraphFileBlobCapacityBytes} from '../cache_capacity.js';
import {
  codeGraphDiskCapacityFailure,
  codeGraphPersistentCapacityDemand,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '../disk/capacity.js';
import {
  codeGraphCapacityTemporaryDirectory,
  codeGraphDiskReservationFilesystemKey,
  codeGraphSqliteTemporaryDirectoryUsable,
  type CodeGraphDiskReservationOptions,
  withCodeGraphDiskReservation,
} from '../disk/reservation.js';
import {
  codeGraphExtractionWindowSize,
  createCodeGraphExtractionCostModel,
  planCodeGraphExtractionLanes,
  takeCodeGraphExtractionWindow,
} from '../extraction_lanes.js';
import {extractRepositoryFileFacts} from '../extractor.js';
import {
  budgetCachedCodeGraphFacts,
  cachedCodeGraphFactBytes,
  CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
  serializeBoundedCodeGraphFact,
  type BoundedCodeGraphFact,
} from '../fact/budget.js';
import {
  codeGraphContentIdentity,
  codeGraphExtractorSetIdentityFromIdentities,
  codeGraphExtractorSetIdentityFromPackProvenance,
} from '../graph_identity.js';
import {CodeGraphIndexOperationError} from './shared.js';
import {codeGraphFileProgressDimensions, emitContentProgress, type CodeGraphPendingCacheGroup} from './cache_flush.js';
import type {CodeGraphIndexResourceGate} from './types.js';
import type {DirectPersistentCapacityProtection, IncrementalOverlayAssessment} from './types.js';
import {type CodeGraphContentBatchContext, type CodeGraphInventoryOptions} from '../inventory.js';
import {codeGraphInventorySha256Hex} from '../inventory/identity.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, type CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {relocateStructuredSchemaFacts} from '../languages/schemas/extractor.js';
import {codeGraphDiskReservationLockPath, codeGraphDiskReservationRoot, type CodeGraphLayout} from '../layout.js';
import {compareCodeUnits} from '../ordering.js';
import {codeGraphScopeIdentitySuffix, type CodeGraphScopeIdentity} from '../scope/identity.js';
import {budgetParserWorkerFacts, type CodeGraphParserPoolShape, type CodeGraphParserResult} from '../parser_worker.js';
import {
  codeGraphExtractionWorkUnits,
  codeGraphSourceSizeBucket,
  type CodeGraphScanningMetrics,
} from '../progress/telemetry.js';
import {
  CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION,
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphLanguagePackProvenance,
  type CodeGraphStagingProgress,
  type CodeGraphStoreShape,
} from '../store.js';
import {inspectCodeGraphStorage} from '../storage.js';
import {TreeSitterRuntime, type TreeSitterRuntimeShape} from '../tree_sitter/runtime.js';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  type CodeGraphEdge,
  type CodeGraphFileFacts,
  type CodeGraphMaterializationMetrics,
  type CodeGraphInventoryFile,
  type CodeGraphMaterializationRows,
  type CodeGraphProgress,
  type CodeGraphReference,
  type CodeGraphSymbol,
  type RepositoryIdentity,
} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface DirectPersistentCapacityContext {
  readonly capacityProtection?: DirectPersistentCapacityProtection;
  readonly claimMode?: CodeGraphDiskReservationOptions['claimMode'];
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly threadnoteHome: string;
}

export function codeGraphDirectPersistentCapacityProtector(
  input: DirectPersistentCapacityContext,
): CodeGraphDirectPersistentCapacityProtector {
  return (boundary, transaction) =>
    input.capacityProtection
      ? withCodeGraphDiskReservation(
          {
            boundary,
            ...(boundary.operation === 'resolve persistent code graph references' && input.capacityProtection.onTiming
              ? {onTiming: input.capacityProtection.onTiming}
              : {}),
            claimMode: input.claimMode,
            ledgerLockPath: codeGraphDiskReservationLockPath(input.capacityProtection.path, input.threadnoteHome),
            ledgerRoot: codeGraphDiskReservationRoot(input.capacityProtection.path, input.threadnoteHome),
            maintenance: input.capacityProtection.maintenance
              .tick({
                allowIndexPreparation: true,
                anchorIdentity: input.identity,
                ...(input.layout.scopeId === undefined ? {} : {anchorScopeId: input.layout.scopeId}),
                automaticTail: false,
                checkoutId: input.layout.checkoutId,
                databasePath: input.layout.databasePath,
                joinActive: false,
                pressure: 'critical',
                threadnoteHome: input.threadnoteHome,
                writerLockPath: input.layout.databaseWriteLockPath,
              })
              .pipe(
                Effect.catchIf(
                  error => ['busy', 'no-space'].includes(error.code),
                  () => Effect.void,
                ),
              ),
            observe: observeDirectPersistentCapacity({
              boundary,
              fs: input.fs,
              identity: input.identity,
              layout: input.layout,
              protection: input.capacityProtection,
              threadnoteHome: input.threadnoteHome,
            }),
            onDiagnostic: diagnostic => Effect.logWarning(diagnostic),
            onWaiting: (input.onProgress?.({phase: 'waiting', reason: 'disk-capacity'}) ?? Effect.void).pipe(
              Effect.ignore,
            ),
            scope: {
              checkoutId: input.layout.checkoutId,
              ...(input.layout.scopeId === undefined ? {} : {scopeId: input.layout.scopeId}),
            },
          },
          transaction,
        ).pipe(
          Effect.provideService(Crypto.Crypto, input.capacityProtection.crypto),
          Effect.provideService(FileSystem.FileSystem, input.fs),
          Effect.provideService(Path.Path, input.capacityProtection.path),
          Effect.provideService(SystemInfo, input.capacityProtection.system),
        )
      : Effect.fail(
          codeGraphDiskCapacityFailure(
            {
              calibrationIdentity: 'direct-persistent-capacity-unavailable',
              reason: 'calibration-input-unknown',
              state: 'unknown',
            },
            boundary.operation,
            {
              checkoutId: input.layout.checkoutId,
              ...(input.layout.scopeId === undefined ? {} : {scopeId: input.layout.scopeId}),
            },
          ),
        );
}

export function promoteReadySnapshotWithCapacity(
  input: DirectPersistentCapacityContext & {readonly store: CodeGraphStoreShape},
  snapshotId: string,
) {
  return input.store.promote(input.layout.databasePath, input.identity, snapshotId, {
    persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector(input),
  });
}

export interface CodeGraphCacheExtractedRow {
  readonly cacheFact: BoundedCodeGraphFact;
  readonly cacheIdentity: string;
  readonly degraded: boolean;
  readonly file: CodeGraphInventoryFile;
}

export interface CodeGraphCacheContentCoalescer {
  /** @internal Accepts already-extracted rows for bounded structural/load tests. */
  readonly acceptExtracted: (
    rows: readonly CodeGraphCacheExtractedRow[],
    context: CodeGraphContentBatchContext,
  ) => Effect.Effect<void, unknown>;
  /** Starts exact path accounting for a bounded sparse-admission attempt. */
  readonly beginSparseExtractionTracking: Effect.Effect<void>;
  /** Marks the committed-to-worktree extraction boundary, even for deletion-only overlays. */
  readonly beginOverlayExtraction: Effect.Effect<void>;
  /** Drops references only. This is safe in failure/cancellation cleanup because it never starts a write. */
  readonly discard: Effect.Effect<void>;
  /** Stops sparse-attempt path accounting while retaining its terminal count. */
  readonly endSparseExtractionTracking: Effect.Effect<void>;
  /** Exact serialized fact bytes extracted in the current inventory phase. */
  readonly extractedFactBytes: Effect.Effect<number>;
  /** Flushes pending rows and is called only after inventory succeeds. */
  readonly flush: Effect.Effect<void, unknown>;
  readonly onContentBatch: NonNullable<CodeGraphInventoryOptions['onContentBatch']>;
  /** Unique paths extracted during the bounded sparse-admission attempt. */
  readonly sparseExtractedFiles: Effect.Effect<number>;
}

const CODE_GRAPH_CACHE_TIMESTAMP_CAPACITY_PLACEHOLDER = '1970-01-01T00:00:00.000Z';

/** Store surface required by the content coalescer. */
export type CodeGraphCacheContentStore = Pick<CodeGraphStoreShape, 'cacheFacts'>;

/** @internal Exposed for cache coalescing/cancellation contract tests. */
export function cacheContentBatch(options: {
  readonly databasePath: string;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  /** Required verification runs before persistence; unlike contribution enqueue, failures propagate. */
  readonly onSourceParserBatch?: (group: {
    readonly cacheIdentity: string;
    readonly facts: readonly BoundedCodeGraphFact[];
    readonly files: readonly CodeGraphInventoryFile[];
  }) => Effect.Effect<void, unknown>;
  readonly onCachedParserBatch?: (group: {
    readonly cacheIdentity: string;
    readonly facts: readonly BoundedCodeGraphFact[];
    readonly files: readonly CodeGraphInventoryFile[];
  }) => Effect.Effect<void, unknown>;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly parserPool: CodeGraphParserPoolShape;
  readonly preparationGate?: CodeGraphIndexResourceGate;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly store: CodeGraphCacheContentStore;
  readonly threadnoteHome: string;
  readonly treeSitter: TreeSitterRuntimeShape;
}): CodeGraphCacheContentCoalescer {
  const parserCapacity = options.parserPool.capacity;
  const windowSize = codeGraphExtractionWindowSize(parserCapacity);
  const extractionCostModel = createCodeGraphExtractionCostModel<ExtractionReuseGroup>();
  let extractionMilliseconds = 0;
  let extractionFactsBytesCompleted = 0;
  let extractionDegradedFiles = 0;
  let extractionSourceBytesCompleted = 0;
  let extractionWorkUnitsCompleted = 0;
  let extractionPlan = undefined as CodeGraphContentBatchContext['extractionPlan'];
  let extractionPhase: 'none' | 'planned' | 'unplanned' = 'none';
  let sparseExtractionTracking = false;
  const sparseExtractedPaths = new Set<string>();
  let terminalExtractedFactBytes = 0;
  let persistenceMilliseconds = 0;
  let readingMilliseconds = 0;
  let serializationMilliseconds = 0;
  let pendingBytes = 0;
  let pendingRows = 0;
  let latestContext: CodeGraphContentBatchContext | undefined;
  const pendingGroups = new Map<string, CodeGraphPendingCacheGroup>();
  const currentScanningMetrics = (): CodeGraphScanningMetrics | undefined =>
    extractionPlan === undefined
      ? undefined
      : {
          factsBytesCompleted: extractionFactsBytesCompleted,
          degradedFiles: extractionDegradedFiles,
          sourceBytesCompleted: extractionSourceBytesCompleted,
          sourceBytesTotal: extractionPlan.sourceBytesTotal,
          workUnitsCompleted: extractionWorkUnitsCompleted,
          workUnitsTotal: extractionPlan.workUnitsTotal,
        };
  const observeExtractionPlan = (plan: CodeGraphContentBatchContext['extractionPlan']) => {
    if (plan === undefined) {
      if (extractionPhase !== 'unplanned') terminalExtractedFactBytes = 0;
      extractionPhase = 'unplanned';
      extractionPlan = undefined;
      extractionFactsBytesCompleted = 0;
      extractionDegradedFiles = 0;
      extractionSourceBytesCompleted = 0;
      extractionWorkUnitsCompleted = 0;
      return;
    }
    if (
      extractionPhase !== 'planned' ||
      extractionPlan === undefined ||
      extractionPlan.sourceBytesTotal !== plan.sourceBytesTotal ||
      extractionPlan.workUnitsTotal !== plan.workUnitsTotal
    ) {
      terminalExtractedFactBytes = 0;
      extractionFactsBytesCompleted = 0;
      extractionDegradedFiles = 0;
      extractionSourceBytesCompleted = 0;
      extractionWorkUnitsCompleted = 0;
    }
    extractionPhase = 'planned';
    extractionPlan = plan;
  };
  const completeExtractionMetrics = (file: CodeGraphInventoryFile, factsBytes: number) => {
    terminalExtractedFactBytes = Math.min(Number.MAX_SAFE_INTEGER, terminalExtractedFactBytes + factsBytes);
    if (extractionPlan === undefined) return undefined;
    extractionFactsBytesCompleted = Math.min(Number.MAX_SAFE_INTEGER, extractionFactsBytesCompleted + factsBytes);
    extractionSourceBytesCompleted = Math.min(
      extractionPlan.sourceBytesTotal,
      extractionSourceBytesCompleted + file.size,
    );
    extractionWorkUnitsCompleted = Math.min(
      extractionPlan.workUnitsTotal,
      extractionWorkUnitsCompleted +
        codeGraphExtractionWorkUnits(file.size, file.language, codeGraphSourceSizeBucket(file.size)),
    );
    return currentScanningMetrics();
  };
  type SerializedParserResult = CodeGraphParserResult & {readonly cacheFact: BoundedCodeGraphFact};
  const reusableExtractions = new Map<string, SerializedParserResult>();
  const reusableExtractionUses = new Map<string, number>();
  const flushPendingGroup = (key: string) =>
    Effect.gen(function* () {
      const group = pendingGroups.get(key);
      if (!group || group.files.length === 0) return;
      const context = latestContext;
      if (!context)
        return yield* CodeGraphIndexOperationError.make({
          message: 'Code graph cache persistence context is unavailable.',
        });
      const representative = group.files[0];
      const groupBytes = EffectArray.reduce(group.files, 0, (total, file) => total + file.size);
      const groupFactBytes = EffectArray.reduce(group.facts, 0, (total, fact) => total + fact.bytes);
      yield* emitContentProgress(
        options.onProgress,
        context,
        {
          batchCompleted: 0,
          batchTotal: group.files.length,
          bytes: groupBytes,
          ...codeGraphFileProgressDimensions(representative, options.languagePacks),
          factsBytes: groupFactBytes,
          language: representative.language,
          path: representative.path,
          sizeBucket: codeGraphSourceSizeBucket(groupBytes),
          stage: 'persisting',
        },
        extractionMilliseconds,
        persistenceMilliseconds,
        serializationMilliseconds,
        currentScanningMetrics(),
      );
      const startedAt = performance.now();
      yield* options.onSourceParserBatch?.(group) ?? Effect.void;
      yield* options.store.cacheFacts(
        options.databasePath,
        group.files,
        group.facts,
        group.cacheIdentity,
        options.persistentCapacityProtector,
      );
      yield* (
        options.onCachedParserBatch?.({
          cacheIdentity: group.cacheIdentity,
          facts: group.facts,
          files: group.files,
        }) ?? Effect.void
      ).pipe(Effect.ignore);
      const elapsed = Math.max(0, performance.now() - startedAt);
      persistenceMilliseconds += elapsed;
      pendingBytes -= group.payloadBytes;
      pendingRows -= group.files.length;
      pendingGroups.delete(key);
      yield* emitContentProgress(
        options.onProgress,
        context,
        {
          batchCompleted: group.files.length,
          batchTotal: group.files.length,
          bytes: groupBytes,
          ...codeGraphFileProgressDimensions(representative, options.languagePacks),
          factsBytes: groupFactBytes,
          language: representative.language,
          path: representative.path,
          persistMilliseconds: elapsed,
          relations: EffectArray.reduce(group.facts, 0, (total, fact) => total + fact.facts.edges.length),
          sizeBucket: codeGraphSourceSizeBucket(groupBytes),
          stage: 'persisting',
          symbols: EffectArray.reduce(group.facts, 0, (total, fact) => total + fact.facts.symbols.length),
        },
        extractionMilliseconds,
        persistenceMilliseconds,
        serializationMilliseconds,
        currentScanningMetrics(),
      );
    });
  const flushOldestPendingGroup = () => {
    const key = pendingGroups.keys().next().value;
    return key === undefined ? Effect.void : flushPendingGroup(key);
  };
  const acceptExtracted = (rows: readonly CodeGraphCacheExtractedRow[], context: CodeGraphContentBatchContext) =>
    Effect.gen(function* () {
      latestContext = context;
      for (const {cacheFact, cacheIdentity: activeCacheIdentity, degraded, file} of rows) {
        if (sparseExtractionTracking) sparseExtractedPaths.add(file.path);
        const cacheIdentity = degraded ? degradedParserCacheIdentity(activeCacheIdentity) : activeCacheIdentity;
        const key = `${degraded ? 'degraded' : 'durable'}\0${cacheIdentity}`;
        const reuseClass = degraded ? undefined : codeGraphBlobExtractionReuseClass(file);
        const rowBytes = codeGraphFileBlobCapacityBytes({
          ...(reuseClass === undefined ? {} : {blobId: file.blobId, reuseClass}),
          contentHash: file.contentHash,
          createdAt: CODE_GRAPH_CACHE_TIMESTAMP_CAPACITY_PLACEHOLDER,
          extractorSet: cacheIdentity,
          factsJson: cacheFact.json,
          path: file.path,
        });
        if (rowBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes) {
          return yield* CodeGraphIndexOperationError.make({
            message: `Code graph cache row exceeds the persistence payload ceiling.`,
          });
        }
        while (
          pendingRows > 0 &&
          (pendingRows >= CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows ||
            pendingBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes - rowBytes)
        ) {
          yield* flushOldestPendingGroup();
        }
        if (pendingGroups.get(key)?.paths.has(file.path)) {
          // Committed-tree and dirty-overlay inventory phases can extract the
          // same path with different content hashes. Both physical cache rows
          // are reusable, so flush the older row instead of deduplicating it.
          yield* flushPendingGroup(key);
        }
        const pending = pendingGroups.get(key) ?? {
          cacheIdentity,
          facts: [],
          files: [],
          paths: new Set<string>(),
          payloadBytes: 0,
        };
        if (!pendingGroups.has(key)) pendingGroups.set(key, pending);
        const {bytes: _bytes, content: _content, ...baseCacheFile} = file;
        const cacheFile = degraded ? {...baseCacheFile, blobId: ''} : baseCacheFile;
        pending.files.push(cacheFile);
        pending.facts.push(cacheFact);
        pending.paths.add(file.path);
        pending.payloadBytes += rowBytes;
        pendingBytes += rowBytes;
        pendingRows += 1;
      }
    });
  const onContentBatch = (
    files: Parameters<typeof extractRepositoryFileFacts>[0],
    context: CodeGraphContentBatchContext,
  ) =>
    Effect.gen(function* () {
      readingMilliseconds += context.readingMilliseconds;
      observeExtractionPlan(context.extractionPlan);
      const cumulativeContext = {...context, readingMilliseconds};
      latestContext = cumulativeContext;
      let parsedCompleted = 0;
      const orderedFiles = [...files].sort((left, right) => compareCodeUnits(left.path, right.path));
      const localReuseCounts = new Map<string, number>();
      for (const file of orderedFiles) {
        const reuseKey = blobReuseKeyForFile(file, options.languagePacks);
        if (reuseKey !== undefined) localReuseCounts.set(reuseKey, (localReuseCounts.get(reuseKey) ?? 0) + 1);
      }
      const expectedReuseCount = (key: string): number =>
        cumulativeContext.blobReuseCounts?.get(key) ?? localReuseCounts.get(key) ?? 0;
      const finishReuseAttempt = (key: string | undefined) => {
        if (key === undefined) return;
        const uses = (reusableExtractionUses.get(key) ?? 0) + 1;
        if (uses >= expectedReuseCount(key)) {
          reusableExtractionUses.delete(key);
          reusableExtractions.delete(key);
        } else {
          reusableExtractionUses.set(key, uses);
        }
      };
      let remainingGroups = extractionReuseGroups(orderedFiles, options.languagePacks);
      while (remainingGroups.length > 0) {
        const lane = planCodeGraphExtractionLanes(remainingGroups, parserCapacity, extractionCostModel)[0];
        const [groupWindow, rest] = takeCodeGraphExtractionWindow(lane.groups, windowSize);
        remainingGroups = rest;
        const window = EffectArray.flatMap(groupWindow, group => group.files).sort((left, right) =>
          compareCodeUnits(left.path, right.path),
        );
        const runExtraction = () =>
          Effect.gen(function* () {
            let windowCompleted = 0;
            const extractGroup = (group: ExtractionReuseGroup, parserExtract: CodeGraphParserPoolShape['extract']) =>
              Effect.forEach(
                group.files,
                file =>
                  Effect.gen(function* () {
                    const reuseKey = group.reuseKey;
                    yield* emitContentProgress(
                      options.onProgress,
                      cumulativeContext,
                      {
                        batchCompleted: parsedCompleted,
                        batchTotal: files.length,
                        bytes: file.size,
                        ...codeGraphFileProgressDimensions(file, options.languagePacks),
                        language: file.language,
                        path: file.path,
                        stage: 'extracting',
                      },
                      extractionMilliseconds,
                      persistenceMilliseconds,
                      serializationMilliseconds,
                      currentScanningMetrics(),
                    );
                    const donor = reuseKey === undefined ? undefined : reusableExtractions.get(reuseKey);
                    const relocation = donor === undefined ? undefined : relocateSerializedParserResult(file, donor);
                    const reused = relocation?.result;
                    serializationMilliseconds += relocation?.serializationMilliseconds ?? 0;
                    if (reused !== undefined) {
                      finishReuseAttempt(reuseKey);
                      windowCompleted += 1;
                      yield* emitContentProgress(
                        options.onProgress,
                        cumulativeContext,
                        {
                          batchCompleted: parsedCompleted + windowCompleted,
                          batchTotal: files.length,
                          bytes: file.size,
                          ...codeGraphFileProgressDimensions(file, options.languagePacks),
                          degraded: false,
                          factsBytes: reused.cacheFact.bytes,
                          language: file.language,
                          parseMilliseconds: 0,
                          path: file.path,
                          relations: reused.facts.edges.length,
                          stage: 'extracting',
                          symbols: reused.facts.symbols.length,
                        },
                        extractionMilliseconds,
                        persistenceMilliseconds,
                        serializationMilliseconds,
                        completeExtractionMetrics(file, reused.cacheFact.bytes),
                      );
                      return {file, requestMilliseconds: 0, result: reused, reused: true};
                    }
                    const requestStartedAt = performance.now();
                    const parsed = yield* extractParserFacts(file, options, parserExtract);
                    const requestMilliseconds = Math.max(0, performance.now() - requestStartedAt);
                    const freshSerializationStartedAt = performance.now();
                    const cacheFact = serializeBoundedCodeGraphFact(parsed.facts);
                    serializationMilliseconds += Math.max(0, performance.now() - freshSerializationStartedAt);
                    const result = {
                      ...parsed,
                      cacheFact,
                      facts: cacheFact.facts,
                    } satisfies CodeGraphParserResult & {readonly cacheFact: BoundedCodeGraphFact};
                    if (result.degraded) extractionDegradedFiles += 1;
                    if (!result.degraded && reuseKey !== undefined && expectedReuseCount(reuseKey) > 1) {
                      reusableExtractions.set(reuseKey, result);
                    }
                    finishReuseAttempt(reuseKey);
                    windowCompleted += 1;
                    yield* emitContentProgress(
                      options.onProgress,
                      cumulativeContext,
                      {
                        batchCompleted: parsedCompleted + windowCompleted,
                        batchTotal: files.length,
                        bytes: file.size,
                        ...codeGraphFileProgressDimensions(file, options.languagePacks),
                        degraded: result.degraded,
                        ...(result.degradationReason === undefined
                          ? {}
                          : {degradationReason: result.degradationReason}),
                        factsBytes: result.cacheFact.bytes,
                        language: file.language,
                        parseMilliseconds: result.parseMilliseconds,
                        path: file.path,
                        relations: result.facts.edges.length,
                        stage: 'extracting',
                        symbols: result.facts.symbols.length,
                      },
                      extractionMilliseconds + result.parseMilliseconds,
                      persistenceMilliseconds,
                      serializationMilliseconds,
                      completeExtractionMetrics(file, result.cacheFact.bytes),
                    );
                    return {file, requestMilliseconds, result, reused: false};
                  }),
                {concurrency: 1},
              );
            let nextGroupIndex = 0;
            const drainGroups = (parserExtract: CodeGraphParserPoolShape['extract']) =>
              Effect.gen(function* () {
                const drained = [];
                while (nextGroupIndex < groupWindow.length) {
                  const group = groupWindow[nextGroupIndex];
                  nextGroupIndex += 1;
                  if (group !== undefined) drained.push(yield* extractGroup(group, parserExtract));
                }
                return drained;
              });
            const groupedResults = (yield* Effect.forEach(
              Array.from({length: Math.min(lane.concurrency, groupWindow.length)}),
              () =>
                options.parserPool.withParserSlot(options.threadnoteHome, window, extract =>
                  drainGroups((file, _threadnoteHome) => extract(file)),
                ),
              {concurrency: 'unbounded'},
            )).flat();
            const results = groupedResults.flat();
            for (const observed of [...results].sort((left, right) =>
              compareCodeUnits(left.file.path, right.file.path),
            )) {
              if (observed.reused) continue;
              extractionCostModel.observe(observed.file, {
                factsBytes: observed.result.cacheFact.bytes,
                requestMilliseconds: observed.requestMilliseconds,
              });
            }
            extractionMilliseconds += EffectArray.reduce(
              results,
              0,
              (total, result) => total + result.result.parseMilliseconds,
            );
            parsedCompleted += results.length;
            const resultsByPath = new Map(EffectArray.map(results, result => [result.file.path, result.result]));
            const extractedRows: CodeGraphCacheExtractedRow[] = [];
            for (const group of groupFilesByCacheIdentity(window, options.languagePacks)) {
              const durableFiles = EffectArray.filter(group.files, file => !resultsByPath.get(file.path)!.degraded);
              const degradedFiles = EffectArray.filter(
                group.files,
                (file, __effectArrayIndex) =>
                  __effectArrayIndex in group.files && resultsByPath.get(file.path)!.degraded,
              );
              for (const [degraded, cacheFiles] of [
                [false, durableFiles],
                [true, degradedFiles],
              ] as const) {
                for (const file of cacheFiles) {
                  extractedRows.push({
                    cacheFact: resultsByPath.get(file.path)!.cacheFact,
                    cacheIdentity: group.cacheIdentity,
                    degraded,
                    file,
                  });
                }
              }
            }
            return extractedRows;
          });
        const extraction = runExtraction();
        const admittedExtraction = options.preparationGate ? options.preparationGate(extraction) : extraction;
        yield* acceptExtracted(yield* admittedExtraction, cumulativeContext);
      }
    });
  return {
    acceptExtracted,
    beginSparseExtractionTracking: Effect.sync(() => {
      sparseExtractedPaths.clear();
      sparseExtractionTracking = true;
    }),
    beginOverlayExtraction: Effect.sync(() => observeExtractionPlan(undefined)),
    discard: Effect.sync(() => {
      pendingGroups.clear();
      pendingBytes = 0;
      pendingRows = 0;
      latestContext = undefined;
      reusableExtractions.clear();
      reusableExtractionUses.clear();
    }),
    endSparseExtractionTracking: Effect.sync(() => {
      sparseExtractionTracking = false;
    }),
    extractedFactBytes: Effect.sync(() => terminalExtractedFactBytes),
    flush: Effect.gen(function* () {
      while (pendingGroups.size > 0) yield* flushOldestPendingGroup();
      reusableExtractions.clear();
      reusableExtractionUses.clear();
    }),
    onContentBatch,
    sparseExtractedFiles: Effect.sync(() => sparseExtractedPaths.size),
  };
}
function blobReuseKeyForFile(
  file: CodeGraphInventoryFile,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): string | undefined {
  const cacheIdentity = Option.getOrUndefined(languagePacks.cacheIdentityForPath(file.path));
  return cacheIdentity === undefined ? undefined : codeGraphBlobReuseCacheKey(file, cacheIdentity);
}
function extractionReuseGroups(
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): readonly {readonly files: readonly CodeGraphInventoryFile[]; readonly reuseKey?: string}[] {
  const groups = new Map<string, {files: CodeGraphInventoryFile[]; reuseKey?: string}>();
  for (const file of files) {
    const reuseKey = blobReuseKeyForFile(file, languagePacks);
    const key = reuseKey ?? `path\0${file.path}`;
    const group = groups.get(key) ?? {files: [], ...(reuseKey === undefined ? {} : {reuseKey})};
    if (!groups.has(key)) groups.set(key, group);
    group.files.push(file);
  }
  return [...groups.values()];
}

type ExtractionReuseGroup = ReturnType<typeof extractionReuseGroups>[number];
function relocateSerializedParserResult(
  file: CodeGraphInventoryFile,
  donor: CodeGraphParserResult & {readonly cacheFact: BoundedCodeGraphFact},
):
  | {
      readonly result: CodeGraphParserResult & {readonly cacheFact: BoundedCodeGraphFact};
      readonly serializationMilliseconds: number;
    }
  | undefined {
  if (donor.degraded) return undefined;
  const relocated = relocateStructuredSchemaFacts(file, donor.facts);
  if (relocated === undefined) return undefined;
  const serializationStartedAt = performance.now();
  const cacheFact = serializeBoundedCodeGraphFact(relocated);
  return {
    result: {cacheFact, degraded: false, facts: cacheFact.facts, parseMilliseconds: 0},
    serializationMilliseconds: Math.max(0, performance.now() - serializationStartedAt),
  };
}

function extractParserFacts(
  file: CodeGraphInventoryFile,
  options: {
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly parserPool: CodeGraphParserPoolShape;
    readonly threadnoteHome: string;
    readonly treeSitter: TreeSitterRuntimeShape;
  },
  parserExtract: CodeGraphParserPoolShape['extract'] = options.parserPool.extract,
): Effect.Effect<CodeGraphParserResult, unknown> {
  const match = options.languagePacks.match(file.path);
  const boundedManifestExtraction =
    file.size <= 1_048_576 && Option.isSome(match) && match.value.pack.id === 'manifests';
  if (file.bytes === undefined && !boundedManifestExtraction) return parserExtract(file, options.threadnoteHome);
  return Effect.gen(function* () {
    const startedAt = performance.now();
    const facts = yield* options.languagePacks
      .extractRawFile(file)
      .pipe(Effect.provideService(TreeSitterRuntime, options.treeSitter));
    const bounded = budgetParserWorkerFacts(file, facts);
    return {
      degraded: bounded.degraded,
      facts: bounded.facts,
      parseMilliseconds: Math.max(0, performance.now() - startedAt),
    };
  });
}

/** Cache generations that can satisfy inventory content admission for active parser packs. */
export function codeGraphParserCacheLookupGenerations(activeIdentities: readonly string[]): readonly {
  readonly activeIdentity: string;
  readonly storedIdentity: string;
}[] {
  return EffectArray.flatMap([...new Set(activeIdentities)].sort(compareCodeUnits), activeIdentity => [
    {activeIdentity, storedIdentity: activeIdentity},
    {activeIdentity, storedIdentity: degradedParserCacheIdentity(activeIdentity)},
  ]);
}

/** Rebind a physical cache-generation key to the active identity expected by inventory admission. */
export function codeGraphActiveParserCacheKey(key: string, storedIdentity: string, activeIdentity: string): string {
  if (storedIdentity === activeIdentity) return key;
  const terminalGeneration = `\0${storedIdentity}`;
  if (Effect2.pipe(key, EffectString.endsWith(terminalGeneration)))
    return `${Effect2.pipe(key, EffectString.slice(0, -terminalGeneration.length))}\0${activeIdentity}`;
  const embeddedGeneration = `\0${storedIdentity}\0`;
  if (!Effect2.pipe(key, EffectString.includes(embeddedGeneration))) return key;
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The opaque identity must remain literal even when it contains dollar replacement patterns; Effect String accepts replacement strings only.
  return key.replace(embeddedGeneration, () => `\0${activeIdentity}\0`);
}

export {verifyIndexInput} from './input/observation.js';

export function extractorSetIdentity(
  files: readonly {readonly contentHash: string; readonly path: string}[],
  languagePacks: CodeGraphLanguagePackRegistryShape = BUILTIN_LANGUAGE_PACK_REGISTRY,
): string {
  const paths = EffectArray.map(files, file => file.path);
  return codeGraphExtractorSetIdentityFromIdentities(
    languagePacks.activeCacheIdentities(paths),
    languagePacks.activeDerivationIdentities(paths),
  );
}

export function extractorSetIdentityFromPackProvenance(provenance: readonly CodeGraphLanguagePackProvenance[]): string {
  return codeGraphExtractorSetIdentityFromPackProvenance(provenance);
}

export function parserCacheIdentity(): string {
  const identity = BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentityForPath('source.ts');
  return identity._tag === 'Some' ? identity.value : sha256HexSync(`${CODE_GRAPH_EXTRACTOR_SET_VERSION}:typescript`);
}

export function snapshotIdentity(
  identity: {
    readonly headCommit: string;
    readonly repositoryId: string;
    readonly worktreeId: string;
  },
  dirty: boolean,
  extractorSet: string,
  files: readonly {readonly contentHash: string; readonly path: string; readonly source: string}[],
  scope?: CodeGraphScopeIdentity,
): string {
  const prefix =
    `snapshot-v2\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${identity.repositoryId}\n` +
    `${dirty ? identity.worktreeId : 'shared-commit'}\n${identity.headCommit}\n${dirty ? 'dirty' : 'clean'}\n` +
    `${extractorSet}\n${codeGraphScopeIdentitySuffix(scope)}`;
  return `cgsn_${Effect2.pipe(
    codeGraphInventorySha256Hex(prefix, files, file => `${file.path}\0${file.contentHash}\0${file.source}`),
    EffectString.slice(0, 40),
  )}`;
}

/**
 * Deterministic dirty identity for a persisted-base delta. The base snapshot
 * and exact overlay observation replace a repository-wide inventory replay.
 */
export function sparseOverlaySnapshotIdentity(
  identity: {
    readonly headCommit: string;
    readonly repositoryId: string;
    readonly worktreeId: string;
  },
  baseSnapshotId: string,
  extractorSet: string,
  overlayFingerprint: string,
  scope?: CodeGraphScopeIdentity,
): string {
  return `cgsn_${Effect2.pipe(
    sha256HexSync(
      `snapshot-sparse-overlay-v2\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${identity.repositoryId}\n${identity.worktreeId}\n${identity.headCommit}\n${baseSnapshotId}\n${extractorSet}\n${overlayFingerprint}${codeGraphScopeIdentitySuffix(scope)}`,
    ),
    EffectString.slice(0, 40),
  )}`;
}

/** Content identity for a persisted-base delta without a flat full-inventory hash. */
export function sparseOverlayGraphContentIdentity(
  baseGraphContentId: string,
  extractorSet: string,
  overlayFingerprint: string,
  scope?: CodeGraphScopeIdentity,
): string {
  return `cgc_${Effect2.pipe(
    sha256HexSync(
      `graph-content-sparse-overlay-v2\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${baseGraphContentId}\n${extractorSet}\n${overlayFingerprint}${codeGraphScopeIdentitySuffix(scope)}`,
    ),
    EffectString.slice(0, 40),
  )}`;
}

/**
 * Identifies the graph-producing inputs without coupling them to a Git commit or
 * worktree. Commit observations remain snapshot rows and may safely alias this
 * identity when the eligible inventory and derivation identity are unchanged.
 */
export function graphContentIdentity(
  extractorSet: string,
  files: readonly {
    readonly contentHash: string;
    readonly language?: string;
    readonly mode?: string;
    readonly path: string;
  }[],
  scope?: CodeGraphScopeIdentity,
): string {
  return codeGraphContentIdentity(extractorSet, files, scope);
}

export function selectedDecodedFactBytes(
  bytesByPath: ReadonlyMap<string, number> | undefined,
  paths: readonly string[],
): number | undefined {
  if (paths.length === 0) return 0;
  if (bytesByPath === undefined) return undefined;
  let total = 0;
  for (const path of paths) {
    const bytes = bytesByPath.get(path);
    if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) return undefined;
    total = Math.min(Number.MAX_SAFE_INTEGER, total + bytes);
  }
  return total;
}

export function directFullSnapshotIdentity(logicalSnapshotId: string): string {
  if (!/^cgsn_[0-9a-f]{40}$/.test(logicalSnapshotId)) {
    throw CodeGraphIndexOperationError.make({message: 'Logical snapshot identity is invalid.'});
  }
  return `${logicalSnapshotId}-direct`;
}

export function forcedSnapshotIdentity(logicalSnapshotId: string, forceGeneration: string | undefined): string {
  return forceGeneration ? `${logicalSnapshotId}-full-${forceGeneration}` : logicalSnapshotId;
}

export const firstReadySnapshotById = Effect.fn('codeGraph.firstReadySnapshotById')(function* (
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshotIds: readonly string[],
) {
  for (const snapshotId of snapshotIds) {
    const ready = yield* store.currentLexicalReadySnapshotById(databasePath, snapshotId);
    if (ready) return ready;
  }
  return undefined;
});

/**
 * Decide whether a clean ready snapshot for HEAD is graph-equivalent to the
 * current inventory and safe to promote without rematerializing.
 *
 * Requires an explicit graphContentId on the candidate so we never promote a
 * same-commit row that merely shares extractor set but not inventory content.
 */
export function shouldReuseReadySnapshotForCleanCommit(input: {
  readonly candidate?: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly graphContentId?: string;
    readonly id: string;
  };
  readonly graphContentId: string;
  readonly headCommit: string;
}): boolean {
  return (
    input.candidate !== undefined &&
    input.candidate.dirty === false &&
    input.candidate.commit === input.headCommit &&
    input.candidate.graphContentId !== undefined &&
    input.candidate.graphContentId === input.graphContentId
  );
}

export const reusableReadySnapshotForCleanCommit = Effect.fn('codeGraph.reusableReadySnapshotForCleanCommit')(
  function* (input: {
    readonly scopeId?: string;
    readonly databasePath: string;
    readonly extractorSet: string;
    readonly graphContentId: string;
    readonly headCommit: string;
    readonly repositoryId: string;
    readonly store: CodeGraphStoreShape;
  }) {
    const candidate = yield* input.store.readySnapshotForCommit(
      input.databasePath,
      input.repositoryId,
      input.headCommit,
      input.extractorSet,
      input.scopeId,
    );
    return shouldReuseReadySnapshotForCleanCommit({
      candidate,
      graphContentId: input.graphContentId,
      headCommit: input.headCommit,
    })
      ? candidate
      : undefined;
  },
);

export function embeddingSymbolSource(store: CodeGraphStoreShape, databasePath: string, snapshotId: string) {
  return {
    count: store.countEmbeddingSymbols(databasePath, snapshotId),
    loadPage: (cursor: Parameters<CodeGraphStoreShape['loadSymbolPage']>[2], limit: number) =>
      store.loadEmbeddingSymbolPage(databasePath, snapshotId, cursor, limit),
  };
}

const observeDirectPersistentCapacity = Effect.fn('codeGraph.observeDirectPersistentCapacity')(function* (input: {
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly layout: CodeGraphLayout;
  readonly protection: DirectPersistentCapacityProtection;
  readonly threadnoteHome: string;
}) {
  const temporaryDirectory = yield* codeGraphCapacityTemporaryDirectory(
    {
      boundary: input.boundary,
      environment: input.protection.system.environment(),
      platform: input.protection.system.platform,
      temporaryDirectory: input.protection.temporaryDirectory,
    },
    directory => codeGraphSqliteTemporaryDirectoryUsable(input.fs, directory),
  );
  const [durableFilesystem, temporaryFilesystem] = yield* Effect.all(
    [
      input.fs.stat(input.layout.repositoryRoot).pipe(
        Effect.map(info => info.dev),
        Effect.option,
      ),
      temporaryDirectory === undefined
        ? Effect.succeedNone
        : input.fs.stat(temporaryDirectory).pipe(
            Effect.map(info => info.dev),
            Effect.option,
          ),
    ] as const,
    {concurrency: 2},
  );
  const filesystemsShared =
    Option.isSome(durableFilesystem) && Option.isSome(temporaryFilesystem)
      ? durableFilesystem.value === temporaryFilesystem.value
      : undefined;
  const probe = (target: string) =>
    input.protection.availableDiskBytes(target, input.boundary).pipe(Effect.orElseSucceed(() => undefined));
  const temporaryProbe = temporaryDirectory === undefined ? succeedUndefined : probe(temporaryDirectory);
  const availability =
    filesystemsShared === undefined
      ? Effect.succeed([undefined, undefined] as const)
      : filesystemsShared
        ? probe(input.layout.repositoryRoot).pipe(Effect.map(available => [available, available] as const))
        : Effect.all([probe(input.layout.repositoryRoot), temporaryProbe] as const, {
            concurrency: 2,
          });
  const [[durableAvailableBytes, temporaryAvailableBytes], storage] = yield* Effect.all(
    [
      availability,
      inspectCodeGraphStorage(input.threadnoteHome, input.identity.checkoutId, {openWhileLocked: true}).pipe(
        Effect.option,
      ),
    ] as const,
    {concurrency: 2},
  );
  const pageStorage =
    Option.isSome(storage) && storage.value.state === 'available' && storage.value.pageStorage.state === 'available'
      ? storage.value.pageStorage
      : undefined;
  const demand = codeGraphPersistentCapacityDemand({
    boundary: input.boundary,
    lexicalFormatVersion: CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION,
    pageSize: pageStorage?.pageSize ?? 0,
    walAutoCheckpointPages: input.protection.walAutoCheckpointPages,
  });
  return {
    demand,
    durableAvailableBytes,
    durableFilesystemKey: Option.isSome(durableFilesystem)
      ? (codeGraphDiskReservationFilesystemKey(input.protection.system.platform, durableFilesystem.value) ??
        'durable-filesystem-unknown')
      : 'durable-filesystem-unknown',
    freelistBytes:
      input.boundary.operation === 'sort persistent code graph materialization spool'
        ? 0
        : (pageStorage?.reclaimableBytes ?? 0),
    temporaryAvailableBytes,
    temporaryFilesystemKey: Option.isSome(temporaryFilesystem)
      ? (codeGraphDiskReservationFilesystemKey(input.protection.system.platform, temporaryFilesystem.value) ??
        'temporary-filesystem-unknown')
      : 'temporary-filesystem-unknown',
  };
});

/** @internal Narrow observation seam for capacity-topology integration coverage. */
export const observeDirectPersistentCapacityForTest = observeDirectPersistentCapacity;

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const CODE_GRAPH_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: Number.POSITIVE_INFINITY,
} as const;

export const CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS = 10 * 60_000;
// Keep this logical boundary stable because its batch indexes and fingerprints
// are persisted as resumable-build receipts. The transaction coalescer below
// combines up to four logical batches into the 512-file physical envelope.
const FACT_MATERIALIZATION_BATCH_FILES = 128;
const FACT_MATERIALIZATION_BATCH_SOURCE_BYTES = 16 * 1_048_576;
const FACT_MATERIALIZATION_BATCH_CACHED_FACT_BYTES = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM;
const PERSISTENT_MATERIALIZATION_TRANSACTION_BATCHES = 4;
export const PERSISTENT_MATERIALIZATION_TRANSACTION_FILES = 512;
export const PERSISTENT_MATERIALIZATION_TRANSACTION_SOURCE_BYTES = 64 * 1_048_576;
export const PERSISTENT_MATERIALIZATION_TRANSACTION_FACT_BYTES = 32 * 1_048_576;
// Conservative, warning-only planning factors informed by beta.30's observed
// production-shaped live amplification. They cover indexed TEMP rows, the durable candidate
// plus WAL, rollback/subjournals, and one concurrent worktree/repository build.
// Actual high-water telemetry remains authoritative and should recalibrate
// these factors as retained release evidence grows.
const FACT_MATERIALIZATION_TEMP_FACT_AMPLIFICATION_HEURISTIC = 5;
const FACT_MATERIALIZATION_DURABLE_FACT_AMPLIFICATION_HEURISTIC = 5;
const FACT_MATERIALIZATION_JOURNAL_FACT_AMPLIFICATION_HEURISTIC = 3;
const FACT_MATERIALIZATION_TEMP_MINIMUM_ESTIMATE_BYTES = 512 * 1_048_576;
const FACT_MATERIALIZATION_DIRECT_TEMP_ESTIMATE_BYTES = 16 * 1_048_576;
const FACT_MATERIALIZATION_DURABLE_MINIMUM_ESTIMATE_BYTES = 512 * 1_048_576;
const FACT_MATERIALIZATION_JOURNAL_MINIMUM_ESTIMATE_BYTES = 256 * 1_048_576;
export const CODE_GRAPH_MATERIALIZATION_STORAGE_HEURISTIC_MODEL_VERSION = 1 as const;

export function estimatedMaterializationStorageBytes(
  factBytes: number | undefined,
  sourceBytes: number,
  materializationMode: 'direct-persistent' | 'temporary-staged' = 'temporary-staged',
  estimateBasis: 'cached-fact-bytes' | 'final-fact-bytes' = 'cached-fact-bytes',
) {
  const basisBytes = factBytes ?? sourceBytes;
  const estimatedTemporaryDatabaseBytes =
    materializationMode === 'direct-persistent'
      ? FACT_MATERIALIZATION_DIRECT_TEMP_ESTIMATE_BYTES
      : Math.max(
          FACT_MATERIALIZATION_TEMP_MINIMUM_ESTIMATE_BYTES,
          saturatingMultiply(basisBytes, FACT_MATERIALIZATION_TEMP_FACT_AMPLIFICATION_HEURISTIC),
        );
  const estimatedDurableSnapshotBytes = Math.max(
    FACT_MATERIALIZATION_DURABLE_MINIMUM_ESTIMATE_BYTES,
    saturatingMultiply(basisBytes, FACT_MATERIALIZATION_DURABLE_FACT_AMPLIFICATION_HEURISTIC),
  );
  const estimatedJournalBytes = Math.max(
    FACT_MATERIALIZATION_JOURNAL_MINIMUM_ESTIMATE_BYTES,
    saturatingMultiply(basisBytes, FACT_MATERIALIZATION_JOURNAL_FACT_AMPLIFICATION_HEURISTIC),
  );
  const estimatedConcurrentBuildBytes = saturatingAdd(
    estimatedTemporaryDatabaseBytes,
    estimatedDurableSnapshotBytes,
    estimatedJournalBytes,
  );
  return {
    decisionLayer: 'whole-build-heuristic' as const,
    enforcement: 'advisory' as const,
    estimateBasis: factBytes === undefined ? ('source-bytes-fallback' as const) : estimateBasis,
    estimatedConcurrentBuildBytes,
    estimatedDurableSnapshotBytes,
    estimatedJournalBytes,
    estimatedRequiredBytes: saturatingAdd(estimatedConcurrentBuildBytes, estimatedConcurrentBuildBytes),
    estimatedTemporaryDatabaseBytes,
    materializationMode,
    modelVersion: CODE_GRAPH_MATERIALIZATION_STORAGE_HEURISTIC_MODEL_VERSION,
  };
}

export interface MaterializationStorageAvailability {
  readonly durableAvailableBytes?: number;
  readonly filesystemsShared?: boolean;
  readonly temporaryAvailableBytes?: number;
}

export type MaterializationStoragePlan = ReturnType<typeof estimatedMaterializationStorageBytes> &
  MaterializationStorageAvailability & {
    readonly availableBytes?: number;
    readonly estimatedDurableFilesystemRequiredBytes: number;
    readonly estimatedTemporaryFilesystemRequiredBytes: number;
  };

/**
 * Plans warning-only materialization headroom for SQLite's durable and TEMP
 * filesystems. A second complete allowance covers one concurrent worktree or
 * repository build without imposing a repository-size rejection.
 */
export function materializationStoragePlan(
  estimate: ReturnType<typeof estimatedMaterializationStorageBytes>,
  availability: MaterializationStorageAvailability,
): MaterializationStoragePlan {
  const estimatedDurableFilesystemRequiredBytes = saturatingMultiply(
    estimate.materializationMode === 'direct-persistent'
      ? saturatingAdd(estimate.estimatedDurableSnapshotBytes, estimate.estimatedJournalBytes)
      : estimate.estimatedDurableSnapshotBytes,
    2,
  );
  const estimatedTemporaryFilesystemRequiredBytes = saturatingMultiply(
    estimate.materializationMode === 'direct-persistent'
      ? estimate.estimatedTemporaryDatabaseBytes
      : saturatingAdd(estimate.estimatedTemporaryDatabaseBytes, estimate.estimatedJournalBytes),
    2,
  );
  const sharedAvailableBytes =
    availability.filesystemsShared === true
      ? minimumDefined(availability.durableAvailableBytes, availability.temporaryAvailableBytes)
      : undefined;
  return {
    ...estimate,
    ...availability,
    ...(sharedAvailableBytes === undefined ? {} : {availableBytes: sharedAvailableBytes}),
    estimatedDurableFilesystemRequiredBytes,
    estimatedTemporaryFilesystemRequiredBytes,
  };
}

export function materializationStorageShortfalls(storage: {
  readonly availableBytes?: number;
  readonly durableAvailableBytes?: number;
  readonly estimatedDurableFilesystemRequiredBytes?: number;
  readonly estimatedRequiredBytes?: number;
  readonly estimatedTemporaryFilesystemRequiredBytes?: number;
  readonly filesystemsShared?: boolean;
  readonly temporaryAvailableBytes?: number;
}): readonly ('durable' | 'shared' | 'temporary')[] {
  if (storage.filesystemsShared === true) {
    return storage.availableBytes !== undefined &&
      storage.estimatedRequiredBytes !== undefined &&
      storage.availableBytes < storage.estimatedRequiredBytes
      ? ['shared']
      : [];
  }
  const shortfalls: ('durable' | 'temporary')[] = [];
  if (
    storage.durableAvailableBytes !== undefined &&
    storage.estimatedDurableFilesystemRequiredBytes !== undefined &&
    storage.durableAvailableBytes < storage.estimatedDurableFilesystemRequiredBytes
  ) {
    shortfalls.push('durable');
  }
  if (
    storage.temporaryAvailableBytes !== undefined &&
    storage.estimatedTemporaryFilesystemRequiredBytes !== undefined &&
    storage.temporaryAvailableBytes < storage.estimatedTemporaryFilesystemRequiredBytes
  ) {
    shortfalls.push('temporary');
  }
  return shortfalls;
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function saturatingMultiply(value: number, multiplier: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value * multiplier);
}

function saturatingAdd(...values: readonly number[]): number {
  return EffectArray.reduce(values, 0, (total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value));
}

export interface CodeGraphMaterializationReplayMetrics {
  readonly attributedFilesCompleted: number;
  readonly cachedFactReplayBytesCompleted: number;
  readonly crossGenerationShardFilesCompleted: number;
  readonly exactGenerationShardFilesCompleted: number;
  readonly materializedShardCacheDeferredFilesCompleted: number;
  readonly materializedShardCacheDeferredRawFactBytesCompleted: number;
  readonly materializedShardReplayBytesCompleted: number;
  readonly rawFactReplayBytesCompleted: number;
}

export interface CodeGraphMaterializationReplayObservation {
  readonly attributedFiles?: number;
  readonly crossGenerationShardFiles?: number;
  readonly exactGenerationShardFiles?: number;
  readonly materializedShardCacheDeferredFiles?: number;
  readonly materializedShardCacheDeferredRawFactBytes?: number;
  readonly materializedShardReplayBytes?: number;
  readonly rawFactReplayBytes?: number;
}

export function emptyMaterializationReplayMetrics(): CodeGraphMaterializationReplayMetrics {
  return {
    attributedFilesCompleted: 0,
    cachedFactReplayBytesCompleted: 0,
    crossGenerationShardFilesCompleted: 0,
    exactGenerationShardFilesCompleted: 0,
    materializedShardCacheDeferredFilesCompleted: 0,
    materializedShardCacheDeferredRawFactBytesCompleted: 0,
    materializedShardReplayBytesCompleted: 0,
    rawFactReplayBytesCompleted: 0,
  };
}

/** Adds one physical replay observation while retaining an exact, safely bounded split. */
export function addMaterializationReplayMetrics(
  current: CodeGraphMaterializationReplayMetrics,
  observation: CodeGraphMaterializationReplayObservation,
): CodeGraphMaterializationReplayMetrics {
  const materializedShardReplayBytesCompleted = saturatingAdd(
    current.materializedShardReplayBytesCompleted,
    observation.materializedShardReplayBytes ?? 0,
  );
  const rawFactReplayBytesCompleted = saturatingAdd(
    current.rawFactReplayBytesCompleted,
    observation.rawFactReplayBytes ?? 0,
  );
  return {
    attributedFilesCompleted: saturatingAdd(current.attributedFilesCompleted, observation.attributedFiles ?? 0),
    cachedFactReplayBytesCompleted: saturatingAdd(materializedShardReplayBytesCompleted, rawFactReplayBytesCompleted),
    crossGenerationShardFilesCompleted: saturatingAdd(
      current.crossGenerationShardFilesCompleted,
      observation.crossGenerationShardFiles ?? 0,
    ),
    exactGenerationShardFilesCompleted: saturatingAdd(
      current.exactGenerationShardFilesCompleted,
      observation.exactGenerationShardFiles ?? 0,
    ),
    materializedShardCacheDeferredFilesCompleted: saturatingAdd(
      current.materializedShardCacheDeferredFilesCompleted,
      observation.materializedShardCacheDeferredFiles ?? 0,
    ),
    materializedShardCacheDeferredRawFactBytesCompleted: saturatingAdd(
      current.materializedShardCacheDeferredRawFactBytesCompleted,
      observation.materializedShardCacheDeferredRawFactBytes ?? 0,
    ),
    materializedShardReplayBytesCompleted,
    rawFactReplayBytesCompleted,
  };
}

export function factMaterializationBatches<T extends {readonly path: string; readonly size: number}>(
  values: readonly T[],
  cachedFactBytesByPath: ReadonlyMap<string, number> = new Map(),
): readonly (readonly T[])[] {
  const output: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;
  let batchFactBytes = 0;
  for (const value of values) {
    // Current-version cache writes and materialization reads both apply the
    // same per-file compactor. Clamp defensive metadata from an unexpected
    // legacy/corrupt row to that in-memory materialization ceiling, so there
    // is no oversized-singleton exception in the batch planner.
    const factBytes = Math.min(
      CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
      Math.max(0, cachedFactBytesByPath.get(value.path) ?? 0),
    );
    if (
      batch.length > 0 &&
      (batch.length >= FACT_MATERIALIZATION_BATCH_FILES ||
        batchBytes + value.size > FACT_MATERIALIZATION_BATCH_SOURCE_BYTES ||
        batchFactBytes + factBytes > FACT_MATERIALIZATION_BATCH_CACHED_FACT_BYTES)
    ) {
      output.push(batch);
      batch = [];
      batchBytes = 0;
      batchFactBytes = 0;
    }
    batch.push(value);
    batchBytes += value.size;
    batchFactBytes += factBytes;
  }
  if (batch.length > 0) output.push(batch);
  return output;
}

export interface PersistentMaterializationTransactionCandidate {
  readonly factBytes: number;
  readonly fileCount: number;
  readonly sourceBytes: number;
}

/**
 * Coalesces contiguous, already-bounded logical receipts into larger physical
 * SQLite transactions. Logical receipt identities stay unchanged so an
 * interrupted build from an older release resumes without replay or graph
 * drift. A candidate over a physical ceiling remains an isolated singleton.
 */
export function persistentMaterializationTransactionBatches<T extends PersistentMaterializationTransactionCandidate>(
  values: readonly T[],
  maximumBatches = PERSISTENT_MATERIALIZATION_TRANSACTION_BATCHES,
): readonly (readonly T[])[] {
  const batchLimit = Math.max(1, Math.min(PERSISTENT_MATERIALIZATION_TRANSACTION_BATCHES, maximumBatches));
  const output: T[][] = [];
  let batch: T[] = [];
  let factBytes = 0;
  let fileCount = 0;
  let sourceBytes = 0;
  for (const value of values) {
    if (
      batch.length > 0 &&
      (batch.length >= batchLimit ||
        fileCount + value.fileCount > PERSISTENT_MATERIALIZATION_TRANSACTION_FILES ||
        sourceBytes + value.sourceBytes > PERSISTENT_MATERIALIZATION_TRANSACTION_SOURCE_BYTES ||
        factBytes + value.factBytes > PERSISTENT_MATERIALIZATION_TRANSACTION_FACT_BYTES)
    ) {
      output.push(batch);
      batch = [];
      factBytes = 0;
      fileCount = 0;
      sourceBytes = 0;
    }
    batch.push(value);
    factBytes += value.factBytes;
    fileCount += value.fileCount;
    sourceBytes += value.sourceBytes;
  }
  if (batch.length > 0) output.push(batch);
  return output;
}

export function uniqueById<T extends {readonly id: string}>(values: readonly T[]): readonly T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    if (!unique.has(value.id)) unique.set(value.id, value);
  }
  return [...unique.values()];
}

/**
 * Extraction may encounter the same relationship repeatedly at one call site
 * or through overlapping language-pack derivations. The storage layer keeps
 * strict INSERT semantics; collapse those logical duplicates deterministically
 * before they reach its primary-key boundary.
 */
export function deduplicateMaterializationRelationships(
  edges: readonly CodeGraphEdge[],
  references: readonly CodeGraphReference[],
): {
  readonly duplicateEdges: number;
  readonly duplicateReferences: number;
  readonly edges: readonly CodeGraphEdge[];
  readonly references: readonly CodeGraphReference[];
} {
  const edgeById = new Map<string, CodeGraphEdge>();
  for (const edge of edges) {
    if (!edgeById.has(edge.id)) edgeById.set(edge.id, edge);
  }
  const referenceByEdgeId = new Map<string, CodeGraphReference>();
  for (const reference of references) {
    // Reference attribution has historically been last-wins for one logical
    // edge. Preserve that contract for older, uncompacted cache rows while
    // edges retain their first stable evidence occurrence.
    referenceByEdgeId.set(reference.edgeId, reference);
  }
  return {
    duplicateEdges: edges.length - edgeById.size,
    duplicateReferences: references.length - referenceByEdgeId.size,
    edges: [...edgeById.values()],
    references: [...referenceByEdgeId.values()],
  };
}

export function materializationRows(
  symbols: readonly CodeGraphSymbol[],
  edges: number,
  references: readonly CodeGraphReference[],
  deduplicated: {readonly edges: number; readonly references: number},
): CodeGraphMaterializationRows {
  return {
    deduplicatedEdges: deduplicated.edges,
    deduplicatedReferences: deduplicated.references,
    edges,
    lookupKeys: EffectArray.reduce(symbols, 0, (total, symbol) => total + (symbol.lookupKeys?.length ?? 0)),
    referenceCandidates: EffectArray.reduce(
      references,
      0,
      (total, reference) =>
        total + EffectArray.reduce(reference.lookupTiers, 0, (tierTotal, tier) => tierTotal + tier.length),
    ),
    references: references.length,
    symbols: symbols.length,
  };
}

export function addMaterializationRows(
  left: CodeGraphMaterializationRows,
  right: CodeGraphMaterializationRows,
): CodeGraphMaterializationRows {
  return {
    deduplicatedEdges: (left.deduplicatedEdges ?? 0) + (right.deduplicatedEdges ?? 0),
    deduplicatedReferences: (left.deduplicatedReferences ?? 0) + (right.deduplicatedReferences ?? 0),
    edges: (left.edges ?? 0) + (right.edges ?? 0),
    lookupKeys: (left.lookupKeys ?? 0) + (right.lookupKeys ?? 0),
    referenceCandidates: (left.referenceCandidates ?? 0) + (right.referenceCandidates ?? 0),
    references: (left.references ?? 0) + (right.references ?? 0),
    reexports: (left.reexports ?? 0) + (right.reexports ?? 0),
    symbols: (left.symbols ?? 0) + (right.symbols ?? 0),
    terms: (left.terms ?? 0) + (right.terms ?? 0),
  };
}

export function materializationRowsWithStoreProgress(
  rows: CodeGraphMaterializationRows,
  progress: CodeGraphStagingProgress,
): CodeGraphMaterializationRows {
  // Store observers emit a zero-row stage boundary before the first bounded
  // statement. Keep the batch estimate at that boundary; replacing it with
  // zero made the CLI claim that a non-empty batch contained no symbols or
  // lookup keys. Positive observations monotonically replace estimates with
  // the rows actually accepted by SQLite.
  if (progress.rowsCompleted === 0) return rows;
  switch (progress.stage) {
    case 'symbols':
      return {...rows, symbols: progress.rowsCompleted};
    case 'lookup-keys':
      return {...rows, lookupKeys: progress.rowsCompleted};
    case 'terms':
      return {...rows, terms: progress.rowsCompleted};
    case 'edges':
      return {...rows, edges: progress.rowsCompleted};
    case 'references':
      return {...rows, references: progress.rowsCompleted};
    case 'reference-candidates':
      return {...rows, referenceCandidates: progress.rowsCompleted};
    case 'reexports':
      return {...rows, reexports: progress.rowsCompleted};
    case 'analysis':
    case 'receipt':
    case 'validating':
    case 'committing':
    case 'committed':
      return rows;
  }
}

export interface MaterializationStorageFiles {
  readonly databaseBytes: number;
  readonly journalBytes: number;
  readonly sharedMemoryBytes: number;
  readonly sidecarDatabaseBytes: number;
  readonly sidecarJournalBytes: number;
  readonly sidecarSharedMemoryBytes: number;
  readonly sidecarWalBytes: number;
  readonly totalBytes: number;
  readonly walBytes: number;
}

export interface MaterializationStorageTelemetry {
  readonly durableDatabaseFileBytes: number;
  readonly durableDatabaseFileHighWaterBytes: number;
  readonly durableDatabaseGrowthBytes: number;
  readonly durableDatabaseGrowthHighWaterBytes: number;
  readonly durableDatabaseStartBytes: number;
  readonly durableFilesystemBytes: number;
  readonly durableFilesystemHighWaterBytes: number;
  readonly durableJournalBytes: number;
  readonly durableJournalHighWaterBytes: number;
  readonly durableSharedMemoryBytes: number;
  readonly durableSharedMemoryHighWaterBytes: number;
  readonly durableSidecarDatabaseBytes?: number;
  readonly durableSidecarDatabaseHighWaterBytes?: number;
  readonly durableSidecarJournalBytes?: number;
  readonly durableSidecarJournalHighWaterBytes?: number;
  readonly durableSidecarWalBytes?: number;
  readonly durableSidecarWalHighWaterBytes?: number;
  readonly durableWalBytes: number;
  readonly durableWalHighWaterBytes: number;
}

export function initialMaterializationStorageTelemetry(
  current: MaterializationStorageFiles,
  includeSidecar: boolean,
): MaterializationStorageTelemetry {
  return {
    durableDatabaseFileBytes: current.databaseBytes,
    durableDatabaseFileHighWaterBytes: current.databaseBytes,
    durableDatabaseGrowthBytes: 0,
    durableDatabaseGrowthHighWaterBytes: 0,
    durableDatabaseStartBytes: current.databaseBytes,
    durableFilesystemBytes: current.totalBytes,
    durableFilesystemHighWaterBytes: current.totalBytes,
    durableJournalBytes: current.journalBytes,
    durableJournalHighWaterBytes: current.journalBytes,
    durableSharedMemoryBytes: current.sharedMemoryBytes,
    durableSharedMemoryHighWaterBytes: current.sharedMemoryBytes,
    ...(includeSidecar
      ? {
          durableSidecarDatabaseBytes: current.sidecarDatabaseBytes,
          durableSidecarDatabaseHighWaterBytes: current.sidecarDatabaseBytes,
          durableSidecarJournalBytes: current.sidecarJournalBytes,
          durableSidecarJournalHighWaterBytes: current.sidecarJournalBytes,
          durableSidecarWalBytes: current.sidecarWalBytes,
          durableSidecarWalHighWaterBytes: current.sidecarWalBytes,
        }
      : {}),
    durableWalBytes: current.walBytes,
    durableWalHighWaterBytes: current.walBytes,
  };
}

export function observeMaterializationStorage(
  previous: MaterializationStorageTelemetry,
  current: MaterializationStorageFiles,
): MaterializationStorageTelemetry {
  const durableDatabaseGrowthBytes = Math.max(0, current.databaseBytes - previous.durableDatabaseStartBytes);
  return {
    ...previous,
    durableDatabaseFileBytes: current.databaseBytes,
    durableDatabaseFileHighWaterBytes: Math.max(previous.durableDatabaseFileHighWaterBytes, current.databaseBytes),
    durableDatabaseGrowthBytes,
    durableDatabaseGrowthHighWaterBytes: Math.max(
      previous.durableDatabaseGrowthHighWaterBytes,
      durableDatabaseGrowthBytes,
    ),
    durableFilesystemBytes: current.totalBytes,
    durableFilesystemHighWaterBytes: Math.max(previous.durableFilesystemHighWaterBytes, current.totalBytes),
    durableJournalBytes: current.journalBytes,
    durableJournalHighWaterBytes: Math.max(previous.durableJournalHighWaterBytes, current.journalBytes),
    durableSharedMemoryBytes: current.sharedMemoryBytes,
    durableSharedMemoryHighWaterBytes: Math.max(previous.durableSharedMemoryHighWaterBytes, current.sharedMemoryBytes),
    ...(previous.durableSidecarDatabaseBytes === undefined
      ? {}
      : {
          durableSidecarDatabaseBytes: current.sidecarDatabaseBytes,
          durableSidecarDatabaseHighWaterBytes: Math.max(
            previous.durableSidecarDatabaseHighWaterBytes ?? 0,
            current.sidecarDatabaseBytes,
          ),
          durableSidecarJournalBytes: current.sidecarJournalBytes,
          durableSidecarJournalHighWaterBytes: Math.max(
            previous.durableSidecarJournalHighWaterBytes ?? 0,
            current.sidecarJournalBytes,
          ),
          durableSidecarWalBytes: current.sidecarWalBytes,
          durableSidecarWalHighWaterBytes: Math.max(
            previous.durableSidecarWalHighWaterBytes ?? 0,
            current.sidecarWalBytes,
          ),
        }),
    durableWalBytes: current.walBytes,
    durableWalHighWaterBytes: Math.max(previous.durableWalHighWaterBytes, current.walBytes),
  };
}

/**
 * Capture durable-storage growth around a bounded incremental publication.
 * Incremental staging bypasses the full-materialization loop, so it must
 * establish and close its own high-water interval instead of inheriting the
 * full-build sampler.
 */
export function withIncrementalMaterializationStorageTelemetry<A, E, R>(
  fs: FileSystem.FileSystem,
  databasePath: string,
  transaction: Effect.Effect<A, E, R>,
): Effect.Effect<{readonly result: A; readonly storage: MaterializationStorageTelemetry}, E, R> {
  return Effect.gen(function* () {
    const before = yield* materializationStorageFiles(fs, databasePath);
    const initial = initialMaterializationStorageTelemetry(before, false);
    const result = yield* transaction;
    const after = yield* materializationStorageFiles(fs, databasePath);
    return {result, storage: observeMaterializationStorage(initial, after)};
  });
}

export function applyIncrementalMaterialization(input: {
  readonly assessment: Extract<IncrementalOverlayAssessment, {readonly mode: 'eligible'}>;
  readonly baseSnapshotId: string;
  readonly databasePath: string;
  readonly fs: FileSystem.FileSystem;
  readonly foldForward?: {
    readonly logicalSnapshotId: string;
    readonly priorStagedPayloadBytes: number;
    readonly priorStagedRows: number;
  };
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly prepared: boolean;
  readonly storage?: MaterializationStorageTelemetry;
  readonly store: CodeGraphStoreShape;
}) {
  return Effect.gen(function* () {
    if (input.prepared) return {result: true, storage: input.storage};
    if (input.assessment.reuse === 'persisted-base') {
      return yield* withIncrementalMaterializationStorageTelemetry(
        input.fs,
        input.databasePath,
        input.store.preparePersistedIncrementalActivation(
          input.databasePath,
          input.baseSnapshotId,
          input.assessment.files,
          input.assessment.facts,
          {
            deletedPaths: input.assessment.deletedPaths,
            ...(input.foldForward
              ? {
                  foldForward: {
                    snapshotId: input.foldForward.logicalSnapshotId,
                    stagedPayloadBytes: input.foldForward.priorStagedPayloadBytes,
                    stagedRows: input.foldForward.priorStagedRows,
                  },
                }
              : {}),
            resolutionClosure: input.assessment.resolutionClosure,
          },
          input.persistentCapacityProtector,
        ),
      );
    }
    return {
      result: yield* input.store.replaceStagedModifiedFiles(
        input.databasePath,
        input.baseSnapshotId,
        input.assessment.files,
        input.assessment.facts,
        input.persistentCapacityProtector,
      ),
      storage: undefined,
    };
  });
}

export function incrementalMaterializationMetrics(
  assessment: Extract<IncrementalOverlayAssessment, {readonly mode: 'eligible'}>,
  storage: MaterializationStorageTelemetry,
  dirty: boolean,
): CodeGraphMaterializationMetrics {
  const sourceBytesTotal = EffectArray.reduce(assessment.files, 0, (total, file) => total + file.size);
  return {
    attributedFilesCompleted: assessment.files.length,
    batchesCompleted: 1,
    batchesTotal: 1,
    mode: dirty ? 'incremental-overlay' : 'incremental-clean',
    sourceBytesCompleted: sourceBytesTotal,
    sourceBytesTotal,
    storage: {
      ...storage,
      materializationMode: 'direct-persistent',
      temporaryDatabaseBytes: 0,
      temporaryDatabaseHighWaterBytes: 0,
    },
  };
}

export function materializationStorageFiles(
  fs: FileSystem.FileSystem,
  databasePath: string,
  sidecarDatabasePaths: readonly string[] = [],
): Effect.Effect<MaterializationStorageFiles, never> {
  const bytes = (file: string) =>
    fs.stat(file).pipe(
      Effect.map(info => Math.min(Number(info.size), Number.MAX_SAFE_INTEGER)),
      Effect.orElseSucceed(() => 0),
    );
  const sidecarFiles = EffectArray.flatMap(sidecarDatabasePaths, sidecar => [
    bytes(sidecar),
    bytes(`${sidecar}-journal`),
    bytes(`${sidecar}-shm`),
    bytes(`${sidecar}-wal`),
  ]);
  return Effect.all(
    [
      bytes(databasePath),
      bytes(`${databasePath}-journal`),
      bytes(`${databasePath}-shm`),
      bytes(`${databasePath}-wal`),
      ...sidecarFiles,
    ],
    {concurrency: 8},
  ).pipe(
    Effect.map(([databaseBytes, journalBytes, sharedMemoryBytes, walBytes, ...sidecars]) => {
      let sidecarDatabaseBytes = 0;
      let sidecarJournalBytes = 0;
      let sidecarSharedMemoryBytes = 0;
      let sidecarWalBytes = 0;
      for (let index = 0; index < sidecars.length; index += 4) {
        sidecarDatabaseBytes += sidecars[index] ?? 0;
        sidecarJournalBytes += sidecars[index + 1] ?? 0;
        sidecarSharedMemoryBytes += sidecars[index + 2] ?? 0;
        sidecarWalBytes += sidecars[index + 3] ?? 0;
      }
      return {
        databaseBytes,
        journalBytes,
        sharedMemoryBytes,
        sidecarDatabaseBytes,
        sidecarJournalBytes,
        sidecarSharedMemoryBytes,
        sidecarWalBytes,
        totalBytes:
          databaseBytes +
          journalBytes +
          sharedMemoryBytes +
          walBytes +
          sidecarDatabaseBytes +
          sidecarJournalBytes +
          sidecarSharedMemoryBytes +
          sidecarWalBytes,
        walBytes,
      };
    }),
  );
}

export function materializationStagingStage(
  progress: CodeGraphStagingProgress,
): NonNullable<Extract<CodeGraphProgress, {readonly phase: 'materializing'}>['activity']>['stage'] {
  switch (progress.stage) {
    case 'validating':
      return 'preparing-rows';
    case 'symbols':
      return 'writing-symbols';
    case 'lookup-keys':
      return 'writing-lookups';
    case 'terms':
      return 'writing-terms';
    case 'edges':
      return 'writing-edges';
    case 'reference-candidates':
      return 'writing-candidates';
    case 'references':
    case 'reexports':
      return 'writing-references';
    case 'analysis':
      return 'writing-analysis';
    case 'receipt':
      return 'writing-receipt';
    case 'committing':
    case 'committed':
      return 'committing';
  }
}

export function cachedFileKeys(
  store: CodeGraphStoreShape,
  databasePath: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>,
  files?: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
): Effect.Effect<ReadonlySet<string>, unknown> {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const cacheIdentities =
      files === undefined
        ? languagePacks.cacheIdentities
        : languagePacks.activeCacheIdentities(EffectArray.map(files, file => file.path));
    const generations = codeGraphParserCacheLookupGenerations(cacheIdentities);
    const sets = yield* Effect.forEach(
      generations,
      generation =>
        store
          .cachedCommittedFileKeys(databasePath, generation.storedIdentity, files)
          .pipe(
            Effect.map(
              keys =>
                new Set(
                  EffectArray.map([...keys], key =>
                    codeGraphActiveParserCacheKey(key, generation.storedIdentity, generation.activeIdentity),
                  ),
                ),
            ),
          ),
      {concurrency: 1},
    );
    const keys = new Set(EffectArray.flatMap(sets, set => [...set]));
    yield* onProgress?.({
      activity: {
        elapsedMilliseconds: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
        generations: generations.length,
        keys: keys.size,
        stage: 'loading-cache',
      },
      phase: 'registering',
    }) ?? Effect.void;
    return keys;
  });
}

export function loadCachedFacts(
  store: CodeGraphStoreShape,
  databasePath: string,
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): Effect.Effect<
  {
    readonly bytes: number;
    readonly bytesByPath: ReadonlyMap<string, number>;
    readonly facts: ReadonlyMap<string, CodeGraphFileFacts>;
  },
  unknown
> {
  return Effect.forEach(
    groupFilesByCacheIdentity(files, languagePacks),
    group =>
      Effect.gen(function* () {
        const active = yield* store.loadCachedFacts(databasePath, group.files, group.cacheIdentity);
        const missing = EffectArray.filter(group.files, file => !active.facts.has(file.path));
        if (missing.length === 0) return active;
        const degraded = yield* store.loadCachedFacts(
          databasePath,
          missing,
          degradedParserCacheIdentity(group.cacheIdentity),
        );
        return {
          bytes: active.bytes + degraded.bytes,
          bytesByPath: new Map([...(active.bytesByPath ?? []), ...(degraded.bytesByPath ?? [])]),
          facts: new Map([...active.facts, ...degraded.facts]),
        };
      }),
    {concurrency: 1},
  ).pipe(
    Effect.map(groups => {
      const output = new Map<string, CodeGraphFileFacts>();
      const bytesByPath = new Map<string, number>();
      let bytes = 0;
      for (const group of groups) {
        for (const [path, facts] of group.facts) {
          const persistedBytes = group.bytesByPath?.get(path);
          if (persistedBytes !== undefined && persistedBytes <= CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM) {
            output.set(path, facts);
            bytesByPath.set(path, persistedBytes);
            bytes += persistedBytes;
            continue;
          }
          const budgeted = budgetCachedCodeGraphFacts(facts);
          const budgetedBytes = cachedCodeGraphFactBytes(budgeted);
          output.set(path, budgeted);
          bytesByPath.set(path, budgetedBytes);
          bytes += budgetedBytes;
        }
      }
      return {bytes, bytesByPath, facts: output};
    }),
  );
}

export function loadCachedFactsWithPackProvenance(
  store: CodeGraphStoreShape,
  databasePath: string,
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
  provenance: readonly CodeGraphLanguagePackProvenance[],
): Effect.Effect<
  {
    readonly bytes: number;
    readonly bytesByPath: ReadonlyMap<string, number>;
    readonly facts: ReadonlyMap<string, CodeGraphFileFacts>;
  },
  unknown
> {
  const provenanceById = new Map(EffectArray.map(provenance, pack => [pack.id, pack]));
  const groups = new Map<string, CodeGraphInventoryFile[]>();
  let unmatched = false;
  for (const file of files) {
    const match = Option.getOrUndefined(languagePacks.match(file.path));
    const identity = match === undefined ? undefined : provenanceById.get(match.pack.id)?.cacheIdentity;
    if (identity === undefined) {
      unmatched = true;
      continue;
    }
    const group = groups.get(identity) ?? [];
    group.push(file);
    groups.set(identity, group);
  }
  if (unmatched) return Effect.succeed({bytes: 0, bytesByPath: new Map(), facts: new Map()});
  return Effect.forEach(
    [...groups],
    ([cacheIdentity, groupFiles]) =>
      Effect.gen(function* () {
        const active = yield* store.loadCachedFacts(databasePath, groupFiles, cacheIdentity);
        const missing = EffectArray.filter(groupFiles, file => !active.facts.has(file.path));
        if (missing.length === 0) return active;
        const degraded = yield* store.loadCachedFacts(
          databasePath,
          missing,
          degradedParserCacheIdentity(cacheIdentity),
        );
        return {
          bytes: active.bytes + degraded.bytes,
          bytesByPath: new Map([...(active.bytesByPath ?? []), ...(degraded.bytesByPath ?? [])]),
          facts: new Map([...active.facts, ...degraded.facts]),
        };
      }),
    {concurrency: 1},
  ).pipe(
    Effect.map(loaded => {
      const facts = new Map<string, CodeGraphFileFacts>();
      const bytesByPath = new Map<string, number>();
      let bytes = 0;
      for (const group of loaded) {
        for (const [path, fact] of group.facts) {
          const persistedBytes = group.bytesByPath?.get(path);
          if (persistedBytes !== undefined && persistedBytes <= CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM) {
            facts.set(path, fact);
            bytesByPath.set(path, persistedBytes);
            bytes += persistedBytes;
            continue;
          }
          const budgeted = budgetCachedCodeGraphFacts(fact);
          const budgetedBytes = cachedCodeGraphFactBytes(budgeted);
          facts.set(path, budgeted);
          bytesByPath.set(path, budgetedBytes);
          bytes += budgetedBytes;
        }
      }
      return {bytes, bytesByPath, facts};
    }),
  );
}
