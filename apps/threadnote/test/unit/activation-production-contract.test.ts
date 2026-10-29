import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  activationContinuationCommandV1,
  runActivationProductionCommandV1,
} from '@threadnote/threadnote/activation/production';
import {makeActivationProductionExecutorV1} from '@threadnote/threadnote/activation/production/executor';
import {parseActivationProductionRequestV1} from '@threadnote/threadnote/activation/production/contract';
import {
  activationApprovedProjectionEvidenceHashV1,
  activationImportedMemoriesEvidenceHashV1,
  activationProposalEvidenceInputV1,
  assertDirectActivationPublicationV1,
  assertProposalActivationPublicationV1,
  directActivationPublicationIsCompleteV1,
  findOrCreateActivationDecisionReviewV1,
  findOrCreateActivationImportReviewsV1,
  observeCurrentActivationTeamV1,
  onlyDecisionCandidate,
  readAppliedActivationDecisionV1,
  readAppliedActivationImportsV1,
  type AppliedActivationDecisionV1,
} from '@threadnote/threadnote/activation/production/evidence';
import {canonicalMemoryDocumentContent, parseMemoryDocument} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CandidateReview, MemoryCandidate} from '@threadnote/memory/candidate';
import {
  activationReplacementTargetIdentityHashV1,
  observeActivationProductionV1,
} from '@threadnote/threadnote/activation/production/observe';
import {
  completeActivationMutationIntentV1,
  prepareActivationMutationIntentV1,
} from '@threadnote/threadnote/activation/production/mutation_store';
import {CommandExecutor} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runCloseoutApply} from '@threadnote/threadnote/memory/closeout';
import {runRemember} from '@threadnote/threadnote/memory/index';
import {
  bindActivationApprovalV1,
  createActivationReceiptV1,
  recordActivationOutcomeV1,
} from '@threadnote/threadnote/activation/receipt';
import {recoverShareInit} from '@threadnote/threadnote/share/admin';
import {readTeamsFile, teamGitdirPath, teamWorktreePath} from '@threadnote/threadnote/share/core';
import {runShareInit, runSharePublish} from '@threadnote/threadnote/effect/share';
import {initializeActivationStateV1} from '@threadnote/threadnote/activation/store';
import {
  activationProductionUndoApprovalTokenV1,
  runActivationProductionUndoV1,
} from '@threadnote/threadnote/activation/production/undo';
import {
  buildReviewedKnowledgeDeltaGitProposal,
  runKnowledgeDeltaGitProposalMaterialize,
} from '@threadnote/threadnote/git_proposal/commands';
import {initializeActivationProposalEvidenceV1} from '@threadnote/threadnote/activation/production/proposal_store';
import type {ActivationPlanV1} from '@threadnote/threadnote/activation/contract';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const request = {
  adrPaths: ['docs/adr/0001.md'],
  decision: {
    constraints: ['Stay offline.'],
    decision: 'Keep Git as the shared source of truth.',
    invalidated: ['The prior implicit publication path.'],
    rationale: 'It preserves review and portability.',
    unresolvedRisks: ['Large repositories may need tuning.'],
    verification: ['The second agent read the exact memory.'],
  },
  primarySurfaceId: 'codex-cli',
  project: 'threadnote',
  publicationMode: 'proposal' as const,
  repositoryRoot: '/tmp/threadnote',
  secondarySurfaceId: 'claude-code',
  task: 'Activate Threadnote for this repository.',
  team: {name: 'default', push: false, setDefault: true},
  topic: 'activation-decision',
  type: 'threadnote-activation-request' as const,
  version: 1 as const,
};

describe('activation production request', () => {
  it('strictly parses a bounded request', () => {
    expect(parseActivationProductionRequestV1(request)).toEqual(request);
  });

  it('rejects same-surface, excess, and unbound replacement requests', () => {
    expect(() =>
      parseActivationProductionRequestV1({...request, secondarySurfaceId: request.primarySurfaceId}),
    ).toThrow(/distinct/u);
    expect(() => parseActivationProductionRequestV1({...request, extra: true})).toThrow();
    expect(() =>
      parseActivationProductionRequestV1({...request, secondSurfaceEvidence: {read: {}, recall: {}}}),
    ).toThrow();
    expect(() =>
      parseActivationProductionRequestV1({...request, decision: {...request.decision, operation: 'replace'}}),
    ).toThrow(/replaceUri/u);
  });

  it('canonicalizes replacement target identity aliases before hashing', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/u), {maxLength: 5, minLength: 1}), segments => {
        const path = EffectArray.join(segments, '/');
        expect(activationReplacementTargetIdentityHashV1(`viking://user/${path}`)).toBe(
          activationReplacementTargetIdentityHashV1(`threadnote://user/${path}`),
        );
      }),
      {numRuns: 32},
    );
  });

  it('renders the real request path as one shell-safe continuation argument', () => {
    const requestPath = "/tmp/activation request;$(touch should-not-run)'s.json";
    const command = activationContinuationCommandV1(
      Effect2.pipe('a', EffectString.repeat(64)),
      requestPath,
      Effect2.pipe('b', EffectString.repeat(64)),
    );
    expect(command).toContain(`--request '/tmp/activation request;$(touch should-not-run)'"'"'s.json'`);
    expect(command).not.toContain('<request.json>');
  });

  it('binds undo approval to effective operations, retained IDs, and publication evidence', () => {
    fc.assert(
      fc.property(
        fc.string({unit: fc.constantFrom(...'0123456789abcdef'), minLength: 64, maxLength: 64}),
        fc.string({unit: fc.constantFrom(...'0123456789abcdef'), minLength: 64, maxLength: 64}),
        (baseUndoPlanHash, publicationEvidenceHash) => {
          const input = {
            baseUndoPlanHash,
            operations: [
              {
                inputHash: Effect2.pipe('1', EffectString.repeat(64)),
                operationId: 'decision-apply',
                outcomeHash: Effect2.pipe('2', EffectString.repeat(64)),
                subsystemReceiptHash: Effect2.pipe('3', EffectString.repeat(64)),
              },
            ],
            publicationEvidenceHash,
            retainedOperationIds: ['decision-publish'],
          };
          const token = activationProductionUndoApprovalTokenV1(input);
          expect(
            activationProductionUndoApprovalTokenV1({
              ...input,
              operations: [{...input.operations[0], inputHash: flipDigest(input.operations[0].inputHash)}],
            }),
          ).not.toBe(token);
          expect(
            activationProductionUndoApprovalTokenV1({
              ...input,
              retainedOperationIds: [...input.retainedOperationIds, 'team-share'],
            }),
          ).not.toBe(token);
          expect(
            activationProductionUndoApprovalTokenV1({
              ...input,
              publicationEvidenceHash: flipDigest(publicationEvidenceHash),
            }),
          ).not.toBe(token);
        },
      ),
      {numRuns: 32},
    );
  });

  it('verifies direct publication after personal candidate provenance is stripped', () => {
    const applied = activationDecision('personal', 'tn_activation_source');
    const published = activationDecision('shared', 'tn_activation_source');
    expect(published.record.metadata.candidateId).toBeUndefined();
    expect(() => assertDirectActivationPublicationV1(applied, published)).not.toThrow();
    expect(directActivationPublicationIsCompleteV1(applied, published)).toBe(false);
    expect(directActivationPublicationIsCompleteV1(published, published)).toBe(true);
  });

  it('verifies proposal continuation against the replacement target identity', () => {
    const applied = activationDecision('personal', 'tn_activation_source');
    const published = activationDecision('shared', 'tn_existing_shared_target');
    const evidence = {
      activationId: Effect2.pipe('a', EffectString.repeat(64)),
      approvedProjectionHash: activationApprovedProjectionEvidenceHashV1(applied),
      branchName: 'threadnote/knowledge-delta/review-0000000000000000-deadbeefcafe',
      candidateId: applied.candidate.candidateId,
      finalContentHash: sha256HexSync(canonicalMemoryDocumentContent(published.record.content)),
      operation: 'replace' as const,
      proposalHash: Effect2.pipe('b', EffectString.repeat(64)),
      repositoryId: Effect2.pipe('c', EffectString.repeat(64)),
      reviewId: applied.review.reviewId,
      reviewRevision: applied.review.revision,
      revision: Effect2.pipe('d', EffectString.repeat(64)),
      sourceMemoryId: applied.record.metadata.memoryId!,
      targetMemoryId: published.record.metadata.memoryId!,
      targetPreconditionHash: Effect2.pipe('e', EffectString.repeat(64)),
      team: 'default',
      type: 'threadnote-activation-proposal-evidence' as const,
      version: 1 as const,
    };
    expect(() => assertProposalActivationPublicationV1(evidence, published)).not.toThrow();
    expect(() =>
      assertProposalActivationPublicationV1({...evidence, targetMemoryId: 'tn_wrong_target'}, published),
    ).toThrow(/approved Git evidence/u);
  });

  effectIt.effect('previews the real local journey without creating activation state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-preview-repo-'});
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-preview-home-'});
        yield* command.execute('git', ['init', '--quiet'], {cwd: root, maxOutputBytes: 4_096, timeoutMs: 5_000});
        const requestPath = path.join(root, 'activation.json');
        yield* fs.writeFileString(
          requestPath,
          JSON.stringify({...request, adrPaths: [], repositoryRoot: root, team: {...request.team, remotePath: root}}),
        );
        yield* runActivationProductionCommandV1(
          {
            account: 'test',
            agentContextHome: home,
            agentId: 'test-agent',
            agentIdSource: 'system',
            manifestPath: path.join(home, 'manifest.yaml'),
            user: 'test-user',
            userSource: 'system',
          },
          {apply: false, approved: false, command: 'start', requestFile: requestPath},
        );
        expect(yield* fs.exists(path.join(home, 'activation'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('accepts a managed MCP surface without project guidance', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-no-guidance-repo-'});
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-no-guidance-home-'});
        yield* command.execute('git', ['init', '--quiet'], {cwd: root, maxOutputBytes: 4_096, timeoutMs: 5_000});
        const config = {
          account: 'test',
          agentContextHome: home,
          agentId: 'test-agent',
          agentIdSource: 'system' as const,
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'test-user',
          userSource: 'system' as const,
        };
        const input = {
          ...request,
          adrPaths: [],
          primarySurfaceId: 'junie-cli',
          repositoryRoot: root,
          team: {...request.team, remotePath: root},
        };
        const observation = yield* observeActivationProductionV1(config, parseActivationProductionRequestV1(input));
        expect(observation.primaryAdapter.catalog.id).toBe('junie-cli');
        expect(observation.imports.sources).toEqual([]);
        const firstReplacement = yield* observeActivationProductionV1(
          config,
          parseActivationProductionRequestV1({
            ...input,
            decision: {
              ...input.decision,
              operation: 'replace',
              replaceUri: 'viking://user/test/memories/durable/projects/threadnote/first.md',
            },
          }),
        );
        const secondReplacement = yield* observeActivationProductionV1(
          config,
          parseActivationProductionRequestV1({
            ...input,
            decision: {
              ...input.decision,
              operation: 'replace',
              replaceUri: 'threadnote://user/test/memories/durable/projects/threadnote/second.md',
            },
          }),
        );
        expect(firstReplacement.request.decision.replaceUri).toBe(
          'threadnote://user/test/memories/durable/projects/threadnote/first.md',
        );
        expect(firstReplacement.plan.taskHash).not.toBe(observation.plan.taskHash);
        expect(secondReplacement.plan.taskHash).not.toBe(firstReplacement.plan.taskHash);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('imports approved guidance into resumable candidate reviews', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-import-repo-'});
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-import-home-'});
        yield* command.execute('git', ['init', '--quiet'], {cwd: root, maxOutputBytes: 4_096, timeoutMs: 5_000});
        yield* fs.writeFileString(path.join(root, 'AGENTS.md'), '# Existing agent guidance\n');
        const config = {
          account: 'test',
          agentContextHome: home,
          agentId: 'test-agent',
          agentIdSource: 'system' as const,
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'test-user',
          userSource: 'system' as const,
        };
        const observation = yield* observeActivationProductionV1(
          config,
          parseActivationProductionRequestV1({
            ...request,
            adrPaths: [],
            repositoryRoot: root,
            team: {...request.team, remotePath: root},
          }),
        );
        const created = yield* findOrCreateActivationImportReviewsV1(config, observation);
        expect(created).toHaveLength(1);
        for (const review of created) {
          const candidate = onlyDecisionCandidate(review);
          const applied = yield* runCloseoutApply(config, {
            action: 'approve',
            approved: true,
            candidateId: candidate.candidateId,
            operation: 'create',
            reviewId: review.reviewId,
            revision: review.revision,
          });
          expect(applied.isError).not.toBe(true);
        }
        const imported = yield* readAppliedActivationImportsV1(config, observation);
        expect(imported).toHaveLength(1);
        expect(imported[0].record.body).toContain('Existing agent guidance');
        expect(
          activationImportedMemoriesEvidenceHashV1(
            observation.imports.sourceSetHash,
            EffectArray.map(imported, decision => decision.review),
          ),
        ).toMatch(/^[0-9a-f]{64}$/u);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('disowns import and decision candidates approved by another actor', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-external-apply-repo-'});
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-external-apply-home-'});
        yield* command.execute('git', ['init', '--quiet'], {cwd: root, maxOutputBytes: 4_096, timeoutMs: 5_000});
        yield* fs.writeFileString(path.join(root, 'AGENTS.md'), '# External approval ownership\n');
        const config = {
          account: 'test',
          agentContextHome: home,
          agentId: 'test-agent',
          agentIdSource: 'system' as const,
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'test-user',
          userSource: 'system' as const,
        };
        const observation = yield* observeActivationProductionV1(
          config,
          parseActivationProductionRequestV1({
            ...request,
            adrPaths: [],
            repositoryRoot: root,
            team: {...request.team, remotePath: root},
          }),
        );
        const importReviews = yield* findOrCreateActivationImportReviewsV1(config, observation);
        for (const review of importReviews) {
          const candidate = onlyDecisionCandidate(review);
          yield* runCloseoutApply(config, {
            action: 'approve',
            approved: true,
            candidateId: candidate.candidateId,
            operation: 'create',
            reviewId: review.reviewId,
            revision: review.revision,
          });
        }
        const decisionReview = yield* findOrCreateActivationDecisionReviewV1(config, observation);
        const decisionCandidate = onlyDecisionCandidate(decisionReview);
        yield* runCloseoutApply(config, {
          action: 'approve',
          approved: true,
          candidateId: decisionCandidate.candidateId,
          operation: 'create',
          reviewId: decisionReview.reviewId,
          revision: decisionReview.revision,
        });
        const executor = makeActivationProductionExecutorV1(config, observation);
        const receipt = createActivationReceiptV1(observation.plan, '2026-09-18T08:00:00.000Z');
        const imported = yield* executor.execute({
          operationId: 'imports-review',
          plan: observation.plan,
          receipt,
        });
        const decided = yield* executor.execute({
          operationId: 'decision-apply',
          plan: observation.plan,
          receipt,
        });
        expect(imported).toMatchObject({ownership: 'preexisting', undoEligible: false});
        expect(decided).toMatchObject({ownership: 'preexisting', undoEligible: false});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('recovers only an exact clean interrupted team clone', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const remote = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-team-remote-'});
        const other = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-team-other-'});
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-team-home-'});
        for (const repository of [remote, other]) {
          yield* command.execute('git', ['init', '--quiet'], {
            cwd: repository,
            maxOutputBytes: 4_096,
            timeoutMs: 5_000,
          });
          yield* command.execute('git', ['config', 'user.email', 'activation@example.test'], {cwd: repository});
          yield* command.execute('git', ['config', 'user.name', 'Activation Test'], {cwd: repository});
          yield* fs.writeFileString(path.join(repository, 'README.md'), '# Team memory\n');
          yield* command.execute('git', ['add', 'README.md'], {cwd: repository});
          yield* command.execute('git', ['commit', '--quiet', '-m', 'seed'], {cwd: repository});
        }
        const config = {
          account: 'test',
          agentContextHome: home,
          agentId: 'test-agent',
          agentIdSource: 'system' as const,
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'test-user',
          userSource: 'system' as const,
        };
        const [worktree, gitdir] = yield* Effect.all([
          teamWorktreePath(config, 'default'),
          teamGitdirPath(config, 'default'),
        ]);
        yield* Effect.all([
          fs.makeDirectory(path.dirname(worktree), {recursive: true}),
          fs.makeDirectory(path.dirname(gitdir), {recursive: true}),
        ]);
        yield* command.execute('git', ['clone', '--quiet', `--separate-git-dir=${gitdir}`, '--', remote, worktree], {
          maxOutputBytes: 8_192,
          timeoutMs: 10_000,
        });
        expect(yield* recoverShareInit(config, remote, {push: false, setDefault: true, team: 'default'})).toBe(true);
        expect((yield* readTeamsFile(config)).teams.default?.remote).toBe(remote);
        const invalidHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-team-invalid-home-'});
        const invalidConfig = {...config, agentContextHome: invalidHome};
        const [invalidWorktree, invalidGitdir] = yield* Effect.all([
          teamWorktreePath(invalidConfig, 'default'),
          teamGitdirPath(invalidConfig, 'default'),
        ]);
        yield* Effect.all([
          fs.makeDirectory(path.dirname(invalidWorktree), {recursive: true}),
          fs.makeDirectory(path.dirname(invalidGitdir), {recursive: true}),
        ]);
        yield* command.execute(
          'git',
          ['clone', '--quiet', `--separate-git-dir=${invalidGitdir}`, '--', remote, invalidWorktree],
          {maxOutputBytes: 8_192, timeoutMs: 10_000},
        );
        const mismatch = yield* Effect.exit(
          recoverShareInit(invalidConfig, other, {push: false, setDefault: true, team: 'default'}),
        );
        expect(Exit.isFailure(mismatch)).toBe(true);
        expect((yield* readTeamsFile(invalidConfig)).teams.default).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains decision and team when direct publication completed before receipt CAS', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const repository = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-unrecorded-repo-'});
        const remote = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-unrecorded-remote-'});
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-unrecorded-home-'});
        for (const target of [repository, remote]) {
          yield* command.execute('git', ['init', '--quiet'], {cwd: target, maxOutputBytes: 4_096, timeoutMs: 5_000});
          yield* command.execute('git', ['config', 'user.email', 'activation@example.test'], {cwd: target});
          yield* command.execute('git', ['config', 'user.name', 'Activation Test'], {cwd: target});
          yield* fs.writeFileString(path.join(target, 'README.md'), '# Activation publication\n');
          yield* command.execute('git', ['add', 'README.md'], {cwd: target});
          yield* command.execute('git', ['commit', '--quiet', '-m', 'seed'], {cwd: target});
        }
        const config = {
          account: 'test',
          agentContextHome: home,
          agentId: 'test-agent',
          agentIdSource: 'system' as const,
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'test-user',
          userSource: 'system' as const,
        };
        yield* runShareInit(config, remote, {
          dryRun: false,
          push: false,
          setDefault: true,
          team: 'default',
        });
        const configuredTeam = (yield* readTeamsFile(config)).teams.default;
        if (configuredTeam === undefined) throw new Error('Expected configured activation team.');
        yield* prepareSharedWorktreeForCommits(configuredTeam.worktree);
        yield* command.execute('git', [
          '-C',
          configuredTeam.worktree,
          'remote',
          'set-url',
          'origin',
          'https://example.test/threadnote/activation.git',
        ]);
        const observation = yield* observeActivationProductionV1(
          config,
          parseActivationProductionRequestV1({
            ...request,
            adrPaths: [],
            publicationMode: 'direct',
            repositoryRoot: repository,
            team: {...request.team, remotePath: configuredTeam.worktree},
          }),
        );
        const review = yield* findOrCreateActivationDecisionReviewV1(config, observation);
        const candidate = onlyDecisionCandidate(review);
        yield* runCloseoutApply(config, {
          action: 'approve',
          approved: true,
          candidateId: candidate.candidateId,
          operation: 'create',
          reviewId: review.reviewId,
          revision: review.revision,
        });
        const decision = yield* readAppliedActivationDecisionV1(config, observation);
        yield* runSharePublish(config, decision.record.uri, {
          dryRun: false,
          preview: false,
          push: false,
          team: 'default',
        });
        const receipt = receiptThroughDecisionApply(observation.plan);
        yield* initializeActivationStateV1(config, observation.plan, receipt);
        const preview = yield* runActivationProductionUndoV1(config, observation, {apply: false});
        expect(preview.retainedOperationIds).toEqual(expect.arrayContaining(['decision-apply', 'team-share']));
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains decision and team when proposal materialized before receipt CAS', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const repository = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-proposal-repo-'});
        const remote = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-proposal-remote-'});
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-proposal-home-'});
        for (const target of [repository, remote]) {
          yield* command.execute('git', ['init', '--quiet'], {cwd: target, maxOutputBytes: 4_096, timeoutMs: 5_000});
          yield* command.execute('git', ['config', 'user.email', 'activation@example.test'], {cwd: target});
          yield* command.execute('git', ['config', 'user.name', 'Activation Test'], {cwd: target});
          yield* fs.writeFileString(path.join(target, 'README.md'), '# Activation proposal\n');
          yield* command.execute('git', ['add', 'README.md'], {cwd: target});
          yield* command.execute('git', ['commit', '--quiet', '-m', 'seed'], {cwd: target});
        }
        const config = {
          account: 'test',
          agentContextHome: home,
          agentId: 'test-agent',
          agentIdSource: 'system' as const,
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'test-user',
          userSource: 'system' as const,
        };
        yield* runShareInit(config, remote, {
          dryRun: false,
          push: false,
          setDefault: true,
          team: 'default',
        });
        const configuredTeam = (yield* readTeamsFile(config)).teams.default;
        if (configuredTeam === undefined) throw new Error('Expected configured activation team.');
        yield* prepareSharedWorktreeForCommits(configuredTeam.worktree);
        yield* command.execute('git', [
          '-C',
          configuredTeam.worktree,
          'remote',
          'set-url',
          'origin',
          'https://example.test/threadnote/proposal.git',
        ]);
        const observation = yield* observeActivationProductionV1(
          config,
          parseActivationProductionRequestV1({
            ...request,
            adrPaths: [],
            repositoryRoot: repository,
            team: {...request.team, remotePath: configuredTeam.worktree},
          }),
        );
        const review = yield* findOrCreateActivationDecisionReviewV1(config, observation);
        const candidate = onlyDecisionCandidate(review);
        yield* runCloseoutApply(config, {
          action: 'approve',
          approved: true,
          candidateId: candidate.candidateId,
          operation: 'create',
          reviewId: review.reviewId,
          revision: review.revision,
        });
        const decision = yield* readAppliedActivationDecisionV1(config, observation);
        const team = yield* observeCurrentActivationTeamV1(config, 'default');
        const built = yield* buildReviewedKnowledgeDeltaGitProposal(config, {
          approved: true,
          candidateIds: [candidate.candidateId],
          reviewId: decision.review.reviewId,
          revision: decision.review.revision,
          team: 'default',
        });
        const receipt = receiptThroughDecisionApply(observation.plan);
        yield* initializeActivationStateV1(config, observation.plan, receipt);
        yield* initializeActivationProposalEvidenceV1(
          config,
          activationProposalEvidenceInputV1(observation, decision, team, built),
        );
        const proposalDirectory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-proposal-file-'});
        const proposalPath = path.join(proposalDirectory, 'proposal.json');
        yield* fs.writeFileString(proposalPath, built.artifact);
        const materialized = yield* runKnowledgeDeltaGitProposalMaterialize(config, {
          apply: true,
          proposal: proposalPath,
          team: 'default',
        });
        expect(materialized.materialized).toBe(true);
        const preview = yield* runActivationProductionUndoV1(config, observation, {apply: false});
        expect(preview.retainedOperationIds).toEqual(expect.arrayContaining(['decision-apply', 'team-share']));
        yield* command.execute('git', [
          '-C',
          configuredTeam.worktree,
          'update-ref',
          '-d',
          `refs/heads/${built.proposal.branch.name}`,
        ]);
        const expanded = yield* runActivationProductionUndoV1(config, observation, {apply: false});
        if (!('operations' in expanded)) throw new Error('Expected an expanded activation undo preview.');
        expect(expanded.operations).toEqual(expect.arrayContaining(['decision-apply', 'team-share']));
        expect(expanded.undoPlanHash).not.toBe(preview.undoPlanHash);
        const staleApproval = yield* runActivationProductionUndoV1(config, observation, {
          apply: true,
          approval: preview.undoPlanHash,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(staleApproval)).toBe(true);
        expect((yield* readTeamsFile(config)).teams.default).toBeDefined();
        expect((yield* readAppliedActivationDecisionV1(config, observation)).record.uri).toBe(decision.record.uri);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('advances duplicate import no-actions with verified preexisting evidence', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-no-action-repo-'});
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-no-action-home-'});
        yield* command.execute('git', ['init', '--quiet'], {cwd: root, maxOutputBytes: 4_096, timeoutMs: 5_000});
        const duplicateGuidance =
          'Threadnote activation duplicate guidance requires deterministic verified no action for the same approved target.';
        yield* fs.writeFileString(path.join(root, 'AGENTS.md'), `${duplicateGuidance}\n`);
        const config = {
          account: 'test',
          agentContextHome: home,
          agentId: 'test-agent',
          agentIdSource: 'system' as const,
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'test-user',
          userSource: 'system' as const,
        };
        const observation = yield* observeActivationProductionV1(
          config,
          parseActivationProductionRequestV1({
            ...request,
            adrPaths: [],
            repositoryRoot: root,
            team: {...request.team, remotePath: root},
          }),
        );
        const importedCandidate = observation.imports.candidates[0];
        if (importedCandidate === undefined) throw new Error('Expected one activation import candidate.');
        yield* runRemember(config, {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'test',
          text: duplicateGuidance,
          topic: `activation-import-${Effect2.pipe(importedCandidate.candidateId, EffectString.slice(-24))}`,
        });
        const [review] = yield* findOrCreateActivationImportReviewsV1(config, observation);
        const candidate = onlyDecisionCandidate(review);
        expect(candidate.recommendation).toBe('no_action');
        const applied = yield* runCloseoutApply(config, {
          action: 'approve',
          approved: true,
          candidateId: candidate.candidateId,
          operation: 'create',
          reviewId: review.reviewId,
          revision: review.revision,
        });
        expect(applied.isError).not.toBe(true);
        const first = yield* readAppliedActivationImportsV1(config, observation);
        const retried = yield* readAppliedActivationImportsV1(config, observation);
        expect(first[0].candidate.recommendation).toBe('no_action');
        expect(first[0].candidate.applyTargetUri).toBeUndefined();
        expect(first[0].record.uri).toBe(retried[0].record.uri);
        expect(
          activationImportedMemoriesEvidenceHashV1(
            observation.imports.sourceSetHash,
            EffectArray.map(first, decision => decision.review),
          ),
        ).toBe(
          activationImportedMemoriesEvidenceHashV1(
            observation.imports.sourceSetHash,
            EffectArray.map(retried, decision => decision.review),
          ),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('disowns a prepared mutation when another actor creates its target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-intent-home-'});
        const config = {agentContextHome: home};
        const activationId = Effect2.pipe('a', EffectString.repeat(64));
        const targetHash = Effect2.pipe('b', EffectString.repeat(64));
        const prepared = yield* prepareActivationMutationIntentV1(config, {
          activationId,
          beforeStateHash: Effect2.pipe('c', EffectString.repeat(64)),
          operationId: 'surface-primary',
          ownership: 'activation-created',
          targetHash,
        });
        const recovered = yield* prepareActivationMutationIntentV1(config, {
          activationId,
          beforeStateHash: Effect2.pipe('d', EffectString.repeat(64)),
          operationId: 'surface-primary',
          ownership: 'preexisting',
          targetHash,
        });
        expect(prepared.phase).toBe('prepared');
        expect(recovered.phase).toBe('disowned');
        expect(recovered.ownership).toBe('preexisting');
        expect(recovered.beforeStateHash).toBe(prepared.beforeStateHash);
        expect(recovered.afterStateHash).toBe(Effect2.pipe('d', EffectString.repeat(64)));
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains created ownership only after mutation completion is durably proven', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-intent-complete-home-'});
        const config = {agentContextHome: home};
        const activationId = Effect2.pipe('e', EffectString.repeat(64));
        const targetHash = Effect2.pipe('f', EffectString.repeat(64));
        const prepared = yield* prepareActivationMutationIntentV1(config, {
          activationId,
          beforeStateHash: Effect2.pipe('0', EffectString.repeat(64)),
          operationId: 'surface-primary',
          ownership: 'activation-created',
          targetHash,
        });
        const completed = yield* completeActivationMutationIntentV1(config, {
          activationId,
          afterStateHash: Effect2.pipe('1', EffectString.repeat(64)),
          expectedRevision: prepared.revision,
          operationId: 'surface-primary',
        });
        const concurrent = yield* TestClock.withLive(
          Effect.all(
            Array.from({length: 8}, (_, index) =>
              prepareActivationMutationIntentV1(config, {
                activationId,
                beforeStateHash: Effect2.pipe((index + 2).toString(16), EffectString.padStart(64, '0')),
                operationId: 'surface-primary',
                ownership: 'preexisting',
                targetHash,
              }),
            ),
            {concurrency: 'unbounded'},
          ),
        );
        expect(completed.phase).toBe('completed');
        expect(completed.afterStateHash).toBe(Effect2.pipe('1', EffectString.repeat(64)));
        expect(EffectArray.every(concurrent, intent => intent.revision === completed.revision)).toBe(true);
        expect(EffectArray.every(concurrent, intent => intent.ownership === 'activation-created')).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function receiptThroughDecisionApply(plan: ActivationPlanV1) {
  let receipt = createActivationReceiptV1(plan, '2026-09-18T08:00:00.000Z');
  for (const operation of plan.operations) {
    const approval =
      operation.approvalKind === undefined
        ? undefined
        : bindActivationApprovalV1(plan, receipt, operation.id, Effect2.pipe('a', EffectString.repeat(64)));
    const transition = recordActivationOutcomeV1({
      approval,
      now: new Date(Date.parse(receipt.updatedAt) + 1_000).toISOString(),
      operationId: operation.id,
      outcome: {
        ownership: operation.reversible ? 'activation-created' : 'preexisting',
        status: operation.expectedOutcome,
        subsystemReceiptHash: Effect2.pipe('b', EffectString.repeat(64)),
        undoEligible: operation.reversible,
      },
      plan,
      receipt,
    });
    if (transition.status === 'conflict') throw new Error(`Could not build receipt: ${transition.code}`);
    receipt = transition.receipt;
    if (operation.kind === 'decision.apply') break;
  }
  return receipt;
}

const prepareSharedWorktreeForCommits = Effect.fn('test.activation.prepareSharedWorktreeForCommits')(function* (
  worktree: string,
) {
  const command = yield* CommandExecutor;
  yield* command.execute('git', ['-C', worktree, 'config', 'user.email', 'activation@example.test']);
  yield* command.execute('git', ['-C', worktree, 'config', 'user.name', 'Activation Test']);
  const status = yield* command.execute('git', ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all']);
  const pending = Effect2.pipe(status.stdout, EffectString.trim);
  if (pending === '') return;
  if (pending !== 'A  .gitignore') {
    throw new Error(`Unexpected dirty activation team fixture: ${pending}`);
  }
  yield* command.execute('git', [
    '-C',
    worktree,
    'commit',
    '--quiet',
    '-m',
    'share: ignore native canonical store directory summaries',
  ]);
});

function flipDigest(value: string): string {
  return `${value[0] === '0' ? '1' : '0'}${Effect2.pipe(value, EffectString.slice(1))}`;
}

function activationDecision(visibility: 'personal' | 'shared', memoryId: string): AppliedActivationDecisionV1 {
  const reviewId = 'review-0000000000000000';
  const candidateId = `${reviewId}-1`;
  const body = '# Decision\nKeep Git as the shared source of truth.';
  const content = EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      'topic: activation-decision',
      'source_agent_client: codex',
      'timestamp: 2026-09-18T00:00:00.000Z',
      `memory_id: ${memoryId}`,
      `visibility: ${visibility}`,
      'authority: user_approved',
      'trust: approved',
      ...(visibility === 'personal' ? [`candidate_id: ${candidateId}`, 'source_session_id: activation-session'] : []),
      '',
      body,
    ],
    '\n',
  );
  const uri =
    visibility === 'personal'
      ? 'threadnote://user/test/projects/threadnote/durable/activation-decision.md'
      : 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/activation-decision.md';
  const record = parseMemoryDocument(uri, content);
  if (record === undefined) throw new Error('Expected activation decision record.');
  const candidate = {
    applyBodyText: body,
    applyContentHash: sha256HexSync(
      canonicalMemoryDocumentContent(
        Effect2.pipe(content, EffectString.replace('visibility: shared', 'visibility: personal')),
      ),
    ),
    applyOperation: 'create',
    applyStage: 'written',
    applyTargetUri: 'threadnote://user/test/projects/threadnote/durable/activation-decision.md',
    candidateId,
    categories: ['decision'],
    comparison: 'new',
    confidence: 1,
    evidence: [],
    kind: 'durable',
    project: 'threadnote',
    proposedText: body,
    reason: 'test',
    recommendation: 'create',
    state: 'applied',
    topic: 'activation-decision',
  } satisfies MemoryCandidate;
  const review = {
    auditEvents: [],
    candidates: [candidate],
    codeCitations: [],
    createdAt: '2026-09-18T00:00:00.000Z',
    outcome: 'test',
    project: 'threadnote',
    reviewId,
    revision: 1,
    sourceAgentClient: 'codex',
    sourceSessionId: 'activation-session',
    task: 'test activation',
    topic: 'activation-decision',
    version: 2,
  } satisfies CandidateReview;
  return {candidate, record, review};
}
