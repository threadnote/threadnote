import fc from 'fast-check';
import {describe, it, expect} from 'vitest';
import {initializeNativeWatch} from '@threadnote/workflow-automations/watch';
import {decodeNativeWatchEnvelope} from '../../src/workflow_automation/watch_store.js';
import {runtimeConfigForTest} from '@threadnote/workspace/test/helpers/runtime-config';
const fixture = () => ({
  format: 'threadnote-native-watch-runtime',
  version: 1,
  state: initializeNativeWatch('watch-1', 'https://github.com/test/repo/pull/1', 0),
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
});
describe('native watch envelope', () => {
  it('round trips bounded metric values without mutation', () => {
    fc.assert(
      fc.property(fc.nat({max: 1_000_000}), count => {
        const input = {...fixture(), metrics: {...fixture().metrics, requests: count}};
        const before = JSON.stringify(input);
        expect(decodeNativeWatchEnvelope(JSON.parse(before))).toEqual(input);
        expect(JSON.stringify(input)).toBe(before);
      }),
      {numRuns: 30},
    );
  });
  it('round trips a strict envelope', () =>
    expect(decodeNativeWatchEnvelope(JSON.parse(JSON.stringify(fixture())))).toEqual(fixture()));
  it.each([null, false, true])('retains nullable mergeability metadata through the cache envelope: %s', mergeable => {
    const input = {
      ...fixture(),
      provider: {
        pages: [
          {
            key: 'pull',
            etag: '"pull"',
            projection: {
              items: [],
              size: 0,
              pending: 0,
              failed: 0,
              pull: {
                head: Effect2.pipe('a', EffectString.repeat(40)),
                base: Effect2.pipe('b', EffectString.repeat(40)),
                mergeable,
                state: 'open',
              },
            },
          },
        ],
      },
    };
    expect(decodeNativeWatchEnvelope(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });
  it('rejects unknown fields and legacy state', () => {
    expect(() => decodeNativeWatchEnvelope({...fixture(), token: 'secret'})).toThrow();
    expect(() => decodeNativeWatchEnvelope(fixture().state)).toThrow();
  });
  it('rejects provider headers with control characters', () =>
    expect(() =>
      decodeNativeWatchEnvelope({
        ...fixture(),
        provider: {
          pages: [{key: 'comments', etag: 'bad\r\nheader', projection: {items: [], size: 0, pending: 0, failed: 0}}],
        },
      }),
    ).toThrow());
});

import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as BunServices from '@effect/platform-bun/BunServices';
import {readNativeWatch, writeNativeWatch} from '../../src/workflow_automation/watch_store.js';

import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

effectIt.effect('read does not create state; CAS preserves exact old bytes and corrupt state', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'native-watch-store-'});
    const config = runtimeConfigForTest({agentContextHome: home});
    expect(yield* readNativeWatch(config, 'watch-1')).toBeUndefined();
    expect(yield* fs.exists(path.join(home, 'workflow-automations'))).toBe(false);
    const envelope = decodeNativeWatchEnvelope(fixture());
    const initial = yield* writeNativeWatch(config, envelope, null);
    const file = path.join(home, 'workflow-automations', 'native-watch-v1', 'watch-1.json');
    const bytes = yield* fs.readFileString(file);
    expect((yield* writeNativeWatch(config, {...envelope, stopRequested: true}, 'bad').pipe(Effect.result))._tag).toBe(
      'Failure',
    );
    expect(yield* fs.readFileString(file)).toBe(bytes);
    expect((yield* readNativeWatch(config, 'watch-1'))?.revision).toBe(initial.revision);
    yield* fs.writeFileString(file, '{"legacy":true}');
    expect((yield* readNativeWatch(config, 'watch-1').pipe(Effect.result))._tag).toBe('Failure');
    expect((yield* writeNativeWatch(config, envelope, null).pipe(Effect.result))._tag).toBe('Failure');
    expect(yield* fs.readFileString(file)).toBe('{"legacy":true}');
    yield* fs.remove(file);
    const outside = path.join(home, 'outside.json');
    yield* fs.writeFileString(outside, bytes);
    yield* fs.symlink(outside, file);
    expect((yield* readNativeWatch(config, 'watch-1').pipe(Effect.result))._tag).toBe('Failure');
    expect((yield* writeNativeWatch(config, envelope, null).pipe(Effect.result))._tag).toBe('Failure');
    expect(yield* fs.readFileString(outside)).toBe(bytes);
  }).pipe(provideTestLayer(BunServices.layer), TestClock.withLive),
);
