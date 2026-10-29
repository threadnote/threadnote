import {it} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {initializeNativeWatch} from '@threadnote/workflow-automations/watch';
import {readNativeWatch, writeNativeWatch} from '../../src/workflow_automation/watch_store.js';
import {parseWatchWorkResponse} from './release-artifact.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

it.effect('dispatches explicit consumer attachment and renewal without a collector or provider sweep', () =>
  Effect.gen(function* () {
    const f = yield* nativeFixture().pipe(TestClock.withLive);
    const stored = yield* writeNativeWatch(
      f.config,
      {
        format: 'threadnote-native-watch-runtime',
        version: 1,
        state: initializeNativeWatch('consumer-watch', 'https://github.com/fixture/repo/pull/1', 0),
        provider: {pages: []},
        collector: null,
        stopRequested: false,
        metrics: {
          requests: 0,
          notModified: 0,
          responseBytes: 0,
          graphqlCost: 0,
          providerMilliseconds: 0,
          sweeps: 0,
          consumerReads: 0,
        },
      },
      null,
    );
    const request = {
      protocolVersion: 1,
      executorVersion: 1,
      action: 'watch',
      command: 'consumer',
      watchId: 'consumer-watch',
      consumerId: 'fixture-consumer',
      wakeupId: 'fixture-wakeup',
    };
    const workResponse = yield* f.call({...request, command: 'work'});
    expect(workResponse).not.toHaveProperty('collector');
    expect(parseWatchWorkResponse(workResponse)).toMatchObject({
      status: 'ok',
      watchId: request.watchId,
      revision: stored.revision,
      work: {items: [], offset: 0, nextOffset: null},
    });
    const attached = yield* f.call({...request, expectedRevision: stored.revision});
    expect(attached).toMatchObject({
      protocolVersion: 1,
      executorVersion: 1,
      status: 'ok',
      collector: {alive: false, status: 'absent'},
      consumer: {live: true, id: request.consumerId, wakeupId: request.wakeupId},
      ready: false,
    });
    const beforeRenewal = yield* readNativeWatch(f.config, request.watchId);
    if (!beforeRenewal) throw new Error('Expected an attached native watch');
    yield* TestClock.adjust(1000);
    const renewed = yield* f.call({...request, expectedRevision: beforeRenewal.revision});
    expect(renewed).toMatchObject({status: 'ok', consumer: {live: true, id: request.consumerId}});
    const afterRenewal = yield* readNativeWatch(f.config, request.watchId);
    if (!afterRenewal) throw new Error('Expected a renewed native watch');
    expect(afterRenewal.envelope.state.consumer?.lastSeenAt).toBe(
      beforeRenewal.envelope.state.consumer!.lastSeenAt + 1000,
    );
    expect(afterRenewal.envelope.state.consumer?.leaseUntil).toBe(
      beforeRenewal.envelope.state.consumer!.leaseUntil + 1000,
    );
    expect(afterRenewal.envelope.collector).toBeNull();
    expect(afterRenewal.envelope.provider).toEqual(stored.envelope.provider);
    expect(afterRenewal.envelope.metrics).toEqual(stored.envelope.metrics);
    expect(afterRenewal.envelope.state.events).toEqual(stored.envelope.state.events);
    expect(afterRenewal.envelope.state.work).toEqual(stored.envelope.state.work);
    const statePath = f.path.join(f.home, 'workflow-automations', 'native-watch-v1', request.watchId + '.json');
    const stateBytes = yield* f.fs.readFileString(statePath);
    expect(yield* f.call({...request, expectedRevision: stored.revision}).pipe(Effect.result)).toMatchObject({
      failure: {code: 'watch-state-conflict'},
    });
    expect(yield* f.fs.readFileString(statePath)).toBe(stateBytes);
  }).pipe(provideNative),
);
