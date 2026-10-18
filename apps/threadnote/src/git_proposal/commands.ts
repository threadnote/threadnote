import {Console, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import {
  loadCandidateReview,
  listCandidateReviews,
  withCandidateReviewLock,
  type CandidateReview,
} from '@threadnote/memory/candidate';
import {
  memoryCodeCitationContentSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {hasDeferredCodeAnchorIntent} from '../memory/deferred/code_anchor.js';
import {canonicalMemoryDocumentContent, type MemoryRecord} from '@threadnote/memory/document';
import {projectKnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import {readMaintenanceMemoryRecords} from '../memory/maintenance/records.js';
import {MemoryOperationError} from '../memory/migrations.js';
import {assertSafeShareRelativePath, assertShareTeamWritable, resolveTeam} from '../share/core.js';
import {gitFileContent} from '../share/git.js';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import type {CommandResult} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  buildKnowledgeDeltaGitProposalV1,
  verifyKnowledgeDeltaGitProposalV1,
  type ReviewedSharedMemoryMutationV1,
} from './knowledge_delta.js';
import {planKnowledgeDeltaGitMaterializationV1, type KnowledgeDeltaGitMaterializationPlanV1} from './materializer.js';
import {
  verifyTopicMaintenanceGitProposal,
  type GitProposal,
  type GitProposalBuild,
} from './topic_maintenance_proposal.js';
import {
  buildReviewedTopicMaintenanceGitProposal,
  verifyTopicMaintenanceMaterialization,
} from './topic_maintenance_commands.js';

const MAXIMUM_GIT_PROPOSAL_OUTPUT_BYTES = 256 * 1_024;

export interface KnowledgeDeltaGitProposalExportOptionsV1 {
  readonly approved?: boolean;
  readonly approvalDigest?: string;
  readonly sourceCwd?: string;
  readonly candidateIds: readonly string[];
  readonly output?: string;
  readonly reviewId: string;
  readonly revision: number;
  readonly team?: string;
}

export interface KnowledgeDeltaGitProposalMaterializeOptionsV1 {
  readonly apply?: boolean;
  readonly approvalDigest?: string;
  readonly sourceCwd?: string;
  readonly proposal: string;
  readonly team?: string;
}

interface GitMaterializeRunOptions {
  readonly allowFailure?: boolean;
  readonly indexFile?: string;
  readonly input?: Uint8Array;
}

type GitMaterializeRunner = (
  args: readonly string[],
  options?: GitMaterializeRunOptions,
) => Effect.Effect<CommandResult, unknown>;

export const runKnowledgeDeltaGitProposalMaterialize = Effect.fn('gitProposal.materializeCommand')(function* (
  config: RuntimeConfig,
  options: KnowledgeDeltaGitProposalMaterializeOptionsV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const rawProposal = yield* fs
    .readFileString(options.proposal)
    .pipe(Effect.mapError(() => operationError('Git proposal file is unreadable.')));
  const proposal = yield* Effect.try({
    try: () => JSON.parse(rawProposal) as GitProposal,
    catch: () => operationError('Git proposal file is unreadable or invalid JSON.'),
  });
  yield* Effect.try({
    try: () =>
      proposal.version === 2
        ? verifyTopicMaintenanceGitProposal(proposal)
        : verifyKnowledgeDeltaGitProposalV1(proposal),
    catch: cause => operationError(cause instanceof Error ? cause.message : 'Git proposal is invalid.'),
  });
  const materialize = materializeProposal(config, options, proposal);
  return yield* proposal.version === 2
    ? withCandidateReviewLock(config.agentContextHome, proposal.knowledgeDelta.reviewId, materialize)
    : materialize;
});

const materializeProposal = Effect.fn('gitProposal.materializeDecoded')(function* (
  config: RuntimeConfig,
  options: KnowledgeDeltaGitProposalMaterializeOptionsV1,
  proposal: GitProposal,
) {
  const fs = yield* FileSystem.FileSystem;
  if (proposal.version === 2) {
    if (options.apply === true && options.approvalDigest !== proposal.proposalHash)
      return yield* operationError(
        'Shared maintenance materialization requires the exact proposalHash as approvalDigest.',
      );
    yield* verifyTopicMaintenanceMaterialization(config, proposal, options);
  }
  const team = yield* resolveTeam(config, options.team);
  if (team.name !== proposal.target.team) {
    return yield* operationError(
      `Git proposal targets shared team "${proposal.target.team}", not configured team "${team.name}".`,
    );
  }
  if (options.apply === true) {
    yield* Effect.try({
      try: () => assertShareTeamWritable(team, 'materialize a Knowledge Delta Git proposal'),
      catch: cause => operationError(cause instanceof Error ? cause.message : 'Shared team is not writable.'),
    });
  }
  const repository = yield* resolveRepositoryIdentity(team.config.worktree).pipe(
    Effect.mapError(() => operationError('Could not resolve the local shared Git repository.')),
  );
  const command = yield* CommandExecutor;
  const run: GitMaterializeRunner = (args, runOptions = {}) =>
    command.execute('git', args, {
      allowFailure: runOptions.allowFailure,
      cwd: team.config.worktree,
      input: runOptions.input,
      maxOutputBytes: 1_048_576,
      timeoutMs: 30_000,
      trustedGitIndexFile: runOptions.indexFile,
    });
  const read: GitMaterializeRunner = (args, runOptions = {}) => run(['--no-optional-locks', ...args], runOptions);
  const status = yield* read(['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (status.stdout.trim())
    return yield* operationError('Local shared Git worktree must be clean before materialization.');
  const base = proposal.base.expectedCommit;
  const readableBase = yield* read(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {allowFailure: true});
  if (readableBase.exitCode !== 0 || readableBase.stdout.trim() !== base) {
    return yield* operationError('Git proposal base commit is not readable in the configured shared repository.');
  }
  const files = Object.fromEntries(
    yield* Effect.forEach(proposal.files, file =>
      read(['show', `${base}:${file.path}`], {allowFailure: true}).pipe(
        Effect.map(result => [file.path, result.exitCode === 0 ? result.stdout : undefined] as const),
      ),
    ),
  );
  const plan = yield* Effect.try({
    try: () =>
      planKnowledgeDeltaGitMaterializationV1(proposal, {
        baseCommit: base,
        files,
        repositoryId: repository.repositoryId,
      }),
    catch: cause => operationError(cause instanceof Error ? cause.message : 'Proposal precondition changed.'),
  });
  const branchRef = `refs/heads/${plan.branch}`;
  const refCheck = yield* read(['check-ref-format', '--branch', plan.branch], {allowFailure: true});
  if (refCheck.exitCode !== 0) return yield* operationError('Git proposal branch binding is invalid.');
  const existing = yield* materializedBranchCommit(read, branchRef);
  if (existing !== undefined) {
    yield* verifyMaterializedBranch(read, branchRef, existing, base, plan);
    if (proposal.version === 2) yield* verifyTopicMaintenanceMaterialization(config, proposal, options);
    yield* Console.log(
      JSON.stringify({
        branch: plan.branch,
        commit: existing,
        outcome: options.apply === true ? 'reused' : 'preview',
        proposalHash: plan.proposalHash,
      }),
    );
    return {branch: plan.branch, commit: existing, materialized: true, proposalHash: plan.proposalHash} as const;
  }
  if (repository.headCommit !== base) return yield* operationError('Proposal base commit changed.');
  if (options.apply !== true) {
    yield* Console.log(
      JSON.stringify({
        branch: plan.branch,
        files: plan.files.map(file => file.path),
        outcome: 'preview',
        proposalHash: plan.proposalHash,
      }),
    );
    return {branch: plan.branch, materialized: false, proposalHash: plan.proposalHash} as const;
  }
  const commit = yield* createMaterializedBranch(fs, yield* Path.Path, run, read, branchRef, base, plan);
  if (proposal.version === 2) yield* verifyTopicMaintenanceMaterialization(config, proposal, options);
  yield* Console.log(
    JSON.stringify({
      branch: plan.branch,
      commit: commit.commit,
      outcome: commit.outcome,
      proposalHash: plan.proposalHash,
    }),
  );
  return {branch: plan.branch, commit: commit.commit, materialized: true, proposalHash: plan.proposalHash} as const;
});

const materializedBranchCommit = Effect.fn('gitProposal.materializedBranchCommit')(function* (
  read: GitMaterializeRunner,
  branchRef: string,
) {
  const result = yield* read(['rev-parse', '--verify', '--quiet', `${branchRef}^{commit}`], {allowFailure: true});
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
});

const verifyMaterializedBranch = Effect.fn('gitProposal.verifyMaterializedBranch')(function* (
  read: GitMaterializeRunner,
  branchRef: string,
  commit: string,
  base: string,
  plan: KnowledgeDeltaGitMaterializationPlanV1,
) {
  const parents = (yield* read(['rev-list', '--parents', '-n', '1', branchRef])).stdout.trim().split(/\s+/u);
  const message = (yield* read(['show', '-s', '--format=%B', branchRef])).stdout.trimEnd();
  const changed = (yield* read([
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    '--no-renames',
    base,
    commit,
  ])).stdout
    .split('\n')
    .filter(Boolean)
    .sort();
  const planned = plan.files.map(file => file.path).sort();
  if (
    parents.length !== 2 ||
    parents[0] !== commit ||
    parents[1] !== base ||
    message !== plan.commitMessage.trimEnd() ||
    JSON.stringify(changed) !== JSON.stringify(planned)
  ) {
    return yield* operationError('Existing materialization branch conflicts with the Git proposal.');
  }
  for (const file of plan.files) {
    const treeEntry = yield* read(['ls-tree', commit, '--', file.path]);
    const content = yield* read(['show', `${commit}:${file.path}`]);
    if (!treeEntry.stdout.startsWith('100644 blob ') || content.stdout !== file.content) {
      return yield* operationError('Existing materialization branch conflicts with the Git proposal.');
    }
  }
});

const createMaterializedBranch = Effect.fn('gitProposal.createMaterializedBranch')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  run: GitMaterializeRunner,
  read: GitMaterializeRunner,
  branchRef: string,
  base: string,
  plan: KnowledgeDeltaGitMaterializationPlanV1,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-git-proposal-'});
      const indexFile = path.join(temporary, 'index');
      yield* run(['read-tree', base], {indexFile});
      for (const file of plan.files) {
        const blob = (yield* run(['hash-object', '-w', '--stdin'], {
          input: new TextEncoder().encode(file.content),
        })).stdout.trim();
        yield* run(['update-index', '--add', '--cacheinfo', '100644', blob, file.path], {indexFile});
      }
      const tree = (yield* run(['write-tree'], {indexFile})).stdout.trim();
      const commit = (yield* run(['commit-tree', tree, '-p', base, '-m', plan.commitMessage])).stdout.trim();
      const objectFormat = (yield* read(['rev-parse', '--show-object-format'])).stdout.trim();
      const updated = yield* run(['update-ref', branchRef, commit, gitNullObjectId(objectFormat)], {
        allowFailure: true,
      });
      if (updated.exitCode !== 0) {
        const raced = yield* materializedBranchCommit(read, branchRef);
        if (raced === undefined) return yield* operationError('Could not create the materialization branch.');
        yield* verifyMaterializedBranch(read, branchRef, raced, base, plan);
        return {commit: raced, outcome: 'reused' as const};
      }
      yield* verifyMaterializedBranch(read, branchRef, commit, base, plan);
      return {commit, outcome: 'applied' as const};
    }),
  );
});

export function gitNullObjectId(objectFormat: string): string {
  if (objectFormat === 'sha1') return '0'.repeat(40);
  if (objectFormat === 'sha256') return '0'.repeat(64);
  throw operationError(`Unsupported Git object format: ${objectFormat || 'unknown'}.`);
}

export const buildReviewedKnowledgeDeltaGitProposal = Effect.fn('gitProposal.buildReviewed')(function* (
  config: RuntimeConfig,
  options: Omit<KnowledgeDeltaGitProposalExportOptionsV1, 'output'>,
) {
  const candidateIds = [...new Set(options.candidateIds.map(value => value.trim()).filter(Boolean))].sort();
  if (candidateIds.length > 3) return yield* operationError('A Git proposal can contain at most three candidates.');
  const reviewId = options.reviewId.trim();
  return yield* withCandidateReviewLock(
    config.agentContextHome,
    reviewId,
    Effect.gen(function* () {
      const reviews = yield* listCandidateReviews(config.agentContextHome);
      const review = reviews.find(item => item.reviewId === reviewId);
      if (!review) return yield* operationError(`Candidate review ${reviewId} was not found.`);
      if (review.revision !== options.revision) {
        return yield* operationError(
          `Candidate review revision changed: expected ${options.revision}, current ${review.revision}. Review it again before export.`,
        );
      }
      if (review.maintenance || review.maintenanceCapture)
        return yield* operationError('Topic maintenance requires the dedicated reviewed Git proposal adapter.');
      if (options.approved !== true)
        return yield* operationError('Git proposal export requires --approved after explicit shared-mutation review.');
      if (candidateIds.length === 0) return yield* operationError('Select at least one --candidate-id to share.');
      const delta = projectKnowledgeDeltaV1(review);
      const team = yield* resolveTeam(config, options.team);
      const repository = yield* resolveRepositoryIdentity(team.config.worktree).pipe(
        Effect.mapError(cause => operationError(`Could not resolve the shared Git repository: ${cause.message}`)),
      );
      if (repository.remoteIdentity === undefined) {
        return yield* operationError(
          'The configured shared Git worktree needs a portable remote repository identity before proposal export.',
        );
      }
      const baseCommit = repository.headCommit;
      if (/^0+$/u.test(baseCommit)) {
        return yield* operationError('The configured shared Git worktree has no readable HEAD commit.');
      }
      const records = yield* readMaintenanceMemoryRecords(config);
      const mutations = yield* Effect.forEach(candidateIds, candidateId =>
        reviewedMutation(config, review, candidateId, records, team.config.worktree, baseCommit),
      );
      return yield* Effect.try({
        try: () =>
          buildKnowledgeDeltaGitProposalV1({
            baseCommit,
            delta,
            mutations,
            project: review.project,
            target: {repositoryId: repository.repositoryId, team: team.name},
          }),
        catch: cause => operationError(cause instanceof Error ? cause.message : 'Could not build the Git proposal.'),
      });
    }),
  );
});

/** Shared maintenance dispatch stays separate from the legacy V1 activation/publication API. */
export const buildReviewedGitProposal = Effect.fn('gitProposal.buildReviewedVariant')(function* (
  config: RuntimeConfig,
  options: Omit<KnowledgeDeltaGitProposalExportOptionsV1, 'output'>,
) {
  const selected = yield* loadCandidateReview(config.agentContextHome, options.reviewId);
  if (selected.maintenanceCapture || selected.maintenance?.version === 2)
    return yield* operationError('Private imported topic reviews cannot be exported.');
  if (!selected.maintenance) return yield* buildReviewedKnowledgeDeltaGitProposal(config, options);
  return yield* withCandidateReviewLock(
    config.agentContextHome,
    options.reviewId,
    Effect.gen(function* () {
      const review = yield* loadCandidateReview(config.agentContextHome, options.reviewId);
      if (review.revision !== options.revision)
        return yield* operationError('Shared maintenance review revision changed. Read its current preview.');
      return yield* buildReviewedTopicMaintenanceGitProposal(config, review, options);
    }),
  );
});

export const runKnowledgeDeltaGitProposalExport = Effect.fn('gitProposal.exportCommand')(function* (
  config: RuntimeConfig,
  options: KnowledgeDeltaGitProposalExportOptionsV1,
) {
  const built = yield* buildReviewedGitProposal(config, options);
  if (options.output === undefined) {
    yield* Console.log(built.artifact.trimEnd());
    return;
  }
  const system = yield* SystemInfo;
  const path = yield* Path.Path;
  const output = path.resolve(system.currentDirectory(), options.output);
  yield* writeProposalArtifact(output, built);
  yield* Console.log(`Wrote Knowledge Delta Git proposal: ${output}`);
});

function reviewedMutation(
  config: RuntimeConfig,
  review: CandidateReview,
  candidateId: string,
  records: readonly MemoryRecord[],
  worktree: string,
  baseCommit: string,
) {
  return Effect.gen(function* () {
    const candidate = review.candidates.find(item => item.candidateId === candidateId);
    if (!candidate) return yield* operationError(`Candidate ${candidateId} is not part of ${review.reviewId}.`);
    if (candidate.state !== 'applied' || !candidate.applyTargetUri) {
      return yield* operationError(`Candidate ${candidateId} must be applied before shared Git proposal export.`);
    }
    const sources = records.filter(record => record.uri === candidate.applyTargetUri);
    if (sources.length !== 1) {
      return yield* operationError(`Applied candidate source ${candidate.applyTargetUri} is not uniquely readable.`);
    }
    const source = sources[0];
    if (!source) return yield* operationError(`Applied candidate source ${candidate.applyTargetUri} is missing.`);
    if (!candidate.applyContentHash) {
      return yield* operationError(
        `Candidate ${candidateId} has no approved apply content hash. Apply it again before shared Git proposal export.`,
      );
    }
    const currentSourceContentHash = sha256HexSync(canonicalMemoryDocumentContent(source.content));
    if (currentSourceContentHash !== candidate.applyContentHash) {
      return yield* operationError(
        `Candidate ${candidateId} applied source changed after approval. Review and apply it again before shared Git proposal export.`,
      );
    }
    if (source.metadata.kind !== 'durable' || source.metadata.status !== 'active') {
      return yield* operationError(`Candidate ${candidateId} is not an active durable memory.`);
    }
    if (yield* hasDeferredCodeAnchorIntent(config, source.uri)) {
      return yield* operationError(
        `Candidate ${candidateId} code citations are still pending. Prepare the graph, run \`threadnote finalize-code-refs --uri ${source.uri}\`, and retry the export.`,
      );
    }
    const citationBlocker = memoryCodeCitationContentSharingBlocker(source.uri, source.content);
    if (citationBlocker) {
      return yield* operationError(
        `Candidate ${candidateId} cannot be shared: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
      );
    }
    const targetPath = yield* sharedTargetPath(review.project, source.metadata.topic);
    const targetContent = yield* gitFileContent(worktree, baseCommit, targetPath);
    const expectedTarget =
      targetContent === undefined
        ? ({state: 'absent'} as const)
        : ({content: targetContent, contentHash: sha256HexSync(targetContent), state: 'present'} as const);
    return {
      approval: {
        expectedSourceContentHash: currentSourceContentHash,
        reviewId: review.reviewId,
        revision: review.revision,
        share: true,
      },
      candidateId,
      expectedTarget,
      operation: targetContent === undefined ? 'create' : 'replace',
      sourceContent: source.content,
      sourceUri: source.uri,
    } satisfies ReviewedSharedMemoryMutationV1;
  });
}

function sharedTargetPath(projectInput: string, topicInput: string | undefined) {
  return Effect.try({
    try: () => {
      const project = validatePortableSegment(projectInput);
      const topic = validatePortableSegment(topicInput ?? '');
      return assertSafeShareRelativePath(`durable/projects/${project}/${topic}.md`);
    },
    catch: () => operationError('The reviewed project/topic is not a portable shared-memory path.'),
  });
}

const writeProposalArtifact = Effect.fn('gitProposal.writeArtifact')(function* (
  output: string,
  built: GitProposalBuild,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bytes = new TextEncoder().encode(built.artifact).byteLength;
  if (bytes > MAXIMUM_GIT_PROPOSAL_OUTPUT_BYTES) return yield* operationError('Git proposal artifact is too large.');
  if (yield* fs.exists(output)) {
    if (Option.isSome(yield* fs.readLink(output).pipe(Effect.option))) {
      return yield* operationError('Refusing to overwrite a symbolic-link Git proposal output.');
    }
    const current = yield* fs.readFileString(output);
    if (current === built.artifact) return;
    return yield* operationError('Git proposal output already exists with different content.');
  }
  yield* fs.makeDirectory(path.dirname(output), {recursive: true});
  const crypto = yield* Crypto.Crypto;
  const temporary = `${output}.${yield* crypto.randomUUIDv4()}.tmp`;
  yield* fs.writeFileString(temporary, built.artifact, {mode: 0o600});
  yield* fs.rename(temporary, output).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

function operationError(message: string) {
  return MemoryOperationError.make({message});
}
