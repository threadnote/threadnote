import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestClock} from 'effect/testing';
import {TestError} from '@threadnote/testing/test-error';
import {createReviewedSupportSnapshot} from '@threadnote/memory/reviewed-support';
import {
  assertAutomaticMaintenanceAssessment,
  assertAutomaticMaintenanceSource,
  automaticMaintenanceEvidenceId,
  type AutomaticMaintenanceSourceV1,
} from '@threadnote/memory/automatic-maintenance';
import {it as effectIt} from '@effect/vitest';
import fc from 'fast-check';
import {describe, expect, it, vi} from 'vitest';
import {Effect, FileSystem, Path, Predicate, Ref, Result, Schema} from 'effect';
import {ResourceStore} from '@threadnote/store/resource-store';
import * as memoryIdentity from '@threadnote/recall/memory/identity';
import * as modelDiscovery from '../../src/manager/consolidation_models.js';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {assertApprovedSourceDescriptor, validateReviewedMemorySupport} from '@threadnote/memory/reviewed-support';
import {loadCandidateReview} from '@threadnote/memory/candidate';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {prepareMemoryMaintenanceBasis} from '@threadnote/context/memory_maintenance';
import {EffectMcpServerAdapter, EffectMcpServerRegistry} from '../../src/effect/ai/mcp.js';
import {registerStoreTool} from '../../src/mcp/server/store.js';
import {registerReadTool} from '../../src/mcp/server/recall.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {MemoryKind} from '@threadnote/memory/types';
import {registerContextMaintenanceTools} from '../../src/mcp/server/context/maintenance.js';
import {
  requestAutomaticMemoryReview,
  requestAutomaticMemoryDraft,
  automaticReviewPacket,
} from '../../src/memory/context/maintenance_draft.js';
import {
  projectAutomaticMemoryReview,
  projectTopicReviewDecisionAcknowledgement,
} from '../../src/memory/context/maintenance_review_projection.js';
import {applyTopicMaintenanceReview} from '../../src/memory/context/maintenance_review.js';
import {
  prepareAutomaticMemory,
  readLiveAutomaticPreparation,
} from '../../src/memory/context/maintenance_preparation.js';
import {
  parseAutomaticMaintenanceDraft,
  validateAutomaticMaintenanceDraftBasis,
  validateAutomaticMaintenanceReview,
  type AutomaticMaintenanceDraftBasisV3,
} from '@threadnote/memory/topic-maintenance-draft';
import {preparePersonalMemoryWrite} from '../../src/mcp/server/memory.js';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {readContextHealthCitationEvidence} from '@threadnote/context/citation_validation';
import {runCommandEffect} from '@threadnote/platform/command';
import {runContextMaintenance, readContextMaintenancePacket} from '../../src/memory/context/maintenance.js';
import {localDraftGenerationSettings} from '../../src/effect/ai/consolidator.js';
import type {runSelectedDraft} from '../../src/manager/selected_draft.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {readDraftQueueStatus} from '../../src/memory/context/maintenance_draft_queue.js';
import {compactAutomaticTopicDraftFixture} from '../helpers/topic-draft-wire.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function encodeMcpInput(input: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(input);
  if (encoded === undefined) throw TestError.make({message: 'MCP test input is not a JSON object.'});
  const decoded: unknown = JSON.parse(encoded);
  if (!Predicate.isObject(decoded) || EffectArray.isArray(decoded))
    throw TestError.make({message: 'MCP test input is not a JSON object.'});
  return decoded;
}

function structuredObject(value: unknown): Record<string, unknown> {
  expect(Predicate.isObject(value) && !EffectArray.isArray(value)).toBe(true);
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) {
    throw new Error('Expected an object MCP response.');
  }
  return value;
}

type AutomaticReviewPacket = ReturnType<typeof automaticReviewPacket>;
type PublicAutomaticReview = NonNullable<ReturnType<typeof projectAutomaticMemoryReview>>;
type ReviewDecisionAcknowledgement = NonNullable<ReturnType<typeof projectTopicReviewDecisionAcknowledgement>>;
type CompleteAutomaticReview = PublicAutomaticReview & {
  readonly approval: NonNullable<PublicAutomaticReview['approval']>;
};

function isAutomaticSource(value: unknown): value is AutomaticMaintenanceSourceV1 {
  try {
    assertAutomaticMaintenanceSource(value);
    return true;
  } catch {
    return false;
  }
}

const AutomaticSourceSchema = Schema.declare<AutomaticMaintenanceSourceV1>(isAutomaticSource);
const SourceDescriptorSchema = Schema.Struct({
  id: Schema.String,
  source: AutomaticSourceSchema,
  scope: Schema.Literals(['personal', 'shared', 'external', 'repository']),
  locator: Schema.optionalKey(Schema.Struct({repositoryId: Schema.String, teamId: Schema.String, path: Schema.String})),
});
const ReviewEvidenceSchema = Schema.Struct({
  handleId: Schema.String,
  descriptor: SourceDescriptorSchema,
  content: Schema.String,
  contentHash: Schema.String,
  codeExcerpt: Schema.optionalKey(
    Schema.Struct({startLine: Schema.Finite, endLine: Schema.Finite, fileBytesHash: Schema.String}),
  ),
});
const AutomaticDraftProposalSchema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal('automatic'),
  draft: Schema.Struct({
    version: Schema.Literal(2),
    kind: Schema.Literal('automatic'),
    purpose: Schema.Literals(['automatic', 'manual-edit']),
    targetHash: Schema.String,
    observationRevision: Schema.String,
    packetDigest: Schema.String,
    outcome: Schema.Literals(['propose-update', 'propose-revalidation', 'policy-conflict', 'insufficient-evidence']),
    operations: Schema.Array(
      Schema.Struct({
        ordinal: Schema.Finite,
        beforeHash: Schema.String,
        text: Schema.String,
        supportHandles: Schema.Array(Schema.String),
        rationale: Schema.String,
      }),
    ),
    reviewedHandles: Schema.Array(Schema.String),
    rationale: Schema.String,
    unresolvedQuestions: Schema.Array(Schema.String),
    removedClaims: Schema.Array(Schema.String),
    paragraphDecisions: Schema.Array(
      Schema.Struct({
        ordinal: Schema.Finite,
        beforeHash: Schema.String,
        role: Schema.Literals(['descriptive', 'normative', 'historical', 'unknown']),
        support: Schema.Literals(['direct', 'contextual', 'unresolved']),
        evidenceIds: Schema.Array(Schema.String),
      }),
    ),
    desiredBody: Schema.optionalKey(Schema.String),
  }),
  body: Schema.String,
  finalBodyHash: Schema.String,
  changedOrdinals: Schema.Array(Schema.Finite),
});
const CoverageSchema = Schema.Struct({
  outcome: Schema.Literals(['complete', 'partial', 'unknown']),
  scope: Schema.Literals(['recorded-only', 'bounded-search', 'none']),
  searchedScopes: Schema.Array(Schema.String),
  omittedSources: Schema.Finite,
  omittedParagraphs: Schema.NullOr(Schema.Finite),
});
const OwnerProposalSchema = Schema.Struct({
  operation: Schema.Literal('context_maintenance_review'),
  action: Schema.Literal('automatic-preview'),
  reviewId: Schema.String,
  revision: Schema.Finite,
  uri: Schema.String,
  authority: Schema.Literal('shared-owner'),
  publicationApprovalRequired: Schema.Literal(true),
  instructions: Schema.String,
});
const ReviewDecisionAcknowledgementSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal('topic-maintenance-recovery'),
  project: Schema.String,
  reviewId: Schema.String,
  revision: Schema.Finite,
  state: Schema.Literals(['applied', 'applying', 'conflict', 'deferred', 'pending', 'rejected']),
  caseId: Schema.optionalKey(Schema.String),
  recovery: Schema.optionalKey(Schema.Struct({action: Schema.Literal('reject')})),
});

const AutomaticReviewProjectionEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal('automatic-memory-review'),
  reviewId: Schema.String,
  revision: Schema.Finite,
  state: Schema.Literals(['applied', 'applying', 'conflict', 'deferred', 'pending', 'rejected']),
  targetUri: Schema.String,
  targetHash: Schema.String,
  purpose: Schema.Literals(['automatic', 'manual-edit']),
  acceptedBody: Schema.String,
  proposal: Schema.Unknown,
  sourceEvidence: Schema.Array(ReviewEvidenceSchema),
  coverage: CoverageSchema,
  approval: Schema.optionalKey(
    Schema.Struct({
      stage: Schema.Literals(['preview', 'parked', 'prepared', 'written', 'conflict']),
      reviewRevision: Schema.Finite,
      approvalDigest: Schema.String,
      content: Schema.String,
      contentHash: Schema.String,
      metadataDiff: Schema.Array(
        Schema.Struct({field: Schema.String, beforeHash: Schema.String, afterHash: Schema.String}),
      ),
      reviewedSupport: Schema.Unknown,
    }),
  ),
  canApply: Schema.Boolean,
  ownerProposal: Schema.optionalKey(OwnerProposalSchema),
});

const AutomaticBasisWireSchema = Schema.Struct({
  version: Schema.Literal(3),
  kind: Schema.Literal('automatic'),
  targetUri: Schema.String,
  targetHash: Schema.String,
  observationRevision: Schema.String,
  packetDigest: Schema.String,
  body: Schema.String,
  assessment: Schema.Unknown,
  reads: Schema.Array(Schema.Struct({uri: Schema.String, hash: Schema.String})),
  scopeRevision: Schema.String,
  paragraphs: Schema.Array(Schema.Unknown),
  additionalDependencies: Schema.Tuple([]),
  handles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      citationId: Schema.String,
      variant: Schema.Literals(['accepted', 'current']),
    }),
  ),
});

const PacketEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(3),
  kind: Schema.Literal('automatic'),
  basis: Schema.Unknown,
  reviewEvidence: Schema.Array(ReviewEvidenceSchema),
  omissions: Schema.Array(Schema.String),
  capabilities: Schema.Unknown,
  draftRequest: Schema.Struct({
    operation: Schema.Literal('context_maintenance_draft'),
    uri: Schema.String,
    expectedContentHash: Schema.String,
    available: Schema.Boolean,
    waitingReason: Schema.optionalKey(Schema.Literal('draft-basis-boundary')),
    instructions: Schema.optionalKey(Schema.String),
    requires: Schema.Tuple([Schema.Literal('backend'), Schema.Literal('modelId')]),
    roleDecisions: Schema.Literal('provisional-until-final-approval'),
  }),
  manualRequest: Schema.optionalKey(
    Schema.Struct({
      operation: Schema.Literal('context_maintenance_review'),
      action: Schema.Literal('manual-preview'),
      uri: Schema.String,
      expectedContentHash: Schema.String,
      available: Schema.Boolean,
      desiredBodyRequired: Schema.Literal(true),
    }),
  ),
  ownerProposal: Schema.optionalKey(
    Schema.Struct({
      operation: Schema.Literal('context_maintenance_review'),
      action: Schema.Literal('automatic-preview'),
      uri: Schema.String,
      expectedContentHash: Schema.String,
      publicationOperation: Schema.Literal('share_propose'),
      publicationApprovalRequired: Schema.Literal(true),
      instructions: Schema.String,
    }),
  ),
});

function decodeAutomaticReviewPacket(value: unknown): AutomaticReviewPacket {
  const envelope = decodeResult(value, PacketEnvelopeSchema);
  const basisWire = decodeResult(envelope.basis, AutomaticBasisWireSchema);
  assertAutomaticMaintenanceAssessment(basisWire.assessment);
  if (JSON.stringify(basisWire.paragraphs) !== JSON.stringify(basisWire.assessment.paragraphs))
    throw TestError.make({message: 'Automatic review packet paragraphs differ from their assessment.'});
  const basis = {
    ...basisWire,
    assessment: basisWire.assessment,
    paragraphs: basisWire.assessment.paragraphs,
  } satisfies AutomaticMaintenanceDraftBasisV3;
  for (const entry of envelope.reviewEvidence) {
    assertApprovedSourceDescriptor(entry.descriptor);
    if (entry.contentHash !== sha256HexSync(entry.content))
      throw TestError.make({message: 'Automatic review packet evidence hash does not match its content.'});
  }
  if (
    envelope.draftRequest.uri !== basis.targetUri ||
    envelope.draftRequest.expectedContentHash !== basis.targetHash ||
    JSON.stringify(envelope.capabilities) !== JSON.stringify(basis.assessment.capabilities) ||
    envelope.reviewEvidence.length !== basis.handles.length ||
    !EffectArray.every(envelope.reviewEvidence, item =>
      EffectArray.some(
        basis.handles,
        handle => handle.id === item.handleId && handle.citationId === item.descriptor.id,
      ),
    ) ||
    (envelope.manualRequest !== undefined &&
      (envelope.manualRequest.uri !== basis.targetUri ||
        envelope.manualRequest.expectedContentHash !== basis.targetHash)) ||
    (envelope.ownerProposal !== undefined &&
      (envelope.ownerProposal.uri !== basis.targetUri ||
        envelope.ownerProposal.expectedContentHash !== basis.targetHash))
  )
    throw TestError.make({message: 'Automatic review packet fields differ from the validated basis.'});
  const packet = {
    ...envelope,
    basis,
    reviewEvidence: Array.from(envelope.reviewEvidence),
    draftRequest: {...envelope.draftRequest, requires: Array.from(envelope.draftRequest.requires)},
    omissions: Array.from(envelope.omissions),
    capabilities: basis.assessment.capabilities,
  } satisfies AutomaticReviewPacket;
  if (JSON.stringify(packet) !== JSON.stringify(value))
    throw TestError.make({message: 'Automatic review packet differs from its validated wire representation.'});
  return packet;
}

function decodePublicAutomaticReview(value: unknown): PublicAutomaticReview {
  if (!Schema.is(AutomaticReviewProjectionEnvelopeSchema)(value))
    throw TestError.make({message: 'Automatic review projection does not match its public result schema.'});
  const envelope = value;
  if (!Schema.is(AutomaticDraftProposalSchema)(envelope.proposal))
    throw TestError.make({message: 'Automatic review proposal does not match its versioned schema.'});
  const proposal = envelope.proposal;
  const sourceEvidence = envelope.sourceEvidence;
  for (const entry of sourceEvidence) {
    assertApprovedSourceDescriptor(entry.descriptor);
    if (entry.contentHash !== sha256HexSync(entry.content))
      throw TestError.make({message: 'Automatic review evidence hash does not match its content.'});
  }
  let approval: PublicAutomaticReview['approval'];
  if (envelope.approval !== undefined) {
    const record = parseMemoryDocument(envelope.targetUri, envelope.approval.content);
    if (!record) throw TestError.make({message: 'Automatic review approval content is not a memory document.'});
    const reviewedSupport = validateReviewedMemorySupport(envelope.approval.reviewedSupport, record.body);
    approval = {...envelope.approval, reviewedSupport};
  }
  const projection = {
    ...envelope,
    proposal,
    sourceEvidence: Array.from(sourceEvidence),
    approval,
  } satisfies PublicAutomaticReview;
  if (JSON.stringify(projection) !== JSON.stringify(value))
    throw TestError.make({message: 'Automatic review projection differs from its validated wire representation.'});
  return projection;
}

function decodeReviewDecisionAcknowledgement(value: unknown): ReviewDecisionAcknowledgement | PublicAutomaticReview {
  if (Schema.is(ReviewDecisionAcknowledgementSchema)(value)) return value;
  return decodePublicAutomaticReview(value);
}

function decodeCompleteAutomaticReview(value: unknown): CompleteAutomaticReview {
  const projection = decodePublicAutomaticReview(value);
  const approval = projection.approval;
  if (approval === undefined) throw TestError.make({message: 'Automatic review projection has no approval preview.'});
  return {...projection, approval};
}

function decodeResult<T>(value: unknown, schema: Schema.Schema<T>): T {
  if (!Schema.is(schema)(value))
    throw TestError.make({message: 'MCP review response does not match its versioned result contract.'});
  return value;
}

const McpResultEnvelopeSchema = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.Unknown,
});

const MaintenanceStateSchema = Schema.StructWithRest(
  Schema.Struct({
    cases: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          caseId: Schema.String,
          citationId: Schema.optionalKey(Schema.String),
          memoryId: Schema.String,
          family: Schema.String,
          disposition: Schema.String,
          reason: Schema.String,
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const fixture = Effect.fn('automaticReview.fixture')(function* (
  kind: MemoryKind = 'durable',
  body = 'The timeout is 30 seconds.',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'ordinary-review-'});
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    manifestPath: path.join(home, 'manifest.yaml'),
    user: 'tester',
  };
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const uri = `threadnote://user/tester/memories/${kind}/projects/fixture/target.md`;
  const sourceUri = 'threadnote://user/tester/memories/durable/projects/fixture/source.md';
  const targetPath = path.join(home, 'data/local/user/tester/memories', kind, 'projects/fixture/target.md');
  const sourcePath = path.join(home, 'data/local/user/tester/memories/durable/projects/fixture/source.md');
  const metadata = {
    kind,
    status: 'active' as const,
    schemaVersion: 10,
    memoryId: 'tn_target',
    project: 'fixture',
    topic: 'target',
    sourceAgentClient: 'test',
    timestamp: '2026-10-21T00:00:00.000Z',
    relations: [{type: 'references' as const, uri: sourceUri}],
  };
  const content = formatMemoryDocument(kind === 'handoff' ? 'HANDOFF' : 'MEMORY', metadata, body);
  const source = formatMemoryDocument(
    'MEMORY',
    {...metadata, kind: 'durable', memoryId: 'tn_source', topic: 'source', relations: []},
    'The timeout is 60 seconds.',
  );
  yield* fs.makeDirectory(path.dirname(targetPath), {recursive: true});
  yield* fs.makeDirectory(path.dirname(sourcePath), {recursive: true});
  yield* fs.writeFileString(targetPath, content);
  yield* fs.writeFileString(sourcePath, source);
  type Packet = AutomaticReviewPacket;
  type CompleteReview = CompleteAutomaticReview;
  type ReviewEnvironment = Effect.Services<ReturnType<typeof server.invokeTool>>;
  type Output<T> = {readonly isError?: boolean; readonly structuredContent: T; readonly content: readonly unknown[]};
  const server = new EffectMcpServerRegistry();
  registerContextMaintenanceTools(server, config);
  function rawReview(input: Record<string, unknown>) {
    return server.invokeTool('context_maintenance_review', encodeMcpInput(input));
  }
  function review(
    input: Record<string, unknown> & {readonly action: 'reject'},
  ): Effect.Effect<Output<ReviewDecisionAcknowledgement | PublicAutomaticReview>, never, ReviewEnvironment>;
  function review(
    input: Record<string, unknown> & {readonly action: 'automatic-preview'; readonly draftJson?: undefined},
  ): Effect.Effect<Output<Packet>, never, ReviewEnvironment>;
  function review(input: Record<string, unknown>): Effect.Effect<Output<CompleteReview>, never, ReviewEnvironment>;
  function review(input: Record<string, unknown>): Effect.Effect<Output<unknown>, never, ReviewEnvironment> {
    return rawReview(input).pipe(
      Effect.flatMap(result => {
        if (result.isError === true || result.structuredContent === undefined)
          return Effect.fail(
            TestError.make({message: 'Expected a successful review projection; use rawReview for error cases.'}),
          );
        return Effect.try({
          try: () => {
            const envelope = decodeResult(result, McpResultEnvelopeSchema);
            const structuredContent =
              input.action === 'automatic-preview' && input.draftJson === undefined
                ? decodeAutomaticReviewPacket(envelope.structuredContent)
                : input.action === 'reject'
                  ? decodeReviewDecisionAcknowledgement(envelope.structuredContent)
                  : decodeCompleteAutomaticReview(envelope.structuredContent);
            return {content: envelope.content, structuredContent};
          },
          catch: () => TestError.make({message: 'MCP review response could not be decoded.'}),
        });
      }),
      Effect.orDie,
    );
  }
  return {config, uri, sourceUri, targetPath, sourcePath, content, review, rawReview, fs, path, home};
});

const publicRelatedFixture = Effect.fn('automaticReview.publicRelatedFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* ResourceStore;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'ordinary-public-related-'});
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    user: 'tester',
    manifestPath: path.join(home, 'manifest.yaml'),
  };
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const server = new EffectMcpServerAdapter('automatic-related-review-test', '1.0.0', '');
  registerStoreTool(server, config, 'remember_context', 'Store memory.');
  registerReadTool(server, config, 'read_context', 'Read memory.');
  registerContextMaintenanceTools(server, config);
  const authored = yield* server.invokeTool('remember_context', {
    kind: 'durable',
    project: 'fixture',
    topic: 'source',
    text: 'The timeout is 60 seconds.',
    keywords: ['synthetic', 'related-review'],
  });
  expect(authored.isError).not.toBe(true);
  const sourceUri = String(structuredObject(authored.structuredContent).memoryUri);
  expect(sourceUri).toBe('threadnote://user/tester/memories/durable/projects/fixture/source.md');
  const target = yield* server.invokeTool('remember_context', {
    kind: 'durable',
    project: 'fixture',
    topic: 'target',
    text: 'The timeout is 30 seconds.',
    keywords: ['synthetic', 'related-review'],
    relations: [{type: 'references', uri: sourceUri}],
  });
  expect(target.isError).not.toBe(true);
  const uri = String(structuredObject(target.structuredContent).memoryUri);
  expect(uri).toBe('threadnote://user/tester/memories/durable/projects/fixture/target.md');
  const root = path.join(home, 'data/local/user/tester/memories');
  const targetPath = path.join(root, 'durable/projects/fixture/target.md');
  const sourcePath = path.join(root, 'durable/projects/fixture/source.md');
  const content = yield* fs.readFileString(targetPath);
  const source = yield* fs.readFileString(sourcePath);
  const sourceId = parseMemoryDocument(sourceUri, source)!.metadata.memoryId!;
  const alias = `threadnote://memory/${sourceId}`;
  expect(sourceId).toMatch(/^tn_[a-z0-9_]+$/u);
  expect(parseMemoryDocument(uri, content)!.metadata.relations).toEqual([{type: 'references', uri: alias}]);
  const review = (input: Record<string, unknown>) => server.invokeTool('context_maintenance_review', input);
  return {
    fs,
    path,
    store,
    config,
    server,
    home,
    root,
    uri,
    sourceUri,
    targetPath,
    sourcePath,
    content,
    source,
    sourceId,
    alias,
    review,
  };
});

function draft(packet: ReturnType<typeof automaticReviewPacket>, text: string, role = 'descriptive') {
  const basis = packet.basis;
  const handle = packet.reviewEvidence[0];
  const changed = text !== basis.body;
  return JSON.stringify({
    version: 2,
    kind: 'automatic',
    purpose: 'automatic',
    targetHash: basis.targetHash,
    observationRevision: basis.observationRevision,
    packetDigest: basis.packetDigest,
    outcome: changed ? 'propose-update' : 'propose-revalidation',
    operations: changed
      ? [
          {
            ordinal: 0,
            beforeHash: basis.paragraphs[0].hash,
            text,
            supportHandles: [handle.handleId],
            rationale: 'Review exact current behavior.',
          },
        ]
      : [],
    reviewedHandles: [handle.handleId],
    rationale: 'Explicit full paragraph review.',
    unresolvedQuestions: [],
    removedClaims: [],
    paragraphDecisions: [
      {ordinal: 0, beforeHash: basis.paragraphs[0].hash, role, support: 'direct', evidenceIds: [handle.descriptor.id]},
    ],
  });
}

describe('ordinary memory exact public review', () => {
  effectIt.effect(
    'resolves public authored reference aliases through review, cache loss and unchanged manual preview',
    () =>
      Effect.gen(function* () {
        const f = yield* publicRelatedFixture();
        for (const uri of [f.sourceUri, f.alias]) {
          const read = yield* f.server.invokeTool('read_context', {uri, responseFormat: 'dual'});
          expect(read.isError).not.toBe(true);
          expect(structuredObject(read.structuredContent).content).toBe(f.source);
        }
        const inspected = yield* f.review({
          action: 'automatic-preview',
          uri: f.uri,
          expectedContentHash: sha256HexSync(f.content),
        });
        expect(inspected.isError).not.toBe(true);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- In-process MCP response fields are verified by this integration fixture.
        const packet = inspected.structuredContent as ReturnType<typeof automaticReviewPacket>;
        expect(packet.omissions).not.toContain('related-source-unreadable');
        expect(packet.reviewEvidence).toHaveLength(1);
        expect(packet.reviewEvidence[0].descriptor.source).toMatchObject({
          kind: 'memory',
          uri: f.sourceUri,
          memoryId: f.sourceId,
        });
        expect(
          EffectArrayPipe(packet.basis.reads, __effectArrayValues =>
            EffectArray.filter(
              __effectArrayValues,
              (read, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && read.uri === f.sourceUri,
            ),
          ),
        ).toHaveLength(1);
        const proposed = yield* f.review({
          action: 'automatic-preview',
          uri: f.uri,
          expectedContentHash: sha256HexSync(f.content),
          draftJson: draft(packet, 'The timeout is 60 seconds.'),
        });
        expect(proposed.isError).not.toBe(true);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- In-process MCP response fields are verified by this integration fixture.
        const preview = proposed.structuredContent as NonNullable<ReturnType<typeof projectAutomaticMemoryReview>>;
        expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
        const applied = yield* f.review({
          action: 'apply',
          reviewId: preview.reviewId,
          revision: preview.revision,
          approvalDigest: preview.approval!.approvalDigest,
          approved: true,
        });
        expect(applied.isError).not.toBe(true);
        const accepted = yield* f.fs.readFileString(f.targetPath);
        expect(accepted).toBe(preview.approval!.content);
        const current = parseMemoryDocument(f.uri, accepted)!;
        expect(current.metadata.relations).toEqual([{type: 'references', uri: f.alias}]);
        expect(current.metadata.reviewedSupport!.active.sources[0].source).toMatchObject({
          kind: 'memory',
          uri: f.sourceUri,
        });
        yield* f.fs.remove(f.path.join(f.home, 'context-maintenance/automatic'), {recursive: true, force: true});
        const rebuiltResult = yield* f.review({
          action: 'automatic-preview',
          uri: f.uri,
          expectedContentHash: sha256HexSync(accepted),
        });
        expect(rebuiltResult.isError).not.toBe(true);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- In-process MCP response fields are verified by this integration fixture.
        const rebuilt = rebuiltResult.structuredContent as ReturnType<typeof automaticReviewPacket>;
        expect(rebuilt.omissions).not.toContain('related-source-unreadable');
        expect(rebuilt.basis.assessment.coverage.omittedSources).toBe(0);
        expect(rebuilt.basis.reads).toHaveLength(2);
        expect(
          EffectArrayPipe(rebuilt.basis.reads, __effectArrayValues =>
            EffectArray.filter(
              __effectArrayValues,
              (read, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && read.uri === f.sourceUri,
            ),
          ),
        ).toHaveLength(1);
        expect(
          EffectArrayPipe(rebuilt.basis.assessment.evidence, __effectArrayValues =>
            EffectArray.filter(
              __effectArrayValues,
              (entry, __effectArrayIndex) =>
                __effectArrayIndex in __effectArrayValues && entry.source.kind === 'memory',
            ),
          ),
        ).toHaveLength(1);
        const manualResult = yield* f.review({
          action: 'manual-preview',
          uri: f.uri,
          expectedContentHash: sha256HexSync(accepted),
          desiredBody: current.body,
        });
        expect(manualResult.isError).not.toBe(true);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- In-process MCP response fields are verified by this integration fixture.
        const manual = manualResult.structuredContent as NonNullable<ReturnType<typeof projectAutomaticMemoryReview>>;
        expect(manual.approval!.reviewedSupport.active.paragraphs).toEqual(
          current.metadata.reviewedSupport!.active.paragraphs,
        );
        expect(manual.approval!.reviewedSupport.active.sources).toEqual(
          current.metadata.reviewedSupport!.active.sources,
        );
        expect(yield* f.fs.readFileString(f.targetPath)).toBe(accepted);
        expect(yield* f.fs.readFileString(f.sourcePath)).toBe(f.source);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  for (const failure of ['missing', 'ambiguous'] as const) {
    effectIt.effect(`withholds a ${failure} public authored reference alias without changing the target`, () =>
      Effect.gen(function* () {
        const f = yield* publicRelatedFixture();
        const location = {account: f.config.account, home: f.home, user: f.config.user};
        if (failure === 'missing') yield* f.store.remove(location, f.sourceUri);
        else
          yield* f.store.write(
            location,
            Effect2.pipe(f.sourceUri, EffectString.replace('/source.md', '/duplicate.md')),
            Effect2.pipe(f.source, EffectString.replace('topic: source', 'topic: duplicate')),
            {mode: 'create'},
          );
        const inspected = yield* f.review({
          action: 'automatic-preview',
          uri: f.uri,
          expectedContentHash: sha256HexSync(f.content),
        });
        expect(inspected.isError).not.toBe(true);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- In-process MCP response fields are verified by this integration fixture.
        const packet = inspected.structuredContent as ReturnType<typeof automaticReviewPacket>;
        expect(packet.omissions).toContain('related-source-unreadable');
        expect(packet.reviewEvidence).toHaveLength(0);
        expect(packet.basis.reads).toHaveLength(1);
        expect(packet.basis.assessment.coverage.omittedSources).toBe(1);
        expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );
  }

  effectIt.effect('withholds a public authored alias when its live identity changes after resolution', () =>
    Effect.gen(function* () {
      const f = yield* publicRelatedFixture();
      const changed = yield* Ref.make(false);
      const resolve = memoryIdentity.resolveMemoryIdentityAliases;
      const raced = Effect2.pipe(
        f.source,
        EffectString.replace(`memory_id: ${f.sourceId}`, 'memory_id: tn_reused_source_identity'),
      );
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi
            .spyOn(memoryIdentity, 'resolveMemoryIdentityAliases')
            .mockImplementation((...args) =>
              resolve(...args).pipe(
                Effect.tap(routes =>
                  EffectArray.some(routes, route => route.requestedUri === f.alias)
                    ? Ref.getAndSet(changed, true).pipe(
                        Effect.flatMap(alreadyChanged =>
                          alreadyChanged
                            ? Effect.void
                            : f.store.write(
                                {account: f.config.account, home: f.home, user: f.config.user},
                                f.sourceUri,
                                raced,
                                {mode: 'replace'},
                              ),
                        ),
                      )
                    : Effect.void,
                ),
              ),
            ),
        ),
        () =>
          Effect.gen(function* () {
            const inspected = yield* f.review({
              action: 'automatic-preview',
              uri: f.uri,
              expectedContentHash: sha256HexSync(f.content),
            });
            expect(yield* Ref.get(changed)).toBe(true);
            expect(inspected.isError).not.toBe(true);
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- In-process MCP response fields are verified by this integration fixture.
            const packet = inspected.structuredContent as ReturnType<typeof automaticReviewPacket>;
            expect(packet.omissions).toContain('related-source-unreadable');
            expect(packet.reviewEvidence).toHaveLength(0);
            expect(packet.basis.reads).toHaveLength(1);
            expect(packet.basis.assessment.coverage.omittedSources).toBe(1);
            expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
            expect(yield* f.fs.readFileString(f.sourcePath)).toBe(raced);
          }),
        spy => Effect.sync(() => spy.mockRestore()),
      );
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses public apply when an authored source identity becomes ambiguous after preview', () =>
    Effect.gen(function* () {
      const f = yield* publicRelatedFixture();
      const inspected = yield* f.review({
        action: 'automatic-preview',
        uri: f.uri,
        expectedContentHash: sha256HexSync(f.content),
      });
      expect(inspected.isError).not.toBe(true);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- In-process MCP response fields are verified by this integration fixture.
      const packet = inspected.structuredContent as ReturnType<typeof automaticReviewPacket>;
      expect(packet.reviewEvidence).toHaveLength(1);
      const proposed = yield* f.review({
        action: 'automatic-preview',
        uri: f.uri,
        expectedContentHash: sha256HexSync(f.content),
        draftJson: draft(packet, 'The timeout is 60 seconds.'),
      });
      expect(proposed.isError).not.toBe(true);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- In-process MCP response fields are verified by this integration fixture.
      const preview = proposed.structuredContent as NonNullable<ReturnType<typeof projectAutomaticMemoryReview>>;
      const duplicateUri = Effect2.pipe(f.sourceUri, EffectString.replace('/source.md', '/duplicate.md'));
      yield* f.store.write(
        {account: f.config.account, home: f.home, user: f.config.user},
        duplicateUri,
        Effect2.pipe(f.source, EffectString.replace('topic: source', 'topic: duplicate')),
        {mode: 'create'},
      );
      const ambiguous = yield* f.server.invokeTool('read_context', {uri: f.alias, responseFormat: 'dual'});
      expect(ambiguous.isError).toBe(true);
      expect(yield* f.fs.readFileString(f.sourcePath)).toBe(f.source);
      const applied = yield* f.server.invokeTool('context_maintenance_review', {
        action: 'apply',
        reviewId: preview.reviewId,
        revision: preview.revision,
        approvalDigest: preview.approval!.approvalDigest,
        approved: true,
      });
      expect(applied.isError).toBe(true);
      expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
      expect(yield* f.fs.readFileString(f.sourcePath)).toBe(f.source);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  for (const [action, overflow] of [
    ['automatic-preview', false],
    ['manual-preview', false],
    ['automatic-preview', true],
  ] as const) {
    effectIt.effect(
      overflow
        ? 'refuses actual twenty-five-handle producer before model or quota admission'
        : `reviews all seventeen produced handles in a public ${action} request`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          const repository = f.path.join(f.home, 'repository');
          yield* f.fs.makeDirectory(repository);
          const refs = Array.from({length: 8}, (_, index) => `source-${index}.ts`);
          const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
          const commit = (message: string) =>
            Effect.gen(function* () {
              yield* git(['add', '.']);
              yield* git([
                '-c',
                'user.name=Test',
                '-c',
                'user.email=test@example.invalid',
                'commit',
                '--quiet',
                '-m',
                message,
              ]);
            });
          const index = () =>
            CodeGraphIndexer.pipe(
              Effect.flatMap(indexer => indexer.index({cwd: repository, threadnoteHome: f.home, ensureVectors: false})),
            );
          yield* f.fs.writeFileString(
            f.config.manifestPath,
            `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`,
          );
          yield* git(['init', '--quiet']);
          for (const ref of refs)
            yield* f.fs.writeFileString(f.path.join(repository, ref), 'export const timeoutSeconds = 30;\n');
          yield* commit('original');
          yield* index();
          const roots = yield* captureMemoryCodeCitations(f.config, {callerCwd: repository, refs});
          const metadata = {...parseMemoryDocument(f.uri, f.content)!.metadata, codeCitations: roots};
          const baseline = formatMemoryDocument('MEMORY', metadata, 'The timeout is 30 seconds.');
          const currentRefs = overflow ? EffectArray.map(refs, ref => `active-${ref}`) : refs;
          for (const ref of currentRefs)
            yield* f.fs.writeFileString(f.path.join(repository, ref), 'export const timeoutSeconds = 60;\n');
          yield* commit('current');
          yield* index();
          const current = yield* captureMemoryCodeCitations(f.config, {callerCwd: repository, refs: currentRefs});
          const sources = EffectArray.map(current, citation => {
            const source = {kind: 'code' as const, citation};
            return {id: automaticMaintenanceEvidenceId(source), source, scope: 'repository' as const};
          });
          const body = 'The timeout is 60 seconds.';
          // Seed a valid accepted record from real old/current captures. Cache loss must
          // reconstruct this canonical eight-pin authority without replaying its history.
          const active = createReviewedSupportSnapshot({
            bodyHash: sha256HexSync(body),
            paragraphs: [
              {
                ordinal: 0,
                hash: sha256HexSync(body),
                role: 'descriptive',
                support: 'direct',
                evidenceIds: EffectArray.map(sources, source => source.id),
              },
            ],
            sources,
            acceptance: {
              reviewId: 'review-eight-pin-fixture',
              approvedAt: '2026-10-21T00:00:00.000Z',
              targetBeforeHash: sha256HexSync(baseline),
              preparationDigest: sha256HexSync(JSON.stringify(roots)),
              sourceVectorDigest: sha256HexSync(JSON.stringify(sources)),
            },
          });
          const accepted = formatMemoryDocument(
            'MEMORY',
            {...metadata, schemaVersion: 11, reviewedSupport: {type: 'reviewed-memory-support', version: 1, active}},
            body,
          );
          yield* f.fs.writeFileString(f.targetPath, accepted);
          const packet = yield* f.review({
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(accepted),
            sourceCwd: repository,
          });
          expect(packet.isError, JSON.stringify(packet)).not.toBe(true);
          const p = packet.structuredContent;
          expect(p.basis.assessment.version).toBe(2);
          if (overflow) {
            expect(p.reviewEvidence).toHaveLength(25);
            expect(
              EffectArrayPipe(p.reviewEvidence, __effectArrayValues =>
                EffectArray.filter(
                  __effectArrayValues,
                  (entry, __effectArrayIndex) =>
                    __effectArrayIndex in __effectArrayValues && entry.descriptor.source.kind === 'code',
                ),
              ),
            ).toHaveLength(24);
            expect(p.draftRequest.available).toBe(false);
            const discovery = vi
              .spyOn(modelDiscovery, 'availableConsolidationModels')
              .mockImplementation(() => Effect.die(new Error('Over-budget basis reached model discovery.')));
            let calls = 0;
            let discoveryCalls = 0;
            const attempted = yield* requestAutomaticMemoryDraft(
              f.config,
              {
                uri: f.uri,
                expectedContentHash: sha256HexSync(accepted),
                sourceCwd: repository,
                backend: 'local-ai',
                modelId: 'test-model',
              },
              () =>
                Effect.sync(() => {
                  calls++;
                  throw new Error('Over-budget basis reached generation.');
                }),
            ).pipe(
              Effect.result,
              Effect.ensuring(
                Effect.sync(() => {
                  discoveryCalls = discovery.mock.calls.length;
                  discovery.mockRestore();
                }),
              ),
            );
            expect(attempted._tag).toBe('Failure');
            expect(calls).toBe(0);
            expect(discoveryCalls).toBe(0);
            const queue = yield* readDraftQueueStatus(f.config);
            expect(queue.backgroundReservations).toEqual([]);
            expect(queue.queued).toEqual([]);
            expect(queue.active).toBeUndefined();
            expect(yield* f.fs.exists(f.path.join(f.home, 'threadnote/candidates/v1/topic-generation'))).toBe(false);
            expect(yield* f.fs.readFileString(f.targetPath)).toBe(accepted);
            return;
          }
          expect(p.reviewEvidence).toHaveLength(17);
          expect(
            EffectArrayPipe(p.reviewEvidence, __effectArrayValues2 =>
              EffectArray.filter(
                __effectArrayValues2,
                (entry, __effectArrayIndex2) =>
                  __effectArrayIndex2 in __effectArrayValues2 &&
                  Effect2.pipe(entry.handleId, EffectString.startsWith('accepted:')),
              ),
            ),
          ).toHaveLength(8);
          expect(
            EffectArrayPipe(p.reviewEvidence, __effectArrayValues =>
              EffectArray.filter(
                __effectArrayValues,
                (entry, __effectArrayIndex) =>
                  __effectArrayIndex in __effectArrayValues && entry.descriptor.source.kind === 'memory',
              ),
            ),
          ).toHaveLength(1);
          const selected = EffectArrayPipe(p.reviewEvidence, __effectArrayValues2 =>
            EffectArray.filter(
              __effectArrayValues2,
              (entry, __effectArrayIndex2) =>
                __effectArrayIndex2 in __effectArrayValues2 &&
                Effect2.pipe(entry.handleId, EffectString.startsWith('current:')) &&
                entry.descriptor.source.kind === 'code',
            ),
          );
          expect(selected).toHaveLength(8);
          expect(
            EffectArray.every(
              selected,
              entry => Effect2.pipe(entry.content, EffectString.trim) === 'export const timeoutSeconds = 60;',
            ),
          ).toBe(true);
          expect(
            EffectArray.every(
              selected,
              entry => entry.codeExcerpt?.fileBytesHash === sha256HexSync('export const timeoutSeconds = 60;\n'),
            ),
          ).toBe(true);
          // Legacy basis geometry remains bounded even though V2 admits this vector.
          expect(() =>
            validateAutomaticMaintenanceDraftBasis({
              ...p.basis,
              assessment: {...p.basis.assessment, version: 1},
              reads: p.basis.reads.slice(0, 16),
            }),
          ).toThrow('invalid automatic basis');
          expect(() =>
            validateAutomaticMaintenanceDraftBasis({
              ...p.basis,
              handles: [...p.basis.handles, ...p.basis.handles.slice(0, 8)],
            }),
          ).toThrow('invalid automatic basis');
          const proposal = JSON.parse(draft(p, body));
          const raw = JSON.stringify({
            ...proposal,
            reviewedHandles: EffectArray.map(selected, entry => entry.handleId),
            paragraphDecisions: [
              {...proposal.paragraphDecisions[0], evidenceIds: EffectArray.map(selected, entry => entry.descriptor.id)},
            ],
          });
          const preview = yield* f.review({
            action,
            uri: f.uri,
            expectedContentHash: sha256HexSync(accepted),
            sourceCwd: repository,
            ...(action === 'automatic-preview' ? {draftJson: raw} : {desiredBody: body}),
          });
          expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
          expect(preview.structuredContent.sourceEvidence).toHaveLength(17);
          expect(parseMemoryDocument(f.uri, preview.structuredContent.approval.content)!.body).toBe(body);
          expect(preview.structuredContent.approval.reviewedSupport.active.paragraphs[0].support).toBe('direct');
          expect(preview.structuredContent.approval.reviewedSupport.active.sources).toHaveLength(8);
          if (action === 'manual-preview')
            expect(preview.structuredContent.approval.reviewedSupport.active.paragraphs).toEqual(active.paragraphs);
          const payload = (yield* loadCandidateReview(f.home, preview.structuredContent.reviewId)).maintenance!;
          expect(() => validateAutomaticMaintenanceReview(payload)).not.toThrow();
          // Complete evidence is a bijection: no source may be dropped or counted twice.
          fc.assert(
            fc.property(fc.integer({min: 0, max: 16}), ordinal => {
              expect(() =>
                validateAutomaticMaintenanceReview({
                  ...payload,
                  reviewEvidence: EffectArrayPipe(p.reviewEvidence, __effectArrayValues2 =>
                    EffectArray.filter(
                      __effectArrayValues2,
                      (_, index) => index in __effectArrayValues2 && index !== ordinal,
                    ),
                  ),
                }),
              ).toThrow();
              expect(() =>
                validateAutomaticMaintenanceReview({
                  ...payload,
                  reviewEvidence: [...p.reviewEvidence, p.reviewEvidence[ordinal]],
                }),
              ).toThrow();
            }),
            {numRuns: 24},
          );
          expect(parseMemoryDocument(f.uri, accepted)!.metadata.codeCitations).toEqual(roots);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(accepted);
        }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
      90_000,
    );
  }

  effectIt.effect(
    'code-backed approval keeps historical roots without reopening health and detects new active-source drift',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const repository = f.path.join(f.home, 'repository');
          yield* f.fs.makeDirectory(repository);
          const source = f.path.join(repository, 'source.ts');
          const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
          const commit = (message: string) =>
            Effect.gen(function* () {
              yield* git(['add', '.']);
              yield* git([
                '-c',
                'user.name=Test',
                '-c',
                'user.email=test@example.invalid',
                'commit',
                '--quiet',
                '-m',
                message,
              ]);
            });
          const index = () =>
            CodeGraphIndexer.pipe(
              Effect.flatMap(indexer => indexer.index({cwd: repository, threadnoteHome: f.home, ensureVectors: false})),
            );
          yield* f.fs.writeFileString(
            f.config.manifestPath,
            `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`,
          );
          yield* git(['init', '--quiet']);
          yield* f.fs.writeFileString(source, 'export const requestTimeoutSeconds = 30;\n');
          yield* commit('initial');
          yield* index();
          const [citation] = yield* captureMemoryCodeCitations(f.config, {callerCwd: repository, refs: ['source.ts']});
          const baseline = formatMemoryDocument(
            'MEMORY',
            {...parseMemoryDocument(f.uri, f.content)!.metadata, relations: [], codeCitations: [citation]},
            'The timeout is 30 seconds.',
          );
          yield* f.fs.writeFileString(f.targetPath, baseline);
          yield* f.fs.writeFileString(source, 'export const requestTimeoutSeconds = 60;\n');
          yield* commit('current');
          yield* index();
          const state = () =>
            f.fs
              .readFileString(f.path.join(f.home, 'context-maintenance/state-v2.json'))
              .pipe(Effect.flatMap(text => Schema.decodeUnknownEffect(MaintenanceStateSchema)(JSON.parse(text))));
          const activeCitationCases = () =>
            state().pipe(
              Effect.map(current =>
                EffectArrayPipe(current.cases, __effectArrayValues =>
                  EffectArray.filter(
                    __effectArrayValues,
                    (item, __effectArrayIndex) =>
                      __effectArrayIndex in __effectArrayValues &&
                      item.memoryId === 'tn_target' &&
                      (item.family === 'citation' || item.family === 'citation-coverage') &&
                      item.disposition !== 'resolved',
                  ),
                ),
              ),
            );
          for (let tick = 0; tick < 8; tick++) yield* runContextMaintenance(f.config, {cwd: repository});
          expect(EffectArray.some(yield* activeCitationCases(), item => item.disposition === 'needs-decision')).toBe(
            true,
          );
          const packet = yield* f.review({
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(baseline),
            sourceCwd: repository,
          });
          expect(packet.isError).not.toBe(true);
          expect(packet.structuredContent.reviewEvidence).toHaveLength(1);
          expect(packet.structuredContent.reviewEvidence[0].descriptor.source).toMatchObject({
            kind: 'code',
            citation: {target: {kind: 'file'}},
          });
          expect(packet.structuredContent.reviewEvidence[0].codeExcerpt?.fileBytesHash).toBe(
            sha256HexSync('export const requestTimeoutSeconds = 60;\n'),
          );
          const entry = packet.structuredContent.reviewEvidence[0];
          if (entry.descriptor.source.kind !== 'code') throw new Error('Expected code.');
          const proof = yield* readContextHealthCitationEvidence(
            f.config,
            {kind: 'repository', callerCwd: repository},
            entry.descriptor.source.citation,
            {
              startLine: entry.codeExcerpt!.startLine,
              maximumLines: entry.codeExcerpt!.endLine - entry.codeExcerpt!.startLine + 1,
              maximumBytes: 32 * 1024,
            },
          );
          expect(
            EffectOption.getOrUndefined(
              EffectArray.findFirst(proof.excerpts, excerpt => excerpt.provenance === 'current-verified'),
            ),
            JSON.stringify(proof),
          ).toMatchObject({
            supportsCitation: true,
            content: entry.content,
            excerptHash: entry.contentHash,
            fileBytesHash: entry.codeExcerpt!.fileBytesHash,
            source: {sourceDirty: entry.descriptor.source.citation.sourceDirty},
          });
          const preview = yield* f.review({
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(baseline),
            sourceCwd: repository,
            draftJson: draft(packet.structuredContent, 'The timeout is 60 seconds.'),
          });
          expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
          const p = preview.structuredContent;
          yield* f.fs.writeFileString(source, 'export const requestTimeoutSeconds = 90;\n');
          const raced = yield* f.rawReview({
            action: 'apply',
            reviewId: p.reviewId,
            revision: p.revision,
            approvalDigest: p.approval.approvalDigest,
            approved: true,
            sourceCwd: repository,
          });
          expect(raced.isError).toBe(true);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(baseline);
          yield* f.fs.writeFileString(source, 'export const requestTimeoutSeconds = 60;\n');
          const approved = yield* f.review({
            action: 'apply',
            reviewId: p.reviewId,
            revision: p.revision,
            approvalDigest: p.approval.approvalDigest,
            approved: true,
            sourceCwd: repository,
          });
          expect(approved.isError).not.toBe(true);
          expect(yield* activeCitationCases()).toEqual([]);
          const accepted = yield* f.fs.readFileString(f.targetPath);
          expect(parseMemoryDocument(f.uri, accepted)!.metadata.codeCitations).toEqual([citation]);
          yield* f.fs.writeFileString(f.path.join(repository, 'unrelated.ts'), 'export const untouched = true;\n');
          yield* commit('unrelated');
          yield* index();
          const manual = yield* f.review({
            action: 'manual-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(accepted),
            desiredBody: 'The timeout is 60 seconds.',
            sourceCwd: repository,
          });
          expect(manual.isError, JSON.stringify(manual)).not.toBe(true);
          expect(manual.structuredContent.approval.reviewedSupport.active.paragraphs[0]).toEqual(
            p.approval.reviewedSupport.active.paragraphs[0],
          );
          for (let tick = 0; tick < 8; tick++) yield* runContextMaintenance(f.config, {cwd: repository});
          expect(yield* activeCitationCases()).toEqual([]);
          yield* f.fs.writeFileString(source, 'export const requestTimeoutSeconds = 90;\n');
          yield* commit('new-active-drift');
          yield* index();
          for (let tick = 0; tick < 12; tick++) {
            yield* runContextMaintenance(f.config, {cwd: repository});
            if (EffectArray.some(yield* activeCitationCases(), item => item.disposition === 'needs-decision')) break;
          }
          expect(EffectArray.some(yield* activeCitationCases(), item => item.disposition === 'needs-decision')).toBe(
            true,
          );
          const newer = EffectOption.getOrUndefined(
            EffectArray.findFirst(yield* activeCitationCases(), item => item.disposition === 'needs-decision'),
          )!;
          const activeSource = p.approval.reviewedSupport.active.sources[0].source;
          if (activeSource.kind !== 'code') throw new Error('Expected approved code source.');
          expect(newer.citationId).toBe(activeSource.citation.id);
          const healthPacket = yield* readContextMaintenancePacket(f.config, newer.caseId);
          if (!('reviewRoute' in healthPacket) || !healthPacket.reviewRoute)
            throw new Error('Expected ordinary support-aware review route.');
          expect(healthPacket.reviewRoute).toMatchObject({
            operation: 'context_maintenance_review',
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(accepted),
            sourceCwd: repository,
          });
          expect(healthPacket.allowedOperations).not.toContain('context_health_repair_apply');
          expect(
            EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(healthPacket.evidence?.excerpts), __effectOptionalArray =>
                Boolean(
                  EffectArray.some(
                    __effectOptionalArray,
                    excerpt =>
                      excerpt.provenance === 'current-verified' &&
                      Effect2.pipe(excerpt.content, EffectString.includes('90')),
                  ),
                ),
              ),
            ),
          ).toBe(true);
          const refreshed = yield* f.review({
            ...healthPacket.reviewRoute,
            action: 'automatic-preview',
            draftJson: undefined,
          });
          expect(refreshed.isError).not.toBe(true);
          expect(
            EffectArray.some(refreshed.structuredContent.reviewEvidence, entry =>
              Effect2.pipe(entry.content, EffectString.includes('90')),
            ),
          ).toBe(true);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(accepted);
        }),
      ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    90_000,
  );

  effectIt.effect(
    'explicit model request proposes provisional roles without enrollment and preserves pending review precedence',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const catalog = yield* LocalModelCatalog;
          const modelId = 'gemma-4-e4b-it-q4';
          const manifest = yield* catalog.get(modelId);
          const store = yield* LocalModelStore;
          const installed = LocalModelStore.of({
            ...store,
            status: (_home, selected) =>
              Effect.succeed({
                bytes: selected.size,
                installed: true,
                modelId: selected.id,
                partialBytes: 0,
                path: '/fake/model.gguf',
                verified: true,
              }),
          });
          let calls = 0;
          const generator: typeof runSelectedDraft = (_config, _backend, _model, prompt, _purpose, basis) =>
            Effect.sync(() => {
              calls++;
              if (!basis || basis.version !== 3) throw new Error('Expected automatic source basis.');
              const packet = JSON.parse(Effect2.pipe(prompt, EffectString.split('\n')).at(-1)!);
              return {
                text: JSON.stringify(
                  compactAutomaticTopicDraftFixture(
                    basis,
                    JSON.parse(
                      draft(
                        {...packet, basis, reviewEvidence: packet.currentSources},
                        packet.currentSources[0].content,
                      ),
                    ),
                  ),
                ),
                backendIdentity: 'local-ai',
                modelIdentity: modelId,
                modelVersion: `${manifest.revision}:${manifest.sha256}`,
                usage: {status: 'unavailable' as const},
                settings: localDraftGenerationSettings(modelId, 'topic-maintenance'),
              };
            });
          const input = {
            uri: f.uri,
            expectedContentHash: sha256HexSync(f.content),
            backend: 'local-ai' as const,
            modelId,
          };
          const initialPacket = yield* f.review({
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(f.content),
          });
          expect(initialPacket.structuredContent.capabilities.draft).toBe(false);
          expect(initialPacket.structuredContent.draftRequest).toMatchObject({
            available: true,
            roleDecisions: 'provisional-until-final-approval',
          });
          const review = yield* requestAutomaticMemoryDraft(f.config, input, generator).pipe(
            Effect.provideService(LocalModelStore, installed),
          );
          expect(review.maintenance?.generation).toMatchObject({origin: 'model', attempts: 1});
          expect(review.maintenance?.version).toBe(3);
          expect(calls).toBe(1);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
          expect(
            Result.isFailure(
              yield* requestAutomaticMemoryDraft(f.config, input, generator).pipe(
                Effect.provideService(LocalModelStore, installed),
                Effect.result,
              ),
            ),
          ).toBe(true);
          expect(calls).toBe(1);
          const rejected = yield* f.review({action: 'reject', reviewId: review.reviewId, revision: review.revision});
          expect(rejected.structuredContent.state).toBe('rejected');
          expect(
            Result.isFailure(
              yield* requestAutomaticMemoryDraft(f.config, input, generator).pipe(
                Effect.provideService(LocalModelStore, installed),
                Effect.result,
              ),
            ),
          ).toBe(true);
          expect(calls).toBe(1);
          const source = yield* f.fs.readFileString(f.sourcePath);
          yield* f.fs.writeFileString(
            f.sourcePath,
            Effect2.pipe(source, EffectString.replace('60 seconds', '90 seconds')),
          );
          const refreshed = yield* requestAutomaticMemoryDraft(f.config, input, generator).pipe(
            Effect.provideService(LocalModelStore, installed),
          );
          expect(refreshed.candidates[0].state).toBe('pending');
          expect(refreshed.candidates[0].proposedText).toBe('The timeout is 90 seconds.');
          expect(calls).toBe(2);
          const ordinary = yield* preparePersonalMemoryWrite(f.config, {
            bodyText: 'An ordinary new note.',
            metadata: {...parseMemoryDocument(f.uri, f.content)!.metadata, memoryId: undefined, topic: 'new-note'},
          });
          expect(ordinary.finalMetadata.schemaVersion).toBe(10);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
  );

  for (const outcome of ['insufficient-evidence', 'policy-conflict'] as const) {
    for (const raceDecision of [false, true]) {
      effectIt.effect(
        `redrafts ${outcome} only for new evidence and preserves ${raceDecision ? 'a concurrent decision' : 'the resulting actionable review'}`,
        () =>
          Effect.gen(function* () {
            const f = yield* fixture();
            const input = {
              uri: f.uri,
              expectedContentHash: sha256HexSync(f.content),
              backend: 'local-ai' as const,
              modelId: 'gemma-4-e4b-it-q4',
            };
            const packet = yield* requestAutomaticMemoryReview(f.config, input);
            if ('reviewId' in packet) throw new Error('Expected a source packet.');
            const noUpdate = JSON.parse(draft(packet, packet.basis.body));
            noUpdate.outcome = outcome;
            noUpdate.reviewedHandles = [];
            noUpdate.paragraphDecisions = [
              {
                ordinal: 0,
                beforeHash: packet.basis.paragraphs[0].hash,
                role: 'unknown',
                support: 'unresolved',
                evidenceIds: [],
              },
            ];
            const initial = yield* requestAutomaticMemoryReview(
              f.config,
              {
                ...input,
                draftJson: JSON.stringify(noUpdate),
              },
              {
                origin: 'model',
                agent: 'local-ai',
                model: input.modelId,
                promptVersion: 'fixture',
                attempts: 1,
                usage: {status: 'unavailable'},
              },
            );
            if (!('reviewId' in initial)) throw new Error('Expected a saved assessment.');
            const catalog = yield* LocalModelCatalog;
            const manifest = yield* catalog.get(input.modelId);
            const store = yield* LocalModelStore;
            const installed = LocalModelStore.of({
              ...store,
              status: (_home, selected) =>
                Effect.succeed({
                  bytes: selected.size,
                  installed: true,
                  modelId: selected.id,
                  partialBytes: 0,
                  path: '/synthetic/model.gguf',
                  verified: true,
                }),
            });
            // The concurrent user decision belongs to the test fixture, not the provider's service contract.
            const reviewContext = yield* Effect.context<Effect.Services<ReturnType<typeof f.review>>>();
            let calls = 0;
            const generator: typeof runSelectedDraft = (_config, _backend, _model, prompt, _purpose, basis) =>
              Effect.gen(function* () {
                calls++;
                if (!basis || basis.version !== 3) throw new Error('Expected automatic basis.');
                if (raceDecision) {
                  const decision = yield* f
                    .review({
                      action: 'reject',
                      reviewId: initial.reviewId,
                      revision: initial.revision,
                    })
                    .pipe(Effect.provideContext(reviewContext));
                  expect(decision.isError).not.toBe(true);
                }
                const current = JSON.parse(Effect2.pipe(prompt, EffectString.split('\n')).at(-1)!);
                return {
                  text: JSON.stringify(
                    compactAutomaticTopicDraftFixture(
                      basis,
                      JSON.parse(
                        draft(
                          {...current, basis, reviewEvidence: current.currentSources},
                          current.currentSources[0].content,
                        ),
                      ),
                    ),
                  ),
                  backendIdentity: 'local-ai',
                  modelIdentity: input.modelId,
                  modelVersion: `${manifest.revision}:${manifest.sha256}`,
                  usage: {status: 'unavailable' as const},
                  settings: localDraftGenerationSettings(input.modelId, 'topic-maintenance'),
                };
              });
            const run = () =>
              requestAutomaticMemoryDraft(f.config, input, generator).pipe(
                Effect.provideService(LocalModelStore, installed),
                Effect.result,
              );
            expect(Result.isFailure(yield* run())).toBe(true);
            expect(calls).toBe(0);
            const changedTarget = Effect2.pipe(f.content, EffectString.replace('30 seconds', '31 seconds'));
            yield* f.fs.writeFileString(f.targetPath, changedTarget);
            expect(
              Result.isFailure(
                yield* requestAutomaticMemoryDraft(f.config, input, generator).pipe(
                  Effect.provideService(LocalModelStore, installed),
                  Effect.result,
                ),
              ),
            ).toBe(true);
            expect(calls).toBe(0);
            expect((yield* loadCandidateReview(f.home, initial.reviewId)).revision).toBe(initial.revision);
            yield* f.fs.writeFileString(f.targetPath, f.content);
            const source = yield* f.fs.readFileString(f.sourcePath);
            yield* f.fs.writeFileString(
              f.sourcePath,
              Effect2.pipe(source, EffectString.replace('60 seconds', '90 seconds')),
            );
            const result = yield* run();
            expect(calls).toBe(1);
            const saved = yield* loadCandidateReview(f.home, initial.reviewId);
            expect(saved.auditEvents.slice(0, initial.auditEvents.length)).toEqual(initial.auditEvents);
            if (raceDecision) {
              expect(Result.isFailure(result)).toBe(true);
              expect(saved.candidates[0].state).toBe('rejected');
              expect(saved.maintenance?.proposal.draft.outcome).toBe(outcome);
            } else {
              expect(Result.isSuccess(result)).toBe(true);
              expect(saved.revision).toBe(initial.revision + 1);
              expect(saved.maintenance?.proposal.draft.outcome).toBe('propose-update');
              expect(saved.candidates[0].proposedText).toBe('The timeout is 90 seconds.');
              expect(saved.maintenanceApproval).toBeUndefined();
              // Explicit human preview takes ownership before the next source change.
              const preview = yield* f.review({action: 'preview', reviewId: saved.reviewId, revision: saved.revision});
              expect(preview.isError).not.toBe(true);
              const owned = yield* loadCandidateReview(f.home, saved.reviewId);
              yield* f.fs.writeFileString(
                f.sourcePath,
                Effect2.pipe(source, EffectString.replace('60 seconds', '120 seconds')),
              );
              expect(Result.isFailure(yield* run())).toBe(true);
              expect(calls).toBe(1);
              expect((yield* loadCandidateReview(f.home, initial.reviewId)).revision).toBe(owned.revision);
            }
            expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
          }).pipe(provideTestLayer(ApplicationLayer)),
      );
    }
  }

  effectIt.effect(
    'manual preview keeps a complete body larger than the model limit and supports another manual edit',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const packet = yield* f.review({
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(f.content),
          });
          const p = (yield* f.review({
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(f.content),
            draftJson: draft(packet.structuredContent, 'The timeout is one minute.'),
          })).structuredContent;
          yield* applyTopicMaintenanceReview(f.config, {
            reviewId: p.reviewId,
            revision: p.revision,
            approvalDigest: p.approval.approvalDigest,
            approved: true,
          });
          const large = Effect2.pipe('User-authored sentence. ', EffectString.repeat(1800));
          const before = yield* f.fs.readFileString(f.targetPath);
          const manual = (yield* f.review({
            action: 'manual-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(before),
            desiredBody: large,
          })).structuredContent;
          expect(manual.proposal.body).toBe(Effect2.pipe(large, EffectString.trim));
          const revised = (yield* f.review({
            action: 'manual-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(before),
            desiredBody: large,
            reviewId: manual.reviewId,
            revision: manual.revision,
          })).structuredContent;
          expect(revised.revision).toBeGreaterThan(manual.revision);
          expect(
            Result.isFailure(
              yield* applyTopicMaintenanceReview(f.config, {
                reviewId: manual.reviewId,
                revision: manual.revision,
                approvalDigest: manual.approval.approvalDigest,
                approved: true,
              }).pipe(Effect.result),
            ),
          ).toBe(true);
          yield* applyTopicMaintenanceReview(f.config, {
            reviewId: revised.reviewId,
            revision: revised.revision,
            approvalDigest: revised.approval.approvalDigest,
            approved: true,
          });
          const saved = yield* f.fs.readFileString(f.targetPath);
          expect(parseMemoryDocument(f.uri, saved)!.body).toBe(Effect2.pipe(large, EffectString.trim));
          const next = yield* f.review({
            action: 'manual-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(saved),
            desiredBody: large + 'Another sentence.',
          });
          expect(next.isError).not.toBe(true);
          expect(next.structuredContent.proposal.body).toBe(large + 'Another sentence.');
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('missing ID remains an explicit capability limit, with no accepted mutation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const body = Effect2.pipe(f.content, EffectString.replace(/^memory_id:.*\n/mu, ''));
        yield* f.fs.writeFileString(f.targetPath, body);
        const packet = yield* f.review({
          action: 'automatic-preview',
          uri: f.uri,
          expectedContentHash: sha256HexSync(body),
        });
        expect(packet.isError).not.toBe(true);
        expect(packet.structuredContent.capabilities.reasons).toContain('missing-id');
        expect(packet.structuredContent.capabilities.draft).toBe(false);
        expect(packet.structuredContent.draftRequest.available).toBe(false);
        expect(yield* f.fs.readFileString(f.targetPath)).toBe(body);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('bounded duplicate-paragraph replacements preserve every other ordinal and never mutate their basis', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('red', 'blue', 'green', 'orange'), {minLength: 1, maxLength: 20}), words => {
        const text = EffectArray.join(words, ' ') + '.';
        const uri = 'threadnote://user/tester/memories/durable/projects/fixture/target.md';
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/fixture/source.md';
        const metadata = {
          kind: 'durable' as const,
          status: 'active' as const,
          schemaVersion: 10,
          memoryId: 'tn_target',
          project: 'fixture',
          topic: 'target',
          sourceAgentClient: 'test',
          timestamp: '2026-10-21T00:00:00.000Z',
        };
        const record = parseMemoryDocument(
          uri,
          formatMemoryDocument('MEMORY', metadata, 'Duplicate.\n\nDuplicate.\n\nProtected.'),
        )!;
        const source = parseMemoryDocument(
          sourceUri,
          formatMemoryDocument('MEMORY', {...metadata, memoryId: 'tn_source'}, text),
        )!;
        const prepared = prepareAutomaticMemory(record, {
          sources: [source],
          scopeRevision: Effect2.pipe('a', EffectString.repeat(64)),
        });
        const packet = automaticReviewPacket(record, prepared);
        const snapshot = JSON.stringify(packet);
        const h = packet.reviewEvidence[0];
        const raw = {
          version: 2,
          kind: 'automatic',
          purpose: 'automatic',
          targetHash: packet.basis.targetHash,
          observationRevision: packet.basis.observationRevision,
          packetDigest: packet.basis.packetDigest,
          outcome: 'propose-update',
          operations: [
            {
              ordinal: 1,
              beforeHash: sha256HexSync('Duplicate.'),
              text,
              supportHandles: [h.handleId],
              rationale: 'Exact second paragraph only.',
            },
          ],
          reviewedHandles: [h.handleId],
          rationale: 'Review.',
          unresolvedQuestions: [],
          removedClaims: [],
          paragraphDecisions: EffectArray.map(packet.basis.paragraphs, (paragraph, ordinal) => ({
            ordinal,
            beforeHash: paragraph.hash,
            role: ordinal === 1 ? 'descriptive' : 'unknown',
            support: ordinal === 1 ? 'direct' : 'unresolved',
            evidenceIds: ordinal === 1 ? [h.descriptor.id] : [],
          })),
        };
        const proposal = parseAutomaticMaintenanceDraft(packet.basis, JSON.stringify(raw));
        expect(Effect2.pipe(proposal.body, EffectString.split('\n\n'))).toEqual(['Duplicate.', text, 'Protected.']);
        expect(proposal.changedOrdinals).toEqual([1]);
        expect(JSON.stringify(packet)).toBe(snapshot);
      }),
      {numRuns: 30},
    );
  });

  effectIt.effect(
    'unenrolled related-supported memory previews, applies exactly once, survives cache loss and manual editing',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const packet = yield* f.review({
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(f.content),
          });
          expect(packet.isError).not.toBe(true);
          expect(packet.structuredContent.basis.assessment.preparation.kind).toBe('derived');
          expect(packet.structuredContent.basis.paragraphs[0].role).toBe('unknown');
          const previewed = yield* f.review({
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(f.content),
            draftJson: draft(packet.structuredContent, 'The timeout is 60 seconds.'),
          });
          expect(previewed.isError).not.toBe(true);
          const preview = previewed.structuredContent;
          expect(preview.approval.content).toContain('schema_version: 11');
          expect(preview.approval.reviewedSupport.active.paragraphs[0]).toMatchObject({
            role: 'descriptive',
            support: 'direct',
          });
          expect(preview.approval.content).not.toContain('topic_maintenance:');
          expect(preview.approval.content).not.toContain('consolidation:');
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
          yield* TestClock.adjust('1 hour');
          const apply = () =>
            f.review({
              action: 'apply',
              reviewId: preview.reviewId,
              revision: preview.revision,
              approvalDigest: preview.approval.approvalDigest,
              approved: true,
            });
          const applied = yield* apply();
          expect(applied.isError).not.toBe(true);
          expect(applied.structuredContent.state).toBe('applied');
          const generation = yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local');
          expect((yield* apply()).isError).not.toBe(true);
          expect(yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local')).toBe(generation);
          const accepted = yield* f.fs.readFileString(f.targetPath);
          expect(accepted).toBe(preview.approval.content);
          expect(parseMemoryDocument(f.uri, accepted)!.metadata.reviewedSupport!.active.acceptance.approvedAt).toBe(
            preview.approval.reviewedSupport.active.acceptance.approvedAt,
          );
          yield* f.fs.remove(f.path.join(f.home, 'context-maintenance/automatic'), {recursive: true, force: true});
          const current = parseMemoryDocument(f.uri, accepted)!;
          const rebuilt = prepareMemoryMaintenanceBasis(current).assessment;
          expect(rebuilt.preparation.kind).toBe('reviewed-support');
          expect(rebuilt.paragraphs[0]).toMatchObject({
            role: 'descriptive',
            support: 'direct',
            roleAuthority: 'reviewed',
          });
          const fresh = yield* fixture();
          yield* fresh.fs.writeFileString(fresh.targetPath, accepted);
          yield* fresh.fs.writeFileString(fresh.sourcePath, yield* f.fs.readFileString(f.sourcePath));
          const revalidated = yield* readLiveAutomaticPreparation(fresh.config, fresh.uri);
          expect(revalidated.record.metadata.reviewedSupport).toEqual(current.metadata.reviewedSupport);
          expect(revalidated.prepared.assessment.paragraphs[0]).toMatchObject({
            role: 'descriptive',
            support: 'direct',
            currentSupport: 'direct',
            roleAuthority: 'reviewed',
          });
          const manual = yield* f.review({
            action: 'manual-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(accepted),
            desiredBody: 'User-authored unsupported text.',
          });
          expect(manual.isError).not.toBe(true);
          expect(manual.structuredContent.proposal.draft.operations).toEqual([]);
          expect(manual.structuredContent.approval.reviewedSupport.active.paragraphs[0]).toMatchObject({
            role: 'unknown',
            support: 'unresolved',
            evidenceIds: [],
          });
          expect(manual.structuredContent.approval.reviewedSupport.initialApproval).toEqual(
            current.metadata.reviewedSupport!.active,
          );
          const saved = yield* f.review({
            action: 'apply',
            reviewId: manual.structuredContent.reviewId,
            revision: manual.structuredContent.revision,
            approvalDigest: manual.structuredContent.approval.approvalDigest,
            approved: true,
          });
          expect(saved.isError).not.toBe(true);
          expect(parseMemoryDocument(f.uri, yield* f.fs.readFileString(f.targetPath))!.body).toBe(
            'User-authored unsupported text.',
          );
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
  );

  for (const kind of ['durable', 'smoke', 'incident', 'handoff', 'preference'] as const)
    effectIt.effect(`supports exact no-text approval for ${kind} while preserving protected roles`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture(kind);
          const packet = yield* requestAutomaticMemoryReview(f.config, {
            uri: f.uri,
            expectedContentHash: sha256HexSync(f.content),
          });
          if ('reviewId' in packet) throw new Error('expected packet');
          const role =
            kind === 'incident' || kind === 'handoff'
              ? 'historical'
              : kind === 'preference'
                ? 'normative'
                : 'descriptive';
          const preview = yield* f.review({
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(f.content),
            draftJson: draft(packet, packet.basis.body, role),
          });
          expect(preview.isError).not.toBe(true);
          const p = preview.structuredContent;
          const applied = yield* f.review({
            action: 'apply',
            reviewId: p.reviewId,
            revision: p.revision,
            approvalDigest: p.approval.approvalDigest,
            approved: true,
          });
          expect(applied.isError).not.toBe(true);
          const record = parseMemoryDocument(f.uri, yield* f.fs.readFileString(f.targetPath))!;
          expect(record.metadata.kind).toBe(kind);
          expect(record.metadata.relations).toEqual(parseMemoryDocument(f.uri, f.content)!.metadata.relations);
          expect(record.body).toBe(packet.basis.body);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    );

  effectIt.effect(
    'source drift refuses approval and a postwrite journal fault recovers with one mutation and one apply audit',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const packet = yield* f.review({
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(f.content),
          });
          const previewed = yield* f.review({
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: sha256HexSync(f.content),
            draftJson: draft(packet.structuredContent, 'The timeout is 60 seconds.'),
          });
          const p = previewed.structuredContent;
          const input = {
            reviewId: p.reviewId,
            revision: p.revision,
            approvalDigest: p.approval.approvalDigest,
            approved: true,
          };
          const source = yield* f.fs.readFileString(f.sourcePath);
          yield* f.fs.writeFileString(
            f.sourcePath,
            Effect2.pipe(source, EffectString.replace('60 seconds', '90 seconds')),
          );
          expect(Result.isFailure(yield* applyTopicMaintenanceReview(f.config, input).pipe(Effect.result))).toBe(true);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
          yield* f.fs.writeFileString(f.sourcePath, source);
          const readFault = {
            ...f.fs,
            readFileString: (file: string) =>
              f.fs.readFileString(file).pipe(
                Effect.filterOrElse(
                  content => file !== f.targetPath || content !== p.approval.content,
                  () => f.fs.readFileString(f.home),
                ),
              ),
          };
          expect(
            Result.isFailure(
              yield* applyTopicMaintenanceReview(f.config, input).pipe(
                Effect.provideService(FileSystem.FileSystem, readFault),
                Effect.result,
              ),
            ),
          ).toBe(true);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(p.approval.content);
          expect((yield* loadCandidateReview(f.home, p.reviewId)).maintenanceApproval?.stage).toBe('prepared');
          const writtenGeneration = yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local');
          let failed = false;
          const faulty = {
            ...f.fs,
            rename: (from: string, to: string) =>
              Effect.gen(function* () {
                if (
                  !failed &&
                  Effect2.pipe(to, EffectString.endsWith(`${p.reviewId}.json`)) &&
                  Effect2.pipe(yield* f.fs.readFileString(f.targetPath), EffectString.includes('reviewed_support:'))
                ) {
                  failed = true;
                  return yield* f.fs.rename(`${from}.missing`, to);
                }
                return yield* f.fs.rename(from, to);
              }),
          };
          expect(
            Result.isFailure(
              yield* applyTopicMaintenanceReview(f.config, input).pipe(
                Effect.provideService(FileSystem.FileSystem, faulty),
                Effect.result,
              ),
            ),
          ).toBe(true);
          expect(failed).toBe(true);
          expect(yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local')).toBe(writtenGeneration);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(p.approval.content);
          const generation = yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local');
          yield* f.fs.remove(f.path.join(f.home, 'context-maintenance/automatic'), {recursive: true, force: true});
          const retry = yield* applyTopicMaintenanceReview(f.config, input);
          expect(retry.candidates[0].state).toBe('applied');
          expect(yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local')).toBe(generation);
          expect(
            EffectArrayPipe((yield* loadCandidateReview(f.home, p.reviewId)).auditEvents, __effectArrayValues =>
              EffectArray.filter(
                __effectArrayValues,
                (event, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && event.action === 'apply',
              ),
            ),
          ).toHaveLength(1);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
