import {Array as EffectArray, Option as EffectOption, Schema, String as EffectString, pipe as EffectPipe} from 'effect';
import {nativeCycleParentsReady, nextNativeCycle as cycleNext} from './cycle.js';
import {NativeCycleDeliverySchema} from './cycle.js';
import {
  nativeCyclePhaseReviewUsage,
  nativeCycleSnapshotIsCurrentIteration,
  nativeCycleSupplementalRef,
  nativeCycleSupplementalRevision,
} from './cycle_runtime.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {NativeWorkflowState} from './native.js';
import {NativeCompactIntentSchema} from './authoring.js';
import {nativeCycleReviewRecordingMode, validateNativeCycleReviewHistory} from './cycle_review.js';

export const NativeTaskStartRequestSchema = Schema.Union([
  Schema.Struct({
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    featureName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    graphProject: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
    installationTarget: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
    taskRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
    intent: NativeCompactIntentSchema,
  }),
  Schema.Struct({
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    sharedPlanRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    installationTarget: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    graphProject: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
    delivery: Schema.Literals(['local', 'commit', 'pr']),
    bindings: Schema.Record(Schema.String, Schema.Struct({branch: Schema.String, baseBranch: Schema.String})),
    userResponse: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    review: Schema.Struct({outcome: Schema.Literal('accepted'), blockingIssueCount: Schema.Literal(0)}),
  }),
]);

export type NativeTaskRole = 'implementation' | 'review' | 'delivery';

/** Semantic task anchor input; the application derives the digest from admitted checkout bytes. */
export const NativeTaskAnchorSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  pattern: Schema.String.check(Schema.isMaxLength(256)),
});

export interface NativeTaskView {
  readonly status: 'ready' | 'blocked' | 'complete' | 'uninitialized';
  readonly runId: string;
  readonly generation: string;
  readonly revision: string;
  readonly featureId: string;
  readonly objective: string;
  readonly next: {
    readonly action: string;
    readonly phaseId?: string;
    readonly snapshotId?: string;
    readonly reason?: string;
  };
  readonly taskRef?: string;
  readonly role?: NativeTaskRole;
  readonly phase?: {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly scope: readonly string[];
    readonly acceptance: readonly string[];
    readonly acceptanceRefs: readonly string[];
    readonly snapshot?: {
      readonly snapshotId: string;
      readonly head: string;
      readonly tree: string;
      readonly baseTree: string;
      readonly scopeBase: string;
      readonly declaredBaseHead: string;
      readonly files: readonly string[];
      readonly scopeFiles: readonly string[];
      readonly requiredReviewLanes: readonly string[];
      readonly recordingMode: 'full' | 'incremental';
      readonly snapshotRef: string;
      readonly previousAttempt?: {readonly status: 'invalid'; readonly message: string};
    };
  };
  readonly page: {
    readonly offset: number;
    readonly limit: 16;
    readonly nextOffset?: number;
    readonly nextCursor?: string;
  };
  readonly counts: {
    readonly scope: number;
    readonly acceptance: number;
    readonly acceptanceRefs: number;
    readonly snapshotFiles: number;
    readonly snapshotScopeFiles: number;
    readonly historicalWatches?: number;
    readonly supplementalPublications?: number;
  };
  readonly missingInputs: readonly string[];
  readonly supplementalPublications?: readonly {
    readonly publicationId: string;
    readonly phaseId: string;
    readonly prUrl: string;
    readonly publicationRef: string;
    readonly revision: string;
    readonly completed: boolean;
    readonly watch?: {
      readonly consumerId: string;
      readonly stateDir: string;
      readonly state: 'active' | 'terminal';
      readonly recordRef: string;
    };
  }[];
  readonly historicalWatches?: readonly {
    readonly phaseId: string;
    readonly title: string;
    readonly prUrl: string;
  }[];
  readonly baseRequalification?: {
    readonly action: 'requalify-base';
    readonly phaseId: string;
    readonly predecessorRef: string;
    readonly fromBaseBranch: string;
    readonly toBaseBranch: string;
  };
  readonly historicalWatch?: {
    readonly action: 'watch-pr';
    readonly phaseId: string;
    readonly prUrl: string;
    readonly consumerId: string;
    readonly validationRef: string;
    readonly deliveryRef: string;
  };
}

export interface NativeTaskProjectionOptions {
  readonly role?: NativeTaskRole;
  readonly offset?: number;
  readonly planDrift?: string;
  /** Result of the application core's live check-phase for an accepted review. */
  readonly acceptedSnapshotCurrent?: boolean;
  readonly historicalWatchCount?: number;
  /** Digest of the refreshed external candidate set used by the caller's paged projection. */
  readonly candidateHash?: string;
}

export const NativeTaskActionRefSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals([
    'task',
    'work',
    'snapshot',
    'validation',
    'delivery',
    'retained-work',
    'closeout-prepare',
    'closeout-finish',
  ]),
  runId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)),
  generationHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  stateRevision: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  phaseId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u))),
  taskAction: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
  phaseHash: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  baselineHead: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u))),
  baselineTree: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u))),
  baselineRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
  sourceHead: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u))),
  sourceTree: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u))),
  snapshotId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u))),
  attemptId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u))),
  previousAttemptId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u))),
  payloadDigest: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  delivery: Schema.optionalKey(NativeCycleDeliverySchema),
  watchId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u))),
  consumerId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u))),
  wakeupId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u))),
  eventKey: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[0-9]+:[0-9]+$/u)),
  ),
  watchAttemptId: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu)),
  ),
  watchDeliveryId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
  watchEventId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(384))),
  workViewDigest: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  workRowDigest: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  closeoutRevision: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)))),
  transactionId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  jobId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u))),
}).check(
  Schema.makeFilter(ref =>
    ref.kind === 'retained-work'
      ? Boolean(
          ref.watchId &&
          ref.consumerId &&
          ref.wakeupId &&
          ref.watchEventId &&
          ref.workViewDigest &&
          ref.workRowDigest &&
          !ref.watchDeliveryId &&
          !ref.eventKey &&
          !ref.watchAttemptId,
        )
      : ref.workViewDigest === undefined && ref.workRowDigest === undefined,
  ),
);
export type NativeTaskActionRef = typeof NativeTaskActionRefSchema.Type;

const nativeTaskStartRunIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
export interface NativeTaskStartReference {
  readonly runId: string;
  readonly actionRef?: NativeTaskActionRef;
}

export function nativeTaskCardRef(
  state: NativeWorkflowState,
  revision: string,
  taskAction: string,
  phaseId?: string,
  snapshotId?: string,
  payloadDigest?: string,
): string {
  const phaseHash = phaseId ? state.cycle?.state.phases[phaseId]?.phaseHash : undefined;
  return encodeNativeTaskActionRef({
    version: 1,
    kind: 'task',
    runId: state.runId,
    generationHash: sha256HexSync(state.generation),
    ...(/^[a-f0-9]{64}$/u.test(revision) ? {stateRevision: revision} : {}),
    taskAction,
    ...(phaseId && phaseHash ? {phaseId, phaseHash} : {}),
    ...(snapshotId ? {snapshotId} : {}),
    ...(payloadDigest ? {payloadDigest} : {}),
  });
}

const encodeOpaqueRef = (value: string): string => {
  const binary = EffectArray.join(
    EffectArray.map(Array.from(new TextEncoder().encode(value)), byte => String.fromCharCode(byte)),
    '',
  );
  return EffectPipe(
    btoa(binary),
    EffectString.replaceAll('+', '-'),
    EffectString.replaceAll('/', '_'),
    EffectString.replace(/=+$/u, ''),
  );
};

const decodeOpaqueRef = (value: string): string | undefined => {
  try {
    const binary = atob(EffectPipe(value, EffectString.replaceAll('-', '+'), EffectString.replaceAll('_', '/')));
    const bytes = Uint8Array.from(binary, character =>
      EffectOption.getOrElse(EffectPipe(character, EffectString.charCodeAt(0)), () => 0),
    );
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return undefined;
  }
};

export function encodeNativeTaskActionRef(input: NativeTaskActionRef): string {
  const ref = Schema.decodeSync(NativeTaskActionRefSchema, {onExcessProperty: 'error'})(input);
  return `taskref-v1.${encodeOpaqueRef(JSON.stringify(ref))}`;
}

export function decodeNativeTaskActionRef(input: string): NativeTaskActionRef | undefined {
  if (!EffectString.startsWith('taskref-v1.')(input)) return undefined;
  const decoded = decodeOpaqueRef(EffectString.slice('taskref-v1.'.length)(input));
  if (decoded === undefined) return undefined;
  try {
    return Schema.decodeUnknownSync(NativeTaskActionRefSchema, {onExcessProperty: 'error'})(JSON.parse(decoded));
  } catch {
    return undefined;
  }
}

/** Decode either the legacy canonical run ID or a current task-view card reference. */
export function decodeNativeTaskStartReference(input: string): NativeTaskStartReference | undefined {
  if (EffectString.startsWith('taskref-v1.')(input)) {
    const actionRef = decodeNativeTaskActionRef(input);
    return actionRef?.kind === 'task' ? {runId: actionRef.runId, actionRef} : undefined;
  }
  return Schema.is(nativeTaskStartRunIdSchema)(input) ? {runId: input} : undefined;
}

export const nativeTaskStartRunId = (
  reference: NativeTaskStartReference | undefined,
  project: string,
  featureId: string,
) => reference?.runId ?? 'task-' + EffectString.slice(0, 48)(sha256HexSync(project + '\n' + featureId));

export const nativeTaskStartReferenceIsCurrent = (
  reference: NativeTaskStartReference | undefined,
  current: {readonly state: {readonly generation: string}; readonly revision: string},
  refs: readonly [requested: string | undefined, current: string | undefined],
) =>
  !reference?.actionRef ||
  (reference.actionRef.generationHash === sha256HexSync(current.state.generation) &&
    reference.actionRef.stateRevision === current.revision &&
    refs[1] === refs[0]);

export function nativeTaskSnapshotId(workRef: string): string {
  return `task-${EffectString.slice(0, 48)(sha256HexSync(workRef))}`;
}

export interface NativeTaskCursor {
  readonly version: 1;
  readonly runId: string;
  readonly generationHash: string;
  readonly revision: string;
  readonly action: string;
  readonly phaseId: string | null;
  readonly snapshotId: string | null;
  readonly role: NativeTaskRole | null;
  readonly candidateHash?: string;
  readonly offset: number;
}

const encodeCursor = (cursor: NativeTaskCursor): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  const binary = EffectArray.join(
    EffectArray.map(Array.from(bytes), byte => String.fromCharCode(byte)),
    '',
  );
  return `task-v1.${EffectPipe(btoa(binary), EffectString.replaceAll('+', '-'), EffectString.replaceAll('/', '_'), EffectString.replace(/=+$/u, ''))}`;
};

export function decodeNativeTaskCursor(value: string): NativeTaskCursor | undefined {
  if (!EffectString.startsWith('task-v1.')(value)) return undefined;
  try {
    const encoded = EffectPipe(
      EffectString.slice('task-v1.'.length)(value),
      EffectString.replaceAll('-', '+'),
      EffectString.replaceAll('_', '/'),
    );
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, character =>
      EffectOption.getOrElse(EffectPipe(character, EffectString.charCodeAt(0)), () => 0),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const candidateHash =
      typeof parsed === 'object' && parsed !== null && 'candidateHash' in parsed ? parsed.candidateHash : undefined;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('runId' in parsed) ||
      typeof parsed.runId !== 'string' ||
      !('generationHash' in parsed) ||
      typeof parsed.generationHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(parsed.generationHash) ||
      !('revision' in parsed) ||
      typeof parsed.revision !== 'string' ||
      !('action' in parsed) ||
      typeof parsed.action !== 'string' ||
      !('phaseId' in parsed) ||
      (parsed.phaseId !== null && typeof parsed.phaseId !== 'string') ||
      !('snapshotId' in parsed) ||
      (parsed.snapshotId !== null && typeof parsed.snapshotId !== 'string') ||
      !('role' in parsed) ||
      (parsed.role !== null &&
        parsed.role !== 'implementation' &&
        parsed.role !== 'review' &&
        parsed.role !== 'delivery') ||
      (candidateHash !== undefined && (typeof candidateHash !== 'string' || !/^[a-f0-9]{64}$/u.test(candidateHash))) ||
      !('offset' in parsed) ||
      typeof parsed.offset !== 'number' ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < pageSize ||
      parsed.offset > 8192 ||
      parsed.offset % pageSize !== 0
    )
      return undefined;
    return {
      version: 1,
      runId: parsed.runId,
      generationHash: parsed.generationHash,
      revision: parsed.revision,
      action: parsed.action,
      phaseId: parsed.phaseId,
      snapshotId: parsed.snapshotId,
      role: parsed.role,
      ...(typeof candidateHash === 'string' ? {candidateHash} : {}),
      offset: parsed.offset,
    };
  } catch {
    return undefined;
  }
}

export function nativeTaskCursorMatches(
  cursor: NativeTaskCursor,
  view: NativeTaskView,
  candidateHash?: string,
): boolean {
  return (
    cursor.runId === view.runId &&
    cursor.generationHash === sha256HexSync(view.generation) &&
    cursor.revision === view.revision &&
    cursor.action === view.next.action &&
    cursor.phaseId === (view.next.phaseId ?? null) &&
    cursor.snapshotId === (view.next.snapshotId ?? null) &&
    cursor.role === (view.role ?? null) &&
    (cursor.candidateHash ?? null) === (candidateHash ?? null)
  );
}

const taskCursor = (
  view: Pick<NativeTaskView, 'runId' | 'generation' | 'revision' | 'next' | 'role'> &
    Pick<NativeTaskProjectionOptions, 'candidateHash'>,
  offset: number,
): string =>
  encodeCursor({
    version: 1,
    runId: view.runId,
    generationHash: sha256HexSync(view.generation),
    revision: view.revision,
    action: view.next.action,
    phaseId: view.next.phaseId ?? null,
    snapshotId: view.next.snapshotId ?? null,
    role: view.role ?? null,
    ...(view.candidateHash ? {candidateHash: view.candidateHash} : {}),
    offset,
  });

const pageSize = 16 as const;
const page = (items: readonly string[], offset: number) => items.slice(offset, offset + pageSize);

/** Project a bounded continuation page from canonical native state without returning its stored image. */
export function projectNativeTaskView(
  state: NativeWorkflowState,
  revision: string,
  options: NativeTaskProjectionOptions = {},
): NativeTaskView {
  const offset = Math.min(8192, Math.max(0, Math.floor(options.offset ?? 0)));
  const cycle = state.cycle?.state;
  if (options.planDrift) {
    return {
      status: 'blocked',
      runId: state.runId,
      generation: state.generation,
      revision,
      featureId: state.featureId,
      objective: 'Reconcile this cycle to its current approved plan.',
      next: {action: 'reconcile-plan', reason: options.planDrift},
      taskRef: nativeTaskCardRef(state, revision, 'reconcile-plan'),
      ...(options.role ? {role: options.role} : {}),
      page: {offset, limit: pageSize},
      counts: {scope: 0, acceptance: 0, acceptanceRefs: 0, snapshotFiles: 0, snapshotScopeFiles: 0},
      missingInputs: [
        'A fresh verified export of the current approved plan',
        'Cycle reconciliation against that export',
      ],
    };
  }
  if (!cycle)
    return {
      status: 'uninitialized',
      runId: state.runId,
      generation: state.generation,
      revision,
      featureId: state.featureId,
      objective: state.title ?? `Continue workflow ${state.featureId}`,
      next: {action: 'initialize-cycle', reason: 'This run has no initialized implementation cycle.'},
      taskRef: nativeTaskCardRef(state, revision, 'initialize-cycle'),
      ...(options.role ? {role: options.role} : {}),
      page: {offset, limit: pageSize},
      counts: {scope: 0, acceptance: 0, acceptanceRefs: 0, snapshotFiles: 0, snapshotScopeFiles: 0},
      missingInputs: ['A verified native cycle plan'],
    };

  const runtime = state.cycle;
  const canonicalNext = cycleNext(cycle);
  const localDelivery =
    cycle.plan.delivery === 'local'
      ? EffectOption.getOrUndefined(
          EffectArray.findFirst(
            cycle.plan.phases,
            candidate =>
              cycle.phases[candidate.id].status === 'validated' &&
              !cycle.phases[candidate.id].delivery &&
              nativeCycleParentsReady(cycle, candidate.id),
          ),
        )
      : undefined;
  const pendingSnapshot = EffectOption.getOrUndefined(
    EffectArray.findFirst(cycle.plan.phases, candidate => {
      if (localDelivery || canonicalNext.action !== 'implement' || canonicalNext.phaseId !== candidate.id) return false;
      const phaseSnapshots = EffectArray.filter(runtime.snapshots, entry => entry.snapshot.phaseId === candidate.id);
      const latest = phaseSnapshots.at(-1)?.snapshot;
      return Boolean(
        latest &&
        latest.phaseHash === cycle.phases[candidate.id].phaseHash &&
        nativeCycleSnapshotIsCurrentIteration(runtime, candidate.id, latest.snapshotId),
      );
    }),
  );
  const latestSnapshot = pendingSnapshot
    ? EffectArray.filter(runtime.snapshots, entry => entry.snapshot.phaseId === pendingSnapshot.id).at(-1)
    : undefined;
  const acceptedReview = latestSnapshot
    ? EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.reviews, item => item.snapshotId === latestSnapshot.snapshot.snapshotId),
      )
    : undefined;
  const predecessorId = latestSnapshot?.snapshot.previous ?? latestSnapshot?.snapshot.supersedes;
  const predecessor = predecessorId
    ? EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === predecessorId),
      )?.snapshot
    : undefined;
  const predecessorReview = predecessor
    ? EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.reviews, item => item.snapshotId === predecessor.snapshotId),
      )?.report
    : undefined;
  const blockingReview = Boolean(
    latestSnapshot &&
    acceptedReview &&
    validateNativeCycleReviewHistory(
      latestSnapshot.snapshot,
      acceptedReview.report,
      predecessor && predecessorReview ? {snapshot: predecessor, review: predecessorReview} : undefined,
    ).summary.blockingIssueCount,
  );
  const reviewWork =
    pendingSnapshot && latestSnapshot && !acceptedReview
      ? {phase: pendingSnapshot, snapshot: latestSnapshot}
      : undefined;
  const validationWork =
    pendingSnapshot && latestSnapshot && acceptedReview && !blockingReview && options.acceptedSnapshotCurrent !== false
      ? {phase: pendingSnapshot, snapshot: latestSnapshot}
      : undefined;
  const latestInvalidAttempt = reviewWork
    ? EffectArray.filter(
        runtime.attempts,
        attempt => attempt.snapshotId === reviewWork.snapshot.snapshot.snapshotId && attempt.status === 'invalid',
      ).at(-1)
    : undefined;
  const reviewBlocked = Boolean(
    reviewWork &&
    EffectArray.filter(
      runtime.attempts,
      attempt => attempt.snapshotId === reviewWork.snapshot.snapshot.snapshotId && attempt.status === 'invalid',
    ).length >= 2,
  );
  const reviewBudget = reviewWork ? nativeCyclePhaseReviewUsage(runtime, reviewWork.phase.id) : undefined;
  const reviewBudgetBlocked = reviewBudget?.exhausted ?? false;
  const next = reviewWork
    ? {
        action: reviewBudgetBlocked ? 'expand-review-budget' : reviewBlocked ? 'resolve-review-failure' : 'review',
        phaseId: reviewWork.phase.id,
        snapshotId: reviewWork.snapshot.snapshot.snapshotId,
        ...(latestInvalidAttempt ? {reason: latestInvalidAttempt.message} : {}),
      }
    : validationWork
      ? {action: 'validate', phaseId: validationWork.phase.id, snapshotId: validationWork.snapshot.snapshot.snapshotId}
      : localDelivery
        ? {action: 'deliver', phaseId: localDelivery.id}
        : canonicalNext;
  const phase = next.phaseId
    ? EffectOption.getOrUndefined(EffectArray.findFirst(cycle.plan.phases, item => item.id === next.phaseId))
    : undefined;
  const scope = phase?.allowedPaths ?? [];
  const acceptance = phase?.acceptanceCriteria ?? [];
  const acceptanceRefs = phase ? EffectArray.map(phase.acceptanceRefs, item => item.id) : [];
  const snapshot = (reviewWork ?? validationWork)?.snapshot.snapshot;
  const snapshotFiles = snapshot?.files ?? [];
  const snapshotScopeFiles = snapshot?.scopeFiles ?? [];
  const counts = {
    scope: scope.length,
    acceptance: acceptance.length,
    acceptanceRefs: acceptanceRefs.length,
    snapshotFiles: snapshotFiles.length,
    snapshotScopeFiles: snapshotScopeFiles.length,
    ...(cycle.supplementalPublications ? {supplementalPublications: cycle.supplementalPublications.length} : {}),
    ...(options.historicalWatchCount && options.historicalWatchCount > 0
      ? {historicalWatches: options.historicalWatchCount}
      : {}),
  };
  const nextOffset = offset + pageSize;
  const more = EffectArray.some(
    [
      counts.scope,
      counts.acceptance,
      counts.acceptanceRefs,
      counts.snapshotFiles,
      counts.snapshotScopeFiles,
      counts.historicalWatches ?? 0,
      counts.supplementalPublications ?? 0,
    ],
    count => count > nextOffset,
  );
  const missingInputs = reviewWork
    ? reviewBudgetBlocked
      ? [`Explicit human authorization to expand this phase review budget (current limit: ${reviewBudget?.limit})`]
      : reviewBlocked
        ? [
            'Submit one corrected review with this current taskRef, the same snapshotRef, and nonblank userAuthority.',
            'Preserve all prior findings and dispositions; record a complete independent source review.',
          ]
        : [
            `A complete independent review for snapshot ${reviewWork.snapshot.snapshot.snapshotId}`,
            'Correctness and simplicity review lanes with complete reports',
          ]
    : validationWork
      ? [`Passed check and acceptance evidence for snapshot ${validationWork.snapshot.snapshot.snapshotId}`]
      : localDelivery && next.action === 'deliver'
        ? ['The validation reference returned by workflow_task_record_validation']
        : phase
          ? [
              ...(scope.length ? [] : ['Implementation scope paths']),
              ...(acceptance.length ? [] : ['Acceptance criteria']),
            ]
          : next.action === 'complete'
            ? []
            : ['An eligible phase'];
  const view: NativeTaskView = {
    status:
      next.action === 'complete'
        ? 'complete'
        : next.action === 'blocked' || reviewBlocked || reviewBudgetBlocked
          ? 'blocked'
          : 'ready',
    runId: state.runId,
    generation: state.generation,
    revision,
    featureId: cycle.plan.featureId,
    objective: cycle.plan.objective,
    next: {
      action: next.action,
      ...(next.phaseId ? {phaseId: next.phaseId} : {}),
      ...('snapshotId' in next ? {snapshotId: next.snapshotId} : {}),
      ...('reason' in next ? {reason: next.reason} : {}),
    },
    ...(reviewWork
      ? {role: 'review'}
      : options.role
        ? {role: options.role}
        : next.action === 'deliver' || next.action === 'implement'
          ? {role: next.action === 'deliver' ? 'delivery' : 'implementation'}
          : {}),
    ...(phase
      ? {
          phase: {
            id: phase.id,
            title: phase.title,
            status: cycle.phases[phase.id].status,
            scope: page(scope, offset),
            acceptance: page(acceptance, offset),
            acceptanceRefs: page(acceptanceRefs, offset),
            ...(snapshot
              ? {
                  snapshot: {
                    snapshotId: snapshot.snapshotId,
                    head: snapshot.head,
                    tree: snapshot.tree,
                    baseTree: snapshot.baseTree,
                    scopeBase: snapshot.scopeBase,
                    declaredBaseHead: snapshot.declaredBaseHead,
                    files: page(snapshotFiles, offset),
                    scopeFiles: page(snapshotScopeFiles, offset),
                    requiredReviewLanes: ['correctness', 'simplicity'],
                    recordingMode: nativeCycleReviewRecordingMode(snapshot),
                    snapshotRef: (() => {
                      const baseline = runtime.baselines[snapshot.phaseId];
                      if (!baseline) throw new Error('An active review snapshot must have its admitted baseline.');
                      return encodeNativeTaskActionRef({
                        version: 1,
                        kind: 'snapshot',
                        runId: state.runId,
                        generationHash: sha256HexSync(state.generation),
                        phaseId: snapshot.phaseId,
                        phaseHash: snapshot.phaseHash,
                        baselineHead: baseline.head,
                        baselineTree: baseline.tree,
                        baselineRef: baseline.pinnedRef,
                        snapshotId: snapshot.snapshotId,
                        sourceHead: snapshot.head,
                        sourceTree: snapshot.tree,
                      });
                    })(),
                    ...(latestInvalidAttempt
                      ? {previousAttempt: {status: 'invalid' as const, message: latestInvalidAttempt.message}}
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    page: {
      offset,
      limit: pageSize,
      ...(more
        ? {
            nextOffset,
            nextCursor: taskCursor(
              {
                runId: state.runId,
                generation: state.generation,
                revision,
                next: {
                  action: next.action,
                  ...(next.phaseId ? {phaseId: next.phaseId} : {}),
                  ...('snapshotId' in next ? {snapshotId: next.snapshotId} : {}),
                },
                ...(reviewWork
                  ? {role: 'review' as const}
                  : options.role
                    ? {role: options.role}
                    : next.action === 'deliver' || next.action === 'implement'
                      ? {role: next.action === 'deliver' ? ('delivery' as const) : ('implementation' as const)}
                      : undefined),
                ...(options.candidateHash ? {candidateHash: options.candidateHash} : {}),
              },
              nextOffset,
            ),
          }
        : {}),
    },
    counts,
    missingInputs,
  };
  return {
    ...view,
    ...(cycle.supplementalPublications
      ? {
          supplementalPublications: EffectArray.map(
            cycle.supplementalPublications.slice(offset, offset + pageSize),
            publication => {
              const watchRecord = EffectArray.filter(publication.records, record => record.event.kind === 'watch').at(
                -1,
              );
              const watchEvent = watchRecord?.event;
              return {
                publicationId: publication.publicationId,
                phaseId: publication.initialization.phaseId,
                prUrl: publication.initialization.pr.url,
                publicationRef: nativeCycleSupplementalRef(publication),
                revision: nativeCycleSupplementalRevision(runtime),
                completed: EffectArray.some(publication.records, record => record.event.kind === 'completed'),
                ...(watchEvent?.kind === 'watch'
                  ? {
                      watch: {
                        consumerId: watchEvent.watch.consumerId,
                        stateDir: watchEvent.watch.stateDir,
                        state: watchEvent.watch.state,
                        recordRef: watchRecord!.operationId,
                      },
                    }
                  : {}),
              };
            },
          ),
        }
      : {}),
    taskRef: nativeTaskCardRef(
      state,
      revision,
      next.action,
      next.phaseId,
      'snapshotId' in next ? next.snapshotId : undefined,
    ),
  };
}
