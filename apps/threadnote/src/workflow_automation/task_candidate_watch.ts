import {Effect, Predicate, Array as EffectArray, Option, Record as EffectRecord, String as EffectString} from 'effect';
import {
  decodeNativeTaskActionRef,
  encodeNativeTaskActionRef,
  type NativeTaskActionRef,
} from '@threadnote/workflow-automations/task';
import {nativeCycleSnapshotIsCurrentIteration} from '@threadnote/workflow-automations/cycle-runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {fail, type NativeTaskStoredState, type NativeTaskCycleRuntime} from './task_action_helpers.js';
import {runNativeWatch, invalidateNativeCandidateWatch} from './watch.js';
import {nativeWorkflowError} from './memory.js';
import {
  readNativeWatch,
  verifyNativeCandidateWatchOwner,
  nativeWatchOwnerDigest,
  bindNativeCandidateWatchBase,
  nativeCandidateWatchFailureIsDrift,
  type NativeWatchOwner,
  type NativeCandidateWatchOwner,
} from './watch_store.js';
import type {NativeWatchWakeup, nativeWatchWakeupRequestSchema} from './watch_notification_state.js';
import {discoverNativeWatchCodexExecutable} from './watch_notification.js';
import {
  assertNativeWatchOutput,
  nativeWatchOutputLimit,
  nativeWatchWorkDetail,
  nativeWatchWorkList,
} from './watch_output.js';

export interface OwnedNativeTaskWatchRequest {
  readonly operation:
    'start' | 'inspect' | 'relay' | 'disposition' | 'ack' | 'work' | 'work-disposition' | 'work-detail' | 'stop';
  readonly wakeup?: typeof nativeWatchWakeupRequestSchema.Type;
  readonly noticeRef?: string;
  readonly watchDeliveryRef?: string;
  readonly dispositions?: readonly {
    readonly eventRef: string;
    readonly status: 'open' | 'blocked' | 'resolved' | 'ignored';
    readonly reason: string;
    readonly evidence: string;
  }[];
  readonly workEventRef?: string;
  readonly workOffset?: number;
  readonly workViewDigest?: string;
  readonly offsetBytes?: number;
  readonly sourceDigest?: string;
}
export interface OwnedNativeTaskWatchBinding {
  readonly owner: NativeWatchOwner;
  readonly watchId: string;
  readonly consumerId: string;
  readonly wakeupId: string;
  readonly refBase: NativeTaskActionRef;
}

const find = <A>(values: readonly A[], predicate: (value: A) => boolean): A | undefined =>
  Option.getOrUndefined(EffectArray.findFirst(values, predicate));

/** Shared transport, with opaque owner-specific proofs mapped only after exact route validation. */
export const runOwnedNativeTaskWatch = (
  config: RuntimeConfig,
  request: OwnedNativeTaskWatchRequest,
  binding: OwnedNativeTaskWatchBinding,
) =>
  Effect.gen(function* () {
    const {owner, watchId, consumerId, wakeupId, refBase} = binding;
    const candidate = owner.kind === 'candidate-pr';
    const kinds = candidate
      ? ({
          notice: 'candidate-notice',
          delivery: 'candidate-delivery',
          event: 'candidate-event',
          work: 'candidate-work',
        } as const)
      : ({notice: 'delivery', delivery: 'delivery', event: 'delivery', work: 'retained-work'} as const);
    const encode = (kind: NativeTaskActionRef['kind'], fields: Partial<NativeTaskActionRef>) =>
      encodeNativeTaskActionRef({...refBase, kind, ...fields});
    const matches = (ref: NativeTaskActionRef | undefined, kind: NativeTaskActionRef['kind']) => {
      if (!ref || ref.kind !== kind) return false;
      for (const [key, value] of EffectRecord.toEntries<string, unknown>(refBase)) {
        if (key === 'kind') continue;
        if (Reflect.get(ref, key) !== value) return false;
      }
      return true;
    };
    const watch = yield* readNativeWatch(config, watchId);
    if (
      watch &&
      (nativeWatchOwnerDigest(watch.envelope.owner ?? owner) !== nativeWatchOwnerDigest(owner) ||
        !watch.envelope.owner ||
        watch.envelope.state.pr !== owner.prUrl)
    )
      return yield* fail('watch-owner-conflict', 'This watch belongs to another immutable owner.');
    if (request.operation !== 'start' && request.wakeup?.host === 'codex' && !request.wakeup.executable)
      return yield* fail('invalid-request', 'Only a new watch start can discover a Codex executable.');
    if (request.operation === 'start') {
      const inputWakeup = request.wakeup;
      if (!inputWakeup) return yield* fail('host-registration-required', 'Start needs actual host registration.');
      let wakeup: NativeWatchWakeup;
      if (inputWakeup.host === 'cursor-cli') wakeup = inputWakeup;
      else if (inputWakeup.executable !== undefined)
        wakeup = {host: 'codex', executable: inputWakeup.executable, threadId: inputWakeup.threadId};
      else if (watch) {
        const registered = watch.envelope.notification?.target;
        if (registered?.host !== 'codex' || registered.threadId !== inputWakeup.threadId)
          return yield* fail('watch-owner-conflict', 'Replay requires the exact registered host.');
        wakeup = registered;
      } else {
        if (owner.kind === 'candidate-pr') yield* verifyNativeCandidateWatchOwner(config, owner);
        wakeup = {
          host: 'codex',
          threadId: inputWakeup.threadId,
          executable: yield* discoverNativeWatchCodexExecutable(),
        };
      }
      // Lost-response replay is inspect-only; it never replaces a subscription or restarts invalidated proof.
      if (watch) {
        if (
          stableJson(watch.envelope.notification?.target) !== stableJson(wakeup) ||
          watch.envelope.state.consumer?.id !== consumerId ||
          watch.envelope.state.consumer.wakeupId !== wakeupId
        )
          return yield* fail(
            'watch-owner-conflict',
            'Candidate replay requires the exact registered host and consumer.',
          );
        if (watch.envelope.invalidation) return yield* fail('candidate-invalidated', 'This candidate was invalidated.');
        // A replay still verifies the live binding through the same guarded mutation route.
        if (owner.kind === 'candidate-pr') {
          const checked = yield* verifyNativeCandidateWatchOwner(config, owner).pipe(Effect.result);
          if (checked._tag === 'Failure') {
            if (!nativeCandidateWatchFailureIsDrift(checked.failure)) return yield* checked.failure;
            yield* invalidateNativeCandidateWatch(config, watchId, nativeWorkflowError(checked.failure).code);
            return yield* fail('candidate-binding-drift', 'The candidate source or PR binding changed.');
          }
        }
        const result = yield* runNativeWatch(
          config,
          {
            protocolVersion: 1,
            executorVersion: 1,
            action: 'watch',
            command:
              watch.envelope.collector?.status === 'blocked' && !watch.envelope.stopRequested ? 'start' : 'inspect',
            watchId,
            ...(watch.envelope.collector?.status === 'blocked' && !watch.envelope.stopRequested
              ? {consumerId, wakeupId, pr: owner.prUrl, wakeup}
              : {}),
          },
          owner,
        );
        return {status: 'watch-updated' as const, operation: request.operation, watchId, result};
      }
      const result = yield* runNativeWatch(
        config,
        {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'watch',
          command: 'start',
          watchId,
          consumerId,
          wakeupId,
          pr: owner.prUrl,
          wakeup,
        },
        owner,
      );
      return {status: 'watch-updated' as const, operation: request.operation, watchId, result};
    }
    if (!watch) return yield* fail('watch-not-found', 'Start this owned watch explicitly.');
    const consumer = watch.envelope.state.consumer;
    if (!consumer || consumer.id !== consumerId || consumer.wakeupId !== wakeupId)
      return yield* fail('watch-owner-conflict', 'This watch consumer changed.');
    const workViewDigest = sha256HexSync(stableJson(watch.envelope.state.work));
    const rowRef = (eventId: string) => {
      const row = find(watch.envelope.state.work, item => item.eventId === eventId);
      return row
        ? encode(kinds.work, {watchEventId: row.eventId, workViewDigest, workRowDigest: sha256HexSync(stableJson(row))})
        : undefined;
    };
    const validWorkRef = (ref: NativeTaskActionRef | undefined) => {
      const row = find(watch.envelope.state.work, item => item.eventId === ref?.watchEventId);
      return matches(ref, kinds.work) &&
        ref?.workViewDigest === workViewDigest &&
        row &&
        ref.workRowDigest === sha256HexSync(stableJson(row))
        ? row
        : undefined;
    };
    if (request.operation === 'work-detail') {
      const ref = request.workEventRef ? decodeNativeTaskActionRef(request.workEventRef) : undefined;
      const row = validWorkRef(ref);
      if (!row) return yield* fail('stale-watch-work-ref', 'Use a current opaque retained work reference.');
      return assertNativeWatchOutput({
        status: 'watch-updated' as const,
        operation: request.operation,
        watchId,
        revision: watch.revision,
        result: {
          workDetail: nativeWatchWorkDetail(
            watch.envelope.state.work,
            row.eventId,
            request.offsetBytes,
            request.sourceDigest,
          ),
        },
      });
    }
    if (request.operation === 'work') {
      if (
        ((request.workOffset ?? 0) > 0 && !request.workViewDigest) ||
        (request.workViewDigest !== undefined && request.workViewDigest !== workViewDigest)
      )
        return yield* fail('stale-watch-work-view', 'Restart retained work paging with its current view digest.');
      const page = nativeWatchWorkList(watch.envelope.state.work, request.workOffset ?? 0);
      const items = EffectArray.flatMap(page.items, item =>
        Predicate.isObject(item) && typeof item.eventId === 'string'
          ? [
              {
                eventId: item.eventId,
                eventRef: rowRef(item.eventId),
                status: item.status,
                detail: {
                  operation: 'work-detail',
                  workEventRef: rowRef(item.eventId),
                  offsetBytes: 0,
                  sourceDigest: sha256HexSync(
                    stableJson(find(watch.envelope.state.work, row => row.eventId === item.eventId)),
                  ),
                },
              },
            ]
          : [],
      );
      const output = () => ({
        status: 'watch-updated' as const,
        operation: request.operation,
        watchId,
        revision: watch.revision,
        result: {
          work: {
            items,
            offset: page.offset,
            nextOffset:
              page.offset + items.length < watch.envelope.state.work.length ? page.offset + items.length : null,
            workViewDigest,
          },
        },
      });
      while (items.length > 1 && new TextEncoder().encode(JSON.stringify(output())).byteLength > nativeWatchOutputLimit)
        items.pop();
      return assertNativeWatchOutput(output());
    }
    const notice = request.noticeRef ? decodeNativeTaskActionRef(request.noticeRef) : undefined;
    if (request.noticeRef) {
      const notification = watch.envelope.notification;
      const outbox = notification?.outbox;
      if (
        request.operation !== 'relay' ||
        !matches(notice, kinds.notice) ||
        !notice?.eventKey ||
        !notification ||
        notification.consumerId !== consumerId ||
        notification.wakeupId !== wakeupId ||
        !outbox ||
        outbox.key !== notice.eventKey ||
        outbox.attempts < 1 ||
        outbox.status === 'pending' ||
        outbox.attemptId !== notice.watchAttemptId
      )
        return yield* fail('foreign-notice-route', 'Use this exact owned notice event key and attempt.');
    }
    const delivery = request.watchDeliveryRef ? decodeNativeTaskActionRef(request.watchDeliveryRef) : undefined;
    if (
      request.watchDeliveryRef &&
      (!matches(delivery, kinds.delivery) || !delivery?.watchDeliveryId || delivery.watchEventId || delivery.eventKey)
    )
      return yield* fail('stale-watch-delivery-ref', 'Use the opaque relay delivery reference.');
    if ((request.operation === 'ack' || request.operation === 'disposition') && !delivery?.watchDeliveryId)
      return yield* fail('stale-watch-delivery-ref', 'This mutation requires the opaque relay delivery reference.');
    const retained = request.operation === 'work-disposition';
    if (retained && request.watchDeliveryRef)
      return yield* fail('stale-watch-event-ref', 'Retained work does not use a relay delivery.');
    const seen = new Set<string>();
    const dispositions = [];
    for (const item of request.dispositions ?? []) {
      const ref = decodeNativeTaskActionRef(item.eventRef);
      if (
        !ref?.watchEventId ||
        seen.has(ref.watchEventId) ||
        (retained
          ? !validWorkRef(ref)
          : !matches(ref, kinds.event) ||
            ref.watchDeliveryId !== delivery?.watchDeliveryId ||
            !EffectArray.some(
              watch.envelope.state.events,
              event =>
                event.id === ref.watchEventId &&
                watch.envelope.state.delivery !== null &&
                event.sequence >= watch.envelope.state.delivery.first &&
                event.sequence <= watch.envelope.state.delivery.last,
            ))
      )
        return yield* fail('stale-watch-event-ref', 'Use the current opaque event or retained work reference.');
      seen.add(ref.watchEventId);
      dispositions.push({eventId: ref.watchEventId, status: item.status, reason: item.reason, evidence: item.evidence});
    }
    const result = yield* runNativeWatch(
      config,
      {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: request.operation,
        watchId,
        consumerId,
        wakeupId,
        expectedRevision: watch.revision,
        relayLimit: 1,
        ...(delivery?.watchDeliveryId ? {deliveryId: delivery.watchDeliveryId} : {}),
        ...(notice?.eventKey ? {eventKey: notice.eventKey} : {}),
        ...(notice?.watchAttemptId ? {attemptId: notice.watchAttemptId} : {}),
        ...(request.dispositions ? {dispositions} : {}),
      },
      owner,
    );
    const after = yield* readNativeWatch(config, watchId);
    if (!after || nativeWatchOwnerDigest(after.envelope.owner ?? owner) !== nativeWatchOwnerDigest(owner))
      return yield* fail('watch-readback-mismatch', 'The owned watch changed identity.');
    const raw: Record<string, unknown> | undefined = Predicate.isObject(result) ? result : undefined;
    const delivered =
      raw && Predicate.isObject(raw.delivery) && typeof raw.delivery.id === 'string' ? raw.delivery : undefined;
    const watchDeliveryRef = delivered ? encode(kinds.delivery, {watchDeliveryId: String(delivered.id)}) : undefined;
    const eventRefs =
      delivered && EffectArray.isArray(delivered.events)
        ? EffectArray.flatMap(delivered.events, (event: unknown) =>
            Predicate.isObject(event) && typeof event.id === 'string'
              ? [encode(kinds.event, {watchDeliveryId: String(delivered.id), watchEventId: event.id})]
              : [],
          )
        : [];
    const outbox = after.envelope.notification?.outbox;
    const noticeRef =
      request.operation === 'inspect' && outbox && outbox.attempts > 0 && outbox.status !== 'pending'
        ? encode(kinds.notice, {eventKey: outbox.key, ...(outbox.attemptId ? {watchAttemptId: outbox.attemptId} : {})})
        : undefined;
    return assertNativeWatchOutput({
      status: 'watch-updated' as const,
      operation: request.operation,
      watchId,
      revision: after.revision,
      result: delivered ? {delivery: delivered} : result,
      ...(watchDeliveryRef ? {watchDeliveryRef} : {}),
      ...(eventRefs.length ? {eventRefs} : {}),
      ...(noticeRef ? {noticeRef} : {}),
    });
  });

export interface NativeTaskCandidateWatchRequest extends OwnedNativeTaskWatchRequest {
  readonly command: 'watch-candidate-pr';
  readonly runId: string;
  readonly snapshotRef?: string;
  readonly candidateWatchRef?: string;
  readonly pr?: string;
}

export const runNativeTaskCandidateWatch = (
  config: RuntimeConfig,
  request: NativeTaskCandidateWatchRequest,
  stored: NativeTaskStoredState,
  checkout: string,
  runtime: NativeTaskCycleRuntime,
) =>
  Effect.gen(function* () {
    let owner: NativeCandidateWatchOwner;
    let watchId: string;
    let refBase: NativeTaskActionRef;
    if (request.operation === 'start') {
      const ref = request.snapshotRef ? decodeNativeTaskActionRef(request.snapshotRef) : undefined;
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
        !ref.baselineRef ||
        !request.pr
      )
        return yield* fail(
          'invalid-snapshot-ref',
          'Start candidate observation from its exact current immutable snapshotRef and PR.',
        );
      const snapshot = EffectArray.filter(runtime.snapshots, item => item.snapshot.phaseId === ref.phaseId).at(
        -1,
      )?.snapshot;
      const phase = find(runtime.state.plan.phases, item => item.id === ref.phaseId);
      if (
        !snapshot ||
        snapshot.snapshotId !== ref.snapshotId ||
        !phase ||
        !nativeCycleSnapshotIsCurrentIteration(runtime, ref.phaseId, ref.snapshotId)
      )
        return yield* fail('stale-snapshot-ref', 'Use the latest immutable snapshot for this phase.');
      const baseBinding = yield* bindNativeCandidateWatchBase(
        checkout,
        phase.baseBranch,
        {phaseId: ref.phaseId, phaseHash: ref.phaseHash, head: ref.sourceHead, tree: ref.sourceTree},
        request.pr,
      );
      if (baseBinding.headBranch !== phase.branch)
        return yield* fail('watch-binding-drift', 'The PR must use the exact admitted phase branch.');
      owner = {
        kind: 'candidate-pr',
        runId: request.runId,
        generationHash: ref.generationHash,
        phaseId: ref.phaseId,
        phaseHash: ref.phaseHash,
        snapshotRef: request.snapshotRef!,
        snapshotId: ref.snapshotId,
        snapshotDigest: sha256HexSync(stableJson(snapshot)),
        baselineHead: ref.baselineHead,
        baselineTree: ref.baselineTree,
        baselineRef: ref.baselineRef,
        callerCwd: checkout,
        head: ref.sourceHead,
        tree: ref.sourceTree,
        branch: phase.branch,
        scopeDigest: sha256HexSync(
          stableJson({
            phase,
            files: snapshot.files,
            scopeFiles: snapshot.scopeFiles,
            scopeBase: snapshot.scopeBase,
            declaredBaseHead: snapshot.declaredBaseHead,
          }),
        ),
        prUrl: request.pr,
        comparisonRef: phase.baseBranch,
        ...baseBinding,
      };
      const digest = nativeWatchOwnerDigest(owner);
      const identity = EffectString.slice(0, 48)(digest);
      watchId = `candidate-${identity}`;
      refBase = {
        version: 1,
        kind: 'candidate-watch',
        runId: owner.runId,
        generationHash: owner.generationHash,
        phaseId: owner.phaseId,
        phaseHash: owner.phaseHash,
        snapshotId: owner.snapshotId,
        sourceHead: owner.head,
        sourceTree: owner.tree,
        baselineHead: owner.baselineHead,
        baselineTree: owner.baselineTree,
        baselineRef: owner.baselineRef,
        watchId,
        consumerId: `candidate-task-${identity}`,
        wakeupId: `candidate-task-${identity}`,
        payloadDigest: digest,
      };
    } else {
      const ref = request.candidateWatchRef ? decodeNativeTaskActionRef(request.candidateWatchRef) : undefined;
      if (!ref || ref.kind !== 'candidate-watch' || ref.runId !== request.runId || !ref.watchId)
        return yield* fail('invalid-candidate-watch-ref', 'Use the returned candidate watch reference.');
      const watch = yield* readNativeWatch(config, ref.watchId);
      if (!watch || watch.envelope.owner?.kind !== 'candidate-pr')
        return yield* fail('watch-not-found', 'This candidate watch has no matching typed owner.');
      owner = watch.envelope.owner;
      watchId = ref.watchId;
      refBase = ref;
      const expected = decodeNativeTaskActionRef(owner.snapshotRef);
      if (
        !expected ||
        ref.generationHash !== owner.generationHash ||
        ref.payloadDigest !== nativeWatchOwnerDigest(owner) ||
        ref.consumerId !== `candidate-task-${EffectString.slice(0, 48)(nativeWatchOwnerDigest(owner))}` ||
        ref.wakeupId !== ref.consumerId ||
        watchId !== `candidate-${EffectString.slice(0, 48)(nativeWatchOwnerDigest(owner))}` ||
        EffectArray.some(
          EffectArray.map(
            [
              'runId',
              'generationHash',
              'phaseId',
              'phaseHash',
              'snapshotId',
              'sourceHead',
              'sourceTree',
              'baselineHead',
              'baselineTree',
              'baselineRef',
            ],
            key => [key, Reflect.get(expected, key)] as const,
          ),
          ([key, value]) => Reflect.get(ref, key) !== value,
        )
      )
        return yield* fail(
          'invalid-candidate-watch-ref',
          'This reference differs from its immutable candidate binding.',
        );
    }
    const result = yield* runOwnedNativeTaskWatch(config, request, {
      owner,
      watchId,
      consumerId: refBase.consumerId!,
      wakeupId: refBase.wakeupId!,
      refBase,
    });
    return assertNativeWatchOutput({
      ...result,
      status: 'candidate-watch-updated' as const,
      diagnosticOnly: true,
      ...(request.operation === 'start' ? {candidateWatchRef: encodeNativeTaskActionRef(refBase)} : {}),
    });
  });
