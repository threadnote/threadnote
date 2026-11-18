import {Array as EffectArray, Effect, FileSystem, Record as EffectRecord, Schema} from 'effect';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {Command} from 'effect/cli';
import {it as effectIt} from '@effect/vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphStore} from '@threadnote/graph/store';
import {describe, expect} from 'vitest';
import {
  decodeNativeTaskActionRef,
  encodeNativeTaskActionRef,
  nativeTaskSnapshotId,
} from '@threadnote/workflow-automations/task';
import {NativeAuthoringPlanDocumentSchema} from '@threadnote/workflow-automations/authoring';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import {runCommandEffect} from '@threadnote/platform/command';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {
  makeNativeTaskActionCommands,
  makeNativeTaskPrWatchCommand,
  makeNativeTaskSupplementalCommand,
  makeNativeTaskInvalidTailCommand,
} from '../../src/effect/workflow_cli.js';
import {applyDevSkills} from '../../src/dev_skills/index.js';
import {SystemInfo} from '@threadnote/platform/system';
import {nativeCloseoutJournalPath, readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {CurrentNativeJobAutoLaunch, runNativeJobWorker} from '../../src/workflow_automation/native_jobs.js';
import {readNativeCloseoutJournal, writeNativeCloseoutJournal} from '../../src/workflow_automation/closeout_store.js';
import {decodeJournal} from '../../src/workflow_automation/closeout_request_schema.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';
import {completeLocalPhase, object, run} from './native-cycle-lifecycle-fixture.js';
import {nativeFixture} from './native-automation-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  windowsRealGitFixtureTimeout,
  cliTestLayer,
  fixture,
  runNativeTaskAction,
  packet,
  proposal,
  completeDuringJournalRead,
} from './native-task-actions-fixture.js';

describe('native task actions', () => {
  effectIt.effect('validates a reviewed tree after a new commit and rejects committed tree drift', () =>
    Effect.gen(function* () {
      for (const changedTree of [false, true]) {
        const f = yield* fixture(['one'], 'local');
        yield* f.mutate('begin-phase', {phaseId: 'one'});
        const work = object(
          yield* runNativeTaskAction(f.config, {
            command: 'work',
            runId: 'native-run',
            callerCwd: f.repo,
            packet,
          }),
        );
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "reviewed";\n');
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Reviewed implementation']);
        const snapshot = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(work.workRef),
          }),
        );
        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, f.config);
        const reviewCard = object(
          object(yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo}))
            .structuredContent,
        );
        expect(reviewCard.next).toMatchObject({action: 'review', tool: 'workflow_task_record_review'});
        const review = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-review',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: String(snapshot.snapshotRef),
            report: {
              mode: 'full',
              selected: ['correctness', 'simplicity'],
              lanes: [
                {name: 'correctness', status: 'complete'},
                {name: 'simplicity', status: 'complete'},
              ],
              findings: [],
            },
          }),
        );
        const validationCard = object(
          object(yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo}))
            .structuredContent,
        );
        expect(validationCard.next).toMatchObject({
          action: 'validate',
          snapshotId: decodeNativeTaskActionRef(String(snapshot.snapshotRef))?.snapshotId,
          tool: 'workflow_task_record_validation',
        });
        const reviewedHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        const reviewedTree = EffectString.trim((yield* f.git(['rev-parse', 'HEAD^{tree}'])).stdout);
        if (changedTree) {
          yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "changed";\n');
          yield* f.git(['add', 'source.ts']);
          yield* f.git(['commit', '-m', 'Changed implementation']);
        } else yield* f.git(['commit', '--allow-empty', '-m', 'Build marker']);
        expect(EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout)).not.toBe(reviewedHead);
        expect(EffectString.trim((yield* f.git(['rev-parse', 'HEAD^{tree}'])).stdout) === reviewedTree).toBe(
          !changedTree,
        );
        const stored = yield* readNativeWorkflowState(f.config, 'native-run');
        if (!stored) throw new Error('Expected the canonical workflow journal.');
        const journalPath = f.journalPath(stored.state.bindingId);
        const beforeJournal = yield* f.fs.readFileString(journalPath);
        const beforeState = yield* f.fs.readFileString(f.statePath());
        const validation = runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(review.snapshotRef),
          validation: {
            checks: [{command: 'focused fixture check', result: 'passed', evidence: 'Reviewed tree checked.'}],
            acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Reviewed tree works.'}],
          },
        });
        if (changedTree) {
          expect(yield* validation.pipe(Effect.result)).toMatchObject({failure: {code: 'source-drift'}});
          expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);
          expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeState);
        } else {
          const accepted = object(yield* validation);
          expect(accepted).toMatchObject({status: 'recorded', replayed: false});
          const deliveryCard = object(
            object(yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo}))
              .structuredContent,
          );
          expect(deliveryCard).toMatchObject({
            status: 'ready',
            next: {action: 'deliver', tool: 'workflow_task_deliver'},
          });
          const delivered = object(
            object(
              yield* mcp.invokeTool('workflow_task_deliver', {
                runId: 'native-run',
                callerCwd: f.repo,
                delivery: {command: 'local', validationRef: String(accepted.validationRef)},
              }),
            ).structuredContent,
          );
          expect(delivered).toMatchObject({status: 'delivered', replayed: false});
          expect(
            object(
              object(yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo}))
                .structuredContent,
            ),
          ).toMatchObject({status: 'complete', next: {action: 'complete', tool: 'workflow_task_finish'}});
        }
      }
    }).pipe(run),
  );

  // prettier-ignore
  effectIt.effect('replays an exact snapshot and review but refuses a snapshot replay after source drift', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      const readbackProposal = {
        ...proposal,
        architecture: {
          ...proposal.architecture,
          summary: EffectString.repeat(4199)('S') + 'é',
          components: EffectArray.makeBy(3, index => EffectString.repeat(8192)(String(index))),
        },
      };
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const work = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      expect(work.status).toBe('ready');
      expect(work.phaseId).toBe('one');
      const workRef = String(work.workRef);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "worker result";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Worker result']);
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const recordedEnvelope = object(
        yield* mcp.invokeTool('workflow_task_snapshot', {
          runId: 'native-run',
          callerCwd: f.repo,
          snapshot: {command: 'record', workRef},
        }),
      );
      const recorded = object(recordedEnvelope.structuredContent);
      expect(recorded).toMatchObject({status: 'recorded', replayed: false});
      const snapshotRef = String(recorded.snapshotRef);
      const recordedTree = String(object(object(recorded.snapshot).snapshot).tree);
      const recordSnapshot = runNativeTaskAction(f.config, {
        command: 'record-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        workRef,
      });
      const failureMessage = (result: unknown) => String(object(object(result).failure).message);
      const beforeReplay = yield* f.fs.readFileString(f.statePath());
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "later drift";\n');
      yield* f.git(['add', 'source.ts']);
      const driftTree = EffectString.trim((yield* f.git(['write-tree'])).stdout);
      const staleReplay = yield* recordSnapshot.pipe(Effect.result);
      expect(staleReplay).toMatchObject({failure: {code: 'source-drift'}});
      expect(failureMessage(staleReplay)).toContain(recordedTree);
      expect(failureMessage(staleReplay)).toContain(driftTree);
      expect(failureMessage(staleReplay)).toContain('supersede-unreviewed-snapshot');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeReplay);
      yield* f.git(['checkout', 'HEAD', '--', 'source.ts']);
      const replay = object(yield* recordSnapshot);
      expect(replay).toMatchObject({status: 'recorded', replayed: true});
      expect(replay.snapshot).toEqual(recorded.snapshot);
      expect(object(object(replay.snapshot).snapshot).snapshotId).toBe(nativeTaskSnapshotId(workRef));
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeReplay);
      const report = {
        mode: 'full',
        selected: ['correctness', 'simplicity'],
        lanes: [
          {name: 'correctness', status: 'complete'},
          {name: 'simplicity', status: 'complete'},
        ],
        findings: [],
      };
      const review = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          report,
        }),
      );
      expect(review).toMatchObject({status: 'recorded', replayed: false});
      const afterReview = yield* f.fs.readFileString(f.statePath());
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "review replay drift";\n');
      const reviewRef = String(review.snapshotRef);
      const exactReview = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: reviewRef,
          report,
        }),
      );
      expect(exactReview).toMatchObject({status: 'recorded', replayed: true});
      expect(exactReview.attempt).toEqual(review.attempt);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterReview);
      const changed = yield* runNativeTaskAction(f.config, {
        command: 'record-review',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: reviewRef,
        report: {...report, mode: 'incremental'},
      }).pipe(Effect.result);
      expect(changed).toMatchObject({failure: {code: 'review-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterReview);
      const reviewedReplay = yield* recordSnapshot.pipe(Effect.result);
      expect(reviewedReplay).toMatchObject({failure: {code: 'source-drift'}});
      expect(failureMessage(reviewedReplay)).toContain('task-action work');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterReview);
      yield* f.git(['checkout', '--', 'source.ts']);
      const validationEvidence = {
        checks: [{command: 'focused fixture check', result: 'passed', evidence: 'The private fixture flow passed.'}],
        acceptance: [
          {criterion: 'one works', result: 'passed', evidence: 'The implementation meets the fixture criterion.'},
        ],
      };
      const validation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: reviewRef,
          validation: validationEvidence,
        }),
      );
      expect(validation).toMatchObject({status: 'recorded', replayed: false});
      const deliveryEnvelope = object(
        yield* mcp.invokeTool('workflow_task_deliver', {
          runId: 'native-run',
          callerCwd: f.repo,
          delivery: {command: 'local', validationRef: String(validation.validationRef)},
        }),
      );
      const delivery = object(deliveryEnvelope.structuredContent);
      expect(delivery).toMatchObject({status: 'delivered', replayed: false, receipt: {delivery: 'local'}});
      const afterDelivery = yield* f.fs.readFileString(f.statePath());
      const exactValidation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(validation.validationRef),
          validation: validationEvidence,
        }),
      );
      expect(exactValidation).toMatchObject({status: 'recorded', replayed: true});
      expect(exactValidation.validation).toEqual(validation.validation);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterDelivery);
      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "post-validation drift";\n',
      );
      const exactDelivery = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-local',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: String(delivery.deliveryRef),
        }),
      );
      expect(exactDelivery).toMatchObject({status: 'delivered', replayed: true});
      expect(exactDelivery.receipt).toEqual(delivery.receipt);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterDelivery);
      yield* f.git(['checkout', '--', 'source.ts']);
      const invalidProposal = {
        ...readbackProposal,
        decisions: [{id: 'unknown', implemented: 'Unsupported decision.', rationale: 'Unsupported decision.'}],
        scenarios: [{id: 'unknown', evidence: 'Unsupported scenario.'}],
        behaviorVerification: 'No spec is pinned.',
      };
      const beforeInvalidFinish = yield* f.fs.readFileString(f.statePath());
      const closeoutPath = yield* nativeCloseoutJournalPath(f.config, 'native-run');
      const invalidFinish = yield* runNativeTaskAction(f.config, {
        command: 'finish',
        runId: 'native-run',
        callerCwd: f.repo,
        proposal: invalidProposal,
      }).pipe(Effect.result);
      expect(invalidFinish).toMatchObject({failure: {code: 'invalid-closeout-proposal'}});
      if (invalidFinish._tag === 'Failure') {
        expect(String(object(invalidFinish.failure).message)).toContain('decisions, scenarios, behaviorVerification');
        expect(String(object(invalidFinish.failure).message)).not.toContain('unknown');
      }
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeInvalidFinish);
      expect(yield* f.fs.exists(closeoutPath)).toBe(false);
      const storedForLegacyJob = yield* readNativeWorkflowState(f.config, 'native-run');
      if (!storedForLegacyJob) throw new Error('Expected current native state.');
      const legacyJob = object(
        yield* f.call({
          ...f.base('job'),
          command: 'submit',
          work: {...f.base('closeout'), command: 'prepare', proposal: invalidProposal},
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      const legacyJobId = String(legacyJob.jobId);
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', legacyJobId, f.call))).toMatchObject({
        status: 'failed',
        code: 'invalid-closeout',
      });
      const legacyPrepareRef = encodeNativeTaskActionRef({
        version: 1,
        kind: 'closeout-prepare',
        runId: 'native-run',
        generationHash: sha256HexSync(storedForLegacyJob.state.generation),
        payloadDigest: sha256HexSync(stableJson(invalidProposal)),
        jobId: legacyJobId,
      });
      const failedJobBeforeRetry = object(yield* f.call({...f.base('job'), command: 'status', jobId: legacyJobId}));
      const terminalInvalidFinish = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          prepareRef: legacyPrepareRef,
          resume: true,
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(terminalInvalidFinish).toMatchObject({
        status: 'blocked',
        stage: 'prepare',
        job: {status: 'failed', code: 'invalid-closeout', nextAction: expect.stringContaining('corrected new finish')},
      });
      expect(object(yield* f.call({...f.base('job'), command: 'status', jobId: legacyJobId}))).toEqual(
        failedJobBeforeRetry,
      );
      const finishThroughMcp = (input: Record<string, unknown>) =>
        mcp.invokeTool('workflow_task_finish', input).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false));
      let lostPrepareAcknowledgment: Record<string, unknown> | undefined;
      const lostPrepare = yield* finishThroughMcp({runId: 'native-run', callerCwd: f.repo, proposal: readbackProposal}).pipe(
        Effect.tap(value => Effect.sync(() => (lostPrepareAcknowledgment = object(object(value).structuredContent)))),
        Effect.andThen(
          Effect.fail(
            WorkflowAutomationError.make({code: 'test-lost-ack', message: 'Simulated lost MCP preparation response.'}),
          ),
        ),
        Effect.result,
      );
      expect(lostPrepare._tag).toBe('Failure');
      const preparingEnvelope = object(
        yield* finishThroughMcp({runId: 'native-run', callerCwd: f.repo, proposal: readbackProposal}),
      );
      const preparing = object(preparingEnvelope.structuredContent);
      expect(preparing).toMatchObject({status: 'pending', stage: 'prepare'});
      expect(preparing.job).not.toHaveProperty('jobId');
      expect(preparing.job).not.toHaveProperty('generation');
      expect(preparing.job).not.toHaveProperty('protocolVersion');
      expect(decodeNativeTaskActionRef(String(lostPrepareAcknowledgment?.prepareRef))?.jobId).toBe(
        decodeNativeTaskActionRef(String(preparing.prepareRef))?.jobId,
      );
      const prepareRef = String(preparing.prepareRef);
      const prepareJobId = String(decodeNativeTaskActionRef(prepareRef)?.jobId);
      const changedProposal = {
        ...readbackProposal,
        architectureVerification: 'Changed semantic evidence on the same prepare reference.',
      };
      const changedPrepare = yield* runNativeTaskAction(f.config, {
        command: 'finish',
        runId: 'native-run',
        callerCwd: f.repo,
        proposal: changedProposal,
        prepareRef,
      }).pipe(Effect.result);
      expect(changedPrepare).toMatchObject({failure: {code: 'closeout-intent-conflict'}});
      expect(object(yield* f.call({...f.base('job'), command: 'cancel', jobId: prepareJobId})).stopRequested).toBe(
        true,
      );
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', prepareJobId, f.call)).status).toBe(
        'stopped-with-progress',
      );
      const stoppedStatus = object(yield* f.call({...f.base('job'), command: 'status', jobId: prepareJobId}));
      const blockedPreparation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          prepareRef,
        }),
      );
      expect(blockedPreparation).toMatchObject({
        status: 'blocked',
        stage: 'prepare',
        job: {status: 'stopped-with-progress', nextAction: expect.stringContaining('resume:true')},
      });
      expect(String(object(blockedPreparation.job).nextAction)).not.toContain(prepareJobId);
      expect(String(object(blockedPreparation.job).nextAction)).not.toContain('operation IDs');
      expect(blockedPreparation.job).not.toHaveProperty('jobId');
      expect(blockedPreparation.job).not.toHaveProperty('generation');
      expect(object(yield* f.call({...f.base('job'), command: 'status', jobId: prepareJobId}))).toEqual(stoppedStatus);
      const explicitlyResumed = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          prepareRef,
          resume: true,
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(explicitlyResumed).toMatchObject({status: 'pending', stage: 'prepare', job: {status: 'accepted'}});
      const largePrepareCompletion = object(
        yield* runNativeJobWorker(f.config, 'native-run', prepareJobId, f.call),
      );
      expect(largePrepareCompletion.status, JSON.stringify(largePrepareCompletion)).toBe('completed');
      expect(object(yield* f.call({...f.base('closeout'), command: 'recover'})).closeout).toMatchObject({
        state: 'superseded',
      });
      yield* f.mutate('invalidate', {
        phaseId: 'one',
        reason: 'Requalify after superseding the first closeout admission.',
      });
      yield* f.mutate('resume-phase', {phaseId: 'one', reason: 'Revalidate the current local implementation.'});
      const previousSnapshotId = String(object(object(recorded.snapshot).snapshot).snapshotId);
      yield* completeLocalPhase(f, 'one', 'replacement', previousSnapshotId);
      const replacementEnvelope = object(
        yield* finishThroughMcp({runId: 'native-run', callerCwd: f.repo, proposal: readbackProposal}),
      );
      const replacementPrepare = object(replacementEnvelope.structuredContent);
      expect(replacementPrepare).toMatchObject({status: 'pending', stage: 'prepare'});
      const replacementJobId = String(decodeNativeTaskActionRef(String(replacementPrepare.prepareRef))?.jobId);
      expect(replacementJobId).not.toBe(prepareJobId);
      const replacementStatus = object(yield* runNativeJobWorker(f.config, 'native-run', replacementJobId, f.call));
      expect(replacementStatus.status, JSON.stringify(replacementStatus)).toBe('completed');
      const closeoutFile = f.statePath() + '.closeout.json';
      const beforeStalePrepareRef = yield* f.fs.readFileString(closeoutFile);
      const beforeStaleNativeState = yield* f.fs.readFileString(f.statePath());
      const stalePrepareRef = yield* runNativeTaskAction(f.config, {
        command: 'finish',
        runId: 'native-run',
        callerCwd: f.repo,
        prepareRef,
      }).pipe(Effect.result);
      expect(stalePrepareRef).toMatchObject({failure: {code: 'stale-closeout-ref'}});
      expect(yield* f.fs.readFileString(closeoutFile)).toBe(beforeStalePrepareRef);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeStaleNativeState);
      const replacementPrepareRef = String(replacementPrepare.prepareRef);
      let lostFinishAcknowledgment: Record<string, unknown> | undefined;
      const lostFinish = yield* finishThroughMcp({
        runId: 'native-run',
        callerCwd: f.repo,
        prepareRef: replacementPrepareRef,
      }).pipe(
        Effect.tap(value => Effect.sync(() => (lostFinishAcknowledgment = object(object(value).structuredContent)))),
        Effect.andThen(
          Effect.fail(
            WorkflowAutomationError.make({code: 'test-lost-ack', message: 'Simulated lost MCP finish response.'}),
          ),
        ),
        Effect.result,
      );
      expect(lostFinish._tag).toBe('Failure');
      const beforePendingReplay = yield* f.fs.readFileString(closeoutFile);
      const nativeStateBeforePendingReplay = yield* f.fs.readFileString(f.statePath());
      const jobsDirectory = f.path.join(f.home, 'workflow-automations', 'native-v1', 'jobs', 'native-run');
      const jobsBeforeReplay = yield* f.fs.readDirectory(jobsDirectory);
      const finishingEnvelope = object(
        yield* finishThroughMcp({runId: 'native-run', callerCwd: f.repo, prepareRef: replacementPrepareRef}),
      );
      expect(yield* f.fs.readFileString(closeoutFile)).toBe(beforePendingReplay);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(nativeStateBeforePendingReplay);
      expect(yield* f.fs.readDirectory(jobsDirectory)).toEqual(jobsBeforeReplay);
      const finishing = object(finishingEnvelope.structuredContent);
      expect(finishing).toMatchObject({status: 'pending', stage: 'finish'});
      const finishRef = String(finishing.finishRef);
      expect(String(lostFinishAcknowledgment?.finishRef)).toBe(finishRef);
      const finishJobId = String(decodeNativeTaskActionRef(finishRef)?.jobId);
      const beforeConflictingFinish = yield* f.fs.readFileString(closeoutFile);
      const conflictingFinish = yield* runNativeTaskAction(f.config, {
        command: 'finish',
        runId: 'native-run',
        callerCwd: f.repo,
        proposal: changedProposal,
        finishRef,
      }).pipe(Effect.result);
      expect(conflictingFinish).toMatchObject({failure: {code: 'stale-closeout-ref'}});
      expect(yield* f.fs.readFileString(closeoutFile)).toBe(beforeConflictingFinish);
      const interleaving = yield* completeDuringJournalRead(f, finishJobId);
      const lostFinishReplay = object(
        object(
          yield* finishThroughMcp({runId: 'native-run', callerCwd: f.repo, prepareRef: replacementPrepareRef}).pipe(
            Effect.provideService(FileSystem.FileSystem, interleaving.filesystem),
          ),
        ).structuredContent,
      );
      expect(interleaving.wasCaptured()).toBe(true);
      expect(yield* f.fs.readDirectory(jobsDirectory)).toEqual(jobsBeforeReplay);
      expect(lostFinishReplay).toMatchObject({status: 'complete', stage: 'finish', replayed: true, finishRef});
      const complete = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          finishRef,
        }),
      );
      expect(complete).toMatchObject({status: 'complete', replayed: true});
      const completedCloseoutBytes = yield* f.fs.readFileString(closeoutFile);
      const completedCloseout = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      expect(completedCloseout?.state.status).toBe('complete');
      expect(completedCloseout?.state.outputs).not.toEqual({});
      expect(completedCloseout?.state.admissionEpoch).toEqual(expect.any(String));
      const completedNativeState = yield* f.fs.readFileString(f.statePath());
      expect(
        object(
          object(yield* finishThroughMcp({runId: 'native-run', callerCwd: f.repo, prepareRef: replacementPrepareRef}))
            .structuredContent,
        ),
      ).toEqual(lostFinishReplay);
      expect(yield* f.fs.readFileString(closeoutFile)).toBe(completedCloseoutBytes);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(completedNativeState);
      expect(yield* f.fs.readDirectory(jobsDirectory)).toEqual(jobsBeforeReplay);
      expect(complete.closeout).toEqual({
        transactionId: completedCloseout?.state.transactionId,
        documentDigest: completedCloseout?.state.documentDigest,
        outputs: completedCloseout?.state.outputs,
        archives: completedCloseout?.state.archives,
      });
      if (!completedCloseout || EffectRecord.keys(completedCloseout.state.outputs).length < 2)
        throw new Error('Expected multiple independently admitted closeout outputs for negative coverage tests.');
      const outputKeys = EffectRecord.keys(completedCloseout.state.outputs);
      const incompleteOutputs = EffectRecord.remove(completedCloseout.state.outputs, outputKeys[0]);
      const incompleteJournal = yield* writeNativeCloseoutJournal(
        f.config,
        'native-run',
        {...completedCloseout.state, outputs: incompleteOutputs},
        completedCloseout.revision,
        decodeJournal,
      );
      const incompleteView = yield* readNativeTaskView(f.config, {
        runId: 'native-run',
        callerCwd: f.repo,
        detail: 'packet',
      }).pipe(Effect.result);
      expect(incompleteView).toMatchObject({failure: {code: 'invalid-closeout-state'}});
      expect(
        yield* readNativeTaskView(f.config, {
          runId: 'native-run',
          callerCwd: f.repo,
          detail: 'packet',
          outputKey: outputKeys[0],
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'invalid-closeout-state'}});
      const restoredJournal = yield* writeNativeCloseoutJournal(
        f.config,
        'native-run',
        completedCloseout.state,
        incompleteJournal.revision,
        decodeJournal,
      );
      const changedDocuments = [...completedCloseout.state.documents];
      changedDocuments[0] = {...changedDocuments[0], body: changedDocuments[0].body + '\nEdited after admission.'};
      const editedBodyJournal = yield* writeNativeCloseoutJournal(
        f.config,
        'native-run',
        {
          ...completedCloseout.state,
          documents: changedDocuments,
          documentDigest: sha256HexSync(stableJson(changedDocuments)),
        },
        restoredJournal.revision,
        decodeJournal,
      );
      const editedBodyView = yield* readNativeTaskView(f.config, {
        runId: 'native-run',
        callerCwd: f.repo,
        detail: 'packet',
      }).pipe(Effect.result);
      expect(editedBodyView).toMatchObject({failure: {code: 'invalid-readback'}});
      yield* writeNativeCloseoutJournal(
        f.config,
        'native-run',
        completedCloseout.state,
        editedBodyJournal.revision,
        decodeJournal,
      );
      const restoredOutputs = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      if (!restoredOutputs) throw new Error('Expected restored complete closeout journal.');
      const fs = yield* FileSystem.FileSystem;
      const closeoutWriteContext =
        yield* Effect.context<Effect.Services<ReturnType<typeof writeNativeCloseoutJournal>>>();
      const closeoutJournalPath = yield* fs.realPath(f.statePath() + '.closeout.json');
      let changedDuringRead = false;
      const racingFilesystem = FileSystem.FileSystem.of({
        ...fs,
        readFile: file =>
          fs.readFile(file).pipe(
            Effect.tap(() =>
              file === closeoutJournalPath && !changedDuringRead
                ? Effect.gen(function* () {
                    changedDuringRead = true;
                    yield* writeNativeCloseoutJournal(
                      f.config,
                      'native-run',
                      {
                        ...restoredOutputs.state,
                        outputs: EffectRecord.remove(restoredOutputs.state.outputs, outputKeys[0]),
                      },
                      restoredOutputs.revision,
                      decodeJournal,
                    ).pipe(Effect.provideContext(closeoutWriteContext), Effect.orDie);
                  })
                : Effect.void,
            ),
          ),
      });
      const racedView = yield* readNativeTaskView(f.config, {
        runId: 'native-run',
        callerCwd: f.repo,
        detail: 'packet',
      }).pipe(Effect.provideService(FileSystem.FileSystem, racingFilesystem), Effect.result);
      expect(changedDuringRead).toBe(true);
      expect(racedView).toMatchObject({failure: {code: 'inspection-failed'}});
      const changedJournal = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      if (!changedJournal) throw new Error('Expected concurrent closeout journal update.');
      yield* writeNativeCloseoutJournal(
        f.config,
        'native-run',
        completedCloseout.state,
        changedJournal.revision,
        decodeJournal,
      );
      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "post-validation drift";\n',
      );
      const exactFinish = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          finishRef,
        }),
      );
      expect(exactFinish).toMatchObject({status: 'complete', replayed: true});
      expect(yield* f.fs.readFileString(closeoutFile)).toBe(completedCloseoutBytes);
      const terminalView = object(
        yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo, detail: 'packet'}),
      );
      expect(terminalView).toMatchObject({
        status: 'complete',
        closeout: {
          status: 'complete',
          transactionId: completedCloseout?.state.transactionId,
          outputs: expect.arrayContaining([
            expect.objectContaining({
              uri: expect.any(String),
              memoryId: expect.any(String),
              revision: expect.any(String),
            }),
          ]),
        },
      });
      const terminalViewReplay = object(
        yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo, detail: 'packet'}),
      );
      expect(terminalViewReplay).toEqual(terminalView);
      expect(yield* f.fs.readFileString(closeoutFile)).toBe(completedCloseoutBytes);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(completedNativeState);
      if (!completedCloseout) throw new Error('Expected the completed closeout journal.');
      const outputKey = 'architecture';
      if (!completedCloseout.state.outputs[outputKey]) throw new Error('Expected the verified architecture output.');
      const expectedBody = EffectOption.getOrUndefined(
        EffectArray.findFirst(EffectArray.reverse(completedCloseout.state.documents), document => document.key === outputKey),
      )?.body;
      if (expectedBody === undefined) throw new Error('Expected the selected closeout output body.');
      expect(expectedBody).toContain('é');
      expect(expectedBody.length).toBeGreaterThanOrEqual(59_000);
      expect(expectedBody.length).toBeLessThan(60_000);
      const defaultOutputs = object(terminalView.closeout).outputs;
      if (!EffectArray.isArray(defaultOutputs)) throw new Error('Expected default closeout output references.');
      expect(EffectArray.every(defaultOutputs, output => !('body' in object(output)))).toBe(true);
      const selectedBodyView = object(
        yield* readNativeTaskView(f.config, {
          runId: 'native-run',
          callerCwd: f.repo,
          detail: 'packet',
          outputKey,
        }),
      );
      const selectedOutputs = object(selectedBodyView.closeout).outputs;
      if (!EffectArray.isArray(selectedOutputs)) throw new Error('Expected verified closeout output references.');
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(selectedOutputs, output => object(output).key === outputKey),
        ),
      ).toMatchObject({body: expectedBody});
      expect(
        EffectArray.every(selectedOutputs, output => {
          const record = object(output);
          return record.key === outputKey ? record.body === expectedBody : !('body' in record);
        }),
      ).toBe(true);
      expect(
        object(
          object(
            yield* mcp.invokeTool('workflow_task_view', {
              runId: 'native-run',
              callerCwd: f.repo,
              detail: 'packet',
              outputKey,
            }),
          ).structuredContent,
        ).closeout,
      ).toEqual(selectedBodyView.closeout);
      expect(
        yield* readNativeTaskView(f.config, {
          runId: 'native-run',
          callerCwd: f.repo,
          detail: 'summary',
          outputKey,
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'invalid-request'}});
      expect(
        yield* readNativeTaskView(f.config, {
          runId: 'native-run',
          callerCwd: f.repo,
          detail: 'packet',
          outputKey: 'unknown-output',
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'closeout-output-not-found'}});
      expect(yield* f.fs.readFileString(closeoutFile)).toBe(completedCloseoutBytes);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(completedNativeState);
    }).pipe(run),
    windowsRealGitFixtureTimeout,
  );

  effectIt.effect('records canonical commit delivery through MCP with exact replay and guarded refusal', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'commit');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const work = object(
        yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "commit delivery";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Validated commit']);
      const snapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      const snapshotRef = String(snapshot.snapshotRef);
      const report = {
        mode: 'full',
        selected: ['correctness', 'simplicity'],
        lanes: [
          {name: 'correctness', status: 'complete'},
          {name: 'simplicity', status: 'complete'},
        ],
        findings: [],
      };
      yield* runNativeTaskAction(f.config, {
        command: 'record-review',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef,
        report,
      });
      yield* f.git(['commit', '--allow-empty', '-m', 'Same-tree commit build marker']);
      const validation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          validation: {
            checks: [{command: 'commit fixture check', result: 'passed', evidence: 'The exact committed tree passed.'}],
            acceptance: [{criterion: 'one works', result: 'passed', evidence: 'The accepted source is committed.'}],
          },
        }),
      );
      const validationRef = String(validation.validationRef);
      const ref = decodeNativeTaskActionRef(validationRef);
      if (!ref) throw new Error('Expected an opaque validation reference.');
      const foreignRef = encodeNativeTaskActionRef({...ref, runId: 'foreign-run'});
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const taskViewEnvelope = object(
        yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo}),
      );
      expect(object(taskViewEnvelope.structuredContent).next).toMatchObject({
        action: 'deliver',
        tool: 'workflow_task_deliver',
        arguments: {
          runId: 'native-run',
          delivery: {command: 'commit', validationRef, commitEvidence: '<commitEvidence>'},
        },
      });
      const evidence = 'Verified fixture commit ' + EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      const beforeForeign = yield* f.fs.readFileString(f.statePath());
      const foreign = yield* runNativeTaskAction(f.config, {
        command: 'deliver-commit',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: foreignRef,
        commitEvidence: evidence,
      }).pipe(Effect.result);
      expect(foreign).toMatchObject({failure: {code: 'invalid-validation-ref'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeForeign);

      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "source drift";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Commit after validation']);
      const beforeStale = yield* f.fs.readFileString(f.statePath());
      const stale = yield* mcp
        .invokeTool('workflow_task_deliver', {
          runId: 'native-run',
          callerCwd: f.repo,
          delivery: {command: 'commit', validationRef, commitEvidence: evidence},
        })
        .pipe(Effect.result);
      expect(stale).toMatchObject({failure: {code: 'source-drift'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeStale);
      yield* f.git(['reset', '--hard', 'HEAD~1']);

      let cliDelivery: Record<string, unknown> | undefined;
      const taskActions = makeNativeTaskActionCommands(
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        options =>
          runNativeTaskAction(f.config, {command: 'deliver-commit', ...options}).pipe(
            Effect.tap(value => Effect.sync(() => (cliDelivery = object(value)))),
            Effect.asVoid,
          ),
      );
      const cli = Command.make('workflow-automation').pipe(Command.withSubcommands([taskActions]));
      const beforeMissingEvidence = yield* f.fs.readFileString(f.statePath());
      const missingEvidence = yield* Command.runWith(cli, {version: 'fixture'})([
        'task-action',
        'deliver-commit',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--validation-ref',
        validationRef,
      ]).pipe(Effect.result);
      expect(missingEvidence._tag).toBe('Failure');
      expect(cliDelivery).toBeUndefined();
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeMissingEvidence);
      yield* Command.runWith(cli, {version: 'fixture'})([
        'task-action',
        'deliver-commit',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--validation-ref',
        validationRef,
        '--commit-evidence',
        evidence,
      ]);
      const delivered = cliDelivery;
      if (!delivered) throw new Error('Expected the typed commit-delivery CLI result.');
      expect(delivered).toMatchObject({status: 'delivered', replayed: false, receipt: {delivery: 'commit'}});
      const canonicalDeliveryRef = decodeNativeTaskActionRef(String(delivered.deliveryRef));
      if (!canonicalDeliveryRef) throw new Error('Expected the canonical commit-delivery reference.');
      const tamperedDigestRef = encodeNativeTaskActionRef({
        ...canonicalDeliveryRef,
        payloadDigest: sha256HexSync('valid-form-but-mismatched-delivery-digest'),
      });
      const beforeTamperedDigest = yield* f.fs.readFileString(f.statePath());
      const tamperedDigestReplay = yield* runNativeTaskAction(f.config, {
        command: 'deliver-commit',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: tamperedDigestRef,
        commitEvidence: evidence,
      }).pipe(Effect.result);
      expect(tamperedDigestReplay).toMatchObject({failure: {code: 'delivery-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeTamperedDigest);
      const afterDelivery = yield* f.fs.readFileString(f.statePath());
      const closeoutWithoutProposal = yield* runNativeTaskAction(f.config, {
        command: 'finish',
        runId: 'native-run',
        callerCwd: f.repo,
      }).pipe(Effect.result);
      expect(closeoutWithoutProposal).toMatchObject({failure: {code: 'invalid-request'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterDelivery);
      const replayEnvelope = object(
        yield* mcp.invokeTool('workflow_task_deliver', {
          runId: 'native-run',
          callerCwd: f.repo,
          delivery: {command: 'commit', validationRef: String(delivered.deliveryRef), commitEvidence: evidence},
        }),
      );
      expect(object(replayEnvelope.structuredContent)).toMatchObject({
        status: 'delivered',
        replayed: true,
        receipt: delivered.receipt,
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterDelivery);
      const changedEvidence = yield* mcp
        .invokeTool('workflow_task_deliver', {
          runId: 'native-run',
          callerCwd: f.repo,
          delivery: {
            command: 'commit',
            validationRef: String(delivered.deliveryRef),
            commitEvidence: 'different commit',
          },
        })
        .pipe(Effect.result);
      expect(changedEvidence).toMatchObject({failure: {code: 'delivery-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterDelivery);
    }).pipe(run),
  );

  effectIt.effect('completes two dependent local phases through the task facade before closeout', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one', 'two'], 'local');
      const report = {
        mode: 'full',
        selected: ['correctness', 'simplicity'],
        lanes: [
          {name: 'correctness', status: 'complete'},
          {name: 'simplicity', status: 'complete'},
        ],
        findings: [],
      };
      const phaseEvidence: {id: string; acceptance: {criterion: string; evidence: string}[]}[] = [];
      for (const phaseId of ['one', 'two']) {
        if (phaseId === 'one') {
          const beforeEarlyStart = yield* f.fs.readFileString(f.statePath());
          const earlySecondPhase = yield* runNativeTaskAction(f.config, {
            command: 'work',
            runId: 'native-run',
            callerCwd: f.repo,
            phaseId: 'two',
            packet,
          }).pipe(Effect.result);
          expect(earlySecondPhase).toMatchObject({failure: {code: 'invalid-request'}});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeEarlyStart);
        }
        if (phaseId === 'two') yield* f.git(['checkout', '-b', 'feature/two']);
        const task = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(task).toMatchObject({status: 'ready', next: {action: 'implement', phaseId}});
        const begun = object(
          yield* runNativeTaskAction(f.config, {
            command: 'begin',
            runId: 'native-run',
            callerCwd: f.repo,
            taskRef: String(task.taskRef),
          }),
        );
        expect(begun).toMatchObject({status: 'begun', phaseId});
        const work = object(
          yield* runNativeTaskAction(f.config, {
            command: 'work',
            runId: 'native-run',
            callerCwd: f.repo,
            packet,
          }),
        );
        expect(work).toMatchObject({status: 'ready', phaseId});
        const workRef = String(work.workRef);
        const decodedWork = decodeNativeTaskActionRef(workRef);
        if (!decodedWork) throw new Error('The work continuation must be opaque and decodable by the runtime.');
        const beforeWrongPhase = yield* f.fs.readFileString(f.statePath());
        const wrongPhaseRef = encodeNativeTaskActionRef({
          ...decodedWork,
          phaseId: phaseId === 'one' ? 'two' : 'one',
        });
        const wrongPhase = yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: wrongPhaseRef,
        }).pipe(Effect.result);
        expect(wrongPhase._tag).toBe('Failure');
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeWrongPhase);
        yield* f.fs.writeFileString(
          f.path.join(f.repo, 'source.ts'),
          `export const fixture = "${phaseId} worker result";\n`,
        );
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', `${phaseId} worker result`]);
        const snapshot = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef,
          }),
        );
        const snapshotRef = String(snapshot.snapshotRef);
        const review = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-review',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef,
            report,
          }),
        );
        const validation = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-validation',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: String(review.snapshotRef),
            validation: {
              checks: [{command: 'focused dependent check', result: 'passed', evidence: `${phaseId} checked`}],
              acceptance: [{criterion: `${phaseId} works`, result: 'passed', evidence: `${phaseId} source readback`}],
            },
          }),
        );
        const delivery = object(
          yield* runNativeTaskAction(f.config, {
            command: 'deliver-local',
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef: String(validation.validationRef),
          }),
        );
        expect(delivery).toMatchObject({status: 'delivered', replayed: false});
        phaseEvidence.push({
          id: phaseId,
          acceptance: [{criterion: `${phaseId} works`, evidence: `${phaseId} delivered`}],
        });
      }
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      expect(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).toMatchObject({
        status: 'complete',
        next: {action: 'complete'},
      });
      const completedView = object(
        object(yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo})).structuredContent,
      );
      expect(completedView.next).toMatchObject({action: 'complete', tool: 'workflow_task_finish'});
      const multiPhaseProposal = {...proposal, phaseEvidence};
      const submittedEnvelope = object(
        yield* mcp
          .invokeTool('workflow_task_finish', {
            runId: 'native-run',
            callerCwd: f.repo,
            proposal: multiPhaseProposal,
          })
          .pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      const submitted = object(submittedEnvelope.structuredContent);
      expect(submitted).toMatchObject({status: 'pending', stage: 'prepare'});
      const prepareRef = String(submitted.prepareRef);
      const prepareJobId = String(decodeNativeTaskActionRef(prepareRef)?.jobId);
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', prepareJobId, f.call)).status).toBe('completed');
      const finishSubmitted = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal: multiPhaseProposal,
          prepareRef,
          resume: true,
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(finishSubmitted.status).toBe('pending');
      const finishRef = String(finishSubmitted.finishRef);
      const finishJobId = String(decodeNativeTaskActionRef(finishRef)?.jobId);
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', finishJobId, f.call)).status).toBe('completed');
      const completed = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal: multiPhaseProposal,
          finishRef,
          resume: true,
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(completed).toMatchObject({status: 'complete'});
    }).pipe(run),
  );

  effectIt.effect('resumes only the current blocked phase and replays the same recovery without another write', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const control = (taskRef: string, operation: unknown) =>
        mcp.invokeTool('workflow_task_control', {
          runId: 'native-run',
          callerCwd: f.repo,
          taskRef,
          control: operation,
        });
      const initial = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      const begun = object(object(yield* control(String(initial.taskRef), {command: 'begin'})).structuredContent);
      expect(begun.status).toBe('begun');
      const afterBegin = yield* f.fs.readFileString(f.statePath());
      const beginReplay = object(object(yield* control(String(initial.taskRef), {command: 'begin'})).structuredContent);
      expect(beginReplay).toMatchObject({status: 'begun', replayed: true, phaseId: 'one'});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterBegin);
      yield* f.mutate('invalidate', {phaseId: 'one', reason: 'A scoped source change invalidated this phase.'});
      const blocked = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(blocked).toMatchObject({status: 'blocked', next: {action: 'blocked', phaseId: 'one'}});
      const blockedRef = String(blocked.taskRef);
      const blockedRefValue = decodeNativeTaskActionRef(blockedRef);
      const blockedState = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(blockedRefValue).toMatchObject({
        kind: 'task',
        stateRevision: blockedState?.revision,
        phaseId: 'one',
        phaseHash: blockedState?.state.cycle?.state.phases.one?.phaseHash,
        taskAction: 'blocked',
      });
      const beforeWrongPhase = yield* f.fs.readFileString(f.statePath());
      const decoded = decodeNativeTaskActionRef(blockedRef);
      if (!decoded) throw new Error('The blocked phase card must carry a decodable opaque task reference.');
      const wrongPhase = encodeNativeTaskActionRef({...decoded, phaseId: 'other'});
      const wrongPhaseResult = yield* runNativeTaskAction(f.config, {
        command: 'resume',
        runId: 'native-run',
        callerCwd: f.repo,
        taskRef: wrongPhase,
        reason: 'The wrong phase must not be resumed.',
      }).pipe(Effect.result);
      expect(wrongPhaseResult).toMatchObject({failure: {code: 'stale-task-ref'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeWrongPhase);
      const reason = 'The current phase is repaired and its parent acceptance remains current.';
      const resumed = object(object(yield* control(blockedRef, {command: 'resume', reason})).structuredContent);
      expect(resumed).toMatchObject({status: 'resumed', replayed: false, phaseId: 'one'});
      const afterResume = yield* f.fs.readFileString(f.statePath());
      const replay = object(object(yield* control(blockedRef, {command: 'resume', reason})).structuredContent);
      expect(replay).toMatchObject({status: 'resumed', replayed: true, phaseId: 'one'});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterResume);
    }).pipe(run),
  );

  effectIt.effect('extends an exhausted review budget semantically and preserves continuous history', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const control = (taskRef: string, operation: unknown) =>
        mcp.invokeTool('workflow_task_control', {
          runId: 'native-run',
          callerCwd: f.repo,
          taskRef,
          control: operation,
        });
      const report = {
        mode: 'full',
        selected: ['correctness', 'simplicity'],
        lanes: [
          {name: 'correctness', status: 'complete'},
          {name: 'simplicity', status: 'complete'},
        ],
        findings: [],
      };
      let sixthSnapshotRef = '';
      for (let iteration = 1; iteration <= 6; iteration++) {
        const work = object(
          yield* runNativeTaskAction(f.config, {
            command: 'work',
            runId: 'native-run',
            callerCwd: f.repo,
            packet,
          }),
        );
        yield* f.fs.writeFileString(
          f.path.join(f.repo, 'source.ts'),
          `export const fixture = "review ${iteration}";\n`,
        );
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', `Review ${iteration}`]);
        const snapshot = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(work.workRef),
            ...(iteration === 1 ? {} : {reason: `Review iteration ${iteration} follows the reviewed predecessor.`}),
          }),
        );
        if (iteration === 6) {
          const blocked = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
          expect(blocked).toMatchObject({
            status: 'blocked',
            next: {action: 'expand-review-budget', phaseId: 'one'},
          });
          const taskRef = String(blocked.taskRef);
          const beforeInvalid = yield* f.fs.readFileString(f.statePath());
          const missingAuthority = yield* runNativeTaskAction(f.config, {
            command: 'extend-review-budget',
            runId: 'native-run',
            callerCwd: f.repo,
            taskRef,
            additionalReviews: 1,
            reason: 'A final independent review is still needed.',
            userAuthority: '',
          }).pipe(Effect.result);
          expect(missingAuthority._tag).toBe('Failure');
          expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeInvalid);
          const ref = decodeNativeTaskActionRef(taskRef);
          if (!ref) throw new Error('The exhausted review card must carry its opaque task reference.');
          const wrongPhaseTaskRef = encodeNativeTaskActionRef({...ref, phaseId: 'other'});
          const wrongPhase = yield* runNativeTaskAction(f.config, {
            command: 'extend-review-budget',
            runId: 'native-run',
            callerCwd: f.repo,
            taskRef: wrongPhaseTaskRef,
            additionalReviews: 1,
            reason: 'A final independent review is still needed.',
            userAuthority: 'Actual fixture authority for this budget increase.',
          }).pipe(Effect.result);
          expect(wrongPhase).toMatchObject({failure: {code: 'stale-task-ref'}});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeInvalid);
          const extensionControl = {
            command: 'extend-review-budget' as const,
            additionalReviews: 1,
            reason: 'A final independent review is still needed.',
            userAuthority: 'Actual fixture authority for this budget increase.',
          };
          const extended = object(object(yield* control(taskRef, extensionControl)).structuredContent);
          expect(extended).toMatchObject({status: 'extended', replayed: false, expansion: {from: 5, to: 6}});
          const afterExtension = yield* f.fs.readFileString(f.statePath());
          const replay = object(object(yield* control(taskRef, extensionControl)).structuredContent);
          expect(replay).toMatchObject({status: 'extended', replayed: true});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(afterExtension);
          const changedIntent = yield* runNativeTaskAction(f.config, {
            command: 'extend-review-budget',
            runId: 'native-run',
            callerCwd: f.repo,
            taskRef,
            additionalReviews: 1,
            userAuthority: 'Actual fixture authority for this budget increase.',
            reason: 'Changed recovery reason cannot reuse the prior extension reference.',
          }).pipe(Effect.result);
          expect(changedIntent).toMatchObject({failure: {code: 'stale-task-ref'}});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(afterExtension);
          sixthSnapshotRef = String(snapshot.snapshotRef);
        }
        const reviewView = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        if (iteration === 6)
          expect(reviewView).toMatchObject({status: 'ready', role: 'review', next: {action: 'review', phaseId: 'one'}});
        const review = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-review',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: String(snapshot.snapshotRef),
            report: {...report, mode: iteration === 1 ? 'full' : 'incremental'},
          }),
        );
        if (review.status !== 'recorded') throw new Error(JSON.stringify(review.attempt));
      }
      expect(sixthSnapshotRef.length).toBeGreaterThan(0);
      const after = yield* readNativeWorkflowState(f.config, 'native-run');
      const cycle = after?.state.cycle;
      expect(cycle?.reviews).toHaveLength(6);
      expect(cycle?.reviewExpansions).toHaveLength(1);
      expect(cycle?.reviewExpansions[0]).toMatchObject({
        phaseId: 'one',
        from: 5,
        to: 6,
        reason: 'A final independent review is still needed.',
        authority: 'Actual fixture authority for this budget increase.',
      });
    }).pipe(run),
  );

  // prettier-ignore
  effectIt.effect('reconciles a newly approved plan while preserving runtime-owned phase bindings', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
      yield* runCommandEffect('git', ['-C', f.repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
      yield* runCommandEffect('git', [
        '-C',
        f.repo,
        'config',
        '--local',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      ]);
      yield* runCommandEffect('git', ['-C', f.repo, 'config', '--local', 'user.name', 'Fixture']);
      yield* runCommandEffect('git', ['-C', f.repo, 'config', '--local', 'user.email', 'fixture@example.invalid']);
      yield* runCommandEffect('git', ['-C', f.repo, 'commit', '-m', 'Initialize reconcile fixture source']);
      const localMainHead = EffectString.trim(
        (yield* runCommandEffect('git', ['-C', f.repo, 'rev-parse', 'refs/heads/main'])).stdout,
      );
      yield* runCommandEffect('git', ['-C', f.repo, 'update-ref', 'refs/remotes/origin/main', localMainHead]);
      const indexed = yield* (yield* CodeGraphIndexer).index({cwd: f.repo, threadnoteHome: f.home});
      expect(indexed.snapshot.state).toBe('ready');
      const intent = {
        title: 'Refresh fixture data',
        currentBehavior: 'Expired fixture entries are returned as current.',
        desiredChange: 'Expired fixture entries are refreshed before return.',
        affectedPaths: ['source.ts'],
        acceptanceCriterion: 'Expired entries refresh before return.',
        verification: 'Exercise expiration and observe the refreshed value.',
        eligibilityRationale: 'One bounded file and one observable outcome.',
        eligibility: {status: 'eligible'},
        review: {required: false, reason: 'The bounded fixture contract is explicit.'},
      };
      const draft = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-start',
          runId: 'native-run',
          callerCwd: f.repo,
          intent,
        }),
      );
      const approved = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-confirm',
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: String(draft.intentHash),
          userDecision: 'approve',
          userResponse: 'I approve this exact bounded fixture change.',
          baseBranch: 'main',
        }),
      );
      expect(approved.status).toBe('admitted');
      // Establish real prior source/review/validation evidence before revising the plan.
      const oldFinding = {
        id: 'reconcile-retained-finding',
        file: 'source.ts',
        line: 1,
        body: 'The refreshed value needs an explicit persistence check.',
        trigger: 'A refreshed result is read again.',
        impact: 'A stale result could escape the refresh.',
        evidence: 'Observed the first immutable fixture snapshot.',
        severity: 'important',
        category: 'correctness',
        confidence: 90,
        state: 'new',
      };
      const lanes = [
        {name: 'correctness', status: 'complete'},
        {name: 'simplicity', status: 'complete'},
      ];
      let oldSnapshotRef = '';
      for (const iteration of [1, 2]) {
        const work = object(
          yield* runNativeTaskAction(f.config, {
            command: 'work',
            runId: 'native-run',
            callerCwd: f.repo,
            packet,
          }),
        );
        const oldWorkRef = String(work.workRef);
        yield* f.fs.writeFileString(
          f.path.join(f.repo, 'source.ts'),
          `export const fixture = "prior review ${iteration}";\n`,
        );
        yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
        yield* runCommandEffect('git', ['-C', f.repo, 'commit', '-m', `Prior review ${iteration}`]);
        const snapshot = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: oldWorkRef,
            ...(iteration === 2
              ? {reason: 'Resolve the first review finding in a new committed source snapshot.'}
              : {}),
          }),
        );
        oldSnapshotRef = String(snapshot.snapshotRef);
        const review = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-review',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: oldSnapshotRef,
            report: {
              mode: iteration === 1 ? 'full' : 'incremental',
              selected: ['correctness', 'simplicity'],
              lanes,
              findings: [
                iteration === 1
                  ? oldFinding
                  : {
                      ...oldFinding,
                      state: 'resolved',
                      reason: 'The second committed source fixes the observed persistence gap.',
                      evidence: 'Verified resolution in the second immutable source snapshot.',
                    },
              ],
            },
          }),
        );
        expect(review.status).toBe('recorded');
        oldSnapshotRef = String(review.snapshotRef);
      }
      const validation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: oldSnapshotRef,
          validation: {
            checks: [
              {
                command: 'fixture refresh readback',
                result: 'passed',
                evidence: 'Observed the second committed source.',
              },
            ],
            acceptance: [
              {
                criterion: intent.acceptanceCriterion,
                result: 'passed',
                evidence: 'The original bounded refresh acceptance passed.',
              },
            ],
          },
        }),
      );
      expect(
        object(
          yield* runNativeTaskAction(f.config, {
            command: 'deliver-local',
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef: String(validation.validationRef),
          }),
        ).status,
      ).toBe('delivered');
      const reindexed = yield* (yield* CodeGraphIndexer).index({cwd: f.repo, threadnoteHome: f.home});
      expect(reindexed.snapshot.state).toBe('ready');
      const initialCycleState = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(EffectArray.map(initialCycleState?.state.cycle?.state.plan.phases ?? [], phase => phase.id)).toEqual([
        'compact',
      ]);
      const priorRuntime = initialCycleState?.state.cycle;
      if (!initialCycleState || !priorRuntime) throw new Error('The original cycle evidence must exist.');
      const compactBinding = EffectArray.findFirst(priorRuntime.state.plan.phases, phase => phase.id === 'compact');
      if (compactBinding._tag === 'None') throw new Error('The original compact phase binding must exist.');
      expect(priorRuntime.snapshots).toHaveLength(2);
      expect(priorRuntime.reviews).toHaveLength(2);
      expect(priorRuntime.attempts).toHaveLength(2);
      expect(priorRuntime.state.phases.compact?.status).toBe('published');
      expect(priorRuntime.reviews[1]?.report.findings).toMatchObject([{id: oldFinding.id, state: 'resolved'}]);
      const currentRoot = object(approved.root);
      const loadedEnvelope = object(
        object(
          yield* f.call({
            ...f.base('authoring'),
            command: 'load',
            uri: currentRoot.uri,
            detail: 'document',
          }),
        ).authoring,
      );
      const currentDocument = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(
        loadedEnvelope.document,
      );
      const sourceInspection = object(
        object(
          yield* f.call({
            ...f.base('authoring'),
            command: 'scope-inspect',
            paths: ['source.ts'],
            literalOnly: true,
          }),
        ).authoring,
      );
      const firstPhase = currentDocument.phases[0];
      const firstAcceptance = firstPhase?.acceptance[0];
      if (!firstPhase || !firstAcceptance) throw new Error('The admitted plan must have one phase and acceptance.');
      const proposedDocument = {
        ...currentDocument,
        title: 'Refresh and verify fixture data',
        objective: 'Refresh expired fixture data and verify its persisted result.',
        requirements: [{id: 'behavior', behavior: 'Refresh and persist expired fixture data.'}],
        context: {
          codeRefs: ['source.ts'],
          evidenceRefs: [],
          note: 'A bounded fixture change with a follow-up persistence check.',
        },
        source: sourceInspection.source,
        current: {
          ...object(currentDocument.current),
          summary: 'Expired fixture data can be returned.',
          components: ['Fixture source'],
          contracts: [],
          diagram: 'flowchart TD\n  Source --> Reader',
        },
        target: {
          ...object(currentDocument.target),
          summary: 'Expired data is refreshed and persisted.',
          components: ['Refresh', 'Persist'],
          contracts: [],
          diagram: 'flowchart TD\n  Source --> Refresh --> Persist',
        },
        phases: [
          {
            ...firstPhase,
            acceptance: [{...firstAcceptance, requirementIds: ['behavior']}],
          },
          {
            ...firstPhase,
            id: 'p4-followup',
            title: 'Verify the persisted fixture result',
            outcome: 'The refreshed fixture value remains available after reload.',
            dependsOn: [String(firstPhase.id)],
            acceptance: [
              {
                ...firstAcceptance,
                id: 'persisted-result',
                criterion: 'The refreshed fixture value remains available after reload.',
                verification: 'Reload the fixture and observe the persisted value.',
                requirementIds: ['behavior'],
              },
            ],
          },
          {
            ...firstPhase,
            id: 'p4-closeout-check',
            title: 'Check the persisted fixture result',
            outcome: 'The persisted fixture value can be read back after refresh.',
            dependsOn: ['p4-followup'],
            acceptance: [
              {
                ...firstAcceptance,
                id: 'readback-result',
                criterion: 'The persisted fixture value can be read back after refresh.',
                verification: 'Read back the persisted fixture value after refresh.',
                requirementIds: ['behavior'],
              },
            ],
          },
        ],
        decisions: [
          {
            id: 'verify-after-refresh',
            question: 'How should persistence be checked?',
            selection: 'no-better-alternative',
            selected: 'Reload the fixture after the refresh.',
            alternatives: [],
            rationale: 'The second phase verifies the first phase output.',
            affectedPhases: [String(firstPhase.id), 'p4-followup', 'p4-closeout-check'],
            authority: 'orchestrator',
          },
        ],
        review: {required: true, reason: 'The expanded plan adds a dependent acceptance obligation.'},
      };
      const structural = object(
        object(
          yield* f.call({
            ...f.base('authoring'),
            command: 'validate',
            document: proposedDocument,
          }),
        ).authoring,
      );
      if (structural.issues instanceof Array && structural.issues.length)
        throw new Error(JSON.stringify(structural.issues));
      const expanded = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-expand',
          runId: 'native-run',
          callerCwd: f.repo,
          document: proposedDocument,
        }),
      );
      const expandedRoot = object(expanded.root);
      const expandedDocument = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(
        object(
          object(
            yield* f.call({
              ...f.base('authoring'),
              command: 'load',
              uri: expandedRoot.uri,
              detail: 'document',
            }),
          ).authoring,
        ).document,
      );
      const preReconcile = yield* readNativeWorkflowState(f.config, 'native-run');
      const priorPhaseIds = new Set(
        EffectArray.map(preReconcile?.state.cycle?.state.plan.phases ?? [], phase => phase.id),
      );
      const newPhases = EffectArray.filter(expandedDocument.phases, phase => !priorPhaseIds.has(phase.id));
      expect(EffectArray.map(newPhases, phase => phase.id)).toEqual(['p4-followup', 'p4-closeout-check']);
      const newBindings = {
        'p4-followup': {branch: 'feature/p4-followup', baseBranch: 'main'},
        'p4-closeout-check': {branch: 'feature/p4-closeout-check', baseBranch: 'main'},
      };
      const transitionBindings = {
        ...newBindings,
        compact: {branch: compactBinding.value.branch, baseBranch: 'refs/remotes/origin/main'},
      };
      const confirmResult = object(
        object(
          yield* f.call({
            ...f.base('authoring'),
            command: 'confirm',
            document: expandedDocument,
            presentedIntentHash: String(expanded.intentHash),
            userDecision: 'approve',
            userResponse: 'I approve this exact expanded two-phase plan.',
          }),
        ).authoring,
      );
      const saved = object(
        object(
          yield* f.call({
            ...f.base('authoring'),
            command: 'save',
            document: expandedDocument,
            ready: true,
            uri: object(expanded.root).uri,
            expectedRevision: object(expanded.root).revision,
            confirmation: confirmResult.confirmation,
            review: {
              documentHash: expanded.documentHash,
              outcome: 'accepted',
              blockingIssueCount: 0,
            },
          }),
        ).authoring,
      );
      const awaitingAdmission = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(awaitingAdmission).toMatchObject({
        status: 'blocked',
        next: {action: 'reconcile-plan'},
        authoring: {status: 'awaiting-admission'},
      });
      const taskRef = String(awaitingAdmission.taskRef);
      const authoringJournal = yield* f.fs.readFileString(f.journalPath(initialCycleState.state.bindingId));
      const ref = decodeNativeTaskActionRef(taskRef);
      if (!ref) throw new Error('The current reconcile card must provide a decodable task continuation.');
      for (const changedRef of [
        encodeNativeTaskActionRef({...ref, payloadDigest: EffectString.repeat(64)('0')}),
        encodeNativeTaskActionRef({...ref, generationHash: EffectString.repeat(64)('0')}),
        encodeNativeTaskActionRef({...ref, taskAction: 'blocked', phaseId: 'p4-followup'}),
        encodeNativeTaskActionRef({...ref, phaseId: 'p4-followup'}),
        encodeNativeTaskActionRef({...ref, stateRevision: EffectString.repeat(64)('0')}),
      ]) {
        const before = yield* f.fs.readFileString(f.statePath());
        const refused = yield* runNativeTaskAction(f.config, {
          command: 'reconcile',
          runId: 'native-run',
          callerCwd: f.repo,
          taskRef: changedRef,
          reason: 'A changed opaque reference has no authority.',
          bindings: newBindings,
        }).pipe(Effect.result);
        expect(refused).toMatchObject({failure: {code: 'stale-task-ref'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }
      const beforeRebinding = yield* f.fs.readFileString(f.statePath());
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'reconcile',
          runId: 'native-run',
          callerCwd: f.repo,
          taskRef,
          reason: 'Do not replace an existing runtime binding.',
          bindings: {...newBindings, compact: {branch: 'feature/rebound-old-phase', baseBranch: 'main'}},
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'invalid-request'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeRebinding);
      const invalidBaseTransition = yield* runNativeTaskAction(f.config, {
        command: 'reconcile',
        runId: 'native-run',
        callerCwd: f.repo,
        taskRef,
        reason: 'An unresolvable ref is not an approved comparison base.',
        bindings: {...transitionBindings, compact: {branch: compactBinding.value.branch, baseBranch: 'refs/tags/v1'}},
      }).pipe(Effect.result);
      expect(invalidBaseTransition).toMatchObject({failure: {code: 'invalid-request'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeRebinding);
      const beforeMissingBindings = yield* f.fs.readFileString(f.statePath());
      const missingBindings = yield* runNativeTaskAction(f.config, {
        command: 'reconcile',
        runId: 'native-run',
        callerCwd: f.repo,
        taskRef,
        reason: 'Reconcile the user-approved verification phase.',
      }).pipe(Effect.result);
      expect(missingBindings).toMatchObject({success: {status: 'needs-planning'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeMissingBindings);
      const beforeReconcile = yield* f.fs.readFileString(f.statePath());
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const invokeControl = (bindings: typeof newBindings | typeof transitionBindings) =>
        mcp.invokeTool('workflow_task_control', {
          runId: 'native-run',
          callerCwd: f.repo,
          taskRef,
          control: {
            command: 'reconcile',
            reason: 'Reconcile the user-approved verification phase.',
            bindings,
          },
        });
      const reconciled = object(object(yield* invokeControl(transitionBindings)).structuredContent);
      expect(reconciled).toMatchObject({status: 'reconciled', replayed: false});
      expect(yield* f.fs.readFileString(f.statePath())).not.toBe(beforeReconcile);
      const reconciledState = yield* readNativeWorkflowState(f.config, 'native-run');
      const nextRuntime = reconciledState?.state.cycle;
      if (!nextRuntime) throw new Error('The reconciled canonical cycle must exist.');
      expect(nextRuntime.plans).toHaveLength(priorRuntime.plans.length + 1);
      expect(nextRuntime.state.plan.phases).toHaveLength(3);
      expect(nextRuntime.state.plan.phases[0]?.branch).toBe(priorRuntime.state.plan.phases[0]?.branch);
      expect(nextRuntime.state.plan.phases[0]?.baseBranch).toBe('refs/remotes/origin/main');
      expect(nextRuntime.snapshots).toEqual(priorRuntime.snapshots);
      expect(nextRuntime.reviews).toEqual(priorRuntime.reviews);
      expect(nextRuntime.attempts).toEqual(priorRuntime.attempts);
      expect(nextRuntime.baselines).toEqual(priorRuntime.baselines);
      expect(nextRuntime.reviewLimits).toEqual(priorRuntime.reviewLimits);
      expect(nextRuntime.reviewExpansions).toEqual(priorRuntime.reviewExpansions);
      expect(nextRuntime.state.phases.compact?.status).toBe('stale');
      const previousProof = priorRuntime.state.phases.compact;
      expect(nextRuntime.state.phases.compact?.history).toEqual([
        {
          phaseHash: previousProof?.phaseHash,
          head: previousProof?.head,
          tree: previousProof?.tree,
          validation: previousProof?.validation,
          delivery: previousProof?.delivery,
        },
      ]);
      for (const id of ['compact', 'p4-followup', 'p4-closeout-check']) {
        expect(
          EffectArray.filter(
            nextRuntime.reviews,
            review => review.report.phaseHash === nextRuntime.state.phases[id]?.phaseHash,
          ),
        ).toHaveLength(0);
        expect(nextRuntime.state.phases[id]?.validation).toBeUndefined();
        expect(nextRuntime.state.phases[id]?.delivery).toBeUndefined();
      }
      const afterReconcile = yield* f.fs.readFileString(f.statePath());
      expect(object(object(yield* invokeControl(transitionBindings)).structuredContent)).toMatchObject({
        status: 'reconciled',
        replayed: true,
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterReconcile);
      expect(object(object(yield* invokeControl(newBindings)).structuredContent)).toMatchObject({
        status: 'reconciled',
        replayed: true,
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterReconcile);
      for (const bindings of [
        {...newBindings, 'p4-followup': {branch: 'feature/changed-choice', baseBranch: 'main'}},
        {...newBindings, compact: {branch: compactBinding.value.branch, baseBranch: 'main'}},
      ]) {
        expect(
          yield* runNativeTaskAction(f.config, {
            command: 'reconcile',
            runId: 'native-run',
            callerCwd: f.repo,
            taskRef,
            reason: 'Do not reinterpret an admitted replay as a new binding choice.',
            bindings,
          }).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'invalid-request'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(afterReconcile);
      }
      const blocked = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(blocked).toMatchObject({status: 'blocked', next: {action: 'blocked', phaseId: 'compact'}});
      expect(
        object(
          yield* runNativeTaskAction(f.config, {
            command: 'resume',
            runId: 'native-run',
            callerCwd: f.repo,
            taskRef: String(blocked.taskRef),
            reason: 'Requalify the original phase against the newly approved material plan.',
          }),
        ),
      ).toMatchObject({status: 'resumed', replayed: false, phaseId: 'compact'});
      const ready = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(ready).toMatchObject({status: 'ready', next: {action: 'implement', phaseId: 'compact'}});
      const beforeOldSnapshot = yield* f.fs.readFileString(f.statePath());
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: oldSnapshotRef,
          validation: {
            checks: [
              {
                command: 'fixture refresh readback',
                result: 'passed',
                evidence: 'Observed the second committed source.',
              },
            ],
            acceptance: [
              {
                criterion: intent.acceptanceCriterion,
                result: 'passed',
                evidence: 'The original bounded refresh acceptance passed.',
              },
            ],
          },
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'review-stale'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeOldSnapshot);
      expect(priorRuntime.state.plan.phases[0]).toMatchObject({branch: 'main', baseBranch: 'main'});
      const resumedWork = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "reconciled source";\n');
      yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
      yield* runCommandEffect('git', ['-C', f.repo, 'commit', '-m', 'Implement the newly approved material contract']);
      const newSnapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(resumedWork.workRef),
          reason: 'Requalify the changed material contract and current committed source.',
        }),
      );
      const captured = yield* readNativeWorkflowState(f.config, 'native-run');
      const newEvidence = captured?.state.cycle?.snapshots[2]?.snapshot;
      expect(newEvidence?.supersedes).toBe(priorRuntime.snapshots[1]?.snapshot.snapshotId);
      expect(newEvidence?.phaseHash).not.toBe(priorRuntime.snapshots[1]?.snapshot.phaseHash);
      expect(newEvidence?.head).not.toBe(priorRuntime.snapshots[1]?.snapshot.head);
      expect(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).toMatchObject({
        next: {action: 'review', phaseId: 'compact'},
      });
      const reviewed = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(newSnapshot.snapshotRef),
          report: {
            mode: 'full',
            selected: ['correctness', 'simplicity'],
            lanes,
            findings: [
              {
                ...oldFinding,
                state: 'resolved',
                reason: 'Rechecked the prior fix under the changed contract.',
                evidence: 'Observed the new committed source and material plan.',
              },
            ],
          },
        }),
      );
      expect(reviewed.status).toBe('recorded');
      const newValidation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(reviewed.snapshotRef),
          validation: {
            checks: [
              {command: 'fixture revised refresh check', result: 'passed', evidence: 'New material contract checked.'},
            ],
            acceptance: [
              {
                criterion: intent.acceptanceCriterion,
                result: 'passed',
                evidence: 'Rechecked current source after plan reconciliation.',
              },
            ],
          },
        }),
      );
      expect(
        object(
          yield* runNativeTaskAction(f.config, {
            command: 'deliver-local',
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef: String(newValidation.validationRef),
          }),
        ).status,
      ).toBe('delivered');
      const followup = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(followup).toMatchObject({next: {action: 'blocked', phaseId: 'p4-followup'}});
      expect(
        object(
          yield* runNativeTaskAction(f.config, {
            command: 'resume',
            runId: 'native-run',
            callerCwd: f.repo,
            taskRef: String(followup.taskRef),
            reason: 'The reconciled parent has fresh acceptance and local delivery.',
          }),
        ),
      ).toMatchObject({status: 'resumed', phaseId: 'p4-followup'});
      yield* runCommandEffect('git', ['-C', f.repo, 'checkout', '-b', 'feature/p4-followup']);
      const followupReady = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(
        object(
          yield* runNativeTaskAction(f.config, {
            command: 'begin',
            runId: 'native-run',
            callerCwd: f.repo,
            taskRef: String(followupReady.taskRef),
          }),
        ),
      ).toMatchObject({status: 'begun', phaseId: 'p4-followup'});
      const finalState = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(finalState?.state.cycle?.plans).toHaveLength(priorRuntime.plans.length + 1);
      expect(finalState?.state.cycle?.attempts).toHaveLength(3);
      expect(finalState?.state.cycle?.reviewLimits).toEqual(priorRuntime.reviewLimits);
      expect(finalState?.state.cycle?.state.plan.phases[0]).toEqual(nextRuntime.state.plan.phases[0]);
      expect(finalState?.state.cycle?.state.phases['p4-followup']?.validation).toBeUndefined();
      expect(yield* f.fs.readFileString(f.journalPath(initialCycleState.state.bindingId))).toBe(authoringJournal);
      expect(saved.readiness).toBe('ready');
      expect(expanded.intentHash).not.toBe(draft.intentHash);
    }).pipe(run),
    windowsRealGitFixtureTimeout,
  );

  effectIt.effect(
    'reopens a published phase from its current card and carries fresh proof through local delivery',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one'], 'local');
        yield* completeLocalPhase(f, 'one');
        const current = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(current).toMatchObject({next: {action: 'complete'}, taskRef: expect.any(String)});
        const stateBefore = yield* f.fs.readFileString(f.statePath());
        const request = {
          command: 'reopen' as const,
          runId: 'native-run',
          callerCwd: f.repo,
          taskRef: String(current.taskRef),
          phaseId: 'one',
          reason: 'CI found a defect in the delivered phase.',
        };
        const wrongPhase = yield* runNativeTaskAction(f.config, {...request, phaseId: 'missing'}).pipe(Effect.result);
        expect(wrongPhase).toMatchObject({failure: {code: 'phase-not-reopenable'}});
        const decoded = decodeNativeTaskActionRef(request.taskRef);
        if (!decoded) throw new Error('The complete task card must carry an opaque reference.');
        const foreign = yield* runNativeTaskAction(f.config, {
          ...request,
          taskRef: encodeNativeTaskActionRef({...decoded, generationHash: sha256HexSync('foreign-generation')}),
        }).pipe(Effect.result);
        expect(foreign).toMatchObject({failure: {code: 'stale-task-ref'}});
        yield* f.git(['checkout', '-b', 'wrong-branch']);
        const wrongBranch = yield* runNativeTaskAction(f.config, request).pipe(Effect.result);
        expect(wrongBranch).toMatchObject({failure: {code: 'wrong-branch'}});
        yield* f.git(['checkout', 'feature/one']);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(stateBefore);

        // The reviewed tree is still current: reopening must work before any source bytes change.
        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, f.config);
        const reopened = object(
          (yield* mcp.invokeTool('workflow_task_control', {
            runId: request.runId,
            callerCwd: request.callerCwd,
            taskRef: request.taskRef,
            control: {command: 'reopen', phaseId: request.phaseId, reason: request.reason},
          })).structuredContent,
        );
        expect(reopened).toMatchObject({status: 'reopened', phaseId: 'one', task: {next: {action: 'blocked'}}});
        const invalidated = yield* readNativeWorkflowState(f.config, 'native-run');
        expect(invalidated?.state.cycle?.state.phases.one).toMatchObject({
          status: 'stale',
          history: [expect.objectContaining({delivery: expect.any(Object), validation: expect.any(Object)})],
        });
        const retiredId = invalidated?.state.cycle?.snapshots.at(-1)?.snapshot.snapshotId;
        expect(invalidated?.state.cycle?.invalidatedThroughSnapshot).toEqual({one: retiredId});
        if (!invalidated?.state.cycle || !retiredId) throw new Error('Expected retained cycle proof.');
        expect(() =>
          decodeNativeCycleRuntime({
            ...invalidated.state.cycle,
            invalidatedThroughSnapshot: {one: 'missing-snapshot'},
          }),
        ).toThrow();
        expect(() =>
          decodeNativeCycleRuntime({...invalidated.state.cycle, invalidatedThroughSnapshot: {other: retiredId}}),
        ).toThrow();
        expect(invalidated?.state.cycle?.state.phases.one.history).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              tree: invalidated?.state.cycle?.snapshots.at(-1)?.snapshot.tree,
            }),
          ]),
        );
        const staleReplay = yield* runNativeTaskAction(f.config, request).pipe(Effect.result);
        expect(staleReplay).toMatchObject({failure: {code: 'stale-task-ref'}});
        const blocked = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        const resumed = object(
          yield* runNativeTaskAction(f.config, {
            command: 'resume',
            runId: 'native-run',
            callerCwd: f.repo,
            taskRef: String(blocked.taskRef),
            reason: request.reason,
          }),
        );
        expect(resumed).toMatchObject({status: 'resumed', phaseId: 'one'});
        const priorRuntime = invalidated.state.cycle;
        const priorSnapshot = priorRuntime.snapshots.at(-1)?.snapshot;
        const priorBaseline = priorRuntime.baselines.one;
        if (!priorSnapshot || !priorBaseline) throw new Error('Expected the retired reviewed snapshot and baseline.');
        const retiredSnapshotRef = encodeNativeTaskActionRef({
          version: 1,
          kind: 'snapshot',
          runId: 'native-run',
          generationHash: sha256HexSync(invalidated.state.generation),
          phaseId: 'one',
          phaseHash: priorSnapshot.phaseHash,
          baselineHead: priorBaseline.head,
          baselineTree: priorBaseline.tree,
          baselineRef: priorBaseline.pinnedRef,
          snapshotId: priorSnapshot.snapshotId,
          sourceHead: priorSnapshot.head,
          sourceTree: priorSnapshot.tree,
        });
        const beforeRetiredReplay = yield* f.fs.readFileString(f.statePath());
        const oldValidation = {
          checks: [{command: 'retired check', result: 'passed' as const, evidence: 'Old source check.'}],
          acceptance: [{criterion: 'one works', result: 'passed' as const, evidence: 'Old acceptance.'}],
        };
        expect(
          yield* runNativeTaskAction(f.config, {
            command: 'record-validation',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: retiredSnapshotRef,
            validation: oldValidation,
          }).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'review-stale'}});
        const actualHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        expect(
          yield* f
            .mutate('ready', {
              phaseId: 'one',
              snapshotId: priorSnapshot.snapshotId,
              acceptedHead: actualHead,
              validation: {
                ...oldValidation,
                snapshotTree: priorSnapshot.tree,
                reviewTree: priorSnapshot.tree,
                head: actualHead,
                status: 'passed',
                productState: 'working',
              },
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'review-stale'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeRetiredReplay);
        const ready = yield* (yield* CodeGraphIndexer).index({cwd: f.repo, threadnoteHome: f.home});
        expect(ready.snapshot.state).toBe('ready');
        const work = object(
          yield* runNativeTaskAction(f.config, {
            command: 'work',
            runId: 'native-run',
            callerCwd: f.repo,
            packet,
          }),
        );
        expect(work).toMatchObject({status: 'ready', phaseId: 'one', workRef: expect.any(String)});
        const sameTree = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(work.workRef),
            reason: 'Recheck the same source after the CI environment was corrected.',
          }),
        );
        const sameTreeRef = String(sameTree.snapshotRef);
        expect((yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).next).toMatchObject({
          action: 'review',
          phaseId: 'one',
        });
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: sameTreeRef,
          report: {
            mode: 'incremental',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings: [],
          },
        });
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: sameTreeRef,
          validation: {
            checks: [{command: 'environment check', result: 'passed', evidence: 'The same source passed again.'}],
            acceptance: [{criterion: 'one works', result: 'passed', evidence: 'The same source was rechecked.'}],
          },
        });
        const validatedCard = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(validatedCard.next.action).toBe('deliver');
        let reopenedValidation: Record<string, unknown> | undefined;
        const cliActions = makeNativeTaskActionCommands(
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          options =>
            runNativeTaskAction(f.config, options).pipe(
              Effect.tap(value => Effect.sync(() => (reopenedValidation = object(value)))),
              Effect.asVoid,
            ),
        );
        const cli = Command.make('workflow-automation').pipe(Command.withSubcommands([cliActions]));
        yield* Command.runWith(cli, {version: 'fixture'})([
          'task-action',
          'reopen',
          '--run-id',
          'native-run',
          '--caller-cwd',
          f.repo,
          '--task-ref',
          String(validatedCard.taskRef),
          '--phase-id',
          'one',
          '--reason',
          'The corrected CI environment revealed a remaining source defect.',
        ]);
        expect(reopenedValidation).toMatchObject({status: 'reopened', phaseId: 'one'});
        const secondBlocked = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        yield* runNativeTaskAction(f.config, {
          command: 'resume',
          runId: 'native-run',
          callerCwd: f.repo,
          taskRef: String(secondBlocked.taskRef),
          reason: 'The source defect is ready for another bounded implementation.',
        });
        const secondWork = object(
          yield* runNativeTaskAction(f.config, {
            command: 'work',
            runId: 'native-run',
            callerCwd: f.repo,
            packet,
          }),
        );
        expect(secondWork).toMatchObject({status: 'ready', phaseId: 'one'});
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "CI repair";\n');
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Repair delivered phase']);
        const snapshot = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(secondWork.workRef),
            reason: request.reason,
          }),
        );
        const snapshotRef = String(snapshot.snapshotRef);
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          report: {
            mode: 'incremental',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings: [],
          },
        });
        const validation = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-validation',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef,
            validation: {
              checks: [{command: 'CI repair check', result: 'passed', evidence: 'The corrected fixture passed.'}],
              acceptance: [{criterion: 'one works', result: 'passed', evidence: 'The corrected fixture was checked.'}],
            },
          }),
        );
        expect(
          object(
            yield* runNativeTaskAction(f.config, {
              command: 'deliver-local',
              runId: 'native-run',
              callerCwd: f.repo,
              validationRef: String(validation.validationRef),
            }),
          ).status,
        ).toBe('delivered');
        expect((yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).next.action).toBe(
          'complete',
        );
      }).pipe(run),
    windowsRealGitFixtureTimeout,
  );

  effectIt.effect('recovers an epochless first finish from only prepareRef through concurrent completion', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      yield* completeLocalPhase(f, 'one');
      const finish = (fields: Record<string, unknown>) =>
        runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          ...fields,
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false), Effect.map(object));
      const preparing = yield* finish({proposal});
      const prepareRef = String(preparing.prepareRef);
      const prepareJobId = String(decodeNativeTaskActionRef(prepareRef)?.jobId);
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', prepareJobId, f.call)).status).toBe('completed');
      const prepared = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      expect(prepared?.state.status).toBe('prepared');
      expect(prepared?.state.admissionEpoch).toBeUndefined();
      let lostAcknowledgment: Record<string, unknown> | undefined;
      const lost = yield* finish({prepareRef}).pipe(
        Effect.tap(value => Effect.sync(() => (lostAcknowledgment = value))),
        Effect.andThen(Effect.fail(WorkflowAutomationError.make({code: 'test-lost-ack', message: 'Lost finish ACK'}))),
        Effect.result,
      );
      expect(lost._tag).toBe('Failure');
      const closeoutFile = f.statePath() + '.closeout.json';
      const beforePending = yield* f.fs.readFileString(closeoutFile);
      const stateBeforeReplay = yield* f.fs.readFileString(f.statePath());
      const jobsDirectory = f.path.join(f.home, 'workflow-automations', 'native-v1', 'jobs', 'native-run');
      const jobsBeforeReplay = yield* f.fs.readDirectory(jobsDirectory);
      const pending = yield* finish({prepareRef});
      expect(pending).toMatchObject({status: 'pending', stage: 'finish', finishRef: lostAcknowledgment?.finishRef});
      expect(yield* f.fs.readFileString(closeoutFile)).toBe(beforePending);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(stateBeforeReplay);
      expect(yield* f.fs.readDirectory(jobsDirectory)).toEqual(jobsBeforeReplay);
      const finishRef = String(pending.finishRef);
      const finishJobId = String(decodeNativeTaskActionRef(finishRef)?.jobId);
      const interleaving = yield* completeDuringJournalRead(f, finishJobId);
      const completed = yield* finish({prepareRef}).pipe(
        Effect.provideService(FileSystem.FileSystem, interleaving.filesystem),
      );
      expect(interleaving.wasCaptured()).toBe(true);
      expect(completed).toMatchObject({status: 'complete', stage: 'finish', replayed: true, finishRef});
      const canonical = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      expect(canonical?.state.status).toBe('complete');
      expect(canonical?.state.transactionId).toBe(prepared?.state.transactionId);
      expect(canonical?.state.admissionEpoch).toBeUndefined();
      expect(completed.closeout).toEqual({
        transactionId: canonical?.state.transactionId,
        documentDigest: canonical?.state.documentDigest,
        outputs: canonical?.state.outputs,
        archives: canonical?.state.archives,
      });
      const completedBytes = yield* f.fs.readFileString(closeoutFile);
      const completedState = yield* f.fs.readFileString(f.statePath());
      const finishedCard = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      const reopenFinished = yield* runNativeTaskAction(f.config, {
        command: 'reopen',
        runId: 'native-run',
        callerCwd: f.repo,
        taskRef: String(finishedCard.taskRef),
        phaseId: 'one',
        reason: 'A finished closeout cannot be rewritten.',
      }).pipe(Effect.result);
      expect(reopenFinished).toMatchObject({failure: {code: 'closeout-in-progress'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(completedState);
      expect(yield* finish({prepareRef})).toEqual(completed);
      expect(yield* f.fs.readFileString(closeoutFile)).toBe(completedBytes);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(completedState);
      expect(yield* f.fs.readDirectory(jobsDirectory)).toEqual(jobsBeforeReplay);
    }).pipe(run),
  );

  effectIt.effect('rejects a stale unadmitted work reference without changing native state', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const work = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      yield* f.mutate('invalidate', {phaseId: 'one', reason: 'Fixture drift invalidates this packet.'});
      const before = yield* f.fs.readFileString(f.statePath());
      const result = yield* runNativeTaskAction(f.config, {
        command: 'record-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        workRef: String(work.workRef),
      }).pipe(Effect.result);
      expect(result).toMatchObject({failure: {code: 'stale-work-ref'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

  effectIt.effect(
    'replays a CLI review mutation through MCP after its acknowledgment is lost and source advances',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one'], 'local');
        yield* f.mutate('begin-phase', {phaseId: 'one'});
        const work = object(
          yield* runNativeTaskAction(f.config, {
            command: 'work',
            runId: 'native-run',
            callerCwd: f.repo,
            packet,
          }),
        );
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "reviewed";\n');
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Review snapshot']);
        const snapshot = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(work.workRef),
          }),
        );
        const snapshotRef = String(snapshot.snapshotRef);
        yield* f.git(['checkout', '--', 'source.ts']);
        const report = {
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        };
        const invalidReview = yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          report: {mode: 'full', selected: ['correctness'], findings: []},
        }).pipe(Effect.result);
        expect(invalidReview).toMatchObject({
          failure: {code: 'invalid-request', message: expect.stringContaining('lanes')},
        });
        const beforeReviewCommit = yield* f.fs.readFileString(f.statePath());
        let lostAcknowledgmentResult: Record<string, unknown> | undefined;
        const lostAck = WorkflowAutomationError.make({code: 'test-lost-ack', message: 'Simulated lost CLI response.'});
        const commands = makeNativeTaskActionCommands(
          () => Effect.void,
          () => Effect.void,
          options =>
            runNativeTaskAction(f.config, {command: 'record-review', ...options}).pipe(
              Effect.tap(value => Effect.sync(() => (lostAcknowledgmentResult = object(value)))),
              Effect.andThen(Effect.fail(lostAck)),
            ),
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
        );
        const cli = Command.make('workflow-automation').pipe(Command.withSubcommands([commands]));
        const runCli = Command.runWith(cli, {version: 'fixture'});
        const cliResult = yield* runCli([
          'task-action',
          'record-review',
          '--run-id',
          'native-run',
          '--caller-cwd',
          f.repo,
          '--snapshot-ref',
          snapshotRef,
          '--report',
          JSON.stringify(report),
        ]).pipe(Effect.result);
        expect(cliResult._tag).toBe('Failure');
        const persistedAfterCli = yield* f.fs.readFileString(f.statePath());
        expect(persistedAfterCli).not.toBe(beforeReviewCommit);
        expect(lostAcknowledgmentResult).toMatchObject({status: 'recorded', replayed: false});
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "advanced";\n');
        const stateBeforeRetry = yield* f.fs.readFileString(f.statePath());

        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, f.config);
        const response = object(
          yield* mcp.invokeTool('workflow_task_record_review', {
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef,
            ...report,
          }),
        );
        expect(response.isError).not.toBe(true);
        const retry = object(response.structuredContent);
        expect(retry).toMatchObject({status: 'recorded', replayed: true});
        expect(retry.attempt).toEqual(lostAcknowledgmentResult?.attempt);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(stateBeforeRetry);
        expect(stateBeforeRetry).toBe(persistedAfterCli);
      }).pipe(run, provideTestLayer(cliTestLayer)),
  );

  effectIt.effect('derives anchor digests at both CLI and MCP work boundaries', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      let cliWork: Record<string, unknown> | undefined;
      const commands = makeNativeTaskActionCommands(
        options =>
          runNativeTaskAction(f.config, {
            command: 'work',
            runId: options.runId,
            callerCwd: options.callerCwd,
            packet: options.packet,
          }).pipe(
            Effect.tap(value => Effect.sync(() => (cliWork = object(value)))),
            Effect.asVoid,
          ),
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
      );
      const command = Command.make('workflow-automation').pipe(Command.withSubcommands([commands]));
      const runCommand = Command.runWith(command, {version: 'fixture'});
      yield* runCommand([
        'task-action',
        'work',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--model',
        'fixture-background',
        '--effort',
        'low',
        '--selection',
        'least-sufficient',
        '--risk',
        'settled',
        '--reason',
        packet.capacity.reason,
        '--catalog-evidence',
        packet.capacity.catalogEvidence,
        '--anchor-path',
        'source.ts',
        '--anchor-pattern',
        'export const fixture',
        '--ownership',
        'source.ts',
        '--check',
        'bun test focused fixture',
      ]);
      expect(cliWork).toMatchObject({status: 'ready'});

      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const response = object(
        yield* mcp.invokeTool('workflow_task_work', {
          runId: 'native-run',
          callerCwd: f.repo,
          ...packet,
        }),
      );
      expect(response.isError).not.toBe(true);
      const mcpWork = object(response.structuredContent);
      expect(mcpWork.status).toBe('ready');
      expect(mcpWork.workRef).toBe(cliWork?.workRef);
    }).pipe(run, provideTestLayer(cliTestLayer)),
  );

  effectIt.effect('uses the declared packet budget and keeps bounded recovery for oversized packets', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const largePacket = {
        ...packet,
        budgetBytes: 48_000,
        checks: Array.from({length: 32}, (_, index) => `${index} ${EffectString.repeat(900)('x')}`),
      };
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const largeResponse = object(
        yield* mcp.invokeTool('workflow_task_work', {
          runId: 'native-run',
          callerCwd: f.repo,
          ...largePacket,
        }),
      );
      const largeWork = object(largeResponse.structuredContent);
      expect(largeWork.status).toBe('ready');
      const largePacketBytes = new TextEncoder().encode(JSON.stringify(largeWork.packet)).byteLength;
      expect(largePacketBytes).toBeGreaterThan(16_384);
      expect(largePacketBytes).toBeLessThanOrEqual(48_000);

      const ceilingRefs = Array.from(
        {length: 16},
        (_, index) => `threadnote://fixture/spec/${index}-${EffectString.repeat(1_500)('r')}`,
      );
      let remaining =
        65_536 -
        new TextEncoder().encode(
          JSON.stringify({...object(largeWork.packet), checks: largePacket.checks, detailRefs: ceilingRefs}),
        ).byteLength;
      expect(remaining).toBeGreaterThan(0);
      for (let index = 0; index < ceilingRefs.length && remaining > 0; index += 1) {
        const room = 4_096 - new TextEncoder().encode(ceilingRefs[index]).byteLength;
        const added = Math.min(remaining, room);
        ceilingRefs[index] += EffectString.repeat(added)('r');
        remaining -= added;
      }
      expect(remaining).toBe(0);
      const ceilingPacket = {...largePacket, budgetBytes: 65_536, detailRefs: ceilingRefs};
      const ceilingResponse = object(
        yield* mcp.invokeTool('workflow_task_work', {
          runId: 'native-run',
          callerCwd: f.repo,
          ...ceilingPacket,
        }),
      );
      const ceilingWork = object(ceilingResponse.structuredContent);
      expect(ceilingWork.status).toBe('ready');
      expect(new TextEncoder().encode(JSON.stringify(ceilingWork.packet)).byteLength).toBe(65_536);

      const shortResponse = object(
        yield* mcp.invokeTool('workflow_task_work', {
          runId: 'native-run',
          callerCwd: f.repo,
          ...ceilingPacket,
          budgetBytes: 65_535,
        }),
      );
      expect(shortResponse.structuredContent).toMatchObject({
        status: 'unavailable',
        reason: 'packet-budget-exceeded',
        requiredBytes: 65_536,
      });
      const nonPacket = yield* f.call({...f.base('cycle'), command: 'inspect', maxBytes: 66_048}).pipe(Effect.result);
      expect(nonPacket).toMatchObject({failure: {code: 'invalid-request'}});

      const smallResponse = object(
        yield* mcp.invokeTool('workflow_task_work', {
          runId: 'native-run',
          callerCwd: f.repo,
          ...packet,
          budgetBytes: 1_024,
          detailRefs: Array.from(
            {length: 16},
            (_, index) => `threadnote://fixture/spec/${index}-${EffectString.repeat(4_000)('r')}`,
          ),
        }),
      );
      expect(smallResponse.structuredContent).toMatchObject({
        status: 'unavailable',
        reason: 'response-budget-exceeded',
        continuation: {command: 'detail', phaseId: 'one', omittedDetailRefs: 16},
      });
      const smallWork = object(smallResponse.structuredContent);
      expect(smallWork.requiredBytes).toEqual(expect.any(Number));
      expect(new TextEncoder().encode(JSON.stringify(smallWork)).byteLength).toBeLessThanOrEqual(1_024);

      const longRef = `threadnote://fixture/spec/${EffectString.repeat(4_000)('r')}`;
      const longRefResponse = object(
        yield* mcp.invokeTool('workflow_task_work', {
          runId: 'native-run',
          callerCwd: f.repo,
          ...packet,
          budgetBytes: 8_192,
          checks: largePacket.checks,
          detailRefs: [longRef],
        }),
      );
      expect(longRefResponse.structuredContent).toMatchObject({
        status: 'unavailable',
        reason: 'packet-budget-exceeded',
        detailRefs: [longRef],
        continuation: 'Read the exact phase acceptance and ownership, then create a bounded implementation slice.',
      });
    }).pipe(run, provideTestLayer(cliTestLayer)),
  );

  effectIt.effect.prop(
    'keeps task projection deterministic and refuses generated unknown historical phases without mutation',
    {
      suffixes: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,12}$/u))).check(
        Schema.isBetweenLength(1, 4),
      ),
    },
    ({suffixes}) =>
      Effect.gen(function* () {
        const f = yield* fixture(['one'], 'local');
        const first = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        const second = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(second).toEqual(first);
        const stateBefore = yield* f.fs.readFileString(f.statePath());
        for (const suffix of new Set(suffixes)) {
          const refusal = yield* readNativeTaskView(f.config, {
            runId: 'native-run',
            callerCwd: f.repo,
            phaseId: `unknown-${suffix}`,
          }).pipe(Effect.result);
          expect(refusal).toMatchObject({failure: {code: 'historical-phase-not-found'}});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(stateBefore);
        }
      }).pipe(run),
    {arbitrary: {runs: 4}},
  );

  effectIt.effect.prop(
    'refuses generated wrong-run work references without changing canonical native state',
    {
      suffixes: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,12}$/u))).check(
        Schema.isBetweenLength(1, 4),
      ),
    },
    ({suffixes}) =>
      Effect.gen(function* () {
        const f = yield* fixture(['one'], 'local');
        yield* f.mutate('begin-phase', {phaseId: 'one'});
        const work = object(
          yield* runNativeTaskAction(f.config, {
            command: 'work',
            runId: 'native-run',
            callerCwd: f.repo,
            packet,
          }),
        );
        const ref = decodeNativeTaskActionRef(String(work.workRef));
        if (!ref) throw new Error('The admitted work reference must decode before scope mutation.');
        const stateBefore = yield* f.fs.readFileString(f.statePath());
        for (const suffix of new Set(suffixes)) {
          const altered = encodeNativeTaskActionRef({...ref, runId: `foreign-${suffix}`});
          const refusal = yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: altered,
          }).pipe(Effect.result);
          expect(refusal).toMatchObject({failure: {code: 'invalid-work-ref'}});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(stateBefore);
        }
      }).pipe(run),
    {arbitrary: {runs: 4}},
  );
});

effectIt.effect('routes distinct semantic proof inputs through CLI adapters', () =>
  Effect.gen(function* () {
    const captured: object[] = [];
    const record = (options: object) =>
      Effect.sync(() => {
        captured.push(options);
      });
    const cli = Command.make('workflow-automation').pipe(
      Command.withSubcommands([
        makeNativeTaskSupplementalCommand(record),
        makeNativeTaskInvalidTailCommand(record),
        makeNativeTaskPrWatchCommand(record),
      ]),
    );
    const invoke = Command.runWith(cli, {version: 'fixture'});
    yield* invoke([
      'publish-local',
      '--run-id',
      'run',
      '--caller-cwd',
      '/repo',
      '--task-ref',
      'complete-ref',
      '--phase-id',
      'one',
      '--pr',
      '{"url":"https://github.com/example/repo/pull/1"}',
      '--user-authority',
      'Attach this existing PR.',
    ]);
    yield* invoke([
      'requalify-invalid-tail',
      '--run-id',
      'run',
      '--caller-cwd',
      '/repo',
      '--task-ref',
      'tail-task',
      '--predecessor-ref',
      'tail-source',
      '--reason',
      'Prepared normal merge.',
      '--user-authority',
      'Authorize qualification.',
      '--phase-owned-paths',
      '[{"phaseId":"one","paths":["source.ts"]}]',
    ]);
    yield* invoke([
      'watch-pr',
      '--run-id',
      'run',
      '--caller-cwd',
      '/repo',
      '--operation',
      'start',
      '--snapshot-ref',
      'immutable-source',
      '--pr',
      'https://github.com/example/repo/pull/1',
    ]);
    yield* invoke([
      'watch-pr',
      '--caller-cwd',
      '/repo',
      '--operation',
      'start',
      '--pr-url',
      'https://github.com/example/repo/pull/1',
      '--host',
      'claude-code',
      '--host-executable',
      '/home/user/.local/bin/claude',
      '--host-reference',
      'cccccccc-cccc-4ccc-cccc-cccccccccccc',
      '--workspace',
      '/repo',
    ]);
    expect(captured[0]).toMatchObject({
      taskRef: 'complete-ref',
      phaseId: 'one',
      pr: {url: 'https://github.com/example/repo/pull/1'},
      userAuthority: 'Attach this existing PR.',
    });
    expect(captured[1]).toMatchObject({
      taskRef: 'tail-task',
      predecessorRef: 'tail-source',
      phaseOwnedPaths: [{phaseId: 'one', paths: ['source.ts']}],
    });
    expect(captured[2]).toMatchObject({
      snapshotRef: 'immutable-source',
      operation: 'start',
      pr: 'https://github.com/example/repo/pull/1',
    });
    expect(captured[3]).toMatchObject({
      wakeup: {
        host: 'claude-code',
        executable: '/home/user/.local/bin/claude',
        sessionId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
        workspace: '/repo',
        exclusiveSession: true,
      },
    });
  }).pipe(provideTestLayer(cliTestLayer)),
);

effectIt.effect(
  'captures foreground citations at most twice for workflow_task_start and workflow_task_compact_confirm',
  () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
      yield* runCommandEffect('git', [
        '-C',
        f.repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'Fixture source',
      ]);
      const system = yield* SystemInfo;
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      const config = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
      const scopedSystem = {...system, currentDirectory: () => repo, homeDirectory: home};
      yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(Effect.provideService(SystemInfo, scopedSystem));
      const indexer = yield* CodeGraphIndexer;
      expect((yield* indexer.index({cwd: repo, threadnoteHome: home})).snapshot.state).toBe('ready');

      const graphStore = yield* CodeGraphStore;
      let evidenceReads = 0;
      const observedGraphStore = CodeGraphStore.of({
        ...graphStore,
        ...(graphStore.readReadySnapshotCitationEvidence
          ? {
              readReadySnapshotCitationEvidence: (...args) =>
                Effect.sync(() => {
                  evidenceReads += 1;
                }).pipe(Effect.andThen(graphStore.readReadySnapshotCitationEvidence!(...args))),
            }
          : {}),
        effectiveSnapshotCitationEvidence: (...args) =>
          Effect.sync(() => {
            evidenceReads += 1;
          }).pipe(Effect.andThen(graphStore.effectiveSnapshotCitationEvidence(...args))),
      });
      const countCaptures = <A, E, R>(program: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          evidenceReads = 0;
          const value = yield* program.pipe(Effect.provideService(SystemInfo, scopedSystem));
          return {value, captures: evidenceReads};
        });

      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      yield* Effect.sync(() => {
        registerWorkflowTaskTool(mcp, config);
      }).pipe(Effect.provideService(CodeGraphStore, observedGraphStore));

      const started = yield* countCaptures(
        mcp
          .invokeTool('workflow_task_start', {
            featureName: 'Bounded citation count',
            callerCwd: repo,
            installationTarget: 'codex',
            intent: {
              title: 'Bounded citation count',
              currentBehavior: 'Foreground compact start captures code citations per child artifact.',
              desiredChange: 'Foreground compact start reuses opening citations and re-verifies root.',
              affectedPaths: ['source.ts'],
              acceptanceCriterion: 'At most two citation captures execute per foreground save.',
              verification: 'Count snapshot citation evidence reads during foreground save.',
              eligibilityRationale: 'Single bounded behavior with no open design questions.',
              eligibility: {status: 'eligible'},
              review: {required: false, reason: 'Synthetic verification test.'},
            },
          })
          .pipe(Effect.provideService(CodeGraphStore, observedGraphStore)),
      );
      const startedResult = object(started.value);
      expect(startedResult.isError).not.toBe(true);
      expect(started.captures).toBe(2);

      const structuredStart = object(startedResult.structuredContent);
      const runId = String(structuredStart.taskRef);
      const intentHash = String(structuredStart.intentHash);

      const confirmed = yield* countCaptures(
        mcp
          .invokeTool('workflow_task_compact_confirm', {
            runId,
            callerCwd: repo,
            presentedIntentHash: intentHash,
            userResponse: 'Approve exact compact intent.',
            userDecision: 'approve',
            baseBranch: 'main',
          })
          .pipe(Effect.provideService(CodeGraphStore, observedGraphStore)),
      );
      const confirmedResult = object(confirmed.value);
      expect(confirmedResult.isError).not.toBe(true);
      expect(confirmed.captures).toBe(2);
    }).pipe(run),
  windowsRealGitFixtureTimeout,
);
