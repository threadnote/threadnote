import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  openNewRemoteHandoffLifecycle,
  REMOTE_HANDOFF_LIFECYCLE_OPERATIONS,
  transitionRemoteHandoffLifecycle,
} from '@threadnote/memory/remote/lifecycle';
import {
  REMOTE_MEMORY_CAPABILITIES,
  evaluateRemoteMemoryPolicy,
  type RemoteMemoryPolicyContextV1,
  type RemoteMemoryPolicyRequestV1,
} from '@threadnote/memory/remote/policy';
import type {RemoteMemoryReceiptV1} from '@threadnote/memory/remote/receipts';
import {
  applyRemoteMutationDecision,
  formatRemoteMemoryLogicalKey,
  planRemoteMutation,
  type RemoteIdempotencyKeyV1,
  type RemoteMutationIntentV1,
} from '@threadnote/memory/remote/revisions';
import {Array as EffectArray} from 'effect';

const idempotencyKey: RemoteIdempotencyKeyV1 = {
  operationId: 'operation-1',
  principalId: 'principal-1',
  tenantId: 'tenant-1',
  version: 1,
};

const replayReceipt: RemoteMemoryReceiptV1 = {
  consistency: 'recent-write-overlay',
  indexedGeneration: 4,
  policyVersion: 'policy-1',
  sharePolicyVersion: 'share-policy-1',
  requestId: 'request-1',
  revision: 'revision-2',
  shareGeneration: 5,
  shareId: 'share-1',
  tenantId: 'tenant-1',
  uri: 'threadnote://share/share-1/memories/durable/project/topic.md',
  version: 1,
};

const policyRequest: RemoteMemoryPolicyRequestV1 = {
  kind: 'durable',
  managedCloud: true,
  nowEpochMilliseconds: 1_000,
  operation: 'write',
  project: 'project',
  shareId: 'share-1',
  version: 1,
};

const policyContext: RemoteMemoryPolicyContextV1 = {
  attestation: {
    expiresAtEpochMilliseconds: 2_000,
    principalId: 'principal-1',
    projectIds: ['project'],
    provider: 'cursor',
    shareId: 'share-1',
    version: 1,
  },
  capabilities: [...REMOTE_MEMORY_CAPABILITIES],
  durableWritesAllowed: true,
  grant: {active: true, allProjects: false, projectIds: ['project'], shareId: 'share-1', version: 1},
  handoffWritesAllowed: true,
  membershipActive: true,
  policyVersion: 'policy-1',
  principalId: 'principal-1',
  requireCursorAttestationForManagedWrites: true,
  version: 1,
};

describe('remote memory revision, policy, and lifecycle contracts', () => {
  it('commits create-if-absent and then rejects a second create without last-writer-wins behavior', () => {
    const intent = mutationIntent({baseRevision: undefined, proposedRevision: 'revision-1'});
    const first = planRemoteMutation({currentShareGeneration: 7, intent});
    expect(first).toMatchObject({kind: 'commit', mutation: {revision: 'revision-1', shareGeneration: 8}});

    const committed = applyRemoteMutationDecision({decision: first});
    expect(
      planRemoteMutation({currentShareGeneration: committed.shareGeneration, head: committed.head, intent}),
    ).toEqual({
      currentRevision: 'revision-1',
      kind: 'conflict',
      reason: 'already_exists',
      shareGeneration: 8,
      version: 1,
    });
  });

  it('replays the exact stored outcome for the same operation and rejects a changed request', () => {
    const intent = mutationIntent({fingerprint: 'request-a'});
    const record = {fingerprint: 'request-a', key: idempotencyKey, outcome: replayReceipt, version: 1 as const};

    const replay = planRemoteMutation({currentShareGeneration: 9, idempotencyRecord: record, intent});
    expect(replay).toEqual({kind: 'replay', outcome: replayReceipt, version: 1});
    if (replay.kind === 'replay') expect(replay.outcome).toBe(replayReceipt);

    expect(
      planRemoteMutation({
        currentShareGeneration: 9,
        idempotencyRecord: record,
        intent: {...intent, fingerprint: 'request-b'},
      }),
    ).toEqual({kind: 'idempotency_conflict', operationId: 'operation-1', shareGeneration: 9, version: 1});
  });

  fcProp(
    it,
    'allows at most one distinct sequential winner from a shared base revision',
    {
      baseRevision: FC.uuid(),
      firstRevision: FC.uuid(),
      generation: FC.integer({max: 1_000_000, min: 0}),
      secondRevision: FC.uuid(),
    },
    ({baseRevision, firstRevision, generation, secondRevision}) => {
      FC.pre(firstRevision !== baseRevision && secondRevision !== baseRevision && firstRevision !== secondRevision);
      const logicalKey = 'memory-key';
      const head = {logicalKey, revision: baseRevision, status: 'active' as const, version: 1 as const};
      const first = planRemoteMutation({
        currentShareGeneration: generation,
        head,
        intent: mutationIntent({baseRevision, logicalKey, proposedRevision: firstRevision}),
      });
      expect(first.kind).toBe('commit');
      const committed = applyRemoteMutationDecision({decision: first});
      const second = planRemoteMutation({
        currentShareGeneration: committed.shareGeneration,
        head: committed.head,
        intent: mutationIntent({baseRevision, logicalKey, proposedRevision: secondRevision}),
      });

      expect(second).toMatchObject({kind: 'conflict', reason: 'stale_base', shareGeneration: generation + 1});
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'allocates one generation only for commits and leaves rejected generations unchanged',
    {generation: FC.integer({max: 1_000_000, min: 0}), revision: FC.uuid()},
    ({generation, revision}) => {
      const create = planRemoteMutation({
        currentShareGeneration: generation,
        intent: mutationIntent({baseRevision: undefined, proposedRevision: revision}),
      });
      expect(create).toMatchObject({kind: 'commit', mutation: {shareGeneration: generation + 1}});
      const conflict = planRemoteMutation({
        currentShareGeneration: generation,
        head: {logicalKey: 'memory-key', revision: 'current', status: 'active', version: 1},
        intent: mutationIntent({baseRevision: 'stale', proposedRevision: revision}),
      });
      expect(conflict).toMatchObject({kind: 'conflict', shareGeneration: generation});
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'uses distinct logical lock keys for independent topics',
    {firstTopic: FC.uuid(), secondTopic: FC.uuid()},
    ({firstTopic, secondTopic}) => {
      FC.pre(firstTopic !== secondTopic);
      const identity = {kind: 'handoff' as const, project: 'p', shareId: 's', tenantId: 't', version: 1 as const};
      expect(formatRemoteMemoryLogicalKey({...identity, topic: firstTopic})).not.toBe(
        formatRemoteMemoryLogicalKey({...identity, topic: secondTopic}),
      );
    },
    {fastCheck: {numRuns: 100}},
  );

  it('requires the complete active grant, capability, write policy, and fresh matching attestation', () => {
    expect(evaluateRemoteMemoryPolicy(policyContext, policyRequest)).toEqual({
      allowed: true,
      policyVersion: 'policy-1',
      version: 1,
    });
    expect(
      evaluateRemoteMemoryPolicy(
        {...policyContext, attestation: {...policyContext.attestation!, expiresAtEpochMilliseconds: 1_000}},
        policyRequest,
      ),
    ).toMatchObject({allowed: false, reason: 'attestation_expired'});
    expect(evaluateRemoteMemoryPolicy({...policyContext, membershipActive: false}, policyRequest)).toMatchObject({
      allowed: false,
      reason: 'membership_inactive',
    });
  });

  fcProp(
    it,
    'removing capabilities cannot add an allowed operation',
    {mask: FC.integer({max: 15, min: 0})},
    ({mask}) => {
      const subset = EffectArray.filter(REMOTE_MEMORY_CAPABILITIES, (_, index) => (mask & (1 << index)) !== 0);
      const fullDecision = evaluateRemoteMemoryPolicy(policyContext, policyRequest);
      const subsetDecision = evaluateRemoteMemoryPolicy({...policyContext, capabilities: subset}, policyRequest);

      expect(fullDecision.allowed).toBe(true);
      if (subsetDecision.allowed) expect(fullDecision.allowed).toBe(true);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'never leaves an archived handoff without opening a new logical handoff',
    {operations: FC.array(FC.constantFrom(...REMOTE_HANDOFF_LIFECYCLE_OPERATIONS), {maxLength: 20})},
    ({operations}) => {
      const state = 'archived' as const;
      for (const operation of operations) {
        const decision = transitionRemoteHandoffLifecycle(state, operation);
        expect(decision).toMatchObject({from: 'archived', kind: 'rejected', reason: 'terminal_state'});
      }
      expect(openNewRemoteHandoffLifecycle()).toBe('active');
    },
    {fastCheck: {numRuns: 100}},
  );

  it('allows only the declared active and expired handoff transitions', () => {
    expect(transitionRemoteHandoffLifecycle('active', 'revise')).toMatchObject({kind: 'transition', to: 'active'});
    expect(transitionRemoteHandoffLifecycle('active', 'expire')).toMatchObject({kind: 'transition', to: 'expired'});
    expect(transitionRemoteHandoffLifecycle('expired', 'archive')).toMatchObject({kind: 'transition', to: 'archived'});
    expect(transitionRemoteHandoffLifecycle('expired', 'revise')).toMatchObject({
      kind: 'rejected',
      reason: 'transition_not_allowed',
    });
    expect(transitionRemoteHandoffLifecycle('superseded', 'revise')).toMatchObject({
      kind: 'rejected',
      reason: 'terminal_state',
    });
  });
});

function mutationIntent(
  overrides: Partial<RemoteMutationIntentV1> & {readonly baseRevision?: string} = {},
): RemoteMutationIntentV1 {
  return {
    fingerprint: 'request-a',
    idempotencyKey,
    logicalKey: 'memory-key',
    proposedRevision: 'revision-2',
    version: 1,
    ...overrides,
  };
}
