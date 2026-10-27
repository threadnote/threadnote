import {Clock, Effect, FileSystem, Path, Schema} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {
  loadExternalResourceAccess,
  externalResourceAccess,
  isExternalResourceUri,
} from '@threadnote/store/external-resource';
import {recallCandidateIsValid} from '../candidate_validation.js';
import {deduplicateLogicalRecallCandidates, recallCandidateLogicalCorpusKey, type RecallCandidate} from '../rank.js';
import {recallIndexCandidateIsEligible} from './candidate.js';
import {recallApprovedAuthoritative} from './eligibility.js';
import {
  recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh,
  recallIndexForegroundRefreshRequired,
} from './freshness.js';
import {
  createRecallIdentityConflictLoader,
  identityProjectionMetadataIsCurrent,
  markRecallIdentityConflicts,
  rebuildRecallIdentityConflicts,
} from './identity.js';
import {stripRecallAnchor} from './lexical.js';
import {normalizeRecallWorkspaceScope} from './scope.js';
import {normalizedRecallRecordedAt, selectRecallDocumentRowsByMemoryIds} from './selection.js';
import {clearRecallStaleMarkerInvalidations, readRecallStaleMarker} from './stale_marker.js';
import {
  assembleRecallSourceCandidate,
  loadCanonicalResourcePolicy,
  countRecallSourceChanges,
  dropRecallSourceScan,
  forEachChangedRecallSourcePage,
  recallIndexedProject,
  recallProjectionObservedChanges,
  RECALL_REFRESH_SOURCE_TABLE,
  scanRecallSources,
  type RecallRefreshConfig,
} from './refresh.js';

export class RecallIdentityLeaseError extends Schema.TaggedError<RecallIdentityLeaseError>()(
  'RecallIdentityLeaseError',
  {message: Schema.String},
) {}

export class RecallIdentityProjectionCorrupt extends Schema.TaggedError<RecallIdentityProjectionCorrupt>()(
  'RecallIdentityProjectionCorrupt',
  {message: Schema.String},
) {}

const STAGED = 'recall_identity_candidates';
const metadataFor = (sql: SqlClient.SqlClient) =>
  sql
    .unsafe<{readonly key: string; readonly value: string}>('SELECT key, value FROM metadata')
    .pipe(Effect.map(rows => new Map(rows.map(row => [row.key, row.value]))));

/** Independent derived baseline: same source universe/candidate assembler, no lexical publication. */
export const reconcileIdentityProjection = Effect.fn('recall.reconcileIdentityProjection')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  markerBase: string,
  config: RecallRefreshConfig,
  checked = false,
) {
  const metadata = yield* metadataFor(sql);
  const marker = yield* readRecallStaleMarker(fs, markerBase);
  const generation = yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account);
  const integrityCurrent = identityProjectionMetadataIsCurrent(metadata);
  if (checked && metadata.get('identity_initialized') === 'true' && !integrityCurrent)
    return yield* RecallIdentityLeaseError.make({message: 'Identity projection integrity changed inside CHECK.'});
  if (
    !recallIndexForegroundRefreshRequired({
      forceRefresh: false,
      initialized: metadata.get('identity_initialized') === 'true',
      integrityCurrent,
      sourceValidationRequired: metadata.get('identity_source_validation_required') === 'true',
      observedCanonicalMutationGeneration: generation,
      observedStaleGeneration: marker?.generation ?? '',
      persistedCanonicalMutationGeneration: metadata.get('identity_canonical_mutation_generation') ?? '',
      persistedStaleGeneration: metadata.get('identity_stale_generation') ?? '',
    })
  )
    return;
  const markerChanged = metadata.get('identity_stale_generation') !== (marker?.generation ?? '');
  const continuity = recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh({
    markerCurrentGeneration: marker?.canonicalMutationGeneration,
    markerPreviousGeneration: marker?.previousCanonicalMutationGeneration,
    observedGeneration: generation,
    persistedGeneration: metadata.get('identity_canonical_mutation_generation') ?? '',
  });
  const force =
    metadata.get('identity_initialized') !== 'true' ||
    !integrityCurrent ||
    metadata.get('identity_source_validation_required') === 'true' ||
    (markerChanged && marker?.forceRefresh === true) ||
    !continuity;
  const policy = yield* loadCanonicalResourcePolicy(config);
  const scan = yield* scanRecallSources(
    sql,
    fs,
    path,
    config,
    false,
    policy,
    new Set(markerChanged ? (marker?.invalidatedUris ?? []) : []),
    'identity',
  );
  yield* sql.unsafe(`DROP TABLE IF EXISTS temp.${STAGED}`);
  yield* sql.unsafe(`CREATE TEMP TABLE ${STAGED} (
    uri TEXT PRIMARY KEY NOT NULL, project TEXT, approved_authoritative INTEGER NOT NULL,
    workspace_scope TEXT, recorded_at TEXT, candidate_json TEXT NOT NULL, logical_key TEXT NOT NULL
  ) WITHOUT ROWID`);
  const counts = yield* countRecallSourceChanges(sql, force, 'identity');
  const hash = new Bun.CryptoHasher('sha256');
  hash.update(JSON.stringify(metadata.get('identity_content_generation') ?? null));
  const reconcile = Effect.gen(function* () {
    yield* forEachChangedRecallSourcePage(
      sql,
      force,
      page =>
        Effect.gen(function* () {
          const candidates = yield* Effect.forEach(
            page,
            source => assembleRecallSourceCandidate(fs, config, source, policy),
            {concurrency: 16},
          );
          yield* sql.unsafe(
            `INSERT INTO temp.${STAGED} (
        uri, project, approved_authoritative, workspace_scope, recorded_at, candidate_json, logical_key
      ) VALUES ${candidates.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
            candidates.flatMap(({candidate}) => {
              const json = JSON.stringify(candidate);
              hash.update(JSON.stringify([stripRecallAnchor(candidate.uri), json]));
              return [
                stripRecallAnchor(candidate.uri),
                recallIndexedProject(candidate),
                recallApprovedAuthoritative(candidate.authority, candidate.trust) ? 1 : 0,
                normalizeRecallWorkspaceScope(candidate.fields?.workspaceScope) ?? null,
                normalizedRecallRecordedAt(candidate.timestamp),
                json,
                recallCandidateLogicalCorpusKey(candidate),
              ];
            }),
          );
        }),
      'identity',
    );
    // Removed URIs affect the witness without decoding or hashing unchanged bodies.
    const removed = yield* sql.unsafe<{readonly uri: string}>(`SELECT d.uri FROM identity_documents AS d
      LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS s ON s.uri = d.uri WHERE s.uri IS NULL ORDER BY d.uri`);
    for (const row of removed) hash.update(JSON.stringify(row.uri));
    const contentGeneration =
      counts.changedSourceCount === 0 && counts.removedSourceCount === 0 && metadata.has('identity_content_generation')
        ? metadata.get('identity_content_generation')!
        : hash.digest('hex');
    const observedChanges = yield* recallProjectionObservedChanges(sql, 'identity');
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(`DELETE FROM identity_documents WHERE uri NOT IN (SELECT uri FROM temp.${RECALL_REFRESH_SOURCE_TABLE})
        OR uri IN (SELECT uri FROM temp.${STAGED})`);
        yield* sql.unsafe(`INSERT INTO identity_documents (
        uri, project, approved_authoritative, workspace_scope, source_path, source_modified_at,
        recorded_at, source_size, authority_policy_key, candidate_json, logical_key
      ) SELECT c.uri, c.project, c.approved_authoritative, c.workspace_scope, s.source_path,
        s.source_modified_at, c.recorded_at, s.source_size, s.authority_policy_key, c.candidate_json, c.logical_key
        FROM temp.${STAGED} AS c INNER JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS s ON s.uri = c.uri ORDER BY c.uri COLLATE BINARY`);
        yield* rebuildRecallIdentityConflicts(sql, 'identity');
        const values = [
          ['identity_initialized', 'true'],
          ['identity_canonical_mutation_generation', generation],
          ['identity_stale_generation', marker?.generation ?? ''],
          ['identity_content_generation', contentGeneration],
          ['identity_conflict_generation', contentGeneration],
          ['identity_source_validation_required', 'false'],
          ['identity_validated_at', String(yield* Clock.currentTimeMillis)],
        ];
        if (
          observedChanges &&
          metadata.get('initialized') === 'true' &&
          metadata.get('canonical_mutation_generation') === generation
        )
          values.push(['source_validation_required', 'true']);
        yield* sql.unsafe(
          `INSERT INTO metadata (key, value) VALUES ${values.map(() => '(?, ?)').join(', ')}
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          values.flat(),
        );
        yield* sql.unsafe(`INSERT INTO metadata (key, value) SELECT 'identity_integrity_sequence', value
        FROM metadata WHERE key = 'identity_mutation_sequence' ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      }),
    );
    yield* Effect.annotateCurrentSpan({
      'recall.identity.scannedSources': scan.scannedSourceCount,
      'recall.identity.changedSources': counts.changedSourceCount,
      'recall.identity.removedSources': counts.removedSourceCount,
      'recall.identity.forceAllSources': force,
    });
    if (markerChanged && marker) yield* clearRecallStaleMarkerInvalidations(fs, markerBase, marker).pipe(Effect.ignore);
  });
  yield* reconcile.pipe(
    Effect.ensuring(
      sql.unsafe(`DROP TABLE IF EXISTS temp.${STAGED}`).pipe(Effect.andThen(dropRecallSourceScan(sql)), Effect.ignore),
    ),
  );
});

export const selectIdentityProjection = Effect.fn('recall.selectIdentityProjection')(function* (
  sql: SqlClient.SqlClient,
  config: RecallRefreshConfig,
  options: {readonly memoryIds: readonly string[]; readonly allowedUriScopes: readonly string[]},
) {
  const location = {home: config.agentContextHome, account: config.account, user: config.user};
  const externalResources = yield* loadExternalResourceAccess(location);
  const eligibility = {
    kind: 'candidate-policy' as const,
    authority: 'any' as const,
    projects: {mode: 'unrestricted' as const},
    externalResources,
  };
  const rows = yield* selectRecallDocumentRowsByMemoryIds(
    sql,
    [...new Set(options.memoryIds)].sort(),
    options.allowedUriScopes,
    eligibility,
    'identity',
  );
  const candidates: RecallCandidate[] = [];
  for (const row of rows) {
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(row.candidate_json),
      catch: () => RecallIdentityProjectionCorrupt.make({message: 'Invalid identity candidate JSON.'}),
    });
    if (!recallCandidateIsValid(parsed) || stripRecallAnchor(parsed.uri) !== row.uri)
      return yield* RecallIdentityProjectionCorrupt.make({message: 'Invalid identity candidate.'});
    if (recallIndexCandidateIsEligible(eligibility, parsed)) candidates.push(parsed);
  }
  const logical = deduplicateLogicalRecallCandidates(candidates);
  const conflicts = yield* createRecallIdentityConflictLoader(sql, 'identity')(
    options.allowedUriScopes,
    eligibility,
    logical.flatMap(candidate => (candidate.memoryId ? [candidate.memoryId] : [])),
  );
  return yield* Effect.filter(markRecallIdentityConflicts(logical, conflicts), candidate =>
    isExternalResourceUri(candidate.uri)
      ? externalResourceAccess(location, candidate.uri, undefined, candidate.contentHash).pipe(
          Effect.map(access => access && candidate.authority === 'external' && candidate.trust === 'untrusted'),
        )
      : Effect.succeed(true),
  );
});
