import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {declaresTopicMaintenanceHeader, declaresReviewedSupportHeader} from '@threadnote/memory/document';
import {verifyKnowledgeDeltaGitProposalV1} from './knowledge_delta.js';
import {
  verifyAutomaticMaintenanceGitProposal,
  verifyTopicMaintenanceGitProposal,
  type GitProposal,
} from './topic_maintenance_proposal.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export class KnowledgeDeltaGitMaterializerError extends Schema.TaggedError<
  KnowledgeDeltaGitMaterializerError,
  {readonly brand: unique symbol}
>()('KnowledgeDeltaGitMaterializerError', {message: Schema.String}) {}

export interface KnowledgeDeltaGitMaterializerStateV1 {
  readonly baseCommit: string;
  readonly files: Readonly<Record<string, string | undefined>>;
  readonly repositoryId: string;
}

export interface KnowledgeDeltaGitMaterializationPlanV1 {
  readonly branch: string;
  readonly commitMessage: string;
  readonly files: readonly {readonly content: string; readonly path: string}[];
  readonly proposalHash: string;
  readonly stateHash: string;
}

export function planKnowledgeDeltaGitMaterializationV1(
  proposal: GitProposal,
  state: KnowledgeDeltaGitMaterializerStateV1,
): KnowledgeDeltaGitMaterializationPlanV1 {
  if (proposal.version === 3) verifyAutomaticMaintenanceGitProposal(proposal);
  else if (proposal.version === 2) verifyTopicMaintenanceGitProposal(proposal);
  else verifyKnowledgeDeltaGitProposalV1(proposal);
  if (state.repositoryId !== proposal.target.repositoryId) fail('Proposal repository binding changed.');
  if (state.baseCommit !== proposal.base.expectedCommit) fail('Proposal base commit changed.');
  for (const file of proposal.files) {
    const current = state.files[file.path];
    if (proposal.version !== 3 && current !== undefined && declaresReviewedSupportHeader(current))
      fail(
        'Legacy proposals cannot replace a shared target with approved reviewed support; use the automatic review variant.',
      );
    if (proposal.version === 1 && current !== undefined && declaresTopicMaintenanceHeader(current))
      fail('Legacy V1 proposals cannot replace an enrolled shared target; use the reviewed maintenance variant.');
    if (file.targetPrecondition.state === 'absent') {
      if (current !== undefined) fail(`Proposal target changed: ${file.path}.`);
    } else if (current === undefined || sha256HexSync(current) !== file.targetPrecondition.expectedContentHash) {
      fail(`Proposal target changed: ${file.path}.`);
    }
  }
  const files = EffectArray.map(proposal.files, file => ({content: file.content, path: file.path}));
  const targetState = EffectArray.map(proposal.files, file => {
    const content = state.files[file.path];
    return {contentHash: content === undefined ? null : sha256HexSync(content), path: file.path};
  }).sort((left, right) => Effect.pipe(left.path, EffectString.localeCompare(right.path)));
  return {
    branch: proposal.branch.name,
    commitMessage: proposal.commit.message,
    files,
    proposalHash: proposal.proposalHash,
    stateHash: sha256HexSync(
      JSON.stringify({baseCommit: state.baseCommit, files: targetState, repositoryId: state.repositoryId}),
    ),
  };
}

function fail(message: string): never {
  throw KnowledgeDeltaGitMaterializerError.make({message});
}
