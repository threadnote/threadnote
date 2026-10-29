import {Array as EffectArray, Option as EffectOption} from 'effect';
import {DateTime, Effect, Schema} from 'effect';
import {agentAdapterStatus} from '../../agent_integration/adapter_actions.js';
import type {AgentAdapter} from '../../agent_integration/adapters.js';
import {readAgentIntegrationRegistry} from '../../agent_integration/registry.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {KnowledgeDeltaGitProposalBuildV1} from '../../git_proposal/knowledge_delta.js';
import {
  buildExactDurableCandidateReview,
  listCandidateReviews,
  isMemoryCandidate,
  readActiveProjectMemories,
  saveCandidateReview,
  withCandidateReviewLock,
  type CandidateReview,
  type MemoryCandidate,
} from '@threadnote/memory/candidate';
import {canonicalMemoryDocumentContent, isSharedMemoryUri, type MemoryRecord} from '@threadnote/memory/document';
import {isMemoryId} from '@threadnote/memory/identity-alias';
import {projectKnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import {readMemoryWithRelocations} from '@threadnote/memory/relocation';
import {readTeamsFile, shareTeamAccess, sharedUriFor} from '../../share/core.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ActivationOperationExecutionV1} from '../commands.js';
import type {SecondSurfaceSnapshotV1} from '../second/surface.js';
import type {ActivationProductionObservationV1} from './observe.js';
import {ActivationProductionError, activationProductionError} from './observe.js';
import type {ActivationProposalEvidenceInputV1, ActivationProposalEvidenceV1} from './proposal_store.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface CurrentActivationSurfaceV1 {
  readonly evidenceHash: string;
  readonly snapshot: SecondSurfaceSnapshotV1;
}

export interface CurrentActivationTeamV1 {
  readonly evidenceHash: string;
  readonly repositoryId: string;
  readonly worktree: string;
}

export interface AppliedActivationDecisionV1 {
  readonly candidate: MemoryCandidate;
  readonly record: MemoryRecord;
  readonly review: CandidateReview;
}

export const observeCurrentActivationSurfaceV1 = Effect.fn('activation.production.surfaceEvidence')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
) {
  const [status, registry] = yield* Effect.all([
    agentAdapterStatus(config, adapter),
    readAgentIntegrationRegistry(config),
  ]).pipe(Effect.mapError(() => activationProductionError(`Could not observe ${adapter.catalog.id}.`)));
  const receipt = adapter.legacyClient
    ? registry?.hosts[adapter.legacyClient]
    : registry?.surfaces?.[adapter.catalog.id];
  if (status.state !== 'current' || receipt === undefined) {
    return yield* activationProductionError(`${adapter.catalog.id} is not current.`);
  }
  const installedVersion = receipt.installedVersion;
  const mcp = receipt.mcp;
  const capabilitiesFingerprint = sha256HexSync(canonicalJson(adapter.catalog.capabilities));
  const mcpConfigFingerprint = sha256HexSync(
    canonicalJson({
      name: mcp.name,
      toolset: mcp.toolset ?? 'default',
      ...(adapter.catalog.id === 'cursor-cloud-personal' ? {profile: 'cloud'} : {}),
    }),
  );
  const mcpReceiptFingerprint = sha256HexSync(canonicalJson(receipt));
  const mcpServerFingerprint = sha256HexSync(
    canonicalJson({installedVersion, protocol: 'threadnote-mcp-stdio-v1', toolset: mcp.toolset ?? 'default'}),
  );
  const snapshot = {
    access: 'local-stdio' as const,
    capabilitiesFingerprint,
    configurationState: 'current' as const,
    mcpCapability: adapter.catalog.capabilities.mcp.status,
    mcpConfigFingerprint,
    mcpReceiptFingerprint,
    mcpServerFingerprint,
    surfaceId: adapter.catalog.id,
  } satisfies SecondSurfaceSnapshotV1;
  return {
    evidenceHash: sha256HexSync(canonicalJson({snapshot, status: status.state})),
    snapshot,
  } satisfies CurrentActivationSurfaceV1;
});

export const observeCurrentActivationTeamV1 = Effect.fn('activation.production.teamEvidence')(function* (
  config: RuntimeConfig,
  teamName: string,
) {
  const teams = yield* readTeamsFile(config).pipe(
    Effect.mapError(() => activationProductionError('Configured team shares could not be read.')),
  );
  const team = teams.teams[teamName];
  if (team === undefined) return yield* activationProductionError(`Activation team ${teamName} is not configured.`);
  if (shareTeamAccess(team) !== 'read-write') {
    return yield* activationProductionError(`Activation team ${teamName} must be read-write.`);
  }
  const repository = yield* resolveRepositoryIdentity(team.worktree).pipe(
    Effect.mapError(() => activationProductionError(`Activation team ${teamName} is not a readable Git repository.`)),
  );
  return {
    evidenceHash: sha256HexSync(
      canonicalJson({access: 'read-write', repositoryId: repository.repositoryId, team: teamName}),
    ),
    repositoryId: repository.repositoryId,
    worktree: team.worktree,
  } satisfies CurrentActivationTeamV1;
});

const findOrCreateActivationDecisionReviewUnlocked = Effect.fn('activation.production.decisionReviewUnlocked')(
  function* (config: RuntimeConfig, observation: ActivationProductionObservationV1) {
    const proposedText = activationDecisionTextV1(observation);
    const reviews = yield* listCandidateReviews(config.agentContextHome);
    const matching = EffectArray.filter(
      reviews,
      review =>
        review.sourceSessionId === observation.plan.activationId &&
        review.project === observation.request.project &&
        review.topic === observation.request.topic &&
        review.task === observation.request.task,
    );
    if (matching.length > 1) {
      return yield* activationProductionError('Activation decision review identity is ambiguous.');
    }
    if (matching[0] !== undefined) {
      const candidate = onlyDecisionCandidate(matching[0]);
      if (candidate.proposedText !== proposedText) {
        return yield* activationProductionError('Activation decision review changed after it was created.');
      }
      return matching[0];
    }
    const existing = yield* readActiveProjectMemories(config, observation.request.project);
    const review = yield* buildExactDurableCandidateReview(
      {
        constraints: observation.request.decision.constraints,
        decisions: [observation.request.decision.decision],
        evidence: EffectArray.map(
          observation.imports.sources,
          source => `activation-import:${source.sourceId}:${source.contentHash}`,
        ),
        outcome: 'Activate one reviewed durable decision for cross-agent reuse.',
        knowledgeInvalidated: observation.request.decision.invalidated,
        project: observation.request.project,
        rationale: observation.request.decision.rationale,
        sourceAgentClient: observation.primaryAdapter.catalog.agentId,
        sourceSessionId: observation.plan.activationId,
        task: observation.request.task,
        topic: observation.request.topic,
        unresolvedRisks: observation.request.decision.unresolvedRisks,
        verificationPerformed: observation.request.decision.verification,
      },
      proposedText,
      existing,
      yield* DateTime.nowAsDate,
    );
    if (review.candidates.length !== 1) {
      return yield* activationProductionError('Activation decision did not produce one reviewable candidate.');
    }
    yield* saveCandidateReview(config.agentContextHome, review);
    return review;
  },
);

export const findOrCreateActivationDecisionReviewV1 = Effect.fn('activation.production.decisionReview')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  return yield* withCandidateReviewLock(
    config.agentContextHome,
    `activation-decision-${observation.plan.activationId}`,
    findOrCreateActivationDecisionReviewUnlocked(config, observation),
  );
});

const findOrCreateActivationImportReviewsUnlocked = Effect.fn('activation.production.importReviewsUnlocked')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  const existingReviews = yield* listCandidateReviews(config.agentContextHome);
  const existingMemories = yield* readActiveProjectMemories(config, observation.request.project);
  const now = yield* DateTime.nowAsDate;
  const reviews: CandidateReview[] = [];
  for (const imported of observation.imports.candidates) {
    const sourceSessionId = activationImportSourceSessionId(observation.plan.activationId, imported.candidateId);
    const matches = EffectArray.filter(existingReviews, review => review.sourceSessionId === sourceSessionId);
    if (matches.length > 1) {
      return yield* activationProductionError(`Activation import ${imported.candidateId} is ambiguous.`);
    }
    if (matches[0] !== undefined) {
      if (onlyDecisionCandidate(matches[0]).proposedText !== imported.proposedText) {
        return yield* activationProductionError(`Activation import ${imported.candidateId} changed after review.`);
      }
      reviews.push(matches[0]);
      continue;
    }
    const review = yield* buildExactDurableCandidateReview(
      {
        evidence: EffectArray.map(imported.sourceIds, sourceId => `activation-import:${sourceId}`),
        outcome: 'Imported repository guidance or ADR requires explicit candidate apply before it becomes memory.',
        project: observation.request.project,
        sourceAgentClient: observation.primaryAdapter.catalog.agentId,
        sourceSessionId,
        task: `activation-import:${imported.candidateId}`,
        topic: `activation-import-${Effect2.pipe(imported.candidateId, EffectString.slice(-24))}`,
      },
      imported.proposedText,
      existingMemories,
      now,
    );
    onlyDecisionCandidate(review);
    yield* saveCandidateReview(config.agentContextHome, review);
    reviews.push(review);
  }
  return reviews;
});

export const findOrCreateActivationImportReviewsV1 = Effect.fn('activation.production.importReviews')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  return yield* withCandidateReviewLock(
    config.agentContextHome,
    `activation-imports-${observation.plan.activationId}`,
    findOrCreateActivationImportReviewsUnlocked(config, observation),
  );
});

export const loadActivationImportReviewsV1 = Effect.fn('activation.production.loadImportReviews')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  const all = yield* listCandidateReviews(config.agentContextHome);
  const reviews: CandidateReview[] = [];
  for (const imported of observation.imports.candidates) {
    const sourceSessionId = activationImportSourceSessionId(observation.plan.activationId, imported.candidateId);
    const matches = EffectArray.filter(all, review => review.sourceSessionId === sourceSessionId);
    if (matches.length !== 1 || onlyDecisionCandidate(matches[0]).proposedText !== imported.proposedText) {
      return yield* activationProductionError(`Activation import ${imported.candidateId} review is unavailable.`);
    }
    reviews.push(matches[0]);
  }
  return reviews;
});

export const loadActivationDecisionReviewV1 = Effect.fn('activation.production.loadDecisionReview')(function* (
  config: RuntimeConfig,
  activationId: string,
) {
  const matches = EffectArray.filter(
    yield* listCandidateReviews(config.agentContextHome),
    review => review.sourceSessionId === activationId,
  );
  if (matches.length !== 1) return yield* activationProductionError('Activation decision review is unavailable.');
  onlyDecisionCandidate(matches[0]);
  return matches[0];
});

export const readAppliedActivationDecisionV1 = Effect.fn('activation.production.appliedDecision')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  const review = yield* loadActivationDecisionReviewV1(config, observation.plan.activationId);
  return yield* readAppliedReview(config, observation.request.project, review);
});

export const readAppliedActivationImportsV1 = Effect.fn('activation.production.appliedImports')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  const reviews = yield* loadActivationImportReviewsV1(config, observation);
  return yield* Effect.forEach(
    reviews,
    review => readAppliedActivationImportReviewV1(config, observation.request.project, review),
    {
      concurrency: 1,
    },
  );
});

export const readAppliedActivationImportReviewV1 = Effect.fn('activation.production.appliedImportReview')(function* (
  config: RuntimeConfig,
  project: string,
  review: CandidateReview,
) {
  const candidate = onlyDecisionCandidate(review);
  if (candidate.recommendation !== 'no_action') {
    const applied = yield* readAppliedReview(config, project, review);
    if (applied.candidate.applyOperation !== 'create') {
      return yield* activationProductionError('Activation imports must be applied as creates or verified no-actions.');
    }
    return applied;
  }
  if (
    candidate.state !== 'applied' ||
    candidate.applyTargetUri !== undefined ||
    candidate.targetUri === undefined ||
    candidate.targetContentHash === undefined
  ) {
    return yield* activationProductionError('Activation import no-action evidence is incomplete.');
  }
  const resolved = yield* readMemoryWithRelocations(config, candidate.targetUri).pipe(
    Effect.mapError(() => activationProductionError('Activation import no-action target is not readable.')),
  );
  const records = yield* readActiveProjectMemories(config, project);
  const matches = EffectArray.filter(records, record => record.uri === resolved.canonicalUri);
  if (matches.length !== 1) {
    return yield* activationProductionError('Activation import no-action target is not unique.');
  }
  const record = matches[0];
  if (sha256HexSync(canonicalMemoryDocumentContent(record.content)) !== candidate.targetContentHash) {
    return yield* activationProductionError('Activation import no-action target changed after review.');
  }
  return {candidate, record, review} satisfies AppliedActivationDecisionV1;
});

const readAppliedReview = Effect.fn('activation.production.appliedReview')(function* (
  config: RuntimeConfig,
  project: string,
  review: CandidateReview,
) {
  const candidate = onlyDecisionCandidate(review);
  if (candidate.state !== 'applied' || candidate.applyTargetUri === undefined) {
    return yield* activationProductionError('Activation candidate has not been applied.');
  }
  const resolved = yield* readMemoryWithRelocations(config, candidate.applyTargetUri).pipe(
    Effect.mapError(() => activationProductionError('Applied activation candidate is not readable.')),
  );
  const records = yield* readActiveProjectMemories(config, project);
  const matches = EffectArray.filter(records, record => record.uri === resolved.canonicalUri);
  if (matches.length !== 1) return yield* activationProductionError('Applied activation candidate is not unique.');
  const record = matches[0];
  assertAppliedActivationRecord(candidate, record);
  return {candidate, record, review} satisfies AppliedActivationDecisionV1;
});

export const readPublishedActivationDecisionV1 = Effect.fn('activation.production.publishedDecision')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  const review = yield* loadActivationDecisionReviewV1(config, observation.plan.activationId);
  const candidate = onlyDecisionCandidate(review);
  if (candidate.state !== 'applied' || candidate.applyTargetUri === undefined) {
    return yield* activationProductionError('Activation decision has not been applied.');
  }
  yield* readAppliedReview(config, observation.request.project, review);
  const expectedUri = sharedUriFor(config, candidate.applyTargetUri, observation.request.team.name);
  const resolved = yield* readMemoryWithRelocations(config, expectedUri).pipe(
    Effect.mapError(() =>
      activationProductionError(
        `Shared decision is not readable at ${expectedUri}. Merge/sync the local proposal before retrying proof.`,
      ),
    ),
  );
  const records = yield* readActiveProjectMemories(config, observation.request.project);
  const matches = EffectArray.filter(records, record => record.uri === resolved.canonicalUri);
  if (matches.length !== 1) return yield* activationProductionError('Published activation decision is not unique.');
  const record = matches[0];
  assertAppliedActivationRecord(candidate, record);
  return {candidate, record, review} satisfies AppliedActivationDecisionV1;
});

export const readOptionalPublishedActivationDecisionV1 = Effect.fn('activation.production.optionalPublishedDecision')(
  function* (config: RuntimeConfig, observation: ActivationProductionObservationV1) {
    return yield* readPublishedActivationDecisionV1(config, observation).pipe(
      Effect.map(decision => ({_tag: 'Some' as const, decision})),
      Effect.catchIf(
        error =>
          Schema.is(ActivationProductionError)(error) &&
          Effect2.pipe(error.message, EffectString.startsWith('Shared decision is not readable at ')),
        () => Effect.succeed({_tag: 'None' as const}),
      ),
    );
  },
);

export function activationReviewFingerprintV1(review: CandidateReview): string {
  return sha256HexSync(canonicalJson(projectKnowledgeDeltaV1(review)));
}

export function activationImportReviewsEvidenceHashV1(
  sourceSetHash: string,
  reviews: readonly CandidateReview[],
): string {
  return sha256HexSync(
    canonicalJson({
      reviews: EffectArray.map(reviews, review => activationReviewEvidenceHashV1(review)).sort(),
      sourceSetHash,
    }),
  );
}

export function activationImportedMemoriesEvidenceHashV1(
  sourceSetHash: string,
  reviews: readonly CandidateReview[],
): string {
  const memories = EffectArray.map(reviews, review => {
    const candidate = onlyDecisionCandidate(review);
    if (candidate.recommendation === 'no_action') {
      if (
        candidate.state !== 'applied' ||
        candidate.applyTargetUri !== undefined ||
        candidate.targetContentHash === undefined ||
        candidate.targetUri === undefined
      ) {
        throw activationProductionError('Activation import review is not a verified no-action.');
      }
      return {
        candidateId: candidate.candidateId,
        contentHash: candidate.targetContentHash,
        disposition: 'preexisting' as const,
        reviewId: review.reviewId,
        revision: review.revision,
        targetUriHash: sha256HexSync(canonicalJson({targetUri: candidate.targetUri})),
      };
    }
    if (
      candidate.state !== 'applied' ||
      candidate.applyOperation !== 'create' ||
      candidate.applyContentHash === undefined ||
      candidate.applyTargetUri === undefined
    ) {
      throw activationProductionError('Activation import review is not an applied create.');
    }
    return {
      candidateId: candidate.candidateId,
      contentHash: candidate.applyContentHash,
      disposition: 'created' as const,
      reviewId: review.reviewId,
      revision: review.revision,
      targetUriHash: sha256HexSync(canonicalJson({targetUri: candidate.applyTargetUri})),
    };
  });
  return sha256HexSync(
    canonicalJson({
      memories: memories.sort((left, right) => compareText(left.candidateId, right.candidateId)),
      sourceSetHash,
    }),
  );
}

export function activationReviewEvidenceHashV1(review: CandidateReview): string {
  const candidate = onlyDecisionCandidate(review);
  return sha256HexSync(
    canonicalJson({
      candidateId: candidate.candidateId,
      comparison: candidate.comparison,
      proposedTextHash: sha256HexSync(candidate.proposedText),
      recommendation: candidate.recommendation,
      reviewId: review.reviewId,
      targetContentHash: candidate.targetContentHash ?? null,
      targetUri: candidate.targetUri ?? null,
    }),
  );
}

export function activationApprovalTokenV1(operationId: string, evidenceHash: string): string {
  return sha256HexSync(canonicalJson({evidenceHash, operationId, version: 1}));
}

export function activationPublicationApprovalTokenV1(input: {
  readonly decisionEvidenceHash: string;
  readonly mode: 'direct' | 'proposal';
  readonly operationId: string;
  readonly proposalHash?: string;
  readonly push: boolean;
  readonly teamEvidenceHash: string;
}): string {
  return activationApprovalTokenV1(
    input.operationId,
    sha256HexSync(
      canonicalJson({
        decision: input.decisionEvidenceHash,
        mode: input.mode,
        proposalHash: input.proposalHash ?? null,
        push: input.push,
        team: input.teamEvidenceHash,
      }),
    ),
  );
}

export function activationRecoveredProposalHashV1(decisionEvidenceHash: string): string {
  return sha256HexSync(canonicalJson({decisionEvidenceHash, state: 'already-published', version: 1}));
}

export function activationDecisionEvidenceHashV1(decision: AppliedActivationDecisionV1): string {
  return sha256HexSync(
    canonicalJson({
      candidateId: decision.candidate.candidateId,
      contentHash: sha256HexSync(decision.record.body),
      memoryId: decision.record.metadata.memoryId,
      reviewId: decision.review.reviewId,
      revision: decision.review.revision,
    }),
  );
}

export function activationApprovedProjectionEvidenceHashV1(decision: AppliedActivationDecisionV1): string {
  return sha256HexSync(
    canonicalJson({
      bodyHash: sha256HexSync(decision.record.body),
      candidateId: decision.candidate.candidateId,
      reviewId: decision.review.reviewId,
      revision: decision.review.revision,
    }),
  );
}

export function assertDirectActivationPublicationV1(
  applied: AppliedActivationDecisionV1,
  published: AppliedActivationDecisionV1,
): void {
  if (
    activationApprovedProjectionEvidenceHashV1(applied) !== activationApprovedProjectionEvidenceHashV1(published) ||
    applied.record.metadata.memoryId === undefined ||
    published.record.metadata.memoryId !== applied.record.metadata.memoryId
  ) {
    throw activationProductionError('Shared activation decision does not match the approved local decision.');
  }
}

export function directActivationPublicationIsCompleteV1(
  applied: AppliedActivationDecisionV1,
  published: AppliedActivationDecisionV1,
): boolean {
  assertDirectActivationPublicationV1(applied, published);
  return isSharedMemoryUri(applied.record.uri) && applied.record.uri === published.record.uri;
}

export function assertProposalActivationPublicationV1(
  evidence: ActivationProposalEvidenceV1,
  published: AppliedActivationDecisionV1,
): void {
  if (
    evidence.approvedProjectionHash !== activationApprovedProjectionEvidenceHashV1(published) ||
    published.candidate.candidateId !== evidence.candidateId ||
    published.review.reviewId !== evidence.reviewId ||
    published.review.revision !== evidence.reviewRevision ||
    published.record.metadata.memoryId !== evidence.targetMemoryId ||
    sha256HexSync(canonicalMemoryDocumentContent(published.record.content)) !== evidence.finalContentHash
  ) {
    throw activationProductionError('Merged activation proposal does not match its approved Git evidence.');
  }
}

export function assertActivationProposalEvidenceContextV1(
  observation: ActivationProductionObservationV1,
  applied: AppliedActivationDecisionV1,
  team: CurrentActivationTeamV1,
  evidence: ActivationProposalEvidenceV1,
): void {
  if (
    evidence.activationId !== observation.plan.activationId ||
    evidence.team !== observation.request.team.name ||
    evidence.repositoryId !== team.repositoryId ||
    evidence.approvedProjectionHash !== activationApprovedProjectionEvidenceHashV1(applied) ||
    evidence.candidateId !== applied.candidate.candidateId ||
    evidence.reviewId !== applied.review.reviewId ||
    evidence.reviewRevision !== applied.review.revision ||
    evidence.sourceMemoryId !== applied.record.metadata.memoryId
  ) {
    throw activationProductionError('Activation proposal evidence changed after approval.');
  }
}

export function activationProposalEvidenceInputV1(
  observation: ActivationProductionObservationV1,
  applied: AppliedActivationDecisionV1,
  team: CurrentActivationTeamV1,
  built: KnowledgeDeltaGitProposalBuildV1,
): ActivationProposalEvidenceInputV1 {
  const file = built.proposal.files[0];
  const sourceMemoryId = applied.record.metadata.memoryId;
  if (built.proposal.files.length !== 1 || file === undefined || sourceMemoryId === undefined) {
    throw activationProductionError('Activation proposal evidence is incomplete.');
  }
  return {
    activationId: observation.plan.activationId,
    approvedProjectionHash: activationApprovedProjectionEvidenceHashV1(applied),
    branchName: built.proposal.branch.name,
    candidateId: applied.candidate.candidateId,
    finalContentHash: sha256HexSync(canonicalMemoryDocumentContent(file.content)),
    operation: file.operation,
    proposalHash: built.proposal.proposalHash,
    repositoryId: team.repositoryId,
    reviewId: applied.review.reviewId,
    reviewRevision: applied.review.revision,
    sourceMemoryId,
    targetMemoryId: file.memory.id,
    targetPreconditionHash: sha256HexSync(canonicalJson(file.targetPrecondition)),
    team: observation.request.team.name,
  };
}

export function assertActivationProposalBuildEvidenceV1(
  evidence: ActivationProposalEvidenceV1,
  expected: ActivationProposalEvidenceInputV1,
): void {
  const {revision: _, type: _type, version: _version, ...actual} = evidence;
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw activationProductionError('Activation proposal plan changed after materialization.');
  }
}

export function previousPublicationReceiptHashV1(execution: ActivationOperationExecutionV1): string | undefined {
  return EffectOption.getOrUndefined(
    EffectArray.findFirst(
      execution.receipt.operations,
      operation => operation.kind === 'decision.publish' || operation.kind === 'decision.propose',
    ),
  )?.subsystemReceiptHash;
}

export function onlyDecisionCandidate(review: CandidateReview): MemoryCandidate {
  const candidate = review.candidates[0];
  if (review.candidates.length !== 1 || candidate === undefined || !isMemoryCandidate(candidate)) {
    throw activationProductionError('Activation decision review must contain exactly one fully specified candidate.');
  }
  return candidate;
}

function activationDecisionTextV1(observation: ActivationProductionObservationV1): string {
  const input = observation.request.decision;
  return EffectArray.join(
    [
      '# Decision',
      Effect2.pipe(input.decision, EffectString.trim),
      '',
      '## Rationale',
      Effect2.pipe(input.rationale, EffectString.trim),
      ...section('Constraints', input.constraints),
      ...section('Verification performed', input.verification),
      ...section('Knowledge invalidated', input.invalidated),
      ...section('Unresolved risks', input.unresolvedRisks),
    ],
    '\n',
  );
}

function activationImportSourceSessionId(activationId: string, candidateId: string): string {
  return `${activationId}:import:${candidateId}`;
}

function assertAppliedActivationRecord(candidate: MemoryCandidate, record: MemoryRecord): void {
  if (isSharedMemoryUri(record.uri)) {
    if (
      candidate.applyBodyText === undefined ||
      Effect2.pipe(record.body, EffectString.trim) !== Effect2.pipe(candidate.applyBodyText, EffectString.trim) ||
      record.metadata.candidateId !== undefined ||
      record.metadata.memoryId === undefined ||
      !isMemoryId(record.metadata.memoryId)
    ) {
      throw activationProductionError('Published activation candidate content or stable identity changed.');
    }
    return;
  }
  if (
    record.metadata.candidateId !== candidate.candidateId ||
    candidate.applyContentHash === undefined ||
    sha256HexSync(canonicalMemoryDocumentContent(record.content)) !== candidate.applyContentHash
  ) {
    throw activationProductionError('Applied activation candidate identity or content changed.');
  }
}

function section(title: string, items: readonly string[]): readonly string[] {
  return items.length === 0
    ? []
    : ['', `## ${title}`, ...EffectArray.map(items, item => `- ${Effect2.pipe(item, EffectString.trim)}`)];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
