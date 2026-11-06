import {SystemInfo} from '@threadnote/platform/system';
import {
  decodeNativeAuthoringDocument,
  NativeCompactIntentSchema,
  NativeCompactSourceSnapshotSchema,
  nativeSpecIntentDigest,
  projectNativeCompactIntent,
  type NativeCompactIntent,
} from '@threadnote/workflow-automations/authoring';
import {NativeCloseoutProposalSchema} from '@threadnote/workflow-automations/closeout';
import {
  NativeCyclePublicationAuthoritySchema,
  NativeCycleValidationSchema,
} from '@threadnote/workflow-automations/cycle';
import {NativeCyclePacketOptionsSchema} from '@threadnote/workflow-automations/cycle-packet';
import {NativeCycleReviewSchema} from '@threadnote/workflow-automations/cycle-review';
import {nativeCyclePhaseReviewUsage} from '@threadnote/workflow-automations/cycle-runtime';
import {workflowTitleSlug} from '@threadnote/workflow-automations/naming';
import {
  decodeNativeTaskActionRef,
  decodeNativeTaskStartReference,
  encodeNativeTaskActionRef,
  nativeTaskStartReferenceIsCurrent,
  nativeTaskStartRunId,
  NativeTaskAnchorSchema,
  NativeTaskStartRequestSchema,
  nativeTaskSnapshotId,
} from '@threadnote/workflow-automations/task';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  Effect,
  Array as EffectArray,
  Option as EffectOption,
  pipe as EffectPipe,
  FileSystem,
  Path,
  Predicate,
  Schema,
} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {statusDevSkills} from '../dev_skills/index.js';
import {gitValue} from '../utils.js';
import {inspectWorkflowJournal, withWorkflowLock} from '../workflow_memory/journal.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {resolveWorkflowBinding} from '../workflow_memory/profile.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {inspectNativeSourcePaths} from './authoring.js';
import {makeWorkflowGitAdapter} from './cycle_git.js';
import {makeWorkflowGraphAdapter} from './graph.js';
import {runCompactOriginAuthoringSave, runWorkflowAutomation} from './index.js';
import {nativeWorkflowError} from './memory.js';
import {readNativeWorkflowState} from './store.js';
import {readNativeTaskView} from './task.js';
import {inspectOldBindingOwners} from './task_binding_transition.js';
import {nativeWatchWakeupSchema} from './watch_notification_state.js';
import {
  cycleRequest,
  fail,
  hasApprovedBasePlanTransition,
  hasExactAcceptedFullReview,
  inCheckout,
  isCurrentTaskTargetForRequalification,
  requalificationSnapshotId,
  unwrapCycle,
  verifyRequalificationWitness,
} from './task_action_helpers.js';
import {runNativeTaskFinish} from './task_closeout_action.js';
import {runNativeTaskCommitDelivery, runNativeTaskPrDelivery, runNativeTaskPrWatch} from './task_delivery_actions.js';
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const packetInputSchema = Schema.Struct({
  capacity: NativeCyclePacketOptionsSchema.fields.capacity,
  anchors: Schema.Array(NativeTaskAnchorSchema).check(Schema.isBetweenLength(1, 128)),
  ownership: NativeCyclePacketOptionsSchema.fields.ownership,
  checks: NativeCyclePacketOptionsSchema.fields.checks,
  budgetBytes: NativeCyclePacketOptionsSchema.fields.budgetBytes,
  detailRefs: NativeCyclePacketOptionsSchema.fields.detailRefs,
});
const reviewInputSchema = Schema.Struct({
  mode: NativeCycleReviewSchema.fields.mode,
  selected: NativeCycleReviewSchema.fields.selected,
  lanes: NativeCycleReviewSchema.fields.lanes,
  findings: NativeCycleReviewSchema.fields.findings,
});
const validationInputSchema = Schema.Struct({
  checks: NativeCycleValidationSchema.fields.checks,
  acceptance: NativeCycleValidationSchema.fields.acceptance,
});
const compactReviewSchema = Schema.Struct({
  documentHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  outcome: Schema.Literals(['accepted', 'changes-requested']),
  blockingIssueCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const prDeliverySchema = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  headSha: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)),
  branch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  baseBranch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  state: Schema.Literals(['open', 'merged']),
});
export const NativeTaskPrDeliveryFieldsSchema = Schema.Struct({
  commitEvidence: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  pr: prDeliverySchema,
  publication: NativeCyclePublicationAuthoritySchema,
});
export type NativeTaskPrDeliveryFields = typeof NativeTaskPrDeliveryFieldsSchema.Type;
export const NativeTaskCommitDeliveryFieldsSchema = Schema.Struct({
  commitEvidence: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
});
export type NativeTaskCommitDeliveryFields = typeof NativeTaskCommitDeliveryFieldsSchema.Type;
export const NativeTaskPrWatchFieldsSchema = Schema.Struct({
  operation: Schema.Literals([
    'start',
    'inspect',
    'relay',
    'disposition',
    'ack',
    'work',
    'work-disposition',
    'stop',
    'complete',
  ]),
  phaseId: Schema.optionalKey(id),
  wakeup: Schema.optionalKey(nativeWatchWakeupSchema),
  takeover: Schema.optionalKey(Schema.Boolean),
  recoverWakeup: Schema.optionalKey(Schema.Boolean),
  noticeRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  watchDeliveryRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  dispositions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        eventRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
        status: Schema.Literals(['open', 'blocked', 'resolved', 'ignored']),
        reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
        evidence: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
      }),
    ).check(Schema.isMaxLength(32)),
  ),
});
const closeoutProposalFields = {...NativeCloseoutProposalSchema.fields};
delete (closeoutProposalFields as Partial<typeof closeoutProposalFields>).watchWork;
export const NativeTaskCloseoutProposalSchema = Schema.Struct(closeoutProposalFields);
const requestSchema = Schema.Union([
  Schema.Struct({
    command: Schema.Literal('compact-start'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    intent: NativeCompactIntentSchema,
  }),
  Schema.Struct({
    command: Schema.Literal('compact-expand'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    document: Schema.Unknown,
  }),
  Schema.Struct({
    command: Schema.Literal('compact-confirm'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    presentedIntentHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
    userResponse: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
    userDecision: Schema.optionalKey(Schema.Literals(['approve', 'reject', 'defer'])),
    baseBranch: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
    reconcileReason: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
    bindings: Schema.optionalKey(Schema.Record(id, Schema.Struct({branch: Schema.String, baseBranch: Schema.String}))),
    review: Schema.optionalKey(compactReviewSchema),
  }),
  Schema.Struct({
    command: Schema.Literal('begin'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    taskRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    command: Schema.Literal('resume'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    taskRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    command: Schema.Literal('reconcile'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    taskRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    bindings: Schema.optionalKey(
      Schema.Record(
        id,
        Schema.Struct({
          branch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
          baseBranch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
        }),
      ),
    ),
  }),
  Schema.Struct({
    command: Schema.Literal('extend-review-budget'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    taskRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    additionalReviews: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 1, maximum: 251})),
    reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    userAuthority: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    command: Schema.Literal('work'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    packet: packetInputSchema,
  }),
  Schema.Struct({
    command: Schema.Literal('record-snapshot'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    workRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    reason: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  }),
  Schema.Struct({
    command: Schema.Literal('supersede-unreviewed-snapshot'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    snapshotRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    command: Schema.Literal('requalify-base-snapshot'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    snapshotRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    userAuthority: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    command: Schema.Literal('record-review'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    snapshotRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    report: reviewInputSchema,
  }),
  Schema.Struct({
    command: Schema.Literal('record-validation'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    snapshotRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    validation: validationInputSchema,
  }),
  Schema.Struct({
    command: Schema.Literal('deliver-local'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    validationRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    command: Schema.Literal('deliver-commit'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    validationRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    ...NativeTaskCommitDeliveryFieldsSchema.fields,
  }),
  Schema.Struct({
    command: Schema.Literal('deliver-pr'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    validationRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    ...NativeTaskPrDeliveryFieldsSchema.fields,
  }),
  Schema.Struct({
    command: Schema.Literal('watch-pr'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    validationRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
    deliveryRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192))),
    ...NativeTaskPrWatchFieldsSchema.fields,
  }),
  Schema.Struct({
    command: Schema.Literal('finish'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    proposal: Schema.optionalKey(NativeTaskCloseoutProposalSchema),
    prepareRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
    finishRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
    resume: Schema.optionalKey(Schema.Boolean),
  }),
]);

export type NativeTaskActionRequest = typeof requestSchema.Type;
const compactIntentMatchesDocument = (intent: NativeCompactIntent, value: unknown): boolean => {
  if (!Predicate.isObject(value) || value.kind !== 'plan' || !Predicate.isObject(value.compactOrigin)) return false;
  const phases = value.phases;
  const current = value.current;
  const target = value.target;
  const requirements = value.requirements;
  if (
    !EffectArray.isArray(phases) ||
    phases.length !== 1 ||
    !Predicate.isObject(phases[0]) ||
    !Predicate.isObject(current) ||
    !Predicate.isObject(target) ||
    !EffectArray.isArray(requirements) ||
    requirements.length !== 1 ||
    !Predicate.isObject(requirements[0])
  )
    return false;
  const phase = phases[0];
  const acceptance = phase.acceptance;
  return (
    value.title === intent.title &&
    current.summary === intent.currentBehavior &&
    target.summary === intent.desiredChange &&
    requirements[0].behavior === intent.desiredChange &&
    EffectArray.isArray(phase.affectedPaths) &&
    stableJson(phase.affectedPaths) === stableJson(intent.affectedPaths) &&
    EffectArray.isArray(acceptance) &&
    acceptance.length === 1 &&
    Predicate.isObject(acceptance[0]) &&
    acceptance[0].criterion === intent.acceptanceCriterion &&
    acceptance[0].verification === intent.verification &&
    Predicate.isObject(value.review) &&
    value.review.required === intent.review.required &&
    value.review.reason === intent.review.reason &&
    value.compactOrigin.eligibilityRationale === intent.eligibilityRationale &&
    intent.eligibility.status === 'eligible'
  );
};

/** The installed selector is checked for start and resume, never treated as actor/publication authority. */
export const readNativeTaskInstalledTarget = (
  config: RuntimeConfig,
  installationTarget: string | undefined,
  checkout: string,
  allowedProfiles: readonly ('desktop' | 'codex-cloud-personal' | 'cursor-cloud-personal')[] = ['desktop'],
) =>
  Effect.gen(function* () {
    if (!installationTarget)
      return yield* fail(
        'needs-resources',
        'Select an installed Threadnote skill target. It must have the current verified workflow bundle before a task can start or resume.',
      );
    const installed = yield* inCheckout(
      statusDevSkills(config, {agent: installationTarget}).pipe(
        Effect.mapError(() =>
          fail('needs-resources', 'The selected skill target could not verify an installed workflow bundle.'),
        ),
      ),
      checkout,
    );
    if (installed.targets.length !== 1)
      return yield* fail('needs-selection', 'Select exactly one installed Threadnote skill target for this task.');
    const target = installed.targets[0];
    if (
      !target.enrolled ||
      !target.enabled ||
      target.installationState !== 'current' ||
      !allowedProfiles.includes(target.target.profile) ||
      target.installedDigest !== installed.bundle.digest ||
      target.installed?.digest !== installed.bundle.digest
    )
      return yield* fail(
        'needs-resources',
        'The selected target does not have the current verified Threadnote workflow generation enabled. Update or repair that installation, then retry.',
      );
    return {...target, installedDigest: installed.bundle.digest};
  });

export const runNativeTaskStart = (config: RuntimeConfig, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(NativeTaskStartRequestSchema, {onExcessProperty: 'error'})(
      input,
    ).pipe(
      Effect.mapError(() =>
        fail(
          'invalid-request',
          'Provide a feature name, absolute checkout path, bounded compact intent, and an optional installed target or task reference.',
        ),
      ),
    );
    const taskStartReference = request.taskRef ? decodeNativeTaskStartReference(request.taskRef) : undefined;
    if (request.taskRef && !taskStartReference)
      return yield* fail('invalid-task-ref', 'Provide a canonical run ID or current task-view reference.');
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    if (!path.isAbsolute(request.callerCwd))
      return yield* fail('invalid-request', 'callerCwd must be an absolute checkout path.');
    const cwd = yield* fs
      .realPath(request.callerCwd)
      .pipe(Effect.mapError(() => fail('workspace-not-found', 'callerCwd must resolve to an existing checkout.')));
    const reportedCheckout = yield* gitValue(['rev-parse', '--show-toplevel'], cwd);
    if (!reportedCheckout) return yield* fail('workspace-not-found', 'callerCwd must be inside a Git checkout.');
    const checkout = yield* fs
      .realPath(reportedCheckout)
      .pipe(Effect.mapError(() => fail('workspace-not-found', 'The Git checkout root could not be resolved.')));
    const project = yield* Effect.try({
      try: () => workflowTitleSlug(path.basename(checkout)),
      catch: () => fail('invalid-project', 'The checkout directory cannot be used as a workflow project name.'),
    });
    const featureId = yield* Effect.try({
      try: () => workflowTitleSlug(request.featureName),
      catch: () => fail('invalid-feature', 'featureName must be a stable, nonblank task name.'),
    });
    const runId = nativeTaskStartRunId(taskStartReference, project, featureId);
    const stored = yield* readNativeWorkflowState(config, runId);
    const identity = {featureId, project};
    const currentSystem = yield* SystemInfo;
    const inCallerCheckout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(SystemInfo, {...currentSystem, currentDirectory: () => checkout}));
    const requireGraphReady = (
      generation: string,
      profile: 'desktop' | 'codex-cloud-personal' | 'cursor-cloud-personal',
      team?: string,
    ) =>
      Effect.gen(function* () {
        const binding = yield* resolveWorkflowBinding(config, {
          protocolVersion: 1,
          action: 'bind',
          workflowRunId: 'native-v1-' + runId,
          project,
          featureId,
          generation,
          profile,
          ...(team === undefined ? {} : {team}),
        });
        const graph = yield* makeWorkflowGraphAdapter(config, binding, {prepare: false});
        return yield* graph.ready(checkout);
      }).pipe(inCallerCheckout);

    if (stored) {
      if (
        stored.state.project !== project ||
        stored.state.featureId !== featureId ||
        (stored.state.title !== undefined && stored.state.title !== request.intent.title)
      )
        return yield* fail(
          'task-identity-conflict',
          'This task name already belongs to different canonical intent. Resume its current task card or choose a new feature name.',
        );
      const storedProfile = stored.state.profile ?? 'desktop';
      const selectedTarget = yield* readNativeTaskInstalledTarget(config, request.installationTarget, checkout, [
        storedProfile,
      ]);
      const view = yield* readNativeTaskView(config, {runId, callerCwd: checkout, detail: 'packet'});
      if (!nativeTaskStartReferenceIsCurrent(taskStartReference, stored, [request.taskRef, view.taskRef]))
        return yield* fail('stale-task-ref', 'Read the current task card before starting or resuming this task.');
      if (selectedTarget.installedDigest !== stored.state.generation) {
        const owners = yield* inspectOldBindingOwners(config, stored);
        const repeatedOwners = yield* inspectOldBindingOwners(config, stored);
        const latest = yield* readNativeWorkflowState(config, runId).pipe(Effect.result);
        const unresolved = [...owners.unresolved];
        if (stableJson(owners) !== stableJson(repeatedOwners))
          unresolved.push({owner: 'readback', status: 'changed', reason: 'run-owned-owner-readback-changed'});
        if (latest._tag !== 'Success' || latest.success?.revision !== stored.revision)
          unresolved.push({
            owner: 'canonical-run',
            status: 'changed',
            reason: 'run-revision-changed-during-cutover-inspection',
          });
        const outcome = unresolved.length === 0 ? 'drained' : 'needs-drain';
        return {
          status: 'binding-transition' as const,
          outcome,
          taskRef: runId,
          binding: {
            runId: stored.state.runId,
            generation: stored.state.generation,
            bindingId: stored.state.bindingId,
            profile: storedProfile,
          },
          selectedTarget: {
            surfaceId: selectedTarget.target.surfaceId,
            profile: selectedTarget.target.profile,
            installedDigest: selectedTarget.installedDigest,
          },
          owners: unresolved.length > 0 ? unresolved : [],
          view,
        };
      }
      const root = EffectArray.findFirst(
        [...stored.state.operations].reverse(),
        operation =>
          operation.status === 'verified' &&
          operation.intent.artifactKey === 'author-root-plan' &&
          operation.artifact !== undefined,
      );
      const reservation = stored.state.authoringSave;
      if (root._tag === 'Some' && !reservation) {
        const loaded = yield* inCallerCheckout(
          runWorkflowAutomation(
            config,
            authoringRequest(stored, 'load', {uri: root.value.artifact!.uri, detail: 'document'}),
          ).pipe(Effect.map(unwrapAuthoring)),
        );
        const document = yield* Effect.try({
          try: () => decodeNativeAuthoringDocument(loaded.document),
          catch: nativeWorkflowError,
        });
        if (!compactIntentMatchesDocument(request.intent, document))
          return yield* fail(
            'task-intent-conflict',
            'The saved task has different business intent. Continue its current task or choose a new feature name; existing intent was not overwritten.',
          );
        return {status: 'resumed' as const, taskRef: runId, view};
      }
      // Only the original initial compact save may continue through this semantic entry point.
      // Its complete document/save digest and deterministic receipt prefix are checked by the existing saver.
      const pendingCompactSave = reservation?.operationStart === 0 && reservation.rootUri === null;
      if ((stored.state.operations.length > 0 || reservation) && !pendingCompactSave)
        return yield* fail(
          'task-intent-missing',
          'This task has unrelated workflow history; no replacement intent was written.',
        );
      if (request.intent.eligibility.status === 'needs-planning') {
        if (pendingCompactSave)
          return yield* fail(
            'task-intent-conflict',
            'Resume the admitted compact save with its original eligible business intent; no intent was changed.',
          );
        return {
          status: 'needs-planning' as const,
          missingDecision: request.intent.eligibility.missingDecision,
          evidenceRefs: request.intent.eligibility.evidenceRefs,
          eligibilityRationale: request.intent.eligibilityRationale,
        };
      }
      const source = yield* inCallerCheckout(inspectNativeSourcePaths(checkout, request.intent.affectedPaths));
      const projected = projectNativeCompactIntent(request.intent, identity, source);
      if (projected.status !== 'eligible') return projected;
      yield* requireGraphReady(stored.state.generation, stored.state.profile, stored.state.team);
      const started = yield* runNativeTaskAction(config, {
        command: 'compact-start',
        runId,
        callerCwd: checkout,
        intent: request.intent,
      });
      return {...started, taskRef: runId, resumed: true, ...(pendingCompactSave ? {recovered: true} : {})};
    }

    if (request.taskRef)
      return yield* fail('run-not-found', 'The supplied task reference does not resolve to an existing native task.');
    if (request.intent.eligibility.status === 'needs-planning')
      return {
        status: 'needs-planning' as const,
        missingDecision: request.intent.eligibility.missingDecision,
        evidenceRefs: request.intent.eligibility.evidenceRefs,
        eligibilityRationale: request.intent.eligibilityRationale,
      };
    const target = yield* readNativeTaskInstalledTarget(config, request.installationTarget, checkout);
    const source = yield* inCallerCheckout(inspectNativeSourcePaths(checkout, request.intent.affectedPaths));
    const projected = projectNativeCompactIntent(request.intent, identity, source);
    if (projected.status !== 'eligible') return projected;
    yield* requireGraphReady(target.installedDigest, target.target.profile);
    const initialized = yield* inCallerCheckout(
      runWorkflowAutomation(config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'init',
        runId,
        project,
        featureId,
        generation: target.installedDigest,
        profile: target.target.profile,
        title: request.intent.title,
      }),
    );
    const initResult: unknown = initialized;
    if (Predicate.isObject(initResult) && initResult.status === 'error')
      return yield* fail(
        typeof initResult.code === 'string' ? initResult.code : 'task-start-failed',
        typeof initResult.message === 'string' ? initResult.message : 'The native task could not be initialized.',
      );
    const started = yield* runNativeTaskAction(config, {
      command: 'compact-start',
      runId,
      callerCwd: checkout,
      intent: request.intent,
    });
    return {...started, taskRef: runId};
  }).pipe(
    Effect.catchDefect(error => Effect.fail(nativeWorkflowError(error))),
    Effect.mapError(nativeWorkflowError),
  );

const authoringRequest = (
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  command: string,
  fields: object,
) => ({
  protocolVersion: 1,
  executorVersion: 1,
  action: 'authoring',
  command,
  runId: stored.state.runId,
  generation: stored.state.generation,
  ...fields,
});

const unwrapAuthoring = (result: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(result) || result.status !== 'ok' || !Predicate.isObject(result.authoring))
    throw fail(
      Predicate.isObject(result) && typeof result.code === 'string' ? result.code : 'task-action-failed',
      Predicate.isObject(result) && Predicate.isObject(result.authoring) && typeof result.authoring.message === 'string'
        ? result.authoring.message
        : 'The native authoring action did not return a verified result.',
    );
  return result.authoring;
};

const requireEffectValue = <A>(value: A | undefined, message: string): A => {
  if (value === undefined) throw fail('invalid-state', message);
  return value;
};

const snapshotRef = (work: NonNullable<ReturnType<typeof decodeNativeTaskActionRef>>, entry: unknown) => {
  if (!Predicate.isObject(entry) || !Predicate.isObject(entry.snapshot))
    throw fail('invalid-state', 'Canonical snapshot evidence is unavailable.');
  const snapshot = entry.snapshot;
  if (typeof snapshot.snapshotId !== 'string' || typeof snapshot.head !== 'string' || typeof snapshot.tree !== 'string')
    throw fail('invalid-state', 'Canonical snapshot identity is incomplete.');
  return encodeNativeTaskActionRef({
    version: 1,
    kind: 'snapshot',
    runId: work.runId,
    generationHash: work.generationHash,
    phaseId: work.phaseId,
    phaseHash: work.phaseHash,
    baselineHead: work.baselineHead,
    baselineTree: work.baselineTree,
    baselineRef: work.baselineRef,
    snapshotId: snapshot.snapshotId,
    sourceHead: snapshot.head,
    sourceTree: snapshot.tree,
  });
};

/** Typed task operations over the existing cycle state; references never authorize a mutation by themselves. */
export const runNativeTaskAction = (config: RuntimeConfig, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(requestSchema, {onExcessProperty: 'error'})(input).pipe(
      Effect.mapError(error =>
        fail('invalid-request', `Invalid task-action input: ${EffectString.slice(0, 768)(error.message)}`),
      ),
    );
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    if (!path.isAbsolute(request.callerCwd))
      return yield* fail('invalid-request', 'callerCwd must be an absolute checkout path.');
    const callerCwd = yield* fs
      .realPath(request.callerCwd)
      .pipe(Effect.mapError(() => fail('workspace-not-found', 'callerCwd must resolve to an existing checkout.')));
    const reportedCheckout = yield* gitValue(['rev-parse', '--show-toplevel'], callerCwd);
    if (!reportedCheckout) return yield* fail('workspace-not-found', 'callerCwd must be inside a Git checkout.');
    // Git may report a Windows root with a different separator/casing form than
    // realPath used when the native run binding was created. Compare filesystem
    // canonical roots, not two textual renderings of the same checkout.
    const checkout = yield* fs
      .realPath(reportedCheckout)
      .pipe(Effect.mapError(() => fail('workspace-not-found', 'The Git checkout root could not be resolved.')));
    const stored = yield* readNativeWorkflowState(config, request.runId);
    if (!stored) return yield* fail('run-not-found', 'Start a fresh native run before using task actions.');
    const journal = yield* inCheckout(
      withWorkflowLock(config, stored.state.bindingId, inspectWorkflowJournal(config, stored.state.bindingId)),
      checkout,
    );
    if (journal.state.binding.repo !== checkout)
      return yield* fail('wrong-checkout', 'Use the checkout bound to this native run.');

    if (
      request.command === 'compact-start' ||
      request.command === 'compact-expand' ||
      request.command === 'compact-confirm'
    ) {
      const authoring = (command: string, fields: object = {}, compactOriginCreation = false) =>
        inCheckout(
          (compactOriginCreation ? runCompactOriginAuthoringSave : runWorkflowAutomation)(
            config,
            authoringRequest(stored, command, fields),
          ).pipe(Effect.map(unwrapAuthoring)),
          checkout,
        );
      const rootOperation = EffectArray.findFirst(
        [...stored.state.operations].reverse(),
        operation =>
          operation.status === 'verified' &&
          operation.intent.artifactKey === 'author-root-plan' &&
          operation.artifact !== undefined,
      );
      const root = rootOperation?._tag === 'Some' ? rootOperation.value.artifact : undefined;
      const loadRoot = () =>
        Effect.gen(function* () {
          if (!root) return yield* fail('authoring-root-missing', 'Create a compact task draft before confirming it.');
          const loaded = yield* authoring('load', {uri: root.uri, detail: 'document'});
          const document = yield* Effect.try({
            try: () => decodeNativeAuthoringDocument(loaded.document),
            catch: nativeWorkflowError,
          });
          return {document, uri: root.uri, revision: root.revision, metadata: loaded};
        });

      if (request.command === 'compact-start') {
        if (request.intent.eligibility.status === 'needs-planning')
          return projectNativeCompactIntent(
            request.intent,
            {featureId: stored.state.featureId, project: stored.state.project},
            {head: EffectPipe('0', EffectString.repeat(40)), files: []},
          );
        const inspected = yield* authoring('scope-inspect', {
          paths: request.intent.affectedPaths,
          literalOnly: true,
        });
        const sourceSnapshot = yield* Schema.decodeUnknownEffect(NativeCompactSourceSnapshotSchema)(
          inspected.source,
        ).pipe(Effect.mapError(nativeWorkflowError));
        const projection = projectNativeCompactIntent(
          request.intent,
          {featureId: stored.state.featureId, project: stored.state.project},
          sourceSnapshot,
        );
        if (projection.status !== 'eligible') return projection;
        let document = projection.document;
        if (root) {
          const previous = yield* loadRoot();
          if (previous.document.kind !== 'plan' || !previous.document.compactOrigin)
            return yield* fail(
              'compact-origin-required',
              'This run already has a standard plan. Continue through its existing authoring flow.',
            );
          if (previous.document.compactOrigin.expanded)
            return yield* fail(
              'compact-already-expanded',
              'Continue through the expanded plan flow; a new compact start cannot replace this run’s material design.',
            );
          document = decodeNativeAuthoringDocument({
            ...document,
            compactOrigin: {
              ...previous.document.compactOrigin,
              eligibilityRationale: request.intent.eligibilityRationale,
            },
          });
        }
        const packet = yield* authoring('acceptance-packet', {document, detail: 'document'});
        const initialSave =
          stored.state.authoringSave?.operationStart === 0 && stored.state.authoringSave.rootUri === null;
        const saved = yield* authoring(
          'save',
          {
            document,
            ready: false,
            // A verified root can still belong to the unfinished original draft save.
            // Keep that save's runtime-owned CAS rather than inventing a second update.
            ...(initialSave
              ? {expectedRevision: null}
              : root
                ? {uri: root.uri, expectedRevision: root.revision}
                : {expectedRevision: null}),
          },
          true,
        );
        return {
          status: 'awaiting-user-confirmation',
          packet,
          root: saved.root,
          documentHash: saved.documentHash,
          intentHash: saved.intentHash,
          readiness: saved.readiness,
          next: 'Present the complete packet and collect a real user response for its exact intentHash.',
        };
      }

      if (request.command === 'compact-expand') {
        const previous = yield* loadRoot();
        if (previous.document.kind !== 'plan' || !previous.document.compactOrigin)
          return yield* fail('compact-origin-required', 'Only a compact-origin plan can be expanded in place.');
        const supplied = yield* Effect.try({
          try: () => decodeNativeAuthoringDocument(request.document),
          catch: nativeWorkflowError,
        });
        if (
          supplied.kind !== 'plan' ||
          supplied.id !== stored.state.featureId ||
          supplied.project !== stored.state.project
        )
          return yield* fail('binding-drift', 'The expanded plan must retain this run’s plan identity.');
        if (supplied.openQuestions.length > 0 || supplied.decisions.length === 0)
          return {
            status: 'needs-planning',
            missingDecision:
              supplied.openQuestions[0] ?? 'Record the resolved product or design decision before expanding this run.',
            evidenceRefs: [],
          };
        const document = decodeNativeAuthoringDocument({
          ...supplied,
          compactOrigin: {...previous.document.compactOrigin, expanded: true},
        });
        const packet = yield* authoring('acceptance-packet', {document, detail: 'document'});
        const saved = yield* authoring('save', {
          document,
          ready: false,
          uri: previous.uri,
          expectedRevision: previous.revision,
        });
        return {
          status: 'awaiting-user-confirmation',
          packet,
          root: saved.root,
          documentHash: saved.documentHash,
          intentHash: saved.intentHash,
          readiness: saved.readiness,
          previousRoot: previous.uri,
          next: 'The earlier response does not approve this expanded intent; collect a response for this exact intentHash.',
        };
      }

      const current = yield* loadRoot();
      if (current.document.kind !== 'plan' || !current.document.compactOrigin)
        return yield* fail('compact-origin-required', 'This plan has no compact-origin confirmation obligation.');
      const intentHash = nativeSpecIntentDigest(current.document);
      if (request.presentedIntentHash !== intentHash)
        return yield* fail(
          'stale-intent',
          'The displayed compact intent changed. Run workflow_task_view for this run to retrieve the current packet, then present that packet before confirming.',
        );
      const existingCycle = stored.state.cycle?.state;
      const currentBranch = yield* gitValue(['branch', '--show-current'], checkout);
      if (!existingCycle && !request.baseBranch)
        return {status: 'missing-input', intentHash, missingInputs: ['baseBranch for the local cycle']};
      const priorBindings = new Map(
        EffectArray.map(
          existingCycle?.plan.phases ?? [],
          phase => [phase.id, {branch: phase.branch, baseBranch: phase.baseBranch}] as const,
        ),
      );
      const bindings =
        request.bindings ??
        EffectRecord.fromEntries(
          EffectArray.map(current.document.phases, phase => {
            const priorBinding = priorBindings.get(phase.id);
            if (priorBinding) return [phase.id, priorBinding] as const;
            return [phase.id, {branch: currentBranch ?? '', baseBranch: request.baseBranch ?? ''}] as const;
          }),
        );
      if (
        !currentBranch ||
        EffectArray.some(
          current.document.phases,
          phase => !bindings[phase.id]?.branch || !bindings[phase.id]?.baseBranch,
        ) ||
        EffectRecord.keys(bindings).length !== current.document.phases.length
      )
        return {
          status: 'missing-input',
          intentHash,
          missingInputs: ['An exact branch/base-branch binding for every phase'],
        };
      const existingConfirmation = Predicate.isObject(current.metadata.confirmation)
        ? current.metadata.confirmation
        : undefined;
      const priorResponse =
        existingConfirmation?.decision === 'approved' &&
        existingConfirmation.intentHash === intentHash &&
        typeof existingConfirmation.response === 'string'
          ? existingConfirmation.response
          : undefined;
      // An implicit replay is valid only when the caller supplies no new response
      // and the exact current intent already has a stored approval.
      const implicitReplay = request.userDecision === undefined && request.userResponse === undefined;
      const userDecision = request.userDecision ?? (implicitReplay && priorResponse ? 'approve' : undefined);
      const userResponse = request.userResponse ?? (implicitReplay ? priorResponse : undefined);
      if (!userDecision || !userResponse || (request.userDecision !== undefined && !request.userResponse))
        return {
          status: 'awaiting-user-confirmation',
          intentHash,
          missingDecision:
            'Provide the user’s actual response and an explicit approve/reject/defer decision for the displayed compact-intent packet.',
          actorIdentity: 'caller-asserted; not independently verified by this local command boundary',
        };
      const confirmationResult = yield* authoring('confirm', {
        document: current.document,
        presentedIntentHash: request.presentedIntentHash,
        userResponse,
        userDecision,
      });
      if (!Predicate.isObject(confirmationResult.confirmation))
        return {
          status: userDecision,
          intentHash,
          response: userResponse,
          actorIdentity: 'caller-asserted; not independently verified by this local command boundary',
        };

      const saved = yield* authoring('save', {
        document: current.document,
        ready: true,
        uri: current.uri,
        expectedRevision: current.revision,
        confirmation: confirmationResult.confirmation,
        ...(request.review ? {review: request.review} : {}),
      });
      if (saved.readiness !== 'ready')
        return {
          status: 'awaiting-review',
          intentHash,
          root: saved.root,
          blockers: saved.readinessBlockers ?? [],
          confirmation: confirmationResult.confirmation,
          actorIdentity: 'caller-asserted; not independently verified by this local command boundary',
        };
      const exportPacket = yield* authoring('export-dev-cycle', {
        uri: current.uri,
        delivery: 'local',
        bindings,
      });
      const latest = yield* readNativeWorkflowState(config, request.runId);
      if (!latest) return yield* fail('run-not-found', 'The compact task run disappeared before cycle admission.');
      const cycle = unwrapCycle(
        yield* inCheckout(
          runWorkflowAutomation(
            config,
            cycleRequest(latest, {
              command: existingCycle ? 'reconcile' : 'init',
              expectedRevision: latest.revision,
              plan: exportPacket,
              ...(existingCycle
                ? {reason: request.reconcileReason ?? 'Admit the newly confirmed compact-origin plan on this same run.'}
                : {}),
            }),
          ),
          checkout,
        ),
      );
      const task = yield* inCheckout(readNativeTaskView(config, {runId: request.runId, callerCwd: checkout}), checkout);
      return {
        status: 'admitted',
        intentHash,
        root: saved.root,
        cycle,
        task,
        taskReadiness: task.status,
        actorIdentity: 'caller-asserted; not independently verified by this local command boundary',
      };
    }

    if (!stored.state.cycle) return yield* fail('cycle-not-found', 'This run has no admitted native cycle.');
    const runtime = stored.state.cycle;
    const state = runtime.state;
    if (
      request.command !== 'supersede-unreviewed-snapshot' &&
      state.plan.delivery !== 'local' &&
      state.plan.delivery !== 'commit' &&
      state.plan.delivery !== 'pr'
    )
      return yield* fail('task-scope', 'Task actions support approved local, commit, or PR-delivery cycles.');

    const taskView = () => readNativeTaskView(config, {runId: request.runId, callerCwd: checkout});
    const currentTaskRef = (view: Effect.Success<ReturnType<typeof taskView>>, action: string) => {
      const currentPhaseId = 'phaseId' in view.next ? view.next.phaseId : undefined;
      const currentSnapshotId = 'snapshotId' in view.next ? view.next.snapshotId : undefined;
      if (!('taskRef' in request) || !request.taskRef || view.next.action !== action) return undefined;
      const ref = decodeNativeTaskActionRef(request.taskRef);
      if (
        !ref ||
        ref.kind !== 'task' ||
        ref.runId !== request.runId ||
        ref.generationHash !== sha256HexSync(stored.state.generation) ||
        ref.stateRevision !== stored.revision ||
        ref.taskAction !== action ||
        (currentPhaseId !== undefined &&
          (ref.phaseId !== currentPhaseId || ref.phaseHash !== state.phases[currentPhaseId]?.phaseHash)) ||
        (currentSnapshotId !== undefined && ref.snapshotId !== currentSnapshotId)
      )
        return undefined;
      return ref;
    };

    if (request.command === 'begin') {
      const view = yield* taskView();
      const currentPhaseId = 'phaseId' in view.next ? view.next.phaseId : undefined;
      if (!currentPhaseId) return yield* fail('task-not-ready', 'The current task card has no eligible phase.');
      const replayRef = decodeNativeTaskActionRef(request.taskRef);
      const existingBaseline = runtime.baselines[currentPhaseId];
      if (
        existingBaseline &&
        replayRef?.kind === 'task' &&
        replayRef.runId === request.runId &&
        replayRef.generationHash === sha256HexSync(stored.state.generation) &&
        replayRef.taskAction === 'implement' &&
        replayRef.phaseId === currentPhaseId &&
        replayRef.phaseHash === state.phases[currentPhaseId]?.phaseHash
      )
        return {
          status: 'begun',
          replayed: true,
          phaseId: currentPhaseId,
          phaseHash: state.phases[currentPhaseId]?.phaseHash,
          baseline: existingBaseline,
          task: view,
        };
      const ref = currentTaskRef(view, 'implement');
      if (!ref) return yield* fail('stale-task-ref', 'Read the current task card before beginning this phase.');
      const phaseId = currentPhaseId;
      const phaseHash = state.phases[phaseId]?.phaseHash;
      const baseline = runtime.baselines[phaseId];
      if (baseline) {
        if (ref.phaseHash !== phaseHash)
          return yield* fail('stale-task-ref', 'The phase contract changed after this task card was issued.');
        return {status: 'begun', replayed: true, phaseId, phaseHash, baseline, task: view};
      }
      const cycle = unwrapCycle(
        yield* inCheckout(
          runWorkflowAutomation(
            config,
            cycleRequest(stored, {command: 'begin-phase', phaseId, expectedRevision: stored.revision}),
          ),
          checkout,
        ),
      );
      const latest = yield* readNativeWorkflowState(config, request.runId);
      const latestBaseline = latest?.state.cycle?.baselines[phaseId];
      if (!latestBaseline) return yield* fail('phase-not-begun', 'The canonical phase baseline was not persisted.');
      return {
        status: 'begun',
        replayed: false,
        phaseId,
        phaseHash,
        baseline: latestBaseline,
        cycle,
        task: yield* taskView(),
      };
    }

    if (request.command === 'resume') {
      const ref = decodeNativeTaskActionRef(request.taskRef);
      const prior = ref?.phaseId ? state.phases[ref.phaseId] : undefined;
      if (
        ref?.kind === 'task' &&
        ref.runId === request.runId &&
        ref.generationHash === sha256HexSync(stored.state.generation) &&
        ref.taskAction === 'blocked' &&
        ref.phaseId &&
        ref.phaseHash === prior?.phaseHash &&
        prior?.reason === request.reason &&
        ['pending', 'active'].includes(prior.status)
      )
        return {status: 'resumed', replayed: true, phaseId: ref.phaseId, task: yield* taskView()};
      const view = yield* taskView();
      const current = currentTaskRef(view, 'blocked');
      if (!current) return yield* fail('stale-task-ref', 'Read the current blocked phase card before resuming.');
      const phaseId = current.phaseId;
      if (!phaseId || !['stale', 'blocked'].includes(state.phases[phaseId]?.status ?? ''))
        return yield* fail('phase-not-resumable', 'Only the current stale or blocked phase can be resumed.');
      if (!EffectString.trim(request.reason))
        return yield* fail('invalid-request', 'Record the concrete recovery reason.');
      const cycle = unwrapCycle(
        yield* inCheckout(
          runWorkflowAutomation(
            config,
            cycleRequest(stored, {
              command: 'resume-phase',
              phaseId,
              reason: request.reason,
              expectedRevision: stored.revision,
            }),
          ),
          checkout,
        ),
      );
      return {status: 'resumed', replayed: false, phaseId, cycle, task: yield* taskView()};
    }

    if (request.command === 'reconcile') {
      const planResult = yield* inCheckout(
        runWorkflowAutomation(config, authoringRequest(stored, 'current-plan', {detail: 'document'})),
        checkout,
      );
      const planValue: unknown =
        Predicate.isObject(planResult) && 'authoring' in planResult ? planResult.authoring : undefined;
      const currentPlan = Predicate.isObject(planValue) ? planValue.currentPlan : undefined;
      if (!Predicate.isObject(currentPlan) || !Predicate.isObject(currentPlan.root))
        return {status: 'needs-planning', missingInputs: ['A verified current ready approved plan root']};
      const planRefDigest = sha256HexSync(
        stableJson({
          uri: currentPlan.root.uri,
          revision: currentPlan.root.revision,
          documentHash: currentPlan.documentHash,
          intentHash: currentPlan.intentHash,
        }),
      );
      const suppliedRef = decodeNativeTaskActionRef(request.taskRef);
      if (
        !suppliedRef ||
        suppliedRef.kind !== 'task' ||
        suppliedRef.runId !== request.runId ||
        suppliedRef.generationHash !== sha256HexSync(stored.state.generation) ||
        suppliedRef.taskAction !== 'reconcile-plan' ||
        suppliedRef.payloadDigest !== planRefDigest
      )
        return yield* fail(
          'stale-task-ref',
          'The approved plan changed. Read workflow_task_view for its current action.',
        );
      if (currentPlan.status !== 'awaiting-admission' && currentPlan.status !== 'admitted')
        return {
          status: 'needs-planning',
          missingInputs: ['Current plan approval and its required independent review before reconciliation'],
        };
      const currentReconcileView = yield* taskView();
      const currentReconcileTask =
        currentReconcileView.next.action === 'reconcile-plan' && currentReconcileView.taskRef === request.taskRef;
      const loaded = yield* inCheckout(
        runWorkflowAutomation(
          config,
          authoringRequest(stored, 'load', {uri: currentPlan.root.uri, detail: 'document'}),
        ),
        checkout,
      );
      const loadedValue: unknown = Predicate.isObject(loaded) && 'authoring' in loaded ? loaded.authoring : undefined;
      if (!Predicate.isObject(loadedValue) || !Predicate.isObject(loadedValue.document))
        return {status: 'needs-planning', missingInputs: ['The approved plan document readback']};
      const document = decodeNativeAuthoringDocument(loadedValue.document);
      if (document.kind !== 'plan' || document.openQuestions.length > 0 || document.decisions.length === 0)
        return {status: 'needs-planning', missingInputs: ['Resolved plan questions and a recorded design decision']};
      const suppliedBindings = request.bindings ?? {};
      const currentIds = new Set(EffectArray.map(state.plan.phases, phase => phase.id));
      // An admitted exact replay may repeat only the business bindings introduced
      // by that retained plan transition. Older bindings remain runtime-owned.
      const replayPredecessor =
        currentPlan.status === 'admitted' && stableJson(runtime.plans.at(-1)) === stableJson(state.plan)
          ? runtime.plans.at(-2)
          : undefined;
      if (
        EffectArray.some(EffectRecord.keys(suppliedBindings), phaseId => {
          if (!currentIds.has(phaseId)) return false;
          const current = EffectOption.getOrUndefined(
            EffectArray.findFirst(state.plan.phases, phase => phase.id === phaseId),
          );
          const supplied = suppliedBindings[phaseId];
          return (
            !replayPredecessor ||
            EffectArray.some(replayPredecessor.phases, phase => phase.id === phaseId) ||
            supplied.branch !== current?.branch ||
            supplied.baseBranch !== current?.baseBranch
          );
        })
      )
        return yield* fail('invalid-request', 'Existing phase bindings are runtime-owned and cannot be replaced here.');
      const bindings = EffectRecord.fromEntries(
        EffectArray.map(document.phases, phase => {
          const prior = EffectOption.getOrUndefined(
            EffectArray.findFirst(state.plan.phases, item => item.id === phase.id),
          );
          const supplied = suppliedBindings[phase.id];
          return [phase.id, prior ? {branch: prior.branch, baseBranch: prior.baseBranch} : supplied] as const;
        }),
      );
      if (
        EffectArray.some(document.phases, phase => !bindings[phase.id]?.branch || !bindings[phase.id]?.baseBranch) ||
        EffectArray.some(
          EffectRecord.keys(suppliedBindings),
          phaseId => !EffectArray.some(document.phases, phase => phase.id === phaseId),
        )
      )
        return {
          status: 'needs-planning',
          missingInputs: ['A branch and base-branch choice for each new approved phase'],
        };
      const exported = yield* inCheckout(
        runWorkflowAutomation(
          config,
          authoringRequest(stored, 'export-dev-cycle', {
            uri: currentPlan.root.uri,
            delivery: 'local',
            bindings,
          }),
        ),
        checkout,
      );
      const exportValue: unknown =
        Predicate.isObject(exported) && 'authoring' in exported ? exported.authoring : undefined;
      if (!Predicate.isObject(exportValue))
        return {status: 'needs-planning', missingInputs: ['A verified export of the current approved plan']};
      if (currentPlan.status === 'admitted') {
        const currentHash = stableJson(state.plan);
        if (currentHash === stableJson(exportValue))
          return {status: 'reconciled', replayed: true, task: currentReconcileView};
        if (suppliedRef.stateRevision !== stored.revision)
          return yield* fail('stale-task-ref', 'The current approved plan action changed. Read the latest task card.');
        if (!currentReconcileTask)
          return yield* fail('stale-task-ref', 'The task reference cannot reconcile changed plan content.');
      }
      if (!currentReconcileTask || suppliedRef.stateRevision !== stored.revision)
        return yield* fail('stale-task-ref', 'Read workflow_task_view for the current plan reconciliation task.');
      const cycle = unwrapCycle(
        yield* inCheckout(
          runWorkflowAutomation(
            config,
            cycleRequest(stored, {
              command: 'reconcile',
              plan: exportValue,
              reason: request.reason,
              expectedRevision: stored.revision,
            }),
          ),
          checkout,
        ),
      );
      return {status: 'reconciled', replayed: false, cycle, task: yield* taskView()};
    }

    if (request.command === 'extend-review-budget') {
      const requestDigest = sha256HexSync(
        stableJson({
          taskRef: request.taskRef,
          additionalReviews: request.additionalReviews,
          reason: request.reason,
          userAuthority: request.userAuthority,
        }),
      );
      const priorExpansion = EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.reviewExpansions, item => item.requestDigest === requestDigest),
      );
      if (priorExpansion)
        return {status: 'extended', replayed: true, expansion: priorExpansion, task: yield* taskView()};
      const view = yield* taskView();
      const ref = currentTaskRef(view, 'expand-review-budget');
      if (!ref)
        return yield* fail('stale-task-ref', 'Read the current exhausted review-budget card before extending it.');
      const phaseId = ref.phaseId;
      const currentSnapshotId = 'snapshotId' in view.next ? view.next.snapshotId : undefined;
      if (!phaseId || ref.phaseHash !== state.phases[phaseId]?.phaseHash || ref.snapshotId !== currentSnapshotId)
        return yield* fail('stale-task-ref', 'The review budget reference does not match this phase snapshot.');
      const usage = nativeCyclePhaseReviewUsage(runtime, phaseId);
      if (!usage.exhausted)
        return yield* fail('review-budget', 'The current phase has not exhausted its review budget.');
      const reviewLimit = usage.limit + request.additionalReviews;
      if (reviewLimit > 256)
        return yield* fail('review-budget', 'The requested addition exceeds the maximum supported review budget.');
      const cycle = unwrapCycle(
        yield* inCheckout(
          runWorkflowAutomation(
            config,
            cycleRequest(stored, {
              command: 'extend-reviews',
              phaseId,
              reviewLimit,
              userAuthority: request.userAuthority,
              reviewExpansionReason: request.reason,
              reviewExpansionDigest: requestDigest,
              expectedRevision: stored.revision,
            }),
          ),
          checkout,
        ),
      );
      const latest = yield* readNativeWorkflowState(config, request.runId);
      const expansion = latest?.state.cycle
        ? EffectOption.getOrUndefined(
            EffectArray.findFirst(latest.state.cycle.reviewExpansions, item => item.requestDigest === requestDigest),
          )
        : undefined;
      if (!expansion)
        return yield* fail('review-budget-not-recorded', 'The authorized budget increase was not persisted.');
      return {status: 'extended', replayed: false, expansion, cycle, task: yield* taskView()};
    }

    if (request.command === 'finish') return yield* runNativeTaskFinish(config, request, stored, checkout, state);

    if (request.command === 'record-review') {
      const ref = decodeNativeTaskActionRef(request.snapshotRef);
      if (
        !ref ||
        ref.kind !== 'snapshot' ||
        ref.runId !== request.runId ||
        ref.generationHash !== sha256HexSync(stored.state.generation) ||
        !ref.phaseId ||
        !ref.phaseHash ||
        !ref.snapshotId ||
        !ref.sourceHead ||
        !ref.sourceTree ||
        !ref.baselineHead ||
        !ref.baselineTree ||
        !ref.baselineRef
      )
        return yield* fail('invalid-snapshot-ref', 'Restart with the current review task for this run.');
      const entry = EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === ref.snapshotId),
      );
      if (
        !entry ||
        entry.snapshot.phaseId !== ref.phaseId ||
        entry.snapshot.phaseHash !== ref.phaseHash ||
        entry.snapshot.head !== ref.sourceHead ||
        entry.snapshot.tree !== ref.sourceTree
      )
        return yield* fail('stale-snapshot-ref', 'The referenced immutable snapshot is unavailable.');
      const report = {
        snapshotId: entry.snapshot.snapshotId,
        phaseHash: entry.snapshot.phaseHash,
        snapshotTree: entry.snapshot.tree,
        status: 'complete' as const,
        ...request.report,
      };
      const reportJson = stableJson(report);
      const reportDigest = sha256HexSync(reportJson);
      const attemptId = `attempt-${EffectString.slice(0, 48)(sha256HexSync(stableJson([ref.snapshotId, reportDigest])))}`;
      if (ref.attemptId !== undefined && (ref.attemptId !== attemptId || ref.payloadDigest !== reportDigest))
        return yield* fail('review-conflict', 'The review reference is bound to different report content.');
      const attemptRef = encodeNativeTaskActionRef({
        ...ref,
        kind: 'snapshot',
        attemptId,
        payloadDigest: reportDigest,
      });
      const prior = EffectOption.getOrUndefined(EffectArray.findFirst(runtime.attempts, item => item.id === attemptId));
      if (prior) {
        if (prior.snapshotId !== ref.snapshotId || prior.digest !== reportDigest)
          return yield* fail(
            'review-conflict',
            'This review identity is already bound to different canonical evidence.',
          );
        return {
          status: prior.status === 'accepted' ? 'recorded' : 'invalid',
          replayed: true,
          snapshotRef: attemptRef,
          attempt: prior,
        };
      }
      const view = yield* readNativeTaskView(config, {
        runId: request.runId,
        callerCwd: checkout,
        role: 'review',
      });
      if (view.status !== 'ready' || view.next.action !== 'review' || view.next.snapshotId !== ref.snapshotId)
        return yield* fail(
          'review-not-ready',
          EffectArray.join(view.missingInputs, ' ') || 'Follow the current native review task.',
        );
      const head = yield* gitValue(['rev-parse', 'HEAD'], checkout);
      if (!head) return yield* fail('source-unavailable', 'Could not read the current review source head.');
      yield* inCheckout(
        runWorkflowAutomation(
          config,
          cycleRequest(stored, {
            command: 'validate-review',
            phaseId: ref.phaseId,
            snapshotId: ref.snapshotId,
            attemptId,
            acceptedHead: head,
            report,
            expectedRevision: stored.revision,
          }),
        ),
        checkout,
      );
      const latest = yield* readNativeWorkflowState(config, request.runId);
      const attempt = latest?.state.cycle
        ? EffectOption.getOrUndefined(EffectArray.findFirst(latest.state.cycle.attempts, item => item.id === attemptId))
        : undefined;
      if (!attempt) return yield* fail('review-not-recorded', 'The canonical review attempt was not persisted.');
      return {
        status: attempt.status === 'accepted' ? 'recorded' : 'invalid',
        replayed: false,
        snapshotRef: attemptRef,
        attempt,
      };
    }

    if (request.command === 'record-validation') {
      const ref = decodeNativeTaskActionRef(request.snapshotRef);
      if (
        !ref ||
        (ref.kind !== 'snapshot' && ref.kind !== 'validation') ||
        ref.runId !== request.runId ||
        ref.generationHash !== sha256HexSync(stored.state.generation) ||
        !ref.phaseId ||
        !ref.phaseHash ||
        !ref.snapshotId ||
        !ref.sourceHead ||
        !ref.sourceTree
      )
        return yield* fail('invalid-snapshot-ref', 'Restart with the current validation task for this run.');
      const matches = EffectArray.filter(
        runtime.snapshots,
        item =>
          item.snapshot.snapshotId === ref.snapshotId &&
          item.snapshot.phaseId === ref.phaseId &&
          item.snapshot.phaseHash === ref.phaseHash &&
          item.snapshot.head === ref.sourceHead &&
          item.snapshot.tree === ref.sourceTree,
      );
      const entry = matches[0];
      if (matches.length !== 1 || !entry)
        return yield* fail(
          'snapshot-ambiguous',
          'Recovery requires one unique canonical snapshot for this validation.',
        );
      const report = EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.reviews, item => item.snapshotId === ref.snapshotId),
      );
      if (!report) return yield* fail('review-pending', 'Record the complete accepted review before validation.');
      const validation = {
        snapshotTree: entry.snapshot.tree,
        reviewTree: entry.snapshot.tree,
        head: entry.snapshot.head,
        status: 'passed' as const,
        productState: 'working' as const,
        checks: request.validation.checks,
        acceptance: request.validation.acceptance,
      };
      const proof = state.phases[ref.phaseId];
      const validationDigest = sha256HexSync(stableJson(validation));
      const validationRef = encodeNativeTaskActionRef({
        ...ref,
        kind: 'validation',
        payloadDigest: validationDigest,
      });
      if (proof?.validation) {
        if (
          proof.phaseHash !== ref.phaseHash ||
          proof.head !== entry.snapshot.head ||
          proof.tree !== entry.snapshot.tree ||
          stableJson(proof.validation) !== stableJson(validation) ||
          (ref.kind === 'validation' && ref.payloadDigest !== validationDigest)
        )
          return yield* fail('validation-conflict', 'This phase already has different canonical validation evidence.');
        return {status: 'recorded', replayed: true, validationRef, validation: proof.validation};
      }
      if (ref.kind === 'validation')
        return yield* fail('stale-validation-ref', 'This validation reference has no matching canonical phase proof.');
      unwrapCycle(
        yield* inCheckout(
          runWorkflowAutomation(
            config,
            cycleRequest(stored, {
              command: 'ready',
              phaseId: ref.phaseId,
              snapshotId: ref.snapshotId,
              validation,
              expectedRevision: stored.revision,
            }),
          ),
          checkout,
        ),
      );
      const latest = yield* readNativeWorkflowState(config, request.runId);
      const accepted = latest?.state.cycle?.state.phases[ref.phaseId]?.validation;
      if (!accepted) return yield* fail('validation-not-recorded', 'The canonical phase validation was not persisted.');
      return {status: 'recorded', replayed: false, validationRef, validation: accepted};
    }

    if (request.command === 'deliver-local') {
      const ref = decodeNativeTaskActionRef(request.validationRef);
      if (
        !ref ||
        (ref.kind !== 'validation' && ref.kind !== 'delivery') ||
        ref.runId !== request.runId ||
        ref.generationHash !== sha256HexSync(stored.state.generation) ||
        !ref.phaseId ||
        !ref.phaseHash ||
        !ref.snapshotId ||
        !ref.sourceHead ||
        !ref.sourceTree ||
        !ref.payloadDigest
      )
        return yield* fail(
          'invalid-validation-ref',
          'Use the current canonical validation reference for local delivery.',
        );
      if (state.plan.delivery !== 'local')
        return yield* fail('delivery-scope', 'This task operation supports local delivery only.');
      const proof = state.phases[ref.phaseId];
      const validationDigest = proof?.validation ? sha256HexSync(stableJson(proof.validation)) : undefined;
      if (
        !proof?.validation ||
        proof.phaseHash !== ref.phaseHash ||
        proof.head !== ref.sourceHead ||
        proof.tree !== ref.sourceTree ||
        (ref.kind === 'validation' && validationDigest !== ref.payloadDigest)
      )
        return yield* fail('stale-validation-ref', 'The reference does not match current canonical phase validation.');
      const snapshots = EffectArray.filter(
        runtime.snapshots,
        item =>
          item.snapshot.snapshotId === ref.snapshotId &&
          item.snapshot.phaseId === ref.phaseId &&
          item.snapshot.phaseHash === ref.phaseHash &&
          item.snapshot.head === ref.sourceHead &&
          item.snapshot.tree === ref.sourceTree,
      );
      if (snapshots.length !== 1)
        return yield* fail('snapshot-ambiguous', 'Local delivery needs one unique canonical source snapshot.');
      const receipt = {
        phaseId: ref.phaseId,
        phaseHash: ref.phaseHash,
        delivery: 'local' as const,
        headSha: proof.head,
        validatedTree: proof.tree,
      };
      const deliveryDigest = sha256HexSync(stableJson(receipt));
      if (ref.kind === 'delivery' && ref.payloadDigest !== deliveryDigest)
        return yield* fail('delivery-conflict', 'The delivery reference is bound to different receipt content.');
      const deliveryRef = encodeNativeTaskActionRef({...ref, kind: 'delivery', payloadDigest: deliveryDigest});
      if (proof.delivery) {
        if (
          stableJson(proof.delivery) !== stableJson(receipt) ||
          (ref.kind === 'delivery' && ref.payloadDigest !== deliveryDigest)
        )
          return yield* fail('delivery-conflict', 'The phase already has a different canonical delivery receipt.');
        return {status: 'delivered', replayed: true, deliveryRef, receipt: proof.delivery};
      }
      if (ref.kind === 'delivery')
        return yield* fail('stale-delivery-ref', 'This delivery reference has no matching canonical receipt.');
      unwrapCycle(
        yield* inCheckout(
          runWorkflowAutomation(
            config,
            cycleRequest(stored, {
              command: 'record-delivery',
              phaseId: ref.phaseId,
              delivery: receipt,
              expectedRevision: stored.revision,
            }),
          ),
          checkout,
        ),
      );
      const latest = yield* readNativeWorkflowState(config, request.runId);
      const persisted = latest?.state.cycle?.state.phases[ref.phaseId]?.delivery;
      if (!persisted || stableJson(persisted) !== stableJson(receipt))
        return yield* fail('delivery-not-recorded', 'The canonical local delivery receipt was not persisted.');
      return {status: 'delivered', replayed: false, deliveryRef, receipt: persisted};
    }

    if (request.command === 'deliver-commit')
      return yield* runNativeTaskCommitDelivery(config, request, stored, checkout, runtime);

    if (request.command === 'deliver-pr')
      return yield* runNativeTaskPrDelivery(config, request, stored, checkout, runtime);

    if (request.command === 'watch-pr') return yield* runNativeTaskPrWatch(config, request, stored, checkout);

    if (request.command === 'work') {
      const view = yield* readNativeTaskView(config, {
        runId: request.runId,
        callerCwd: checkout,
        role: 'implementation',
      });
      if (view.status !== 'ready' || view.next.action !== 'implement' || !view.next.phaseId)
        return yield* fail(
          'task-not-ready',
          EffectArray.join(view.missingInputs, ' ') || 'Follow the current native task action.',
        );
      const phaseId = view.next.phaseId;
      let current = yield* readNativeWorkflowState(config, request.runId);
      if (!current?.state.cycle) return yield* fail('cycle-not-found', 'This run has no admitted native cycle.');
      if (!current.state.cycle.baselines[phaseId]) {
        unwrapCycle(
          yield* inCheckout(
            runWorkflowAutomation(
              config,
              cycleRequest(current, {
                command: 'begin-phase',
                phaseId,
                expectedRevision: current.revision,
              }),
            ),
            checkout,
          ),
        );
        current = yield* readNativeWorkflowState(config, request.runId);
      }
      if (!current?.state.cycle) return yield* fail('cycle-not-found', 'This run has no admitted native cycle.');
      const proofResult = yield* inCheckout(
        runWorkflowAutomation(config, {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'graph-ready',
          runId: current.state.runId,
          generation: current.state.generation,
        }),
        checkout,
      );
      const proofValue: unknown = proofResult;
      if (!Predicate.isObject(proofValue) || proofValue.status !== 'ok' || !Predicate.isObject(proofValue.graph))
        return yield* fail(
          'graph-not-ready',
          'A current ready graph proof is required before dispatching implementation.',
        );
      const graph = proofValue.graph;
      if (graph.state !== 'ready' || graph.dirty !== false || typeof graph.head !== 'string')
        return yield* fail(
          'graph-not-ready',
          'A clean current ready graph proof is required before dispatching implementation.',
        );
      const tree = yield* gitValue(['rev-parse', 'HEAD^{tree}'], checkout);
      if (!tree) return yield* fail('source-unavailable', 'Could not read the current source tree.');
      const source = yield* inCheckout(
        Effect.gen(function* () {
          const git = yield* makeWorkflowGitAdapter();
          return yield* git.inspect(checkout, [
            ...new Set(EffectArray.map(request.packet.anchors, anchor => anchor.path)),
          ]);
        }),
        checkout,
      );
      if (source.head !== graph.head || source.tree !== tree)
        return yield* fail('source-drift', 'Source changed while deriving task anchor evidence.');
      const packetAnchors = EffectArray.map(request.packet.anchors, anchor => {
        const sha256 = source.files[anchor.path];
        if (sha256 === undefined) throw fail('invalid-anchor', `Could not derive checkout bytes for ${anchor.path}.`);
        return {...anchor, sha256};
      });
      const packet = unwrapCycle(
        yield* inCheckout(
          runWorkflowAutomation(
            config,
            cycleRequest(current, {
              command: 'packet',
              phaseId,
              packet: {...request.packet, anchors: packetAnchors, graphProof: {...graph, tree}},
            }),
          ),
          checkout,
        ),
      );
      if (packet.available !== true)
        return yield* fail(
          'packet-unavailable',
          typeof packet.reason === 'string' ? packet.reason : 'The packet is unavailable.',
        );
      const latest = yield* readNativeWorkflowState(config, request.runId);
      const baseline = requireEffectValue(
        latest?.state.cycle?.baselines[phaseId],
        'The phase baseline is unavailable.',
      );
      const phaseHash = requireEffectValue(
        latest?.state.cycle?.state.phases[phaseId]?.phaseHash,
        'The phase contract is unavailable.',
      );
      const workRef = encodeNativeTaskActionRef({
        version: 1,
        kind: 'work',
        runId: request.runId,
        generationHash: sha256HexSync(latest!.state.generation),
        stateRevision: latest!.revision,
        phaseId,
        phaseHash,
        baselineHead: baseline.head,
        baselineTree: baseline.tree,
        baselineRef: baseline.pinnedRef,
        sourceHead: graph.head,
        sourceTree: tree,
        payloadDigest: sha256HexSync(JSON.stringify(request.packet)),
      });
      return {status: 'ready', phaseId, workRef, packet};
    }

    if (request.command === 'requalify-base-snapshot') {
      const ref = decodeNativeTaskActionRef(request.snapshotRef);
      const generationHash = sha256HexSync(stored.state.generation);
      if (
        !ref ||
        ref.kind !== 'snapshot' ||
        ref.runId !== request.runId ||
        ref.generationHash !== generationHash ||
        !ref.phaseId ||
        !ref.phaseHash ||
        !ref.snapshotId ||
        !ref.sourceHead ||
        !ref.sourceTree ||
        !ref.baselineHead ||
        !ref.baselineTree ||
        !ref.baselineRef
      )
        return yield* fail('invalid-snapshot-ref', 'Select the exact reviewed predecessor from the current task view.');
      if (!EffectString.trim(request.reason) || !EffectString.trim(request.userAuthority))
        return yield* fail(
          'invalid-base-requalification',
          'Provide the concrete requalification reason and caller-provided human authority statement; actor identity is not independently authenticated.',
        );
      const phaseEntries = EffectArray.filter(runtime.snapshots, item => item.snapshot.snapshotId === ref.snapshotId);
      const entry = phaseEntries[0];
      const baseline = runtime.baselines[ref.phaseId];
      if (
        phaseEntries.length !== 1 ||
        !entry ||
        !baseline ||
        entry.snapshot.phaseId !== ref.phaseId ||
        entry.snapshot.phaseHash !== ref.phaseHash ||
        entry.snapshot.head !== ref.sourceHead ||
        entry.snapshot.tree !== ref.sourceTree ||
        baseline.head !== ref.baselineHead ||
        baseline.tree !== ref.baselineTree ||
        baseline.pinnedRef !== ref.baselineRef
      )
        return yield* fail(
          'stale-snapshot-ref',
          'The predecessor reference does not match one canonical snapshot and baseline.',
        );
      const existingId = requalificationSnapshotId(
        request.runId,
        generationHash,
        ref.phaseId,
        ref.snapshotId,
        request.reason,
        request.userAuthority,
      );
      const existing = EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === existingId);
      if (existing._tag === 'Some') {
        const admitted = existing.value;
        const qualification = admitted.snapshot.baseRequalification;
        if (
          admitted.snapshot.phaseId !== ref.phaseId ||
          (admitted.snapshot.previous ?? admitted.snapshot.supersedes) !== ref.snapshotId ||
          !qualification ||
          qualification.reason !== request.reason ||
          qualification.authority !== request.userAuthority ||
          qualification.preRebaseHead !== entry.snapshot.head ||
          qualification.priorDeclaredBaseHead !== entry.snapshot.declaredBaseHead ||
          qualification.ontoHead !== admitted.snapshot.declaredBaseHead ||
          qualification.rebasedHead !== admitted.snapshot.head ||
          admitted.snapshot.acceptedHead !== admitted.snapshot.head
        )
          return yield* fail(
            'snapshot-conflict',
            'The deterministic requalification identity is bound to different evidence.',
          );
        return {
          status: 'recorded',
          replayed: true,
          snapshot: admitted,
          snapshotRef: snapshotRef(
            {
              version: 1,
              kind: 'work',
              runId: request.runId,
              generationHash,
              phaseId: ref.phaseId,
              phaseHash: admitted.snapshot.phaseHash,
              baselineHead: baseline.head,
              baselineTree: baseline.tree,
              baselineRef: baseline.pinnedRef,
            },
            admitted,
          ),
        };
      }
      const view = yield* taskView();
      if (
        view.revision !== stored.revision ||
        !isCurrentTaskTargetForRequalification(view, ref.phaseId) ||
        view.baseRequalification?.phaseId !== ref.phaseId ||
        view.baseRequalification.predecessorRef !== request.snapshotRef
      )
        return yield* fail(
          'stale-snapshot-ref',
          'Requalification requires the exact reviewed predecessor on the current eligible task view.',
        );
      if (!hasExactAcceptedFullReview(runtime, ref.phaseId, ref.snapshotId))
        return yield* fail(
          'review-history',
          'Base requalification requires the latest exact predecessor with an accepted full review.',
        );
      const planPhases = EffectArray.filter(state.plan.phases, phase => phase.id === ref.phaseId);
      const selected = planPhases[0];
      if (
        planPhases.length !== 1 ||
        !selected ||
        !hasApprovedBasePlanTransition(
          runtime,
          entry.snapshot,
          view.baseRequalification.fromBaseBranch,
          selected.baseBranch,
        )
      )
        return yield* fail(
          'invalid-base-requalification',
          'The canonical plans do not contain this reviewed-base transition.',
        );
      const witness = yield* verifyRequalificationWitness(
        checkout,
        selected.branch,
        selected.baseBranch,
        entry.snapshot.head,
        entry.snapshot.declaredBaseHead,
        view.baseRequalification.fromBaseBranch,
      );
      const result = unwrapCycle(
        yield* inCheckout(
          runWorkflowAutomation(
            config,
            cycleRequest(stored, {
              command: 'snapshot',
              phaseId: ref.phaseId,
              snapshotId: existingId,
              previous: ref.snapshotId,
              acceptedHead: witness.rebasedHead,
              reason: request.reason,
              userAuthority: request.userAuthority,
              baseRequalification: witness,
              expectedRevision: stored.revision,
            }),
          ),
          checkout,
        ),
      );
      const latest = yield* readNativeWorkflowState(config, request.runId);
      const admitted = EffectOption.getOrUndefined(
        EffectArray.findFirst(latest?.state.cycle?.snapshots ?? [], item => item.snapshot.snapshotId === existingId),
      );
      if (!admitted || latest?.revision === stored.revision)
        return yield* fail('snapshot-not-recorded', 'The canonical requalified snapshot was not persisted.');
      return {
        status: 'recorded',
        replayed: false,
        snapshot: admitted,
        snapshotRef: snapshotRef(
          {
            version: 1,
            kind: 'work',
            runId: request.runId,
            generationHash,
            phaseId: ref.phaseId,
            phaseHash: admitted.snapshot.phaseHash,
            baselineHead: baseline.head,
            baselineTree: baseline.tree,
            baselineRef: baseline.pinnedRef,
          },
          admitted,
        ),
        cycle: result,
      };
    }

    if (request.command === 'supersede-unreviewed-snapshot') {
      const ref = decodeNativeTaskActionRef(request.snapshotRef);
      if (
        !ref ||
        ref.kind !== 'snapshot' ||
        ref.runId !== request.runId ||
        ref.generationHash !== sha256HexSync(stored.state.generation) ||
        !ref.phaseId ||
        !ref.phaseHash ||
        !ref.snapshotId ||
        !ref.sourceHead ||
        !ref.sourceTree ||
        !ref.baselineHead ||
        !ref.baselineTree ||
        !ref.baselineRef
      )
        return yield* fail('invalid-snapshot-ref', 'Use the exact reference for the unreviewed snapshot to supersede.');
      const entry = EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === ref.snapshotId),
      );
      if (state.plan.delivery !== 'local' && state.plan.delivery !== 'commit' && state.plan.delivery !== 'pr')
        return yield* fail('task-scope', 'Snapshot recovery supports approved local, commit, or PR delivery plans.');
      const snapshotId = `superseded-${sha256HexSync(stableJson([ref.snapshotId, request.reason]))}`;
      const alreadyAdmitted = EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === snapshotId);
      const exactReplay =
        alreadyAdmitted._tag === 'Some' &&
        alreadyAdmitted.value.snapshot.supersedes === ref.snapshotId &&
        alreadyAdmitted.value.snapshot.unreviewedSupersession?.reason === request.reason;
      const baseline = runtime.baselines[ref.phaseId];
      const latest = EffectArray.filter(runtime.snapshots, item => item.snapshot.phaseId === ref.phaseId).at(-1);
      if (
        !entry ||
        entry.snapshot.phaseId !== ref.phaseId ||
        entry.snapshot.phaseHash !== ref.phaseHash ||
        entry.snapshot.head !== ref.sourceHead ||
        entry.snapshot.tree !== ref.sourceTree ||
        !baseline ||
        baseline.head !== ref.baselineHead ||
        baseline.tree !== ref.baselineTree ||
        baseline.pinnedRef !== ref.baselineRef ||
        state.phases[ref.phaseId]?.phaseHash !== ref.phaseHash ||
        state.phases[ref.phaseId]?.status !== 'pending' ||
        (latest?.snapshot.snapshotId !== ref.snapshotId && !exactReplay)
      )
        return yield* fail('stale-snapshot-ref', 'The exact snapshot is no longer the current phase predecessor.');
      if (EffectArray.some(runtime.reviews, item => item.snapshotId === ref.snapshotId))
        return yield* fail('review-history', 'Only an unreviewed snapshot can use supersession recovery.');
      const currentTask = yield* readNativeTaskView(config, {
        runId: request.runId,
        callerCwd: checkout,
        role: 'review',
      });
      if (
        currentTask.revision !== stored.revision ||
        currentTask.status !== 'ready' ||
        currentTask.next.action !== 'review' ||
        currentTask.next.phaseId !== ref.phaseId ||
        (currentTask.next.snapshotId !== ref.snapshotId &&
          !(exactReplay && currentTask.next.snapshotId === snapshotId)) ||
        currentTask.phase?.snapshot?.snapshotId !== currentTask.next.snapshotId
      )
        return yield* fail(
          'stale-snapshot-ref',
          'Recovery requires the exact unreviewed snapshot on the current phase review card.',
        );
      const head = yield* gitValue(['rev-parse', 'HEAD'], checkout);
      if (!head) return yield* fail('source-unavailable', 'Could not read the current source head.');
      const result = unwrapCycle(
        yield* inCheckout(
          runWorkflowAutomation(
            config,
            cycleRequest(stored, {
              command: 'snapshot',
              phaseId: ref.phaseId,
              snapshotId,
              previous: ref.snapshotId,
              supersedeUnreviewed: true,
              acceptedHead: head,
              reason: request.reason,
              expectedRevision: stored.revision,
            }),
          ),
          checkout,
        ),
      );
      return {
        status: 'recorded',
        replayed: alreadyAdmitted._tag === 'Some',
        snapshot: result.snapshot,
        snapshotRef: snapshotRef(ref, result.snapshot),
      };
    }

    const ref = decodeNativeTaskActionRef(request.workRef);
    if (
      !ref ||
      ref.kind !== 'work' ||
      ref.runId !== request.runId ||
      ref.generationHash !== sha256HexSync(stored.state.generation) ||
      !ref.phaseId ||
      !ref.phaseHash ||
      !ref.baselineHead ||
      !ref.baselineTree ||
      !ref.baselineRef
    )
      return yield* fail('invalid-work-ref', 'Restart with the current implementation packet for this run.');
    const snapshotId = nativeTaskSnapshotId(request.workRef);
    const admitted = EffectOption.getOrUndefined(
      EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === snapshotId),
    );
    if (admitted) {
      if (admitted.snapshot.phaseId !== ref.phaseId || admitted.snapshot.phaseHash !== ref.phaseHash)
        return yield* fail(
          'snapshot-conflict',
          'This task reference is already bound to different canonical snapshot evidence.',
        );
      return {status: 'recorded', replayed: true, snapshot: admitted, snapshotRef: snapshotRef(ref, admitted)};
    }
    const baseline = runtime.baselines[ref.phaseId];
    if (
      !baseline ||
      baseline.head !== ref.baselineHead ||
      baseline.tree !== ref.baselineTree ||
      baseline.pinnedRef !== ref.baselineRef ||
      state.phases[ref.phaseId]?.phaseHash !== ref.phaseHash ||
      stored.revision !== ref.stateRevision
    )
      return yield* fail('stale-work-ref', 'This packet is no longer admitted. Restart with the current task view.');
    const view = yield* readNativeTaskView(config, {
      runId: request.runId,
      callerCwd: checkout,
      role: 'implementation',
    });
    if (view.status !== 'ready' || view.next.action !== 'implement' || view.next.phaseId !== ref.phaseId)
      return yield* fail(
        'task-not-ready',
        EffectArray.join(view.missingInputs, ' ') || 'Follow the current native task action.',
      );
    const head = yield* gitValue(['rev-parse', 'HEAD'], checkout);
    if (!head) return yield* fail('source-unavailable', 'Could not read the current source head.');
    const previous = EffectArray.filter(runtime.snapshots, item => item.snapshot.phaseId === ref.phaseId).at(
      -1,
    )?.snapshot;
    if (previous && !request.reason)
      return yield* fail('review-history', 'Give a concrete reason before recording another source iteration.');
    const result = unwrapCycle(
      yield* inCheckout(
        runWorkflowAutomation(
          config,
          cycleRequest(stored, {
            command: 'snapshot',
            phaseId: ref.phaseId,
            snapshotId,
            acceptedHead: head,
            ...(previous ? {previous: previous.snapshotId} : {}),
            reason: request.reason ?? 'Record the exact worker source result for this implementation packet.',
            expectedRevision: stored.revision,
          }),
        ),
        checkout,
      ),
    );
    return {
      status: 'recorded',
      replayed: false,
      snapshot: result.snapshot,
      snapshotRef: snapshotRef(ref, result.snapshot),
    };
  });
