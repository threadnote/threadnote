import {makeTopicDraftWireFixture} from '../helpers/topic-draft-wire.js';
import {decodeTopicDraftWire} from '../../src/manager/topic_draft_schema.js';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Schema} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {
  validateTopicGenerationReceipt,
  type TopicGenerationReceiptV1,
} from '@threadnote/memory/topic-maintenance-draft';
import {maintenanceContentHash} from '../../src/memory/context/maintenance_policy.js';
import {expect, vi} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseTopicMaintenanceDraft} from '@threadnote/memory/topic-maintenance-draft';
import {
  basisFromPacket,
  reviewEvidenceFromPacket,
  privateReview,
  requestTopicMaintenanceDraft,
  readyEvidence,
  TopicDraftError,
} from '../../src/memory/context/maintenance_draft.js';
import {TOPIC_DRAFT_PROMPT_VERSION} from '../../src/effect/ai/selected_generation.js';

const mocks = vi.hoisted(() => ({
  packet: vi.fn(),
  review: vi.fn(),
  identity: vi.fn(),
  save: vi.fn(),
  saveUnderLock: vi.fn(),
  saveReview: vi.fn(),
  records: vi.fn(),
}));
vi.mock('../../src/memory/context/maintenance.js', async original => ({
  ...(await original<typeof import('../../src/memory/context/maintenance.js')>()),
  readContextMaintenancePacket: mocks.packet,
}));
vi.mock('@threadnote/memory/candidate', async original => ({
  ...(await original<typeof import('@threadnote/memory/candidate')>()),
  loadCandidateReviewOptional: mocks.review,
  saveCandidateReview: mocks.saveReview,
  withCandidateReviewLock: (_home: string, _id: string, effect: Effect.Effect<unknown>) => effect,
}));
vi.mock('@threadnote/memory/candidate-generation', async original => ({
  ...(await original<typeof import('@threadnote/memory/candidate-generation')>()),
  saveTopicGenerationReceipt: mocks.save,
  saveTopicGenerationReceiptUnderLock: mocks.saveUnderLock,
}));
vi.mock('../../src/manager/consolidation_models.js', async original => ({
  ...(await original<typeof import('../../src/manager/consolidation_models.js')>()),
  availableConsolidationModels: () => Effect.succeed([{id: 'fixture', label: 'fixture', isDefault: true}]),
}));
vi.mock('../../src/effect/ai/selected_generation.js', async original => ({
  ...(await original<typeof import('../../src/effect/ai/selected_generation.js')>()),
  selectedTopicDraftIdentity: mocks.identity,
}));

vi.mock('../../src/mcp/server/memory.js', async original => ({
  ...(await original<typeof import('../../src/mcp/server/memory.js')>()),
  readMemoryRecordsByUri: mocks.records,
}));
vi.mock('../../src/memory/context/maintenance_inventory.js', async original => ({
  ...(await original<typeof import('../../src/memory/context/maintenance_inventory.js')>()),
  prepareContextMaintenanceInventory: () =>
    Effect.fail(TestError.make({message: 'Advisory not needed for request fixture.'})),
}));

function fixture() {
  const body = 'Preserve this policy.';
  // Two declared sources let [0,0] pass cardinality preflight and reach the duplicate application guard.
  const citations = ['source.ts', 'other.ts'].map(path =>
    createMemoryCodeCitation({
      evidenceRetention: 'capsule-retained',
      extractorSet: 'test',
      fileContentHash: {algorithm: 'sha256', value: '2'.repeat(64)},
      path,
      repositoryId: '3'.repeat(64),
      repositoryIdentityKind: 'local',
      sourceCommit: '1'.repeat(40),
      sourceDirty: false,
      sourceSnapshotId: 'cgsn_' + '1'.repeat(40),
      target: {kind: 'file'},
      version: 1,
    }),
  );
  const excerpt = (citation: (typeof citations)[number]) => ({
    content: 'const value = 1;',
    excerptHash: sha256HexSync('const value = 1;'),
    fileBytesHash: '2'.repeat(64),
    startLine: 1,
    endLine: 1,
    source: {
      extractorSet: citation.extractorSet,
      fileContentHash: citation.fileContentHash.value,
      path: citation.path,
      repositoryId: citation.repositoryId,
      sourceCommit: citation.sourceCommit,
      sourceDirty: false,
      sourceSnapshotId: citation.sourceSnapshotId,
    },
    supportsCitation: true,
    truncated: false,
  });
  const packet = readyEvidence({
    version: 1,
    coverage: 'declared-only',
    outcome: 'ready',
    targetUri: 'threadnote://user/tester/memories/durable/policy.md',
    targetHash: maintenanceContentHash(body),
    observationRevision: 'b'.repeat(64),
    body,
    paragraphs: [
      {
        ordinal: 0,
        hash: sha256HexSync(body),
        role: 'normative',
        support: 'direct',
        citationIds: citations.map(citation => citation.id),
      },
    ],
    sources: citations.map(citation => ({
      citationId: citation.id,
      original: citation,
      current: citation,
      oldExcerpt: {...excerpt(citation), provenance: 'historical-verified'},
      newExcerpt: {...excerpt(citation), provenance: 'current-verified'},
    })),
  } as never);
  if (packet.version !== 1) throw new Error('Expected code packet fixture.');
  const basis = basisFromPacket(packet);
  const identity = {
    agent: 'local-ai',
    model: 'fixture',
    modelVersion: 'revision:hash',
    backendIdentity: 'local-ai',
    settings: 'seed=0;maxTokens=4000',
  };
  const proposal = parseTopicMaintenanceDraft(
    basis,
    JSON.stringify({
      version: 1,
      targetHash: basis.targetHash,
      observationRevision: basis.observationRevision,
      packetDigest: basis.packetDigest,
      outcome: 'policy-conflict',
      operations: [],
      reviewedHandles: [],
      rationale: 'Human policy decision.',
      unresolvedQuestions: [],
      removedClaims: [],
      paragraphDispositions: {version: 1, entries: []},
    }),
  );
  const review = privateReview(
    undefined,
    basis,
    {
      version: 1,
      basis,
      proposal,
      reviewEvidence: reviewEvidenceFromPacket(packet),
      generation: {
        agent: identity.agent,
        model: identity.model,
        modelVersion: `${identity.modelVersion};${identity.settings}`,
        promptVersion: TOPIC_DRAFT_PROMPT_VERSION,
        attempts: 1,
        usage: {status: 'unavailable'},
      },
    },
    'fixture',
    'policy',
    [],
    '2026-10-18T00:00:00.000Z',
  );
  return {body, packet, basis, identity, proposal, review, wire: makeTopicDraftWireFixture(basis)};
}

effectIt.effect('returns a matching cached review without allocating any generation receipt', () =>
  Effect.gen(function* () {
    const {packet, identity, review} = fixture();
    mocks.packet.mockReturnValue(Effect.succeed({topicEvidence: packet}));
    mocks.review.mockReturnValue(Effect.succeed(review));
    mocks.identity.mockReturnValue(Effect.succeed(identity));
    let generated = false;
    const actual = yield* requestTopicMaintenanceDraft(
      {agentContextHome: '/unused'} as never,
      {caseId: 'health-case-' + 'c'.repeat(40), backend: 'local-ai', modelId: 'fixture'},
      () =>
        Effect.sync(() => {
          generated = true;
          throw new Error('No model call expected');
        }),
    );
    expect(actual).toBe(review);
    expect(generated).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.saveUnderLock).not.toHaveBeenCalled();
  }).pipe(provideTestLayer(ApplicationLayer)),
);

for (const legacy of ['temperature-zero', 'prompt-v23'] as const) {
  effectIt.effect('refuses a pending cached review from ' + legacy + ' without relabeling it', () =>
    Effect.gen(function* () {
      const {packet, identity, review} = fixture();
      const oldSettings = review.maintenance!.generation.modelVersion;
      const cached =
        legacy === 'prompt-v23'
          ? {
              ...review,
              maintenance: {
                ...review.maintenance!,
                generation: {
                  ...review.maintenance!.generation,
                  promptVersion: 'topic-maintenance-draft-v23',
                  modelVersion: `${identity.modelVersion};seed=0;maxTokens=4000;profile=gemma4-e4b-v1;temperature=1;topP=0.95;topK=64`,
                },
              },
            }
          : review;
      const selected = {
        ...identity,
        settings: 'seed=0;maxTokens=4000;profile=gemma4-e4b-v1;temperature=1;topP=0.95;topK=64',
      };
      mocks.packet.mockReturnValue(Effect.succeed({topicEvidence: packet}));
      mocks.review.mockReturnValue(Effect.succeed(cached));
      mocks.identity.mockReturnValue(Effect.succeed(selected));
      let calls = 0;
      const error = yield* requestTopicMaintenanceDraft(
        {agentContextHome: '/unused'} as never,
        {caseId: 'health-case-' + 'c'.repeat(40), backend: 'local-ai', modelId: 'fixture'},
        () =>
          Effect.sync(() => {
            calls++;
            throw new Error('No dispatch expected');
          }),
      ).pipe(Effect.flip);
      expect(Schema.is(TopicDraftError)(error) && error.reason).toBe('review-pending');
      expect(calls).toBe(0);
      expect(review.maintenance!.generation.modelVersion).toBe(oldSettings);
      expect(mocks.saveReview).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
}

function requestFixture() {
  return Effect.gen(function* () {
    vi.clearAllMocks();
    const value = fixture();
    mocks.packet.mockReturnValue(Effect.succeed({topicEvidence: value.packet}));
    mocks.review.mockReturnValue(Effect.void);
    mocks.identity.mockReturnValue(Effect.succeed(value.identity));
    mocks.records.mockReturnValue(
      Effect.succeed([
        {
          uri: value.basis.targetUri,
          content: value.body,
          body: value.body,
          metadata: {kind: 'durable', status: 'active', project: 'fixture', topic: 'policy'},
        },
      ]),
    );
    mocks.saveReview.mockReturnValue(Effect.succeed('saved'));
    const receipts: TopicGenerationReceiptV1[] = [];
    mocks.save.mockImplementation((_home: string, input: TopicGenerationReceiptV1) =>
      Effect.sync(() => {
        receipts.push(validateTopicGenerationReceipt(input));
        return input.receiptId;
      }),
    );
    const config = {
      account: 'local',
      agentContextHome: yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
    } as never;
    const input = {caseId: 'health-case-' + 'c'.repeat(40), backend: 'local-ai' as const, modelId: 'fixture'};
    return {...value, receipts, config, input};
  });
}

effectIt.effect('wires a repaired request to a saved safe summary and all-attempt usage', () =>
  Effect.gen(function* () {
    const value = yield* requestFixture();
    const firstWire = structuredClone(value.wire);
    firstWire.decision.reviewedSourceIndices = [0, 0];
    const firstText = JSON.stringify(decodeTopicDraftWire(value.basis, firstWire));
    const acceptedText = JSON.stringify(decodeTopicDraftWire(value.basis, value.wire));
    let calls = 0;
    const actual = yield* requestTopicMaintenanceDraft(value.config, value.input, () =>
      Effect.sync(() => ({
        text: ++calls === 1 ? firstText : acceptedText,
        outputRepresentation: 'decoded-json' as const,
        backendIdentity: 'local-ai',
        modelIdentity: 'fixture',
        modelVersion: value.identity.modelVersion,
        settings: {maxOutputTokens: 4000 as const, seed: 0 as const},
        usage: {status: 'measured' as const, inputTokens: 7, outputTokens: 3},
      })),
    );
    expect(calls).toBe(2);
    expect(actual.maintenance?.generation.usage).toEqual({status: 'measured', inputTokens: 14, outputTokens: 6});
    expect(actual.maintenance?.generation.origin).not.toBe('manual');
    const last = value.receipts.at(-1)!;
    expect(last.state).toBe('completed');
    expect(last.attempts.map(attempt => attempt.status)).toEqual(['draft-invalid', 'accepted']);
    expect(last.firstFailedOutput).toMatchObject({
      text: firstText,
      hash: sha256HexSync(firstText),
      bytes: new TextEncoder().encode(firstText).byteLength,
      representation: 'decoded-json',
      truncated: false,
    });
    expect(JSON.stringify(actual)).not.toContain('reviewedSourceIndices');
    expect(mocks.saveReview).toHaveBeenCalledOnce();
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect('persists the accepted attempt when the closing source fence refuses the review', () =>
  Effect.gen(function* () {
    const value = yield* requestFixture();
    mocks.packet
      .mockReturnValueOnce(Effect.succeed({topicEvidence: value.packet}))
      .mockReturnValue(Effect.succeed({topicEvidence: {...value.packet, targetHash: 'f'.repeat(64)}}));
    const failure = yield* requestTopicMaintenanceDraft(value.config, value.input, () =>
      Effect.succeed({
        text: JSON.stringify(decodeTopicDraftWire(value.basis, value.wire)),
        outputRepresentation: 'decoded-json' as const,
        backendIdentity: 'local-ai',
        modelIdentity: 'fixture',
        modelVersion: value.identity.modelVersion,
        settings: {maxOutputTokens: 4000 as const, seed: 0 as const},
        usage: {status: 'unavailable' as const},
      }),
    ).pipe(Effect.flip);
    const last = value.receipts.at(-1)!;
    expect(last).toMatchObject({state: 'failed', phase: 'closing-fence', attempts: [{status: 'accepted'}]});
    expect(mocks.saveReview).not.toHaveBeenCalled();
    expect(Schema.is(TopicDraftError)(failure) && failure.diagnostics?.receiptId).toBe(last.receiptId);
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect('refuses an unexpected sampling profile when the selected model has none', () =>
  Effect.gen(function* () {
    const value = yield* requestFixture();
    let calls = 0;
    const failure = yield* requestTopicMaintenanceDraft(value.config, value.input, () =>
      Effect.sync(() => {
        calls++;
        return {
          text: JSON.stringify(value.wire),
          backendIdentity: 'local-ai',
          modelIdentity: 'fixture',
          modelVersion: value.identity.modelVersion,
          settings: {
            maxOutputTokens: 4000 as const,
            seed: 0 as const,
            sampling: {profileId: 'unexpected', temperature: 1, topP: 0.95, topK: 64},
          },
          usage: {status: 'unavailable' as const},
        };
      }),
    ).pipe(Effect.flip);
    expect(calls).toBe(1);
    expect(Schema.is(TopicDraftError)(failure)).toBe(true);
    expect(value.receipts.at(-1)).toMatchObject({state: 'failed', attempts: [{status: 'provider-output-invalid'}]});
    expect(mocks.saveReview).not.toHaveBeenCalled();
    expect(value.receipts.at(-1)?.modelVersion).toBe(`${value.identity.modelVersion};${value.identity.settings}`);
  }).pipe(provideTestLayer(ApplicationLayer)),
);
