/**
 * The refresh-demand document is deliberately a scheduling hint, not a
 * publication authority.  It has one active claim and one replaceable desired
 * target per worktree, so a noisy caller cannot turn coordination into an
 * unbounded per-caller ledger.
 */
export const CODE_GRAPH_REFRESH_DEMAND_VERSION = 1 as const;
export const CODE_GRAPH_REFRESH_DEMAND_TOKEN = /^cgdq_[0-9a-f]{32}$/u;
export const CODE_GRAPH_REFRESH_DEMAND_KEY = /^[0-9a-f]{64}$/u;

export type CodeGraphRefreshDemandPhase = 'claimed' | 'preparing' | 'publishing';

export interface CodeGraphRefreshDemandTarget {
  readonly attachmentCount: number;
  readonly requestedAt: number;
  readonly recoveryKey?: string;
  readonly retry?: {readonly attempt: number; readonly blocked?: true; readonly notBefore: number};
  readonly targetKey: string;
  readonly targetToken: string;
  readonly updatedAt: number;
}

export interface CodeGraphRefreshDemandActive extends CodeGraphRefreshDemandTarget {
  readonly claimStartedAt: number;
  readonly claimOwner?: {readonly processId: number; readonly processStartIdentity?: string};
  readonly phase: CodeGraphRefreshDemandPhase;
}

export interface CodeGraphRefreshDemandState {
  readonly active?: CodeGraphRefreshDemandActive;
  readonly checkoutId: string;
  readonly desired?: CodeGraphRefreshDemandTarget;
  readonly revision: number;
  readonly version: typeof CODE_GRAPH_REFRESH_DEMAND_VERSION;
  readonly worktreeId: string;
}

export type CodeGraphRefreshDemandRegistration =
  | {
      readonly state: CodeGraphRefreshDemandState;
      readonly target: CodeGraphRefreshDemandActive;
      readonly type: 'claimed';
    }
  | {
      readonly state: CodeGraphRefreshDemandState;
      readonly target: CodeGraphRefreshDemandTarget;
      readonly type: 'attached';
    }
  | {
      readonly state: CodeGraphRefreshDemandState;
      readonly target: CodeGraphRefreshDemandTarget;
      readonly type: 'deferred';
    }
  | {
      readonly state: CodeGraphRefreshDemandState;
      readonly target: CodeGraphRefreshDemandTarget;
      readonly type: 'queued';
    };

const MAX_ATTACHMENTS = 1_000_000;
const nextRevision = (state: CodeGraphRefreshDemandState) => state.revision + 1;
const attach = <A extends CodeGraphRefreshDemandTarget>(target: A, now: number): A => ({
  ...target,
  attachmentCount: Math.min(MAX_ATTACHMENTS, target.attachmentCount + 1),
  updatedAt: now,
});

export function emptyCodeGraphRefreshDemand(checkoutId: string, worktreeId: string): CodeGraphRefreshDemandState {
  return {checkoutId, revision: 0, version: CODE_GRAPH_REFRESH_DEMAND_VERSION, worktreeId};
}

/**
 * Records latest intent without electing an owner. This is the synchronous
 * request preflight used before in-process deduplication or global permits.
 */
export function enqueueCodeGraphRefreshDemand(
  state: CodeGraphRefreshDemandState,
  input: {readonly now: number; readonly recoveryKey?: string; readonly targetKey: string; readonly token: string},
): CodeGraphRefreshDemandRegistration {
  const active = state.active;
  if (active?.targetKey === input.targetKey) {
    const target = attach(active, input.now);
    return {
      state: {...state, active: target, desired: undefined, revision: nextRevision(state)},
      target,
      type: 'attached',
    };
  }
  if (active) {
    if (state.desired?.targetKey === input.targetKey) {
      const target = attach(state.desired, input.now);
      return {
        state: {...state, desired: target, revision: nextRevision(state)},
        target,
        type: target.retry && (target.retry.blocked || target.retry.notBefore > input.now) ? 'deferred' : 'attached',
      };
    }
    const target: CodeGraphRefreshDemandTarget = {
      attachmentCount: 1,
      requestedAt: input.now,
      recoveryKey: input.recoveryKey,
      targetKey: input.targetKey,
      targetToken: input.token,
      updatedAt: input.now,
    };
    return {state: {...state, desired: target, revision: nextRevision(state)}, target, type: 'queued'};
  }
  const retained =
    state.desired?.targetKey === input.targetKey &&
    (!state.desired.retry?.blocked || state.desired.recoveryKey === input.recoveryKey)
      ? attach(state.desired, input.now)
      : undefined;
  const target = retained ?? {
    attachmentCount: 1,
    requestedAt: input.now,
    recoveryKey: input.recoveryKey,
    targetKey: input.targetKey,
    targetToken: input.token,
    updatedAt: input.now,
  };
  return {
    state: {...state, desired: target, revision: nextRevision(state)},
    target,
    type: target.retry && (target.retry.blocked || target.retry.notBefore > input.now) ? 'deferred' : 'queued',
  };
}

/** Latest target wins, except a publishing target is irrevocable. */
export function registerCodeGraphRefreshDemand(
  state: CodeGraphRefreshDemandState,
  input: {
    readonly now: number;
    readonly recoveryKey?: string;
    readonly owner?: CodeGraphRefreshDemandActive['claimOwner'];
    readonly targetKey: string;
    readonly token: string;
  },
): CodeGraphRefreshDemandRegistration {
  const active = state.active;
  if (active?.targetKey === input.targetKey) {
    const target = attach(active, input.now);
    return {
      state: {...state, active: target, desired: undefined, revision: nextRevision(state)},
      target,
      type: 'attached',
    };
  }
  if (!active) {
    const retained =
      state.desired?.targetKey === input.targetKey &&
      (!state.desired.retry?.blocked || state.desired.recoveryKey === input.recoveryKey)
        ? state.desired
        : undefined;
    const target = retained ?? {
      attachmentCount: 1,
      requestedAt: input.now,
      recoveryKey: input.recoveryKey,
      targetKey: input.targetKey,
      targetToken: input.token,
      updatedAt: input.now,
    };
    if (retained?.retry && (retained.retry.blocked || retained.retry.notBefore > input.now))
      return {state, target: retained, type: 'deferred'};
    const claimed: CodeGraphRefreshDemandActive = {
      ...target,
      attachmentCount: retained ? Math.min(MAX_ATTACHMENTS, retained.attachmentCount + 1) : target.attachmentCount,
      claimStartedAt: input.now,
      claimOwner: input.owner,
      phase: 'claimed',
      updatedAt: input.now,
    };
    return {
      state: {...state, active: claimed, desired: undefined, revision: nextRevision(state)},
      target: claimed,
      type: 'claimed',
    };
  }
  if (state.desired?.targetKey === input.targetKey) {
    const target = attach(state.desired, input.now);
    if (target.retry && (target.retry.blocked || target.retry.notBefore > input.now))
      return {state, target, type: 'deferred'};
    return {state: {...state, desired: target, revision: nextRevision(state)}, target, type: 'attached'};
  }
  const target: CodeGraphRefreshDemandTarget = {
    attachmentCount: 1,
    requestedAt: input.now,
    recoveryKey: input.recoveryKey,
    targetKey: input.targetKey,
    targetToken: input.token,
    updatedAt: input.now,
  };
  return {state: {...state, desired: target, revision: nextRevision(state)}, target, type: 'queued'};
}

/** Atomically resumes an admitted lane and advances it to the caller's latest observed target. */
export function resumeCodeGraphRefreshDemand(
  state: CodeGraphRefreshDemandState,
  input: {
    readonly now: number;
    readonly recoveryKey?: string;
    readonly owner?: CodeGraphRefreshDemandActive['claimOwner'];
    readonly ownerLive: boolean;
    readonly targetKey: string;
    readonly token: string;
  },
): CodeGraphRefreshDemandRegistration | undefined {
  const candidate = state.desired ?? state.active;
  if (candidate === undefined) return undefined;
  if (candidate.targetKey !== input.targetKey) {
    const resumable =
      state.active === undefined || input.ownerLive
        ? state
        : {...state, active: undefined, revision: nextRevision(state)};
    return registerCodeGraphRefreshDemand(resumable, input);
  }
  if (state.active !== undefined && input.ownerLive) {
    if (state.desired !== undefined) {
      const target = attach(state.desired, input.now);
      return {
        state: {...state, desired: target, revision: nextRevision(state)},
        target,
        type: target.retry && (target.retry.blocked || target.retry.notBefore > input.now) ? 'deferred' : 'attached',
      };
    }
    const target = attach(state.active, input.now);
    return {
      state: {...state, active: target, revision: nextRevision(state)},
      target,
      type: 'attached',
    };
  }
  const desired: CodeGraphRefreshDemandTarget = {
    attachmentCount: candidate.attachmentCount,
    requestedAt: candidate.requestedAt,
    recoveryKey: candidate.recoveryKey,
    ...(candidate.retry === undefined ? {} : {retry: candidate.retry}),
    targetKey: candidate.targetKey,
    targetToken: candidate.targetToken,
    updatedAt: candidate.updatedAt,
  };
  const resumable =
    state.active === undefined ? state : {...state, active: undefined, desired, revision: nextRevision(state)};
  return registerCodeGraphRefreshDemand(resumable, {
    now: input.now,
    owner: input.owner,
    recoveryKey: input.recoveryKey,
    targetKey: desired.targetKey,
    token: desired.targetToken,
  });
}

/** A child may adopt only the exact claim it was spawned for. */
export function adoptCodeGraphRefreshDemand(
  state: CodeGraphRefreshDemandState,
  token: string,
  targetKey: string,
  owner: CodeGraphRefreshDemandActive['claimOwner'],
): {readonly state: CodeGraphRefreshDemandState; readonly adopted: boolean} {
  const active = state.active;
  if (!active || active.targetToken !== token || active.targetKey !== targetKey || active.phase === 'publishing')
    return {adopted: false, state};
  return {
    adopted: true,
    state: {...state, active: {...active, claimOwner: owner, phase: 'preparing'}, revision: nextRevision(state)},
  };
}

/** Supersession is allowed at authority checkpoints until the writer begins. */
export function beginCodeGraphRefreshDemandPublication(
  state: CodeGraphRefreshDemandState,
  token: string,
  targetKey: string,
): {readonly state: CodeGraphRefreshDemandState; readonly type: 'publish' | 'superseded' | 'unauthorized'} {
  const active = state.active;
  if (!active || active.targetToken !== token || active.targetKey !== targetKey) return {state, type: 'unauthorized'};
  if (active.phase === 'publishing') return {state, type: 'publish'};
  if (state.desired && state.desired.targetKey !== targetKey)
    return {state: {...state, active: undefined, revision: nextRevision(state)}, type: 'superseded'};
  return {state: {...state, active: {...active, phase: 'publishing'}, revision: nextRevision(state)}, type: 'publish'};
}

/** Completion never clears a newer desired target. */
export function completeCodeGraphRefreshDemand(
  state: CodeGraphRefreshDemandState,
  token: string,
  targetKey: string,
): CodeGraphRefreshDemandState {
  const active = state.active;
  if (!active || active.targetToken !== token || active.targetKey !== targetKey) return state;
  return {
    ...state,
    active: undefined,
    desired: state.desired?.targetKey === targetKey ? undefined : state.desired,
    revision: nextRevision(state),
  };
}

/** Dead claims are replaced only by the last desired target. */
export function recoverCodeGraphRefreshDemand(
  state: CodeGraphRefreshDemandState,
  ownerLive: boolean,
): CodeGraphRefreshDemandState {
  if (!state.active || ownerLive) return state;
  const {claimStartedAt: _started, claimOwner: _owner, phase: _phase, ...target} = state.active;
  return {
    ...state,
    active: undefined,
    desired: state.desired ?? (target.retry === undefined ? undefined : target),
    revision: nextRevision(state),
  };
}

/** Retry state is attached only to the latest desired target and is capped. */
export function deferCodeGraphRefreshDemand(
  state: CodeGraphRefreshDemandState,
  token: string,
  targetKey: string,
  now: number,
  blocked = false,
): CodeGraphRefreshDemandState {
  const active = state.active;
  if (active?.targetToken !== token || active.targetKey !== targetKey) return state;
  if (state.desired && state.desired.targetKey !== targetKey) {
    return {...state, active: undefined, revision: nextRevision(state)};
  }
  const prior = active.retry?.attempt ?? state.desired?.retry?.attempt ?? 0;
  const attempt = Math.min(8, prior + 1);
  const desired: CodeGraphRefreshDemandTarget = {
    attachmentCount: active.attachmentCount,
    requestedAt: active.requestedAt,
    recoveryKey: active.recoveryKey,
    retry: {
      attempt,
      ...(blocked ? {blocked: true as const} : {}),
      notBefore: now + Math.min(60_000, 250 * 2 ** (attempt - 1)),
    },
    targetKey: active.targetKey,
    targetToken: active.targetToken,
    updatedAt: now,
  };
  return {...state, active: undefined, desired, revision: nextRevision(state)};
}

/** Permanent failure releases only the failed claim and retains a newer target. */
export function failCodeGraphRefreshDemand(
  state: CodeGraphRefreshDemandState,
  token: string,
  targetKey: string,
): CodeGraphRefreshDemandState {
  const active = state.active;
  if (active?.targetToken !== token || active.targetKey !== targetKey) return state;
  return {
    ...state,
    active: undefined,
    desired: state.desired?.targetKey === targetKey ? undefined : state.desired,
    revision: nextRevision(state),
  };
}

export function validCodeGraphRefreshDemand(state: unknown): state is CodeGraphRefreshDemandState {
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
  const validRetry = (retry: unknown): boolean => {
    if (retry === undefined) return true;
    if (!isRecord(retry)) return false;
    const attempt = retry.attempt;
    const blocked = retry.blocked;
    const notBefore = retry.notBefore;
    return (
      typeof attempt === 'number' &&
      Number.isSafeInteger(attempt) &&
      attempt >= 1 &&
      attempt <= 8 &&
      (blocked === undefined || blocked === true) &&
      typeof notBefore === 'number' &&
      Number.isSafeInteger(notBefore) &&
      notBefore >= 0
    );
  };
  const validTarget = (target: unknown): target is CodeGraphRefreshDemandTarget | undefined => {
    if (target === undefined) return true;
    if (!isRecord(target)) return false;
    return (
      typeof target.targetKey === 'string' &&
      CODE_GRAPH_REFRESH_DEMAND_KEY.test(target.targetKey) &&
      (target.recoveryKey === undefined ||
        (typeof target.recoveryKey === 'string' && CODE_GRAPH_REFRESH_DEMAND_KEY.test(target.recoveryKey))) &&
      typeof target.targetToken === 'string' &&
      CODE_GRAPH_REFRESH_DEMAND_TOKEN.test(target.targetToken) &&
      typeof target.requestedAt === 'number' &&
      Number.isSafeInteger(target.requestedAt) &&
      typeof target.updatedAt === 'number' &&
      Number.isSafeInteger(target.updatedAt) &&
      typeof target.attachmentCount === 'number' &&
      Number.isSafeInteger(target.attachmentCount) &&
      target.attachmentCount > 0 &&
      target.attachmentCount <= MAX_ATTACHMENTS &&
      validRetry(target.retry)
    );
  };
  if (!isRecord(state)) return false;
  if (
    state.version !== CODE_GRAPH_REFRESH_DEMAND_VERSION ||
    typeof state.checkoutId !== 'string' ||
    !CODE_GRAPH_REFRESH_DEMAND_KEY.test(state.checkoutId) ||
    typeof state.worktreeId !== 'string' ||
    !CODE_GRAPH_REFRESH_DEMAND_KEY.test(state.worktreeId) ||
    typeof state.revision !== 'number' ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !validTarget(state.active) ||
    !validTarget(state.desired)
  ) {
    return false;
  }
  const active = state.active;
  if (active === undefined) return true;
  if (!isRecord(active)) return false;
  const claimOwner = active.claimOwner;
  return (
    typeof active.claimStartedAt === 'number' &&
    Number.isSafeInteger(active.claimStartedAt) &&
    active.claimStartedAt >= 0 &&
    (active.phase === 'claimed' || active.phase === 'preparing' || active.phase === 'publishing') &&
    (claimOwner === undefined ||
      (isRecord(claimOwner) &&
        typeof claimOwner.processId === 'number' &&
        Number.isSafeInteger(claimOwner.processId) &&
        claimOwner.processId > 0 &&
        (claimOwner.processStartIdentity === undefined ||
          (typeof claimOwner.processStartIdentity === 'string' && claimOwner.processStartIdentity.length <= 256))))
  );
}
