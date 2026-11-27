import {NativeCloseoutProposalSchema, type NativeCloseoutProposal} from '@threadnote/workflow-automations/closeout';
import {nextNativeCycle} from '@threadnote/workflow-automations/cycle';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {nativeNext, nativeRefusal, nativeWatchNext} from '@threadnote/workflow-automations/gates';
import type {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {Clock, Effect, Array as EffectArray, Predicate, Schema} from 'effect';
import * as EffectString from 'effect/String';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {decodeJournal} from './closeout_request_schema.js';
import {readNativeCloseoutJournal} from './closeout_store.js';
import {verifyNativeMergedPhaseHead} from './cycle_delivery.js';
import {runWorkflowAutomation} from './index.js';
import {nativeJobId} from './native_jobs.js';
import {
  readNativeTaskPhaseWatchIds,
  readNativeTaskPhaseWatch,
  resolveNativeTaskPrWatch,
  nativeTaskWatchIdentityForConsumer,
} from './task_pr_watch.js';
import {nativeWatchCollectorAlive} from './watch_process.js';
import {nativeWorkflowError} from './memory.js';
import {readNativeWorkflowState} from './store.js';
import {nativeTaskPhaseWatchRefs} from './task.js';
import {runNativeTaskPrWatch, watchWorkDrained} from './task_delivery_actions.js';

import type {NativeTaskCycleRuntime, NativeTaskStoredState} from './task_action_helpers.js';
import {fail, inCheckout} from './task_action_helpers.js';
import type {NativeTaskActionRequest} from './task_actions.js';

const closeoutValidationInputSchema = Schema.Struct({
  status: Schema.Literal('ok'),
  phases: Schema.Array(Schema.Struct({id: Schema.String, acceptanceCriteria: Schema.Array(Schema.String)})),
  decisions: Schema.Array(Schema.Struct({id: Schema.String})),
  scenarios: Schema.Array(Schema.Struct({id: Schema.String})),
});

const sameIds = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  EffectArray.every(actual, id => expected.includes(id));

const taskJobSummary = (value: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(value) || typeof value.status !== 'string')
    return {status: 'unknown', nextAction: 'Inspect this task action using its opaque continuation reference.'};
  return {
    status: value.status,
    ...(Predicate.isObject(value.progress) ? {progress: value.progress} : {}),
    ...(typeof value.code === 'string' ? {code: value.code} : {}),
    ...(value.code === 'invalid-closeout' && value.status === 'failed'
      ? {
          nextAction:
            'This preparation proposal cannot be retried. Match its phase evidence, decisions, and scenarios to the pinned plan and spec, then submit a corrected new finish request.',
        }
      : value.status === 'blocked-with-progress' ||
          value.status === 'stopped-with-progress' ||
          value.status === 'failed'
        ? {
            nextAction:
              'Resolve the reported issue, then explicitly retry this task action with resume:true and the same reference.',
          }
        : value.status === 'accepted'
          ? {nextAction: 'Wait for this accepted task action, then query again with the same reference.'}
          : value.status === 'running'
            ? {nextAction: 'Wait for this task action, then query again with the same reference.'}
            : {}),
  };
};

const requiredSources = ['comments', 'reviews', 'threads', 'checks', 'statuses'];
type PhaseWatch = NonNullable<Effect.Success<ReturnType<typeof resolveNativeTaskPrWatch>>['watch']>;
type PhaseWatchState = PhaseWatch['envelope']['state'];
/** The finish gate and its prerequisite diagnosis share these predicates. */
const watchSourcesComplete = (state: PhaseWatchState) =>
  state.sources.length === requiredSources.length &&
  EffectArray.every(requiredSources, source =>
    EffectArray.some(
      state.sources,
      item => item.source === source && item.lastCompleteAt !== undefined && item.error === undefined,
    ),
  );
const watchHostReceipts = (notification: PhaseWatch['envelope']['notification']) =>
  EffectArray.filter(
    [notification?.lastReceipt?.receipt, notification?.outbox?.receipt],
    (receipt): receipt is string => !!receipt,
  );
// The terminal receipt may still be in the outbox while lastReceipt names an earlier notice.
const receiptCitesHost = (evidence: string | undefined, notification: PhaseWatch['envelope']['notification']) =>
  evidence !== undefined &&
  EffectString.startsWith('native-watch-revision:')(evidence) &&
  EffectArray.some(watchHostReceipts(notification), receipt =>
    EffectString.endsWith(`;host-receipt:${receipt}`)(evidence),
  );
const leaseExpiredWithWork = (state: PhaseWatchState, now: number) =>
  state.consumer !== null && state.consumer.leaseUntil <= now && !watchWorkDrained(state);
type CloseoutWatchWork = NonNullable<NativeCloseoutProposal['watchWork']>[number];
const closeoutUndeliveredRowLimit = 16;
const closeoutWatchWorkRowLimit = 128;
/** Well under the 60,000-byte closeout document limit, so watch work never crowds out the closeout itself. */
const closeoutWatchWorkByteBudget = 30_000;
/** Actionable events only; CI progress, head moves, source errors and watcher lifecycle are not work. */
const actionableUndelivered = (event: PhaseWatchState['events'][number]) =>
  event.source === 'comments' || event.source === 'reviews' || event.source === 'threads'
    ? event.kind !== 'removed'
    : event.source === 'checks' || event.source === 'statuses'
      ? event.kind === 'ci_error'
      : event.kind === 'merge_conflict';
/** The live watch keeps the untrusted CI summary; closeout journals and memory documents never carry it. */
const closeoutEvent = ({summary: _summary, ...event}: PhaseWatchState['events'][number]) => event;
/**
 * Open and blocked work, plus each actionable event that has no disposition yet, so closeout never drops an event that
 * was still undelivered at merge. A long backlog keeps its first rows and one aggregate row for the rest.
 */
const closeoutWorkOf = (state: PhaseWatchState): {rows: CloseoutWatchWork[]; undelivered: number} => {
  const disposed = new Set(EffectArray.map(state.work, item => item.eventId));
  const undelivered = EffectArray.filter(
    state.events,
    event => !disposed.has(event.id) && actionableUndelivered(event),
  );
  const row = (event: PhaseWatchState['events'][number], reason: string): CloseoutWatchWork => ({
    eventId: event.id,
    status: 'open',
    reason,
    evidence: state.pr,
    event: closeoutEvent(event),
    at: event.at,
  });
  const excess = undelivered.slice(closeoutUndeliveredRowLimit);
  const first = excess[0];
  const last = excess.at(-1);
  const rows: CloseoutWatchWork[] = [
    ...EffectArray.flatMap(state.work, item =>
      item.status === 'open' || item.status === 'blocked'
        ? [
            {
              eventId: item.eventId,
              status: item.status,
              reason: item.reason,
              evidence: item.evidence,
              event: closeoutEvent(item.event),
              at: item.at,
            },
          ]
        : [],
    ),
    ...EffectArray.map(undelivered.slice(0, closeoutUndeliveredRowLimit), event =>
      row(event, 'Undelivered watch event at merge.'),
    ),
    ...(first && last
      ? [
          row(
            first,
            `${excess.length} more undelivered watch events (${first.id}..${last.id}); relay them and persist dispositions before ACK.`,
          ),
        ]
      : []),
  ];
  return {rows, undelivered: undelivered.length};
};

/**
 * Record the terminal receipt of each merged phase watch that is ready, so finish needs no separate watch complete.
 * The collector never writes canonical workflow receipts; finish runs the same checkout-bound complete route, which
 * keeps every merged-PR, terminal-watch, consumer and host-receipt gate. A plain renew first refreshes an expired
 * lease of the same consumer; on a merged watch it neither restarts collection nor changes the PR binding.
 */
const settleMergedPhaseWatches = (
  config: RuntimeConfig,
  runId: string,
  stored: NativeTaskStoredState,
  checkout: string,
  state: NativeTaskCycleRuntime['state'],
) =>
  Effect.gen(function* () {
    const failures = new Map<string, WorkflowAutomationError>();
    let advanced = false;
    for (const planPhase of state.plan.phases) {
      const receipt = state.phases[planPhase.id]?.delivery;
      if (
        receipt?.delivery !== 'pr' ||
        receipt.pr?.state !== 'open' ||
        receipt.watch?.state !== 'active' ||
        !receipt.watch.consumerId
      )
        continue;
      const resolved = yield* resolveNativeTaskPrWatch(
        config,
        runId,
        planPhase.id,
        receipt.pr.url,
        receipt.watch.consumerId,
      ).pipe(Effect.option);
      const watch = resolved._tag === 'Some' ? resolved.value.watch : undefined;
      const refs = nativeTaskPhaseWatchRefs(stored, planPhase.id);
      if (
        !watch ||
        !refs ||
        watch.envelope.state.prState !== 'merged' ||
        watch.envelope.collector?.status !== 'terminal'
      )
        continue;
      const route = {
        command: 'watch-pr' as const,
        runId,
        callerCwd: checkout,
        validationRef: refs.validationRef,
        deliveryRef: refs.deliveryRef,
      };
      if (leaseExpiredWithWork(watch.envelope.state, yield* Clock.currentTimeMillis)) {
        const renewed = yield* runNativeTaskPrWatch(config, {...route, operation: 'renew'}, stored, checkout).pipe(
          Effect.result,
        );
        if (renewed._tag === 'Failure') {
          failures.set(planPhase.id, nativeWorkflowError(renewed.failure));
          continue;
        }
      }
      const current = yield* readNativeWorkflowState(config, runId);
      if (!current) continue;
      const completed = yield* runNativeTaskPrWatch(config, {...route, operation: 'complete'}, current, checkout).pipe(
        Effect.result,
      );
      if (completed._tag === 'Failure') failures.set(planPhase.id, nativeWorkflowError(completed.failure));
      else advanced = true;
    }
    return {advanced, failures};
  });

export const runNativeTaskFinish = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'finish'}>,
  initialStored: NativeTaskStoredState,
  checkout: string,
  initialState: NativeTaskCycleRuntime['state'],
) =>
  Effect.gen(function* () {
    let stored = initialStored;
    let state = initialState;
    /** A watch operation with the phase's current references, or the task card when the phase has none. */
    const phaseWatchNext = (phaseId: string, operation: 'inspect' | 'renew' | 'work' | 'relay' | 'complete') => {
      const refs = nativeTaskPhaseWatchRefs(stored, phaseId);
      return refs
        ? nativeWatchNext(
            {
              runId: request.runId,
              callerCwd: checkout,
              validationRef: refs.validationRef,
              deliveryRef: refs.deliveryRef,
            },
            operation,
          )
        : nativeNext.view({runId: request.runId, callerCwd: checkout});
    };
    // Cheap request-shape refusals come first, so they never settle a watch.
    if (request.prepareRef && request.finishRef)
      return yield* fail('invalid-request', 'Continue one closeout reference at a time.');
    if (request.resume && !request.prepareRef && !request.finishRef)
      return yield* fail('invalid-request', 'Explicit job resume requires its exact prepareRef or finishRef.');
    const invalidProposal = fail(
      'invalid-closeout-proposal',
      'The semantic closeout proposal could not retain canonical PR watch work.',
    );
    if (request.proposal !== undefined)
      yield* Schema.decodeEffect(NativeCloseoutProposalSchema, {onExcessProperty: 'error'})(request.proposal).pipe(
        Effect.mapError(() => invalidProposal),
      );
    if (nextNativeCycle(state).action !== 'complete')
      return yield* fail('finish-scope', 'Task finish requires the current canonical phase completion gate.');
    const phase = state.plan.phases[0];
    const phaseReceipt = phase ? state.phases[phase.id]?.delivery : undefined;
    let closeoutWatchWork: NativeCloseoutProposal['watchWork'] | undefined;
    if (state.plan.delivery === 'local') {
      if (!phase || phaseReceipt?.delivery !== 'local')
        return yield* fail('finish-scope', 'Local closeout requires its exact canonical local delivery receipt.');
    } else if (state.plan.delivery === 'commit') {
      if (
        !EffectArray.every(state.plan.phases, item => {
          const receipt = state.phases[item.id]?.delivery;
          return receipt?.delivery === 'commit' && EffectString.trim(receipt.commitEvidence ?? '').length > 0;
        })
      )
        return yield* fail('finish-scope', 'Commit closeout requires every phase’s exact canonical commit receipt.');
    } else {
      if (state.plan.delivery !== 'pr')
        return yield* fail('finish-scope', 'PR closeout requires a canonical PR delivery plan.');
      const settlement = yield* settleMergedPhaseWatches(config, request.runId, stored, checkout, state);
      if (settlement.advanced) {
        const fresh = yield* readNativeWorkflowState(config, request.runId);
        if (!fresh?.state.cycle) return yield* fail('cycle-not-found', 'This run no longer has its canonical cycle.');
        stored = fresh;
        state = fresh.state.cycle.state;
      }
      const autoFailures = settlement.failures;
      const watchWork: CloseoutWatchWork[] = [];
      for (const planPhase of state.plan.phases) {
        const proof = state.phases[planPhase.id];
        const receipt = proof?.delivery;
        const pr = receipt?.pr;
        const resolved =
          pr?.url && receipt?.watch?.consumerId
            ? yield* resolveNativeTaskPrWatch(config, request.runId, planPhase.id, pr.url, receipt.watch.consumerId)
            : undefined;
        const watch = resolved?.watch;
        const notification = watch?.envelope.notification;
        const consumer = watch?.envelope.state.consumer;
        const hasHostReceipt = receiptCitesHost(receipt?.watch?.evidence, notification);
        const completeSources = watch !== undefined && watchSourcesComplete(watch.envelope.state);
        if (
          !proof ||
          !receipt ||
          receipt.delivery !== 'pr' ||
          receipt.phaseId !== planPhase.id ||
          receipt.phaseHash !== proof.phaseHash ||
          receipt.headSha !== proof.head ||
          receipt.validatedTree !== proof.tree ||
          pr?.state !== 'merged' ||
          receipt.watch?.state !== 'terminal' ||
          receipt.watch.prUrl !== pr.url ||
          !watch ||
          watch.envelope.state.pr !== pr.url ||
          watch.envelope.state.prState !== 'merged' ||
          watch.envelope.state.head !== receipt.watch.headSha ||
          watch.envelope.collector?.status !== 'terminal' ||
          !completeSources ||
          !notification ||
          !consumer ||
          receipt.watch.consumerId !== consumer.id ||
          notification.consumerId !== consumer.id ||
          notification.wakeupId !== consumer.wakeupId ||
          !hasHostReceipt
        ) {
          const now = yield* Clock.currentTimeMillis;
          const watchState = watch?.envelope.state;
          const autoFailure = autoFailures.get(planPhase.id);
          const [message, operation]: readonly [string, 'inspect' | 'renew' | 'complete'] = !watchState
            ? [
                `Phase ${planPhase.id} has no canonical PR watch; reload the task card for its watch references.`,
                'inspect',
              ]
            : watchState.prState === 'open'
              ? [
                  `The PR of phase ${planPhase.id} is not merged yet; the watch must observe the merge before finish.`,
                  'inspect',
                ]
              : watchState.prState !== 'merged'
                ? [`The PR of phase ${planPhase.id} closed without a merge.`, 'inspect']
                : watch?.envelope.collector?.status !== 'terminal' || !completeSources
                  ? [
                      `The watch of phase ${planPhase.id} has not finished its terminal merged sweep with every source complete; wait for that sweep.`,
                      'inspect',
                    ]
                  : leaseExpiredWithWork(watchState, now)
                    ? [
                        `The watch consumer lease of phase ${planPhase.id} expired while merged-watch events or open work remain; renew the watch${autoFailure ? ` (automatic renew refused: ${autoFailure.message})` : ''}.`,
                        'renew',
                      ]
                    : !watchHostReceipts(notification).length
                      ? [
                          `The merged watch notice of phase ${planPhase.id} has no host receipt yet; wait until the host wakeup is delivered.`,
                          'inspect',
                        ]
                      : receipt?.watch?.state !== 'terminal' || pr?.state !== 'merged'
                        ? [
                            `The merged PR receipt of phase ${planPhase.id} is not recorded: ${autoFailure?.message ?? 'watch complete has not run'}`,
                            'complete',
                          ]
                        : [
                            'PR closeout requires each exact merged PR, terminal source-complete watch, matching consumer record, and host receipt.',
                            'inspect',
                          ];
          return yield* nativeRefusal('finish-scope', message, {next: phaseWatchNext(planPhase.id, operation)});
        }
        // Later phases or maintenance can merge the PR above this phase's own delivered head.
        yield* verifyNativeMergedPhaseHead(checkout, pr.headSha, receipt.watch.headSha);
        const watchIds = new Set(yield* readNativeTaskPhaseWatchIds(config, request.runId, planPhase.id));
        if (!resolved) return yield* fail('finish-scope', 'The canonical watch identity is unavailable.');
        watchIds.add(resolved.watchId);
        for (const prior of [proof, ...(proof.history ?? [])]) {
          const receipt = prior.delivery;
          if (receipt?.delivery !== 'pr' || !receipt.pr || !receipt.watch?.consumerId) continue;
          const identity = nativeTaskWatchIdentityForConsumer(
            request.runId,
            planPhase.id,
            receipt.pr.url,
            receipt.watch.consumerId,
          );
          if (!identity) return yield* fail('finish-scope', 'A retained PR receipt has another watch consumer.');
          watchIds.add(identity.watchId);
        }
        for (const watchId of watchIds) {
          const retained = yield* readNativeTaskPhaseWatch(config, request.runId, planPhase.id, watchId);
          if (watchId === resolved.watchId && retained.watch.revision !== watch.revision)
            return yield* fail('watch-inventory-changed', 'The canonical watch changed during closeout discovery.');
          const retainedState = retained.watch.envelope.state;
          const retainedNotification = retained.watch.envelope.notification;
          const retainedOutbox = retainedNotification?.outbox;
          if (
            watchId !== resolved.watchId &&
            (retainedState.prState === 'open' ||
              !retained.watch.envelope.collector ||
              !['terminal', 'stopped'].includes(retained.watch.envelope.collector.status) ||
              (yield* nativeWatchCollectorAlive(retained.watch.envelope.collector)) ||
              retainedState.delivery !== null ||
              retainedState.acknowledged !== retainedState.nextSequence - 1 ||
              !retainedNotification ||
              retainedNotification.recoveryRequested ||
              !(retainedNotification.lastReceipt || retainedOutbox?.receipt) ||
              (retainedOutbox && ['pending', 'sending', 'failed'].includes(retainedOutbox.status)) ||
              !watchSourcesComplete(retainedState))
          )
            return yield* fail(
              'finish-scope',
              'A retained prior PR watch still owns active collection; settle that exact watch before finish.',
            );
          const carried = closeoutWorkOf(retainedState);
          watchWork.push(...carried.rows);
          // Measure the rendered form the closeout documents use.
          if (
            watchWork.length > closeoutWatchWorkRowLimit ||
            Buffer.byteLength(JSON.stringify(watchWork, null, 2)) > closeoutWatchWorkByteBudget
          ) {
            const current = watchId === resolved.watchId;
            const renewFirst =
              current &&
              retainedState.consumer !== null &&
              retainedState.consumer.leaseUntil <= (yield* Clock.currentTimeMillis);
            return yield* nativeRefusal(
              'closeout-watch-work-overflow',
              `Closeout would carry ${watchWork.length} open watch work rows after watch ${watchId}, more than its bounded budget; ${renewFirst ? 'renew the watch first, then ' : ''}resolve or ignore open watch work first.`,
              {
                // A retained prior watch is not reachable through watch-pr, so the task card leads to it.
                next: !current
                  ? nativeNext.view({runId: request.runId, callerCwd: checkout})
                  : phaseWatchNext(planPhase.id, carried.undelivered ? 'relay' : 'work'),
              },
            );
          }
        }
      }
      closeoutWatchWork = watchWork;
    }
    const closeoutProposal =
      request.proposal === undefined
        ? undefined
        : yield* Schema.decodeEffect(NativeCloseoutProposalSchema, {onExcessProperty: 'error'})({
            ...request.proposal,
            ...(closeoutWatchWork === undefined ? {} : {watchWork: closeoutWatchWork}),
          }).pipe(Effect.mapError(() => invalidProposal));
    let proposalDigest = closeoutProposal ? sha256HexSync(stableJson(closeoutProposal)) : undefined;
    let expectedPreparedRevision: string | undefined;
    const journal = yield* readNativeCloseoutJournal(config, request.runId, decodeJournal);
    const jobRequest = (command: 'submit' | 'result' | 'resume', jobId?: string, work?: unknown) =>
      runWorkflowAutomation(config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'job',
        command,
        runId: request.runId,
        generation: stored.state.generation,
        ...(jobId === undefined ? {} : {jobId}),
        ...(work === undefined ? {} : {work}),
      });
    const prepareWork = closeoutProposal
      ? {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'closeout',
          command: 'prepare',
          runId: request.runId,
          generation: stored.state.generation,
          proposal: closeoutProposal,
        }
      : undefined;
    if (request.finishRef) {
      const ref = decodeNativeTaskActionRef(request.finishRef);
      if (
        !ref ||
        ref.kind !== 'closeout-finish' ||
        ref.runId !== request.runId ||
        ref.generationHash !== sha256HexSync(stored.state.generation) ||
        !ref.jobId ||
        !ref.transactionId ||
        !ref.payloadDigest ||
        (proposalDigest !== undefined && proposalDigest !== ref.payloadDigest) ||
        !journal ||
        journal.state.transactionId !== ref.transactionId ||
        journal.state.status === 'superseded' ||
        sha256HexSync(stableJson(journal.state.proposal)) !== ref.payloadDigest
      )
        return yield* fail('stale-closeout-ref', 'The finish reference does not match the active canonical closeout.');
      const result = yield* inCheckout(jobRequest('result', ref.jobId), checkout);
      const status = Predicate.isObject(result) && typeof result.status === 'string' ? result.status : 'unknown';
      if (status !== 'completed') {
        if (status === 'blocked-with-progress' || status === 'stopped-with-progress' || status === 'failed') {
          if (!request.resume)
            return {status: 'blocked', stage: 'finish', finishRef: request.finishRef, job: taskJobSummary(result)};
          const resumed = yield* inCheckout(jobRequest('resume', ref.jobId), checkout);
          return {status: 'pending', stage: 'finish', finishRef: request.finishRef, job: taskJobSummary(resumed)};
        }
        if (status === 'accepted' || status === 'running') {
          if (!request.resume)
            return {status: 'pending', stage: 'finish', finishRef: request.finishRef, job: taskJobSummary(result)};
          const resumed = yield* inCheckout(jobRequest('resume', ref.jobId), checkout);
          return {status: 'pending', stage: 'finish', finishRef: request.finishRef, job: taskJobSummary(resumed)};
        }
        return yield* fail('invalid-job-state', 'The canonical finish job has an unrecognized lifecycle state.');
      }
      const latestJournal = yield* readNativeCloseoutJournal(config, request.runId, decodeJournal);
      if (
        !latestJournal ||
        latestJournal.state.status !== 'complete' ||
        latestJournal.state.transactionId !== ref.transactionId ||
        latestJournal.state.runId !== request.runId ||
        latestJournal.state.generation !== stored.state.generation ||
        latestJournal.state.bindingId !== stored.state.bindingId
      )
        return yield* fail(
          'closeout-incomplete',
          'The finish job completed without canonical completed closeout evidence.',
        );
      return {
        status: 'complete',
        replayed: true,
        finishRef: request.finishRef,
        closeout: {
          transactionId: latestJournal.state.transactionId,
          documentDigest: latestJournal.state.documentDigest,
          outputs: latestJournal.state.outputs,
          archives: latestJournal.state.archives,
        },
      };
    }
    if (!request.prepareRef && (!closeoutProposal || !proposalDigest || !prepareWork))
      return yield* fail(
        'invalid-request',
        'Provide the semantic closeout proposal or its exact prepare/finish reference.',
      );
    if (request.prepareRef) {
      const ref = decodeNativeTaskActionRef(request.prepareRef);
      if (
        !ref ||
        ref.kind !== 'closeout-prepare' ||
        ref.runId !== request.runId ||
        ref.generationHash !== sha256HexSync(stored.state.generation) ||
        !ref.jobId ||
        !ref.payloadDigest ||
        (proposalDigest !== undefined && ref.payloadDigest !== proposalDigest)
      )
        return yield* fail('closeout-intent-conflict', 'The prepare reference is bound to different proposal content.');
      const result = yield* inCheckout(jobRequest('result', ref.jobId), checkout);
      const status = Predicate.isObject(result) && typeof result.status === 'string' ? result.status : 'unknown';
      if (status !== 'completed') {
        if (status === 'blocked-with-progress' || status === 'stopped-with-progress' || status === 'failed') {
          if (
            status === 'failed' &&
            Predicate.isObject(result) &&
            'code' in result &&
            result.code === 'invalid-closeout'
          )
            return {status: 'blocked', stage: 'prepare', prepareRef: request.prepareRef, job: taskJobSummary(result)};
          if (!request.resume)
            return {status: 'blocked', stage: 'prepare', prepareRef: request.prepareRef, job: taskJobSummary(result)};
          const resumed = yield* inCheckout(jobRequest('resume', ref.jobId), checkout);
          return {status: 'pending', stage: 'prepare', prepareRef: request.prepareRef, job: taskJobSummary(resumed)};
        }
        if (status === 'accepted' || status === 'running') {
          if (!request.resume)
            return {status: 'pending', stage: 'prepare', prepareRef: request.prepareRef, job: taskJobSummary(result)};
          const resumed = yield* inCheckout(jobRequest('resume', ref.jobId), checkout);
          return {status: 'pending', stage: 'prepare', prepareRef: request.prepareRef, job: taskJobSummary(resumed)};
        }
        return yield* fail('invalid-job-state', 'The canonical preparation job has an unrecognized lifecycle state.');
      }
      const resultValue: unknown = result;
      const completedResult =
        Predicate.isObject(resultValue) && Predicate.isObject(resultValue.result) ? resultValue.result : undefined;
      const preparedRevision =
        completedResult &&
        Predicate.isObject(completedResult.closeout) &&
        typeof completedResult.closeout.revision === 'string'
          ? completedResult.closeout.revision
          : undefined;
      const preparedAdmissionEpoch =
        completedResult &&
        Predicate.isObject(completedResult.closeout) &&
        typeof completedResult.closeout.admissionEpoch === 'string'
          ? completedResult.closeout.admissionEpoch
          : undefined;
      if (!preparedRevision)
        return yield* fail(
          'closeout-result-unavailable',
          'The canonical prepare job lacks its journal revision readback.',
        );
      proposalDigest = ref.payloadDigest;
      if (
        journal &&
        journal.state.runId === request.runId &&
        journal.state.generation === stored.state.generation &&
        journal.state.bindingId === stored.state.bindingId &&
        sha256HexSync(stableJson(journal.state.proposal)) === proposalDigest &&
        journal.state.admissionEpoch === preparedAdmissionEpoch &&
        ['prepared', 'archiving', 'complete'].includes(journal.state.status)
      ) {
        const admittedFinishWork = {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'closeout',
          command: 'finish',
          runId: request.runId,
          generation: stored.state.generation,
          expectedRevision: preparedRevision,
        };
        const admittedFinishJobId = nativeJobId(stored.state.bindingId, admittedFinishWork, preparedAdmissionEpoch);
        const finishRef = encodeNativeTaskActionRef({
          version: 1,
          kind: 'closeout-finish',
          runId: request.runId,
          generationHash: sha256HexSync(stored.state.generation),
          payloadDigest: proposalDigest,
          closeoutRevision: preparedRevision,
          transactionId: journal.state.transactionId,
          jobId: admittedFinishJobId,
        });
        const admittedFinish = yield* Effect.result(inCheckout(jobRequest('result', admittedFinishJobId), checkout));
        if (admittedFinish._tag === 'Success') {
          const finishStatus =
            Predicate.isObject(admittedFinish.success) && typeof admittedFinish.success.status === 'string'
              ? admittedFinish.success.status
              : 'unknown';
          if (finishStatus === 'completed') {
            const completed = yield* readNativeCloseoutJournal(config, request.runId, decodeJournal);
            if (
              !completed ||
              completed.state.status !== 'complete' ||
              completed.state.runId !== request.runId ||
              completed.state.generation !== stored.state.generation ||
              completed.state.bindingId !== stored.state.bindingId ||
              completed.state.transactionId !== journal.state.transactionId ||
              completed.state.admissionEpoch !== preparedAdmissionEpoch ||
              sha256HexSync(stableJson(completed.state.proposal)) !== proposalDigest
            )
              return yield* fail(
                'closeout-incomplete',
                'The finish job completed without canonical completed closeout evidence for this admission.',
              );
            return {
              status: 'complete',
              stage: 'finish',
              replayed: true,
              finishRef,
              closeout: {
                transactionId: completed.state.transactionId,
                documentDigest: completed.state.documentDigest,
                outputs: completed.state.outputs,
                archives: completed.state.archives,
              },
            };
          }
          if (
            finishStatus === 'blocked-with-progress' ||
            finishStatus === 'stopped-with-progress' ||
            finishStatus === 'failed'
          )
            return {status: 'blocked', stage: 'finish', finishRef, job: taskJobSummary(admittedFinish.success)};
          if (finishStatus === 'accepted' || finishStatus === 'running')
            return {status: 'pending', stage: 'finish', finishRef, job: taskJobSummary(admittedFinish.success)};
        }
      }
      const prepared = yield* readNativeCloseoutJournal(config, request.runId, decodeJournal);
      if (
        !prepared ||
        prepared.revision !== preparedRevision ||
        prepared.state.status !== 'prepared' ||
        sha256HexSync(stableJson(prepared.state.proposal)) !== proposalDigest
      )
        return yield* fail(
          'stale-closeout-ref',
          'This preparation reference no longer identifies the current canonical closeout admission.',
        );
      expectedPreparedRevision = preparedRevision;
    } else {
      const graphResult = yield* inCheckout(
        runWorkflowAutomation(config, {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'graph-ready',
          runId: request.runId,
          generation: stored.state.generation,
        }),
        checkout,
      );
      const graphValue: unknown = graphResult;
      if (
        !Predicate.isObject(graphValue) ||
        graphValue.status !== 'ok' ||
        !Predicate.isObject(graphValue.graph) ||
        graphValue.graph.state !== 'ready'
      )
        return yield* fail('graph-not-ready', 'Refresh or repair current graph evidence before starting closeout.');
      const validation = yield* inCheckout(
        runWorkflowAutomation(config, {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'closeout',
          command: 'validation-input',
          runId: request.runId,
          generation: stored.state.generation,
        }),
        checkout,
      );
      const validationInput = yield* Schema.decodeUnknownEffect(closeoutValidationInputSchema)(validation).pipe(
        Effect.mapError(() => fail('closeout-not-ready', 'The canonical closeout validation inputs are unavailable.')),
      );
      const mismatches: string[] = [];
      if (
        !sameIds(
          EffectArray.map(closeoutProposal!.phaseEvidence, item => item.id),
          EffectArray.map(validationInput.phases, item => item.id),
        )
      )
        mismatches.push('phaseEvidence');
      for (const phaseInput of validationInput.phases) {
        const evidence = EffectArray.findFirst(closeoutProposal!.phaseEvidence, item => item.id === phaseInput.id);
        if (
          evidence._tag === 'None' ||
          !sameIds(
            EffectArray.map(evidence.value.acceptance, item => item.criterion),
            phaseInput.acceptanceCriteria,
          )
        ) {
          mismatches.push('acceptance');
          break;
        }
      }
      if (
        !sameIds(
          EffectArray.map(closeoutProposal!.decisions, item => item.id),
          EffectArray.map(validationInput.decisions, item => item.id),
        )
      )
        mismatches.push('decisions');
      if (
        !sameIds(
          EffectArray.map(closeoutProposal!.scenarios, item => item.id),
          EffectArray.map(validationInput.scenarios, item => item.id),
        )
      )
        mismatches.push('scenarios');
      if ((state.plan.spec === undefined) !== (closeoutProposal!.behaviorVerification === undefined))
        mismatches.push('behaviorVerification');
      if (mismatches.length > 0)
        return yield* fail(
          'invalid-closeout-proposal',
          `Closeout proposal fields ${EffectArray.join(mismatches, ', ')} must match the pinned plan and spec. Correct the proposal and submit a new finish request.`,
        );
      const submitted = yield* inCheckout(jobRequest('submit', undefined, prepareWork), checkout);
      const submittedValue: unknown = submitted;
      if (!Predicate.isObject(submittedValue) || typeof submittedValue.jobId !== 'string')
        return yield* fail('closeout-job-not-admitted', 'The canonical closeout preparation job was not admitted.');
      const prepareRef = encodeNativeTaskActionRef({
        version: 1,
        kind: 'closeout-prepare',
        runId: request.runId,
        generationHash: sha256HexSync(stored.state.generation),
        payloadDigest: proposalDigest,
        jobId: submittedValue.jobId,
      });
      return {status: 'pending', stage: 'prepare', prepareRef, job: taskJobSummary(submittedValue)};
    }
    const prepared = yield* readNativeCloseoutJournal(config, request.runId, decodeJournal);
    if (
      !prepared ||
      (expectedPreparedRevision !== undefined && prepared.revision !== expectedPreparedRevision) ||
      prepared.state.status !== 'prepared' ||
      (request.prepareRef && !request.proposal && proposalDigest === undefined) ||
      proposalDigest === undefined ||
      sha256HexSync(stableJson(prepared.state.proposal)) !== proposalDigest
    )
      return yield* fail(
        'closeout-not-prepared',
        'The preparation job completed without its exact prepared transaction.',
      );
    const finishWork = {
      protocolVersion: 1,
      executorVersion: 1,
      action: 'closeout',
      command: 'finish',
      runId: request.runId,
      generation: stored.state.generation,
      expectedRevision: expectedPreparedRevision ?? prepared.revision,
    };
    const submitted = yield* inCheckout(jobRequest('submit', undefined, finishWork), checkout);
    const submittedValue: unknown = submitted;
    if (!Predicate.isObject(submittedValue) || typeof submittedValue.jobId !== 'string')
      return yield* fail('closeout-job-not-admitted', 'The canonical closeout finish job was not admitted.');
    const finishRef = encodeNativeTaskActionRef({
      version: 1,
      kind: 'closeout-finish',
      runId: request.runId,
      generationHash: sha256HexSync(stored.state.generation),
      payloadDigest: proposalDigest,
      closeoutRevision: prepared.revision,
      transactionId: prepared.state.transactionId,
      jobId: submittedValue.jobId,
    });
    return {status: 'pending', stage: 'finish', finishRef, job: taskJobSummary(submittedValue)};
  });
