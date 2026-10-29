import {Array as EffectArray} from 'effect';
import {CODE_GRAPH_VECTOR_DATABASE_VERSION, CODE_GRAPH_VECTOR_DATABASE_FILENAME} from './vector/generation_schema.js';
import {
  commitCodeGraphGenerationStep,
  completeCodeGraphGeneration,
  claimCodeGraphGeneration,
  initializeCodeGraphGenerationSchema,
  requireCodeGraphGenerationClaim,
  requireCodeGraphGenerationSchema,
  renewCodeGraphGenerationClaim,
  readCodeGraphGenerationProgress,
  releaseCodeGraphGenerationClaim,
  type CodeGraphGenerationProgress,
} from './vector/generation.js';
import {inspectVectorPageStorageSql} from './vector/retirement/inspection.js';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Cause, Clock, Context, Crypto, DateTime, Effect, Exit, FileSystem, Layer, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {LocalModelRuntime, type LocalModelRuntimeShape} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelCatalog, type LocalModelCatalogShape} from '@threadnote/inference/models/catalog';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import {normalizeVector, searchExactVectors, type VectorSearchResult} from '@threadnote/inference/vector-search';
import {codeGraphVectorWriteLockPath, type CodeGraphLayout} from './layout.js';
import {compareCodeUnits} from './ordering.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from './index_scope.js';
import {codeGraphVectorViewId} from './vector/identity.js';
import type {CodeGraphProgress, CodeGraphSnapshot, CodeGraphSymbol} from './types.js';
import type {CodeGraphSymbolCursor} from './store.js';
import {
  CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
  CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL,
  CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL,
  CODE_GRAPH_VECTOR_REUSE_INDEX_SQL,
  CODE_GRAPH_VECTORS_TABLE_SQL,
  initializeCodeGraphVectorRetirementSchema,
  makeCodeGraphVectorRetirementCapacityProtector,
  prepareCodeGraphVectorRetirement,
  requireCodeGraphVectorRetirementSchema,
} from './vector/retirement.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class CodeGraphEmbeddingError extends Schema.TaggedError<CodeGraphEmbeddingError, {readonly brand: unique symbol}>()(
  'CodeGraphEmbeddingError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

class CodeGraphVectorOwnerExpired extends Schema.TaggedError<
  CodeGraphVectorOwnerExpired,
  {readonly brand: unique symbol}
>()('CodeGraphVectorOwnerExpired', {message: Schema.String}) {}

class CodeGraphVectorClaimCleanupPending extends Schema.TaggedError<
  CodeGraphVectorClaimCleanupPending,
  {readonly brand: unique symbol}
>()('CodeGraphVectorClaimCleanupPending', {cause: Schema.Defect(), message: Schema.String}) {
  get retryable(): boolean {
    return (
      isFileLockTimeout(this.cause) ||
      (typeof this.cause === 'object' &&
        this.cause !== null &&
        'retryable' in this.cause &&
        this.cause.retryable === true)
    );
  }
  get recovery(): 'defer' | 'fix-storage' {
    return this.retryable ? 'defer' : 'fix-storage';
  }
}

const CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION = 1;
const CODE_GRAPH_EMBEDDING_CONTEXT_CAP = 8;

const CODE_GRAPH_SEMANTIC_MINIMUM_SCORE = 0.64;
const EMBED_BATCH_SIZE = 128;
const VECTOR_PAGE_SIZE = 400;
const CODE_GRAPH_VECTOR_WRITE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: Number.POSITIVE_INFINITY,
} as const;

interface VectorGenerationRow {
  readonly count: number;
  readonly created_at: string;
  readonly dimensions: number;
  readonly generation: string;
  readonly model_id: string;
  readonly model_sha256: string;
  readonly snapshot_id: string;
  readonly state: 'building' | 'ready';
  readonly template_version: number;
}

interface VectorRow {
  readonly fingerprint: string;
  readonly symbol_id: string;
  readonly vector: unknown;
}

interface ProjectedSymbol {
  readonly fingerprint: string;
  readonly id: string;
  readonly text: string;
}

export interface CodeGraphVectorPublication {
  readonly validate: Effect.Effect<void, unknown>;
  readonly attach: (commit: Effect.Effect<void, unknown>) => Effect.Effect<void, unknown>;
}

export interface CodeGraphEmbeddingStatus {
  readonly embedded: number;
  readonly generation?: string;
  readonly ownerToken?: string;
  readonly modelId?: string;
  readonly ready: boolean;
  readonly reason?: string;
  readonly state?: 'checkpointed' | 'deferred';
  readonly reused: number;
}

export interface CodeGraphSymbolPageSource {
  readonly count: Effect.Effect<number, unknown>;
  readonly loadPage: (
    cursor: CodeGraphSymbolCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphSymbol[], unknown>;
}

export type CodeGraphEmbeddingSymbolSource = readonly CodeGraphSymbol[] | CodeGraphSymbolPageSource;

export type CodeGraphEmbeddingCheck =
  | {readonly modelId: string; readonly reused: number; readonly state: 'ready'}
  | {readonly reason: string; readonly state: 'stale' | 'unavailable'};

export interface CodeGraphEmbeddingIndexShape {
  readonly check: (
    threadnoteHome: string,
    layout: CodeGraphLayout,
    snapshotId: string,
    /** Status observation reads installed metadata only; the default retains artifact verification. */
    options?: {readonly metadataOnly?: boolean},
  ) => Effect.Effect<CodeGraphEmbeddingCheck, unknown>;
  readonly ensure: (
    threadnoteHome: string,
    layout: CodeGraphLayout,
    snapshot: CodeGraphSnapshot,
    symbols: CodeGraphEmbeddingSymbolSource,
    options?: {
      readonly publication?: CodeGraphVectorPublication;
      readonly force?: boolean;
      readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
    },
  ) => Effect.Effect<CodeGraphEmbeddingStatus, unknown>;
  readonly search: (
    threadnoteHome: string,
    layout: CodeGraphLayout,
    snapshotId: string,
    query: string,
    limit: number,
  ) => Effect.Effect<ReadonlyMap<string, number>, unknown>;
}

export class CodeGraphEmbeddingIndex extends Context.Service<CodeGraphEmbeddingIndex, CodeGraphEmbeddingIndexShape>()(
  '@threadnote/graph/embedding/CodeGraphEmbeddingIndex',
) {
  static readonly layer = Layer.effect(
    CodeGraphEmbeddingIndex,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const catalog = yield* LocalModelCatalog;
      const modelStore = yield* LocalModelStore;
      const runtime = yield* LocalModelRuntime;
      const crypto = yield* Crypto.Crypto;
      const system = yield* SystemInfo;
      return CodeGraphEmbeddingIndex.of({
        check: (threadnoteHome, layout, snapshotId, options) =>
          checkGraphVectors({
            catalog,
            fs,
            layout,
            modelStore,
            path,
            snapshotId,
            threadnoteHome,
            metadataOnly: options?.metadataOnly,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path)),
        ensure: (threadnoteHome, layout, snapshot, symbols, options) =>
          executeCodeGraphVectorGeneration({
            catalog,
            force: options?.force === true,
            fs,
            layout,
            modelStore,
            onProgress: options?.onProgress,
            publication: options?.publication,
            path,
            runtime,
            snapshot,
            symbols,
            threadnoteHome,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
          ),
        search: (threadnoteHome, layout, snapshotId, query, limit) =>
          searchGraphVectors({
            catalog,
            fs,
            layout,
            limit,
            modelStore,
            path,
            query,
            runtime,
            snapshotId,
            threadnoteHome,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path)),
      });
    }),
  );
}

const checkGraphVectors = Effect.fn('codeGraph.checkVectors')(function* (input: {
  readonly metadataOnly?: boolean;
  readonly catalog: LocalModelCatalogShape;
  readonly fs: FileSystem.FileSystem;
  readonly layout: CodeGraphLayout;
  readonly modelStore: LocalModelStoreShape;
  readonly path: Path.Path;
  readonly snapshotId: string;
  readonly threadnoteHome: string;
}) {
  const select = input.metadataOnly
    ? Effect.gen(function* () {
        const selection = yield* readModelSelection(input.threadnoteHome);
        const modelId = selection.roles.embedding;
        if (!modelId) return yield* CodeGraphEmbeddingError.make({message: 'No core embedding model is selected.'});
        const manifest = yield* input.catalog.get(modelId);
        if (manifest.role !== 'embedding' || !manifest.dimensions)
          return yield* CodeGraphEmbeddingError.make({message: 'Selected model is not an embedding model.'});
        const installed = yield* input.modelStore.status(input.threadnoteHome, manifest);
        if (!installed.installed || installed.bytes !== manifest.size)
          return yield* CodeGraphEmbeddingError.make({message: 'Selected embedding model is unavailable.'});
        return {manifest};
      })
    : selectedEmbeddingModel(input.threadnoteHome, input.catalog, input.modelStore);
  const selected = yield* select.pipe(
    Effect.match({
      onFailure: cause => ({reason: messageOf(cause), state: 'unavailable'}) as const,
      onSuccess: value => value,
    }),
  );
  if ('state' in selected) return selected;
  const databasePath = vectorDatabasePath(input.path, input.layout.vectorRoot, selected.manifest.id);
  if (!(yield* input.fs.exists(databasePath))) {
    return {reason: 'Code graph vector database is missing.', state: 'stale'} as const;
  }
  return yield* useVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* requireVectorDatabaseReady(sql);
      const active = yield* selectActiveGeneration(sql, requiredWorktreeId(input.layout));
      if (
        !active ||
        active.snapshot_id !== input.snapshotId ||
        active.model_id !== selected.manifest.id ||
        active.model_sha256 !== selected.manifest.sha256 ||
        active.template_version !== CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION ||
        active.dimensions !== selected.manifest.dimensions
      ) {
        return {reason: 'Code graph vectors do not match the ready snapshot.', state: 'stale'} as const;
      }
      if (input.metadataOnly) {
        const currentSelection = yield* readModelSelection(input.threadnoteHome);
        const currentId = currentSelection.roles.embedding;
        const current = currentId ? yield* input.catalog.get(currentId) : undefined;
        if (
          current?.id !== selected.manifest.id ||
          current.sha256 !== selected.manifest.sha256 ||
          current.dimensions !== selected.manifest.dimensions
        )
          return {reason: 'Selected embedding model changed during observation.', state: 'stale'} as const;
      }
      return {modelId: selected.manifest.id, reused: active.count, state: 'ready'} as const;
    }),
    true,
  ).pipe(
    Effect.catch(cause =>
      Effect.succeed({reason: `Code graph vector database is invalid: ${messageOf(cause)}`, state: 'stale'} as const),
    ),
  );
});

export const executeCodeGraphVectorGeneration = Effect.fn('codeGraph.executeVectorGeneration')(function* (input: {
  readonly maximumSteps?: number;
  readonly lockWaitTimeoutMilliseconds?: number;
  readonly maximumInferenceSymbolsPerStep?: number;
  readonly inferenceBatchSize?: number;
  readonly embeddingContextPoolSize?: 1 | 2 | 4 | 8;
  readonly ownerToken?: string;
  readonly abandonedOwnerToken?: string;
  /** Retain ownership, including unfinished checkpoints, only for same-token retries. */
  readonly retainPublicationClaimOnFailure?: (cause: unknown) => boolean;
  readonly catalog: LocalModelCatalogShape;
  readonly force: boolean;
  readonly fs: FileSystem.FileSystem;
  readonly layout: CodeGraphLayout;
  readonly modelStore: LocalModelStoreShape;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly publication?: CodeGraphVectorPublication;
  readonly path: Path.Path;
  readonly runtime: LocalModelRuntimeShape;
  readonly snapshot: CodeGraphSnapshot;
  readonly symbols: CodeGraphEmbeddingSymbolSource;
  readonly threadnoteHome: string;
}) {
  const crypto = yield* Crypto.Crypto;
  const system = yield* SystemInfo;
  for (const limit of [input.maximumSteps, input.maximumInferenceSymbolsPerStep, input.inferenceBatchSize]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      return yield* CodeGraphEmbeddingError.make({
        message: 'Code graph vector generation limits must be positive safe integers.',
      });
    }
  }
  if (
    (input.snapshot.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) !==
    (input.layout.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY)
  ) {
    return yield* CodeGraphEmbeddingError.make({message: 'Code graph vector snapshot scope does not match its view.'});
  }
  const selected = yield* selectedEmbeddingModel(input.threadnoteHome, input.catalog, input.modelStore).pipe(
    Effect.catch(cause => Effect.succeed({reason: messageOf(cause)} as const)),
  );
  if ('reason' in selected) return {embedded: 0, ready: false, reason: selected.reason, reused: 0};
  const root = input.path.join(input.layout.vectorRoot, selected.manifest.id);
  const databasePath = vectorDatabasePath(input.path, input.layout.vectorRoot, selected.manifest.id);
  const writeLockPath = codeGraphVectorWriteLockPath(
    input.path,
    input.threadnoteHome,
    input.layout.checkoutId,
    sha256HexSync(selected.manifest.id),
  );
  const lockOptions = {
    ...CODE_GRAPH_VECTOR_WRITE_LOCK_OPTIONS,
    waitTimeoutMilliseconds: input.lockWaitTimeoutMilliseconds ?? Number.POSITIVE_INFINITY,
  };
  const lock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withExclusiveFileLock(input.fs, writeLockPath, lockOptions, effect).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(Path.Path, input.path),
      Effect.provideService(SystemInfo, system),
    );
  const worktreeId = requiredWorktreeId(input.layout);
  const ownerToken = input.ownerToken ?? (yield* crypto.randomUUIDv4());
  const requestEpoch = input.force ? ownerToken : input.snapshot.id;
  yield* input.fs.makeDirectory(root, {recursive: true, mode: 0o700});
  const capacity = yield* makeCodeGraphVectorRetirementCapacityProtector({
    databasePath,
    claimMode: input.lockWaitTimeoutMilliseconds === 0 ? 'nonblocking-one-attempt' : 'wait',
    threadnoteHome: input.threadnoteHome,
  });
  if (yield* input.fs.exists(databasePath)) {
    yield* prepareCodeGraphVectorRetirement(databasePath, {
      capacityProtector: (boundary, transaction, storage) => capacity(boundary, lock(transaction), storage),
    });
  }
  const validate = Effect.gen(function* () {
    yield* input.publication?.validate ?? Effect.void;
    const selection = yield* readModelSelection(input.threadnoteHome);
    const modelId = selection.roles.embedding;
    const current = modelId ? yield* input.catalog.get(modelId) : undefined;
    if (
      current?.id !== selected.manifest.id ||
      current.sha256 !== selected.manifest.sha256 ||
      current.dimensions !== selected.manifest.dimensions
    ) {
      return yield* CodeGraphEmbeddingError.make({message: 'Code graph embedding model changed during generation.'});
    }
  }).pipe(Effect.provideService(FileSystem.FileSystem, input.fs), Effect.provideService(Path.Path, input.path));
  return yield* useVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Capacity admission happens outside publication/model gates, including metadata migration.
      const protect = <A, E, R>(rows: number, bytes: number, transaction: Effect.Effect<A, E, R>) =>
        Effect.flatMap(inspectVectorPageStorageSql(sql), storage =>
          capacity(
            {
              operation: 'write code graph vector generation',
              rowCount: rows,
              finalFactBytes: bytes,
            },
            transaction,
            storage,
          ),
        );
      yield* protect(32, 65_536, lock(initializeVectorDatabase(sql)));
      let prepared:
        {readonly generation: VectorGenerationRow; readonly progress: CodeGraphGenerationProgress} | undefined;
      while (!prepared) {
        yield* validate;
        prepared = yield* protect(
          3,
          4096,
          lock(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* requireVectorDatabaseReady(sql);
                const exact = input.force
                  ? undefined
                  : yield* selectGenerationForSnapshot(
                      sql,
                      input.snapshot.id,
                      selected.manifest.sha256,
                      selected.manifest.dimensions!,
                    );
                let generation = exact;
                if (!generation) {
                  const candidates = yield* sql.unsafe<VectorGenerationRow>(
                    `SELECT generation.* FROM vector_generations AS generation
            JOIN vector_generation_progress AS progress ON progress.generation = generation.generation
            WHERE generation.snapshot_id = ? AND generation.model_sha256 = ? AND generation.dimensions = ?
              AND generation.template_version = ? AND generation.state = 'building' AND progress.request_epoch = ?
              AND NOT EXISTS (SELECT 1 FROM vector_generation_retirements WHERE generation = generation.generation)
              AND (progress.reusable_generation IS NULL OR EXISTS (
                SELECT 1 FROM vector_generations AS reusable WHERE reusable.generation = progress.reusable_generation AND reusable.state = 'ready'
                  AND NOT EXISTS (SELECT 1 FROM vector_generation_retirements WHERE generation = reusable.generation)))
            ORDER BY generation.created_at DESC LIMIT 1`,
                    [
                      input.snapshot.id,
                      selected.manifest.sha256,
                      selected.manifest.dimensions!,
                      CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION,
                      requestEpoch,
                    ],
                  );
                  generation = candidates[0];
                }
                let reusable: VectorGenerationRow | undefined;
                if (!generation) {
                  if (!input.force) {
                    const active = yield* selectActiveGeneration(sql, worktreeId);
                    reusable =
                      active?.model_sha256 === selected.manifest.sha256 &&
                      active.template_version === CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION &&
                      active.dimensions === selected.manifest.dimensions
                        ? active
                        : undefined;
                  }
                  const id = `${yield* Clock.currentTimeMillis}-${yield* crypto.randomUUIDv4()}`;
                  yield* sql`INSERT INTO vector_generations (generation, snapshot_id, model_id, model_sha256, dimensions, template_version, count, state, created_at)
            VALUES (${id}, ${input.snapshot.id}, ${selected.manifest.id}, ${selected.manifest.sha256}, ${selected.manifest.dimensions!},
              ${CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION}, 0, 'building', ${DateTime.formatIso(yield* DateTime.now)})`;
                  generation = (yield* sql.unsafe<VectorGenerationRow>(
                    'SELECT * FROM vector_generations WHERE generation = ?',
                    [id],
                  ))[0]!;
                }
                if (input.abandonedOwnerToken)
                  yield* sql.unsafe(
                    'UPDATE vector_generation_progress SET expires_at = 0 WHERE generation = ? AND owner_token = ?',
                    [generation.generation, input.abandonedOwnerToken],
                  );
                const prior = yield* readCodeGraphGenerationProgress(sql, generation.generation);
                if (prior?.owner_token === ownerToken && prior.expires_at <= (yield* Clock.currentTimeMillis))
                  return yield* CodeGraphVectorOwnerExpired.make({
                    message: 'Vector generation ownership expired; a fresh validated owner is required.',
                  });
                const progress = yield* claimCodeGraphGeneration(sql, {
                  generation: generation.generation,
                  ownerToken,
                  requestEpoch,
                  reusableGeneration: reusable?.generation,
                });
                return progress ? {generation, progress} : undefined;
              }),
            ),
          ),
        );
        if (!prepared && input.maximumSteps !== undefined)
          return {
            embedded: 0,
            reused: 0,
            ready: false,
            modelId: selected.manifest.id,
            state: 'deferred' as const,
            reason: 'Code graph vector generation has another live owner.',
          };
        if (!prepared) yield* Effect.sleep('100 millis');
      }
      const generation = prepared.generation.generation;
      const initialGeneration = prepared.generation;
      const initialProgress = prepared.progress;
      return yield* Effect.gen(function* () {
        let progress = initialProgress;
        const total = yield* embeddingSymbolCount(input.symbols);
        let steps = 0;
        const maximumSteps = Math.max(1, Math.floor(input.maximumSteps ?? Number.POSITIVE_INFINITY));
        const stepInferenceLimit = Math.max(
          1,
          Math.min(VECTOR_PAGE_SIZE, Math.floor(input.maximumInferenceSymbolsPerStep ?? VECTOR_PAGE_SIZE)),
        );
        const inferenceBatchSize = Math.max(
          1,
          Math.min(EMBED_BATCH_SIZE, Math.floor(input.inferenceBatchSize ?? EMBED_BATCH_SIZE)),
        );
        if (initialGeneration.state !== 'ready') {
          for (;;) {
            yield* validate;
            progress = yield* lock(requireCodeGraphGenerationClaim(sql, generation, ownerToken));
            const cursor: CodeGraphSymbolCursor | undefined = progress.cursor ? JSON.parse(progress.cursor) : undefined;
            let rawPage = isSymbolPageSource(input.symbols)
              ? yield* input.symbols.loadPage(cursor, VECTOR_PAGE_SIZE)
              : input.symbols.slice(progress.array_offset, progress.array_offset + VECTOR_PAGE_SIZE);
            if (rawPage.length === 0) break;
            let projectedPage = EffectArray.map(selectGraphEmbeddingSymbols(rawPage), projectSymbol);
            const existing =
              projectedPage.length === 0
                ? []
                : yield* sql.unsafe<{readonly symbol_id: string}>(
                    `SELECT symbol_id FROM vectors WHERE generation = ? AND symbol_id IN (${EffectArray.join(
                      EffectArray.map(projectedPage, () => '?'),
                      ', ',
                    )})`,
                    [generation, ...EffectArray.map(projectedPage, item => item.id)],
                  );
            const inserted = new Set(EffectArray.map(existing, row => row.symbol_id));
            let projected = EffectArray.filter(projectedPage, item => !inserted.has(item.id));
            // A step consumes at most one inference batch. Cursor advances only over its raw prefix.
            const reusable = progress.reusable_generation
              ? yield* loadReusableVectors(sql, progress.reusable_generation, projected, selected.manifest.dimensions!)
              : new Map<string, Uint8Array>();
            // A background step may stop within a structural page; its cursor covers only that prefix.
            const missingIds = new Set(
              EffectArray.map(
                EffectArray.filter(projected, item => !reusable.has(item.id)),
                item => item.id,
              ),
            );
            let missingCount = 0;
            let consumed = rawPage.length;
            const seen = new Set<string>();
            for (const [index, item] of rawPage.entries()) {
              if (missingIds.has(item.id) && !seen.has(item.id)) {
                if (missingCount === stepInferenceLimit) {
                  consumed = index;
                  break;
                }
                missingCount += 1;
                seen.add(item.id);
              }
            }
            const truncated = consumed < rawPage.length;
            rawPage = rawPage.slice(0, consumed);
            if (truncated) {
              projectedPage = EffectArray.map(selectGraphEmbeddingSymbols(rawPage), projectSymbol);
              projected = EffectArray.filter(projectedPage, item => !inserted.has(item.id));
            }
            const rows: Array<readonly [string, string, string, Uint8Array]> = [];
            const missing: ProjectedSymbol[] = [];
            for (const item of projected) {
              const vector = reusable.get(item.id);
              if (vector) rows.push([generation, item.id, item.fingerprint, vector]);
              else missing.push(item);
            }
            // Persist a whole bounded page; inference requests remain bounded and carry no file lock.
            let embedded = 0;
            for (let offset = 0; offset < missing.length; offset += inferenceBatchSize) {
              yield* validate;
              const batch = missing.slice(offset, offset + inferenceBatchSize);
              const vectors = yield* withExclusiveFileLock(
                input.fs,
                `${writeLockPath}.inference`,
                lockOptions,
                Effect.gen(function* () {
                  yield* validate;
                  yield* protect(1, 4096, lock(renewCodeGraphGenerationClaim(sql, generation, ownerToken)));
                  return yield* input.runtime.embedMany({
                    embeddingContextPoolSize: input.embeddingContextPoolSize ?? CODE_GRAPH_EMBEDDING_CONTEXT_CAP,
                    inputs: EffectArray.map(
                      batch,
                      item => `${selected.manifest.promptPrefixes?.document ?? ''}${item.text}`,
                    ),
                    manifest: selected.manifest,
                    modelPath: selected.modelPath,
                  });
                }),
              );
              yield* validate;
              if (vectors.length !== batch.length)
                return yield* CodeGraphEmbeddingError.make({message: 'Embedding model returned an incomplete batch.'});
              for (const [index, item] of batch.entries())
                rows.push([
                  generation,
                  item.id,
                  item.fingerprint,
                  encodeVector(normalizeVector(vectors[index]), selected.manifest.dimensions!),
                ]);
              embedded += batch.length;
            }
            yield* validate;
            const last = rawPage.at(-1)!;
            const nextCursor = JSON.stringify({id: last.id, path: last.path, qualifiedName: last.qualifiedName});
            progress = yield* protect(
              rows.length + 1,
              EffectArray.reduce(
                rows,
                4096,
                (sum, row) => sum + row[3].byteLength + row[1].length + row[2].length + 256,
              ),
              lock(
                commitCodeGraphGenerationStep(sql, {
                  generation,
                  ownerToken,
                  expectedCursor: progress.cursor,
                  expectedOffset: progress.array_offset,
                  nextCursor,
                  nextOffset: progress.array_offset + rawPage.length,
                  embedded,
                  reused: rows.length - embedded,
                  rows,
                }),
              ),
            );
            yield* input.onProgress?.({
              completed: progress.embedded + progress.reused,
              embedded: progress.embedded,
              reused: progress.reused,
              phase: 'embedding',
              total,
              unit: 'symbols',
            }) ?? Effect.void;
            steps += 1;
            if (!truncated && rawPage.length < VECTOR_PAGE_SIZE) break;
            if (steps >= maximumSteps)
              return {
                embedded: progress.embedded,
                reused: progress.reused,
                generation,
                ownerToken,
                modelId: selected.manifest.id,
                ready: false,
                state: 'checkpointed' as const,
                reason: 'Code graph vector generation checkpointed.',
              };
          }
          yield* protect(2, 4096, lock(completeCodeGraphGeneration(sql, generation, ownerToken, total)));
        }
        // Completion retains ownership until the independent publication fence has committed.
        const commit = sql.withTransaction(
          Effect.gen(function* () {
            yield* validate;
            yield* requireCodeGraphGenerationClaim(sql, generation, ownerToken);
            const ready = yield* sql.unsafe(
              "SELECT 1 FROM vector_generations WHERE generation = ? AND state = 'ready'",
              [generation],
            );
            if (ready.length !== 1)
              return yield* CodeGraphEmbeddingError.make({message: 'Code graph generation is not complete.'});
            yield* sql.unsafe(
              'UPDATE vector_generation_progress SET reusable_generation = NULL WHERE generation = ? AND owner_token = ?',
              [generation, ownerToken],
            );
            yield* activateVectorGeneration(sql, worktreeId, generation);
            yield* sql.unsafe('DELETE FROM vector_generation_progress WHERE generation = ? AND owner_token = ?', [
              generation,
              ownerToken,
            ]);
            yield* validate;
          }),
        );
        yield* protect(
          2,
          4096,
          input.publication
            ? input.publication.attach(commit.pipe(Effect.provideService(SqlClient.SqlClient, sql)))
            : lock(commit),
        );
        yield* removeLegacyVectorSidecars(input.fs, input.path, root);
        return {
          embedded: initialGeneration.state === 'ready' ? 0 : progress.embedded,
          reused: initialGeneration.state === 'ready' ? initialGeneration.count : progress.reused,
          modelId: selected.manifest.id,
          ready: true,
        };
      }).pipe(
        Effect.onExit(exit =>
          Exit.isFailure(exit) &&
          (Cause.hasInterrupts(exit.cause) ||
            input.retainPublicationClaimOnFailure?.(Cause.squash(exit.cause)) !== true)
            ? protect(1, 4096, lock(releaseCodeGraphGenerationClaim(sql, generation, ownerToken))).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
    }),
  );
});

/** A worker must prove release before discarding its durable demand owner. Never creates vector storage. */
export const releaseCodeGraphVectorOwner = Effect.fn('codeGraph.releaseVectorOwner')(function* (input: {
  readonly home: string;
  readonly layout: CodeGraphLayout;
  readonly modelId: string;
  readonly ownerToken: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(input.modelId))
    return yield* CodeGraphEmbeddingError.make({message: 'Vector cleanup model identity is invalid.'});
  const databasePath = vectorDatabasePath(path, input.layout.vectorRoot, input.modelId);
  const release = Effect.gen(function* () {
    if (!(yield* fs.exists(databasePath))) return;
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Expected native open failures stay typed; the scoped connection closes before returning.
        const services = yield* Layer.build(
          SqliteClient.layer({
            create: false,
            disableWAL: true,
            filename: databasePath,
            readwrite: true,
            busyTimeout: 50,
          }),
        );
        return yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* requireVectorDatabaseReady(sql);
          const versions = yield* sql.unsafe<{user_version: number}>('PRAGMA user_version');
          if (versions[0]?.user_version === 2) return;
          yield* requireCodeGraphGenerationSchema(sql);
          const owned = yield* sql.unsafe<{generation: string}>(
            'SELECT generation FROM vector_generation_progress WHERE owner_token = ? AND expires_at > ? LIMIT 2',
            [input.ownerToken, yield* Clock.currentTimeMillis],
          );
          if (owned.length === 0) return;
          if (owned.length !== 1)
            return yield* CodeGraphEmbeddingError.make({message: 'A vector owner has multiple generation claims.'});
          const capacity = yield* makeCodeGraphVectorRetirementCapacityProtector({
            databasePath,
            threadnoteHome: input.home,
            claimMode: 'nonblocking-one-attempt',
          });
          const storage = yield* inspectVectorPageStorageSql(sql);
          yield* capacity(
            {operation: 'write code graph vector generation', rowCount: 1, finalFactBytes: 4096},
            withExclusiveFileLock(
              fs,
              codeGraphVectorWriteLockPath(path, input.home, input.layout.checkoutId, sha256HexSync(input.modelId)),
              {...CODE_GRAPH_VECTOR_WRITE_LOCK_OPTIONS, waitTimeoutMilliseconds: 0},
              sql.withTransaction(
                sql.unsafe(
                  'UPDATE vector_generation_progress SET expires_at = 0 WHERE generation = ? AND owner_token = ?',
                  [owned[0].generation, input.ownerToken],
                ),
              ),
            ),
            storage,
          );
        }).pipe(Effect.provide(services));
      }),
    );
  });
  return yield* release.pipe(
    Effect.mapError(cause =>
      CodeGraphVectorClaimCleanupPending.make({cause, message: 'Vector ownership cleanup must be retried.'}),
    ),
  );
});

const searchGraphVectors = Effect.fn('codeGraph.searchVectors')(function* (input: {
  readonly catalog: LocalModelCatalogShape;
  readonly fs: FileSystem.FileSystem;
  readonly layout: CodeGraphLayout;
  readonly limit: number;
  readonly modelStore: LocalModelStoreShape;
  readonly path: Path.Path;
  readonly query: string;
  readonly runtime: LocalModelRuntimeShape;
  readonly snapshotId: string;
  readonly threadnoteHome: string;
}) {
  const selected = yield* selectedEmbeddingModel(input.threadnoteHome, input.catalog, input.modelStore);
  const databasePath = vectorDatabasePath(input.path, input.layout.vectorRoot, selected.manifest.id);
  if (!(yield* input.fs.exists(databasePath))) return new Map<string, number>();
  return yield* useVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* requireVectorDatabaseReady(sql);
      const active = yield* selectActiveGeneration(sql, requiredWorktreeId(input.layout));
      if (
        !active ||
        active.snapshot_id !== input.snapshotId ||
        active.model_sha256 !== selected.manifest.sha256 ||
        active.template_version !== CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION ||
        active.dimensions !== selected.manifest.dimensions
      ) {
        return new Map<string, number>();
      }
      const [queryVector] = yield* input.runtime.embedMany({
        inputs: [`${selected.manifest.promptPrefixes?.query ?? ''}${input.query}`],
        manifest: selected.manifest,
        modelPath: selected.modelPath,
      });
      const boundedLimit = Math.max(1, input.limit);
      let cursor = '';
      let best: readonly VectorSearchResult[] = [];
      for (;;) {
        const rows = yield* sql.unsafe<VectorRow>(
          `SELECT symbol_id, fingerprint, vector
           FROM vectors
           WHERE generation = ? AND symbol_id > ?
           ORDER BY symbol_id
           LIMIT ?`,
          [active.generation, cursor, VECTOR_PAGE_SIZE],
        );
        if (rows.length === 0) break;
        const records = EffectArray.map(rows, row => ({
          id: row.symbol_id,
          vector: decodeVector(row.vector, active.dimensions),
        }));
        const pageMatches = searchExactVectors(queryVector, records, {
          dimensions: active.dimensions,
          limit: Math.min(boundedLimit, records.length),
          minimumScore: CODE_GRAPH_SEMANTIC_MINIMUM_SCORE,
        });
        best = mergeSearchResults(best, pageMatches, boundedLimit);
        cursor = rows.at(-1)!.symbol_id;
        if (rows.length < VECTOR_PAGE_SIZE) break;
      }
      return new Map(EffectArray.map(best, match => [match.id, Math.max(0, match.score)]));
    }),
  );
});

const selectedEmbeddingModel = Effect.fn('codeGraph.selectedEmbeddingModel')(function* (
  threadnoteHome: string,
  catalog: LocalModelCatalogShape,
  store: LocalModelStoreShape,
) {
  const selection = yield* readModelSelection(threadnoteHome);
  const modelId = selection.roles.embedding;
  if (!modelId) return yield* CodeGraphEmbeddingError.make({message: 'No core embedding model is selected.'});
  const manifest = yield* catalog.get(modelId);
  if (manifest.role !== 'embedding' || !manifest.dimensions) {
    return yield* CodeGraphEmbeddingError.make({message: `Selected model ${modelId} is not an embedding model.`});
  }
  const verified = yield* store.verify(threadnoteHome, manifest);
  return {manifest, modelPath: verified.path};
});

function embeddingSymbolCount(source: CodeGraphEmbeddingSymbolSource): Effect.Effect<number, unknown> {
  return isSymbolPageSource(source) ? source.count : Effect.succeed(selectGraphEmbeddingSymbols(source).length);
}

function isSymbolPageSource(source: CodeGraphEmbeddingSymbolSource): source is CodeGraphSymbolPageSource {
  return 'loadPage' in source;
}

export function selectGraphEmbeddingSymbols(symbols: readonly CodeGraphSymbol[]): readonly CodeGraphSymbol[] {
  const selected = EffectArray.filter(
    symbols,
    (symbol, __effectArrayIndex) =>
      __effectArrayIndex in symbols &&
      (symbol.exported ||
        ['class', 'document', 'function', 'heading', 'interface', 'method', 'module', 'package', 'type'].includes(
          symbol.kind,
        )),
  );
  return [...new Map(EffectArray.map(selected, symbol => [symbol.id, symbol])).values()].sort(
    (left, right) =>
      vectorPriority(right) - vectorPriority(left) ||
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.qualifiedName, right.qualifiedName) ||
      compareCodeUnits(left.id, right.id),
  );
}

function vectorPriority(symbol: CodeGraphSymbol): number {
  const kind =
    {
      class: 9,
      document: 4,
      function: 10,
      heading: 5,
      interface: 9,
      method: 8,
      module: 6,
      package: 7,
      type: 8,
    }[symbol.kind] ?? 0;
  return (symbol.exported ? 100 : 0) + kind + (symbol.documentation ? 1 : 0);
}

function projectSymbol(symbol: CodeGraphSymbol): ProjectedSymbol {
  const text = EffectArray.join(
    EffectArray.filter(
      [
        `${symbol.kind} ${symbol.qualifiedName}`,
        symbol.signature ? `signature: ${symbol.signature}` : '',
        symbol.packageName ? `package: ${symbol.packageName}` : '',
        `path: ${symbol.path}`,
        symbol.documentation
          ? `documentation: ${Effect2.pipe(symbol.documentation, EffectString.slice(0, 1_024))}`
          : '',
      ],
      Boolean,
    ),
    '\n',
  );
  return {
    fingerprint: sha256HexSync(`code-graph-embedding-v${CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION}\n${text}`),
    id: symbol.id,
    text,
  };
}

const loadReusableVectors = Effect.fn('codeGraph.loadReusableVectors')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  symbols: readonly ProjectedSymbol[],
  dimensions: number,
) {
  if (symbols.length === 0) return new Map<string, Uint8Array>();
  const expected = new Map(EffectArray.map(symbols, symbol => [symbol.id, symbol.fingerprint]));
  const rows = yield* sql.unsafe<VectorRow>(
    `SELECT symbol_id, fingerprint, vector FROM vectors
     WHERE generation = ? AND symbol_id IN (${EffectArray.join(
       EffectArray.map(symbols, () => '?'),
       ', ',
     )})`,
    [generation, ...EffectArray.map(symbols, symbol => symbol.id)],
  );
  const reusable = new Map<string, Uint8Array>();
  for (const row of rows) {
    if (expected.get(row.symbol_id) !== row.fingerprint) continue;
    const bytes = bytesFromSqlBlob(row.vector);
    if (isDecodableVector(bytes, dimensions)) reusable.set(row.symbol_id, bytes);
  }
  return reusable;
});

function encodeVector(vector: readonly number[], dimensions: number): Uint8Array {
  if (vector.length !== dimensions) {
    throw CodeGraphEmbeddingError.make({message: `Vector has ${vector.length} dimensions; expected ${dimensions}.`});
  }
  const bytes = new Uint8Array(dimensions * 4);
  const view = new DataView(bytes.buffer);
  for (const [index, component] of vector.entries()) {
    if (!Number.isFinite(component))
      throw CodeGraphEmbeddingError.make({message: 'Vector contains a non-finite component.'});
    view.setFloat32(index * 4, component, true);
  }
  return bytes;
}

function decodeVector(value: unknown, dimensions: number): readonly number[] {
  const bytes = bytesFromSqlBlob(value);
  if (bytes.byteLength !== dimensions * 4) {
    throw CodeGraphEmbeddingError.make({
      message: `Stored vector has ${bytes.byteLength} bytes; expected ${dimensions * 4}.`,
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = Array.from({length: dimensions}, (_, index) => view.getFloat32(index * 4, true));
  if (EffectArray.some(vector, component => !Number.isFinite(component))) {
    throw CodeGraphEmbeddingError.make({message: 'Stored vector contains a non-finite component.'});
  }
  const magnitude = Math.sqrt(EffectArray.reduce(vector, 0, (sum, component) => sum + component * component));
  if (Math.abs(magnitude - 1) > 0.002)
    throw CodeGraphEmbeddingError.make({message: 'Stored vector is not L2-normalized.'});
  return vector;
}

function isDecodableVector(value: unknown, dimensions: number): boolean {
  try {
    decodeVector(value, dimensions);
    return true;
  } catch {
    return false;
  }
}

function bytesFromSqlBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw CodeGraphEmbeddingError.make({message: 'Stored vector is not a binary SQLite value.'});
}

function mergeSearchResults(
  left: readonly VectorSearchResult[],
  right: readonly VectorSearchResult[],
  limit: number,
): readonly VectorSearchResult[] {
  return [...left, ...right].sort((a, b) => b.score - a.score || compareCodeUnits(a.id, b.id)).slice(0, limit);
}

function vectorDatabasePath(path: Path.Path, vectorRoot: string, modelId: string): string {
  return path.join(vectorRoot, modelId, CODE_GRAPH_VECTOR_DATABASE_FILENAME);
}

function useVectorDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
  readOnly = false,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    Layer.build(
      SqliteClient.layer({
        disableWAL: true,
        filename: databasePath,
        ...(readOnly ? {readonly: true, create: false, readwrite: false, busyTimeout: 100} : {}),
      }).pipe(Layer.orDie),
    ).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
}

const initializeVectorDatabase = Effect.fn('codeGraph.initializeVectorDatabase')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  const versions = yield* sql.unsafe<{readonly user_version: number}>('PRAGMA user_version');
  const version = Number(versions[0]?.user_version ?? 0);
  if (version === CODE_GRAPH_VECTOR_DATABASE_VERSION) {
    yield* requireVectorDatabaseReady(sql);
    yield* sql.unsafe('PRAGMA journal_mode = WAL');
    return;
  }
  if (version === 2) {
    yield* requireCodeGraphVectorRetirementSchema(sql);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* initializeCodeGraphGenerationSchema(sql);
        yield* sql.unsafe(`PRAGMA user_version = ${CODE_GRAPH_VECTOR_DATABASE_VERSION}`);
        yield* requireVectorDatabaseReady(sql);
      }),
    );
    yield* sql.unsafe('PRAGMA journal_mode = WAL');
    return;
  }
  if (version !== 0) {
    return yield* CodeGraphEmbeddingError.make({message: 'Code graph vector database version is unsupported.'});
  }
  const objects = yield* sql.unsafe(
    `SELECT 1 FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' COLLATE NOCASE
     LIMIT 1`,
  );
  if (objects.length !== 0) {
    return yield* CodeGraphEmbeddingError.make({message: 'Code graph vector database initialization is incomplete.'});
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL);
      yield* sql.unsafe(CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL);
      yield* sql.unsafe(CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL);
      yield* sql.unsafe(CODE_GRAPH_VECTORS_TABLE_SQL);
      yield* sql.unsafe(CODE_GRAPH_VECTOR_REUSE_INDEX_SQL);
      yield* initializeCodeGraphVectorRetirementSchema(sql);
      yield* initializeCodeGraphGenerationSchema(sql);
      yield* sql.unsafe(`PRAGMA user_version = ${CODE_GRAPH_VECTOR_DATABASE_VERSION}`);
    }),
  );
  yield* sql.unsafe('PRAGMA journal_mode = WAL');
});

const requireVectorDatabaseReady = Effect.fn('codeGraph.requireVectorDatabaseReady')(function* (
  sql: SqlClient.SqlClient,
) {
  const versions = yield* sql.unsafe<{readonly user_version: unknown}>('PRAGMA user_version');
  if (versions.length !== 1 || ![2, CODE_GRAPH_VECTOR_DATABASE_VERSION].includes(Number(versions[0]?.user_version))) {
    return yield* CodeGraphEmbeddingError.make({message: 'Code graph vector database version is unsupported.'});
  }
  yield* requireCodeGraphVectorRetirementSchema(sql);
  if (versions[0]?.user_version === CODE_GRAPH_VECTOR_DATABASE_VERSION) yield* requireCodeGraphGenerationSchema(sql);
});

const selectActiveGeneration = Effect.fn('codeGraph.selectActiveVectorGeneration')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
) {
  const rows = yield* sql.unsafe<VectorGenerationRow>(
    `SELECT generation.*
     FROM vector_pointers AS pointer
     JOIN vector_generations AS generation ON generation.generation = pointer.generation
     WHERE pointer.worktree_id = ? AND generation.state = 'ready'
       AND NOT EXISTS (
         SELECT 1 FROM vector_generation_retirements AS retirement
         WHERE retirement.generation = generation.generation
       )
     LIMIT 1`,
    [worktreeId],
  );
  return rows[0];
});

const selectGenerationForSnapshot = Effect.fn('codeGraph.selectVectorGenerationForSnapshot')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  modelSha256: string,
  dimensions: number,
) {
  const rows = yield* sql.unsafe<VectorGenerationRow>(
    `SELECT * FROM vector_generations
     WHERE snapshot_id = ?
       AND model_sha256 = ?
       AND dimensions = ?
       AND template_version = ?
       AND state = 'ready'
       AND NOT EXISTS (
         SELECT 1 FROM vector_generation_retirements AS retirement
         WHERE retirement.generation = vector_generations.generation
       )
     ORDER BY created_at DESC, generation DESC
     LIMIT 1`,
    [snapshotId, modelSha256, dimensions, CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION],
  );
  return rows[0];
});

function activateVectorGeneration(sql: SqlClient.SqlClient, worktreeId: string, generation: string) {
  return sql`
    INSERT INTO vector_pointers (worktree_id, generation)
    VALUES (${worktreeId}, ${generation})
    ON CONFLICT(worktree_id) DO UPDATE SET generation = excluded.generation
  `;
}

const removeLegacyVectorSidecars = Effect.fn('codeGraph.removeLegacyVectorSidecars')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  for (const legacy of ['active.json', 'generations', 'pointers']) {
    yield* fs.remove(path.join(root, legacy), {force: true, recursive: true}).pipe(Effect.ignore);
  }
});

function requiredWorktreeId(layout: CodeGraphLayout): string {
  if (!/^[0-9a-f]{64}$/.test(layout.worktreeId))
    throw CodeGraphEmbeddingError.make({message: 'Code graph worktree identity is invalid.'});
  return codeGraphVectorViewId(layout.worktreeId, layout.scopeId);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
