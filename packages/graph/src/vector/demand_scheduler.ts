import {Array as EffectArray, Option as EffectOption} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

/** One durable lane has one replaceable desired target and at most one active owner. */
export interface CodeGraphEmbeddingDemandTarget {
  readonly snapshotId: string;
  readonly activatedAt: string;
}
export interface CodeGraphEmbeddingDemandModel {
  readonly id: string;
  readonly sha256: string;
  readonly dimensions: number;
  readonly templateVersion: number;
}
export interface CodeGraphEmbeddingDemandOwner {
  readonly token: string;
  readonly processId: number;
  readonly processStartIdentity: string;
}
export interface CodeGraphEmbeddingDemandClaim extends CodeGraphEmbeddingDemandTarget {
  readonly worktreeId: string;
  readonly scopeId: string;
  readonly owner: CodeGraphEmbeddingDemandOwner;
  readonly model: CodeGraphEmbeddingDemandModel;
  readonly expiresAt: number;
}
export interface CodeGraphEmbeddingDemandLane extends CodeGraphEmbeddingDemandTarget {
  readonly worktreeId: string;
  readonly scopeId: string;
  readonly state: 'queued' | 'building' | 'deferred' | 'blocked' | 'ready' | 'cancelled';
  readonly attempt: number;
  readonly notBefore: number;
  readonly reason?: string;
  readonly model?: CodeGraphEmbeddingDemandModel;
  readonly active?: CodeGraphEmbeddingDemandClaim;
}
export type CodeGraphEmbeddingDemandAcknowledgement = {
  readonly kind: 'checkpoint' | 'finish' | 'defer' | 'failure' | 'superseded' | 'rebind';
  readonly now: number;
  readonly reason?: string;
  readonly retryAfterMilliseconds?: number;
  readonly jitter?: number;
  readonly blocked?: boolean;
  readonly retainClaim?: boolean;
};
export const CODE_GRAPH_EMBEDDING_DEMAND_PAGE_SIZE = 64;
export const CODE_GRAPH_EMBEDDING_DEMAND_LEASE_MILLISECONDS = 5 * 60_000;
export const codeGraphEmbeddingDemandSameTarget = (
  left: CodeGraphEmbeddingDemandTarget,
  right: CodeGraphEmbeddingDemandTarget,
) => left.snapshotId === right.snapshotId && left.activatedAt === right.activatedAt;
export const codeGraphEmbeddingDemandSameModel = (
  left: CodeGraphEmbeddingDemandModel | undefined,
  right: CodeGraphEmbeddingDemandModel,
) =>
  left?.id === right.id &&
  left.sha256 === right.sha256 &&
  left.dimensions === right.dimensions &&
  left.templateVersion === right.templateVersion;

export function enqueueCodeGraphEmbeddingDemandLane(
  previous: CodeGraphEmbeddingDemandLane | undefined,
  target: CodeGraphEmbeddingDemandTarget & {readonly worktreeId: string; readonly scopeId: string},
): CodeGraphEmbeddingDemandLane {
  if (previous && codeGraphEmbeddingDemandSameTarget(previous, target)) return previous;
  return {...target, state: 'queued', attempt: 0, notBefore: 0, ...(previous?.active ? {active: previous.active} : {})};
}

export function claimCodeGraphEmbeddingDemandLane(
  lane: CodeGraphEmbeddingDemandLane,
  input: {
    readonly owner: CodeGraphEmbeddingDemandOwner;
    readonly model: CodeGraphEmbeddingDemandModel;
    readonly now: number;
    readonly leaseMilliseconds?: number;
  },
): CodeGraphEmbeddingDemandLane | undefined {
  if (
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    (input.leaseMilliseconds !== undefined &&
      (!Number.isSafeInteger(input.leaseMilliseconds) || input.leaseMilliseconds < 1))
  )
    return undefined;
  if (lane.state === 'cancelled' || lane.state === 'ready') return undefined;
  if (lane.active && lane.active.expiresAt > input.now) return undefined;
  // Only an already-recorded lane may rebind after configuration changes.
  const changedModel =
    (lane.model !== undefined && !codeGraphEmbeddingDemandSameModel(lane.model, input.model)) ||
    (lane.model === undefined && lane.state === 'blocked' && lane.reason === 'model-unavailable');
  if (!changedModel && (lane.state === 'blocked' || lane.notBefore > input.now)) return undefined;
  if (lane.active?.owner.token === input.owner.token) return undefined;
  const active = {
    snapshotId: lane.snapshotId,
    activatedAt: lane.activatedAt,
    worktreeId: lane.worktreeId,
    scopeId: lane.scopeId,
    owner: input.owner,
    model: input.model,
    expiresAt:
      input.now +
      Math.max(
        1_000,
        Math.min(
          CODE_GRAPH_EMBEDDING_DEMAND_LEASE_MILLISECONDS,
          input.leaseMilliseconds ?? CODE_GRAPH_EMBEDDING_DEMAND_LEASE_MILLISECONDS,
        ),
      ),
  };
  return {
    ...lane,
    active,
    model: input.model,
    state: 'building',
    ...(changedModel ? {attempt: 0, notBefore: 0, reason: undefined} : {}),
  };
}

export function acknowledgeCodeGraphEmbeddingDemandLane(
  lane: CodeGraphEmbeddingDemandLane,
  claim: CodeGraphEmbeddingDemandClaim,
  acknowledgement: CodeGraphEmbeddingDemandAcknowledgement,
): CodeGraphEmbeddingDemandLane | undefined {
  if (!Number.isSafeInteger(acknowledgement.now) || acknowledgement.now < 0) return undefined;
  if (
    !lane.active ||
    lane.active.owner.token !== claim.owner.token ||
    lane.active.owner.processId !== claim.owner.processId ||
    lane.active.owner.processStartIdentity !== claim.owner.processStartIdentity ||
    lane.active.expiresAt <= acknowledgement.now ||
    !codeGraphEmbeddingDemandSameTarget(lane.active, claim) ||
    !codeGraphEmbeddingDemandSameModel(lane.active.model, claim.model)
  )
    return undefined;
  const {active: _active, ...unowned} = lane;
  if (!codeGraphEmbeddingDemandSameTarget(lane, claim))
    return {...unowned, state: lane.state === 'cancelled' ? 'cancelled' : 'queued'};
  const reason =
    Effect.pipe(acknowledgement.reason, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.slice(0, 512)),
    ) || undefined;
  if (acknowledgement.kind === 'rebind' && lane.state === 'cancelled')
    return {...unowned, state: 'cancelled', reason: lane.reason ?? 'removed'};
  if (acknowledgement.kind === 'rebind') return {...unowned, state: 'queued', attempt: 0, notBefore: 0, reason};
  if (acknowledgement.kind === 'superseded') return {...unowned, state: 'cancelled', reason: reason ?? 'superseded'};
  if (acknowledgement.kind === 'finish')
    return {...unowned, state: 'ready', attempt: 0, notBefore: 0, reason: undefined};
  if (acknowledgement.kind === 'checkpoint')
    return {
      ...lane,
      attempt: 0,
      notBefore: 0,
      reason: undefined,
      active: {...lane.active, expiresAt: acknowledgement.now + CODE_GRAPH_EMBEDDING_DEMAND_LEASE_MILLISECONDS},
    };
  if (acknowledgement.kind === 'defer' && acknowledgement.retainClaim && !acknowledgement.blocked) {
    const delay = Number.isFinite(acknowledgement.retryAfterMilliseconds)
      ? acknowledgement.retryAfterMilliseconds!
      : 1_000;
    return {
      ...lane,
      state: 'deferred',
      reason,
      notBefore: acknowledgement.now + Math.max(1_000, Math.min(300_000, delay)),
      active: {...lane.active, expiresAt: acknowledgement.now + CODE_GRAPH_EMBEDDING_DEMAND_LEASE_MILLISECONDS},
    };
  }
  if (acknowledgement.kind === 'defer')
    return {
      ...unowned,
      state: acknowledgement.blocked ? 'blocked' : 'deferred',
      reason,
      notBefore:
        acknowledgement.now +
        Math.max(
          1_000,
          Math.min(
            300_000,
            Number.isFinite(acknowledgement.retryAfterMilliseconds) ? acknowledgement.retryAfterMilliseconds! : 1_000,
          ),
        ),
    };
  const attempt = Math.min(3, lane.attempt + 1);
  const delay = Math.min(
    300_000,
    Math.max(
      1_000,
      Math.round(
        1_000 *
          2 ** (attempt - 1) *
          (1 + Math.max(0, Math.min(1, Number.isFinite(acknowledgement.jitter) ? acknowledgement.jitter! : 0.5))),
      ),
    ),
  );
  return {
    ...unowned,
    state: acknowledgement.blocked || attempt >= 3 ? 'blocked' : 'deferred',
    attempt,
    reason,
    notBefore: acknowledgement.now + delay,
  };
}

/** Stateless bounded round-robin: retaining only the last key prevents per-request growth. */
export function selectCodeGraphEmbeddingDemandLane<T extends {readonly key: string}>(
  lanes: readonly T[],
  after?: string,
): T | undefined {
  const sorted = [...lanes].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return (
    EffectOption.getOrUndefined(EffectArray.findFirst(sorted, lane => after === undefined || lane.key > after)) ??
    sorted[0]
  );
}
