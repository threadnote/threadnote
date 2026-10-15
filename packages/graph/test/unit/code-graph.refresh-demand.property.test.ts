import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  deferCodeGraphRefreshDemand,
  emptyCodeGraphRefreshDemand,
  enqueueCodeGraphRefreshDemand,
  registerCodeGraphRefreshDemand,
  recoverCodeGraphRefreshDemand,
  resumeCodeGraphRefreshDemand,
} from '@threadnote/graph/refresh/demand_scheduler';

const checkout = 'a'.repeat(64);
const worktree = 'b'.repeat(64);
const zeroTarget = '0'.repeat(64);
const oneTarget = '1'.padEnd(64, '0');
const target = fc.array(fc.integer({min: 0, max: 15}), {minLength: 1, maxLength: 8}).map(value =>
  value
    .map(part => part.toString(16))
    .join('')
    .padEnd(64, '0')
    .slice(0, 64),
);

describe('code graph refresh demand properties', () => {
  it('coalesces every preflight sequence to one latest desired target without claiming ownership', () => {
    fc.assert(
      fc.property(fc.array(target, {maxLength: 40}), targets => {
        const state = targets.reduce(
          (current, targetKey, index) =>
            enqueueCodeGraphRefreshDemand(current, {
              now: index,
              targetKey,
              token: `cgdq_${index.toString(16).padStart(32, '0')}`,
            }).state,
          emptyCodeGraphRefreshDemand(checkout, worktree),
        );

        expect(state.active).toBeUndefined();
        expect(state.desired?.targetKey).toBe(targets.at(-1));
      }),
      {numRuns: 200},
    );
  });

  it('is deterministic and makes the final observed target authoritative', () => {
    fc.assert(
      fc.property(fc.array(target, {maxLength: 40}), targets => {
        let state = emptyCodeGraphRefreshDemand(checkout, worktree);
        for (const [index, targetKey] of targets.entries()) {
          state = registerCodeGraphRefreshDemand(state, {
            now: index,
            targetKey,
            token: `cgdq_${index.toString(16).padStart(32, '0')}`,
          }).state;
        }
        if (targets.length === 0) return;
        expect(state.active?.targetKey).toBe(targets[0]);
        const latest = targets.at(-1)!;
        expect(state.desired?.targetKey).toBe(latest === targets[0] ? undefined : latest);
        const replay = targets.reduce(
          (current, targetKey, index) =>
            registerCodeGraphRefreshDemand(current, {
              now: index,
              targetKey,
              token: `cgdq_${index.toString(16).padStart(32, '0')}`,
            }).state,
          emptyCodeGraphRefreshDemand(checkout, worktree),
        );
        expect(replay).toEqual(state);
      }),
      {numRuns: 200},
    );
  });

  it('never creates an idle lane and uses only persisted or caller-provided demand tokens', () => {
    fc.assert(
      fc.property(fc.array(target, {maxLength: 40}), target, fc.boolean(), (targets, requested, ownerLive) => {
        const state = targets.reduce(
          (current, targetKey, index) =>
            registerCodeGraphRefreshDemand(current, {
              now: index,
              targetKey,
              token: `cgdq_${index.toString(16).padStart(32, '0')}`,
            }).state,
          emptyCodeGraphRefreshDemand(checkout, worktree),
        );
        const admitted = state.desired ?? state.active;
        const replacementToken = `cgdq_${'f'.repeat(32)}`;
        const resumed = resumeCodeGraphRefreshDemand(state, {
          now: targets.length + 1,
          owner: {processId: 1},
          ownerLive,
          targetKey: requested,
          token: replacementToken,
        });

        expect(resumed !== undefined).toBe(admitted !== undefined);
        if (resumed === undefined || admitted === undefined) return;
        expect(resumed.target.targetKey).toBe(requested);
        const admittedTokens = new Set([
          replacementToken,
          ...[state.active, state.desired]
            .filter(candidate => candidate?.targetKey === requested)
            .map(candidate => candidate!.targetToken),
        ]);
        expect(admittedTokens.has(resumed.target.targetToken)).toBe(true);
        const admittedKeys = new Set([state.active?.targetKey, state.desired?.targetKey, requested].filter(Boolean));
        for (const key of [resumed.state.active?.targetKey, resumed.state.desired?.targetKey].filter(Boolean))
          expect(admittedKeys.has(key)).toBe(true);
      }),
      {examples: [[[oneTarget, zeroTarget], oneTarget, false]], numRuns: 200},
    );
  });

  it('carries a capped monotonic retry attempt through every reclaimed target', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 12}), failures => {
        const targetKey = '1'.repeat(64);
        const targetToken = 'cgdq_11111111111111111111111111111111';
        let now = 0;
        let state = registerCodeGraphRefreshDemand(emptyCodeGraphRefreshDemand(checkout, worktree), {
          now,
          targetKey,
          token: targetToken,
        }).state;
        for (let attempt = 1; attempt <= failures; attempt += 1) {
          state = deferCodeGraphRefreshDemand(state, targetToken, targetKey, now);
          const expectedAttempt = Math.min(8, attempt);
          expect(state.desired?.retry?.attempt).toBe(expectedAttempt);
          const delay = Math.min(60_000, 250 * 2 ** (expectedAttempt - 1));
          expect(state.desired?.retry?.notBefore).toBe(now + delay);
          now += delay;
          const claimed = registerCodeGraphRefreshDemand(state, {now, targetKey, token: targetToken});
          expect(claimed.type).toBe('claimed');
          state = claimed.state;
        }
      }),
      {numRuns: 100},
    );
  });

  it('preserves one deferred target and its backoff under repeated equivalent demand', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), {maxLength: 100}), operations => {
        const targetKey = '1'.repeat(64);
        const targetToken = 'cgdq_11111111111111111111111111111111';
        const claimed = registerCodeGraphRefreshDemand(emptyCodeGraphRefreshDemand(checkout, worktree), {
          now: 0,
          targetKey,
          token: targetToken,
        });
        let state = deferCodeGraphRefreshDemand(claimed.state, targetToken, targetKey, 0);

        for (const [index, enqueue] of operations.entries()) {
          const observed = enqueue
            ? enqueueCodeGraphRefreshDemand(state, {
                now: index + 1,
                targetKey,
                token: `cgdq_${(index + 2).toString(16).padStart(32, '0')}`,
              })
            : registerCodeGraphRefreshDemand(state, {
                now: index + 1,
                targetKey,
                token: `cgdq_${(index + 2).toString(16).padStart(32, '0')}`,
              });
          expect(observed.type).toBe('deferred');
          state = observed.state;
        }

        expect(state.active).toBeUndefined();
        expect(state.desired).toMatchObject({
          requestedAt: 0,
          retry: {attempt: 1, notBefore: 250},
          targetKey,
          targetToken,
        });
      }),
      {numRuns: 100},
    );
  });
  it('suppresses invalid targets across repeated requests and resumes after a changed recovery fingerprint', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 40}), fc.boolean(), (repeats, enqueue) => {
        const input = {now: 0, targetKey: zeroTarget, token: `cgdq_${'1'.repeat(32)}`, recoveryKey: 'c'.repeat(64)};
        const claimed = registerCodeGraphRefreshDemand(emptyCodeGraphRefreshDemand(checkout, worktree), input);
        let state = deferCodeGraphRefreshDemand(claimed.state, input.token, input.targetKey, 0, true);
        for (let index = 1; index <= repeats; index++) {
          const observed = (enqueue ? enqueueCodeGraphRefreshDemand : registerCodeGraphRefreshDemand)(state, {
            ...input,
            now: index * 100_000,
          });
          expect(observed.type).toBe('deferred');
          expect(observed.state.active).toBeUndefined();
          state = observed.state;
        }
        const resumed = resumeCodeGraphRefreshDemand(state, {
          ...input,
          now: 1_000_000,
          ownerLive: false,
          recoveryKey: 'd'.repeat(64),
        });
        expect(resumed?.type).toBe('claimed');
        expect(resumed?.target.retry).toBeUndefined();
        expect(resumed?.target.recoveryKey).toBe('d'.repeat(64));
      }),
      {numRuns: 50},
    );
  });

  it('preserves failed-attempt history when a reclaimed retry owner dies before publication', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 8}), attempts => {
        const input = {now: 0, targetKey: zeroTarget, token: `cgdq_${'1'.repeat(32)}`};
        let state = registerCodeGraphRefreshDemand(emptyCodeGraphRefreshDemand(checkout, worktree), input).state;
        for (let attempt = 0; attempt < attempts; attempt++) {
          state = deferCodeGraphRefreshDemand(state, input.token, input.targetKey, input.now);
          input.now = state.desired!.retry!.notBefore;
          state = registerCodeGraphRefreshDemand(state, input).state;
        }
        const recovered = recoverCodeGraphRefreshDemand(state, false);
        expect(recovered.desired?.retry).toEqual(state.active?.retry);
        const resumed = registerCodeGraphRefreshDemand(recovered, input);
        const failedAgain = deferCodeGraphRefreshDemand(resumed.state, input.token, input.targetKey, input.now);
        expect(failedAgain.desired?.retry?.attempt).toBe(Math.min(8, attempts + 1));
      }),
      {numRuns: 50},
    );
  });
});
