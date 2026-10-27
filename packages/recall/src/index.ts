import {Cause, Clock, Context, Effect, FileSystem, Layer, Option, Path, Predicate, Schema} from 'effect';
import {
  recallCodeLinkMatchesResult,
  recallExactMatchesResult,
  recallIndexDataBatchResult,
  recallIndexDataResult,
  recallMemoryLinkMatchesResult,
} from './index/result.js';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {useRecallDatabase, probeRecallDatabase} from './index/database.js';
import {assertResourceAccountCheck, assertOutsideResourceAccountCheck} from '@threadnote/store/resource-store';
import {
  reconcileIdentityProjection,
  selectIdentityProjection,
  RecallIdentityLeaseError,
  RecallIdentityProjectionCorrupt,
} from './index/identity_projection.js';
import {
  initializeRecallSchema,
  RECALL_INDEX_DATABASE_VERSION,
  RecallIndexSchemaIncompatible,
  type RecallMetadataRow,
} from './index/schema.js';
export {withRecallDatabaseSession} from './index/database.js';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {resourceAccountMutationLockPath} from '@threadnote/store/resource/lock';
import {
  isExternalResourceUri,
  loadExternalResourceAccess,
  externalResourceAccess,
} from '@threadnote/store/external-resource';
import {
  readCanonicalMutationGeneration,
  type CanonicalMutationGenerationTransition,
} from '@threadnote/store/resource/mutation_generation';
import {SystemInfo} from '@threadnote/platform/system';
import {errorMessage} from '@threadnote/platform/errors';
import {
  candidatePostings,
  indexTerms,
  postingLexicalScore,
  selectQueryTerms,
  stripRecallAnchor,
} from './index/lexical.js';
import {
  deduplicateLogicalRecallCandidates,
  recallDocumentTerms,
  type RecallCandidate,
  type RecallCorpusStatistics,
} from './rank.js';
import {normalizeRecallSearchText} from './tokenize.js';
import {recallExactSearchText, recallIndexCandidateIsEligible} from './index/candidate.js';
import {removeLegacyRecallIndexArtifacts} from './index/cleanup.js';
import {recallEligibilityPolicyRestrictsCandidates, type RecallEligibilityPolicy} from './eligibility.js';
import {recallCandidateIsValid} from './candidate_validation.js';
import {recallEligibilityPredicate} from './index/eligibility.js';
import {
  boundedRecallPhysicalCandidateLimit,
  RECALL_RECENCY_CANDIDATE_RESERVE,
  RECALL_RECENCY_RETRIEVAL_LIMIT,
  recallStatisticTerms,
} from './index/query.js';
import {deriveIndexedRecallCodeLinks, selectRecallCodeLinks, type RecallCodeLinkQueryOptions} from './code_links.js';
import {
  deriveIndexedRecallMemoryLinks,
  selectRecallMemoryLinks,
  type RecallMemoryLinkQueryOptions,
} from './memory/links.js';
import * as RecallIndexIdentity from './index/identity.js';
import {
  recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh,
  recallIndexForegroundRefreshRequired,
} from './index/freshness.js';
import {
  identityStaleMarkerBasePath,
  clearRecallStaleMarkerInvalidations as clearStaleMarkerInvalidations,
  readRecallStaleMarker as readStaleMarker,
  type RecallStaleMarker,
  writeRecallStaleGeneration as writeStaleGeneration,
} from './index/stale_marker.js';
import {
  combineRecallSqlPredicates,
  recallUriMatchesScopes,
  recallUriScopePredicate,
  recallWorkspaceScopeMatches,
  type RecallWorkspaceScopeMode,
} from './index/scope.js';
import {
  recallProjectMatches,
  recallQuerySelectionIsExhaustive,
  recallSelectionHasDocuments,
  selectRecallDocumentRows,
  selectRecallDocumentRowsByMemoryIds,
  selectRecallDocumentSample,
  selectRecallQueryTermStatistics,
  selectRecallRecentTopicalDocuments,
  selectTopRecallPostingsByTerms,
} from './index/selection.js';
import {
  assembleRecallSourceCandidate,
  loadCanonicalResourcePolicy,
  RecallIndexOperationError,
  recallProjectionObservedChanges,
  countRecallSourceChanges,
  dropRecallSourceScan,
  forEachChangedRecallSourcePage,
  hashRecallRefreshGeneration,
  insertIndexedRecallSources,
  RECALL_REFRESH_AFFECTED_TERM_TABLE,
  RECALL_REFRESH_INDEXED_CODE_LINK_TABLE,
  RECALL_REFRESH_INDEXED_DOCUMENT_TABLE,
  RECALL_REFRESH_INDEXED_MEMORY_LINK_TABLE,
  RECALL_REFRESH_INDEXED_POSTING_TABLE,
  RECALL_REFRESH_REPLACED_DOCUMENT_TABLE,
  RECALL_REFRESH_SOURCE_TABLE,
  scanRecallSources,
  stageRecallRefreshAffectedTerms,
  type IndexedRecallSource,
} from './index/refresh.js';

export {recallUriMatchesScopes} from './index/scope.js';

interface RecallIndexConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

export interface RecallIndexData {
  readonly candidates: readonly RecallCandidate[];
  readonly corpusStatistics: RecallCorpusStatistics;
  readonly generation: string;
  /** True only when the query selection proves that no matching candidate was truncated. */
  readonly queryExhaustive: boolean;
  /** Independent canonical-timestamp lane; callers must still apply normal topical ranking. */
  readonly recentCandidates?: readonly RecallCandidate[];
}

export interface RecallExactMatch {
  readonly terms: readonly string[];
  readonly uri: string;
}

export interface RecallIndexStatus {
  readonly databasePath?: string;
  readonly documentCount: number;
  readonly generation?: string;
  readonly ready: boolean;
  readonly reason?: string;
  readonly skippedOversizedDocumentCount?: number;
}

export type RecallIndexProgress =
  | {
      readonly completed: number;
      readonly phase: 'indexing';
      readonly scanned: number;
      readonly total: number;
    }
  | {
      readonly completed: number;
      readonly phase: 'writing';
      readonly removed: number;
      readonly total: number;
    }
  | {
      readonly documentCount: number;
      readonly phase: 'activating';
    };

export interface RecallIndexQueryDiagnostics {
  readonly postingRows: number;
  readonly postingStatements: number;
  readonly queryTerms: number;
}

interface RecallDocumentRow {
  readonly candidate_json: string;
  readonly id: number;
  readonly uri: string;
}

interface RecallTermStatisticRow {
  readonly document_frequency: number;
  readonly term: string;
}

const RECALL_INDEX_POINTER_VERSION = 1;
const ACTIVE_DATABASE_FILENAME = `active-v${RECALL_INDEX_DATABASE_VERSION}.sqlite`;
const INACTIVE_DATABASE_FILENAME = `with-inactive-v${RECALL_INDEX_DATABASE_VERSION}.sqlite`;
const DEFAULT_QUERY_RESULT_LIMIT = 100;
const QUERY_POSTING_POOL_MULTIPLIER = 5;
const MINIMUM_QUERY_POSTING_POOL = 500;
let staleGenerationCounter = 0;

interface RecallIndexPointer {
  readonly database: string;
  readonly version: typeof RECALL_INDEX_POINTER_VERSION;
}

class RecallIndexCorrupt extends Schema.TaggedError<RecallIndexCorrupt>()('RecallIndexCorrupt', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

interface LoadRecallIndexOptions {
  readonly allowedUriScopes?: readonly string[];
  readonly eligibility?: RecallEligibilityPolicy;
  readonly forceRefresh?: boolean;
  readonly includeInactive: boolean;
  readonly limit?: number;
  readonly memoryIds?: readonly string[];
  readonly onQueryDiagnostics?: (diagnostics: RecallIndexQueryDiagnostics) => Effect.Effect<void, unknown>;
  readonly onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>;
  readonly project?: string;
  readonly query?: string;
  /** Enabled only from explicit recency wording in the original user query. */
  readonly recencyIntent?: boolean;
  readonly requiredUris?: readonly string[];
  /** Bypass the short freshness cache, but reindex only sources whose live metadata changed. */
  readonly validateNow?: boolean;
  readonly workspaceScope?: string;
  /** Select the protected hierarchy by default, or only scopes outside it for the bounded challenger lane. */
  readonly workspaceScopeMode?: RecallWorkspaceScopeMode;
}

interface LoadRecallIndexBatchOptions {
  readonly forceRefresh?: boolean;
  readonly includeInactive: boolean;
  readonly onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>;
  readonly selections: readonly Omit<LoadRecallIndexOptions, 'forceRefresh' | 'includeInactive' | 'validateNow'>[];
}

interface LoadRecallExactMatchesOptions {
  readonly eligibility?: RecallEligibilityPolicy;
  readonly forceRefresh?: boolean;
  readonly includeInactive: boolean;
  readonly limitPerTerm?: number;
  readonly onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>;
  readonly terms: readonly string[];
  readonly uriScopes: readonly string[];
}

export interface LoadRecallCodeLinksOptions extends RecallCodeLinkQueryOptions {
  readonly forceRefresh?: boolean;
  readonly includeInactive: boolean;
  readonly onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>;
}

export interface LoadRecallMemoryLinksOptions extends RecallMemoryLinkQueryOptions {
  readonly forceRefresh?: boolean;
  readonly includeInactive: boolean;
  readonly onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>;
  /** @internal Reports the single forced-refresh repair initiated by this load. */
  readonly onRefreshRepair?: () => void;
}

const loadRecallIndexDataInternal = Effect.fn('recall.loadIndexDataInternal')(function* (
  config: RecallIndexConfig,
  options:
    | LoadRecallCodeLinksOptions
    | LoadRecallMemoryLinksOptions
    | LoadRecallIndexOptions
    | LoadRecallIndexBatchOptions
    | LoadRecallExactMatchesOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const fixedDatabasePath = recallIndexDatabasePath(pathService, config.agentContextHome, options.includeInactive);
  yield* fs.makeDirectory(pathService.dirname(fixedDatabasePath), {recursive: true, mode: 0o700});
  const databasePath = yield* resolveActiveRecallDatabasePath(
    fs,
    pathService,
    config.agentContextHome,
    options.includeInactive,
  );
  return yield* executeRecallIndexQuery(databasePath, fixedDatabasePath, config, options).pipe(
    Effect.catchCauseIf(isRecoverableRecallIndexCause, firstCause =>
      recoverRecallIndex(fs, pathService, databasePath, fixedDatabasePath, config, options, firstCause),
    ),
  );
});

const executeRecallIndexQuery = Effect.fn('recall.executeIndexQuery')(function* (
  databasePath: string,
  staleMarkerBasePath: string,
  config: RecallIndexConfig,
  options:
    | LoadRecallCodeLinksOptions
    | LoadRecallMemoryLinksOptions
    | LoadRecallIndexOptions
    | LoadRecallIndexBatchOptions
    | LoadRecallExactMatchesOptions,
  prepareForActivation = false,
  indexLockHeld = false,
) {
  return yield* useRecallDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      yield* initializeRecallDatabase(sql, fs, pathService, config, options.includeInactive, indexLockHeld);
      yield* fs.chmod(databasePath, 0o600);
      yield* ensureRecallDatabaseFresh(
        sql,
        fs,
        pathService,
        databasePath,
        staleMarkerBasePath,
        config,
        {
          forceRefresh: options.forceRefresh,
          includeInactive: options.includeInactive,
          onProgress: options.onProgress,
          validateNow: 'validateNow' in options ? options.validateNow : undefined,
        },
        indexLockHeld,
      );
      const externalResources = yield* loadExternalResourceAccess({
        home: config.agentContextHome,
        account: config.account,
        user: config.user,
      });
      const accessEligibility = (policy: RecallEligibilityPolicy | undefined): RecallEligibilityPolicy => ({
        ...(policy ?? {kind: 'candidate-policy', authority: 'any', projects: {mode: 'unrestricted'}}),
        externalResources,
      });
      const effectiveOptions =
        'selections' in options
          ? {
              ...options,
              selections: options.selections.map(selection => ({
                ...selection,
                eligibility: accessEligibility(selection.eligibility),
              })),
            }
          : {...options, eligibility: accessEligibility(options.eligibility)};
      const result = yield* 'anchors' in effectiveOptions
        ? selectRecallCodeLinks(sql, effectiveOptions)
        : 'memorySeeds' in effectiveOptions
          ? selectRecallMemoryLinks(sql, effectiveOptions)
          : Effect.gen(function* () {
              const metadata = yield* loadRecallMetadata(sql);
              const generation = metadata.get('content_generation') ?? '';
              const corpusStatistics = yield* loadRecallCorpusStatistics(sql, recallStatisticTerms(effectiveOptions));
              const loadIdentityConflicts = RecallIndexIdentity.createRecallIdentityConflictLoader(sql);
              const selectData = (selection: LoadRecallIndexOptions) =>
                selectRecallIndexData(
                  sql,
                  corpusStatistics,
                  generation,
                  selection,
                  loadIdentityConflicts,
                  metadata.has('document_count') ? Number(metadata.get('document_count')) : undefined,
                );
              return 'terms' in effectiveOptions
                ? yield* selectRecallExactMatches(sql, effectiveOptions)
                : 'selections' in effectiveOptions
                  ? yield* Effect.forEach(
                      effectiveOptions.selections,
                      selection => selectData({...selection, includeInactive: effectiveOptions.includeInactive}),
                      {concurrency: 1},
                    )
                  : yield* selectData(effectiveOptions);
            });
      const finalResult = yield* filterExternalRecallResult(result, config, externalResources);
      if (prepareForActivation) {
        yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
        yield* sql.unsafe('PRAGMA journal_mode = DELETE');
      }
      return finalResult;
    }),
    !prepareForActivation,
  );
});

const recoverRecallIndex = Effect.fn('recall.recoverIndex')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  failedDatabasePath: string,
  staleMarkerBasePath: string,
  config: RecallIndexConfig,
  options:
    | LoadRecallCodeLinksOptions
    | LoadRecallMemoryLinksOptions
    | LoadRecallIndexOptions
    | LoadRecallIndexBatchOptions
    | LoadRecallExactMatchesOptions,
  firstCause: Cause.Cause<unknown>,
) {
  return yield* withRecallIndexLock(fs, path, config.agentContextHome, options.includeInactive, () =>
    Effect.gen(function* () {
      const activePath = yield* resolveActiveRecallDatabasePath(
        fs,
        path,
        config.agentContextHome,
        options.includeInactive,
      );
      if (activePath !== failedDatabasePath) {
        return yield* executeRecallIndexQuery(activePath, staleMarkerBasePath, config, options, false, true);
      }
      const system = yield* SystemInfo;
      const generation = `${yield* Clock.currentTimeMillis}-${system.processId}-${nextRecallGenerationCounter()}`;
      const root = recallIndexRoot(path, config.agentContextHome);
      const relativeDatabasePath = path.join(
        'generations',
        `${options.includeInactive ? 'with-inactive' : 'active'}-${generation}.sqlite`,
      );
      const replacementPath = path.join(root, relativeDatabasePath);
      yield* fs.makeDirectory(path.dirname(replacementPath), {recursive: true, mode: 0o700});
      const replacementOptions = {...options, forceRefresh: true};
      const rebuilt = yield* executeRecallIndexQuery(
        replacementPath,
        staleMarkerBasePath,
        config,
        replacementOptions,
        true,
        true,
      ).pipe(
        Effect.catchCause(secondCause =>
          Effect.fail(
            RecallIndexOperationError.make({
              message: `Lexical recall index recovery failed: ${Cause.pretty(firstCause)}; replacement failed: ${Cause.pretty(secondCause)}`,
            }),
          ),
        ),
        Effect.ensuring(removeRecallDatabaseAuxiliaryFiles(fs, replacementPath).pipe(Effect.ignore)),
      );
      yield* writeActiveRecallDatabasePointer(
        fs,
        path,
        config.agentContextHome,
        options.includeInactive,
        relativeDatabasePath,
      );
      return rebuilt;
    }),
  );
});

export const loadRecallIndexData = Effect.fn('recall.loadIndexData')(function* (
  config: RecallIndexConfig,
  options: LoadRecallIndexOptions,
) {
  return recallIndexDataResult(yield* loadRecallIndexDataInternal(config, options));
});

export const loadRecallIndexDataBatch = Effect.fn('recall.loadIndexDataBatch')(function* (
  config: RecallIndexConfig,
  options: LoadRecallIndexBatchOptions,
) {
  return recallIndexDataBatchResult(yield* loadRecallIndexDataInternal(config, options));
});

export const loadRecallIndex = Effect.fn('recall.loadIndex')(function* (
  config: RecallIndexConfig,
  options: LoadRecallIndexOptions,
) {
  return (yield* loadRecallIndexData(config, options)).candidates;
});

type IdentityLease = {
  readonly owner: number;
  readonly home: string;
  readonly account: string;
  readonly path: string;
  readonly pointerPath: string;
  readonly pointer: string | undefined;
  readonly identity: NonNullable<Effect.Success<ReturnType<typeof probeRecallDatabase>>>;
  readonly sql: SqlClient.SqlClient;
  active: boolean;
  busy: boolean;
};
const CurrentIdentityLease = Context.Reference<IdentityLease | undefined>('threadnote/RecallIdentityClientLease', {
  defaultValue: () => undefined,
});
const hasRecallIdentityClientLease = Effect.map(CurrentIdentityLease, lease => lease !== undefined);
const assertOutsideRecallIdentityClientLease = Effect.gen(function* () {
  if (yield* hasRecallIdentityClientLease)
    return yield* RecallIdentityLeaseError.make({message: 'Identity client lease cannot be reacquired.'});
  yield* assertOutsideResourceAccountCheck;
});

/** Called inside the real index lock, after schema/pointer admission and before store account acquisition. */
function withRecallIdentityClientLease<A, E, R>(
  path: string,
  home: string,
  account: string,
  program: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    yield* assertOutsideRecallIdentityClientLease;
    const sql = yield* SqlClient.SqlClient;
    const current = yield* probeRecallDatabase(path, true);
    if (current === undefined)
      return yield* RecallIdentityLeaseError.make({message: 'Identity database cannot establish a live client lease.'});
    const fs = yield* FileSystem.FileSystem;
    const pointerPath = recallIndexPointerPath(yield* Path.Path, home, false);
    const pointer = yield* readIdentityLeasePointer(fs, pointerPath);
    return yield* Effect.acquireUseRelease(
      Effect.map(Effect.fiberId, (owner): IdentityLease => ({
        owner,
        home,
        account,
        path,
        pointerPath,
        pointer,
        sql,
        identity: current,
        active: true,
        busy: false,
      })),
      lease => program.pipe(Effect.provideService(CurrentIdentityLease, lease)),
      lease =>
        Effect.sync(() => {
          lease.active = false;
        }),
    );
  });
}

const readIdentityLeasePointer = (fs: FileSystem.FileSystem, path: string) =>
  Effect.gen(function* () {
    return (yield* fs.exists(path)) ? yield* fs.readFileString(path) : undefined;
  });

/** No recovery or lock acquisition is possible through this borrow; stale/inherited/reentrant scopes fail. */
function borrowRecallIdentityClient<A, E, R>(
  home: string,
  account: string,
  query: (sql: SqlClient.SqlClient, path: string) => Effect.Effect<A, E, R>,
) {
  return Effect.withFiber(fiber =>
    Effect.gen(function* () {
      const lease = Context.get(fiber.context, CurrentIdentityLease);
      if (!lease?.active || lease.busy || lease.owner !== fiber.id || lease.home !== home || lease.account !== account)
        return yield* RecallIdentityLeaseError.make({
          message: 'Identity query requires a matching active same-fiber index/client lease.',
        });
      yield* assertResourceAccountCheck(home, account);
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          lease.busy = true;
        }),
        () =>
          Effect.gen(function* () {
            const current = yield* probeRecallDatabase(lease.path, true);
            if (current?.files !== lease.identity.files)
              return yield* RecallIdentityLeaseError.make({message: 'Identity database changed inside CHECK.'});
            const fs = yield* FileSystem.FileSystem;
            if ((yield* readIdentityLeasePointer(fs, lease.pointerPath)) !== lease.pointer)
              return yield* RecallIdentityLeaseError.make({message: 'Identity database pointer changed inside CHECK.'});
            const result = yield* query(lease.sql, lease.path);
            if (
              (yield* probeRecallDatabase(lease.path, true))?.files !== lease.identity.files ||
              (yield* readIdentityLeasePointer(fs, lease.pointerPath)) !== lease.pointer
            )
              return yield* RecallIdentityLeaseError.make({
                message: 'Identity database changed before CHECK completed.',
              });
            return result;
          }),
        () =>
          Effect.sync(() => {
            lease.busy = false;
          }),
      );
    }),
  );
}

/** Internal algorithm choice, never caller-supplied ownership or public workflow payload. */
export type MemoryIdentityEngine = 'lexical' | 'identity-projection';

/** Targets/evidence are prepared by the caller before admission; the real store takes account ownership next. */
export function withRecallIdentityProjectionLease<A, E, R>(config: RecallIndexConfig, program: Effect.Effect<A, E, R>) {
  return withIdentityProjectionLease(config, program);
}

function withIdentityProjectionLease<A, E, R>(
  config: RecallIndexConfig,
  program: Effect.Effect<A, E, R>,
  replaceDatabase?: string,
) {
  return Effect.gen(function* () {
    yield* assertOutsideRecallIdentityClientLease;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixed = recallIndexDatabasePath(path, config.agentContextHome, false);
    yield* fs.makeDirectory(path.dirname(fixed), {recursive: true, mode: 0o700});
    return yield* withRecallIndexLock(fs, path, config.agentContextHome, false, () =>
      Effect.gen(function* () {
        const active = yield* resolveActiveRecallDatabasePath(fs, path, config.agentContextHome, false);
        let admitted = false;
        const run = (database: string) =>
          useRecallDatabase(
            database,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* initializeRecallDatabase(sql, fs, path, config, false, true);
              yield* fs.chmod(database, 0o600);
              admitted = true;
              return yield* withRecallIdentityClientLease(database, config.agentContextHome, config.account, program);
            }),
          );
        const replace = Effect.gen(function* () {
          const system = yield* SystemInfo;
          const relative = path.join(
            'generations',
            `active-${yield* Clock.currentTimeMillis}-${system.processId}-${nextRecallGenerationCounter()}.sqlite`,
          );
          const replacement = path.join(recallIndexRoot(path, config.agentContextHome), relative);
          yield* fs.makeDirectory(path.dirname(replacement), {recursive: true, mode: 0o700});
          // Complete recovery and close the replacement before publishing it; no source reconciliation is admitted here.
          yield* useRecallDatabase(
            replacement,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* initializeRecallDatabase(sql, fs, path, config, false, true);
              yield* fs.chmod(replacement, 0o600);
              yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
              yield* sql.unsafe('PRAGMA journal_mode = DELETE');
            }),
            false,
          ).pipe(Effect.ensuring(removeRecallDatabaseAuxiliaryFiles(fs, replacement).pipe(Effect.ignore)));
          yield* writeActiveRecallDatabasePointer(fs, path, config.agentContextHome, false, relative);
          return yield* run(replacement);
        });
        if (replaceDatabase === active) return yield* replace;
        return yield* run(active).pipe(
          Effect.catchCauseIf(
            cause => !admitted && isRecoverableRecallIndexCause(cause),
            () => replace,
          ),
        );
      }),
    );
  });
}

const loadIdentityProjection = Effect.fn('recall.loadIdentityProjection')(function* (
  config: RecallIndexConfig,
  options: {readonly allowedUriScopes: readonly string[]; readonly memoryIds: readonly string[]},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const marker = identityStaleMarkerBasePath(recallIndexDatabasePath(path, config.agentContextHome, false));
  const query = (sql: SqlClient.SqlClient, checked: boolean) =>
    Effect.gen(function* () {
      yield* reconcileIdentityProjection(sql, fs, path, marker, config, checked);
      return yield* selectIdentityProjection(sql, config, options);
    });
  if (yield* hasRecallIdentityClientLease)
    return yield* borrowRecallIdentityClient(config.agentContextHome, config.account, (sql, database) =>
      Effect.gen(function* () {
        const active = yield* resolveActiveRecallDatabasePath(fs, path, config.agentContextHome, false);
        if (active !== database)
          return yield* RecallIdentityLeaseError.make({message: 'Identity database pointer changed inside CHECK.'});
        const metadata = yield* loadRecallMetadata(sql);
        if (metadata.get('schema_version') !== String(RECALL_INDEX_DATABASE_VERSION))
          return yield* RecallIdentityLeaseError.make({message: 'Identity database schema changed inside CHECK.'});
        return yield* query(sql, true);
      }),
    );
  // Ordinary identity reads use index -> account. The lease is borrowed exclusively by real CHECK queries.
  let failedDatabase: string | undefined;
  const read = withCanonicalResourceMutationLock(
    fs,
    path,
    config.agentContextHome,
    config.account,
    Effect.gen(function* () {
      failedDatabase = (yield* CurrentIdentityLease)?.path;
      return yield* query(yield* SqlClient.SqlClient, false);
    }),
  );
  // Recovery belongs only to this read-only entry, after both leases unwind. Never replay an arbitrary write program.
  return yield* withIdentityProjectionLease(config, read).pipe(
    Effect.catchCauseIf(
      cause => Schema.is(RecallIdentityProjectionCorrupt)(Cause.squash(cause)) || isRecoverableRecallIndexCause(cause),
      () => withIdentityProjectionLease(config, read, failedDatabase),
    ),
  );
});

export const loadRecallMemoryIdentities = Effect.fn('recall.loadMemoryIdentities')(function* (
  config: RecallIndexConfig,
  options: {
    readonly allowedUriScopes: readonly string[];
    readonly memoryIds: readonly string[];
    readonly validateNow?: boolean;
    readonly engine?: MemoryIdentityEngine;
  },
) {
  if (options.engine === 'identity-projection') return yield* loadIdentityProjection(config, options);
  const data = yield* loadRecallIndexData(config, {
    allowedUriScopes: options.allowedUriScopes,
    includeInactive: false,
    memoryIds: options.memoryIds,
    validateNow: options.validateNow,
  });
  return data.candidates;
});

export const loadRecallExactMatches = Effect.fn('recall.loadExactMatches')(function* (
  config: RecallIndexConfig,
  options: LoadRecallExactMatchesOptions,
) {
  return recallExactMatchesResult(yield* loadRecallIndexDataInternal(config, options));
});

export const loadRecallCodeLinks = Effect.fn('recall.loadCodeLinks')(function* (
  config: RecallIndexConfig,
  options: LoadRecallCodeLinksOptions,
) {
  let canonicalMismatchCount = 0;
  let truncatedSelectorCount = 0;
  const first = recallCodeLinkMatchesResult(
    yield* loadRecallIndexDataInternal(config, {
      ...options,
      onCanonicalMismatch: (count: number) => {
        canonicalMismatchCount += count;
        options.onCanonicalMismatch?.(count);
      },
      onSearchTruncated: (count: number) => {
        truncatedSelectorCount += count;
      },
    }),
  );
  if (options.forceRefresh === true || canonicalMismatchCount === 0) {
    if (truncatedSelectorCount > 0) options.onSearchTruncated?.(truncatedSelectorCount);
    return first;
  }
  let refreshedTruncatedSelectorCount = 0;
  const refreshed = recallCodeLinkMatchesResult(
    yield* loadRecallIndexDataInternal(config, {
      ...options,
      forceRefresh: true,
      onSearchTruncated: (count: number) => {
        refreshedTruncatedSelectorCount += count;
      },
    }),
  );
  if (refreshedTruncatedSelectorCount > 0) options.onSearchTruncated?.(refreshedTruncatedSelectorCount);
  return refreshed;
});

export const loadRecallMemoryLinks = Effect.fn('recall.loadMemoryLinks')(function* (
  config: RecallIndexConfig,
  options: LoadRecallMemoryLinksOptions,
) {
  let canonicalMismatchCount = 0;
  let truncatedSeedOrdinals: readonly number[] = [];
  const first = recallMemoryLinkMatchesResult(
    yield* loadRecallIndexDataInternal(config, {
      ...options,
      onCanonicalMismatch: (count: number) => {
        canonicalMismatchCount += count;
        options.onCanonicalMismatch?.(count);
      },
      onSearchTruncated: (ordinals: readonly number[]) => {
        truncatedSeedOrdinals = [...new Set([...truncatedSeedOrdinals, ...ordinals])].sort((a, b) => a - b);
      },
    }),
  );
  if (options.forceRefresh === true || canonicalMismatchCount === 0) {
    if (truncatedSeedOrdinals.length > 0) options.onSearchTruncated?.(truncatedSeedOrdinals);
    return first;
  }
  options.onRefreshRepair?.();
  let refreshedTruncatedSeedOrdinals: readonly number[] = [];
  const refreshed = recallMemoryLinkMatchesResult(
    yield* loadRecallIndexDataInternal(config, {
      ...options,
      forceRefresh: true,
      onSearchTruncated: (ordinals: readonly number[]) => {
        refreshedTruncatedSeedOrdinals = [...new Set([...refreshedTruncatedSeedOrdinals, ...ordinals])].sort(
          (a, b) => a - b,
        );
      },
    }),
  );
  if (refreshedTruncatedSeedOrdinals.length > 0) {
    options.onSearchTruncated?.(refreshedTruncatedSeedOrdinals);
  }
  return refreshed;
});

export const recallIndexStatus = Effect.fn('recall.indexStatus')(function* (
  config: RecallIndexConfig,
  includeInactive = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixedDatabasePath = recallIndexDatabasePath(path, config.agentContextHome, includeInactive);
  const databasePath = yield* resolveActiveRecallDatabasePath(fs, path, config.agentContextHome, includeInactive);
  if (!(yield* fs.exists(databasePath))) {
    return {
      databasePath,
      documentCount: 0,
      ready: false,
      reason: 'not built; run `threadnote repair`',
    } satisfies RecallIndexStatus;
  }
  return yield* useRecallDatabaseReadOnly(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const metadata = yield* loadRecallMetadata(sql);
      if (metadata.get('schema_version') !== String(RECALL_INDEX_DATABASE_VERSION)) {
        return {
          databasePath,
          documentCount: 0,
          ready: false,
          reason: `unsupported schema ${metadata.get('schema_version') ?? 'unknown'}; run \`threadnote repair\``,
        } satisfies RecallIndexStatus;
      }
      if (metadata.get('initialized') !== 'true') {
        const untouched = yield* RecallIndexIdentity.recallLexicalProjectionIsUntouched(sql, metadata);
        return {
          databasePath,
          documentCount: 0,
          ready: false,
          reason: untouched ? 'not built; run `threadnote repair`' : 'not initialized; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      if (!RecallIndexIdentity.recallIndexMetadataIsCurrent(metadata)) {
        return {
          databasePath,
          documentCount: numericMetadata(metadata, 'document_count'),
          ready: false,
          reason: 'integrity sequence mismatch; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      const canonicalMutationGeneration = yield* readCanonicalMutationGeneration(
        fs,
        path,
        config.agentContextHome,
        config.account,
      );
      if ((metadata.get('canonical_mutation_generation') ?? '') !== canonicalMutationGeneration) {
        return {
          databasePath,
          documentCount: numericMetadata(metadata, 'document_count'),
          generation: metadata.get('content_generation'),
          ready: false,
          reason: 'canonical documents changed; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      const staleMarker = yield* readStaleMarker(fs, fixedDatabasePath);
      if (metadata.get('stale_generation') !== (staleMarker?.generation ?? '')) {
        return {
          databasePath,
          documentCount: numericMetadata(metadata, 'document_count'),
          generation: metadata.get('content_generation'),
          ready: false,
          reason: 'canonical documents changed; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      const rows = yield* sql<{readonly document_count: number}>`SELECT COUNT(*) AS document_count FROM documents`;
      const documentCount = Number(rows[0]?.document_count ?? 0);
      if (!Number.isSafeInteger(documentCount) || documentCount < 0) {
        return {
          databasePath,
          documentCount: 0,
          ready: false,
          reason: 'invalid document count; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      if (numericMetadata(metadata, 'document_count') !== documentCount) {
        return {
          databasePath,
          documentCount,
          ready: false,
          reason: 'document count metadata mismatch; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      const generation = metadata.get('content_generation');
      if (!generation) {
        return {
          databasePath,
          documentCount,
          ready: false,
          reason: 'missing content generation; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      if (metadata.get('source_validation_required') === 'true') {
        return {
          databasePath,
          documentCount,
          generation,
          ready: false,
          reason: 'canonical documents changed; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      return {
        databasePath,
        documentCount,
        generation,
        ready: true,
        skippedOversizedDocumentCount: numericMetadata(metadata, 'oversized_document_count'),
      } satisfies RecallIndexStatus;
    }),
  ).pipe(
    Effect.catch(cause =>
      Effect.succeed({
        databasePath,
        documentCount: 0,
        ready: false,
        reason: `unreadable: ${errorMessage(cause)}; run \`threadnote repair\``,
      } satisfies RecallIndexStatus),
    ),
  );
});

export const currentRecallCorpusGeneration = Effect.fn('recall.currentCorpusGeneration')(function* (
  config: RecallIndexConfig,
) {
  const status = yield* recallIndexStatus(config, false);
  return status.ready ? Option.fromUndefinedOr(status.generation) : Option.none<string>();
});

export const clearRecallIndexMemoryCache = Effect.fn('recall.clearMemoryCache')(function* () {
  // SQLite owns its page cache and every operation uses a scoped connection.
  yield* Effect.void;
});

export const expireRecallIndexValidation = Effect.fn('recall.expireValidation')(function* (
  agentContextHome: string,
  includeInactive: boolean,
  invalidatedUris?: readonly string[],
  canonicalMutationGeneration?: CanonicalMutationGenerationTransition,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const databasePath = recallIndexDatabasePath(pathService, agentContextHome, includeInactive);
  yield* fs.makeDirectory(pathService.dirname(databasePath), {recursive: true, mode: 0o700});
  yield* writeStaleGeneration(fs, databasePath, invalidatedUris, canonicalMutationGeneration);
  yield* writeStaleGeneration(
    fs,
    identityStaleMarkerBasePath(databasePath),
    invalidatedUris,
    canonicalMutationGeneration,
  );
});

const selectRecallIndexData = Effect.fn('recall.selectIndexData')(function* (
  sql: SqlClient.SqlClient,
  corpusStatistics: RecallCorpusStatistics,
  generation: string,
  options: LoadRecallIndexOptions,
  loadIdentityConflicts: ReturnType<typeof RecallIndexIdentity.createRecallIdentityConflictLoader>,
  physicalDocumentCount?: number,
) {
  if (options.query === undefined) {
    const rows =
      options.memoryIds !== undefined
        ? yield* selectRecallDocumentRowsByMemoryIds(
            sql,
            [...new Set(options.memoryIds)].sort(),
            options.allowedUriScopes,
            options.eligibility,
          )
        : options.allowedUriScopes?.length ||
            recallEligibilityPolicyRestrictsCandidates(options.eligibility) ||
            options.limit !== undefined ||
            options.project !== undefined ||
            options.workspaceScope !== undefined
          ? yield* selectRecallDocumentSample(sql, options)
          : yield* sql<RecallDocumentRow>`SELECT id, uri, candidate_json FROM documents ORDER BY uri`;
    const logicalCandidates = deduplicateLogicalRecallCandidates(
      rows.map(decodeCandidateRow).filter(candidate => recallIndexCandidateIsEligible(options.eligibility, candidate)),
    );
    const candidates = options.limit === undefined ? logicalCandidates : logicalCandidates.slice(0, options.limit);
    const identityConflicts = yield* loadIdentityConflicts(
      options.allowedUriScopes,
      options.eligibility,
      candidates.flatMap(candidate => (candidate.memoryId ? [candidate.memoryId] : [])),
    );
    return {
      candidates: RecallIndexIdentity.markRecallIdentityConflicts(candidates, identityConflicts),
      corpusStatistics,
      generation,
      queryExhaustive: options.memoryIds !== undefined || options.limit === undefined,
    } satisfies RecallIndexData;
  }
  const selected: RecallCandidate[] = [];
  const selectedIds = new Set<number>();
  const requiredUris = [...new Set((options.requiredUris ?? []).map(stripRecallAnchor))];
  if (requiredUris.length > 0) {
    const requiredRows = yield* selectRecallDocumentRows(sql, 'uri', requiredUris);
    const rowByUri = new Map(requiredRows.map(row => [row.uri, row]));
    for (const uri of requiredUris) {
      const row = rowByUri.get(uri);
      if (!row || selectedIds.has(row.id) || !recallUriMatchesScopes(row.uri, options.allowedUriScopes)) continue;
      const candidate = decodeCandidateRow(row);
      if (
        recallIndexCandidateIsEligible(options.eligibility, candidate) &&
        recallProjectMatches(options.project, candidate.fields?.project) &&
        recallWorkspaceScopeMatches(
          options.workspaceScope,
          candidate.fields?.workspaceScope,
          options.workspaceScopeMode,
        )
      ) {
        selectedIds.add(row.id);
        selected.push(candidate);
      }
    }
  }
  const resultLimit = options.limit ?? DEFAULT_QUERY_RESULT_LIMIT;
  const postingPoolLimit = Math.max(MINIMUM_QUERY_POSTING_POOL, resultLimit * QUERY_POSTING_POOL_MULTIPLIER);
  const indexedQueryTerms = [...new Set(indexTerms(options.query))];
  const siblingWorkspaceSelection = options.workspaceScopeMode === 'sibling' && options.workspaceScope !== undefined;
  if (siblingWorkspaceSelection && !(yield* recallSelectionHasDocuments(sql, options))) {
    return {
      candidates: [],
      corpusStatistics,
      generation,
      queryExhaustive: true,
    } satisfies RecallIndexData;
  }
  const queryCorpusStatistics = siblingWorkspaceSelection
    ? corpusStatistics
    : yield* selectRecallQueryTermStatistics(sql, indexedQueryTerms, corpusStatistics, options);
  const queryTerms = selectQueryTerms(indexedQueryTerms, queryCorpusStatistics);
  const recentRows = options.recencyIntent
    ? yield* selectRecallRecentTopicalDocuments(sql, queryTerms, {
        ...options,
        limit: RECALL_RECENCY_RETRIEVAL_LIMIT,
        minimumLogicalCandidates: RECALL_RECENCY_CANDIDATE_RESERVE,
      })
    : [];
  const postingCorpusStatistics =
    options.workspaceScope === undefined &&
    options.project === undefined &&
    !recallEligibilityPolicyRestrictsCandidates(options.eligibility)
      ? corpusStatistics
      : siblingWorkspaceSelection
        ? corpusStatistics
        : queryCorpusStatistics;
  const postingRows = yield* selectTopRecallPostingsByTerms(
    sql,
    queryTerms,
    options.allowedUriScopes,
    options.eligibility,
    options.project,
    options.workspaceScope,
    options.workspaceScopeMode,
    postingPoolLimit,
    postingCorpusStatistics,
    physicalDocumentCount === undefined ? undefined : {...corpusStatistics, physicalDocumentCount},
  );
  yield* options.onQueryDiagnostics?.({
    postingRows: postingRows.length,
    postingStatements: queryTerms.length === 0 ? 0 : 1,
    queryTerms: queryTerms.length,
  }) ?? Effect.void;
  const scores = new Map<number, number>();
  for (const posting of postingRows) {
    const score = postingLexicalScore(
      {
        documentLength: posting.document_length,
        fieldWeight: posting.field_weight,
        termFrequency: posting.term_frequency,
      },
      posting.term,
      postingCorpusStatistics,
    );
    scores.set(posting.document_id, (scores.get(posting.document_id) ?? 0) + score);
  }
  const uriByDocumentId = new Map(postingRows.map(posting => [posting.document_id, posting.uri]));
  const rankedIds = [...scores]
    .sort(
      ([leftId, leftScore], [rightId, rightScore]) =>
        rightScore - leftScore || (uriByDocumentId.get(leftId) ?? '').localeCompare(uriByDocumentId.get(rightId) ?? ''),
    )
    .map(([documentId]) => documentId);
  const candidateDecodeLimit = boundedRecallPhysicalCandidateLimit(resultLimit);
  const boundedRankedIds = rankedIds.slice(0, candidateDecodeLimit);
  const rankedRows = yield* selectRecallDocumentRows(sql, 'id', boundedRankedIds);
  const rowById = new Map(rankedRows.map(row => [row.id, row]));
  for (const documentId of boundedRankedIds) {
    const row = rowById.get(documentId);
    if (row && !selectedIds.has(documentId)) {
      selectedIds.add(documentId);
      const candidate = decodeCandidateRow(row);
      if (recallIndexCandidateIsEligible(options.eligibility, candidate)) {
        selected.push(candidate);
      }
    }
  }
  const deduplicated = deduplicateLogicalRecallCandidates(selected);
  const requiredUriSet = new Set(requiredUris);
  const requiredCandidates = deduplicated.filter(candidate =>
    [candidate.uri, ...(candidate.equivalentUris ?? [])].some(uri => requiredUriSet.has(stripRecallAnchor(uri))),
  );
  const rankedCandidates = deduplicated
    .filter(candidate => !requiredCandidates.includes(candidate))
    .slice(0, resultLimit);
  const candidates = [...requiredCandidates, ...rankedCandidates];
  const recentCandidates = deduplicateLogicalRecallCandidates(recentRows.map(decodeCandidateRow)).filter(
    candidate =>
      recallUriMatchesScopes(candidate.uri, options.allowedUriScopes) &&
      recallIndexCandidateIsEligible(options.eligibility, candidate) &&
      recallProjectMatches(options.project, candidate.fields?.project) &&
      recallWorkspaceScopeMatches(options.workspaceScope, candidate.fields?.workspaceScope, options.workspaceScopeMode),
  );
  const queryExhaustive = recallQuerySelectionIsExhaustive({
    candidateDecodeLimit,
    deduplicatedCandidateCount: deduplicated.length,
    documentFrequency: queryCorpusStatistics.documentFrequency,
    indexedQueryTerms,
    postingPoolLimit,
    postingTerms: postingRows.map(posting => posting.term),
    queryTerms,
    rankedDocumentCount: rankedIds.length,
    resultLimit,
  });
  const identityConflicts = yield* loadIdentityConflicts(
    options.allowedUriScopes,
    options.eligibility,
    [...candidates, ...recentCandidates].flatMap(candidate => (candidate.memoryId ? [candidate.memoryId] : [])),
  );
  return {
    candidates: RecallIndexIdentity.markRecallIdentityConflicts(candidates, identityConflicts),
    corpusStatistics: postingCorpusStatistics,
    generation,
    queryExhaustive,
    recentCandidates: RecallIndexIdentity.markRecallIdentityConflicts(recentCandidates, identityConflicts),
  } satisfies RecallIndexData;
});

const selectRecallExactMatches = Effect.fn('recall.selectExactMatches')(function* (
  sql: SqlClient.SqlClient,
  options: LoadRecallExactMatchesOptions,
) {
  const terms = [
    ...new Map(
      options.terms
        .map(term => term.trim())
        .filter(Boolean)
        .map(term => [term.toLocaleLowerCase(), term] as const),
    ).values(),
  ];
  const scopes = [...new Set(options.uriScopes.map(stripRecallAnchor))];
  const limitPerTerm = Math.max(0, Math.floor(options.limitPerTerm ?? 25));
  if (terms.length === 0 || scopes.length === 0 || limitPerTerm === 0) {
    return [] satisfies readonly RecallExactMatch[];
  }
  const matchedTermsByUri = new Map<string, Set<string>>();
  for (const scopeUri of scopes) {
    const scope = combineRecallSqlPredicates(
      recallUriScopePredicate('d', [scopeUri]),
      recallEligibilityPredicate('d', options.eligibility),
    );
    for (const term of terms) {
      const phrase = `"${normalizeRecallSearchText(term).replaceAll('"', '""')}"`;
      const rows = yield* sql.unsafe<{readonly uri: string}>(
        `SELECT d.uri
         FROM exact_search
         INNER JOIN documents AS d ON d.id = exact_search.rowid
         WHERE exact_search MATCH ?
           AND ${scope.sql}
         ORDER BY d.uri
         LIMIT ?`,
        [phrase, ...scope.params, limitPerTerm],
      );
      for (const row of rows) {
        const matched = matchedTermsByUri.get(row.uri) ?? new Set<string>();
        matched.add(term);
        matchedTermsByUri.set(row.uri, matched);
      }
    }
  }
  return [...matchedTermsByUri]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([uri, matched]) => ({
      terms: terms.filter(term => matched.has(term)),
      uri,
    })) satisfies readonly RecallExactMatch[];
});

export function recallIndexDatabaseFilename(includeInactive: boolean): string {
  return includeInactive ? INACTIVE_DATABASE_FILENAME : ACTIVE_DATABASE_FILENAME;
}

function recallIndexDatabasePath(path: Path.Path, home: string, includeInactive: boolean): string {
  return path.join(recallIndexRoot(path, home), recallIndexDatabaseFilename(includeInactive));
}

function recallIndexRoot(path: Path.Path, home: string): string {
  return path.join(home, 'indexes', 'lexical');
}

function recallIndexPointerPath(path: Path.Path, home: string, includeInactive: boolean): string {
  const databaseName = recallIndexDatabaseFilename(includeInactive).replace(/\.sqlite$/, '');
  return path.join(recallIndexRoot(path, home), `${databaseName}.pointer.json`);
}

const resolveActiveRecallDatabasePath = Effect.fn('recall.resolveActiveDatabasePath')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  includeInactive: boolean,
) {
  const fixedPath = recallIndexDatabasePath(path, home, includeInactive);
  const pointerPath = recallIndexPointerPath(path, home, includeInactive);
  if (!(yield* fs.exists(pointerPath))) {
    return fixedPath;
  }
  const raw = yield* fs.readFileString(pointerPath);
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: cause => RecallIndexCorrupt.make({message: `Lexical index pointer is invalid: ${String(cause)}`}),
  }).pipe(Effect.option);
  if (Option.isNone(parsed)) {
    return fixedPath;
  }
  if (!Predicate.isObject(parsed.value)) return fixedPath;
  const pointer = parsed.value;
  const relative = typeof pointer.database === 'string' ? pointer.database.replaceAll('\\', '/') : undefined;
  if (
    pointer.version !== RECALL_INDEX_POINTER_VERSION ||
    !relative ||
    !relative.startsWith('generations/') ||
    relative.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
    !relative.endsWith('.sqlite')
  ) {
    return fixedPath;
  }
  const databasePath = path.join(recallIndexRoot(path, home), ...relative.split('/'));
  if (!(yield* fs.exists(databasePath))) {
    return fixedPath;
  }
  return databasePath;
});

const writeActiveRecallDatabasePointer = Effect.fn('recall.writeActiveDatabasePointer')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  includeInactive: boolean,
  database: string,
) {
  const system = yield* SystemInfo;
  const pointerPath = recallIndexPointerPath(path, home, includeInactive);
  const temporaryPath = `${pointerPath}.${system.processId}.${nextRecallGenerationCounter()}.tmp`;
  const pointer: RecallIndexPointer = {
    database: database.replaceAll('\\', '/'),
    version: RECALL_INDEX_POINTER_VERSION,
  };
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(pointer, undefined, 2)}\n`, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, pointerPath)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
});

function useRecallDatabaseReadOnly<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    Layer.build(
      SqliteClient.layer({
        create: false,
        disableWAL: true,
        filename: databasePath,
        readonly: true,
        readwrite: false,
      }).pipe(Layer.orDie),
    ).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
}

const initializeRecallDatabase = Effect.fn('recall.initializeDatabase')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RecallIndexConfig,
  includeInactive: boolean,
  indexLockHeld: boolean,
) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  const empty = sql.unsafe('SELECT name FROM main.sqlite_schema LIMIT 1').pipe(Effect.map(rows => rows.length === 0));
  const initialize = initializeRecallSchema(sql);
  if (!(yield* empty)) return yield* initialize;
  // Serialize cold writers cooperatively before SQLite's synchronous BEGIN wait.
  // Recheck under the existing lock; another caller may have completed bootstrap.
  const cold = Effect.gen(function* () {
    return yield* (yield* empty) ? sql.withTransaction(initialize) : initialize;
  });
  return yield* indexLockHeld
    ? cold
    : withRecallIndexLock(fs, path, config.agentContextHome, includeInactive, () => cold);
});

const ensureRecallDatabaseFresh = Effect.fn('recall.ensureDatabaseFresh')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  databasePath: string,
  staleMarkerBasePath: string,
  config: RecallIndexConfig,
  options: {
    readonly forceRefresh?: boolean;
    readonly includeInactive: boolean;
    readonly onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>;
    readonly validateNow?: boolean;
  },
  indexLockHeld = false,
) {
  const metadata = yield* loadRecallMetadata(sql);
  const staleMarker = yield* readStaleMarker(fs, staleMarkerBasePath);
  const canonicalMutationGeneration = yield* readCanonicalMutationGeneration(
    fs,
    path,
    config.agentContextHome,
    config.account,
  );
  if (
    !recallIndexForegroundRefreshRequired(
      recallIndexForegroundFreshness(metadata, staleMarker, canonicalMutationGeneration, options),
    )
  ) {
    return;
  }
  const refresh = withCanonicalResourceMutationLock(
    fs,
    path,
    config.agentContextHome,
    config.account,
    Effect.gen(function* () {
      const lockedMetadata = yield* loadRecallMetadata(sql);
      const lockedStaleMarker = yield* readStaleMarker(fs, staleMarkerBasePath);
      const lockedCanonicalMutationGeneration = yield* readCanonicalMutationGeneration(
        fs,
        path,
        config.agentContextHome,
        config.account,
      );
      if (
        !recallIndexForegroundRefreshRequired(
          recallIndexForegroundFreshness(lockedMetadata, lockedStaleMarker, lockedCanonicalMutationGeneration, options),
        )
      ) {
        return;
      }
      const repairLogicalCorruption =
        lockedMetadata.get('initialized') === 'true' &&
        !RecallIndexIdentity.recallIndexMetadataIsCurrent(lockedMetadata);
      yield* refreshRecallDatabase(
        sql,
        fs,
        path,
        databasePath,
        staleMarkerBasePath,
        config,
        options.includeInactive,
        options.forceRefresh === true || repairLogicalCorruption,
        options.onProgress,
      );
    }),
  );
  yield* indexLockHeld
    ? refresh
    : withRecallIndexLock(fs, path, config.agentContextHome, options.includeInactive, () => refresh);
});

function recallIndexForegroundFreshness(
  metadata: ReadonlyMap<string, string>,
  staleMarker: RecallStaleMarker | undefined,
  canonicalMutationGeneration: string,
  options: Pick<LoadRecallIndexOptions, 'forceRefresh'>,
) {
  return {
    forceRefresh: options.forceRefresh === true,
    initialized: metadata.get('initialized') === 'true',
    sourceValidationRequired: metadata.get('source_validation_required') === 'true',
    integrityCurrent: RecallIndexIdentity.recallIndexMetadataIsCurrent(metadata),
    observedCanonicalMutationGeneration: canonicalMutationGeneration,
    observedStaleGeneration: staleMarker?.generation ?? '',
    persistedCanonicalMutationGeneration: metadata.get('canonical_mutation_generation') ?? '',
    persistedStaleGeneration: metadata.get('stale_generation') ?? '',
  };
}

const refreshRecallDatabase = Effect.fn('recall.refreshDatabase')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  databasePath: string,
  staleMarkerBasePath: string,
  config: RecallIndexConfig,
  includeInactive: boolean,
  forceRefresh: boolean,
  onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>,
) {
  const staleMarker = yield* readStaleMarker(fs, staleMarkerBasePath);
  const staleGeneration = staleMarker?.generation;
  const canonicalMutationGeneration = yield* readCanonicalMutationGeneration(
    fs,
    path,
    config.agentContextHome,
    config.account,
  );
  const canonicalResourcePolicy = yield* loadCanonicalResourcePolicy(config);
  const previousMetadata = yield* loadRecallMetadata(sql);
  const markerChanged = previousMetadata.get('stale_generation') !== (staleGeneration ?? '');
  const canonicalMutationGenerationChanged =
    (previousMetadata.get('canonical_mutation_generation') ?? '') !== canonicalMutationGeneration;
  const canonicalMutationContinuityAllowsIncrementalRefresh =
    recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh({
      ...(staleMarker?.canonicalMutationGeneration === undefined
        ? {}
        : {markerCurrentGeneration: staleMarker.canonicalMutationGeneration}),
      ...(staleMarker?.previousCanonicalMutationGeneration === undefined
        ? {}
        : {markerPreviousGeneration: staleMarker.previousCanonicalMutationGeneration}),
      observedGeneration: canonicalMutationGeneration,
      persistedGeneration: previousMetadata.get('canonical_mutation_generation') ?? '',
    });
  const invalidatedUris = markerChanged ? new Set(staleMarker?.invalidatedUris ?? []) : new Set<string>();
  const forceFromMarker = markerChanged && staleMarker?.forceRefresh === true;
  const sourceScan = yield* scanRecallSources(
    sql,
    fs,
    path,
    config,
    includeInactive,
    canonicalResourcePolicy,
    invalidatedUris,
  );
  const forceAllSources =
    forceRefresh ||
    previousMetadata.get('source_validation_required') === 'true' ||
    forceFromMarker ||
    (canonicalMutationGenerationChanged && !canonicalMutationContinuityAllowsIncrementalRefresh);
  const refreshCounts = yield* countRecallSourceChanges(sql, forceAllSources);
  yield* Effect.annotateCurrentSpan({
    'recall.refresh.forceAllSources': forceAllSources,
    'recall.refresh.forceRefresh': forceRefresh,
    'recall.refresh.forceFromMarker': forceFromMarker,
    'recall.refresh.canonicalMutationChanged': canonicalMutationGenerationChanged,
    'recall.refresh.continuityAllowed': canonicalMutationContinuityAllowsIncrementalRefresh,
    'recall.refresh.scannedSources': sourceScan.scannedSourceCount,
    'recall.refresh.changedSources': refreshCounts.changedSourceCount,
    'recall.refresh.removedSources': refreshCounts.removedSourceCount,
  });
  yield* onProgress?.({
    completed: 0,
    phase: 'indexing',
    scanned: sourceScan.scannedSourceCount,
    total: refreshCounts.changedSourceCount,
  }) ?? Effect.void;
  let indexedSourceCount = 0;
  yield* forEachChangedRecallSourcePage(sql, forceAllSources, page =>
    Effect.gen(function* () {
      const indexedSources = yield* Effect.forEach(
        page,
        source =>
          Effect.gen(function* () {
            const {candidate, memory} = yield* assembleRecallSourceCandidate(
              fs,
              config,
              source,
              canonicalResourcePolicy,
            );
            const memoryLinkProjection = deriveIndexedRecallMemoryLinks(memory);
            const postings = candidatePostings(candidate);
            return {
              candidate,
              codeLinks: deriveIndexedRecallCodeLinks(memory?.metadata.codeCitations ?? []),
              documentLength: recallDocumentTerms(candidate).length,
              exactSearchText: recallExactSearchText(candidate),
              memoryLinks: memoryLinkProjection.links,
              memoryLinksTruncated: memoryLinkProjection.truncated,
              postings,
              source,
            } satisfies IndexedRecallSource;
          }),
        {concurrency: 16},
      );
      yield* insertIndexedRecallSources(sql, indexedSources);
      indexedSourceCount += indexedSources.length;
      yield* onProgress?.({
        completed: indexedSourceCount,
        phase: 'indexing',
        scanned: sourceScan.scannedSourceCount,
        total: refreshCounts.changedSourceCount,
      }) ?? Effect.void;
    }),
  ).pipe(Effect.withSpan('recall.assembleRefreshSources'));
  const previousContentGeneration = previousMetadata.get('content_generation');
  const contentGeneration =
    refreshCounts.changedSourceCount === 0 && refreshCounts.removedSourceCount === 0 && previousContentGeneration
      ? previousContentGeneration
      : yield* hashRecallRefreshGeneration(sql, previousContentGeneration).pipe(
          Effect.withSpan('recall.hashRefreshGeneration'),
        );
  const previousValidatedAt = numericMetadata(previousMetadata, 'validated_at');
  const now = yield* Clock.currentTimeMillis;
  yield* onProgress?.({
    completed: 0,
    phase: 'writing',
    removed: refreshCounts.removedSourceCount,
    total: refreshCounts.changedSourceCount,
  }) ?? Effect.void;
  const observedSourceChanges = yield* recallProjectionObservedChanges(sql, 'lexical');
  const writeRefresh = sql.withTransaction(
    Effect.gen(function* () {
      yield* stageRecallRefreshAffectedTerms(sql);
      yield* sql.unsafe(`
        DELETE FROM exact_search
        WHERE rowid IN (SELECT document_id FROM temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE})
      `);
      yield* sql.unsafe(`
        DELETE FROM documents
        WHERE id IN (SELECT document_id FROM temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE})
      `);
      yield* sql.unsafe(`
        INSERT INTO documents (
          uri,
          project,
          approved_authoritative,
          workspace_scope,
          source_path,
          source_modified_at,
          recorded_at,
          source_size,
          authority_policy_key,
          candidate_json,
          logical_key,
          document_length,
          memory_links_truncated
        )
        SELECT
          indexed.uri,
          indexed.project,
          indexed.approved_authoritative,
          indexed.workspace_scope,
          source.source_path,
          source.source_modified_at,
          indexed.recorded_at,
          source.source_size,
          source.authority_policy_key,
          indexed.candidate_json,
          indexed.logical_key,
          indexed.document_length,
          indexed.memory_links_truncated
        FROM temp.${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} AS indexed
        INNER JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = indexed.uri
        ORDER BY indexed.uri COLLATE BINARY
      `);
      yield* sql.unsafe(`
        INSERT INTO exact_search (rowid, content)
        SELECT document.id, indexed.exact_search_text
        FROM temp.${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} AS indexed
        INNER JOIN documents AS document ON document.uri = indexed.uri
        ORDER BY indexed.uri COLLATE BINARY
      `);
      yield* sql.unsafe(`
        INSERT INTO code_links (document_id, document_uri, citation_ordinal, selector_kind, selector_digest)
        SELECT document.id, document.uri, code_link.citation_ordinal, code_link.selector_kind, code_link.selector_digest
        FROM temp.${RECALL_REFRESH_INDEXED_CODE_LINK_TABLE} AS code_link
        INNER JOIN documents AS document ON document.uri = code_link.uri
        ORDER BY
          document.id,
          code_link.citation_ordinal,
          code_link.selector_kind COLLATE BINARY,
          code_link.selector_digest COLLATE BINARY
      `);
      yield* sql.unsafe(`
        INSERT INTO memory_links (
          source_document_id,
          source_uri,
          source_memory_id,
          target_memory_id,
          target_locator_digest,
          relation_type,
          relation_origin,
          relation_ordinal
        )
        SELECT
          document.id,
          document.uri,
          memory_link.source_memory_id,
          memory_link.target_memory_id,
          memory_link.target_locator_digest,
          memory_link.relation_type,
          memory_link.relation_origin,
          memory_link.relation_ordinal
        FROM temp.${RECALL_REFRESH_INDEXED_MEMORY_LINK_TABLE} AS memory_link
        INNER JOIN documents AS document ON document.uri = memory_link.uri
        ORDER BY
          document.id,
          memory_link.relation_origin COLLATE BINARY,
          memory_link.relation_ordinal,
          memory_link.relation_type COLLATE BINARY,
          memory_link.target_memory_id COLLATE BINARY,
          memory_link.target_locator_digest COLLATE BINARY
      `);
      yield* sql.unsafe(`
        INSERT INTO postings (term, document_id, field_weight, term_frequency)
        SELECT posting.term, document.id, posting.field_weight, posting.term_frequency
        FROM temp.${RECALL_REFRESH_INDEXED_POSTING_TABLE} AS posting
        INNER JOIN documents AS document ON document.uri = posting.uri
        ORDER BY posting.term COLLATE BINARY, document.id
      `);
      if (refreshCounts.changedSourceCount > 0) {
        yield* onProgress?.({
          completed: refreshCounts.changedSourceCount,
          phase: 'writing',
          removed: refreshCounts.removedSourceCount,
          total: refreshCounts.changedSourceCount,
        }) ?? Effect.void;
      }
      yield* RecallIndexIdentity.rebuildRecallIdentityConflicts(sql);
      yield* resolveLegacyRecallMemoryLinks(sql);
      yield* sql.unsafe(`
        DELETE FROM term_statistics
        WHERE term IN (SELECT term FROM temp.${RECALL_REFRESH_AFFECTED_TERM_TABLE})
      `);
      yield* sql.unsafe(`
        INSERT INTO term_statistics (term, document_frequency)
        SELECT posting.term, COUNT(DISTINCT document.logical_key)
        FROM postings AS posting
        INNER JOIN documents AS document ON document.id = posting.document_id
        WHERE posting.term IN (SELECT term FROM temp.${RECALL_REFRESH_AFFECTED_TERM_TABLE})
        GROUP BY posting.term
      `);
      const aggregate = yield* sql<{
        readonly document_count: number;
        readonly total_document_length: number | null;
      }>`
        SELECT COUNT(*) AS document_count, COALESCE(SUM(document_length), 0) AS total_document_length
        FROM documents
      `;
      const documentCount = aggregate[0]?.document_count ?? 0;
      const totalDocumentLength = aggregate[0]?.total_document_length ?? 0;
      const logicalAggregate = yield* sql<{
        readonly document_count: number;
        readonly total_document_length: number | null;
      }>`
        SELECT COUNT(*) AS document_count, COALESCE(SUM(document_length), 0) AS total_document_length
        FROM (
          SELECT logical_key, MAX(document_length) AS document_length
          FROM documents
          GROUP BY logical_key
        )
      `;
      const logicalDocumentCount = logicalAggregate[0]?.document_count ?? 0;
      const logicalTotalDocumentLength = logicalAggregate[0]?.total_document_length ?? 0;
      const metadataEntries = [
        ['canonical_mutation_generation', canonicalMutationGeneration],
        ['content_generation', contentGeneration],
        ['document_count', String(documentCount)],
        ['include_inactive', includeInactive ? 'true' : 'false'],
        ['initialized', 'true'],
        ['source_validation_required', 'false'],
        ['memory_identity_conflict_generation', contentGeneration],
        ['logical_document_count', String(logicalDocumentCount)],
        ['logical_total_document_length', String(logicalTotalDocumentLength)],
        ['oversized_document_count', String(sourceScan.skippedOversizedDocumentCount)],
        ['stale_generation', staleGeneration ?? ''],
        ['total_document_length', String(totalDocumentLength)],
        ['validated_at', String(Math.max(now, previousValidatedAt + 1))],
      ] as const;
      if (
        observedSourceChanges &&
        previousMetadata.get('identity_initialized') === 'true' &&
        previousMetadata.get('identity_canonical_mutation_generation') === canonicalMutationGeneration
      ) {
        yield* sql.unsafe(`INSERT INTO metadata (key, value) VALUES ('identity_source_validation_required', 'true')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      }
      yield* sql.unsafe(
        `INSERT INTO metadata (key, value) VALUES ${metadataEntries.map(() => '(?, ?)').join(', ')}
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        metadataEntries.flat(),
      );
      yield* sql.unsafe(`
        INSERT INTO metadata (key, value)
        SELECT 'integrity_sequence', value FROM metadata WHERE key = 'mutation_sequence'
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      yield* onProgress?.({documentCount, phase: 'activating'}) ?? Effect.void;
    }).pipe(Effect.withSpan('recall.writeRefreshBody')),
  );
  yield* writeRefresh.pipe(Effect.withSpan('recall.writeRefresh'));
  yield* dropRecallSourceScan(sql);
  yield* fs.chmod(databasePath, 0o600);
  if (markerChanged && staleMarker) {
    yield* clearStaleMarkerInvalidations(fs, staleMarkerBasePath, staleMarker).pipe(Effect.ignore);
  }
  yield* removeLegacyRecallIndexArtifacts(fs, path, config.agentContextHome, RECALL_INDEX_DATABASE_VERSION);
});

function loadRecallMetadata(sql: SqlClient.SqlClient) {
  return sql<RecallMetadataRow>`SELECT key, value FROM metadata`.pipe(
    Effect.map(rows => new Map(rows.map(row => [row.key, row.value]))),
  );
}

function numericMetadata(metadata: ReadonlyMap<string, string>, key: string): number {
  const value = Number(metadata.get(key) ?? '0');
  return Number.isFinite(value) ? value : 0;
}

/**
 * Legacy URI edges retain only a locator digest. Re-resolve every such row
 * against the exact corpus staged for this database so target add/delete/move
 * operations converge with a clean rebuild even when the source is unchanged.
 */
const resolveLegacyRecallMemoryLinks = Effect.fn('recall.resolveLegacyMemoryLinks')(function* (
  sql: SqlClient.SqlClient,
) {
  const resolvedTarget = `(SELECT json_extract(target.candidate_json, '$.memoryId')
    FROM temp.${RECALL_REFRESH_SOURCE_TABLE} AS target_source
    INNER JOIN documents AS target ON target.uri = target_source.uri
    WHERE target_source.uri_locator_digest = memory_links.target_locator_digest
      AND json_type(target.candidate_json, '$.memoryId') = 'text'
      AND COALESCE(json_extract(target.candidate_json, '$.status'), 'active') = 'active'
      AND length(json_extract(target.candidate_json, '$.memoryId')) BETWEEN 4 AND 131
      AND substr(json_extract(target.candidate_json, '$.memoryId'), 1, 3) = 'tn_'
      AND substr(json_extract(target.candidate_json, '$.memoryId'), 4) NOT GLOB '*[^A-Za-z0-9_-]*'
      AND NOT EXISTS (
        SELECT 1 FROM memory_identity_conflicts AS conflict
        WHERE conflict.memory_id = json_extract(target.candidate_json, '$.memoryId')
      )
      AND (
        SELECT COUNT(*) FROM documents AS identity_document
        WHERE json_extract(identity_document.candidate_json, '$.memoryId') =
          json_extract(target.candidate_json, '$.memoryId')
      ) = 1
    ORDER BY target.uri COLLATE BINARY
    LIMIT 1)`;
  yield* sql.unsafe(`
    UPDATE memory_links
    SET target_memory_id = COALESCE(${resolvedTarget}, '')
    WHERE target_locator_digest <> ''
      AND target_memory_id <> COALESCE(${resolvedTarget}, '')
  `);
});

const loadRecallCorpusStatistics = Effect.fn('recall.loadCorpusStatistics')(function* (
  sql: SqlClient.SqlClient,
  terms: readonly string[],
) {
  const [metadata, rows] = yield* Effect.all(
    [
      loadRecallMetadata(sql),
      terms.length === 0
        ? Effect.succeed<readonly RecallTermStatisticRow[]>([])
        : Effect.gen(function* () {
            const selected: RecallTermStatisticRow[] = [];
            for (const batch of chunkValues(terms, 400)) {
              selected.push(
                ...(yield* sql<RecallTermStatisticRow>`
                  SELECT term, document_frequency FROM term_statistics WHERE ${sql.in('term', batch)}
                `),
              );
            }
            return selected;
          }),
    ],
    {concurrency: 2},
  );
  const documentCount = numericMetadata(metadata, 'logical_document_count');
  const totalDocumentLength = numericMetadata(metadata, 'logical_total_document_length');
  return {
    averageDocumentLength: documentCount === 0 ? 1 : totalDocumentLength / documentCount,
    documentCount,
    documentFrequency: Object.assign(Object.fromEntries(rows.map(row => [row.term, row.document_frequency]))),
    totalDocumentLength,
  } satisfies RecallCorpusStatistics;
});

function decodeCandidateRow(row: RecallDocumentRow): RecallCandidate {
  let value: unknown;
  try {
    value = JSON.parse(row.candidate_json);
  } catch (cause) {
    throw RecallIndexCorrupt.make({message: `Lexical index candidate ${row.uri} is invalid: ${String(cause)}`});
  }
  if (!recallCandidateIsValid(value) || stripRecallAnchor(value.uri) !== row.uri) {
    throw RecallIndexCorrupt.make({message: `Lexical index candidate ${row.uri} is invalid.`});
  }
  return value;
}

function withRecallIndexLock<A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  includeInactive: boolean,
  effect: () => Effect.Effect<A, E, R>,
) {
  return withExclusiveFileLock(
    fs,
    path.join(home, 'locks', 'indexes', 'lexical', `${recallIndexDatabaseFilename(includeInactive)}.lock`),
    {
      heartbeatIntervalMilliseconds: 10_000,
      retryIntervalMilliseconds: 100,
      staleAfterMilliseconds: 60_000,
      waitTimeoutMilliseconds: 120_000,
    },
    Effect.suspend(effect),
  );
}

function withCanonicalResourceMutationLock<A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  account: string,
  effect: Effect.Effect<A, E, R>,
) {
  return withExclusiveFileLock(
    fs,
    resourceAccountMutationLockPath(path, home, account),
    {
      heartbeatIntervalMilliseconds: 10_000,
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 30_000,
      waitTimeoutMilliseconds: 30_000,
    },
    effect,
  );
}

function removeRecallDatabaseAuxiliaryFiles(fs: FileSystem.FileSystem, databasePath: string) {
  return Effect.forEach([`${databasePath}-shm`, `${databasePath}-wal`], target => fs.remove(target, {force: true}), {
    concurrency: 1,
    discard: true,
  });
}

function isRecoverableRecallIndexCause(cause: Cause.Cause<unknown>): boolean {
  const squashed = Cause.squash(cause);
  if (Schema.is(RecallIndexCorrupt)(squashed) || Schema.is(RecallIndexSchemaIncompatible)(squashed)) {
    return true;
  }
  return /database disk image is malformed|file is not a database|database schema is corrupt|malformed database schema/i.test(
    Cause.pretty(cause),
  );
}

function nextRecallGenerationCounter(): number {
  staleGenerationCounter += 1;
  return staleGenerationCounter;
}

function chunkValues<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
  const chunks: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function filterExternalRecallResult<A>(
  result: A,
  config: RecallIndexConfig,
  externalResources: Readonly<Record<string, string>>,
): Effect.Effect<A, never, FileSystem.FileSystem | Path.Path> {
  const location = {home: config.agentContextHome, account: config.account, user: config.user};
  const allowed = (candidate: RecallCandidate) =>
    !isExternalResourceUri(candidate.uri)
      ? Effect.succeed(true)
      : externalResourceAccess(location, candidate.uri, undefined, candidate.contentHash).pipe(
          Effect.map(access => access && candidate.authority === 'external' && candidate.trust === 'untrusted'),
        );
  const filterData = (data: RecallIndexData) =>
    Effect.gen(function* () {
      const candidates = yield* Effect.filter(data.candidates, allowed);
      const recentCandidates =
        data.recentCandidates === undefined ? undefined : yield* Effect.filter(data.recentCandidates, allowed);
      return {...data, candidates, ...(recentCandidates === undefined ? {} : {recentCandidates})};
    });
  if (Array.isArray(result))
    return Effect.forEach(result, value => {
      if (typeof value === 'object' && value !== null && 'candidates' in value)
        return filterData(value as RecallIndexData);
      if (
        typeof value === 'object' &&
        value !== null &&
        'uri' in value &&
        typeof value.uri === 'string' &&
        isExternalResourceUri(value.uri)
      )
        return externalResourceAccess(location, value.uri, undefined, externalResources[value.uri]).pipe(
          Effect.map(access => (access ? value : undefined)),
        );
      return Effect.succeed(value);
    }).pipe(Effect.map(value => value.filter(item => item !== undefined) as A));
  if (typeof result === 'object' && result !== null && 'candidates' in result)
    return filterData(result as unknown as RecallIndexData).pipe(Effect.map(value => value as A));
  return Effect.succeed(result);
}
