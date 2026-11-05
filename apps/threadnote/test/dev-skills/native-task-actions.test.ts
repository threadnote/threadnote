import {Effect, FileSystem, Layer, Path, Schema, Stdio, Terminal, Tracer} from 'effect';
import {ChildProcessSpawner} from 'effect/process';
import {Command} from 'effect/cli';
import {it as effectIt} from '@effect/vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {describe, expect} from 'vitest';
import {
  decodeNativeTaskActionRef,
  encodeNativeTaskActionRef,
  nativeTaskSnapshotId,
} from '@threadnote/workflow-automations/task';
import {
  NativeAuthoringPlanDocumentSchema,
  NativeCompactSourceSnapshotSchema,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
  projectNativeCompactIntent,
} from '@threadnote/workflow-automations/authoring';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {makeNativeTaskActionCommands, makeNativeTaskViewCommand} from '../../src/effect/workflow_cli.js';
import {runNativeTaskAction} from '../../src/workflow_automation/task_actions.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {CurrentNativeJobAutoLaunch, runNativeJobWorker} from '../../src/workflow_automation/native_jobs.js';
import {readNativeCloseoutJournal} from '../../src/workflow_automation/closeout_store.js';
import {decodeJournal} from '../../src/workflow_automation/closeout_request_schema.js';
import {completeLocalPhase, fixture, object, run} from './native-cycle-lifecycle-fixture.js';
import {nativeFixture} from './native-automation-fixture.js';
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

// Hold the first journal read at its prepared bytes while the real worker completes.
// The facade must reconcile that captured image with the later completed job result.
const completeDuringJournalRead = (f: Effect.Success<ReturnType<typeof fixture>>, finishJobId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const worker = runNativeJobWorker(f.config, 'native-run', finishJobId, f.call);
    const context = yield* Effect.context<Effect.Services<typeof worker>>();
    const closeoutFile = yield* fs.realPath(f.statePath() + '.closeout.json');
    let captured = false;
    const filesystem = FileSystem.FileSystem.of({
      ...fs,
      readFile: file =>
        fs.readFile(file).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              if (file !== closeoutFile || captured) return;
              captured = true;
              const before = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
              expect(before?.state.status).toBe('prepared');
              expect(object(yield* worker).status).toBe('completed');
            }).pipe(Effect.provideContext(context), Effect.orDie),
          ),
        ),
    });
    return {filesystem, wasCaptured: () => captured};
  });

// Resource oracle on the real facade: one authoritative receipt inspection per read,
// independent of whether a run has no root, a compact packet, or accumulated cycle history.
const inspectTaskOnce = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const delegate = yield* Effect.tracer;
    let inspections = 0;
    const tracer = Tracer.make({
      ...delegate,
      span(options) {
        if (options.name === 'workflowAutomation.inspectNative') inspections++;
        return delegate.span.call(delegate, options);
      },
    });
    const result = yield* program.pipe(Effect.withTracer(tracer));
    expect(inspections).toBe(1);
    return result;
  });

describe('native task actions', () => {
  effectIt.effect('saves a compact draft, records exact user approval and initializes the same task facade', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
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
      const emptyState = yield* f.fs.readFileString(f.statePath());
      expect(
        yield* inspectTaskOnce(readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})),
      ).toMatchObject({status: 'uninitialized'});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(emptyState);
      const indexer = yield* CodeGraphIndexer;
      const indexed = yield* indexer.index({cwd: f.repo, threadnoteHome: f.home});
      expect(indexed.snapshot.state).toBe('ready');
      const intent = {
        title: 'Refresh expired fixture data',
        currentBehavior: 'Expired fixture data is returned without a freshness check.',
        desiredChange: 'Expired fixture data is refreshed before it is returned.',
        affectedPaths: ['source.ts'],
        acceptanceCriterion: 'Expired fixture data is refreshed before return.',
        verification: 'Exercise expired fixture data and observe the refresh.',
        eligibilityRationale:
          'One behavior and one inspected file are explicit, with no unresolved product decision or dependency.',
        eligibility: {status: 'eligible'},
        review: {required: false, reason: 'Routine local fixture correction.'},
      };
      const inspectedSource = object(
        yield* f.call({
          ...f.base('authoring'),
          command: 'scope-inspect',
          paths: intent.affectedPaths,
          literalOnly: true,
        }),
      );
      const sourceSnapshot = yield* Schema.decodeUnknownEffect(NativeCompactSourceSnapshotSchema)(
        object(inspectedSource.authoring).source,
      );
      const forgedCompact = projectNativeCompactIntent(
        intent,
        {featureId: 'feature', project: 'fixture'},
        sourceSnapshot,
      );
      if (forgedCompact.status !== 'eligible') throw new Error('Expected eligible fixture compact intent.');
      const beforeForgedSave = yield* f.fs.readFileString(f.statePath());
      const forgedSave = yield* f
        .call({
          ...f.base('authoring'),
          command: 'save',
          document: forgedCompact.document,
          ready: false,
          expectedRevision: null,
        })
        .pipe(Effect.result);
      expect(forgedSave).toMatchObject({failure: {code: 'compact-origin-forbidden'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeForgedSave);
      let cliDraft: Record<string, unknown> | undefined;
      const commands = makeNativeTaskActionCommands(
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        options =>
          runNativeTaskAction(f.config, {command: 'compact-start', ...options}).pipe(
            Effect.tap(value => Effect.sync(() => (cliDraft = object(value)))),
            Effect.asVoid,
          ),
        () => Effect.void,
        () => Effect.void,
      );
      const cli = Command.make('workflow-automation').pipe(Command.withSubcommands([commands]));
      const runCli = Command.runWith(cli, {version: 'fixture'});
      const beforeStart = yield* f.fs.readFileString(f.statePath());
      const malformed = yield* runCli([
        'task-action',
        'compact-start',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--intent',
        '{invalid',
      ]).pipe(Effect.result);
      expect(malformed).toMatchObject({failure: {code: 'invalid-request'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeStart);
      yield* runCli([
        'task-action',
        'compact-start',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--intent',
        JSON.stringify(intent),
      ]);
      const draft = object(cliDraft);
      expect(draft.status).toBe('awaiting-user-confirmation');
      expect(yield* f.fs.readFileString(f.statePath())).not.toBe(beforeStart);
      const savedState = yield* f.fs.readFileString(f.statePath());
      // The mutation response can be lost: recover the current root and packet through the read-only facade.
      const initialState = yield* readNativeWorkflowState(f.config, 'native-run');
      if (!initialState) throw new Error('Expected persisted compact run.');
      const initialJournal = yield* f.fs.readFileString(f.journalPath(initialState.state.bindingId));
      // Test oracle only: observe and decode the actual persisted document independently
      // before discarding the mutation response. Keep this read outside the traced task-view scope.
      const expectedInitialDocument = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema, {
        onExcessProperty: 'error',
      })(
        object(
          object(
            yield* f.call({...f.base('authoring'), command: 'load', uri: object(draft.root).uri, detail: 'document'}),
          ).authoring,
        ).document,
      );

      const resumedDraft = object(
        yield* inspectTaskOnce(readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})),
      );
      expect(resumedDraft).toMatchObject({
        status: 'blocked',
        next: {action: 'compact-confirm'},
        authoring: {
          status: 'awaiting-user-confirmation',
          root: draft.root,
          intentHash: draft.intentHash,
          documentHash: draft.documentHash,
          packet: {intentHash: draft.intentHash, documentHash: draft.documentHash},
        },
      });
      expect(object(resumedDraft.authoring).packet).not.toHaveProperty('document');
      expect(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).toEqual(resumedDraft);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      expect(yield* f.fs.readFileString(f.journalPath(initialState.state.bindingId))).toBe(initialJournal);
      let cliPacket: Record<string, unknown> | undefined;
      const taskViewCommand = makeNativeTaskViewCommand(options =>
        readNativeTaskView(f.config, {
          runId: options.runId,
          callerCwd: options.callerCwd,
          ...(options.detail === undefined ? {} : {detail: options.detail}),
        }).pipe(
          Effect.tap(value =>
            Effect.sync(() => {
              cliPacket = object(value);
            }),
          ),
          Effect.asVoid,
        ),
      );
      const taskViewCli = Command.make('workflow-automation').pipe(Command.withSubcommands([taskViewCommand]));
      yield* Command.runWith(taskViewCli, {version: 'fixture'})([
        'task-view',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--detail',
        'packet',
      ]);
      const recoveredDraft = object(object(object(cliPacket).authoring).packet);
      expect(recoveredDraft.document).toEqual(expectedInitialDocument);
      expect(recoveredDraft.documentHash).toBe(nativeAuthoringDigest(expectedInitialDocument));
      expect(recoveredDraft.intentHash).toBe(nativeSpecIntentDigest(expectedInitialDocument));

      expect(recoveredDraft).toMatchObject({
        intentHash: draft.intentHash,
        documentHash: draft.documentHash,
        document: {
          title: intent.title,
          current: {summary: intent.currentBehavior},
          target: {summary: intent.desiredChange},
          phases: [
            {
              affectedPaths: intent.affectedPaths,
              acceptance: [{criterion: intent.acceptanceCriterion, verification: intent.verification}],
            },
          ],
          compactOrigin: {eligibilityRationale: intent.eligibilityRationale},
        },
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      expect(yield* f.fs.readFileString(f.journalPath(initialState.state.bindingId))).toBe(initialJournal);
      const draftPacket = object(draft.packet);
      const draftDocument = object(draftPacket.document);
      const documentWithoutCompactOrigin = {...draftDocument};
      delete documentWithoutCompactOrigin.compactOrigin;
      const root = object(draft.root);
      const markerRemoval = yield* f
        .call({
          ...f.base('authoring'),
          command: 'save',
          document: documentWithoutCompactOrigin,
          ready: false,
          uri: root.uri,
          expectedRevision: root.revision,
        })
        .pipe(Effect.result);
      expect(markerRemoval).toMatchObject({failure: {code: 'compact-confirmation-required'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      const intentHash = String(draft.intentHash);
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const omittedDecision = object(
        yield* mcp.invokeTool('workflow_task_compact_confirm', {
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: intentHash,
          userResponse: 'I reject this exact intent because it changes too much.',
          baseBranch: 'main',
        }),
      );
      expect(omittedDecision.structuredContent).toMatchObject({status: 'awaiting-user-confirmation'});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      const explicitRejection = object(
        yield* mcp.invokeTool('workflow_task_compact_confirm', {
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: intentHash,
          userDecision: 'reject',
          userResponse: 'I reject this exact intent because it changes too much.',
          baseBranch: 'main',
        }),
      );
      expect(explicitRejection.structuredContent).toMatchObject({status: 'reject'});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      const explicitDeferral = object(
        yield* mcp.invokeTool('workflow_task_compact_confirm', {
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: intentHash,
          userDecision: 'defer',
          userResponse: 'Defer this exact intent until I decide.',
          baseBranch: 'main',
        }),
      );
      expect(explicitDeferral.structuredContent).toMatchObject({status: 'defer'});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      const response = object(
        yield* mcp.invokeTool('workflow_task_compact_confirm', {
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: intentHash,
          userResponse: 'I approve this exact bounded fixture change.',
          userDecision: 'approve',
          baseBranch: 'main',
        }),
      );
      expect(response.isError).not.toBe(true);
      const approved = object(response.structuredContent);
      expect(approved).toMatchObject({
        status: 'admitted',
        intentHash,
        taskReadiness: 'ready',
        task: {status: 'ready', next: {action: 'implement'}},
      });
      const initialPlan = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(draftDocument);
      const work = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      expect(work).toMatchObject({status: 'ready', phaseId: 'compact'});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "worker result";\n');
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
        'Worker source result',
      ]);
      const reindexed = yield* (yield* CodeGraphIndexer).index({cwd: f.repo, threadnoteHome: f.home});
      expect(reindexed.snapshot.state).toBe('ready');
      const snapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      expect(snapshot.status).toBe('recorded');
      const snapshotRef = String(snapshot.snapshotRef);
      const finding = {
        id: 'compact-expansion-preserved-finding',
        file: 'source.ts',
        line: 1,
        body: 'The implementation has not yet established the expanded behavior.',
        trigger: 'The phase has an unreviewed source snapshot.',
        impact: 'The expanded plan must retain this finding and its history.',
        evidence: 'The finding is stored against the immutable compact phase snapshot.',
        severity: 'important',
        category: 'correctness',
        confidence: 90,
        state: 'new',
      };
      const recordedFinding = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          report: {
            mode: 'full',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings: [finding],
          },
        }),
      );
      expect(recordedFinding).toMatchObject({status: 'recorded', replayed: false});
      const beforeExpansion = yield* readNativeWorkflowState(f.config, 'native-run');
      const preservedCycle = beforeExpansion?.state.cycle;
      expect(preservedCycle?.attempts).toHaveLength(1);
      expect(preservedCycle?.attempts[0]?.report).toContain('compact-expansion-preserved-finding');
      expect(preservedCycle?.reviews).toHaveLength(1);
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
      const refreshedSource = object(sourceInspection.source);
      const compactPhase = initialPlan.phases[0];
      const firstAcceptance = compactPhase?.acceptance[0];
      if (!compactPhase || !firstAcceptance) throw new Error('The compact plan must have one accepted phase.');
      const expandedDocument = {
        ...initialPlan,
        title: 'Refresh fixture data and verify the persisted result',
        objective: 'Refresh stale fixture data and verify the persisted result on the same run.',
        requirements: [{id: 'behavior', behavior: 'Stale fixture data is refreshed and verified before return.'}],
        source: refreshedSource,
        current: {...initialPlan.current, summary: 'Expired fixture data is returned without a freshness check.'},
        target: {...initialPlan.target, summary: 'Expired fixture data is refreshed and then verified before return.'},
        phases: [
          {
            ...compactPhase,
            title: 'Refresh expired fixture data',
            outcome: 'Expired fixture data is refreshed before return.',
            acceptance: [
              {
                ...firstAcceptance,
                criterion: 'Expired fixture data is refreshed before return.',
                verification: 'Exercise expiration and observe the refreshed result.',
              },
            ],
          },
          {
            ...compactPhase,
            id: 'verify',
            title: 'Verify persisted fixture data',
            outcome: 'The refreshed fixture data remains available after reload.',
            dependsOn: ['compact'],
            acceptance: [
              {
                ...firstAcceptance,
                id: 'persisted-result',
                criterion: 'The refreshed fixture result remains available after reload.',
                verification: 'Reload the fixture and observe the refreshed result.',
              },
            ],
          },
        ],
        decisions: [
          {
            id: 'verify-after-refresh',
            question: 'How should persistence be checked?',
            selection: 'no-better-alternative',
            selected: 'Use the existing readback path after the refresh.',
            alternatives: [],
            rationale: 'This adds one dependent verification phase while retaining the existing storage contract.',
            affectedPhases: ['compact', 'verify'],
            authority: 'orchestrator',
          },
        ],
        review: {required: true, reason: 'The expanded scope adds a dependent persistence check.'},
      };
      const expanded = object(
        yield* mcp.invokeTool('workflow_task_compact_expand', {
          runId: 'native-run',
          callerCwd: f.repo,
          document: expandedDocument,
        }),
      );
      expect(expanded.isError).not.toBe(true);
      const expandedContent = object(expanded.structuredContent);
      expect(expandedContent).toMatchObject({
        status: 'awaiting-user-confirmation',
        previousRoot: root.uri,
        root: {uri: root.uri},
      });
      const expandedIntentHash = String(expandedContent.intentHash);
      expect(expandedIntentHash).not.toBe(intentHash);
      // Independently capture the complete persisted expansion as a test oracle, not a user recovery step.
      const expectedExpandedDocument = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema, {
        onExcessProperty: 'error',
      })(
        object(
          object(
            yield* f.call({
              ...f.base('authoring'),
              command: 'load',
              uri: object(expandedContent.root).uri,
              detail: 'document',
            }),
          ).authoring,
        ).document,
      );
      // Recover all authored material through the task MCP surface after discarding the expansion response.
      const detailedExpanded = object(
        yield* mcp.invokeTool('workflow_task_view', {
          runId: 'native-run',
          callerCwd: f.repo,
          detail: 'packet',
        }),
      );
      expect(detailedExpanded.isError).not.toBe(true);
      const recoveredExpanded = object(object(object(detailedExpanded.structuredContent).authoring).packet);
      expect(recoveredExpanded).toMatchObject({
        intentHash: expandedIntentHash,
        documentHash: expandedContent.documentHash,
      });
      const recoveredExpandedDocument = object(recoveredExpanded.document);
      expect(recoveredExpandedDocument).toEqual(expectedExpandedDocument);
      expect(recoveredExpanded.documentHash).toBe(nativeAuthoringDigest(expectedExpandedDocument));
      expect(recoveredExpanded.intentHash).toBe(nativeSpecIntentDigest(expectedExpandedDocument));

      expect(recoveredExpandedDocument.title).toBe(expandedDocument.title);
      expect(recoveredExpandedDocument.current).toEqual(expandedDocument.current);
      expect(recoveredExpandedDocument.target).toEqual(expandedDocument.target);
      expect(recoveredExpandedDocument.phases).toEqual(expandedDocument.phases);
      expect(recoveredExpandedDocument.decisions).toEqual(expandedDocument.decisions);
      expect(recoveredExpandedDocument.requirements).toEqual(expandedDocument.requirements);
      const expandedResume = object(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo}));
      expect(expandedResume).toMatchObject({
        status: 'blocked',
        next: {action: 'compact-confirm'},
        authoring: {
          status: 'awaiting-user-confirmation',
          intentHash: expandedIntentHash,
          documentHash: expandedContent.documentHash,
          root: expandedContent.root,
        },
        cycleTask: {status: 'blocked'},
      });
      expect(object(expandedResume.authoring).intentHash).not.toBe(intentHash);
      const beforeStaleConfirmation = yield* f.fs.readFileString(f.statePath());
      const staleConfirmation = yield* runNativeTaskAction(f.config, {
        command: 'compact-confirm',
        runId: 'native-run',
        callerCwd: f.repo,
        presentedIntentHash: intentHash,
        userResponse: 'I approve the original compact intent.',
        baseBranch: 'main',
      }).pipe(Effect.result);
      expect(staleConfirmation).toMatchObject({failure: {code: 'stale-intent'}});
      const afterStaleConfirmation = yield* f.fs.readFileString(f.statePath());
      expect(afterStaleConfirmation).toBe(beforeStaleConfirmation);
      const awaitingExpandedApproval = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-confirm',
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: expandedIntentHash,
          baseBranch: 'main',
        }),
      );
      expect(awaitingExpandedApproval.status).toBe('awaiting-user-confirmation');
      expect(awaitingExpandedApproval.actorIdentity).toContain('caller-asserted');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterStaleConfirmation);
      const approvedWithoutReview = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-confirm',
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: expandedIntentHash,
          userDecision: 'approve',
          userResponse: 'I approve the expanded two-phase intent and its exact source scope.',
          baseBranch: 'main',
        }),
      );
      expect(approvedWithoutReview.status).toBe('awaiting-review');
      const reviewState = yield* f.fs.readFileString(f.statePath());
      const awaitingReview = object(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo}));
      expect(awaitingReview).toMatchObject({
        status: 'blocked',
        next: {action: 'compact-confirm'},
        authoring: {
          status: 'awaiting-review',
          intentHash: expandedIntentHash,
          documentHash: expandedContent.documentHash,
        },
        cycleTask: {status: 'blocked'},
      });
      expect(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).toEqual(awaitingReview);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(reviewState);
      const expandedApproval = object(
        yield* mcp.invokeTool('workflow_task_compact_confirm', {
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: expandedIntentHash,
          userDecision: 'approve',
          userResponse: 'I approve the expanded two-phase intent and its exact source scope.',
          baseBranch: 'main',
          review: {
            documentHash: String(expandedContent.documentHash),
            outcome: 'accepted',
            blockingIssueCount: 0,
          },
        }),
      );
      expect(expandedApproval.isError).not.toBe(true);
      expect(expandedApproval.structuredContent).toMatchObject({
        status: 'admitted',
        intentHash: expandedIntentHash,
        actorIdentity: expect.stringContaining('caller-asserted'),
      });
      const afterExpansion = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(afterExpansion?.state.cycle?.snapshots).toEqual(preservedCycle?.snapshots);
      expect(afterExpansion?.state.cycle?.attempts).toEqual(preservedCycle?.attempts);
      expect(afterExpansion?.state.cycle?.reviews).toEqual(preservedCycle?.reviews);
      expect(afterExpansion?.state.cycle?.reviewLimits).toEqual(preservedCycle?.reviewLimits);
      expect(afterExpansion?.state.cycle?.reviewExpansions).toEqual(preservedCycle?.reviewExpansions);
      expect(afterExpansion?.state.cycle?.plans).toContainEqual(
        expect.objectContaining({
          source: expect.objectContaining({documentHash: preservedCycle?.state.plan.source.documentHash}),
        }),
      );
      const taskView = yield* inspectTaskOnce(readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo}));
      const repeatedTaskView = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(taskView).toEqual(repeatedTaskView);
      expect(taskView).toMatchObject({status: 'blocked', next: {action: 'blocked'}});
      const stored = yield* f.fs.readFileString(f.statePath());
      const replay = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-confirm',
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: expandedIntentHash,
          baseBranch: 'main',
          review: {
            documentHash: String(expandedContent.documentHash),
            outcome: 'accepted',
            blockingIssueCount: 0,
          },
        }),
      );
      expect(replay.status).toBe('admitted');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(stored);
      // A changed latest root must fail closed, never fall back to its valid historical root.
      const currentRootUri = String(object(expandedContent.root).uri);
      const originalRoot = yield* f.store.read(f.location, currentRootUri);
      yield* Effect.acquireUseRelease(
        f.store.write(f.location, currentRootUri, originalRoot + '\nUnexpected external edit.\n', {mode: 'replace'}),
        () =>
          Effect.gen(function* () {
            const changedRoot = yield* f.store.read(f.location, currentRootUri);
            const corruptedRead = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo}).pipe(
              Effect.result,
            );
            expect(corruptedRead._tag).toBe('Failure');
            expect(
              (yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo, detail: 'packet'}).pipe(
                Effect.result,
              ))._tag,
            ).toBe('Failure');
            expect(yield* f.fs.readFileString(f.statePath())).toBe(stored);
            expect(yield* f.store.read(f.location, currentRootUri)).toBe(changedRoot);
          }),
        () => f.store.write(f.location, currentRootUri, originalRoot, {mode: 'replace'}),
      );
    }).pipe(run),
  );

  effectIt.effect('returns a missing planning decision without saving compact intent', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      const before = yield* f.fs.readFileString(f.statePath());
      const result = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-start',
          runId: 'native-run',
          callerCwd: f.repo,
          intent: {
            title: 'Change fixture refresh behavior',
            currentBehavior: 'Expired fixture entries are returned as current.',
            desiredChange: 'Expired fixture entries are refreshed before return.',
            affectedPaths: ['source.ts'],
            acceptanceCriterion: 'Expired entries refresh before return.',
            verification: 'Exercise expiration and observe the refreshed value.',
            eligibilityRationale: 'An unresolved behavior choice remains.',
            eligibility: {
              status: 'needs-planning',
              missingDecision: 'Choose synchronous refresh or queued refresh.',
              evidenceRefs: ['threadnote://user/test/memories/durable/projects/fixture/cache.md'],
            },
            review: {required: false, reason: 'Not eligible until the decision is resolved.'},
          },
        }),
      );
      expect(result).toMatchObject({
        status: 'needs-planning',
        missingDecision: 'Choose synchronous refresh or queued refresh.',
        evidenceRefs: ['threadnote://user/test/memories/durable/projects/fixture/cache.md'],
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

  effectIt.effect('accepts the bound checkout when Git reports an alternate root spelling', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const fs = yield* FileSystem.FileSystem;
      const executor = yield* CommandExecutor;
      const canonicalRoot = yield* fs.realPath(f.repo);
      const separator = f.path.sep;
      const reportedRoot = canonicalRoot + separator + '.';
      let injectedAlternateRoot = false;
      const alternateRootExecutor = CommandExecutor.of({
        ...executor,
        execute: (executable, args, options) =>
          executor.execute(executable, args, options).pipe(
            Effect.map(result => {
              if (executable !== 'git' || args[0] !== 'rev-parse' || args[1] !== '--show-toplevel') return result;
              injectedAlternateRoot = true;
              return {...result, stdout: reportedRoot};
            }),
          ),
      });
      const work = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }).pipe(Effect.provideService(CommandExecutor, alternateRootExecutor)),
      );
      expect(injectedAlternateRoot).toBe(true);
      expect(work.status).toBe('ready');
      expect(work.phaseId).toBe('one');
    }).pipe(run),
  );

  effectIt.effect('canonicalizes the reported checkout root while refusing a different repository', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      const foreignRepo = yield* f.fs.makeTempDirectoryScoped({prefix: 'threadnote-task-foreign-checkout-'});
      yield* runCommandEffect('git', ['init', foreignRepo]);
      const before = yield* f.fs.readFileString(f.statePath());
      const refusal = yield* runNativeTaskAction(f.config, {
        command: 'work',
        runId: 'native-run',
        callerCwd: foreignRepo,
        packet,
      }).pipe(Effect.result);
      expect(refusal).toMatchObject({failure: {code: expect.stringMatching(/^(?:wrong-checkout|binding-drift)$/u)}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

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
