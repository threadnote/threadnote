import {Clock, Crypto, DateTime, Effect, FileSystem, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {
  CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
  codeGraphQualifiedRefHandle,
  codeGraphWorksetContinuationHandle,
  type QualifiedCodeGraphRefV1,
} from '../workset/evidence.js';
import {codeGraphWorksetCatalogLayout} from './layout.js';
import {normalizeWorksetScopeReceipt, worksetScopeReceiptsMatch, type WorksetScopeRow} from './scope_receipt.js';
import {
  codeGraphWorksetCatalogGenerationDigest,
  codeGraphWorksetCatalogGenerationIdentity,
  codeGraphWorksetCatalogGenerationReceiptIdentity,
  codeGraphWorksetRoutingProjectionDigestAppendCanonical,
  codeGraphWorksetRoutingProjectionDigestStart,
  validateCodeGraphWorksetRoutingProjectionReceipt,
} from './projection.js';
import {
  codeGraphWorksetPersistedResultDigest,
  codeGraphWorksetResultSetId,
  decodeStoredCodeGraphWorksetResultCard,
  decodeStoredCodeGraphWorksetResultEnvelope,
  prepareCodeGraphWorksetResultEnvelope,
  prepareCodeGraphWorksetResultSequence,
} from './result_set.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogGenerationDigestMemberV1,
  type CodeGraphWorksetCatalogGenerationInputV1,
  type CodeGraphWorksetCatalogGenerationReceiptInputV1,
  type CodeGraphWorksetCatalogMaintenanceOptionsV1,
  type CodeGraphWorksetCatalogPublishedMemberV1,
  type CodeGraphWorksetCatalogRoutingSymbolCursorV1,
  type CodeGraphWorksetCatalogRoutingSymbolRecordV1,
  type CodeGraphWorksetResultSetInputV1,
  type CodeGraphWorksetResultSetMaintenanceOptionsV1,
  type CodeGraphWorksetResultSetPageV1,
  type CodeGraphWorksetResultSetRegistrationV1,
  type CodeGraphWorksetRoutingProjectionReceiptV1,
  type CodeGraphWorksetRoutingSymbolV1,
  type CodeGraphWorksetRoutingTermV1,
} from './types.js';

import {
  withCatalogWriter,
  withCatalogReader,
  selectProjectionForSnapshot,
  selectProjectionByDigest,
  projectionState,
  dropQueuedReferencedProjections,
  insertProjectionHeader,
  insertRoutingSymbol,
  loadAndValidateProjection,
  decodeProjectionMetadata,
  decodeRoutingSymbol,
  decodeQualifiedRef,
  validateResultSetIdentityInput,
  validateGenerationIdentity,
  validateResultSetGenerationForRegistration,
  validateResultSetReferences,
  decodeResultSetRow,
  storedResultSetSequenceReceipt,
  readStoredResultSetCursor,
  deleteExpiredResultSets,
  resultSetCapacity,
  loadGenerationMembers,
  selectGeneration,
  decodeGenerationRow,
  generationReceipt,
  generationIsPublished,
  initializeCatalogLayout,
  inspectCatalogLayout,
  removeCatalogFiles,
  rowCount,
  changes,
  currentIsoInstant,
  readLimit,
  retirementLimit,
  resultSetTtlMilliseconds,
  resultSetProjectorVersion,
  resultSetPageLimit,
  resultSetMaintenanceLimit,
  canonicalIso,
  optionalIsoInstant,
  requiredText,
  requiredInteger,
  requiredNumber,
  assertInputText,
  routingRowKey,
  validateInput,
  validateStored,
  mapCatalogError,
  invalid,
  corrupt,
} from './store_support.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_PROJECTION_PAGE_MAXIMUM,
  codeGraphWorksetRoutingProjectionLogicalBytes,
  codeGraphWorksetRoutingProjectionPages,
} from './projection/storage.js';
import {
  codeGraphWorksetCatalogWriteRequiredFreeBytes,
  verifyCodeGraphWorksetCatalogDiskCapacity,
} from './storage_capacity.js';
export {withCodeGraphWorksetCatalogReader, withCodeGraphWorksetCatalogWriter} from './store_support.js';

const CATALOG_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 30_000,
} as const;
export {CODE_GRAPH_WORKSET_CATALOG_PROJECTION_PAGE_MAXIMUM} from './projection/storage.js';
const GENERATION_ID = /^cgwg_[0-9a-f]{40}$/u;
const QUALIFIED_REF = /^cgr_[0-9a-f]{40}$/u;
const CONTINUATION_CURSOR = /^cgwc_[0-9a-f]{40}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const LOCAL_NODE_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PRODUCTION_MAINTENANCE_LIMIT = 32;
const STAGING_GENERATION_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const CATALOG_RECLAIM_ROW_BUDGET = 256;

interface GenerationRow {
  readonly generation_digest: unknown;
  readonly id: unknown;
  readonly manifest_digest: unknown;
  readonly member_count: unknown;
  readonly state: unknown;
  readonly workset_name: unknown;
}

interface GenerationMemberRow {
  readonly ordinal: unknown;
  readonly projection_digest: unknown;
  readonly repository_id: unknown;
  readonly repository_key: unknown;
  readonly snapshot_id: unknown;
  readonly worktree_id: unknown;
}

interface ProjectionRow extends WorksetScopeRow {
  readonly checkout_id: unknown;
  readonly commit_id: unknown;
  readonly component_count: unknown;
  readonly extractor_generation: unknown;
  readonly projection_digest: unknown;
  readonly projector_version: unknown;
  readonly repository_id: unknown;
  readonly snapshot_digest: unknown;
  readonly snapshot_id: unknown;
  readonly state: unknown;
  readonly symbol_count: unknown;
  readonly worktree_id: unknown;
}

interface RoutingSymbolRow {
  readonly exported: unknown;
  readonly kind: unknown;
  readonly language: unknown;
  readonly name: unknown;
  readonly node_id: unknown;
  readonly package_name: unknown;
  readonly path: unknown;
  readonly qualified_name: unknown;
  readonly span_column: unknown;
  readonly span_end_column: unknown;
  readonly span_end_line: unknown;
  readonly span_line: unknown;
}

interface RoutingLookupKeyRow {
  readonly lookup_key: unknown;
  readonly node_id: unknown;
}

interface RoutingTermRow {
  readonly node_id: unknown;
  readonly term: unknown;
  readonly weight: unknown;
}

interface QualifiedRefRow {
  readonly created_at: unknown;
  readonly node_id: unknown;
  readonly ref: unknown;
  readonly repository_id: unknown;
}

interface ResultSetRow {
  readonly card_count: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly envelope_bytes: unknown;
  readonly envelope_digest: unknown;
  readonly envelope_json: unknown;
  readonly generation_digest: unknown;
  readonly generation_id: unknown;
  readonly generation_state: unknown;
  readonly id: unknown;
  readonly offset: unknown;
  readonly projector_version: unknown;
  readonly result_set_token: unknown;
  readonly sequence_digest: unknown;
  readonly stored_generation_digest: unknown;
  readonly total_bytes: unknown;
  readonly workset_name: unknown;
}

interface ResultCardRow {
  readonly card_bytes: unknown;
  readonly card_digest: unknown;
  readonly card_id: unknown;
  readonly card_json: unknown;
  readonly ordinal: unknown;
  readonly qualified_ref: unknown;
  readonly repository_key: unknown;
}

export const ensureCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetCatalog.ensure')(function* (
  threadnoteHome: string,
) {
  yield* withCatalogWriter(threadnoteHome, () => Effect.void);
});

/** Create or reset one projection header before bounded symbol pages are appended. */
export const beginCodeGraphWorksetCatalogProjection = Effect.fn('codeGraphWorksetCatalog.beginProjection')(function* (
  threadnoteHome: string,
  input: CodeGraphWorksetRoutingProjectionReceiptV1,
  reservedLogicalBytes: number,
) {
  const receipt = yield* validateInput(() => {
    const validated = validateCodeGraphWorksetRoutingProjectionReceipt(input);
    if (
      !Number.isSafeInteger(reservedLogicalBytes) ||
      reservedLogicalBytes < 0 ||
      reservedLogicalBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.projectionBytesMaximum
    ) {
      throw invalid('Workset routing projection reservation is invalid.');
    }
    return validated;
  });
  const crypto = yield* Crypto.Crypto;
  const stagingToken = sha256HexSync(yield* crypto.randomBytes(32));
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
  return yield* withCatalogWriter(threadnoteHome, sql =>
    Effect.gen(function* () {
      const now = yield* currentIsoInstant;
      const existing = yield* selectProjectionForSnapshot(sql, receipt);
      if (existing !== undefined) {
        if (
          existing.projection_digest !== receipt.projectionDigest ||
          !worksetScopeReceiptsMatch(existing.scope, receipt)
        ) {
          return yield* invalid('A ready snapshot produced different records for the same projector version.');
        }
        if (existing.state === 'ready') {
          yield* loadAndValidateProjection(sql, receipt.projectionDigest, true);
          return {receipt, state: 'ready' as const};
        }
        return yield* CodeGraphWorksetCatalogError.of(
          existing.state === 'reclaiming' ? 'capacity' : 'busy',
          existing.state === 'reclaiming'
            ? 'Routing projection cleanup must finish before restaging.'
            : 'Another routing projection stream is already staging this snapshot.',
        );
      }
      yield* verifyCodeGraphWorksetCatalogDiskCapacity(
        target => system.availableDiskBytes(target),
        layout.root,
        codeGraphWorksetCatalogWriteRequiredFreeBytes(reservedLogicalBytes, receipt.symbolCount),
        'routing projection reservation',
      );
      yield* insertProjectionHeader(sql, receipt, now, reservedLogicalBytes, stagingToken);
      return {receipt, stagingToken, state: 'staging' as const};
    }),
  );
});

/** Append one canonical bounded symbol page in a short catalog transaction. */
export const appendCodeGraphWorksetCatalogProjectionPage = Effect.fn('codeGraphWorksetCatalog.appendProjectionPage')(
  function* (
    threadnoteHome: string,
    input: {
      readonly projectionDigest: string;
      readonly stagingToken: string;
      readonly symbols: readonly CodeGraphWorksetRoutingSymbolV1[];
    },
  ) {
    const pageBytes = yield* validateInput(() => {
      if (!SHA256_HEX.test(input.projectionDigest)) throw invalid('Workset projection digest is invalid.');
      if (!SHA256_HEX.test(input.stagingToken)) throw invalid('Workset projection staging token is invalid.');
      if (input.symbols.length < 1 || input.symbols.length > CODE_GRAPH_WORKSET_CATALOG_PROJECTION_PAGE_MAXIMUM) {
        throw invalid('Workset projection page size is invalid.');
      }
      codeGraphWorksetRoutingProjectionDigestAppendCanonical(
        codeGraphWorksetRoutingProjectionDigestStart(),
        input.symbols,
      );
      const bytes = codeGraphWorksetRoutingProjectionLogicalBytes(input.symbols);
      if (bytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.projectionPageBytesMaximum) {
        throw CodeGraphWorksetCatalogError.of(
          'capacity',
          'Workset routing projection page exceeds the supported aggregate byte bound.',
        );
      }
      return bytes;
    });
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
    yield* verifyCodeGraphWorksetCatalogDiskCapacity(
      target => system.availableDiskBytes(target),
      layout.root,
      codeGraphWorksetCatalogWriteRequiredFreeBytes(pageBytes, input.symbols.length),
      'routing projection page',
    );
    yield* withCatalogWriter(threadnoteHome, sql =>
      sql.withTransaction(
        Effect.gen(function* () {
          const state = yield* projectionState(sql, input.projectionDigest);
          if (state !== 'staging') {
            return yield* CodeGraphWorksetCatalogError.of('stale', 'Projection staging is not active.');
          }
          yield* sql.unsafe(
            `UPDATE routing_projection_storage
             SET logical_bytes = logical_bytes + ?
             WHERE projection_digest = ? AND staging_token = ?
               AND logical_bytes <= reserved_bytes - ?`,
            [pageBytes, input.projectionDigest, input.stagingToken, pageBytes],
          );
          if ((yield* changes(sql)) !== 1) {
            const receipts = yield* sql.unsafe<{
              readonly logical_bytes: unknown;
              readonly staging_token: unknown;
            }>(
              `SELECT logical_bytes, staging_token FROM routing_projection_storage
               WHERE projection_digest = ? LIMIT 1`,
              [input.projectionDigest],
            );
            if (receipts.length === 0) {
              return yield* corrupt('Routing projection storage receipt is missing.');
            }
            if (receipts[0].staging_token !== input.stagingToken) {
              return yield* CodeGraphWorksetCatalogError.of('stale', 'Routing projection staging ownership changed.');
            }
            return yield* CodeGraphWorksetCatalogError.of(
              'capacity',
              'Workset routing projection exceeds the supported aggregate byte bound.',
            );
          }
          yield* Effect.forEach(input.symbols, symbol => insertRoutingSymbol(sql, input.projectionDigest, symbol), {
            concurrency: 1,
            discard: true,
          });
        }),
      ),
    );
  },
);

/** Recompute streamed integrity and make one fully appended projection eligible for a generation. */
export const completeCodeGraphWorksetCatalogProjection = Effect.fn('codeGraphWorksetCatalog.completeProjection')(
  function* (threadnoteHome: string, input: {readonly projectionDigest: string; readonly stagingToken: string}) {
    yield* validateInput(() => {
      if (!SHA256_HEX.test(input.projectionDigest)) throw invalid('Workset projection digest is invalid.');
      if (!SHA256_HEX.test(input.stagingToken)) throw invalid('Workset projection staging token is invalid.');
    });
    return yield* withCatalogWriter(threadnoteHome, sql =>
      Effect.gen(function* () {
        const ownership = yield* sql.unsafe<{
          readonly staging_token: unknown;
          readonly state: unknown;
        }>(
          `SELECT p.state, s.staging_token
           FROM repository_snapshots AS p
           JOIN routing_projection_storage AS s USING (projection_digest)
           WHERE p.projection_digest = ? LIMIT 1`,
          [input.projectionDigest],
        );
        if (ownership.length !== 1) {
          return yield* CodeGraphWorksetCatalogError.of('stale', 'Projection staging is not active.');
        }
        if (ownership[0].state === 'ready') {
          return (yield* loadAndValidateProjection(sql, input.projectionDigest, true)).receipt;
        }
        if (ownership[0].state !== 'staging' || ownership[0].staging_token !== input.stagingToken) {
          return yield* CodeGraphWorksetCatalogError.of('stale', 'Routing projection staging ownership changed.');
        }
        const projection = yield* loadAndValidateProjection(sql, input.projectionDigest);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const storage = yield* sql.unsafe<{
              readonly logical_bytes: unknown;
              readonly reserved_bytes: unknown;
              readonly staging_token: unknown;
            }>(
              `SELECT logical_bytes, reserved_bytes, staging_token FROM routing_projection_storage
               WHERE projection_digest = ? AND staging_token = ?
               LIMIT 1`,
              [input.projectionDigest, input.stagingToken],
            );
            if (storage.length !== 1) {
              return yield* CodeGraphWorksetCatalogError.of('stale', 'Routing projection staging ownership changed.');
            }
            if (
              requiredInteger(storage[0].logical_bytes, 'routing projection logical bytes') !==
              requiredInteger(storage[0].reserved_bytes, 'routing projection reserved bytes')
            ) {
              return yield* corrupt('Routing projection storage reservation is incomplete.');
            }
            yield* sql.unsafe(
              `UPDATE repository_snapshots SET state = 'ready'
               WHERE projection_digest = ? AND state = 'staging'`,
              [input.projectionDigest],
            );
            if ((yield* changes(sql)) !== 1) {
              return yield* corrupt('Routing projection publication lost its staging state.');
            }
            yield* sql.unsafe(
              `UPDATE routing_projection_storage SET staging_token = NULL
               WHERE projection_digest = ? AND staging_token = ?`,
              [input.projectionDigest, input.stagingToken],
            );
            if ((yield* changes(sql)) !== 1) {
              return yield* corrupt('Routing projection staging ownership changed before publication.');
            }
          }),
        );
        return projection.receipt;
      }),
    );
  },
);

/**
 * Materialize repository projections under a durable staging generation. Each
 * projection is committed independently, while published readers continue to
 * resolve only the existing generation pointer.
 */
export const stageCodeGraphWorksetCatalogGeneration = Effect.fn('codeGraphWorksetCatalog.stageGeneration')(function* (
  threadnoteHome: string,
  input: CodeGraphWorksetCatalogGenerationInputV1,
) {
  const identity = yield* validateInput(() => codeGraphWorksetCatalogGenerationIdentity(input));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
  const ownedProjectionDigests: string[] = [];
  const critical = Effect.gen(function* () {
    yield* drainCodeGraphWorksetCatalogPreparationPages(threadnoteHome);
    const members: CodeGraphWorksetCatalogGenerationDigestMemberV1[] = [];
    for (const member of identity.members) {
      const projection = member.projection;
      const projectionReceipt = {
        ...normalizeWorksetScopeReceipt(projection),
        checkoutId: projection.checkoutId,
        commitId: projection.commitId,
        componentCount: projection.componentCount,
        extractorGeneration: projection.extractorGeneration,
        projectionDigest: projection.projectionDigest,
        projectorVersion: projection.projectorVersion,
        repositoryId: projection.repositoryId,
        snapshotDigest: projection.snapshotDigest,
        snapshotId: projection.snapshotId,
        symbolCount: projection.symbols.length,
        worktreeId: projection.worktreeId,
      } satisfies CodeGraphWorksetRoutingProjectionReceiptV1;
      const reservation = codeGraphWorksetRoutingProjectionLogicalBytes(projection.symbols);
      const staged = yield* beginCodeGraphWorksetCatalogProjection(threadnoteHome, projectionReceipt, reservation);
      if (staged.state === 'staging') {
        ownedProjectionDigests.push(projection.projectionDigest);
        yield* appendFullProjectionPages(
          threadnoteHome,
          projection.projectionDigest,
          staged.stagingToken,
          projection.symbols,
        );
        yield* completeCodeGraphWorksetCatalogProjection(threadnoteHome, {
          projectionDigest: projection.projectionDigest,
          stagingToken: staged.stagingToken,
        });
      }
      members.push({
        ...normalizeWorksetScopeReceipt(projection),
        projectionDigest: projection.projectionDigest,
        repositoryId: projection.repositoryId,
        repositoryKey: member.repositoryKey,
        snapshotId: projection.snapshotId,
      });
    }
    return yield* stageCodeGraphWorksetCatalogGenerationFromReceipts(threadnoteHome, {
      manifestDigest: input.manifestDigest,
      members,
      worksetName: input.worksetName,
    });
  }).pipe(
    Effect.onError(() =>
      retireCodeGraphWorksetCatalogPreparation(threadnoteHome, {
        projectionDigests: ownedProjectionDigests,
      }).pipe(Effect.andThen(drainCodeGraphWorksetCatalogPreparationPages(threadnoteHome)), Effect.ignoreCause),
    ),
  );
  return yield* withExclusiveFileLock(fs, layout.prepareLockPath, CATALOG_LOCK_OPTIONS, critical).pipe(
    mapCatalogError('serialize workset catalog preparation'),
  );
});

function appendFullProjectionPages(
  threadnoteHome: string,
  projectionDigest: string,
  stagingToken: string,
  symbols: readonly CodeGraphWorksetRoutingSymbolV1[],
) {
  return Effect.gen(function* () {
    for (const page of codeGraphWorksetRoutingProjectionPages(symbols)) {
      yield* appendCodeGraphWorksetCatalogProjectionPage(threadnoteHome, {
        projectionDigest,
        stagingToken,
        symbols: page,
      });
    }
  });
}

/** Stage a deterministic generation from lightweight, already-streamed projection receipts. */
export const stageCodeGraphWorksetCatalogGenerationFromReceipts = Effect.fn(
  'codeGraphWorksetCatalog.stageGenerationFromReceipts',
)(function* (threadnoteHome: string, input: CodeGraphWorksetCatalogGenerationReceiptInputV1) {
  const identity = yield* validateInput(() => codeGraphWorksetCatalogGenerationReceiptIdentity(input));
  return yield* withCatalogWriter(threadnoteHome, sql =>
    Effect.gen(function* () {
      const now = yield* currentIsoInstant;
      const existing = yield* selectGeneration(sql, identity.id);
      if (existing?.state === 'ready') {
        if (!(yield* generationIsPublished(sql, identity.id, input.worksetName))) {
          return yield* corrupt('A ready workset generation has no matching published pointer.');
        }
        return generationReceipt(existing);
      }
      if (existing?.state === 'staging') {
        const stagedMembers = yield* loadGenerationMembers(sql, identity.id);
        const matches =
          stagedMembers.length === identity.members.length &&
          stagedMembers.every((member, ordinal) => {
            const expected = identity.members[ordinal];
            return (
              expected !== undefined &&
              member.repository_key === expected.repositoryKey &&
              member.repository_id === expected.repositoryId &&
              member.snapshot_id === expected.snapshotId &&
              worksetScopeReceiptsMatch(member, expected) &&
              member.projection_digest === expected.projectionDigest
            );
          });
        if (!matches) return yield* corrupt('An existing staging generation is incomplete.');
        return generationReceipt(existing);
      }
      if (existing?.state === 'retired') {
        return yield* CodeGraphWorksetCatalogError.of(
          'capacity',
          'Retired catalog cleanup must finish before restaging.',
        );
      }
      for (const member of identity.members) {
        const projection = yield* selectProjectionByDigest(sql, member.projectionDigest);
        if (
          projection === undefined ||
          projection.state !== 'ready' ||
          projection.repository_id !== member.repositoryId ||
          projection.snapshot_id !== member.snapshotId ||
          !worksetScopeReceiptsMatch(projection.scope, member)
        ) {
          return yield* CodeGraphWorksetCatalogError.of(
            'missing',
            'A streamed workset projection is not ready for staging.',
          );
        }
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(
            `INSERT INTO workset_generations (
               id, workset_name, manifest_digest, generation_digest, state,
               member_count, created_at, published_at
             ) VALUES (?, ?, ?, ?, 'staging', ?, ?, NULL)`,
            [identity.id, input.worksetName, input.manifestDigest, identity.digest, identity.members.length, now],
          );
          for (let ordinal = 0; ordinal < identity.members.length; ordinal += 1) {
            const member = identity.members[ordinal];
            yield* sql.unsafe(
              `INSERT INTO workset_generation_members (
                 generation_id, ordinal, repository_key, repository_id, snapshot_id, projection_digest
               ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                identity.id,
                ordinal,
                member.repositoryKey,
                member.repositoryId,
                member.snapshotId,
                member.projectionDigest,
              ],
            );
            yield* sql.unsafe('DELETE FROM routing_projection_retirements WHERE projection_digest = ?', [
              member.projectionDigest,
            ]);
          }
        }),
      );
      const receipt = {
        digest: identity.digest,
        id: identity.id,
        manifestDigest: input.manifestDigest,
        memberCount: identity.members.length,
        state: 'staging' as const,
        worksetName: input.worksetName,
      };
      return receipt;
    }),
  );
});

/** @internal Retire one serialized prepare attempt without cascading heavy payload. */
export const retireCodeGraphWorksetCatalogPreparation = Effect.fn('codeGraphWorksetCatalog.retirePreparation')(
  function* (
    threadnoteHome: string,
    input: {readonly generationId?: string; readonly projectionDigests: readonly string[]},
  ) {
    yield* validateInput(() => {
      if (input.generationId !== undefined && !GENERATION_ID.test(input.generationId)) {
        throw invalid('Workset catalog generation identity is invalid.');
      }
      if (input.projectionDigests.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration) {
        throw invalid('Workset catalog projection retirement exceeds the supported bound.');
      }
      const unique = new Set(input.projectionDigests);
      if (
        unique.size !== input.projectionDigests.length ||
        input.projectionDigests.some(digest => !SHA256_HEX.test(digest))
      ) {
        throw invalid('Workset catalog projection retirement identity is invalid.');
      }
    });
    const now = yield* currentIsoInstant;
    yield* withCatalogWriter(threadnoteHome, sql =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (input.generationId !== undefined) {
            yield* discardStagingGenerationWithSql(sql, input.generationId);
          }
          for (const projectionDigest of input.projectionDigests) {
            yield* queueProjectionRetirement(sql, projectionDigest, now);
          }
          yield* markQueuedOrphanProjectionsRetiring(sql, input.projectionDigests.length);
          yield* dropQueuedReferencedProjections(sql, input.projectionDigests.length);
        }),
      ),
    );
  },
);

/** Atomically replace one workset's published pointer after validating every staged projection receipt. */
export const publishCodeGraphWorksetCatalogGeneration = Effect.fn('codeGraphWorksetCatalog.publishGeneration')(
  function* <E = never, R = never>(
    threadnoteHome: string,
    input: {
      /** Final lease/snapshot guard run under the writer lock before the pointer transaction. */
      readonly beforePointerSwap?: () => Effect.Effect<void, E, R>;
      readonly generationId: string;
      readonly worksetName: string;
    },
  ) {
    yield* validateInput(() => {
      if (!GENERATION_ID.test(input.generationId)) throw invalid('Workset catalog generation identity is invalid.');
      assertInputText(input.worksetName, 'workset name', 256);
    });
    return yield* withCatalogWriter(threadnoteHome, sql =>
      Effect.gen(function* () {
        const generation = yield* selectGeneration(sql, input.generationId);
        if (generation === undefined || generation.workset_name !== input.worksetName) {
          return yield* CodeGraphWorksetCatalogError.of(
            'missing',
            'The staged workset catalog generation does not exist.',
          );
        }
        if (generation.state === 'ready') {
          if (!(yield* generationIsPublished(sql, input.generationId, input.worksetName))) {
            return yield* corrupt('A ready workset generation has no matching published pointer.');
          }
          return generationReceipt(generation);
        }
        if (generation.state !== 'staging') {
          return yield* CodeGraphWorksetCatalogError.of(
            'invalid-input',
            'A retired workset generation cannot be published.',
          );
        }
        const members = yield* loadGenerationMembers(sql, input.generationId);
        if (members.length !== generation.member_count) {
          return yield* corrupt('Staged workset generation is incomplete.');
        }
        const digestMembers: CodeGraphWorksetCatalogGenerationDigestMemberV1[] = [];
        for (const member of members) {
          // Projection validation can read a complete repository projection,
          // so it intentionally runs before the short pointer transaction.
          // The home-global writer lock fences every supported catalog writer.
          const projection = yield* loadAndValidateProjection(sql, member.projection_digest, true);
          if (
            projection.receipt.repositoryId !== member.repository_id ||
            projection.receipt.snapshotId !== member.snapshot_id
          ) {
            return yield* corrupt('A staged workset member does not match its routing projection.');
          }
          digestMembers.push({
            ...normalizeWorksetScopeReceipt(projection.receipt),
            projectionDigest: projection.receipt.projectionDigest,
            repositoryId: projection.receipt.repositoryId,
            repositoryKey: member.repository_key,
            snapshotId: projection.receipt.snapshotId,
          });
        }
        const digest = yield* validateInput(() =>
          codeGraphWorksetCatalogGenerationDigest(generation.workset_name, generation.manifest_digest, digestMembers),
        );
        if (digest !== generation.generation_digest || `cgwg_${digest.slice(0, 40)}` !== generation.id) {
          return yield* corrupt('Staged workset generation digest validation failed.');
        }
        if (input.beforePointerSwap !== undefined) yield* input.beforePointerSwap();
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const fenced = yield* selectGeneration(sql, input.generationId);
            if (
              fenced === undefined ||
              fenced.state !== 'staging' ||
              fenced.generation_digest !== digest ||
              fenced.member_count !== members.length
            ) {
              return yield* corrupt('Workset generation changed before pointer publication.');
            }
            const now = yield* currentIsoInstant;
            yield* sql.unsafe(
              `UPDATE workset_generations
             SET state = 'retired'
             WHERE id = (
               SELECT generation_id FROM published_worksets WHERE workset_name = ?
             ) AND id <> ?`,
              [input.worksetName, input.generationId],
            );
            yield* sql.unsafe(
              `UPDATE workset_generations
             SET state = 'ready', published_at = ?
             WHERE id = ? AND state = 'staging'`,
              [now, input.generationId],
            );
            if ((yield* changes(sql)) !== 1) {
              return yield* corrupt('Workset generation publication lost its staging state.');
            }
            yield* sql.unsafe(
              `INSERT INTO published_worksets (workset_name, generation_id, published_at)
             VALUES (?, ?, ?)
             ON CONFLICT(workset_name) DO UPDATE SET
               generation_id = excluded.generation_id,
               published_at = excluded.published_at`,
              [input.worksetName, input.generationId, now],
            );
            return {...generationReceipt(generation), state: 'ready' as const};
          }),
        );
      }),
    );
  },
);

/**
 * Remove one manifest-deleted/renamed workset publication without touching any
 * repository snapshot. Heavy derived payload is reclaimed in bounded pages.
 */
export const retireCodeGraphWorksetPublication = Effect.fn('codeGraphWorksetCatalog.retirePublication')(function* (
  threadnoteHome: string,
  input: {readonly generationId: string; readonly worksetName: string},
) {
  yield* validateInput(() => {
    assertInputText(input.worksetName, 'workset name', 256);
    if (!GENERATION_ID.test(input.generationId)) throw invalid('Workset catalog generation identity is invalid.');
  });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
  return yield* withExclusiveFileLock(
    fs,
    layout.prepareLockPath,
    CATALOG_LOCK_OPTIONS,
    Effect.gen(function* () {
      const retired = yield* withCatalogWriter(threadnoteHome, sql =>
        sql.withTransaction(
          Effect.gen(function* () {
            const pointers = yield* sql.unsafe<{readonly generation_id: unknown}>(
              `SELECT generation_id FROM published_worksets
               WHERE workset_name = ? AND generation_id = ? LIMIT 1`,
              [input.worksetName, input.generationId],
            );
            if (pointers.length === 0) return false;
            const generationId = requiredText(pointers[0].generation_id, 'published generation identity');
            yield* sql.unsafe('DELETE FROM published_worksets WHERE workset_name = ? AND generation_id = ?', [
              input.worksetName,
              generationId,
            ]);
            if ((yield* changes(sql)) !== 1) {
              return yield* corrupt('Published workset pointer changed during retirement.');
            }
            yield* sql.unsafe(
              `UPDATE workset_generations SET state = 'retired'
                 WHERE id = ? AND workset_name = ? AND state = 'ready'
                   AND NOT EXISTS (
                     SELECT 1 FROM published_worksets AS p WHERE p.generation_id = workset_generations.id
                   )`,
              [generationId, input.worksetName],
            );
            if ((yield* changes(sql)) !== 1) {
              return yield* corrupt('Published workset generation changed during retirement.');
            }
            return true;
          }),
        ),
      );
      if (!retired) return {cleanupPending: false, retired};
      const maintenance = yield* maintainCodeGraphWorksetCatalogPreparationPage(threadnoteHome);
      return {cleanupPending: maintenance.pendingCleanup, retired};
    }),
  ).pipe(mapCatalogError('retire workset catalog publication'));
});

export const readPublishedCodeGraphWorksetCatalogGeneration = Effect.fn(
  'codeGraphWorksetCatalog.readPublishedGeneration',
)(function* (threadnoteHome: string, worksetName: string) {
  yield* validateInput(() => assertInputText(worksetName, 'workset name', 256));
  return yield* withCatalogReader(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<GenerationRow>(
          `SELECT g.id, g.workset_name, g.manifest_digest, g.generation_digest, g.state, g.member_count
           FROM published_worksets AS p
           JOIN workset_generations AS g ON g.id = p.generation_id
           WHERE p.workset_name = ? AND g.state = 'ready'
           LIMIT 1`,
          [worksetName],
        );
        if (rows.length === 0) return undefined;
        const generation = yield* decodeGenerationRow(rows[0]);
        const memberRows = yield* loadGenerationMembers(sql, generation.id);
        if (memberRows.length !== generation.member_count) {
          return yield* corrupt('Published workset generation is incomplete.');
        }
        const members: CodeGraphWorksetCatalogPublishedMemberV1[] = [];
        for (const member of memberRows) {
          const projections = yield* sql.unsafe<ProjectionRow>(
            `SELECT *
             FROM repository_snapshots
             WHERE projection_digest = ? AND state = 'ready'
             LIMIT 1`,
            [member.projection_digest],
          );
          if (projections.length !== 1) {
            return yield* corrupt('Published workset projection is missing.');
          }
          const projection = yield* decodeProjectionMetadata(projections[0]);
          if (projection.repository_id !== member.repository_id || projection.snapshot_id !== member.snapshot_id) {
            return yield* corrupt('Published Workset member identity does not match its projection.');
          }
          members.push({
            ...projection.scope,
            checkoutId: projection.checkout_id,
            commitId: projection.commit_id,
            ordinal: member.ordinal,
            projectionDigest: projection.projection_digest,
            repositoryId: projection.repository_id,
            repositoryKey: member.repository_key,
            snapshotDigest: projection.snapshot_digest,
            snapshotId: projection.snapshot_id,
            symbolCount: projection.symbol_count,
            worktreeId: projection.worktree_id,
          });
        }
        const digest = yield* validateStored(() =>
          codeGraphWorksetCatalogGenerationDigest(generation.workset_name, generation.manifest_digest, members),
        );
        if (digest !== generation.generation_digest)
          return yield* corrupt('Published Workset scope receipts do not match their generation.');
        return {
          digest: generation.generation_digest,
          id: generation.id,
          manifestDigest: generation.manifest_digest,
          members,
          worksetName: generation.workset_name,
        };
      }),
    ),
  );
});

/** Bounded deterministic keyset read for future global routing queries. */
export const readCodeGraphWorksetCatalogRoutingSymbols = Effect.fn('codeGraphWorksetCatalog.readRoutingSymbols')(
  function* (
    threadnoteHome: string,
    input: {
      readonly after?: CodeGraphWorksetCatalogRoutingSymbolCursorV1;
      readonly limit?: number;
      readonly worksetName: string;
    },
  ) {
    const limit = yield* validateInput(() => readLimit(input.limit));
    yield* validateInput(() => {
      assertInputText(input.worksetName, 'workset name', 256);
      if (input.after !== undefined) {
        if (
          !Number.isSafeInteger(input.after.ordinal) ||
          input.after.ordinal < 0 ||
          !LOCAL_NODE_ID.test(input.after.nodeId)
        ) {
          throw invalid('Workset catalog routing cursor is invalid.');
        }
      }
    });
    return yield* withCatalogReader(threadnoteHome, sql =>
      sql.withTransaction(
        Effect.gen(function* () {
          const generationRows = yield* sql.unsafe<{readonly generation_id: unknown}>(
            `SELECT p.generation_id
           FROM published_worksets AS p
           JOIN workset_generations AS g ON g.id = p.generation_id
           WHERE p.workset_name = ? AND g.state = 'ready'
           LIMIT 1`,
            [input.worksetName],
          );
          if (generationRows.length === 0) return undefined;
          const generationId = requiredText(generationRows[0].generation_id, 'published generation identity');
          const afterOrdinal = input.after?.ordinal ?? -1;
          const afterNodeId = input.after?.nodeId ?? '';
          const selectionSql = `
          SELECT m.ordinal, m.repository_key, m.repository_id, m.snapshot_id, m.projection_digest,
                 s.node_id, s.kind, s.language, s.exported, s.package_name, s.path,
                 s.name, s.qualified_name, s.span_line, s.span_column, s.span_end_line,
                 s.span_end_column
          FROM workset_generation_members AS m
          JOIN routing_symbols AS s ON s.projection_digest = m.projection_digest
          WHERE m.generation_id = ?
            AND (m.ordinal > ? OR (m.ordinal = ? AND s.node_id > ?))
          ORDER BY m.ordinal, s.node_id
          LIMIT ?`;
          const rows = yield* sql.unsafe<GenerationMemberRow & RoutingSymbolRow>(selectionSql, [
            generationId,
            afterOrdinal,
            afterOrdinal,
            afterNodeId,
            limit + 1,
          ]);
          const visible = rows.slice(0, limit);
          const terms =
            visible.length === 0
              ? []
              : yield* sql.unsafe<RoutingTermRow & {readonly ordinal: unknown}>(
                  `WITH selected AS (
                   SELECT m.ordinal, m.projection_digest, s.node_id
                   FROM workset_generation_members AS m
                   JOIN routing_symbols AS s ON s.projection_digest = m.projection_digest
                   WHERE m.generation_id = ?
                     AND (m.ordinal > ? OR (m.ordinal = ? AND s.node_id > ?))
                   ORDER BY m.ordinal, s.node_id
                   LIMIT ?
                 )
                 SELECT selected.ordinal, selected.node_id, t.term, t.weight
                 FROM selected
                 JOIN routing_terms AS t
                   ON t.projection_digest = selected.projection_digest AND t.node_id = selected.node_id
                 ORDER BY selected.ordinal, selected.node_id, t.term
                 LIMIT ?`,
                  [
                    generationId,
                    afterOrdinal,
                    afterOrdinal,
                    afterNodeId,
                    limit,
                    limit * CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol + 1,
                  ],
                );
          const lookupKeys =
            visible.length === 0
              ? []
              : yield* sql.unsafe<RoutingLookupKeyRow & {readonly ordinal: unknown}>(
                  `WITH selected AS (
                   SELECT m.ordinal, m.projection_digest, s.node_id
                   FROM workset_generation_members AS m
                   JOIN routing_symbols AS s ON s.projection_digest = m.projection_digest
                   WHERE m.generation_id = ?
                     AND (m.ordinal > ? OR (m.ordinal = ? AND s.node_id > ?))
                   ORDER BY m.ordinal, s.node_id
                   LIMIT ?
                 )
                 SELECT selected.ordinal, selected.node_id, k.lookup_key
                 FROM selected
                 JOIN routing_lookup_keys AS k
                   ON k.projection_digest = selected.projection_digest AND k.node_id = selected.node_id
                 ORDER BY selected.ordinal, selected.node_id, k.lookup_key
                 LIMIT ?`,
                  [
                    generationId,
                    afterOrdinal,
                    afterOrdinal,
                    afterNodeId,
                    limit,
                    limit * CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol + 1,
                  ],
                );
          if (terms.length > limit * CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol) {
            return yield* corrupt('Routing symbol term count exceeds the supported bound.');
          }
          if (lookupKeys.length > limit * CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol) {
            return yield* corrupt('Routing symbol lookup-key count exceeds the supported bound.');
          }
          const termsBySymbol = new Map<string, CodeGraphWorksetRoutingTermV1[]>();
          for (const row of terms) {
            const key = routingRowKey(
              requiredInteger(row.ordinal, 'routing ordinal'),
              requiredText(row.node_id, 'node identity'),
            );
            const entries = termsBySymbol.get(key) ?? [];
            entries.push({
              term: requiredText(row.term, 'routing term'),
              weight: requiredNumber(row.weight, 'term weight'),
            });
            termsBySymbol.set(key, entries);
          }
          const lookupKeysBySymbol = new Map<string, string[]>();
          for (const row of lookupKeys) {
            const key = routingRowKey(
              requiredInteger(row.ordinal, 'routing ordinal'),
              requiredText(row.node_id, 'node identity'),
            );
            const entries = lookupKeysBySymbol.get(key) ?? [];
            entries.push(requiredText(row.lookup_key, 'lookup key'));
            lookupKeysBySymbol.set(key, entries);
          }
          const symbols: CodeGraphWorksetCatalogRoutingSymbolRecordV1[] = [];
          for (const row of visible) {
            const ordinal = requiredInteger(row.ordinal, 'routing ordinal');
            const nodeId = requiredText(row.node_id, 'node identity');
            const key = routingRowKey(ordinal, nodeId);
            const symbol = yield* decodeRoutingSymbol(
              row,
              lookupKeysBySymbol.get(key) ?? [],
              termsBySymbol.get(key) ?? [],
            );
            symbols.push({
              ...symbol,
              ordinal,
              projectionDigest: requiredText(row.projection_digest, 'projection digest'),
              repositoryId: requiredText(row.repository_id, 'repository identity'),
              repositoryKey: requiredText(row.repository_key, 'repository key'),
              snapshotId: requiredText(row.snapshot_id, 'snapshot identity'),
            });
          }
          const last = symbols.at(-1);
          return {
            generationId,
            ...(rows.length > limit && last !== undefined ? {next: {nodeId: last.nodeId, ordinal: last.ordinal}} : {}),
            symbols,
            worksetName: input.worksetName,
          };
        }),
      ),
    );
  },
);

/** Verify that one stable node belongs to an exact published projection surface. */
export const codeGraphWorksetCatalogProjectionContainsNode = Effect.fn(
  'codeGraphWorksetCatalog.projectionContainsNode',
)(function* (threadnoteHome: string, input: {readonly nodeId: string; readonly projectionDigest: string}) {
  yield* validateInput(() => {
    if (!LOCAL_NODE_ID.test(input.nodeId)) throw invalid('Workset projection node identity is invalid.');
    if (!SHA256_HEX.test(input.projectionDigest)) throw invalid('Workset projection digest is invalid.');
  });
  return yield* withCatalogReader(threadnoteHome, sql =>
    sql
      .unsafe<{readonly present: unknown}>(
        `SELECT 1 AS present
         FROM routing_symbols
         WHERE projection_digest = ? AND node_id = ?
         LIMIT 1`,
        [input.projectionDigest, input.nodeId],
      )
      .pipe(Effect.map(rows => rows.length === 1)),
  );
});

/** Register the deterministic home-local mapping for one repository-qualified graph node. */
export const registerCodeGraphQualifiedRef = Effect.fn('codeGraphWorksetCatalog.registerQualifiedRef')(function* (
  threadnoteHome: string,
  input: QualifiedCodeGraphRefV1,
) {
  const ref = yield* validateInput(() => codeGraphQualifiedRefHandle(input));
  return yield* withCatalogWriter(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const createdAt = yield* currentIsoInstant;
        yield* sql.unsafe(
          `INSERT INTO qualified_refs (ref, repository_id, node_id, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
          [ref, input.repositoryId, input.nodeId, createdAt],
        );
        const rows = yield* sql.unsafe<QualifiedRefRow>(
          `SELECT ref, repository_id, node_id, created_at
           FROM qualified_refs WHERE ref = ? LIMIT 1`,
          [ref],
        );
        if (rows.length !== 1) return yield* corrupt('Qualified reference registration disappeared.');
        const record = yield* decodeQualifiedRef(rows[0]);
        if (record.repositoryId !== input.repositoryId || record.nodeId !== input.nodeId) {
          return yield* corrupt('Qualified reference identity collision detected.');
        }
        return record;
      }),
    ),
  );
});

/** Resolve one qualified handle, optionally fencing it to an expected repository. */
export const resolveCodeGraphQualifiedRef = Effect.fn('codeGraphWorksetCatalog.resolveQualifiedRef')(function* (
  threadnoteHome: string,
  input: {readonly ref: string; readonly repositoryId?: string},
) {
  yield* validateInput(() => {
    if (!QUALIFIED_REF.test(input.ref)) throw invalid('Qualified code graph reference is invalid.');
    if (input.repositoryId !== undefined && !SHA256_HEX.test(input.repositoryId)) {
      throw invalid('Qualified code graph repository identity is invalid.');
    }
  });
  const record = yield* withCatalogReader(threadnoteHome, sql =>
    Effect.gen(function* () {
      const rows = yield* sql.unsafe<QualifiedRefRow>(
        `SELECT ref, repository_id, node_id, created_at
         FROM qualified_refs
         WHERE ref = ?${input.repositoryId === undefined ? '' : ' AND repository_id = ?'}
         LIMIT 1`,
        input.repositoryId === undefined ? [input.ref] : [input.ref, input.repositoryId],
      );
      return rows.length === 0 ? undefined : yield* decodeQualifiedRef(rows[0]);
    }),
  );
  if (record === undefined) {
    return yield* CodeGraphWorksetCatalogError.of(
      'missing',
      'The repository-qualified graph reference is not registered.',
    );
  }
  return record;
});

/**
 * Persist one globally ranked evidence sequence and every bounded cursor
 * boundary. Old catalog generations remain pinned until their result sets are
 * pruned, so continuation never re-ranks against a newer generation.
 */
export const registerCodeGraphWorksetResultSet = Effect.fn('codeGraphWorksetCatalog.registerResultSet')(function* (
  threadnoteHome: string,
  input: CodeGraphWorksetResultSetInputV1,
) {
  const envelope = yield* validateInput(() => prepareCodeGraphWorksetResultEnvelope(input.result));
  const result = envelope.result;
  const sequence = yield* validateInput(() => prepareCodeGraphWorksetResultSequence(result.cards));
  const totalBytes = envelope.bytes + sequence.totalBytes;
  if (totalBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetBytesMaximum) {
    return yield* CodeGraphWorksetCatalogError.of(
      'invalid-input',
      'Workset persisted result bytes exceed the supported bound.',
    );
  }
  const persistedDigest = codeGraphWorksetPersistedResultDigest(envelope.digest, sequence.digest);
  const ttlMilliseconds = yield* validateInput(() => resultSetTtlMilliseconds(input.ttlMilliseconds));
  yield* validateInput(() => validateResultSetIdentityInput(result, input.projectorVersion));
  const crypto = yield* Crypto.Crypto;
  const resultSetToken = sha256HexSync(yield* crypto.randomBytes(32));
  const resultSetId = codeGraphWorksetResultSetId(resultSetToken);
  const cursors = Array.from({length: sequence.cards.length + 1}, (_, offset) =>
    codeGraphWorksetContinuationHandle({
      generationDigest: result.workset.generation.digest,
      offset,
      projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
      resultSetToken,
    }),
  );
  const createdAtMilliseconds = yield* Clock.currentTimeMillis;
  const createdAt = DateTime.formatIso(DateTime.makeUnsafe(createdAtMilliseconds));
  const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(createdAtMilliseconds + ttlMilliseconds));
  yield* withCatalogWriter(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* validateResultSetGenerationForRegistration(sql, result);
        yield* validateResultSetReferences(sql, result.workset.generation.id, sequence);
        yield* deleteExpiredResultSets(sql, createdAt, CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsMaximum);
        const capacity = yield* resultSetCapacity(sql);
        if (
          capacity.count + 1 > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsMaximum ||
          capacity.bytes + totalBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsBytesMaximum
        ) {
          return yield* CodeGraphWorksetCatalogError.of(
            'capacity',
            'The bounded workset result-set cache is full; prune expired cursors or repeat the small request later.',
          );
        }
        yield* sql.unsafe(
          `INSERT INTO result_sets (
             id, workset_name, generation_id, generation_digest, projector_version,
             result_set_token, sequence_digest, envelope_json, envelope_bytes, envelope_digest,
             card_count, total_bytes, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            resultSetId,
            result.workset.name,
            result.workset.generation.id,
            result.workset.generation.digest,
            input.projectorVersion,
            resultSetToken,
            persistedDigest,
            envelope.json,
            envelope.bytes,
            envelope.digest,
            sequence.cards.length,
            totalBytes,
            createdAt,
            expiresAt,
          ],
        );
        yield* Effect.forEach(
          sequence.cards,
          (card, ordinal) =>
            sql.unsafe(
              `INSERT INTO result_cards (
                 result_set_id, ordinal, card_id, qualified_ref, repository_key,
                 card_json, card_bytes, card_digest
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                resultSetId,
                ordinal,
                card.card.id,
                card.card.ref,
                card.card.repositoryKey,
                card.json,
                card.bytes,
                card.digest,
              ],
            ),
          {concurrency: 1, discard: true},
        );
        yield* Effect.forEach(
          cursors,
          (cursor, offset) =>
            sql.unsafe('INSERT INTO result_set_cursors (cursor, result_set_id, offset) VALUES (?, ?, ?)', [
              cursor,
              resultSetId,
              offset,
            ]),
          {concurrency: 1, discard: true},
        );
        const stored = yield* storedResultSetSequenceReceipt(sql, resultSetId);
        if (
          stored.count !== sequence.cards.length ||
          stored.bytes + envelope.bytes !== totalBytes ||
          codeGraphWorksetPersistedResultDigest(envelope.digest, stored.digest) !== persistedDigest ||
          (yield* rowCount(sql, 'SELECT COUNT(*) AS count FROM result_set_cursors WHERE result_set_id = ?', [
            resultSetId,
          ])) !== cursors.length
        ) {
          return yield* corrupt('Stored workset result-set receipt is inconsistent.');
        }
      }),
    ),
  );
  return {
    cardCount: sequence.cards.length,
    continuationForOffset: (offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= cursors.length) {
        throw invalid('Workset result-set continuation offset is invalid.');
      }
      return cursors[offset];
    },
    createdAt,
    expiresAt,
    generation: result.workset.generation,
    id: resultSetId,
    initialCursor: cursors[0],
    projectorVersion: input.projectorVersion,
    totalBytes,
    worksetName: result.workset.name,
  } satisfies CodeGraphWorksetResultSetRegistrationV1;
});

/** Resolve a persisted keyset page without re-running routing or ranking. */
export const readCodeGraphWorksetResultSetPage = Effect.fn('codeGraphWorksetCatalog.readResultSetPage')(function* (
  threadnoteHome: string,
  input: {
    readonly cursor: string;
    readonly expectedGeneration?: {readonly digest: string; readonly id: string};
    readonly expectedProjectorVersion?: number;
    readonly limit?: number;
  },
) {
  const limit = yield* validateInput(() => resultSetPageLimit(input.limit));
  const expectedProjectorVersion = yield* validateInput(() =>
    resultSetProjectorVersion(input.expectedProjectorVersion ?? CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION),
  );
  yield* validateInput(() => {
    if (!CONTINUATION_CURSOR.test(input.cursor)) throw invalid('Workset continuation cursor is invalid.');
    if (input.expectedGeneration !== undefined) validateGenerationIdentity(input.expectedGeneration);
  });
  const now = yield* currentIsoInstant;
  const page = yield* withCatalogReader(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<ResultSetRow>(
          `SELECT c.offset, r.id, r.workset_name, r.generation_id, r.generation_digest,
                  r.projector_version, r.result_set_token, r.sequence_digest, r.card_count,
                  r.envelope_json, r.envelope_bytes, r.envelope_digest,
                  r.total_bytes, r.created_at, r.expires_at,
                  g.generation_digest AS stored_generation_digest, g.state AS generation_state
           FROM result_set_cursors AS c
           JOIN result_sets AS r ON r.id = c.result_set_id
           JOIN workset_generations AS g ON g.id = r.generation_id
           WHERE c.cursor = ?
           LIMIT 1`,
          [input.cursor],
        );
        if (rows.length === 0) {
          return yield* CodeGraphWorksetCatalogError.of(
            'missing',
            'The workset continuation cursor is missing; repeat the original small request.',
          );
        }
        const resultSet = yield* decodeResultSetRow(rows[0]);
        if (resultSet.expiresAt <= now) {
          return yield* CodeGraphWorksetCatalogError.of(
            'expired',
            'The workset continuation cursor expired; repeat the original small request.',
          );
        }
        if (
          resultSet.projectorVersion !== CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION ||
          resultSet.projectorVersion !== expectedProjectorVersion
        ) {
          return yield* CodeGraphWorksetCatalogError.of(
            'incompatible',
            'The workset continuation projector version is incompatible; repeat the original small request.',
          );
        }
        if (
          input.expectedGeneration !== undefined &&
          (input.expectedGeneration.id !== resultSet.generation.id ||
            input.expectedGeneration.digest !== resultSet.generation.digest)
        ) {
          return yield* CodeGraphWorksetCatalogError.of(
            'stale',
            'The workset continuation belongs to a different catalog generation.',
          );
        }
        const expectedCursor = codeGraphWorksetContinuationHandle({
          generationDigest: resultSet.generation.digest,
          offset: resultSet.offset,
          projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
          resultSetToken: resultSet.resultSetToken,
        });
        if (expectedCursor !== input.cursor || codeGraphWorksetResultSetId(resultSet.resultSetToken) !== resultSet.id) {
          return yield* corrupt('Workset continuation identity validation failed.');
        }
        const sequence = yield* storedResultSetSequenceReceipt(sql, resultSet.id);
        const envelope = yield* validateStored(() =>
          decodeStoredCodeGraphWorksetResultEnvelope(
            resultSet.envelopeJson,
            resultSet.envelopeBytes,
            resultSet.envelopeDigest,
          ),
        );
        if (
          sequence.count !== resultSet.cardCount ||
          sequence.bytes + resultSet.envelopeBytes !== resultSet.totalBytes ||
          codeGraphWorksetPersistedResultDigest(resultSet.envelopeDigest, sequence.digest) !==
            resultSet.sequenceDigest ||
          envelope.workset.name !== resultSet.worksetName ||
          envelope.workset.generation.id !== resultSet.generation.id ||
          envelope.workset.generation.digest !== resultSet.generation.digest
        ) {
          return yield* corrupt('Workset continuation sequence receipt is inconsistent.');
        }
        const cardRows = yield* sql.unsafe<ResultCardRow>(
          `SELECT ordinal, card_id, qualified_ref, repository_key, card_json, card_bytes, card_digest
           FROM result_cards
           WHERE result_set_id = ? AND ordinal >= ?
           ORDER BY ordinal
           LIMIT ?`,
          [resultSet.id, resultSet.offset, limit + 1],
        );
        const visible = cardRows.slice(0, limit);
        const cards = [];
        for (let index = 0; index < visible.length; index += 1) {
          const row = visible[index];
          const ordinal = requiredInteger(row.ordinal, 'result card ordinal');
          if (ordinal !== resultSet.offset + index) {
            return yield* corrupt('Workset result-set page ordinals are not contiguous.');
          }
          const card = yield* validateStored(() =>
            decodeStoredCodeGraphWorksetResultCard(
              requiredText(row.card_json, 'result card JSON'),
              requiredInteger(row.card_bytes, 'result card byte count'),
              requiredText(row.card_digest, 'result card digest'),
            ),
          );
          if (
            card.id !== requiredText(row.card_id, 'result card identity') ||
            card.ref !== requiredText(row.qualified_ref, 'result card qualified reference') ||
            card.repositoryKey !== requiredText(row.repository_key, 'result card repository key')
          ) {
            return yield* corrupt('Workset result-set card columns do not match their payload.');
          }
          cards.push(card);
        }
        const nextOffset = resultSet.offset + cards.length;
        const hasMore = cardRows.length > limit;
        const next = hasMore ? yield* readStoredResultSetCursor(sql, resultSet, nextOffset) : undefined;
        return {
          cards,
          continuationForOffset: (offset: number) => {
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > resultSet.cardCount) {
              throw invalid('Workset result-set continuation offset is invalid.');
            }
            return codeGraphWorksetContinuationHandle({
              generationDigest: resultSet.generation.digest,
              offset,
              projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
              resultSetToken: resultSet.resultSetToken,
            });
          },
          cursor: input.cursor,
          expiresAt: resultSet.expiresAt,
          generation: resultSet.generation,
          ...(next === undefined ? {} : {next}),
          offset: resultSet.offset,
          projectorVersion: resultSet.projectorVersion,
          result: {...envelope, cards},
          resultSetId: resultSet.id,
          totalCards: resultSet.cardCount,
          totalBytes: resultSet.totalBytes,
          worksetName: resultSet.worksetName,
        } satisfies CodeGraphWorksetResultSetPageV1;
      }),
    ),
  );
  if (page === undefined) {
    return yield* CodeGraphWorksetCatalogError.of(
      'missing',
      'The workset continuation catalog is missing; repeat the original small request.',
    );
  }
  return page;
});

/** Bounded expiry and capacity maintenance for the home-global result cache. */
export const maintainCodeGraphWorksetResultSets = Effect.fn('codeGraphWorksetCatalog.maintainResultSets')(function* (
  threadnoteHome: string,
  options: CodeGraphWorksetResultSetMaintenanceOptionsV1 = {},
) {
  const limit = yield* validateInput(() => resultSetMaintenanceLimit(options.limit));
  const now =
    options.now === undefined ? yield* currentIsoInstant : yield* validateInput(() => canonicalIso(options.now));
  return yield* withCatalogWriter(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const expiredResultSetsDeleted = yield* deleteExpiredResultSets(sql, now, limit);
        let capacityResultSetsDeleted = 0;
        let capacity = yield* resultSetCapacity(sql);
        while (
          capacityResultSetsDeleted < limit - expiredResultSetsDeleted &&
          (capacity.count > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsMaximum ||
            capacity.bytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsBytesMaximum)
        ) {
          const candidates = yield* sql.unsafe<{readonly id: unknown}>(
            'SELECT id FROM result_sets ORDER BY expires_at, created_at, id LIMIT 1',
          );
          if (candidates.length === 0) break;
          yield* sql.unsafe('DELETE FROM result_sets WHERE id = ?', [
            requiredText(candidates[0].id, 'result set identity'),
          ]);
          capacityResultSetsDeleted += yield* changes(sql);
          capacity = yield* resultSetCapacity(sql);
        }
        yield* maintainCatalogRowsWithSql(sql, {
          generationLimit: PRODUCTION_MAINTENANCE_LIMIT,
          now,
          projectionLimit: 0,
        });
        return {
          capacityResultSetsDeleted,
          expiredResultSetsDeleted,
          remainingBytes: capacity.bytes,
          remainingResultSets: capacity.count,
        };
      }),
    ),
  );
});

export const inspectCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetCatalog.inspect')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* inspectCatalogLayout(fs, codeGraphWorksetCatalogLayout(path, threadnoteHome));
});

/** Delete only bounded retired/staging catalog rows; repository graph databases are never in scope. */
export const maintainCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetCatalog.maintain')(function* (
  threadnoteHome: string,
  options: CodeGraphWorksetCatalogMaintenanceOptionsV1 = {},
) {
  const generationLimit = yield* validateInput(() => retirementLimit(options.generationLimit, 32));
  const projectionLimit = yield* validateInput(() => retirementLimit(options.projectionLimit, 32));
  const stagingBefore = yield* validateInput(() => optionalIsoInstant(options.stagingBefore));
  const now = yield* currentIsoInstant;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
  return yield* withExclusiveFileLock(
    fs,
    layout.prepareLockPath,
    CATALOG_LOCK_OPTIONS,
    withCatalogWriter(threadnoteHome, sql =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* deleteExpiredResultSets(sql, now, CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsMaximum);
          const result = yield* maintainCatalogRowsWithSql(sql, {
            generationLimit,
            now,
            projectionLimit,
            stagingBefore,
          });
          return {
            projectionsDeleted: result.projectionsDeleted,
            retiredGenerationsDeleted: result.retiredGenerationsDeleted,
            stagingGenerationsRetired: result.stagingGenerationsRetired,
          };
        }),
      ),
    ),
  ).pipe(mapCatalogError('maintain workset catalog'));
});

/** @internal One physically bounded cleanup page for the home-global prepare lock holder. */
export const maintainCodeGraphWorksetCatalogPreparationPage = Effect.fn(
  'codeGraphWorksetCatalog.maintainPreparationPage',
)(function* (threadnoteHome: string) {
  const now = yield* currentIsoInstant;
  return yield* withCatalogWriter(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* deleteExpiredResultSets(sql, now, CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsMaximum);
        return yield* maintainCatalogRowsWithSql(sql, {
          generationLimit: PRODUCTION_MAINTENANCE_LIMIT,
          now,
          projectionLimit: CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration,
          stagingBefore: stagingGenerationCutoff(now),
        });
      }),
    ),
  );
});

function drainCodeGraphWorksetCatalogPreparationPages(threadnoteHome: string) {
  return Effect.gen(function* () {
    let pendingCleanup = true;
    while (pendingCleanup) {
      const page = yield* maintainCodeGraphWorksetCatalogPreparationPage(threadnoteHome);
      pendingCleanup = page.pendingCleanup;
      if (pendingCleanup) yield* Effect.yieldNow;
    }
  });
}

function maintainCatalogRowsWithSql(
  sql: SqlClient.SqlClient,
  input: {
    readonly generationLimit: number;
    readonly now: string;
    readonly projectionLimit: number;
    readonly stagingBefore?: string;
  },
) {
  return Effect.gen(function* () {
    let stagingGenerationsRetired = 0;
    if (input.stagingBefore !== undefined && input.generationLimit > 0) {
      yield* sql.unsafe(
        `UPDATE workset_generations
         SET state = 'retired'
         WHERE id = (
           SELECT g.id FROM workset_generations AS g
           WHERE g.state = 'staging' AND g.created_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM published_worksets AS p WHERE p.generation_id = g.id
             )
           ORDER BY g.created_at, g.id
           LIMIT 1
         )`,
        [input.stagingBefore],
      );
      stagingGenerationsRetired = yield* changes(sql);
    }
    let retiredGenerationsDeleted = 0;
    let generationWorkPerformed = stagingGenerationsRetired > 0;
    if (input.generationLimit > 0 && !generationWorkPerformed) {
      const candidates = yield* sql.unsafe<{readonly id: unknown}>(
        `SELECT g.id FROM workset_generations AS g
         WHERE g.state = 'retired'
           AND NOT EXISTS (
             SELECT 1 FROM published_worksets AS p WHERE p.generation_id = g.id
           )
           AND (
             g.member_count > 0
             OR EXISTS (
               SELECT 1 FROM workset_generation_members AS m WHERE m.generation_id = g.id
             )
             OR EXISTS (
               SELECT 1 FROM cross_repository_bridge_sets AS b WHERE b.generation_id = g.id
             )
             OR NOT EXISTS (
               SELECT 1 FROM result_sets AS r WHERE r.generation_id = g.id
             )
           )
         ORDER BY g.created_at, g.id
         LIMIT 1`,
      );
      const candidate = candidates[0];
      if (candidate !== undefined) {
        const generationId = requiredText(candidate.id, 'retired generation identity');
        yield* sql.unsafe(
          `DELETE FROM cross_repository_bridges
           WHERE generation_id = ? AND ordinal IN (
             SELECT ordinal FROM cross_repository_bridges
             WHERE generation_id = ?
             ORDER BY ordinal
             LIMIT ?
           )`,
          [generationId, generationId, CATALOG_RECLAIM_ROW_BUDGET],
        );
        generationWorkPerformed = (yield* changes(sql)) > 0;
        if (!generationWorkPerformed) {
          const bridgeSets = yield* sql.unsafe<{readonly bridge_bytes: unknown}>(
            'SELECT bridge_bytes FROM cross_repository_bridge_sets WHERE generation_id = ? LIMIT 1',
            [generationId],
          );
          if (bridgeSets[0] !== undefined) {
            const bridgeBytes = requiredInteger(bridgeSets[0].bridge_bytes, 'retired bridge logical bytes');
            yield* sql.unsafe(
              `UPDATE catalog_capacity
               SET bridge_logical_bytes = bridge_logical_bytes - ?
               WHERE singleton = 1 AND bridge_logical_bytes >= ?`,
              [bridgeBytes, bridgeBytes],
            );
            if ((yield* changes(sql)) !== 1) {
              return yield* corrupt('Bridge capacity receipt is inconsistent during reclamation.');
            }
            yield* sql.unsafe('DELETE FROM cross_repository_bridge_sets WHERE generation_id = ?', [generationId]);
            if ((yield* changes(sql)) !== 1) {
              return yield* corrupt('Retired bridge set changed during reclamation.');
            }
            generationWorkPerformed = true;
          }
        }
        if (!generationWorkPerformed) {
          const members = yield* sql.unsafe<{readonly projection_digest: unknown}>(
            `SELECT projection_digest FROM workset_generation_members
             WHERE generation_id = ?
             ORDER BY ordinal
             LIMIT ?`,
            [generationId, CATALOG_RECLAIM_ROW_BUDGET],
          );
          if (members.length > 0) {
            for (const member of members) {
              yield* queueProjectionRetirement(
                sql,
                requiredText(member.projection_digest, 'projection digest'),
                input.now,
              );
            }
            yield* sql.unsafe(
              `DELETE FROM workset_generation_members
               WHERE generation_id = ? AND ordinal IN (
                 SELECT ordinal FROM workset_generation_members
                 WHERE generation_id = ?
                 ORDER BY ordinal
                 LIMIT ?
               )`,
              [generationId, generationId, CATALOG_RECLAIM_ROW_BUDGET],
            );
            const membersDeleted = yield* changes(sql);
            if (membersDeleted !== members.length) {
              return yield* corrupt('Retired generation members changed during reclamation.');
            }
            yield* markQueuedOrphanProjectionsRetiring(sql, members.length);
            yield* dropQueuedReferencedProjections(sql, members.length);
            generationWorkPerformed = true;
          }
        }
        if (!generationWorkPerformed) {
          yield* sql.unsafe('UPDATE workset_generations SET member_count = 0 WHERE id = ? AND state = ?', [
            generationId,
            'retired',
          ]);
          yield* sql.unsafe(
            `DELETE FROM workset_generations
             WHERE id = ? AND state = 'retired'
               AND NOT EXISTS (
                 SELECT 1 FROM result_sets AS r WHERE r.generation_id = workset_generations.id
               )`,
            [generationId],
          );
          retiredGenerationsDeleted = yield* changes(sql);
          generationWorkPerformed = true;
        }
      }
    }
    let projectionsDeleted = 0;
    if (input.projectionLimit > 0 && !generationWorkPerformed) {
      yield* markQueuedOrphanProjectionsRetiring(sql, 1);
      const projectionsMarked = yield* changes(sql);
      if (projectionsMarked === 0) {
        projectionsDeleted = yield* reclaimOneProjectionPage(sql);
      }
    }
    const pendingCleanup = yield* catalogCleanupPending(sql, input.projectionLimit > 0);
    return {pendingCleanup, projectionsDeleted, retiredGenerationsDeleted, stagingGenerationsRetired};
  });
}

function reclaimOneProjectionPage(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const queued = yield* sql.unsafe<{readonly projection_digest: unknown}>(
      `SELECT q.projection_digest FROM routing_projection_retirements AS q
       JOIN repository_snapshots AS p ON p.projection_digest = q.projection_digest
       WHERE p.state = 'reclaiming'
         AND NOT EXISTS (
           SELECT 1 FROM workset_generation_members AS m
           WHERE m.projection_digest = q.projection_digest
         )
       ORDER BY q.requested_at, q.projection_digest
       LIMIT 1`,
    );
    if (queued[0] === undefined) return 0;
    const projectionDigest = requiredText(queued[0].projection_digest, 'retired projection digest');
    for (const child of [
      ['routing_exact_keys', '(projection_digest, node_id, key_kind, exact_key)', 'node_id, key_kind, exact_key'],
      ['routing_lookup_keys', '(projection_digest, node_id, lookup_key)', 'node_id, lookup_key'],
      ['routing_terms', '(projection_digest, node_id, term)', 'node_id, term'],
    ] as const) {
      if ((yield* deleteRoutingChildPage(sql, child[0], child[1], child[2], projectionDigest)) > 0) return 0;
    }
    yield* sql.unsafe(
      `DELETE FROM routing_symbols
       WHERE projection_digest = ? AND node_id IN (
         SELECT node_id FROM routing_symbols
         WHERE projection_digest = ?
         ORDER BY node_id
         LIMIT ?
       )`,
      [projectionDigest, projectionDigest, CATALOG_RECLAIM_ROW_BUDGET],
    );
    if ((yield* changes(sql)) > 0) return 0;
    const storage = yield* sql.unsafe<{readonly reserved_bytes: unknown}>(
      'SELECT reserved_bytes FROM routing_projection_storage WHERE projection_digest = ? LIMIT 1',
      [projectionDigest],
    );
    if (storage.length !== 1) {
      return yield* corrupt('Routing projection storage receipt is missing during reclamation.');
    }
    const logicalBytes = requiredInteger(storage[0].reserved_bytes, 'routing projection reserved bytes');
    yield* sql.unsafe(
      `UPDATE catalog_capacity
       SET projection_logical_bytes = projection_logical_bytes - ?
       WHERE singleton = 1 AND projection_logical_bytes >= ?`,
      [logicalBytes, logicalBytes],
    );
    if ((yield* changes(sql)) !== 1) {
      return yield* corrupt('Routing projection capacity receipt is inconsistent.');
    }
    yield* sql.unsafe(
      `DELETE FROM repository_snapshots
       WHERE projection_digest = ? AND state = 'reclaiming'
         AND NOT EXISTS (
           SELECT 1 FROM workset_generation_members AS m
           WHERE m.projection_digest = repository_snapshots.projection_digest
         )`,
      [projectionDigest],
    );
    const deleted = yield* changes(sql);
    if (deleted !== 1) return yield* corrupt('Retired routing projection changed during reclamation.');
    return deleted;
  });
}

function discardStagingGenerationWithSql(sql: SqlClient.SqlClient, generationId: string) {
  return sql.unsafe(
    `UPDATE workset_generations SET state = 'retired'
     WHERE id = ? AND state = 'staging'
       AND NOT EXISTS (
         SELECT 1 FROM published_worksets AS p WHERE p.generation_id = workset_generations.id
       )`,
    [generationId],
  );
}

function queueProjectionRetirement(sql: SqlClient.SqlClient, projectionDigest: string, requestedAt: string) {
  return sql.unsafe(
    `INSERT OR IGNORE INTO routing_projection_retirements (projection_digest, requested_at)
     SELECT projection_digest, ? FROM repository_snapshots WHERE projection_digest = ?`,
    [requestedAt, projectionDigest],
  );
}

function markQueuedOrphanProjectionsRetiring(sql: SqlClient.SqlClient, limit: number) {
  if (limit === 0) return Effect.void;
  return sql.unsafe(
    `UPDATE repository_snapshots SET state = 'reclaiming'
     WHERE projection_digest IN (
       SELECT q.projection_digest FROM routing_projection_retirements AS q
       WHERE NOT EXISTS (
         SELECT 1 FROM workset_generation_members AS m
         WHERE m.projection_digest = q.projection_digest
       )
       ORDER BY q.requested_at, q.projection_digest
       LIMIT ?
     ) AND state IN ('ready', 'staging')`,
    [limit],
  );
}

function deleteRoutingChildPage(
  sql: SqlClient.SqlClient,
  table: 'routing_exact_keys' | 'routing_lookup_keys' | 'routing_terms',
  tuple: string,
  orderBy: string,
  projectionDigest: string,
) {
  return Effect.gen(function* () {
    yield* sql.unsafe(
      `DELETE FROM ${table}
       WHERE ${tuple} IN (
         SELECT ${tuple.slice(1, -1)} FROM ${table}
         WHERE projection_digest = ?
         ORDER BY ${orderBy}
         LIMIT ?
       )`,
      [projectionDigest, CATALOG_RECLAIM_ROW_BUDGET],
    );
    return yield* changes(sql);
  });
}

function catalogCleanupPending(sql: SqlClient.SqlClient, includeProjections: boolean) {
  return sql
    .unsafe<{readonly count: unknown}>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM workset_generations AS g
           WHERE g.state = 'retired'
             AND NOT EXISTS (
               SELECT 1 FROM published_worksets AS p WHERE p.generation_id = g.id
             )
             AND (
               g.member_count > 0
               OR EXISTS (
                 SELECT 1 FROM workset_generation_members AS m WHERE m.generation_id = g.id
               )
               OR EXISTS (
                 SELECT 1 FROM cross_repository_bridge_sets AS b WHERE b.generation_id = g.id
               )
               OR NOT EXISTS (
                 SELECT 1 FROM result_sets AS r WHERE r.generation_id = g.id
               )
             )
           LIMIT 1
         )
         ${
           includeProjections
             ? `OR EXISTS (
           SELECT 1 FROM routing_projection_retirements AS q
           WHERE NOT EXISTS (
             SELECT 1 FROM workset_generation_members AS m
             WHERE m.projection_digest = q.projection_digest
           )
           LIMIT 1
         )`
             : ''
         }
       ) AS count`,
    )
    .pipe(Effect.map(rows => requiredInteger(rows[0]?.count, 'cleanup pending count') > 0));
}

function stagingGenerationCutoff(now: string): string {
  return new Date(new Date(now).getTime() - STAGING_GENERATION_RETENTION_MILLISECONDS).toISOString();
}
/** Inspect and reconstruct only the disposable catalog when corruption or schema drift is proven. */
export const recoverCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetCatalog.recover')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
  return yield* withExclusiveFileLock(
    fs,
    layout.prepareLockPath,
    CATALOG_LOCK_OPTIONS,
    withExclusiveFileLock(
      fs,
      layout.lockPath,
      CATALOG_LOCK_OPTIONS,
      Effect.gen(function* () {
        const health = yield* inspectCatalogLayout(fs, layout);
        if (health.state === 'ok') return {previousState: health.state, rebuilt: false};
        if (health.state === 'unavailable') {
          return yield* CodeGraphWorksetCatalogError.of(
            'storage',
            'The workset catalog is unavailable and was not rebuilt.',
          );
        }
        if (health.state !== 'missing') yield* removeCatalogFiles(fs, layout);
        yield* initializeCatalogLayout(fs, layout);
        return {previousState: health.state, rebuilt: health.state !== 'missing'};
      }),
    ),
  ).pipe(mapCatalogError('recover workset catalog'));
});

/** Explicit exact-target rebuild for repair and tests. */
export const rebuildCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetCatalog.rebuild')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
  return yield* withExclusiveFileLock(
    fs,
    layout.prepareLockPath,
    CATALOG_LOCK_OPTIONS,
    withExclusiveFileLock(
      fs,
      layout.lockPath,
      CATALOG_LOCK_OPTIONS,
      Effect.gen(function* () {
        yield* removeCatalogFiles(fs, layout);
        yield* initializeCatalogLayout(fs, layout);
      }),
    ),
  ).pipe(mapCatalogError('rebuild workset catalog'));
});
