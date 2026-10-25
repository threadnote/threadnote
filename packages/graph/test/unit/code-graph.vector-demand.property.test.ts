import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {
  acknowledgeCodeGraphEmbeddingDemandLane,
  claimCodeGraphEmbeddingDemandLane,
  enqueueCodeGraphEmbeddingDemandLane,
  selectCodeGraphEmbeddingDemandLane,
  type CodeGraphEmbeddingDemandLane,
} from '../../src/vector/demand_scheduler.js';

const model = {id: 'model', sha256: 'a'.repeat(64), dimensions: 2, templateVersion: 1};
const laneId = {worktreeId: 'b'.repeat(64), scopeId: 'full'};
const target = (snapshot: number, epoch: number) => ({
  ...laneId,
  snapshotId: `snapshot-${snapshot}`,
  activatedAt: new Date(epoch).toISOString(),
});
const commands = Schema.Array(
  Schema.Struct({
    action: Schema.Literals([
      'enqueue',
      'claim',
      'step',
      'promote',
      'ABA',
      'restart',
      'defer',
      'fail',
      'advance',
      'finish',
    ]),
    value: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 3})),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(64));

effectIt.effect.prop(
  'coalesced desired identity and expiring exclusive ownership survive arbitrary transitions and restart',
  {commands},
  ({commands}) =>
    Effect.gen(function* () {
      let epoch = 0;
      let latestSnapshot = 0;
      let lane: CodeGraphEmbeddingDemandLane = enqueueCodeGraphEmbeddingDemandLane(
        undefined,
        target(latestSnapshot, epoch),
      );
      let nextOwner = 0;
      for (const command of commands) {
        const now = yield* Clock.currentTimeMillis;
        if (command.action === 'enqueue' || command.action === 'promote' || command.action === 'ABA') {
          const previousActive = lane.active;
          if (command.action !== 'enqueue') epoch += 1;
          latestSnapshot = command.action === 'ABA' ? 0 : command.value;
          lane = enqueueCodeGraphEmbeddingDemandLane(lane, target(latestSnapshot, epoch));
          expect(lane.active).toEqual(previousActive);
        } else if (command.action === 'restart') {
          const before = structuredClone(lane);
          lane = JSON.parse(JSON.stringify(lane));
          expect(lane).toEqual(before);
        } else if (command.action === 'advance') {
          yield* TestClock.adjust((command.value + 1) * 100_000);
        } else if (command.action === 'claim') {
          const previous = lane;
          const claimed = claimCodeGraphEmbeddingDemandLane(lane, {
            now,
            model,
            owner: {token: `owner-${nextOwner++}`, processId: 123, processStartIdentity: 'process'},
            leaseMilliseconds: 1_000,
          });
          if (previous.active && previous.active.expiresAt > now) expect(claimed).toBeUndefined();
          if (
            previous.notBefore > now ||
            previous.state === 'blocked' ||
            previous.state === 'ready' ||
            previous.state === 'cancelled'
          )
            expect(claimed).toBeUndefined();
          if (claimed) {
            expect(claimed.active).toMatchObject({
              snapshotId: `snapshot-${latestSnapshot}`,
              activatedAt: target(latestSnapshot, epoch).activatedAt,
            });
            lane = claimed;
          }
        } else if (lane.active) {
          const claim = lane.active;
          const isCurrent =
            claim.snapshotId === `snapshot-${latestSnapshot}` &&
            claim.activatedAt === target(latestSnapshot, epoch).activatedAt;
          const kind =
            command.action === 'step'
              ? 'checkpoint'
              : command.action === 'fail'
                ? 'failure'
                : command.action === 'defer'
                  ? 'defer'
                  : 'finish';
          const result = acknowledgeCodeGraphEmbeddingDemandLane(lane, claim, {
            kind,
            now,
            jitter: 0,
            retryAfterMilliseconds: 1_000,
          });
          if (claim.expiresAt <= now) expect(result).toBeUndefined();
          if (result) {
            if (!isCurrent) expect(result.state).not.toBe('ready');
            if (kind === 'defer' && isCurrent) {
              expect(result.notBefore).toBeGreaterThan(now);
              expect(
                claimCodeGraphEmbeddingDemandLane(result, {
                  now,
                  model,
                  owner: {token: 'immediate-retry', processId: 124, processStartIdentity: 'retry'},
                }),
              ).toBeUndefined();
            }
            lane = result;
          }
        }
        expect(lane.snapshotId).toBe(`snapshot-${latestSnapshot}`);
        expect(lane.activatedAt).toBe(target(latestSnapshot, epoch).activatedAt);
        expect(lane.attempt).toBeGreaterThanOrEqual(0);
        expect(lane.attempt).toBeLessThanOrEqual(3);
      }
    }),
  {arbitrary: {runs: 48, seed: 25025}},
);

effectIt.effect.prop(
  'round robin gives every stable finite lane a turn despite repeated updates to a noisy lane',
  {
    count: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 24})),
    noise: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 1_000}))).check(Schema.isMaxLength(48)),
  },
  ({count, noise}) =>
    Effect.sync(() => {
      const lanes = Array.from({length: count}, (_, n) => ({key: n.toString().padStart(3, '0'), revision: 0}));
      let cursor: string | undefined;
      for (let round = 0; round < 3; round += 1) {
        const visited = new Set<string>();
        for (let n = 0; n < count; n += 1) {
          lanes[0] = {...lanes[0], revision: noise[(round * count + n) % Math.max(1, noise.length)] ?? n};
          const selected = selectCodeGraphEmbeddingDemandLane(lanes, cursor)!;
          visited.add(selected.key);
          cursor = selected.key;
        }
        expect(visited).toEqual(new Set(lanes.map(lane => lane.key)));
      }
    }),
  {arbitrary: {runs: 32, seed: 25026}},
);
