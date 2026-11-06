import {
  Array as A,
  Array as EffectArray,
  Record as EffectRecord,
  Clock,
  Cause,
  String as EffectString,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Stdio,
  Terminal,
} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {Command} from 'effect/cli';
import {SystemInfo} from '@threadnote/platform/system';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {CommandExecutor, commandEnvironment, runCommandEffect} from '@threadnote/platform/command';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {SecureRandom} from 'effect/crypto';
import {
  NativeAuthoringSpecDocumentSchema,
  NativeAuthoringPlanDocumentSchema,
  nativeAuthoringDigest,
} from '@threadnote/workflow-automations/authoring';
import {applyDevSkills} from '../../src/dev_skills/index.js';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {makeNativeTaskAuthoringCommand} from '../../src/effect/task_authoring_cli.js';
import {
  runNativeTaskAuthoring,
  encodeNativeAuthoringTaskRef,
  decodeNativeAuthoringTaskRef,
} from '../../src/workflow_automation/task_authoring.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {runNativeTaskAction} from '../../src/workflow_automation/task_actions.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {ResourceStore} from '@threadnote/store/resource-store';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {AuthoringRootSchema, decodeAuthoringArtifact} from '../../src/workflow_automation/authoring_artifacts.js';
import {CurrentNativeJobAutoLaunch, runNativeJob} from '../../src/workflow_automation/native_jobs.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestClock} from 'effect/testing';
import {object} from './native-cycle-lifecycle-fixture.js';
import {workflowTitleSlug} from '@threadnote/workflow-automations/naming';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';

const specBusiness = {
  title: 'Reliable fixture readback',
  objective: 'Return the complete saved fixture value.',
  requirements: [{id: 'read', behavior: 'The complete saved value is returned.'}],
  context: {codeRefs: ['source.ts'], evidenceRefs: [], note: 'Inspected private fixture source.'},
  actors: ['Fixture reader'],
  inScope: ['Read the saved fixture.'],
  outOfScope: ['Remote publication.'],
  constraints: ['Preserve the complete value.'],
  observations: ['The fixture is a local source module.'],
  scenarios: [
    {
      id: 'readback',
      requirementIds: ['read'],
      given: 'A value is saved.',
      when: 'The reader loads it.',
      then: 'The complete saved value is returned.',
    },
  ],
  assumptions: [],
  questions: [],
  artifacts: [],
  review: {required: true, reason: 'Independent behavior and source review is required.'},
};
const planBusiness = {
  title: 'Implement reliable fixture readback',
  objective: 'Return the complete saved fixture value.',
  context: specBusiness.context,
  current: {
    summary: 'The reader can omit part of the saved value.',
    components: ['Fixture reader'],
    contracts: ['Read saved fixture values.'],
  },
  target: {
    summary: 'The reader returns the complete saved value.',
    components: ['Fixture reader'],
    contracts: ['Preserve the complete saved value.'],
  },
  phases: [
    {
      id: 'readback',
      title: 'Preserve the complete value',
      outcome: 'The reader returns the complete value.',
      dependsOn: [],
      affectedPaths: ['source.ts'],
      newPaths: [],
      contracts: ['Preserve the complete saved value.'],
      acceptance: [
        {
          id: 'read-complete',
          criterion: 'Complete value is returned.',
          verification: 'Read and compare the full saved value.',
          requirementIds: ['read'],
          scenarioIds: ['readback'],
        },
      ],
      safeBoundary: 'One local readback contract remains independently working.',
    },
  ],
  decisions: [
    {
      id: 'reuse-reader',
      question: 'Which reader should own the fix?',
      selection: 'no-better-alternative',
      selected: 'Retain the current fixture reader.',
      alternatives: [],
      rationale: 'The current reader owns this contract.',
      affectedPhases: ['readback'],
      authority: 'orchestrator',
    },
  ],
  openQuestions: [],
  review: {required: true, reason: 'An independent architecture review is required.'},
};
const setup = Effect.gen(function* () {
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
  const scoped = {...system, currentDirectory: () => repo, homeDirectory: home};
  yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(Effect.provideService(SystemInfo, scoped));
  expect((yield* (yield* CodeGraphIndexer).index({cwd: repo, threadnoteHome: home})).snapshot.state).toBe('ready');
  const mcp = new EffectMcpServerAdapter('test', '1', 'private authoring fixture');
  registerWorkflowTaskTool(mcp, config);
  const author = (input: object) =>
    mcp.invokeTool('workflow_task_author', {callerCwd: repo, ...input}).pipe(
      Effect.provideService(SystemInfo, scoped),
      Effect.map(envelope => {
        const response = object(envelope);
        if (response.isError) throw new Error(JSON.stringify(response));
        return object(response.structuredContent);
      }),
    );
  return {...f, config, repo, home, scoped, author, mcp};
});

effectIt.effect(
  'authors and approves a spec, transfers its exact source into a reviewed plan, and admits local work through public task interfaces',
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const specFile = f.path.join(f.root, 'spec-business.json');
      const planFile = f.path.join(f.root, 'plan-business.json');
      yield* f.fs.writeFileString(specFile, JSON.stringify(specBusiness));
      yield* f.fs.writeFileString(planFile, JSON.stringify(planBusiness));
      const start = {
        command: 'start',
        featureName: 'Reliable fixture',
        kind: 'spec',
        contentFile: specFile,
        installationTarget: 'codex',
      };
      const draft = yield* f.author(start);
      expect(draft.status).toBe('draft');
      const statePath = f.statePath(String(draft.runId));
      const beforeReplay = yield* f.fs.readFileString(statePath);
      expect(yield* f.author(start)).toMatchObject({status: 'draft', replayed: true, authoringRef: draft.authoringRef});
      expect(yield* f.fs.readFileString(statePath)).toBe(beforeReplay);
      const foreign = f.path.join(f.root, 'other', 'repo');
      yield* f.fs.makeDirectory(foreign, {recursive: true});
      yield* runCommandEffect('git', ['init', '--initial-branch=main', foreign]);
      expect(
        yield* runNativeTaskAuthoring(f.config, {
          command: 'read',
          callerCwd: foreign,
          authoringRef: draft.authoringRef,
          detail: 'document',
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'binding-drift'}});
      expect(yield* f.fs.readFileString(statePath)).toBe(beforeReplay);
      const missingRunId = 'task-' + EffectString.slice(0, 48)(sha256HexSync('repo\nmissing-resources'));
      expect(
        yield* runNativeTaskAuthoring(f.config, {
          command: 'start',
          callerCwd: f.repo,
          featureName: 'Missing resources',
          kind: 'spec',
          contentFile: specFile,
        }).pipe(Effect.provideService(SystemInfo, f.scoped), Effect.result),
      ).toMatchObject({failure: {code: 'needs-resources'}});
      expect(yield* readNativeWorkflowState(f.config, missingRunId)).toBeUndefined();

      const read = yield* f.author({command: 'read', authoringRef: draft.authoringRef, detail: 'document'});
      const spec = yield* Schema.decodeUnknownEffect(NativeAuthoringSpecDocumentSchema)(read.document);
      expect(spec.title).toBe(specBusiness.title);
      expect(spec.scenarios).toEqual(specBusiness.scenarios);
      expect(spec.source?.files[0]?.path).toBe('source.ts');
      expect(
        yield* f.author({
          command: 'decide',
          authoringRef: draft.authoringRef,
          userDecision: 'approve',
          userResponse: 'I approve the exact displayed readback specification.',
        }),
      ).toMatchObject({status: 'needs-review'});
      expect(yield* f.fs.readFileString(statePath)).toBe(beforeReplay);
      const readySpec = yield* f.author({
        command: 'decide',
        authoringRef: draft.authoringRef,
        userDecision: 'approve',
        userResponse: 'I approve the exact displayed readback specification.',
        review: {outcome: 'accepted', blockingIssueCount: 0},
      });
      expect(readySpec.status).toBe('ready');
      const planDraft = yield* f.author({
        command: 'start',
        featureName: 'Reliable fixture',
        kind: 'plan',
        contentFile: planFile,
        specRef: readySpec.authoringRef,
      });
      expect(planDraft.status).toBe('draft');
      const loadedPlan = yield* f.author({command: 'read', authoringRef: planDraft.authoringRef, detail: 'document'});
      const plan = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(loadedPlan.document);
      expect(plan.requirements).toEqual(spec.requirements);
      expect(plan.spec?.scenarios).toEqual(spec.scenarios);
      expect(plan.spec?.root).toEqual(readySpec.root);
      expect(plan.current.diagram).toBe('');
      expect(plan.target.diagram).toBe('');
      const beforeUnapproved = yield* f.fs.readFileString(statePath);
      const unapproved = yield* runNativeTaskAuthoring(f.config, {
        command: 'admit',
        callerCwd: f.repo,
        authoringRef: planDraft.authoringRef,
        bindings: {readback: {branch: 'main', baseBranch: 'main'}},
      }).pipe(Effect.provideService(SystemInfo, f.scoped), Effect.result);
      expect(unapproved).toMatchObject({failure: {code: 'approval-required'}});
      expect(yield* f.fs.readFileString(statePath)).toBe(beforeUnapproved);
      const approvedPlan = yield* f.author({
        command: 'decide',
        authoringRef: planDraft.authoringRef,
        userDecision: 'approve',
        userResponse: 'I approve this exact source-linked readback plan.',
        review: {outcome: 'accepted', blockingIssueCount: 0},
      });
      expect(approvedPlan.status).toBe('ready');
      const admission = {
        command: 'admit',
        authoringRef: approvedPlan.authoringRef,
        bindings: {readback: {branch: 'main', baseBranch: 'main'}},
      };
      expect(yield* f.author(admission)).toMatchObject({status: 'admitted'});
      const afterAdmit = yield* f.fs.readFileString(statePath);
      expect(yield* f.author(admission)).toMatchObject({status: 'admitted', replayed: true});
      expect(yield* f.fs.readFileString(statePath)).toBe(afterAdmit);
      expect(yield* readNativeTaskView(f.config, {runId: String(draft.runId), callerCwd: f.repo})).toMatchObject({
        next: {action: 'implement', phaseId: 'readback'},
      });
      const workEnvelope = object(
        yield* f.mcp
          .invokeTool('workflow_task_work', {
            runId: String(draft.runId),
            callerCwd: f.repo,
            capacity: {
              model: 'fixture-background',
              effort: 'low',
              selection: 'least-sufficient',
              risk: 'settled',
              reason: 'One scoped source file.',
              catalogEvidence: 'Private fixture capability record.',
            },
            anchors: [{path: 'source.ts', pattern: 'export const fixture'}],
            ownership: ['source.ts'],
            checks: ['focused fixture readback check'],
          })
          .pipe(Effect.provideService(SystemInfo, f.scoped)),
      );
      expect(workEnvelope.isError).not.toBe(true);
      expect(object(workEnvelope.structuredContent)).toMatchObject({status: 'ready', phaseId: 'readback'});
    }).pipe(TestClock.withLive, provideNative),
);

effectIt.effect('admits commit delivery, recovers an unreviewed snapshot, and delivers reviewed source', () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const file = f.path.join(f.root, 'commit-plan-business.json');
    const direct = {
      ...planBusiness,
      requirements: specBusiness.requirements,
      phases: A.map(planBusiness.phases, phase => ({
        ...phase,
        acceptance: A.map(phase.acceptance, item => ({...item, scenarioIds: []})),
      })),
    };
    yield* f.fs.writeFileString(file, JSON.stringify(direct));
    const draft = yield* f.author({
      command: 'start',
      featureName: 'Commit delivery task',
      kind: 'plan',
      contentFile: file,
      installationTarget: 'codex',
    });
    const read = yield* f.author({command: 'read', authoringRef: draft.authoringRef, detail: 'document'});
    expect(read.document).toMatchObject({title: direct.title, phases: [{id: 'readback'}]});
    const ready = yield* f.author({
      command: 'decide',
      authoringRef: read.authoringRef,
      userDecision: 'approve',
      userResponse: 'I approve this exact commit-delivery plan after its required independent review.',
      review: {outcome: 'accepted', blockingIssueCount: 0},
    });
    const bindings = {readback: {branch: 'main', baseBranch: 'main'}};
    const bindingsFile = f.path.join(f.root, 'commit-bindings.json');
    yield* f.fs.writeFileString(bindingsFile, JSON.stringify(bindings));
    const cli = Command.make('threadnote').pipe(
      Command.withSubcommands([makeNativeTaskAuthoringCommand(program => program(f.config))]),
    );
    yield* Command.runWith(cli, {version: 'fixture'})([
      'task-author',
      '--operation',
      'admit',
      '--caller-cwd',
      f.repo,
      '--authoring-ref',
      String(ready.authoringRef),
      '--delivery',
      'commit',
      '--bindings-file',
      bindingsFile,
    ]).pipe(provideTestLayer(cliLayer), Effect.provideService(SystemInfo, f.scoped));
    const admittedState = yield* readNativeWorkflowState(f.config, String(draft.runId));
    expect(admittedState?.state.cycle?.state.plan.delivery).toBe('commit');
    expect((yield* readNativeWorkflowState(f.config, String(draft.runId)))?.state.cycle?.state.plan).toMatchObject({
      delivery: 'commit',
      phases: [{id: 'readback', branch: 'main', baseBranch: 'main'}],
    });

    const runId = String(draft.runId);
    const action = (request: Record<string, unknown>) =>
      runNativeTaskAction(f.config, {runId, callerCwd: f.repo, ...request}).pipe(
        Effect.provideService(SystemInfo, f.scoped),
      );
    const task = yield* readNativeTaskView(f.config, {runId, callerCwd: f.repo});
    expect(task.next.action).toBe('implement');
    const begun = object(yield* action({command: 'begin', taskRef: String(task.taskRef)}));
    expect(begun.status).toBe('begun');
    const work = object(
      yield* action({
        command: 'work',
        packet: {
          capacity: {
            model: 'fixture-background',
            effort: 'low',
            selection: 'least-sufficient',
            risk: 'settled',
            reason: 'Exercise the one-phase commit workflow in a private fixture.',
            catalogEvidence: 'Synthetic local test capability record; not provider evidence.',
          },
          anchors: [{path: 'source.ts', pattern: 'export const fixture'}],
          ownership: ['source.ts'],
          checks: ['focused fixture check'],
        },
      }),
    );
    yield* f.fs.writeFileString(
      f.path.join(f.repo, 'source.ts'),
      'export const fixture = "first private candidate";\n',
    );
    const commit = (message: string) =>
      Effect.gen(function* () {
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
          message,
        ]);
      });
    yield* commit('First private candidate');
    const first = object(yield* action({command: 'record-snapshot', workRef: String(work.workRef)}));
    const firstRef = String(first.snapshotRef);

    yield* f.fs.writeFileString(
      f.path.join(f.repo, 'source.ts'),
      'export const fixture = "corrected private candidate";\n',
    );
    yield* commit('Corrected private candidate');
    const mcpSnapshot = (snapshot: Record<string, unknown>) =>
      f.mcp.invokeTool('workflow_task_snapshot', {runId, callerCwd: f.repo, snapshot}).pipe(
        Effect.provideService(SystemInfo, f.scoped),
        Effect.map(result => object(result)),
      );
    const beforeRecovery = yield* f.fs.readFileString(f.statePath(runId));
    const reason = 'Correct the candidate before any review and require a full independent review.';
    const recoveredEnvelope = yield* mcpSnapshot({command: 'supersede-unreviewed', snapshotRef: firstRef, reason});
    expect(recoveredEnvelope.isError).not.toBe(true);
    const recovered = object(recoveredEnvelope.structuredContent);
    expect(recovered).toMatchObject({status: 'recorded', replayed: false});
    expect(object(object(recovered.snapshot).snapshot)).toMatchObject({
      supersedes: object(object(first.snapshot).snapshot).snapshotId,
    });
    const afterRecovery = yield* f.fs.readFileString(f.statePath(runId));
    expect(afterRecovery).not.toBe(beforeRecovery);
    const replay = yield* mcpSnapshot({command: 'supersede-unreviewed', snapshotRef: firstRef, reason});
    expect(object(replay.structuredContent)).toMatchObject({
      status: 'recorded',
      replayed: true,
      snapshot: recovered.snapshot,
    });
    expect(yield* f.fs.readFileString(f.statePath(runId))).toBe(afterRecovery);
    const staleRecovery = yield* f.mcp
      .invokeTool('workflow_task_snapshot', {
        runId,
        callerCwd: f.repo,
        snapshot: {
          command: 'supersede-unreviewed',
          snapshotRef: firstRef,
          reason: reason + ' changed after admission',
        },
      })
      .pipe(Effect.provideService(SystemInfo, f.scoped), Effect.result);
    expect(staleRecovery).toMatchObject({failure: {code: 'stale-snapshot-ref'}});
    expect(yield* f.fs.readFileString(f.statePath(runId))).toBe(afterRecovery);

    const snapshotRef = String(recovered.snapshotRef);
    const report = {
      mode: 'full',
      selected: ['correctness', 'simplicity'],
      lanes: [
        {name: 'correctness', status: 'complete'},
        {name: 'simplicity', status: 'complete'},
      ],
      findings: [],
    };
    yield* action({command: 'record-review', snapshotRef, report});
    const validation = object(
      yield* action({
        command: 'record-validation',
        snapshotRef,
        validation: {
          checks: [
            {command: 'private fixture check', result: 'passed', evidence: 'The exact corrected fixture tree passed.'},
          ],
          acceptance: [
            {
              criterion: 'Complete value is returned.',
              result: 'passed',
              evidence: 'The canonical business-admitted plan completed.',
            },
          ],
        },
      }),
    );
    const validationRef = String(validation.validationRef);
    const evidence = 'Synthetic private fixture commit evidence; not a provider or human authentication claim.';
    const deliveredEnvelope = object(
      yield* f.mcp
        .invokeTool('workflow_task_deliver', {
          runId,
          callerCwd: f.repo,
          delivery: {command: 'commit', validationRef, commitEvidence: evidence},
        })
        .pipe(Effect.provideService(SystemInfo, f.scoped)),
    );
    expect(deliveredEnvelope.isError).not.toBe(true);
    expect(object(deliveredEnvelope.structuredContent)).toMatchObject({
      status: 'delivered',
      replayed: false,
      receipt: {delivery: 'commit', commitEvidence: evidence},
    });
    const stateAfterDelivery = yield* f.fs.readFileString(f.statePath(runId));
    const replayed = object(
      yield* f.mcp
        .invokeTool('workflow_task_deliver', {
          runId,
          callerCwd: f.repo,
          delivery: {command: 'commit', validationRef, commitEvidence: evidence},
        })
        .pipe(Effect.provideService(SystemInfo, f.scoped)),
    );
    expect(object(replayed.structuredContent)).toMatchObject({status: 'delivered', replayed: true});
    expect(yield* f.fs.readFileString(f.statePath(runId))).toBe(stateAfterDelivery);
    const invalidFinish = yield* action({command: 'finish'}).pipe(Effect.result);
    expect(invalidFinish).toMatchObject({failure: {code: 'invalid-request'}});
    expect(yield* f.fs.readFileString(f.statePath(runId))).toBe(stateAfterDelivery);
  }).pipe(TestClock.withLive, provideNative),
);

effectIt.effect(
  'background semantic authoring replays one durable job identity without claiming pending work completed',
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const file = f.path.join(f.root, 'background-spec.json');
      yield* f.fs.writeFileString(file, JSON.stringify(specBusiness));
      const start = {
        command: 'start',
        featureName: 'Background semantic authoring',
        kind: 'spec',
        contentFile: file,
        installationTarget: 'codex',
        saveMode: 'background',
      };
      const first = yield* f.author(start).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false));
      expect(first.status).toBe('accepted');
      expect(String(first.jobRef)).toMatch(/^authorjob-v1\./u);
      const statePath = f.statePath(String(first.runId));
      const stateAfterAdmission = yield* f.fs.readFileString(statePath);
      const replay = yield* f.author(start).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false));
      expect(replay.jobRef).toBe(first.jobRef);
      expect(yield* f.fs.readFileString(statePath)).toBe(stateAfterAdmission);
      const status = yield* f.author({command: 'job', jobRef: first.jobRef, operation: 'status'});
      expect(status).toMatchObject({status: 'accepted', jobRef: first.jobRef});
      const pendingResult = yield* f.author({command: 'job', jobRef: first.jobRef, operation: 'result'});
      expect(pendingResult).toMatchObject({status: 'accepted', jobRef: first.jobRef});
      expect(pendingResult).not.toHaveProperty('authoring');
    }).pipe(TestClock.withLive, provideNative),
);

effectIt.effect('rejects same-basename foreign job continuations without changing canonical run or job bytes', () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const file = f.path.join(f.root, 'foreign-job-spec.json');
    yield* f.fs.writeFileString(file, JSON.stringify(specBusiness));
    const accepted = yield* f
      .author({
        command: 'start',
        featureName: 'Foreign job owner binding',
        kind: 'spec',
        contentFile: file,
        installationTarget: 'codex',
        saveMode: 'background',
      })
      .pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false));
    const runId = String(accepted.runId);
    const jobRef = String(accepted.jobRef);
    const jobPayload = object(
      JSON.parse(
        Buffer.from(
          EffectString.replaceAll(
            '_',
            '/',
          )(EffectString.replaceAll('-', '+')(EffectString.slice('authorjob-v1.'.length)(jobRef))),
          'base64',
        ).toString('utf8'),
      ),
    );
    const run = yield* readNativeWorkflowState(f.config, runId);
    if (!run) throw new Error('The submitted job has no native run.');
    const foreignRepo = f.path.join(f.root, 'foreign', 'repo');
    yield* f.fs.makeDirectory(foreignRepo, {recursive: true});
    yield* f.fs.writeFileString(f.path.join(foreignRepo, 'source.ts'), 'export const foreign = true;\n');
    yield* runCommandEffect('git', ['init', '--initial-branch=main', foreignRepo]);
    const foreignSystem = {...f.scoped, currentDirectory: () => foreignRepo};
    const jobDirectory = f.path.join(f.home, 'workflow-automations', 'native-v1', 'jobs', runId);
    const snapshotJobFiles = () =>
      Effect.gen(function* () {
        const names = [...(yield* f.fs.readDirectory(jobDirectory))].sort();
        const contents: Array<readonly [string, string]> = [];
        for (const name of names) contents.push([name, yield* f.fs.readFileString(f.path.join(jobDirectory, name))]);
        return contents;
      });
    const beforeRun = yield* f.fs.readFileString(f.statePath(runId));
    const beforeJobs = yield* snapshotJobFiles();
    const operations = ['status', 'result', 'cancel', 'resume'] as const;
    for (const operation of operations) {
      const foreignAttempt = yield* runNativeTaskAuthoring(f.config, {
        command: 'job',
        callerCwd: foreignRepo,
        jobRef,
        operation,
      }).pipe(Effect.provideService(SystemInfo, foreignSystem), Effect.result);
      expect(foreignAttempt).toMatchObject({failure: {code: 'binding-drift'}});
      const lowLevelAttempt = yield* runNativeJob(
        f.config,
        {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'job',
          command: operation,
          runId,
          generation: run.state.generation,
          jobId: jobPayload.jobId,
        },
        () => Effect.void,
      ).pipe(Effect.provideService(SystemInfo, foreignSystem), Effect.result);
      expect(lowLevelAttempt).toMatchObject({failure: {code: 'binding-drift'}});
      expect(yield* f.fs.readFileString(f.statePath(runId))).toBe(beforeRun);
      expect(yield* snapshotJobFiles()).toEqual(beforeJobs);
    }
    expect(yield* f.author({command: 'job', jobRef, operation: 'status'})).toMatchObject({
      status: 'accepted',
      jobRef,
    });
    const ownerResumeWithoutTarget = yield* f.author({command: 'job', jobRef, operation: 'resume'}).pipe(Effect.result);
    expect(ownerResumeWithoutTarget).toMatchObject({failure: {code: 'needs-resources'}});
    expect(yield* f.fs.readFileString(f.statePath(runId))).toBe(beforeRun);
    expect(yield* snapshotJobFiles()).toEqual(beforeJobs);
  }).pipe(TestClock.withLive, provideNative),
);

effectIt.effect(
  'runs background semantic authoring in an owned real worker process and verifies its canonical readback',
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const system = yield* SystemInfo;
      const expectedWorkerCwd = yield* f.fs.realPath(f.repo);
      const executor = yield* CommandExecutor;
      const environmentPolicy = yield* ChildEnvironmentPolicy;
      const executablePath = yield* f.fs.realPath(system.executablePath);
      const developmentEntrypoint = yield* f.fs.realPath(system.developmentEntrypoint);
      const expectedEntrypoint = yield* f.fs.realPath(
        Bun.fileURLToPath(new URL('../../src/standalone.ts', import.meta.url)),
      );
      const expectedExecutable = yield* f.fs.realPath(process.execPath);
      expect(executablePath).toBe(expectedExecutable);
      expect(developmentEntrypoint).toBe(expectedEntrypoint);
      const executableDigest = sha256HexSync(yield* f.fs.readFile(executablePath));
      const entrypointDigest = sha256HexSync(yield* f.fs.readFile(developmentEntrypoint));
      type OwnedWorker = {
        readonly child: ReturnType<typeof Bun.spawn>;
        readonly executable: string;
        readonly args: readonly string[];
        readonly cwd: string | undefined;
        readonly env: NodeJS.ProcessEnv | undefined;
        readonly processStartIdentity: string | undefined;
      };
      const ownedWorkers = yield* Ref.make<readonly OwnedWorker[]>([]);
      const bodySucceeded = yield* Ref.make(false);
      const processStartIdentity = (pid: number, remaining: number): Effect.Effect<string | undefined> =>
        (
          system.canonicalProcessStartIdentity?.(pid) ?? Effect.void.pipe(Effect.as(undefined as string | undefined))
        ).pipe(
          Effect.filterOrElse(
            identity => identity !== undefined || remaining <= 0,
            () => Effect.sleep('10 millis').pipe(Effect.flatMap(() => processStartIdentity(pid, remaining - 1))),
          ),
        );
      const adapter = CommandExecutor.of({
        ...executor,
        spawnDetached: (executable, args, options) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const env = commandEnvironment(executable, options?.env, system.environment(), environmentPolicy);
              const child = yield* Effect.sync(() =>
                Bun.spawn([executable, ...args], {
                  cwd: options?.cwd,
                  env,
                  detached: true,
                  stdin: 'ignore',
                  stdout: 'ignore',
                  stderr: 'ignore',
                }),
              );
              const entry: OwnedWorker = {
                child,
                executable,
                args: [...args],
                cwd: options?.cwd,
                env,
                processStartIdentity: undefined,
              };
              yield* Ref.update(ownedWorkers, current => [...current, entry]);
              const childIdentity = yield* processStartIdentity(child.pid, 20);
              const updated: OwnedWorker = {...entry, processStartIdentity: childIdentity};
              yield* Ref.update(ownedWorkers, current =>
                A.map(current, item => (item.child === child ? updated : item)),
              );
              return childIdentity !== undefined;
            }).pipe(Effect.catchCause(() => Effect.succeed(false))),
          ),
      });
      const author = (input: object) => f.author(input).pipe(Effect.provideService(CommandExecutor, adapter));
      const finalDiagnostic = yield* Ref.make<
        | (() => Effect.Effect<
            void,
            never,
            | CodeGraphQueryService
            | CodeGraphStore
            | CommandExecutor
            | FileSystem.FileSystem
            | Path.Path
            | ResourceStore
            | SecureRandom.SecureRandom
            | SystemInfo
          >)
        | undefined
      >(undefined);
      const safeWrite = (line: string) =>
        Effect.sync(() => {
          try {
            process.stdout.write(`${line}\n`);
          } catch {
            // Diagnostic output must not replace the primary worker outcome.
          }
        });

      const file = f.path.join(f.root, 'spawned-background-spec.json');
      yield* f.fs.writeFileString(file, JSON.stringify(specBusiness));
      const start = {
        command: 'start',
        featureName: 'Spawned background authoring',
        kind: 'spec',
        contentFile: file,
        installationTarget: 'codex',
        saveMode: 'background',
      };
      const useWorker = Effect.gen(function* () {
        // CurrentNativeJobAutoLaunch defaults to true; the wrapper observes and owns its real OS child.
        const accepted = yield* author(start);
        const acceptedJob = object(accepted.job);
        const runId = typeof accepted.runId === 'string' ? accepted.runId : undefined;
        const jobId = typeof acceptedJob.jobId === 'string' ? acceptedJob.jobId : undefined;
        const jobRef = typeof accepted.jobRef === 'string' ? accepted.jobRef : undefined;
        const generation = typeof acceptedJob.generation === 'string' ? acceptedJob.generation : undefined;
        const safeId = (value: string | undefined) =>
          value !== undefined &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) &&
          !EffectString.includes('..')(value);
        const knownIdentity = safeId(runId) && safeId(jobId);
        const launch = (yield* Ref.get(ownedWorkers))[0];
        const statePath = knownIdentity && runId ? f.statePath(runId) : undefined;
        const jobPath =
          knownIdentity && runId && jobId
            ? f.path.join(f.home, 'workflow-automations', 'native-v1', 'jobs', runId, `${jobId}.json`)
            : undefined;
        const inputPath = jobPath ? `${jobPath}.input.json` : undefined;
        const lockPath = jobPath ? `${jobPath}.worker.lock` : undefined;
        const lastResult = yield* Ref.make<Record<string, unknown>>(accepted);
        const primaryFailureCode = yield* Ref.make<string | undefined>(undefined);
        const failureReason = yield* Ref.make('worker-test-failed-or-interrupted');
        const asRecord = (value: unknown): Record<string, unknown> =>
          typeof value === 'object' && value !== null && !EffectArray.isArray(value)
            ? EffectRecord.fromEntries(EffectRecord.toEntries(value))
            : {};
        const parseRecord = (value: string | undefined) => {
          try {
            return value ? asRecord(JSON.parse(value)) : {};
          } catch {
            return {};
          }
        };
        const finiteJobStatus = (value: unknown) =>
          value === 'accepted' ||
          value === 'running' ||
          value === 'completed' ||
          value === 'failed' ||
          value === 'blocked-with-progress' ||
          value === 'stopped-with-progress'
            ? value
            : undefined;
        // Project the durable worker error into a closed, non-text diagnostic.
        // Never emit the receipt's arbitrary code or any free-form receipt field.
        const finiteFailure = (value: unknown) => {
          if (typeof value !== 'string') return {code: 'unknown', stage: 'unknown'};
          const stages: Record<string, string> = {
            'job-controller-drift': 'controller-check',
            'job-target-drift': 'target-check',
            'job-closeout-drift': 'closeout-check',
            'job-source-drift': 'source-check',
            'source-drift': 'source-check',
            'job-capability': 'admission-or-witness-check',
            'invalid-job-state': 'input-or-request-check',
            'job-busy': 'lock-acquisition',
            'job-stopped': 'cancellation-boundary',
            'binding-drift': 'authoring-dispatch',
            'revision-conflict': 'authoring-dispatch',
            'not-ready': 'authoring-dispatch',
            'job-failed': 'untyped-dispatch-failure',
          };
          const stage = stages[value];
          return stage ? {code: value, stage} : {code: 'other-known-or-unknown', stage: 'unknown'};
        };
        const captureAfterExit = () =>
          Effect.gen(function* () {
            if (!knownIdentity || !jobPath || !inputPath || !lockPath || !runId || !jobId) {
              yield* safeWrite(
                `THREADNOTE_P4_REAL_JOB_DIAGNOSTIC ${JSON.stringify({version: 2, reason: 'job-identity-unavailable', fileCapture: 'skipped'})}`,
              );
              return;
            }
            const last = yield* Ref.get(lastResult);
            const failureCode = yield* Ref.get(primaryFailureCode);
            const reason = yield* Ref.get(failureReason);
            const lowerStatus = generation
              ? yield* Effect.result(
                  runNativeJob(
                    f.config,
                    {
                      protocolVersion: 1,
                      executorVersion: 1,
                      action: 'job',
                      command: 'status',
                      runId,
                      jobId,
                      generation,
                    },
                    () => Effect.void,
                  ),
                )
              : undefined;
            const typedStatus = lowerStatus
              ? lowerStatus._tag === 'Success'
                ? asRecord(lowerStatus.success)
                : {
                    code: 'job-status-unavailable',
                  }
              : undefined;
            const [receiptBytes, inputBytes, lockBytes, lockExists] = yield* Effect.all([
              f.fs.readFileString(jobPath).pipe(Effect.option),
              f.fs.readFileString(inputPath).pipe(Effect.option),
              f.fs.readFileString(lockPath).pipe(Effect.option),
              f.fs.exists(lockPath).pipe(Effect.option),
            ]);
            const receiptText = Option.getOrUndefined(receiptBytes);
            const inputText = Option.getOrUndefined(inputBytes);
            const lockText = Option.getOrUndefined(lockBytes);
            const receipt = parseRecord(receiptText);
            const failure = finiteFailure(receipt.code);
            const admittedInput = parseRecord(inputText);
            const admittedDocument = asRecord(asRecord(admittedInput.work).document);
            const controller = yield* readNativeWorkflowState(f.config, runId).pipe(Effect.option);
            const controllerState = Option.getOrUndefined(controller)?.state;
            const documentIdMatches =
              typeof admittedDocument.id === 'string' &&
              controllerState !== undefined &&
              admittedDocument.id === controllerState.featureId;
            const documentProjectMatches =
              typeof admittedDocument.project === 'string' &&
              controllerState !== undefined &&
              admittedDocument.project === controllerState.project;
            const bindingPredicate =
              failure.code === 'binding-drift'
                ? documentIdMatches && documentProjectMatches
                  ? 'document-identity-matches'
                  : documentIdMatches
                    ? 'document-project-mismatch'
                    : documentProjectMatches
                      ? 'document-feature-id-mismatch'
                      : controllerState &&
                          typeof admittedDocument.id === 'string' &&
                          typeof admittedDocument.project === 'string'
                        ? 'document-feature-id-and-project-mismatch'
                        : 'identity-comparison-unavailable'
                : undefined;
            const responseJob = asRecord(last.job);
            const typedStatusJob = asRecord(typedStatus);
            const body = {
              version: 2,
              reason,
              runId,
              jobId,
              privateHome: f.home,
              privateManifest: launch?.env?.THREADNOTE_MANIFEST,
              primaryFailureCode: failureCode ? 'typed-failure' : undefined,
              lastResult: {
                status: finiteJobStatus(last.status),
                jobStatus: finiteJobStatus(responseJob.status),
                stopRequested: responseJob.stopRequested === true,
                progress: responseJob.progress,
              },
              typedStatus: {
                status: finiteJobStatus(typedStatusJob.status),
                progress: typedStatusJob.progress,
              },
              receipt: receiptText
                ? {
                    sha256: sha256HexSync(receiptText),
                    status: finiteJobStatus(receipt.status),
                    failure,
                    bindingPredicate,
                    started: receipt.started === true,
                    stopRequested: receipt.stopRequested === true,
                  }
                : {available: false},
              input: inputText ? {sha256: sha256HexSync(inputText)} : {available: false},
              workerLock: {
                checked: Option.isSome(lockExists),
                exists: Option.getOrUndefined(lockExists),
                sha256: lockText ? sha256HexSync(lockText) : undefined,
              },
            };
            yield* safeWrite(`THREADNOTE_P4_REAL_JOB_DIAGNOSTIC ${JSON.stringify(body)}`);
          }).pipe(
            Effect.timeoutOption('3 seconds'),
            Effect.flatMap(result =>
              Option.isSome(result)
                ? Effect.void
                : safeWrite(
                    `THREADNOTE_P4_REAL_JOB_DIAGNOSTIC ${JSON.stringify({version: 2, capture: 'timed-out', fileCapture: 'incomplete'})}`,
                  ),
            ),
            Effect.catchCauseIf(
              cause => !Cause.hasInterrupts(cause),
              () => safeWrite(`THREADNOTE_P4_REAL_JOB_DIAGNOSTIC ${JSON.stringify({version: 2, capture: 'failed'})}`),
            ),
          );
        if (knownIdentity) yield* Ref.set(finalDiagnostic, captureAfterExit);
        expect(accepted.status).toBe('accepted');
        expect(jobRef).toMatch(/^authorjob-v1\./u);
        expect(knownIdentity).toBe(true);
        const exactRunId = runId!;
        const exactJobId = jobId!;
        const exactJobRef = jobRef!;
        const exactStatePath = statePath!;
        expect(launch).toBeDefined();
        expect(yield* Ref.get(ownedWorkers)).toHaveLength(1);
        expect(launch?.executable).toBe(system.executablePath);
        expect(launch?.cwd).toBe(expectedWorkerCwd);
        expect(launch?.args).toEqual([
          system.developmentEntrypoint,
          'workflow-automation',
          'job-worker',
          '--run-id',
          exactRunId,
          '--job-id',
          exactJobId,
        ]);
        expect(launch?.env?.THREADNOTE_HOME).toBe(f.home);
        expect(launch?.env?.THREADNOTE_MANIFEST).toBe(f.config.manifestPath);
        expect(launch?.env?.THREADNOTE_ACCOUNT).toBe(f.config.account);
        expect(launch?.env?.THREADNOTE_USER).toBe(f.config.user);
        expect(launch?.env?.THREADNOTE_AGENT_ID).toBe(f.config.agentId);
        expect(launch?.processStartIdentity).toBeDefined();
        process.stdout.write(
          `THREADNOTE_P4_REAL_JOB_LAUNCH ${JSON.stringify({
            executable: launch?.executable,
            executableSha256: executableDigest,
            entrypoint: system.developmentEntrypoint,
            entrypointSha256: entrypointDigest,
            args: launch?.args,
            privateHome: f.home,
            privateManifest: launch?.env?.THREADNOTE_MANIFEST,
            runId,
            jobId,
            pid: launch?.child.pid,
            processStartIdentitySha256: launch?.processStartIdentity
              ? sha256HexSync(launch.processStartIdentity)
              : undefined,
          })}\n`,
        );

        const pollStartedAt = Number(yield* Clock.monotonicTimeNanos);
        const waitForCanonicalResult = (): ReturnType<typeof author> =>
          author({command: 'job', jobRef: exactJobRef, operation: 'result'}).pipe(
            // The worker may advance the run between the public read's two revisions.
            // Retry only its typed optimistic-read conflict, with the same continuation
            // and the existing overall polling deadline; every other failure stays fatal.
            Effect.catchIf(
              error => Schema.is(WorkflowAutomationError)(error) && error.code === 'state-conflict',
              error =>
                Clock.monotonicTimeNanos.pipe(
                  Effect.flatMap(now =>
                    Number(now) - pollStartedAt < 10_000_000_000
                      ? safeWrite('THREADNOTE_P4_REAL_JOB_RETRY {"code":"state-conflict"}').pipe(
                          Effect.andThen(Effect.sleep('100 millis')),
                          Effect.flatMap(waitForCanonicalResult),
                        )
                      : Effect.fail(error),
                  ),
                ),
            ),
            Effect.tap(result => Ref.set(lastResult, result)),
            Effect.tapCause(cause => {
              if (Cause.hasInterrupts(cause)) return Effect.void;
              const typedError = Option.getOrUndefined(Cause.findErrorOption(cause));
              return Ref.set(primaryFailureCode, typedError ? 'typed-failure' : 'mcp-result-error').pipe(
                Effect.andThen(Ref.set(failureReason, 'mcp-result-error')),
              );
            }),
            Effect.flatMap(result => {
              if (result.status === 'completed' && result.authoring) return Effect.succeed(result);
              const jobStatus = finiteJobStatus(asRecord(result.job).status);
              if (
                jobStatus === 'failed' ||
                jobStatus === 'blocked-with-progress' ||
                jobStatus === 'stopped-with-progress' ||
                jobStatus === 'completed'
              ) {
                const terminalReason = `terminal-${jobStatus}`;
                return Ref.set(failureReason, terminalReason).pipe(
                  Effect.andThen(
                    Effect.fail(
                      WorkflowAutomationError.make({
                        code: 'test-worker-terminal',
                        message: `Spawned authoring worker returned ${terminalReason}.`,
                      }),
                    ),
                  ),
                );
              }
              return Clock.monotonicTimeNanos.pipe(
                Effect.flatMap(now =>
                  Number(now) - pollStartedAt >= 10_000_000_000
                    ? Ref.set(failureReason, 'bounded-result-deadline').pipe(
                        Effect.andThen(
                          Effect.fail(
                            WorkflowAutomationError.make({
                              code: 'test-worker-incomplete',
                              message:
                                'Spawned authoring worker remained nonterminal past the fixture diagnostic deadline.',
                            }),
                          ),
                        ),
                      )
                    : Effect.sleep('100 millis').pipe(Effect.flatMap(waitForCanonicalResult)),
                ),
              );
            }),
          );
        const completed = yield* waitForCanonicalResult();
        expect(completed.jobRef).toBe(exactJobRef);
        const authoring = object(completed.authoring);
        expect(authoring.status).toBe('draft');
        const canonical = yield* Schema.decodeUnknownEffect(NativeAuthoringSpecDocumentSchema)(authoring.document);
        expect(canonical.title).toBe(specBusiness.title);
        expect(canonical.objective).toBe(specBusiness.objective);
        expect(canonical.scenarios).toEqual(specBusiness.scenarios);
        expect(authoring.documentHash).toBe(nativeAuthoringDigest(canonical));

        const completedState = yield* f.fs.readFileString(exactStatePath);
        const completedReceipt = yield* f.fs.readFileString(jobPath!);
        const completedInput = yield* f.fs.readFileString(inputPath!);
        const completedController = yield* readNativeWorkflowState(f.config, exactRunId);
        expect(
          A.filter(
            completedController?.state.operations ?? [],
            operation => operation.intent.role === 'authoring-root',
          ),
        ).toHaveLength(1);
        const replay = yield* author(start);
        expect(replay).toMatchObject({
          status: 'draft',
          runId: exactRunId,
          replayed: true,
          authoringRef: authoring.authoringRef,
          documentHash: nativeAuthoringDigest(canonical),
        });
        expect(yield* f.fs.readFileString(exactStatePath)).toBe(completedState);
        const resultReplay = yield* author({command: 'job', jobRef: exactJobRef, operation: 'result'});
        expect(resultReplay.status).toBe('completed');
        expect(resultReplay.jobRef).toBe(exactJobRef);
        expect(object(resultReplay.job).jobId).toBe(exactJobId);
        expect(object(resultReplay.authoring).document).toEqual(authoring.document);
        const status = yield* author({command: 'job', jobRef: exactJobRef, operation: 'status'});
        expect(status).toMatchObject({status: 'completed', jobRef: exactJobRef});
        expect(yield* author({command: 'job', jobRef: exactJobRef, operation: 'cancel'})).toMatchObject({
          status: 'completed',
          jobRef: exactJobRef,
        });
        expect(
          yield* author({
            command: 'job',
            jobRef: exactJobRef,
            operation: 'resume',
            installationTarget: 'codex',
          }),
        ).toMatchObject({
          status: 'completed',
          jobRef: exactJobRef,
        });
        const readback = yield* author({command: 'read', authoringRef: authoring.authoringRef, detail: 'document'});
        expect(readback.document).toEqual(authoring.document);
        expect(yield* f.fs.readFileString(exactStatePath)).toBe(completedState);
        expect(yield* f.fs.readFileString(jobPath!)).toBe(completedReceipt);
        expect(yield* f.fs.readFileString(inputPath!)).toBe(completedInput);
        expect(yield* Ref.get(ownedWorkers)).toHaveLength(1);
        yield* Ref.set(bodySucceeded, true);
      });
      const cleanup = Effect.gen(function* () {
        const workers = yield* Ref.get(ownedWorkers);
        let cleanupFailed = false;
        let allOwnedExitsObserved = workers.length > 0;
        for (const worker of workers) {
          const exited = Effect.tryPromise({
            try: () => worker.child.exited,
            catch: error => WorkflowAutomationError.make({code: 'test-worker-exit', message: String(error)}),
          }).pipe(Effect.timeoutOption('5 seconds'));
          let exitCode = Option.getOrUndefined(yield* exited);
          let forced: string | undefined;
          if (exitCode === undefined) {
            forced = 'SIGTERM';
            yield* Effect.try({try: () => worker.child.kill('SIGTERM'), catch: () => undefined});
            exitCode = Option.getOrUndefined(
              yield* Effect.tryPromise({
                try: () => worker.child.exited,
                catch: error => WorkflowAutomationError.make({code: 'test-worker-exit', message: String(error)}),
              }).pipe(Effect.timeoutOption('3 seconds')),
            );
          }
          if (exitCode === undefined) {
            forced = 'SIGKILL';
            yield* Effect.try({try: () => worker.child.kill('SIGKILL'), catch: () => undefined});
            exitCode = Option.getOrUndefined(
              yield* Effect.tryPromise({
                try: () => worker.child.exited,
                catch: error => WorkflowAutomationError.make({code: 'test-worker-exit', message: String(error)}),
              }).pipe(Effect.timeoutOption('3 seconds')),
            );
          }
          const exitEvidence = {pid: worker.child.pid, exitCode, forced: forced ?? null};
          yield* safeWrite(`THREADNOTE_P4_REAL_JOB_EXIT ${JSON.stringify(exitEvidence)}`);
          const succeeded = yield* Ref.get(bodySucceeded);
          if (exitCode === undefined) allOwnedExitsObserved = false;
          if (exitCode === undefined || (succeeded && (forced !== undefined || exitCode !== 0))) cleanupFailed = true;
        }
        const succeeded = yield* Ref.get(bodySucceeded);
        const captureAfterExit = yield* Ref.get(finalDiagnostic);
        if (!succeeded || cleanupFailed) {
          if (captureAfterExit && allOwnedExitsObserved) yield* captureAfterExit();
          else {
            const skippedReason =
              workers.length === 0
                ? 'owned-child-unavailable'
                : allOwnedExitsObserved
                  ? 'job-identity-unavailable'
                  : 'owned-exit-unobserved';
            yield* safeWrite(
              `THREADNOTE_P4_REAL_JOB_DIAGNOSTIC ${JSON.stringify({version: 2, reason: skippedReason, stateCapture: 'skipped'})}`,
            );
          }
        }
        if (cleanupFailed && succeeded)
          return yield* WorkflowAutomationError.make({
            code: 'test-worker-cleanup',
            message: 'Owned native job worker exit was not cleanly observed.',
          });
      });
      yield* Effect.acquireUseRelease(
        Effect.void,
        () => useWorker,
        () => cleanup,
      );
    }).pipe(TestClock.withLive, provideNative),
);

effectIt.effect('dirty-source background preparation refuses without a synchronous authoring save fallback', () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const file = f.path.join(f.root, 'dirty-background-spec.json');
    yield* f.fs.writeFileString(file, JSON.stringify(specBusiness));
    yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "dirty";\n');
    const featureName = 'Dirty background authoring';
    const project = workflowTitleSlug(f.path.basename(f.repo));
    const featureId = workflowTitleSlug(featureName);
    const runId = 'task-' + EffectString.slice(0, 48)(sha256HexSync(project + '\n' + featureId));
    const result = yield* runNativeTaskAuthoring(f.config, {
      command: 'start',
      callerCwd: f.repo,
      featureName,
      kind: 'spec',
      contentFile: file,
      installationTarget: 'codex',
      saveMode: 'background',
    }).pipe(
      Effect.provideService(SystemInfo, f.scoped),
      Effect.provideService(CurrentNativeJobAutoLaunch, false),
      Effect.result,
    );
    expect(result).toMatchObject({failure: {code: 'evidence-unavailable'}});
    const state = yield* readNativeWorkflowState(f.config, runId);
    expect(state).toBeUndefined();
  }).pipe(TestClock.withLive, provideNative),
);

effectIt.effect('admits an approved standard plan as PR delivery through semantic authoring', () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const file = f.path.join(f.root, 'pr-plan-business.json');
    const direct = {
      ...planBusiness,
      requirements: specBusiness.requirements,
      phases: A.map(planBusiness.phases, phase => ({
        ...phase,
        acceptance: A.map(phase.acceptance, item => ({...item, scenarioIds: []})),
      })),
    };
    yield* f.fs.writeFileString(file, JSON.stringify(direct));
    const draft = yield* f.author({
      command: 'start',
      featureName: 'PR task admission',
      kind: 'plan',
      contentFile: file,
      installationTarget: 'codex',
    });
    const ready = yield* f.author({
      command: 'decide',
      authoringRef: draft.authoringRef,
      userDecision: 'approve',
      userResponse: 'I approve the exact PR task plan after its required independent review.',
      review: {outcome: 'accepted', blockingIssueCount: 0},
    });
    yield* runCommandEffect('git', ['-C', f.repo, 'checkout', '-b', 'feature/readback']);
    const result = yield* f.author({
      command: 'admit',
      authoringRef: ready.authoringRef,
      delivery: 'pr',
      bindings: {readback: {branch: 'feature/readback', baseBranch: 'main'}},
    });
    expect(result).toMatchObject({status: 'admitted'});
    const state = yield* readNativeWorkflowState(f.config, String(draft.runId));
    expect(state?.state.cycle?.state.plan.delivery).toBe('pr');
    expect(yield* readNativeTaskView(f.config, {runId: String(draft.runId), callerCwd: f.repo})).toMatchObject({
      status: 'ready',
      next: {action: 'implement', phaseId: 'readback'},
    });
    const beforeReplay = yield* f.fs.readFileString(f.statePath(String(draft.runId)));
    expect(
      yield* f
        .author({
          command: 'admit',
          authoringRef: ready.authoringRef,
          delivery: 'local',
          bindings: {readback: {branch: 'feature/readback', baseBranch: 'main'}},
        })
        .pipe(Effect.result),
    ).toMatchObject({failure: {code: 'cycle-conflict'}});
    expect(yield* f.fs.readFileString(f.statePath(String(draft.runId)))).toBe(beforeReplay);
  }).pipe(TestClock.withLive, provideNative),
);

const cliLayer = Layer.mergeAll(
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
);

effectIt.effect(
  'starts a direct approved-intent prose plan through CLI without inventing a spec, and refuses stale/source/metadata changes without mutation',
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const file = f.path.join(f.root, 'direct-plan.json');
      const direct = {
        ...planBusiness,
        requirements: specBusiness.requirements,
        phases: A.map(planBusiness.phases, phase => ({
          ...phase,
          acceptance: A.map(phase.acceptance, item => ({...item, scenarioIds: []})),
        })),
      };
      yield* f.fs.writeFileString(file, JSON.stringify(direct));
      const cli = Command.make('threadnote').pipe(
        Command.withSubcommands([makeNativeTaskAuthoringCommand(program => program(f.config))]),
      );
      yield* Command.runWith(cli, {version: 'fixture'})([
        'task-author',
        '--operation',
        'start',
        '--caller-cwd',
        f.repo,
        '--feature-name',
        'Direct intent',
        '--kind',
        'plan',
        '--content-file',
        file,
        '--installation-target',
        'codex',
      ]).pipe(provideTestLayer(cliLayer), Effect.provideService(SystemInfo, f.scoped));
      const draft = yield* f.author({
        command: 'start',
        featureName: 'Direct intent',
        kind: 'plan',
        contentFile: file,
        installationTarget: 'codex',
      });
      expect(draft).toMatchObject({status: 'draft', replayed: true});
      const read = yield* f.author({command: 'read', authoringRef: draft.authoringRef, detail: 'document'});
      const document = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(read.document);
      expect(document.spec).toBeUndefined();
      expect(document.current.summary).toBe(direct.current.summary);
      expect(document.current.diagram).toBe('');
      const statePath = f.statePath(String(draft.runId));
      const bytes = yield* f.fs.readFileString(statePath);
      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "changed after presentation";\n',
      );
      const changedSource = yield* runNativeTaskAuthoring(f.config, {
        command: 'decide',
        callerCwd: f.repo,
        authoringRef: draft.authoringRef,
        userDecision: 'approve',
        userResponse: 'I approve the originally displayed plan.',
        review: {outcome: 'accepted', blockingIssueCount: 0},
      }).pipe(Effect.provideService(SystemInfo, f.scoped), Effect.result);
      expect(changedSource).toMatchObject({failure: {code: 'source-drift'}});
      expect(yield* f.fs.readFileString(statePath)).toBe(bytes);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = true;\n');
      yield* f.fs.writeFileString(file, JSON.stringify({...direct, project: 'foreign'}));
      expect(
        yield* runNativeTaskAuthoring(f.config, {
          command: 'save',
          callerCwd: f.repo,
          authoringRef: draft.authoringRef,
          contentFile: file,
        }).pipe(Effect.provideService(SystemInfo, f.scoped), Effect.result),
      ).toMatchObject({failure: {code: 'invalid-content'}});
      expect(yield* f.fs.readFileString(statePath)).toBe(bytes);
      yield* f.fs.writeFileString(
        file,
        JSON.stringify({...direct, objective: 'Preserve the complete fixture value after a reload.'}),
      );
      const updated = yield* f.author({command: 'save', authoringRef: draft.authoringRef, contentFile: file});
      expect(updated.status).toBe('draft');
      const updatedBytes = yield* f.fs.readFileString(statePath);
      expect(
        yield* runNativeTaskAuthoring(f.config, {
          command: 'decide',
          callerCwd: f.repo,
          authoringRef: draft.authoringRef,
          userDecision: 'approve',
          userResponse: 'The earlier approval cannot authorize changed intent.',
          review: {outcome: 'accepted', blockingIssueCount: 0},
        }).pipe(Effect.provideService(SystemInfo, f.scoped), Effect.result),
      ).toMatchObject({failure: {code: 'stale-authoring-ref'}});
      expect(yield* f.fs.readFileString(statePath)).toBe(updatedBytes);
      const approved = yield* f.author({
        command: 'decide',
        authoringRef: updated.authoringRef,
        userDecision: 'approve',
        userResponse: 'I approve the complete current direct-intent plan.',
        review: {outcome: 'accepted', blockingIssueCount: 0},
      });
      expect(approved.status).toBe('ready');
    }).pipe(TestClock.withLive, provideNative),
);

effectIt.effect(
  'invalidates an old approved spec transfer when an explicit specification update changes its canonical revision',
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const specFile = f.path.join(f.root, 'spec.json');
      const planFile = f.path.join(f.root, 'plan.json');
      yield* f.fs.writeFileString(specFile, JSON.stringify(specBusiness));
      yield* f.fs.writeFileString(planFile, JSON.stringify(planBusiness));
      const draft = yield* f.author({
        command: 'start',
        featureName: 'Spec revision',
        kind: 'spec',
        contentFile: specFile,
        installationTarget: 'codex',
      });
      const ready = yield* f.author({
        command: 'decide',
        authoringRef: draft.authoringRef,
        userDecision: 'approve',
        userResponse: 'I approve the exact original specification.',
        review: {outcome: 'accepted', blockingIssueCount: 0},
      });
      const beforeSourceChange = yield* f.fs.readFileString(f.statePath(String(draft.runId)));
      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "drift before spec transfer";\n',
      );
      expect(
        yield* runNativeTaskAuthoring(f.config, {
          command: 'start',
          callerCwd: f.repo,
          featureName: 'Spec revision',
          kind: 'plan',
          contentFile: planFile,
          specRef: ready.authoringRef,
        }).pipe(Effect.provideService(SystemInfo, f.scoped), Effect.result),
      ).toMatchObject({failure: {code: 'source-drift'}});
      expect(yield* f.fs.readFileString(f.statePath(String(draft.runId)))).toBe(beforeSourceChange);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = true;\n');
      yield* f.fs.writeFileString(
        specFile,
        JSON.stringify({...specBusiness, objective: 'Read the complete value and its updated metadata.'}),
      );
      const updated = yield* f.author({command: 'save', authoringRef: ready.authoringRef, contentFile: specFile});
      expect(updated.status).toBe('draft');
      const statePath = f.statePath(String(draft.runId));
      const before = yield* f.fs.readFileString(statePath);
      expect(
        yield* runNativeTaskAuthoring(f.config, {
          command: 'start',
          callerCwd: f.repo,
          featureName: 'Spec revision',
          kind: 'plan',
          contentFile: planFile,
          specRef: ready.authoringRef,
        }).pipe(Effect.provideService(SystemInfo, f.scoped), Effect.result),
      ).toMatchObject({failure: {code: 'stale-spec-ref'}});
      expect(yield* f.fs.readFileString(statePath)).toBe(before);
    }).pipe(TestClock.withLive, provideNative),
);

effectIt.effect.each([
  'initial-source',
  'update-source',
  'update-history',
  'update-root',
  'verified-root',
  'promote-root',
  'promote-verified',
] as const)('resumes the exact public standard save at %s without duplicate artifact effects', cut =>
  Effect.gen(function* () {
    const f = yield* setup;
    const file = f.path.join(f.root, 'fault-spec.json');
    yield* f.fs.writeFileString(file, JSON.stringify(specBusiness));
    const start = {
      command: 'start',
      featureName: 'Fault recovery',
      kind: 'spec',
      contentFile: file,
      installationTarget: 'codex',
    };
    const prior = cut === 'initial-source' ? undefined : yield* f.author(start);
    const runId = prior
      ? String(prior.runId)
      : 'task-' + EffectString.slice(0, 48)(sha256HexSync('repo\nfault-recovery'));
    const promotion = cut === 'promote-root' || cut === 'promote-verified';
    const intended =
      cut === 'initial-source' || promotion
        ? specBusiness
        : {...specBusiness, objective: 'Keep the complete revised specification available.'};
    yield* f.fs.writeFileString(file, JSON.stringify(intended));
    const action =
      promotion && prior
        ? {
            command: 'decide',
            authoringRef: prior.authoringRef,
            userDecision: 'approve',
            userResponse: 'I approve the exact displayed specification after independent review.',
            review: {outcome: 'accepted', blockingIssueCount: 0},
          }
        : prior
          ? {command: 'save', authoringRef: prior.authoringRef, contentFile: file}
          : start;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* ResourceStore;
    const statePath = f.path.join(f.config.agentContextHome, 'workflow-automations', 'native-v1', runId + '.json');
    const observe = () =>
      readNativeWorkflowState(f.config, runId).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.orDie,
      );
    let injected = false;
    const writes = new Map<string, number>();
    const resource = ResourceStore.of({
      ...store,
      writeChecked: (...args) =>
        store.writeChecked(...args).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              const current = yield* observe();
              const operation = current?.state.operations.at(-1);
              if (operation)
                writes.set(operation.intent.operationId, (writes.get(operation.intent.operationId) ?? 0) + 1);
              const hint = operation?.intent.nameHint;
              if (
                !injected &&
                operation?.status === 'prepared' &&
                (cut === 'initial-source' || cut === 'update-source'
                  ? hint === 'source'
                  : cut === 'update-history'
                    ? hint === 'history'
                    : (cut === 'update-root' || cut === 'promote-root') && operation.intent.role === 'authoring-root')
              ) {
                injected = true;
                return yield* Effect.die(new Error('Injected standard save acknowledgement loss at ' + cut));
              }
            }),
          ),
        ),
    });
    const failingFs = FileSystem.make({
      ...fs,
      rename: (from, to) =>
        fs.rename(from, to).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              if (to !== statePath || injected || (cut !== 'verified-root' && cut !== 'promote-verified')) return;
              const current = yield* observe();
              const reservation = current?.state.authoringSave;
              const operation = current?.state.operations.at(-1);
              if (
                reservation &&
                current &&
                current.state.operations.length > reservation.operationStart &&
                operation?.status === 'verified' &&
                operation.intent.role === 'authoring-root'
              ) {
                injected = true;
                return yield* Effect.die(new Error('Injected verified root before reservation finalization'));
              }
            }),
          ),
        ),
    });
    const interrupted = yield* f
      .author(action)
      .pipe(
        Effect.provideService(ResourceStore, resource),
        Effect.provideService(FileSystem.FileSystem, failingFs),
        Effect.exit,
      );
    expect(interrupted._tag).toBe('Failure');
    expect(injected).toBe(true);
    const pending = yield* readNativeWorkflowState(f.config, runId);
    if (!pending?.state.authoringSave) throw new Error('The real native fault must retain its exact reservation.');
    const prefix = pending.state.operations;
    const pendingBytes = yield* f.fs.readFileString(statePath);
    const journal = yield* f.fs.readFileString(f.journalPath(pending.state.bindingId));
    yield* f.fs.writeFileString(
      file,
      JSON.stringify({...intended, objective: 'Changed intent cannot reuse the admitted save.'}),
    );
    expect(
      yield* runNativeTaskAuthoring(f.config, {
        callerCwd: f.repo,
        ...action,
        ...(promotion ? {userResponse: 'A different response cannot reuse this admitted approval.'} : {}),
      }).pipe(
        Effect.provideService(SystemInfo, f.scoped),
        Effect.provideService(ResourceStore, resource),
        Effect.result,
      ),
    ).toMatchObject({failure: {code: 'pending-operation'}});
    expect(yield* f.fs.readFileString(statePath)).toBe(pendingBytes);
    expect(yield* f.fs.readFileString(f.journalPath(pending.state.bindingId))).toBe(journal);
    yield* f.fs.writeFileString(file, JSON.stringify(intended));
    const recovered = yield* f.author(action).pipe(Effect.provideService(ResourceStore, resource));
    expect(recovered.status).toBe(promotion ? 'ready' : 'draft');
    const after = yield* readNativeWorkflowState(f.config, runId);
    expect(after?.state.authoringSave).toBeUndefined();
    if (!after) throw new Error('The original canonical run must remain.');
    expect(after.state.generation).toBe(pending.state.generation);
    expect(after.state.bindingId).toBe(pending.state.bindingId);
    expect(A.map(after.state.operations.slice(0, prefix.length), operation => operation.intent)).toEqual(
      A.map(prefix, operation => operation.intent),
    );
    expect(new Set(A.map(after.state.operations, operation => operation.intent.operationId)).size).toBe(
      after.state.operations.length,
    );
    expect(A.every([...writes.values()], count => count === 1)).toBe(true);
    const detail = yield* f.author({command: 'read', authoringRef: recovered.authoringRef, detail: 'document'});
    expect(object(detail.document).objective).toBe(intended.objective);
    // Independent native authoring read is an oracle, never a caller recovery step.
    const canonical = object(
      object(
        yield* f.call({
          ...f.base('authoring', runId, after.state.generation),
          command: 'load',
          uri: object(recovered.root).uri,
          detail: 'document',
        }),
      ).authoring,
    ).document;
    expect(detail.document).toEqual(canonical);
    const operation = after.state.operations.at(-1);
    if (!operation?.artifact) throw new Error('The final root must have a verified artifact.');
    const root = decodeAuthoringArtifact(operation.artifact.body, AuthoringRootSchema);
    if (prior) {
      expect(root.previous).toBeDefined();
      if (!root.previous) throw new Error('An update must preserve its previous root.');
      const historical = decodeAuthoringArtifact(
        yield* Schema.decodeUnknownEffect(Schema.String)(
          object(
            object(yield* f.call({...f.base('read', runId, after.state.generation), uri: root.previous.uri})).artifact,
          ).body,
        ),
        AuthoringRootSchema,
      );
      expect(historical.documentHash).toBe(prior.documentHash);
    }
    const completeBytes = yield* f.fs.readFileString(statePath);
    const count = A.reduce([...writes.values()], 0, (sum, value) => sum + value);
    expect(yield* f.author(action).pipe(Effect.provideService(ResourceStore, resource))).toMatchObject({
      replayed: true,
      authoringRef: recovered.authoringRef,
    });
    expect(yield* f.fs.readFileString(statePath)).toBe(completeBytes);
    expect(A.reduce([...writes.values()], 0, (sum, value) => sum + value)).toBe(count);
  }).pipe(TestClock.withLive, provideNative),
);

const asciiId = fc.string({unit: fc.constantFrom('a', 'b', '0', '9', '-', '_'), minLength: 1, maxLength: 24});
const hexDigest = fc.string({unit: fc.constantFrom('0', '1', 'a', 'b', 'e', 'f'), minLength: 64, maxLength: 64});
fcEffectProp(
  effectIt,
  'round-trips bounded canonical authoring continuations without a store or source dependency',
  {
    kind: fc.constantFrom('spec' as const, 'plan' as const),
    suffix: asciiId,
    documentHash: hexDigest,
    stateRevision: hexDigest,
    generationHash: hexDigest,
  },
  value =>
    Effect.gen(function* () {
      const expected = {
        version: 1 as const,
        kind: value.kind,
        runId: 'run-' + value.suffix,
        operationId: 'author-' + value.suffix,
        documentHash: value.documentHash,
        stateRevision: value.stateRevision,
        generationHash: value.generationHash,
      };
      const encoded = encodeNativeAuthoringTaskRef(expected);
      expect(encoded.length).toBeLessThan(4096);
      expect(encoded).toMatch(/^authorref-v1\.[A-Za-z0-9_-]+$/u);
      expect(yield* decodeNativeAuthoringTaskRef(encoded)).toEqual(expected);
      expect(encodeNativeAuthoringTaskRef(yield* decodeNativeAuthoringTaskRef(encoded))).toBe(encoded);
    }),
  {fastCheck: {numRuns: 32}},
);

fcEffectProp(
  effectIt,
  'foreign same-basename roots cannot mutate authoring job state for any generated cancel or resume attempt',
  {
    operation: fc.constantFrom('cancel' as const, 'resume' as const),
    suffix: asciiId,
  },
  value =>
    Effect.gen(function* () {
      const f = yield* setup;
      const file = f.path.join(f.root, 'foreign-property-spec.json');
      yield* f.fs.writeFileString(file, JSON.stringify(specBusiness));
      const accepted = yield* f
        .author({
          command: 'start',
          featureName: 'Generated foreign job owner binding',
          kind: 'spec',
          contentFile: file,
          installationTarget: 'codex',
          saveMode: 'background',
        })
        .pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false));
      const runId = String(accepted.runId);
      const jobRef = String(accepted.jobRef);
      const jobPayload = object(
        JSON.parse(
          Buffer.from(
            EffectString.replaceAll(
              '_',
              '/',
            )(EffectString.replaceAll('-', '+')(EffectString.slice('authorjob-v1.'.length)(jobRef))),
            'base64',
          ).toString('utf8'),
        ),
      );
      const run = yield* readNativeWorkflowState(f.config, runId);
      if (!run) throw new Error('The submitted job has no native run.');
      const foreignRepo = f.path.join(f.root, 'generated-' + value.suffix, 'repo');
      yield* f.fs.makeDirectory(foreignRepo, {recursive: true});
      yield* f.fs.writeFileString(f.path.join(foreignRepo, 'source.ts'), 'export const foreign = true;\n');
      yield* runCommandEffect('git', ['init', '--initial-branch=main', foreignRepo]);
      const beforeRun = yield* f.fs.readFileString(f.statePath(runId));
      const jobDirectory = f.path.join(f.home, 'workflow-automations', 'native-v1', 'jobs', runId);
      const jobNames = [...(yield* f.fs.readDirectory(jobDirectory))].sort();
      const beforeJobs: Array<readonly [string, string]> = [];
      for (const name of jobNames) beforeJobs.push([name, yield* f.fs.readFileString(f.path.join(jobDirectory, name))]);
      const result = yield* runNativeJob(
        f.config,
        {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'job',
          command: value.operation,
          runId,
          generation: run.state.generation,
          jobId: jobPayload.jobId,
        },
        () => Effect.void,
      ).pipe(Effect.provideService(SystemInfo, {...f.scoped, currentDirectory: () => foreignRepo}), Effect.result);
      expect(result).toMatchObject({failure: {code: 'binding-drift'}});
      expect(yield* f.fs.readFileString(f.statePath(runId))).toBe(beforeRun);
      const afterJobs: Array<readonly [string, string]> = [];
      for (const name of jobNames) afterJobs.push([name, yield* f.fs.readFileString(f.path.join(jobDirectory, name))]);
      expect(afterJobs).toEqual(beforeJobs);
    }).pipe(TestClock.withLive, provideNative),
  {fastCheck: {numRuns: 4}},
);
