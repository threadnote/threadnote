import {Cause, Clock, Crypto, Effect, FileSystem, Layer, Option, Path, Predicate, Schema} from 'effect';
import {
  recallCodeLinkMatchesResult,
  recallExactMatchesResult,
  recallIndexDataBatchResult,
  recallIndexDataResult,
  recallMemoryLinkMatchesResult,
} from './index/result.js';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {SEED_STATE_FILE} from '@threadnote/workspace/constants';
import {sha256Hex} from '@threadnote/platform/digest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {resourceAccountMutationLockPath} from '@threadnote/store/resource/lock';
import {
  readCanonicalMutationGeneration,
  type CanonicalMutationGenerationTransition,
} from '@threadnote/store/resource/mutation_generation';
import {SystemInfo} from '@threadnote/platform/system';
import {parseSeedManifest} from '@threadnote/workspace/manifest';
import {
  boundedMemoryAuthority,
  boundedMemoryTrust,
  parseMemoryDocument,
  type MemoryRelation,
} from '@threadnote/memory/document';
import {redactSensitiveText} from '@threadnote/platform/scrubber';
import type {ProjectManifest} from '@threadnote/workspace/config';
import {errorMessage} from '@threadnote/platform/errors';
import {globToRegExp} from '@threadnote/platform/glob';
import {expandPath} from '@threadnote/platform/paths';
import {
  candidatePostings,
  identifiers,
  indexTerms,
  postingLexicalScore,
  selectQueryTerms,
  stripRecallAnchor,
} from './index/lexical.js';
import {
  deduplicateLogicalRecallCandidates,
  recallMemoryContentHash,
  recallDocumentTerms,
  type RecallCandidate,
  type RecallCorpusStatistics,
} from './rank.js';
import {normalizeRecallSearchText} from './tokenize.js';
import {removeLegacyRecallIndexArtifacts} from './index/cleanup.js';
import {
  recallCandidateIsEligible,
  recallEligibilityPolicyRestrictsCandidates,
  type RecallEligibilityPolicy,
} from './eligibility.js';
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
  type CanonicalResourcePolicy,
  type IndexedRecallSource,
} from './index/refresh.js';

export {recallUriMatchesScopes} from './index/scope.js';

class RecallIndexOperationError extends Schema.TaggedError<RecallIndexOperationError>()('RecallIndexOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

interface SeedStateEntry {
  readonly mtimeMs: number;
  readonly size: number;
}

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

interface RecallMetadataRow {
  readonly key: string;
  readonly value: string;
}

interface RecallTermStatisticRow {
  readonly document_frequency: number;
  readonly term: string;
}

const RECALL_INDEX_DATABASE_VERSION = 13;
const RECALL_INDEX_POINTER_VERSION = 1;
const ACTIVE_DATABASE_FILENAME = `active-v${RECALL_INDEX_DATABASE_VERSION}.sqlite`;
const INACTIVE_DATABASE_FILENAME = `with-inactive-v${RECALL_INDEX_DATABASE_VERSION}.sqlite`;
const DEFAULT_QUERY_RESULT_LIMIT = 100;
const QUERY_POSTING_POOL_MULTIPLIER = 5;
const MINIMUM_QUERY_POSTING_POOL = 500;
const SEED_FILE_MTIME_TOLERANCE_MILLISECONDS = 1;
let staleGenerationCounter = 0;

interface RecallIndexPointer {
  readonly database: string;
  readonly version: typeof RECALL_INDEX_POINTER_VERSION;
}

class RecallIndexCorrupt extends Schema.TaggedError<RecallIndexCorrupt>()('RecallIndexCorrupt', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

class RecallIndexSchemaIncompatible extends Schema.TaggedError<RecallIndexSchemaIncompatible>()(
  'RecallIndexSchemaIncompatible',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

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
      yield* initializeRecallDatabase(sql);
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
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
      const result = yield* 'anchors' in options
        ? selectRecallCodeLinks(sql, options)
        : 'memorySeeds' in options
          ? selectRecallMemoryLinks(sql, options)
          : Effect.gen(function* () {
              const metadata = yield* loadRecallMetadata(sql);
              const generation = metadata.get('content_generation') ?? '';
              const corpusStatistics = yield* loadRecallCorpusStatistics(sql, recallStatisticTerms(options));
              const loadIdentityConflicts = RecallIndexIdentity.createRecallIdentityConflictLoader(sql);
              const selectData = (selection: LoadRecallIndexOptions) =>
                selectRecallIndexData(sql, corpusStatistics, generation, selection, loadIdentityConflicts);
              return 'terms' in options
                ? yield* selectRecallExactMatches(sql, options)
                : 'selections' in options
                  ? yield* Effect.forEach(
                      options.selections,
                      selection => selectData({...selection, includeInactive: options.includeInactive}),
                      {concurrency: 1},
                    )
                  : yield* selectData(options);
            });
      if (prepareForActivation) {
        yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
        yield* sql.unsafe('PRAGMA journal_mode = DELETE');
      }
      return result;
    }),
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
        return yield* executeRecallIndexQuery(activePath, staleMarkerBasePath, config, options);
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

export const loadRecallMemoryIdentities = Effect.fn('recall.loadMemoryIdentities')(function* (
  config: RecallIndexConfig,
  options: {
    readonly allowedUriScopes: readonly string[];
    readonly memoryIds: readonly string[];
    readonly validateNow?: boolean;
  },
) {
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
        return {
          databasePath,
          documentCount: 0,
          ready: false,
          reason: 'not initialized; run `threadnote repair`',
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
});

const selectRecallIndexData = Effect.fn('recall.selectIndexData')(function* (
  sql: SqlClient.SqlClient,
  corpusStatistics: RecallCorpusStatistics,
  generation: string,
  options: LoadRecallIndexOptions,
  loadIdentityConflicts: ReturnType<typeof RecallIndexIdentity.createRecallIdentityConflictLoader>,
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
    const logicalCandidates = deduplicateLogicalRecallCandidates(rows.map(decodeCandidateRow));
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

function useRecallDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, R> {
  return Effect.scoped(
    Layer.build(SqliteClient.layer({filename: databasePath})).pipe(
      Effect.flatMap(context => effect.pipe(Effect.provide(context))),
    ),
  );
}

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
      }),
    ).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
}

const initializeRecallDatabase = Effect.fn('recall.initializeDatabase')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      uri TEXT UNIQUE NOT NULL,
      project TEXT,
      approved_authoritative INTEGER NOT NULL CHECK (approved_authoritative IN (0, 1)),
      workspace_scope TEXT,
      source_path TEXT NOT NULL,
      source_modified_at TEXT,
      recorded_at TEXT,
      source_size INTEGER NOT NULL CHECK (source_size >= 0),
      authority_policy_key TEXT,
      candidate_json TEXT NOT NULL,
      logical_key TEXT NOT NULL,
      document_length INTEGER NOT NULL CHECK (document_length >= 0),
      memory_links_truncated INTEGER NOT NULL CHECK (memory_links_truncated IN (0, 1))
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS postings (
      term TEXT NOT NULL,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      field_weight REAL NOT NULL CHECK (field_weight >= 0),
      term_frequency INTEGER NOT NULL CHECK (term_frequency > 0),
      PRIMARY KEY (term, document_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS code_links (
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      document_uri TEXT NOT NULL,
      citation_ordinal INTEGER NOT NULL CHECK (citation_ordinal >= 0),
      selector_kind TEXT NOT NULL CHECK (
        selector_kind IN ('symbol-node', 'symbol-locator', 'file-path', 'file-content')
      ),
      selector_digest TEXT NOT NULL CHECK (
        length(selector_digest) = 64 AND selector_digest NOT GLOB '*[^0-9a-f]*'
      ),
      PRIMARY KEY (document_id, citation_ordinal, selector_kind, selector_digest)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS memory_links (
      source_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      source_uri TEXT NOT NULL,
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      target_locator_digest TEXT NOT NULL CHECK (
        target_locator_digest = '' OR (
          length(target_locator_digest) = 64 AND target_locator_digest NOT GLOB '*[^0-9a-f]*'
        )
      ),
      relation_type TEXT NOT NULL CHECK (
        relation_type IN ('depends_on', 'evidence_for', 'references', 'related_to', 'supersedes')
      ),
      relation_origin TEXT NOT NULL CHECK (
        relation_origin IN ('relation', 'references', 'evidence', 'supersedes')
      ),
      relation_ordinal INTEGER NOT NULL CHECK (relation_ordinal >= 0),
      CHECK (target_memory_id <> '' OR target_locator_digest <> ''),
      PRIMARY KEY (
        source_document_id,
        relation_origin,
        relation_ordinal,
        relation_type,
        target_memory_id,
        target_locator_digest
      )
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS term_statistics (
      term TEXT PRIMARY KEY NOT NULL,
      document_frequency INTEGER NOT NULL CHECK (document_frequency > 0)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS exact_search USING fts5(
      content,
      content = '',
      contentless_delete = 1,
      tokenize = 'trigram'
    )
  `);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_uri ON documents(uri)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_logical_key ON documents(logical_key)');
  yield* RecallIndexIdentity.initializeRecallIdentityIndex(sql);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_modified_uri ON documents(source_modified_at DESC, uri)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS documents_project_modified_uri ON documents(project, source_modified_at DESC, uri)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS documents_eligibility_uri ON documents(project, approved_authoritative, uri)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS documents_authority_project_uri ON documents(approved_authoritative, project, uri)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_workspace_scope_uri ON documents(workspace_scope, uri)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS postings_document_id ON postings(document_id)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS code_links_selector_document ON code_links(selector_kind, selector_digest, document_id, citation_ordinal)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS code_links_selector_uri ON code_links(selector_kind, selector_digest, document_uri COLLATE BINARY, citation_ordinal, document_id)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS memory_links_source ON memory_links(source_memory_id, relation_type, source_uri COLLATE BINARY, relation_origin, relation_ordinal, target_memory_id, target_locator_digest, source_document_id)',
  );
  yield* sql.unsafe(
    "CREATE INDEX IF NOT EXISTS memory_links_target ON memory_links(target_memory_id, relation_type, source_uri COLLATE BINARY, relation_origin, relation_ordinal, target_locator_digest, source_document_id) WHERE target_memory_id <> ''",
  );
  yield* sql.unsafe(
    "CREATE INDEX IF NOT EXISTS memory_links_locator ON memory_links(target_locator_digest, relation_type, source_document_id, relation_origin, relation_ordinal) WHERE target_locator_digest <> ''",
  );
  yield* sql`
    INSERT INTO metadata (key, value)
    VALUES ('schema_version', ${String(RECALL_INDEX_DATABASE_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  yield* sql`INSERT INTO metadata (key, value) VALUES ('mutation_sequence', '0') ON CONFLICT(key) DO NOTHING`;
  for (const table of ['documents', 'postings', 'term_statistics', 'code_links', 'memory_links'] as const) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      yield* sql.unsafe(`
        CREATE TRIGGER IF NOT EXISTS ${table}_integrity_${operation.toLowerCase()}
        AFTER ${operation} ON ${table}
        BEGIN
          UPDATE metadata
          SET value = CAST(value AS INTEGER) + 1
          WHERE key = 'mutation_sequence';
        END
      `);
    }
  }
  const rows = yield* sql<RecallMetadataRow>`SELECT key, value FROM metadata WHERE key = 'schema_version'`;
  if (rows[0]?.value !== String(RECALL_INDEX_DATABASE_VERSION)) {
    return yield* RecallIndexSchemaIncompatible.make({
      message: `Unsupported lexical index schema ${rows[0]?.value ?? 'unknown'}; expected ${RECALL_INDEX_DATABASE_VERSION}.`,
    });
  }
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
    forceFromMarker ||
    (canonicalMutationGenerationChanged && !canonicalMutationContinuityAllowsIncrementalRefresh);
  const refreshCounts = yield* countRecallSourceChanges(sql, forceAllSources);
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
            const content = yield* fs.readFileString(source.path);
            const canonicalResource = yield* verifyCanonicalResource(fs, source.uri, content, canonicalResourcePolicy);
            const memory = parseMemoryDocument(source.uri, content);
            const candidate = indexCandidate(source.uri, content, canonicalResource, memory);
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
  );
  const previousContentGeneration = previousMetadata.get('content_generation');
  const contentGeneration =
    refreshCounts.changedSourceCount === 0 && refreshCounts.removedSourceCount === 0 && previousContentGeneration
      ? previousContentGeneration
      : yield* hashRecallRefreshGeneration(sql, previousContentGeneration);
  const previousValidatedAt = numericMetadata(previousMetadata, 'validated_at');
  const now = yield* Clock.currentTimeMillis;
  yield* onProgress?.({
    completed: 0,
    phase: 'writing',
    removed: refreshCounts.removedSourceCount,
    total: refreshCounts.changedSourceCount,
  }) ?? Effect.void;
  yield* sql.withTransaction(
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
        ['memory_identity_conflict_generation', contentGeneration],
        ['logical_document_count', String(logicalDocumentCount)],
        ['logical_total_document_length', String(logicalTotalDocumentLength)],
        ['oversized_document_count', String(sourceScan.skippedOversizedDocumentCount)],
        ['stale_generation', staleGeneration ?? ''],
        ['total_document_length', String(totalDocumentLength)],
        ['validated_at', String(Math.max(now, previousValidatedAt + 1))],
      ] as const;
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
    }),
  );
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

function recallIndexCandidateIsEligible(
  policy: RecallEligibilityPolicy | undefined,
  candidate: RecallCandidate,
): boolean {
  return (
    policy === undefined ||
    recallCandidateIsEligible(policy, {
      authority: candidate.authority,
      project: candidate.fields?.project,
      trust: candidate.trust,
    })
  );
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

function indexCandidate(
  uri: string,
  content: string,
  canonicalResource: boolean,
  memory = parseMemoryDocument(uri, content),
): RecallCandidate {
  const text = redactSensitiveText(memory?.body ?? content);
  const fields = {
    identifiers: identifiers(text),
    keywords: memory?.metadata.keywords,
    project: memory?.metadata.project ?? resourceProject(uri),
    title: firstHeading(text) ?? uriBasename(uri),
    topic: memory?.metadata.topic ?? uriTopic(uri),
    workspaceScope: memory?.metadata.workspaceScope,
  };
  return {
    authority: boundedMemoryAuthority(uri, memory?.metadata, {canonicalResource}),
    contentHash: memory ? recallMemoryContentHash(memory.body) : undefined,
    fields,
    kind: memory?.metadata.kind,
    memoryId: memory?.metadata.memoryId,
    relations: memoryRelations(memory),
    status: memory?.metadata.status,
    text,
    timestamp: memory?.metadata.timestamp,
    trust: boundedMemoryTrust(uri, memory?.metadata, {canonicalResource}),
    uri,
    validFrom: memory?.metadata.validFrom,
    validTo: memory?.metadata.validTo,
  };
}

/**
 * Exact search is a user-content surface, not a serialization search. Keep the
 * parsed body and intentional low-entropy discovery fields while excluding
 * machine headers such as citation IDs, hashes, snapshots, and repository IDs.
 */
function recallExactSearchText(candidate: RecallCandidate): string {
  const fields = candidate.fields;
  return normalizeRecallSearchText(
    redactSensitiveText(
      [
        candidate.text,
        fields?.title,
        fields?.topic,
        fields?.project,
        fields?.workspaceScope,
        ...(fields?.keywords ?? []),
      ]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join('\n'),
    ),
  );
}

function memoryRelations(memory: ReturnType<typeof parseMemoryDocument>): readonly MemoryRelation[] | undefined {
  if (!memory) {
    return undefined;
  }
  const relations: MemoryRelation[] = [
    ...(memory.metadata.relations ?? []),
    ...(memory.metadata.references ?? []).map(uri => ({type: 'references' as const, uri})),
    ...(memory.metadata.evidence ?? [])
      .filter(evidence => evidence.startsWith('threadnote://'))
      .map(uri => ({type: 'evidence_for' as const, uri})),
    ...(memory.metadata.supersedes ? [{type: 'supersedes' as const, uri: memory.metadata.supersedes}] : []),
  ];
  return relations.length > 0 ? relations : undefined;
}

function firstHeading(value: string): string | undefined {
  return /^#{1,3}\s+(.+)$/m.exec(value)?.[1]?.trim();
}

function resourceProject(uri: string): string | undefined {
  return /^threadnote:\/\/resources\/repos\/([^/]+)/.exec(uri)?.[1];
}

function uriTopic(uri: string): string {
  return uriBasename(uri).replace(/\.[a-z0-9]+$/i, '');
}

function uriBasename(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

function loadCanonicalResourcePolicy(
  config: RecallIndexConfig,
): Effect.Effect<CanonicalResourcePolicy, never, Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo> {
  const manifestPath = config.manifestPath;
  if (!manifestPath) {
    return Effect.succeed({entryKeyByUri: new Map(), sourcePathByUri: new Map()});
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const manifestRaw = yield* fs.readFileString(manifestPath);
    const manifest = yield* Effect.try({
      try: () => parseSeedManifest(manifestRaw, manifestPath),
      catch: cause =>
        RecallIndexOperationError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
    });
    const seedStateRaw = yield* fs.readFileString(pathService.join(config.agentContextHome, SEED_STATE_FILE));
    const seedState = yield* Effect.try({
      try: () => parseSeedState(seedStateRaw),
      catch: cause =>
        RecallIndexOperationError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
    });
    const entryKeyByUri = new Map<string, string>();
    const sourcePathByUri = new Map<string, string>();
    for (const [uri, recorded] of [...seedState].sort(([left], [right]) => left.localeCompare(right))) {
      const source = yield* resolveSeededResourceSource(fs, manifest.projects, uri, recorded);
      if (!source) {
        continue;
      }
      const match = seededResourceMatch(manifest.projects, uri);
      if (!match) {
        continue;
      }
      sourcePathByUri.set(uri, source);
      entryKeyByUri.set(
        uri,
        yield* sha256Hex(
          JSON.stringify({
            project: {
              path: yield* expandPath(match.project.path),
              seed: [...match.project.seed],
              uri: normalizedResourceRoot(match.project.uri),
            },
            recorded,
            source,
            uri,
          }),
        ),
      );
    }
    return {entryKeyByUri, sourcePathByUri};
  }).pipe(
    Effect.orElseSucceed(() => ({
      entryKeyByUri: new Map<string, string>(),
      sourcePathByUri: new Map<string, string>(),
    })),
  );
}

function parseSeedState(raw: string): ReadonlyMap<string, SeedStateEntry> {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('files' in value) ||
    typeof value.files !== 'object' ||
    value.files === null
  ) {
    return new Map();
  }
  const entries: Array<[string, SeedStateEntry]> = [];
  for (const [uri, entry] of Object.entries(value.files)) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'mtimeMs' in entry &&
      typeof entry.mtimeMs === 'number' &&
      Number.isFinite(entry.mtimeMs) &&
      'size' in entry &&
      typeof entry.size === 'number' &&
      Number.isFinite(entry.size)
    ) {
      entries.push([uri, {mtimeMs: entry.mtimeMs, size: entry.size}]);
    }
  }
  return new Map(entries);
}

function resolveSeededResourceSource(
  fs: FileSystem.FileSystem,
  projects: readonly ProjectManifest[],
  uri: string,
  recorded: SeedStateEntry,
): Effect.Effect<string | undefined, never, Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const match = seededResourceMatch(projects, uri);
    if (!match) {
      return undefined;
    }
    const projectRoot = yield* expandPath(match.project.path);
    const sourcePath = pathService.join(projectRoot, ...match.relativePath.split('/'));
    const relativeSourcePath = pathService.relative(projectRoot, sourcePath);
    if (
      relativeSourcePath === '' ||
      relativeSourcePath.startsWith(`..${pathService.sep}`) ||
      relativeSourcePath === '..' ||
      pathService.isAbsolute(relativeSourcePath)
    ) {
      return undefined;
    }
    const [realProjectRoot, realSourcePath, info] = yield* Effect.all([
      fs.realPath(projectRoot),
      fs.realPath(sourcePath),
      fs.stat(sourcePath),
    ]);
    const realRelativePath = pathService.relative(realProjectRoot, realSourcePath);
    if (
      realRelativePath.startsWith(`..${pathService.sep}`) ||
      realRelativePath === '..' ||
      pathService.isAbsolute(realRelativePath) ||
      info.type !== 'File' ||
      Number(info.size) !== recorded.size
    ) {
      return undefined;
    }
    const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
    if (modifiedAt === undefined || Math.abs(modifiedAt - recorded.mtimeMs) > SEED_FILE_MTIME_TOLERANCE_MILLISECONDS) {
      return undefined;
    }
    return sourcePath;
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function seededResourceMatch(
  projects: readonly ProjectManifest[],
  uri: string,
): {readonly project: ProjectManifest; readonly relativePath: string} | undefined {
  for (const project of projects) {
    const root = normalizedResourceRoot(project.uri);
    if (!uri.startsWith(`${root}/`)) {
      continue;
    }
    const relativePath = uri.slice(root.length + 1).replaceAll('\\', '/');
    if (
      relativePath.length === 0 ||
      relativePath.startsWith('/') ||
      relativePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
      !project.seed.some(pattern => globToRegExp(pattern.replaceAll('\\', '/')).test(relativePath))
    ) {
      continue;
    }
    return {project, relativePath};
  }
  return undefined;
}

function normalizedResourceRoot(uri: string): string {
  return stripRecallAnchor(uri).replace(/\/+$/, '');
}

function verifyCanonicalResource(
  fs: FileSystem.FileSystem,
  uri: string,
  indexedContent: string,
  policy: CanonicalResourcePolicy,
): Effect.Effect<boolean, never> {
  const sourcePath = policy.sourcePathByUri.get(uri);
  if (!sourcePath) {
    return Effect.succeed(false);
  }
  return fs.readFileString(sourcePath).pipe(
    Effect.map(sourceContent => sourceContent === indexedContent),
    Effect.orElseSucceed(() => false),
  );
}
