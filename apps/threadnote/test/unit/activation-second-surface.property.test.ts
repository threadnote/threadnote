import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  completeSecondSurfaceProofV1,
  planSecondSurfaceReadV1,
  type SecondSurfaceProofContextV1,
  type SecondSurfaceReadObservationV1,
  type SecondSurfaceRecallObservationV1,
} from '@threadnote/threadnote/activation/second/surface';

const hash = fc.string({unit: fc.constantFrom(...'0123456789abcdef'), minLength: 64, maxLength: 64});
const identity = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/u).map(value => `team-${value}`);

describe('activation second-surface proof properties', () => {
  it('is deterministic and sensitive to every bound identity fingerprint', () => {
    fc.assert(
      fc.property(
        fc.record({
          activationId: hash,
          activationReceiptRevision: hash,
          catalogSnapshotHash: hash,
          contentHash: hash,
          primaryCapabilities: hash,
          primaryConfig: hash,
          primaryReceipt: hash,
          publicationReceiptHash: hash,
          queryFingerprint: hash,
          repositoryIdentityHash: hash,
          secondaryCapabilities: hash,
          secondaryConfig: hash,
          secondaryReceipt: hash,
          server: hash,
          shareStateHash: hash,
          teamId: identity,
        }),
        values => {
          const [context, recall, read] = proofFixture(values);
          const proof = completeSecondSurfaceProofV1(context, recall, read);
          expect(
            completeSecondSurfaceProofV1(structuredClone(context), structuredClone(recall), structuredClone(read)),
          ).toEqual(proof);
          expect(proof.status).toBe('verified');
          if (proof.status !== 'verified') return;

          for (const changedFixture of coherentIdentityMutations(context, recall, read)) {
            const changed = completeSecondSurfaceProofV1(...changedFixture);
            expect(changed.status).toBe('verified');
            if (changed.status === 'verified') expect(changed.receipt.proofHash).not.toBe(proof.receipt.proofHash);
          }

          const staleFields: SecondSurfaceRecallObservationV1[] = [
            {...recall, catalogSnapshotHash: flipHash(recall.catalogSnapshotHash)},
            {...recall, capabilitiesFingerprint: flipHash(recall.capabilitiesFingerprint)},
            {...recall, mcpConfigFingerprint: flipHash(recall.mcpConfigFingerprint)},
            {...recall, mcpReceiptFingerprint: flipHash(recall.mcpReceiptFingerprint)},
            {...recall, mcpServerFingerprint: flipHash(recall.mcpServerFingerprint)},
            {...recall, repositoryIdentityHash: flipHash(recall.repositoryIdentityHash)},
            {...recall, teamShareStateHash: flipHash(recall.teamShareStateHash)},
          ];
          for (const stale of staleFields) expect(planSecondSurfaceReadV1(context, stale).status).toBe('rejected');
        },
      ),
      {numRuns: 100, examples: [[{...fixedValues(), teamId: 'team-con'}]]},
    );
  });

  it.each(['con', 'prn', 'aux', 'nul', 'com1', 'lpt9'])('rejects the non-portable team identity %s', teamId => {
    const [context, recall, read] = proofFixture({...fixedValues(), teamId});
    expect(completeSecondSurfaceProofV1(context, recall, read)).toEqual({code: 'input-invalid', status: 'rejected'});
  });

  it('never advances to read for incomplete, truncated, absent, or ambiguous target recall', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.integer({min: 0, max: 3}), (complete, truncated, targetCopies) => {
        const [context, base] = proofFixture(fixedValues());
        const results = Array.from({length: targetCopies}, () => base.results[0]);
        const recall = {
          ...base,
          complete,
          results,
          returnedResults: results.length,
          totalResults: results.length + (truncated ? 1 : 0),
          truncated,
        };
        const next = planSecondSurfaceReadV1(context, recall);
        expect(next.status === 'ready').toBe(complete && !truncated && targetCopies === 1);
      }),
      {numRuns: 100},
    );
  });

  it('rejects arbitrary non-boolean runtime flags instead of coercing them', () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.string(), fc.constant(null), fc.constant(undefined)), invalidFlag => {
        const [context, recall, read] = proofFixture(fixedValues());
        expect(planSecondSurfaceReadV1(context, {...recall, complete: invalidFlag})).toEqual({
          code: 'input-invalid',
          status: 'rejected',
        });
        expect(completeSecondSurfaceProofV1(context, recall, {...read, readable: invalidFlag})).toEqual({
          code: 'input-invalid',
          status: 'rejected',
        });
      }),
      {numRuns: 100},
    );
  });
});

interface FixtureValues {
  readonly activationId: string;
  readonly activationReceiptRevision: string;
  readonly catalogSnapshotHash: string;
  readonly contentHash: string;
  readonly primaryCapabilities: string;
  readonly primaryConfig: string;
  readonly primaryReceipt: string;
  readonly publicationReceiptHash: string;
  readonly queryFingerprint: string;
  readonly repositoryIdentityHash: string;
  readonly secondaryCapabilities: string;
  readonly secondaryConfig: string;
  readonly secondaryReceipt: string;
  readonly server: string;
  readonly shareStateHash: string;
  readonly teamId: string;
}

function proofFixture(
  values: FixtureValues,
): [SecondSurfaceProofContextV1, SecondSurfaceRecallObservationV1, SecondSurfaceReadObservationV1] {
  const context: SecondSurfaceProofContextV1 = {
    activationId: values.activationId,
    activationReceiptRevision: values.activationReceiptRevision,
    catalogRevision: 'catalog-v1',
    catalogSnapshotHash: values.catalogSnapshotHash,
    decision: {
      canonicalUri: `threadnote://user/test/memories/shared/${values.teamId}/durable/projects/threadnote/decision.md`,
      contentHash: values.contentHash,
      memoryId: 'tn_decision',
      publicationReceiptHash: values.publicationReceiptHash,
    },
    primary: {
      access: 'local-stdio',
      capabilitiesFingerprint: values.primaryCapabilities,
      configurationState: 'current',
      mcpCapability: 'managed',
      mcpConfigFingerprint: values.primaryConfig,
      mcpReceiptFingerprint: values.primaryReceipt,
      mcpServerFingerprint: values.server,
      surfaceId: 'primary-surface',
    },
    queryFingerprint: values.queryFingerprint,
    repositoryIdentityHash: values.repositoryIdentityHash,
    repositoryState: 'clean',
    secondary: {
      access: 'local-stdio',
      capabilitiesFingerprint: values.secondaryCapabilities,
      configurationState: 'current',
      mcpCapability: 'managed',
      mcpConfigFingerprint: values.secondaryConfig,
      mcpReceiptFingerprint: values.secondaryReceipt,
      mcpServerFingerprint: values.server,
      surfaceId: 'secondary-surface',
    },
    startedAt: '2026-09-18T08:00:00.000Z',
    teamId: values.teamId,
    teamShareStateHash: values.shareStateHash,
  };
  const common = {
    activationReceiptRevision: values.activationReceiptRevision,
    capabilitiesFingerprint: values.secondaryCapabilities,
    catalogRevision: context.catalogRevision,
    catalogSnapshotHash: values.catalogSnapshotHash,
    mcpConfigFingerprint: values.secondaryConfig,
    mcpReceiptFingerprint: values.secondaryReceipt,
    mcpServerFingerprint: values.server,
    repositoryIdentityHash: values.repositoryIdentityHash,
    surfaceId: context.secondary.surfaceId,
    teamShareStateHash: values.shareStateHash,
  };
  const recall: SecondSurfaceRecallObservationV1 = {
    ...common,
    complete: true,
    invocationId: values.activationId,
    observedAt: '2026-09-18T08:00:01.000Z',
    queryFingerprint: values.queryFingerprint,
    responseFingerprint: values.activationReceiptRevision,
    results: [
      {
        canonicalUri: context.decision.canonicalUri,
        identityConflict: false,
        memoryId: context.decision.memoryId,
      },
    ],
    returnedResults: 1,
    totalResults: 1,
    truncated: false,
  };
  const read: SecondSurfaceReadObservationV1 = {
    ...common,
    canonicalUri: context.decision.canonicalUri,
    complete: true,
    contentHash: values.contentHash,
    invocationId: values.contentHash,
    memoryId: context.decision.memoryId,
    observedAt: '2026-09-18T08:00:02.000Z',
    readable: true,
    recallResponseFingerprint: recall.responseFingerprint,
    requestedMemoryId: context.decision.memoryId,
    requestedUri: context.decision.canonicalUri,
    resourceCount: 1,
    responseFingerprint: values.queryFingerprint,
  };
  return [context, recall, read];
}

function fixedValues(): FixtureValues {
  return {
    activationId: 'a'.repeat(64),
    activationReceiptRevision: 'b'.repeat(64),
    catalogSnapshotHash: 'c'.repeat(64),
    contentHash: 'd'.repeat(64),
    primaryCapabilities: 'e'.repeat(64),
    primaryConfig: 'f'.repeat(64),
    primaryReceipt: '0'.repeat(64),
    publicationReceiptHash: '1'.repeat(64),
    queryFingerprint: '2'.repeat(64),
    repositoryIdentityHash: '3'.repeat(64),
    secondaryCapabilities: '4'.repeat(64),
    secondaryConfig: '5'.repeat(64),
    secondaryReceipt: '6'.repeat(64),
    server: '7'.repeat(64),
    shareStateHash: '8'.repeat(64),
    teamId: 'default',
  };
}

type ProofFixture = [SecondSurfaceProofContextV1, SecondSurfaceRecallObservationV1, SecondSurfaceReadObservationV1];

function coherentIdentityMutations(
  context: SecondSurfaceProofContextV1,
  recall: SecondSurfaceRecallObservationV1,
  read: SecondSurfaceReadObservationV1,
): readonly ProofFixture[] {
  const revision = flipHash(context.activationReceiptRevision);
  const catalogHash = flipHash(context.catalogSnapshotHash);
  const contentHash = flipHash(context.decision.contentHash);
  const decisionUri = context.decision.canonicalUri.replace('decision.md', 'decision-alt.md');
  const memoryId = `${context.decision.memoryId}_alt`;
  const query = flipHash(context.queryFingerprint);
  const repository = flipHash(context.repositoryIdentityHash);
  const secondaryCapabilities = flipHash(context.secondary.capabilitiesFingerprint);
  const secondaryConfig = flipHash(context.secondary.mcpConfigFingerprint!);
  const secondaryReceipt = flipHash(context.secondary.mcpReceiptFingerprint!);
  const server = flipHash(context.secondary.mcpServerFingerprint!);
  const share = flipHash(context.teamShareStateHash);
  const recallResponse = flipHash(recall.responseFingerprint);
  const teamId = `${context.teamId}-alt`;
  const teamUri = context.decision.canonicalUri.replace(`/shared/${context.teamId}/`, `/shared/${teamId}/`);
  return [
    [{...context, activationId: flipHash(context.activationId)}, recall, read],
    [
      {...context, activationReceiptRevision: revision},
      {...recall, activationReceiptRevision: revision},
      {...read, activationReceiptRevision: revision},
    ],
    [
      {...context, catalogRevision: 'catalog-v2'},
      {...recall, catalogRevision: 'catalog-v2'},
      {...read, catalogRevision: 'catalog-v2'},
    ],
    [
      {...context, catalogSnapshotHash: catalogHash},
      {...recall, catalogSnapshotHash: catalogHash},
      {...read, catalogSnapshotHash: catalogHash},
    ],
    [{...context, decision: {...context.decision, contentHash}}, recall, {...read, contentHash}],
    [
      {...context, decision: {...context.decision, canonicalUri: decisionUri}},
      {...recall, results: [{...recall.results[0], canonicalUri: decisionUri}]},
      {...read, canonicalUri: decisionUri, requestedUri: decisionUri},
    ],
    [
      {...context, decision: {...context.decision, memoryId}},
      {...recall, results: [{...recall.results[0], memoryId}]},
      {...read, memoryId, requestedMemoryId: memoryId},
    ],
    [
      {
        ...context,
        decision: {...context.decision, publicationReceiptHash: flipHash(context.decision.publicationReceiptHash)},
      },
      recall,
      read,
    ],
    [
      {
        ...context,
        primary: {...context.primary, capabilitiesFingerprint: flipHash(context.primary.capabilitiesFingerprint)},
      },
      recall,
      read,
    ],
    [
      {
        ...context,
        primary: {...context.primary, mcpConfigFingerprint: flipHash(context.primary.mcpConfigFingerprint!)},
      },
      recall,
      read,
    ],
    [
      {
        ...context,
        primary: {...context.primary, mcpReceiptFingerprint: flipHash(context.primary.mcpReceiptFingerprint!)},
      },
      recall,
      read,
    ],
    [{...context, queryFingerprint: query}, {...recall, queryFingerprint: query}, read],
    [
      {...context, repositoryIdentityHash: repository},
      {...recall, repositoryIdentityHash: repository},
      {...read, repositoryIdentityHash: repository},
    ],
    [
      {...context, secondary: {...context.secondary, capabilitiesFingerprint: secondaryCapabilities}},
      {...recall, capabilitiesFingerprint: secondaryCapabilities},
      {...read, capabilitiesFingerprint: secondaryCapabilities},
    ],
    [
      {...context, secondary: {...context.secondary, mcpConfigFingerprint: secondaryConfig}},
      {...recall, mcpConfigFingerprint: secondaryConfig},
      {...read, mcpConfigFingerprint: secondaryConfig},
    ],
    [
      {...context, secondary: {...context.secondary, mcpReceiptFingerprint: secondaryReceipt}},
      {...recall, mcpReceiptFingerprint: secondaryReceipt},
      {...read, mcpReceiptFingerprint: secondaryReceipt},
    ],
    [
      {
        ...context,
        primary: {...context.primary, mcpServerFingerprint: server},
        secondary: {...context.secondary, mcpServerFingerprint: server},
      },
      {...recall, mcpServerFingerprint: server},
      {...read, mcpServerFingerprint: server},
    ],
    [
      {...context, teamShareStateHash: share},
      {...recall, teamShareStateHash: share},
      {...read, teamShareStateHash: share},
    ],
    [context, {...recall, invocationId: flipHash(recall.invocationId)}, read],
    [context, {...recall, responseFingerprint: recallResponse}, {...read, recallResponseFingerprint: recallResponse}],
    [context, recall, {...read, invocationId: flipHash(read.invocationId)}],
    [context, recall, {...read, responseFingerprint: flipHash(read.responseFingerprint)}],
    [
      {...context, teamId, decision: {...context.decision, canonicalUri: teamUri}},
      {...recall, results: [{...recall.results[0], canonicalUri: teamUri}]},
      {...read, canonicalUri: teamUri, requestedUri: teamUri},
    ],
  ];
}

function flipHash(value: string): string {
  return `${value[0] === '0' ? '1' : '0'}${value.slice(1)}`;
}
