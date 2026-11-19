import {runCommandEffect} from '@threadnote/platform/command';
import {NativeTaskActionRefSchema, type NativeTaskActionRef} from '@threadnote/workflow-automations/task';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {Array as EffectArray, Effect, Predicate, Schema, String as EffectString} from 'effect';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {verifyNativePrRepository} from './cycle_delivery.js';
import {fail} from './task_action_helpers.js';
import type {NativeTaskActionRequest} from './task_actions.js';
import {runNativePrWatchOperation} from './task_pr_watch.js';
import {runNativeWatch} from './watch.js';
import {nativeWatchWakeupSchema} from './watch_notification_state.js';
import {nativeWatchPullRequest} from './watch_provider.js';
import {readNativeWatch} from './watch_store.js';
import {nativeWatchCollectorAlive} from './watch_process.js';

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const bindingSchema = Schema.Struct({
  version: Schema.Literal(1),
  checkout: text,
  prUrl: text,
  baseBranch: text,
  headBranch: text,
  wakeup: nativeWatchWakeupSchema,
});
const prefix = 'threadnote-standalone-watch-v1:';
const eventPrefix = 'threadnote-standalone-event-v1:';
const encode = (value: unknown) => Buffer.from(stableJson(value)).toString('base64url');
const decode = (value: string, marker: string): unknown => {
  if (!EffectString.startsWith(marker)(value) || value.length > 16_384)
    throw fail('invalid-watch-ref', 'Use the returned standalone watch reference.');
  const body = EffectString.slice(marker.length)(value);
  if (!/^[A-Za-z0-9_-]+$/u.test(body)) throw fail('invalid-watch-ref', 'Malformed standalone watch reference.');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
};
const standaloneWatchId = (checkout: string, prUrl: string) =>
  'standalone-pr-' + EffectString.slice(0, 48)(sha256HexSync(stableJson({checkout, prUrl})));
const bindingIdentity = (binding: typeof bindingSchema.Type) => {
  const digest = sha256HexSync(stableJson(binding));
  return {
    watchId: standaloneWatchId(binding.checkout, binding.prUrl),
    consumerId: 'standalone-' + EffectString.slice(0, 48)(digest),
    digest,
  };
};

/**
 * Stops the standalone watch a workflow-bound watch replaces, so one PR wakes the session once. Both routes store
 * GitHub's exact html_url, so the identity derives from the same checkout and URL. The stop names the replacing
 * watch; a later standalone start revives the standalone watch only after that watch stops monitoring the PR.
 */
export const stopSupersededStandalonePrWatch = (
  config: RuntimeConfig,
  checkout: string,
  prUrl: string,
  supersededBy: string,
) =>
  Effect.gen(function* () {
    const watchId = standaloneWatchId(checkout, prUrl);
    const watch = yield* readNativeWatch(config, watchId);
    const consumer = watch?.envelope.state.consumer;
    // A superseded watch records its latest replacement; any other stop stays as it is.
    if (
      !watch ||
      !consumer ||
      (watch.envelope.stopRequested &&
        (watch.envelope.stopReason !== 'superseded' || watch.envelope.supersededBy === supersededBy)) ||
      watch.envelope.owner ||
      watch.envelope.state.pr !== prUrl
    )
      return undefined;
    yield* runNativeWatch(config, {
      protocolVersion: 1,
      executorVersion: 1,
      action: 'watch',
      command: 'stop',
      watchId,
      consumerId: consumer.id,
      wakeupId: consumer.wakeupId,
      expectedRevision: watch.revision,
      stopReason: 'superseded',
      supersededBy,
    });
    return watchId;
  });

/** Wire references explicitly identify a standalone watch; no workflow run or validation is created. */
const standaloneEventRefs = {
  encode: (ref: NativeTaskActionRef) => {
    const {runId: scope, generationHash: bindingDigest, ...event} = ref;
    return eventPrefix + encode({...event, scope, bindingDigest});
  },
  decode: (value: string): NativeTaskActionRef | undefined => {
    try {
      const raw = decode(value, eventPrefix);
      const shape = Schema.decodeUnknownSync(Schema.Struct({scope: text, bindingDigest: text}), {
        onExcessProperty: 'ignore',
      })(raw);
      const event = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(raw);
      const {scope: _scope, bindingDigest: _bindingDigest, ...fields} = event;
      return Schema.decodeUnknownSync(NativeTaskActionRefSchema, {onExcessProperty: 'error'})({
        ...fields,
        runId: shape.scope,
        generationHash: shape.bindingDigest,
      });
    } catch {
      return undefined;
    }
  },
};

const observePr = Effect.fn('workflowAutomation.standalonePrTruth')(function* (prUrl: string) {
  const target = yield* Effect.try({
    try: () => nativeWatchPullRequest(prUrl),
    catch: () => fail('invalid-pr', 'Provide an explicit GitHub PR URL.'),
  });
  const response = yield* runCommandEffect(
    'gh',
    [
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      `repos/${target.owner}/${target.repo}/pulls/${target.number}`,
      '--jq',
      '{number, url: .html_url, baseRepository: .base.repo.full_name, baseBranch: .base.ref, headBranch: .head.ref, headSha: .head.sha, state, merged}',
    ],
    {timeoutMs: 15_000, maxOutputBytes: 16_384, sensitiveOutput: true},
  );
  const raw = yield* Effect.try({
    try: () => JSON.parse(response.stdout) as unknown,
    catch: () => fail('provider-shape', 'The actual GitHub PR identity is unavailable.'),
  });
  const truth = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      number: Schema.Int,
      url: text,
      baseRepository: text,
      baseBranch: text,
      headBranch: text,
      headSha: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)),
      state: Schema.Literals(['open', 'closed']),
      merged: Schema.Boolean,
    }),
    {onExcessProperty: 'error'},
  )(raw).pipe(Effect.mapError(() => fail('provider-shape', 'The actual GitHub PR identity is unavailable.')));
  if (
    truth.number !== target.number ||
    truth.url !== prUrl ||
    EffectString.toLowerCase(truth.baseRepository) !== EffectString.toLowerCase(`${target.owner}/${target.repo}`)
  )
    return yield* fail('watch-identity-conflict', 'GitHub returned another PR identity.');
  return truth;
});

export const runStandalonePrWatch = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'watch-pr'}>,
  checkout: string,
) =>
  Effect.gen(function* () {
    if (
      request.runId ||
      request.validationRef ||
      request.deliveryRef ||
      request.phaseId ||
      request.takeover ||
      request.recoverWakeup
    )
      return yield* fail(
        'invalid-request',
        'Standalone monitoring cannot use workflow proof, takeover or host redirection.',
      );
    if (request.operation === 'complete')
      return yield* fail(
        'standalone-monitor-only',
        'Standalone watches monitor PRs and do not complete workflow delivery or grant merge authority.',
      );
    let binding: typeof bindingSchema.Type;
    if (request.watchRef) {
      const watchRef = request.watchRef;
      const raw = yield* Effect.try({
        try: () => decode(watchRef, prefix),
        catch: () => fail('invalid-watch-ref', 'Use the exact returned standalone watch reference.'),
      });
      binding = yield* Schema.decodeUnknownEffect(bindingSchema, {onExcessProperty: 'error'})(raw).pipe(
        Effect.mapError(() => fail('invalid-watch-ref', 'Use the exact returned standalone watch reference.')),
      );
      if (
        binding.checkout !== checkout ||
        (request.prUrl !== undefined && request.prUrl !== binding.prUrl) ||
        (request.wakeup !== undefined && stableJson(request.wakeup) !== stableJson(binding.wakeup))
      )
        return yield* fail(
          'watch-identity-conflict',
          'The reference belongs to another checkout, PR or registered host.',
        );
    } else {
      if (request.operation !== 'start' || !request.prUrl || !request.wakeup)
        return yield* fail(
          'standalone-watch-input-required',
          'Start with an explicit prUrl and actual host registration; resume with the returned watchRef.',
        );
      const wakeup = yield* Schema.decodeUnknownEffect(nativeWatchWakeupSchema)(request.wakeup).pipe(
        Effect.mapError(() => fail('invalid-request', 'Standalone start requires the actual host executable.')),
      );
      const truth = yield* observePr(request.prUrl);
      binding = {
        version: 1,
        checkout,
        prUrl: truth.url,
        baseBranch: truth.baseBranch,
        headBranch: truth.headBranch,
        wakeup,
      };
    }
    yield* verifyNativePrRepository(checkout, binding.prUrl);
    const {watchId, consumerId, digest} = bindingIdentity(binding);
    const watchRef = prefix + encode(binding);
    const scope = {runId: watchId, generationHash: digest};
    let watch = yield* readNativeWatch(config, watchId);
    const checkIdentity = (stored: typeof watch) =>
      stored !== undefined &&
      stored.envelope.state.pr === binding.prUrl &&
      stored.envelope.state.consumer?.id === consumerId &&
      stored.envelope.state.consumer.wakeupId === consumerId &&
      stableJson(stored.envelope.notification?.target) === stableJson(binding.wakeup);
    // A superseded watch stays stopped while the live workflow-bound watch that replaced it monitors the PR.
    const successorId = watch?.envelope.stopReason === 'superseded' ? watch.envelope.supersededBy : undefined;
    const successor = successorId
      ? yield* readNativeWatch(config, successorId).pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    if (
      request.operation === 'start' &&
      successor &&
      !successor.envelope.stopRequested &&
      successor.envelope.state.consumer &&
      successor.envelope.state.prState === 'open' &&
      successor.envelope.state.pr === binding.prUrl &&
      (yield* nativeWatchCollectorAlive(successor.envelope.collector))
    )
      return yield* fail(
        'watch-superseded',
        `The workflow-bound watch ${successorId} monitors this PR and wakes its session. Continue with that watch. A standalone start restarts this watch after that watch stops.`,
      );
    // Only a failed admission or a workflow-bound handover may be revived; an explicit stop stays stopped.
    const retryFailedAdmission =
      request.operation === 'start' &&
      watch !== undefined &&
      checkIdentity(watch) &&
      watch.envelope.stopRequested &&
      watch.envelope.state.prState === 'open' &&
      (watch.envelope.collector?.reason === 'collector-startup-failed' || watch.envelope.stopReason === 'superseded') &&
      !(yield* nativeWatchCollectorAlive(watch.envelope.collector));
    if (request.operation === 'start' && (!watch || retryFailedAdmission)) {
      if (!watch && request.watchRef)
        return yield* fail('watch-not-found', 'A watch reference cannot create or redirect a watch.');
      yield* runNativeWatch(config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'start',
        watchId,
        pr: binding.prUrl,
        consumerId,
        wakeupId: consumerId,
        wakeup: binding.wakeup,
        ...(watch ? {expectedRevision: watch.revision} : {}),
      });
      watch = yield* readNativeWatch(config, watchId);
    }
    if (!checkIdentity(watch))
      return yield* fail(
        'watch-identity-conflict',
        'No stored watch matches the exact standalone PR, checkout and host binding.',
      );
    if (!watch) return yield* fail('watch-not-found', 'Start the explicit standalone PR watch first.');
    const terminalEmpty =
      watch.envelope.state.prState !== 'open' &&
      watch.envelope.state.events.length === 0 &&
      watch.envelope.state.delivery === null &&
      watch.envelope.state.acknowledged === watch.envelope.state.nextSequence - 1 &&
      !EffectArray.some(watch.envelope.state.work, row => row.status === 'open' || row.status === 'blocked');
    if (terminalEmpty && EffectArray.contains(['start', 'relay', 'ack', 'disposition', 'renew'], request.operation))
      return {
        status: 'terminal-empty',
        watchId,
        watchRef,
        prUrl: binding.prUrl,
        revision: watch.revision,
        authority: 'monitor-only' as const,
      };
    if (request.operation === 'start' || request.operation === 'renew') {
      if (request.operation === 'renew') {
        yield* runNativeWatch(config, {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'watch',
          command: 'renew',
          watchId,
          pr: binding.prUrl,
          consumerId,
          wakeupId: consumerId,
          wakeup: binding.wakeup,
          baseBranch: binding.baseBranch,
          headBranch: binding.headBranch,
        });
        watch = yield* readNativeWatch(config, watchId);
        if (!checkIdentity(watch)) return yield* fail('watch-readback-mismatch', 'The renewed watch changed identity.');
      }
      const inspected = yield* runNativePrWatchOperation(
        config,
        {operation: 'inspect'},
        watch!,
        scope,
        standaloneEventRefs,
      );
      const health: Record<string, unknown> | undefined = Predicate.isObject(inspected.result)
        ? inspected.result
        : undefined;
      const status =
        health?.stopRequested === true
          ? 'watch-stopped'
          : health?.prState !== 'open'
            ? 'terminal'
            : health?.monitoring === 'interrupted'
              ? 'watch-interrupted'
              : 'watching';
      return {...inspected, status, watchRef, authority: 'monitor-only' as const};
    }
    const {wakeup: _wakeup, ...operation} = request;
    return {
      ...(yield* runNativePrWatchOperation(config, operation, watch, scope, standaloneEventRefs)),
      authority: 'monitor-only' as const,
    };
  });
