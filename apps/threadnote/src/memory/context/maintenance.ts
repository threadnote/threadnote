import {publicStatus, renderContextMaintenanceStatus} from './maintenance_projection.js';
import {
  selectFairMaintenanceWork,
  maintenanceCheckpointCurrent,
  reconcileRepositoryRecoveryCases,
  mergeMaintenanceCaseLineage,
  upsertCase,
  resolveRelationTarget,
  resolveMaintenanceRelationPolicy,
  maintenanceRelationPolicyMatches,
  reconcileAbsentMaintenanceAnchors,
  maintenanceAnchorChunksComplete,
  type MaintenanceRelationPolicy,
} from './maintenance_policy.js';
export {renderContextMaintenanceStatus} from './maintenance_projection.js';
export {planMaintenanceWorkerBatches, maintenanceWorkerRecordValidations} from './maintenance_batch.js';
export {
  selectFairMaintenanceWork,
  updateMaintenanceCase,
  reconcileRepositoryRecoveryCases,
  resolveRelationTarget,
  resolveMaintenanceRelationPolicy,
  safeRelationRemoval,
  maintenanceAnchorChunksComplete,
} from './maintenance_policy.js';
import {Clock, Crypto, DateTime, Effect, FileSystem, Path, Result, Schema} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runDetachedCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {
  assertMemoryDocumentSchemaWritable,
  canonicalMemoryDocumentContent,
  isSharedMemoryUri,
  parseMemoryDocument,
  type MemoryRecord,
  type MemoryRelation,
} from '@threadnote/memory/document';
import {memoryIdentityLockKey, memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {
  contextHealthCaseIdV2,
  contextHealthCitationCaseSlotV2,
  migrateContextHealthCitationCaseSlotV2,
  type ContextHealthCaseDispositionV2,
} from '@threadnote/context/health_maintenance';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import {expandPath} from '@threadnote/platform/paths';
import {readMaintenanceMemoryRecords} from '../maintenance/records.js';
import {
  contextMaintenanceInventoryPreparation,
  prepareContextMaintenanceInventory,
  type ContextMaintenanceInventoryPreparationV2,
} from './maintenance_inventory.js';
import {
  readContextMaintenanceSourceEpoch,
  readContextMaintenanceEvidenceRequests,
  clearContextMaintenanceEvidenceRequest,
} from './maintenance_evidence.js';
import {
  activeIncomingDependency,
  buildMaintenanceSemanticReport,
  readMaintenanceCandidateDecisions,
  readMaintenanceSemanticRecords,
} from './maintenance_decisions.js';
import {readMemoryRecordsByUri, resourceExists} from '../../mcp/server/memory.js';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import {collectContextHealthEvidence} from './health_commands.js';
import {contextHealthFindingCaseIdentityV2} from '@threadnote/context/health_maintenance';
import {writeMemoryFile, writeMemoryFileChecked} from '../../share/index.js';
import {discardDeferredCodeAnchorIntent} from '../deferred/code_anchor.js';
import {forgetResourceWithRetry} from '../../mcp/server/memory.js';
import {previewContextHealthRepairPlanV1} from './health_repair.js';
import {type ContextHealthRepairProposalV1} from './health_repair.js';
import {
  applyAutomaticContextHealthArchive,
  previewAutomaticContextHealthArchiveReceipt,
} from './health_repair_commands.js';
import {readContextHealthCitationEvidence} from '@threadnote/context/citation_validation';
import {buildContextMaintenancePacket} from './maintenance_packet.js';
import {recordSourceRevision} from './maintenance_source.js';
import {
  prepareMaintenanceWorkerBatches,
  maintenanceWorkerBatchCurrent,
  invalidateMaintenanceWorkerBatch,
} from './maintenance_batch.js';

const MAX_RECEIPTS = 100;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const LOCK = {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 60_000, waitTimeoutMilliseconds: 50};

export class ContextMaintenanceError extends Schema.TaggedError<ContextMaintenanceError>()('ContextMaintenanceError', {
  message: Schema.String,
}) {}

export interface ContextMaintenanceCaseV2 {
  readonly caseId: string;
  readonly project: string;
  readonly memoryId: string;
  readonly family: string;
  readonly slot: string;
  readonly evidenceRevision: string;
  readonly disposition: ContextHealthCaseDispositionV2;
  readonly reason: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly lastChecked: string;
  readonly attemptCount: number;
  readonly nextAttemptAt?: string;
  readonly wake?: {readonly kind: 'evidence-generation'; readonly revision: string};
  readonly citationId?: string;
  readonly subjectUri?: string;
  readonly archivedUri?: string;
  readonly omittedSubjects?: number;
  readonly omittedSources?: number;
  readonly anchorEvidence?: {readonly status: string; readonly coverage: string; readonly provenance?: string};
  readonly retirement?: {
    readonly citationId: string;
    readonly anchorSlot: string;
    readonly evidenceRevision: string;
    readonly expectedContentHash: string;
    readonly retiredAt: string;
    readonly reason: string;
    readonly provenance?: 'historical-verified' | 'unverified';
    readonly evidenceGeneration?: string;
    readonly attemptedSteps?: readonly string[];
  };
  readonly causeKey?: string;
  readonly repositoryId?: string;
  readonly subjectContentHashes?: readonly {readonly uri: string; readonly hash: string}[];
  readonly candidateReview?: {readonly reviewId: string; readonly revision: number; readonly candidateRevision: string};
  readonly sourceSnapshot?: {readonly cwd: string; readonly generation: string; readonly revision: string};
  readonly sourceSnapshots?: readonly {
    readonly uri: string;
    readonly cwd: string;
    readonly generation: string;
    readonly revision: string;
  }[];
  readonly events: readonly {readonly at: string; readonly reason: string}[];
}

export interface ContextMaintenanceReceiptV2 {
  readonly receiptId: string;
  readonly project: string;
  readonly subjectUri: string;
  readonly archivedUri?: string;
  readonly postHash: string;
  readonly timestamp: string;
  readonly state: 'applying' | 'applied' | 'undone' | 'conflict';
}

interface UndoJournal extends ContextMaintenanceReceiptV2 {
  readonly before: string;
  readonly after: string;
  readonly archiveProposal?: ContextHealthRepairProposalV1;
  readonly archiveCallerCwd?: string;
  readonly removed: readonly MemoryRelation[];
  readonly relationChanges?: readonly {
    readonly relation: MemoryRelation;
    readonly targetHash?: string;
    readonly successorHash?: string;
    readonly lineageHashes?: readonly string[];
  }[];
}

interface WorkCheckpoint {
  readonly revision: string;
  readonly checkedAt: string;
  readonly retryAt?: string;
  readonly checkedCitations?: number;
  readonly attemptedCitations?: number;
  readonly memoryHash?: string;
  readonly sourceEpoch?: string;
  readonly sourceRevision?: string;
  readonly inventoryComplete?: boolean;
}

export interface ContextMaintenanceStatusV2 {
  readonly version: 2;
  readonly paused: boolean;
  readonly state: 'idle' | 'running' | 'waiting-evidence' | 'needs-decision' | 'failed';
  readonly generation: string;
  readonly preparation?: ContextMaintenanceInventoryPreparationV2;
  readonly semanticCoverage?: readonly {
    readonly project: string;
    readonly state: 'partial' | 'complete';
    readonly eligibleRecords: number;
    readonly checkedBatches: number;
    readonly totalBatches: number;
  }[];
  readonly projects: readonly {
    readonly project: string;
    readonly generation: string;
    readonly cursor: number;
    readonly eligible: number;
    readonly checked: number;
    readonly eligibleCitations: number;
    readonly checkedCitations: number;
  }[];
  readonly cases: readonly ContextMaintenanceCaseV2[];
  readonly receipts: readonly ContextMaintenanceReceiptV2[];
  readonly counts?: Readonly<Record<string, number>>;
  readonly groups?: readonly {
    readonly causeKey: string;
    readonly project: string;
    readonly disposition: ContextHealthCaseDispositionV2;
    readonly reason: string;
    readonly affectedMemories: number;
  }[];
  readonly omittedCases?: number;
  readonly omittedReceipts?: number;
  readonly page?: {readonly generation: string; readonly caseNextCursor?: string; readonly receiptNextCursor?: string};
  readonly lastProgressAt?: string;
  readonly error?: {readonly reason: string; readonly at: string};
}

export interface MaintenanceState extends ContextMaintenanceStatusV2 {
  readonly checkpoints: Readonly<Record<string, WorkCheckpoint>>;
  readonly lastProject?: string;
  readonly lastTaskByProject?: Readonly<Record<string, string>>;
  readonly lastWakeAt?: string;
  readonly policyOverrides?: Readonly<Record<string, string>>;
  readonly decisionCheckpoints?: Readonly<Record<string, string>>;
  readonly semanticProgress?: Readonly<
    Record<
      string,
      {
        readonly generation: string;
        readonly cursor: number;
        readonly totalBatches: number;
        readonly eligibleRecords: number;
        readonly partial?: boolean;
      }
    >
  >;
}

export interface ContextMaintenanceReadOptions {
  readonly limit?: number;
  readonly caseCursor?: string;
  readonly receiptCursor?: string;
  readonly caseId?: string;
  readonly receiptId?: string;
}

export const readContextMaintenanceStatus = Effect.fn('contextMaintenance.status')(function* (
  config: RuntimeConfig,
  project?: string,
  options: ContextMaintenanceReadOptions = {},
) {
  const yieldedState = yield* readState(config);
  return yield* Effect.try({
    try: () => publicStatus(yieldedState, project, options),
    catch: error => fail(error instanceof Error ? error.message : 'Invalid maintenance selector.'),
  });
});

export const setContextMaintenancePaused = Effect.fn('contextMaintenance.pause')(function* (
  config: RuntimeConfig,
  paused: boolean,
) {
  return yield* withStateLock(
    config,
    Effect.gen(function* () {
      const state = {...(yield* readState(config)), paused};
      yield* writeState(config, state);
      return publicStatus(state);
    }),
  );
});

export const runContextMaintenance = Effect.fn('contextMaintenance.run')(function* (
  config: RuntimeConfig,
  options: {readonly cwd: string; readonly project?: string; readonly maxRecords?: number},
) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(options.cwd)) return yield* fail('Maintenance cwd must be absolute.');
  const maxRecords = Math.max(1, Math.min(100, options.maxRecords ?? 16));
  return yield* withStateLock(
    config,
    Effect.gen(function* () {
      let state = yield* readState(config);
      if (state.paused) return publicStatus(state);
      const started = yield* Clock.currentTimeMillis;
      const snapshot = yield* prepareContextMaintenanceInventory(
        config,
        options.project,
        Math.min(256, maxRecords * 16),
      ).pipe(Effect.result);
      if (Result.isFailure(snapshot)) {
        state = {
          ...state,
          state: 'failed',
          error: {at: DateTime.formatIso(DateTime.makeUnsafe(started)), reason: 'memory-snapshot-unreadable'},
        };
        yield* writeState(config, state);
        return publicStatus(state);
      }
      const corpus = snapshot.success.records;
      const logicalHashes = snapshot.success.canonicalContentHashes;
      state = {...state, cases: migrateMaintenanceCases(state.cases, corpus, logicalHashes)};
      const active = corpus
        .filter(record => record.metadata.status === 'active')
        .map(record =>
          record.metadata.project === undefined
            ? {...record, metadata: {...record.metadata, project: 'unscoped'}}
            : record,
        );
      const now = DateTime.formatIso(DateTime.makeUnsafe(started));
      const generation = snapshot.success.generation;
      const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.result);
      const roots = new Map<string, string>();
      if (Result.isSuccess(manifest)) {
        for (const project of manifest.success.projects) {
          const root = yield* expandPath(project.path).pipe(Effect.result);
          if (Result.isSuccess(root)) roots.set(project.name, root.success);
        }
      }
      const checkpoints = {...state.checkpoints};
      const caseMap = new Map(state.cases.map(item => [item.caseId, item]));
      const evidenceRequests = yield* readContextMaintenanceEvidenceRequests(config);
      const requestedUris = new Set(evidenceRequests.flatMap(request => request.uris));
      const candidateDecisions = yield* readMaintenanceCandidateDecisions(config, options.project);
      const pendingCandidateIds = new Set<string>();
      for (const decision of candidateDecisions) {
        const identity = {
          project: decision.review.project,
          memoryId: 'candidate',
          family: 'candidate',
          slot: decision.candidate.candidateId,
        };
        const id = contextHealthCaseIdV2(identity);
        pendingCandidateIds.add(id);
        const previous = caseMap.get(id);
        const item =
          previous?.evidenceRevision === decision.revision
            ? previous
            : upsertCase(
                caseMap,
                {
                  ...identity,
                  evidenceRevision: decision.revision,
                  disposition: 'needs-decision',
                  reason: `candidate-${decision.candidate.comparison}`,
                },
                now,
              );
        caseMap.set(id, {
          ...item,
          candidateReview: {
            reviewId: decision.review.reviewId,
            revision: decision.review.revision,
            candidateRevision: decision.revision,
          },
        });
      }
      for (const [id, item] of caseMap)
        if (
          item.family === 'candidate' &&
          (options.project === undefined || item.project === options.project) &&
          !pendingCandidateIds.has(id)
        )
          caseMap.set(id, {...item, disposition: 'resolved', reason: 'candidate-review-completed', lastChecked: now});
      const receipts = [
        ...new Map(
          [...state.receipts, ...(yield* recoverReceiptJournals(config, state.receipts))].map(item => [
            item.receiptId,
            item,
          ]),
        ).values(),
      ];
      const sourceRevisions = new Map<string, string>();
      const recordSourceRevisions = new Map<string, string>();
      const tasks = active.flatMap(record => {
        const chunks = Math.max(1, Math.ceil((record.metadata.codeCitations?.length ?? 0) / 64));
        return Array.from({length: chunks}, (_, chunk) => ({
          record,
          project: record.metadata.project!,
          chunk,
          key: `${record.metadata.memoryId ?? record.uri}:${chunk}`,
          revision: snapshot.success.hashes.get(record.uri) ?? contentHash(record.content),
        }));
      });
      const keys = new Set(tasks.map(task => task.key));
      for (const key of Object.keys(checkpoints)) if (!keys.has(key)) delete checkpoints[key];
      const pending = tasks.filter(task => options.project === undefined || task.project === options.project);
      const rotated = [...pending].sort((left, right) => {
        const priority = (task: typeof left) => {
          const check = checkpoints[task.key];
          if (
            check !== undefined &&
            (check.inventoryComplete !== snapshot.success.complete ||
              (check.retryAt !== undefined && check.retryAt <= now))
          )
            return 2;
          return check?.memoryHash !== logicalHashes.get(task.record.uri) ? 1 : 0;
        };
        if (priority(left) !== priority(right)) return priority(right) - priority(left);
        if (left.project !== right.project) return left.project.localeCompare(right.project);
        const cursor = state.lastTaskByProject?.[left.project];
        const leftAfter = cursor === undefined || left.key > cursor;
        const rightAfter = cursor === undefined || right.key > cursor;
        return Number(rightAfter) - Number(leftAfter) || left.key.localeCompare(right.key);
      });
      state = {...state, generation, state: 'running', error: undefined};
      yield* writeState(config, state);
      // Bound the expensive per-record citation work in one tick. maxRecords
      // still controls inventory pagination, and checkpoints rotate across ticks.
      const selected = selectFairMaintenanceWork(rotated, state.lastProject, Math.min(maxRecords, 4));
      const {batches, batchByTask} = yield* prepareMaintenanceWorkerBatches(
        config,
        selected,
        roots,
        options.cwd,
        started,
        now,
        checkpoints,
        caseMap,
      );
      const workStarted = yield* Clock.currentTimeMillis;
      const previousCitationCases = new Map(caseMap);
      for (const task of selected) {
        if (task !== selected[0] && (yield* Clock.currentTimeMillis) - workStarted > 5_000) break;
        const currentRecord = (yield* readMemoryRecordsByUri(config, [task.record.uri]))[0];
        if (currentRecord === undefined || currentRecord.metadata.status !== 'active') continue;
        const record =
          currentRecord.metadata.project === undefined
            ? {...currentRecord, metadata: {...currentRecord.metadata, project: 'unscoped'}}
            : currentRecord;
        const memoryId = record.metadata.memoryId ?? record.uri;
        let postMutationHash: string | undefined;
        const decisionRevision = sha256HexSync(
          active
            .filter(item => item.metadata.project === task.project)
            .map(item => `${item.uri}:${snapshot.success.hashes.get(item.uri)}`)
            .join('|'),
        );
        const semanticProgress = state.semanticProgress?.[task.project];
        const semanticCursor = semanticProgress?.generation === decisionRevision ? semanticProgress.cursor : 0;
        if (semanticProgress?.generation !== decisionRevision || semanticCursor < semanticProgress.totalBatches) {
          const semanticBatch = yield* readMaintenanceSemanticRecords(config, task.project, active, semanticCursor);
          const subjects = semanticBatch.records;
          const semantic = buildMaintenanceSemanticReport(task.project, subjects, now);
          const semanticIds = new Set<string>();
          for (const finding of semantic.findings.filter(finding => finding.category === 'semantic-contradiction')) {
            const identity = contextHealthFindingCaseIdentityV2({project: task.project, finding, records: subjects});
            const item = upsertCase(
              caseMap,
              {
                ...identity,
                evidenceRevision: decisionRevision,
                disposition: 'needs-decision',
                reason: 'opposing-canonical-claims',
              },
              now,
            );
            semanticIds.add(item.caseId);
            caseMap.set(item.caseId, {
              ...item,
              subjectContentHashes: subjects
                .filter(subject =>
                  [finding.semanticEvidence?.left.recordUri, finding.semanticEvidence?.right.recordUri].includes(
                    subject.uri,
                  ),
                )
                .map(subject => ({uri: subject.uri, hash: contentHash(subject.content)})),
            });
          }
          for (const [id, item] of caseMap)
            if (
              item.project === task.project &&
              item.family === 'semantic-contradiction' &&
              semantic.semanticCompleteness?.state === 'complete' &&
              !semanticIds.has(id) &&
              item.subjectContentHashes?.length === 2 &&
              item.subjectContentHashes.every(subject => subjects.some(record => record.uri === subject.uri))
            )
              caseMap.set(id, {
                ...item,
                disposition: 'resolved',
                reason: 'semantic-postcondition-verified',
                lastChecked: now,
              });
          state = {
            ...state,
            decisionCheckpoints: {...state.decisionCheckpoints, [task.project]: decisionRevision},
            semanticProgress: {
              ...state.semanticProgress,
              [task.project]: {
                generation: decisionRevision,
                cursor: semanticCursor + 1,
                totalBatches: semanticBatch.totalBatches,
                eligibleRecords: semanticBatch.eligibleRecords,
                partial:
                  (semanticProgress?.generation === decisionRevision && semanticProgress.partial === true) ||
                  semantic.semanticCompleteness?.state !== 'complete',
              },
            },
          };
        }
        state = {
          ...state,
          lastProject: task.project,
          lastTaskByProject: {...state.lastTaskByProject, [task.project]: task.key},
        };
        if ((record.metadata.codeCitations?.length ?? 0) > 0) {
          const observed = batchByTask.get(task.key)?.observation;
          if (observed?.sourceEpoch !== undefined) sourceRevisions.set(task.project, observed.sourceEpoch);
          else if (!sourceRevisions.has(task.project))
            sourceRevisions.set(task.project, yield* sourceGeneration(config, roots.get(task.project) ?? options.cwd));
          recordSourceRevisions.set(
            record.uri,
            yield* recordSourceRevision(
              config,
              record,
              roots.get(task.project) ?? options.cwd,
              batchByTask.get(task.key)?.observation?.association,
            ),
          );
        }
        const relationCorpus =
          snapshot.success.complete && (record.metadata.relations?.length ?? 0) > 0
            ? yield* readMaintenanceMemoryRecords(config, {requireReadable: true})
            : corpus;
        task.revision = sha256HexSync(
          `${snapshot.success.complete}:${contentHash(record.content)}:${sourceRevisions.get(task.project) ?? ''}:${recordSourceRevisions.get(record.uri) ?? ''}:${(
            record.metadata.relations ?? []
          )
            .map(relation => {
              const target = resolveRelationTarget(relationCorpus, relation.uri);
              const policy = resolveMaintenanceRelationPolicy(
                record,
                relation,
                relationCorpus,
                snapshot.success.complete,
              );
              const successors = relationCorpus
                .filter(
                  candidate =>
                    candidate.metadata.status === 'active' &&
                    (candidate.metadata.relations ?? []).some(
                      link =>
                        link.type === 'supersedes' &&
                        resolveRelationTarget(relationCorpus, link.uri).record?.uri === target.record?.uri,
                    ),
                )
                .map(candidate => [candidate.uri, contentHash(candidate.content)])
                .sort();
              return `${relation.type}:${relation.uri}:${target.state}:${target.record?.content ?? ''}:${policy.state}:${JSON.stringify(successors)}:${JSON.stringify(policy.lineage?.map(item => [item.uri, contentHash(item.content)]))}`;
            })
            .join('|')}`,
        );
        const check = checkpoints[task.key];
        const legacy = state.cases.some(
          item =>
            item.memoryId === memoryId &&
            ['needs-decision', 'waiting-evidence'].includes(item.disposition) &&
            item.subjectContentHashes === undefined,
        );
        const waitingForEvidenceDeadline =
          check?.retryAt !== undefined &&
          check.retryAt > now &&
          [...caseMap.values()].some(
            item =>
              item.project === task.project && item.memoryId === memoryId && item.disposition === 'waiting-evidence',
          );
        if (
          (!requestedUris.has(record.uri) ||
            waitingForEvidenceDeadline ||
            [...caseMap.values()].some(
              item =>
                item.project === task.project && item.memoryId === memoryId && item.wake?.revision === task.revision,
            )) &&
          !legacy &&
          check?.revision === task.revision &&
          (check.retryAt === undefined || check.retryAt > now)
        )
          continue;
        const previousCases = [...caseMap.values()].filter(
          item =>
            item.project === task.project &&
            item.memoryId === memoryId &&
            (item.family.startsWith('citation')
              ? item.family === 'citation-coverage'
                ? item.slot === String(task.chunk)
                : (record.metadata.codeCitations?.slice(task.chunk * 64, (task.chunk + 1) * 64) ?? []).some(
                    citation => contextHealthCitationCaseSlotV2(citation) === item.slot,
                  )
              : task.chunk === 0),
        );
        const seen = new Set<string>();
        if (task.chunk === 0) {
          const changes = (record.metadata.relations ?? []).flatMap(relation => {
            const policy = resolveMaintenanceRelationPolicy(
              record,
              relation,
              relationCorpus,
              snapshot.success.complete,
            );
            return policy.state === 'prunable' || policy.state === 'redirectable' ? [{relation, policy}] : [];
          });
          const removal = changes.map(change => change.relation);
          for (const relation of record.metadata.relations ?? []) {
            const target = resolveRelationTarget(relationCorpus, relation.uri);
            if (target.state === 'active') continue;
            const policy = resolveMaintenanceRelationPolicy(
              record,
              relation,
              relationCorpus,
              snapshot.success.complete,
            );
            const removable = removal.some(item => item.type === relation.type && item.uri === relation.uri);
            const disposition =
              target.state === 'missing' && !snapshot.success.complete
                ? 'waiting-evidence'
                : removable
                  ? 'queued'
                  : policy.state === 'historical'
                    ? 'historical'
                    : 'needs-decision';
            const item = upsertCase(
              caseMap,
              {
                project: task.project,
                memoryId,
                family: 'relation',
                slot: target.record?.metadata.memoryId ?? relation.uri,
                evidenceRevision: sha256HexSync(`${task.revision}:${target.state}:${target.record?.content ?? ''}`),
                disposition,
                reason:
                  target.state === 'missing' && !snapshot.success.complete
                    ? 'inventory-preparation-incomplete'
                    : removable
                      ? policy.state === 'redirectable'
                        ? 'verified-explicit-successor'
                        : 'proven-unusable-personal-dependency'
                      : target.state === 'inactive'
                        ? 'historical-relation'
                        : 'relation-target-unresolved',
              },
              now,
            );
            seen.add(item.caseId);
          }
          if (isSharedMemoryUri(record.uri)) {
            for (const relation of record.metadata.relations ?? []) {
              const target = resolveRelationTarget(corpus, relation.uri);
              if (target.state !== 'missing') continue;
              const item = upsertCase(
                caseMap,
                {
                  project: task.project,
                  memoryId,
                  family: 'shared-owner-proposal',
                  slot: 'relations',
                  evidenceRevision: task.revision,
                  disposition: 'needs-decision',
                  reason: 'shared-canonical-relations-require-owner-review',
                },
                now,
              );
              seen.add(item.caseId);
            }
          }
          if (removal.length > 0) {
            const repaired = yield* repairRelations(config, record, changes, now).pipe(Effect.result);
            if (Result.isSuccess(repaired)) {
              const receipt = repaired.success;
              postMutationHash = receipt.postHash;
              upsertMaintenanceReceipt(receipts, receipt);
              for (const relation of removal) {
                const id = contextHealthCaseIdV2({
                  project: task.project,
                  memoryId,
                  family: 'relation',
                  slot: resolveRelationTarget(corpus, relation.uri).record?.metadata.memoryId ?? relation.uri,
                });
                const item = caseMap.get(id);
                if (item !== undefined)
                  caseMap.set(id, {
                    ...item,
                    disposition: (record.metadata.relations ?? []).some(
                      link =>
                        link.uri === relation.uri &&
                        !removal.some(removed => removed.type === link.type && removed.uri === link.uri),
                    )
                      ? 'historical'
                      : changes.find(change => change.relation.uri === relation.uri)?.policy.state === 'redirectable'
                        ? 'resolved'
                        : 'retired',
                    reason: 'relation-repair-verified',
                  });
              }
            } else {
              for (const id of seen) {
                const item = caseMap.get(id);
                if (item?.disposition === 'queued')
                  caseMap.set(id, {
                    ...item,
                    disposition: 'waiting-evidence',
                    reason: 'relation-repair-conflict',
                    nextAttemptAt:
                      item.attemptCount < 3
                        ? DateTime.formatIso(DateTime.makeUnsafe(started + 60_000 * 2 ** (item.attemptCount - 1)))
                        : undefined,
                    wake:
                      item.attemptCount >= 3
                        ? {kind: 'evidence-generation', revision: item.evidenceRevision}
                        : undefined,
                  });
              }
            }
          }
        }
        const citations = record.metadata.codeCitations?.slice(task.chunk * 64, (task.chunk + 1) * 64) ?? [];
        const duplicateRecords = yield* readMemoryRecordsByUri(
          config,
          active
            .filter(
              item =>
                item.uri !== record.uri &&
                snapshot.success.bodyHashes.get(item.uri) === snapshot.success.bodyHashes.get(record.uri),
            )
            .slice(0, 16)
            .map(item => item.uri),
        );
        const repairCorpus = [
          record,
          ...duplicateRecords,
          ...corpus.filter(
            item => item.uri !== record.uri && !duplicateRecords.some(duplicate => duplicate.uri === item.uri),
          ),
        ];
        const collected = yield* collectContextHealthEvidence(
          config,
          task.project,
          [{...record, metadata: {...record.metadata, relations: []}}],
          roots.get(task.project) ?? options.cwd,
          {
            relationCorpus: corpus,
            duplicateCorpus: [record, ...duplicateRecords],
            evidenceMode: 'worker',
            workerEvidence: batchByTask.get(task.key),
            includeCitationCoverageFindings: true,
            citationRecords: [{...record, metadata: {...record.metadata, codeCitations: citations}}],
          },
        ).pipe(Effect.result);
        if (Result.isSuccess(collected))
          for (const request of evidenceRequests.filter(
            request => request.project === task.project && request.uris.includes(record.uri),
          ))
            yield* clearContextMaintenanceEvidenceRequest(config, request.project, request.cwd, [record.uri]);
        const report = Result.isSuccess(collected)
          ? Result.succeed(collected.success.report)
          : Result.fail(collected.failure);
        if (Result.isSuccess(report)) {
          if (task.chunk === 0 && !isSharedMemoryUri(record.uri)) {
            const archive = previewContextHealthRepairPlanV1(report.success, repairCorpus).proposals.find(
              proposal =>
                proposal.mutation.kind === 'archive-memory' &&
                proposal.mutation.subjectUri === record.uri &&
                (proposal.category === 'validity-expired' ||
                  (proposal.category === 'exact-duplicate' &&
                    snapshot.success.complete &&
                    options.project === undefined &&
                    !activeIncomingDependency(record, active) &&
                    duplicateArchiveSafe(
                      record,
                      duplicateRecords.find(
                        item =>
                          item.uri ===
                          (proposal.mutation.kind === 'archive-memory' ? proposal.mutation.survivorUri : undefined),
                      ),
                    ))),
            );
            if (archive !== undefined && state.policyOverrides?.[memoryId] !== contentHash(record.content)) {
              const prepared = previewAutomaticContextHealthArchiveReceipt(config, archive, record, now);
              const pendingReceipt: UndoJournal = {
                receiptId: `maintenance-${sha256HexSync(archive.revision).slice(0, 40)}`,
                project: task.project,
                subjectUri: record.uri,
                archivedUri: prepared.uri,
                archiveProposal: archive,
                archiveCallerCwd: roots.get(task.project) ?? options.cwd,
                postHash: contentHash(prepared.content),
                timestamp: now,
                state: 'applying',
                before: record.content,
                after: prepared.content,
                removed: [],
              };
              yield* atomicJson(yield* receiptPath(config, pendingReceipt.receiptId), pendingReceipt);
              const result = yield* applyAutomaticContextHealthArchive(
                config,
                archive,
                roots.get(task.project) ?? options.cwd,
                now,
                archive.category === 'exact-duplicate'
                  ? source => proveAutomaticDuplicateArchive(config, source)
                  : undefined,
              ).pipe(Effect.result);
              if (
                Result.isSuccess(result) &&
                (result.success.status === 'applied' || result.success.status === 'already-applied')
              ) {
                const archivedRecord = (yield* readMaintenanceMemoryRecords(config, {requireReadable: true})).find(
                  item =>
                    item.metadata.archivedFrom === record.uri && item.metadata.memoryId === record.metadata.memoryId,
                );
                if (archivedRecord !== undefined) {
                  const receipt: UndoJournal = {
                    receiptId: `maintenance-${sha256HexSync(archive.revision).slice(0, 40)}`,
                    project: task.project,
                    subjectUri: record.uri,
                    archivedUri: archivedRecord.uri,
                    postHash: contentHash(archivedRecord.content),
                    timestamp: now,
                    state: 'applied',
                    before: record.content,
                    after: archivedRecord.content,
                    removed: [],
                  };
                  yield* atomicJson(yield* receiptPath(config, receipt.receiptId), receipt);
                  postMutationHash = receipt.postHash;
                  upsertMaintenanceReceipt(receipts, receiptProjection(receipt));
                  upsertCase(
                    caseMap,
                    {
                      project: task.project,
                      memoryId,
                      family: archive.category,
                      slot: 'record',
                      evidenceRevision: task.revision,
                      disposition: 'retired',
                      reason: 'lifecycle-retirement-verified',
                    },
                    now,
                  );
                }
              }
            }
          }
          for (const finding of report.success.findings) {
            if (finding.caseIdentity?.family === 'candidate') continue;
            if (finding.category.startsWith('relation-')) continue;
            if (
              finding.repair.subjectUri !== undefined &&
              finding.repair.subjectUri !== record.uri &&
              finding.semanticEvidence === undefined
            )
              continue;
            if (
              [...caseMap.values()].some(
                item =>
                  item.memoryId === memoryId && item.family === finding.category && item.disposition === 'retired',
              )
            )
              continue;
            const identity = contextHealthFindingCaseIdentityV2({project: task.project, finding, records: corpus});
            const receipt = Result.isSuccess(collected)
              ? collected.success.citationValidations
                  .flatMap(item => item.receipts)
                  .find(item => `${record.uri}#${item.citationId}` === finding.repair.targetUri)
              : undefined;
            const citation = record.metadata.codeCitations?.find(item => item.id === receipt?.citationId);
            const disposition =
              receipt?.provenance === 'historical-verified'
                ? 'historical'
                : finding.category === 'citation-unknown'
                  ? 'waiting-evidence'
                  : 'needs-decision';
            const item = upsertCase(
              caseMap,
              {
                ...identity,
                evidenceRevision: task.revision,
                disposition,
                reason: receipt?.reason ?? finding.category,
                ...(citation === undefined
                  ? {}
                  : {
                      citationId: citation.id,
                      anchorEvidence:
                        receipt === undefined
                          ? undefined
                          : {status: receipt.status, coverage: receipt.coverage, provenance: receipt.provenance},
                      repositoryId: citation.repositoryId,
                      causeKey: `${citation.repositoryId}:${receipt?.reason ?? finding.category}`,
                    }),
              },
              now,
            );
            seen.add(item.caseId);
          }
          // Unknown coverage receipts have no user-facing finding; persist one recoverable coverage case per record batch.
          const coverage = report.success.maintenance?.citationCoverage;
          if (
            coverage !== undefined &&
            coverage.deferred > 0 &&
            !report.success.findings.some(item => item.category === 'citation-unknown')
          ) {
            const item = upsertCase(
              caseMap,
              {
                project: task.project,
                memoryId,
                family: 'citation-coverage',
                slot: String(task.chunk),
                evidenceRevision: task.revision,
                disposition: 'waiting-evidence',
                reason:
                  coverage.reasons
                    .map(item => item.reason)
                    .join(', ')
                    .slice(0, 300) || 'citation-evidence-unavailable',
              },
              now,
            );
            seen.add(item.caseId);
          }
          for (const item of previousCases) {
            if (
              item.family === 'current-support' &&
              [...caseMap.values()].some(
                anchor =>
                  anchor.memoryId === item.memoryId &&
                  anchor.slot === item.slot &&
                  anchor.retirement?.evidenceRevision === item.evidenceRevision &&
                  anchor.evidenceRevision === task.revision,
              )
            )
              seen.add(item.caseId);
            if (!seen.has(item.caseId) && item.disposition !== 'retired')
              caseMap.set(item.caseId, {
                ...item,
                disposition: 'resolved',
                reason: 'postcondition-verified',
                lastChecked: now,
              });
          }
        } else {
          const item = upsertCase(
            caseMap,
            {
              project: task.project,
              memoryId,
              family: 'maintenance',
              slot: String(task.chunk),
              evidenceRevision: task.revision,
              disposition: 'waiting-evidence',
              reason: 'health-evidence-unavailable',
            },
            now,
          );
          seen.add(item.caseId);
        }
        const waiting = [...seen].map(id => caseMap.get(id)).filter(item => item?.disposition === 'waiting-evidence');
        for (const id of seen) {
          const item = caseMap.get(id);
          if (item === undefined) continue;
          caseMap.set(id, {
            ...item,
            subjectUri: record.uri,
            subjectContentHashes:
              item.family === 'semantic-contradiction'
                ? item.subjectContentHashes
                : [{uri: record.uri, hash: contentHash(record.content)}],
            ...(sourceRevisions.has(task.project) && recordSourceRevisions.has(record.uri)
              ? {
                  sourceSnapshot: {
                    cwd: roots.get(task.project) ?? options.cwd,
                    generation: sourceRevisions.get(task.project)!,
                    revision: recordSourceRevisions.get(record.uri)!,
                  },
                }
              : {}),
          });
        }
        checkpoints[task.key] = {
          inventoryComplete: snapshot.success.complete,
          memoryHash: postMutationHash ?? contentHash(record.content),
          sourceEpoch: sourceRevisions.get(task.project),
          sourceRevision: recordSourceRevisions.get(record.uri),
          retryAt: nextMaintenanceDeadline(record, now),
          checkedCitations: Result.isSuccess(report)
            ? (report.success.maintenance?.citationCoverage.checked ?? 0) +
              (report.success.maintenance?.citationCoverage.historicalVerified ?? 0)
            : 0,
          attemptedCitations: citations.length,
          revision:
            postMutationHash === undefined ? task.revision : `${task.revision}:postmutation:${postMutationHash}`,
          checkedAt: now,
          ...(waiting.length === 0
            ? {}
            : {
                retryAt: [nextMaintenanceDeadline(record, now), ...waiting.map(item => item?.nextAttemptAt)]
                  .filter((date): date is string => date !== undefined)
                  .sort()[0],
              }),
        };
        state = {
          ...state,
          lastProject: task.project,
          lastTaskByProject: {...state.lastTaskByProject, [task.project]: task.key},
          lastProgressAt: now,
          checkpoints,
          cases: [...caseMap.values()],
          receipts: receipts.slice(-MAX_RECEIPTS),
        };
        yield* writeState(config, state);
      }
      for (const batch of batches)
        if (!(yield* maintenanceWorkerBatchCurrent(config, batch)))
          invalidateMaintenanceWorkerBatch(batch, caseMap, previousCitationCases, checkpoints);
      if (snapshot.success.complete) {
        for (const record of active.filter(
          record => options.project === undefined || record.metadata.project === options.project,
        )) {
          if (!maintenanceAnchorChunksComplete(record, checkpoints, logicalHashes.get(record.uri))) continue;
          if (
            ![...caseMap.values()].some(
              item =>
                item.memoryId === (record.metadata.memoryId ?? record.uri) &&
                ['citation', 'current-support', 'citation-coverage'].includes(item.family),
            )
          )
            continue;
          const fresh = (yield* readMemoryRecordsByUri(config, [record.uri]))[0];
          if (fresh?.metadata.status === 'active' && contentHash(fresh.content) === logicalHashes.get(record.uri))
            reconcileAbsentMaintenanceAnchors(caseMap, fresh, now);
        }
      }
      reconcileRepositoryRecoveryCases(caseMap, now);
      const activeIds = new Set(active.map(record => record.metadata.memoryId ?? record.uri));
      const caseValues = [...caseMap.values()].map(item =>
        (item.family === 'candidate' && pendingCandidateIds.has(item.caseId)) ||
        (item.family === 'repository-recovery' &&
          item.subjectContentHashes?.some(subject => active.some(record => record.uri === subject.uri))) ||
        !snapshot.success.complete ||
        (options.project !== undefined && item.project !== options.project) ||
        activeIds.has(item.memoryId) ||
        (item.family === 'semantic-contradiction' &&
          ((item.subjectContentHashes?.length ?? 0) < 2 ||
            item.subjectContentHashes?.every(subject => active.some(record => record.uri === subject.uri)))) ||
        item.disposition === 'retired'
          ? item
          : {...item, disposition: 'resolved' as const, reason: 'subject-inactive'},
      );
      const terminal = caseValues
        .filter(item => ['resolved', 'retired'].includes(item.disposition) && item.retirement === undefined)
        .sort((a, b) => b.lastChecked.localeCompare(a.lastChecked))
        .slice(0, 200);
      const cases = [
        ...caseValues.filter(
          item => !['resolved', 'retired'].includes(item.disposition) || item.retirement !== undefined,
        ),
        ...terminal,
      ];
      state = {
        ...state,
        preparation: contextMaintenanceInventoryPreparation(snapshot.success, corpus.length),
        checkpoints,
        cases,
        receipts: receipts.slice(-MAX_RECEIPTS),
        state: cases.some(item => item.disposition === 'needs-decision')
          ? 'needs-decision'
          : cases.some(item => item.disposition === 'waiting-evidence')
            ? 'waiting-evidence'
            : snapshot.success.complete &&
                tasks.every(task =>
                  maintenanceCheckpointCurrent(
                    checkpoints[task.key],
                    logicalHashes.get(task.record.uri),
                    sourceRevisions.get(task.project),
                    now,
                  ),
                )
              ? 'idle'
              : 'running',
        projects: [...new Set(active.map(record => record.metadata.project!))].sort().map(project => {
          const selected = tasks.filter(task => task.project === project);
          const checked = selected.filter(task =>
            maintenanceCheckpointCurrent(
              checkpoints[task.key],
              logicalHashes.get(task.record.uri),
              sourceRevisions.get(project),
              now,
            ),
          );
          return {
            project,
            generation,
            cursor: checked.length,
            eligible: selected.length,
            checked: checked.length,
            eligibleCitations: selected.reduce(
              (count, task) =>
                count + (task.record.metadata.codeCitations?.slice(task.chunk * 64, (task.chunk + 1) * 64).length ?? 0),
              0,
            ),
            checkedCitations: checked.reduce(
              (count, task) => count + (checkpoints[task.key]?.checkedCitations ?? 0),
              0,
            ),
          };
        }),
      };
      yield* writeState(config, state);
      yield* pruneReceiptJournals(config, state.receipts);
      return publicStatus(state);
    }),
  ).pipe(
    Effect.catchIf(
      error => typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'FileLockTimeout',
      () => readContextMaintenanceStatus(config),
    ),
  );
});

const repairRelations = Effect.fn('contextMaintenance.repairRelations')(function* (
  config: RuntimeConfig,
  original: MemoryRecord,
  changes: readonly {readonly relation: MemoryRelation; readonly policy: MaintenanceRelationPolicy}[],
  timestamp: string,
  expectedPostHash?: string,
) {
  const removed = changes.map(change => change.relation);
  const fs = yield* FileSystem.FileSystem;
  return yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [
      original.uri,
      ...(memoryIdentityLockKey(original.metadata.memoryId) === undefined
        ? []
        : [memoryIdentityLockKey(original.metadata.memoryId)!]),
      ...changes.flatMap(({relation: item, policy}) =>
        [
          item.uri,
          policy.target?.uri,
          policy.successor?.uri,
          ...(policy.lineage ?? []).flatMap(record => [record.uri, memoryIdentityLockKey(record.metadata.memoryId)]),
          memoryIdentityLockKey(policy.target?.metadata.memoryId),
          memoryIdentityLockKey(policy.successor?.metadata.memoryId),
          memoryIdentityLockKey(memoryIdFromIdentityAlias(item.uri)),
        ].filter((key): key is string => key !== undefined),
      ),
    ],
    Effect.gen(function* () {
      const current = (yield* readMemoryRecordsByUri(config, [original.uri]))[0];
      if (current === undefined || contentHash(current.content) !== contentHash(original.content))
        return yield* fail('The relation subject changed.');
      yield* Effect.try({
        try: () => assertMemoryDocumentSchemaWritable(current.content),
        catch: () => fail('Relation subject schema is not writable.'),
      });
      const lines = canonicalMemoryDocumentContent(current.content).split('\n');
      const separator = lines.indexOf('');
      const after = lines
        .flatMap((line, index) => {
          if (index > separator) return [line];
          const change = changes.find(({relation}) => line === `relation: ${relation.type} ${relation.uri}`);
          if (change === undefined) return [line];
          return change.policy.successor === undefined
            ? []
            : [`relation: ${change.relation.type} threadnote://memory/${change.policy.successor.metadata.memoryId}`];
        })
        .join('\n');
      if (expectedPostHash !== undefined && contentHash(after) !== expectedPostHash)
        return yield* fail('The journal relation proof changed.');
      if (after === current.content || parseMemoryDocument(current.uri, after) === undefined)
        return yield* fail('Relation repair could not be represented safely.');
      const receiptId = `maintenance-${sha256HexSync(`${original.uri}\0${contentHash(current.content)}\0${contentHash(after)}`).slice(0, 40)}`;
      const journal: UndoJournal = {
        receiptId,
        project: original.metadata.project ?? 'unscoped',
        subjectUri: original.uri,
        postHash: contentHash(after),
        timestamp,
        state: 'applying',
        before: current.content,
        after,
        removed,
        relationChanges: changes.map(({relation, policy}) => ({
          relation,
          targetHash: policy.target === undefined ? undefined : contentHash(policy.target.content),
          successorHash: policy.successor === undefined ? undefined : contentHash(policy.successor.content),
          lineageHashes: policy.lineage?.map(record => contentHash(record.content)),
        })),
      };
      const journalFile = yield* receiptPath(config, receiptId);
      yield* atomicJson(journalFile, journal);
      yield* writeMemoryFileChecked(
        config,
        'threadnote-native',
        current.uri,
        after,
        'replace',
        false,
        Effect.gen(function* () {
          const subject = (yield* readMemoryRecordsByUri(config, [current.uri]))[0];
          if (subject?.content !== current.content) return yield* fail('Relation repair CAS conflicted.');
          const closingCorpus = yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
          for (const {relation, policy} of changes) {
            if (
              !maintenanceRelationPolicyMatches(
                resolveMaintenanceRelationPolicy(subject, relation, closingCorpus),
                policy,
              )
            )
              return yield* fail('The relation target changed before CAS.');
            if (policy.target === undefined && (yield* resourceExists('threadnote-native', config, relation.uri)))
              return yield* fail('The relation target exists or cannot be proved absent.');
          }
        }),
        {quiet: true},
      );
      yield* discardDeferredCodeAnchorIntent(config, current.uri);
      const observed = (yield* readMemoryRecordsByUri(config, [current.uri]))[0];
      if (observed === undefined || contentHash(observed.content) !== journal.postHash)
        return yield* fail('Relation repair postcondition is unavailable.');
      yield* atomicJson(journalFile, {...journal, state: 'applied'});
      return receiptProjection({...journal, state: 'applied'});
    }),
  );
});

export const undoContextMaintenance = Effect.fn('contextMaintenance.undo')(function* (
  config: RuntimeConfig,
  receiptId: string,
) {
  if (!/^maintenance-[0-9a-f]{40}$/u.test(receiptId)) return yield* fail('Select an exact maintenance receipt.');
  return yield* withStateLock(
    config,
    Effect.gen(function* () {
      const state = yield* readState(config);
      const journal = yield* readJson<UndoJournal>(yield* receiptPath(config, receiptId));
      if (journal === undefined || journal.receiptId !== receiptId)
        return yield* fail('The maintenance receipt expired or is unavailable.');
      if (journal.state === 'undone') return {status: 'already-undone' as const, receiptId};
      const fs = yield* FileSystem.FileSystem;
      return yield* withMemoryUriLocks(
        fs,
        config.agentContextHome,
        [
          journal.subjectUri,
          ...(journal.archivedUri === undefined ? [] : [journal.archivedUri]),
          ...journal.removed.map(item => item.uri),
        ],
        Effect.gen(function* () {
          if (journal.postHash !== contentHash(journal.after) || isSharedMemoryUri(journal.subjectUri))
            return yield* fail('Maintenance receipt integrity failed.');
          if (journal.archivedUri !== undefined) {
            const original = parseMemoryDocument(journal.subjectUri, journal.before);
            if (original === undefined) return yield* fail('The original archived memory is unavailable.');
            if (
              original.metadata.validTo !== undefined &&
              Date.parse(original.metadata.validTo) <= (yield* Clock.currentTimeMillis)
            )
              return {status: 'conflict' as const, receiptId, reason: 'validity-policy-still-expired'};
            const observed = yield* readMemoryRecordsByUri(config, [journal.subjectUri, journal.archivedUri]);
            const source = observed.find(item => item.uri === journal.subjectUri);
            const archive = observed.find(item => item.uri === journal.archivedUri);
            if (source !== undefined && contentHash(source.content) !== contentHash(journal.before))
              return {status: 'conflict' as const, receiptId, reason: 'memory-changed'};
            if (
              archive === undefined &&
              source !== undefined &&
              contentHash(source.content) === contentHash(journal.before)
            ) {
              yield* atomicJson(yield* receiptPath(config, receiptId), {...journal, state: 'undone'});
              yield* writeState(config, {
                ...state,
                policyOverrides: {
                  ...state.policyOverrides,
                  [original.metadata.memoryId ?? original.uri]: contentHash(original.content),
                },
                receipts: state.receipts.map(item =>
                  item.receiptId === receiptId ? {...item, state: 'undone'} : item,
                ),
              });
              return {status: 'already-undone' as const, receiptId};
            }
            if (archive === undefined || contentHash(archive.content) !== journal.postHash)
              return {status: 'conflict' as const, receiptId, reason: 'archive-changed'};
            const corpus = yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
            if (
              (original.metadata.relations ?? []).some(
                item =>
                  resolveRelationTarget(corpus, item.uri).state === 'missing' ||
                  resolveRelationTarget(corpus, item.uri).state === 'conflicted',
              )
            )
              return {status: 'conflict' as const, receiptId, reason: 'restored-relations-unresolved'};
            if (source === undefined)
              yield* writeMemoryFile(config, 'threadnote-native', journal.subjectUri, journal.before, 'create', false, {
                quiet: true,
              });
            if (!(yield* forgetResourceWithRetry(config, journal.archivedUri, false, journal.after, true)))
              return {status: 'conflict' as const, receiptId, reason: 'archive-changed'};
            yield* atomicJson(yield* receiptPath(config, receiptId), {...journal, state: 'undone'});
            yield* writeState(config, {
              ...state,
              policyOverrides: {
                ...state.policyOverrides,
                [original.metadata.memoryId ?? original.uri]: contentHash(original.content),
              },
              receipts: state.receipts.map(item => (item.receiptId === receiptId ? {...item, state: 'undone'} : item)),
            });
            return {status: 'undone' as const, receiptId};
          }
          const current = (yield* readMemoryRecordsByUri(config, [journal.subjectUri]))[0];
          if (current === undefined || contentHash(current.content) !== journal.postHash)
            return {status: 'conflict' as const, receiptId, reason: 'memory-changed'};
          const corpus = yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
          if (journal.removed.some(item => resolveRelationTarget(corpus, item.uri).state !== 'active'))
            return {status: 'conflict' as const, receiptId, reason: 'restored-target-not-active'};
          const result = yield* writeMemoryFileChecked(
            config,
            'threadnote-native',
            current.uri,
            journal.before,
            'replace',
            false,
            Effect.gen(function* () {
              const subject = (yield* readMemoryRecordsByUri(config, [current.uri]))[0];
              if (subject?.content !== current.content) return yield* fail('The relation subject changed.');
              const closing = yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
              if (journal.removed.some(item => resolveRelationTarget(closing, item.uri).state !== 'active'))
                return yield* fail('The restored relation target changed.');
            }),
            {quiet: true},
          ).pipe(Effect.result);
          if (Result.isFailure(result))
            return {status: 'conflict' as const, receiptId, reason: 'restored-proof-changed'};
          yield* discardDeferredCodeAnchorIntent(config, current.uri);
          yield* atomicJson(yield* receiptPath(config, receiptId), {...journal, state: 'undone'});
          yield* writeState(config, {
            ...state,
            receipts: state.receipts.map(item => (item.receiptId === receiptId ? {...item, state: 'undone'} : item)),
          });
          return {status: 'undone' as const, receiptId};
        }),
      );
    }),
  );
});

export const retireContextMaintenanceAnchor = Effect.fn('contextMaintenance.retireAnchor')(function* (
  config: RuntimeConfig,
  input: {readonly caseId: string; readonly evidenceRevision: string; readonly expectedContentHash: string},
) {
  return yield* withStateLock(
    config,
    Effect.gen(function* () {
      const state = yield* readState(config);
      const item = state.cases.find(item => item.caseId === input.caseId);
      if (item === undefined || item.family !== 'citation' || item.evidenceRevision !== input.evidenceRevision)
        return yield* fail('The exact anchor case changed. Refresh its packet before retirement.');
      if (item.retirement?.expectedContentHash === input.expectedContentHash)
        return {status: 'already-retired' as const, caseId: item.caseId};
      if (
        item.anchorEvidence === undefined ||
        !['unknown', 'changed', 'deleted'].includes(item.anchorEvidence.status) ||
        !['needs-decision', 'waiting-evidence', 'historical'].includes(item.disposition)
      )
        return yield* fail(
          'Reviewed historicalization requires an exact unsupported anchor case. It never proves permanent evidence loss.',
        );
      const corpus = yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
      const record = corpus.find(record => (record.metadata.memoryId ?? record.uri) === item.memoryId);
      if (
        record === undefined ||
        contentHash(record.content) !== input.expectedContentHash ||
        item.subjectContentHashes?.find(subject => subject.uri === record.uri)?.hash !== input.expectedContentHash
      )
        return yield* fail('The anchor subject changed.');
      return yield* withMemoryUriLocks(
        yield* FileSystem.FileSystem,
        config.agentContextHome,
        [record.uri, memoryIdentityLockKey(record.metadata.memoryId)!].filter(
          (key): key is string => key !== undefined,
        ),
        Effect.gen(function* () {
          const current = (yield* readMemoryRecordsByUri(config, [record.uri]))[0];
          if (current === undefined || contentHash(current.content) !== input.expectedContentHash)
            return yield* fail('The anchor subject changed before CAS.');
          const citation = current.metadata.codeCitations?.find(
            citation => citation.id === item.citationId && contextHealthCitationCaseSlotV2(citation) === item.slot,
          );
          if (
            citation === undefined ||
            item.sourceSnapshot === undefined ||
            (yield* sourceGeneration(config, item.sourceSnapshot.cwd)) !== item.sourceSnapshot.generation ||
            (yield* recordSourceRevision(config, current, item.sourceSnapshot.cwd)) !== item.sourceSnapshot.revision
          )
            return yield* fail('The anchor or source evidence changed. Refresh the exact packet.');
          const evidence = yield* readContextHealthCitationEvidence(
            config,
            {kind: 'repository', callerCwd: item.sourceSnapshot.cwd, project: item.project},
            citation,
            {maximumBytes: 4_000, maximumLines: 24},
          );
          if (evidence.excerpts.some(excerpt => excerpt.provenance === 'current-verified' && excerpt.supportsCitation))
            return yield* fail('Current support recovered. Refresh the packet before choosing another workflow.');
          if (
            (yield* sourceGeneration(config, item.sourceSnapshot.cwd)) !== item.sourceSnapshot.generation ||
            (yield* recordSourceRevision(config, current, item.sourceSnapshot.cwd)) !== item.sourceSnapshot.revision
          )
            return yield* fail('Source evidence changed during reviewed historicalization.');
          const now = DateTime.formatIso(yield* DateTime.now);
          const cases = new Map(state.cases.map(item => [item.caseId, item]));
          const retired = {
            ...item,
            disposition: 'retired' as const,
            reason: 'reviewed-historical-anchor',
            nextAttemptAt: undefined,
            wake: undefined,
            retirement: {
              citationId: citation.id,
              anchorSlot: item.slot,
              evidenceRevision: item.evidenceRevision,
              expectedContentHash: input.expectedContentHash,
              retiredAt: now,
              reason: item.reason,
              provenance: evidence.excerpts.some(
                excerpt => excerpt.provenance === 'historical-verified' && excerpt.supportsCitation,
              )
                ? ('historical-verified' as const)
                : ('unverified' as const),
              evidenceGeneration: evidence.generation,
              attemptedSteps: evidence.attemptedSteps,
            },
          };
          cases.set(item.caseId, retired);
          const currentRequired = record.metadata.kind === 'durable' || record.metadata.kind === 'smoke';
          if (currentRequired) {
            const decision = upsertCase(
              cases,
              {
                project: item.project,
                memoryId: item.memoryId,
                family: 'current-support',
                slot: item.slot,
                evidenceRevision: item.evidenceRevision,
                disposition: 'needs-decision',
                reason: 'current-support-required',
              },
              now,
            );
            cases.set(decision.caseId, {
              ...decision,
              citationId: citation.id,
              subjectContentHashes: item.subjectContentHashes,
              sourceSnapshot: item.sourceSnapshot,
            });
          }
          yield* writeState(config, {
            ...state,
            checkpoints: Object.fromEntries(
              Object.entries(state.checkpoints).map(([key, checkpoint]) => [
                key,
                key.startsWith(`${item.memoryId}:`)
                  ? {...checkpoint, retryAt: nextMaintenanceDeadline(current, now)}
                  : checkpoint,
              ]),
            ),
            cases: [...cases.values()],
            state: [...cases.values()].some(item => item.disposition === 'needs-decision')
              ? 'needs-decision'
              : [...cases.values()].some(item => item.disposition === 'waiting-evidence')
                ? 'waiting-evidence'
                : 'idle',
          });
          return {
            status: 'retired' as const,
            caseId: item.caseId,
            currentSupportRequired: currentRequired,
            canonicalProvenancePreserved: true,
            permanentLossProven: false,
            recoveryIncomplete: !evidence.routesComplete,
          };
        }),
      );
    }),
  );
});

export const runContextMaintenanceScheduler = Effect.fn('contextMaintenance.scheduler')(function* (
  config: RuntimeConfig,
) {
  const cwd = (yield* SystemInfo).currentDirectory();
  for (;;) {
    yield* runContextMaintenance(config, {cwd}).pipe(Effect.ignore);
    yield* Effect.sleep('30 seconds');
  }
});

export const wakeContextMaintenance = Effect.fn('contextMaintenance.wake')(function* (config: RuntimeConfig) {
  const system = yield* SystemInfo;
  const state = yield* withStateLock(
    config,
    Effect.gen(function* () {
      const state = yield* readState(config);
      const now = yield* Clock.currentTimeMillis;
      if (state.paused || (state.lastWakeAt !== undefined && now - Date.parse(state.lastWakeAt) < 30_000)) return false;
      yield* writeState(config, {...state, lastWakeAt: DateTime.formatIso(DateTime.makeUnsafe(now))});
      return true;
    }),
  ).pipe(Effect.orElseSucceed(() => false));
  if (!state) return false;
  const executableName = system.executablePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  const script = executableName === 'bun' || executableName === 'bun.exe' ? system.processArguments[1] : undefined;
  const args = [
    ...(script === undefined ? [] : [script]),
    '--home',
    config.agentContextHome,
    '--manifest',
    config.manifestPath,
    'context',
    'maintain',
    '--max-records',
    '16',
    '--json',
  ];
  return yield* runDetachedCommandEffect(system.executablePath, args, {
    cwd: system.currentDirectory(),
    env: {
      ...system.environment(),
      THREADNOTE_ACCOUNT: config.account,
      THREADNOTE_USER: config.user,
      THREADNOTE_AGENT_ID: config.agentId,
    },
    intendedChild: 'context-maintenance',
  });
});

export const runContextMaintainCommand = Effect.fn('contextMaintenance.command')(function* (
  config: RuntimeConfig,
  options: {
    readonly project?: string;
    readonly maxRecords?: number;
    readonly json?: boolean;
    readonly action?: string;
    readonly receiptId?: string;
    readonly caseId?: string;
    readonly caseCursor?: string;
    readonly receiptCursor?: string;
    readonly limit?: number;
    readonly evidenceRevision?: string;
    readonly expectedContentHash?: string;
    readonly citationId?: string;
    readonly memoryUri?: string;
    readonly startLine?: number;
    readonly maximumLines?: number;
  },
) {
  const result =
    options.action === 'retire-anchor'
      ? yield* retireContextMaintenanceAnchor(config, {
          caseId: options.caseId ?? '',
          evidenceRevision: options.evidenceRevision ?? '',
          expectedContentHash: options.expectedContentHash ?? '',
        })
      : options.action === 'packet'
        ? yield* readContextMaintenancePacket(config, options.caseId ?? '', options)
        : options.action === 'status'
          ? yield* readContextMaintenanceStatus(config, options.project, options)
          : options.action === 'pause' || options.action === 'resume'
            ? yield* setContextMaintenancePaused(config, options.action === 'pause')
            : options.action === 'undo'
              ? yield* undoContextMaintenance(config, options.receiptId ?? '')
              : yield* runContextMaintenance(config, {
                  cwd: (yield* SystemInfo).currentDirectory(),
                  project: options.project,
                  maxRecords: options.maxRecords,
                });
  yield* writeFinalCliOutput(
    options.json
      ? JSON.stringify(result)
      : 'projects' in result
        ? renderContextMaintenanceStatus(result)
        : 'status' in result
          ? `Maintenance undo: ${result.status}`
          : JSON.stringify(result, null, 2),
  );
});

function contentHash(content: string) {
  return sha256HexSync(canonicalMemoryDocumentContent(content));
}
function fail(message: string) {
  return ContextMaintenanceError.make({message});
}
function emptyState(): MaintenanceState {
  return {
    version: 2,
    paused: false,
    state: 'idle',
    generation: '',
    projects: [],
    cases: [],
    receipts: [],
    checkpoints: {},
  };
}
function upsertMaintenanceReceipt(receipts: ContextMaintenanceReceiptV2[], receipt: ContextMaintenanceReceiptV2): void {
  const index = receipts.findIndex(item => item.receiptId === receipt.receiptId);
  if (index === -1) receipts.push(receipt);
  else receipts.splice(index, 1, receipt);
}

function receiptProjection(journal: UndoJournal): ContextMaintenanceReceiptV2 {
  const {
    before: _before,
    after: _after,
    removed: _removed,
    relationChanges: _relationChanges,
    archiveProposal: _archiveProposal,
    archiveCallerCwd: _archiveCallerCwd,
    ...receipt
  } = journal;
  return receipt;
}
const statePath = Effect.fn('contextMaintenance.statePath')(function* (config: RuntimeConfig) {
  return (yield* Path.Path).join(config.agentContextHome, 'context-maintenance', 'state-v2.json');
});
const receiptPath = Effect.fn('contextMaintenance.receiptPath')(function* (config: RuntimeConfig, id: string) {
  return (yield* Path.Path).join(config.agentContextHome, 'context-maintenance', 'receipts', `${id}.json`);
});
function withStateLock<A, E, R>(config: RuntimeConfig, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    return yield* withExclusiveFileLock(yield* FileSystem.FileSystem, `${yield* statePath(config)}.lock`, LOCK, effect);
  });
}
const readState = Effect.fn('contextMaintenance.readState')(function* (config: RuntimeConfig) {
  const state = yield* readJson<MaintenanceState>(yield* statePath(config));
  if (state === undefined) return emptyState();
  if (
    state.version !== 2 ||
    typeof state.paused !== 'boolean' ||
    !Array.isArray(state.cases) ||
    !Array.isArray(state.receipts) ||
    !Array.isArray(state.projects) ||
    typeof state.checkpoints !== 'object' ||
    state.checkpoints === null
  )
    return yield* fail('Maintenance state is malformed; preserve it for recovery.');
  return {...state, cases: migrateMaintenanceCases(state.cases)};
});
function readJson<A>(file: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(file).pipe(Effect.result);
    if (Result.isFailure(stat)) {
      if (stat.failure.reason._tag === 'NotFound') return undefined;
      return yield* stat.failure;
    }
    if (stat.success.type !== 'File' || Number(stat.success.size) > MAX_STATE_BYTES)
      return yield* fail('Maintenance state exceeds its read boundary.');
    const text = yield* fs.readFileString(file);
    return yield* Effect.try({try: () => JSON.parse(text) as A, catch: () => fail('Maintenance state is malformed.')});
  });
}
const atomicJson = Effect.fn('contextMaintenance.atomicJson')(function* (file: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), {recursive: true});
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.length > MAX_STATE_BYTES) return yield* fail('Maintenance state exceeds its write boundary.');
  const temporary = `${file}.${yield* (yield* Crypto.Crypto).randomUUIDv4}.tmp`;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
      yield* handle.writeAll(encoded);
      yield* handle.sync;
    }),
  ).pipe(
    Effect.andThen(fs.rename(temporary, file)),
    Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
  );
  yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.open(path.dirname(file), {flag: 'r'});
      yield* directory.sync;
    }),
  ).pipe(Effect.ignore);
});
function writeState(config: RuntimeConfig, state: MaintenanceState) {
  return Effect.flatMap(statePath(config), file => atomicJson(file, state));
}
const pruneReceiptJournals = Effect.fn('contextMaintenance.pruneReceipts')(function* (
  config: RuntimeConfig,
  receipts: readonly ContextMaintenanceReceiptV2[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(yield* receiptPath(config, 'unused'));
  if (!(yield* fs.exists(directory))) return;
  const retained = new Set(receipts.map(item => `${item.receiptId}.json`));
  for (const name of yield* fs.readDirectory(directory)) {
    if (/^maintenance-[0-9a-f]{40}\.json$/u.test(name) && !retained.has(name))
      yield* fs.remove(path.join(directory, name));
  }
});

export const proveAutomaticDuplicateArchive = Effect.fn('contextMaintenance.duplicateDependencyProof')(function* (
  config: RuntimeConfig,
  subject: MemoryRecord,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const before = yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account);
  const records = yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
  const after = yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account);
  if (before !== after || activeIncomingDependency(subject, records))
    return yield* fail('Duplicate dependency proof changed or found an active incoming dependency.');
});

export function duplicateArchiveSafe(subject: MemoryRecord, survivor: MemoryRecord | undefined): boolean {
  if (
    survivor === undefined ||
    survivor.uri === subject.uri ||
    isSharedMemoryUri(survivor.uri) ||
    subject.body.trim() !== survivor.body.trim()
  )
    return false;
  if (subject.metadata.memoryId === undefined || survivor.metadata.memoryId === undefined) return false;
  const relations = new Set((survivor.metadata.relations ?? []).map(item => `${item.type}:${item.uri}`));
  const citations = new Set((survivor.metadata.codeCitations ?? []).map(item => item.id));
  return (
    (subject.metadata.relations ?? []).every(item => relations.has(`${item.type}:${item.uri}`)) &&
    (subject.metadata.codeCitations ?? []).every(item => citations.has(item.id))
  );
}

export function nextMaintenanceDeadline(record: MemoryRecord, now: string): string | undefined {
  return [record.metadata.validTo, record.metadata.reviewAfter]
    .filter((value): value is string => value !== undefined && Date.parse(value) > Date.parse(now))
    .sort()[0];
}

const sourceGeneration = readContextMaintenanceSourceEpoch;

const recoverReceiptJournals = Effect.fn('contextMaintenance.recoverReceipts')(function* (
  config: RuntimeConfig,
  known: readonly ContextMaintenanceReceiptV2[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(yield* receiptPath(config, 'unused'));
  if (!(yield* fs.exists(directory))) return [] as ContextMaintenanceReceiptV2[];
  const existing = new Set(known.map(item => item.receiptId));
  const recovered: ContextMaintenanceReceiptV2[] = [];
  for (const name of (yield* fs.readDirectory(directory))
    .filter(name => /^maintenance-[0-9a-f]{40}\.json$/u.test(name))
    .slice(-MAX_RECEIPTS)) {
    const journal = yield* readJson<UndoJournal>(path.join(directory, name));
    if (journal === undefined || (existing.has(journal.receiptId) && journal.state !== 'applying')) continue;
    if (journal.postHash !== contentHash(journal.after) || isSharedMemoryUri(journal.subjectUri))
      return yield* fail('Maintenance receipt integrity failed.');
    if (journal.state === 'applying') {
      if (journal.archivedUri !== undefined) {
        const records = yield* readMemoryRecordsByUri(config, [journal.subjectUri, journal.archivedUri]);
        const archive = records.find(item => item.uri === journal.archivedUri);
        const source = records.find(item => item.uri === journal.subjectUri);
        if (archive !== undefined && contentHash(archive.content) === journal.postHash && source === undefined) {
          yield* atomicJson(path.join(directory, name), {...journal, state: 'applied'});
          recovered.push(receiptProjection({...journal, state: 'applied'}));
        } else if (
          source !== undefined &&
          contentHash(source.content) === contentHash(journal.before) &&
          journal.archiveProposal !== undefined &&
          journal.archiveCallerCwd !== undefined
        ) {
          const applied = yield* applyAutomaticContextHealthArchive(
            config,
            journal.archiveProposal,
            journal.archiveCallerCwd,
            journal.timestamp,
            journal.archiveProposal.category === 'exact-duplicate'
              ? source => proveAutomaticDuplicateArchive(config, source)
              : undefined,
          ).pipe(Effect.result);
          if (
            Result.isSuccess(applied) &&
            (applied.success.status === 'applied' || applied.success.status === 'already-applied')
          ) {
            yield* atomicJson(path.join(directory, name), {...journal, state: 'applied'});
            recovered.push(receiptProjection({...journal, state: 'applied'}));
          } else recovered.push(receiptProjection({...journal, state: 'conflict'}));
        } else recovered.push(receiptProjection({...journal, state: 'conflict'}));
        continue;
      }
      const current = (yield* readMemoryRecordsByUri(config, [journal.subjectUri]))[0];
      if (current !== undefined && contentHash(current.content) === journal.postHash) {
        yield* atomicJson(path.join(directory, name), {...journal, state: 'applied'});
        recovered.push(receiptProjection({...journal, state: 'applied'}));
      } else if (current !== undefined && contentHash(current.content) === contentHash(journal.before)) {
        const corpus = yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
        const changes = journal.removed.map(relation => ({
          relation,
          policy: resolveMaintenanceRelationPolicy(current, relation, corpus),
        }));
        const proofChanged = journal.relationChanges?.some(saved => {
          const policy = changes.find(
            item => item.relation.type === saved.relation.type && item.relation.uri === saved.relation.uri,
          )?.policy;
          return (
            saved.targetHash !== (policy?.target === undefined ? undefined : contentHash(policy.target.content)) ||
            saved.successorHash !==
              (policy?.successor === undefined ? undefined : contentHash(policy.successor.content)) ||
            (saved.lineageHashes !== undefined &&
              JSON.stringify(saved.lineageHashes) !==
                JSON.stringify(policy?.lineage?.map(record => contentHash(record.content))))
          );
        });
        const result = yield* (
          proofChanged || changes.some(change => !['prunable', 'redirectable'].includes(change.policy.state))
            ? Effect.fail(fail('The journal relation proof changed.'))
            : repairRelations(config, current, changes, journal.timestamp, journal.postHash)
        ).pipe(Effect.result);
        if (Result.isSuccess(result)) recovered.push(result.success);
        else recovered.push(receiptProjection({...journal, state: 'conflict'}));
      } else recovered.push(receiptProjection({...journal, state: 'conflict'}));
    } else recovered.push(receiptProjection(journal));
  }
  return recovered;
});

export const readContextMaintenancePacket = Effect.fn('contextMaintenance.packet')(function* (
  config: RuntimeConfig,
  caseId: string,
  selection: {
    readonly citationId?: string;
    readonly memoryUri?: string;
    readonly startLine?: number;
    readonly maximumLines?: number;
  } = {},
) {
  const state = yield* readState(config);
  const item = state.cases.find(item => item.caseId === caseId);
  if (item === undefined) return yield* fail('The selected maintenance case changed or expired.');
  if (item.family === 'candidate') {
    const current = (yield* readMaintenanceCandidateDecisions(config, item.project)).find(
      decision => decision.candidate.candidateId === item.slot,
    );
    if (current === undefined || current.revision !== item.evidenceRevision)
      return yield* fail('The candidate review changed or completed. Refresh maintenance and the review inbox.');
    return {
      version: 2 as const,
      caseId: item.caseId,
      project: item.project,
      subject: {
        kind: 'candidate-review' as const,
        reviewId: current.review.reviewId,
        candidateId: item.slot,
        revision: current.review.revision,
      },
      memoryUri: current.candidate.targetUri,
      memoryId: item.memoryId,
      evidenceRevision: item.evidenceRevision,
      expectedContentHash: current.revision,
      disposition: item.disposition,
      reason: item.reason,
      choices: [
        'Preview the exact candidate review',
        'Approve an explicitly reviewed candidate',
        'Defer or reject the candidate',
      ],
      allowedOperations: ['list_memory_candidates', 'apply_memory_candidates'],
      reviewInbox: {
        reviewId: current.review.reviewId,
        candidateId: item.slot,
        command: `threadnote closeout preview --review-id ${current.review.reviewId} --candidate-id ${item.slot} --json`,
      },
      instructions:
        'Preview this exact review revision before choosing approve, defer, or reject. Approval and destructive replacement require explicit user authorization. Candidate decisions use the review inbox, not context-health memory repair.',
    };
  }
  const corpus = yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
  const relatedMemories = ['semantic-contradiction', 'repository-recovery'].includes(item.family)
    ? corpus.filter(record => item.subjectContentHashes?.some(subject => subject.uri === record.uri) === true)
    : [];
  const record =
    corpus.find(record => (record.metadata.memoryId ?? record.uri) === item.memoryId) ?? relatedMemories[0];
  if (record === undefined) return yield* fail('The selected memory is unavailable.');
  const stale =
    item.subjectContentHashes === undefined ||
    item.subjectContentHashes.some(
      subject => contentHash(corpus.find(record => record.uri === subject.uri)?.content ?? '') !== subject.hash,
    );
  if (stale)
    return yield* fail(
      'The selected maintenance case is stale. Run maintenance to refresh its evidence before requesting a decision packet.',
    );
  if (
    item.sourceSnapshot !== undefined &&
    ((yield* sourceGeneration(config, item.sourceSnapshot.cwd)) !== item.sourceSnapshot.generation ||
      (yield* recordSourceRevision(config, record, item.sourceSnapshot.cwd)) !== item.sourceSnapshot.revision)
  )
    return yield* fail(
      'The selected maintenance case is stale. Source evidence changed; run maintenance before requesting a decision packet.',
    );
  const assertCurrent = Effect.gen(function* () {
    const latest = (yield* readState(config)).cases.find(current => current.caseId === item.caseId);
    if (latest?.evidenceRevision !== item.evidenceRevision || latest.disposition !== item.disposition)
      return yield* fail('The selected maintenance case changed. Refresh its packet.');
    const subjects = yield* readMemoryRecordsByUri(
      config,
      (item.subjectContentHashes ?? []).map(subject => subject.uri),
    );
    if (
      item.subjectContentHashes?.some(
        subject => contentHash(subjects.find(record => record.uri === subject.uri)?.content ?? '') !== subject.hash,
      )
    )
      return yield* fail('The selected maintenance subject changed. Refresh its packet.');
    for (const source of item.sourceSnapshots ?? []) {
      const subject = subjects.find(record => record.uri === source.uri);
      if (
        subject === undefined ||
        (yield* sourceGeneration(config, source.cwd)) !== source.generation ||
        (yield* recordSourceRevision(config, subject, source.cwd)) !== source.revision
      )
        return yield* fail('The selected repository recovery source changed. Refresh its packet.');
    }
    if (
      item.sourceSnapshot !== undefined &&
      ((yield* sourceGeneration(config, item.sourceSnapshot.cwd)) !== item.sourceSnapshot.generation ||
        (yield* recordSourceRevision(config, record, item.sourceSnapshot.cwd)) !== item.sourceSnapshot.revision)
    )
      return yield* fail('The selected maintenance source changed. Refresh its packet.');
  });
  return yield* buildContextMaintenancePacket(
    config,
    {item, record, corpus, callerCwd: item.sourceSnapshot?.cwd ?? (yield* SystemInfo).currentDirectory(), selection},
    assertCurrent,
  );
});

export function migrateMaintenanceCases(
  cases: readonly ContextMaintenanceCaseV2[],
  records: readonly MemoryRecord[] = [],
  hashes?: ReadonlyMap<string, string>,
): readonly ContextMaintenanceCaseV2[] {
  const identities = new Map<string, ContextMaintenanceCaseV2>();
  for (const item of cases) {
    const subject = records.find(record => (record.metadata.memoryId ?? record.uri) === item.memoryId);
    const ordinal = /^(?:anchor:)?(\d+)$/u.exec(item.slot);
    const unchangedSubject =
      subject !== undefined &&
      item.subjectContentHashes?.some(
        reference =>
          reference.uri === subject.uri &&
          reference.hash === (hashes?.get(subject.uri) ?? contentHash(subject.content)),
      );
    const citationId =
      item.citationId ??
      (unchangedSubject && ordinal !== null ? subject.metadata.codeCitations?.[Number(ordinal[1])]?.id : undefined);
    const slot =
      item.family === 'citation'
        ? records.length === 0 || item.slot.startsWith('legacy-unresolved:')
          ? item.slot
          : /^anchor:tncc_[0-9a-f]{40}$/u.test(item.slot) &&
              !subject?.metadata.codeCitations?.some(
                citation => contextHealthCitationCaseSlotV2(citation) === item.slot,
              )
            ? item.slot
            : (migrateContextHealthCitationCaseSlotV2({
                slot: item.slot,
                citationId,
                citations:
                  records.find(record => (record.metadata.memoryId ?? record.uri) === item.memoryId)?.metadata
                    .codeCitations ?? [],
              }) ?? `legacy-unresolved:${item.caseId}`)
        : item.family === 'relation'
          ? item.slot.replace(/^(?:depends_on|references|related_to|supersedes|evidence_for):(?=threadnote:\/\/)/u, '')
          : item.slot === item.family && item.family !== 'citation'
            ? 'record'
            : item.slot;
    const canonicalSlot =
      item.family === 'relation' ? (resolveRelationTarget(records, slot).record?.metadata.memoryId ?? slot) : slot;
    const next = {
      ...item,
      slot: canonicalSlot,
      disposition:
        item.family === 'review-overdue' && item.disposition === 'deferred-policy'
          ? ('needs-decision' as const)
          : item.disposition,
      caseId: contextHealthCaseIdV2({...item, slot: canonicalSlot}),
    };
    const prior = identities.get(next.caseId);
    identities.set(next.caseId, prior === undefined ? next : mergeMaintenanceCaseLineage(prior, next));
  }
  return [...identities.values()];
}
