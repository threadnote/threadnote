import {isSharedMemoryUri, type MemoryRecord} from '@threadnote/memory/document';
import {validateTopicMaintenanceManifest} from '@threadnote/memory/topic-maintenance';
import {contextHealthCaseIdV2} from '@threadnote/context/health_maintenance';
import {assertMemoryCodeCitation} from '@threadnote/memory/code/citation';
import type {TopicMaintenanceObservationV1} from '@threadnote/context/topic_maintenance';
import {
  observeTopicMaintenanceEvidence,
  buildTopicMaintenanceEvidencePacket,
} from '@threadnote/context/topic_maintenance';
import {Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readMemoryRecordsByUri} from '../../mcp/server/memory.js';
import {readContextMaintenanceSourceEpoch} from './maintenance_evidence.js';
import {maintenanceContentHash, upsertCase} from './maintenance_policy.js';
import {withMaintenancePacketRevision} from './maintenance_packet.js';
import type {ContextMaintenanceCaseV2} from './maintenance.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {MaintenanceWorkSchedule} from './maintenance_decisions.js';

export const TOPIC_MAINTENANCE_FAMILY = 'topic-maintenance';
export const TOPIC_MAINTENANCE_SLOT = 'declared-support';
const MAX_TOPIC_CHECKPOINT_BYTES = 32 * 1024;
class TopicMaintenanceError extends Schema.TaggedError<TopicMaintenanceError>()('TopicMaintenanceError', {
  message: Schema.String,
}) {}
const topicFail = (message: string) => TopicMaintenanceError.make({message});

export interface TopicMaintenanceCheckpoint {
  readonly targetHash: string;
  readonly revision: string;
  readonly outcome: 'unchanged' | 'review-required' | 'unavailable';
  readonly checkedAt: string;
  readonly coverage: 'declared-only';
  readonly suppressedRevision?: string;
  readonly observation?: TopicMaintenanceObservationV1;
  readonly recoveryObservation?: TopicMaintenanceObservationV1;
  readonly deferredAt?: string;
  readonly overflowReason?: 'topic-observation-overflow';
}

function checkpointFits(value: TopicMaintenanceCheckpoint): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_TOPIC_CHECKPOINT_BYTES;
}

function compactCheckpoint(
  candidate: TopicMaintenanceCheckpoint,
  recovery: TopicMaintenanceObservationV1 | undefined,
): TopicMaintenanceCheckpoint {
  const base: TopicMaintenanceCheckpoint = {
    targetHash: candidate.targetHash,
    revision: candidate.revision,
    outcome: 'unavailable',
    checkedAt: candidate.checkedAt,
    coverage: 'declared-only',
    ...(candidate.suppressedRevision ? {suppressedRevision: candidate.suppressedRevision} : {}),
    ...(candidate.deferredAt ? {deferredAt: candidate.deferredAt} : {}),
    ...(candidate.overflowReason ? {overflowReason: candidate.overflowReason} : {}),
  };
  const withRecovery = recovery === undefined ? base : {...base, recoveryObservation: recovery};
  return checkpointFits(withRecovery) ? withRecovery : base;
}

/** A valid observation may exceed the private checkpoint budget; retain only bounded recovery data. */
export function boundedTopicMaintenanceCheckpoint(
  observation: TopicMaintenanceObservationV1,
  checkedAt: string,
  previous?: TopicMaintenanceCheckpoint,
  suppressedRevision?: string,
): TopicMaintenanceCheckpoint {
  const candidate: TopicMaintenanceCheckpoint = {
    targetHash: observation.targetHash,
    revision: observation.revision,
    outcome: observation.outcome,
    checkedAt,
    coverage: 'declared-only',
    observation,
    ...(suppressedRevision ? {suppressedRevision} : {}),
  };
  if (checkpointFits(candidate)) return candidate;
  return compactCheckpoint(
    {...candidate, overflowReason: 'topic-observation-overflow'},
    previous?.observation ?? previous?.recoveryObservation,
  );
}

/** Inventory records are metadata projections; validate the full record after selecting. */
export function enrolledTopicCandidate(record: MemoryRecord): boolean {
  return (
    record.metadata.status === 'active' &&
    !isSharedMemoryUri(record.uri) &&
    record.metadata.topicMaintenance !== undefined &&
    record.metadata.topicMaintenanceError === undefined &&
    record.metadata.memoryId !== undefined
  );
}

export function enrolledTopicRecord(record: MemoryRecord): boolean {
  if (!enrolledTopicCandidate(record)) return false;
  try {
    validateTopicMaintenanceManifest(record.metadata.topicMaintenance, record);
    return true;
  } catch {
    return false;
  }
}

export function topicMaintenanceCaseId(record: MemoryRecord): string {
  return contextHealthCaseIdV2({
    project: record.metadata.project ?? 'unscoped',
    memoryId: record.metadata.memoryId!,
    family: TOPIC_MAINTENANCE_FAMILY,
    slot: TOPIC_MAINTENANCE_SLOT,
  });
}

/** Rotate across stable IDs; one target receives the topic phase each tick. */
export function selectTopicMaintenanceRecord(
  records: readonly MemoryRecord[],
  lastMemoryId: string | undefined,
): MemoryRecord | undefined {
  const eligible = records
    .filter(enrolledTopicCandidate)
    .sort((a, b) => a.metadata.memoryId!.localeCompare(b.metadata.memoryId!));
  return eligible.find(record => record.metadata.memoryId! > (lastMemoryId ?? '')) ?? eligible[0];
}

/** An attempted target consumes its fair turn even if its opening/closing fence races. */
export function advanceTopicMaintenanceCursor(
  schedule: MaintenanceWorkSchedule,
  attempted: MemoryRecord,
): MaintenanceWorkSchedule {
  return {...schedule, lastTopicMemoryId: attempted.metadata.memoryId!};
}

/** Decode optional state without discarding a malformed recovery artifact. */
export function validTopicMaintenanceCheckpoints(value: unknown): value is Record<string, TopicMaintenanceCheckpoint> {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.every(([key, item]) => {
    if (!/^health-case-[0-9a-f]{40}$/u.test(key) || typeof item !== 'object' || item === null || Array.isArray(item))
      return false;
    const entry = item as Record<string, unknown>;
    return (
      Object.keys(entry).every(field =>
        [
          'targetHash',
          'revision',
          'outcome',
          'checkedAt',
          'coverage',
          'suppressedRevision',
          'observation',
          'recoveryObservation',
          'deferredAt',
          'overflowReason',
        ].includes(field),
      ) &&
      typeof entry.targetHash === 'string' &&
      /^[0-9a-f]{64}$/u.test(entry.targetHash) &&
      typeof entry.revision === 'string' &&
      /^[0-9a-f]{64}$/u.test(entry.revision) &&
      ['unchanged', 'review-required', 'unavailable'].includes(entry.outcome as string) &&
      typeof entry.checkedAt === 'string' &&
      entry.checkedAt.length <= 40 &&
      entry.coverage === 'declared-only' &&
      (entry.suppressedRevision === undefined ||
        (typeof entry.suppressedRevision === 'string' && /^[0-9a-f]{64}$/u.test(entry.suppressedRevision))) &&
      (entry.deferredAt === undefined || (typeof entry.deferredAt === 'string' && entry.deferredAt.length <= 40)) &&
      (entry.overflowReason === undefined || entry.overflowReason === 'topic-observation-overflow') &&
      (entry.observation === undefined
        ? (entry.deferredAt !== undefined || entry.overflowReason !== undefined) && entry.outcome === 'unavailable'
        : validObservation(entry.observation, entry.targetHash, entry.revision)) &&
      (entry.recoveryObservation === undefined ||
        (typeof entry.recoveryObservation === 'object' &&
          entry.recoveryObservation !== null &&
          validObservation(
            entry.recoveryObservation,
            (entry.recoveryObservation as TopicMaintenanceObservationV1).targetHash,
            (entry.recoveryObservation as TopicMaintenanceObservationV1).revision,
          ))) &&
      checkpointFits(entry as unknown as TopicMaintenanceCheckpoint)
    );
  });
}

function validObservation(
  value: unknown,
  targetHash: unknown,
  revision: unknown,
): value is TopicMaintenanceObservationV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some(
      key => !['version', 'targetHash', 'revision', 'coverage', 'outcome', 'sources', 'canDraft'].includes(key),
    ) ||
    item.version !== 1 ||
    item.targetHash !== targetHash ||
    item.revision !== revision ||
    item.coverage !== 'declared-only' ||
    !['unchanged', 'review-required', 'unavailable'].includes(item.outcome as string) ||
    typeof item.canDraft !== 'boolean' ||
    !Array.isArray(item.sources) ||
    item.sources.length > 8
  )
    return false;
  const ids = new Set<string>();
  return item.sources.every((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
    const source = raw as Record<string, unknown>;
    if (
      Object.keys(source).some(
        key =>
          ![
            'citationId',
            'status',
            'reason',
            'historicalAvailable',
            'current',
            'currentFileBytesHash',
            'observedPath',
            'observedNodeId',
            'excerptTruncated',
          ].includes(key),
      ) ||
      typeof source.citationId !== 'string' ||
      !/^tncc_[0-9a-f]{40}$/u.test(source.citationId) ||
      ids.has(source.citationId) ||
      !['exact', 'relocated', 'changed', 'deleted', 'unknown'].includes(source.status as string) ||
      typeof source.reason !== 'string' ||
      source.reason.length > 256 ||
      typeof source.historicalAvailable !== 'boolean' ||
      (source.excerptTruncated !== undefined && typeof source.excerptTruncated !== 'boolean') ||
      (source.currentFileBytesHash !== undefined &&
        (typeof source.currentFileBytesHash !== 'string' || !/^[0-9a-f]{64}$/u.test(source.currentFileBytesHash))) ||
      (source.observedPath !== undefined &&
        (typeof source.observedPath !== 'string' || source.observedPath.length > 4096)) ||
      (source.observedNodeId !== undefined &&
        (typeof source.observedNodeId !== 'string' || source.observedNodeId.length > 100))
    )
      return false;
    ids.add(source.citationId);
    if (source.current === undefined) return true;
    try {
      assertMemoryCodeCitation(source.current);
      return true;
    } catch {
      return false;
    }
  });
}

export function pruneAbsentTopicCheckpoints(
  checkpoints: Readonly<Record<string, TopicMaintenanceCheckpoint>>,
  activeCaseIds: ReadonlySet<string>,
  complete: boolean,
): Readonly<Record<string, TopicMaintenanceCheckpoint>> {
  if (!complete) return checkpoints;
  return Object.fromEntries(Object.entries(checkpoints).filter(([id]) => activeCaseIds.has(id)));
}

/** Keep enrolled active identity while applying the ordinary terminal-history cap to proven absence. */
export function selectRetainedMaintenanceCases(
  cases: readonly ContextMaintenanceCaseV2[],
  activeIds: ReadonlySet<string>,
  completeUnscopedInventory: boolean,
  exactCaseRefresh: boolean,
): readonly ContextMaintenanceCaseV2[] {
  if (exactCaseRefresh) return cases;
  const retainTopic = (item: ContextMaintenanceCaseV2) =>
    item.family === TOPIC_MAINTENANCE_FAMILY && (!completeUnscopedInventory || activeIds.has(item.memoryId));
  const terminal = cases
    .filter(
      item => ['resolved', 'retired'].includes(item.disposition) && item.retirement === undefined && !retainTopic(item),
    )
    .sort((a, b) => b.lastChecked.localeCompare(a.lastChecked))
    .slice(0, 200);
  return [
    ...cases.filter(
      item => !['resolved', 'retired'].includes(item.disposition) || item.retirement !== undefined || retainTopic(item),
    ),
    ...terminal,
  ];
}

/** Observe exactly one selected target; a changed target or source leaves its old case untouched. */
export const observeTopicMaintenanceCase = Effect.fn('contextMaintenance.observeTopicCase')(function* (
  config: RuntimeConfig,
  selected: MemoryRecord,
  expectedContentHash: string,
  root: string,
  now: string,
  checkpoints: Readonly<Record<string, TopicMaintenanceCheckpoint>>,
  caseMap: Map<string, ContextMaintenanceCaseV2>,
) {
  const caseId = topicMaintenanceCaseId(selected);
  const openingEpoch = yield* readContextMaintenanceSourceEpoch(config, root);
  const current = (yield* readMemoryRecordsByUri(config, [selected.uri]))[0];
  if (!current || !enrolledTopicRecord(current) || maintenanceContentHash(current.content) !== expectedContentHash)
    return undefined;
  const previousCheckpoint = checkpoints[caseId];
  const observed = yield* observeTopicMaintenanceEvidence(
    config,
    current,
    root,
    previousCheckpoint?.observation ?? previousCheckpoint?.recoveryObservation,
  );
  const closing = (yield* readMemoryRecordsByUri(config, [selected.uri]))[0];
  if (
    !closing ||
    !enrolledTopicRecord(closing) ||
    maintenanceContentHash(closing.content) !== maintenanceContentHash(current.content) ||
    (yield* readContextMaintenanceSourceEpoch(config, root)) !== openingEpoch
  )
    return undefined;
  const previous = caseMap.get(caseId);
  const suppressed = checkpoints[caseId]?.suppressedRevision === observed.revision;
  const checkpoint = boundedTopicMaintenanceCheckpoint(
    observed,
    now,
    previousCheckpoint,
    suppressed ? observed.revision : undefined,
  );
  const disposition = suppressed
    ? 'deferred-policy'
    : checkpoint.outcome === 'unavailable'
      ? 'waiting-evidence'
      : checkpoint.outcome === 'review-required'
        ? 'needs-decision'
        : 'resolved';
  const reason = suppressed
    ? 'same-revision-review-suppressed'
    : (checkpoint.overflowReason ?? `topic-${observed.outcome}`);
  const next =
    previous?.evidenceRevision === observed.revision &&
    previous.disposition === disposition &&
    previous.reason === reason
      ? previous
      : upsertCase(
          caseMap,
          {
            project: selected.metadata.project ?? 'unscoped',
            memoryId: selected.metadata.memoryId!,
            family: TOPIC_MAINTENANCE_FAMILY,
            slot: TOPIC_MAINTENANCE_SLOT,
            evidenceRevision: observed.revision,
            disposition,
            reason,
          },
          now,
        );
  const item: ContextMaintenanceCaseV2 = {
    ...next,
    lastChecked: now,
    lastSeen: now,
    subjectUri: current.uri,
    subjectContentHashes: [{uri: current.uri, hash: maintenanceContentHash(current.content)}],
    sourceSnapshot: {cwd: root, generation: openingEpoch, revision: observed.revision},
  };
  return {caseId, item, checkpoint};
});

/** A timed-out turn retains prior evidence and records an explicit bounded retry reason. */
export function deferTopicMaintenanceCase(
  selected: MemoryRecord,
  expectedContentHash: string,
  now: string,
  previous: TopicMaintenanceCheckpoint | undefined,
  priorCase: ContextMaintenanceCaseV2 | undefined,
) {
  const caseId = topicMaintenanceCaseId(selected);
  const targetHash = previous?.targetHash ?? expectedContentHash;
  const revision = previous?.revision ?? sha256HexSync(`topic-observation-budget-deferred:${caseId}:${targetHash}`);
  const checkpoint: TopicMaintenanceCheckpoint =
    previous === undefined
      ? {targetHash, revision, outcome: 'unavailable', checkedAt: now, coverage: 'declared-only', deferredAt: now}
      : (() => {
          const candidate: TopicMaintenanceCheckpoint = {
            ...previous,
            checkedAt: now,
            outcome: 'unavailable',
            deferredAt: now,
          };
          return checkpointFits(candidate)
            ? candidate
            : compactCheckpoint(candidate, previous.observation ?? previous.recoveryObservation);
        })();
  const item: ContextMaintenanceCaseV2 = priorCase
    ? {
        ...priorCase,
        disposition: 'waiting-evidence',
        reason: 'topic-observation-budget-deferred',
        lastSeen: now,
        lastChecked: now,
      }
    : {
        caseId,
        project: selected.metadata.project ?? 'unscoped',
        memoryId: selected.metadata.memoryId!,
        family: TOPIC_MAINTENANCE_FAMILY,
        slot: TOPIC_MAINTENANCE_SLOT,
        evidenceRevision: revision,
        disposition: 'waiting-evidence',
        reason: 'topic-observation-budget-deferred',
        firstSeen: now,
        lastSeen: now,
        lastChecked: now,
        attemptCount: 0,
        events: [{at: now, reason: 'topic-observation-budget-deferred'}],
      };
  return {caseId, item, checkpoint};
}

/** Share the existing packet revision guard and reject a mixed target/source read. */
export function buildTopicMaintenanceCasePacket<E, R>(
  config: RuntimeConfig,
  item: ContextMaintenanceCaseV2,
  record: MemoryRecord,
  observation: TopicMaintenanceObservationV1,
  assertCaseCurrent: Effect.Effect<void, E, R>,
) {
  const root = item.sourceSnapshot!.cwd;
  const assertCurrent = Effect.gen(function* () {
    yield* assertCaseCurrent;
    const current = (yield* readMemoryRecordsByUri(config, [record.uri]))[0];
    if (
      !current ||
      !enrolledTopicRecord(current) ||
      maintenanceContentHash(current.content) !== item.subjectContentHashes?.[0]?.hash ||
      (yield* readContextMaintenanceSourceEpoch(config, root)) !== item.sourceSnapshot!.generation
    )
      return yield* topicFail('The enrolled topic or source changed. Refresh maintenance.');
    const evidence = yield* observeTopicMaintenanceEvidence(config, current, root, observation, {allowCapture: false});
    if (evidence.revision !== item.evidenceRevision)
      return yield* topicFail('The declared source evidence changed. Refresh maintenance.');
  });
  return withMaintenancePacketRevision(
    assertCurrent,
    buildTopicMaintenanceEvidencePacket(config, record, root, observation),
  );
}

export function readTopicMaintenanceCasePacket<E, R>(
  config: RuntimeConfig,
  item: ContextMaintenanceCaseV2,
  record: MemoryRecord,
  checkpoint: TopicMaintenanceCheckpoint | undefined,
  selection: {
    readonly citationId?: string;
    readonly memoryUri?: string;
    readonly startLine?: number;
    readonly maximumLines?: number;
  },
  assertCaseCurrent: Effect.Effect<void, E, R>,
) {
  return Effect.gen(function* () {
    if (
      item.slot !== TOPIC_MAINTENANCE_SLOT ||
      !enrolledTopicRecord(record) ||
      !item.sourceSnapshot ||
      selection.citationId !== undefined ||
      selection.memoryUri !== undefined ||
      selection.startLine !== undefined ||
      selection.maximumLines !== undefined ||
      !checkpoint ||
      checkpoint.deferredAt !== undefined ||
      checkpoint.overflowReason !== undefined ||
      !checkpoint.observation ||
      checkpoint.observation.revision !== item.evidenceRevision
    )
      return yield* topicFail('The enrolled topic observation changed. Refresh maintenance.');
    const observation = checkpoint.observation;
    const topicEvidence = yield* buildTopicMaintenanceCasePacket(config, item, record, observation, assertCaseCurrent);
    return {
      version: 2 as const,
      caseId: item.caseId,
      project: item.project,
      memoryUri: record.uri,
      memoryId: item.memoryId,
      evidenceRevision: item.evidenceRevision,
      expectedContentHash: observation.targetHash,
      disposition: item.disposition,
      reason: item.reason,
      coverage: 'declared-only' as const,
      topicEvidence,
      evidenceCounts: {
        declared: observation.sources.length,
        unavailable: observation.sources.filter(
          source => source.status === 'unknown' || source.status === 'deleted' || !source.current,
        ).length,
        historicalUnavailable: observation.sources.filter(source => !source.historicalAvailable).length,
        truncated:
          topicEvidence.truncatedExcerpts ?? observation.sources.filter(source => source.excerptTruncated).length,
      },
      choices: ['Review the declared support and author a topic update'],
      allowedOperations: ['read_context_maintenance_packet'],
      instructions: 'Review the accepted topic and every declared original citation against bounded verified evidence.',
    };
  });
}
