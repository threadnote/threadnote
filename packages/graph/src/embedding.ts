import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Clock, Context, Crypto, DateTime, Effect, FileSystem, Layer, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {LocalModelRuntime, type LocalModelRuntimeShape} from '@threadnote/inference/engine/local-model-runtime';
import {
  LocalModelCatalog,
  type LocalModelCatalogShape,
  type LocalModelManifest,
} from '@threadnote/inference/models/catalog';
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

class CodeGraphEmbeddingError extends Schema.TaggedError<CodeGraphEmbeddingError>()('CodeGraphEmbeddingError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION = 1;
const CODE_GRAPH_EMBEDDING_CONTEXT_CAP = 8;
const CODE_GRAPH_VECTOR_DATABASE_VERSION = 2;
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

export interface CodeGraphEmbeddingStatus {
  readonly embedded: number;
  readonly modelId?: string;
  readonly ready: boolean;
  readonly reason?: string;
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
  ) => Effect.Effect<CodeGraphEmbeddingCheck, unknown>;
  readonly ensure: (
    threadnoteHome: string,
    layout: CodeGraphLayout,
    snapshot: CodeGraphSnapshot,
    symbols: CodeGraphEmbeddingSymbolSource,
    options?: {
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
        check: (threadnoteHome, layout, snapshotId) =>
          checkGraphVectors({catalog, fs, layout, modelStore, path, snapshotId, threadnoteHome}).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
        ensure: (threadnoteHome, layout, snapshot, symbols, options) =>
          ensureGraphVectors({
            catalog,
            force: options?.force === true,
            fs,
            layout,
            modelStore,
            onProgress: options?.onProgress,
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
  readonly catalog: LocalModelCatalogShape;
  readonly fs: FileSystem.FileSystem;
  readonly layout: CodeGraphLayout;
  readonly modelStore: LocalModelStoreShape;
  readonly path: Path.Path;
  readonly snapshotId: string;
  readonly threadnoteHome: string;
}) {
  const selected = yield* selectedEmbeddingModel(input.threadnoteHome, input.catalog, input.modelStore).pipe(
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
        active.model_sha256 !== selected.manifest.sha256 ||
        active.template_version !== CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION ||
        active.dimensions !== selected.manifest.dimensions
      ) {
        return {reason: 'Code graph vectors do not match the ready snapshot.', state: 'stale'} as const;
      }
      return {modelId: selected.manifest.id, reused: active.count, state: 'ready'} as const;
    }),
  ).pipe(
    Effect.catch(cause =>
      Effect.succeed({reason: `Code graph vector database is invalid: ${messageOf(cause)}`, state: 'stale'} as const),
    ),
  );
});

const ensureGraphVectors = Effect.fn('codeGraph.ensureVectors')(function* (input: {
  readonly catalog: LocalModelCatalogShape;
  readonly force: boolean;
  readonly fs: FileSystem.FileSystem;
  readonly layout: CodeGraphLayout;
  readonly modelStore: LocalModelStoreShape;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly path: Path.Path;
  readonly runtime: LocalModelRuntimeShape;
  readonly snapshot: CodeGraphSnapshot;
  readonly symbols: CodeGraphEmbeddingSymbolSource;
  readonly threadnoteHome: string;
}) {
  const crypto = yield* Crypto.Crypto;
  const system = yield* SystemInfo;
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
  const worktreeId = requiredWorktreeId(input.layout);
  yield* input.fs.makeDirectory(root, {recursive: true, mode: 0o700});
  if (yield* input.fs.exists(databasePath)) {
    const capacityProtector = yield* makeCodeGraphVectorRetirementCapacityProtector({
      databasePath,
      threadnoteHome: input.threadnoteHome,
    });
    yield* prepareCodeGraphVectorRetirement(databasePath, {
      capacityProtector: (boundary, transaction, storage) =>
        capacityProtector(
          boundary,
          withExclusiveFileLock(input.fs, writeLockPath, CODE_GRAPH_VECTOR_WRITE_LOCK_OPTIONS, transaction).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Path.Path, input.path),
            Effect.provideService(SystemInfo, system),
          ),
          storage,
        ),
    });
  }
  const status = yield* withExclusiveFileLock(
    input.fs,
    writeLockPath,
    CODE_GRAPH_VECTOR_WRITE_LOCK_OPTIONS,
    useVectorDatabase(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* initializeVectorDatabase(sql);
        const active = yield* selectActiveGeneration(sql, worktreeId);
        if (
          !input.force &&
          active?.snapshot_id === input.snapshot.id &&
          active.model_sha256 === selected.manifest.sha256 &&
          active.template_version === CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION &&
          active.dimensions === selected.manifest.dimensions
        ) {
          return {embedded: 0, modelId: selected.manifest.id, ready: true, reused: active.count};
        }

        const exact = input.force
          ? undefined
          : yield* selectGenerationForSnapshot(
              sql,
              input.snapshot.id,
              selected.manifest.sha256,
              selected.manifest.dimensions!,
            );
        if (exact) {
          yield* activateVectorGeneration(sql, worktreeId, exact.generation);
          return {embedded: 0, modelId: selected.manifest.id, ready: true, reused: exact.count};
        }

        const reusable = input.force
          ? undefined
          : active &&
              active.model_sha256 === selected.manifest.sha256 &&
              active.template_version === CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION &&
              active.dimensions === selected.manifest.dimensions
            ? active
            : undefined;
        const generation = `${yield* Clock.currentTimeMillis}-${worktreeId.slice(-8)}-${input.snapshot.id.slice(-8)}-${(yield* crypto.randomUUIDv4).slice(
          0,
          8,
        )}`;
        yield* sql`
        INSERT INTO vector_generations (
          generation, snapshot_id, model_id, model_sha256, dimensions,
          template_version, count, state, created_at
        ) VALUES (
          ${generation}, ${input.snapshot.id}, ${selected.manifest.id}, ${selected.manifest.sha256},
          ${selected.manifest.dimensions!}, ${CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION}, 0, 'building',
          ${DateTime.formatIso(yield* DateTime.now)}
        )
      `;

        const build = buildVectorGeneration({
          generation,
          onProgress: input.onProgress,
          reusableGeneration: reusable?.generation,
          runtime: input.runtime,
          selected,
          snapshot: input.snapshot,
          source: input.symbols,
          sql,
        }).pipe(
          Effect.tap(result =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                UPDATE vector_generations
                SET count = ${result.count}, state = 'ready'
                WHERE generation = ${generation}
              `;
                yield* activateVectorGeneration(sql, worktreeId, generation);
              }),
            ),
          ),
        );
        const built = yield* build;
        yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
        return {
          embedded: built.embedded,
          modelId: selected.manifest.id,
          ready: true,
          reused: built.reused,
        };
      }),
    ),
  );
  yield* removeLegacyVectorSidecars(input.fs, input.path, root);
  return status;
});

const buildVectorGeneration = Effect.fn('codeGraph.buildVectorGeneration')(function* (input: {
  readonly generation: string;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly reusableGeneration?: string;
  readonly runtime: LocalModelRuntimeShape;
  readonly selected: {
    readonly manifest: LocalModelManifest;
    readonly modelPath: string;
  };
  readonly snapshot: CodeGraphSnapshot;
  readonly source: CodeGraphEmbeddingSymbolSource;
  readonly sql: SqlClient.SqlClient;
}) {
  const dimensions = input.selected.manifest.dimensions!;
  const total = yield* embeddingSymbolCount(input.source);
  let embedded = 0;
  let reused = 0;
  let cursor: CodeGraphSymbolCursor | undefined;
  let arrayOffset = 0;
  yield* input.onProgress?.({
    completed: embedded + reused,
    embedded,
    phase: 'embedding',
    reused,
    total,
    unit: 'symbols',
  }) ?? Effect.void;

  for (;;) {
    const rawPage = isSymbolPageSource(input.source)
      ? yield* input.source.loadPage(cursor, VECTOR_PAGE_SIZE)
      : input.source.slice(arrayOffset, arrayOffset + VECTOR_PAGE_SIZE);
    if (rawPage.length === 0) break;
    const projected = selectGraphEmbeddingSymbols(rawPage).map(projectSymbol);
    const fresh = yield* excludeAlreadyInserted(input.sql, input.generation, projected);
    const reusable = input.reusableGeneration
      ? yield* loadReusableVectors(input.sql, input.reusableGeneration, fresh, dimensions)
      : new Map<string, Uint8Array>();
    const rows: Array<readonly [string, string, string, Uint8Array]> = [];
    const missing: ProjectedSymbol[] = [];
    for (const item of fresh) {
      const vector = reusable.get(item.id);
      if (vector) {
        rows.push([input.generation, item.id, item.fingerprint, vector]);
        reused += 1;
      } else {
        missing.push(item);
      }
    }
    yield* insertVectorRows(input.sql, rows);
    yield* input.onProgress?.({
      completed: embedded + reused,
      embedded,
      phase: 'embedding',
      reused,
      total,
      unit: 'symbols',
    }) ?? Effect.void;

    for (let start = 0; start < missing.length; start += EMBED_BATCH_SIZE) {
      const batch = missing.slice(start, start + EMBED_BATCH_SIZE);
      const vectors = yield* input.runtime.embedMany({
        embeddingContextPoolSize: CODE_GRAPH_EMBEDDING_CONTEXT_CAP,
        inputs: batch.map(item => `${input.selected.manifest.promptPrefixes?.document ?? ''}${item.text}`),
        manifest: input.selected.manifest,
        modelPath: input.selected.modelPath,
      });
      const embeddedRows = batch.map(
        (item, index) =>
          [
            input.generation,
            item.id,
            item.fingerprint,
            encodeVector(normalizeVector(vectors[index]), dimensions),
          ] as const,
      );
      yield* insertVectorRows(input.sql, embeddedRows);
      embedded += batch.length;
      yield* input.onProgress?.({
        completed: embedded + reused,
        embedded,
        phase: 'embedding',
        reused,
        total,
        unit: 'symbols',
      }) ?? Effect.void;
    }

    if (isSymbolPageSource(input.source)) {
      const last = rawPage.at(-1)!;
      cursor = {id: last.id, path: last.path, qualifiedName: last.qualifiedName};
    } else {
      arrayOffset += rawPage.length;
    }
    if (rawPage.length < VECTOR_PAGE_SIZE) break;
  }

  const rows = yield* input.sql<{readonly count: number}>`
    SELECT COUNT(*) AS count FROM vectors WHERE generation = ${input.generation}
  `;
  const count = Number(rows[0]?.count ?? 0);
  yield* input.onProgress?.({
    completed: count,
    embedded,
    phase: 'embedding',
    reused,
    total: count,
    unit: 'symbols',
  }) ?? Effect.void;
  return {count, embedded, reused};
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
        const records = rows.map(row => ({
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
      return new Map(best.map(match => [match.id, Math.max(0, match.score)]));
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
  const selected = symbols.filter(
    symbol =>
      symbol.exported ||
      ['class', 'document', 'function', 'heading', 'interface', 'method', 'module', 'package', 'type'].includes(
        symbol.kind,
      ),
  );
  return [...new Map(selected.map(symbol => [symbol.id, symbol])).values()].sort(
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
  const text = [
    `${symbol.kind} ${symbol.qualifiedName}`,
    symbol.signature ? `signature: ${symbol.signature}` : '',
    symbol.packageName ? `package: ${symbol.packageName}` : '',
    `path: ${symbol.path}`,
    symbol.documentation ? `documentation: ${symbol.documentation.slice(0, 1_024)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    fingerprint: sha256HexSync(`code-graph-embedding-v${CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION}\n${text}`),
    id: symbol.id,
    text,
  };
}

const excludeAlreadyInserted = Effect.fn('codeGraph.excludeAlreadyInserted')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  symbols: readonly ProjectedSymbol[],
) {
  if (symbols.length === 0) return symbols;
  const rows = yield* sql.unsafe<{readonly symbol_id: string}>(
    `SELECT symbol_id FROM vectors
     WHERE generation = ? AND symbol_id IN (${symbols.map(() => '?').join(', ')})`,
    [generation, ...symbols.map(symbol => symbol.id)],
  );
  const existing = new Set(rows.map(row => row.symbol_id));
  return symbols.filter(symbol => !existing.has(symbol.id));
});

const loadReusableVectors = Effect.fn('codeGraph.loadReusableVectors')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  symbols: readonly ProjectedSymbol[],
  dimensions: number,
) {
  if (symbols.length === 0) return new Map<string, Uint8Array>();
  const expected = new Map(symbols.map(symbol => [symbol.id, symbol.fingerprint]));
  const rows = yield* sql.unsafe<VectorRow>(
    `SELECT symbol_id, fingerprint, vector FROM vectors
     WHERE generation = ? AND symbol_id IN (${symbols.map(() => '?').join(', ')})`,
    [generation, ...symbols.map(symbol => symbol.id)],
  );
  const reusable = new Map<string, Uint8Array>();
  for (const row of rows) {
    if (expected.get(row.symbol_id) !== row.fingerprint) continue;
    const bytes = bytesFromSqlBlob(row.vector);
    if (isDecodableVector(bytes, dimensions)) reusable.set(row.symbol_id, bytes);
  }
  return reusable;
});

function insertVectorRows(sql: SqlClient.SqlClient, rows: readonly (readonly [string, string, string, Uint8Array])[]) {
  return Effect.gen(function* () {
    for (let start = 0; start < rows.length; start += 100) {
      const batch = rows.slice(start, start + 100);
      yield* sql.unsafe(
        `INSERT OR IGNORE INTO vectors (generation, symbol_id, fingerprint, vector)
         VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')}`,
        batch.flat(),
      );
    }
  });
}

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
  if (vector.some(component => !Number.isFinite(component))) {
    throw CodeGraphEmbeddingError.make({message: 'Stored vector contains a non-finite component.'});
  }
  const magnitude = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
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
  return path.join(vectorRoot, modelId, `vectors-v${CODE_GRAPH_VECTOR_DATABASE_VERSION}.sqlite`);
}

function useVectorDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    Layer.build(SqliteClient.layer({disableWAL: true, filename: databasePath})).pipe(
      Effect.flatMap(context => effect.pipe(Effect.provide(context))),
    ),
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
      yield* sql.unsafe(`PRAGMA user_version = ${CODE_GRAPH_VECTOR_DATABASE_VERSION}`);
    }),
  );
  yield* sql.unsafe('PRAGMA journal_mode = WAL');
});

const requireVectorDatabaseReady = Effect.fn('codeGraph.requireVectorDatabaseReady')(function* (
  sql: SqlClient.SqlClient,
) {
  const versions = yield* sql.unsafe<{readonly user_version: unknown}>('PRAGMA user_version');
  if (versions.length !== 1 || versions[0]?.user_version !== CODE_GRAPH_VECTOR_DATABASE_VERSION) {
    return yield* CodeGraphEmbeddingError.make({message: 'Code graph vector database version is unsupported.'});
  }
  yield* requireCodeGraphVectorRetirementSchema(sql);
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
