import {Array as EffectArray, Effect, FileSystem, Layer, Path, Schema, Stdio, Terminal, Tracer} from 'effect';
import * as EffectString from 'effect/String';
import {ChildProcessSpawner} from 'effect/process';
import {Command} from 'effect/cli';
import {it as effectIt} from '@effect/vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {
  ResourceStore,
  type ResourceStoreLocation,
  type ResourceStoreWriteOptions,
} from '@threadnote/store/resource-store';
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
import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {
  makeNativeTaskActionCommands,
  makeNativeTaskStartCommand,
  makeNativeTaskViewCommand,
} from '../../src/effect/workflow_cli.js';
import {runNativeTaskAction, runNativeTaskStart} from '../../src/workflow_automation/task_actions.js';
import {applyDevSkills} from '../../src/dev_skills/index.js';
import {SystemInfo} from '@threadnote/platform/system';
import {readNativeWorkflowState, serializeNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {runWorkflowAutomation} from '../../src/workflow_automation/index.js';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
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
  effectIt.effect.each([
    'prepared-data-before-write',
    'prepared-data',
    'prepared-view',
    'verified-data-prefix',
    'verified-last-child',
    'prepared-root',
    'verified-root',
  ])('recovers an exact semantic compact save at %s', cut =>
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
      const intent = {
        title: 'Recover one compact fixture change',
        currentBehavior: 'Expired fixture data is returned.',
        desiredChange: 'Expired fixture data is refreshed before return.',
        affectedPaths: ['source.ts'],
        acceptanceCriterion: 'The refreshed fixture value is returned.',
        verification: 'Read an expired fixture.',
        eligibilityRationale: 'One source-bound fixture behavior with no unresolved decisions.',
        eligibility: {status: 'eligible'},
        review: {required: false, reason: 'Bounded fixture correction.'},
      };
      const featureName = 'Recovery ' + cut;
      const runId = 'task-' + EffectString.slice(0, 48)(sha256HexSync('repo\nrecovery-' + cut));
      const base = {featureName, callerCwd: repo, installationTarget: 'codex', intent};
      const statePath = f.path.join(home, 'workflow-automations', 'native-v1', runId + '.json');
      const actualFs = yield* FileSystem.FileSystem;
      const actualPath = yield* Path.Path;
      const observe = () =>
        readNativeWorkflowState(config, runId).pipe(
          Effect.provideService(FileSystem.FileSystem, actualFs),
          Effect.provideService(Path.Path, actualPath),
          Effect.orDie,
        );
      let injected = false;
      const writes = new Map<string, number>();
      const stop = () =>
        Effect.sync(() => {
          injected = true;
        }).pipe(Effect.andThen(Effect.die(new Error('Synthetic compact cut: ' + cut))));
      const matchesPrepared = (state: Effect.Success<ReturnType<typeof readNativeWorkflowState>>) => {
        const last = state?.state.operations.at(-1);
        if (!state?.state.authoringSave || last?.status !== 'prepared') return false;
        if (cut === 'prepared-data' || cut === 'prepared-data-before-write') return last.intent.nameHint === 'source';
        if (cut === 'prepared-view') return last.intent.nameHint === 'plan-overview';
        return (
          cut === 'prepared-root' &&
          last.intent.role === 'authoring-root' &&
          last.intent.artifactKey === 'author-root-plan'
        );
      };
      const observedStore = ResourceStore.of({
        ...f.store,
        writeChecked: <E, R>(
          location: ResourceStoreLocation,
          uri: string,
          content: string,
          options: ResourceStoreWriteOptions,
          check: Effect.Effect<void, E, R>,
        ) =>
          Effect.gen(function* () {
            if (!injected && cut === 'prepared-data-before-write' && matchesPrepared(yield* observe()))
              return yield* stop();
            const result = yield* f.store.writeChecked(location, uri, content, options, check);
            writes.set(uri, (writes.get(uri) ?? 0) + 1);
            if (!injected && cut !== 'prepared-data-before-write' && matchesPrepared(yield* observe()))
              return yield* stop();
            return result;
          }),
      });
      const faultFs = {
        ...actualFs,
        rename: (from: string, to: string) =>
          actualFs.rename(from, to).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (injected || to !== statePath) return;
                const state = yield* observe();
                const last = state?.state.operations.at(-1);
                if (!state?.state.authoringSave || last?.status !== 'verified') return;
                const selected =
                  cut === 'verified-data-prefix'
                    ? last.intent.nameHint === 'source'
                    : cut === 'verified-last-child'
                      ? last.intent.nameHint === 'decisions'
                      : cut === 'verified-root' && last.intent.role === 'authoring-root';
                if (selected) return yield* stop();
              }),
            ),
          ),
      };
      const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(SystemInfo, scopedSystem),
          Effect.provideService(ResourceStore, observedStore),
          Effect.provideService(FileSystem.FileSystem, faultFs),
        );
      const interrupted = yield* scoped(runNativeTaskStart(config, base)).pipe(Effect.result);
      expect(interrupted, cut).toMatchObject({
        failure: {message: expect.stringContaining('Synthetic compact cut: ' + cut)},
      });
      expect(injected, cut).toBe(true);
      const pending = yield* observe();
      if (!pending?.state.authoringSave) throw new Error('Expected the original admitted save at ' + cut);
      const reservation = pending.state.authoringSave;
      expect(reservation.operationStart).toBe(0);
      expect(reservation.rootUri).toBeNull();
      const prefix = pending.state.operations;
      expect(prefix.length).toBeGreaterThan(0);
      expect(prefix.at(-1)?.status).toBe(EffectString.startsWith('verified-')(cut) ? 'verified' : 'prepared');
      const originalBytes = yield* f.fs.readFileString(statePath);
      const journalPath = f.journalPath(pending.state.bindingId);
      const originalJournal = yield* f.fs.readFileString(journalPath);
      const writesBefore = [...writes];
      const prefixReadbacks: {uri: string; bytes: string}[] = [];
      for (const operation of prefix)
        if (operation.status === 'verified' && operation.artifact)
          prefixReadbacks.push({
            uri: operation.artifact.uri,
            bytes: yield* f.store.read(f.location, operation.artifact.uri),
          });
      const unchanged = () =>
        Effect.gen(function* () {
          expect(yield* f.fs.readFileString(statePath), cut).toBe(originalBytes);
          expect(yield* f.fs.readFileString(journalPath), cut).toBe(originalJournal);
          expect([...writes], cut).toEqual(writesBefore);
        });
      const changed = yield* scoped(
        runNativeTaskStart(config, {
          ...base,
          taskRef: runId,
          intent: {...intent, desiredChange: 'Discard expired fixture data.'},
        }),
      ).pipe(Effect.result);
      expect(changed, cut).toMatchObject({failure: {code: 'pending-operation'}});
      yield* unchanged();
      yield* f.fs.writeFileString(f.path.join(repo, 'source.ts'), 'export const fixture = false;\n');
      const drifted = yield* scoped(runNativeTaskStart(config, {...base, taskRef: runId})).pipe(Effect.result);
      expect(drifted, cut).toMatchObject({failure: {code: 'evidence-unavailable'}});
      yield* unchanged();
      yield* f.fs.writeFileString(f.path.join(repo, 'source.ts'), 'export const fixture = true;\n');
      const foreignRepo = f.path.join(f.root, 'other', 'repo');
      yield* f.fs.makeDirectory(foreignRepo, {recursive: true});
      yield* runCommandEffect('git', ['init', '--initial-branch=main', foreignRepo]);
      const foreign = yield* scoped(runNativeTaskStart(config, {...base, taskRef: runId, callerCwd: foreignRepo})).pipe(
        Effect.result,
      );
      expect(foreign, cut).toMatchObject({failure: {code: 'binding-drift'}});
      yield* unchanged();
      const notEligible = yield* scoped(
        runNativeTaskStart(config, {
          ...base,
          taskRef: runId,
          intent: {
            ...intent,
            eligibility: {status: 'needs-planning', missingDecision: 'Choose another behavior.', evidenceRefs: []},
          },
        }),
      ).pipe(Effect.result);
      expect(notEligible).toMatchObject({failure: {code: 'task-intent-conflict'}});
      yield* unchanged();
      const firstRoot = EffectArray.some(
        prefix,
        item => item.status === 'verified' && item.intent.role === 'authoring-root',
      );
      if (!firstRoot) {
        const {authoringSave: _reservation, ...unrelated} = pending.state;
        yield* Effect.acquireUseRelease(
          f.fs.writeFileString(statePath, serializeNativeWorkflowState(unrelated)),
          () =>
            Effect.gen(function* () {
              const unreservedBytes = yield* f.fs.readFileString(statePath);
              const refused = yield* scoped(runNativeTaskStart(config, {...base, taskRef: runId})).pipe(Effect.result);
              expect(refused).toMatchObject({failure: {code: 'task-intent-missing'}});
              expect(yield* f.fs.readFileString(statePath)).toBe(unreservedBytes);
              expect(yield* f.fs.readFileString(journalPath)).toBe(originalJournal);
              expect([...writes]).toEqual(writesBefore);
            }),
          () => f.fs.writeFileString(statePath, originalBytes),
        );
      }
      if (prefix.length >= 2 && prefix[0].status === 'verified' && prefix[1].status === 'verified') {
        const malformed = {...pending.state, operations: [prefix[1], prefix[0], ...prefix.slice(2)]};
        yield* Effect.acquireUseRelease(
          f.fs.writeFileString(statePath, serializeNativeWorkflowState(malformed)),
          () =>
            Effect.gen(function* () {
              const badBytes = yield* f.fs.readFileString(statePath);
              const refused = yield* scoped(runNativeTaskStart(config, {...base, taskRef: runId})).pipe(Effect.result);
              expect(refused, cut).toMatchObject({failure: {code: 'pending-operation'}});
              expect(yield* f.fs.readFileString(statePath)).toBe(badBytes);
              expect(yield* f.fs.readFileString(journalPath)).toBe(originalJournal);
              expect([...writes]).toEqual(writesBefore);
            }),
          () => f.fs.writeFileString(statePath, originalBytes),
        );
      }
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, config);
      const recovered = object(yield* scoped(mcp.invokeTool('workflow_task_start', {...base, taskRef: runId})));
      expect(recovered.isError, cut).not.toBe(true);
      const complete = yield* observe();
      if (!complete) throw new Error('Expected recovered task state.');
      expect(complete.state.authoringSave, cut).toBeUndefined();
      expect(complete.state.runId).toBe(pending.state.runId);
      expect(complete.state.generation).toBe(pending.state.generation);
      expect(complete.state.bindingId).toBe(pending.state.bindingId);
      for (const key of ['project', 'featureId', 'title', 'profile', 'team', 'naming'] as const)
        expect(complete.state[key], cut + ' identity ' + key).toEqual(pending.state[key]);
      expect(new Set(EffectArray.map(complete.state.operations, item => item.intent.operationId)).size).toBe(
        complete.state.operations.length,
      );
      expect(EffectArray.every(complete.state.operations, item => item.status === 'verified')).toBe(true);
      expect(EffectArray.map(complete.state.operations, item => item.intent.nameHint)).toEqual([
        'source',
        'index',
        'plan-overview',
        'decisions',
        'plan',
      ]);
      for (const original of prefixReadbacks)
        expect(yield* f.store.read(f.location, original.uri)).toBe(original.bytes);
      expect(
        EffectArray.map(complete.state.operations.slice(0, prefix.length), item => ({
          intent: item.intent,
          digest: item.intentDigest,
        })),
      ).toEqual(EffectArray.map(prefix, item => ({intent: item.intent, digest: item.intentDigest})));
      for (const operation of complete.state.operations) {
        if (!operation.artifact) throw new Error('Expected verified artifact.');
        expect(writes.get(operation.artifact.uri), cut + ' ' + operation.intent.nameHint).toBe(1);
      }
      const view = object(yield* scoped(readNativeTaskView(config, {runId, callerCwd: repo, detail: 'packet'})));
      const authoring = object(view.authoring);
      expect(authoring).toMatchObject({readiness: 'draft', status: 'awaiting-user-confirmation'});
      expect(authoring.confirmation).toBeUndefined();
      const document = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(
        object(authoring.packet).document,
      );
      expect(document.current.summary).toBe(intent.currentBehavior);
      expect(document.target.summary).toBe(intent.desiredChange);
      expect(authoring.documentHash).toBe(nativeAuthoringDigest(document));
      const loaded = object(
        object(
          yield* scoped(
            runWorkflowAutomation(config, {
              protocolVersion: 1,
              executorVersion: 1,
              action: 'authoring',
              command: 'load',
              runId,
              generation: complete.state.generation,
              uri: object(authoring.root).uri,
              detail: 'document',
            }),
          ),
        ).authoring,
      );
      expect(loaded.document).toEqual(document);
      const finishedBytes = yield* f.fs.readFileString(statePath);
      const finishedWrites = [...writes];
      yield* f.fs.writeFileString(f.path.join(repo, 'source.ts'), 'export const fixture = false;\n');
      const replay = object(yield* scoped(runNativeTaskStart(config, {...base, taskRef: runId})));
      expect(replay.status).toBe('resumed');
      expect(yield* f.fs.readFileString(statePath)).toBe(finishedBytes);
      expect([...writes]).toEqual(finishedWrites);
      yield* f.fs.writeFileString(f.path.join(repo, 'source.ts'), 'export const fixture = true;\n');
      const confirmed = object(
        yield* scoped(
          runNativeTaskAction(config, {
            command: 'compact-confirm',
            runId,
            callerCwd: repo,
            presentedIntentHash: authoring.intentHash,
            userDecision: 'approve',
            userResponse: 'I approve this exact recovered fixture change.',
            baseBranch: 'main',
          }),
        ),
      );
      expect(confirmed, cut).toMatchObject({status: 'admitted', taskReadiness: 'ready'});
      expect((yield* observe())?.state.authoringSave).toBeUndefined();
    }).pipe(run),
  );

  effectIt.effect(
    'starts a semantic task from a verified local installed bundle and safely replays or refuses changed intent',
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
        const intent = {
          title: 'Refresh expired fixture data',
          currentBehavior: 'Expired fixture data is returned without a freshness check.',
          desiredChange: 'Expired fixture data is refreshed before it is returned.',
          affectedPaths: ['source.ts'],
          acceptanceCriterion: 'Expired fixture data is refreshed before return.',
          verification: 'Exercise expired fixture data and observe the refresh.',
          eligibilityRationale:
            'One behavior and one inspected file are explicit, with no unresolved product decision.',
          eligibility: {status: 'eligible' as const},
          review: {required: false, reason: 'Routine local fixture correction.'},
        };
        const base = {callerCwd: f.repo, featureName: 'Fixture refresh', installationTarget: 'codex', intent};
        const withoutTarget = {callerCwd: f.repo, featureName: 'Fixture refresh', intent};
        const missingResources = yield* runNativeTaskStart(f.config, withoutTarget).pipe(Effect.result);
        expect(missingResources).toMatchObject({failure: {code: 'needs-resources'}});
        const needsPlanning = yield* runNativeTaskStart(f.config, {
          ...base,
          intent: {
            ...intent,
            eligibility: {
              status: 'needs-planning' as const,
              missingDecision: 'Select refresh behavior.',
              evidenceRefs: [],
            },
          },
        });
        expect(needsPlanning).toMatchObject({status: 'needs-planning', missingDecision: 'Select refresh behavior.'});

        const system = yield* SystemInfo;
        const canonicalRepo = yield* f.fs.realPath(f.repo);
        const canonicalHome = yield* f.fs.realPath(f.home);
        const config = {
          ...f.config,
          agentContextHome: canonicalHome,
          manifestPath: f.path.join(canonicalHome, 'manifest.json'),
        };
        const testSystem = {...system, currentDirectory: () => canonicalRepo, homeDirectory: canonicalHome};
        const expectedRunId = 'task-' + EffectString.slice(0, 48)(sha256HexSync('repo\nfixture-refresh'));
        const installed = yield* applyDevSkills(config, 'install', {
          agent: 'codex',
        }).pipe(Effect.provideService(SystemInfo, testSystem));
        expect(installed.applied).toBe(true);
        const graphBlocked = yield* runNativeTaskStart(config, base).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(graphBlocked).toMatchObject({failure: {code: 'evidence-unavailable'}});
        expect(yield* readNativeWorkflowState(config, expectedRunId)).toBeUndefined();
        const indexer = yield* CodeGraphIndexer;
        expect((yield* indexer.index({cwd: canonicalRepo, threadnoteHome: canonicalHome})).snapshot.state).toBe(
          'ready',
        );
        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, config);
        const testFs = yield* FileSystem.FileSystem;
        const testPath = yield* Path.Path;
        let injectedPreparedRoot = false;
        let checkedWrites = 0;
        const interruptedStore = ResourceStore.of({
          ...f.store,
          writeChecked: <E, R>(
            location: ResourceStoreLocation,
            uri: string,
            content: string,
            options: ResourceStoreWriteOptions,
            check: Effect.Effect<void, E, R>,
          ) =>
            f.store.writeChecked(location, uri, content, options, check).pipe(
              Effect.tap(() => {
                checkedWrites++;
                if (injectedPreparedRoot) return Effect.void;
                return readNativeWorkflowState(config, expectedRunId).pipe(
                  Effect.provideService(FileSystem.FileSystem, testFs),
                  Effect.provideService(Path.Path, testPath),
                  Effect.orDie,
                  Effect.map(state => {
                    if (!state?.state.authoringSave) return false;
                    const firstPrepared = EffectArray.findFirst(
                      state.state.operations,
                      operation => operation.status === 'prepared',
                    );
                    const last = state.state.operations[state.state.operations.length - 1];
                    return (
                      firstPrepared._tag === 'Some' &&
                      firstPrepared.value === last &&
                      last?.intent.artifactKey === 'author-root-plan' &&
                      last.intent.role === 'authoring-root' &&
                      last.intent.sourceRunId === expectedRunId
                    );
                  }),
                  Effect.flatMap(isPreparedRoot => {
                    if (!isPreparedRoot) return Effect.void;
                    injectedPreparedRoot = true;
                    return Effect.die(new Error('Synthetic lost acknowledgement after prepared compact root'));
                  }),
                );
              }),
            ),
        });
        const interrupted = yield* runNativeTaskStart(config, base).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.provideService(ResourceStore, interruptedStore),
          Effect.result,
        );
        expect(interrupted._tag).toBe('Failure');
        expect(injectedPreparedRoot).toBe(true);
        const preparedState = yield* readNativeWorkflowState(config, expectedRunId);
        expect(preparedState?.state.authoringSave).toBeDefined();
        const pendingRoot = preparedState?.state.operations[preparedState.state.operations.length - 1];
        expect(pendingRoot).toMatchObject({
          status: 'prepared',
          intent: {artifactKey: 'author-root-plan', role: 'authoring-root', sourceRunId: expectedRunId},
        });
        const writesAtFailure = checkedWrites;
        const preparedStatePath = f.path.join(
          canonicalHome,
          'workflow-automations',
          'native-v1',
          expectedRunId + '.json',
        );
        const preparedBytes = yield* f.fs.readFileString(preparedStatePath);
        const changedPendingIntent = yield* runNativeTaskStart(config, {
          ...base,
          intent: {...intent, desiredChange: 'Delete expired fixture data.'},
        }).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.provideService(ResourceStore, interruptedStore),
          Effect.result,
        );
        expect(changedPendingIntent).toMatchObject({failure: {code: 'pending-operation'}});
        expect(yield* f.fs.readFileString(preparedStatePath)).toBe(preparedBytes);
        expect(checkedWrites).toBe(writesAtFailure);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = false;\n');
        const changedPendingSource = yield* runNativeTaskStart(config, base).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.provideService(ResourceStore, interruptedStore),
          Effect.result,
        );
        expect(changedPendingSource._tag).toBe('Failure');
        expect(yield* f.fs.readFileString(preparedStatePath)).toBe(preparedBytes);
        expect(checkedWrites).toBe(writesAtFailure);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = true;\n');
        const startResponse = object(
          yield* mcp
            .invokeTool('workflow_task_start', base)
            .pipe(
              Effect.provideService(SystemInfo, testSystem),
              Effect.provideService(ResourceStore, interruptedStore),
            ),
        );
        expect(checkedWrites).toBe(writesAtFailure);
        expect(startResponse.isError).not.toBe(true);
        const started = object(startResponse.structuredContent);
        expect(started.status).toBe('awaiting-user-confirmation');
        expect(typeof started.taskRef).toBe('string');
        const runId = String(started.taskRef);
        const statePath = f.path.join(canonicalHome, 'workflow-automations', 'native-v1', runId + '.json');
        const savedState = yield* f.fs.readFileString(statePath);
        const resumed = object(
          yield* runNativeTaskStart(config, base).pipe(
            Effect.provideService(SystemInfo, testSystem),
            Effect.provideService(ResourceStore, interruptedStore),
          ),
        );
        expect(resumed.status).toBe('resumed');
        expect(resumed.taskRef).toBe(runId);
        expect(yield* f.fs.readFileString(statePath)).toBe(savedState);

        let cliResult: Record<string, unknown> | undefined;
        const taskStart = makeNativeTaskStartCommand(options => {
          const {eligibility, missingDecision, evidenceRefs, reviewRequired, reviewReason, ...fields} = options;
          const cliIntent = {
            title: fields.title,
            currentBehavior: fields.currentBehavior,
            desiredChange: fields.desiredChange,
            affectedPaths: fields.affectedPaths,
            acceptanceCriterion: fields.acceptanceCriterion,
            verification: fields.verification,
            eligibilityRationale: fields.eligibilityRationale,
            eligibility:
              eligibility === 'eligible'
                ? {status: 'eligible' as const}
                : {status: 'needs-planning' as const, missingDecision: missingDecision ?? '', evidenceRefs},
            review: {required: reviewRequired, reason: reviewReason},
          };
          return runNativeTaskStart(config, {
            callerCwd: fields.callerCwd,
            featureName: fields.featureName,
            ...(fields.installationTarget === undefined ? {} : {installationTarget: fields.installationTarget}),
            ...(fields.taskRef === undefined ? {} : {taskRef: fields.taskRef}),
            intent: cliIntent,
          }).pipe(
            Effect.provideService(SystemInfo, testSystem),
            Effect.tap(value => Effect.sync(() => (cliResult = object(value)))),
            Effect.asVoid,
          );
        });
        const cli = Command.make('workflow-automation').pipe(Command.withSubcommands([taskStart]));
        const runCli = Command.runWith(cli, {version: 'fixture'});
        yield* runCli([
          'task-start',
          '--caller-cwd',
          f.repo,
          '--feature-name',
          'Fixture refresh',
          '--installation-target',
          'codex',
          '--title',
          intent.title,
          '--current-behavior',
          intent.currentBehavior,
          '--desired-change',
          intent.desiredChange,
          '--affected-path',
          'source.ts',
          '--acceptance',
          intent.acceptanceCriterion,
          '--verification',
          intent.verification,
          '--eligibility-rationale',
          intent.eligibilityRationale,
          '--eligibility',
          'eligible',
          '--review-reason',
          intent.review.reason,
        ]).pipe(Effect.provideService(SystemInfo, testSystem));
        expect(cliResult).toMatchObject({status: 'resumed', taskRef: runId});
        expect(yield* f.fs.readFileString(statePath)).toBe(savedState);

        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = false;\n');
        const replayAfterSourceDrift = object(
          yield* runNativeTaskStart(config, base).pipe(Effect.provideService(SystemInfo, testSystem)),
        );
        expect(replayAfterSourceDrift.status).toBe('resumed');
        expect(yield* f.fs.readFileString(statePath)).toBe(savedState);

        const foreignRepo = f.path.join(f.root, 'foreign');
        yield* f.fs.makeDirectory(foreignRepo);
        yield* f.fs.writeFileString(f.path.join(foreignRepo, 'source.ts'), 'export const fixture = true;\n');
        yield* runCommandEffect('git', ['init', '--initial-branch=main', foreignRepo]);
        yield* runCommandEffect('git', ['-C', foreignRepo, 'add', 'source.ts']);
        yield* runCommandEffect('git', [
          '-C',
          foreignRepo,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'Foreign source',
        ]);
        const foreignResume = yield* runNativeTaskStart(config, {
          ...base,
          callerCwd: foreignRepo,
          taskRef: runId,
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
        expect(foreignResume).toMatchObject({failure: {code: 'task-identity-conflict'}});
        expect(yield* f.fs.readFileString(statePath)).toBe(savedState);

        const changed = yield* runNativeTaskStart(config, {
          ...base,
          intent: {...intent, desiredChange: 'Delete expired fixture data.'},
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
        expect(changed).toMatchObject({failure: {code: 'task-intent-conflict'}});
        expect(yield* f.fs.readFileString(statePath)).toBe(savedState);
      }).pipe(run, provideTestLayer(cliTestLayer)),
  );

  effectIt.effect('recovers an unreviewed snapshot through the public task action and requires full review', () =>
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
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "first admitted files";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'First source candidate']);
      const firstResult = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      const firstSnapshot = object(object(firstResult.snapshot).snapshot);
      const firstSnapshotRef = String(firstResult.snapshotRef);

      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "corrected candidate two";\n',
      );
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Correct admitted source before review']);
      const recoveryRequest = {
        command: 'supersede-unreviewed-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: firstSnapshotRef,
        reason: 'Corrected admitted files before any review was accepted; request a full independent review.',
      };
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const recoveryResponse = object(
        yield* mcp.invokeTool('workflow_task_supersede_unreviewed_snapshot', {
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: firstSnapshotRef,
          reason: recoveryRequest.reason,
        }),
      );
      expect(recoveryResponse.isError).not.toBe(true);
      const recovered = object(recoveryResponse.structuredContent);
      expect(recovered).toMatchObject({status: 'recorded', replayed: false});
      const secondSnapshot = object(object(recovered.snapshot).snapshot);
      expect(secondSnapshot).toMatchObject({
        snapshotId: expect.stringMatching(/^superseded-/u),
        supersedes: firstSnapshot.snapshotId,
        unreviewedSupersession: {reason: recoveryRequest.reason},
        phaseHash: String(firstSnapshot.phaseHash),
        baseTree: firstSnapshot.baseTree,
      });
      expect(secondSnapshot.tree).not.toBe(firstSnapshot.tree);
      const afterRecovery = yield* f.fs.readFileString(f.statePath());
      const replay = object(yield* runNativeTaskAction(f.config, recoveryRequest));
      expect(replay).toMatchObject({status: 'recorded', replayed: true});
      expect(replay.snapshot).toEqual(recovered.snapshot);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);
      let cliReplay: Record<string, unknown> | undefined;
      const commands = makeNativeTaskActionCommands(
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
          runNativeTaskAction(f.config, {command: 'supersede-unreviewed-snapshot', ...options}).pipe(
            Effect.tap(value => Effect.sync(() => (cliReplay = object(value)))),
            Effect.asVoid,
          ),
      );
      const cli = Command.make('workflow-automation').pipe(Command.withSubcommands([commands]));
      const runCli = Command.runWith(cli, {version: 'fixture'});
      yield* runCli([
        'task-action',
        'supersede-unreviewed-snapshot',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--snapshot-ref',
        firstSnapshotRef,
        '--reason',
        recoveryRequest.reason,
      ]);
      expect(cliReplay).toMatchObject({status: 'recorded', replayed: true});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);
      const changedIntent = yield* runNativeTaskAction(f.config, {
        ...recoveryRequest,
        reason: 'Change the reason after recovery.',
      }).pipe(Effect.result);
      expect(changedIntent).toMatchObject({failure: {code: 'stale-snapshot-ref'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);

      const review = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(recovered.snapshotRef),
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
      expect(review.status).toBe('recorded');
      const runtime = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle;
      expect(runtime?.snapshots).toHaveLength(2);
      expect(runtime?.snapshots[0]?.snapshot).toEqual(firstSnapshot);
      expect(runtime?.snapshots[1]?.snapshot).toEqual(secondSnapshot);
      expect(EffectArray.map(runtime?.reviews ?? [], item => item.report.mode)).toEqual(['full']);
    }).pipe(run),
  );

  effectIt.effect('refuses task-action supersession of a reviewed snapshot without mutating state', () =>
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
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "reviewed candidate";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Reviewed candidate']);
      const recorded = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      yield* runNativeTaskAction(f.config, {
        command: 'record-review',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: String(recorded.snapshotRef),
        report: {
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        },
      });
      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "after accepted review";\n',
      );
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Change after accepted review']);
      const before = yield* f.fs.readFileString(f.statePath());
      const refused = yield* runNativeTaskAction(f.config, {
        command: 'supersede-unreviewed-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: String(recorded.snapshotRef),
        reason: 'The predecessor already has an accepted review.',
      }).pipe(Effect.result);
      expect(refused).toMatchObject({failure: {code: 'review-history'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

  effectIt.effect('recovers the current one-phase PR review card from its opaque snapshot reference', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['P1'], 'pr');
      yield* f.mutate('begin-phase', {phaseId: 'P1'});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "P1 first source";\n');
      const firstResult = yield* f.mutate('snapshot', {
        phaseId: 'P1',
        snapshotId: 'p1-unreviewed',
      });
      const firstSnapshot = object(object(firstResult.snapshot).snapshot);
      const stored = yield* readNativeWorkflowState(f.config, 'native-run');
      if (!stored?.state.cycle) throw new Error('Expected current cycle state.');
      const baseline = stored.state.cycle.baselines.P1;
      if (!baseline) throw new Error('Expected the P1 baseline.');
      const snapshotRef = encodeNativeTaskActionRef({
        version: 1,
        kind: 'snapshot',
        runId: 'native-run',
        generationHash: sha256HexSync(stored.state.generation),
        phaseId: 'P1',
        phaseHash: String(firstSnapshot.phaseHash),
        baselineHead: baseline.head,
        baselineTree: baseline.tree,
        baselineRef: baseline.pinnedRef,
        sourceHead: String(firstSnapshot.head),
        sourceTree: String(firstSnapshot.tree),
        snapshotId: String(firstSnapshot.snapshotId),
      });
      const currentCard = object(
        yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo, role: 'review'}),
      );
      expect(currentCard).toMatchObject({
        status: 'ready',
        next: {action: 'review', phaseId: 'P1', snapshotId: 'p1-unreviewed'},
      });

      const beforeForeign = yield* f.fs.readFileString(f.statePath());
      const staleRef = encodeNativeTaskActionRef({
        version: 1,
        kind: 'snapshot',
        runId: 'native-run',
        generationHash: sha256HexSync(stored.state.generation),
        phaseId: 'P1',
        phaseHash: String(firstSnapshot.phaseHash),
        baselineHead: baseline.head,
        baselineTree: baseline.tree,
        baselineRef: baseline.pinnedRef,
        sourceHead: String(firstSnapshot.head),
        sourceTree: '0000000000000000000000000000000000000000',
        snapshotId: String(firstSnapshot.snapshotId),
      });
      const foreign = yield* runNativeTaskAction(f.config, {
        command: 'supersede-unreviewed-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: staleRef,
        reason: 'Try to recover from a stale source reference.',
      }).pipe(Effect.result);
      expect(foreign).toMatchObject({failure: {code: 'stale-snapshot-ref'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeForeign);

      const changedSource = 'export const fixture = "P1 corrected source";\n';
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), changedSource);
      const reason = 'Corrected admitted P1 files before any review was accepted.';
      const recovered = object(
        yield* runNativeTaskAction(f.config, {
          command: 'supersede-unreviewed-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          reason,
        }),
      );
      expect(recovered).toMatchObject({status: 'recorded', replayed: false});
      const candidate = object(object(recovered.snapshot).snapshot);
      expect(candidate).toMatchObject({
        supersedes: firstSnapshot.snapshotId,
        unreviewedSupersession: {reason},
        phaseId: 'P1',
        phaseHash: String(firstSnapshot.phaseHash),
        baseTree: firstSnapshot.baseTree,
      });
      expect(candidate.tree).not.toBe(firstSnapshot.tree);
      const afterRecovery = yield* f.fs.readFileString(f.statePath());
      const replay = object(
        yield* runNativeTaskAction(f.config, {
          command: 'supersede-unreviewed-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          reason,
        }),
      );
      expect(replay).toMatchObject({status: 'recorded', replayed: true});
      expect(replay.snapshot).toEqual(recovered.snapshot);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);
      const changedIntent = yield* runNativeTaskAction(f.config, {
        command: 'supersede-unreviewed-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef,
        reason: 'Changed the business reason after recovery.',
      }).pipe(Effect.result);
      expect(changedIntent).toMatchObject({failure: {code: 'stale-snapshot-ref'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "P1 drifted again";\n');
      const changedSourceReplay = yield* runNativeTaskAction(f.config, {
        command: 'supersede-unreviewed-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef,
        reason,
      }).pipe(Effect.result);
      expect(changedSourceReplay).toMatchObject({failure: {code: 'source-drift'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), changedSource);

      const report = {
        snapshotId: candidate.snapshotId,
        phaseHash: candidate.phaseHash,
        snapshotTree: candidate.tree,
        status: 'complete',
        selected: ['correctness', 'simplicity'],
        lanes: [
          {name: 'correctness', status: 'complete'},
          {name: 'simplicity', status: 'complete'},
        ],
        findings: [],
      };
      const incremental = yield* f.mutate('validate-review', {
        snapshotId: candidate.snapshotId,
        attemptId: 'p1-incremental-refused',
        report: {...report, mode: 'incremental'},
      });
      expect(incremental).toMatchObject({status: 'error', code: 'invalid-cycle-review'});
      const full = yield* f.mutate('validate-review', {
        snapshotId: candidate.snapshotId,
        attemptId: 'p1-full-review',
        report: {...report, mode: 'full'},
      });
      expect(full).toMatchObject({status: 'ok'});
      const runtime = decodeNativeCycleRuntime(object(JSON.parse(yield* f.fs.readFileString(f.statePath()))).cycle);
      expect(EffectArray.map(runtime.snapshots, entry => entry.snapshot.snapshotId)).toEqual([
        firstSnapshot.snapshotId,
        candidate.snapshotId,
      ]);
      expect(EffectArray.map(runtime.reviews, entry => entry.snapshotId)).toEqual([candidate.snapshotId]);
      expect(EffectArray.map(runtime.attempts, entry => entry.id)).toEqual([
        'p1-incremental-refused',
        'p1-full-review',
      ]);
      expect(EffectArray.map(runtime.attempts, entry => entry.status)).toEqual(['invalid', 'accepted']);
    }).pipe(run),
  );

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
        current: {
          ...initialPlan.current,
          summary: 'Expired fixture data is returned without a freshness check.',
          components: ['source.ts exports the fixture value consumed by the reload check.'],
        },
        target: {
          ...initialPlan.target,
          summary: 'Expired fixture data is refreshed and then verified before return.',
          components: [
            'source.ts refreshes the fixture value and exposes the persisted result for reload verification.',
          ],
        },
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
