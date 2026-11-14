import {
  Array as EffectArray,
  Effect,
  FileSystem,
  Option as EffectOption,
  Path,
  Predicate,
  Schema,
  String as EffectString,
} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {
  decodeNativeTaskCursor,
  nativeTaskCursorMatches,
  nativeTaskPageCursor,
  nativeTaskCardRef,
  projectNativeTaskView,
  encodeNativeTaskActionRef,
} from '@threadnote/workflow-automations/task';
import {nativeCyclePhaseHash} from '@threadnote/workflow-automations/cycle';
import {
  nativeCycleHasBasePlanTransition,
  nativeCycleInvalidTailBasis,
} from '@threadnote/workflow-automations/cycle-runtime';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readNativeWorkflowState} from './store.js';
import {nativeTaskWatchIdentityForConsumer} from './task_pr_watch.js';
import {readNativeTaskInspection, runWorkflowAutomation} from './index.js';
import {gitValue} from '../utils.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {readNativeCandidateWatchInventory, readNativeWatch} from './watch_store.js';
import {verifyNativeCycleBaseRequalification, nativeCycleIsAncestor} from './cycle_git.js';
import {
  resolveNativeTaskBaseRef,
  selectNativeTaskSameLabelIntegration,
  isCurrentTaskTargetForRequalification,
} from './task_action_helpers.js';
import {verifyNativeCycleSnapshotEvidence, verifyNativeCycleUnreviewedRebase} from './cycle_recovery.js';
import {currentNativeTaskRef} from './task_action_helpers.js';
import {decodeJournal} from './closeout_request_schema.js';
import {readNativeCloseoutJournal} from './closeout_store.js';

const requestSchema = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  role: Schema.optionalKey(Schema.Literals(['implementation', 'review', 'delivery'])),
  detail: Schema.optionalKey(Schema.Literals(['summary', 'packet'])),
  outputKey: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u))),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))),
  phaseId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
});

export const encodeNativeAuthoringTaskRef = (ref: {
  readonly version: 1;
  readonly kind: 'spec' | 'plan';
  readonly runId: string;
  readonly generationHash: string;
  readonly operationId: string;
  readonly documentHash: string;
  readonly stateRevision: string;
}) =>
  'authorref-v1.' +
  EffectString.replaceAll(
    '/',
    '_',
  )(EffectString.replaceAll('+', '-')(EffectString.replace(/=+$/u, '')(btoa(stableJson(ref)))));

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});

const historicalPhaseProof = (
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  phaseId: string,
) => {
  const runtime = stored.state.cycle;
  const cycle = runtime?.state;
  if (!runtime || !cycle || cycle.plan.delivery !== 'pr') return undefined;
  const phases = EffectArray.filter(cycle.plan.phases, phase => phase.id === phaseId);
  const phase = phases[0];
  const proof = cycle.phases[phaseId];
  const baseline = runtime.baselines[phaseId];
  const receipt = proof?.delivery;
  const validation = proof?.validation;
  if (
    phases.length !== 1 ||
    !phase ||
    !proof ||
    proof.status !== 'published' ||
    !proof.head ||
    !proof.tree ||
    !validation ||
    validation.status !== 'passed' ||
    validation.productState !== 'working' ||
    validation.snapshotTree !== proof.tree ||
    validation.reviewTree !== proof.tree ||
    (validation.head !== undefined && validation.head !== proof.head) ||
    !baseline ||
    !receipt ||
    receipt.delivery !== 'pr' ||
    receipt.phaseId !== phaseId ||
    receipt.phaseHash !== proof.phaseHash ||
    receipt.headSha !== proof.head ||
    receipt.validatedTree !== proof.tree ||
    !receipt.pr ||
    receipt.pr.state !== 'open' ||
    receipt.pr.headSha !== proof.head ||
    receipt.pr.branch !== phase.branch ||
    !receipt.watch ||
    receipt.watch.state !== 'active' ||
    receipt.watch.prUrl !== receipt.pr.url ||
    receipt.watch.headSha !== proof.head ||
    receipt.watch.consumerKind !== 'orchestrator' ||
    !receipt.watch.consumerId
  )
    return undefined;
  const snapshots = EffectArray.filter(
    runtime.snapshots,
    item =>
      item.snapshot.phaseId === phaseId &&
      item.snapshot.phaseHash === proof.phaseHash &&
      item.snapshot.tree === proof.tree &&
      item.snapshot.repo === baseline.repo &&
      item.snapshot.baseTree === baseline.tree,
  );
  if (snapshots.length !== 1 || !snapshots[0]) return undefined;
  const snapshot = snapshots[0].snapshot;
  const reviews = EffectArray.filter(
    runtime.reviews,
    item =>
      item.snapshotId === snapshot.snapshotId &&
      item.report.snapshotId === snapshot.snapshotId &&
      item.report.phaseHash === proof.phaseHash &&
      item.report.snapshotTree === proof.tree &&
      item.report.status === 'complete',
  );
  if (reviews.length !== 1) return undefined;
  const watchIdentity = nativeTaskWatchIdentityForConsumer(
    stored.state.runId,
    phaseId,
    receipt.pr.url,
    receipt.watch.consumerId,
  );
  if (!watchIdentity) return undefined;
  return {
    phaseId,
    title: phase.title,
    prUrl: receipt.pr.url,
    watchId: watchIdentity.watchId,
    phaseHash: proof.phaseHash,
    baseline,
    snapshot,
    validation,
    delivery: receipt,
    sourceHead: proof.head,
    sourceTree: proof.tree,
    consumerId: receipt.watch.consumerId,
  };
};

const discoverHistoricalWatches = (
  config: RuntimeConfig,
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  checkout: string,
) =>
  Effect.gen(function* () {
    const runtime = stored.state.cycle;
    if (!runtime || runtime.state.plan.delivery !== 'pr') return [];
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(config.agentContextHome);
    const expectedStateDir = path.join(home, 'workflow-automations', 'native-watch-v1');
    const candidates: {candidate: NonNullable<ReturnType<typeof historicalPhaseProof>>; watchRevision: string}[] = [];
    for (const phase of runtime.state.plan.phases) {
      const candidate = historicalPhaseProof(stored, phase.id);
      if (!candidate) continue;
      const branchHead = yield* gitValue(
        ['rev-parse', '--verify', '--end-of-options', `refs/heads/${phase.branch}^{commit}`],
        checkout,
      );
      const branchTree = yield* gitValue(
        ['rev-parse', '--verify', '--end-of-options', `refs/heads/${phase.branch}^{tree}`],
        checkout,
      );
      if (branchHead !== candidate.sourceHead || branchTree !== candidate.sourceTree) continue;
      const watch = yield* readNativeWatch(config, candidate.watchId);
      const consumer = watch?.envelope.state.consumer;
      const notification = watch?.envelope.notification;
      const activeOpenWatch =
        watch?.envelope.state.prState === 'open' && watch.envelope.collector?.status === 'running';
      const terminalMergedWatch =
        watch?.envelope.state.prState === 'merged' &&
        watch.envelope.collector?.status === 'terminal' &&
        watch.envelope.collector.reason === 'merged';
      if (
        !watch ||
        watch.envelope.state.pr !== candidate.prUrl ||
        (!activeOpenWatch && !terminalMergedWatch) ||
        watch.envelope.state.head !== candidate.sourceHead ||
        !consumer ||
        consumer.id !== candidate.consumerId ||
        !notification ||
        notification.consumerId !== consumer.id ||
        notification.wakeupId !== consumer.wakeupId
      )
        continue;
      if (candidate.delivery.watch?.stateDir !== expectedStateDir) continue;
      candidates.push({candidate, watchRevision: watch.revision});
    }
    return candidates;
  });

const historicalTaskRefs = (
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  candidate: NonNullable<ReturnType<typeof historicalPhaseProof>>,
) => {
  const generationHash = sha256HexSync(stored.state.generation);
  const reference = {
    version: 1 as const,
    runId: stored.state.runId,
    generationHash,
    phaseId: candidate.phaseId,
    phaseHash: candidate.phaseHash,
    baselineHead: candidate.baseline.head,
    baselineTree: candidate.baseline.tree,
    baselineRef: candidate.baseline.pinnedRef,
    snapshotId: candidate.snapshot.snapshotId,
    sourceHead: candidate.snapshot.head,
    sourceTree: candidate.snapshot.tree,
  };
  return {
    action: 'watch-pr' as const,
    phaseId: candidate.phaseId,
    prUrl: candidate.prUrl,
    consumerId: candidate.consumerId,
    validationRef: encodeNativeTaskActionRef({
      ...reference,
      kind: 'validation',
      payloadDigest: sha256HexSync(stableJson(candidate.validation)),
    }),
    deliveryRef: encodeNativeTaskActionRef({
      ...reference,
      kind: 'delivery',
      payloadDigest: sha256HexSync(stableJson(candidate.delivery)),
      delivery: candidate.delivery,
    }),
  };
};

const baseRequalificationRoute = (
  config: RuntimeConfig,
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  checkout: string,
  view: ReturnType<typeof projectNativeTaskView>,
) =>
  Effect.gen(function* () {
    const runtime = stored.state.cycle;
    const cycle = runtime?.state;
    const phaseId = view.next.phaseId;
    const blockedForReviewedBaseTransition =
      view.status === 'blocked' &&
      view.next.action === 'blocked' &&
      phaseId !== undefined &&
      view.next.phaseId === phaseId &&
      cycle?.phases[phaseId]?.status === 'stale';
    if (
      !runtime ||
      !cycle ||
      !phaseId ||
      (!(view.status === 'ready' && view.next.action === 'implement') && !blockedForReviewedBaseTransition)
    )
      return undefined;
    const phaseMatches = EffectArray.filter(cycle.plan.phases, phase => phase.id === phaseId);
    const phase = phaseMatches[0];
    const baseline = runtime.baselines[phaseId];
    if (!phase || phaseMatches.length !== 1 || !baseline) return undefined;
    const phaseSnapshots = EffectArray.filter(runtime.snapshots, entry => entry.snapshot.phaseId === phaseId);
    const prior = phaseSnapshots.at(-1)?.snapshot;
    if (
      !prior ||
      EffectArray.filter(phaseSnapshots, entry => entry.snapshot.snapshotId === prior.snapshotId).length !== 1
    )
      return undefined;
    const completedReviews = EffectArray.filter(
      runtime.reviews,
      entry =>
        entry.snapshotId === prior.snapshotId &&
        entry.report.snapshotId === prior.snapshotId &&
        entry.report.phaseHash === prior.phaseHash &&
        entry.report.snapshotTree === prior.tree &&
        entry.report.status === 'complete' &&
        entry.report.mode === 'full',
    );
    if (completedReviews.length !== 1) return undefined;
    const completedReviewDigest = sha256HexSync(stableJson(completedReviews[0].report));
    const acceptedAttempts = EffectArray.filter(
      runtime.attempts,
      attempt =>
        attempt.snapshotId === prior.snapshotId &&
        attempt.status === 'accepted' &&
        attempt.digest === completedReviewDigest,
    );
    if (acceptedAttempts.length !== 1) return undefined;
    const fromBranches = new Set<string>();
    for (const plan of runtime.plans) {
      const planPhase = EffectArray.findFirst(plan.phases, candidate => candidate.id === phaseId);
      if (
        planPhase._tag === 'Some' &&
        planPhase.value.baseBranch !== phase.baseBranch &&
        nativeCyclePhaseHash(plan, phaseId) === prior.phaseHash &&
        nativeCycleHasBasePlanTransition(
          runtime.plans,
          prior,
          cycle.phases[phaseId]?.phaseHash ?? '',
          planPhase.value.baseBranch,
          phase.baseBranch,
        )
      )
        fromBranches.add(planPhase.value.baseBranch);
    }
    if (fromBranches.size !== 1) return undefined;
    const fromBaseBranch = [...fromBranches][0];
    if (!fromBaseBranch) return undefined;
    const oldBaseResult = yield* verifyNativeCycleSnapshotEvidence(checkout, prior).pipe(Effect.result);
    const headResult = yield* gitValue(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], checkout).pipe(
      Effect.result,
    );
    const branchResult = yield* gitValue(['branch', '--show-current'], checkout).pipe(Effect.result);
    const newBaseResult = yield* resolveNativeTaskBaseRef(checkout, phase.baseBranch).pipe(Effect.result);
    if (
      oldBaseResult._tag === 'Failure' ||
      headResult._tag === 'Failure' ||
      branchResult._tag === 'Failure' ||
      newBaseResult._tag === 'Failure'
    )
      return undefined;
    if (headResult.success === undefined || branchResult.success === undefined || newBaseResult.success === undefined)
      return undefined;
    const priorBaseHead = prior.declaredBaseHead;
    const currentHead = EffectString.trim(headResult.success);
    const currentBranch = EffectString.trim(branchResult.success);
    const newBaseHead = newBaseResult.success.commit;
    if (
      priorBaseHead !== prior.declaredBaseHead ||
      currentBranch !== phase.branch ||
      currentHead === prior.head ||
      newBaseHead === prior.declaredBaseHead
    )
      return undefined;
    const witness = {
      preRebaseHead: prior.head,
      ontoHead: newBaseHead,
      rebasedHead: currentHead,
      fromBaseBranch,
    };
    const ancestry = yield* verifyNativeCycleBaseRequalification(
      checkout,
      prior.head,
      currentHead,
      newBaseHead,
      witness,
    ).pipe(Effect.result);
    if (ancestry._tag === 'Failure') return undefined;
    const latest = yield* readNativeWorkflowState(config, stored.state.runId);
    if (!latest || latest.revision !== stored.revision) return undefined;
    return {
      action: 'requalify-base' as const,
      phaseId,
      predecessorRef: encodeNativeTaskActionRef({
        version: 1,
        kind: 'snapshot',
        runId: stored.state.runId,
        generationHash: sha256HexSync(stored.state.generation),
        phaseId,
        phaseHash: prior.phaseHash,
        baselineHead: baseline.head,
        baselineTree: baseline.tree,
        baselineRef: baseline.pinnedRef,
        snapshotId: prior.snapshotId,
        sourceHead: prior.head,
        sourceTree: prior.tree,
      }),
      fromBaseBranch,
      toBaseBranch: phase.baseBranch,
    };
  });

const sameLabelIntegrationRoute = (
  config: RuntimeConfig,
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  checkout: string,
  view: ReturnType<typeof projectNativeTaskView>,
) =>
  Effect.gen(function* () {
    const phaseId = view.next.phaseId;
    if (!phaseId || !stored.state.cycle || !isCurrentTaskTargetForRequalification(view, phaseId)) return undefined;
    const selected = selectNativeTaskSameLabelIntegration(stored.state.cycle, phaseId);
    if (!selected) return undefined;
    const {phase, priorEntry, baseline} = selected;
    const prior = priorEntry.snapshot;
    const base = yield* resolveNativeTaskBaseRef(checkout, phase.baseBranch);
    const head = yield* gitValue(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], checkout);
    const branch = yield* gitValue(['branch', '--show-current'], checkout);
    if (
      !base ||
      !head ||
      branch !== phase.branch ||
      base.commit === prior.declaredBaseHead ||
      !(yield* nativeCycleIsAncestor(checkout, prior.head, head)) ||
      !(yield* nativeCycleIsAncestor(checkout, base.commit, head))
    )
      return undefined;
    const latest = yield* readNativeWorkflowState(config, stored.state.runId);
    if (!latest || latest.revision !== stored.revision) return undefined;
    return {
      action: 'integrate-same-label-base' as const,
      phaseId,
      baseBranch: phase.baseBranch,
      predecessorRef: encodeNativeTaskActionRef({
        version: 1,
        kind: 'snapshot',
        runId: stored.state.runId,
        generationHash: sha256HexSync(stored.state.generation),
        phaseId,
        phaseHash: prior.phaseHash,
        baselineHead: baseline.head,
        baselineTree: baseline.tree,
        baselineRef: baseline.pinnedRef,
        snapshotId: prior.snapshotId,
        sourceHead: prior.head,
        sourceTree: prior.tree,
      }),
    };
  });

const invalidTailRequalificationRoute = (
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  checkout: string,
  view: ReturnType<typeof projectNativeTaskView>,
) =>
  Effect.gen(function* () {
    const runtime = stored.state.cycle;
    const phaseId = view.next.phaseId;
    if (
      !runtime ||
      !phaseId ||
      !['review', 'resolve-review-failure', 'expand-review-budget'].includes(view.next.action)
    )
      return undefined;
    const selected = nativeCycleInvalidTailBasis(runtime, phaseId);
    const phase = EffectOption.getOrUndefined(
      EffectArray.findFirst(runtime.state.plan.phases, item => item.id === phaseId),
    );
    const baseline = runtime.baselines[phaseId];
    if (
      !selected ||
      !phase ||
      !baseline ||
      !['active', 'pending'].includes(runtime.state.phases[phaseId]?.status ?? '')
    )
      return undefined;
    const observed = yield* resolveNativeTaskBaseRef(checkout, phase.baseBranch).pipe(Effect.option);
    if (observed._tag === 'None' || !observed.value || observed.value.commit === selected.leaf.declaredBaseHead)
      return undefined;
    const liveBaseHead = observed.value.commit;
    return {
      action: 'requalify-invalid-tail' as const,
      phaseId,
      liveBaseHead,
      basisSnapshotId: selected.basis.snapshot.snapshotId,
      taskRef: nativeTaskCardRef(
        stored.state,
        stored.revision,
        'requalify-invalid-tail',
        phaseId,
        selected.leaf.snapshotId,
        sha256HexSync(stableJson([selected.leaf.snapshotId, selected.basis.snapshot.snapshotId, liveBaseHead])),
      ),
      predecessorRef: encodeNativeTaskActionRef({
        version: 1,
        kind: 'snapshot',
        runId: stored.state.runId,
        generationHash: sha256HexSync(stored.state.generation),
        stateRevision: stored.revision,
        phaseId,
        phaseHash: selected.leaf.phaseHash,
        snapshotId: selected.leaf.snapshotId,
        sourceHead: selected.leaf.head,
        sourceTree: selected.leaf.tree,
        baselineHead: baseline.head,
        baselineTree: baseline.tree,
        baselineRef: baseline.pinnedRef,
      }),
    };
  });

/** Read the canonical run, then use the guarded native inspection path before projecting a task. */
export const readNativeTaskView = (config: RuntimeConfig, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(requestSchema, {onExcessProperty: 'error'})(input).pipe(
      Effect.mapError(() => fail('invalid-request', 'Provide runId, an absolute callerCwd, and an optional role.')),
    );
    if (request.outputKey !== undefined && request.detail !== 'packet')
      return yield* fail('invalid-request', 'Select a closeout output key only with detail=packet.');
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    if (!path.isAbsolute(request.callerCwd))
      return yield* fail('invalid-request', 'callerCwd must be an absolute checkout path.');
    const callerCwd = yield* fs
      .realPath(request.callerCwd)
      .pipe(Effect.mapError(() => fail('workspace-not-found', 'callerCwd must resolve to an existing checkout.')));
    const reportedCheckout = yield* gitValue(['rev-parse', '--show-toplevel'], callerCwd);
    if (!reportedCheckout) return yield* fail('workspace-not-found', 'callerCwd must be inside a Git checkout.');
    const checkout = yield* fs
      .realPath(reportedCheckout)
      .pipe(
        Effect.mapError(() => fail('workspace-not-found', 'The Git checkout root must resolve to an existing path.')),
      );
    const stored = yield* readNativeWorkflowState(config, request.runId);
    if (!stored) return yield* fail('run-not-found', 'This native run does not exist.');
    const system = yield* SystemInfo;
    const inspected = yield* readNativeTaskInspection(
      config,
      stored.state.runId,
      stored.state.generation,
      request.detail ?? 'summary',
      request.outputKey,
    ).pipe(Effect.provideService(SystemInfo, {...system, currentDirectory: () => checkout}));
    if (!('revision' in inspected) || inspected.revision !== stored.revision || !('taskAuthoring' in inspected))
      return yield* fail('inspection-failed', 'The native run could not be inspected.');
    if (request.outputKey !== undefined) {
      const closeout = 'taskCloseout' in inspected ? inspected.taskCloseout : undefined;
      if (!closeout || closeout.status !== 'complete')
        return yield* fail('closeout-incomplete', 'A complete verified closeout is required to read an output body.');
      if (!EffectArray.some(closeout.outputs, output => output.key === request.outputKey))
        return yield* fail('closeout-output-not-found', 'The selected key is not a verified closeout output.');
    }
    const planDrift = 'planDrift' in inspected ? inspected.planDrift : undefined;
    const authoringResult = inspected.taskAuthoring;
    const authoringValue =
      authoringResult && 'currentPlan' in authoringResult && Predicate.isObject(authoringResult.currentPlan)
        ? authoringResult.currentPlan
        : undefined;
    const authoringRoot = authoringValue && Predicate.isObject(authoringValue.root) ? authoringValue.root : undefined;
    const authoringKind =
      authoringValue && (authoringValue.kind === 'spec' || authoringValue.kind === 'plan')
        ? authoringValue.kind
        : undefined;
    const authoringRootOperation =
      authoringRoot && authoringKind
        ? EffectOption.getOrUndefined(
            EffectArray.findFirst(
              [...stored.state.operations].reverse(),
              operation =>
                operation.status === 'verified' &&
                operation.intent.role === 'authoring-root' &&
                operation.intent.artifactKey === 'author-root-' + authoringKind &&
                operation.artifact?.uri === authoringRoot.uri &&
                operation.artifact.revision === authoringRoot.revision,
            ),
          )
        : undefined;
    const authoringRef =
      authoringValue && authoringKind && authoringRootOperation && typeof authoringValue.documentHash === 'string'
        ? encodeNativeAuthoringTaskRef({
            version: 1,
            kind: authoringKind,
            runId: stored.state.runId,
            generationHash: sha256HexSync(stored.state.generation),
            operationId: authoringRootOperation.intent.operationId,
            documentHash: authoringValue.documentHash,
            stateRevision: stored.revision,
          })
        : undefined;
    const authoring =
      authoringValue &&
      authoringRef &&
      Predicate.isObject(authoringValue.next) &&
      authoringValue.next.action === 'compact-confirm'
        ? {
            ...authoringValue,
            authoringRef,
            continuation: {
              tool: 'workflow_task_author',
              authoringRef,
              read: {command: 'read', detail: 'document'},
              save: {command: 'save'},
            },
          }
        : authoringValue;
    const afterRead = yield* readNativeWorkflowState(config, request.runId);
    if (afterRead?.revision !== stored.revision)
      return yield* fail('inspection-failed', 'The native run changed while reading its current authoring root.');
    const continueAuthoring = (view: ReturnType<typeof projectNativeTaskView>) => {
      const closeout =
        'taskCloseout' in inspected && Predicate.isObject(inspected.taskCloseout) ? inspected.taskCloseout : undefined;
      if (closeout?.status === 'complete') return {...view, closeout};
      if (!authoring) return view;
      const currentRoot = Predicate.isObject(authoring.root) ? authoring.root : undefined;
      if (authoring.status === 'admitted')
        return view.next.action === 'reconcile-plan' && currentRoot
          ? {
              ...view,
              authoring,
              taskRef: nativeTaskCardRef(
                stored.state,
                stored.revision,
                'reconcile-plan',
                undefined,
                undefined,
                sha256HexSync(
                  stableJson({
                    uri: currentRoot.uri,
                    revision: currentRoot.revision,
                    documentHash: authoring.documentHash,
                    intentHash: authoring.intentHash,
                  }),
                ),
              ),
            }
          : {...view, authoring};
      const reconcileReady = authoring.status === 'awaiting-admission';
      if (reconcileReady && !stored.state.cycle) return {...view, authoring};
      const authoringAction =
        Predicate.isObject(authoring.next) && typeof authoring.next.action === 'string'
          ? authoring.next.action
          : 'compact-confirm';
      const taskRef = reconcileReady
        ? nativeTaskCardRef(
            stored.state,
            stored.revision,
            'reconcile-plan',
            undefined,
            undefined,
            currentRoot
              ? sha256HexSync(
                  stableJson({
                    uri: currentRoot.uri,
                    revision: currentRoot.revision,
                    documentHash: authoring.documentHash,
                    intentHash: authoring.intentHash,
                  }),
                )
              : undefined,
          )
        : undefined;
      return {
        ...view,
        status: 'blocked' as const,
        ...(taskRef ? {taskRef} : {}),
        next: {action: reconcileReady ? 'reconcile-plan' : authoringAction},
        missingInputs: [
          ...view.missingInputs,
          ...(reconcileReady && view.next.action === 'reconcile-plan'
            ? []
            : [
                authoring.status === 'awaiting-user-confirmation'
                  ? 'An actual user response and explicit approve/reject/defer decision for the current intent hash'
                  : authoring.status === 'awaiting-review'
                    ? 'An accepted review of the exact current document'
                    : authoring.status === 'awaiting-readiness'
                      ? 'A ready current plan with its authoring blockers resolved'
                      : 'Admission of the ready current plan',
              ]),
        ],
        authoring,
        ...(stored.state.cycle ? {cycleTask: view} : {}),
      };
    };
    const authoringBlocked = authoring !== undefined && authoring.status !== 'admitted';
    const canProjectHistoricalWatches = planDrift === undefined && !authoringBlocked;
    const historicalCandidates = canProjectHistoricalWatches
      ? yield* discoverHistoricalWatches(config, stored, checkout)
      : [];
    const historicalCandidateHash = canProjectHistoricalWatches
      ? sha256HexSync(
          stableJson(
            EffectArray.map(historicalCandidates, ({candidate}) => ({
              phaseId: candidate.phaseId,
              phaseHash: candidate.phaseHash,
              prUrl: candidate.prUrl,
              watchId: candidate.watchId,
              sourceHead: candidate.sourceHead,
              sourceTree: candidate.sourceTree,
              consumerId: candidate.consumerId,
              snapshotId: candidate.snapshot.snapshotId,
              validationDigest: sha256HexSync(stableJson(candidate.validation)),
              deliveryDigest: sha256HexSync(stableJson(candidate.delivery)),
            })),
          ),
        )
      : undefined;
    const candidateInventory = yield* readNativeCandidateWatchInventory(config, stored, checkout);
    const candidateWatches = EffectArray.map(candidateInventory.rows, row => ({...row, diagnosticOnly: true as const}));
    const discoveryHash = sha256HexSync(stableJson([historicalCandidateHash ?? null, candidateInventory.digest]));
    const uncheckedView = projectNativeTaskView(stored.state, stored.revision, {
      ...(request.role === undefined ? {} : {role: request.role}),
      ...(planDrift === undefined ? {} : {planDrift}),
    });
    let acceptedSnapshotCurrent = true;
    if (!authoringBlocked && uncheckedView.next.action === 'validate' && uncheckedView.next.snapshotId) {
      const head = yield* gitValue(['rev-parse', 'HEAD'], checkout);
      if (!head) return yield* fail('source-unavailable', 'Could not read the current source head.');
      const checked = yield* runWorkflowAutomation(config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'cycle',
        command: 'check-phase',
        runId: stored.state.runId,
        generation: stored.state.generation,
        phaseId: uncheckedView.next.phaseId,
        snapshotId: uncheckedView.next.snapshotId,
        acceptedHead: head,
      }).pipe(Effect.provideService(SystemInfo, {...system, currentDirectory: () => checkout}), Effect.result);
      if (checked._tag === 'Failure') {
        if (
          Schema.is(WorkflowAutomationError)(checked.failure) &&
          (checked.failure.code === 'review-stale' || checked.failure.code === 'source-drift')
        )
          acceptedSnapshotCurrent = false;
        else return yield* checked.failure;
      }
    }
    const projectionOptions = (offset: number) => ({
      ...(request.role === undefined ? {} : {role: request.role}),
      ...(planDrift === undefined ? {} : {planDrift}),
      ...(acceptedSnapshotCurrent ? {} : {acceptedSnapshotCurrent: false}),
      ...(historicalCandidates.length > 0 ? {historicalWatchCount: historicalCandidates.length} : {}),
      ...(candidateWatches.length > 0 ? {candidateWatches} : {}),
      candidateHash: discoveryHash,
      ...(offset === 0 ? {} : {offset}),
    });
    const projectAt = (offset: number) => {
      const view = continueAuthoring(projectNativeTaskView(stored.state, stored.revision, projectionOptions(offset)));
      return view.page.nextOffset === undefined
        ? view
        : {
            ...view,
            page: {
              ...view.page,
              nextCursor: nativeTaskPageCursor({...view, candidateHash: discoveryHash}, view.page.nextOffset),
            },
          };
    };
    const initialView = projectAt(0);
    let selectedView = initialView;
    if (request.cursor !== undefined) {
      const cursor = decodeNativeTaskCursor(request.cursor);
      if (!cursor || !nativeTaskCursorMatches(cursor, initialView, discoveryHash))
        return yield* fail(
          'stale-cursor',
          'The native task or retained watch inventory changed. Restart with workflow_task_view to get a current task card.',
        );
      selectedView = projectAt(cursor.offset);
    }
    const pageWatches = EffectArray.map(
      historicalCandidates.slice(selectedView.page.offset, selectedView.page.offset + selectedView.page.limit),
      item => ({phaseId: item.candidate.phaseId, title: item.candidate.title, prUrl: item.candidate.prUrl}),
    );
    const result = pageWatches.length > 0 ? {...selectedView, historicalWatches: pageWatches} : selectedView;
    const withBaseRequalification = (view: ReturnType<typeof projectNativeTaskView>) =>
      Effect.gen(function* () {
        const sameLabel = yield* sameLabelIntegrationRoute(config, stored, checkout, view);
        const route = yield* baseRequalificationRoute(config, stored, checkout, view);
        const invalid = yield* invalidTailRequalificationRoute(stored, checkout, view);
        const runtime = stored.state.cycle;
        const snapshotRef = view.phase?.snapshot?.snapshotRef;
        const prior = runtime
          ? EffectOption.getOrUndefined(
              EffectArray.findFirst(runtime.snapshots, entry => entry.snapshot.snapshotId === view.next.snapshotId),
            )?.snapshot
          : undefined;
        const phase = runtime
          ? EffectOption.getOrUndefined(
              EffectArray.findFirst(runtime.state.plan.phases, candidate => candidate.id === view.next.phaseId),
            )
          : undefined;
        const recovery =
          runtime && prior && phase && snapshotRef && view.status === 'ready' && view.next.action === 'review'
            ? yield* verifyNativeCycleUnreviewedRebase(checkout, prior, runtime, phase).pipe(Effect.result)
            : undefined;
        return {
          ...view,
          ...(sameLabel ? {sameLabelBaseIntegration: sameLabel} : {}),
          ...(route ? {baseRequalification: route} : {}),
          ...(invalid ? {invalidTailRequalification: invalid} : {}),
          ...(recovery?._tag === 'Success'
            ? {
                unreviewedRebaseRecovery: {
                  action: 'recover-unreviewed-rebase' as const,
                  snapshotRef: snapshotRef!,
                  userAuthorityRequired: true as const,
                },
              }
            : {}),
        };
      });
    if (request.phaseId === undefined) return yield* withBaseRequalification(result);
    const runtime = stored.state.cycle;
    const requestedPhases = EffectArray.filter(runtime?.state.plan.phases ?? [], phase => phase.id === request.phaseId);
    if (requestedPhases.length === 0)
      return yield* fail('historical-phase-not-found', 'The requested phase is not in this runs canonical plan.');
    if (requestedPhases.length !== 1)
      return yield* fail(
        'historical-phase-ambiguous',
        'The requested phase does not have one unique canonical plan entry.',
      );
    if (!EffectArray.some(pageWatches, item => item.phaseId === request.phaseId))
      return yield* fail('historical-phase-not-listed', 'Select a historical phase from the current task-view page.');
    if (!canProjectHistoricalWatches)
      return yield* fail(
        'historical-watch-not-eligible',
        'Resolve the current plan and authoring gate before resuming a historical PR watch.',
      );
    const selectedCandidate = EffectArray.findFirst(
      historicalCandidates,
      item => item.candidate.phaseId === request.phaseId,
    );
    if (selectedCandidate._tag === 'None')
      return yield* fail(
        'historical-watch-not-eligible',
        'The phase has no exact published PR and eligible open or merged watch with matching canonical source and consumer evidence.',
      );
    const latest = yield* readNativeWorkflowState(config, request.runId);
    if (!latest || latest.revision !== stored.revision)
      return yield* fail('inspection-failed', 'The native run changed while reading its historical watch route.');
    const currentWatch = yield* readNativeWatch(config, selectedCandidate.value.candidate.watchId);
    if (!currentWatch || currentWatch.revision !== selectedCandidate.value.watchRevision)
      return yield* fail('inspection-failed', 'The historical watch changed while reading its typed continuation.');
    const phase = requestedPhases[0];
    const branchHead = yield* gitValue(
      ['rev-parse', '--verify', '--end-of-options', `refs/heads/${phase.branch}^{commit}`],
      checkout,
    );
    const branchTree = yield* gitValue(
      ['rev-parse', '--verify', '--end-of-options', `refs/heads/${phase.branch}^{tree}`],
      checkout,
    );
    if (
      branchHead !== selectedCandidate.value.candidate.sourceHead ||
      branchTree !== selectedCandidate.value.candidate.sourceTree
    )
      return yield* fail(
        'historical-watch-not-eligible',
        'The published phase branch no longer matches its reviewed source.',
      );
    return yield* withBaseRequalification({
      ...result,
      historicalWatch: historicalTaskRefs(stored, selectedCandidate.value.candidate),
    });
  });

/** Resolve an explicit reopen target against the current card and terminal closeout state. */
export const verifyNativeTaskReopen = (
  config: RuntimeConfig,
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  checkout: string,
  request: {readonly runId: string; readonly taskRef: string; readonly phaseId: string},
) =>
  Effect.gen(function* () {
    const view = yield* readNativeTaskView(config, {runId: request.runId, callerCwd: checkout});
    if (
      ![
        'implement',
        'review',
        'validate',
        'deliver',
        'complete',
        'blocked',
        'expand-review-budget',
        'resolve-review-failure',
      ].includes(view.next.action)
    )
      return yield* fail('task-not-ready', 'Resolve the current plan or authoring gate before reopening a phase.');
    if (!currentNativeTaskRef(request.taskRef, stored.state, stored.revision, request.runId, view.next.action, view))
      return yield* fail('stale-task-ref', 'Read the current task card before reopening a phase.');
    const phases = stored.state.cycle?.state.plan.phases ?? [];
    const selected = EffectArray.filter(phases, phase => phase.id === request.phaseId);
    const phase = selected.length === 1 ? selected[0] : undefined;
    const proof = stored.state.cycle?.state.phases[request.phaseId];
    if (!phase || !proof || !['validated', 'published'].includes(proof.status))
      return yield* fail('phase-not-reopenable', 'Select one current validated or published phase.');
    const closeout = yield* readNativeCloseoutJournal(config, request.runId, decodeJournal);
    if (closeout)
      return yield* fail(
        'closeout-in-progress',
        'The semantic closeout has started; its recorded proof cannot be reopened.',
      );
    const branch = yield* gitValue(['branch', '--show-current'], checkout);
    if (branch !== phase.branch)
      return yield* fail('wrong-branch', 'Reopen the phase from its bound implementation branch.');
    return phase.id;
  });
