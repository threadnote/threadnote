import {Array as EffectArray, Effect, FileSystem, Path, Predicate, Schema, String as EffectString} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {
  decodeNativeTaskCursor,
  nativeTaskCursorMatches,
  nativeTaskCardRef,
  projectNativeTaskView,
  encodeNativeTaskActionRef,
} from '@threadnote/workflow-automations/task';
import {nativeCyclePhaseHash} from '@threadnote/workflow-automations/cycle';
import {nativeCycleHasBasePlanTransition} from '@threadnote/workflow-automations/cycle-runtime';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readNativeWorkflowState} from './store.js';
import {readNativeTaskInspection} from './index.js';
import {gitValue} from '../utils.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {readNativeWatch} from './watch_store.js';
import {verifyNativeCycleBaseRequalification} from './cycle_git.js';

const requestSchema = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  role: Schema.optionalKey(Schema.Literals(['implementation', 'review', 'delivery'])),
  detail: Schema.optionalKey(Schema.Literals(['summary', 'packet'])),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))),
  phaseId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
});

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
      item.snapshot.head === proof.head &&
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
  return {
    phaseId,
    title: phase.title,
    prUrl: receipt.pr.url,
    watchId: `pr-${EffectString.slice(0, 48)(sha256HexSync(`${stored.state.runId}\n${phaseId}`))}`,
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
    const acceptedAttempts = EffectArray.filter(
      runtime.attempts,
      attempt =>
        attempt.snapshotId === prior.snapshotId &&
        attempt.status === 'accepted' &&
        attempt.digest === sha256HexSync(stableJson(completedReviews[0]?.report)),
    );
    if (completedReviews.length !== 1 || acceptedAttempts.length !== 1) return undefined;
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
    const oldBaseResult = yield* gitValue(
      ['rev-parse', '--verify', '--end-of-options', `refs/heads/${fromBaseBranch}^{commit}`],
      checkout,
    ).pipe(Effect.result);
    const headResult = yield* gitValue(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], checkout).pipe(
      Effect.result,
    );
    const branchResult = yield* gitValue(['branch', '--show-current'], checkout).pipe(Effect.result);
    const newBaseResult = yield* gitValue(
      ['rev-parse', '--verify', '--end-of-options', `refs/heads/${phase.baseBranch}^{commit}`],
      checkout,
    ).pipe(Effect.result);
    if (
      oldBaseResult._tag === 'Failure' ||
      headResult._tag === 'Failure' ||
      branchResult._tag === 'Failure' ||
      newBaseResult._tag === 'Failure'
    )
      return undefined;
    if (
      oldBaseResult.success === undefined ||
      headResult.success === undefined ||
      branchResult.success === undefined ||
      newBaseResult.success === undefined
    )
      return undefined;
    const priorBaseHead = EffectString.trim(oldBaseResult.success);
    const currentHead = EffectString.trim(headResult.success);
    const currentBranch = EffectString.trim(branchResult.success);
    const newBaseHead = EffectString.trim(newBaseResult.success);
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

/** Read the canonical run, then use the guarded native inspection path before projecting a task. */
export const readNativeTaskView = (config: RuntimeConfig, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(requestSchema, {onExcessProperty: 'error'})(input).pipe(
      Effect.mapError(() => fail('invalid-request', 'Provide runId, an absolute callerCwd, and an optional role.')),
    );
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    if (!path.isAbsolute(request.callerCwd))
      return yield* fail('invalid-request', 'callerCwd must be an absolute checkout path.');
    const callerCwd = yield* fs
      .realPath(request.callerCwd)
      .pipe(Effect.mapError(() => fail('workspace-not-found', 'callerCwd must resolve to an existing checkout.')));
    const checkout = yield* gitValue(['rev-parse', '--show-toplevel'], callerCwd);
    if (!checkout) return yield* fail('workspace-not-found', 'callerCwd must be inside a Git checkout.');
    const stored = yield* readNativeWorkflowState(config, request.runId);
    if (!stored) return yield* fail('run-not-found', 'This native run does not exist.');
    const system = yield* SystemInfo;
    const inspected = yield* readNativeTaskInspection(
      config,
      stored.state.runId,
      stored.state.generation,
      request.detail ?? 'summary',
    ).pipe(Effect.provideService(SystemInfo, {...system, currentDirectory: () => checkout}));
    if (!('revision' in inspected) || inspected.revision !== stored.revision || !('taskAuthoring' in inspected))
      return yield* fail('inspection-failed', 'The native run could not be inspected.');
    const planDrift = 'planDrift' in inspected ? inspected.planDrift : undefined;
    const authoringResult = inspected.taskAuthoring;
    const authoring =
      authoringResult && 'currentPlan' in authoringResult && Predicate.isObject(authoringResult.currentPlan)
        ? authoringResult.currentPlan
        : undefined;
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
        next: {action: reconcileReady ? 'reconcile-plan' : 'compact-confirm'},
        missingInputs: [
          ...view.missingInputs,
          authoring.status === 'awaiting-user-confirmation'
            ? 'An actual user response and explicit approve/reject/defer decision for the current intent hash'
            : authoring.status === 'awaiting-review'
              ? 'An accepted review of the exact current document'
              : 'Admission of the confirmed current plan',
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
    const projectionOptions = (offset: number) => ({
      ...(request.role === undefined ? {} : {role: request.role}),
      ...(planDrift === undefined ? {} : {planDrift}),
      ...(historicalCandidates.length > 0 ? {historicalWatchCount: historicalCandidates.length} : {}),
      ...(historicalCandidateHash ? {candidateHash: historicalCandidateHash} : {}),
      ...(offset === 0 ? {} : {offset}),
    });
    const projectAt = (offset: number) =>
      continueAuthoring(projectNativeTaskView(stored.state, stored.revision, projectionOptions(offset)));
    const initialView = projectAt(0);
    let selectedView = initialView;
    if (request.cursor !== undefined) {
      const cursor = decodeNativeTaskCursor(request.cursor);
      if (!cursor || !nativeTaskCursorMatches(cursor, initialView, historicalCandidateHash))
        return yield* fail(
          'stale-cursor',
          'The native task or eligible historical-watch set changed. Restart with workflow_task_view to get a current task card.',
        );
      selectedView = projectAt(cursor.offset);
    }
    const pageWatches = EffectArray.map(
      historicalCandidates.slice(selectedView.page.offset, selectedView.page.offset + selectedView.page.limit),
      item => ({phaseId: item.candidate.phaseId, title: item.candidate.title, prUrl: item.candidate.prUrl}),
    );
    const result = pageWatches.length > 0 ? {...selectedView, historicalWatches: pageWatches} : selectedView;
    const withBaseRequalification = (view: ReturnType<typeof projectNativeTaskView>) =>
      baseRequalificationRoute(config, stored, checkout, view).pipe(
        Effect.map(route => (route ? {...view, baseRequalification: route} : view)),
      );
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
        'The phase has no exact published PR and active incomplete watch with matching canonical source and consumer evidence.',
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
