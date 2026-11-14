import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {Array as EffectArray, Effect, Option, Predicate, Schema, String as EffectString} from 'effect';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {fail} from './task_action_helpers.js';
import type {NativeTaskActionRequest} from './task_actions.js';
import {runNativeWatch} from './watch.js';
import {
  assertNativeWatchOutput,
  nativeWatchOutputLimit,
  nativeWatchWorkDetail,
  nativeWatchWorkList,
} from './watch_output.js';
import {readNativeWatch, readNativeTaskWatchIds} from './watch_store.js';
import {nativeWatchWakeupRequestSchema} from './watch_notification_state.js';

export const NativeTaskPrWatchFieldsSchema = Schema.Struct({
  operation: Schema.Literals([
    'start',
    'renew',
    'inspect',
    'relay',
    'disposition',
    'ack',
    'work',
    'work-disposition',
    'work-detail',
    'stop',
    'complete',
  ]),
  phaseId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u))),
  wakeup: Schema.optionalKey(nativeWatchWakeupRequestSchema),
  takeover: Schema.optionalKey(Schema.Boolean),
  recoverWakeup: Schema.optionalKey(Schema.Boolean),
  noticeRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  workEventRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  offsetBytes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: Number.MAX_SAFE_INTEGER}))),
  sourceDigest: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  workOffset: Schema.optionalKey(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 8192}))),
  workViewDigest: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
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

// Preserve persisted legacy routes; the PR suffix qualifies only a different PR in the same phase.
export const nativeTaskLegacyWatchIdentity = (runId: string, phaseId: string) => {
  const identity = EffectString.slice(0, 48)(sha256HexSync(`${runId}\n${phaseId}`));
  return {watchId: `pr-${identity}`, consumerId: `task-${identity}`, wakeupId: `task-${identity}`};
};

const qualifiedWatchIdentity = (runId: string, phaseId: string, prUrl: string) => {
  const identity = `${EffectString.slice(3)(nativeTaskLegacyWatchIdentity(runId, phaseId).watchId)}-${EffectString.slice(0, 48)(sha256HexSync(prUrl))}`;
  return {watchId: `pr-${identity}`, consumerId: `task-${identity}`, wakeupId: `task-${identity}`};
};

export const nativeTaskWatchIdentityForConsumer = (runId: string, phaseId: string, prUrl: string, consumerId: string) =>
  Option.getOrUndefined(
    EffectArray.findFirst(
      [nativeTaskLegacyWatchIdentity(runId, phaseId), qualifiedWatchIdentity(runId, phaseId, prUrl)],
      identity => identity.consumerId === consumerId,
    ),
  );

const phaseWatchIdentity = (
  runId: string,
  phaseId: string,
  watch: NonNullable<Effect.Success<ReturnType<typeof readNativeWatch>>>,
) => {
  const state = watch.envelope.state;
  const identity = Option.getOrUndefined(
    EffectArray.findFirst(
      [nativeTaskLegacyWatchIdentity(runId, phaseId), qualifiedWatchIdentity(runId, phaseId, state.pr)],
      item => item.watchId === state.watchId,
    ),
  );
  return identity &&
    !watch.envelope.owner &&
    (!state.consumer || (state.consumer.id === identity.consumerId && state.consumer.wakeupId === identity.wakeupId))
    ? identity
    : undefined;
};

export const resolveNativeTaskPrWatch = (
  config: RuntimeConfig,
  runId: string,
  phaseId: string,
  prUrl: string,
  retainedConsumerId?: string,
) =>
  Effect.gen(function* () {
    const legacy = nativeTaskLegacyWatchIdentity(runId, phaseId);
    const qualified = qualifiedWatchIdentity(runId, phaseId, prUrl);
    const legacyWatch = yield* readNativeWatch(config, legacy.watchId);
    const qualifiedWatch = yield* readNativeWatch(config, qualified.watchId);
    if (
      EffectArray.some(
        [legacyWatch, qualifiedWatch],
        watch => watch !== undefined && !phaseWatchIdentity(runId, phaseId, watch),
      )
    )
      return yield* fail('watch-identity-conflict', 'An occupied phase watch belongs to another owner or consumer.');
    if (legacyWatch && legacyWatch.envelope.state.pr !== prUrl && !legacyWatch.envelope.state.consumer)
      return yield* fail('watch-identity-conflict', 'An unbound legacy watch cannot qualify a different PR.');
    if (qualifiedWatch && qualifiedWatch.envelope.state.pr !== prUrl)
      return yield* fail('watch-identity-conflict', 'The qualified watch belongs to another PR.');
    if (retainedConsumerId !== undefined) {
      const identity = nativeTaskWatchIdentityForConsumer(runId, phaseId, prUrl, retainedConsumerId);
      if (!identity) return yield* fail('watch-identity-conflict', 'The receipt belongs to another watch consumer.');
      const watch = identity.watchId === legacy.watchId ? legacyWatch : qualifiedWatch;
      if (watch && watch.envelope.state.pr !== prUrl)
        return yield* fail('watch-identity-conflict', 'The retained consumer watch belongs to another PR.');
      return {...identity, watch};
    }
    if (legacyWatch?.envelope.state.pr === prUrl && qualifiedWatch)
      return yield* fail(
        'watch-identity-conflict',
        'Both watch identities match this PR; use its retained consumer receipt.',
      );
    if (legacyWatch?.envelope.state.pr === prUrl) return {...legacy, watch: legacyWatch};
    if (qualifiedWatch || legacyWatch) return {...qualified, watch: qualifiedWatch};
    return {...legacy, watch: undefined};
  });

export const readNativeTaskPhaseWatchIds = (config: RuntimeConfig, runId: string, phaseId: string) =>
  readNativeTaskWatchIds(config, nativeTaskLegacyWatchIdentity(runId, phaseId).watchId);

/** Validate a scoped inventory entry without treating its filename as proof of a different owner. */
export const readNativeTaskPhaseWatch = (config: RuntimeConfig, runId: string, phaseId: string, watchId: string) =>
  Effect.gen(function* () {
    const watch = yield* readNativeWatch(config, watchId);
    if (!watch) return yield* fail('watch-inventory-changed', 'The phase watch inventory changed; reload it.');
    const identity = phaseWatchIdentity(runId, phaseId, watch);
    if (!identity)
      return yield* fail(
        'watch-identity-conflict',
        'The phase inventory contains another PR or task consumer binding.',
      );
    return {...identity, watch};
  });

/** Shared event and retained-work routing; admission and publication remain with each caller. */
export const runNativePrWatchOperation = (
  config: RuntimeConfig,
  request: Pick<
    Extract<NativeTaskActionRequest, {command: 'watch-pr'}>,
    | 'operation'
    | 'workEventRef'
    | 'offsetBytes'
    | 'sourceDigest'
    | 'workOffset'
    | 'workViewDigest'
    | 'watchDeliveryRef'
    | 'noticeRef'
    | 'dispositions'
    | 'wakeup'
    | 'recoverWakeup'
  >,
  watch: NonNullable<Effect.Success<ReturnType<typeof readNativeWatch>>>,
  scope: {readonly runId: string; readonly generationHash: string},
  refs = {encode: encodeNativeTaskActionRef, decode: decodeNativeTaskActionRef},
) =>
  Effect.gen(function* () {
    const watchId = watch.envelope.state.watchId;
    const prUrl = watch.envelope.state.pr;
    const consumer = watch.envelope.state.consumer;
    if (!consumer)
      return yield* fail('watch-consumer-required', 'Attach the actual watch consumer before using the watch.');
    if (request.operation === 'start' || request.operation === 'renew' || request.operation === 'complete')
      return yield* fail('invalid-request', 'Admission, renewal and publication need their owning route.');
    const workViewDigest = sha256HexSync(stableJson(watch.envelope.state.work));
    if (request.operation === 'work-detail') {
      const ref = request.workEventRef ? refs.decode(request.workEventRef) : undefined;
      const row = ref?.watchEventId
        ? Option.getOrUndefined(
            EffectArray.findFirst(watch.envelope.state.work, item => item.eventId === ref.watchEventId),
          )
        : undefined;
      // Like work, detail reads bind the current owner without requiring or renewing its lease.
      if (
        !ref ||
        ref.kind !== 'retained-work' ||
        ref.runId !== scope.runId ||
        ref.generationHash !== scope.generationHash ||
        ref.watchId !== watchId ||
        ref.consumerId !== consumer.id ||
        ref.wakeupId !== consumer.wakeupId ||
        ref.workViewDigest !== workViewDigest ||
        !row ||
        ref.workRowDigest !== sha256HexSync(stableJson(row))
      )
        return yield* fail(
          'stale-watch-work-ref',
          'Read retained work detail with a current opaque row reference returned by work.',
        );
      const workDetail = yield* Effect.try({
        try: () =>
          nativeWatchWorkDetail(watch.envelope.state.work, row.eventId, request.offsetBytes, request.sourceDigest),
        catch: () =>
          fail(
            'invalid-watch-page',
            'Work detail changed or its UTF-8 cursor or sourceDigest is invalid; reload work.',
          ),
      });
      return assertNativeWatchOutput({
        status: 'watch-updated',
        operation: request.operation,
        watchId,
        revision: watch.revision,
        result: {workDetail},
      });
    }
    if (request.operation === 'work') {
      if ((request.workOffset ?? 0) > 0 && !request.workViewDigest)
        return yield* fail('stale-watch-work-view', 'Continue work paging with its complete workViewDigest.');
      if (request.workViewDigest !== undefined && request.workViewDigest !== workViewDigest)
        return yield* fail('stale-watch-work-view', 'Retained work changed; restart work paging at offset zero.');
      const page = nativeWatchWorkList(watch.envelope.state.work, request.workOffset ?? 0);
      const items: Record<string, unknown>[] = EffectArray.map(page.items, item => {
        if (!Predicate.isObject(item) || typeof item.eventId !== 'string')
          throw fail('invalid-watch-work', 'A retained work row has no canonical identity.');
        const row = Option.getOrUndefined(
          EffectArray.findFirst(watch.envelope.state.work, row => row.eventId === item.eventId),
        );
        if (!row) throw fail('invalid-watch-work', 'A retained work row is unavailable.');
        const eventRef = refs.encode({
          version: 1,
          kind: 'retained-work',
          runId: scope.runId,
          generationHash: scope.generationHash,
          watchId,
          consumerId: consumer.id,
          wakeupId: consumer.wakeupId,
          watchEventId: row.eventId,
          workViewDigest,
          workRowDigest: sha256HexSync(stableJson(row)),
        });
        return {
          ...item,
          eventRef,
          ...('detail' in item
            ? {
                detail: {
                  operation: 'work-detail',
                  workEventRef: eventRef,
                  offsetBytes: 0,
                  sourceDigest: sha256HexSync(stableJson(row)),
                },
              }
            : {}),
        };
      });
      const output = () => ({
        status: 'watch-updated',
        operation: request.operation,
        watchId,
        prUrl: watch.envelope.state.pr,
        headSha: watch.envelope.state.head,
        revision: watch.revision,
        result: {
          protocolVersion: 1,
          executorVersion: 1,
          status: 'ok',
          watchId,
          revision: watch.revision,
          work: {
            items,
            offset: page.offset,
            nextOffset:
              page.offset + items.length < watch.envelope.state.work.length ? page.offset + items.length : null,
            workViewDigest,
          },
        },
      });
      while (new TextEncoder().encode(JSON.stringify(output())).byteLength > nativeWatchOutputLimit && items.length > 1)
        items.pop();
      if (new TextEncoder().encode(JSON.stringify(output())).byteLength > nativeWatchOutputLimit && items[0]) {
        const item = items[0];
        const row = Option.getOrUndefined(
          EffectArray.findFirst(watch.envelope.state.work, row => row.eventId === item.eventId),
        );
        items[0] = {
          eventId: item.eventId,
          status: item.status,
          at: item.at,
          eventRef: item.eventRef,
          available: false,
          detail: {
            operation: 'work-detail',
            workEventRef: item.eventRef,
            offsetBytes: 0,
            sourceDigest: sha256HexSync(stableJson(row)),
          },
        };
      }
      return assertNativeWatchOutput(output());
    }
    const retained =
      request.operation === 'work-disposition' &&
      EffectArray.some(request.dispositions ?? [], item => refs.decode(item.eventRef)?.kind === 'retained-work');
    if (retained && request.watchDeliveryRef)
      return yield* fail('stale-watch-event-ref', 'Retained work references do not use a relay delivery reference.');
    const notice =
      request.operation !== 'work-disposition' && request.noticeRef ? refs.decode(request.noticeRef) : undefined;
    const watchDelivery = request.watchDeliveryRef ? refs.decode(request.watchDeliveryRef) : undefined;
    if (
      request.operation !== 'work-disposition' &&
      request.noticeRef &&
      (!notice ||
        notice.kind !== 'delivery' ||
        notice.watchId !== watchId ||
        notice.consumerId !== consumer.id ||
        notice.wakeupId !== consumer.wakeupId ||
        !notice.eventKey ||
        notice.runId !== scope.runId ||
        notice.generationHash !== scope.generationHash)
    )
      return yield* fail('foreign-notice-route', 'The notice reference does not belong to this exact watch consumer.');
    if (
      request.watchDeliveryRef &&
      (!watchDelivery ||
        watchDelivery.kind !== 'delivery' ||
        watchDelivery.watchId !== watchId ||
        watchDelivery.consumerId !== consumer.id ||
        watchDelivery.wakeupId !== consumer.wakeupId ||
        watchDelivery.runId !== scope.runId ||
        watchDelivery.generationHash !== scope.generationHash ||
        !watchDelivery.watchDeliveryId)
    )
      return yield* fail(
        'stale-watch-delivery-ref',
        'Use the current opaque event delivery reference returned by relay.',
      );
    const watchCommand = request.operation === 'inspect' ? 'inspect' : request.operation;
    if (notice) {
      const notification = watch.envelope.notification;
      const outbox = notification?.outbox;
      if (
        !notification ||
        notification.consumerId !== consumer.id ||
        notification.wakeupId !== consumer.wakeupId ||
        !outbox ||
        outbox.key !== notice.eventKey ||
        outbox.attempts < 1 ||
        outbox.status === 'pending' ||
        (notice.watchAttemptId !== undefined && outbox.attemptId !== notice.watchAttemptId) ||
        (notice.watchAttemptId === undefined && outbox.attemptId !== undefined) ||
        notice.runId !== scope.runId ||
        notice.generationHash !== scope.generationHash
      )
        return yield* fail(
          'foreign-notice-route',
          'This notice does not belong to the current PR watch consumer and attempt.',
        );
    }
    const dispositionIds = new Set<string>();
    const dispositions:
      | {eventId: string; status: 'open' | 'blocked' | 'resolved' | 'ignored'; reason: string; evidence: string}[]
      | undefined = request.dispositions === undefined ? undefined : [];
    for (const item of request.dispositions ?? []) {
      const eventRef = refs.decode(item.eventRef);
      if (
        !eventRef ||
        (retained ? eventRef.kind !== 'retained-work' : eventRef.kind !== 'delivery') ||
        eventRef.runId !== scope.runId ||
        eventRef.generationHash !== scope.generationHash ||
        eventRef.watchId !== watchId ||
        eventRef.consumerId !== consumer.id ||
        eventRef.wakeupId !== consumer.wakeupId ||
        (retained
          ? eventRef.workViewDigest !== workViewDigest ||
            eventRef.workRowDigest !==
              sha256HexSync(
                stableJson(
                  Option.getOrNull(
                    EffectArray.findFirst(watch.envelope.state.work, row => row.eventId === eventRef.watchEventId),
                  ),
                ),
              )
          : eventRef.watchDeliveryId !== watchDelivery?.watchDeliveryId) ||
        !eventRef.watchEventId ||
        dispositionIds.has(eventRef.watchEventId)
      )
        return yield* fail(
          'stale-watch-event-ref',
          retained
            ? 'Use current retained work references returned by work; reload its complete view.'
            : 'A disposition must use an event from the current opaque watch delivery.',
        );
      dispositionIds.add(eventRef.watchEventId);
      dispositions?.push({
        eventId: eventRef.watchEventId,
        status: item.status,
        reason: item.reason,
        evidence: item.evidence,
      });
    }
    const result = yield* runNativeWatch(config, {
      protocolVersion: 1,
      executorVersion: 1,
      action: 'watch',
      command: watchCommand,
      watchId,
      consumerId: consumer.id,
      wakeupId: consumer.wakeupId,
      ...(request.wakeup ? {wakeup: request.wakeup} : {}),
      ...(request.recoverWakeup ? {recoverWakeup: true} : {}),
      expectedRevision: watch.revision,
      ...(watchDelivery?.watchDeliveryId ? {deliveryId: watchDelivery.watchDeliveryId} : {}),
      ...(notice?.eventKey ? {eventKey: notice.eventKey} : {}),
      ...(notice?.watchAttemptId ? {attemptId: notice.watchAttemptId} : {}),
      ...(dispositions ? {dispositions} : {}),
    });
    const after = yield* readNativeWatch(config, watchId);
    if (!after || after.envelope.state.pr !== prUrl)
      return yield* fail('watch-readback-mismatch', 'The canonical watch changed identity during its operation.');
    const resultRecord: Record<string, unknown> | undefined = Predicate.isObject(result) ? result : undefined;
    const delivered = resultRecord && Predicate.isObject(resultRecord.delivery) ? resultRecord.delivery : undefined;
    const watchDeliveryRef =
      delivered && typeof delivered.id === 'string'
        ? refs.encode({
            version: 1,
            kind: 'delivery',
            runId: scope.runId,
            generationHash: scope.generationHash,
            watchId,
            consumerId: consumer.id,
            wakeupId: consumer.wakeupId,
            watchDeliveryId: delivered.id,
          })
        : undefined;
    const eventRefs =
      delivered && EffectArray.isArray(delivered.events)
        ? EffectArray.flatMap(delivered.events, (event: unknown) =>
            Predicate.isObject(event) && typeof event.id === 'string' && watchDeliveryRef
              ? [
                  refs.encode({
                    version: 1,
                    kind: 'delivery',
                    runId: scope.runId,
                    generationHash: scope.generationHash,
                    watchId,
                    consumerId: consumer.id,
                    wakeupId: consumer.wakeupId,
                    watchDeliveryId: String(delivered.id),
                    watchEventId: event.id,
                  }),
                ]
              : [],
          )
        : [];
    const nextNotice = after.envelope.notification?.outbox;
    const noticeRef =
      nextNotice?.key && nextNotice.attemptId
        ? refs.encode({
            version: 1,
            kind: 'delivery',
            runId: scope.runId,
            generationHash: scope.generationHash,
            watchId,
            consumerId: consumer.id,
            wakeupId: consumer.wakeupId,
            eventKey: nextNotice.key,
            watchAttemptId: nextNotice.attemptId,
          })
        : undefined;
    return {
      status: 'watch-updated',
      operation: request.operation,
      watchId,
      prUrl: after.envelope.state.pr,
      headSha: after.envelope.state.head,
      revision: after.revision,
      result,
      ...(watchDeliveryRef ? {watchDeliveryRef} : {}),
      ...(eventRefs.length ? {eventRefs} : {}),
      ...(noticeRef ? {noticeRef} : {}),
    };
  });
