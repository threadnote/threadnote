import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {Effect, FileSystem, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {EffectMcpServerAdapter} from '@threadnote/threadnote/effect/ai/mcp';
import type {ManagerTopicReviewV1} from '@threadnote/manager/attention/topic-contracts';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {proposeTopicMaintenanceEnrollment} from '@threadnote/memory/topic-maintenance';
import {parseTopicMaintenanceDraft} from '@threadnote/memory/topic-maintenance-draft';
import {
  candidateReviewWithState,
  loadCandidateReview,
  saveCandidateReview,
  type CandidateReview,
} from '@threadnote/memory/candidate';
import {
  runContextMaintenance,
  readContextMaintenancePacket,
  readContextMaintenanceStatus,
} from '../../src/memory/context/maintenance.js';
import {
  basisFromPacket,
  privateReview,
  readyEvidence,
  requestTopicMaintenanceDraft,
  reviewEvidenceFromPacket,
} from '../../src/memory/context/maintenance_draft.js';
import {
  applyTopicMaintenanceReview,
  prepareTopicMaintenanceReview,
} from '../../src/memory/context/maintenance_review.js';
import type {runSelectedDraft} from '../../src/manager/selected_draft.js';
import {projectManagerTopicReview} from '../../src/manager/topic_review.js';
import {handleManagerTopicReview} from '../../src/manager/topic_review.js';
import {registerContextMaintenanceTools} from '../../src/mcp/server/context/maintenance.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('reviewed personal topic acceptance', () => {
  effectIt.effect(
    'prepares exact bytes, rejects source races, and applies once with restart-safe receipt',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'topic-review-'});
          const repository = path.join(home, 'repository');
          yield* fs.makeDirectory(repository);
          const source = path.join(repository, 'source.ts');
          yield* fs.writeFileString(source, 'export const requestTimeoutSeconds = 30;\n');
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
          yield* git(['init', '--quiet']);
          yield* commit('initial');
          const config = {
            account: 'local',
            agentContextHome: home,
            agentId: 'test',
            manifestPath: path.join(home, 'manifest.yaml'),
            user: 'tester',
          };
          yield* fs.writeFileString(
            config.manifestPath,
            `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`,
          );
          const index = () =>
            CodeGraphIndexer.pipe(
              Effect.flatMap(indexer => indexer.index({cwd: repository, threadnoteHome: home, ensureVectors: false})),
            );
          yield* index();
          const [citation] = yield* captureMemoryCodeCitations(config, {callerCwd: repository, refs: ['source.ts']});
          const uri = 'threadnote://user/tester/memories/durable/projects/fixture/timeout.md';
          const base = parseMemoryDocument(
            uri,
            formatMemoryDocument(
              'MEMORY',
              {
                kind: 'durable',
                status: 'active',
                schemaVersion: 8,
                memoryId: 'tn_timeout',
                project: 'fixture',
                topic: 'timeout',
                sourceAgentClient: 'test',
                timestamp: '2026-10-16T00:00:00.000Z',
                codeCitations: [citation],
              },
              'Request timeout is 30 seconds.\n\nA request times out after 30 seconds.',
            ),
          )!;
          const enrolled = proposeTopicMaintenanceEnrollment(base, {
            paragraphs: [
              {role: 'descriptive', support: 'direct', citationIds: [citation.id]},
              {role: 'descriptive', support: 'direct', citationIds: [citation.id]},
            ],
            additionalDependencies: [],
          });
          const memory = path.join(home, 'data/local/user/tester/memories/durable/projects/fixture/timeout.md');
          yield* fs.makeDirectory(path.dirname(memory), {recursive: true});
          yield* fs.writeFileString(memory, enrolled.content);
          const accepted = yield* fs.readFileString(memory);
          for (let tick = 0; tick < 8; tick++) yield* runContextMaintenance(config, {cwd: repository});
          yield* fs.writeFileString(source, 'export const requestTimeoutSeconds = 60;\n');
          yield* commit('changed');
          yield* index();
          let caseId = '';
          for (let tick = 0; tick < 12; tick++) {
            yield* runContextMaintenance(config, {cwd: repository});
            const state = JSON.parse(yield* fs.readFileString(path.join(home, 'context-maintenance/state-v2.json')));
            const item = state.cases.find((entry: {family: string}) => entry.family === 'topic-maintenance');
            if (item?.disposition === 'needs-decision') {
              caseId = item.caseId;
              break;
            }
          }
          expect(caseId).not.toBe('');
          const packet = readyEvidence(yield* readContextMaintenancePacket(config, caseId));
          const basis = basisFromPacket(packet);
          const proposal = parseTopicMaintenanceDraft(
            basis,
            JSON.stringify({
              version: 1,
              targetHash: basis.targetHash,
              observationRevision: basis.observationRevision,
              packetDigest: basis.packetDigest,
              outcome: 'propose-update',
              operations: [
                {
                  ordinal: 0,
                  beforeHash: basis.paragraphs[0].hash,
                  text: 'Request timeout is 60 seconds.',
                  supportHandles: [`current:${citation.id}`],
                  rationale: 'Current source declares 60 seconds.',
                },
                {
                  ordinal: 1,
                  beforeHash: basis.paragraphs[1].hash,
                  text: 'A request times out after 60 seconds.',
                  supportHandles: [`current:${citation.id}`],
                  rationale: 'Current source declares 60 seconds.',
                },
              ],
              reviewedHandles: [`current:${citation.id}`],
              rationale: 'Update the descriptive timeout.',
              unresolvedQuestions: [],
              removedClaims: ['Request timeout is 30 seconds.', 'A request times out after 30 seconds.'],
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
                origin: 'model',
                agent: 'local-ai',
                model: 'fixture-model',
                promptVersion: 'fixture-topic-v1',
                attempts: 1,
                usage: {status: 'unavailable'},
              },
            },
            'fixture',
            'timeout',
            [],
            '2026-10-16T00:00:00.000Z',
          );
          yield* saveCandidateReview(home, review);
          const invalidEdit = yield* prepareTopicMaintenanceReview(config, {
            reviewId: review.reviewId,
            revision: review.revision,
            sourceCwd: repository,
            editedDraftJson: '{}',
          }).pipe(Effect.result);
          expect(Result.isFailure(invalidEdit)).toBe(true);
          expect((yield* loadCandidateReview(home, review.reviewId)).revision).toBe(review.revision);
          const system = yield* SystemInfo;
          const binary = system.environment().THREADNOTE_E2E_BINARY;
          const executable = binary ?? system.executablePath;
          const prefix = binary ? [] : [path.join(system.currentDirectory(), 'apps/threadnote/src/standalone.ts')];
          const cli = (args: readonly string[]) =>
            runCommandEffect(executable, [...prefix, 'context', 'maintain', ...args], {
              cwd: repository,
              env: {
                ...system.environment(),
                THREADNOTE_HOME: home,
                THREADNOTE_USER: config.user,
                THREADNOTE_MANIFEST: config.manifestPath,
                NO_COLOR: '1',
              },
              timeoutMs: 60_000,
            });
          const editedDraftFile = path.join(home, 'edited-draft.json');
          yield* fs.writeFileString(
            editedDraftFile,
            JSON.stringify({
              ...proposal.draft,
              operations: proposal.draft.operations.map((operation, index) =>
                index === 0 ? {...operation, text: 'The request timeout is 60 seconds.'} : operation,
              ),
              rationale: 'Reviewed the same evidence and approved this exact replacement.',
            }),
          );
          let previewReview = JSON.parse(
            (yield* cli([
              '--action',
              'draft-preview',
              '--review-id',
              review.reviewId,
              '--revision',
              String(review.revision),
              '--source-cwd',
              repository,
              '--edited-draft-file',
              editedDraftFile,
              '--json',
            ])).stdout,
          ) as CandidateReview;
          const firstProjected = projectManagerTopicReview(previewReview)!;
          expect(firstProjected.draft.operations[0]?.text).toBe('The request timeout is 60 seconds.');
          const secondEditedDraft = {
            ...firstProjected.draft,
            operations: firstProjected.draft.operations.map((operation, index) =>
              index === 1 ? {...operation, text: 'Requests time out after 60 seconds.'} : operation,
            ),
          };
          previewReview = yield* prepareTopicMaintenanceReview(config, {
            reviewId: review.reviewId,
            revision: previewReview.revision,
            sourceCwd: repository,
            editedDraftJson: JSON.stringify(secondEditedDraft),
          });
          const secondProjected = projectManagerTopicReview(previewReview)!;
          expect(secondProjected.draft.operations.map(operation => operation.text)).toEqual([
            'The request timeout is 60 seconds.',
            'Requests time out after 60 seconds.',
          ]);
          expect(secondProjected.proposal.body).toBe(
            'The request timeout is 60 seconds.\n\nRequests time out after 60 seconds.',
          );
          const preview = previewReview.maintenanceApproval!.preview;
          expect(preview.approvedProposal.draft.rationale).toBe(
            'Reviewed the same evidence and approved this exact replacement.',
          );
          expect(previewReview.maintenance?.proposal.draft.rationale).toBe(proposal.draft.rationale);
          type ToolResult = {readonly isError?: boolean; readonly structuredContent?: ManagerTopicReviewV1};
          const handlers = new Map<string, (input: Record<string, unknown>) => Effect.Effect<ToolResult>>();
          const server = {
            registerTool: (name: string, _definition: unknown, handle: unknown) => {
              handlers.set(name, handle as (input: Record<string, unknown>) => Effect.Effect<ToolResult>);
            },
          } as unknown as EffectMcpServerAdapter;
          registerContextMaintenanceTools(server, config);
          const reviewTool = (input: Record<string, unknown>) => handlers.get('context_maintenance_review')!(input);
          expect((yield* reviewTool({action: 'view', reviewId: review.reviewId})).structuredContent?.revision).toBe(
            previewReview.revision,
          );
          expect(preview.beforeContent).toBe(accepted);
          expect(preview.content).toContain('The request timeout is 60 seconds.');
          expect(preview.content).toContain('Requests time out after 60 seconds.');
          expect(preview.manifest.version).toBe(2);
          expect(yield* fs.readFileString(memory)).toBe(accepted);
          const apply = () =>
            applyTopicMaintenanceReview(config, {
              reviewId: review.reviewId,
              revision: previewReview.revision,
              sourceCwd: repository,
              approvalDigest: preview.approvalDigest,
              approved: true,
            });
          const wrongDigest = yield* reviewTool({
            action: 'apply',
            reviewId: review.reviewId,
            revision: previewReview.revision,
            sourceCwd: repository,
            approvalDigest: 'f'.repeat(64),
            approved: true,
          });
          expect(wrongDigest.isError).toBe(true);
          yield* fs.writeFileString(memory, accepted.replace('topic: timeout', 'topic: renamed-timeout'));
          expect(Result.isFailure(yield* apply().pipe(Effect.result))).toBe(true);
          expect(yield* fs.readFileString(memory)).toContain('topic: renamed-timeout');
          yield* fs.writeFileString(memory, accepted);
          yield* fs.writeFileString(source, 'export const requestTimeoutSeconds = 90;\n');
          yield* commit('raced');
          yield* index();
          expect(Result.isFailure(yield* apply().pipe(Effect.result))).toBe(true);
          expect(yield* fs.readFileString(memory)).toBe(accepted);
          yield* fs.writeFileString(source, 'export const requestTimeoutSeconds = 60;\n');
          yield* commit('restored');
          yield* index();
          const managerApply = () =>
            handleManagerTopicReview({
              config,
              method: 'POST',
              url: new URL('http://manager.test/api/attention/topic-review'),
              body: Effect.succeed({
                action: 'apply',
                project: 'fixture',
                reviewId: review.reviewId,
                revision: previewReview.revision,
                approvalDigest: preview.approvalDigest,
                approved: true,
              }),
            });
          const preparedBeforeWrite = candidateReviewWithState(
            previewReview,
            previewReview.candidates[0].candidateId,
            'applying',
          );
          yield* saveCandidateReview(home, {
            ...preparedBeforeWrite,
            maintenanceApproval: {...previewReview.maintenanceApproval!, stage: 'prepared'},
          });
          expect(projectManagerTopicReview(preparedBeforeWrite)?.revision).toBe(previewReview.revision + 1);
          expect(
            projectManagerTopicReview({
              ...preparedBeforeWrite,
              maintenanceApproval: {...previewReview.maintenanceApproval!, stage: 'prepared'},
            })?.canApply,
          ).toBe(true);
          const managerBeforeWrite = yield* managerApply();
          expect(managerBeforeWrite?.status).toBe(200);
          expect(managerBeforeWrite?.body).toMatchObject({state: 'applied', approval: {stage: 'written'}});
          const applied = JSON.parse(
            (yield* cli([
              '--action',
              'draft-apply',
              '--review-id',
              review.reviewId,
              '--revision',
              String(previewReview.revision),
              '--approval-digest',
              preview.approvalDigest,
              '--source-cwd',
              repository,
              '--approved',
              '--json',
            ])).stdout,
          ) as CandidateReview;
          expect(applied.candidates[0].state).toBe('applied');
          expect(applied.maintenanceApproval?.stage).toBe('written');
          expect(
            (yield* reviewTool({action: 'view', reviewId: review.reviewId})).structuredContent?.approval?.stage,
          ).toBe('written');
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
          const replay = yield* apply();
          expect(replay.revision).toBe(applied.revision);
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
          const preparedAgain = candidateReviewWithState(applied, applied.candidates[0].candidateId, 'applying');
          yield* saveCandidateReview(home, {
            ...preparedAgain,
            maintenanceApproval: {...applied.maintenanceApproval!, stage: 'prepared'},
          });
          const managerAfterWrite = yield* managerApply();
          expect(managerAfterWrite?.status).toBe(200);
          expect(managerAfterWrite?.body).toMatchObject({state: 'applied', approval: {stage: 'written'}});
          const recovered = yield* loadCandidateReview(home, review.reviewId);
          expect(recovered.candidates[0].state).toBe('applied');
          expect(recovered.maintenanceApproval?.stage).toBe('written');
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
          const preparedWithDrift = candidateReviewWithState(
            recovered,
            recovered.candidates[0].candidateId,
            'applying',
          );
          yield* saveCandidateReview(home, {
            ...preparedWithDrift,
            maintenanceApproval: {...recovered.maintenanceApproval!, stage: 'prepared'},
          });
          yield* fs.writeFileString(source, 'export const requestTimeoutSeconds = 90;\n');
          yield* commit('post-write-race');
          yield* index();
          expect(Result.isFailure(yield* apply().pipe(Effect.result))).toBe(true);
          const conflicted = yield* loadCandidateReview(home, review.reviewId);
          expect(conflicted.maintenanceApproval?.stage).toBe('conflict');
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
          let newerCase = (yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0];
          for (let tick = 0; tick < 12 && newerCase?.evidenceRevision === basis.observationRevision; tick++) {
            yield* runContextMaintenance(config, {cwd: repository});
            newerCase = (yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0];
          }
          expect(newerCase?.disposition).toBe('needs-decision');
          expect(newerCase?.evidenceRevision).not.toBe(basis.observationRevision);
          const conflictView = yield* handleManagerTopicReview({
            config,
            method: 'GET',
            url: new URL(`http://manager.test/api/attention/topic-review?project=fixture&reviewId=${review.reviewId}`),
            body: Effect.succeed({}),
          });
          expect(conflictView?.status).toBe(200);
          expect(conflictView?.body).toMatchObject({
            state: 'conflict',
            caseId,
            caseObservationMatches: false,
            canApply: false,
          });
          const projectedCaseId = (conflictView!.body as ManagerTopicReviewV1).caseId;
          const closedResponse = yield* handleManagerTopicReview({
            config,
            method: 'POST',
            url: new URL('http://manager.test/api/attention/topic-review'),
            body: Effect.succeed({
              action: 'reject',
              project: 'fixture',
              reviewId: review.reviewId,
              revision: conflicted.revision,
              caseId: projectedCaseId,
            }),
          });
          expect(closedResponse?.status).toBe(200);
          const closed = yield* loadCandidateReview(home, review.reviewId);
          expect(closed.candidates[0].state).toBe('rejected');
          expect(closed.maintenanceApproval).toEqual(conflicted.maintenanceApproval);
          expect(closed.maintenanceClosedConflict).toMatchObject({
            version: 1,
            reviewRevision: previewReview.revision,
            targetUri: uri,
            beforeContentHash: preview.beforeContentHash,
            contentHash: preview.contentHash,
            approvalDigest: preview.approvalDigest,
          });
          expect(closed.auditEvents.slice(-2).map(event => event.action)).toEqual(['conflict', 'reject']);
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
          expect(Result.isFailure(yield* apply().pipe(Effect.result))).toBe(true);
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
          const generator: typeof runSelectedDraft = (_config, _agent, _model, prompt) =>
            Effect.sync(() => {
              const identity = JSON.parse(/^Identity: (.+)$/mu.exec(prompt)![1]);
              const evidence = JSON.parse(/^Packet: (.+)$/mu.exec(prompt)![1]);
              const draft = {
                version: 1,
                targetHash: identity.targetHash,
                observationRevision: identity.observationRevision,
                packetDigest: identity.packetDigest,
                outcome: 'propose-update',
                operations: [
                  {
                    ordinal: 0,
                    beforeHash: evidence.paragraphs[0].hash,
                    text: 'Request timeout is 90 seconds.',
                    supportHandles: [`current:${evidence.sources[0].citationId}`],
                    rationale: 'The current source declares 90 seconds.',
                  },
                ],
                reviewedHandles: [`current:${evidence.sources[0].citationId}`],
                rationale: 'Replace the descriptive timeout.',
                unresolvedQuestions: [],
                removedClaims: ['Request timeout is 60 seconds.'],
              };
              return {
                text: JSON.stringify(draft),
                backendIdentity: 'local-ai',
                modelIdentity: modelId,
                modelVersion: `${manifest.revision}:${manifest.sha256}`,
                usage: {status: 'unavailable' as const},
                settings: {maxOutputTokens: 4000 as const, seed: 0 as const},
              };
            });
          const fresh = yield* requestTopicMaintenanceDraft(
            config,
            {caseId, backend: 'local-ai', modelId},
            generator,
          ).pipe(Effect.provideService(LocalModelStore, installed));
          expect(fresh.revision).toBeGreaterThan(closed.revision);
          expect(fresh.candidates[0].state).toBe('pending');
          expect(fresh.maintenanceApproval).toBeUndefined();
          expect(fresh.maintenanceClosedConflict).toEqual(closed.maintenanceClosedConflict);
          expect(fresh.auditEvents.map(event => event.action)).toContain('conflict');
          expect((yield* loadCandidateReview(home, review.reviewId)).maintenanceClosedConflict).toEqual(
            closed.maintenanceClosedConflict,
          );
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
        }),
      ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    90_000,
  );
});
