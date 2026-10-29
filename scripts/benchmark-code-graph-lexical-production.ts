import {Array as EffectArray} from 'effect';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {DateTime, Effect, FileSystem, Option, Path} from 'effect';
import {
  codeGraphCompactLexicalDeepAuditStatement,
  codeGraphEffectiveSymbolTermsQueryStatement,
  codeGraphTermCandidateQueryStatement,
  CodeGraphStore,
  type CodeGraphActivationProgress,
  type CodeGraphStagingProgress,
} from '@threadnote/graph/store';
import type {
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {parseLexicalProductionBenchmarkArguments} from './benchmark-code-graph-lexical-production-arguments.js';
import {atomicWrite, printJson, scriptArguments} from './effect/script.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const ARTIFACT_VERSION = 1 as const;
const LEGACY_INSERT_BATCH_ROWS = 5_000;
const LEGACY_TRANSACTION_ROWS = 100_000;
const SNAPSHOT_ID = 'lexical-production-micro';

interface QueryMeasurements {
  readonly digest: string;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly responseRows: number;
}

interface StorageMeasurements {
  readonly allocatedBytes: number;
  readonly freelistBytes: number;
  readonly pageCount: number;
  readonly pageSize: number;
}

interface CanonicalEvidence {
  readonly digest: string;
  readonly rowCount: number;
}

interface CompactBuildMeasurements {
  readonly activationValidationMilliseconds: number;
  readonly materializationMilliseconds: number;
  readonly postingRows: number;
  readonly termWriteMilliseconds: number;
}

interface ExactValidationMeasurements {
  readonly actualPostingCount: number;
  readonly actualSymbolCount: number;
  readonly actualTermCount: number;
  readonly expectedPostingCount: number;
  readonly expectedSymbolCount: number;
  readonly expectedTermCount: number;
  readonly firstMilliseconds: number;
  readonly parity: boolean;
  readonly p50Milliseconds: number;
  readonly samples: number;
}

const benchmark = Effect.scoped(
  Effect.gen(function* () {
    const args = parseLexicalProductionBenchmarkArguments(yield* scriptArguments());
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const hardware = yield* system.hardwareInfo;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-lexical-production-micro-'});
    const compactPath = path.join(root, 'compact.sqlite');
    const legacyPath = path.join(root, 'legacy.sqlite');
    const fixture = lexicalFixture(root, args.symbolCount);

    const compactBuild = yield* buildCompactSnapshot(
      compactPath,
      fixture.identity,
      fixture.files,
      fixture.symbols,
      args.batchSymbols,
    );
    yield* Effect.sync(() => checkpointAndVacuum(compactPath));
    const compactStorage = storageMeasurements(compactPath);
    const compactCanonical = canonicalEvidence(compactPath, SNAPSHOT_ID);
    const compactValidation = compactValidationMeasurements(compactPath, SNAPSHOT_ID);

    yield* fs.copyFile(compactPath, legacyPath);
    yield* Effect.sync(() => prepareLegacyClone(legacyPath, SNAPSHOT_ID));
    const legacyWrite = yield* Effect.sync(() => materializeLegacyTerms(compactPath, legacyPath, SNAPSHOT_ID));
    yield* Effect.sync(() => checkpointAndVacuum(legacyPath));
    const legacyStorage = storageMeasurements(legacyPath);
    const legacyCanonical = canonicalEvidence(legacyPath, SNAPSHOT_ID);

    const queryTerms = ['render', 'pipeline', 'service', 'module-7'];
    const compactQuery = queryMeasurements(compactPath, SNAPSHOT_ID, queryTerms, args.queryIterations);
    const legacyQuery = queryMeasurements(legacyPath, SNAPSHOT_ID, queryTerms, args.queryIterations);
    const allocatedBytesReductionPercent =
      (1 - compactStorage.allocatedBytes / Math.max(1, legacyStorage.allocatedBytes)) * 100;
    const assertions = {
      canonicalParity:
        compactCanonical.rowCount === legacyCanonical.rowCount && compactCanonical.digest === legacyCanonical.digest,
      deepAuditParity: compactValidation.parity,
      postingCountParity:
        compactBuild.postingRows === compactCanonical.rowCount && compactBuild.postingRows === legacyWrite.postingRows,
      queryParity: compactQuery.digest === legacyQuery.digest && compactQuery.responseRows === legacyQuery.responseRows,
      storageReduced: compactStorage.allocatedBytes < legacyStorage.allocatedBytes,
    };
    if (EffectArray.some(EffectRecord.values(assertions), value => !value)) {
      return yield* ScriptError.make({
        message: `Code graph lexical production microbenchmark failed: ${JSON.stringify(assertions)}`,
      });
    }

    const artifact = {
      assertions,
      compact: {
        ...compactBuild,
        canonical: compactCanonical,
        exactValidation: compactValidation,
        query: compactQuery,
        storage: compactStorage,
      },
      contract: {
        compactFormatVersion: 1,
        legacySecondaryIndexes: ['terms_lookup', 'terms_symbol'],
        measurement: 'same-process-production-schema-write-query-microbenchmark',
        ranking: 'sum-weight-desc-symbol-id',
        scope: 'lexical-storage-only-not-end-to-end-indexing',
      },
      createdAt: DateTime.formatIso(yield* DateTime.now),
      environment: {
        architecture: system.architecture,
        commit: gitValue(['rev-parse', 'HEAD']),
        cpu: hardware.cpuModel,
        dirty: gitValue(['status', '--porcelain']).length > 0,
        memoryBytes: hardware.memoryBytes,
        operatingSystem: hardware.operatingSystem,
        runtime: system.runtimeVersion,
        sqlite: sqliteVersion(compactPath),
      },
      legacy: {
        canonical: legacyCanonical,
        postingRows: legacyWrite.postingRows,
        query: legacyQuery,
        storage: legacyStorage,
        termWriteMilliseconds: legacyWrite.termWriteMilliseconds,
      },
      profile: {
        allowLarge: args.allowLarge,
        batchSymbols: args.batchSymbols,
        legacyInsertBatchRows: LEGACY_INSERT_BATCH_ROWS,
        legacyTransactionRows: LEGACY_TRANSACTION_ROWS,
        queryIterations: args.queryIterations,
        symbolCount: args.symbolCount,
      },
      reduction: {
        exactCountToActivationValidationRatio:
          compactValidation.p50Milliseconds / Math.max(Number.EPSILON, compactBuild.activationValidationMilliseconds),
        allocatedBytesPercent: allocatedBytesReductionPercent,
        compactToLegacyRatio: compactStorage.allocatedBytes / Math.max(1, legacyStorage.allocatedBytes),
        compactToLegacyTermWriteRatio:
          compactBuild.termWriteMilliseconds / Math.max(Number.EPSILON, legacyWrite.termWriteMilliseconds),
      },
      suite: 'code-graph-lexical-production-micro-v1',
      version: ARTIFACT_VERSION,
    };
    if (Option.isSome(args.outputPath)) {
      yield* atomicWrite(args.outputPath.value, `${JSON.stringify(artifact, undefined, 2)}\n`);
    }
    yield* printJson(artifact);
  }),
);

const buildCompactSnapshot = Effect.fn('benchmarkCodeGraphLexicalProduction.buildCompact')(function* (
  databasePath: string,
  identity: RepositoryIdentity,
  files: readonly CodeGraphInventoryFile[],
  symbols: readonly CodeGraphSymbol[],
  batchSymbols: number,
) {
  const store = yield* CodeGraphStore;
  const batches = chunk(symbols, batchSymbols);
  const snapshot: CodeGraphSnapshot = {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: 0,
    extractorSet: 'lexical-production-micro-v1',
    fileCount: files.length,
    id: SNAPSHOT_ID,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: symbols.length,
    worktreeId: identity.worktreeId,
  };
  let termWriteMilliseconds = 0;
  let postingRows = 0;
  let activationValidationMilliseconds = 0;
  const startedAt = performance.now();
  yield* store.withSession(
    databasePath,
    Effect.gen(function* () {
      const ownerToken = yield* store.claimPersistentBuild(databasePath, identity, {...snapshot, state: 'building'});
      yield* store.prepareActivation(databasePath, files, snapshot.id, batches.length, ownerToken);
      for (const [batchIndex, batch] of batches.entries()) {
        let batchTermMilliseconds = 0;
        let batchPostingRows = 0;
        yield* store.stageActivationFacts(
          databasePath,
          batch,
          [],
          [],
          (progress: CodeGraphStagingProgress) =>
            Effect.sync(() => {
              if (progress.stage !== 'terms') return;
              batchTermMilliseconds = Math.max(batchTermMilliseconds, progress.stageElapsedMilliseconds ?? 0);
              batchPostingRows = Math.max(batchPostingRows, progress.rowsCompleted);
            }),
          batchIndex,
        );
        termWriteMilliseconds += batchTermMilliseconds;
        postingRows += batchPostingRows;
      }
      yield* store.resolveStagedReferences(databasePath);
      yield* store.activateStaged(
        databasePath,
        identity,
        snapshot,
        undefined,
        undefined,
        (progress: CodeGraphActivationProgress) =>
          Effect.sync(() => {
            if (progress.stage === 'validating-input' && progress.state === 'completed') {
              activationValidationMilliseconds = progress.stageElapsedMilliseconds;
            }
          }),
      );
    }),
  );
  return {
    activationValidationMilliseconds,
    materializationMilliseconds: performance.now() - startedAt,
    postingRows,
    termWriteMilliseconds,
  } satisfies CompactBuildMeasurements;
});

function prepareLegacyClone(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('PRAGMA foreign_keys = ON');
    database.run('PRAGMA journal_mode = WAL');
    database.run('BEGIN IMMEDIATE');
    try {
      database.query('DELETE FROM lexical_storage_formats WHERE snapshot_id = ?').run(snapshotId);
      database.query('DELETE FROM lexical_compact_snapshots WHERE snapshot_id = ?').run(snapshotId);
      database.run('CREATE INDEX IF NOT EXISTS terms_lookup ON symbol_terms(snapshot_id, term, weight DESC)');
      database.run('CREATE INDEX IF NOT EXISTS terms_symbol ON symbol_terms(snapshot_id, symbol_id)');
      database.run('COMMIT');
    } catch (cause) {
      database.run('ROLLBACK');
      throw cause;
    }
    database.run('PRAGMA wal_checkpoint(TRUNCATE)');
    database.run('VACUUM');
  } finally {
    database.close(false);
  }
}

function materializeLegacyTerms(
  compactPath: string,
  legacyPath: string,
  snapshotId: string,
): {readonly postingRows: number; readonly termWriteMilliseconds: number} {
  const compact = new Database(compactPath, {readonly: true, strict: true});
  const legacy = new Database(legacyPath, {strict: true});
  try {
    legacy.run('PRAGMA foreign_keys = ON');
    legacy.run('PRAGMA journal_mode = WAL');
    legacy.run('PRAGMA synchronous = NORMAL');
    const canonical = codeGraphEffectiveSymbolTermsQueryStatement(snapshotId, undefined);
    const rowSequence = compact.query(canonical.text).iterate(...canonical.parameters);
    const rows = rowSequence[Symbol.iterator]();
    let postingRows = 0;
    let transactionRows = 0;
    let batch: Array<{readonly symbol_id: string; readonly term: string; readonly weight: number}> = [];
    let transactionOpen = false;
    const begin = () => {
      if (transactionOpen) return;
      legacy.run('BEGIN IMMEDIATE');
      transactionOpen = true;
      transactionRows = 0;
    };
    const commit = () => {
      if (!transactionOpen) return;
      legacy.run('COMMIT');
      transactionOpen = false;
    };
    const flush = () => {
      if (batch.length === 0) return;
      begin();
      legacy
        .query(
          `INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight)
           VALUES ${EffectArray.join(
             EffectArray.map(batch, () => '(?, ?, ?, ?)'),
             ', ',
           )}`,
        )
        .run(...EffectArray.flatMap(batch, row => [snapshotId, row.term, row.symbol_id, Number(row.weight)]));
      postingRows += batch.length;
      transactionRows += batch.length;
      batch = [];
      if (transactionRows >= LEGACY_TRANSACTION_ROWS) commit();
    };
    const startedAt = performance.now();
    let next = rows.next();
    while (!next.done) {
      const row = next.value;
      if (!isLegacySymbolTermRow(row))
        throw ScriptError.make({message: 'Legacy symbol-term scan returned an invalid row.'});
      batch.push(row);
      if (batch.length >= LEGACY_INSERT_BATCH_ROWS) flush();
      next = rows.next();
    }
    flush();
    commit();
    legacy.run('PRAGMA synchronous = FULL');
    return {postingRows, termWriteMilliseconds: performance.now() - startedAt};
  } catch (cause) {
    try {
      legacy.run('ROLLBACK');
    } catch {
      // No transaction remains open after a successful final commit.
    }
    throw cause;
  } finally {
    compact.close(false);
    legacy.close(false);
  }
}

function isLegacySymbolTermRow(
  value: unknown,
): value is {readonly symbol_id: string; readonly term: string; readonly weight: number} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'symbol_id' in value &&
    typeof value.symbol_id === 'string' &&
    'term' in value &&
    typeof value.term === 'string' &&
    'weight' in value &&
    typeof value.weight === 'number'
  );
}

function isExactValidationMeasurementsRow(value: unknown): value is {
  readonly expected_posting_count: number;
  readonly expected_symbol_count: number;
  readonly expected_term_count: number;
  readonly posting_count: number;
  readonly symbol_count: number;
  readonly term_count: number;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'expected_posting_count' in value &&
    typeof value.expected_posting_count === 'number' &&
    'expected_symbol_count' in value &&
    typeof value.expected_symbol_count === 'number' &&
    'expected_term_count' in value &&
    typeof value.expected_term_count === 'number' &&
    'posting_count' in value &&
    typeof value.posting_count === 'number' &&
    'symbol_count' in value &&
    typeof value.symbol_count === 'number' &&
    'term_count' in value &&
    typeof value.term_count === 'number'
  );
}

function compactValidationMeasurements(databasePath: string, snapshotId: string): ExactValidationMeasurements {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const statement = codeGraphCompactLexicalDeepAuditStatement(snapshotId);
    const query = database.query(statement.text);
    const durations: number[] = [];
    let result:
      | {
          readonly expected_posting_count: number;
          readonly expected_symbol_count: number;
          readonly expected_term_count: number;
          readonly posting_count: number;
          readonly symbol_count: number;
          readonly term_count: number;
        }
      | undefined;
    for (let index = 0; index < 5; index += 1) {
      const startedAt = performance.now();
      const observed: unknown = query.get(...statement.parameters);
      if (observed === undefined) {
        result = undefined;
      } else if (isExactValidationMeasurementsRow(observed)) {
        result = observed;
      } else {
        throw ScriptError.make({message: 'Compact lexical deep audit returned an invalid storage receipt.'});
      }
      durations.push(performance.now() - startedAt);
    }
    if (result === undefined)
      throw ScriptError.make({message: 'Compact lexical deep audit did not return a storage receipt.'});
    return {
      actualPostingCount: Number(result.posting_count),
      actualSymbolCount: Number(result.symbol_count),
      actualTermCount: Number(result.term_count),
      expectedPostingCount: Number(result.expected_posting_count),
      expectedSymbolCount: Number(result.expected_symbol_count),
      expectedTermCount: Number(result.expected_term_count),
      firstMilliseconds: durations[0],
      parity:
        Number(result.posting_count) === Number(result.expected_posting_count) &&
        Number(result.symbol_count) === Number(result.expected_symbol_count) &&
        Number(result.term_count) === Number(result.expected_term_count),
      p50Milliseconds: percentile(durations, 0.5),
      samples: durations.length,
    };
  } finally {
    database.close(false);
  }
}

function canonicalEvidence(databasePath: string, snapshotId: string): CanonicalEvidence {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const statement = codeGraphEffectiveSymbolTermsQueryStatement(snapshotId, undefined);
    const rows = database.query(statement.text).iterate(...statement.parameters);
    const digest = new Bun.CryptoHasher('sha256');
    let rowCount = 0;
    for (const row of rows) {
      digest.update(`${JSON.stringify(row)}\n`);
      rowCount += 1;
    }
    return {digest: digest.digest('hex'), rowCount};
  } finally {
    database.close(false);
  }
}

function queryMeasurements(
  databasePath: string,
  snapshotId: string,
  terms: readonly string[],
  iterations: number,
): QueryMeasurements {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const statement = codeGraphTermCandidateQueryStatement(snapshotId, undefined, terms, 400);
    const query = database.query(statement.text);
    query.all(...statement.parameters);
    const durations: number[] = [];
    const digest = new Bun.CryptoHasher('sha256');
    let responseRows = 0;
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      const rows = query.all(...statement.parameters);
      durations.push(performance.now() - startedAt);
      responseRows = rows.length;
      digest.update(`${JSON.stringify(rows)}\n`);
    }
    return {
      digest: digest.digest('hex'),
      p50Milliseconds: percentile(durations, 0.5),
      p95Milliseconds: percentile(durations, 0.95),
      responseRows,
    };
  } finally {
    database.close(false);
  }
}

function checkpointAndVacuum(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('PRAGMA wal_checkpoint(TRUNCATE)');
    database.run('VACUUM');
    database.run('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    database.close(false);
  }
}

function storageMeasurements(databasePath: string): StorageMeasurements {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const pageCount = pragmaInteger(database, 'page_count');
    const pageSize = pragmaInteger(database, 'page_size');
    const freelistCount = pragmaInteger(database, 'freelist_count');
    return {
      allocatedBytes: pageCount * pageSize,
      freelistBytes: freelistCount * pageSize,
      pageCount,
      pageSize,
    };
  } finally {
    database.close(false);
  }
}

function pragmaInteger(database: Database, name: 'freelist_count' | 'page_count' | 'page_size'): number {
  const row = database.query<Record<string, bigint | number> | null, SQLQueryBindings[]>(`PRAGMA ${name}`).get();
  const value = Number(row?.[name] ?? -1);
  if (!Number.isSafeInteger(value) || value < 0)
    throw ScriptError.make({message: `SQLite returned an invalid ${name}.`});
  return value;
}

function sqliteVersion(databasePath: string): string {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query<{readonly version?: string} | null, SQLQueryBindings[]>('SELECT sqlite_version() AS version')
      .get();
    return row?.version ?? 'unknown';
  } finally {
    database.close(false);
  }
}

function lexicalFixture(
  root: string,
  symbolCount: number,
): {
  readonly files: readonly CodeGraphInventoryFile[];
  readonly identity: RepositoryIdentity;
  readonly symbols: readonly CodeGraphSymbol[];
} {
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
    displayName: 'lexical-production-micro',
    gitCommonDirectory: root,
    headCommit: Effect2.pipe('1', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: Effect2.pipe('r', EffectString.repeat(64)),
    worktreeId: Effect2.pipe('w', EffectString.repeat(64)),
  };
  const fileCount = Math.max(1, Math.ceil(symbolCount / 10));
  const files = Array.from({length: fileCount}, (_, index): CodeGraphInventoryFile => {
    const fileIndex = Effect2.pipe(String(index), EffectString.padStart(6, '0'));
    return {
      blobId: Effect2.pipe(index.toString(16), EffectString.padStart(40, '0')),
      contentHash: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
      language: 'typescript',
      mode: '100644',
      path: `packages/module-${index % 64}/src/service-${fileIndex}.ts`,
      size: 1_024,
      source: 'commit',
    };
  });
  const symbols = Array.from({length: symbolCount}, (_, index): CodeGraphSymbol => {
    const padded = Effect2.pipe(String(index), EffectString.padStart(7, '0'));
    const module = index % 64;
    const file = files[Math.floor(index / 10)];
    const name = `renderPipelineService${padded}`;
    const qualifiedName = `packages.module${module}.${name}`;
    return {
      contentHash: `hash-${padded}`,
      documentation: `Render pipeline service for module ${module} with deterministic benchmark routing.`,
      exported: index % 3 !== 0,
      id: `symbol-${padded}`,
      kind: index % 5 === 0 ? 'class' : 'function',
      language: 'typescript',
      lookupKeys: [`typescript:name:${name}`, `typescript:qualified:${qualifiedName}`, `typescript:path:${file.path}`],
      name,
      path: file.path,
      qualifiedName,
      resolutionDomain: 'typescript',
      signature: `export function ${name}(input: RenderRequest): RenderResult`,
      span: {column: 1, endColumn: 80, endLine: 4, line: 1},
    };
  });
  return {files, identity, symbols};
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
}

function chunk<A>(values: readonly A[], size: number): readonly (readonly A[])[] {
  const output: A[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function gitValue(arguments_: readonly string[]): string {
  const result = Bun.spawnSync({cmd: ['git', ...arguments_], stderr: 'ignore', stdout: 'pipe'});
  return result.exitCode === 0 ? Effect2.pipe(new TextDecoder().decode(result.stdout), EffectString.trim) : 'unknown';
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmark, ApplicationLayer));
