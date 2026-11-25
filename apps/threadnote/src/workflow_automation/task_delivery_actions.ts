import {
  NativeCycleDeliverySchema,
  type NativeCycleDelivery,
  nextNativeCycle,
  nativeCyclePublicationField,
  type NativeCycleValidation,
} from '@threadnote/workflow-automations/cycle';
import {
  nativeCycleCoverage,
  nativeCycleCoverageAccepts,
  nativeCycleLatestSnapshot,
  nativeCycleReviewBasis,
} from '@threadnote/workflow-automations/cycle-runtime';
import {validateNativeCycleReview} from '@threadnote/workflow-automations/cycle-review';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runCommandEffect} from '@threadnote/platform/command';
import {Cause, Effect, Array as EffectArray, FileSystem, Option, Path, Predicate, Schema} from 'effect';
import * as Clock from 'effect/Clock';
import * as EffectString from 'effect/String';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {
  bindNativeCycleDeliveryBase,
  CurrentNativeMaintenanceProof,
  CurrentNativeTerminalDeliveryWatch,
  nativeMaintenanceProofError,
  readNativeCycleGitProof,
  verifyNativeCycleDeliveryRepository,
  verifyNativePrRepository,
  verifyNativeCyclePrDeliveryIdentity,
} from './cycle_delivery.js';
import {captureNativeCycleSource} from './cycle_git.js';
import {runWorkflowAutomation} from './index.js';
import {stopSupersededStandalonePrWatch} from './standalone_pr_watch.js';
import {readNativeWorkflowRevision, readNativeWorkflowState, withNativeWorkflowLock} from './store.js';
import {readNativeTaskView} from './task.js';
import {runNativeWatch} from './watch.js';
import {
  runNativePrWatchOperation,
  readNativeTaskPhaseWatchIds,
  readNativeTaskPhaseWatch,
  resolveNativeTaskPrWatch,
} from './task_pr_watch.js';
import {
  discoverNativeWatchCodexExecutable,
  nativeWatchHostRegistrationHint,
  resolveNativeWatchSessionWakeup,
} from './watch_notification.js';
import {
  isNativeWatchSessionWakeup,
  nativeWatchWakeupMatches,
  type NativeWatchWakeup,
} from './watch_notification_state.js';
import {readNativeWatch, withNativeWatchControlLock} from './watch_store.js';

import type {NativeTaskCycleRuntime, NativeTaskStoredState} from './task_action_helpers.js';
import {cycleRequest, fail, inCheckout, unwrapCycle} from './task_action_helpers.js';
import {nativeWorkflowError} from './memory.js';
import type {NativeTaskActionRequest} from './task_actions.js';
import {runNativeTaskCandidateWatch} from './task_candidate_watch.js';
import {runNativeTaskSupplementalPublication} from './task_supplemental_publication.js';

export const runNativeTaskCommitDelivery = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'deliver-commit'}>,
  stored: NativeTaskStoredState,
  checkout: string,
  runtime: NativeTaskCycleRuntime,
) =>
  Effect.gen(function* () {
    const state = runtime.state;
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
        'Use the current canonical validation reference for commit delivery.',
      );
    if (state.plan.delivery !== 'commit')
      return yield* fail('delivery-scope', 'This task action supports commit delivery only.');
    const proof = state.phases[ref.phaseId];
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
      return yield* fail('snapshot-ambiguous', 'Commit delivery needs one unique canonical reviewed snapshot.');
    if (!proof || proof.phaseHash !== ref.phaseHash || proof.tree !== ref.sourceTree)
      return yield* fail('stale-validation-ref', 'The reference does not match current canonical phase validation.');
    const existingReceipt = proof.delivery;
    if (existingReceipt) {
      const existingDigest = sha256HexSync(stableJson(existingReceipt));
      if (
        existingReceipt.delivery !== 'commit' ||
        existingReceipt.phaseId !== ref.phaseId ||
        existingReceipt.phaseHash !== ref.phaseHash ||
        existingReceipt.validatedTree !== ref.sourceTree ||
        existingReceipt.commitEvidence !== request.commitEvidence ||
        (ref.kind === 'delivery' && ref.payloadDigest !== existingDigest)
      )
        return yield* fail('delivery-conflict', 'The phase already has a different canonical delivery receipt.');
      const deliveryRef = encodeNativeTaskActionRef({...ref, kind: 'delivery', payloadDigest: existingDigest});
      return {status: 'delivered', replayed: true, deliveryRef, receipt: existingReceipt, next: nextNativeCycle(state)};
    }
    const validationDigest = proof.validation ? sha256HexSync(stableJson(proof.validation)) : undefined;
    if (
      !proof.validation ||
      proof.head !== (proof.validation.head ?? ref.sourceHead) ||
      (ref.kind === 'validation' && validationDigest !== ref.payloadDigest)
    )
      return yield* fail('stale-validation-ref', 'The reference does not match current canonical phase validation.');
    if (ref.kind === 'delivery')
      return yield* fail('stale-delivery-ref', 'This delivery reference has no matching canonical receipt.');
    const readinessResult = yield* inCheckout(
      runWorkflowAutomation(config, cycleRequest(stored, {command: 'publication-ready', phaseId: ref.phaseId})),
      checkout,
    );
    const readinessValue: unknown = readinessResult;
    const readinessObject = Predicate.isObject(readinessValue) ? readinessValue : undefined;
    const readinessCycle =
      readinessObject && Predicate.isObject(readinessObject.cycle) ? readinessObject.cycle : undefined;
    const readinessHead = readinessCycle && typeof readinessCycle.head === 'string' ? readinessCycle.head : undefined;
    if (
      !readinessObject ||
      readinessObject.status !== 'ok' ||
      !readinessCycle ||
      readinessCycle.revision !== stored.revision ||
      !readinessHead ||
      readinessCycle.tree !== proof.tree
    )
      return yield* fail('source-drift', 'Commit delivery requires the exact clean validated source tree and branch.');
    const readiness = {head: readinessHead};
    const receipt = yield* Schema.decodeEffect(NativeCycleDeliverySchema, {onExcessProperty: 'error'})({
      phaseId: ref.phaseId,
      phaseHash: ref.phaseHash,
      delivery: 'commit',
      headSha: readiness.head,
      validatedTree: proof.tree,
      commitEvidence: request.commitEvidence,
    }).pipe(
      Effect.mapError(() =>
        fail('invalid-commit-receipt', 'The supplied commit evidence is not a valid canonical receipt.'),
      ),
    );
    const deliveryDigest = sha256HexSync(stableJson(receipt));
    const deliveryRef = encodeNativeTaskActionRef({...ref, kind: 'delivery', payloadDigest: deliveryDigest});
    // The cycle executor independently verifies clean source, exact validated tree,
    // declared branch, phase eligibility, and revision before it persists the receipt.
    const result = yield* inCheckout(
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
    );
    const cycle = unwrapCycle(result);
    const latest = yield* readNativeWorkflowState(config, request.runId);
    const persisted = latest?.state.cycle?.state.phases[ref.phaseId]?.delivery;
    if (!persisted || stableJson(persisted) !== stableJson(receipt))
      return yield* fail('delivery-not-recorded', 'The canonical commit receipt was not persisted exactly.');
    return {status: 'delivered', replayed: false, deliveryRef, receipt: persisted, next: cycle.next};
  });

export const runNativeTaskPrDelivery = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'deliver-pr'}>,
  stored: NativeTaskStoredState,
  checkout: string,
  runtime: NativeTaskCycleRuntime,
) =>
  Effect.gen(function* () {
    const state = runtime.state;
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
      return yield* fail('invalid-validation-ref', 'Use the current canonical validation reference for PR delivery.');
    if (state.plan.delivery !== 'pr')
      return yield* fail('delivery-scope', 'This task action supports PR delivery only.');
    const matchingPhases = EffectArray.filter(state.plan.phases, item => item.id === ref.phaseId);
    const phase = matchingPhases.length === 1 ? matchingPhases[0] : undefined;
    const proof = state.phases[ref.phaseId];
    const validationDigest = proof?.validation ? sha256HexSync(stableJson(proof.validation)) : undefined;
    if (
      !phase ||
      !proof?.validation ||
      proof.phaseHash !== ref.phaseHash ||
      proof.head !== (proof.validation.head ?? ref.sourceHead) ||
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
      return yield* fail('snapshot-ambiguous', 'PR delivery needs one unique canonical reviewed snapshot.');
    if (request.pr.branch !== phase.branch)
      return yield* fail('pr-source-mismatch', 'The supplied PR head and branch must match the validated phase.');
    const userAuthority = request.userAuthority ?? proof.delivery?.userAuthority;
    // A replay that omits publication keeps the stored receipt's publication, like its authority.
    const publication = request.publication ?? proof.delivery?.publication;
    if (!proof.delivery && !EffectString.trim(userAuthority ?? ''))
      return yield* fail(
        'user-authority-required',
        'Provide caller-provided userAuthority quoting the actual existing approval for this PR delivery; publication evidence is separate.',
      );
    // A tree validated dirty gets its commit only after validation. The cycle executor accepts a clean HEAD that
    // carries the exact validated tree and descends from the snapshot head, so the PR binds to that commit.
    let deliveryHead = proof.head;
    if (!proof.delivery) {
      const sourceReady = unwrapCycle(
        yield* inCheckout(
          runWorkflowAutomation(
            config,
            cycleRequest(stored, {
              command: 'publication-ready',
              phaseId: ref.phaseId,
              ...nativeCyclePublicationField(publication),
            }),
          ),
          checkout,
        ),
      );
      if (typeof sourceReady.head !== 'string' || sourceReady.tree !== proof.tree)
        return yield* fail(
          'source-drift',
          'Existing PR adoption needs the exact clean validated source before provider verification.',
        );
      deliveryHead = sourceReady.head;
    }
    if (request.pr.headSha !== deliveryHead)
      return yield* fail('pr-source-mismatch', 'The supplied PR head and branch must match the validated phase.');
    const supplied = {
      phaseId: ref.phaseId,
      phaseHash: ref.phaseHash,
      delivery: 'pr' as const,
      headSha: deliveryHead,
      validatedTree: proof.tree,
      commitEvidence: request.commitEvidence,
      pr: request.pr,
      ...nativeCyclePublicationField(publication),
    };
    const providerIdentity = proof.delivery
      ? proof.delivery.providerIdentity
      : yield* verifyNativeCyclePrDeliveryIdentity(checkout, supplied);
    const receipt = yield* Schema.decodeEffect(NativeCycleDeliverySchema, {onExcessProperty: 'error'})({
      ...(userAuthority ? {userAuthority} : {}),
      ...(providerIdentity ? {providerIdentity} : {}),
      phaseId: ref.phaseId,
      phaseHash: ref.phaseHash,
      delivery: 'pr',
      headSha: deliveryHead,
      validatedTree: proof.tree,
      commitEvidence: request.commitEvidence,
      pr: request.pr,
      ...nativeCyclePublicationField(publication),
    }).pipe(
      Effect.mapError(() => fail('invalid-pr-receipt', 'The supplied PR evidence is not a valid canonical receipt.')),
    );
    const deliveryDigest = sha256HexSync(stableJson(receipt));
    if (proof.delivery) {
      const storedReceipt = proof.delivery;
      const storedPr = storedReceipt.pr;
      const suppliedPr = receipt.pr;
      const samePhysicalReceipt =
        storedPr !== undefined &&
        suppliedPr !== undefined &&
        stableJson({...storedPr, baseRefBinding: undefined}) === stableJson(suppliedPr);
      if (
        !samePhysicalReceipt ||
        storedReceipt.delivery !== receipt.delivery ||
        storedReceipt.phaseId !== receipt.phaseId ||
        storedReceipt.phaseHash !== receipt.phaseHash ||
        storedReceipt.headSha !== receipt.headSha ||
        storedReceipt.validatedTree !== receipt.validatedTree ||
        storedReceipt.commitEvidence !== receipt.commitEvidence ||
        stableJson(storedReceipt.publication) !== stableJson(receipt.publication) ||
        storedReceipt.userAuthority !== receipt.userAuthority ||
        stableJson(storedReceipt.providerIdentity) !== stableJson(receipt.providerIdentity) ||
        (ref.kind === 'delivery' && ref.payloadDigest !== sha256HexSync(stableJson(storedReceipt)))
      )
        return yield* fail('delivery-conflict', 'The phase already has a different canonical delivery receipt.');
      return {
        status: 'delivered',
        replayed: true,
        deliveryRef: encodeNativeTaskActionRef({
          ...ref,
          kind: 'delivery',
          payloadDigest: sha256HexSync(stableJson(storedReceipt)),
        }),
        receipt: storedReceipt,
        next: 'complete',
      };
    }
    if (ref.kind === 'delivery')
      return yield* fail('stale-delivery-ref', 'This delivery reference has no matching canonical receipt.');
    const task = yield* readNativeTaskView(config, {runId: request.runId, callerCwd: checkout, role: 'delivery'});
    if (task.status !== 'ready' || task.next.action !== 'deliver' || task.next.phaseId !== ref.phaseId)
      return yield* fail('task-not-ready', 'Follow the current delivery task card before publishing this phase.');
    const deliveryRef = encodeNativeTaskActionRef({
      ...ref,
      kind: 'delivery',
      payloadDigest: deliveryDigest,
      delivery: receipt,
    });
    yield* verifyNativeCyclePrDeliveryIdentity(checkout, receipt);
    if (request.pr.state === 'open') yield* bindNativeCycleDeliveryBase(checkout, phase.baseBranch, receipt);
    const afterIdentity = unwrapCycle(
      yield* inCheckout(
        runWorkflowAutomation(
          config,
          cycleRequest(stored, {
            command: 'publication-ready',
            phaseId: ref.phaseId,
            ...nativeCyclePublicationField(publication),
          }),
        ),
        checkout,
      ),
    );
    const latestBeforeDelivery = yield* readNativeWorkflowState(config, request.runId);
    if (
      afterIdentity.head !== deliveryHead ||
      afterIdentity.tree !== proof.tree ||
      latestBeforeDelivery?.revision !== stored.revision
    )
      return yield* fail('source-drift', 'Source or canonical task changed during remote PR verification.');
    if (request.pr.state === 'open') {
      return {
        status: 'watch-required',
        replayed: false,
        deliveryRef,
        phaseId: phase.id,
        pr: request.pr,
        ...nativeCyclePublicationField(publication),
        commitEvidence: request.commitEvidence,
        next: {
          action: 'watch-pr',
          operation: 'start',
          runId: request.runId,
          phaseId: phase.id,
          validationRef: request.validationRef,
          deliveryRef,
          expectedConsumer: `Start a task-bound watch with these fields and the host wakeup; the PR and head are in pr. A successful start records the delivery. ${nativeWatchHostRegistrationHint}`,
        },
      };
    }
    const finalReceipt = receipt;
    const result = unwrapCycle(
      yield* inCheckout(
        runWorkflowAutomation(
          config,
          cycleRequest(stored, {
            command: 'record-delivery',
            phaseId: ref.phaseId,
            delivery: finalReceipt,
            ...nativeCyclePublicationField(publication),
            expectedRevision: stored.revision,
          }),
        ),
        checkout,
      ),
    );
    const latest = yield* readNativeWorkflowState(config, request.runId);
    const persisted = latest?.state.cycle?.state.phases[ref.phaseId]?.delivery;
    if (
      !persisted ||
      !persisted.pr ||
      stableJson({...persisted, pr: {...persisted.pr, baseRefBinding: undefined}}) !== stableJson(finalReceipt)
    )
      return yield* fail('delivery-not-recorded', 'The canonical PR receipt and authority readback do not match.');
    const persistedRef = encodeNativeTaskActionRef({
      ...ref,
      kind: 'delivery',
      payloadDigest: sha256HexSync(stableJson(persisted)),
      delivery: persisted,
    });
    return {status: 'delivered', replayed: false, deliveryRef: persistedRef, receipt: persisted, next: result.next};
  });

type StoredWatch = NonNullable<Effect.Success<ReturnType<typeof readNativeWatch>>>;

/** Delivery moves the validation to the commit that carries its tree, so an earlier reference names it before that. */
const validationRefMatches = (
  proof: {readonly validation?: NativeCycleValidation; readonly delivery?: unknown},
  digest: string | undefined,
  sourceHead: string | undefined,
) => {
  if (!proof.validation) return false;
  const {head: _head, ...unbound} = proof.validation;
  const forms =
    proof.delivery === undefined ? [proof.validation] : [proof.validation, unbound, {...unbound, head: sourceHead}];
  return EffectArray.some(forms, form => sha256HexSync(stableJson(form)) === digest);
};
const maintenanceMarker =
  /;maintenance-proof:([A-Za-z0-9._-]+):([A-Za-z0-9._-]+):([A-Za-z0-9._-]+):([a-f0-9]{64}):[a-f0-9]{64}(?=;host-receipt:)/u;

const verifyNativeTaskMaintenance = Effect.fn('workflowAutomation.task.verifyMaintenance')(function* (
  config: RuntimeConfig,
  originRunId: string,
  checkout: string,
  published: NativeCycleDelivery,
  maintainedHead: string,
  reference: string,
) {
  const invalid = nativeMaintenanceProofError;
  const ref = decodeNativeTaskActionRef(reference);
  if (
    ref?.kind !== 'validation' ||
    ref.runId === originRunId ||
    !ref.phaseId ||
    !ref.phaseHash ||
    !ref.snapshotId ||
    !ref.sourceHead ||
    !ref.sourceTree ||
    !published.pr
  )
    return yield* invalid('Use an exact validation reference from a separate reviewed maintenance task.');
  const donor = yield* readNativeWorkflowState(config, ref.runId).pipe(
    Effect.mapError(() => invalid('The canonical maintenance task state could not be read.')),
  );
  const runtime = donor?.state.cycle;
  const phase = runtime?.state.phases[ref.phaseId];
  if (
    !donor ||
    !runtime ||
    ref.generationHash !== sha256HexSync(donor.state.generation) ||
    runtime.state.plan.delivery !== 'commit' ||
    phase?.delivery?.delivery !== 'commit' ||
    phase.status !== 'published' ||
    phase.phaseHash !== ref.phaseHash ||
    phase.head !== maintainedHead ||
    phase.head !== ref.sourceHead ||
    phase.tree !== ref.sourceTree ||
    phase.tree === published.validatedTree ||
    phase.delivery.headSha !== maintainedHead ||
    phase.delivery.validatedTree !== phase.tree ||
    !phase.delivery.commitEvidence ||
    !phase.validation ||
    phase.validation.waiverId !== undefined ||
    phase.validation.snapshotTree !== phase.tree ||
    phase.validation.reviewTree !== phase.tree ||
    !validationRefMatches(phase, ref.payloadDigest, ref.sourceHead)
  )
    return yield* invalid('The maintenance task does not retain the exact unwaived validation and commit delivery.');
  const source = nativeCycleLatestSnapshot(runtime, ref.phaseId, ref.phaseHash);
  const snapshot = source?.snapshot;
  const comparison = snapshot?.comparisonEvidence;
  if (
    !source ||
    !snapshot ||
    snapshot.snapshotId !== ref.snapshotId ||
    snapshot.head !== maintainedHead ||
    snapshot.tree !== phase.tree ||
    snapshot.dirty === true ||
    source.incoming.length !== 0 ||
    !snapshot.pinnedRef ||
    !comparison ||
    snapshot.declaredBaseHead !== published.headSha ||
    snapshot.scopeBase !== comparison.baseTree ||
    comparison.baseTree !== published.validatedTree
  )
    return yield* invalid(
      'The current maintenance snapshot must pin the original delivered PR head as its comparison base.',
    );
  const coverage = nativeCycleCoverage(runtime, snapshot);
  if (coverage._tag !== 'reviewed' || coverage.match !== 'exact' || coverage.blocked || coverage.blockingWaiver)
    return yield* invalid('The exact maintenance snapshot needs independent review with no blocker or waiver.');
  yield* Effect.try({
    try: () => validateNativeCycleReview(snapshot, coverage.review, nativeCycleReviewBasis(runtime, snapshot)),
    catch: () => invalid('The maintenance snapshot does not have a valid independent review.'),
  });
  const git = (repo: string, args: readonly string[], maxOutputBytes?: number) =>
    readNativeCycleGitProof(repo, args, undefined, maxOutputBytes).pipe(
      Effect.flatMap(result =>
        result.exitCode !== 0 || EffectString.trim(result.stderr)
          ? Effect.fail(invalid('Git could not verify the maintenance checkout.'))
          : Effect.succeed(EffectString.trim(result.stdout)),
      ),
      Effect.mapError(() => invalid('Git could not verify the maintenance checkout.')),
    );
  const fs = yield* FileSystem.FileSystem;
  const realPath = (path: string) =>
    fs.realPath(path).pipe(Effect.mapError(() => invalid('The canonical maintenance checkout is unavailable.')));
  const commonDir = (repo: string) =>
    git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).pipe(Effect.flatMap(realPath));
  const expectedCommonDir = yield* commonDir(checkout);
  const sourceObjects = [
    'HEAD',
    'HEAD^{tree}',
    comparison.baseRef,
    published.headSha + '^{tree}',
    comparison.sourceRef,
    snapshot.pinnedRef,
  ];
  const expectedObjects = [
    maintainedHead,
    phase.tree,
    published.headSha,
    comparison.baseTree,
    maintainedHead,
    phase.tree,
  ];
  const verifyLocalSource = Effect.gen(function* () {
    if ((yield* commonDir(snapshot.repo)) !== expectedCommonDir)
      return yield* invalid('The maintenance checkout belongs to a different Git repository.');
    // Git status can omit entries whose index flags mask worktree changes. Refuse that view.
    const tracked = yield* git(snapshot.repo, ['-c', 'core.quotePath=true', 'ls-files', '-v'], 4 * 1024 * 1024);
    if (/^(?:S|[a-z]) /mu.test(tracked))
      return yield* invalid('The maintenance index must not mask tracked worktree changes.');
    const status = yield* git(snapshot.repo, [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.trustctime=true',
      '-c',
      'core.checkStat=default',
      '-c',
      'core.ignoreStat=false',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]);
    if (status !== '') return yield* invalid('The maintenance checkout must remain clean.');
    const objects = yield* git(snapshot.repo, ['rev-parse', '--revs-only', '--end-of-options', ...sourceObjects]);
    if (EffectArray.join(EffectString.split(objects, /\r?\n/u), '\n') !== EffectArray.join(expectedObjects, '\n'))
      return yield* invalid('The maintenance checkout must retain the exact pinned source, tree, and comparison base.');
  });
  yield* verifyLocalSource;
  yield* verifyNativePrRepository(snapshot.repo, published.pr.url).pipe(
    Effect.mapError(() => invalid('The maintenance checkout does not bind the same GitHub repository.')),
  );
  const captured = yield* captureNativeCycleSource(snapshot.repo, 'HEAD').pipe(
    Effect.mapError(() => invalid('The maintenance checkout could not be independently captured.')),
  );
  if (captured.head !== maintainedHead || captured.tree !== phase.tree)
    return yield* invalid('The maintenance checkout must remain clean at the reviewed committed source.');
  // The caller holds the donor run lock across this fence and the target state write.
  const recheck = Effect.gen(function* () {
    const revision = yield* readNativeWorkflowRevision(config, ref.runId).pipe(
      Effect.mapError(() => invalid('The canonical maintenance task state could not be read.')),
    );
    if (revision !== donor.revision)
      return yield* invalid('The canonical maintenance validation changed before terminal delivery.');
    yield* verifyLocalSource;
  }).pipe(
    Effect.timeout('10 seconds'),
    Effect.catchIf(Cause.isTimeoutError, () => Effect.fail(invalid('The maintenance source recheck timed out.'))),
  );
  const digest = sha256HexSync(stableJson({revision: donor.revision, head: maintainedHead, tree: phase.tree}));
  const marker = `;maintenance-proof:${ref.runId}:${ref.phaseId}:${ref.snapshotId}:${sha256HexSync(reference)}:${digest}`;
  return {runId: ref.runId, head: maintainedHead, tree: phase.tree, marker, recheck};
});

const requiredWatchSources = ['comments', 'reviews', 'threads', 'checks', 'statuses'];

const watchWorkDrained = (state: StoredWatch['envelope']['state']) =>
  state.events.length === 0 &&
  state.delivery === null &&
  state.acknowledged === state.nextSequence - 1 &&
  !EffectArray.some(state.work, item => item.status === 'open' || item.status === 'blocked');

/** Retain the host receipt for the acknowledged terminal range, even if the outbox is still queued. */
const acknowledgedMergedWatchReceipt = ({state, collector, notification}: StoredWatch['envelope']) => {
  if (
    state.prState !== 'merged' ||
    collector?.status !== 'terminal' ||
    collector.reason !== 'merged' ||
    !notification ||
    notification.recoveryRequested ||
    !state.lastAck ||
    !watchWorkDrained(state)
  )
    return undefined;
  const {outbox, lastReceipt} = notification;
  const coversMergedRange = (first: number, last: number) =>
    last === state.acknowledged &&
    EffectArray.some(
      state.work,
      ({event}) =>
        event.source === 'watch' &&
        event.kind === 'merged' &&
        event.key === state.watchId &&
        !event.removed &&
        event.head === state.head &&
        event.sequence >= first &&
        event.sequence <= last,
    );
  if (outbox) {
    // An authenticated Codex arrival can claim backlog beyond its original notice range.
    const through = outbox.status === 'queued' ? Math.max(outbox.last, outbox.consumedThrough ?? 0) : outbox.last;
    return (outbox.status === 'queued' || outbox.status === 'completed') &&
      !outbox.error &&
      coversMergedRange(outbox.first, through)
      ? outbox.receipt
      : undefined;
  }
  if (!lastReceipt) return undefined;
  const [, first, last] = EffectString.split(lastReceipt.key, ':');
  return coversMergedRange(Number(first), Number(last)) ? lastReceipt.receipt : undefined;
};

const standaloneWatchRoute =
  'To monitor the PR now, call watch-pr with prUrl and the host wakeup (runId optional) for a monitor-only standalone watch.';

export const runNativeTaskPrWatch = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'watch-pr'}> & {readonly runId: string},
  stored: NativeTaskStoredState,
  checkout: string,
) =>
  Effect.gen(function* () {
    const inputWakeup = request.wakeup;
    let wakeup: NativeWatchWakeup | undefined;
    if (inputWakeup?.host === 'codex' && inputWakeup.executable) {
      wakeup = {host: 'codex', executable: inputWakeup.executable, threadId: inputWakeup.threadId};
    } else if (isNativeWatchSessionWakeup(inputWakeup) && (request.operation === 'start' || request.recoverWakeup)) {
      wakeup = yield* resolveNativeWatchSessionWakeup(inputWakeup, checkout);
    } else if (request.operation !== 'start' && inputWakeup?.host === 'codex') {
      return yield* fail(
        'invalid-request',
        'Only watch start can discover a Codex executable; renewal uses its exact registered host.',
      );
    }
    if (request.operation === 'start' && !inputWakeup)
      return yield* fail('host-registration-required', `Start needs a host wakeup. ${nativeWatchHostRegistrationHint}`);
    if (!request.validationRef && !request.deliveryRef) {
      if ((request.operation !== 'inspect' && request.operation !== 'stop') || !request.phaseId)
        return yield* fail(
          'invalid-delivery-ref',
          `Provisional watch recovery needs a phaseId and is limited to inspect or stop. ${standaloneWatchRoute}`,
        );
      const runtime = stored.state.cycle;
      const cycle = runtime?.state;
      const phases = EffectArray.filter(cycle?.plan.phases ?? [], item => item.id === request.phaseId);
      const phase = cycle?.phases[request.phaseId];
      const baseline = runtime?.baselines[request.phaseId];
      if (
        !runtime ||
        !cycle ||
        cycle.plan.delivery !== 'pr' ||
        phases.length !== 1 ||
        !phase ||
        phase.status !== 'validated' ||
        phase.delivery !== undefined ||
        !phase.phaseHash ||
        !phase.head ||
        !phase.tree ||
        !phase.validation ||
        phase.validation.status !== 'passed' ||
        phase.validation.productState !== 'working' ||
        phase.validation.snapshotTree !== phase.tree ||
        (phase.validation.head !== undefined && phase.validation.head !== phase.head) ||
        !baseline
      )
        return yield* fail(
          'provisional-watch-not-eligible',
          `No current validated provisional PR phase matches this run; Git publication alone cannot arm a workflow watch. ${standaloneWatchRoute}`,
        );
      const snapshots = EffectArray.filter(
        runtime.snapshots,
        item =>
          item.snapshot.phaseId === request.phaseId &&
          item.snapshot.phaseHash === phase.phaseHash &&
          item.snapshot.tree === phase.tree &&
          item.snapshot.repo === baseline.repo &&
          item.snapshot.baseTree === baseline.tree,
      );
      // A tree validated dirty and then committed has several snapshots; any reviewed one proves the validated tree.
      if (!EffectArray.some(snapshots, item => nativeCycleCoverageAccepts(nativeCycleCoverage(runtime, item.snapshot))))
        return yield* fail(
          'provisional-watch-not-eligible',
          `None of the ${snapshots.length} snapshots of this validated tree is reviewed. ${standaloneWatchRoute}`,
        );
      const watchIds = yield* readNativeTaskPhaseWatchIds(config, request.runId, request.phaseId);
      if (watchIds.length !== 1)
        return yield* fail(
          'watch-identity-conflict',
          'Provisional recovery needs a unique retained watch; use both exact current validation and PR delivery references.',
        );
      const {watchId, consumerId, watch} = yield* readNativeTaskPhaseWatch(
        config,
        request.runId,
        request.phaseId,
        watchIds[0],
      );
      if (
        !watch ||
        watch.envelope.state.watchId !== watchId ||
        watch.envelope.state.consumer?.id !== consumerId ||
        watch.envelope.state.consumer.wakeupId !== consumerId ||
        (watch.envelope.state.head !== undefined && watch.envelope.state.head !== phase.head)
      )
        return yield* fail('watch-identity-conflict', 'No stored watch matches this exact provisional run and phase.');
      const latest = yield* readNativeWorkflowState(config, request.runId);
      if (!latest || latest.revision !== stored.revision)
        return yield* fail('stale-task-state', 'The canonical task changed before provisional watch recovery.');
      const result = yield* runNativeWatch(config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: request.operation,
        watchId,
        consumerId,
        wakeupId: consumerId,
        expectedRevision: watch.revision,
      });
      const [after, latestAfter] = yield* Effect.all([
        readNativeWatch(config, watchId),
        readNativeWorkflowState(config, request.runId),
      ]);
      if (
        !after ||
        after.envelope.state.watchId !== watchId ||
        after.envelope.state.pr !== watch.envelope.state.pr ||
        after.envelope.state.consumer?.id !== consumerId ||
        after.envelope.state.consumer.wakeupId !== consumerId ||
        latestAfter?.revision !== stored.revision
      )
        return yield* fail(
          'watch-readback-mismatch',
          'The provisional watch or canonical task changed during recovery.',
        );
      return {
        status: 'watch-updated',
        operation: request.operation,
        watchId,
        prUrl: after.envelope.state.pr,
        headSha: after.envelope.state.head,
        revision: after.revision,
        result,
      };
    }
    if (!request.validationRef || !request.deliveryRef)
      return yield* fail(
        'invalid-delivery-ref',
        `Workflow watches need the exact current validation and PR delivery references; Git publication supplies neither. ${standaloneWatchRoute}`,
      );
    const validationRef = request.validationRef;
    const deliveryRef = request.deliveryRef;
    const validation = decodeNativeTaskActionRef(validationRef);
    const deliveryAction = decodeNativeTaskActionRef(deliveryRef);
    const embeddedDelivery = deliveryAction?.delivery;
    if (
      !validation ||
      validation.runId !== request.runId ||
      validation.kind !== 'validation' ||
      validation.generationHash !== sha256HexSync(stored.state.generation) ||
      !validation.phaseId ||
      !validation.phaseHash ||
      !validation.snapshotId ||
      !validation.sourceHead ||
      !validation.sourceTree ||
      !deliveryAction ||
      deliveryAction.kind !== 'delivery' ||
      deliveryAction.runId !== request.runId ||
      deliveryAction.phaseId !== validation.phaseId ||
      deliveryAction.generationHash !== validation.generationHash ||
      !deliveryAction.payloadDigest ||
      !embeddedDelivery ||
      sha256HexSync(stableJson(embeddedDelivery)) !== deliveryAction.payloadDigest ||
      embeddedDelivery.delivery !== 'pr' ||
      (embeddedDelivery.pr?.state !== 'open' && embeddedDelivery.pr?.state !== 'merged') ||
      embeddedDelivery.phaseId !== validation.phaseId ||
      embeddedDelivery.phaseHash !== validation.phaseHash ||
      embeddedDelivery.validatedTree !== validation.sourceTree
    )
      return yield* fail(
        'invalid-delivery-ref',
        'Use the exact current open-PR delivery reference returned by the task card.',
      );
    const runtime = stored.state.cycle;
    if (!runtime) return yield* fail('cycle-not-found', 'This task has no admitted native cycle.');
    const referencedPr = embeddedDelivery.pr;
    const currentPhase = runtime.state.phases[validation.phaseId];
    const maintenance = request.operation !== 'start' && request.operation !== 'complete';
    const deliveryMatches = (receipt: NonNullable<typeof currentPhase>['delivery']) =>
      receipt === undefined ||
      (receipt.delivery === 'pr' &&
        receipt.pr?.url === referencedPr.url &&
        receipt.pr?.headSha === referencedPr.headSha &&
        receipt.pr?.branch === referencedPr.branch &&
        receipt.pr?.baseBranch === referencedPr.baseBranch &&
        receipt.commitEvidence === embeddedDelivery.commitEvidence &&
        stableJson(receipt.publication) === stableJson(embeddedDelivery.publication) &&
        receipt.userAuthority === embeddedDelivery.userAuthority &&
        stableJson(receipt.providerIdentity) === stableJson(embeddedDelivery.providerIdentity));
    // Retained proof authorizes only maintenance of an already-bound watch. It does
    // not validate the current checkout or admit another delivery at its new HEAD.
    const phase =
      maintenance && currentPhase
        ? Option.getOrUndefined(
            EffectArray.findFirst(
              [currentPhase, ...[...(currentPhase.history ?? [])].reverse()],
              proof =>
                proof.phaseHash === validation.phaseHash &&
                proof.tree === validation.sourceTree &&
                // Before the first receipt, the PR head is the publication-ready descendant of the validated head.
                (proof.delivery === undefined || proof.head === embeddedDelivery.headSha) &&
                proof.head === (proof.validation?.head ?? validation.sourceHead) &&
                validationRefMatches(proof, validation.payloadDigest, validation.sourceHead) &&
                deliveryMatches(proof.delivery),
            ),
          )
        : currentPhase;
    const matchingSnapshots = EffectArray.filter(
      runtime.snapshots,
      item =>
        item.snapshot.snapshotId === validation.snapshotId &&
        item.snapshot.phaseId === validation.phaseId &&
        item.snapshot.phaseHash === validation.phaseHash &&
        item.snapshot.head === validation.sourceHead &&
        item.snapshot.tree === validation.sourceTree,
    );
    if (matchingSnapshots.length !== 1)
      return yield* fail('snapshot-ambiguous', 'The watch reference needs one unique canonical reviewed snapshot.');
    if (
      !phase ||
      phase.head !== (phase.validation?.head ?? validation.sourceHead) ||
      phase.tree !== validation.sourceTree ||
      phase.phaseHash !== validation.phaseHash ||
      (phase.delivery !== undefined && embeddedDelivery.headSha !== phase.head) ||
      (phase.delivery === undefined &&
        !EffectArray.some(
          runtime.state.plan.phases,
          item => item.id === validation.phaseId && item.branch === embeddedDelivery.pr?.branch,
        )) ||
      !phase.validation ||
      !validationRefMatches(phase, validation.payloadDigest, validation.sourceHead) ||
      !deliveryMatches(phase.delivery)
    )
      return yield* fail('stale-delivery-ref', 'The validated PR source changed; reload the current task card.');
    if (
      embeddedDelivery.watch !== undefined &&
      (!phase.delivery?.watch || embeddedDelivery.watch.consumerId !== phase.delivery.watch.consumerId)
    )
      return yield* fail(
        'watch-identity-conflict',
        'The supplied watch consumer does not match canonical delivery proof.',
      );
    const {watchId, consumerId, wakeupId} = yield* resolveNativeTaskPrWatch(
      config,
      request.runId,
      validation.phaseId,
      embeddedDelivery.pr.url,
      phase.delivery?.watch?.consumerId,
    );
    const admitProvisionalWatch = () =>
      Effect.gen(function* () {
        if (phase.delivery !== undefined) {
          const ready = unwrapCycle(
            yield* inCheckout(
              runWorkflowAutomation(
                config,
                cycleRequest(stored, {
                  command: 'publication-ready',
                  phaseId: validation.phaseId,
                  ...nativeCyclePublicationField(embeddedDelivery.publication),
                }),
              ),
              checkout,
            ),
          );
          if (ready.head !== embeddedDelivery.headSha || ready.tree !== validation.sourceTree)
            return yield* fail('source-drift', 'Starting a watch requires its exact clean validated source.');
          return;
        }
        if (embeddedDelivery.pr?.state !== 'open' || typeof embeddedDelivery.commitEvidence !== 'string')
          return yield* fail(
            'invalid-delivery-ref',
            'A provisional task watch needs the exact current open-PR delivery evidence.',
          );
        const admitted = yield* runNativeTaskPrDelivery(
          config,
          {
            command: 'deliver-pr',
            runId: request.runId,
            callerCwd: checkout,
            validationRef,
            commitEvidence: embeddedDelivery.commitEvidence,
            pr: embeddedDelivery.pr,
            ...nativeCyclePublicationField(embeddedDelivery.publication),
            ...(embeddedDelivery.userAuthority ? {userAuthority: embeddedDelivery.userAuthority} : {}),
          },
          stored,
          checkout,
          stored.state.cycle!,
        );
        const admittedAction = decodeNativeTaskActionRef(admitted.deliveryRef);
        const deliveryMatches =
          admittedAction?.delivery !== undefined &&
          stableJson(admittedAction.delivery) === stableJson(embeddedDelivery);
        if (
          admitted.status !== 'watch-required' ||
          !('phaseId' in admitted) ||
          admitted.phaseId !== validation.phaseId ||
          !deliveryMatches
        )
          return yield* fail(
            'stale-delivery-ref',
            'The provisional PR watch reference no longer matches independently revalidated delivery evidence.',
          );
        yield* verifyNativeCycleDeliveryRepository(checkout, admittedAction.delivery);
      });
    if (request.operation === 'start' && inputWakeup?.host === 'codex' && !inputWakeup.executable)
      wakeup = {
        host: 'codex',
        executable: yield* discoverNativeWatchCodexExecutable(),
        threadId: inputWakeup.threadId,
      };
    const validatedPhaseId = validation.phaseId;
    const watchReady = (candidate: StoredWatch, now: number, hasRetainedWatch = false) => {
      const state = candidate.envelope.state;
      const notification = candidate.envelope.notification;
      const consumer = state.consumer;
      const terminal = state.prState === 'merged';
      const consumerExpired = consumer !== null && consumer.leaseUntil <= now;
      const settledReceipt =
        consumerExpired && hasRetainedWatch && terminal
          ? acknowledgedMergedWatchReceipt(candidate.envelope)
          : undefined;
      const hostReceipt = consumerExpired
        ? settledReceipt
        : (notification?.lastReceipt?.receipt ?? notification?.outbox?.receipt);
      // The watch head is the last sweep. A merged head can descend from the delivered head; record-delivery
      // verifies that ancestry. Fresh provider verification binds an open PR head before its receipt.
      const head = terminal ? state.head : embeddedDelivery.headSha;
      const completeSources =
        state.sources.length === requiredWatchSources.length &&
        EffectArray.every(requiredWatchSources, source =>
          EffectArray.some(
            state.sources,
            item => item.source === source && item.lastCompleteAt !== undefined && item.error === undefined,
          ),
        );
      if (
        (state.prState !== 'open' && !terminal) ||
        state.pr !== referencedPr.url ||
        head === undefined ||
        (terminal && (candidate.envelope.collector?.status !== 'terminal' || !completeSources || !hostReceipt)) ||
        !consumer ||
        consumer.id !== consumerId ||
        consumer.wakeupId !== wakeupId ||
        (consumerExpired && !settledReceipt) ||
        !notification ||
        notification.consumerId !== consumer.id ||
        notification.wakeupId !== consumer.wakeupId
      )
        return undefined;
      return {consumer, hostReceipt, head};
    };
    const recordWatchedDelivery = (watch: StoredWatch, providerVerified = false) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const terminal = watch.envelope.state.prState === 'merged';
        const current = yield* readNativeWorkflowState(config, request.runId);
        if (!current?.state.cycle) return yield* fail('cycle-not-found', 'This run no longer has its canonical cycle.');
        const cycleState = current.state.cycle.state;
        const currentProof = cycleState.phases[validatedPhaseId];
        const planPhases = EffectArray.filter(cycleState.plan.phases, item => item.id === validatedPhaseId);
        if (
          planPhases.length !== 1 ||
          !currentProof ||
          currentProof.phaseHash !== validation.phaseHash ||
          // Before the first receipt, publication readiness below binds a same-tree descendant of the validated head.
          (currentProof.delivery !== undefined && currentProof.head !== embeddedDelivery.headSha) ||
          currentProof.tree !== validation.sourceTree ||
          !currentProof.validation ||
          currentProof.validation.snapshotTree !== validation.sourceTree ||
          (currentProof.validation.head ?? validation.sourceHead) !== currentProof.head ||
          !validationRefMatches(currentProof, validation.payloadDigest, validation.sourceHead)
        )
          return yield* fail(
            'stale-delivery-ref',
            'The historical PR reference no longer matches canonical phase proof.',
          );
        const planPhase = planPhases[0];
        const canonicalReceipt = currentProof.delivery;
        const hasRetainedWatch =
          request.operation === 'complete' &&
          canonicalReceipt?.delivery === 'pr' &&
          canonicalReceipt.watch?.consumerId === consumerId;
        const bound = watchReady(watch, now, hasRetainedWatch);
        if (!bound)
          return yield* fail(
            'watch-not-ready',
            terminal
              ? 'A merged PR needs a source-complete terminal watch with a host receipt and either its live consumer or acknowledged, settled terminal work.'
              : 'An open PR needs a started watch with its live consumer and host wakeup registration before delivery.',
          );
        const {consumer, hostReceipt, head} = bound;
        if (!canonicalReceipt && (!embeddedDelivery.userAuthority || !embeddedDelivery.providerIdentity))
          return yield* fail(
            'user-authority-required',
            'Before first canonical delivery, adopt this existing PR with actual userAuthority and fresh provider verification through deliver-pr; an older provisional reference cannot replace that evidence.',
          );
        const canonicalPr = canonicalReceipt?.delivery === 'pr' ? canonicalReceipt.pr : undefined;
        if (canonicalReceipt?.delivery === 'pr') {
          const canonicalIdentity = {
            ...canonicalReceipt,
            pr: canonicalPr ? {...canonicalPr, state: 'open' as const, baseRefBinding: undefined} : undefined,
            watch: undefined,
          };
          const suppliedIdentity = {
            ...embeddedDelivery,
            pr: embeddedDelivery.pr
              ? {...embeddedDelivery.pr, state: 'open' as const, baseRefBinding: undefined}
              : undefined,
            watch: undefined,
          };
          if (stableJson(canonicalIdentity) !== stableJson(suppliedIdentity))
            return yield* fail(
              'stale-delivery-ref',
              'The open PR receipt does not match this exact historical delivery reference.',
            );
          if (
            canonicalPr?.state === 'open' &&
            (canonicalReceipt.watch?.state !== 'active' ||
              canonicalReceipt.watch.prUrl !== referencedPr.url ||
              canonicalReceipt.watch.headSha !== embeddedDelivery.headSha ||
              canonicalReceipt.watch.consumerId !== consumer.id)
          )
            return yield* fail('stale-delivery-ref', 'The published phase is bound to another PR watch consumer.');
        }
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.realPath(config.agentContextHome);
        const stateDir = path.join(home, 'workflow-automations', 'native-watch-v1');
        const maintenanceRef = request.maintenanceValidationRef;
        const retainedMarker =
          canonicalPr?.state === 'merged' ? maintenanceMarker.exec(canonicalReceipt?.watch?.evidence ?? '') : null;
        let maintenance: Effect.Success<ReturnType<typeof verifyNativeTaskMaintenance>> | undefined;
        let recheckMaintenance: Effect.Effect<void, ReturnType<typeof nativeMaintenanceProofError>> | undefined;
        if (maintenanceRef !== undefined) {
          if (canonicalPr?.state === 'merged') {
            if (retainedMarker?.[4] !== sha256HexSync(maintenanceRef))
              return yield* nativeMaintenanceProofError('The merged receipt retains different maintenance evidence.');
          } else {
            if (!terminal || canonicalPr?.state !== 'open' || !canonicalReceipt)
              return yield* nativeMaintenanceProofError(
                'Maintenance evidence requires an already published PR and terminal watch.',
              );
            const verify = verifyNativeTaskMaintenance(
              config,
              request.runId,
              checkout,
              canonicalReceipt,
              head,
              maintenanceRef,
            );
            const verified = yield* verify;
            maintenance = verified;
            const services = yield* Effect.context<Effect.Services<typeof verified.recheck>>();
            recheckMaintenance = verified.recheck.pipe(Effect.provideContext(services));
          }
        }
        const marker = maintenance?.marker ?? retainedMarker?.[0] ?? '';
        // An open PR records its verified watch registration; only terminal completion has a host receipt to cite.
        const evidence = terminal
          ? `native-watch-revision:${watch.revision}${marker};host-receipt:${hostReceipt}`
          : `native-watch-revision:${watch.revision};consumer:${consumer.id};wakeup:${consumer.wakeupId}`;
        const watchEvidence = {
          prUrl: referencedPr.url,
          headSha: head,
          state: terminal ? ('terminal' as const) : ('active' as const),
          stateDir,
          consumerKind: 'orchestrator' as const,
          consumerId: consumer.id,
          evidence,
        };
        const receiptBase = canonicalReceipt?.delivery === 'pr' ? canonicalReceipt : embeddedDelivery;
        const receiptPr = receiptBase.pr;
        if (!receiptPr) return yield* fail('invalid-watch-receipt', 'The task delivery reference has no PR identity.');
        const finalReceipt = yield* Schema.decodeEffect(NativeCycleDeliverySchema, {onExcessProperty: 'error'})({
          ...receiptBase,
          pr: {...receiptPr, state: terminal ? 'merged' : 'open'},
          watch: watchEvidence,
        }).pipe(Effect.mapError(() => fail('invalid-watch-receipt', 'The canonical watch evidence is malformed.')));
        if (canonicalPr?.state === 'merged') {
          if (stableJson(canonicalReceipt) !== stableJson(finalReceipt))
            return yield* fail(
              'delivery-conflict',
              'The merged PR watch receipt is immutable and does not match this terminal readback.',
            );
          return {
            status: 'delivered',
            replayed: true,
            deliveryRef: encodeNativeTaskActionRef({
              ...deliveryAction,
              kind: 'delivery',
              payloadDigest: sha256HexSync(stableJson(canonicalReceipt)),
              delivery: canonicalReceipt,
            }),
            receipt: canonicalReceipt,
            next: nextNativeCycle(cycleState),
          };
        }
        const previouslyPublished = canonicalReceipt?.delivery === 'pr' && canonicalPr?.state === 'open';
        // Record-delivery checks the branch of a merged published phase against its reviewed-to-merged range.
        if (previouslyPublished && !terminal) {
          const branchHead = yield* runCommandEffect(
            'git',
            [
              '--no-optional-locks',
              '-C',
              checkout,
              'rev-parse',
              '--verify',
              '--end-of-options',
              `refs/heads/${planPhase.branch}^{commit}`,
            ],
            {timeoutMs: 30_000, maxOutputBytes: 4096},
          ).pipe(Effect.mapError(() => fail('source-drift', 'The published phase branch reference is unavailable.')));
          const branchTree = yield* runCommandEffect(
            'git',
            [
              '--no-optional-locks',
              '-C',
              checkout,
              'rev-parse',
              '--verify',
              '--end-of-options',
              `refs/heads/${planPhase.branch}^{tree}`,
            ],
            {timeoutMs: 30_000, maxOutputBytes: 4096},
          ).pipe(Effect.mapError(() => fail('source-drift', 'The published phase tree reference is unavailable.')));
          if (
            EffectString.trim(branchHead.stderr) ||
            EffectString.trim(branchTree.stderr) ||
            EffectString.trim(branchHead.stdout) !== embeddedDelivery.headSha ||
            EffectString.trim(branchTree.stdout) !== validation.sourceTree
          )
            return yield* fail(
              'source-drift',
              'The immutable published phase branch no longer matches its reviewed source.',
            );
          return {
            status: 'delivered',
            replayed: true,
            deliveryRef: encodeNativeTaskActionRef({
              ...deliveryAction,
              kind: 'delivery',
              payloadDigest: sha256HexSync(stableJson(canonicalReceipt)),
              delivery: canonicalReceipt,
            }),
            receipt: canonicalReceipt,
            next: nextNativeCycle(cycleState),
          };
        }
        if (!previouslyPublished) {
          const ready = unwrapCycle(
            yield* inCheckout(
              runWorkflowAutomation(
                config,
                cycleRequest(current, {
                  command: 'publication-ready',
                  phaseId: validatedPhaseId,
                  ...nativeCyclePublicationField(embeddedDelivery.publication),
                }),
              ),
              checkout,
            ),
          );
          if (ready.head !== embeddedDelivery.headSha || ready.tree !== validation.sourceTree)
            return yield* fail('source-drift', 'The current source no longer matches the reviewed PR snapshot.');
        }
        if (!canonicalReceipt && !(providerVerified && !terminal))
          yield* verifyNativeCyclePrDeliveryIdentity(checkout, embeddedDelivery, {allowMerged: terminal});
        const finalReceiptPr = finalReceipt.pr;
        if (!finalReceiptPr) return yield* fail('invalid-watch-receipt', 'The canonical watch PR identity is missing.');
        const {baseRefBinding: _baseRefBinding, ...unboundReceiptPr} = finalReceiptPr;
        const baseRefReceipt =
          canonicalReceipt?.delivery === 'pr' ? {...finalReceipt, pr: unboundReceiptPr} : finalReceipt;
        // Historical terminal delivery verifies the original base within the cycle. GitHub
        // retargets can delete that ref, so only the cycle may admit the canonical binding.
        const completesPublished = previouslyPublished && terminal;
        const checkedBaseReceipt = completesPublished
          ? finalReceipt
          : yield* bindNativeCycleDeliveryBase(checkout, planPhase.baseBranch, baseRefReceipt);
        if (
          canonicalPr?.baseRefBinding &&
          stableJson(checkedBaseReceipt.pr?.baseRefBinding) !== stableJson(canonicalPr.baseRefBinding)
        )
          return yield* fail(
            'base-ref-unverified',
            'The historical PR base binding no longer matches its canonical receipt.',
          );
        const persist = withNativeWatchControlLock(
          config,
          watchId,
          Effect.gen(function* () {
            const latestWatch = yield* readNativeWatch(config, watchId);
            // The collector can advance an open watch after start; its binding must still hold.
            if (
              !latestWatch ||
              (latestWatch.revision !== watch.revision && (terminal || !watchReady(latestWatch, now)))
            )
              return yield* fail('watch-state-conflict', 'The exact watch readback changed before phase delivery.');
            const latest = yield* readNativeWorkflowState(config, request.runId);
            if (!latest?.state.cycle || latest.revision !== current.revision)
              return yield* fail(
                'stale-delivery-ref',
                'Canonical phase state changed before the watch receipt was recorded.',
              );
            const result = unwrapCycle(
              yield* inCheckout(
                runWorkflowAutomation(
                  config,
                  cycleRequest(latest, {
                    command: 'record-delivery',
                    phaseId: validatedPhaseId,
                    delivery: finalReceipt,
                    ...nativeCyclePublicationField(embeddedDelivery.publication),
                    expectedRevision: latest.revision,
                  }),
                ).pipe(
                  Effect.provideService(
                    CurrentNativeTerminalDeliveryWatch,
                    completesPublished
                      ? delivery =>
                          Effect.gen(function* () {
                            if (recheckMaintenance) yield* recheckMaintenance;
                            const currentTime = yield* Clock.currentTimeMillis;
                            if (
                              stableJson(delivery) !== stableJson(finalReceipt) ||
                              watchReady(latestWatch, currentTime, hasRetainedWatch)?.hostReceipt !== hostReceipt
                            )
                              return yield* fail(
                                'watch-not-ready',
                                'The exact terminal watch needs its host receipt and either a live consumer or acknowledged, settled terminal work at delivery.',
                              );
                          })
                      : undefined,
                  ),
                  Effect.provideService(CurrentNativeMaintenanceProof, maintenance),
                ),
                checkout,
              ),
            );
            const persistedState = yield* readNativeWorkflowState(config, request.runId);
            const persisted = persistedState?.state.cycle?.state.phases[validatedPhaseId]?.delivery;
            if (
              !persisted ||
              !persisted.pr ||
              stableJson({...persisted, pr: {...persisted.pr, baseRefBinding: undefined}}) !==
                stableJson({...finalReceipt, pr: {...finalReceipt.pr, baseRefBinding: undefined}}) ||
              stableJson(persisted.pr.baseRefBinding) !== stableJson(checkedBaseReceipt.pr?.baseRefBinding)
            )
              return yield* fail('delivery-not-recorded', 'The exact watched PR receipt was not persisted.');
            return {result, persisted};
          }),
        );
        // Maintenance runs deliver commits, so the donor lock precedes the original PR run lock.
        const recorded = maintenance
          ? yield* withNativeWorkflowLock(config, maintenance.runId, false, persist)
          : yield* persist;
        return {
          status: 'delivered',
          replayed: false,
          deliveryRef: encodeNativeTaskActionRef({
            ...deliveryAction,
            kind: 'delivery',
            payloadDigest: sha256HexSync(stableJson(recorded.persisted)),
            delivery: recorded.persisted,
          }),
          receipt: recorded.persisted,
          next: recorded.result.next,
        };
      });
    if (request.operation === 'start') {
      if (!wakeup)
        return yield* fail(
          'host-registration-required',
          `Start needs a host wakeup. ${nativeWatchHostRegistrationHint}`,
        );
      yield* admitProvisionalWatch();
      yield* runNativeWatch(config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'start',
        watchId,
        pr: embeddedDelivery.pr.url,
        consumerId,
        wakeupId,
        wakeup: wakeup,
        ...(request.takeover === true ? {takeover: true} : {}),
        ...(request.recoverWakeup === true ? {recoverWakeup: true} : {}),
      });
      const readback = yield* readNativeWatch(config, watchId);
      if (
        !readback ||
        readback.envelope.state.pr !== embeddedDelivery.pr.url ||
        readback.envelope.state.consumer?.id !== consumerId ||
        readback.envelope.state.consumer?.wakeupId !== wakeupId ||
        readback.envelope.notification?.target.host !== wakeup.host
      )
        return yield* fail(
          'watch-readback-mismatch',
          'The started watch did not retain the exact PR and host consumer binding.',
        );
      const outbox = readback.envelope.notification?.outbox;
      const noticeRef =
        outbox?.key && outbox.attemptId
          ? encodeNativeTaskActionRef({
              version: 1,
              kind: 'delivery',
              runId: request.runId,
              generationHash: sha256HexSync(stored.state.generation),
              watchId,
              consumerId: readback.envelope.state.consumer.id,
              wakeupId: readback.envelope.state.consumer.wakeupId,
              eventKey: outbox.key,
              watchAttemptId: outbox.attemptId,
            })
          : undefined;
      // The started workflow watch is authoritative; a failed handover must not report it as unstarted.
      const supersededStandaloneWatchId = yield* stopSupersededStandalonePrWatch(
        config,
        checkout,
        embeddedDelivery.pr.url,
        watchId,
      ).pipe(Effect.orElseSucceed(() => undefined));
      // A registered consumer and wakeup are the delivery evidence for an open PR; PR events can arrive much later.
      // The watch already runs, so a failed record leaves it usable and names complete as the retry.
      const recorded =
        phase.delivery === undefined ? yield* Effect.result(recordWatchedDelivery(readback, true)) : undefined;
      const recordFailure = recorded?._tag === 'Failure' ? nativeWorkflowError(recorded.failure) : undefined;
      return {
        status: 'watching',
        watchId,
        prUrl: embeddedDelivery.pr.url,
        headSha: readback.envelope.state.head,
        consumerId: readback.envelope.state.consumer.id,
        revision: readback.revision,
        hostReceipt: readback.envelope.notification?.lastReceipt ?? outbox?.receipt ?? null,
        ...(noticeRef ? {noticeRef} : {}),
        ...(supersededStandaloneWatchId ? {supersededStandaloneWatchId} : {}),
        ...(recorded?._tag === 'Success'
          ? {deliveryRef: recorded.success.deliveryRef, receipt: recorded.success.receipt, next: recorded.success.next}
          : {}),
        ...(recordFailure
          ? {
              delivery: {recorded: false, code: recordFailure.code, message: recordFailure.message},
              next: {
                action: 'watch-pr',
                operation: 'complete',
                runId: request.runId,
                phaseId: validation.phaseId,
                validationRef,
                deliveryRef,
              },
            }
          : {}),
      };
    }
    const watch = yield* readNativeWatch(config, watchId);
    if (!watch) return yield* fail('watch-not-found', 'Start the task-bound PR watch before using its route.');
    if (watch.envelope.state.pr !== embeddedDelivery.pr.url)
      return yield* fail('watch-identity-conflict', 'The stored watch belongs to another PR.');
    const consumer = watch.envelope.state.consumer;
    if (!consumer)
      return yield* fail('watch-consumer-required', 'Attach the actual task consumer before using the watch.');
    if (consumer.id !== consumerId || consumer.wakeupId !== wakeupId)
      return yield* fail('watch-identity-conflict', 'The stored watch belongs to another task consumer.');
    if (isNativeWatchSessionWakeup(inputWakeup) && wakeup === undefined) {
      const registered = watch.envelope.notification?.target;
      if (!registered || !nativeWatchWakeupMatches(inputWakeup, registered))
        return yield* fail('watch-identity-conflict', 'The supplied wakeup does not match the registered host.');
      wakeup = registered;
    }
    const terminalEmpty = watch.envelope.state.prState !== 'open' && watchWorkDrained(watch.envelope.state);
    if (
      terminalEmpty &&
      (request.operation === 'relay' || request.operation === 'ack' || request.operation === 'disposition')
    )
      return {status: 'terminal-empty', watchId, prUrl: watch.envelope.state.pr, revision: watch.revision};
    if (request.operation === 'renew') {
      if (request.takeover)
        return yield* fail('invalid-request', 'Renewal preserves the exact host and does not allow takeover.');
      // recoverWakeup settles an ambiguous attempt of this same registered host, even after the PR merged.
      if (terminalEmpty && !(request.recoverWakeup && watch.envelope.notification?.outbox))
        return {status: 'terminal-empty', watchId, prUrl: watch.envelope.state.pr, revision: watch.revision};
      yield* verifyNativeCycleDeliveryRepository(checkout, embeddedDelivery);
      if (phase.delivery === undefined) {
        const approved = EffectArray.filter(runtime.state.plan.phases, item => item.id === validation.phaseId);
        if (approved.length !== 1 || approved[0].branch !== embeddedDelivery.pr.branch)
          return yield* fail(
            'stale-delivery-ref',
            'Renewal requires the canonical approved phase branch and base binding.',
          );
        const {baseRefBinding: _untrustedBinding, ...pr} = embeddedDelivery.pr;
        yield* bindNativeCycleDeliveryBase(checkout, approved[0].baseBranch, {...embeddedDelivery, pr});
      }
      const renewed = yield* runNativeWatch(config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'renew',
        watchId,
        pr: embeddedDelivery.pr.url,
        consumerId,
        wakeupId,
        wakeup: wakeup ?? watch.envelope.notification?.target,
        baseBranch: embeddedDelivery.pr.baseBranch,
        headBranch: embeddedDelivery.pr.branch,
        ...(request.recoverWakeup === true ? {recoverWakeup: true} : {}),
      });
      return {status: 'watching', watchId, prUrl: embeddedDelivery.pr.url, consumerId, watch: renewed};
    }
    if (request.operation === 'complete') return yield* recordWatchedDelivery(watch);
    return yield* runNativePrWatchOperation(config, {...request, wakeup}, watch, {
      runId: request.runId,
      generationHash: sha256HexSync(stored.state.generation),
    });
  });

export const runNativeTaskLocalDelivery = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'deliver-local'}>,
  stored: NativeTaskStoredState,
  checkout: string,
  runtime: NativeTaskCycleRuntime,
) =>
  Effect.gen(function* () {
    const state = runtime.state;
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
    // Delivery moves the validation to the commit that carries its tree, so a reference minted before it names the
    // validation at the snapshot head.
    const validations = proof?.validation
      ? [proof.validation, ...(proof.delivery ? [{...proof.validation, head: ref.sourceHead}] : [])]
      : [];
    if (
      !proof?.validation ||
      proof.phaseHash !== ref.phaseHash ||
      proof.head !== (proof.validation.head ?? ref.sourceHead) ||
      proof.tree !== ref.sourceTree ||
      (ref.kind === 'validation' &&
        !EffectArray.some(validations, validation => sha256HexSync(stableJson(validation)) === ref.payloadDigest))
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
    const {phaseId, phaseHash, sourceTree} = ref;
    const receiptAt = (headSha: string) => {
      const receipt = {phaseId, phaseHash, delivery: 'local' as const, headSha, validatedTree: sourceTree};
      const payloadDigest = sha256HexSync(stableJson(receipt));
      return {
        receipt,
        payloadDigest,
        deliveryRef: encodeNativeTaskActionRef({...ref, kind: 'delivery', payloadDigest}),
      };
    };
    if (proof.delivery) {
      const {receipt, payloadDigest, deliveryRef} = receiptAt(proof.head);
      if (
        stableJson(proof.delivery) !== stableJson(receipt) ||
        (ref.kind === 'delivery' && ref.payloadDigest !== payloadDigest)
      )
        return yield* fail('delivery-conflict', 'The phase already has a different canonical delivery receipt.');
      return {status: 'delivered', replayed: true, deliveryRef, receipt: proof.delivery};
    }
    if (ref.kind === 'delivery')
      return yield* fail('stale-delivery-ref', 'This delivery reference has no matching canonical receipt.');
    // As for commit delivery, the receipt names the commit that carries the validated tree, which a tree recorded dirty
    // gets only once it is committed.
    const ready = unwrapCycle(
      yield* inCheckout(
        runWorkflowAutomation(config, cycleRequest(stored, {command: 'publication-ready', phaseId: ref.phaseId})),
        checkout,
      ),
    );
    if (ready.revision !== stored.revision || typeof ready.head !== 'string' || ready.tree !== proof.tree)
      return yield* fail('source-drift', 'Local delivery requires the exact clean validated source tree and branch.');
    const {receipt, deliveryRef} = receiptAt(ready.head);
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
  });

/** Keep watch proof selection separate from the canonical PR receipt lifecycle. */
export const runNativeTaskWatchAction = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'watch-pr'}> & {readonly runId: string},
  stored: NativeTaskStoredState,
  checkout: string,
  runtime: NativeTaskCycleRuntime,
) =>
  Effect.gen(function* () {
    const candidate =
      request.snapshotRef !== undefined || request.candidateWatchRef !== undefined || request.pr !== undefined;
    if (
      (candidate && request.supplementalRef) ||
      ((candidate || request.supplementalRef) && (request.validationRef || request.deliveryRef))
    )
      return yield* fail(
        'watch-proof-conflict',
        'Choose exactly one canonical, candidate or supplemental proof route.',
      );
    if (candidate) {
      if (request.operation === 'renew' || request.operation === 'complete')
        return yield* fail(
          'candidate-diagnostic-only',
          'Candidate watch supports diagnostics, never canonical completion or renewal.',
        );
      return yield* runNativeTaskCandidateWatch(
        config,
        {...request, operation: request.operation, command: 'watch-candidate-pr'},
        stored,
        checkout,
        runtime,
      );
    }
    if (request.supplementalRef)
      return yield* runNativeTaskSupplementalPublication(
        config,
        {...request, command: 'supplemental-publication', pr: undefined},
        stored,
        checkout,
        runtime,
      );
    return yield* runNativeTaskPrWatch(config, request, stored, checkout);
  });
