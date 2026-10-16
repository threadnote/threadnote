import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {formatMemoryDocument, parseMemoryDocument, canonicalMemoryDocumentContent} from '@threadnote/memory/document';
import {captureConsolidationSource, reviewConsolidation, consolidationSections} from '@threadnote/memory/consolidation';
import type {TopicMaintenanceManifestV1} from '@threadnote/memory/topic-maintenance';
import {loadCandidateReview, saveCandidateReview} from '@threadnote/memory/candidate';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import type {TopicMaintenanceDraftBasisV1} from '@threadnote/memory/topic-maintenance-draft';
import {
  verifyTopicMaintenanceGitProposal,
  type TopicMaintenanceGitProposalV2,
} from '../../src/git_proposal/topic_maintenance_proposal.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerKnowledgeDeltaGitProposalTool} from '../../src/mcp/server/git_proposal.js';
import {runKnowledgeDeltaGitProposalMaterialize} from '../../src/git_proposal/commands.js';
import {expectedBranchName, verifyKnowledgeDeltaGitProposalV1} from '../../src/git_proposal/knowledge_delta.js';
import {prepareSharedInboundContentEffect, stripPersonalProvenanceForSharedPublication} from '../../src/share/core.js';
import {sharePublishEligibilityError} from '../../src/share/publish_policy.js';

describe('reviewed existing shared topic Git proposal', () => {
  effectIt.effect(
    'uses public manual review, exact preview approval and recoverable local branch without accepted writes',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-shared-topic-'});
        const sourceCwd = path.join(home, 'source');
        const shared = path.join(home, 'shared');
        const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
        for (const [cwd, remote] of [
          [sourceCwd, 'source'],
          [shared, 'shared'],
        ]) {
          yield* fs.makeDirectory(cwd, {recursive: true});
          yield* git(cwd, ['init', '--quiet']);
          yield* git(cwd, ['config', 'user.name', 'Test']);
          yield* git(cwd, ['config', 'user.email', 'test@example.invalid']);
          yield* git(cwd, ['remote', 'add', 'origin', `https://example.com/fixture/${remote}.git`]);
        }
        const source = path.join(sourceCwd, 'source.ts');
        yield* fs.writeFileString(source, 'export const timeoutSeconds = 30;\n');
        yield* git(sourceCwd, ['add', '.']);
        yield* git(sourceCwd, ['commit', '--quiet', '-m', 'original']);
        const config = {
          account: 'local',
          agentContextHome: home,
          agentId: 'test',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'tester',
        };
        yield* fs.writeFileString(
          config.manifestPath,
          `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(sourceCwd)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`,
        );
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: sourceCwd, threadnoteHome: home, ensureVectors: false});
        const [citation] = yield* captureMemoryCodeCitations(config, {callerCwd: sourceCwd, refs: ['source.ts']});
        expect(citation).toBeDefined();
        const uri = 'threadnote://user/tester/memories/shared/default/durable/projects/fixture/shared-topic.md';
        const body =
          'Keep timeout policy explicit.\n\nRequest timeout is 30 seconds.\n\nThe initial choice was recorded in the design.';
        const origin = captureConsolidationSource({
          uri: 'threadnote://user/tester/memories/shared/default/durable/projects/fixture/origin-note.md',
          content: formatMemoryDocument(
            'MEMORY',
            {
              schemaVersion: 8,
              kind: 'durable',
              status: 'active',
              project: 'fixture',
              topic: 'origin-note',
              sourceAgentClient: 'test',
              timestamp: '2026-10-16T00:00:00.000Z',
              codeCitations: [citation],
              relations: [{type: 'references', uri: 'threadnote://memory/tn_other_contract'}],
            },
            body,
          ),
        });
        const consolidated = reviewConsolidation(
          body,
          [origin],
          consolidationSections(body).map((section, fragment) => ({
            section,
            disposition: 'direct',
            supports: [{sourceUri: origin.uri, fragment, citationIds: [citation.id], relationIndexes: [0]}],
          })),
          {
            operationId: 'fixture-origin',
            cleanup: 'keep',
            cleanupShared: false,
            target: {
              kind: 'durable',
              status: 'active',
              project: 'fixture',
              topic: 'shared-topic',
              sourceAgentClient: 'test',
            },
          },
        );
        const base = parseMemoryDocument(
          uri,
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'active',
              schemaVersion: 8,
              memoryId: 'tn_shared_topic',
              project: 'fixture',
              topic: 'shared-topic',
              sourceAgentClient: 'test',
              sourceSessionId: 'session-original',
              timestamp: '2026-10-16T00:00:00.000Z',
              visibility: 'shared',
              authority: 'user_approved',
              trust: 'approved',
              owner: 'design-team',
              workspaceScope: 'apps/api',
              validFrom: '2026-10-01',
              reviewAfter: '2026-12-01',
              references: ['threadnote://memory/tn_reference'],
              codeCitations: consolidated.codeCitations,
              relations: consolidated.relations,
              consolidation: consolidated.provenance,
            },
            body,
          ),
        )!;
        // Synthetic existing shared enrollment; the live enrollment API deliberately stays personal-only.
        const manifest: TopicMaintenanceManifestV1 = {
          version: 1,
          memoryId: 'tn_shared_topic',
          repositoryId: citation.repositoryId,
          bodyHash: sha256HexSync(body),
          coverage: 'declared-only',
          paragraphs: (['normative', 'descriptive', 'historical'] as const).map((role, ordinal) => ({
            ordinal,
            hash: sha256HexSync(consolidationSections(body)[ordinal]),
            role,
            support: 'direct',
            citationIds: [citation.id],
            scope: 'fixture',
          })),
          additionalDependencies: [],
        };
        const enrolled = {
          content: formatMemoryDocument(
            'MEMORY',
            {...base.metadata, schemaVersion: 10, topicMaintenance: manifest},
            body,
          ),
        };
        const targetPath = 'durable/projects/fixture/shared-topic.md';
        const target = path.join(shared, targetPath);
        yield* fs.makeDirectory(path.dirname(target), {recursive: true});
        const accepted = `${enrolled.content.replace('\n\n', '\nx_contract: preserve this exact header\n\n')}\n\n`;
        yield* fs.writeFileString(target, accepted);
        yield* git(shared, ['add', '.']);
        yield* git(shared, ['commit', '--quiet', '-m', 'accepted shared topic']);
        const baseCommit = (yield* git(shared, ['rev-parse', 'HEAD'])).stdout.trim();
        const shareDirectory = path.join(home, 'share');
        const teamsPath = path.join(shareDirectory, 'teams.json');
        yield* fs.makeDirectory(shareDirectory);
        const teams = {
          version: 1,
          defaultTeam: 'default',
          teams: {
            default: {
              name: 'default',
              access: 'read-write',
              addedAt: '2026-10-16T00:00:00.000Z',
              remote: 'fixture',
              gitdir: path.join(shared, '.git'),
              worktree: shared,
            },
          },
        };
        yield* fs.writeFileString(teamsPath, JSON.stringify(teams));
        yield* fs.writeFileString(source, 'export const timeoutSeconds = 60;\n');
        yield* git(sourceCwd, ['add', '.']);
        yield* git(sourceCwd, ['commit', '--quiet', '-m', 'updated source']);
        yield* indexer.index({cwd: sourceCwd, threadnoteHome: home, ensureVectors: false});
        const binary = system.environment().THREADNOTE_E2E_BINARY;
        const executable = binary ?? system.executablePath;
        const prefix = binary ? [] : [path.join(system.currentDirectory(), 'apps/threadnote/src/standalone.ts')];
        const cli = (args: readonly string[]) =>
          runCommandEffect(executable, [...prefix, ...args], {
            cwd: sourceCwd,
            env: {
              ...system.environment(),
              NO_COLOR: '1',
              THREADNOTE_HOME: home,
              THREADNOTE_USER: 'tester',
              THREADNOTE_MANIFEST: config.manifestPath,
            },
            timeoutMs: 60_000,
            maxOutputBytes: 1024 * 1024,
          });
        const topicArgs = ['share', 'topic-propose', '--uri', uri, '--source-cwd', sourceCwd];
        const packet = JSON.parse((yield* cli(topicArgs)).stdout) as {basis: TopicMaintenanceDraftBasisV1};
        const basis = packet.basis;
        const draft = {
          version: 1,
          targetHash: basis.targetHash,
          observationRevision: basis.observationRevision,
          packetDigest: basis.packetDigest,
          outcome: 'propose-update',
          operations: [
            {
              ordinal: 1,
              beforeHash: basis.paragraphs[1].hash,
              text: 'Request timeout is 60 seconds.',
              supportHandles: [`current:${citation.id}`],
              rationale: 'The committed source sets 60.',
            },
          ],
          reviewedHandles: [],
          rationale: 'Update only the descriptive fact.',
          unresolvedQuestions: [],
          removedClaims: [],
        };
        const draftFile = path.join(home, 'draft.json');
        yield* fs.writeFileString(draftFile, JSON.stringify(draft));
        const manual = JSON.parse((yield* cli([...topicArgs, '--draft-file', draftFile])).stdout);
        expect(manual).toMatchObject({
          origin: 'manual',
          modelCalls: 0,
          review: {maintenance: {generation: {origin: 'manual', attempts: 0}}, candidates: [{state: 'pending'}]},
        });
        const review = yield* loadCandidateReview(home, manual.review.reviewId);
        const preview = review.maintenanceApproval!.preview;
        const final = parseMemoryDocument(uri, preview.content)!;
        expect(final.metadata).toMatchObject({
          memoryId: 'tn_shared_topic',
          visibility: 'shared',
          owner: 'design-team',
          workspaceScope: 'apps/api',
          sourceSessionId: 'session-original',
          authority: 'user_approved',
          trust: 'approved',
        });
        expect(final.metadata.relations).toEqual(base.metadata.relations);
        expect(final.metadata.references).toEqual(base.metadata.references);
        expect(final.metadata.consolidation).toMatchObject({
          version: 2,
          origin: base.metadata.consolidation,
          originBody: body,
        });
        expect(final.metadata.codeCitations).toContainEqual(citation);
        expect(final.metadata.codeCitations).toHaveLength(2);
        expect(final.body).toBe(body.replace('30 seconds', '60 seconds'));
        expect(preview.content).toContain('x_contract: preserve this exact header');
        for (const variant of [
          preview.content,
          preview.content.replace('topic_maintenance:', ' \n\t \ntopic_maintenance:'),
        ])
          expect(yield* prepareSharedInboundContentEffect(uri, variant)).toBe(variant);
        expect(() => stripPersonalProvenanceForSharedPublication(accepted)).toThrow(
          /reviewed existing-target Git proposal/,
        );
        expect(sharePublishEligibilityError(config, uri.replace('/shared/default', ''), accepted)).toContain(
          'reviewed existing-target Git proposal',
        );
        const exportArgs = [
          'share',
          'propose',
          '--review-id',
          review.reviewId,
          '--revision',
          String(review.revision),
          '--source-cwd',
          sourceCwd,
        ];
        const artifact = JSON.parse((yield* cli(exportArgs)).stdout) as TopicMaintenanceGitProposalV2;
        verifyTopicMaintenanceGitProposal(artifact);
        const mcp = new EffectMcpServerAdapter('shared-topic-test', '1', 'Shared topic proposal test');
        registerKnowledgeDeltaGitProposalTool(mcp, config);
        const mcpPacket = yield* mcp.invokeTool('share_topic_propose', {uri, sourceCwd});
        expect(mcpPacket.isError).not.toBe(true);
        const mcpPreview = yield* mcp.invokeTool('share_propose', {
          reviewId: review.reviewId,
          revision: review.revision,
          sourceCwd,
        });
        expect(mcpPreview.isError).not.toBe(true);
        expect(mcpPreview.structuredContent).toEqual(artifact);
        const mcpApproved = yield* mcp.invokeTool('share_propose', {
          reviewId: review.reviewId,
          revision: review.revision,
          sourceCwd,
          approved: true,
          approvalDigest: artifact.proposalHash,
        });
        expect(mcpApproved.isError).not.toBe(true);
        expect(mcpApproved.structuredContent).toEqual(artifact);
        expect(artifact.version).toBe(2);
        expect(artifact.files[0].targetPrecondition).toMatchObject({
          expectedContentHash: sha256HexSync(accepted),
          expectedMemoryId: 'tn_shared_topic',
        });
        expect(artifact.maintenance.beforeCanonicalHash).toBe(sha256HexSync(canonicalMemoryDocumentContent(accepted)));
        expect(artifact.files[0].targetPrecondition).not.toMatchObject({
          expectedContentHash: artifact.maintenance.beforeCanonicalHash,
        });
        expect(artifact.files[0].content).toBe(preview.content);
        const expectFailure = (args: readonly string[], message: string) =>
          cli(args).pipe(
            Effect.result,
            Effect.map(result => {
              expect(result._tag, `Expected failure containing ${message}`).toBe('Failure');
              if (result._tag === 'Failure') expect(String(result.failure)).toContain(message);
            }),
          );
        yield* expectFailure([...exportArgs, '--approved'], 'proposalHash');
        yield* expectFailure([...exportArgs, '--approved', '--approval-digest', 'f'.repeat(64)], 'proposalHash');
        yield* expectFailure(
          exportArgs.map((value, index) =>
            exportArgs[index - 1] === '--revision' ? String(review.revision + 1) : value,
          ),
          'revision',
        );
        const proposalFile = path.join(home, 'proposal.json');
        yield* cli([...exportArgs, '--approved', '--approval-digest', artifact.proposalHash, '--output', proposalFile]);
        expect(JSON.parse(yield* fs.readFileString(proposalFile))).toEqual(artifact);
        const materialize = ['share', 'materialize', '--proposal', proposalFile, '--source-cwd', sourceCwd];
        yield* expectFailure([...materialize, '--apply'], 'approvalDigest');
        expect(JSON.parse((yield* cli(materialize)).stdout)).toMatchObject({
          outcome: 'preview',
          proposalHash: artifact.proposalHash,
        });
        const first = JSON.parse(
          (yield* cli([...materialize, '--apply', '--approval-digest', artifact.proposalHash])).stdout,
        );
        const recovered = JSON.parse(
          (yield* cli([...materialize, '--apply', '--approval-digest', artifact.proposalHash])).stdout,
        );
        expect(first.outcome).toBe('applied');
        expect(recovered).toMatchObject({outcome: 'reused', commit: first.commit});
        expect((yield* git(shared, ['show', `${first.commit}:${targetPath}`])).stdout).toBe(preview.content);
        expect((yield* git(shared, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(baseCommit);
        expect((yield* git(shared, ['status', '--porcelain'])).stdout).toBe('');
        expect(yield* fs.readFileString(target)).toBe(accepted);
        expect(
          yield* fs.exists(path.join(home, 'data/local/user/tester/memories/durable/projects/fixture/shared-topic.md')),
        ).toBe(false);
        expect((yield* loadCandidateReview(home, review.reviewId)).candidates[0].state).toBe('pending');

        const directFailure = (message: string) =>
          runKnowledgeDeltaGitProposalMaterialize(config, {proposal: proposalFile, sourceCwd}).pipe(
            Effect.result,
            Effect.map(result => {
              expect(result._tag).toBe('Failure');
              if (result._tag === 'Failure') expect(String(result.failure)).toContain(message);
            }),
          );
        // A coherently rehashed metadata edit still cannot replace the assembled, privately reviewed document.
        const changedContent = artifact.files[0].content.replace('x_contract: preserve', 'x_contract: injected');
        const changedBinding = {
          ...artifact,
          files: [{...artifact.files[0], content: changedContent, contentHash: sha256HexSync(changedContent)}],
        };
        const {proposalHash: _changedHash, ...changedUnsigned} = {
          ...changedBinding,
          branch: {name: expectedBranchName(changedBinding)},
        };
        const editedMetadata = {...changedUnsigned, proposalHash: sha256HexSync(canonicalJson(changedUnsigned))};
        verifyTopicMaintenanceGitProposal(editedMetadata);
        yield* fs.writeFileString(proposalFile, canonicalJson(editedMetadata));
        yield* directFailure('changed');
        yield* fs.writeFileString(proposalFile, canonicalJson(artifact));
        yield* git(shared, ['update-ref', `refs/heads/${artifact.branch.name}`, baseCommit]);
        yield* directFailure('conflicts');
        yield* git(shared, ['update-ref', `refs/heads/${artifact.branch.name}`, first.commit]);
        const reviewPath = path.join(home, 'threadnote/candidates/v1/reviews', `${review.reviewId}.json`);
        const reviewBytes = yield* fs.readFileString(reviewPath);
        yield* fs.writeFileString(reviewPath, '{corrupt');
        yield* directFailure('review');
        yield* fs.writeFileString(reviewPath, reviewBytes);
        // A V1 downgrade must not skip maintenance source/policy checks, even with a legacy-shaped review identity.
        const legacyReviewId = 'review-0123456789abcdef';
        const {maintenance: _receipt, version: _version, ...legacyFields} = artifact;
        const downgraded = {
          ...legacyFields,
          version: 1 as const,
          knowledgeDelta: {...artifact.knowledgeDelta, reviewId: legacyReviewId},
          files: [
            {
              ...artifact.files[0],
              approval: {...artifact.files[0].approval, reviewId: legacyReviewId, candidateId: `${legacyReviewId}-1`},
            },
          ],
          commit: {message: `threadnote: propose fixture knowledge delta ${legacyReviewId}`},
        };
        const {proposalHash: _legacyHash, ...legacyUnsigned} = {
          ...downgraded,
          branch: {name: expectedBranchName(downgraded)},
        };
        expect(() =>
          verifyKnowledgeDeltaGitProposalV1({
            ...legacyUnsigned,
            proposalHash: sha256HexSync(canonicalJson(legacyUnsigned)),
          }),
        ).toThrow(/maintenance variant/);

        // Hash mutation property covers the portable artifact boundary independently of filesystem validation.
        yield* Effect.sync(() =>
          fc.assert(
            fc.property(fc.integer({min: 0, max: 63}), offset => {
              const mutated = structuredClone(artifact);
              const chars = [...mutated.maintenance.sourceVectorHash];
              chars[offset] = chars[offset] === 'a' ? 'b' : 'a';
              const altered = {...mutated, maintenance: {...mutated.maintenance, sourceVectorHash: chars.join('')}};
              expect(() => verifyTopicMaintenanceGitProposal(altered)).toThrow();
            }),
            {numRuns: 16},
          ),
        );

        yield* fs.writeFileString(
          teamsPath,
          JSON.stringify({...teams, teams: {default: {...teams.teams.default, access: 'read-only'}}}),
        );
        yield* expectFailure(materialize, 'read-only');
        yield* fs.writeFileString(teamsPath, JSON.stringify(teams));
        yield* git(shared, ['checkout', '--quiet', '-b', 'other-branch']);
        yield* expectFailure(materialize, 'changed');
        yield* git(shared, ['checkout', '--quiet', '-']);
        yield* fs.writeFileString(source, 'export const timeoutSeconds = 90;\n');
        yield* expectFailure(materialize, 'source');
        yield* git(sourceCwd, ['checkout', '--', 'source.ts']);
        yield* fs.writeFileString(target, accepted.replace('x_contract: preserve', 'x_contract: changed'));
        yield* expectFailure(materialize, 'clean');
        yield* git(shared, ['checkout', '--', targetPath]);
        yield* git(shared, ['commit', '--quiet', '--allow-empty', '-m', 'advanced base']);
        yield* expectFailure(materialize, 'changed');
        yield* git(shared, ['reset', '--hard', baseCommit]);
        const staleReview = {...review, revision: review.revision + 1, maintenanceApproval: undefined};
        yield* saveCandidateReview(home, staleReview);
        yield* expectFailure(materialize, 'revision');
        yield* saveCandidateReview(home, review);
        yield* fs.writeFileString(proposalFile, canonicalJson({...artifact, proposalHash: '0'.repeat(64)}));
        yield* expectFailure(materialize, 'hash');
        expect(yield* fs.readFileString(target)).toBe(accepted);
        expect((yield* git(shared, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(baseCommit);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    {timeout: 120_000},
  );
});
