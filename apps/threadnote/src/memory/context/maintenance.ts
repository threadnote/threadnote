import {Array as EffectArray, Option as EffectOption} from 'effect';
import {currentMemoryCodeCitations} from '@threadnote/memory/reviewed-support';
import {ManagerLiveChangeHints} from '../../manager/live_sources.js';
import {prepareAutomaticMaintenance} from './maintenance_preparation.js';
import {publicStatus} from './maintenance_projection.js';
import {reviewedSemanticMaintenanceCases, saveReviewedSemanticMaintenanceCases} from './semantic_review_state.js';
import type {
  ContextMaintenanceReceiptV2,
  ContextMaintenanceReadOptions,
  MaintenanceState,
  UndoJournal,
} from './maintenance_contracts.js';
import {isMaintenanceState, isUndoJournal} from './maintenance_json.js';
import {MaintenancePauseFenceBusy} from './maintenance_contracts.js';
export type {
  ContextMaintenanceCaseV2,
  ContextMaintenanceReceiptV2,
  ContextMaintenanceReadOptions,
  ContextMaintenanceStatusV2,
  MaintenanceState,
} from './maintenance_contracts.js';
import {
  migrateMaintenanceCases,
  selectFairMaintenanceWork,
  selectMaintenanceCitationCaseTask,
  nextMaintenanceDeadline,
  maintenanceContentHash as contentHash,
  maintenanceCheckpointCurrent,
  duplicateArchiveSafe,
  reconcileRepositoryRecoveryCases,
  upsertCase,
  resolveRelationTarget,
  resolveMaintenanceRelationPolicy,
  maintenanceRelationPolicyMatches,
  reconcileAbsentMaintenanceAnchors,
  hasAbsentMaintenanceAnchors,
  maintenanceAnchorChunksComplete,
  type MaintenanceRelationPolicy,
} from './maintenance_policy.js';
export {renderContextMaintenanceStatus} from './maintenance_projection.js';
export {planMaintenanceWorkerBatches, maintenanceWorkerRecordValidations} from './maintenance_batch.js';
export {
  selectFairMaintenanceWork,
  nextMaintenanceDeadline,
  updateMaintenanceCase,
  reconcileRepositoryRecoveryCases,
  resolveRelationTarget,
  resolveMaintenanceRelationPolicy,
  safeRelationRemoval,
  maintenanceAnchorChunksComplete,
  duplicateArchiveSafe,
} from './maintenance_policy.js';
import {Clock, Crypto, DateTime, Effect, FileSystem, Path, Result, Schema} from 'effect';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runDetachedCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {
  assertMemoryDocumentSchemaWritable,
  canonicalMemoryDocumentContent,
  isAgentArtifactUri,
  isSharedMemoryUri,
  parseMemoryDocument,
  type MemoryRecord,
  type MemoryRelation,
} from '@threadnote/memory/document';
import {hasTopicMaintenanceEnrollment} from '@threadnote/memory/topic-maintenance';
import type {TopicMaintenanceReviewPayload} from '@threadnote/memory/topic-maintenance-draft';
import {memoryIdentityLockKey, memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {contextHealthCaseIdV2, contextHealthCitationCaseSlotV2} from '@threadnote/context/health_maintenance';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION} from '@threadnote/context/health_semantic';
import {readMaintenanceMemoryRecords} from '../maintenance/records.js';
import {
  contextMaintenanceInventoryPreparation,
  prepareContextMaintenanceInventory,
  pruneAbsentMaintenanceCheckpoints,
} from './maintenance_inventory.js';
import {
  contextMaintenanceEvidenceDiscoveryPending,
  readContextMaintenanceEvidenceRequestPage,
  contextMaintenanceEvidenceRequestKey,
  readContextMaintenanceSourceEpoch,
} from './maintenance_evidence.js';
import {
  activeIncomingDependency,
  prepareMaintenanceSemanticProgress,
  readMaintenanceCandidateDecisions,
  runMaintenanceSemanticWindow,
  maintenanceSemanticProgressPending,
  maintenanceSemanticProgressUnsupported,
  selectMaintenanceWorkAndRequestCursor,
} from './maintenance_decisions.js';
import {readMemoryRecordsByUri, resourceExists} from '../../mcp/server/memory.js';
import * as selectedMaintenance from './maintenance_refresh.js';
export {runContextMaintainCommand} from './maintenance_commands.js';
import {collectContextHealthEvidence} from './health_commands.js';
import {contextHealthFindingCaseIdentityV2} from '@threadnote/context/health_maintenance';
import {writeMemoryFile, writeMemoryFileChecked} from '../../share/index.js';
import {discardDeferredCodeAnchorIntent} from '../deferred/code_anchor.js';
import {forgetResourceWithRetry} from '../../mcp/server/memory.js';
import {previewContextHealthRepairPlanV1} from './health_repair.js';
import {
  applyAutomaticContextHealthArchive,
  previewAutomaticContextHealthArchiveReceipt,
} from './health_repair_commands.js';
import {readContextHealthCitationEvidence} from '@threadnote/context/citation_validation';
import {makeContextMaintenancePacketReader} from './maintenance_packet.js';
import {
  advanceScheduledTopicMaintenance,
  enrolledTopicCandidate,
  reconcileAcceptedTopicMaintenanceState,
  pruneAbsentTopicCheckpoints,
  selectRetainedMaintenanceCases,
  topicMaintenanceCaseId,
  validTopicMaintenanceCheckpoints,
  TOPIC_MAINTENANCE_FAMILY,
  type TopicReviewDecisionInput,
  saveTopicReviewDecision,
} from './maintenance_topic.js';
import {
  maintenanceCitationAdmissionVersion,
  maintenanceRecordSourceObservation,
  maintenanceRecordRevision,
  recordSourceRevision,
} from './maintenance_source.js';
import {
  prepareMaintenanceWorkerBatches,
  readMaintenanceInventorySubjects,
  runRequestedMaintenanceProjection,
  selectRelationBoundedMaintenanceWindow,
  maintenanceWorkerBatchCurrent,
  maintenanceWorkerCheckpointReusable,
  invalidateMaintenanceWorkerBatch,
} from './maintenance_batch.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MAX_RECEIPTS = 100;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const LOCK = {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 60_000, waitTimeoutMilliseconds: 50};
export class ContextMaintenanceError extends Schema.TaggedError<
  ContextMaintenanceError,
  {readonly brand: unique symbol}
>()('ContextMaintenanceError', {
  message: Schema.String,
}) {}

export const readContextMaintenanceStatus = Effect.fn('contextMaintenance.status')(function* (
  config: RuntimeConfig,
  project?: string,
  options: ContextMaintenanceReadOptions = {},
) {
  const rawState = yield* readState(config);
  const yieldedState = {...rawState, cases: yield* reviewedSemanticMaintenanceCases(config, rawState.cases, project)};
  return yield* Effect.try({
    try: () => publicStatus(yieldedState, project, options),
    catch: error => fail(error instanceof Error ? error.message : 'Invalid maintenance selector.'),
  });
});
export const reconcileSemanticReviewMaintenanceCases = (config: RuntimeConfig) =>
  withStateLock(
    config,
    readState(config).pipe(
      Effect.flatMap(state => saveReviewedSemanticMaintenanceCases(config, state, next => writeState(config, next))),
    ),
  );

export const recordTopicMaintenanceReviewDecision = (config: RuntimeConfig, input: TopicReviewDecisionInput) =>
  withStateLock(
    config,
    readState(config).pipe(
      Effect.flatMap(state => saveTopicReviewDecision(state, input, next => writeState(config, next))),
    ),
  );

export function reconcileAcceptedTopicMaintenanceCase<A, E, R>(
  config: RuntimeConfig,
  original: MemoryRecord,
  acceptedContent: string,
  payload: TopicMaintenanceReviewPayload,
  sourceCwd: string | undefined,
  complete: Effect.Effect<A, E, R>,
) {
  return withStateLock(
    config,
    readState(config).pipe(
      Effect.flatMap(state =>
        reconcileAcceptedTopicMaintenanceState(
          config,
          state,
          original,
          acceptedContent,
          payload,
          sourceCwd,
          next => writeState(config, next),
          complete,
        ),
      ),
    ),
  );
}

export const setContextMaintenancePaused = Effect.fn('contextMaintenance.pause')(function* (
  config: RuntimeConfig,
  paused: boolean,
) {
  return yield* selectedMaintenance.withMaintenanceOperationLock(
    config,
    Effect.gen(function* () {
      const state = {...(yield* readState(config)), paused};
      yield* writeState(config, state);
      return publicStatus(state);
    }),
  );
});

export function withMaintenancePauseFence<A, E, R>(config: RuntimeConfig, publish: Effect.Effect<A, E, R>) {
  return Effect.suspend(() => {
    let entered = false;
    return withStateLock(
      config,
      Effect.gen(function* () {
        entered = true;
        if ((yield* readState(config)).paused)
          return yield* fail('Automatic generation is paused with all context maintenance.');
        return yield* publish;
      }),
    ).pipe(
      Effect.catchIf(
        error => !entered && isFileLockTimeout(error),
        () => Effect.fail(MaintenancePauseFenceBusy.make({})),
      ),
    );
  });
}

export const runContextMaintenance = Effect.fn('contextMaintenance.run')(function* (
  config: RuntimeConfig,
  options: {readonly cwd: string; readonly project?: string; readonly maxRecords?: number; readonly caseId?: string},
) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(options.cwd)) return yield* fail('Maintenance cwd must be absolute.');
  const maxRecords = Math.max(1, Math.min(100, options.maxRecords ?? 16));
  return yield* selectedMaintenance.withMaintenanceOperationLock(
    config,
    Effect.gen(function* () {
      let state = yield* readState(config);
      const selectedCase =
        options.caseId === undefined
          ? undefined
          : EffectOption.getOrUndefined(EffectArray.findFirst(state.cases, item => item.caseId === options.caseId));
      if (options.caseId !== undefined) {
        if (selectedCase === undefined || (options.project !== undefined && selectedCase.project !== options.project))
          return yield* fail('The exact maintenance case is unavailable in this project.');
        if (selectedCase.family !== 'citation' && selectedCase.family !== 'citation-coverage')
          return yield* fail(
            'Exact run supports citation cases only. Use context maintain --action refresh --project <project> --case-id <case-id> --json to inspect current evidence without changing canonical memories.',
          );
        options = {...options, project: selectedCase.project};
      }
      if (state.paused) return publicStatus(state);
      const started = yield* Clock.currentTimeMillis;
      let snapshot = yield* prepareContextMaintenanceInventory(
        config,
        options.project,
        Math.min(256, maxRecords * 16),
      ).pipe(Effect.result);
      if (Result.isFailure(snapshot) && snapshot.failure.diagnostic.retryable)
        snapshot = yield* prepareContextMaintenanceInventory(
          config,
          options.project,
          Math.min(256, maxRecords * 16),
        ).pipe(Effect.result);
      if (Result.isFailure(snapshot)) {
        state = {
          ...state,
          state: 'failed',
          error: {
            at: DateTime.formatIso(DateTime.makeUnsafe(started)),
            reason: 'memory-snapshot-unreadable',
            diagnostic: snapshot.failure.diagnostic,
          },
        };
        yield* writeState(config, state);
        return publicStatus(state);
      }
      const inventory = snapshot.success;
      const corpus = yield* readMaintenanceInventorySubjects(config, inventory.records, inventory.hashes);
      if (!EffectArray.every(corpus, (record): record is MemoryRecord => record !== undefined))
        return yield* fail('The approved-support inventory subject changed; refresh maintenance.');
      const completeCorpus = EffectArray.filter(corpus, (record): record is MemoryRecord => record !== undefined);
      const logicalHashes = snapshot.success.canonicalContentHashes;
      if (selectedCase === undefined)
        state = {
          ...state,
          cases: migrateMaintenanceCases(state.cases, completeCorpus, logicalHashes, snapshot.success.complete),
        };
      const active = EffectArray.map(
        EffectArray.filter(completeCorpus, record => record.metadata.status === 'active'),
        record =>
          record.metadata.project === undefined
            ? {...record, metadata: {...record.metadata, project: 'unscoped'}}
            : record,
      );
      const topicRecords = EffectArray.filter(
        active,
        record =>
          (options.project === undefined || record.metadata.project === options.project) &&
          enrolledTopicCandidate(record),
      );
      const now = DateTime.formatIso(DateTime.makeUnsafe(started));
      const generation = snapshot.success.generation;
      const roots = yield* prepareAutomaticMaintenance(config, snapshot.success, options);
      const checkpoints = {...state.checkpoints};
      const caseMap = new Map(EffectArray.map(state.cases, item => [item.caseId, item]));
      const evidencePage = yield* readContextMaintenanceEvidenceRequestPage(
        config,
        state.workSchedule?.requestDiscovery?.lastFile,
      );
      const evidenceRequests = evidencePage.requests;
      const candidateDecisions =
        selectedCase === undefined ? yield* readMaintenanceCandidateDecisions(config, options.project) : [];
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
          selectedCase === undefined &&
          item.family === 'candidate' &&
          (options.project === undefined || item.project === options.project) &&
          !pendingCandidateIds.has(id)
        )
          caseMap.set(id, {...item, disposition: 'resolved', reason: 'candidate-review-completed', lastChecked: now});
      const receipts = [
        ...new Map(
          EffectArray.map(
            [
              ...state.receipts,
              ...(selectedCase === undefined ? yield* recoverReceiptJournals(config, state.receipts) : []),
            ],
            item => [item.receiptId, item],
          ),
        ).values(),
      ];
      const sourceRevisions = new Map<string, string>();
      const recordSourceRevisions = new Map<string, string>();
      const tasks = EffectArray.flatMap(active, record => {
        const chunks = Math.max(1, Math.ceil(currentMemoryCodeCitations(record).length / 64));
        return Array.from({length: chunks}, (_, chunk) => ({
          record,
          project: record.metadata.project!,
          chunk,
          key: `${record.metadata.memoryId ?? record.uri}:${chunk}`,
          revision: snapshot.success.hashes.get(record.uri) ?? contentHash(record.content),
        }));
      });
      const keys = new Set(EffectArray.map(tasks, task => task.key));
      const selectedTask =
        selectedCase === undefined ? undefined : selectMaintenanceCitationCaseTask(tasks, selectedCase);
      if (selectedCase !== undefined && selectedTask === undefined)
        return yield* fail(
          'The selected citation subject or anchor is unavailable; refresh inventory or review its current identity.',
        );
      if (selectedCase === undefined)
        pruneAbsentMaintenanceCheckpoints(checkpoints, keys, {
          project: options.project,
          complete: snapshot.success.complete,
        });
      const topicCheckpoints = pruneAbsentTopicCheckpoints(
        state.topicCheckpoints ?? {},
        new Set(EffectArray.map(topicRecords, topicMaintenanceCaseId)),
        snapshot.success.complete && options.project === undefined,
      );
      const pending = EffectArray.filter(
        tasks,
        task => options.project === undefined || task.project === options.project,
      );
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
        if (left.project !== right.project)
          return Effect2.pipe(left.project, EffectString.localeCompare(right.project));
        const cursor = state.lastTaskByProject?.[left.project];
        const leftAfter = cursor === undefined || left.key > cursor;
        const rightAfter = cursor === undefined || right.key > cursor;
        return Number(rightAfter) - Number(leftAfter) || Effect2.pipe(left.key, EffectString.localeCompare(right.key));
      });
      const {
        projects: semanticProjects,
        generations: semanticGenerations,
        progress: semanticProgress,
        pending: pendingSemanticProjects,
      } = prepareMaintenanceSemanticProgress(
        active,
        snapshot.success.hashes,
        state.semanticProgress,
        options.project,
        snapshot.success.complete,
      );
      for (const item of caseMap.values()) {
        const projectProgress = state.semanticProgress?.[item.project];
        const progressNeedsRefresh =
          projectProgress === undefined ||
          projectProgress.version !== 2 ||
          projectProgress.analyzerVersion !== CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION;
        if (
          (options.project === undefined || item.project === options.project) &&
          item.family === 'semantic-contradiction' &&
          item.disposition === 'needs-decision' &&
          (progressNeedsRefresh ||
            EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(item.subjectContentHashes), __effectOptionalArray =>
                Boolean(
                  EffectArray.some(__effectOptionalArray, subject => {
                    const current = logicalHashes.get(subject.uri);
                    return current === undefined ? snapshot.success.complete : current !== subject.hash;
                  }),
                ),
              ),
            ))
        ) {
          upsertCase(
            caseMap,
            {...item, disposition: 'historical', reason: 'semantic-analyzer-v2-evidence-superseded'},
            now,
          );
        }
      }
      const {work, requestDiscovery} = yield* selectMaintenanceWorkAndRequestCursor(
        state.workSchedule,
        pendingSemanticProjects,
        tasks.length > 0,
        evidencePage,
        started,
        options.project,
        topicRecords.length > 0,
      );
      state = {
        ...state,
        generation,
        semanticProgress: selectedCase === undefined ? semanticProgress : state.semanticProgress,
        workSchedule: selectedCase === undefined ? {...work.next, requestDiscovery} : state.workSchedule,
        topicCheckpoints: selectedCase === undefined ? topicCheckpoints : state.topicCheckpoints,
        state: 'running',
        error: undefined,
      };
      yield* writeState(config, state);
      if (selectedCase === undefined && work.phase === 'semantic') {
        const project = work.project!;
        const revision = semanticGenerations.get(project)!;
        const progress = semanticProgress[project];
        if (progress.version !== 2) return yield* fail('Semantic work was selected without current analyzer progress.');
        const headroom =
          MAX_STATE_BYTES -
          new TextEncoder().encode(JSON.stringify({...state, cases: [...caseMap.values()]})).length -
          512 * 1_024;
        const next = yield* runMaintenanceSemanticWindow(config, project, progress, caseMap, now, headroom);
        state = {
          ...state,
          decisionCheckpoints: {...state.decisionCheckpoints, [project]: revision},
          semanticProgress: {
            ...state.semanticProgress,
            [project]: next,
          },
        };
      }
      if (selectedCase === undefined && work.phase === 'requested') {
        const request = EffectOption.getOrUndefined(
          EffectArray.findFirst(evidenceRequests, item => contextMaintenanceEvidenceRequestKey(item) === work.root),
        )!;
        yield* runRequestedMaintenanceProjection(config, request, active, completeCorpus, snapshot.success.complete);
      }
      if (selectedCase === undefined && work.phase === 'topic') {
        state = yield* advanceScheduledTopicMaintenance(
          config,
          state,
          topicRecords,
          roots,
          options.cwd,
          logicalHashes,
          now,
          topicCheckpoints,
          caseMap,
        );
      }
      // maxRecords still controls inventory pagination; record work remains four per tick.
      const selected =
        selectedTask !== undefined
          ? [selectedTask]
          : work.phase === 'records'
            ? selectRelationBoundedMaintenanceWindow(
                selectFairMaintenanceWork(rotated, state.lastProject, Math.min(maxRecords, 4)),
              )
            : [];
      const {batches, batchByTask} = yield* prepareMaintenanceWorkerBatches(
        config,
        selected,
        roots,
        options.cwd,
        started,
        now,
        selectedCase === undefined ? checkpoints : {},
        caseMap,
      );
      const workStarted = yield* Clock.currentTimeMillis;
      const previousCitationCases = new Map(caseMap);
      for (const task of selected) {
        if (task !== selected[0] && (yield* Clock.currentTimeMillis) - workStarted > 5_000) break;
        const currentRecord = (yield* readMemoryRecordsByUri(config, [task.record.uri]))[0];
        if (
          selectedCase !== undefined &&
          (currentRecord?.metadata.status !== 'active' ||
            contentHash(currentRecord.content) !== logicalHashes.get(task.record.uri) ||
            selectMaintenanceCitationCaseTask(
              [{...task, record: currentRecord, project: currentRecord.metadata.project ?? 'unscoped'}],
              selectedCase,
            ) === undefined)
        )
          return yield* fail('The selected citation subject changed during refresh. Retry with current evidence.');
        if (currentRecord === undefined || currentRecord.metadata.status !== 'active') continue;
        const record =
          currentRecord.metadata.project === undefined
            ? {...currentRecord, metadata: {...currentRecord.metadata, project: 'unscoped'}}
            : currentRecord;
        if (selected.length > 1 && (record.metadata.relations?.length ?? 0) > 0) break;
        const memoryId = record.metadata.memoryId ?? record.uri;
        let postMutationHash: string | undefined;
        if (selectedCase === undefined)
          state = {
            ...state,
            lastProject: task.project,
            lastTaskByProject: {...state.lastTaskByProject, [task.project]: task.key},
          };
        if (currentMemoryCodeCitations(record).length > 0) {
          const source = yield* maintenanceRecordSourceObservation(
            config,
            record,
            roots.get(task.project) ?? options.cwd,
            sourceRevisions.get(task.project),
            batchByTask.get(task.key)?.observation,
            selectedCase !== undefined,
          );
          sourceRevisions.set(task.project, source.epoch);
          recordSourceRevisions.set(record.uri, source.revision);
        }
        const relationCorpus =
          snapshot.success.complete && (record.metadata.relations?.length ?? 0) > 0
            ? yield* readMaintenanceMemoryRecords(config, {requireReadable: true})
            : completeCorpus;
        task.revision = maintenanceRecordRevision(
          record,
          relationCorpus,
          snapshot.success.complete,
          sourceRevisions.get(task.project),
          recordSourceRevisions.get(record.uri),
        );
        const check = checkpoints[task.key];
        const workerEvidence = batchByTask.get(task.key);
        const legacy = EffectArray.some(
          state.cases,
          item =>
            item.memoryId === memoryId &&
            ['needs-decision', 'waiting-evidence'].includes(item.disposition) &&
            item.subjectContentHashes === undefined,
        );
        if (
          selectedCase === undefined &&
          maintenanceWorkerCheckpointReusable(record, check, workerEvidence, task.revision, now, legacy)
        )
          continue;
        const previousCases = EffectArray.filter(
          [...caseMap.values()],
          item =>
            item.project === task.project &&
            item.memoryId === memoryId &&
            (Effect2.pipe(item.family, EffectString.startsWith('citation'))
              ? item.family === 'citation-coverage'
                ? item.slot === String(task.chunk)
                : EffectArray.some(
                    currentMemoryCodeCitations(record).slice(task.chunk * 64, (task.chunk + 1) * 64),
                    citation => contextHealthCitationCaseSlotV2(citation) === item.slot,
                  )
              : selectedCase === undefined && task.chunk === 0 && item.family !== TOPIC_MAINTENANCE_FAMILY),
        );
        const seen = new Set<string>();
        if (selectedCase === undefined && task.chunk === 0) {
          const changes = EffectArray.flatMap(record.metadata.relations ?? [], relation => {
            const policy = resolveMaintenanceRelationPolicy(
              record,
              relation,
              relationCorpus,
              snapshot.success.complete,
            );
            return policy.state === 'prunable' || policy.state === 'redirectable' ? [{relation, policy}] : [];
          });
          const removal = EffectArray.map(changes, change => change.relation);
          for (const relation of record.metadata.relations ?? []) {
            if (isAgentArtifactUri(relation.uri)) continue;
            const target = resolveRelationTarget(relationCorpus, relation.uri);
            if (target.state === 'active') continue;
            const policy = resolveMaintenanceRelationPolicy(
              record,
              relation,
              relationCorpus,
              snapshot.success.complete,
            );
            const removable = EffectArray.some(
              removal,
              item => item.type === relation.type && item.uri === relation.uri,
            );
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
              if (isAgentArtifactUri(relation.uri)) continue;
              const target = resolveRelationTarget(completeCorpus, relation.uri);
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
                  slot: resolveRelationTarget(completeCorpus, relation.uri).record?.metadata.memoryId ?? relation.uri,
                });
                const item = caseMap.get(id);
                if (item !== undefined)
                  caseMap.set(id, {
                    ...item,
                    disposition: EffectArray.some(
                      record.metadata.relations ?? [],
                      link =>
                        link.uri === relation.uri &&
                        !EffectArray.some(removal, removed => removed.type === link.type && removed.uri === link.uri),
                    )
                      ? 'historical'
                      : EffectOption.getOrUndefined(
                            EffectArray.findFirst(changes, change => change.relation.uri === relation.uri),
                          )?.policy.state === 'redirectable'
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
        const citations = currentMemoryCodeCitations(record).slice(task.chunk * 64, (task.chunk + 1) * 64);
        const duplicateRecords = yield* readMemoryRecordsByUri(
          config,
          EffectArray.map(
            EffectArray.filter(
              active,
              item =>
                item.uri !== record.uri &&
                snapshot.success.bodyHashes.get(item.uri) === snapshot.success.bodyHashes.get(record.uri),
            ).slice(0, 16),
            item => item.uri,
          ),
        );
        const repairCorpus = [
          record,
          ...duplicateRecords,
          ...EffectArray.filter(
            completeCorpus,
            item =>
              item.uri !== record.uri && !EffectArray.some(duplicateRecords, duplicate => duplicate.uri === item.uri),
          ),
        ];
        const collected = yield* collectContextHealthEvidence(
          config,
          task.project,
          [{...record, metadata: {...record.metadata, relations: []}}],
          roots.get(task.project) ?? options.cwd,
          {
            relationCorpus: completeCorpus,
            duplicateCorpus: [record, ...duplicateRecords],
            evidenceMode: 'worker',
            workerEvidence: batchByTask.get(task.key),
            includeCitationCoverageFindings: true,
            citationRecords: [{...record, metadata: {...record.metadata, codeCitations: citations}}],
          },
        ).pipe(Effect.result);
        const report = Result.isSuccess(collected)
          ? Result.succeed(collected.success.report)
          : Result.fail(collected.failure);
        if (Result.isSuccess(report)) {
          if (
            selectedCase === undefined &&
            task.chunk === 0 &&
            !isSharedMemoryUri(record.uri) &&
            !hasTopicMaintenanceEnrollment(record)
          ) {
            const archive = Effect2.Option.getOrUndefined(
              EffectArray.findFirst(
                previewContextHealthRepairPlanV1(report.success, repairCorpus).proposals,
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
                        EffectOption.getOrUndefined(
                          EffectArray.findFirst(
                            duplicateRecords,
                            item =>
                              item.uri ===
                              (proposal.mutation.kind === 'archive-memory' ? proposal.mutation.survivorUri : undefined),
                          ),
                        ),
                      ))),
              ),
            );
            if (archive !== undefined && state.policyOverrides?.[memoryId] !== contentHash(record.content)) {
              const prepared = previewAutomaticContextHealthArchiveReceipt(config, archive, record, now);
              const pendingReceipt: UndoJournal = {
                receiptId: `maintenance-${Effect2.pipe(sha256HexSync(archive.revision), EffectString.slice(0, 40))}`,
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
                const archivedRecord = EffectOption.getOrUndefined(
                  EffectArray.findFirst(
                    yield* readMaintenanceMemoryRecords(config, {requireReadable: true}),
                    item =>
                      item.metadata.archivedFrom === record.uri && item.metadata.memoryId === record.metadata.memoryId,
                  ),
                );
                if (archivedRecord !== undefined) {
                  const receipt: UndoJournal = {
                    receiptId: `maintenance-${Effect2.pipe(sha256HexSync(archive.revision), EffectString.slice(0, 40))}`,
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
          const enrolled = hasTopicMaintenanceEnrollment(record);
          for (const finding of report.success.findings) {
            if (enrolled && ['citation-changed', 'citation-missing'].includes(finding.category)) continue;
            if (selectedCase !== undefined && !Effect2.pipe(finding.category, EffectString.startsWith('citation-')))
              continue;
            if (finding.caseIdentity?.family === 'candidate') continue;
            if (Effect2.pipe(finding.category, EffectString.startsWith('relation-'))) continue;
            if (
              finding.repair.subjectUri !== undefined &&
              finding.repair.subjectUri !== record.uri &&
              finding.semanticEvidence === undefined
            )
              continue;
            if (
              EffectArray.some(
                [...caseMap.values()],
                item =>
                  item.memoryId === memoryId && item.family === finding.category && item.disposition === 'retired',
              )
            )
              continue;
            const identity = contextHealthFindingCaseIdentityV2({
              project: task.project,
              finding,
              records: completeCorpus,
            });
            const receipt = Result.isSuccess(collected)
              ? EffectOption.getOrUndefined(
                  EffectArray.findFirst(
                    EffectArray.flatMap(collected.success.citationValidations, item => item.receipts),
                    item => `${record.uri}#${item.citationId}` === finding.repair.targetUri,
                  ),
                )
              : undefined;
            const citation = EffectOption.getOrUndefined(
              EffectArray.findFirst(currentMemoryCodeCitations(record), item => item.id === receipt?.citationId),
            );
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
            !EffectArray.some(report.success.findings, item => item.category === 'citation-unknown')
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
                  Effect2.pipe(
                    EffectArray.join(
                      EffectArray.map(coverage.reasons, item => item.reason),
                      ', ',
                    ),
                    EffectString.slice(0, 300),
                  ) || 'citation-evidence-unavailable',
              },
              now,
            );
            seen.add(item.caseId);
          }
          for (const item of previousCases) {
            if (
              item.family === 'current-support' &&
              EffectArray.some(
                [...caseMap.values()],
                anchor =>
                  anchor.memoryId === item.memoryId &&
                  anchor.slot === item.slot &&
                  anchor.retirement?.evidenceRevision === item.evidenceRevision &&
                  anchor.evidenceRevision === task.revision,
              )
            )
              seen.add(item.caseId);
            if (!seen.has(item.caseId) && item.disposition !== 'retired') {
              caseMap.set(item.caseId, {
                ...item,
                ...(selectedCase === undefined ? {} : {evidenceRevision: task.revision}),
                disposition: 'resolved',
                reason: 'postcondition-verified',
                lastChecked: now,
              });
              if (selectedCase !== undefined) seen.add(item.caseId);
            }
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
        const waiting = EffectArray.filter(
          EffectArray.map([...seen], id => caseMap.get(id)),
          item => item?.disposition === 'waiting-evidence',
        );
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
        if (selectedCase === undefined)
          checkpoints[task.key] = {
            ...(batchByTask.get(task.key)?.observation !== undefined && Result.isSuccess(report)
              ? {citationAdmissionVersion: maintenanceCitationAdmissionVersion(record)}
              : {}),
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
                  retryAt: EffectArray.filter(
                    [nextMaintenanceDeadline(record, now), ...EffectArray.map(waiting, item => item?.nextAttemptAt)],
                    (date): date is string => date !== undefined,
                  ).sort()[0],
                }),
          };
        state = {
          ...state,
          lastProject: selectedCase === undefined ? task.project : state.lastProject,
          lastTaskByProject:
            selectedCase === undefined
              ? {...state.lastTaskByProject, [task.project]: task.key}
              : state.lastTaskByProject,
          lastProgressAt: now,
          checkpoints,
          cases: [...caseMap.values()],
          receipts: receipts.slice(-MAX_RECEIPTS),
        };
        yield* writeState(config, state);
      }
      for (const batch of batches)
        if (!(yield* maintenanceWorkerBatchCurrent(config, batch)))
          invalidateMaintenanceWorkerBatch(
            batch,
            caseMap,
            previousCitationCases,
            selectedCase === undefined ? checkpoints : {},
          );
      if (selectedCase === undefined && snapshot.success.complete) {
        for (const record of EffectArray.filter(
          active,
          record => options.project === undefined || record.metadata.project === options.project,
        )) {
          if (!maintenanceAnchorChunksComplete(record, checkpoints, logicalHashes.get(record.uri))) continue;
          if (!hasAbsentMaintenanceAnchors(caseMap.values(), record)) continue;
          const fresh = (yield* readMemoryRecordsByUri(config, [record.uri]))[0];
          if (fresh?.metadata.status === 'active' && contentHash(fresh.content) === logicalHashes.get(record.uri))
            reconcileAbsentMaintenanceAnchors(caseMap, fresh, now);
        }
      }
      if (selectedCase === undefined) reconcileRepositoryRecoveryCases(caseMap, now);
      const activeIds = new Set(EffectArray.map(active, record => record.metadata.memoryId ?? record.uri));
      const caseValues = EffectArray.map([...caseMap.values()], item =>
        selectedCase !== undefined ||
        (item.family === 'candidate' && pendingCandidateIds.has(item.caseId)) ||
        (item.family === 'repository-recovery' &&
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(item.subjectContentHashes), findArray =>
              EffectArray.some(findArray, subject => EffectArray.some(active, record => record.uri === subject.uri)),
            ),
          )) ||
        !snapshot.success.complete ||
        (options.project !== undefined && item.project !== options.project) ||
        activeIds.has(item.memoryId) ||
        (item.family === 'semantic-contradiction' &&
          ((item.subjectContentHashes?.length ?? 0) < 2 ||
            EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(item.subjectContentHashes), findArray =>
                EffectArray.every(findArray, subject => EffectArray.some(active, record => record.uri === subject.uri)),
              ),
            ))) ||
        item.disposition === 'retired' ||
        item.disposition === 'historical'
          ? item
          : {...item, disposition: 'resolved' as const, reason: 'subject-inactive'},
      );
      const cases = selectRetainedMaintenanceCases(
        caseValues,
        activeIds,
        snapshot.success.complete && options.project === undefined,
        selectedCase !== undefined,
      );
      const closingSourceEpochs = new Map<string, string>();
      for (const task of tasks) {
        if (
          (options.project !== undefined && task.project !== options.project) ||
          currentMemoryCodeCitations(task.record).length === 0 ||
          sourceRevisions.has(task.project)
        )
          continue;
        const root = roots.get(task.project) ?? options.cwd;
        let epoch = closingSourceEpochs.get(root);
        if (epoch === undefined) {
          epoch = yield* sourceGeneration(config, root);
          closingSourceEpochs.set(root, epoch);
        }
        sourceRevisions.set(task.project, epoch);
      }
      const semanticStillPending = EffectArray.some(semanticProjects, project => {
        const progress = state.semanticProgress?.[project];
        return progress === undefined || progress.version !== 2 || maintenanceSemanticProgressPending(progress);
      });
      const semanticEvidencePartial = EffectArray.some(semanticProjects, project => {
        const progress = state.semanticProgress?.[project];
        return progress?.version === 2 && maintenanceSemanticProgressUnsupported(progress);
      });
      const requestedStillPending = yield* contextMaintenanceEvidenceDiscoveryPending(
        config,
        requestDiscovery,
        evidencePage.total,
        options.project,
      );
      state = {
        ...state,
        preparation: contextMaintenanceInventoryPreparation(snapshot.success, corpus.length),
        checkpoints,
        cases,
        receipts: receipts.slice(-MAX_RECEIPTS),
        state: EffectArray.some(cases, item => item.disposition === 'needs-decision')
          ? 'needs-decision'
          : EffectArray.some(cases, item => item.disposition === 'waiting-evidence')
            ? 'waiting-evidence'
            : snapshot.success.complete &&
                !semanticStillPending &&
                !requestedStillPending &&
                EffectArray.every(tasks, task =>
                  maintenanceCheckpointCurrent(
                    checkpoints[task.key],
                    logicalHashes.get(task.record.uri),
                    sourceRevisions.get(task.project),
                    now,
                  ),
                )
              ? semanticEvidencePartial
                ? 'waiting-evidence'
                : 'idle'
              : 'running',
        projects: EffectArray.map(
          [...new Set(EffectArray.map(active, record => record.metadata.project!))].sort(),
          project => {
            const selected = EffectArray.filter(tasks, task => task.project === project);
            const checked = EffectArray.filter(selected, task =>
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
              eligibleCitations: EffectArray.reduce(
                selected,
                0,
                (count, task) =>
                  count + currentMemoryCodeCitations(task.record).slice(task.chunk * 64, (task.chunk + 1) * 64).length,
              ),
              checkedCitations: EffectArray.reduce(
                checked,
                0,
                (count, task) => count + (checkpoints[task.key]?.checkedCitations ?? 0),
              ),
            };
          },
        ),
      };
      yield* writeState(config, state);
      if (selectedCase === undefined) yield* pruneReceiptJournals(config, state.receipts);
      return selectedCase === undefined
        ? publicStatus(state)
        : publicStatus(state, options.project, {caseId: options.caseId});
    }),
  );
});

const repairRelations = Effect.fn('contextMaintenance.repairRelations')(function* (
  config: RuntimeConfig,
  original: MemoryRecord,
  changes: readonly {readonly relation: MemoryRelation; readonly policy: MaintenanceRelationPolicy}[],
  timestamp: string,
  expectedPostHash?: string,
) {
  const removed = EffectArray.map(changes, change => change.relation);
  const fs = yield* FileSystem.FileSystem;
  return yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [
      original.uri,
      ...(memoryIdentityLockKey(original.metadata.memoryId) === undefined
        ? []
        : [memoryIdentityLockKey(original.metadata.memoryId)!]),
      ...EffectArray.flatMap(changes, ({relation: item, policy}) =>
        EffectArray.filter(
          [
            item.uri,
            policy.target?.uri,
            policy.successor?.uri,
            ...EffectArray.flatMap(policy.lineage ?? [], record => [
              record.uri,
              memoryIdentityLockKey(record.metadata.memoryId),
            ]),
            memoryIdentityLockKey(policy.target?.metadata.memoryId),
            memoryIdentityLockKey(policy.successor?.metadata.memoryId),
            memoryIdentityLockKey(memoryIdFromIdentityAlias(item.uri)),
          ],
          (key): key is string => key !== undefined,
        ),
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
      const lines = Effect2.pipe(canonicalMemoryDocumentContent(current.content), EffectString.split('\n'));
      const separator = lines.indexOf('');
      const after = EffectArray.join(
        EffectArray.flatMap(lines, (line, index) => {
          if (index > separator) return [line];
          const change = EffectOption.getOrUndefined(
            EffectArray.findFirst(changes, ({relation}) => line === `relation: ${relation.type} ${relation.uri}`),
          );
          if (change === undefined) return [line];
          return change.policy.successor === undefined
            ? []
            : [`relation: ${change.relation.type} threadnote://memory/${change.policy.successor.metadata.memoryId}`];
        }),
        '\n',
      );
      if (expectedPostHash !== undefined && contentHash(after) !== expectedPostHash)
        return yield* fail('The journal relation proof changed.');
      if (after === current.content || parseMemoryDocument(current.uri, after) === undefined)
        return yield* fail('Relation repair could not be represented safely.');
      const receiptId = `maintenance-${Effect2.pipe(sha256HexSync(`${original.uri}\0${contentHash(current.content)}\0${contentHash(after)}`), EffectString.slice(0, 40))}`;
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
        relationChanges: EffectArray.map(changes, ({relation, policy}) => ({
          relation,
          targetHash: policy.target === undefined ? undefined : contentHash(policy.target.content),
          successorHash: policy.successor === undefined ? undefined : contentHash(policy.successor.content),
          lineageHashes: EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(policy.lineage), lineage =>
              EffectArray.map(lineage, record => contentHash(record.content)),
            ),
          ),
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
  return yield* selectedMaintenance.withMaintenanceOperationLock(
    config,
    Effect.gen(function* () {
      const state = yield* readState(config);
      const value = yield* readJson(yield* receiptPath(config, receiptId));
      if (value === undefined) return yield* fail('The maintenance receipt expired or is unavailable.');
      if (!isUndoJournal(value)) return yield* fail('Maintenance receipt integrity failed.');
      const journal = value;
      if (journal.receiptId !== receiptId) return yield* fail('The maintenance receipt expired or is unavailable.');
      if (journal.state === 'undone') return {status: 'already-undone' as const, receiptId};
      const fs = yield* FileSystem.FileSystem;
      return yield* withMemoryUriLocks(
        fs,
        config.agentContextHome,
        [
          journal.subjectUri,
          ...(journal.archivedUri === undefined ? [] : [journal.archivedUri]),
          ...EffectArray.map(journal.removed, item => item.uri),
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
            const source = EffectOption.getOrUndefined(
              EffectArray.findFirst(observed, item => item.uri === journal.subjectUri),
            );
            const archive = EffectOption.getOrUndefined(
              EffectArray.findFirst(observed, item => item.uri === journal.archivedUri),
            );
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
                receipts: EffectArray.map(state.receipts, item =>
                  item.receiptId === receiptId ? {...item, state: 'undone'} : item,
                ),
              });
              return {status: 'already-undone' as const, receiptId};
            }
            if (archive === undefined || contentHash(archive.content) !== journal.postHash)
              return {status: 'conflict' as const, receiptId, reason: 'archive-changed'};
            const corpus = yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
            if (
              EffectArray.some(
                original.metadata.relations ?? [],
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
              receipts: EffectArray.map(state.receipts, item =>
                item.receiptId === receiptId ? {...item, state: 'undone'} : item,
              ),
            });
            return {status: 'undone' as const, receiptId};
          }
          const current = (yield* readMemoryRecordsByUri(config, [journal.subjectUri]))[0];
          if (current === undefined || contentHash(current.content) !== journal.postHash)
            return {status: 'conflict' as const, receiptId, reason: 'memory-changed'};
          const corpus = yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
          if (EffectArray.some(journal.removed, item => resolveRelationTarget(corpus, item.uri).state !== 'active'))
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
              if (
                EffectArray.some(journal.removed, item => resolveRelationTarget(closing, item.uri).state !== 'active')
              )
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
            receipts: EffectArray.map(state.receipts, item =>
              item.receiptId === receiptId ? {...item, state: 'undone'} : item,
            ),
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
  return yield* selectedMaintenance.withMaintenanceOperationLock(
    config,
    Effect.gen(function* () {
      const state = yield* readState(config);
      const item = EffectOption.getOrUndefined(
        EffectArray.findFirst(state.cases, item => item.caseId === input.caseId),
      );
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
      const record = EffectOption.getOrUndefined(
        EffectArray.findFirst(corpus, record => (record.metadata.memoryId ?? record.uri) === item.memoryId),
      );
      if (record !== undefined && hasTopicMaintenanceEnrollment(record))
        return yield* fail('An enrolled topic anchor requires reviewed topic maintenance.');
      if (
        record === undefined ||
        contentHash(record.content) !== input.expectedContentHash ||
        Effect2.Option.getOrUndefined(
          Effect2.Option.map(Effect2.Option.fromNullishOr(item.subjectContentHashes), __effectSubjects =>
            Effect2.Option.getOrUndefined(
              EffectArray.findFirst(__effectSubjects, subject => subject.uri === record.uri),
            ),
          ),
        )?.hash !== input.expectedContentHash
      )
        return yield* fail('The anchor subject changed.');
      return yield* withMemoryUriLocks(
        yield* FileSystem.FileSystem,
        config.agentContextHome,
        EffectArray.filter(
          [record.uri, memoryIdentityLockKey(record.metadata.memoryId)!],
          (key): key is string => key !== undefined,
        ),
        Effect.gen(function* () {
          const current = (yield* readMemoryRecordsByUri(config, [record.uri]))[0];
          if (current === undefined || contentHash(current.content) !== input.expectedContentHash)
            return yield* fail('The anchor subject changed before CAS.');
          const citation =
            current.metadata.codeCitations === undefined
              ? undefined
              : EffectOption.getOrUndefined(
                  EffectArray.findFirst(
                    current.metadata.codeCitations,
                    citation =>
                      citation.id === item.citationId && contextHealthCitationCaseSlotV2(citation) === item.slot,
                  ),
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
          if (
            EffectArray.some(
              evidence.excerpts,
              excerpt => excerpt.provenance === 'current-verified' && excerpt.supportsCitation,
            )
          )
            return yield* fail('Current support recovered. Refresh the packet before choosing another workflow.');
          if (
            (yield* sourceGeneration(config, item.sourceSnapshot.cwd)) !== item.sourceSnapshot.generation ||
            (yield* recordSourceRevision(config, current, item.sourceSnapshot.cwd)) !== item.sourceSnapshot.revision
          )
            return yield* fail('Source evidence changed during reviewed historicalization.');
          const now = DateTime.formatIso(yield* DateTime.now);
          const cases = new Map(EffectArray.map(state.cases, item => [item.caseId, item]));
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
              provenance: EffectArray.some(
                evidence.excerpts,
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
            checkpoints: EffectRecord.fromEntries(
              EffectArray.map(EffectRecord.toEntries(state.checkpoints), ([key, checkpoint]) => [
                key,
                Effect2.pipe(key, EffectString.startsWith(`${item.memoryId}:`))
                  ? {...checkpoint, retryAt: nextMaintenanceDeadline(current, now)}
                  : checkpoint,
              ]),
            ),
            cases: [...cases.values()],
            state: EffectArray.some([...cases.values()], item => item.disposition === 'needs-decision')
              ? 'needs-decision'
              : EffectArray.some([...cases.values()], item => item.disposition === 'waiting-evidence')
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
  for (;;) {
    yield* wakeContextMaintenance(config).pipe(Effect.ignore);
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
  const executableName = Effect2.pipe(
    Effect2.pipe(system.executablePath, EffectString.replaceAll('\\', '/'), EffectString.split('/')).at(-1),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
  );
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
  const index = EffectOption.getOrElse(
    EffectArray.findFirstIndex(receipts, item => item.receiptId === receipt.receiptId),
    () => -1,
  );
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
export const contextMaintenanceStatePath = Effect.fn('contextMaintenance.statePath')(function* (config: RuntimeConfig) {
  return (yield* Path.Path).join(config.agentContextHome, 'context-maintenance', 'state-v2.json');
});
const statePath = contextMaintenanceStatePath;
const receiptPath = Effect.fn('contextMaintenance.receiptPath')(function* (config: RuntimeConfig, id: string) {
  return (yield* Path.Path).join(config.agentContextHome, 'context-maintenance', 'receipts', `${id}.json`);
});
export function withStateLock<A, E, R>(config: RuntimeConfig, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    return yield* withExclusiveFileLock(yield* FileSystem.FileSystem, `${yield* statePath(config)}.lock`, LOCK, effect);
  });
}
export const readState = Effect.fn('contextMaintenance.readState')(function* (config: RuntimeConfig) {
  const value = yield* readJson(yield* statePath(config));
  if (value === undefined) return emptyState();
  if (!isMaintenanceState(value)) return yield* fail('Maintenance state is malformed; preserve it for recovery.');
  const state = value;
  return {...state, cases: migrateMaintenanceCases(state.cases)};
});
function readJson(file: string) {
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
    return yield* Effect.try({
      try: () => {
        const value: unknown = JSON.parse(text);
        return value;
      },
      catch: () => fail('Maintenance state is malformed.'),
    });
  });
}
const atomicJson = Effect.fn('contextMaintenance.atomicJson')(function* (file: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), {recursive: true});
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.length > MAX_STATE_BYTES) return yield* fail('Maintenance state exceeds its write boundary.');
  const temporary = `${file}.${yield* (yield* Crypto.Crypto).randomUUIDv4()}.tmp`;
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
export function writeState(config: RuntimeConfig, state: MaintenanceState) {
  if (!validTopicMaintenanceCheckpoints(state.topicCheckpoints))
    return Effect.fail(fail('Maintenance topic checkpoints exceed their write boundary.'));
  return Effect.flatMap(statePath(config), file => atomicJson(file, state)).pipe(
    Effect.andThen(Effect.flatMap(ManagerLiveChangeHints, hints => hints.maintenance.pipe(Effect.ignoreCause))),
  );
}
const pruneReceiptJournals = Effect.fn('contextMaintenance.pruneReceipts')(function* (
  config: RuntimeConfig,
  receipts: readonly ContextMaintenanceReceiptV2[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(yield* receiptPath(config, 'unused'));
  if (!(yield* fs.exists(directory))) return;
  const retained = new Set(EffectArray.map(receipts, item => `${item.receiptId}.json`));
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

const sourceGeneration = readContextMaintenanceSourceEpoch;

const recoverReceiptJournals = Effect.fn('contextMaintenance.recoverReceipts')(function* (
  config: RuntimeConfig,
  known: readonly ContextMaintenanceReceiptV2[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(yield* receiptPath(config, 'unused'));
  if (!(yield* fs.exists(directory))) {
    const noReceipts: ContextMaintenanceReceiptV2[] = [];
    return noReceipts;
  }
  const existing = new Set(EffectArray.map(known, item => item.receiptId));
  const recovered: ContextMaintenanceReceiptV2[] = [];
  const directoryEntries = yield* fs.readDirectory(directory);
  for (const name of EffectArray.filter(
    directoryEntries,
    (name, index) => index in directoryEntries && /^maintenance-[0-9a-f]{40}\.json$/u.test(name),
  ).slice(-MAX_RECEIPTS)) {
    const value = yield* readJson(path.join(directory, name));
    if (value === undefined) continue;
    if (!isUndoJournal(value)) return yield* fail('Maintenance receipt integrity failed.');
    const journal = value;
    if (existing.has(journal.receiptId) && journal.state !== 'applying') continue;
    if (journal.postHash !== contentHash(journal.after) || isSharedMemoryUri(journal.subjectUri))
      return yield* fail('Maintenance receipt integrity failed.');
    if (journal.state === 'applying') {
      if (journal.archivedUri !== undefined) {
        const records = yield* readMemoryRecordsByUri(config, [journal.subjectUri, journal.archivedUri]);
        const archive = EffectOption.getOrUndefined(
          EffectArray.findFirst(records, item => item.uri === journal.archivedUri),
        );
        const source = EffectOption.getOrUndefined(
          EffectArray.findFirst(records, item => item.uri === journal.subjectUri),
        );
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
        const changes = EffectArray.map(journal.removed, relation => ({
          relation,
          policy: resolveMaintenanceRelationPolicy(current, relation, corpus),
        }));
        const proofChanged = EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(journal.relationChanges), __effectOptionalArray =>
            Boolean(
              EffectArray.some(__effectOptionalArray, saved => {
                const policy = EffectOption.getOrUndefined(
                  EffectArray.findFirst(
                    changes,
                    item => item.relation.type === saved.relation.type && item.relation.uri === saved.relation.uri,
                  ),
                )?.policy;
                return (
                  saved.targetHash !==
                    (policy?.target === undefined ? undefined : contentHash(policy.target.content)) ||
                  saved.successorHash !==
                    (policy?.successor === undefined ? undefined : contentHash(policy.successor.content)) ||
                  (saved.lineageHashes !== undefined &&
                    JSON.stringify(saved.lineageHashes) !==
                      JSON.stringify(
                        EffectOption.getOrUndefined(
                          EffectOption.map(EffectOption.fromNullishOr(policy?.lineage), lineage =>
                            EffectArray.map(lineage, record => contentHash(record.content)),
                          ),
                        ),
                      ))
                );
              }),
            ),
          ),
        );
        const result = yield* (
          proofChanged ||
          EffectArray.some(changes, change => !['prunable', 'redirectable'].includes(change.policy.state))
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

export const readContextMaintenancePacket = Effect.fn('contextMaintenance.packet')(
  makeContextMaintenancePacketReader(readState, fail),
);

export {migrateMaintenanceCases} from './maintenance_policy.js';
