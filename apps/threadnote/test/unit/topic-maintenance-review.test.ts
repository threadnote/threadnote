import {Array as EffectArray} from 'effect';
import {pipe as EffectArrayPipe} from 'effect';

import {localDraftGenerationSettings} from '../../src/effect/ai/consolidator.js';
import {makeTopicDraftWireFixture, topicDraftEvidenceFromPrompt} from '../helpers/topic-draft-wire.js';
import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {Effect, FileSystem, Path, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
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
  parseCandidateReview,
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
  decideTopicMaintenanceReview,
  prepareTopicMaintenanceReview,
  TopicReviewError,
} from '../../src/memory/context/maintenance_review.js';
import type {runSelectedDraft} from '../../src/manager/selected_draft.js';
import {projectManagerTopicReview} from '../../src/manager/topic_review.js';
import {handleManagerTopicReview} from '../../src/manager/topic_review.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeManagerTopicReviewCase = Schema.decodeUnknownSync(
  Schema.StructWithRest(Schema.Struct({caseId: Schema.String}), [JsonRecordSchema]),
);
const decodeReviewToolView = Schema.decodeUnknownSync(
  Schema.StructWithRest(
    Schema.Struct({
      revision: Schema.optionalKey(Schema.Finite),
      approval: Schema.optionalKey(
        Schema.StructWithRest(Schema.Struct({stage: Schema.optionalKey(Schema.String)}), [JsonRecordSchema]),
      ),
    }),
    [JsonRecordSchema],
  ),
);

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
          if (packet.version !== 1) throw new Error('Expected code packet fixture.');
          const basis = basisFromPacket(packet);
          const proposal = parseTopicMaintenanceDraft(
            basis,
            JSON.stringify({
              version: 1,
              targetHash: basis.targetHash,
              observationRevision: basis.observationRevision,
              packetDigest: basis.packetDigest,
              outcome: 'propose-update',
              paragraphDispositions: {
                version: 1,
                entries: EffectArray.map(
                  EffectArrayPipe(basis.paragraphs, __effectFilterValues =>
                    EffectArray.filter(
                      __effectFilterValues,
                      (item, __effectFilterIndex) =>
                        __effectFilterIndex in __effectFilterValues &&
                        item.role === 'descriptive' &&
                        item.support === 'direct',
                    ),
                  ),
                  item => ({
                    ordinal: item.ordinal,
                    beforeHash: item.hash,
                    disposition: 'update',
                    supportHandles: [`current:${citation.id}`],
                    rationale: 'Current source declares 60 seconds.',
                  }),
                ),
              },
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
                agent: 'fixture',
                model: 'deterministic-topic-fixture',
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
          const commandTrace: {args: readonly string[]; exitCode: number; stdout: string; stderr: string}[] = [];
          const tracePath = system.environment().THREADNOTE_TOPIC_REVIEW_TRACE;
          const recordCommand = (args: readonly string[], result: (typeof commandTrace)[number]) =>
            Effect.gen(function* () {
              commandTrace.push({...result, args});
              if (tracePath) yield* fs.writeFileString(tracePath, JSON.stringify(commandTrace, null, 2));
            });
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
            }).pipe(
              Effect.tap(result => recordCommand(args, {...result, args})),
              Effect.tapError(error =>
                error._tag === 'CommandFailed'
                  ? recordCommand(args, {
                      args,
                      exitCode: error.exitCode,
                      stdout: error.stdout,
                      stderr: error.stderr,
                    })
                  : Effect.void,
              ),
            );
          const publicReview = (args: readonly string[]) =>
            cli(args).pipe(Effect.map(result => parseCandidateReview(JSON.parse(result.stdout))));
          const editedDraftFile = path.join(home, 'edited-draft.json');
          yield* fs.writeFileString(
            editedDraftFile,
            JSON.stringify({
              ...proposal.draft,
              operations: EffectArray.map(proposal.draft.operations, (operation, index) =>
                index === 0 ? {...operation, text: 'The request timeout is 60 seconds.'} : operation,
              ),
              rationale: 'Reviewed the same evidence and approved this exact replacement.',
            }),
          );
          let previewReview = parseCandidateReview(
            JSON.parse(
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
            ),
          );
          const firstProjected = projectManagerTopicReview(previewReview)!;
          expect(firstProjected.draft.operations[0]?.text).toBe('The request timeout is 60 seconds.');
          const secondEditedDraft = {
            ...firstProjected.draft,
            operations: EffectArray.map(firstProjected.draft.operations, (operation, index) =>
              index === 1 ? {...operation, text: 'Requests time out after 60 seconds.'} : operation,
            ),
          };
          yield* fs.writeFileString(editedDraftFile, JSON.stringify(secondEditedDraft));
          previewReview = yield* publicReview([
            '--action',
            'draft-preview',
            '--review-id',
            review.reviewId,
            '--revision',
            String(previewReview.revision),
            '--source-cwd',
            repository,
            '--edited-draft-file',
            editedDraftFile,
            '--json',
          ]);
          const secondProjected = projectManagerTopicReview(previewReview)!;
          expect(EffectArray.map(secondProjected.draft.operations, operation => operation.text)).toEqual([
            'The request timeout is 60 seconds.',
            'Requests time out after 60 seconds.',
          ]);
          expect(secondProjected.proposal.body).toBe(
            'The request timeout is 60 seconds.\n\nRequests time out after 60 seconds.',
          );
          const deferred = yield* publicReview([
            '--action',
            'draft-defer',
            '--review-id',
            review.reviewId,
            '--revision',
            String(previewReview.revision),
            '--case-id',
            caseId,
            '--json',
          ]);
          expect(deferred.candidates[0].state).toBe('deferred');
          expect(deferred.maintenanceApproval?.stage).toBe('parked');
          const deferredView = projectManagerTopicReview(yield* loadCandidateReview(home, review.reviewId))!;
          expect(deferredView.draft).toEqual(secondProjected.draft);
          expect(deferredView.proposal.body).toBe(secondProjected.proposal.body);
          expect(deferredView.canApply).toBe(false);
          const resumeSelection = {
            reviewId: review.reviewId,
            revision: deferred.revision,
            action: 'resume' as const,
            caseId,
          };
          const interruptedResume = yield* decideTopicMaintenanceReview(config, resumeSelection, () =>
            Effect.fail(TopicReviewError.make({message: 'synthetic reconciliation interruption'})),
          ).pipe(Effect.result);
          expect(Result.isFailure(interruptedResume)).toBe(true);
          const persistedResume = yield* loadCandidateReview(home, review.reviewId);
          expect(persistedResume).toMatchObject({
            revision: deferred.revision + 1,
            candidates: [{state: 'pending'}],
            maintenanceApproval: {stage: 'parked'},
          });
          const recoveredResume = yield* handleManagerTopicReview({
            config,
            method: 'POST',
            url: new URL('http://manager.test/api/attention/topic-review'),
            body: Effect.succeed({project: 'fixture', ...resumeSelection}),
          });
          expect(recoveredResume?.status).toBe(200);
          let resumed = yield* loadCandidateReview(home, review.reviewId);
          expect(resumed.revision).toBe(persistedResume.revision);
          expect(resumed.candidates[0].state).toBe('pending');
          expect(resumed.maintenanceApproval?.stage).toBe('parked');
          expect(projectManagerTopicReview(resumed)?.draft).toEqual(secondProjected.draft);
          const resumedViaCli = yield* publicReview([
            '--action',
            'draft-resume',
            '--review-id',
            review.reviewId,
            '--revision',
            String(deferred.revision),
            '--case-id',
            caseId,
            '--json',
          ]);
          expect(resumedViaCli.revision).toBe(resumed.revision);
          expect(resumedViaCli.candidates[0].state).toBe('pending');
          const deferredAgain = yield* publicReview([
            '--action',
            'draft-defer',
            '--review-id',
            review.reviewId,
            '--revision',
            String(resumed.revision),
            '--case-id',
            caseId,
            '--json',
          ]);
          expect(deferredAgain.candidates[0].state).toBe('deferred');
          resumed = yield* publicReview([
            '--action',
            'draft-resume',
            '--review-id',
            review.reviewId,
            '--revision',
            String(deferredAgain.revision),
            '--case-id',
            caseId,
            '--json',
          ]);
          expect(resumed.candidates[0].state).toBe('pending');
          expect(resumed.revision).toBe(deferredAgain.revision + 1);
          expect(yield* fs.readFileString(memory)).toBe(accepted);
          expect(
            Result.isFailure(
              yield* applyTopicMaintenanceReview(config, {
                reviewId: review.reviewId,
                revision: previewReview.revision,
                sourceCwd: repository,
                approvalDigest: previewReview.maintenanceApproval!.preview.approvalDigest,
                approved: true,
              }).pipe(Effect.result),
            ),
          ).toBe(true);
          previewReview = yield* publicReview([
            '--action',
            'draft-preview',
            '--review-id',
            review.reviewId,
            '--revision',
            String(resumed.revision),
            '--source-cwd',
            repository,
            '--json',
          ]);
          expect(projectManagerTopicReview(previewReview)?.draft).toEqual(secondProjected.draft);
          const preview = previewReview.maintenanceApproval!.preview;
          expect(preview.approvedProposal.draft.rationale).toBe(
            'Reviewed the same evidence and approved this exact replacement.',
          );
          expect(previewReview.maintenance?.proposal.draft.rationale).toBe(proposal.draft.rationale);
          const reviewTool = (input: Record<string, unknown>) =>
            handleManagerTopicReview({
              config,
              method: input.action === 'view' ? 'GET' : 'POST',
              url:
                input.action === 'view'
                  ? new URL(`http://manager.test/api/attention/topic-review?project=fixture&reviewId=${input.reviewId}`)
                  : new URL('http://manager.test/api/attention/topic-review'),
              body: Effect.succeed({...input, project: 'fixture'}),
            }).pipe(
              Effect.map(response =>
                response ? {isError: response.status !== 200, structuredContent: response.body} : {isError: true},
              ),
            );
          const firstView = decodeReviewToolView(
            (yield* reviewTool({action: 'view', reviewId: review.reviewId})).structuredContent,
          );
          expect(firstView.revision).toBe(previewReview.revision);
          expect(preview.beforeContent).toBe(accepted);
          expect(preview.content).toContain('The request timeout is 60 seconds.');
          expect(preview.content).toContain('Requests time out after 60 seconds.');
          if (preview.version !== 1) throw new Error('Expected the frozen legacy code preview.');
          expect(preview.manifest.version).toBe(2);
          expect(yield* fs.readFileString(memory)).toBe(accepted);
          const apply = () =>
            publicReview([
              '--action',
              'draft-apply',
              '--review-id',
              review.reviewId,
              '--revision',
              String(previewReview.revision),
              '--source-cwd',
              repository,
              '--approval-digest',
              preview.approvalDigest,
              '--approved',
              '--json',
            ]);
          const unapproved = yield* publicReview([
            '--action',
            'draft-apply',
            '--review-id',
            review.reviewId,
            '--revision',
            String(previewReview.revision),
            '--source-cwd',
            repository,
            '--approval-digest',
            preview.approvalDigest,
            '--json',
          ]).pipe(Effect.result);
          expect(Result.isFailure(unapproved)).toBe(true);
          expect(yield* fs.readFileString(memory)).toBe(accepted);
          const wrongDigest = yield* reviewTool({
            action: 'apply',
            reviewId: review.reviewId,
            revision: previewReview.revision,
            sourceCwd: repository,
            approvalDigest: Effect2.pipe('f', EffectString.repeat(64)),
            approved: true,
          });
          expect(wrongDigest.isError).toBe(true);
          yield* fs.writeFileString(
            memory,
            Effect2.pipe(accepted, EffectString.replace('topic: timeout', 'topic: renamed-timeout')),
          );
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
          const stateFile = path.join(home, 'context-maintenance/state-v2.json');
          const savedState = yield* fs.readFileString(stateFile);
          const failingStateWrite = {
            ...fs,
            rename: (from: string, to: string) =>
              to === stateFile ? fs.rename(`${stateFile}.missing`, to) : fs.rename(from, to),
          };
          const writePending = yield* applyTopicMaintenanceReview(config, {
            reviewId: review.reviewId,
            revision: previewReview.revision,
            sourceCwd: repository,
            approvalDigest: preview.approvalDigest,
            approved: true,
          }).pipe(Effect.provideService(FileSystem.FileSystem, failingStateWrite), Effect.result);
          expect(writePending).toMatchObject({failure: {message: expect.stringContaining('verification is pending')}});
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
          expect((yield* loadCandidateReview(home, review.reviewId)).maintenanceApproval?.stage).toBe('prepared');
          expect((yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0]?.disposition).toBe(
            'needs-decision',
          );
          yield* fs.writeFileString(stateFile, '{malformed');
          const pending = yield* applyTopicMaintenanceReview(config, {
            reviewId: review.reviewId,
            revision: previewReview.revision,
            sourceCwd: repository,
            approvalDigest: preview.approvalDigest,
            approved: true,
          }).pipe(Effect.result);
          expect(Result.isFailure(pending)).toBe(true);
          if (Result.isFailure(pending))
            expect(pending.failure).toMatchObject({
              message: expect.stringContaining('saved; maintenance verification is pending'),
            });
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
          expect((yield* loadCandidateReview(home, review.reviewId)).maintenanceApproval?.stage).toBe('prepared');
          const pendingManager = yield* managerApply();
          expect(pendingManager?.status).toBe(409);
          expect(pendingManager?.body).toMatchObject({code: 'topic-review-verification-pending'});
          yield* fs.writeFileString(stateFile, savedState);
          const recoveredBeforeWrite = yield* apply();
          expect(recoveredBeforeWrite.maintenanceApproval?.stage).toBe('written');
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
          expect((yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0]?.disposition).toBe(
            'resolved',
          );
          const beforeCache = JSON.parse(savedState);
          const afterCache = JSON.parse(yield* fs.readFileString(stateFile));
          expect(afterCache.projects).toEqual(beforeCache.projects);
          expect(afterCache.preparation).toEqual(beforeCache.preparation);
          expect(afterCache.workSchedule).toEqual(beforeCache.workSchedule);
          expect(afterCache.checkpoints).toEqual(beforeCache.checkpoints);
          const managerBeforeWrite = yield* managerApply();
          expect(managerBeforeWrite?.status).toBe(200);
          expect(managerBeforeWrite?.body).toMatchObject({state: 'applied', approval: {stage: 'written'}});
          const applied = parseCandidateReview(
            JSON.parse(
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
            ),
          );
          expect(applied.candidates[0].state).toBe('applied');
          expect(applied.maintenanceApproval?.stage).toBe('written');
          const writtenView = decodeReviewToolView(
            (yield* reviewTool({action: 'view', reviewId: review.reviewId})).structuredContent,
          );
          expect(writtenView.approval?.stage).toBe('written');
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
          yield* fs.writeFileString(stateFile, savedState);
          expect((yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0]?.disposition).toBe(
            'needs-decision',
          );
          expect(Result.isFailure(yield* readContextMaintenancePacket(config, caseId).pipe(Effect.result))).toBe(true);
          const qualified = yield* handleManagerTopicReview({
            config,
            method: 'GET',
            url: new URL(`http://manager.test/api/attention/topic-review?project=fixture&caseId=${caseId}`),
            body: Effect.succeed({}),
          });
          expect(qualified?.status).toBe(200);
          expect(qualified?.body).toMatchObject({reviewId: review.reviewId, canFinishVerification: true});
          const replay = yield* apply();
          expect(replay.revision).toBe(applied.revision);
          expect(replay.auditEvents).toEqual(applied.auditEvents);
          expect((yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0]?.disposition).toBe(
            'resolved',
          );
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
          const preparedAgain = candidateReviewWithState(applied, applied.candidates[0].candidateId, 'applying');
          yield* saveCandidateReview(home, {
            ...preparedAgain,
            maintenanceApproval: {...applied.maintenanceApproval!, stage: 'prepared'},
          });
          const recoveredAfterWrite = yield* apply();
          expect(recoveredAfterWrite.maintenanceApproval?.stage).toBe('written');
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
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
          const acceptedRevision = newerCase?.evidenceRevision;
          for (let tick = 0; tick < 12 && newerCase?.evidenceRevision === acceptedRevision; tick++) {
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
          if (!conflictView) throw new Error('Expected a conflicted review response.');
          const projectedCaseId = decodeManagerTopicReviewCase(conflictView.body).caseId;
          if (!projectedCaseId) throw new Error('Conflicted review must retain its projected case.');
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
          expect(EffectArray.map(closed.auditEvents.slice(-2), event => event.action)).toEqual(['conflict', 'reject']);
          const replayedReject = yield* publicReview([
            '--action',
            'draft-reject',
            '--review-id',
            review.reviewId,
            '--revision',
            String(conflicted.revision),
            '--case-id',
            projectedCaseId,
            '--json',
          ]);
          expect(replayedReject.revision).toBe(closed.revision);
          expect(replayedReject.candidates[0].state).toBe('rejected');
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
          const generator: typeof runSelectedDraft = (_config, _agent, _model, prompt, _purpose, currentBasis) =>
            Effect.sync(() => {
              if (!currentBasis || currentBasis.version === 3)
                throw new Error('Expected the frozen legacy generation basis.');
              const identity = JSON.parse(/^Identity: (.+)$/mu.exec(prompt)![1]);
              const eligible: {ordinal: number; sourceIndices: number[]}[] = JSON.parse(
                /^Replaceable direct descriptive paragraphs: (.+)$/mu.exec(prompt)![1],
              );
              const draft = {
                ...makeTopicDraftWireFixture(
                  currentBasis,
                  'unchanged',
                  topicDraftEvidenceFromPrompt(prompt, currentBasis),
                ),
                ...identity,
              };
              draft.decision.removedClaims = ['Request timeout is 60 seconds.'];
              draft.facts.entries = EffectArray.map(eligible, item => ({
                ordinal: item.ordinal,
                currentBehavior: 'Current supported behavior.',
                rationale: 'Checked current source.',
                disposition: item.ordinal === 0 ? 'update' : 'unchanged',
                sourceIndices: item.sourceIndices,
                ...(item.ordinal === 0 ? {text: 'Request timeout is 90 seconds.'} : {}),
              }));
              return {
                text: JSON.stringify(draft),
                backendIdentity: 'local-ai',
                modelIdentity: modelId,
                modelVersion: `${manifest.revision}:${manifest.sha256}`,
                usage: {status: 'unavailable' as const},
                settings: localDraftGenerationSettings(modelId, 'topic-maintenance'),
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
          expect(EffectArray.map(fresh.auditEvents, event => event.action)).toContain('conflict');
          expect((yield* loadCandidateReview(home, review.reviewId)).maintenanceClosedConflict).toEqual(
            closed.maintenanceClosedConflict,
          );
          expect(yield* fs.readFileString(memory)).toBe(preview.content);
        }),
      ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    // Covers sequential CLI/Manager/MCP preview, crash-recovery and replay scenarios.
    // This outer harness ceiling leaves per-command and product deadlines unchanged.
    180_000,
  );
});
