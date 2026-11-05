import {Array as EffectArray, Effect, FileSystem, Option as EffectOption, Path, Predicate, Schema} from 'effect';
import * as EffectString from 'effect/String';
import {SystemInfo} from '@threadnote/platform/system';
import {NativeCyclePacketOptionsSchema} from '@threadnote/workflow-automations/cycle-packet';
import {NativeCycleReviewSchema} from '@threadnote/workflow-automations/cycle-review';
import {NativeCycleValidationSchema, nextNativeCycle} from '@threadnote/workflow-automations/cycle';
import {NativeCloseoutProposalSchema} from '@threadnote/workflow-automations/closeout';
import {
  decodeNativeTaskActionRef,
  encodeNativeTaskActionRef,
  NativeTaskAnchorSchema,
  nativeTaskSnapshotId,
} from '@threadnote/workflow-automations/task';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {readNativeCloseoutJournal} from './closeout_store.js';
import {decodeJournal} from './closeout_request_schema.js';
import {nativeJobId} from './native_jobs.js';
import {readNativeWorkflowState} from './store.js';
import {inspectWorkflowJournal, withWorkflowLock} from '../workflow_memory/journal.js';
import {runWorkflowAutomation} from './index.js';
import {readNativeTaskView} from './task.js';
import {gitValue} from '../utils.js';
import {makeWorkflowGitAdapter} from './cycle_git.js';

const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
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
const requestSchema = Schema.Union([
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
    command: Schema.Literal('finish'),
    runId: id,
    callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    proposal: Schema.optionalKey(NativeCloseoutProposalSchema),
    prepareRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
    finishRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
    resume: Schema.optionalKey(Schema.Boolean),
  }),
]);

const inCheckout = <A, E, R>(program: Effect.Effect<A, E, R>, checkout: string) =>
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    return yield* program.pipe(Effect.provideService(SystemInfo, {...system, currentDirectory: () => checkout}));
  });

const cycleRequest = (
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  request: object,
) => ({
  protocolVersion: 1,
  executorVersion: 1,
  action: 'cycle',
  runId: stored.state.runId,
  generation: stored.state.generation,
  ...request,
});

const unwrapCycle = (result: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(result) || result.status !== 'ok' || !Predicate.isObject(result.cycle))
    throw fail(
      Predicate.isObject(result) && typeof result.code === 'string' ? result.code : 'task-action-failed',
      Predicate.isObject(result) && Predicate.isObject(result.cycle) && typeof result.cycle.message === 'string'
        ? result.cycle.message
        : 'The native cycle action did not return an admitted result.',
    );
  return result.cycle;
};

const requireEffectValue = <A>(value: A | undefined, message: string): A => {
  if (value === undefined) throw fail('invalid-state', message);
  return value;
};

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
    const checkout = yield* gitValue(['rev-parse', '--show-toplevel'], callerCwd);
    if (!checkout) return yield* fail('workspace-not-found', 'callerCwd must be inside a Git checkout.');
    const stored = yield* readNativeWorkflowState(config, request.runId);
    if (!stored?.state.cycle) return yield* fail('cycle-not-found', 'This run has no admitted native cycle.');
    const journal = yield* inCheckout(
      withWorkflowLock(config, stored.state.bindingId, inspectWorkflowJournal(config, stored.state.bindingId)),
      checkout,
    );
    if (journal.state.binding.repo !== checkout)
      return yield* fail('wrong-checkout', 'Use the checkout bound to this native run.');
    const runtime = stored.state.cycle;
    const state = runtime.state;
    if (state.plan.delivery !== 'local' || state.plan.phases.length !== 1)
      return yield* fail('task-scope', 'Task actions support one approved local-delivery phase.');

    if (request.command === 'finish') {
      const phase = state.plan.phases[0];
      if (
        !phase ||
        nextNativeCycle(state).action !== 'complete' ||
        state.phases[phase.id]?.delivery?.delivery !== 'local'
      )
        return yield* fail('finish-scope', 'Task finish supports one fully delivered local cycle phase.');
      if (request.prepareRef && request.finishRef)
        return yield* fail('invalid-request', 'Continue one closeout reference at a time.');
      if (request.resume && !request.prepareRef && !request.finishRef)
        return yield* fail('invalid-request', 'Explicit job resume requires its exact prepareRef or finishRef.');
      let proposalDigest = request.proposal ? sha256HexSync(stableJson(request.proposal)) : undefined;
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
      const prepareWork = request.proposal
        ? {
            protocolVersion: 1,
            executorVersion: 1,
            action: 'closeout',
            command: 'prepare',
            runId: request.runId,
            generation: stored.state.generation,
            proposal: request.proposal,
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
          return yield* fail(
            'stale-closeout-ref',
            'The finish reference does not match the active canonical closeout.',
          );
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
      if (!request.prepareRef && (!request.proposal || !proposalDigest || !prepareWork))
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
          return yield* fail(
            'closeout-intent-conflict',
            'The prepare reference is bound to different proposal content.',
          );
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
          preparedAdmissionEpoch &&
          journal &&
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
            if (finishStatus === 'completed' && journal.state.status === 'complete')
              return {
                status: 'complete',
                stage: 'finish',
                replayed: true,
                finishRef,
                closeout: {
                  transactionId: journal.state.transactionId,
                  documentDigest: journal.state.documentDigest,
                  outputs: journal.state.outputs,
                  archives: journal.state.archives,
                },
              };
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
    }

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
    const result = unwrapCycle(
      yield* inCheckout(
        runWorkflowAutomation(
          config,
          cycleRequest(stored, {
            command: 'snapshot',
            phaseId: ref.phaseId,
            snapshotId,
            acceptedHead: head,
            reason: 'Record the exact worker source result for this implementation packet.',
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
