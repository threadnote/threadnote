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
import {
  readNativeWatch,
  writeNativeWatch,
  readNativeCandidateWatchInventory,
} from '../../src/workflow_automation/watch_store.js';

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
    const owner = {
      kind: 'supplemental-publication' as const,
      runId: 'run-1',
      generationHash: EffectString.repeat(64)('a'),
      publicationId: 'pub-1',
      head: EffectString.repeat(40)('a'),
      tree: EffectString.repeat(40)('b'),
      phaseId: 'one',
      prUrl: envelope.state.pr,
    };
    const owned = yield* writeNativeWatch(
      config,
      {...envelope, state: initializeNativeWatch('sup-owned', owner.prUrl, 0), owner},
      null,
    );
    expect(
      (yield* writeNativeWatch(
        config,
        {...owned.envelope, owner: {...owner, publicationId: 'pub-2'}},
        owned.revision,
      ).pipe(Effect.result))._tag,
    ).toBe('Failure');
    expect((yield* readNativeWatch(config, 'sup-owned'))?.revision).toBe(owned.revision);
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

it('requires typed diagnostic owners and fails closed on mismatched owner state or invalidation', () => {
  const owner = {
    kind: 'supplemental-publication',
    runId: 'run-1',
    generationHash: EffectString.repeat(64)('a'),
    publicationId: 'pub-1',
    head: EffectString.repeat(40)('a'),
    tree: EffectString.repeat(40)('b'),
    phaseId: 'one',
    prUrl: fixture().state.pr,
  };
  const input = {...fixture(), state: initializeNativeWatch('sup-fixture', owner.prUrl, 0), owner};
  expect(decodeNativeWatchEnvelope(input).owner).toEqual(owner);
  expect(() => decodeNativeWatchEnvelope({...input, owner: undefined})).toThrow();
  expect(() => decodeNativeWatchEnvelope({...input, owner: {...owner, kind: 'candidate-pr'}})).toThrow();
  expect(() =>
    decodeNativeWatchEnvelope({...input, state: {...input.state, head: EffectString.repeat(40)('c')}}),
  ).toThrow();
  expect(() =>
    decodeNativeWatchEnvelope({
      ...input,
      invalidation: {kind: 'candidate_invalidated', reason: 'drift', at: 0},
      stopRequested: true,
    }),
  ).toThrow();
  expect(() => decodeNativeWatchEnvelope({...fixture(), owner})).toThrow();
});

import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {fixture as workflowFixture, run} from './native-cycle-lifecycle-fixture.js';

effectIt.effect('refuses a candidate inventory replacement before decoding uncharged bytes', () =>
  Effect.gen(function* () {
    const f = yield* workflowFixture(['one']);
    const stored = yield* readNativeWorkflowState(f.config, 'native-run');
    if (!stored) throw new Error('Missing workflow fixture');
    const watchId = 'candidate-' + EffectString.repeat(48)('a');
    const owner = {
      kind: 'candidate-pr' as const,
      runId: stored.state.runId,
      generationHash: EffectString.repeat(64)('a'),
      phaseId: 'one',
      phaseHash: EffectString.repeat(64)('b'),
      snapshotRef: 'fixture-snapshot-ref',
      snapshotId: 'fixture-snapshot',
      snapshotDigest: EffectString.repeat(64)('c'),
      baselineHead: EffectString.repeat(40)('a'),
      baselineTree: EffectString.repeat(40)('b'),
      baselineRef: 'refs/heads/main',
      callerCwd: f.repo,
      head: EffectString.repeat(40)('a'),
      tree: EffectString.repeat(40)('b'),
      branch: 'main',
      scopeDigest: EffectString.repeat(64)('d'),
      prUrl: fixture().state.pr,
      comparisonRef: 'refs/heads/main',
      comparisonResolvedRef: EffectString.repeat(40)('a'),
      baseConfigDigest: EffectString.repeat(64)('e'),
      baseBranch: 'main',
      headBranch: 'main',
    };
    const initial = yield* writeNativeWatch(
      f.config,
      decodeNativeWatchEnvelope({
        ...fixture(),
        state: initializeNativeWatch(watchId, owner.prUrl, 0),
        owner,
      }),
      null,
    );
    const file = f.path.join(f.config.agentContextHome, 'workflow-automations', 'native-watch-v1', watchId + '.json');
    const firstBytes = yield* f.fs.readFileString(file);
    const replacement = yield* writeNativeWatch(
      f.config,
      {
        ...initial.envelope,
        metrics: {...initial.envelope.metrics, requests: 1000000},
      },
      initial.revision,
    );
    const replacementBytes = yield* f.fs.readFileString(file);
    expect(replacementBytes.length).toBeGreaterThan(firstBytes.length);
    yield* f.fs.writeFileString(file, firstBytes);
    const unchanged = yield* readNativeCandidateWatchInventory(f.config, stored, f.repo);
    expect(unchanged.rows).toHaveLength(1);
    expect(unchanged.rows[0]?.watchRevision).toBe(initial.revision);
    let reads = 0;
    const racingFs = FileSystem.FileSystem.of({
      ...f.fs,
      readFileString: name =>
        f.path.basename(name) === watchId + '.json'
          ? Effect.gen(function* () {
              reads++;
              const bytes = yield* f.fs.readFileString(name);
              if (reads === 1) yield* f.fs.writeFileString(file, replacementBytes);
              return bytes;
            })
          : f.fs.readFileString(name),
    });
    const raced = yield* readNativeCandidateWatchInventory(f.config, stored, f.repo).pipe(
      Effect.provideService(FileSystem.FileSystem, racingFs),
      Effect.result,
    );
    expect(reads).toBe(2);
    expect(raced).toMatchObject({_tag: 'Failure', failure: {code: 'watch-inventory-changed'}});
    expect((yield* readNativeWatch(f.config, watchId))?.revision).toBe(replacement.revision);
    const updated = yield* readNativeCandidateWatchInventory(f.config, stored, f.repo);
    expect(updated.rows[0]?.watchRevision).toBe(replacement.revision);
  }).pipe(run),
);
