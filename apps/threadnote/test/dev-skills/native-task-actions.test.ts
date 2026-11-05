import {Effect, FileSystem, Layer, Path, Schema, Stdio, Terminal} from 'effect';
import {ChildProcessSpawner} from 'effect/process';
import {Command} from 'effect/cli';
import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {
  decodeNativeTaskActionRef,
  encodeNativeTaskActionRef,
  nativeTaskSnapshotId,
} from '@threadnote/workflow-automations/task';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {makeNativeTaskActionCommands} from '../../src/effect/workflow_cli.js';
import {runNativeTaskAction} from '../../src/workflow_automation/task_actions.js';
import {CurrentNativeJobAutoLaunch, runNativeJobWorker} from '../../src/workflow_automation/native_jobs.js';
import {readNativeCloseoutJournal} from '../../src/workflow_automation/closeout_store.js';
import {decodeJournal} from '../../src/workflow_automation/closeout_request_schema.js';
import {completeLocalPhase, fixture, object, run} from './native-cycle-lifecycle-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const cliTestLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die('unused'),
      readInput: Effect.die('unused'),
      readLine: Effect.die('unused'),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die('unused')),
  ),
);

const packet = {
  capacity: {
    model: 'fixture-background',
    effort: 'low',
    selection: 'least-sufficient',
    risk: 'settled',
    reason: 'The fixture exercises a bounded one-file phase.',
    catalogEvidence: 'Synthetic local test capability record.',
  },
  anchors: [{path: 'source.ts', pattern: 'export const fixture'}],
  ownership: ['source.ts'],
  checks: ['bun test focused fixture'],
};

describe('native task actions', () => {
  effectIt.effect('records a canonical snapshot and review with exact replay after source drift', () =>
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
      expect(work.status).toBe('ready');
      expect(work.phaseId).toBe('one');
      const workRef = String(work.workRef);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "worker result";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Worker result']);
      const recorded = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef,
        }),
      );
      expect(recorded).toMatchObject({status: 'recorded', replayed: false});
      const snapshotRef = String(recorded.snapshotRef);
      const beforeReplay = yield* f.fs.readFileString(f.statePath());
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "later drift";\n');
      const replay = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef,
        }),
      );
      expect(replay).toMatchObject({status: 'recorded', replayed: true});
      expect(replay.snapshot).toEqual(recorded.snapshot);
      expect(object(object(replay.snapshot).snapshot).snapshotId).toBe(nativeTaskSnapshotId(workRef));
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeReplay);
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
      const delivery = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-local',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: String(validation.validationRef),
        }),
      );
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
      const proposal = {
        architecture: {
          summary: 'The fixture records a source-checked local implementation.',
          components: ['Fixture source', 'Native cycle'],
          contracts: ['Preserve exact local validation and delivery evidence.'],
          diagram: 'flowchart TD\n Fixture --> Cycle',
          invariants: ['Only the committed validated source is delivered.'],
          unknowns: [],
          deviations: [],
          codeRefs: ['source.ts'],
        },
        architectureVerification: 'Inspected the committed fixture source and its recorded phase proof.',
        combinedChecks: [
          {command: 'focused fixture task flow', result: 'passed', evidence: 'The task action lifecycle passed.'},
        ],
        phaseEvidence: [
          {id: 'one', acceptance: [{criterion: 'one works', evidence: 'Observed the committed worker result.'}]},
        ],
        scenarios: [],
        decisions: [
          {
            id: 'delivery',
            implemented: 'The phase delivered locally.',
            rationale: 'The fixture plan selects local delivery.',
          },
        ],
      };
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const finishThroughMcp = (input: Record<string, unknown>) =>
        mcp.invokeTool('workflow_task_finish', input).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false));
      let lostPrepareAcknowledgment: Record<string, unknown> | undefined;
      const lostPrepare = yield* finishThroughMcp({runId: 'native-run', callerCwd: f.repo, proposal}).pipe(
        Effect.tap(value => Effect.sync(() => (lostPrepareAcknowledgment = object(object(value).structuredContent)))),
        Effect.andThen(
          Effect.fail(
            WorkflowAutomationError.make({code: 'test-lost-ack', message: 'Simulated lost MCP preparation response.'}),
          ),
        ),
        Effect.result,
      );
      expect(lostPrepare._tag).toBe('Failure');
      const preparingEnvelope = object(yield* finishThroughMcp({runId: 'native-run', callerCwd: f.repo, proposal}));
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
        ...proposal,
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
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', prepareJobId, f.call)).status).toBe('completed');
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
      const replacementEnvelope = object(yield* finishThroughMcp({runId: 'native-run', callerCwd: f.repo, proposal}));
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
      const finishingEnvelope = object(
        yield* finishThroughMcp({runId: 'native-run', callerCwd: f.repo, prepareRef: replacementPrepareRef}),
      );
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
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', finishJobId, f.call)).status).toBe('completed');
      const lostFinishReplay = object(
        object(yield* finishThroughMcp({runId: 'native-run', callerCwd: f.repo, prepareRef: replacementPrepareRef}))
          .structuredContent,
      );
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
      expect(complete.closeout).toEqual({
        transactionId: completedCloseout?.state.transactionId,
        documentDigest: completedCloseout?.state.documentDigest,
        outputs: completedCloseout?.state.outputs,
        archives: completedCloseout?.state.archives,
      });
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
