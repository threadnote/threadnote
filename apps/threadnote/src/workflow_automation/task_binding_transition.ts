import {Array as EffectArray, Clock, Effect} from 'effect';
import * as EffectString from 'effect/String';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {inspectNativeJobsForRun} from './native_jobs.js';
import {readNativeWorkflowState} from './store.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {readNativeWatch} from './watch_store.js';
import {nativeWatchCollectorAlive} from './watch_process.js';

export const inspectOldBindingOwners = (
  config: RuntimeConfig,
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
) =>
  Effect.gen(function* () {
    const jobsResult = yield* inspectNativeJobsForRun(
      config,
      stored.state.runId,
      stored.state.generation,
      stored.state.bindingId,
    ).pipe(Effect.result);
    const jobs = jobsResult._tag === 'Success' ? jobsResult.success : [];
    const unresolved: Array<Record<string, unknown>> = [];
    for (const operation of stored.state.operations) {
      if (operation.status !== 'verified')
        unresolved.push({
          owner: 'workflow-operation',
          operationId: operation.intent.operationId,
          status: operation.status,
          reason: 'canonical-operation-not-verified',
        });
    }
    if (stored.state.authoringSave)
      unresolved.push({owner: 'authoring-save', status: 'pending', reason: 'canonical-save-not-settled'});
    if (jobsResult._tag === 'Failure')
      unresolved.push({owner: 'job-inventory', status: 'unavailable', reason: 'run-scoped-job-readback-failed'});
    for (const job of jobs) {
      if (!job.settled)
        unresolved.push({
          owner: 'job',
          jobId: job.jobId,
          status: job.status,
          stopRequested: job.stopRequested,
          reason: job.stopRequested ? 'stop-request-is-not-terminal' : 'job-requires-owner-continuation',
        });
    }
    const watches: Array<Record<string, unknown>> = [];
    const cycle = stored.state.cycle;
    const runtime = cycle?.state;
    const phaseIds = new Set([
      ...EffectArray.flatMap(cycle?.plans ?? [], plan => EffectArray.map(plan.phases, phase => phase.id)),
      ...EffectArray.map(runtime?.plan.phases ?? [], phase => phase.id),
    ]);
    for (const phaseId of phaseIds) {
      const delivery = runtime?.phases[phaseId]?.delivery;
      if (delivery?.delivery !== 'pr' || !delivery.pr?.url) continue;
      const identity = EffectString.slice(0, 48)(sha256HexSync(`${stored.state.runId}\n${phaseId}`));
      const watchId = `pr-${identity}`;
      const watchResult = yield* readNativeWatch(config, watchId).pipe(Effect.result);
      if (watchResult._tag === 'Failure') {
        unresolved.push({owner: 'watch', watchId, status: 'unavailable', reason: 'run-owned-watch-readback-failed'});
        continue;
      }
      const observed = watchResult.success;
      if (!observed) continue;
      const envelope = observed.envelope;
      const reasons: string[] = [];
      if (envelope.state.pr !== delivery.pr.url) reasons.push('watch-pr-binding-mismatch');
      if (envelope.state.head !== delivery.headSha) reasons.push('watch-source-head-mismatch');
      const collectorAlive = yield* nativeWatchCollectorAlive(envelope.collector).pipe(Effect.result);
      if (collectorAlive._tag === 'Failure' || collectorAlive.success)
        reasons.push('collector-still-owned-or-unverifiable');
      if (envelope.collector && envelope.collector.status !== 'stopped' && envelope.collector.status !== 'terminal')
        reasons.push('collector-not-stopped');
      const notification = envelope.notification;
      const outbox = notification?.outbox;
      if (notification?.recoveryRequested) reasons.push('host-recovery-requested');
      if (outbox && outbox.attempts > 0 && !(outbox.receipt || notification?.lastReceipt))
        reasons.push('host-receipt-missing');
      if (outbox && (outbox.status === 'pending' || outbox.status === 'sending' || outbox.status === 'failed'))
        reasons.push(`host-outbox-${outbox.status}`);
      if (
        outbox?.status === 'queued' &&
        (!outbox.receipt || (outbox.consumedThrough ?? 0) < envelope.state.nextSequence - 1)
      )
        reasons.push('host-outbox-awaiting-consumer-readback');
      if (envelope.state.delivery !== null) reasons.push('watch-delivery-open');
      if (envelope.state.prState === 'open') reasons.push('watch-pr-not-terminal');
      const requiredSources = ['comments', 'reviews', 'threads', 'checks', 'statuses'];
      if (
        envelope.state.prState !== 'open' &&
        (envelope.state.sources.length !== requiredSources.length ||
          !EffectArray.every(requiredSources, source =>
            EffectArray.some(
              envelope.state.sources,
              item => item.source === source && item.lastCompleteAt !== undefined && item.error === undefined,
            ),
          ))
      )
        reasons.push('watch-terminal-sources-incomplete');
      if (envelope.state.acknowledged !== envelope.state.nextSequence - 1) reasons.push('watch-notices-unacknowledged');
      if (EffectArray.some(envelope.state.work, item => item.status === 'open' || item.status === 'blocked'))
        reasons.push('watch-work-open');
      const now = yield* Clock.currentTimeMillis;
      if (envelope.state.prState === 'open' && envelope.state.consumer && envelope.state.consumer.leaseUntil > now)
        reasons.push('host-consumer-lease-active');
      watches.push({
        watchId,
        revision: observed.revision,
        collectorStatus: envelope.collector?.status ?? 'absent',
        reasons,
      });
      if (reasons.length > 0) unresolved.push({owner: 'watch', watchId, status: 'needs-drain', reasons});
    }
    return {jobs, watches, unresolved};
  });
