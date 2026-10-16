import {Console, DateTime, Effect, FileSystem, Path} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CommandExecutor} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {parseResourceId, validatePortableSegment} from '@threadnote/store/resource-id';
import {canonicalMemoryDocumentContent, parseMemoryDocument} from '@threadnote/memory/document';
import {
  loadCandidateReviewOptional,
  saveCandidateReview,
  withCandidateReviewLock,
  type CandidateReview,
} from '@threadnote/memory/candidate';
import {
  parseTopicMaintenanceDraft,
  validateTopicMaintenanceReviewPayload,
} from '@threadnote/memory/topic-maintenance-draft';
import {prepareTopicMaintenanceAcceptance} from '@threadnote/memory/topic-maintenance-acceptance';
import {
  buildTopicMaintenanceEvidencePacket,
  observeTopicMaintenanceEvidence,
} from '@threadnote/context/topic_maintenance';
import {MemoryOperationError} from '../memory/migrations.js';
import {sharedDurablePath} from './knowledge_delta.js';
import {
  basisFromPacket,
  privateReview,
  readyEvidence,
  reviewEvidenceFromPacket,
} from '../memory/context/maintenance_draft.js';
import {prepareTopicMaintenanceReview} from '../memory/context/maintenance_review.js';
import {verifyTopicMaintenanceReviewSource} from '../memory/context/maintenance_review_source.js';
import {readContextMaintenanceSourceEpoch} from '../memory/context/maintenance_evidence.js';
import {assertShareTeamWritable, resolveTeam, shareTeamAccess, sharedMemoryUriParts} from '../share/core.js';
import {buildTopicMaintenanceGitProposal, type TopicMaintenanceGitProposalV2} from './topic_maintenance_proposal.js';

export interface SharedTopicProposalOptions {
  readonly uri: string;
  readonly sourceCwd: string;
  readonly draftFile?: string;
  readonly draftJson?: string;
  readonly reviewId?: string;
  readonly revision?: number;
  readonly team?: string;
}

/** Resolve the accepted shared Git file, never a personal projection or cached accepted copy. */
export const readSharedTopicGitBaseline = Effect.fn('gitProposal.readSharedTopicBaseline')(function* (
  config: RuntimeConfig,
  uri: string,
  requestedTeam?: string,
) {
  const parts = sharedMemoryUriParts(config, uri);
  const resource = yield* Effect.try({
    try: () => parseResourceId(uri),
    catch: () => fail('Invalid shared topic URI.'),
  });
  if (
    !parts?.project ||
    !parts.topic ||
    parts.kind !== 'durable' ||
    resource.canonicalUri !== uri ||
    resource.anchor !== undefined
  )
    return yield* fail('Select an exact existing shared durable project/topic URI.');
  const project = yield* Effect.try({
    try: () => validatePortableSegment(decodeURIComponent(parts.project!)),
    catch: () => fail('Invalid shared project.'),
  });
  const topic = yield* Effect.try({
    try: () => validatePortableSegment(decodeURIComponent(parts.topic!)),
    catch: () => fail('Invalid shared topic.'),
  });
  const team = yield* resolveTeam(config, requestedTeam ?? decodeURIComponent(parts.team));
  if (team.name !== decodeURIComponent(parts.team))
    return yield* fail('Shared topic team does not match the selected team.');
  yield* Effect.try({
    try: () => assertShareTeamWritable(team, 'propose reviewed topic maintenance'),
    catch: cause => fail(String(cause)),
  });
  const repository = yield* resolveRepositoryIdentity(team.config.worktree);
  if (!repository.remoteIdentity || /^0+$/u.test(repository.headCommit))
    return yield* fail('Shared proposals require a committed Git base with a portable remote identity.');
  const path = sharedDurablePath(project, topic);
  const command = yield* CommandExecutor;
  const read = (args: readonly string[]) =>
    command.execute('git', ['--no-optional-locks', ...args], {
      cwd: team.config.worktree,
      timeoutMs: 30_000,
      maxOutputBytes: 512 * 1024,
    });
  if ((yield* read(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])).stdout.trim())
    return yield* fail('Shared Git worktree must be clean before topic proposal review.');
  const treeEntry = (yield* read(['ls-tree', repository.headCommit, '--', path])).stdout;
  if (!treeEntry.startsWith('100644 blob ')) return yield* fail('Shared topic must be an existing regular Git file.');
  const rawContent = (yield* read(['show', `${repository.headCommit}:${path}`])).stdout;
  const record = parseMemoryDocument(uri, rawContent);
  if (
    !record ||
    record.headerTitle !== 'MEMORY' ||
    record.metadata.kind !== 'durable' ||
    record.metadata.status !== 'active' ||
    record.metadata.visibility !== 'shared' ||
    record.metadata.project !== project ||
    record.metadata.topic !== topic ||
    !record.metadata.memoryId ||
    !record.metadata.topicMaintenance ||
    record.metadata.topicMaintenanceError
  )
    return yield* fail(
      'Shared topic must already have valid enrolled identity and provenance. Live shared enrollment remains gated.',
    );
  return {team, repository, path, record, rawContent};
});

/** Manual author proposal uses the existing private review, with an honest zero-model-call receipt. */
export const proposeSharedTopicMaintenance = Effect.fn('gitProposal.proposeSharedTopic')(function* (
  config: RuntimeConfig,
  input: SharedTopicProposalOptions,
) {
  if (!(yield* Path.Path).isAbsolute(input.sourceCwd)) return yield* fail('Topic sourceCwd must be absolute.');
  if (input.draftFile && input.draftJson) return yield* fail('Choose draftFile or draftJson, not both.');
  const baseline = yield* readSharedTopicGitBaseline(config, input.uri, input.team);
  const openingEpoch = yield* readContextMaintenanceSourceEpoch(config, input.sourceCwd);
  const observed = yield* observeTopicMaintenanceEvidence(config, baseline.record, input.sourceCwd);
  const built = yield* buildTopicMaintenanceEvidencePacket(config, baseline.record, input.sourceCwd, observed);
  const packet = yield* Effect.try({
    try: () => readyEvidence({topicEvidence: built} as Parameters<typeof readyEvidence>[0]),
    catch: cause => fail(String(cause)),
  });
  const basis = yield* Effect.try({try: () => basisFromPacket(packet), catch: cause => fail(String(cause))});
  if ((yield* readContextMaintenanceSourceEpoch(config, input.sourceCwd)) !== openingEpoch)
    return yield* fail('Topic source changed while preparing the manual proposal packet.');
  if (!input.draftFile && input.draftJson === undefined)
    return {origin: 'manual' as const, modelCalls: 0, basis, packet};
  const json = input.draftJson ?? (yield* (yield* FileSystem.FileSystem).readFileString(input.draftFile!));
  const payload = yield* Effect.try({
    try: () =>
      validateTopicMaintenanceReviewPayload({
        version: 1,
        basis,
        proposal: parseTopicMaintenanceDraft(basis, json),
        reviewEvidence: reviewEvidenceFromPacket(packet),
        generation: {
          origin: 'manual',
          agent: 'manual',
          model: 'none',
          promptVersion: 'manual-topic-v1',
          attempts: 0,
          usage: {status: 'unavailable'},
        },
      }),
    catch: cause => fail(cause instanceof Error ? cause.message : 'Invalid canonical manual draft.'),
  });
  const reviewId = `review-${sha256HexSync(`topic-maintenance\0${input.uri}`).slice(0, 24)}`;
  const review = yield* withCandidateReviewLock(
    config.agentContextHome,
    reviewId,
    Effect.gen(function* () {
      const prior = yield* loadCandidateReviewOptional(config.agentContextHome, reviewId);
      if (prior && (input.reviewId !== reviewId || input.revision !== prior.revision))
        return yield* fail(
          'The shared topic already has a private review. Echo its exact reviewId and revision to edit it.',
        );
      if (!prior && (input.reviewId !== undefined || input.revision !== undefined))
        return yield* fail('The requested shared topic review is missing.');
      if (prior && (!prior.maintenance || prior.candidates[0]?.state !== 'pending'))
        return yield* fail('Resolve or resume the existing private topic review before proposing an edit.');
      const latest = yield* readSharedTopicGitBaseline(config, input.uri, input.team);
      if (canonicalJson(baselineKey(latest)) !== canonicalJson(baselineKey(baseline)))
        return yield* fail('Shared Git base, target or policy changed during manual proposal preparation.');
      yield* verifyTopicMaintenanceReviewSource(config, latest.record, payload, input.sourceCwd);
      const at = DateTime.formatIso(yield* DateTime.now);
      const next = privateReview(
        prior,
        basis,
        payload,
        baseline.record.metadata.project!,
        baseline.record.metadata.topic!,
        ['Explicit manual author proposal; zero model calls.'],
        at,
      );
      yield* saveCandidateReview(config.agentContextHome, next);
      return next;
    }),
  );
  const prepared = yield* prepareTopicMaintenanceReview(
    config,
    {reviewId, revision: review.revision, sourceCwd: input.sourceCwd},
    baseline.record,
  );
  const closing = yield* readSharedTopicGitBaseline(config, input.uri, input.team);
  if (canonicalJson(baselineKey(closing)) !== canonicalJson(baselineKey(baseline)))
    return yield* fail('Shared Git base, target or policy changed during approval preview.');
  yield* verifyTopicMaintenanceReviewSource(config, closing.record, prepared.maintenance!, input.sourceCwd);
  return {origin: 'manual' as const, modelCalls: 0, review: prepared};
});

export const runSharedTopicProposal = Effect.fn('gitProposal.sharedTopicCommand')(function* (
  config: RuntimeConfig,
  input: SharedTopicProposalOptions,
) {
  yield* Console.log(JSON.stringify(yield* proposeSharedTopicMaintenance(config, input)));
});

/** Caller holds the existing review lock. Preview and approved export use the same exact assembly. */
export const buildReviewedTopicMaintenanceGitProposal = Effect.fn('gitProposal.buildReviewedTopic')(function* (
  config: RuntimeConfig,
  review: CandidateReview,
  options: {
    readonly team?: string;
    readonly sourceCwd?: string;
    readonly approved?: boolean;
    readonly approvalDigest?: string;
    readonly candidateIds: readonly string[];
  },
) {
  if (
    !review.maintenance ||
    review.maintenanceApproval?.stage !== 'preview' ||
    review.maintenanceApproval.reviewRevision !== review.revision ||
    !options.sourceCwd
  )
    return yield* fail(
      'Prepare the exact shared topic review and provide sourceCwd before Git proposal preview/export.',
    );
  if (
    options.candidateIds.length > 1 ||
    (options.candidateIds.length === 1 && options.candidateIds[0] !== review.candidates[0]?.candidateId)
  )
    return yield* fail('Select only the exact shared maintenance candidate.');
  const baseline = yield* readSharedTopicGitBaseline(config, review.maintenance.basis.targetUri, options.team);
  yield* verifyTopicMaintenanceReviewSource(config, baseline.record, review.maintenance, options.sourceCwd);
  const preview = review.maintenanceApproval.preview;
  const reproduced = yield* Effect.try({
    try: () =>
      prepareTopicMaintenanceAcceptance(baseline.record, review.maintenance!, {
        reviewId: review.reviewId,
        approvedAt: preview.approvedAt,
        editedDraftJson: JSON.stringify(preview.approvedProposal.draft),
      }),
    catch: cause => fail(cause instanceof Error ? cause.message : 'The exact shared document cannot be reproduced.'),
  });
  if (canonicalJson(reproduced) !== canonicalJson(preview))
    return yield* fail('The stored shared approval differs from the exact reviewed transformation.');
  const built = yield* Effect.try({
    try: () =>
      buildTopicMaintenanceGitProposal({
        baseCommit: baseline.repository.headCommit,
        baseBranch: baseline.repository.branch ?? null,
        target: {repositoryId: baseline.repository.repositoryId, team: baseline.team.name},
        path: baseline.path,
        record: baseline.record,
        rawContent: baseline.rawContent,
        review,
        prepared: reproduced,
        access: 'read-write',
      }),
    catch: cause => fail(cause instanceof Error ? cause.message : 'Invalid shared topic proposal.'),
  });
  const closing = yield* readSharedTopicGitBaseline(config, review.maintenance.basis.targetUri, options.team);
  if (canonicalJson(baselineKey(closing)) !== canonicalJson(baselineKey(baseline)))
    return yield* fail('Shared Git base, target or policy changed during proposal export.');
  yield* verifyTopicMaintenanceReviewSource(config, closing.record, review.maintenance, options.sourceCwd);
  if (options.approved === true && options.approvalDigest !== built.proposal.proposalHash)
    return yield* fail(
      'Shared maintenance export requires the exact preview proposalHash as approvalDigest. Review the complete Git artifact again.',
    );
  return built;
});

export const verifyTopicMaintenanceMaterialization = Effect.fn('gitProposal.verifyTopicMaterialization')(function* (
  config: RuntimeConfig,
  proposal: TopicMaintenanceGitProposalV2,
  options: {readonly sourceCwd?: string; readonly team?: string},
) {
  const review = yield* loadCandidateReviewOptional(config.agentContextHome, proposal.knowledgeDelta.reviewId);
  if (!review || review.revision !== proposal.knowledgeDelta.expectedRevision)
    return yield* fail('Shared maintenance private review is missing or its revision changed.');
  const built = yield* buildReviewedTopicMaintenanceGitProposal(config, review, {
    ...options,
    candidateIds: [proposal.files[0].approval.candidateId],
  });
  if (canonicalJson(built.proposal) !== canonicalJson(proposal))
    return yield* fail(
      'Shared maintenance Git base, approval, target, source or policy changed. Prepare a new preview.',
    );
});

function baselineKey(baseline: Effect.Success<ReturnType<typeof readSharedTopicGitBaseline>>) {
  return {
    commit: baseline.repository.headCommit,
    branch: baseline.repository.branch ?? null,
    repositoryId: baseline.repository.repositoryId,
    path: baseline.path,
    rawHash: sha256HexSync(baseline.rawContent),
    canonicalHash: sha256HexSync(canonicalMemoryDocumentContent(baseline.rawContent)),
    team: baseline.team.name,
    access: shareTeamAccess(baseline.team.config),
  };
}

function fail(message: string) {
  return MemoryOperationError.make({message});
}
