import {NativeCloseoutProposalSchema, type NativeCloseoutProposal} from '@threadnote/workflow-automations/closeout';
import {nextNativeCycle} from '@threadnote/workflow-automations/cycle';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {Effect, Array as EffectArray, Predicate, Schema} from 'effect';
import * as EffectString from 'effect/String';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {decodeJournal} from './closeout_request_schema.js';
import {readNativeCloseoutJournal} from './closeout_store.js';
import {runWorkflowAutomation} from './index.js';
import {nativeJobId} from './native_jobs.js';
import {readNativeWatch} from './watch_store.js';

import type {NativeTaskCycleRuntime, NativeTaskStoredState} from './task_action_helpers.js';
import {fail, inCheckout} from './task_action_helpers.js';
import type {NativeTaskActionRequest} from './task_actions.js';

const taskJobSummary = (value: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(value) || typeof value.status !== 'string')
    return {status: 'unknown', nextAction: 'Inspect this task action using its opaque continuation reference.'};
  return {
    status: value.status,
    ...(Predicate.isObject(value.progress) ? {progress: value.progress} : {}),
    ...(typeof value.code === 'string' ? {code: value.code} : {}),
    ...(value.status === 'blocked-with-progress' ||
    value.status === 'stopped-with-progress' ||
    value.status === 'failed'
      ? {
          nextAction:
            'Resolve the reported issue, then explicitly retry this task action with resume:true and the same reference.',
        }
      : value.status === 'accepted'
        ? {nextAction: 'Continue this accepted task action with the same reference and resume:true.'}
        : value.status === 'running'
          ? {nextAction: 'Wait for this task action, then query again with the same reference.'}
          : {}),
  };
};

export const runNativeTaskFinish = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'finish'}>,
  stored: NativeTaskStoredState,
  checkout: string,
  state: NativeTaskCycleRuntime['state'],
) =>
  Effect.gen(function* () {
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
      const pr = phaseReceipt?.pr;
      const watchId = phase ? `pr-${EffectString.slice(0, 48)(sha256HexSync(`${request.runId}\n${phase.id}`))}` : '';
      const watch = phase ? yield* readNativeWatch(config, watchId) : undefined;
      const notification = watch?.envelope.notification;
      const requiredSources = ['comments', 'reviews', 'threads', 'checks', 'statuses'];
      const completeSources =
        watch &&
        watch.envelope.state.sources.length === requiredSources.length &&
        EffectArray.every(requiredSources, source =>
          EffectArray.some(
            watch.envelope.state.sources,
            item => item.source === source && item.lastCompleteAt !== undefined && item.error === undefined,
          ),
        );
      if (
        state.plan.delivery !== 'pr' ||
        !phase ||
        phaseReceipt?.delivery !== 'pr' ||
        pr?.state !== 'merged' ||
        phaseReceipt.watch?.state !== 'terminal' ||
        !watch ||
        watch.envelope.state.pr !== pr.url ||
        watch.envelope.state.prState !== 'merged' ||
        watch.envelope.state.head !== pr.headSha ||
        watch.envelope.collector?.status !== 'terminal' ||
        !completeSources ||
        !notification ||
        notification.consumerId !== watch.envelope.state.consumer?.id ||
        notification.wakeupId !== watch.envelope.state.consumer?.wakeupId ||
        !(notification.lastReceipt || notification.outbox?.receipt)
      )
        return yield* fail(
          'finish-scope',
          'PR closeout requires the exact merged PR, terminal source-complete watch, live consumer record, and host receipt.',
        );
      closeoutWatchWork = EffectArray.map(
        EffectArray.filter(watch.envelope.state.work, item => item.status === 'open' || item.status === 'blocked'),
        item => ({
          eventId: item.eventId,
          status: item.status === 'blocked' ? ('blocked' as const) : ('open' as const),
          reason: item.reason,
          evidence: item.evidence,
          event: item.event,
          at: item.at,
        }),
      );
    }
    const closeoutProposal =
      request.proposal === undefined
        ? undefined
        : yield* Schema.decodeEffect(NativeCloseoutProposalSchema, {onExcessProperty: 'error'})({
            ...request.proposal,
            ...(closeoutWatchWork === undefined ? {} : {watchWork: closeoutWatchWork}),
          }).pipe(
            Effect.mapError(() =>
              fail(
                'invalid-closeout-proposal',
                'The semantic closeout proposal could not retain canonical PR watch work.',
              ),
            ),
          );
    if (request.prepareRef && request.finishRef)
      return yield* fail('invalid-request', 'Continue one closeout reference at a time.');
    if (request.resume && !request.prepareRef && !request.finishRef)
      return yield* fail('invalid-request', 'Explicit job resume requires its exact prepareRef or finishRef.');
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
      if (!Predicate.isObject(validation) || validation.status !== 'ok')
        return yield* fail('closeout-not-ready', 'The canonical closeout validation inputs are unavailable.');
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
