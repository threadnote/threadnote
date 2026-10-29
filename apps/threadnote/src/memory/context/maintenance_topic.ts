import {isOneOf as checkedIsOneOf} from '@threadnote/platform/validation';
import {Array as EffectArray, Predicate} from 'effect';
import {isSharedMemoryUri, type MemoryRecord} from '@threadnote/memory/document';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import type {TopicMaintenanceReviewPayload} from '@threadnote/memory/topic-maintenance-draft';
import {validateTopicMaintenanceManifest} from '@threadnote/memory/topic-maintenance';
import {contextHealthCaseIdV2} from '@threadnote/context/health_maintenance';
import {assertMemoryCodeCitation} from '@threadnote/memory/code/citation';
import type {TopicMaintenanceObservation, TopicMaintenanceObservationV1} from '@threadnote/context/topic_maintenance';
import {
  observeTopicMaintenanceEvidence,
  buildTopicMaintenanceEvidencePacket,
} from '@threadnote/context/topic_maintenance';
import {DateTime, Effect, FileSystem, Option, Result, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readMemoryRecordsByUri} from '../../mcp/server/memory.js';
import {readContextMaintenanceSourceEpoch} from './maintenance_evidence.js';
import {
  hasAbsentMaintenanceAnchors,
  maintenanceContentHash,
  reconcileAbsentMaintenanceAnchors,
  upsertCase,
} from './maintenance_policy.js';
import {withMaintenancePacketRevision} from './maintenance_packet.js';
import type {ContextMaintenanceCaseV2, MaintenanceState} from './maintenance.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {MaintenanceWorkSchedule} from './maintenance_decisions.js';
import {isObsidianTopic, inspectTopicObsidianState, readTopicObsidianPacket} from './maintenance_obsidian.js';
import {verifyTopicMaintenanceReviewSource} from './maintenance_review_source.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const TOPIC_MAINTENANCE_FAMILY = 'topic-maintenance';
export const TOPIC_MAINTENANCE_SLOT = 'declared-support';
const MAX_TOPIC_CHECKPOINT_BYTES = 32 * 1024;
class TopicMaintenanceError extends Schema.TaggedError<TopicMaintenanceError, {readonly brand: unique symbol}>()(
  'TopicMaintenanceError',
  {
    message: Schema.String,
  },
) {}
const topicFail = (message: string) => TopicMaintenanceError.make({message});

export interface TopicMaintenanceCheckpoint {
  readonly targetHash: string;
  readonly revision: string;
  readonly outcome: 'unchanged' | 'review-required' | 'unavailable';
  readonly checkedAt: string;
  readonly coverage: 'declared-only';
  readonly suppressedRevision?: string;
  readonly suppressedDecision?: 'reject' | 'defer';
  readonly observation?: TopicMaintenanceObservation;
  readonly recoveryObservation?: TopicMaintenanceObservation;
  readonly deferredAt?: string;
  readonly overflowReason?: 'topic-observation-overflow';
}

function checkpointFits(value: TopicMaintenanceCheckpoint): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_TOPIC_CHECKPOINT_BYTES;
}

function compactCheckpoint(
  candidate: TopicMaintenanceCheckpoint,
  recovery: TopicMaintenanceObservation | undefined,
): TopicMaintenanceCheckpoint {
  const base: TopicMaintenanceCheckpoint = {
    targetHash: candidate.targetHash,
    revision: candidate.revision,
    outcome: 'unavailable',
    checkedAt: candidate.checkedAt,
    coverage: 'declared-only',
    ...(candidate.suppressedRevision ? {suppressedRevision: candidate.suppressedRevision} : {}),
    ...(candidate.suppressedDecision ? {suppressedDecision: candidate.suppressedDecision} : {}),
    ...(candidate.deferredAt ? {deferredAt: candidate.deferredAt} : {}),
    ...(candidate.overflowReason ? {overflowReason: candidate.overflowReason} : {}),
  };
  const withRecovery = recovery === undefined ? base : {...base, recoveryObservation: recovery};
  return checkpointFits(withRecovery) ? withRecovery : base;
}

/** A valid observation may exceed the private checkpoint budget; retain only bounded recovery data. */
export function boundedTopicMaintenanceCheckpoint(
  observation: TopicMaintenanceObservation,
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
    ...(suppressedRevision && previous?.suppressedDecision ? {suppressedDecision: previous.suppressedDecision} : {}),
  };
  if (checkpointFits(candidate)) return candidate;
  return compactCheckpoint(
    {...candidate, overflowReason: 'topic-observation-overflow'},
    previous?.observation ?? previous?.recoveryObservation,
  );
}

export interface TopicReviewDecisionInput {
  readonly caseId: string;
  readonly observationRevision: string;
  readonly action: 'reject' | 'defer' | 'resume';
  readonly onStale?: 'ignore';
}

export function saveTopicReviewDecision<E, R>(
  state: MaintenanceState,
  input: TopicReviewDecisionInput,
  persist: (state: MaintenanceState) => Effect.Effect<void, E, R>,
) {
  return Effect.gen(function* () {
    const item = Option.getOrUndefined(EffectArray.findFirst(state.cases, item => item.caseId === input.caseId));
    const checkpoint = state.topicCheckpoints?.[input.caseId];
    if (!['reject', 'defer', 'resume'].includes(input.action) || !/^[0-9a-f]{64}$/u.test(input.observationRevision))
      return yield* topicFail('Choose an exact topic review action and observation revision.');
    if (
      !item ||
      item.family !== TOPIC_MAINTENANCE_FAMILY ||
      item.slot !== TOPIC_MAINTENANCE_SLOT ||
      !checkpoint ||
      item.evidenceRevision !== input.observationRevision ||
      checkpoint.revision !== input.observationRevision
    ) {
      if (input.onStale === 'ignore') return undefined;
      return yield* topicFail('The topic evidence changed. Refresh maintenance before recording this decision.');
    }
    if (input.action === 'resume' && checkpoint.suppressedDecision === 'reject')
      return yield* topicFail('A rejected topic review cannot resume. New material evidence may open another review.');
    if (
      input.action === 'resume'
        ? checkpoint.suppressedRevision === undefined
        : checkpoint.suppressedRevision === input.observationRevision && checkpoint.suppressedDecision === input.action
    )
      return item;
    const {suppressedRevision: _revision, suppressedDecision: _decision, ...unsuppressed} = checkpoint;
    const nextCheckpoint: TopicMaintenanceCheckpoint =
      input.action === 'resume'
        ? unsuppressed
        : {
            ...checkpoint,
            suppressedRevision: input.observationRevision,
            suppressedDecision: input.action,
          };
    const disposition =
      input.action !== 'resume'
        ? 'deferred-policy'
        : checkpoint.outcome === 'review-required'
          ? 'needs-decision'
          : checkpoint.outcome === 'unavailable'
            ? 'waiting-evidence'
            : 'resolved';
    const reason =
      input.action === 'reject'
        ? 'topic-review-rejected'
        : input.action === 'defer'
          ? 'topic-review-deferred'
          : `topic-${checkpoint.outcome}`;
    const now = DateTime.formatIso(yield* DateTime.now);
    const caseMap = new Map(EffectArray.map(state.cases, item => [item.caseId, item]));
    const next = {...item, ...upsertCase(caseMap, {...item, disposition, reason}, now)};
    caseMap.set(item.caseId, next);
    const cases = [...caseMap.values()];
    yield* persist({
      ...state,
      cases,
      topicCheckpoints: {...state.topicCheckpoints, [item.caseId]: nextCheckpoint},
      state: EffectArray.some(cases, item => item.disposition === 'needs-decision')
        ? 'needs-decision'
        : EffectArray.some(cases, item => item.disposition === 'waiting-evidence')
          ? 'waiting-evidence'
          : 'idle',
    });
    return next;
  });
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
  const eligible = EffectArray.filter(
    records,
    (__effectFilterValue: (typeof records)[number], __effectFilterIndex: number) =>
      __effectFilterIndex in records && enrolledTopicCandidate(__effectFilterValue),
  ).sort((a, b) => Effect2.pipe(a.metadata.memoryId!, EffectString.localeCompare(b.metadata.memoryId!)));
  return (
    Option.getOrUndefined(
      EffectArray.findFirst(eligible, record => record.metadata.memoryId! > (lastMemoryId ?? '')),
    ) ?? eligible[0]
  );
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
  if (!Predicate.isObject(value)) return false;
  return EffectArray.every(
    EffectRecord.toEntries(value),
    ([key, item]) => /^health-case-[0-9a-f]{40}$/u.test(key) && decodeTopicMaintenanceCheckpoint(item) !== undefined,
  );
}

function decodeTopicMaintenanceCheckpoint(value: unknown): TopicMaintenanceCheckpoint | undefined {
  if (!Predicate.isObject(value)) return undefined;
  const entry = value;
  if (
    !EffectArray.every(EffectRecord.keys(entry), field =>
      [
        'targetHash',
        'revision',
        'outcome',
        'checkedAt',
        'coverage',
        'suppressedRevision',
        'suppressedDecision',
        'observation',
        'recoveryObservation',
        'deferredAt',
        'overflowReason',
      ].includes(field),
    ) ||
    typeof entry.targetHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(entry.targetHash) ||
    typeof entry.revision !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(entry.revision) ||
    !checkedIsOneOf(['unchanged', 'review-required', 'unavailable'], entry.outcome) ||
    typeof entry.checkedAt !== 'string' ||
    entry.checkedAt.length > 40 ||
    entry.coverage !== 'declared-only' ||
    (entry.suppressedRevision !== undefined &&
      (typeof entry.suppressedRevision !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.suppressedRevision))) ||
    (entry.suppressedDecision !== undefined &&
      (entry.suppressedRevision === undefined || !checkedIsOneOf(['reject', 'defer'], entry.suppressedDecision))) ||
    (entry.deferredAt !== undefined && (typeof entry.deferredAt !== 'string' || entry.deferredAt.length > 40)) ||
    (entry.overflowReason !== undefined && entry.overflowReason !== 'topic-observation-overflow') ||
    (entry.observation !== undefined && !validObservation(entry.observation, entry.targetHash, entry.revision)) ||
    (entry.recoveryObservation !== undefined && !validRecoveryObservation(entry.recoveryObservation))
  )
    return undefined;

  const checkpoint: TopicMaintenanceCheckpoint = {
    targetHash: entry.targetHash,
    revision: entry.revision,
    outcome: entry.outcome,
    checkedAt: entry.checkedAt,
    coverage: entry.coverage,
    ...(entry.suppressedRevision === undefined ? {} : {suppressedRevision: entry.suppressedRevision}),
    ...(entry.suppressedDecision === undefined ? {} : {suppressedDecision: entry.suppressedDecision}),
    ...(entry.observation === undefined ? {} : {observation: entry.observation}),
    ...(entry.recoveryObservation === undefined ? {} : {recoveryObservation: entry.recoveryObservation}),
    ...(entry.deferredAt === undefined ? {} : {deferredAt: entry.deferredAt}),
    ...(entry.overflowReason === undefined ? {} : {overflowReason: entry.overflowReason}),
  };
  if (
    checkpoint.observation === undefined &&
    !(
      (checkpoint.deferredAt !== undefined || checkpoint.overflowReason !== undefined) &&
      checkpoint.outcome === 'unavailable'
    )
  )
    return undefined;
  return checkpointFits(checkpoint) ? checkpoint : undefined;
}

function validRecoveryObservation(value: unknown): value is TopicMaintenanceObservation {
  if (!Predicate.isObject(value) || !('targetHash' in value) || !('revision' in value)) return false;
  return validObservation(value, value.targetHash, value.revision);
}

function validObservation(
  value: unknown,
  targetHash: unknown,
  revision: unknown,
): value is TopicMaintenanceObservation {
  if (typeof value === 'object' && value !== null && 'version' in value && value.version === 2) {
    if (
      EffectArray.some(
        EffectRecord.keys(value),
        key =>
          ![
            'version',
            'sourceKind',
            'targetHash',
            'revision',
            'coverage',
            'outcome',
            'canDraft',
            'inspectionDigest',
            'sources',
          ].includes(key),
      ) ||
      !('sourceKind' in value) ||
      value.sourceKind !== 'obsidian' ||
      !('targetHash' in value) ||
      value.targetHash !== targetHash ||
      !('revision' in value) ||
      value.revision !== revision ||
      !('coverage' in value) ||
      value.coverage !== 'declared-only' ||
      !('outcome' in value) ||
      typeof value.outcome !== 'string' ||
      !['unchanged', 'review-required', 'unavailable'].includes(value.outcome) ||
      !('canDraft' in value) ||
      value.canDraft !== false ||
      ('inspectionDigest' in value &&
        (typeof value.inspectionDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.inspectionDigest))) ||
      !('sources' in value) ||
      !EffectArray.isArray(value.sources) ||
      value.sources.length !== 1
    )
      return false;
    return EffectArray.every(
      value.sources,
      (source: unknown) =>
        typeof source === 'object' &&
        source !== null &&
        EffectArray.join(EffectRecord.keys(source).sort(), ',') ===
          'activeStatus,citationId,historicalAvailable,originStatus,reason,status' &&
        'citationId' in source &&
        typeof source.citationId === 'string' &&
        /^tnob_[a-f0-9]{40}$/u.test(source.citationId) &&
        'historicalAvailable' in source &&
        typeof source.historicalAvailable === 'boolean' &&
        'status' in source &&
        typeof source.status === 'string' &&
        ['exact', 'relocated', 'changed', 'deleted', 'unknown'].includes(source.status) &&
        'reason' in source &&
        typeof source.reason === 'string' &&
        source.reason.length <= 256 &&
        'originStatus' in source &&
        typeof source.originStatus === 'string' &&
        ['available', 'expired', 'revoked', 'missing', 'corrupt'].includes(source.originStatus) &&
        'activeStatus' in source &&
        typeof source.activeStatus === 'string' &&
        ['available', 'expired', 'revoked', 'missing', 'corrupt'].includes(source.activeStatus),
    );
  }
  return validCodeObservation(value, targetHash, revision);
}

function validCodeObservation(
  value: unknown,
  targetHash: unknown,
  revision: unknown,
): value is TopicMaintenanceObservationV1 {
  if (!Predicate.isObject(value)) return false;
  const item = value;
  if (
    EffectArray.some(
      EffectRecord.keys(item),
      key => !['version', 'targetHash', 'revision', 'coverage', 'outcome', 'sources', 'canDraft'].includes(key),
    ) ||
    item.version !== 1 ||
    item.targetHash !== targetHash ||
    item.revision !== revision ||
    item.coverage !== 'declared-only' ||
    !checkedIsOneOf(['unchanged', 'review-required', 'unavailable'], item.outcome) ||
    typeof item.canDraft !== 'boolean' ||
    !EffectArray.isArray(item.sources) ||
    item.sources.length > 8
  )
    return false;
  const ids = new Set<string>();
  return EffectArray.every(item.sources, (raw: unknown) => {
    if (!Predicate.isObject(raw)) return false;
    const source = raw;
    if (
      EffectArray.some(
        EffectRecord.keys(source),
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
      !checkedIsOneOf(['exact', 'relocated', 'changed', 'deleted', 'unknown'], source.status) ||
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
  return EffectRecord.fromEntries(
    EffectArray.filter(EffectRecord.toEntries(checkpoints), ([id]) => activeCaseIds.has(id)),
  );
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
  const terminal = EffectArray.filter(
    cases,
    (item, __effectArrayIndex) =>
      __effectArrayIndex in cases &&
      ['resolved', 'retired'].includes(item.disposition) &&
      item.retirement === undefined &&
      !retainTopic(item),
  )
    .sort((a, b) => Effect2.pipe(b.lastChecked, EffectString.localeCompare(a.lastChecked)))
    .slice(0, 200);
  return [
    ...EffectArray.filter(
      cases,
      (item, __effectArrayIndex) =>
        __effectArrayIndex in cases &&
        (!['resolved', 'retired'].includes(item.disposition) || item.retirement !== undefined || retainTopic(item)),
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
  const imported = isObsidianTopic(selected);
  const openingEpoch = imported ? undefined : yield* readContextMaintenanceSourceEpoch(config, root);
  const current = (yield* readMemoryRecordsByUri(config, [selected.uri]))[0];
  if (!current || !enrolledTopicRecord(current) || maintenanceContentHash(current.content) !== expectedContentHash)
    return undefined;
  const previousCheckpoint = checkpoints[caseId];
  const priorObservation = previousCheckpoint?.observation ?? previousCheckpoint?.recoveryObservation;
  const observed = imported
    ? (yield* inspectTopicObsidianState(config, current)).observation
    : yield* observeTopicMaintenanceEvidence(
        config,
        current,
        root,
        priorObservation?.version === 1 ? priorObservation : undefined,
      );
  const closing = (yield* readMemoryRecordsByUri(config, [selected.uri]))[0];
  if (
    !closing ||
    !enrolledTopicRecord(closing) ||
    maintenanceContentHash(closing.content) !== maintenanceContentHash(current.content)
  )
    return undefined;
  if (
    imported
      ? (yield* inspectTopicObsidianState(config, closing)).observation.revision !== observed.revision
      : (yield* readContextMaintenanceSourceEpoch(config, root)) !== openingEpoch
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
    ? checkpoint.suppressedDecision === 'defer'
      ? 'topic-review-deferred'
      : 'topic-review-rejected'
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
    ...(openingEpoch === undefined
      ? {}
      : {sourceSnapshot: {cwd: root, generation: openingEpoch, revision: observed.revision}}),
  };
  return {caseId, item, checkpoint};
});

export const advanceScheduledTopicMaintenance = Effect.fn('contextMaintenance.advanceScheduledTopic')(function* (
  config: RuntimeConfig,
  state: MaintenanceState,
  records: readonly MemoryRecord[],
  roots: ReadonlyMap<string, string>,
  cwd: string,
  logicalHashes: ReadonlyMap<string, string>,
  now: string,
  checkpoints: Readonly<Record<string, TopicMaintenanceCheckpoint>>,
  caseMap: Map<string, ContextMaintenanceCaseV2>,
) {
  const selected = selectTopicMaintenanceRecord(records, state.workSchedule?.lastTopicMemoryId);
  if (!selected) return state;
  const scheduled = {...state, workSchedule: advanceTopicMaintenanceCursor(state.workSchedule!, selected)};
  const root = roots.get(selected.metadata.project!) ?? cwd;
  const expectedHash = logicalHashes.get(selected.uri) ?? maintenanceContentHash(selected.content);
  const turn = yield* observeTopicMaintenanceCase(config, selected, expectedHash, root, now, checkpoints, caseMap).pipe(
    Effect.timeoutOption(5_000),
  );
  const result = Option.isSome(turn)
    ? turn.value
    : deferTopicMaintenanceCase(
        selected,
        expectedHash,
        now,
        checkpoints[topicMaintenanceCaseId(selected)],
        caseMap.get(topicMaintenanceCaseId(selected)),
      );
  if (!result) return scheduled;
  caseMap.set(result.caseId, result.item);
  return {
    ...scheduled,
    topicCheckpoints: {...state.topicCheckpoints, [result.caseId]: result.checkpoint},
  };
});

export function stateWithAcceptedTopicObservation(
  state: MaintenanceState,
  observed: {
    readonly caseId: string;
    readonly item: ContextMaintenanceCaseV2;
    readonly checkpoint: TopicMaintenanceCheckpoint;
  },
): MaintenanceState {
  const cases = EffectArray.map(state.cases, item => (item.caseId === observed.caseId ? observed.item : item));
  return {
    ...stateWithAcceptedCases(state, cases),
    topicCheckpoints: {...state.topicCheckpoints, [observed.caseId]: observed.checkpoint},
  };
}

function stateWithAcceptedCases(state: MaintenanceState, cases: readonly ContextMaintenanceCaseV2[]): MaintenanceState {
  return {
    ...state,
    cases,
    state: EffectArray.some(cases, item => item.disposition === 'needs-decision')
      ? 'needs-decision'
      : EffectArray.some(cases, item => item.disposition === 'waiting-evidence')
        ? 'waiting-evidence'
        : state.state === 'needs-decision' || state.state === 'waiting-evidence'
          ? 'idle'
          : state.state,
  };
}

/** Under the state lock, re-observe the exact post-write target before completing its review receipt. */
export function reconcileAcceptedTopicMaintenanceState<A, E, R, P, Q>(
  config: RuntimeConfig,
  state: MaintenanceState,
  original: MemoryRecord,
  acceptedContent: string,
  payload: TopicMaintenanceReviewPayload,
  sourceCwd: string | undefined,
  persist: (state: MaintenanceState) => Effect.Effect<void, P, Q>,
  complete: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    return yield* withMemoryUriLocks(
      yield* FileSystem.FileSystem,
      config.agentContextHome,
      [original.uri],
      Effect.gen(function* () {
        const current = (yield* readMemoryRecordsByUri(config, [original.uri]))[0];
        if (
          !current ||
          current.content !== acceptedContent ||
          (payload.version !== 3 && !enrolledTopicRecord(current)) ||
          current.metadata.project !== original.metadata.project ||
          current.metadata.memoryId !== original.metadata.memoryId ||
          current.uri !== payload.basis.targetUri
        )
          return yield* topicFail('The accepted topic changed before maintenance verification.');
        yield* verifyTopicMaintenanceReviewSource(config, original, payload, sourceCwd);
        const persistAndComplete = (accepted: MaintenanceState) =>
          Effect.gen(function* () {
            yield* persist(accepted);
            const finalFence = yield* Effect.gen(function* () {
              const persistedTarget = (yield* readMemoryRecordsByUri(config, [original.uri]))[0];
              if (!persistedTarget || persistedTarget.content !== acceptedContent)
                return yield* topicFail('The accepted topic changed during maintenance verification.');
              yield* verifyTopicMaintenanceReviewSource(config, original, payload, sourceCwd);
            }).pipe(Effect.result);
            if (Result.isFailure(finalFence)) {
              yield* persist(state);
              return yield* Effect.fail(finalFence.failure);
            }
            return yield* complete;
          });
        if (payload.version === 3) {
          if (!hasAbsentMaintenanceAnchors(state.cases, current)) return yield* complete;
          const cases = new Map(EffectArray.map(state.cases, item => [item.caseId, item]));
          reconcileAbsentMaintenanceAnchors(cases, current, DateTime.formatIso(yield* DateTime.now));
          return yield* persistAndComplete(stateWithAcceptedCases(state, [...cases.values()]));
        }
        const caseId = topicMaintenanceCaseId(original);
        const prior = Option.getOrUndefined(EffectArray.findFirst(state.cases, item => item.caseId === caseId));
        const checkpoint = state.topicCheckpoints?.[caseId];
        if (!prior && !checkpoint) {
          if (payload.generation.origin === 'manual') return yield* complete;
          return yield* topicFail('The generated topic case is unavailable for verification.');
        }
        if (!prior || !checkpoint) return yield* topicFail('The topic case checkpoint is incomplete.');
        if (
          prior.project !== original.metadata.project ||
          prior.memoryId !== original.metadata.memoryId ||
          prior.family !== TOPIC_MAINTENANCE_FAMILY ||
          prior.slot !== TOPIC_MAINTENANCE_SLOT ||
          prior.subjectUri !== original.uri ||
          (checkpoint.revision !== payload.basis.observationRevision &&
            checkpoint.targetHash !== maintenanceContentHash(acceptedContent))
        )
          return yield* topicFail('The topic case changed before maintenance verification.');
        const cases = new Map(EffectArray.map(state.cases, item => [item.caseId, item]));
        const now = DateTime.formatIso(yield* DateTime.now);
        const observed = yield* observeTopicMaintenanceCase(
          config,
          current,
          maintenanceContentHash(acceptedContent),
          sourceCwd ?? '',
          now,
          state.topicCheckpoints ?? {},
          cases,
        );
        if (!observed || observed.caseId !== caseId)
          return yield* topicFail('The accepted topic changed during maintenance verification.');
        yield* verifyTopicMaintenanceReviewSource(config, original, payload, sourceCwd);
        if (
          checkpoint.targetHash === observed.checkpoint.targetHash &&
          checkpoint.revision === observed.checkpoint.revision &&
          checkpoint.outcome === observed.checkpoint.outcome &&
          prior.disposition === observed.item.disposition &&
          prior.evidenceRevision === observed.item.evidenceRevision &&
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(prior.subjectContentHashes), __effectArrayReceiver =>
              Option.getOrUndefined(
                EffectArray.findFirst(__effectArrayReceiver, subject => subject.uri === original.uri),
              ),
            ),
          )?.hash === maintenanceContentHash(acceptedContent) &&
          prior.sourceSnapshot?.revision === observed.item.sourceSnapshot?.revision
        )
          return yield* complete;
        return yield* persistAndComplete(stateWithAcceptedTopicObservation(state, observed));
      }),
    );
  });
}

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
  return Effect.gen(function* () {
    const openingEpoch = yield* readContextMaintenanceSourceEpoch(config, root);
    const assertCurrent = Effect.gen(function* () {
      yield* assertCaseCurrent;
      const current = (yield* readMemoryRecordsByUri(config, [record.uri]))[0];
      if (
        !current ||
        !enrolledTopicRecord(current) ||
        maintenanceContentHash(current.content) !== item.subjectContentHashes?.[0]?.hash ||
        (yield* readContextMaintenanceSourceEpoch(config, root)) !== openingEpoch
      )
        return yield* topicFail('The enrolled topic or source changed. Refresh maintenance.');
      const evidence = yield* observeTopicMaintenanceEvidence(config, current, root, observation, {
        allowCapture: false,
      });
      if (evidence.revision !== item.evidenceRevision)
        return yield* topicFail('The declared source evidence changed. Refresh maintenance.');
    });
    return yield* withMaintenancePacketRevision(
      assertCurrent,
      buildTopicMaintenanceEvidencePacket(config, record, root, observation),
    );
  });
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
    if (isObsidianTopic(record)) {
      if (
        item.slot !== TOPIC_MAINTENANCE_SLOT ||
        !checkpoint ||
        checkpoint.observation?.version !== 2 ||
        checkpoint.deferredAt ||
        checkpoint.overflowReason ||
        checkpoint.revision !== item.evidenceRevision ||
        // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
        EffectArray.some(Object.values(selection), value => value !== undefined)
      )
        return yield* topicFail('The imported topic observation changed. Refresh maintenance.');
      const guard = Effect.gen(function* () {
        yield* assertCaseCurrent;
        const current = (yield* readMemoryRecordsByUri(config, [record.uri]))[0];
        if (
          !current ||
          maintenanceContentHash(current.content) !== checkpoint.targetHash ||
          (yield* inspectTopicObsidianState(config, current)).observation.revision !== item.evidenceRevision
        )
          return yield* topicFail('The imported source or target changed. Refresh maintenance.');
      });
      const topicEvidence = yield* withMaintenancePacketRevision(guard, readTopicObsidianPacket(config, record));
      return {
        version: 2 as const,
        caseId: item.caseId,
        project: item.project,
        memoryUri: record.uri,
        memoryId: item.memoryId,
        evidenceRevision: item.evidenceRevision,
        expectedContentHash: checkpoint.targetHash,
        disposition: item.disposition,
        reason: item.reason,
        coverage: 'declared-only' as const,
        topicEvidence,
        evidenceCounts: {
          declared: 1,
          unavailable: topicEvidence.outcome === 'unavailable' ? 1 : 0,
          historicalUnavailable: topicEvidence.obsidian.origin?.historical === 'available' ? 0 : 1,
          truncated: topicEvidence.obsidian.current?.truncated ? 1 : 0,
        },
        choices: ['Inspect and explicitly capture the selected current note fragment', 'Review a bounded topic update'],
        allowedOperations: ['read_context_maintenance_packet', 'context_maintenance_capture'],
        instructions: 'Capture and review exact private note evidence before accepting a topic update.',
      };
    }
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
      checkpoint.observation.version !== 1 ||
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
        unavailable: EffectArray.filter(
          observation.sources,
          source => source.status === 'unknown' || source.status === 'deleted' || !source.current,
        ).length,
        historicalUnavailable: EffectArray.filter(observation.sources, source => !source.historicalAvailable).length,
        truncated:
          topicEvidence.truncatedExcerpts ??
          EffectArray.filter(
            observation.sources,
            (source, __effectArrayIndex) =>
              __effectArrayIndex in observation.sources && Boolean(source.excerptTruncated),
          ).length,
      },
      choices: ['Review the declared support and author a topic update'],
      allowedOperations: ['read_context_maintenance_packet'],
      instructions: 'Review the accepted topic and every declared original citation against bounded verified evidence.',
    };
  });
}
