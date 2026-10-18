import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalMemoryDocumentContent, parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import type {CandidateReview} from '@threadnote/memory/candidate';
import {projectKnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import type {TopicMaintenanceReviewPayloadV1} from '@threadnote/memory/topic-maintenance-draft';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import {
  canonicalRelations,
  expectedBranchName,
  sharedDurablePath,
  KnowledgeDeltaGitProposalError,
  verifyProposalFile,
  type KnowledgeDeltaGitProposalV1,
} from './knowledge_delta.js';

/** Existing shared-target replacement; V1 remains applied-personal publication. */
export interface TopicMaintenanceGitProposalV2 extends Omit<KnowledgeDeltaGitProposalV1, 'version'> {
  readonly version: 2;
  readonly maintenance: {
    readonly approvalDigest: string;
    readonly beforeCanonicalHash: string;
    readonly sourceVectorHash: string;
    readonly reviewHash: string;
    readonly baseBranch: string | null;
    readonly policy: {readonly version: 1; readonly access: 'read-write'; readonly hash: string};
  };
}
export type GitProposal = KnowledgeDeltaGitProposalV1 | TopicMaintenanceGitProposalV2;
export interface GitProposalBuild {
  readonly artifact: string;
  readonly proposal: GitProposal;
}

const hashPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const reviewPattern = /^review-[a-f0-9]{16,32}$/u;
const maximumArtifactBytes = 256 * 1024;

/** Hash the actual locally enforced publication policy, excluding machine paths and credentials. */
export function topicMaintenancePublicationPolicyHash(target: GitProposal['target'], path: string, access: string) {
  return sha256HexSync(canonicalJson({version: 1, access, target, path, maintenance: 1, citationPolicy: 1}));
}

/** Current observation HEAD/snapshot is not the immutable reviewed capture or relevant source vector. */
export function topicMaintenanceSourceVectorHash(review: TopicMaintenanceReviewPayloadV1) {
  return sha256HexSync(
    canonicalJson(
      review.reviewEvidence.map(entry => {
        if (!entry.handleId.startsWith('current:')) return entry;
        const {sourceCommit: _commit, sourceSnapshotId: _snapshot, ...source} = entry.source;
        return {...entry, source};
      }),
    ),
  );
}

export function buildTopicMaintenanceGitProposal(input: {
  readonly baseCommit: string;
  readonly baseBranch: string | null;
  readonly target: GitProposal['target'];
  readonly path: string;
  readonly record: MemoryRecord;
  readonly rawContent: string;
  readonly review: CandidateReview;
  readonly prepared: {readonly content: string; readonly contentHash: string; readonly approvalDigest: string};
  readonly access: 'read-write';
}): GitProposalBuild & {readonly proposal: TopicMaintenanceGitProposalV2} {
  const {record, review, prepared} = input;
  if (
    !review.maintenance ||
    review.maintenance.version !== 1 ||
    review.candidates.length !== 1 ||
    review.candidates[0]?.state !== 'pending'
  )
    fail('Shared maintenance requires one pending private maintenance review.');
  if (
    record.uri !== review.maintenance.basis.targetUri ||
    sha256HexSync(canonicalMemoryDocumentContent(input.rawContent)) !== review.maintenance.basis.targetHash ||
    sha256HexSync(canonicalMemoryDocumentContent(record.content)) !== review.maintenance.basis.targetHash
  )
    fail('Shared maintenance target changed after review.');
  const final = parseMemoryDocument(record.uri, prepared.content);
  if (
    !final ||
    !record.metadata.topicMaintenance ||
    !final.metadata.topicMaintenance ||
    final.metadata.topicMaintenance.version !== 2 ||
    final.metadata.memoryId !== record.metadata.memoryId ||
    final.metadata.authority !== record.metadata.authority ||
    final.metadata.trust !== record.metadata.trust ||
    final.metadata.visibility !== record.metadata.visibility ||
    final.metadata.visibility !== 'shared' ||
    final.metadata.project !== record.metadata.project ||
    final.metadata.topic !== record.metadata.topic ||
    sha256HexSync(canonicalMemoryDocumentContent(prepared.content)) !== prepared.contentHash
  )
    fail('Shared maintenance final document does not preserve its reviewed target.');
  const project = validatePortableSegment(record.metadata.project ?? '');
  const topic = validatePortableSegment(record.metadata.topic ?? '');
  if (input.path !== sharedDurablePath(project, topic)) fail('Shared maintenance path changed.');
  const candidateId = review.candidates[0].candidateId;
  const files = [
    {
      approval: {
        candidateId,
        expectedSourceContentHash: review.maintenance.basis.targetHash,
        expectedSourceMemoryId: record.metadata.memoryId!,
        reviewId: review.reviewId,
        revision: review.revision,
        scope: 'shared' as const,
      },
      content: prepared.content,
      contentHash: sha256HexSync(prepared.content),
      memory: {
        id: record.metadata.memoryId!,
        relations: canonicalRelations(final.metadata.relations ?? [], candidateId),
        topic,
      },
      operation: 'replace' as const,
      path: input.path,
      targetPrecondition: {
        state: 'present' as const,
        expectedContentHash: sha256HexSync(input.rawContent),
        expectedMemoryId: record.metadata.memoryId!,
      },
    },
  ];
  const maintenance: TopicMaintenanceGitProposalV2['maintenance'] = {
    approvalDigest: prepared.approvalDigest,
    beforeCanonicalHash: review.maintenance.basis.targetHash,
    sourceVectorHash: topicMaintenanceSourceVectorHash(review.maintenance),
    reviewHash: sha256HexSync(canonicalJson(JSON.parse(JSON.stringify(review)))),
    baseBranch: input.baseBranch,
    policy: {
      version: 1,
      access: input.access,
      hash: topicMaintenancePublicationPolicyHash(input.target, input.path, input.access),
    },
  };
  const binding = {
    base: {expectedCommit: input.baseCommit},
    files,
    knowledgeDelta: {
      expectedHash: sha256HexSync(canonicalJson(projectKnowledgeDeltaV1(review))),
      expectedRevision: review.revision,
      reviewId: review.reviewId,
    },
    project,
    target: input.target,
  };
  const unsigned = {
    ...binding,
    branch: {name: expectedBranchName({...binding, maintenance})},
    commit: {message: `threadnote: propose ${project} knowledge delta ${review.reviewId}`},
    type: 'knowledge-delta-git-proposal' as const,
    version: 2 as const,
    maintenance,
  };
  const proposal = {...unsigned, proposalHash: sha256HexSync(canonicalJson(unsigned))};
  verifyTopicMaintenanceGitProposal(proposal);
  return {proposal, artifact: `${canonicalJson(proposal)}\n`};
}

export function verifyTopicMaintenanceGitProposal(proposal: TopicMaintenanceGitProposalV2): void {
  if (proposal.type !== 'knowledge-delta-git-proposal' || proposal.version !== 2)
    fail('Shared maintenance Git proposal type or version is unsupported.');
  if (new TextEncoder().encode(canonicalJson(proposal)).byteLength > maximumArtifactBytes)
    fail('Shared maintenance Git proposal is oversized.');
  validatePortableSegment(proposal.project);
  validatePortableSegment(proposal.target.team);
  if (
    !hashPattern.test(proposal.target.repositoryId) ||
    !commitPattern.test(proposal.base.expectedCommit) ||
    /^0+$/u.test(proposal.base.expectedCommit)
  )
    fail('Shared maintenance Git repository/base is invalid.');
  if (
    !reviewPattern.test(proposal.knowledgeDelta.reviewId) ||
    !Number.isSafeInteger(proposal.knowledgeDelta.expectedRevision) ||
    proposal.knowledgeDelta.expectedRevision < 1
  )
    fail('Shared maintenance review identity is invalid.');
  if (
    !Array.isArray(proposal.files) ||
    proposal.files.length !== 1 ||
    proposal.files[0].operation !== 'replace' ||
    proposal.files[0].targetPrecondition.state !== 'present'
  )
    fail('Shared maintenance supports one existing-target replacement only.');
  const receipt = proposal.maintenance;
  if (
    !receipt ||
    ![receipt.approvalDigest, receipt.beforeCanonicalHash, receipt.sourceVectorHash, receipt.reviewHash].every(
      value => typeof value === 'string' && hashPattern.test(value),
    ) ||
    (receipt.baseBranch !== null &&
      (typeof receipt.baseBranch !== 'string' || !receipt.baseBranch || /[\r\n\0]/u.test(receipt.baseBranch))) ||
    receipt.policy?.version !== 1 ||
    receipt.policy.access !== 'read-write' ||
    receipt.policy.hash !==
      topicMaintenancePublicationPolicyHash(proposal.target, proposal.files[0].path, 'read-write') ||
    !hashPattern.test(proposal.knowledgeDelta.expectedHash)
  )
    fail('Shared maintenance approval/source/policy binding is invalid.');
  const file = proposal.files[0];
  if (
    file.approval.expectedSourceContentHash !== receipt.beforeCanonicalHash ||
    file.approval.expectedSourceMemoryId !== file.memory.id ||
    file.approval.candidateId !== `${proposal.knowledgeDelta.reviewId}-1`
  )
    fail('Shared maintenance target approval is invalid.');
  verifyProposalFile(proposal, file);
  if (parseMemoryDocument('threadnote://proposal/file', file.content)?.metadata.topicMaintenance?.version !== 2)
    fail('Shared maintenance final manifest is invalid.');
  if (
    proposal.branch.name !== expectedBranchName(proposal) ||
    proposal.commit.message !==
      `threadnote: propose ${proposal.project} knowledge delta ${proposal.knowledgeDelta.reviewId}`
  )
    fail('Shared maintenance branch/commit binding is invalid.');
  const {proposalHash: _hash, ...unsigned} = proposal;
  if (proposal.proposalHash !== sha256HexSync(canonicalJson(unsigned)))
    fail('Shared maintenance Git proposal hash changed.');
}

function fail(message: string): never {
  throw KnowledgeDeltaGitProposalError.make({message});
}
