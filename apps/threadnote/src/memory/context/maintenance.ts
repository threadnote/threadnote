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
  resolveContextHealthRelationTargetV2,
  type ContextHealthCaseDispositionV2,
} from '@threadnote/context/health_maintenance';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import {expandPath} from '@threadnote/platform/paths';
import {readMaintenanceMemoryRecords} from '../maintenance/records.js';
import {prepareContextMaintenanceInventory} from './maintenance_inventory.js';
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
import {readMemoryRecordsByUri, resourceExists, writeMemoryContentWithExpectedHash} from '../../mcp/server/memory.js';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import {collectContextHealthEvidence} from './health_commands.js';
import {contextHealthFindingCaseIdentityV2} from '@threadnote/context/health_maintenance';
import {writeMemoryFile} from '../../share/index.js';
import {forgetResourceWithRetry} from '../../mcp/server/memory.js';
import {previewContextHealthRepairPlanV1} from './health_repair.js';
import {type ContextHealthRepairProposalV1} from './health_repair.js';
import {
  applyAutomaticContextHealthArchive,
  previewAutomaticContextHealthArchiveReceipt,
} from './health_repair_commands.js';
import {assertSafeRelativePath} from '@threadnote/platform/paths';

const MAX_RECEIPTS = 100;
const MAX_EVENTS = 8;
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
  readonly causeKey?: string;
  readonly repositoryId?: string;
  readonly subjectContentHashes?: readonly {readonly uri: string; readonly hash: string}[];
  readonly candidateReview?: {readonly reviewId: string; readonly revision: number; readonly candidateRevision: string};
  readonly sourceSnapshot?: {readonly cwd: string; readonly generation: string; readonly revision: string};
  readonly events: readonly {readonly at: string; readonly reason: string}[];
}

export interface ContextMaintenanceReceiptV2 {
  readonly receiptId: string;
  readonly project: string;
  readonly subjectUri: string;
  readonly postHash: string;
  readonly timestamp: string;
  readonly state: 'applying' | 'applied' | 'undone' | 'conflict';
}

interface UndoJournal extends ContextMaintenanceReceiptV2 {
  readonly before: string;
  readonly after: string;
  readonly archivedUri?: string;
  readonly archiveProposal?: ContextHealthRepairProposalV1;
  readonly archiveCallerCwd?: string;
  readonly removed: readonly MemoryRelation[];
}

interface WorkCheckpoint {
  readonly revision: string;
  readonly checkedAt: string;
  readonly retryAt?: string;
  readonly checkedCitations?: number;
  readonly attemptedCitations?: number;
  readonly memoryHash?: string;
  readonly sourceEpoch?: string;
  readonly inventoryComplete?: boolean;
}

export interface ContextMaintenanceStatusV2 {
  readonly version: 2;
  readonly paused: boolean;
  readonly state: 'idle' | 'running' | 'waiting-evidence' | 'needs-decision' | 'failed';
  readonly generation: string;
  readonly preparation?: {readonly complete: boolean; readonly admittedRecords: number};
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
  readonly lastProgressAt?: string;
  readonly error?: {readonly reason: string; readonly at: string};
}

interface MaintenanceState extends ContextMaintenanceStatusV2 {
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

export const readContextMaintenanceStatus = Effect.fn('contextMaintenance.status')(function* (
  config: RuntimeConfig,
  project?: string,
) {
  return publicStatus(yield* readState(config), project);
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

export function selectFairMaintenanceWork<T extends {readonly project: string}>(
  items: readonly T[],
  lastProject: string | undefined,
  limit: number,
): readonly T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(item.project, [...(groups.get(item.project) ?? []), item]);
  const projects = [...groups.keys()].sort();
  const start = lastProject === undefined ? 0 : (projects.indexOf(lastProject) + 1) % Math.max(1, projects.length);
  const ordered = [...projects.slice(start), ...projects.slice(0, start)];
  const result: T[] = [];
  for (let round = 0; result.length < limit; round++) {
    let added = false;
    for (const project of ordered) {
      const item = groups.get(project)?.[round];
      if (item === undefined) continue;
      result.push(item);
      added = true;
      if (result.length >= limit) break;
    }
    if (!added) break;
  }
  return result;
}

export function updateMaintenanceCase(
  previous: ContextMaintenanceCaseV2 | undefined,
  input: Pick<
    ContextMaintenanceCaseV2,
    'project' | 'memoryId' | 'family' | 'slot' | 'evidenceRevision' | 'disposition' | 'reason'
  >,
  now: string,
): ContextMaintenanceCaseV2 {
  const unchanged = previous?.evidenceRevision === input.evidenceRevision;
  const attemptCount = unchanged ? (previous?.attemptCount ?? 0) + 1 : 1;
  const waiting = input.disposition === 'waiting-evidence';
  return {
    ...input,
    caseId: contextHealthCaseIdV2(input),
    firstSeen: previous?.firstSeen ?? now,
    lastSeen: now,
    lastChecked: now,
    attemptCount,
    ...(waiting
      ? {
          nextAttemptAt: new Date(
            Date.parse(now) + Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(attemptCount, 10)),
          ).toISOString(),
        }
      : {}),
    events: [...(previous?.events ?? []), {at: now, reason: input.reason}].slice(-MAX_EVENTS),
  };
}

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
      state = {...state, cases: migrateMaintenanceCases(state.cases, corpus)};
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
          return check?.memoryHash !== snapshot.success.hashes.get(task.record.uri) ? 1 : 0;
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
      const workStarted = started;
      for (const task of selectFairMaintenanceWork(rotated, state.lastProject, maxRecords)) {
        if ((yield* Clock.currentTimeMillis) - workStarted > 5_000) break;
        const currentRecord = (yield* readMemoryRecordsByUri(config, [task.record.uri]))[0];
        if (currentRecord === undefined || currentRecord.metadata.status !== 'active') continue;
        const record =
          currentRecord.metadata.project === undefined
            ? {...currentRecord, metadata: {...currentRecord.metadata, project: 'unscoped'}}
            : currentRecord;
        const memoryId = record.metadata.memoryId ?? record.uri;
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
          if (!sourceRevisions.has(task.project))
            sourceRevisions.set(task.project, yield* sourceGeneration(config, roots.get(task.project) ?? options.cwd));
          recordSourceRevisions.set(
            record.uri,
            yield* recordSourceRevision(record, roots.get(task.project) ?? options.cwd),
          );
        }
        task.revision = sha256HexSync(
          `${snapshot.success.complete}:${contentHash(record.content)}:${sourceRevisions.get(task.project) ?? ''}:${recordSourceRevisions.get(record.uri) ?? ''}:${(
            record.metadata.relations ?? []
          )
            .map(relation => {
              const target = resolveRelationTarget(corpus, relation.uri);
              return `${relation.uri}:${target.state}:${target.record?.content ?? ''}`;
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
          (!requestedUris.has(record.uri) || waitingForEvidenceDeadline) &&
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
                : Number(item.slot.replace('anchor:', '')) >= task.chunk * 64 &&
                  Number(item.slot.replace('anchor:', '')) < (task.chunk + 1) * 64
              : task.chunk === 0),
        );
        const seen = new Set<string>();
        if (task.chunk === 0) {
          const removal = snapshot.success.complete ? safeRelationRemoval(record, corpus) : [];
          for (const relation of record.metadata.relations ?? []) {
            const target = resolveRelationTarget(corpus, relation.uri);
            if (target.state === 'active') continue;
            const removable = removal.some(item => item.type === relation.type && item.uri === relation.uri);
            const disposition =
              target.state === 'missing' && !snapshot.success.complete
                ? 'waiting-evidence'
                : removable
                  ? 'queued'
                  : target.state === 'inactive' && relation.type !== 'depends_on'
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
                      ? 'proven-missing-personal-target'
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
            const repaired = yield* repairRelations(config, record, removal, now).pipe(Effect.result);
            if (Result.isSuccess(repaired)) {
              const receipt = repaired.success;
              receipts.push(receipt);
              for (const relation of removal) {
                const id = contextHealthCaseIdV2({
                  project: task.project,
                  memoryId,
                  family: 'relation',
                  slot: resolveRelationTarget(corpus, relation.uri).record?.metadata.memoryId ?? relation.uri,
                });
                const item = caseMap.get(id);
                if (item !== undefined)
                  caseMap.set(id, {...item, disposition: 'retired', reason: 'relation-removal-verified'});
              }
            } else {
              for (const id of seen) {
                const item = caseMap.get(id);
                if (item?.disposition === 'queued')
                  caseMap.set(id, {
                    ...item,
                    disposition: 'waiting-evidence',
                    reason: 'relation-repair-conflict',
                    nextAttemptAt: DateTime.formatIso(DateTime.makeUnsafe(started + 60_000)),
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
                  receipts.push(receiptProjection(receipt));
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
          memoryHash: contentHash(record.content),
          sourceEpoch: sourceRevisions.get(task.project),
          retryAt: nextMaintenanceDeadline(record, now),
          checkedCitations: Result.isSuccess(report)
            ? (report.success.maintenance?.citationCoverage.checked ?? 0) +
              (report.success.maintenance?.citationCoverage.historicalVerified ?? 0)
            : 0,
          attemptedCitations: citations.length,
          revision: task.revision,
          checkedAt: now,
          ...(waiting.length === 0
            ? {}
            : {
                retryAt: [
                  nextMaintenanceDeadline(record, now),
                  ...waiting.map(
                    item => item?.nextAttemptAt ?? DateTime.formatIso(DateTime.makeUnsafe(started + 60_000)),
                  ),
                ]
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
      const activeIds = new Set(active.map(record => record.metadata.memoryId ?? record.uri));
      const caseValues = [...caseMap.values()].map(item =>
        (item.family === 'candidate' && pendingCandidateIds.has(item.caseId)) ||
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
        .filter(item => ['resolved', 'retired'].includes(item.disposition))
        .sort((a, b) => b.lastChecked.localeCompare(a.lastChecked))
        .slice(0, 200);
      const cases = [...caseValues.filter(item => !['resolved', 'retired'].includes(item.disposition)), ...terminal];
      state = {
        ...state,
        preparation: {complete: snapshot.success.complete, admittedRecords: corpus.length},
        checkpoints,
        cases,
        receipts: receipts.slice(-MAX_RECEIPTS),
        state: cases.some(item => item.disposition === 'needs-decision')
          ? 'needs-decision'
          : cases.some(item => item.disposition === 'waiting-evidence')
            ? 'waiting-evidence'
            : snapshot.success.complete
              ? 'idle'
              : 'running',
        projects: [...new Set(active.map(record => record.metadata.project!))].sort().map(project => {
          const selected = tasks.filter(task => task.project === project);
          const checked = selected.filter(task => {
            const check = checkpoints[task.key];
            return (
              check?.memoryHash === snapshot.success.hashes.get(task.record.uri) &&
              (check.sourceEpoch === undefined ||
                !sourceRevisions.has(project) ||
                check.sourceEpoch === sourceRevisions.get(project)) &&
              (check.retryAt === undefined || check.retryAt > now)
            );
          });
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

function upsertCase(
  cases: Map<string, ContextMaintenanceCaseV2>,
  input: Parameters<typeof updateMaintenanceCase>[1] & Pick<ContextMaintenanceCaseV2, 'causeKey' | 'repositoryId'>,
  now: string,
) {
  const id = contextHealthCaseIdV2(input);
  const previous = cases.get(id);
  const effective =
    input.family === 'relation' &&
    input.disposition === 'historical' &&
    previous?.disposition === 'needs-decision' &&
    previous.evidenceRevision === input.evidenceRevision
      ? {...input, disposition: previous.disposition, reason: previous.reason}
      : input;
  const item = {
    ...updateMaintenanceCase(previous, effective, now),
    causeKey: input.causeKey ?? `${input.family}:${input.reason}`,
    ...(input.repositoryId === undefined ? {} : {repositoryId: input.repositoryId}),
  };
  cases.set(id, item);
  return item;
}

export const resolveRelationTarget = resolveContextHealthRelationTargetV2;

export function safeRelationRemoval(record: MemoryRecord, corpus: readonly MemoryRecord[]): readonly MemoryRelation[] {
  if (isSharedMemoryUri(record.uri)) return [];
  return (record.metadata.relations ?? []).filter(relation => {
    const target = resolveRelationTarget(corpus, relation.uri);
    return (
      target.state === 'missing' &&
      memoryIdFromIdentityAlias(relation.uri) === undefined &&
      relation.uri.startsWith(record.uri.slice(0, record.uri.indexOf('/memories/') + '/memories/'.length)) &&
      !isSharedMemoryUri(relation.uri)
    );
  });
}

const repairRelations = Effect.fn('contextMaintenance.repairRelations')(function* (
  config: RuntimeConfig,
  original: MemoryRecord,
  removed: readonly MemoryRelation[],
  timestamp: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [
      original.uri,
      ...removed.flatMap(item =>
        [item.uri, memoryIdentityLockKey(memoryIdFromIdentityAlias(item.uri))].filter(
          (key): key is string => key !== undefined,
        ),
      ),
    ],
    Effect.gen(function* () {
      const current = (yield* readMemoryRecordsByUri(config, [original.uri]))[0];
      if (current === undefined || contentHash(current.content) !== contentHash(original.content))
        return yield* fail('The relation subject changed.');
      const fresh = yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
      for (const relation of removed) {
        if (resolveRelationTarget(fresh, relation.uri).state !== 'missing')
          return yield* fail('The relation target changed.');
        if (
          memoryIdFromIdentityAlias(relation.uri) === undefined &&
          (yield* resourceExists('threadnote-native', config, relation.uri))
        )
          return yield* fail('The relation target exists or cannot be proved absent.');
      }
      yield* Effect.try({
        try: () => assertMemoryDocumentSchemaWritable(current.content),
        catch: () => fail('Relation subject schema is not writable.'),
      });
      const lines = canonicalMemoryDocumentContent(current.content).split('\n');
      const separator = lines.indexOf('');
      const after = lines
        .filter(
          (line, index) =>
            index > separator || !removed.some(relation => line === `relation: ${relation.type} ${relation.uri}`),
        )
        .join('\n');
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
      };
      const journalFile = yield* receiptPath(config, receiptId);
      yield* atomicJson(journalFile, journal);
      const result = yield* writeMemoryContentWithExpectedHash(
        config,
        'threadnote-native',
        current.uri,
        after,
        current.content,
        {alreadyLocked: true},
      );
      if (result.isError === true) return yield* fail('Relation repair CAS conflicted.');
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
          const result = yield* writeMemoryContentWithExpectedHash(
            config,
            'threadnote-native',
            current.uri,
            journal.before,
            current.content,
            {alreadyLocked: true},
          );
          if (result.isError === true) return {status: 'conflict' as const, receiptId, reason: 'memory-changed'};
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
  },
) {
  const result =
    options.action === 'packet'
      ? yield* readContextMaintenancePacket(config, options.caseId ?? '')
      : options.action === 'status'
        ? yield* readContextMaintenanceStatus(config, options.project)
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
function maintenanceCaseSubjectKeys(item: ContextMaintenanceCaseV2): readonly string[] {
  return (item.subjectContentHashes?.length ?? 0) > 0
    ? item.subjectContentHashes!.map(subject => subject.uri)
    : [item.memoryId];
}

function publicStatus(originalState: MaintenanceState, project?: string): ContextMaintenanceStatusV2 {
  const state =
    project === undefined
      ? originalState
      : {
          ...originalState,
          projects: originalState.projects.filter(item => item.project === project),
          cases: originalState.cases.filter(item => item.project === project),
          receipts: originalState.receipts.filter(item => item.project === project),
        };
  const {
    checkpoints: _checkpoints,
    lastProject: _lastProject,
    lastTaskByProject: _lastTaskByProject,
    lastWakeAt: _lastWakeAt,
    policyOverrides: _policyOverrides,
    decisionCheckpoints: _decisionCheckpoints,
    semanticProgress: _semanticProgress,
    ...status
  } = state;
  const counts: Record<string, number> = {
    decisionMemories: new Set(
      state.cases.filter(item => item.disposition === 'needs-decision').flatMap(maintenanceCaseSubjectKeys),
    ).size,
  };
  const groups = new Map<
    string,
    {causeKey: string; project: string; disposition: ContextHealthCaseDispositionV2; reason: string; ids: Set<string>}
  >();
  for (const item of state.cases) {
    counts[item.disposition] = (counts[item.disposition] ?? 0) + 1;
    const key = `${item.project}:${item.causeKey ?? item.family}:${item.disposition}`;
    const group = groups.get(key) ?? {
      causeKey: item.causeKey ?? item.family,
      project: item.project,
      disposition: item.disposition,
      reason: item.reason,
      ids: new Set<string>(),
    };
    for (const subject of maintenanceCaseSubjectKeys(item)) group.ids.add(subject);
    groups.set(key, group);
  }
  const cases = [...state.cases]
    .sort(
      (a, b) =>
        Number(b.disposition === 'needs-decision') - Number(a.disposition === 'needs-decision') ||
        a.caseId.localeCompare(b.caseId),
    )
    .slice(0, 30)
    .map(item => ({...item, events: item.events.slice(-2)}));
  return {
    ...status,
    semanticCoverage: Object.entries(state.semanticProgress ?? {})
      .filter(([name]) => project === undefined || name === project)
      .map(([name, progress]) => ({
        project: name,
        state:
          progress.cursor >= progress.totalBatches && !progress.partial ? ('complete' as const) : ('partial' as const),
        eligibleRecords: progress.eligibleRecords,
        checkedBatches: progress.cursor,
        totalBatches: progress.totalBatches,
      })),
    cases,
    receipts: state.receipts.slice(-10),
    counts,
    groups: [...groups.values()].slice(0, 100).map(({ids, ...group}) => ({...group, affectedMemories: ids.size})),
    omittedCases: state.cases.length - cases.length,
  };
}

function receiptProjection(journal: UndoJournal): ContextMaintenanceReceiptV2 {
  const {
    before: _before,
    after: _after,
    removed: _removed,
    archivedUri: _archivedUri,
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
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > MAX_STATE_BYTES)
    return yield* fail('Maintenance state exceeds its write boundary.');
  const temporary = `${file}.${yield* (yield* Crypto.Crypto).randomUUIDv4}.tmp`;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
      yield* handle.writeAll(new TextEncoder().encode(text));
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

const recordSourceRevision = Effect.fn('contextMaintenance.recordSourceRevision')(function* (
  record: MemoryRecord,
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return sha256HexSync(
    (yield* Effect.forEach(
      [...new Set((record.metadata.codeCitations ?? []).map(citation => citation.path))],
      relative =>
        Effect.gen(function* () {
          const safe = yield* Effect.try(() => assertSafeRelativePath(relative));
          const root = yield* fs.realPath(cwd);
          const file = yield* fs.realPath(path.join(root, safe));
          const contained = path.relative(root, file);
          if (contained.startsWith('..') || path.isAbsolute(contained)) return `${relative}:outside-root`;
          const info = yield* fs.stat(file);
          return `${relative}:${Number(info.size)}:${JSON.stringify(info.mtime)}`;
        }).pipe(Effect.orElseSucceed(() => `${relative}:unavailable`)),
      {concurrency: 16},
    )).join('\n'),
  );
});

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
        const result = yield* repairRelations(config, current, journal.removed, journal.timestamp).pipe(Effect.result);
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
  const relatedMemories =
    item.family === 'semantic-contradiction'
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
      (yield* recordSourceRevision(record, item.sourceSnapshot.cwd)) !== item.sourceSnapshot.revision)
  )
    return yield* fail(
      'The selected maintenance case is stale. Source evidence changed; run maintenance before requesting a decision packet.',
    );
  return {
    version: 2 as const,
    caseId: item.caseId,
    project: item.project,
    memoryUri: record.uri,
    relatedMemories: relatedMemories.map(record => ({
      uri: record.uri,
      expectedContentHash: contentHash(record.content),
    })),
    memoryId: item.memoryId,
    evidenceRevision: item.evidenceRevision,
    expectedContentHash: contentHash(record.content),
    reason: item.reason,
    disposition: item.disposition,
    choices: item.family.startsWith('citation')
      ? [
          'Recover local current evidence',
          'Preserve verified historical provenance',
          'Review and retire unsupported claim',
        ]
      : item.family === 'review-overdue'
        ? [
            'Review the current claim and supporting evidence',
            'Update the review date through a reviewed metadata change',
            'Archive a superseded claim after review',
          ]
        : item.family === 'semantic-contradiction'
          ? [
              'Read both current claims and supporting evidence',
              'Choose the current assertion',
              'Preview exact supersession of the stale claim',
            ]
          : [
              'Review the current record and target',
              'Apply an exact reviewed repair',
              'Keep valid historical relation',
            ],
    allowedOperations: ['read_context', 'context_health_repair_preview', 'context_health_repair_apply'],
    instructions:
      'Read the memory and current evidence. Do not change a claim merely to refresh citation metadata. Shared canonical changes require the reviewed owner publication path. Preview and apply only an exact revision after explicit review.',
  };
});

export function renderContextMaintenanceStatus(status: ContextMaintenanceStatusV2): string {
  const counts = status.counts ?? {};
  return [
    `Context maintenance: ${status.paused ? 'paused' : status.state}`,
    ...(status.preparation?.complete === false
      ? [`Preparation: partial; ${status.preparation.admittedRecords} records indexed so far.`]
      : []),
    `Decisions: ${counts.decisionMemories ?? 0}; waiting evidence: ${counts['waiting-evidence'] ?? 0}; completed: ${(counts.resolved ?? 0) + (counts.retired ?? 0)}.`,
    ...status.projects.map(
      item =>
        `${item.project}: ${item.checked}/${item.eligible} tasks checked; ${item.checkedCitations}/${item.eligibleCitations} citations verified.`,
    ),
    ...(status.groups ?? [])
      .slice(0, 12)
      .map(group => `${group.project}: ${group.reason} (${group.affectedMemories} memories)`),
    ...(status.error === undefined ? [] : [`Maintenance error: ${status.error.reason}`]),
  ].join('\n');
}

export function migrateMaintenanceCases(
  cases: readonly ContextMaintenanceCaseV2[],
  records: readonly MemoryRecord[] = [],
): readonly ContextMaintenanceCaseV2[] {
  const identities = new Map<string, ContextMaintenanceCaseV2>();
  for (const item of cases) {
    if (
      item.family === 'citation-coverage' &&
      cases.some(other => other.memoryId === item.memoryId && other.family === 'citation')
    )
      continue;
    const slot =
      item.family === 'citation' && /^\d+$/u.test(item.slot)
        ? `anchor:${item.slot}`
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
    if (prior === undefined || next.lastChecked >= prior.lastChecked) identities.set(next.caseId, next);
  }
  return [...identities.values()];
}
