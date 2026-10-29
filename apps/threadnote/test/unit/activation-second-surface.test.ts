import {describe, expect, it} from 'vitest';
import {
  completeSecondSurfaceProofV1,
  parseSecondSurfaceProofReceiptV1,
  planSecondSurfaceReadV1,
  planSecondSurfaceRecallV1,
  type SecondSurfaceProofContextV1,
  type SecondSurfaceReadObservationV1,
  type SecondSurfaceRecallObservationV1,
} from '@threadnote/threadnote/activation/second/surface';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const digest = (character: string) => Effect.pipe(character, EffectString.repeat(64));
const startedAt = '2026-09-18T08:00:00.000Z';
const recallAt = '2026-09-18T08:00:10.000Z';
const readAt = '2026-09-18T08:00:12.000Z';

const context: SecondSurfaceProofContextV1 = {
  activationId: digest('a'),
  activationReceiptRevision: digest('b'),
  catalogRevision: 'catalog-v1',
  catalogSnapshotHash: digest('c'),
  decision: {
    canonicalUri: 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/activation.md',
    contentHash: digest('d'),
    memoryId: 'tn_activation_decision',
    publicationReceiptHash: digest('e'),
  },
  primary: {
    access: 'local-stdio',
    capabilitiesFingerprint: digest('f'),
    configurationState: 'current',
    mcpCapability: 'managed',
    mcpConfigFingerprint: digest('1'),
    mcpReceiptFingerprint: digest('2'),
    mcpServerFingerprint: digest('3'),
    surfaceId: 'codex-cli',
  },
  queryFingerprint: digest('4'),
  repositoryIdentityHash: digest('5'),
  repositoryState: 'clean',
  secondary: {
    access: 'local-stdio',
    capabilitiesFingerprint: digest('6'),
    configurationState: 'current',
    mcpCapability: 'partial',
    mcpConfigFingerprint: digest('7'),
    mcpReceiptFingerprint: digest('8'),
    mcpServerFingerprint: digest('3'),
    surfaceId: 'claude-code',
  },
  startedAt,
  teamId: 'default',
  teamShareStateHash: digest('9'),
};

const commonObservation = {
  activationReceiptRevision: context.activationReceiptRevision,
  capabilitiesFingerprint: context.secondary.capabilitiesFingerprint,
  catalogRevision: context.catalogRevision,
  catalogSnapshotHash: context.catalogSnapshotHash,
  mcpConfigFingerprint: context.secondary.mcpConfigFingerprint!,
  mcpReceiptFingerprint: context.secondary.mcpReceiptFingerprint!,
  mcpServerFingerprint: context.secondary.mcpServerFingerprint!,
  repositoryIdentityHash: context.repositoryIdentityHash,
  surfaceId: context.secondary.surfaceId,
  teamShareStateHash: context.teamShareStateHash,
};

const recall: SecondSurfaceRecallObservationV1 = {
  ...commonObservation,
  complete: true,
  invocationId: digest('a'),
  observedAt: recallAt,
  queryFingerprint: context.queryFingerprint,
  responseFingerprint: digest('b'),
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
  ...commonObservation,
  canonicalUri: context.decision.canonicalUri,
  complete: true,
  contentHash: context.decision.contentHash,
  invocationId: digest('c'),
  memoryId: context.decision.memoryId,
  observedAt: readAt,
  readable: true,
  recallResponseFingerprint: recall.responseFingerprint,
  requestedMemoryId: context.decision.memoryId,
  requestedUri: context.decision.canonicalUri,
  resourceCount: 1,
  responseFingerprint: digest('d'),
};

describe('activation second-surface proof', () => {
  it('plans recall then read and emits a deterministic content-free receipt', () => {
    expect(planSecondSurfaceRecallV1(context)).toMatchObject({
      request: {
        activationId: context.activationId,
        queryFingerprint: context.queryFingerprint,
        surfaceId: context.secondary.surfaceId,
      },
      status: 'ready',
    });
    expect(planSecondSurfaceReadV1(context, recall)).toMatchObject({
      request: {
        memoryId: context.decision.memoryId,
        recallResponseFingerprint: recall.responseFingerprint,
        uri: context.decision.canonicalUri,
      },
      status: 'ready',
    });

    const first = completeSecondSurfaceProofV1(context, recall, read);
    const second = completeSecondSurfaceProofV1(
      structuredClone(context),
      structuredClone(recall),
      structuredClone(read),
    );
    expect(first).toEqual(second);
    expect(first.status).toBe('verified');
    if (first.status !== 'verified') throw new Error(`Unexpected ${first.code}.`);
    expect(first.receipt).toMatchObject({
      activationId: context.activationId,
      activationReceiptRevision: context.activationReceiptRevision,
      completedAt: readAt,
      decisionCanonicalUri: context.decision.canonicalUri,
      decisionMemoryId: context.decision.memoryId,
      durationMilliseconds: 12_000,
      primaryMcpCapability: 'managed',
      primarySurfaceId: context.primary.surfaceId,
      recallCompletedAt: recallAt,
      secondarySurfaceId: context.secondary.surfaceId,
      secondaryMcpCapability: 'partial',
      type: 'threadnote-second-surface-proof',
      version: 1,
    });
    const serialized = JSON.stringify(first.receipt);
    expect(serialized).not.toContain('query body');
    expect(serialized).not.toContain('memory body');
    expect(parseSecondSurfaceProofReceiptV1(first.receipt)).toEqual(first.receipt);
    expect(() => parseSecondSurfaceProofReceiptV1({...first.receipt, memoryBody: 'private'})).toThrow();
  });

  it.each([
    ['same-surface', {...context, secondary: {...context.secondary, surfaceId: context.primary.surfaceId}}],
    ['surface-unsupported', {...context, secondary: {...context.secondary, mcpCapability: 'unsupported' as const}}],
    ['surface-not-current', {...context, secondary: {...context.secondary, configurationState: 'stale' as const}}],
    [
      'mcp-missing',
      (() => {
        const {mcpConfigFingerprint: _, ...secondary} = context.secondary;
        return {...context, secondary};
      })(),
    ],
    ['mcp-contract-mismatch', {...context, secondary: {...context.secondary, mcpServerFingerprint: digest('0')}}],
    [
      'remote-dirty-worktree',
      {...context, repositoryState: 'dirty' as const, secondary: {...context.secondary, access: 'remote' as const}},
    ],
    [
      'input-invalid',
      {
        ...context,
        decision: {
          ...context.decision,
          canonicalUri: 'threadnote://user/test/memories/shared/another/durable/projects/threadnote/activation.md',
        },
      },
    ],
  ])('rejects unusable surface state with %s', (code, changed) => {
    expect(planSecondSurfaceRecallV1(changed)).toEqual({code, status: 'rejected'});
  });

  it.each([
    ['catalog-drift', {...recall, catalogRevision: 'catalog-v2'}],
    ['catalog-drift', {...recall, capabilitiesFingerprint: digest('0')}],
    ['configuration-drift', {...recall, mcpConfigFingerprint: digest('0')}],
    ['share-drift', {...recall, teamShareStateHash: digest('0')}],
    ['activation-drift', {...recall, activationReceiptRevision: digest('0')}],
    ['repository-drift', {...recall, repositoryIdentityHash: digest('0')}],
  ])('rejects stale recall evidence with %s', (code, changed) => {
    expect(planSecondSurfaceReadV1(context, changed)).toEqual({code, status: 'rejected'});
  });

  it.each([
    ['recall-incomplete', {...recall, complete: false}],
    ['recall-truncated', {...recall, returnedResults: 1, totalResults: 2, truncated: true}],
    ['wrong-memory', {...recall, results: [{...recall.results[0], memoryId: 'tn_other'}]}],
    [
      'recall-ambiguous',
      {...recall, results: [...recall.results, recall.results[0]], returnedResults: 2, totalResults: 2},
    ],
    ['recall-ambiguous', {...recall, results: [{...recall.results[0], identityConflict: true}]}],
  ])('fails closed on unusable recall output with %s', (code, changed) => {
    expect(planSecondSurfaceReadV1(context, changed)).toEqual({code, status: 'rejected'});
  });

  it.each([
    {...recall, complete: 'yes'},
    {...recall, results: undefined},
    {...recall, results: [{...recall.results[0], identityConflict: undefined}]},
    {...recall, truncated: 0},
    {...recall, unexpected: 'body'},
  ])('rejects malformed runtime recall observations without throwing', malformed => {
    expect(() => planSecondSurfaceReadV1(context, malformed)).not.toThrow();
    expect(planSecondSurfaceReadV1(context, malformed)).toEqual({code: 'input-invalid', status: 'rejected'});
  });

  it.each([
    [{...recall.results[0]}, {...recall.results[0], canonicalUri: 'threadnote://user/test/memories/personal/other.md'}],
    [{...recall.results[0]}, {...recall.results[0], memoryId: 'tn_other'}],
  ])('rejects target identity collisions as ambiguous', (...results) => {
    const changed = {...recall, results, returnedResults: 2, totalResults: 2};
    expect(planSecondSurfaceReadV1(context, changed)).toEqual({code: 'recall-ambiguous', status: 'rejected'});
  });

  it.each([
    ['read-unreadable', {...read, readable: false}],
    ['read-incomplete', {...read, complete: false}],
    ['wrong-memory', {...read, memoryId: 'tn_other'}],
    ['wrong-memory', {...read, contentHash: digest('0')}],
    ['read-drift', {...read, recallResponseFingerprint: digest('0')}],
    ['configuration-drift', {...read, mcpReceiptFingerprint: digest('0')}],
    ['time-invalid', {...read, observedAt: '2026-09-18T07:59:59.000Z'}],
  ])('fails closed on unusable read output with %s', (code, changed) => {
    expect(completeSecondSurfaceProofV1(context, recall, changed)).toEqual({code, status: 'rejected'});
  });

  it('rejects malformed reads, impossible dates, and overlong URIs without throwing', () => {
    const malformedRead = {...read, readable: 'yes'};
    expect(() => completeSecondSurfaceProofV1(context, recall, malformedRead)).not.toThrow();
    expect(completeSecondSurfaceProofV1(context, recall, malformedRead)).toEqual({
      code: 'input-invalid',
      status: 'rejected',
    });
    expect(planSecondSurfaceRecallV1({...context, startedAt: '2026-02-31T08:00:00.000Z'})).toEqual({
      code: 'input-invalid',
      status: 'rejected',
    });
    const overlongUri = `${context.decision.canonicalUri}/${Effect.pipe('a', EffectString.repeat(1_024))}`;
    const overlong = {...context, decision: {...context.decision, canonicalUri: overlongUri}};
    expect(() => planSecondSurfaceRecallV1(overlong)).not.toThrow();
    expect(planSecondSurfaceRecallV1(overlong)).toEqual({code: 'input-invalid', status: 'rejected'});
  });
});
