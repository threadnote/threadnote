import {describe, expect, it} from 'vitest';
import {
  adoptCodeGraphRefreshDemand,
  beginCodeGraphRefreshDemandPublication,
  completeCodeGraphRefreshDemand,
  deferCodeGraphRefreshDemand,
  emptyCodeGraphRefreshDemand,
  enqueueCodeGraphRefreshDemand,
  failCodeGraphRefreshDemand,
  recoverCodeGraphRefreshDemand,
  registerCodeGraphRefreshDemand,
  resumeCodeGraphRefreshDemand,
} from '@threadnote/graph/refresh/demand_scheduler';
import {codeGraphRefreshDemandContinuity} from '@threadnote/graph/refresh/demand';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const checkout = Effect.pipe('a', EffectString.repeat(64));
const worktree = Effect.pipe('b', EffectString.repeat(64));
const key = (value: string) => Effect.pipe(value, EffectString.repeat(64), EffectString.slice(0, 64));
const token = (value: string) => `cgdq_${Effect.pipe(value, EffectString.repeat(32), EffectString.slice(0, 32))}`;
const initial = () => emptyCodeGraphRefreshDemand(checkout, worktree);

describe('code graph refresh demand scheduler', () => {
  it('projects only opaque continuity from active, queued, and deferred demand', () => {
    const active = registerCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('1'), token: token('1')});
    expect(codeGraphRefreshDemandContinuity(active.state, 2)).toEqual({
      type: 'code-graph-refresh-continuity',
      version: 1,
      state: 'active',
      currentTargetToken: token('1'),
    });
    const queued = enqueueCodeGraphRefreshDemand(active.state, {now: 3, targetKey: key('2'), token: token('2')});
    expect(codeGraphRefreshDemandContinuity(queued.state, 4)).toMatchObject({
      state: 'active',
      currentTargetToken: token('1'),
      latestDesiredToken: token('2'),
    });
    const deferred = deferCodeGraphRefreshDemand(active.state, token('1'), key('1'), 10);
    expect(codeGraphRefreshDemandContinuity(deferred, 100)).toEqual({
      type: 'code-graph-refresh-continuity',
      version: 1,
      state: 'deferred',
      queueToken: token('1'),
      latestDesiredToken: token('1'),
      retryAfterMilliseconds: 160,
    });
    expect(JSON.stringify(codeGraphRefreshDemandContinuity(queued.state, 4))).not.toContain(key('1'));
  });
  it('records intent before ownership and preserves the original claim deadline on attachment', () => {
    const queued = enqueueCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('1'), token: token('1')});
    expect(queued.type).toBe('queued');
    expect(queued.state.active).toBeUndefined();
    expect(queued.state.desired?.targetKey).toBe(key('1'));

    const claimed = registerCodeGraphRefreshDemand(queued.state, {
      now: 2,
      targetKey: key('1'),
      token: token('2'),
    });
    const attached = enqueueCodeGraphRefreshDemand(claimed.state, {
      now: 20_000,
      targetKey: key('1'),
      token: token('3'),
    });

    expect(claimed.state.active?.targetToken).toBe(token('1'));
    expect(attached.state.active).toMatchObject({claimStartedAt: 2, updatedAt: 20_000});
  });

  it('keeps a separate latest target for every worktree', () => {
    const first = registerCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('1'), token: token('1')});
    const second = registerCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('2'), token: token('2')});
    const churn = registerCodeGraphRefreshDemand(first.state, {now: 2, targetKey: key('3'), token: token('3')});

    expect(churn.type).toBe('queued');
    expect(churn.state.active?.targetKey).toBe(key('1'));
    expect(churn.state.desired?.targetKey).toBe(key('3'));
    expect(second.state.active?.targetKey).toBe(key('2'));
  });

  it('recovers a dead claim without manufacturing an unowned active target', () => {
    const active = registerCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('1'), token: token('1')});
    const queued = registerCodeGraphRefreshDemand(active.state, {now: 2, targetKey: key('2'), token: token('2')});
    const latest = registerCodeGraphRefreshDemand(queued.state, {now: 3, targetKey: key('3'), token: token('3')});
    const recovered = recoverCodeGraphRefreshDemand(latest.state, false);

    expect(recovered.active).toBeUndefined();
    expect(recovered.desired?.targetKey).toBe(key('3'));
    const current = registerCodeGraphRefreshDemand(recovered, {
      now: 4,
      targetKey: key('4'),
      token: token('4'),
    });
    expect(current.type).toBe('claimed');
    expect(current.state.active?.targetKey).toBe(key('4'));
    expect(current.state.desired).toBeUndefined();
  });

  it('resumes only the latest admitted target and preserves its token', () => {
    const idle = resumeCodeGraphRefreshDemand(initial(), {
      now: 1,
      ownerLive: false,
      targetKey: key('1'),
      token: token('1'),
    });
    expect(idle).toBeUndefined();

    const active = registerCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('1'), token: token('1')});
    const queued = registerCodeGraphRefreshDemand(active.state, {now: 2, targetKey: key('2'), token: token('2')});
    const latest = resumeCodeGraphRefreshDemand(queued.state, {
      now: 3,
      ownerLive: true,
      targetKey: key('3'),
      token: token('3'),
    });
    expect(latest).toMatchObject({
      type: 'queued',
      state: {active: {targetKey: key('1')}, desired: {targetKey: key('3'), targetToken: token('3')}},
    });
    const resumed = resumeCodeGraphRefreshDemand(queued.state, {
      now: 4,
      owner: {processId: 4},
      ownerLive: false,
      targetKey: key('2'),
      token: token('4'),
    });
    expect(resumed).toMatchObject({type: 'claimed', target: {targetKey: key('2'), targetToken: token('2')}});
    expect(resumed?.state.desired).toBeUndefined();
  });

  it('drops obsolete desired demand when the worktree returns to the active target', () => {
    const active = registerCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('1'), token: token('1')});
    const queued = registerCodeGraphRefreshDemand(active.state, {now: 2, targetKey: key('2'), token: token('2')});
    const returned = registerCodeGraphRefreshDemand(queued.state, {now: 3, targetKey: key('1'), token: token('3')});

    expect(returned.state.desired).toBeUndefined();
    expect(returned.target.targetToken).toBe(token('1'));
  });

  it('claims a retained desired target after an active claim is cleared', () => {
    const active = registerCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('1'), token: token('1')});
    const queued = registerCodeGraphRefreshDemand(active.state, {now: 2, targetKey: key('2'), token: token('2')});
    const superseded = beginCodeGraphRefreshDemandPublication(queued.state, token('1'), key('1'));
    const claimed = registerCodeGraphRefreshDemand(superseded.state, {now: 3, targetKey: key('2'), token: token('3')});

    expect(claimed.type).toBe('claimed');
    expect(claimed.state.active?.targetToken).toBe(token('2'));
  });

  it('supersedes an obsolete claim at the scheduler publication gate', () => {
    const active = registerCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('1'), token: token('1')});
    const queued = registerCodeGraphRefreshDemand(active.state, {now: 2, targetKey: key('2'), token: token('2')});
    const result = beginCodeGraphRefreshDemandPublication(queued.state, token('1'), key('1'));

    expect(result.type).toBe('superseded');
    expect(result.state.active).toBeUndefined();
    expect(result.state.desired?.targetKey).toBe(key('2'));
  });

  it('increases retry backoff across claims and preserves a newer desired target', () => {
    const first = registerCodeGraphRefreshDemand(initial(), {now: 0, targetKey: key('1'), token: token('1')});
    const delayed = deferCodeGraphRefreshDemand(first.state, token('1'), key('1'), 10);
    expect(delayed.desired?.retry).toEqual({attempt: 1, notBefore: 260});
    const retry = registerCodeGraphRefreshDemand(delayed, {now: 260, targetKey: key('1'), token: token('2')});
    expect(retry.type).toBe('claimed');
    const delayedAgain = deferCodeGraphRefreshDemand(retry.state, token('1'), key('1'), 300);
    expect(delayedAgain.desired?.retry).toEqual({attempt: 2, notBefore: 800});

    const reclaimed = registerCodeGraphRefreshDemand(delayedAgain, {
      now: 800,
      targetKey: key('1'),
      token: token('3'),
    });
    const newer = registerCodeGraphRefreshDemand(reclaimed.state, {
      now: 801,
      targetKey: key('2'),
      token: token('2'),
    });
    const failed = deferCodeGraphRefreshDemand(newer.state, token('1'), key('1'), 900);
    expect(failed.active).toBeUndefined();
    expect(failed.desired?.targetKey).toBe(key('2'));
    expect(failed.desired?.retry).toBeUndefined();
  });

  it('releases a permanently failed claim without discarding the latest desired target', () => {
    const first = registerCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('1'), token: token('1')});
    const newer = registerCodeGraphRefreshDemand(first.state, {now: 2, targetKey: key('2'), token: token('2')});
    const failed = failCodeGraphRefreshDemand(newer.state, token('1'), key('1'));

    expect(failed.active).toBeUndefined();
    expect(failed.desired?.targetKey).toBe(key('2'));
  });

  it('never cancels a publishing target and preserves a later desired target', () => {
    const active = registerCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('1'), token: token('1')});
    const publishing = beginCodeGraphRefreshDemandPublication(active.state, token('1'), key('1'));
    const queued = registerCodeGraphRefreshDemand(publishing.state, {now: 2, targetKey: key('2'), token: token('2')});
    const again = beginCodeGraphRefreshDemandPublication(queued.state, token('1'), key('1'));
    const complete = completeCodeGraphRefreshDemand(again.state, token('1'), key('1'));

    expect(again.type).toBe('publish');
    expect(complete.desired?.targetKey).toBe(key('2'));
  });

  it('rejects an old demand token after WorktreeChanged computes a new target', () => {
    const active = registerCodeGraphRefreshDemand(initial(), {now: 1, targetKey: key('1'), token: token('1')});
    const changed = adoptCodeGraphRefreshDemand(active.state, token('1'), key('2'), {processId: 1});

    expect(changed.adopted).toBe(false);
    expect(changed.state).toEqual(active.state);
  });
});
