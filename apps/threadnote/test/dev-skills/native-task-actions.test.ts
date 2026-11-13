import {
  Array as EffectArray,
  Effect,
  FileSystem,
  Layer,
  Path,
  Record as EffectRecord,
  Schema,
  Stdio,
  Terminal,
  Tracer,
} from 'effect';
import * as Clock from 'effect/Clock';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {ChildProcessSpawner} from 'effect/process';
import {Command} from 'effect/cli';
import {SecureRandom} from 'effect/crypto';
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
  nativeTaskStartRunId,
  nativeTaskSnapshotId,
} from '@threadnote/workflow-automations/task';
import {workflowTitleSlug} from '@threadnote/workflow-automations/naming';
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
  makeNativeTaskPrWatchCommand,
  makeNativeTaskStartCommand,
  makeNativeTaskViewCommand,
} from '../../src/effect/workflow_cli.js';
import {runNativeTaskAction, runNativeTaskStart} from '../../src/workflow_automation/task_actions.js';
import {runNativeTaskAuthoring} from '../../src/workflow_automation/task_authoring.js';
import {readNativeTaskInstalledTarget} from '../../src/workflow_automation/task_admission.js';
import {readNativeWatch, writeNativeWatch} from '../../src/workflow_automation/watch_store.js';
import {applyDevSkills, statusDevSkills} from '../../src/dev_skills/index.js';
import {DevSkillsSource, loadDevSkillsBundleAt} from '../../src/dev_skills/manifest.js';
import {enrollmentContext} from '../../src/dev_skills/registry.js';
import {SystemInfo} from '@threadnote/platform/system';
import {
  nativeCloseoutJournalPath,
  readNativeWorkflowState,
  serializeNativeWorkflowState,
} from '../../src/workflow_automation/store.js';
import {runWorkflowAutomation} from '../../src/workflow_automation/index.js';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {CurrentNativeJobAutoLaunch, runNativeJobWorker} from '../../src/workflow_automation/native_jobs.js';
import {readNativeCloseoutJournal, writeNativeCloseoutJournal} from '../../src/workflow_automation/closeout_store.js';
import {decodeJournal} from '../../src/workflow_automation/closeout_request_schema.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';
import {
  completeLocalPhase,
  fixture,
  object,
  run,
  windowsCycleFixtureTimeout,
} from './native-cycle-lifecycle-fixture.js';
import {nativeFixture} from './native-automation-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const windowsRealGitFixtureTimeout = windowsCycleFixtureTimeout ?? {timeout: 60_000};

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

const attemptSimulatedTaskWatch = (
  f: Effect.Success<ReturnType<typeof fixture>>,
  runId: string,
  phaseId: string,
  validationRef: string,
  deliveryRef: string,
  prUrl: string,
) =>
  Effect.gen(function* () {
    const identity = EffectString.slice(0, 48)(sha256HexSync(`${runId}\n${phaseId}`));
    const watchId = `pr-${identity}`;
    const consumerId = `task-${identity}`;
    const wakeupId = consumerId;
    const wakeup = {
      host: 'codex' as const,
      executable: '/usr/bin/codex',
      threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    };
    const commands = yield* CommandExecutor;
    const system = yield* SystemInfo;
    const processAdapterContext = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
    >();
    let collectorSpawns = 0;
    let hostPreflights = 0;
    let collectorAlive = true;
    let remoteBaseBranch = 'main';
    const fakeCommands = CommandExecutor.of({
      ...commands,
      execute: (executable, args, options) => {
        if (executable === wakeup.executable && args.length === 2 && args[0] === 'queue' && args[1] === '--help') {
          hostPreflights += 1;
          return Effect.succeed({
            exitCode: 0,
            stderr: '',
            stdout:
              'Usage: codex queue [OPTIONS]\n\nOptions:\n      --thread <THREAD>\n          Thread UUID\n      --message <MESSAGE>\n          Message body\n',
          });
        }
        if (executable === 'gh' && args.includes('--jq')) {
          const url = new URL(prUrl);
          const [, owner, repo, , number] = EffectString.split(url.pathname, '/');
          return Effect.succeed({
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              number: Number(number),
              url: prUrl,
              baseRepository: `${owner}/${repo}`,
              headRepository: `fixture-fork/${repo}`,
              baseBranch: remoteBaseBranch,
              headBranch: `feature/${phaseId}`,
            }),
          });
        }
        return commands.execute(executable, args, options);
      },
      spawnDetached: () =>
        Effect.gen(function* () {
          collectorSpawns += 1;
          collectorAlive = true;
          const starting = yield* readNativeWatch(f.config, watchId);
          if (!starting?.envelope.collector) return false;
          yield* writeNativeWatch(
            f.config,
            {
              ...starting.envelope,
              collector: {
                ...starting.envelope.collector,
                pid: 77777,
                startIdentity: 'fixture-process',
                status: 'running',
              },
            },
            starting.revision,
          );
          return true;
        }).pipe(
          Effect.provide(processAdapterContext),
          Effect.orElseSucceed(() => false),
        ),
    });
    const fakeSystem = SystemInfo.of({
      ...system,
      isProcessRunning: pid => pid === 77777 && collectorAlive,
      processStartIdentity: () => Effect.succeed(EffectOption.getOrUndefined(EffectOption.none<string>())),
      canonicalProcessStartIdentity: () => Effect.succeed(EffectOption.getOrUndefined(EffectOption.none<string>())),
    });
    const result = yield* runNativeTaskAction(f.config, {
      command: 'watch-pr',
      operation: 'start',
      runId,
      callerCwd: f.repo,
      validationRef,
      deliveryRef,
      wakeup,
    }).pipe(
      Effect.match({
        onFailure: failure => ({ok: false as const, failure}),
        onSuccess: value => ({ok: true as const, value}),
      }),
      Effect.provideService(CommandExecutor, fakeCommands),
      Effect.provideService(SystemInfo, fakeSystem),
    );
    const startedWatch = yield* readNativeWatch(f.config, watchId);
    return {
      watchId,
      consumerId,
      wakeupId,
      wakeup,
      prUrl,
      result,
      startedWatch,
      collectorSpawns,
      commands: fakeCommands,
      system: fakeSystem,
      spawnCount: () => collectorSpawns,
      hostPreflightCount: () => hostPreflights,
      setCollectorAlive: (alive: boolean) => {
        collectorAlive = alive;
      },
      setRemoteBase: (branch: string) => {
        remoteBaseBranch = branch;
      },
    };
  });

const startSimulatedTaskWatch = (
  f: Effect.Success<ReturnType<typeof fixture>>,
  runId: string,
  phaseId: string,
  validationRef: string,
  deliveryRef: string,
  prUrl: string,
) =>
  Effect.gen(function* () {
    const attempt = yield* attemptSimulatedTaskWatch(f, runId, phaseId, validationRef, deliveryRef, prUrl);
    if (!attempt.result.ok) return yield* Effect.fail(attempt.result.failure);
    const started = object(attempt.result.value);
    const startedWatch = attempt.startedWatch;
    if (!startedWatch) throw new Error('Expected the simulated task watch to persist.');
    expect(started).toMatchObject({
      status: 'watching',
      watchId: attempt.watchId,
      prUrl,
      consumerId: attempt.consumerId,
    });
    return {...attempt, startedWatch};
  });

const recoverHistoricalTaskWatch = (f: Effect.Success<ReturnType<typeof fixture>>, runId: string) =>
  Effect.gen(function* () {
    const callerCwd = f.repo;
    const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
    registerWorkflowTaskTool(mcp, f.config);
    const discoveryResponse = yield* mcp.invokeTool('workflow_task_view', {runId, callerCwd});
    const discovery = object(discoveryResponse.structuredContent);
    if (object(discovery.next).phaseId !== 'two')
      throw new Error('The resumed current task view no longer identifies P2 as the active phase.');
    const summaries = EffectArray.isArray(discovery.historicalWatches) ? discovery.historicalWatches : [];
    if (summaries.length !== 1)
      throw new Error('A fresh task view did not discover exactly one active historical PR phase.');
    const summary = object(summaries[0]);
    if (typeof summary.phaseId !== 'string') throw new Error('The history summary lacks its canonical phase ID.');
    const selectedResponse = yield* mcp.invokeTool('workflow_task_view', {runId, callerCwd, phaseId: summary.phaseId});
    const selected = object(selectedResponse.structuredContent);
    const route = object(selected.historicalWatch);
    if (object(selected.next).phaseId !== 'two' || route.action !== 'watch-pr')
      throw new Error('The typed historical phase view did not preserve P2 or return canonical P1 watch references.');
    if (
      typeof route.phaseId !== 'string' ||
      typeof route.prUrl !== 'string' ||
      typeof route.consumerId !== 'string' ||
      typeof route.validationRef !== 'string' ||
      typeof route.deliveryRef !== 'string'
    )
      throw new Error('The typed historical phase view lacks exact canonical watch references.');
    const inspect = object(
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'inspect',
        runId,
        callerCwd,
        validationRef: route.validationRef,
        deliveryRef: route.deliveryRef,
      }),
    );
    if (typeof inspect.watchId !== 'string' || typeof inspect.noticeRef !== 'string')
      throw new Error('The exact task watch inspection did not return its current event notice route.');
    return {
      phaseId: route.phaseId,
      prUrl: route.prUrl,
      consumerId: route.consumerId,
      validationRef: route.validationRef,
      deliveryRef: route.deliveryRef,
      watchId: inspect.watchId,
      noticeRef: inspect.noticeRef,
    };
  });

const writeSimulatedTaskWatch = (
  f: Effect.Success<ReturnType<typeof fixture>>,
  startedWatch: NonNullable<Effect.Success<ReturnType<typeof readNativeWatch>>>,
  identity: {
    watchId: string;
    consumerId: string;
    wakeupId: string;
    wakeup: NonNullable<typeof startedWatch.envelope.notification>['target'];
  },
  prUrl: string,
  headSha: string,
  terminal: boolean,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const idHash = sha256HexSync(`${identity.watchId}\n${terminal ? 'terminal' : 'active'}`);
    const receiptId = `${EffectString.slice(0, 8)(idHash)}-${EffectString.slice(8, 12)(idHash)}-4${EffectString.slice(13, 16)(idHash)}-8${EffectString.slice(17, 20)(idHash)}-${EffectString.slice(20, 32)(idHash)}`;
    const attemptHash = sha256HexSync(`${identity.watchId}\n${terminal ? 'attempt-terminal' : 'attempt-active'}`);
    const attemptId = `${EffectString.slice(0, 8)(attemptHash)}-${EffectString.slice(8, 12)(attemptHash)}-4${EffectString.slice(13, 16)(attemptHash)}-8${EffectString.slice(17, 20)(attemptHash)}-${EffectString.slice(20, 32)(attemptHash)}`;
    const event = {
      sequence: 1,
      id: identity.watchId + ':1',
      source: 'comments' as const,
      kind: 'comment' as const,
      key: 'comment-' + identity.watchId,
      version: EffectString.repeat(64)('e'),
      url: prUrl,
      at: now,
      removed: false as const,
    };
    const sources = EffectArray.map(['comments', 'reviews', 'threads', 'checks', 'statuses'] as const, source => ({
      source,
      items: [],
      lastCompleteAt: now,
    }));
    const collector = startedWatch.envelope.collector;
    const notification = startedWatch.envelope.notification;
    if (!collector || !notification)
      throw new Error('Expected a collector and host notification after task watch start.');
    const envelope = {
      ...startedWatch.envelope,
      state: {
        ...startedWatch.envelope.state,
        head: headSha,
        prState: terminal ? ('merged' as const) : ('open' as const),
        nextSequence: 2,
        events: [event],
        sources,
      },
      collector: {
        ...collector,
        status: terminal ? ('terminal' as const) : ('running' as const),
        ...(terminal ? {reason: 'merged' as const} : {}),
        consecutiveErrors: 0,
      },
      notification: {
        ...notification,
        consumerId: identity.consumerId,
        wakeupId: identity.wakeupId,
        target: identity.wakeup,
        notifiedThrough: 0,
        lastConsumerAt: now,
        outbox: {
          key: identity.watchId + ':1:1',
          first: 1,
          last: 1,
          createdAt: now,
          attempts: 1,
          nextAttemptAt: now,
          attemptId,
          collectorToken: collector.token,
          status: 'queued' as const,
          receipt: receiptId,
          consumedThrough: 0,
        },
      },
    };
    yield* writeNativeWatch(f.config, envelope, startedWatch.revision);
    return {event, attemptId, receiptId};
  });

const publishOpenHistoricalPhase = (
  f: Effect.Success<ReturnType<typeof fixture>>,
  phaseId: string,
  baseBranch: string,
  prNumber: number,
  beginPhase = true,
) =>
  Effect.gen(function* () {
    if (beginPhase) yield* f.mutate('begin-phase', {phaseId});
    const work = object(
      yield* runNativeTaskAction(f.config, {
        command: 'work',
        runId: 'native-run',
        callerCwd: f.repo,
        packet,
      }),
    );
    yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), `export const fixture = "${phaseId}";\n`);
    yield* f.git(['add', 'source.ts']);
    yield* f.git(['commit', '-m', `Phase ${phaseId}`]);
    const snapshot = object(
      yield* runNativeTaskAction(f.config, {
        command: 'record-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        workRef: String(work.workRef),
      }),
    );
    const snapshotRef = String(snapshot.snapshotRef);
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
          checks: [
            {command: `phase ${phaseId} check`, result: 'passed', evidence: 'Private pagination fixture passed.'},
          ],
          acceptance: [
            {criterion: `${phaseId} works`, result: 'passed', evidence: 'Its committed source is recorded.'},
          ],
        },
      }),
    );
    const headSha = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
    const prUrl = `https://github.com/example/repo/pull/${prNumber}`;
    const delivery = object(
      yield* runNativeTaskAction(f.config, {
        command: 'deliver-pr',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: String(validation.validationRef),
        commitEvidence: `Private pagination fixture commit ${headSha}`,
        pr: {url: prUrl, headSha, branch: `feature/${phaseId}`, baseBranch, state: 'open' as const},
        publication: {exemption: 'small-fix', reason: `Private ${phaseId} pagination fixture authority.`},
      }),
    );
    const watch = yield* startSimulatedTaskWatch(
      f,
      'native-run',
      phaseId,
      String(validation.validationRef),
      String(delivery.deliveryRef),
      prUrl,
    );
    yield* writeSimulatedTaskWatch(f, watch.startedWatch, watch, prUrl, headSha, false);
    yield* runNativeTaskAction(f.config, {
      command: 'watch-pr',
      operation: 'complete',
      runId: 'native-run',
      callerCwd: f.repo,
      validationRef: String(validation.validationRef),
      deliveryRef: String(delivery.deliveryRef),
    });
    return watch;
  });

describe('native task actions', () => {
  effectIt.effect('lists recorded installation targets and inspection codes on admission failure', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      const config = {...f.config, agentContextHome: home};
      const system = yield* SystemInfo;
      const scoped = {...system, currentDirectory: () => repo, homeDirectory: home};
      yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(Effect.provideService(SystemInfo, scoped));
      const missing = yield* readNativeTaskInstalledTarget(config, undefined, repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.result,
      );
      expect(missing).toMatchObject({
        failure: {code: 'needs-resources', message: expect.stringContaining('installationTarget')},
      });
      if (missing._tag !== 'Failure') throw new Error('Expected missing target to fail');
      expect(missing.failure.message).toContain('--installation-target');
      expect(missing.failure.message).toContain('codex');
      expect(missing.failure.message).toContain('current');
      expect(missing.failure.message).not.toContain(f.root);
      const unknown = yield* readNativeTaskInstalledTarget(config, 'missing-target', repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.result,
      );
      expect(unknown).toMatchObject({
        failure: {code: 'needs-resources', message: expect.stringContaining('Inspection code:')},
      });
      if (unknown._tag !== 'Failure') throw new Error('Expected unknown target to fail');
      expect(unknown.failure.message).toContain('codex');
      expect(unknown.failure.message).not.toContain(f.root);
      const sourceRoot = f.path.join(f.root, 'updated-skill-source');
      const sourceBundle = yield* loadDevSkillsBundleAt(
        Bun.fileURLToPath(new URL('../../../../', import.meta.url)),
        '5.3.0-beta.7',
        false,
      );
      for (const [key, encoded] of EffectRecord.toEntries(sourceBundle.files)) {
        const destination = f.path.join(sourceRoot, 'config', 'agent-skills', key);
        yield* f.fs.makeDirectory(f.path.dirname(destination), {recursive: true});
        const content = Buffer.from(encoded, 'base64');
        yield* f.fs.writeFile(
          destination,
          key === 'dev-spec/SKILL.md' ? Buffer.concat([content, Buffer.from('\nUpdated generation.\n')]) : content,
        );
      }
      const inventory = {
        schemaVersion: sourceBundle.manifest.schemaVersion,
        nativeRequirements: sourceBundle.manifest.nativeRequirements,
        workflowProtocol: sourceBundle.manifest.workflowProtocol,
        stateSchema: sourceBundle.manifest.stateSchema,
        minimumRuntime: sourceBundle.manifest.minimumRuntime,
        skills: sourceBundle.manifest.skills,
      };
      yield* f.fs.writeFileString(f.path.join(sourceRoot, 'config', 'dev-skills.json'), JSON.stringify(inventory));
      const updatedSource = {root: sourceRoot, runtimeVersion: sourceBundle.manifest.releaseVersion};
      const stale = yield* readNativeTaskInstalledTarget(config, 'codex', repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
        Effect.result,
      );
      expect(stale).toMatchObject({failure: {code: 'needs-resources'}});
      if (stale._tag === 'Failure') {
        expect(stale.failure.message).toContain('dev-skills update --agent codex-cli --scope user --profile desktop');
        expect(stale.failure.message).not.toContain(f.root);
      }
      yield* applyDevSkills(config, 'update', {agent: 'codex'}).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
      );
      expect(
        yield* readNativeTaskInstalledTarget(config, 'codex', repo).pipe(
          Effect.provideService(SystemInfo, scoped),
          Effect.provideService(DevSkillsSource, updatedSource),
        ),
      ).toMatchObject({installationState: 'current'});
      yield* applyDevSkills(config, 'install', {agent: 'devin-local', scope: 'project', cwd: repo}).pipe(
        Effect.provideService(SystemInfo, scoped),
      );
      const projectStale = yield* readNativeTaskInstalledTarget(config, 'devin-local', repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
        Effect.result,
      );
      expect(projectStale).toMatchObject({failure: {code: 'needs-resources'}});
      if (projectStale._tag === 'Failure') {
        expect(projectStale.failure.message).toContain(
          'dev-skills update --agent devin-local --scope project --profile desktop --cwd .',
        );
        expect(projectStale.failure.message).toContain('from the target checkout');
        expect(projectStale.failure.message).not.toContain(f.root);
      }
      yield* applyDevSkills(config, 'update', {agent: 'devin-local', scope: 'project', cwd: repo}).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
      );
      yield* applyDevSkills(config, 'install', {agent: 'devin-local', scope: 'user'}).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
      );
      const context = yield* enrollmentContext(config);
      let projectId: string | undefined;
      for (const [id, entry] of EffectRecord.toEntries(context.homeIndex.targets))
        if (entry.target.surfaceId === 'devin-local' && entry.target.scope === 'project') projectId = id;
      expect(projectId).toMatch(/^[a-f0-9]{64}$/u);
      if (!projectId) throw new Error('Expected recorded project consumer ID.');
      const explicitProject = yield* readNativeTaskInstalledTarget(config, projectId, repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
      );
      expect(explicitProject).toMatchObject({
        consumerId: projectId,
        target: {scope: 'project'},
        installationState: 'current',
      });
      const wrongCheckout = yield* readNativeTaskInstalledTarget(config, projectId, home).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
        Effect.result,
      );
      expect(wrongCheckout).toMatchObject({failure: {code: 'needs-resources'}});
      if (wrongCheckout._tag === 'Failure') expect(wrongCheckout.failure.message).toContain('target-checkout-mismatch');
      const bareUser = yield* readNativeTaskInstalledTarget(config, 'devin-local', repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
      );
      expect(bareUser).toMatchObject({target: {scope: 'user'}, installationState: 'current'});
      const unknownId = EffectString.repeat(64)('a');
      const invalidStart = yield* runNativeTaskStart(config, {
        callerCwd: repo,
        featureName: 'Unknown installed target',
        installationTarget: unknownId,
        intent: {
          title: 'Unknown installed target',
          currentBehavior: 'Target admission fails.',
          desiredChange: 'Admit a recorded target.',
          affectedPaths: ['source.ts'],
          acceptanceCriterion: 'The recorded target is admitted.',
          verification: 'Inspect target admission.',
          eligibilityRationale: 'The failure is isolated.',
          eligibility: {status: 'eligible'},
          review: {required: false, reason: 'Focused fixture.'},
        },
      }).pipe(Effect.provideService(SystemInfo, scoped), Effect.result);
      expect(invalidStart).toMatchObject({failure: {code: 'needs-resources'}});
      expect(yield* f.fs.exists(f.path.join(home, 'workflow-automations'))).toBe(false);
    }).pipe(run),
  );

  effectIt.effect('starts in a selected graph project and rejects ambiguous unselected scope', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      const config = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
      const system = yield* SystemInfo;
      const testSystem = {...system, currentDirectory: () => repo, homeDirectory: home};
      yield* f.fs.makeDirectory(f.path.join(repo, 'apps', 'alpha'), {recursive: true});
      yield* f.fs.makeDirectory(f.path.join(repo, 'apps', 'beta'), {recursive: true});
      yield* f.fs.writeFileString(
        f.path.join(repo, 'package.json'),
        JSON.stringify({private: true, workspaces: ['apps/*']}),
      );
      yield* f.fs.writeFileString(
        f.path.join(repo, 'apps', 'alpha', 'package.json'),
        JSON.stringify({name: '@fixture/alpha'}),
      );
      yield* f.fs.writeFileString(
        f.path.join(repo, 'apps', 'beta', 'package.json'),
        JSON.stringify({name: '@fixture/beta'}),
      );
      yield* f.fs.writeFileString(f.path.join(repo, 'apps', 'alpha', 'source.ts'), 'export const selected = true;\n');
      yield* f.fs.writeFileString(f.path.join(repo, 'apps', 'beta', 'source.ts'), 'export const other = true;\n');
      yield* runCommandEffect('git', ['-C', repo, 'add', '.']);
      yield* runCommandEffect('git', [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'Graph projects',
      ]);
      const projects = EffectArray.map(['Alpha', 'Beta'], name => ({
        name,
        path: repo,
        seed: [],
        uri: `threadnote://resources/repos/${EffectString.toLowerCase(name)}`,
        graph: {closure: 'dependencies' as const, roots: [`apps/${EffectString.toLowerCase(name)}`]},
      }));
      yield* f.fs.writeFileString(config.manifestPath, JSON.stringify({version: 1, projects}));
      yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(Effect.provideService(SystemInfo, testSystem));
      const intent = {
        title: 'Selected graph task',
        currentBehavior: 'Selected source is not checked.',
        desiredChange: 'Selected source is checked.',
        affectedPaths: ['apps/alpha/source.ts'],
        acceptanceCriterion: 'Selected source is checked.',
        verification: 'Inspect selected source.',
        eligibilityRationale: 'One local source and behavior are explicit.',
        eligibility: {status: 'eligible' as const},
        review: {required: false, reason: 'Focused fixture.'},
      };
      const request = {callerCwd: repo, featureName: 'Selected graph task', installationTarget: 'codex', intent};
      const unselected = yield* runNativeTaskStart(config, request).pipe(
        Effect.provideService(SystemInfo, testSystem),
        Effect.result,
      );
      expect(unselected).toMatchObject({failure: {code: 'graph-scope-required'}});
      const index = yield* (yield* CodeGraphIndexer).index({cwd: repo, threadnoteHome: home, project: projects[0]});
      expect(index.snapshot.state).toBe('ready');
      const started = object(
        yield* runNativeTaskStart(config, {...request, graphProject: ' alpha '}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        ),
      );
      if (typeof started.taskRef !== 'string') throw new Error('Expected task reference after start');
      const state = yield* readNativeWorkflowState(config, started.taskRef);
      expect(state?.state.graphProject).toBe('Alpha');
      const selectedBytes = yield* f.fs.readFileString(f.statePath(started.taskRef));
      expect(
        yield* runNativeTaskStart(config, {...request, graphProject: 'Beta'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        ),
      ).toMatchObject({failure: {code: 'graph-scope-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath(started.taskRef))).toBe(selectedBytes);
      const legacyName = 'Legacy graph task';
      const legacyRunId = nativeTaskStartRunId(undefined, workflowTitleSlug('repo'), workflowTitleSlug(legacyName));
      const installed = yield* statusDevSkills(config, {agent: 'codex'}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      yield* runWorkflowAutomation(config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'init',
        runId: legacyRunId,
        project: 'repo',
        featureId: workflowTitleSlug(legacyName),
        generation: installed.bundle.digest,
        profile: 'desktop',
        title: intent.title,
      }).pipe(Effect.provideService(SystemInfo, testSystem));
      const legacyBytes = yield* f.fs.readFileString(f.statePath(legacyRunId));
      expect(
        yield* runNativeTaskStart(config, {...request, featureName: legacyName, graphProject: 'Alpha'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        ),
      ).toMatchObject({failure: {code: 'graph-scope-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath(legacyRunId))).toBe(legacyBytes);
    }).pipe(run),
  );

  effectIt.effect(
    'reports a read-back drained outcome for a canonical prior binding without rewriting its history',
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
          'Committed cutover fixture source',
        ]);
        const system = yield* SystemInfo;
        const repo = yield* f.fs.realPath(f.repo);
        const home = yield* f.fs.realPath(f.home);
        const config = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
        const testSystem = {...system, currentDirectory: () => repo, homeDirectory: home};
        const installed = yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(installed.applied).toBe(true);
        const currentStatus = yield* statusDevSkills(config, {agent: 'codex'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const current = currentStatus.targets[0];
        if (!current?.installedDigest) throw new Error('Expected a verified current private bundle.');
        expect(current.installedDigest).toBe(currentStatus.bundle.digest);
        const priorDigest = EffectString.repeat(64)('a');
        expect(priorDigest).not.toBe(currentStatus.bundle.digest);
        const runId = 'task-cutover-prior-binding';
        const intent = {
          title: 'Controlled cutover task',
          currentBehavior: 'The old binding remains inspectable.',
          desiredChange: 'The old binding receives an explicit transition outcome.',
          affectedPaths: ['source.ts'],
          acceptanceCriterion: 'The old generation and canonical history remain unchanged.',
          verification: 'Read the transition outcome and canonical run bytes.',
          eligibilityRationale: 'One fixture task validates a bounded safe cutover.',
          eligibility: {status: 'eligible' as const},
          review: {required: false, reason: 'Cutover metadata fixture.'},
        };
        const initialized = object(
          yield* f.call({
            protocolVersion: 1,
            executorVersion: 1,
            action: 'init',
            runId,
            project: 'repo',
            featureId: 'controlled-cutover',
            generation: priorDigest,
            profile: 'desktop',
            title: intent.title,
          }),
        );
        const historicalWrite = object(
          yield* f.call({
            ...f.write({
              operationId: 'pre-cutover-history',
              artifactKey: 'pre-cutover-history',
              body: 'Canonical synthetic prior-binding evidence.\n',
            }),
            runId,
            generation: priorDigest,
          }),
        );
        expect(historicalWrite).toMatchObject({status: 'ok', runId, operationId: 'pre-cutover-history'});
        const bindingId = String(initialized.bindingId);
        const statePath = f.statePath(runId);
        const journalPath = f.journalPath(bindingId);
        const beforeBytes = yield* f.fs.readFileString(statePath);
        const beforeJournal = yield* f.fs.readFileString(journalPath);
        const before = yield* readNativeWorkflowState(config, runId);
        if (!before) throw new Error('Expected canonical prior binding.');
        expect(before.state.generation).toBe(priorDigest);
        expect(before.state.bindingId).toBe(bindingId);
        expect(before.state.operations).toHaveLength(1);
        const currentTaskCard = yield* readNativeTaskView(config, {runId, callerCwd: repo});
        const issuedTaskRef = String(currentTaskCard.taskRef);
        const decodedTaskRef = decodeNativeTaskActionRef(issuedTaskRef);
        expect(decodedTaskRef).toMatchObject({
          kind: 'task',
          runId,
          generationHash: sha256HexSync(priorDigest),
          stateRevision: before.revision,
        });
        const base = {
          callerCwd: repo,
          featureName: 'Controlled cutover',
          installationTarget: 'codex',
          taskRef: issuedTaskRef,
          intent,
        };
        const first = object(
          yield* runNativeTaskStart(config, base).pipe(Effect.provideService(SystemInfo, testSystem)),
        );
        expect(first).toMatchObject({
          status: 'binding-transition',
          outcome: 'drained',
          binding: {runId, generation: priorDigest, bindingId},
          selectedTarget: {installedDigest: currentStatus.bundle.digest},
          owners: [],
        });
        const repeated = object(
          yield* runNativeTaskStart(config, base).pipe(Effect.provideService(SystemInfo, testSystem)),
        );
        expect(repeated).toEqual(first);
        expect(yield* f.fs.readFileString(statePath)).toBe(beforeBytes);
        expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);
        const after = yield* readNativeWorkflowState(config, runId);
        expect(after?.state.generation).toBe(priorDigest);
        expect(after?.state.bindingId).toBe(bindingId);
        expect(after?.state.operations).toEqual(before.state.operations);
        if (!decodedTaskRef) throw new Error('Expected the issued task reference to decode.');
        const byCanonicalRunId = object(
          yield* runNativeTaskStart(config, {...base, taskRef: runId}).pipe(
            Effect.provideService(SystemInfo, testSystem),
          ),
        );
        expect(byCanonicalRunId).toEqual(first);
        const malformedRef = yield* runNativeTaskStart(config, {...base, taskRef: 'taskref-v1.invalid'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(malformedRef).toMatchObject({failure: {code: 'invalid-task-ref'}});
        const wrongKindRef = yield* runNativeTaskStart(config, {
          ...base,
          taskRef: encodeNativeTaskActionRef({...decodedTaskRef, kind: 'work'}),
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
        expect(wrongKindRef).toMatchObject({failure: {code: 'invalid-task-ref'}});
        const wrongScope = yield* runNativeTaskStart(config, {...base, featureName: 'Different feature'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(wrongScope).toMatchObject({failure: {code: 'task-identity-conflict'}});
        const staleGeneration = yield* runNativeTaskStart(config, {
          ...base,
          taskRef: encodeNativeTaskActionRef({...decodedTaskRef, generationHash: EffectString.repeat(64)('f')}),
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
        expect(staleGeneration).toMatchObject({failure: {code: 'stale-task-ref'}});
        const staleRevision = yield* runNativeTaskStart(config, {
          ...base,
          taskRef: encodeNativeTaskActionRef({...decodedTaskRef, stateRevision: EffectString.repeat(64)('0')}),
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
        expect(staleRevision).toMatchObject({failure: {code: 'stale-task-ref'}});
        expect(yield* f.fs.readFileString(statePath)).toBe(beforeBytes);
        expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);

        const foreignRepo = f.path.join(f.root, 'foreign-cutover');
        yield* f.fs.makeDirectory(foreignRepo);
        yield* f.fs.writeFileString(f.path.join(foreignRepo, 'source.ts'), 'export const foreign = true;\n');
        yield* runCommandEffect('git', ['init', '--initial-branch=main', foreignRepo]);
        const wrongRepo = yield* runNativeTaskStart(config, {...base, callerCwd: foreignRepo}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(wrongRepo).toMatchObject({failure: {code: 'task-identity-conflict'}});
        expect(yield* f.fs.readFileString(statePath)).toBe(beforeBytes);
        expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);
        const wrongTarget = yield* runNativeTaskStart(config, {...base, installationTarget: 'missing-target'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(wrongTarget._tag).toBe('Failure');
        expect(yield* f.fs.readFileString(statePath)).toBe(beforeBytes);
        expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);
        const staleRun = yield* runNativeTaskStart(config, {...base, taskRef: 'task-cutover-missing'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(staleRun).toMatchObject({failure: {code: 'run-not-found'}});
        expect(yield* f.fs.readFileString(statePath)).toBe(beforeBytes);
        expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);
      }).pipe(run),
  );

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
        const missingTargetMcpCall = yield* mcp.invokeTool('workflow_task_start', withoutTarget).pipe(Effect.result);
        expect(missingTargetMcpCall._tag).toBe('Failure');
        expect(yield* readNativeWorkflowState(config, expectedRunId)).toBeUndefined();
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
        let cliHandlerCalls = 0;
        const taskStart = makeNativeTaskStartCommand(options => {
          cliHandlerCalls++;
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
            installationTarget: fields.installationTarget,
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
        const taskStartArgs = [
          '--caller-cwd',
          f.repo,
          '--feature-name',
          'Fixture refresh',
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
        ];
        const missingTargetCli = yield* runCli(['task-start', ...taskStartArgs]).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(missingTargetCli._tag).toBe('Failure');
        expect(cliHandlerCalls).toBe(0);
        yield* runCli(['task-start', '--installation-target', 'codex', ...taskStartArgs]).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
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
      const affectedPaths = Array.from(
        {length: 160},
        (_, index) => `receipt-${index}-abcdefghijklmnopqrstuvwxyz012345.txt`,
      );
      const f = yield* fixture(['one'], 'local', false, false, true, undefined, undefined, {one: affectedPaths});
      for (const path of affectedPaths) yield* f.fs.writeFileString(f.path.join(f.repo, path), 'Admitted text.\n');
      yield* f.git(['add', ...affectedPaths]);
      yield* f.git(['commit', '-m', 'Admit bounded-response snapshot scope']);
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
      for (const path of affectedPaths) yield* f.fs.writeFileString(f.path.join(f.repo, path), 'Changed text.\n');
      yield* f.git(['add', 'source.ts', ...affectedPaths]);
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
      expect(new TextEncoder().encode(JSON.stringify(firstResult.snapshot)).byteLength).toBeGreaterThan(16_384);
      expect(decodeNativeTaskActionRef(firstSnapshotRef)).toMatchObject({
        snapshotId: firstSnapshot.snapshotId,
        sourceHead: firstSnapshot.head,
        sourceTree: firstSnapshot.tree,
      });
      const afterFirst = yield* f.fs.readFileString(f.statePath());
      const firstReplay = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      expect(firstReplay).toMatchObject({status: 'recorded', replayed: true, snapshotRef: firstSnapshotRef});
      expect(firstReplay.snapshot).toEqual(firstResult.snapshot);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterFirst);

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
        yield* mcp.invokeTool('workflow_task_snapshot', {
          runId: 'native-run',
          callerCwd: f.repo,
          snapshot: {
            command: 'supersede-unreviewed',
            snapshotRef: firstSnapshotRef,
            reason: recoveryRequest.reason,
          },
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
      expect(new TextEncoder().encode(JSON.stringify(recovered.snapshot)).byteLength).toBeGreaterThan(16_384);
      expect(decodeNativeTaskActionRef(String(recovered.snapshotRef))).toMatchObject({
        snapshotId: secondSnapshot.snapshotId,
        sourceHead: secondSnapshot.head,
        sourceTree: secondSnapshot.tree,
      });
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

  effectIt.effect(
    'requalifies an exact reviewed predecessor on an approved divergent base through the consolidated snapshot action',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          ['one'],
          'local',
          false,
          false,
          true,
          {one: {branch: 'feature/one', baseBranch: 'prerelease'}},
          repo => runCommandEffect('git', ['-C', repo, 'branch', 'prerelease']),
        );
        yield* f.mutate('begin-phase', {phaseId: 'one'});
        const work = object(
          yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
        );
        yield* f.fs.writeFileString(
          f.path.join(f.repo, 'source.ts'),
          'export const feature = "reviewed predecessor";\n',
        );
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Reviewed predecessor source']);
        const priorResult = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(work.workRef),
          }),
        );
        const prior = object(object(priorResult.snapshot).snapshot);
        const predecessorRef = String(priorResult.snapshotRef);
        const priorFinding = {
          id: 'F1011',
          file: 'source.ts',
          line: 1,
          body: 'Retain this reviewed finding across base requalification.',
          trigger: 'Inspect the rewritten branch.',
          impact: 'The original finding history must remain visible.',
          evidence: 'Observed in the private base-requalification fixture.',
          severity: 'minor',
          category: 'correctness',
          confidence: 97,
          state: 'new',
        };
        const priorReview = {
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [priorFinding],
        };
        expect(
          object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-review',
              runId: 'native-run',
              callerCwd: f.repo,
              snapshotRef: predecessorRef,
              report: priorReview,
            }),
          ).status,
        ).toBe('recorded');
        const reviewedState = yield* readNativeWorkflowState(f.config, 'native-run');
        if (!reviewedState?.state.cycle) throw new Error('Expected the reviewed predecessor runtime.');
        const reviewedRuntime = reviewedState.state.cycle;
        const historicalBaseline = reviewedRuntime.baselines.one;
        if (!historicalBaseline) throw new Error('Expected the retained original phase baseline.');
        const historicalReviews = [...reviewedRuntime.reviews];
        const historicalAttempts = [...reviewedRuntime.attempts];
        const reviewLimits = {...reviewedRuntime.reviewLimits};
        const featureHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);

        yield* f.git(['checkout', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'incoming.ts'), 'export const incoming = true;\n');
        yield* f.git(['add', 'incoming.ts']);
        yield* f.git(['commit', '-m', 'Divergent reviewed new base']);
        const ontoHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        yield* f.git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
        yield* f.git(['config', '--local', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
        yield* f.git(['update-ref', 'refs/remotes/origin/main', ontoHead]);
        yield* f.git(['checkout', '-b', 'feature/main']);
        yield* f.git(['cherry-pick', featureHead]);
        const rebasedHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        expect(rebasedHead).not.toBe(featureHead);
        yield* f.git(['checkout', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'local-main-only.ts'), 'export const localMain = true;\n');
        yield* f.git(['add', 'local-main-only.ts']);
        yield* f.git(['commit', '-m', 'Advance the local base independently']);
        const localMainHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        expect(localMainHead).not.toBe(ontoHead);
        yield* f.git(['checkout', 'feature/main']);

        const amendedPlan = yield* f.revise({}, {one: {branch: 'feature/main', baseBranch: 'origin/main'}});
        yield* f.mutate('reconcile', {
          plan: amendedPlan,
          reason: 'Test-only explicit approval to use main as the declared phase base.',
        });
        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, f.config);
        for (const incompleteRequest of [{callerCwd: f.repo}, {runId: 'native-run'}]) {
          expect(yield* readNativeTaskView(f.config, incompleteRequest).pipe(Effect.result)).toMatchObject({
            failure: {code: 'invalid-request'},
          });
        }
        const taskViewResult = object(
          yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo}),
        );
        expect(taskViewResult.isError).not.toBe(true);
        const taskView = object(taskViewResult.structuredContent);
        const requalification = object(taskView.baseRequalification);
        expect(taskView.next).toMatchObject({action: 'blocked', phaseId: 'one'});
        expect(requalification).toMatchObject({
          action: 'requalify-base',
          phaseId: 'one',
          predecessorRef,
          fromBaseBranch: 'prerelease',
          toBaseBranch: 'origin/main',
        });
        const stateBeforeReviewOmission = yield* f.fs.readFileString(f.statePath());
        const currentStored = yield* readNativeWorkflowState(f.config, 'native-run');
        if (!currentStored?.state.cycle) throw new Error('Expected the stale reviewed-base runtime.');
        const noReviewState = serializeNativeWorkflowState({
          ...currentStored.state,
          cycle: {...currentStored.state.cycle, reviews: [], attempts: []},
        });
        yield* Effect.acquireUseRelease(
          f.fs.writeFileString(f.statePath(), noReviewState),
          () =>
            Effect.gen(function* () {
              const noReviewViewResult = object(
                yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo}),
              );
              expect(noReviewViewResult.isError).not.toBe(true);
              const noReviewView = object(noReviewViewResult.structuredContent);
              expect(noReviewView.next).toMatchObject({action: 'blocked', phaseId: 'one'});
              expect(noReviewView.baseRequalification).toBeUndefined();
            }),
          () => f.fs.writeFileString(f.statePath(), stateBeforeReviewOmission),
        );

        const request = {
          command: 'requalify-base-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: predecessorRef,
          reason: 'Requalify the reviewed source after the approved base transition.',
          userAuthority: 'Test-only explicit human approval for this fixture base transition.',
        };
        const refuseWithoutMutation = (input: typeof request, code: string) =>
          Effect.gen(function* () {
            const before = yield* f.fs.readFileString(f.statePath());
            const refusal = yield* runNativeTaskAction(f.config, input).pipe(Effect.result);
            expect(refusal).toMatchObject({failure: {code}});
            expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
          });
        const decoded = decodeNativeTaskActionRef(predecessorRef);
        if (!decoded) throw new Error('The task view predecessor reference must be decodable.');
        yield* refuseWithoutMutation(
          {...request, snapshotRef: encodeNativeTaskActionRef({...decoded, phaseId: 'two'})},
          'stale-snapshot-ref',
        );
        yield* refuseWithoutMutation(
          {
            ...request,
            snapshotRef: encodeNativeTaskActionRef({
              ...decoded,
              sourceHead: EffectString.repeat(decoded.sourceHead!.length)('f'),
            }),
          },
          'stale-snapshot-ref',
        );
        yield* refuseWithoutMutation(
          {
            ...request,
            snapshotRef: encodeNativeTaskActionRef({...decoded, generationHash: sha256HexSync('foreign-generation')}),
          },
          'invalid-snapshot-ref',
        );
        yield* refuseWithoutMutation({...request, runId: 'foreign-run'}, 'run-not-found');

        yield* f.git(['update-ref', 'refs/heads/prerelease', ontoHead]);
        yield* refuseWithoutMutation(request, 'stale-snapshot-ref');
        yield* f.git(['update-ref', 'refs/heads/prerelease', String(prior.declaredBaseHead)]);
        yield* f.git(['update-ref', 'refs/remotes/origin/main', String(prior.declaredBaseHead)]);
        yield* refuseWithoutMutation(request, 'stale-snapshot-ref');
        yield* f.git(['update-ref', 'refs/remotes/origin/main', ontoHead]);
        yield* f.git(['checkout', 'feature/one']);
        yield* refuseWithoutMutation(request, 'stale-snapshot-ref');
        yield* f.git(['checkout', 'feature/main']);
        expect(EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout)).toBe(rebasedHead);

        const beforeRequalification = yield* f.fs.readFileString(f.statePath());
        const appliedResponse = object(
          yield* mcp.invokeTool('workflow_task_snapshot', {
            runId: 'native-run',
            callerCwd: f.repo,
            snapshot: {
              command: 'requalify-base',
              snapshotRef: predecessorRef,
              reason: request.reason,
              userAuthority: request.userAuthority,
            },
          }),
        );
        expect(appliedResponse.isError).not.toBe(true);
        const applied = object(appliedResponse.structuredContent);
        expect(applied).toMatchObject({status: 'recorded', replayed: false});
        const requalified = object(object(applied.snapshot).snapshot);
        const remoteBaseTree = EffectString.trim((yield* f.git(['rev-parse', 'origin/main^{tree}'])).stdout);
        expect(requalified.declaredBaseHead).toBe(ontoHead);
        expect(requalified.declaredBaseHead).not.toBe(localMainHead);
        expect(requalified.scopeBase).toBe(remoteBaseTree);
        expect(requalified).toMatchObject({
          snapshotId: expect.stringMatching(/^base-requalified-/u),
          previous: prior.snapshotId,
          phaseHash: prior.phaseHash,
          baseTree: historicalBaseline.tree,
          acceptedHead: rebasedHead,
          baseRequalification: {
            preRebaseHead: featureHead,
            ontoHead,
            rebasedHead,
            fromBaseBranch: 'prerelease',
            toBaseBranch: 'origin/main',
            priorDeclaredBaseHead: prior.declaredBaseHead,
            reason: request.reason,
            authority: request.userAuthority,
          },
        });
        const requalifiedRef = String(applied.snapshotRef);
        const afterRequalification = yield* f.fs.readFileString(f.statePath());
        const exactReplay = object(
          yield* mcp.invokeTool('workflow_task_snapshot', {
            runId: 'native-run',
            callerCwd: f.repo,
            snapshot: {
              command: 'requalify-base',
              snapshotRef: predecessorRef,
              reason: request.reason,
              userAuthority: request.userAuthority,
            },
          }),
        );
        expect(exactReplay.structuredContent).toMatchObject({
          status: 'recorded',
          replayed: true,
          snapshot: applied.snapshot,
          snapshotRef: requalifiedRef,
        });
        expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRequalification);
        expect(afterRequalification).not.toBe(beforeRequalification);

        let cliReplay: Record<string, unknown> | undefined;
        const actionCommands = makeNativeTaskActionCommands(
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
            runNativeTaskAction(f.config, {command: 'requalify-base-snapshot', ...options}).pipe(
              Effect.tap(value => Effect.sync(() => (cliReplay = object(value)))),
              Effect.asVoid,
            ),
        );
        const cli = Command.make('workflow-automation').pipe(Command.withSubcommands([actionCommands]));
        yield* Command.runWith(cli, {version: 'fixture'})([
          'task-action',
          'requalify-base-snapshot',
          '--run-id',
          'native-run',
          '--caller-cwd',
          f.repo,
          '--snapshot-ref',
          predecessorRef,
          '--reason',
          request.reason,
          '--user-authority',
          request.userAuthority,
        ]);
        expect(cliReplay).toMatchObject({status: 'recorded', replayed: true, snapshotRef: requalifiedRef});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRequalification);

        const currentView = object(
          (yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo})).structuredContent,
        );
        expect(currentView.next).toMatchObject({action: 'review', phaseId: 'one', snapshotId: requalified.snapshotId});
        expect(currentView.baseRequalification).toBeUndefined();
        const beforeReviewState = yield* readNativeWorkflowState(f.config, 'native-run');
        if (!beforeReviewState?.state.cycle) throw new Error('Expected the requalified cycle state.');
        expect(beforeReviewState.state.cycle.baselines).toEqual(reviewedRuntime.baselines);
        expect(beforeReviewState.state.cycle.reviewLimits).toEqual(reviewLimits);
        expect(beforeReviewState.state.cycle.reviews[0]).toEqual(historicalReviews[0]);
        expect(beforeReviewState.state.cycle.attempts.slice(0, historicalAttempts.length)).toEqual(historicalAttempts);
        expect(beforeReviewState.state.cycle.snapshots[0]?.snapshot).toEqual(prior);
        const requalifiedFullReport = {
          ...priorReview,
          findings: [{...priorFinding, state: 'carried', reason: 'Retained and rechecked after base requalification.'}],
        };
        const incrementalRefusal = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-review',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: requalifiedRef,
            report: {...requalifiedFullReport, mode: 'incremental'},
          }),
        );
        expect(incrementalRefusal.status).toBe('invalid');
        const afterInvalidReview = yield* readNativeWorkflowState(f.config, 'native-run');
        expect(afterInvalidReview?.state.cycle?.reviews).toHaveLength(historicalReviews.length);
        expect(afterInvalidReview?.state.cycle?.reviewLimits).toEqual(reviewLimits);
        const fullReview = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-review',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: requalifiedRef,
            report: requalifiedFullReport,
          }),
        );
        expect(fullReview.status).toBe('recorded');
        const reviewedRequalification = yield* readNativeWorkflowState(f.config, 'native-run');
        expect(reviewedRequalification?.state.cycle?.reviews.at(-1)?.report).toMatchObject({
          mode: 'full',
          findings: [{id: priorFinding.id, state: 'carried'}],
        });
        expect(reviewedRequalification?.state.cycle?.reviewLimits).toEqual(reviewLimits);

        const requalifiedPacket = {...packet, anchors: [{path: 'source.ts', pattern: 'export const feature'}]};
        const followupWork = object(
          yield* runNativeTaskAction(f.config, {
            command: 'work',
            runId: 'native-run',
            callerCwd: f.repo,
            packet: requalifiedPacket,
          }),
        );
        yield* f.fs.writeFileString(
          f.path.join(f.repo, 'source.ts'),
          'export const feature = "reviewed predecessor";\nexport const followup = true;\n',
        );
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Incremental requalified source change']);
        const followupSnapshot = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(followupWork.workRef),
            reason: 'Record the next source change after the full requalification review.',
          }),
        );
        const followup = object(object(followupSnapshot.snapshot).snapshot);
        expect(followup).toMatchObject({previous: requalified.snapshotId});
        expect(followup.baseRequalification).toBeUndefined();
        const incremental = object(
          yield* f.call({
            ...f.base('cycle'),
            command: 'detail',
            snapshotId: followup.snapshotId,
            detailKind: 'patch',
          }),
        );
        const incrementalPatch = String(object(incremental.page).text);
        expect(incrementalPatch).toContain('+export const followup = true;');
        expect(incrementalPatch).not.toContain('+export const feature = "reviewed predecessor";');
        const final = yield* readNativeWorkflowState(f.config, 'native-run');
        expect(EffectArray.map(final?.state.cycle?.snapshots ?? [], item => item.snapshot.snapshotId)).toEqual([
          prior.snapshotId,
          requalified.snapshotId,
          followup.snapshotId,
        ]);
        expect(final?.state.cycle?.reviews[0]).toEqual(historicalReviews[0]);
        expect(final?.state.cycle?.reviewLimits).toEqual(reviewLimits);
        expect(final?.state.cycle?.reviewExpansions).toEqual(reviewedRuntime.reviewExpansions);
      }).pipe(run),
  );

  effectIt.effect.prop(
    'refuses generated foreign-generation reviewed-base references without changing canonical state',
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
          yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
        );
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const reviewed = true;\n');
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Reviewed-base reference fixture']);
        const recorded = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(work.workRef),
          }),
        );
        const snapshotRef = String(recorded.snapshotRef);
        const snapshot = decodeNativeTaskActionRef(snapshotRef);
        if (!snapshot) throw new Error('The reviewed predecessor ref must decode.');
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
            findings: [],
          },
        });
        const before = yield* f.fs.readFileString(f.statePath());
        for (const suffix of new Set(suffixes)) {
          const generationHash = sha256HexSync(`foreign-generation:${suffix}`);
          if (generationHash === snapshot.generationHash) continue;
          const refusal = yield* runNativeTaskAction(f.config, {
            command: 'requalify-base-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: encodeNativeTaskActionRef({...snapshot, generationHash}),
            reason: 'A bounded generated wrong-generation reference must not requalify source.',
            userAuthority: 'Test-only generated invalid reference; no authority is asserted.',
          }).pipe(Effect.result);
          expect(refusal).toMatchObject({failure: {code: 'invalid-snapshot-ref'}});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        }
      }).pipe(run),
    {arbitrary: {runs: 4}},
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

  effectIt.effect('reconciles an amended compact-origin PR cycle without changing delivery or bindings', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      const config = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
      const system = yield* SystemInfo;
      const testSystem = {...system, currentDirectory: () => repo, homeDirectory: home};
      yield* runCommandEffect('git', ['-C', repo, 'add', 'source.ts']);
      yield* runCommandEffect('git', [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'Fixture source',
      ]);
      yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(Effect.provideService(SystemInfo, testSystem));
      const intent = {
        title: 'Refresh compact fixture data',
        currentBehavior: 'Expired fixture values are returned without a freshness check.',
        desiredChange: 'Expired fixture values are refreshed before return.',
        affectedPaths: ['source.ts'],
        acceptanceCriterion: 'Expired fixture values refresh before return.',
        verification: 'Exercise expiration and observe the refreshed value.',
        eligibilityRationale: 'One local source and one bounded behavior are explicit.',
        eligibility: {status: 'eligible' as const},
        review: {required: false, reason: 'The fixture behavior is bounded.'},
      };
      const startInput = {callerCwd: repo, featureName: intent.title, installationTarget: 'codex', intent};
      expect(
        yield* runNativeTaskStart(config, startInput).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        ),
      ).toMatchObject({
        failure: {code: 'evidence-unavailable'},
      });
      expect(
        (yield* (yield* CodeGraphIndexer).index({cwd: repo, threadnoteHome: home, ensureVectors: false})).snapshot
          .state,
      ).toBe('ready');
      const started = object(
        yield* runNativeTaskStart(config, startInput).pipe(Effect.provideService(SystemInfo, testSystem)),
      );
      const runId = String(started.taskRef);
      const initialState = yield* readNativeWorkflowState(config, runId);
      if (!initialState) throw new Error('The compact start must initialize a canonical run.');
      const compactRead = object(
        object(
          yield* f.call(
            {
              ...f.base('authoring', runId, initialState.state.generation),
              command: 'load',
              uri: object(started.root).uri,
              detail: 'document',
            },
            config,
          ),
        ).authoring,
      );
      const compactDocument = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(
        compactRead.document,
      );
      const compactPhase = compactDocument.phases[0];
      const compactAcceptance = compactPhase?.acceptance[0];
      if (!compactPhase || !compactAcceptance)
        throw new Error('The compact plan needs one phase and acceptance criterion.');
      const expansion = {
        ...compactDocument,
        current: {
          ...compactDocument.current,
          components: ['source.ts contains the fixture value consumed by callers.'],
        },
        target: {...compactDocument.target, components: ['Refresh the fixture value before returning it.']},
        phases: [
          compactPhase,
          {
            ...compactPhase,
            id: 'verify',
            title: 'Verify refreshed fixture data',
            outcome: 'The refreshed fixture value remains available after reload.',
            dependsOn: [String(compactPhase.id)],
            acceptance: [
              {
                ...compactAcceptance,
                id: 'persisted',
                criterion: 'The refreshed value persists.',
                verification: 'Reload and observe the refreshed value.',
              },
            ],
          },
        ],
        decisions: [
          {
            id: 'verify-refresh',
            question: 'How is persistence verified?',
            selection: 'no-better-alternative',
            selected: 'Reload the fixture after refresh.',
            alternatives: [],
            rationale: 'A dependent phase verifies persistence.',
            affectedPhases: [String(compactPhase.id), 'verify'],
            authority: 'orchestrator',
          },
        ],
      };
      const firstExpansion = object(
        yield* runNativeTaskAction(config, {
          command: 'compact-expand',
          runId,
          callerCwd: repo,
          document: expansion,
        }),
      );
      expect(firstExpansion.status).toBe('awaiting-user-confirmation');
      const expandedRead = object(
        object(
          yield* f.call(
            {
              ...f.base('authoring', runId, initialState.state.generation),
              command: 'load',
              uri: object(firstExpansion.root).uri,
              detail: 'document',
            },
            config,
          ),
        ).authoring,
      );
      const expandedDocument = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(
        expandedRead.document,
      );
      expect(expandedDocument.compactOrigin?.expanded).toBe(true);
      const contentFile = f.path.join(home, 'compact-business.json');
      const business = {
        title: expandedDocument.title,
        objective: expandedDocument.objective,
        requirements: expandedDocument.requirements,
        context: expandedDocument.context,
        current: expandedDocument.current,
        target: expandedDocument.target,
        phases: expandedDocument.phases,
        decisions: expandedDocument.decisions,
        openQuestions: expandedDocument.openQuestions,
        review: expandedDocument.review,
      };
      yield* f.fs.writeFileString(contentFile, JSON.stringify(business));
      const authored = object(
        yield* runNativeTaskAuthoring(config, {
          command: 'start',
          callerCwd: repo,
          featureName: intent.title,
          kind: 'plan',
          contentFile,
          installationTarget: 'codex',
        }).pipe(Effect.provideService(SystemInfo, testSystem)),
      );
      expect(authored).toMatchObject({status: 'draft', replayed: true});
      const approved = object(
        yield* runNativeTaskAuthoring(config, {
          command: 'decide',
          callerCwd: repo,
          authoringRef: String(authored.authoringRef),
          userDecision: 'approve',
          userResponse: 'I approve this exact expanded fixture plan.',
        }).pipe(Effect.provideService(SystemInfo, testSystem)),
      );
      const admitted = object(
        yield* runNativeTaskAuthoring(config, {
          command: 'admit',
          callerCwd: repo,
          authoringRef: String(approved.authoringRef),
          delivery: 'pr',
          bindings: {
            compact: {branch: 'main', baseBranch: 'main'},
            verify: {branch: 'main', baseBranch: 'main'},
          },
        }).pipe(Effect.provideService(SystemInfo, testSystem)),
      );
      expect(admitted.status).toBe('admitted');
      const initialCycle = yield* readNativeWorkflowState(config, runId);
      expect(initialCycle?.state.cycle?.state.plan).toMatchObject({
        delivery: 'pr',
        phases: [
          {id: 'compact', branch: 'main', baseBranch: 'main'},
          {id: 'verify', branch: 'main', baseBranch: 'main'},
        ],
      });

      const verifyPhase = expandedDocument.phases[1];
      const verifyAcceptance = verifyPhase?.acceptance[0];
      if (!verifyPhase || !verifyAcceptance) throw new Error('The expanded plan must include its verification phase.');
      const amendment = {
        ...expandedDocument,
        title: 'Refresh and verify compact fixture data',
        objective: 'Refresh fixture data and verify the persisted result.',
        target: {...expandedDocument.target, summary: 'Expired fixture values refresh and persist before return.'},
        phases: [
          ...expandedDocument.phases,
          {
            ...verifyPhase,
            id: 'readback',
            title: 'Read back refreshed fixture data',
            outcome: 'The refreshed fixture value is available to later reads.',
            dependsOn: [String(verifyPhase.id)],
            acceptance: [
              {
                ...verifyAcceptance,
                id: 'readback',
                criterion: 'Later reads return the refreshed value.',
                verification: 'Read the fixture value after reload.',
              },
            ],
          },
        ],
        decisions: [
          ...expandedDocument.decisions,
          {
            id: 'readback-refresh',
            question: 'How are later reads checked?',
            selection: 'no-better-alternative',
            selected: 'Read the value after reload.',
            alternatives: [],
            rationale: 'The final phase verifies the persisted result.',
            affectedPhases: ['compact', 'verify', 'readback'],
            authority: 'orchestrator',
          },
        ],
      };
      const expanded = object(
        yield* runNativeTaskAction(config, {
          command: 'compact-expand',
          runId,
          callerCwd: repo,
          document: amendment,
        }),
      );
      expect(expanded.status).toBe('awaiting-user-confirmation');
      const confirmed = object(
        yield* runNativeTaskAction(config, {
          command: 'compact-confirm',
          runId,
          callerCwd: repo,
          presentedIntentHash: String(expanded.intentHash),
          userDecision: 'approve',
          userResponse: 'I approve this exact amended fixture plan.',
          bindings: {
            compact: {branch: 'main', baseBranch: 'main'},
            verify: {branch: 'main', baseBranch: 'main'},
            readback: {branch: 'main', baseBranch: 'main'},
          },
        }),
      );
      expect(confirmed.status).toBe('admitted');
      const after = yield* readNativeWorkflowState(config, runId);
      expect(after?.state.cycle?.state.plan).toMatchObject({
        delivery: 'pr',
        phases: [
          {id: 'compact', branch: 'main', baseBranch: 'main'},
          {id: 'verify', branch: 'main', baseBranch: 'main'},
          {id: 'readback', branch: 'main', baseBranch: 'main'},
        ],
      });
      expect(after?.state.cycle?.plans).toHaveLength(2);
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
      expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.plan.delivery).toBe('local');
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

  const prReceiptCase = (maintenance: boolean) =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'pr');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const work = object(
        yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "PR worker result";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'PR worker result']);
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
      yield* f.git(['commit', '--allow-empty', '-m', 'Same-tree PR build marker']);
      const validation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          validation: {
            checks: [{command: 'private PR check', result: 'passed', evidence: 'The scoped test fixture passed.'}],
            acceptance: [{criterion: 'one works', result: 'passed', evidence: 'The implementation meets acceptance.'}],
          },
        }),
      );
      const validationRef = String(validation.validationRef);
      const headSha = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      const publication = {exemption: 'small-fix', reason: 'Private bounded fixture publication authority.'};
      const openPr = {
        url: 'https://github.com/example/repo/pull/1',
        headSha,
        branch: 'feature/one',
        baseBranch: 'main',
        state: 'open',
      };
      const beforeOpen = yield* f.fs.readFileString(f.statePath());
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const watchEnvelope = object(
        yield* mcp.invokeTool('workflow_task_deliver', {
          runId: 'native-run',
          callerCwd: f.repo,
          delivery: {
            command: 'pr',
            validationRef,
            commitEvidence: 'Verified private fixture commit ' + headSha,
            pr: openPr,
            publication,
          },
        }),
      );
      const watchCard = object(watchEnvelope.structuredContent);
      expect(watchCard).toMatchObject({
        status: 'watch-required',
        next: {action: 'watch-pr', prUrl: openPr.url, headSha},
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeOpen);
      const provisionalRef = decodeNativeTaskActionRef(String(watchCard.deliveryRef));
      if (!provisionalRef?.delivery?.pr) throw new Error('Expected the provisional PR delivery locator.');
      const forgedDelivery = {
        ...provisionalRef.delivery,
        pr: {...provisionalRef.delivery.pr, url: 'https://github.com/other-owner/other-repo/pull/99'},
      };
      const forgedDeliveryRef = encodeNativeTaskActionRef({
        ...provisionalRef,
        kind: 'delivery',
        delivery: forgedDelivery,
        payloadDigest: sha256HexSync(stableJson(forgedDelivery)),
      });
      const watchId = `pr-${EffectString.slice(0, 48)(sha256HexSync('native-run\none'))}`;
      const watchPath = f.path.join(
        f.config.agentContextHome,
        'workflow-automations',
        'native-watch-v1',
        watchId + '.json',
      );
      if (maintenance) {
        yield* f.git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
        // CI edits must not revoke the existing watch route or manufacture validation of the new source.
        const watch = yield* startSimulatedTaskWatch(
          f,
          'native-run',
          'one',
          validationRef,
          String(watchCard.deliveryRef),
          openPr.url,
        );
        yield* writeSimulatedTaskWatch(f, watch.startedWatch, watch, openPr.url, headSha, false);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "CI maintenance";\n');
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'CI maintenance after validated delivery']);
        for (const operation of ['start', 'complete'] as const) {
          expect(
            yield* runNativeTaskAction(f.config, {
              command: 'watch-pr',
              operation,
              runId: 'native-run',
              callerCwd: f.repo,
              validationRef,
              deliveryRef: String(watchCard.deliveryRef),
              ...(operation === 'start' ? {wakeup: watch.wakeup} : {}),
            }).pipe(Effect.result),
          ).toMatchObject({failure: {code: 'source-drift'}});
        }

        yield* f.mutate('invalidate', {phaseId: 'one', reason: 'CI follow-up source needs separate validation.'});
        const maintenanceRunBytes = yield* f.fs.readFileString(f.statePath());
        const watchRequest = {
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef: String(watchCard.deliveryRef),
        };
        for (const operation of ['start', 'complete'] as const) {
          expect(
            yield* runNativeTaskAction(f.config, {
              command: 'watch-pr',
              operation,
              ...watchRequest,
              ...(operation === 'start' ? {wakeup: watch.wakeup} : {}),
            }).pipe(Effect.result),
          ).toMatchObject({failure: {code: 'stale-delivery-ref'}});
        }
        const beforeRenew = yield* readNativeWatch(f.config, watchId);
        if (!beforeRenew?.envelope.state.consumer) throw new Error('Expected the exact retained watch consumer.');
        yield* writeNativeWatch(
          f.config,
          {
            ...beforeRenew.envelope,
            state: {
              ...beforeRenew.envelope.state,
              consumer: {
                ...beforeRenew.envelope.state.consumer,
                lastSeenAt: 1,
                leaseUntil: 1 + beforeRenew.envelope.state.consumer.leaseMilliseconds,
              },
            },
          },
          beforeRenew.revision,
        );
        watch.setCollectorAlive(false);
        const renew = (input: object) =>
          runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'renew', ...watchRequest, ...input}).pipe(
            Effect.provideService(CommandExecutor, watch.commands),
            Effect.provideService(SystemInfo, watch.system),
          );
        const beforeRejectedRenew = yield* f.fs.readFileString(watchPath);
        expect(
          yield* renew({wakeup: {...watch.wakeup, threadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}}).pipe(
            Effect.result,
          ),
        ).toMatchObject({failure: {code: 'watch-identity-conflict'}});
        watch.setRemoteBase('wrong-base');
        expect(yield* renew({}).pipe(Effect.result)).toMatchObject({failure: {code: 'watch-identity-conflict'}});
        const retargeted = {...provisionalRef.delivery, pr: {...provisionalRef.delivery.pr, baseBranch: 'wrong-base'}};
        const retargetedRef = encodeNativeTaskActionRef({
          ...provisionalRef,
          kind: 'delivery',
          delivery: retargeted,
          payloadDigest: sha256HexSync(stableJson(retargeted)),
        });
        expect(yield* renew({deliveryRef: retargetedRef}).pipe(Effect.result)).toMatchObject({
          failure: {code: 'base-ref-unverified'},
        });
        watch.setRemoteBase('main');
        expect(yield* f.fs.readFileString(watchPath)).toBe(beforeRejectedRenew);
        const beforeStartup = yield* readNativeWatch(f.config, watchId);
        if (!beforeStartup?.envelope.collector) throw new Error('Expected the retained collector claim.');
        const youngStartup = yield* writeNativeWatch(
          f.config,
          {
            ...beforeStartup.envelope,
            collector: {
              ...beforeStartup.envelope.collector,
              pid: 0,
              status: 'starting',
              startedAt: yield* Clock.currentTimeMillis,
            },
          },
          beforeStartup.revision,
        );
        const youngStartupBytes = yield* f.fs.readFileString(watchPath);
        expect(yield* renew({}).pipe(Effect.result)).toMatchObject({failure: {code: 'collector-starting'}});
        expect(yield* f.fs.readFileString(watchPath)).toBe(youngStartupBytes);
        expect(watch.spawnCount()).toBe(1);
        yield* writeNativeWatch(f.config, beforeStartup.envelope, youngStartup.revision);
        const renewedResponse = object(
          yield* mcp
            .invokeTool('workflow_task_watch_pr', {operation: 'renew', ...watchRequest})
            .pipe(
              Effect.provideService(CommandExecutor, watch.commands),
              Effect.provideService(SystemInfo, watch.system),
            ),
        );
        expect(renewedResponse.isError).not.toBe(true);
        expect(object(renewedResponse.structuredContent).status).toBe('watching');
        expect(watch.spawnCount()).toBe(2);
        expect(watch.hostPreflightCount()).toBe(1);
        const renewed = yield* readNativeWatch(f.config, watchId);
        if (!renewed) throw new Error('Expected the renewed retained watch.');
        expect(renewed.envelope.state.consumer?.leaseUntil).toBeGreaterThan(yield* Clock.currentTimeMillis);
        const {consumer: _oldConsumer, ...beforeRenewState} = beforeRenew.envelope.state;
        const {consumer: _newConsumer, ...afterRenewState} = renewed.envelope.state;
        expect(afterRenewState).toEqual(beforeRenewState);
        expect(renewed.envelope.notification).toEqual(beforeRenew.envelope.notification);
        expect(renewed.envelope.provider).toEqual(beforeRenew.envelope.provider);
        expect(object(yield* renew({})).status).toBe('watching');
        expect(watch.spawnCount()).toBe(2);
        const nativeRenew = {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'watch',
          command: 'renew',
          watchId,
          pr: openPr.url,
          consumerId: watch.consumerId,
          wakeupId: watch.wakeupId,
          wakeup: watch.wakeup,
          baseBranch: 'main',
          headBranch: 'feature/one',
        };
        for (const change of [
          {consumerId: 'foreign-consumer'},
          {pr: 'https://github.com/foreign/repo/pull/99'},
          {watchId: 'missing-renew'},
        ]) {
          expect(
            yield* f
              .call({...nativeRenew, ...change})
              .pipe(
                Effect.provideService(CommandExecutor, watch.commands),
                Effect.provideService(SystemInfo, watch.system),
                Effect.result,
              ),
          ).toMatchObject({failure: {code: change.watchId ? 'watch-not-found' : 'watch-identity-conflict'}});
        }
        expect(yield* readNativeWatch(f.config, 'missing-renew')).toBeUndefined();
        const historicalWatchBytes = yield* f.fs.readFileString(watchPath);
        const decodedValidation = decodeNativeTaskActionRef(validationRef);
        if (!decodedValidation) throw new Error('Expected the canonical validation reference.');
        const foreignValidation = encodeNativeTaskActionRef({
          ...decodedValidation,
          generationHash: EffectString.repeat(64)('f'),
        });
        expect(
          yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'inspect',
            ...watchRequest,
            validationRef: foreignValidation,
          }).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'invalid-delivery-ref'}});
        expect(
          yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'relay',
            ...watchRequest,
            deliveryRef: forgedDeliveryRef,
          }).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'watch-identity-conflict'}});
        expect(yield* f.fs.readFileString(watchPath)).toBe(historicalWatchBytes);
        expect(
          object(yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'inspect', ...watchRequest})),
        ).toMatchObject({status: 'watch-updated'});
        const relayed = object(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'relay', ...watchRequest}),
        );
        const eventRefs = relayed.eventRefs;
        if (!EffectArray.isArray(eventRefs) || !eventRefs.length)
          throw new Error('Expected the queued historical event.');
        const watchDeliveryRef = String(relayed.watchDeliveryRef);
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'disposition',
          ...watchRequest,
          watchDeliveryRef,
          dispositions: [
            {
              eventRef: String(eventRefs[0]),
              status: 'blocked',
              reason: 'CI repair remains open.',
              evidence: 'Retained event proof.',
            },
          ],
        });
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'ack',
          ...watchRequest,
          watchDeliveryRef,
        });
        const beforeWorkRenew = yield* readNativeWatch(f.config, watchId);
        yield* renew({});
        expect((yield* readNativeWatch(f.config, watchId))?.envelope.state.work).toEqual(
          beforeWorkRenew?.envelope.state.work,
        );
        expect(watch.spawnCount()).toBe(2);
        const retainedWork = object(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'work', ...watchRequest}),
        );
        const rows = object(object(retainedWork.result).work).items;
        if (!EffectArray.isArray(rows) || rows.length !== 1)
          throw new Error('Expected one retained historical work row.');
        const eventRef = String(object(rows[0]).eventRef);
        expect(
          object(
            yield* runNativeTaskAction(f.config, {
              command: 'watch-pr',
              operation: 'work-detail',
              ...watchRequest,
              workEventRef: eventRef,
              offsetBytes: 0,
            }),
          ),
        ).toMatchObject({status: 'watch-updated'});
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'work-disposition',
          ...watchRequest,
          dispositions: [
            {eventRef, status: 'resolved', reason: 'CI repair completed.', evidence: 'Owning check passed.'},
          ],
        });
        const maintained = yield* readNativeWatch(f.config, watch.watchId);
        expect(maintained?.envelope.state.consumer).toMatchObject({id: watch.consumerId, wakeupId: watch.wakeupId});
        expect(maintained?.envelope.state.events).toHaveLength(0);
        expect(maintained?.envelope.state.work[0]?.status).toBe('resolved');
        expect(yield* f.fs.readFileString(f.statePath())).toBe(maintenanceRunBytes);
        expect(
          object(yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'stop', ...watchRequest})),
        ).toMatchObject({status: 'watch-updated'});
        const stoppedBytes = yield* f.fs.readFileString(watchPath);
        expect(yield* renew({}).pipe(Effect.result)).toMatchObject({failure: {code: 'watch-stopped'}});
        expect(yield* f.fs.readFileString(watchPath)).toBe(stoppedBytes);
        expect(watch.hostPreflightCount()).toBe(1);
        expect(watch.spawnCount()).toBe(2);
        const removedBeforeLock = CommandExecutor.of({
          ...watch.commands,
          execute: (executable, args, options) =>
            executable === 'gh'
              ? f.fs
                  .remove(watchPath)
                  .pipe(Effect.orDie, Effect.andThen(watch.commands.execute(executable, args, options)))
              : watch.commands.execute(executable, args, options),
        });
        expect(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'renew', ...watchRequest}).pipe(
            Effect.provideService(CommandExecutor, removedBeforeLock),
            Effect.provideService(SystemInfo, watch.system),
            Effect.result,
          ),
        ).toMatchObject({failure: {code: 'watch-not-found'}});
        expect(watch.spawnCount()).toBe(2);
        expect(yield* renew({}).pipe(Effect.result)).toMatchObject({failure: {code: 'watch-not-found'}});
        expect(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'inspect', ...watchRequest}).pipe(
            Effect.result,
          ),
        ).toMatchObject({failure: {code: 'watch-not-found'}});
        expect(yield* f.fs.exists(watchPath)).toBe(false);
        if (!maintained) throw new Error('Expected the retained watch before terminal qualification.');
        yield* writeNativeWatch(
          f.config,
          {...maintained.envelope, state: {...maintained.envelope.state, prState: 'merged'}},
          null,
        );
        const terminalBytes = yield* f.fs.readFileString(watchPath);
        expect(object(yield* renew({})).status).toBe('terminal-empty');
        expect(yield* f.fs.readFileString(watchPath)).toBe(terminalBytes);
        expect(watch.hostPreflightCount()).toBe(1);
        expect(watch.spawnCount()).toBe(2);
        return;
      }
      const forgedStart = yield* attemptSimulatedTaskWatch(
        f,
        'native-run',
        'one',
        validationRef,
        forgedDeliveryRef,
        forgedDelivery.pr.url,
      );
      expect(forgedStart.result).toMatchObject({ok: false, failure: {code: 'base-ref-unverified'}});
      expect(forgedStart.collectorSpawns).toBe(0);
      expect(forgedStart.startedWatch).toBeUndefined();
      expect(yield* f.fs.exists(watchPath)).toBe(false);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeOpen);
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal,
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'finish-scope'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeOpen);

      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "changed after validation";\n',
      );
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Change after validation']);
      const beforeStale = yield* f.fs.readFileString(f.statePath());
      const stale = yield* runNativeTaskAction(f.config, {
        command: 'deliver-pr',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        commitEvidence: 'Verified private fixture commit ' + headSha,
        pr: {...openPr, state: 'merged'},
        publication,
      }).pipe(Effect.result);
      expect(stale).toMatchObject({failure: {code: 'source-drift'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeStale);
      yield* f.git(['reset', '--hard', 'HEAD~1']);

      const mergedPr = {...openPr, state: 'merged' as const};
      const delivered = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-pr',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          commitEvidence: 'Verified private fixture commit ' + headSha,
          pr: mergedPr,
          publication,
        }),
      );
      expect(delivered).toMatchObject({
        status: 'delivered',
        replayed: false,
        receipt: {delivery: 'pr', pr: mergedPr, publication},
      });
      const afterDelivery = yield* f.fs.readFileString(f.statePath());
      const replay = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-pr',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: String(delivered.deliveryRef),
          commitEvidence: 'Verified private fixture commit ' + headSha,
          pr: mergedPr,
          publication,
        }),
      );
      expect(replay).toMatchObject({status: 'delivered', replayed: true, receipt: delivered.receipt});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterDelivery);
      const changedAuthority = yield* runNativeTaskAction(f.config, {
        command: 'deliver-pr',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: String(delivered.deliveryRef),
        commitEvidence: 'Verified private fixture commit ' + headSha,
        pr: mergedPr,
        publication: {exemption: 'small-fix', reason: 'Changed authority cannot reuse the original receipt.'},
      }).pipe(Effect.result);
      expect(changedAuthority).toMatchObject({failure: {code: 'delivery-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterDelivery);
    }).pipe(run);
  effectIt.effect('prepares and records only an exact approved PR receipt, returning a watch card for open PRs', () =>
    prReceiptCase(false),
  );
  effectIt.effect('maintains an existing PR watch through unvalidated CI source changes', () => prReceiptCase(true));

  effectIt.effect('refuses provisional watches for a local plan or a phase without validation', () =>
    Effect.gen(function* () {
      for (const scenario of [
        {delivery: 'local' as const, reviewed: true, code: 'delivery-scope'},
        {delivery: 'pr' as const, reviewed: false},
      ]) {
        const f = yield* fixture(['one'], scenario.delivery);
        yield* f.mutate('begin-phase', {phaseId: 'one'});
        const work = object(
          yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
        );
        yield* f.fs.writeFileString(
          f.path.join(f.repo, 'source.ts'),
          `export const fixture = "${scenario.delivery}";\n`,
        );
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', `${scenario.delivery} provisional watch fixture`]);
        const snapshot = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(work.workRef),
          }),
        );
        const snapshotRef = String(snapshot.snapshotRef);
        let validationRef: string;
        if (scenario.reviewed) {
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
          const validation = object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-validation',
              runId: 'native-run',
              callerCwd: f.repo,
              snapshotRef,
              validation: {
                checks: [{command: 'fixture check', result: 'passed', evidence: 'Private test evidence.'}],
                acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Committed fixture source.'}],
              },
            }),
          );
          validationRef = String(validation.validationRef);
        } else {
          const snapshotAction = decodeNativeTaskActionRef(snapshotRef);
          if (!snapshotAction) throw new Error('Expected the pre-validation snapshot reference.');
          validationRef = encodeNativeTaskActionRef({
            ...snapshotAction,
            kind: 'validation',
            payloadDigest: sha256HexSync('forged missing validation'),
          });
        }
        const validationAction = decodeNativeTaskActionRef(validationRef);
        if (!validationAction?.sourceHead || !validationAction.sourceTree || !validationAction.phaseHash)
          throw new Error('Expected the task reference to bind the fixture source.');
        const delivery = {
          phaseId: 'one',
          phaseHash: validationAction.phaseHash,
          delivery: 'pr' as const,
          headSha: validationAction.sourceHead,
          validatedTree: validationAction.sourceTree,
          commitEvidence: 'Private fixture commit.',
          pr: {
            url: 'https://github.com/example/repo/pull/88',
            headSha: validationAction.sourceHead,
            branch: 'feature/one',
            baseBranch: 'main',
            state: 'open' as const,
          },
          publication: {exemption: 'small-fix' as const, reason: 'Private fixture authority.'},
        };
        const deliveryRef = encodeNativeTaskActionRef({
          ...validationAction,
          kind: 'delivery',
          delivery,
          payloadDigest: sha256HexSync(stableJson(delivery)),
        });
        const before = yield* f.fs.readFileString(f.statePath());
        if (!scenario.reviewed) {
          const unvalidated = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.phases.one;
          expect(unvalidated?.validation).toBeUndefined();
        }
        const attempt = yield* attemptSimulatedTaskWatch(
          f,
          'native-run',
          'one',
          validationRef,
          deliveryRef,
          delivery.pr.url,
        );
        expect(attempt.result.ok, `${scenario.delivery} reviewed=${scenario.reviewed}`).toBe(false);
        if (!attempt.result.ok && 'code' in scenario)
          expect(attempt.result.failure).toMatchObject({code: scenario.code});
        expect(attempt.collectorSpawns).toBe(0);
        expect(attempt.startedWatch).toBeUndefined();
        expect(
          yield* f.fs.exists(
            f.path.join(
              f.config.agentContextHome,
              'workflow-automations',
              'native-watch-v1',
              attempt.watchId + '.json',
            ),
          ),
        ).toBe(false);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }
    }).pipe(run),
  );

  effectIt.effect('delivers each dependent PR phase from its exact validation reference', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one', 'two'], 'pr');
      const deliverPhase = (phaseId: 'one' | 'two', branch: string, baseBranch: string) =>
        Effect.gen(function* () {
          yield* f.mutate('begin-phase', {phaseId});
          const work = object(
            yield* runNativeTaskAction(f.config, {
              command: 'work',
              runId: 'native-run',
              callerCwd: f.repo,
              packet,
            }),
          );
          yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), `export const fixture = "phase ${phaseId}";\n`);
          yield* f.git(['add', 'source.ts']);
          yield* f.git(['commit', '-m', `Phase ${phaseId}`]);
          const snapshot = object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-snapshot',
              runId: 'native-run',
              callerCwd: f.repo,
              workRef: String(work.workRef),
            }),
          );
          const snapshotRef = String(snapshot.snapshotRef);
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
                checks: [{command: `phase ${phaseId} check`, result: 'passed', evidence: 'Private fixture passed.'}],
                acceptance: [
                  {criterion: `${phaseId} works`, result: 'passed', evidence: `Phase ${phaseId} source is committed.`},
                ],
              },
            }),
          );
          const headSha = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
          const deliveryRequest = {
            command: 'deliver-pr' as const,
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef: String(validation.validationRef),
            commitEvidence: `Private fixture commit ${headSha}`,
            pr: {
              url: `https://github.com/example/repo/pull/${phaseId === 'one' ? '11' : '12'}`,
              headSha,
              branch,
              baseBranch,
              state: 'merged' as const,
            },
            publication: {exemption: 'small-fix' as const, reason: `Private ${phaseId} phase authority input.`},
          };
          const delivered = object(yield* runNativeTaskAction(f.config, deliveryRequest));
          const beforeReplay = yield* f.fs.readFileString(f.statePath());
          const replay = object(yield* runNativeTaskAction(f.config, deliveryRequest));
          expect(replay).toMatchObject({status: 'delivered', replayed: true, receipt: delivered.receipt});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeReplay);
          return {deliveryRequest, delivered};
        });

      const first = yield* deliverPhase('one', 'feature/one', 'main');
      expect(first.delivered).toMatchObject({status: 'delivered', receipt: {phaseId: 'one', pr: {state: 'merged'}}});
      yield* f.git(['checkout', '-b', 'feature/two']);
      yield* f.mutate('begin-phase', {phaseId: 'two'});
      const second = yield* deliverPhase('two', 'feature/two', 'feature/one');
      expect(second.delivered).toMatchObject({status: 'delivered', receipt: {phaseId: 'two', pr: {state: 'merged'}}});
      const beforeHistoricalReplay = yield* f.fs.readFileString(f.statePath());
      const historicalReplay = object(yield* runNativeTaskAction(f.config, first.deliveryRequest));
      expect(historicalReplay).toMatchObject({status: 'delivered', replayed: true, receipt: first.delivered.receipt});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeHistoricalReplay);
      const stored = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(stored?.state.cycle?.state.phases.one?.delivery?.phaseId).toBe('one');
      expect(stored?.state.cycle?.state.phases.two?.delivery?.phaseId).toBe('two');
      const beforeBlockedCloseout = yield* f.fs.readFileString(f.statePath());
      const missingWatch = yield* runNativeTaskAction(f.config, {
        command: 'finish',
        runId: 'native-run',
        callerCwd: f.repo,
        proposal,
      }).pipe(Effect.result);
      expect(missingWatch).toMatchObject({failure: {code: 'finish-scope'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeBlockedCloseout);
    }).pipe(run),
  );

  effectIt.effect(
    'stales a task page when an earlier historical watch loses eligibility without a run revision change',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          ['one', 'two', 'three'],
          'pr',
          false,
          false,
          true,
          {
            one: {branch: 'feature/one', baseBranch: 'origin/main'},
            two: {branch: 'feature/two', baseBranch: 'feature/one'},
            three: {branch: 'feature/three', baseBranch: 'feature/two'},
          },
          repo =>
            Effect.gen(function* () {
              yield* runCommandEffect('git', [
                '-C',
                repo,
                'remote',
                'add',
                'origin',
                'https://github.com/example/repo.git',
              ]);
              yield* runCommandEffect('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
            }),
          {three: Array.from({length: 20}, (_, index) => `scope/${index}.ts`)},
          {},
        );

        const p1 = yield* publishOpenHistoricalPhase(f, 'one', 'origin/main', 31);
        yield* f.git(['checkout', '-b', 'feature/two']);
        yield* f.mutate('begin-phase', {phaseId: 'two'});
        const p2 = yield* publishOpenHistoricalPhase(f, 'two', 'feature/one', 32, false);
        yield* f.git(['checkout', '-b', 'feature/three']);
        yield* f.mutate('begin-phase', {phaseId: 'three'});

        const pageOne = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(EffectArray.map(pageOne.historicalWatches ?? [], item => item.phaseId)).toEqual(['one', 'two']);
        expect(pageOne.page.nextCursor).toBeDefined();
        expect(pageOne.page.limit).toBe(16);
        const beforeRevision = (yield* readNativeWorkflowState(f.config, 'native-run'))?.revision;
        const earlierWatch = yield* readNativeWatch(f.config, p1.watchId);
        if (!earlierWatch?.envelope.collector) throw new Error('Expected the P1 active collector readback.');

        yield* writeNativeWatch(
          f.config,
          {
            ...earlierWatch.envelope,
            stopRequested: true,
            collector: {
              ...earlierWatch.envelope.collector,
              status: 'stopped',
              reason: 'fixture-eligibility-change',
            },
          },
          earlierWatch.revision,
        );
        expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.revision).toBe(beforeRevision);
        expect((yield* readNativeWatch(f.config, p2.watchId))?.envelope.collector?.status).toBe('running');

        const continuation = yield* readNativeTaskView(f.config, {
          runId: 'native-run',
          callerCwd: f.repo,
          cursor: pageOne.page.nextCursor!,
        }).pipe(Effect.result);
        expect(continuation).toMatchObject({
          failure: {
            code: 'stale-cursor',
            message: expect.stringContaining('eligible historical-watch set changed'),
          },
        });
        expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.revision).toBe(beforeRevision);
      }).pipe(run),
  );

  effectIt.effect('routes a stale accepted review to fresh work while retaining current validation and delivery', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const firstWork = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "first result";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'First result']);
      const first = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(firstWork.workRef),
        }),
      );
      const report = {
        mode: 'full',
        selected: ['correctness', 'simplicity'],
        lanes: [
          {name: 'correctness', status: 'complete'},
          {name: 'simplicity', status: 'complete'},
        ],
        findings: [],
      };
      const firstReview = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(first.snapshotRef),
          report,
        }),
      );
      expect(firstReview.status).toBe('recorded');
      const card = () => readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(yield* card()).toMatchObject({
        next: {action: 'validate', snapshotId: object(object(first.snapshot).snapshot).snapshotId},
      });
      yield* f.git(['commit', '--allow-empty', '-m', 'Same tree']);
      expect(yield* card()).toMatchObject({next: {action: 'validate'}});
      const originalBase = EffectString.trim((yield* f.git(['rev-parse', 'main'])).stdout);
      const advancedBase = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      yield* f.git(['update-ref', 'refs/heads/main', advancedBase]);
      expect(yield* card()).toMatchObject({status: 'ready', next: {action: 'implement', phaseId: 'one'}});
      yield* f.git(['update-ref', 'refs/heads/main', originalBase]);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "revised result";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Revised result']);
      expect(yield* card()).toMatchObject({status: 'ready', next: {action: 'implement', phaseId: 'one'}});
      const reindexed = yield* (yield* CodeGraphIndexer).index({cwd: f.repo, threadnoteHome: f.home});
      expect(reindexed.snapshot.state).toBe('ready');
      const nextWork = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      expect(nextWork.workRef).not.toBe(firstWork.workRef);
      const nextSnapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(nextWork.workRef),
          reason: 'The committed implementation changed after the first accepted review.',
        }),
      );
      expect(nextSnapshot).toMatchObject({status: 'recorded', replayed: false});
      const nextReview = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(nextSnapshot.snapshotRef),
          report: {...report, mode: 'incremental'},
        }),
      );
      expect(nextReview.status).toBe('recorded');
      expect(yield* card()).toMatchObject({next: {action: 'validate'}});
      const validated = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(nextReview.snapshotRef),
          validation: {
            checks: [{command: 'focused fixture check', result: 'passed', evidence: 'The revised source passed.'}],
            acceptance: [{criterion: 'one works', result: 'passed', evidence: 'The revised source works.'}],
          },
        }),
      );
      expect(validated.status).toBe('recorded');
      expect(yield* card()).toMatchObject({next: {action: 'deliver', phaseId: 'one'}});
    }).pipe(run),
  );

  // prettier-ignore
  effectIt.effect('continues a nonterminal P1 watch after P2 advances and closes out both terminal receipts', () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        ['one', 'two'],
        'pr',
        false,
        false,
        true,
        {
          one: {branch: 'feature/one', baseBranch: 'origin/main'},
          two: {branch: 'feature/two', baseBranch: 'feature/one'},
        },
        repo =>
          Effect.gen(function* () {
            yield* runCommandEffect('git', [
              '-C',
              repo,
              'remote',
              'add',
              'origin',
              'https://github.com/example/repo.git',
            ]);
            yield* runCommandEffect('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
          }),
      );
      const prepareOpenPr = (phaseId: 'one' | 'two') =>
        Effect.gen(function* () {
          yield* f.mutate('begin-phase', {phaseId});
          const work = object(
            yield* runNativeTaskAction(f.config, {
              command: 'work',
              runId: 'native-run',
              callerCwd: f.repo,
              packet,
            }),
          );
          return {workRef: String(work.workRef)};
        });
      const commitPhase = (phaseId: 'one' | 'two', workRef: string) =>
        Effect.gen(function* () {
          yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), `export const fixture = "phase ${phaseId}";\n`);
          yield* f.git(['add', 'source.ts']);
          yield* f.git(['commit', '-m', `Phase ${phaseId}`]);
          const snapshot = object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-snapshot',
              runId: 'native-run',
              callerCwd: f.repo,
              workRef,
            }),
          );
          const snapshotRef = String(snapshot.snapshotRef);
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
              findings: [],
            },
          });
          if (phaseId === 'one') yield* f.git(['commit', '--allow-empty', '-m', 'Same-tree P1 build marker']);
          const validation = object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-validation',
              runId: 'native-run',
              callerCwd: f.repo,
              snapshotRef,
              validation: {
                checks: [
                  {command: `phase ${phaseId} check`, result: 'passed', evidence: 'Private simulated check passed.'},
                ],
                acceptance: [
                  {criterion: `${phaseId} works`, result: 'passed', evidence: `Phase ${phaseId} source is committed.`},
                ],
              },
            }),
          );
          const headSha = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
          const pr = {
            url: `https://github.com/example/repo/pull/${phaseId === 'one' ? '21' : '22'}`,
            headSha,
            branch: phaseId === 'one' ? 'feature/one' : 'feature/two',
            baseBranch: phaseId === 'one' ? 'main' : 'feature/one',
            state: 'open' as const,
          };
          const publication = {exemption: 'small-fix' as const, reason: `Private ${phaseId} simulated authority.`};
          const delivered = object(
            yield* runNativeTaskAction(f.config, {
              command: 'deliver-pr',
              runId: 'native-run',
              callerCwd: f.repo,
              validationRef: String(validation.validationRef),
              commitEvidence: `Private simulated commit ${headSha}`,
              pr,
              publication,
            }),
          );
          expect(delivered).toMatchObject({status: 'watch-required', next: {action: 'watch-pr', headSha}});
          return {
            validationRef: String(validation.validationRef),
            deliveryRef: String(delivered.deliveryRef),
            headSha,
            pr,
            publication,
          };
        });

      const p1Work = yield* prepareOpenPr('one');
      const publishedP1 = yield* commitPhase('one', p1Work.workRef);
      const p1Watch = yield* startSimulatedTaskWatch(
        f,
        'native-run',
        'one',
        publishedP1.validationRef,
        publishedP1.deliveryRef,
        publishedP1.pr.url,
      );
      yield* writeSimulatedTaskWatch(f, p1Watch.startedWatch, p1Watch, publishedP1.pr.url, publishedP1.headSha, false);
      const provisionalWatchPath = f.path.join(
        f.config.agentContextHome,
        'workflow-automations',
        'native-watch-v1',
        p1Watch.watchId + '.json',
      );
      const provisionalWatchBytes = yield* f.fs.readFileString(provisionalWatchPath);
      const provisionalWorkflowBytes = yield* f.fs.readFileString(f.statePath());
      const originalSource = yield* f.fs.readFileString(f.path.join(f.repo, 'source.ts'));
      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        `${originalSource}\n// provisional source was revoked before canonical delivery\n`,
      );
      const refusedProvisionalStart = yield* attemptSimulatedTaskWatch(f, 'native-run', 'one', publishedP1.validationRef, publishedP1.deliveryRef, publishedP1.pr.url);
      expect(refusedProvisionalStart.result).toMatchObject({ok: false, failure: {code: 'source-drift'}});
      expect(yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'complete', runId: 'native-run', callerCwd: f.repo,
        validationRef: publishedP1.validationRef, deliveryRef: publishedP1.deliveryRef}).pipe(Effect.result)).toMatchObject({failure: {code: 'source-drift'}});
      expect(object(yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'inspect', runId: 'native-run', callerCwd: f.repo,
        validationRef: publishedP1.validationRef, deliveryRef: publishedP1.deliveryRef}))).toMatchObject({status: 'watch-updated'});
      expect(yield* f.fs.readFileString(provisionalWatchPath)).toBe(provisionalWatchBytes);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(provisionalWorkflowBytes);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), originalSource);
      const p1Open = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: publishedP1.validationRef,
          deliveryRef: publishedP1.deliveryRef,
        }),
      );
      expect(p1Open).toMatchObject({
        status: 'delivered',
        receipt: {pr: {...publishedP1.pr, state: 'open'}, watch: {state: 'active'}},
      });
      const p1Published = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(p1Published?.state.cycle?.state.phases.one).toMatchObject({
        status: 'published',
        delivery: {pr: {state: 'open'}},
      });
      expect(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).toMatchObject({
        status: 'ready',
        next: {action: 'implement', phaseId: 'two'},
        historicalWatches: [{phaseId: 'one', prUrl: publishedP1.pr.url}],
      });
      const p1 = {headSha: publishedP1.headSha, pr: publishedP1.pr};

      yield* f.git(['checkout', '-b', 'feature/two']);
      yield* f.mutate('begin-phase', {phaseId: 'two'});
      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "phase two source changed";\n',
      );
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'P2 source change']);
      const p2Head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      expect(p2Head).not.toBe(p1.headSha);

      // New resume scope: only the run/caller are known; discover P1 and its refs through typed views.
      let recoveredP1 = yield* recoverHistoricalTaskWatch(f, 'native-run');
      expect(recoveredP1.phaseId).toBe('one');
      const p1WatchPath = f.path.join(
        f.config.agentContextHome,
        'workflow-automations',
        'native-watch-v1',
        recoveredP1.watchId + '.json',
      );
      const beforeWrongPhase = yield* f.fs.readFileString(p1WatchPath);
      const beforeBadSelection = yield* f.fs.readFileString(f.statePath());
      const unknownPhase = yield* readNativeTaskView(f.config, {
        runId: 'native-run',
        callerCwd: f.repo,
        phaseId: 'unknown-phase',
      }).pipe(Effect.result);
      expect(unknownPhase).toMatchObject({failure: {code: 'historical-phase-not-found'}});
      const currentPhaseSelection = yield* readNativeTaskView(f.config, {
        runId: 'native-run',
        callerCwd: f.repo,
        phaseId: 'two',
      }).pipe(Effect.result);
      expect(currentPhaseSelection).toMatchObject({failure: {code: 'historical-phase-not-listed'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeBadSelection);
      expect(yield* f.fs.readFileString(p1WatchPath)).toBe(beforeWrongPhase);
      const decodedP1Validation = decodeNativeTaskActionRef(recoveredP1.validationRef);
      if (!decodedP1Validation) throw new Error('Expected the recovered exact P1 validation reference.');
      const wrongPhase = yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'relay',
        noticeRef: recoveredP1.noticeRef,
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: encodeNativeTaskActionRef({
          ...decodedP1Validation,
          phaseId: 'two',
        }),
        deliveryRef: recoveredP1.deliveryRef,
      }).pipe(Effect.result);
      expect(wrongPhase._tag).toBe('Failure');
      expect(
        yield* f.fs.readFileString(
          f.path.join(
            f.config.agentContextHome,
            'workflow-automations',
            'native-watch-v1',
            recoveredP1.watchId + '.json',
          ),
        ),
      ).toBe(beforeWrongPhase);
      const noticeRef = decodeNativeTaskActionRef(recoveredP1.noticeRef);
      if (!noticeRef) throw new Error('Expected the exact recovered P1 notice reference.');
      const foreignConsumer = yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'relay',
        noticeRef: encodeNativeTaskActionRef({...noticeRef, consumerId: noticeRef.consumerId + '-foreign'}),
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: recoveredP1.validationRef,
        deliveryRef: recoveredP1.deliveryRef,
      }).pipe(Effect.result);
      expect(foreignConsumer).toMatchObject({failure: {code: 'foreign-notice-route'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeBadSelection);
      expect(yield* f.fs.readFileString(p1WatchPath)).toBe(beforeWrongPhase);

      const relayed = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'relay',
          noticeRef: recoveredP1.noticeRef,
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: recoveredP1.validationRef,
          deliveryRef: recoveredP1.deliveryRef,
        }),
      );
      expect(relayed).toMatchObject({status: 'watch-updated'});
      const eventRefs: unknown[] = EffectArray.isArray(relayed.eventRefs) ? relayed.eventRefs : [];
      if (typeof eventRefs[0] !== 'string') throw new Error('Expected the historical P1 event reference.');
      const p1WatchDeliveryRef = String(relayed.watchDeliveryRef);
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'disposition',
        watchDeliveryRef: p1WatchDeliveryRef,
        dispositions: [
          {
            eventRef: eventRefs[0],
            status: 'open',
            reason: 'P1 review follow-up remains open.',
            evidence: 'Explicit synthetic watch event disposition.',
          },
        ],
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: recoveredP1.validationRef,
        deliveryRef: recoveredP1.deliveryRef,
      });
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'ack',
        watchDeliveryRef: p1WatchDeliveryRef,
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: recoveredP1.validationRef,
        deliveryRef: recoveredP1.deliveryRef,
      });
      const p1AfterAck = yield* readNativeWatch(f.config, recoveredP1.watchId);
      if (!p1AfterAck) throw new Error('Expected the historical P1 watch readback.');
      const p1Collector = p1AfterAck.envelope.collector;
      if (!p1Collector) throw new Error('Expected the P1 collector terminal record.');
      const p1Terminal = {
        ...p1AfterAck.envelope,
        state: {...p1AfterAck.envelope.state, prState: 'merged' as const},
        collector: {...p1Collector, status: 'terminal' as const, reason: 'merged' as const},
      };
      yield* writeNativeWatch(f.config, p1Terminal, p1AfterAck.revision);
      const p1TerminalReadback = yield* readNativeWatch(f.config, recoveredP1.watchId);
      if (!p1TerminalReadback) throw new Error('Expected the terminal P1 watch readback for join checks.');
      const freshTerminalView = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(freshTerminalView).toMatchObject({
        status: 'ready',
        next: {action: 'implement', phaseId: 'two'},
        historicalWatches: [{phaseId: 'one', prUrl: publishedP1.pr.url}],
      });
      // Resume from only the run and caller after the collector is terminal; task-view must keep
      // exposing the still-published canonical P1 continuation until native completion is recorded.
      recoveredP1 = yield* recoverHistoricalTaskWatch(f, 'native-run');
      expect(recoveredP1.phaseId).toBe('one');
      const refuseHistoricalCompletion = (label: string, code: string) =>
        Effect.gen(function* () {
          const workflowBytes = yield* f.fs.readFileString(f.statePath());
          const watchBytes = yield* f.fs.readFileString(p1WatchPath);
          const result = yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'complete',
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef: recoveredP1.validationRef,
            deliveryRef: recoveredP1.deliveryRef,
          }).pipe(Effect.result);
          expect(result, label).toMatchObject({failure: {code}});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(workflowBytes);
          expect(yield* f.fs.readFileString(p1WatchPath)).toBe(watchBytes);
        });

      const p1ProofBeforeMerge = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.phases
        .one;
      if (p1ProofBeforeMerge?.delivery?.delivery !== 'pr' || !p1ProofBeforeMerge.delivery.pr)
        throw new Error('Expected the canonical open P1 PR receipt before historical completion.');
      const p1CanonicalBaseBinding = p1ProofBeforeMerge.delivery.pr.baseRefBinding;
      expect(p1CanonicalBaseBinding).toMatchObject({
        ref: 'refs/remotes/origin/main',
        remote: 'origin',
        repository: 'https://github.com/example/repo',
      });

      const p1Tree = EffectString.trim((yield* f.git(['rev-parse', p1.headSha + '^{tree}'])).stdout);
      const sameTreeCommit = EffectString.trim(
        (yield* f.git(['commit-tree', p1Tree, '-p', p1.headSha, '-m', 'P1 same-tree identity fixture'])).stdout,
      );
      const historicalBranchMismatches = [
        {name: 'old branch commit changed with its reviewed tree retained', head: sameTreeCommit},
        {name: 'old branch commit and reviewed tree both changed', head: p2Head},
      ];
      for (const mismatch of historicalBranchMismatches) {
        yield* f.git(['update-ref', 'refs/heads/feature/one', mismatch.head, p1.headSha]);
        yield* refuseHistoricalCompletion(mismatch.name, 'source-drift');
        yield* f.git(['update-ref', 'refs/heads/feature/one', p1.headSha, mismatch.head]);
      }

      yield* f.git(['remote', 'set-url', 'origin', 'https://github.com/example/other-repo.git']);
      yield* refuseHistoricalCompletion('canonical base repository mismatch', 'base-ref-unverified');
      yield* f.git(['remote', 'set-url', 'origin', 'https://github.com/example/repo.git']);

      const terminalEnvelope = p1TerminalReadback.envelope;
      const terminalConsumer = terminalEnvelope.state.consumer;
      const terminalNotification = terminalEnvelope.notification;
      if (!terminalConsumer || !terminalNotification)
        throw new Error('Expected P1 terminal consumer and host notification evidence.');
      const noHostReceipt = {
        ...terminalEnvelope,
        notification: {
          ...(({lastReceipt: _lastReceipt, ...rest}) => rest)(terminalNotification),
          outbox: null,
        },
      };
      const incompleteSources = {
        ...terminalEnvelope,
        state: {
          ...terminalEnvelope.state,
          sources: EffectArray.map(terminalEnvelope.state.sources, source => {
            if (source.source !== 'statuses') return source;
            const {lastCompleteAt: _lastCompleteAt, ...incomplete} = source;
            return incomplete;
          }),
        },
      };
      const watchJoinMismatches = [
        {name: 'missing host receipt', envelope: noHostReceipt, code: 'watch-not-ready'},
        {name: 'incomplete historical watch sources', envelope: incompleteSources, code: 'watch-not-ready'},
      ];
      for (const mismatch of watchJoinMismatches) {
        const currentWatch = yield* readNativeWatch(f.config, recoveredP1.watchId);
        if (!currentWatch) throw new Error('Expected P1 watch before a table-driven identity mismatch.');
        const altered = yield* writeNativeWatch(f.config, mismatch.envelope, currentWatch.revision);
        yield* refuseHistoricalCompletion(mismatch.name, mismatch.code);
        const afterRefusal = yield* readNativeWatch(f.config, recoveredP1.watchId);
        if (!afterRefusal) throw new Error('Expected P1 watch after a rejected identity mismatch.');
        yield* writeNativeWatch(f.config, currentWatch.envelope, afterRefusal.revision);
        expect(altered.revision).not.toBe(currentWatch.revision);
      }

      // A legitimate base advancement after P1 merges preserves the canonical ref/repository binding.
      yield* f.git(['update-ref', 'refs/remotes/origin/main', p1.headSha]);
      const p1Merged = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: recoveredP1.validationRef,
          deliveryRef: recoveredP1.deliveryRef,
        }),
      );
      expect(p1Merged).toMatchObject({
        status: 'delivered',
        receipt: {phaseId: 'one', pr: {...p1.pr, state: 'merged'}, watch: {state: 'terminal'}},
      });
      const afterP1Merge = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(afterP1Merge?.state.cycle?.state.phases.one?.status).toBe('merged');
      expect(afterP1Merge?.state.cycle?.state.phases.one?.delivery?.pr?.baseRefBinding).toEqual(p1CanonicalBaseBinding);
      expect(
        (yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).historicalWatches,
      ).toBeUndefined();
      expect(EffectString.trim((yield* f.git(['branch', '--show-current'])).stdout)).toBe('feature/two');
      expect(EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout)).toBe(p2Head);

      const p1WorkflowBytesAfterMerge = yield* f.fs.readFileString(f.statePath());
      const p1WatchBytesAfterMerge = yield* f.fs.readFileString(p1WatchPath);
      const closeoutFile = yield* nativeCloseoutJournalPath(f.config, 'native-run');
      const closeoutBytesAfterMerge = (yield* f.fs.exists(closeoutFile))
        ? yield* f.fs.readFileString(closeoutFile)
        : undefined;
      const historicalP1Replay = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: recoveredP1.validationRef,
          deliveryRef: recoveredP1.deliveryRef,
        }),
      );
      expect(historicalP1Replay).toMatchObject({
        status: 'delivered',
        replayed: true,
        receipt: p1Merged.receipt,
        deliveryRef: p1Merged.deliveryRef,
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(p1WorkflowBytesAfterMerge);
      expect(yield* f.fs.readFileString(p1WatchPath)).toBe(p1WatchBytesAfterMerge);
      expect((yield* f.fs.exists(closeoutFile)) ? yield* f.fs.readFileString(closeoutFile) : undefined).toBe(
        closeoutBytesAfterMerge,
      );
      expect(yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal)).toBeUndefined();

      const p2Work = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      const p2Snapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(p2Work.workRef),
        }),
      );
      const p2SnapshotRef = String(p2Snapshot.snapshotRef);
      yield* runNativeTaskAction(f.config, {
        command: 'record-review',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: p2SnapshotRef,
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
      const p2Validation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: p2SnapshotRef,
          validation: {
            checks: [{command: 'phase two check', result: 'passed', evidence: 'Private P2 simulated check passed.'}],
            acceptance: [{criterion: 'two works', result: 'passed', evidence: 'P2 source is committed.'}],
          },
        }),
      );
      const p2Open = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-pr',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: String(p2Validation.validationRef),
          commitEvidence: `Private simulated commit ${p2Head}`,
          pr: {
            url: 'https://github.com/example/repo/pull/22',
            headSha: p2Head,
            branch: 'feature/two',
            baseBranch: 'feature/one',
            state: 'open',
          },
          publication: {exemption: 'small-fix', reason: 'Private P2 simulated authority.'},
        }),
      );
      const p2ValidationRef = String(p2Validation.validationRef);
      const p2DeliveryRef = String(p2Open.deliveryRef);
      const p2Watch = yield* startSimulatedTaskWatch(
        f,
        'native-run',
        'two',
        p2ValidationRef,
        p2DeliveryRef,
        'https://github.com/example/repo/pull/22',
      );
      yield* writeSimulatedTaskWatch(
        f,
        p2Watch.startedWatch,
        p2Watch,
        'https://github.com/example/repo/pull/22',
        p2Head,
        false,
      );
      const p2Published = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: p2ValidationRef,
          deliveryRef: p2DeliveryRef,
        }),
      );
      expect(p2Published).toMatchObject({
        status: 'delivered',
        receipt: {pr: {state: 'open'}, watch: {state: 'active'}},
      });
      const p2CurrentWatch = yield* readNativeWatch(f.config, p2Watch.watchId);
      if (!p2CurrentWatch) throw new Error('Expected the P2 simulated watch readback.');
      const p2Collector = p2CurrentWatch.envelope.collector;
      if (!p2Collector) throw new Error('Expected the P2 collector terminal record.');
      const p2MergedEnvelope = {
        ...p2CurrentWatch.envelope,
        state: {...p2CurrentWatch.envelope.state, prState: 'merged' as const},
        collector: {...p2Collector, status: 'terminal' as const, reason: 'merged' as const},
      };
      yield* writeNativeWatch(f.config, p2MergedEnvelope, p2CurrentWatch.revision);
      const p2Merged = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: p2ValidationRef,
          deliveryRef: p2DeliveryRef,
        }),
      );
      expect(p2Merged).toMatchObject({
        status: 'delivered',
        receipt: {phaseId: 'two', pr: {state: 'merged'}, watch: {state: 'terminal'}},
      });
      const p2Stored = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(p2Stored?.state.cycle?.state.phases.two?.status).toBe('merged');

      const p1WatchReadback = yield* readNativeWatch(f.config, recoveredP1.watchId);
      if (!p1WatchReadback) throw new Error('Expected the terminal P1 canonical watch.');
      const missingSourceEnvelope = {
        ...p1WatchReadback.envelope,
        state: {
          ...p1WatchReadback.envelope.state,
          sources: EffectArray.filter(p1WatchReadback.envelope.state.sources, item => item.source !== 'statuses'),
        },
      };
      const missingSourceWatch = yield* writeNativeWatch(f.config, missingSourceEnvelope, p1WatchReadback.revision);
      const stateBeforeMissingWatchCloseout = yield* f.fs.readFileString(f.statePath());
      const missingP1WatchCloseout = yield* runNativeTaskAction(f.config, {
        command: 'finish',
        runId: 'native-run',
        callerCwd: f.repo,
        proposal,
      }).pipe(Effect.result);
      expect(missingP1WatchCloseout).toMatchObject({failure: {code: 'finish-scope'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(stateBeforeMissingWatchCloseout);
      yield* writeNativeWatch(f.config, p1WatchReadback.envelope, missingSourceWatch.revision);

      const multiPhaseProposal = {
        ...proposal,
        phaseEvidence: [
          ...proposal.phaseEvidence,
          {id: 'two', acceptance: [{criterion: 'two works', evidence: 'The P2 source was committed and reviewed.'}]},
        ],
      };
      const closeout = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal: multiPhaseProposal,
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(closeout).toMatchObject({status: 'pending', stage: 'prepare'});
      const prepareJobId = decodeNativeTaskActionRef(String(closeout.prepareRef))?.jobId;
      if (!prepareJobId) throw new Error('Expected the exact all-phase closeout prepare job.');
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', prepareJobId, f.call)).status).toBe('completed');
      const journal = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      expect(journal?.state.proposal.watchWork).toMatchObject([
        {eventId: recoveredP1.watchId + ':1', status: 'open', evidence: 'Explicit synthetic watch event disposition.'},
      ]);
      const finishing = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal: multiPhaseProposal,
          prepareRef: String(closeout.prepareRef),
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(finishing).toMatchObject({status: 'pending', stage: 'finish'});
      const finishJobId = decodeNativeTaskActionRef(String(finishing.finishRef))?.jobId;
      if (!finishJobId) throw new Error('Expected the exact all-phase closeout finish job.');
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', finishJobId, f.call)).status).toBe('completed');
      const completed = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          finishRef: String(finishing.finishRef),
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(completed).toMatchObject({status: 'complete'});
      const finalJournal = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      expect(finalJournal?.state.status).toBe('complete');
      expect(finalJournal?.state.proposal.watchWork).toMatchObject([
        {eventId: recoveredP1.watchId + ':1', status: 'open'},
      ]);
      expect((yield* readNativeWatch(f.config, recoveredP1.watchId))?.envelope.state.prState).toBe('merged');
      expect((yield* readNativeWatch(f.config, p2Watch.watchId))?.envelope.state.prState).toBe('merged');
      const finalState = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(finalState?.state.cycle?.state.phases.one?.delivery?.watch).toMatchObject({
        state: 'terminal',
        consumerId: recoveredP1.consumerId,
      });
      expect(finalState?.state.cycle?.state.phases.two?.delivery?.watch).toMatchObject({
        state: 'terminal',
        consumerId: p2Watch.consumerId,
      });
    }).pipe(run),
    windowsRealGitFixtureTimeout,
  );

  effectIt.effect('drains an old binding only after its job and PR watch owner receipts settle', () =>
    Effect.gen(function* () {
      const priorDigest = EffectString.repeat(64)('b');
      const f = yield* fixture(
        ['one'],
        'pr',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {
          generation: priorDigest,
          project: 'repo',
        },
      );
      yield* f.git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
      const system = yield* SystemInfo;
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      const taskConfig = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
      const taskSystem = {...system, currentDirectory: () => repo, homeDirectory: home};
      yield* applyDevSkills(taskConfig, 'install', {agent: 'codex'}).pipe(
        Effect.provideService(SystemInfo, taskSystem),
      );
      const installed = yield* statusDevSkills(taskConfig, {agent: 'codex'}).pipe(
        Effect.provideService(SystemInfo, taskSystem),
      );
      expect(installed.targets[0]?.installedDigest).toBe(installed.bundle.digest);
      expect(priorDigest).not.toBe(installed.bundle.digest);
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const work = object(
        yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "watched PR result";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Watched PR result']);
      const snapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      const snapshotRef = String(snapshot.snapshotRef);
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
          findings: [],
        },
      });
      yield* f.git(['commit', '--allow-empty', '-m', 'Same-tree watch build marker']);
      const validation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          validation: {
            checks: [{command: 'private PR check', result: 'passed', evidence: 'Private test fixture passed.'}],
            acceptance: [
              {criterion: 'one works', result: 'passed', evidence: 'The committed change meets acceptance.'},
            ],
          },
        }),
      );
      const validationRef = String(validation.validationRef);
      const headSha = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      const pr = {
        url: 'https://github.com/example/repo/pull/2',
        headSha,
        branch: 'feature/one',
        baseBranch: 'main',
        state: 'open',
      };
      const publication = {exemption: 'small-fix', reason: 'Private fixture authority input.'};
      const card = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-pr',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          commitEvidence: 'Private fixture commit ' + headSha,
          pr,
          publication,
        }),
      );
      const deliveryRef = String(card.deliveryRef);
      const watchIdentity = EffectString.slice(0, 48)(sha256HexSync('native-run\none'));
      const watchId = 'pr-' + watchIdentity;
      const consumerId = 'task-' + watchIdentity;
      const wakeupId = consumerId;
      const now = yield* Clock.currentTimeMillis;
      const wakeup = {
        host: 'codex' as const,
        executable: '/usr/bin/codex',
        threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      };
      const watchFile = f.path.join(
        f.config.agentContextHome,
        'workflow-automations',
        'native-watch-v1',
        watchId + '.json',
      );
      const missingHost = yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'start',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
      }).pipe(Effect.result);
      expect(missingHost).toMatchObject({failure: {code: 'host-registration-required'}});
      expect(yield* readNativeWatch(f.config, watchId)).toBeUndefined();
      // Process-boundary adapter: simulate a detached collector's startup acknowledgement without
      // launching a process or contacting a provider. This exercises the real task start and watch engine.
      const commands = yield* CommandExecutor;
      const watchSystem = yield* SystemInfo;
      const processAdapterContext = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
      >();
      let spawnCalls = 0;
      let preflightCalls = 0;
      let collectorAlive = true;
      const fakeCommands = CommandExecutor.of({
        ...commands,
        execute: (executable, args, options) => {
          if (executable === wakeup.executable && args.length === 2 && args[0] === 'queue' && args[1] === '--help') {
            preflightCalls += 1;
            return Effect.succeed({
              exitCode: 0,
              stderr: '',
              stdout:
                'Usage: codex queue [OPTIONS]\n\nOptions:\n      --thread <THREAD>\n          Thread UUID\n      --message <MESSAGE>\n          Message body\n',
            });
          }
          return commands.execute(executable, args, options);
        },
        spawnDetached: () =>
          Effect.gen(function* () {
            spawnCalls += 1;
            collectorAlive = true;
            const starting = yield* readNativeWatch(f.config, watchId);
            if (!starting?.envelope.collector) return false;
            yield* writeNativeWatch(
              f.config,
              {
                ...starting.envelope,
                collector: {
                  ...starting.envelope.collector,
                  pid: 77777,
                  startIdentity: 'fixture-process',
                  status: 'running',
                },
              },
              starting.revision,
            );
            return true;
          }).pipe(
            Effect.provide(processAdapterContext),
            Effect.orElseSucceed(() => false),
          ),
      });
      const fakeSystem = SystemInfo.of({
        ...watchSystem,
        isProcessRunning: pid => pid === 77777 && collectorAlive,
        processStartIdentity: () => Effect.succeed(EffectOption.getOrUndefined(EffectOption.none<string>())),
        canonicalProcessStartIdentity: () => Effect.succeed(EffectOption.getOrUndefined(EffectOption.none<string>())),
      });
      const started = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'start',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
          wakeup,
        }).pipe(Effect.provideService(CommandExecutor, fakeCommands), Effect.provideService(SystemInfo, fakeSystem)),
      );
      expect(started).toMatchObject({status: 'watching', watchId, prUrl: pr.url, consumerId, hostReceipt: null});
      expect(spawnCalls).toBe(1);
      expect(preflightCalls).toBe(1);
      let startedWatch = yield* readNativeWatch(f.config, watchId);
      if (!startedWatch) throw new Error('The task watch start did not persist canonical watch state.');
      expect(startedWatch.envelope.state.pr).toBe(pr.url);
      expect(startedWatch.envelope.state.consumer).toMatchObject({id: consumerId, wakeupId});
      expect(startedWatch.envelope.notification?.target).toEqual(wakeup);
      expect(startedWatch.envelope.collector).toMatchObject({status: 'running', pid: 77777});
      const provisionalState = yield* readNativeWorkflowState(taskConfig, 'native-run');
      expect(provisionalState?.state.cycle?.state.phases.one?.delivery).toBeUndefined();
      const recoveryInput = {runId: 'native-run', callerCwd: repo, phaseId: 'one'};
      const watchBytesBeforeRecovery = yield* f.fs.readFileString(watchFile);
      const foreignRecovery = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(foreignRecovery, taskConfig);
      const foreignResult = yield* foreignRecovery
        .invokeTool('workflow_task_watch_pr', {
          ...recoveryInput,
          runId: 'foreign-run',
          operation: 'inspect',
        })
        .pipe(Effect.result);
      expect(foreignResult._tag).toBe('Failure');
      expect(yield* f.fs.readFileString(watchFile)).toBe(watchBytesBeforeRecovery);
      const wrongPhaseResult = yield* foreignRecovery
        .invokeTool('workflow_task_watch_pr', {
          ...recoveryInput,
          phaseId: 'foreign-phase',
          operation: 'stop',
        })
        .pipe(Effect.result);
      expect(wrongPhaseResult._tag).toBe('Failure');
      expect(yield* f.fs.readFileString(watchFile)).toBe(watchBytesBeforeRecovery);
      const freshInspect = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(freshInspect, taskConfig);
      const inspected = object(
        object(
          yield* freshInspect.invokeTool('workflow_task_watch_pr', {
            ...recoveryInput,
            operation: 'inspect',
          }),
        ).structuredContent,
      );
      expect(inspected).toMatchObject({status: 'watch-updated', operation: 'inspect', watchId});
      expect(yield* f.fs.readFileString(watchFile)).toBe(watchBytesBeforeRecovery);
      const freshStop = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(freshStop, taskConfig);
      const stopped = object(
        object(
          yield* freshStop.invokeTool('workflow_task_watch_pr', {
            ...recoveryInput,
            operation: 'stop',
          }),
        ).structuredContent,
      );
      expect(stopped).toMatchObject({status: 'watch-updated', operation: 'stop', watchId});
      startedWatch = yield* readNativeWatch(f.config, watchId);
      expect(startedWatch?.envelope.stopRequested).toBe(true);
      if (!startedWatch) throw new Error('The recovered provisional watch disappeared.');
      const cutoverMcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(cutoverMcp, taskConfig);
      const cutoverInput = {
        callerCwd: repo,
        featureName: 'feature',
        installationTarget: 'codex',
        taskRef: 'native-run',
        intent: {
          title: 'feature',
          currentBehavior: 'The old run remains inspectable.',
          desiredChange: 'The old run receives an explicit drain outcome.',
          affectedPaths: ['source.ts'],
          acceptanceCriterion: 'The old binding and canonical history remain unchanged.',
          verification: 'Read the transition outcome and exact watch owner.',
          eligibilityRationale: 'One fixture task validates a bounded safe cutover.',
          eligibility: {status: 'eligible' as const},
          review: {required: false, reason: 'Private cutover fixture.'},
        },
      };
      const observeCutover = () =>
        Effect.gen(function* () {
          const response = object(
            yield* cutoverMcp
              .invokeTool('workflow_task_start', cutoverInput)
              .pipe(Effect.provideService(SystemInfo, fakeSystem)),
          );
          if (response.isError === true) throw new Error('The typed task-start cutover read was refused.');
          return object(response.structuredContent);
        });
      const provisionalRunBytes = yield* f.fs.readFileString(f.statePath());
      const provisionalOwners = yield* observeCutover();
      expect(provisionalOwners).toMatchObject({status: 'binding-transition', outcome: 'needs-drain'});
      expect(provisionalOwners.owners).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            owner: 'watch',
            watchId,
            status: 'needs-drain',
            reasons: expect.arrayContaining(['collector-still-owned-or-unverifiable']),
          }),
        ]),
      );
      expect(yield* f.fs.readFileString(f.statePath())).toBe(provisionalRunBytes);
      const event = {
        sequence: 1,
        id: watchId + ':1',
        source: 'comments' as const,
        kind: 'comment',
        key: 'comment-1',
        version: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        url: pr.url,
        at: now,
        removed: false,
      };
      const attemptId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
      const receiptId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      const initialSources = EffectArray.map(
        ['comments', 'reviews', 'threads', 'checks', 'statuses'] as const,
        source => ({source, items: [], lastCompleteAt: now}),
      );
      yield* writeNativeWatch(
        f.config,
        {
          ...startedWatch.envelope,
          state: {
            ...startedWatch.envelope.state,
            head: headSha,
            prState: 'open',
            nextSequence: 2,
            acknowledged: 0,
            events: [event],
            sources: initialSources,
          },
          notification: {
            ...startedWatch.envelope.notification!,
            lastConsumerAt: now,
            outbox: {
              key: watchId + ':1:1',
              first: 1,
              last: 1,
              createdAt: now,
              attempts: 1,
              nextAttemptAt: now,
              attemptId,
              collectorToken: startedWatch.envelope.collector!.token,
              status: 'queued',
              receipt: receiptId,
              consumedThrough: 0,
            },
          },
        },
        startedWatch.revision,
      );
      startedWatch = yield* readNativeWatch(f.config, watchId);
      if (!startedWatch) throw new Error('The simulated host and provider input did not persist the open PR watch.');
      const openDelivery = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
        }).pipe(Effect.provideService(SystemInfo, fakeSystem)),
      );
      expect(openDelivery).toMatchObject({
        status: 'delivered',
        receipt: {delivery: 'pr', pr: {...pr, state: 'open'}, watch: {state: 'active', consumerId}},
      });

      const root = object(object(f.exported.source).root);
      const acceptedJob = object(
        yield* f
          .call({
            ...f.base('job'),
            command: 'submit',
            work: {
              ...f.base('authoring'),
              command: 'save',
              document: f.document,
              ready: true,
              uri: root.uri,
              expectedRevision: root.revision,
            },
          })
          .pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(acceptedJob.status).toBe('accepted');
      const jobId = String(acceptedJob.jobId);
      const oldRunBytes = yield* f.fs.readFileString(f.statePath());
      const beforeOwnerDrain = yield* observeCutover();
      expect(beforeOwnerDrain).toMatchObject({
        status: 'binding-transition',
        outcome: 'needs-drain',
        binding: {generation: priorDigest},
      });
      expect(beforeOwnerDrain.owners).toEqual(
        expect.arrayContaining([
          expect.objectContaining({owner: 'job', jobId, status: 'accepted'}),
          expect.objectContaining({owner: 'watch', watchId, status: 'needs-drain'}),
        ]),
      );
      expect(yield* f.fs.readFileString(f.statePath())).toBe(oldRunBytes);

      const cancelAcceptedJob = object(yield* f.call({...f.base('job'), command: 'cancel', jobId}));
      expect(cancelAcceptedJob.stopRequested).toBe(true);
      const afterCancelOnly = yield* observeCutover();
      expect(afterCancelOnly.outcome).toBe('needs-drain');
      expect(afterCancelOnly.owners).toEqual(
        expect.arrayContaining([expect.objectContaining({owner: 'job', jobId, stopRequested: true})]),
      );
      const stoppedJob = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(stoppedJob.status).toBe('stopped-with-progress');
      const stoppedJobStatus = object(yield* f.call({...f.base('job'), command: 'status', jobId}));
      expect(stoppedJobStatus.status).toBe('stopped-with-progress');
      const stoppedJobOutcome = yield* observeCutover();
      expect(stoppedJobOutcome.outcome).toBe('needs-drain');
      expect(stoppedJobOutcome.owners).toEqual(
        expect.arrayContaining([expect.objectContaining({owner: 'job', jobId, status: 'stopped-with-progress'})]),
      );

      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'stop',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
      }).pipe(Effect.provideService(SystemInfo, fakeSystem));
      const stopRequestedWatch = yield* readNativeWatch(f.config, watchId);
      if (!stopRequestedWatch) throw new Error('The stopped watch receipt disappeared.');
      expect(stopRequestedWatch.envelope.stopRequested).toBe(true);
      collectorAlive = false;
      // The fake owned collector observes stop and persists its stopped receipt; no real process is signaled.
      yield* writeNativeWatch(
        f.config,
        {
          ...stopRequestedWatch.envelope,
          collector: {...stopRequestedWatch.envelope.collector!, status: 'stopped', reason: 'stop-requested'},
        },
        stopRequestedWatch.revision,
      );
      const stoppedCollector = yield* readNativeWatch(f.config, watchId);
      expect(stoppedCollector?.envelope.collector?.status).toBe('stopped');
      const stopObservedOutcome = yield* observeCutover();
      expect(stopObservedOutcome.outcome).toBe('needs-drain');
      expect(stopObservedOutcome.owners).toEqual(
        expect.arrayContaining([
          expect.objectContaining({owner: 'watch', watchId, status: 'needs-drain'}),
          expect.objectContaining({owner: 'job', jobId, status: 'stopped-with-progress'}),
        ]),
      );

      const resumedJob = object(
        yield* f
          .call({...f.base('job'), command: 'resume', jobId})
          .pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(resumedJob.status).toBe('accepted');
      const completedJob = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(completedJob.status).toBe('completed');
      const completedJobReadback = object(yield* f.call({...f.base('job'), command: 'result', jobId}));
      expect(completedJobReadback.status).toBe('completed');
      expect(completedJobReadback).toHaveProperty('result');
      collectorAlive = false;
      const stoppedWatchContinuation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'start',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
          wakeup,
        }).pipe(Effect.provideService(CommandExecutor, fakeCommands), Effect.provideService(SystemInfo, fakeSystem)),
      );
      expect(stoppedWatchContinuation.status).toBe('watching');
      expect(spawnCalls).toBe(2);
      startedWatch = yield* readNativeWatch(f.config, watchId);
      if (!startedWatch) throw new Error('The continued task watch did not persist its owner receipt.');
      const continuedOutcome = yield* observeCutover();
      expect(continuedOutcome.outcome).toBe('needs-drain');
      expect(continuedOutcome.owners).toEqual(
        expect.arrayContaining([expect.objectContaining({owner: 'watch', watchId, status: 'needs-drain'})]),
      );
      const state = {
        ...startedWatch.envelope.state,
        head: headSha,
        prState: 'merged' as const,
        nextSequence: 2,
        acknowledged: 0,
        events: [event],
        sources: EffectArray.map(['comments', 'reviews', 'threads', 'checks', 'statuses'] as const, source => ({
          source,
          items: [],
          lastCompleteAt: now,
        })),
      };
      // Test-only host adapter receipt: this fixture never contacts GitHub or an external host.
      collectorAlive = false;
      yield* writeNativeWatch(
        f.config,
        {
          ...startedWatch.envelope,
          state,
          collector: {
            ...startedWatch.envelope.collector!,
            status: 'terminal',
            reason: 'merged',
            consecutiveErrors: 0,
          },
          notification: {
            consumerId,
            wakeupId,
            target: wakeup,
            notifiedThrough: 0,
            lastConsumerAt: now,
            outbox: {
              key: watchId + ':1:1',
              first: 1,
              last: 1,
              createdAt: now,
              attempts: 1,
              nextAttemptAt: now,
              attemptId,
              collectorToken: startedWatch.envelope.collector!.token,
              status: 'queued',
              receipt: receiptId,
              consumedThrough: 0,
            },
          },
        },
        startedWatch.revision,
      );
      const before = yield* f.fs.readFileString(f.statePath());
      const taskState = yield* readNativeWorkflowState(f.config, 'native-run');
      if (!taskState) throw new Error('Expected a current native task.');
      const beforeForeignHost = yield* f.fs.readFileString(watchFile);
      const foreignHost = yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'start',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
        wakeup: {...wakeup, threadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'},
      }).pipe(
        Effect.provideService(CommandExecutor, fakeCommands),
        Effect.provideService(SystemInfo, fakeSystem),
        Effect.result,
      );
      expect(foreignHost).toMatchObject({failure: {code: 'wakeup-recovery-required'}});
      expect(yield* f.fs.readFileString(watchFile)).toBe(beforeForeignHost);
      const noticeRef = encodeNativeTaskActionRef({
        version: 1,
        kind: 'delivery',
        runId: 'native-run',
        generationHash: sha256HexSync(taskState.state.generation),
        watchId,
        consumerId,
        wakeupId,
        eventKey: watchId + ':1:1',
        watchAttemptId: attemptId,
      });
      const beforeForeignNotice = yield* f.fs.readFileString(watchFile);
      const foreignNotice = encodeNativeTaskActionRef({
        version: 1,
        kind: 'delivery',
        runId: 'native-run',
        generationHash: sha256HexSync(taskState.state.generation),
        watchId,
        consumerId,
        wakeupId,
        eventKey: watchId + ':2:2',
        watchAttemptId: attemptId,
      });
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'relay',
          noticeRef: foreignNotice,
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'foreign-notice-route'}});
      expect(yield* f.fs.readFileString(watchFile)).toBe(beforeForeignNotice);
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const relayed = object(
        object(
          yield* mcp.invokeTool('workflow_task_watch_pr', {
            operation: 'relay',
            noticeRef,
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef,
            deliveryRef,
          }),
        ).structuredContent,
      );
      expect(relayed).toMatchObject({
        status: 'watch-updated',
        result: {delivery: {id: expect.any(String), events: [{id: watchId + ':1'}]}},
        eventRefs: [expect.any(String)],
      });
      const watchDeliveryRef = String(relayed.watchDeliveryRef);
      const eventRefs: unknown[] = EffectArray.isArray(relayed.eventRefs) ? relayed.eventRefs : [];
      if (typeof eventRefs[0] !== 'string') throw new Error('Expected an opaque event reference.');
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'disposition',
        watchDeliveryRef,
        dispositions: [
          {
            eventRef: eventRefs[0],
            status: 'open',
            reason: 'Review follow-up remains open.',
            evidence: 'Private fixture event.',
          },
        ],
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
      });
      const acked = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'ack',
          watchDeliveryRef,
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
        }),
      );
      expect(acked.status).toBe('watch-updated');
      let afterAck = yield* readNativeWatch(f.config, watchId);
      expect(afterAck?.envelope.state.work).toMatchObject([{eventId: watchId + ':1', status: 'open'}]);
      expect(afterAck?.envelope.state.acknowledged).toBe(1);
      expect(afterAck?.envelope.notification?.outbox).toMatchObject({
        status: 'queued',
        receipt: receiptId,
        consumedThrough: 1,
      });
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'work-disposition',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
        watchDeliveryRef,
        dispositions: [
          {
            eventRef: String(eventRefs[0]),
            status: 'open',
            reason: 'Review follow-up remains open.',
            evidence: 'Private fixture event.',
          },
        ],
      });
      afterAck = yield* readNativeWatch(f.config, watchId);
      if (!afterAck) throw new Error('Expected the ACKed watch.');
      // Simulate another provider page, then retain its rows through the public task protocol.
      const expectedIds = Array.from({length: 19}, (_, index) => watchId + ':' + (index + 1));
      const largeReason = EffectString.repeat(256)('"\\é猫');
      const largeEvidence = EffectString.repeat(512)('😀\\n');
      yield* writeNativeWatch(
        f.config,
        {
          ...afterAck.envelope,
          notification: {
            ...afterAck.envelope.notification!,
            // The fake collector finalizes the first actual host receipt after notice readback and ACK.
            notifiedThrough: 1,
            lastReceipt: {key: watchId + ':1:1', receipt: receiptId, attemptId, kind: 'queued-message', at: now},
            outbox: {
              ...afterAck.envelope.notification!.outbox!,
              key: watchId + ':2:19',
              attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              receipt: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              first: 2,
              last: 19,
              consumedThrough: 0,
            },
          },
          state: {
            ...afterAck.envelope.state,
            nextSequence: 20,
            events: EffectArray.map(expectedIds.slice(1), (id, index) => ({
              ...event,
              id,
              sequence: index + 2,
              key: 'comment-' + (index + 2),
              ...(index === 0 ? {url: 'https://github.com/acme/repo/issues/1#' + EffectString.repeat(1980)('x')} : {}),
            })),
          },
        },
        afterAck.revision,
      );
      const watchRequest = {runId: 'native-run', callerCwd: f.repo, validationRef, deliveryRef};
      const arrival = object(
        yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'inspect', ...watchRequest}),
      );
      for (;;) {
        const relay = object(
          yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'relay',
            ...watchRequest,
            noticeRef: String(arrival.noticeRef),
          }),
        );
        const refs = relay.eventRefs;
        if (!EffectArray.isArray(refs) || !refs.length) break;
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'disposition',
          ...watchRequest,
          watchDeliveryRef: String(relay.watchDeliveryRef),
          dispositions: EffectArray.map(refs, ref => ({
            eventRef: String(ref),
            status: 'blocked',
            reason:
              decodeNativeTaskActionRef(String(ref))?.watchEventId === expectedIds[1]
                ? largeReason
                : 'Retained follow-up',
            evidence:
              decodeNativeTaskActionRef(String(ref))?.watchEventId === expectedIds[1]
                ? largeEvidence
                : 'Fixture provider page',
          })),
        });
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'ack',
          ...watchRequest,
          watchDeliveryRef: String(relay.watchDeliveryRef),
        });
      }
      const settled = yield* readNativeWatch(f.config, watchId);
      if (!settled) throw new Error('Expected the retained work.');
      // A stopped collector must not prevent retained work resolution or be relaunched by it.
      yield* writeNativeWatch(
        f.config,
        {...settled.envelope, collector: {...settled.envelope.collector!, status: 'stopped'}},
        settled.revision,
      );
      const spawnsBeforeWork = spawnCalls;
      const seen: string[] = [];
      let workOffset = 0;
      let workViewDigest: string | undefined;
      let retainedRef = '';
      let detailContinuation: Record<string, unknown> | undefined;
      let pageCount = 0;
      for (;;) {
        const response = object(
          yield* mcp.invokeTool('workflow_task_watch_pr', {
            operation: 'work',
            ...watchRequest,
            workOffset,
            ...(workViewDigest ? {workViewDigest} : {}),
          }),
        );
        expect(response.isError).not.toBe(true);
        const content = object(response.structuredContent);
        expect(new TextEncoder().encode(JSON.stringify(content)).byteLength).toBeLessThanOrEqual(8192);
        const page = object(object(content.result).work);
        workViewDigest = String(page.workViewDigest);
        const rows = EffectArray.isArray(page.items) ? page.items : [];
        for (const row of rows) {
          const item = object(row);
          seen.push(String(item.eventId));
          if (!retainedRef) retainedRef = String(item.eventRef);
          if (item.eventId === expectedIds[1]) detailContinuation = object(item.detail);
        }
        pageCount += 1;
        if (page.nextOffset === null) break;
        workOffset = Number(page.nextOffset);
      }
      let cliPage: Record<string, unknown> | undefined;
      const workCli = Command.make('workflow-automation').pipe(
        Command.withSubcommands([
          makeNativeTaskPrWatchCommand(options =>
            runNativeTaskAction(f.config, {
              command: 'watch-pr',
              ...watchRequest,
              operation: options.operation,
              ...(options.workOffset === undefined ? {} : {workOffset: options.workOffset}),
              ...(options.workViewDigest === undefined ? {} : {workViewDigest: options.workViewDigest}),
              ...(options.workEventRef === undefined ? {} : {workEventRef: options.workEventRef}),
              ...(options.offsetBytes === undefined ? {} : {offsetBytes: options.offsetBytes}),
              ...(options.sourceDigest === undefined ? {} : {sourceDigest: options.sourceDigest}),
            }).pipe(
              Effect.tap(value =>
                Effect.sync(() => {
                  cliPage = object(value);
                }),
              ),
              Effect.asVoid,
            ),
          ),
        ]),
      );
      yield* Command.runWith(workCli, {version: 'fixture'})([
        'watch-pr',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--operation',
        'work',
        '--work-offset',
        '1',
        '--work-view-digest',
        String(workViewDigest),
      ]);
      expect(object(object(cliPage?.result).work).offset).toBe(1);
      expect(pageCount).toBeGreaterThan(1);
      expect(seen).toEqual(expectedIds);
      if (!detailContinuation) throw new Error('Expected an executable retained work detail continuation.');
      expect(detailContinuation).toEqual({
        operation: 'work-detail',
        workEventRef: expect.any(String),
        offsetBytes: 0,
        sourceDigest: expect.any(String),
      });
      const expectedDetailRow = EffectOption.getOrThrow(
        EffectArray.findFirst(settled.envelope.state.work, row => row.eventId === expectedIds[1]),
      );
      const expectedDetailText = stableJson(expectedDetailRow);
      const expectedDetailBytes = new TextEncoder().encode(expectedDetailText);
      const beforeDetails = yield* f.fs.readFileString(watchFile);
      const chunks: string[] = [];
      let continuation = detailContinuation;
      let detailPageCount = 0;
      for (;;) {
        let content: Record<string, unknown>;
        if (detailPageCount % 2 === 0) {
          const response = object(yield* mcp.invokeTool('workflow_task_watch_pr', {...watchRequest, ...continuation}));
          expect(response.isError).not.toBe(true);
          content = object(response.structuredContent);
        } else {
          yield* Command.runWith(workCli, {version: 'fixture'})([
            'watch-pr',
            '--run-id',
            'native-run',
            '--caller-cwd',
            f.repo,
            '--operation',
            String(continuation.operation),
            '--work-event-ref',
            String(continuation.workEventRef),
            '--offset-bytes',
            String(continuation.offsetBytes),
            '--source-digest',
            String(continuation.sourceDigest),
          ]);
          content = object(cliPage);
        }
        expect(new TextEncoder().encode(JSON.stringify(content)).byteLength).toBeLessThanOrEqual(8192);
        const page = object(object(content.result).workDetail);
        expect(page.sourceDigest).toBe(sha256HexSync(expectedDetailText));
        expect(page.totalBytes).toBe(expectedDetailBytes.byteLength);
        expect(page.offsetBytes).toBe(continuation.offsetBytes);
        const text = String(page.text);
        chunks.push(text);
        const end = Number(page.offsetBytes) + new TextEncoder().encode(text).byteLength;
        expect(
          new TextDecoder('utf-8', {fatal: true}).decode(expectedDetailBytes.subarray(Number(page.offsetBytes), end)),
        ).toBe(text);
        detailPageCount += 1;
        if (page.nextOffsetBytes === null) {
          expect(end).toBe(expectedDetailBytes.byteLength);
          break;
        }
        expect(page.nextOffsetBytes).toBe(end);
        continuation = {...continuation, offsetBytes: page.nextOffsetBytes, sourceDigest: page.sourceDigest};
      }
      expect(detailPageCount).toBeGreaterThan(2);
      expect(EffectArray.join(chunks, '')).toBe(expectedDetailText);
      expect(JSON.parse(EffectArray.join(chunks, ''))).toEqual(expectedDetailRow);
      expect(yield* f.fs.readFileString(watchFile)).toBe(beforeDetails);
      expect(spawnCalls).toBe(spawnsBeforeWork);
      const detailRef = decodeNativeTaskActionRef(String(detailContinuation.workEventRef));
      if (!detailRef) throw new Error('Expected the returned opaque detail row reference.');
      const splitOffset = EffectOption.getOrThrow(
        EffectArray.findFirstIndex(Array.from(expectedDetailBytes), byte => (byte & 0xc0) === 0x80),
      );
      for (const invalid of [
        {...detailContinuation, sourceDigest: EffectString.repeat(64)('a')},
        {...detailContinuation, offsetBytes: expectedDetailBytes.byteLength + 1},
        {...detailContinuation, offsetBytes: splitOffset},
        {...detailContinuation, workEventRef: encodeNativeTaskActionRef({...detailRef, consumerId: 'foreign'})},
        {
          ...detailContinuation,
          workEventRef: encodeNativeTaskActionRef({...detailRef, workViewDigest: EffectString.repeat(64)('a')}),
        },
      ]) {
        expect(
          (yield* mcp.invokeTool('workflow_task_watch_pr', {...watchRequest, ...invalid}).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(yield* f.fs.readFileString(watchFile)).toBe(beforeDetails);
      }
      const beforeInvalid = yield* f.fs.readFileString(watchFile);
      const ref = decodeNativeTaskActionRef(retainedRef);
      if (!ref) throw new Error('Expected a returned retained work reference.');
      const disposition = {
        eventRef: retainedRef,
        status: 'resolved' as const,
        reason: 'Settled follow-up',
        evidence: 'Fixture handled',
      };
      for (const dispositions of [
        [{...disposition, reason: 'Invalid\ncontrol'}],
        [disposition, disposition],
        [disposition, {...disposition, eventRef: String(eventRefs[0])}],
        [disposition, {...disposition, eventRef: encodeNativeTaskActionRef({...ref, consumerId: 'foreign'})}],
        [
          disposition,
          {...disposition, eventRef: encodeNativeTaskActionRef({...ref, workViewDigest: EffectString.repeat(64)('a')})},
        ],
      ]) {
        expect(
          (yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'work-disposition',
            ...watchRequest,
            dispositions,
          }).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(yield* f.fs.readFileString(watchFile)).toBe(beforeInvalid);
      }
      const beforeExpiry = yield* readNativeWatch(f.config, watchId);
      if (!beforeExpiry?.envelope.state.consumer) throw new Error('Expected the bound consumer.');
      const liveConsumer = beforeExpiry.envelope.state.consumer;
      yield* writeNativeWatch(
        f.config,
        {
          ...beforeExpiry.envelope,
          state: {
            ...beforeExpiry.envelope.state,
            consumer: {...liveConsumer, lastSeenAt: 0, leaseUntil: liveConsumer.leaseMilliseconds},
          },
        },
        beforeExpiry.revision,
      );
      const expiredBytes = yield* f.fs.readFileString(watchFile);
      const expiredDetail = object(
        yield* mcp.invokeTool('workflow_task_watch_pr', {...watchRequest, ...detailContinuation}),
      );
      expect(expiredDetail.isError).not.toBe(true);
      expect(yield* f.fs.readFileString(watchFile)).toBe(expiredBytes);
      expect(
        (yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'work-disposition',
          ...watchRequest,
          dispositions: [disposition],
        }).pipe(Effect.result))._tag,
      ).toBe('Failure');
      expect(yield* f.fs.readFileString(watchFile)).toBe(expiredBytes);
      const expiredWatch = yield* readNativeWatch(f.config, watchId);
      if (!expiredWatch) throw new Error('Expected the expired watch.');
      yield* writeNativeWatch(
        f.config,
        {...expiredWatch.envelope, state: {...expiredWatch.envelope.state, consumer: liveConsumer}},
        expiredWatch.revision,
      );
      // Collector-only revision changes do not stale an otherwise identical complete work view.
      const collectorChurn = yield* readNativeWatch(f.config, watchId);
      if (!collectorChurn) throw new Error('Expected watch before collector churn.');
      yield* writeNativeWatch(
        f.config,
        {
          ...collectorChurn.envelope,
          metrics: {
            ...collectorChurn.envelope.metrics,
            consumerReads: collectorChurn.envelope.metrics.consumerReads + 1,
          },
        },
        collectorChurn.revision,
      );
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'work-disposition',
        ...watchRequest,
        dispositions: [disposition],
      });
      const beforeStale = yield* f.fs.readFileString(watchFile);
      expect(
        (yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'work',
          ...watchRequest,
          workOffset: 1,
          workViewDigest,
        }).pipe(Effect.result))._tag,
      ).toBe('Failure');
      expect(
        (yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'work-disposition',
          ...watchRequest,
          dispositions: [disposition],
        }).pipe(Effect.result))._tag,
      ).toBe('Failure');
      expect(yield* f.fs.readFileString(watchFile)).toBe(beforeStale);
      expect(
        (yield* mcp.invokeTool('workflow_task_watch_pr', {...watchRequest, ...detailContinuation}).pipe(Effect.result))
          ._tag,
      ).toBe('Failure');
      expect(yield* f.fs.readFileString(watchFile)).toBe(beforeStale);
      // Read each fresh view after mutation and settle the remaining rows without a delivery ID.
      for (;;) {
        const content = object(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'work', ...watchRequest}),
        );
        const page = object(object(content.result).work);
        const rows = EffectArray.filter(
          EffectArray.isArray(page.items) ? page.items : [],
          row => object(row).status === 'open' || object(row).status === 'blocked',
        );
        if (!rows.length) break;
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'work-disposition',
          ...watchRequest,
          dispositions: EffectArray.map(rows, row => ({...disposition, eventRef: String(object(row).eventRef)})),
        });
      }
      expect(
        EffectArray.every(
          (yield* readNativeWatch(f.config, watchId))?.envelope.state.work ?? [],
          row => row.status === 'resolved',
        ),
      ).toBe(true);
      expect(spawnCalls).toBe(spawnsBeforeWork);
      const afterWork = yield* readNativeWatch(f.config, watchId);
      if (!afterWork) throw new Error('Expected the settled watch.');
      yield* writeNativeWatch(
        f.config,
        {...afterWork.envelope, collector: settled.envelope.collector},
        afterWork.revision,
      );
      const cycleBeforeSourceDrift = yield* f.fs.readFileString(f.statePath());
      const watchBeforeSourceDrift = yield* f.fs.readFileString(watchFile);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "drifted after watch";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'published branch source drift']);
      const sourceDrift = yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'complete',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
      }).pipe(Effect.result);
      expect(sourceDrift._tag).toBe('Failure');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(cycleBeforeSourceDrift);
      expect(yield* f.fs.readFileString(watchFile)).toBe(watchBeforeSourceDrift);
      yield* f.git(['reset', '--hard', headSha]);
      const completed = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
        }),
      );
      expect(completed).toMatchObject({
        status: 'delivered',
        receipt: {
          delivery: 'pr',
          pr: {...pr, state: 'merged'},
          publication,
          watch: {prUrl: pr.url, headSha, state: 'terminal', consumerId},
        },
      });
      expect(yield* f.fs.readFileString(f.statePath())).not.toBe(before);
      const stored = yield* readNativeWatch(f.config, watchId);
      expect(stored?.envelope.state.pr).toBe(pr.url);
      expect(stored?.envelope.state.head).toBe(headSha);
      expect(stored?.envelope.state.consumer?.id).toBe(consumerId);
      collectorAlive = false;
      const drainedInputBytes = yield* f.fs.readFileString(f.statePath());
      const drainedJournalBytes = yield* f.fs.readFileString(f.journalPath(taskState.state.bindingId));
      const beforeDrainedState = yield* readNativeWorkflowState(taskConfig, 'native-run');
      const drained = yield* observeCutover();
      expect(drained).toMatchObject({
        status: 'binding-transition',
        outcome: 'drained',
        binding: {
          runId: 'native-run',
          generation: priorDigest,
          bindingId: taskState.state.bindingId,
        },
        selectedTarget: {installedDigest: installed.bundle.digest},
        owners: [],
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(drainedInputBytes);
      expect(yield* f.fs.readFileString(f.journalPath(taskState.state.bindingId))).toBe(drainedJournalBytes);
      const afterDrainedState = yield* readNativeWorkflowState(taskConfig, 'native-run');
      expect(afterDrainedState?.state.generation).toBe(priorDigest);
      expect(afterDrainedState?.state.bindingId).toBe(taskState.state.bindingId);
      expect(afterDrainedState?.state.operations).toEqual(beforeDrainedState?.state.operations);
      expect(yield* observeCutover()).toEqual(drained);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(drainedInputBytes);
      expect(stored?.envelope.notification?.outbox?.receipt).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      const closeout = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal,
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(closeout).toMatchObject({status: 'pending', stage: 'prepare'});
      const prepareJobId = decodeNativeTaskActionRef(String(closeout.prepareRef))?.jobId;
      if (!prepareJobId) throw new Error('Expected an opaque closeout prepare reference.');
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', prepareJobId, f.call)).status).toBe('completed');
      const journal = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      expect(journal?.state.proposal.watchWork).toEqual([]);
      const finishing = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal,
          prepareRef: String(closeout.prepareRef),
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(finishing).toMatchObject({status: 'pending', stage: 'finish'});
      const finishJobId = decodeNativeTaskActionRef(String(finishing.finishRef))?.jobId;
      if (!finishJobId) throw new Error('Expected an opaque closeout finish reference.');
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', finishJobId, f.call)).status).toBe('completed');
      const closeoutCompleted = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          finishRef: String(finishing.finishRef),
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(closeoutCompleted).toMatchObject({status: 'complete'});
      const closed = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      expect(closed?.state.status).toBe('complete');
      expect(closed?.state.proposal.watchWork).toEqual([]);
      const terminal = yield* readNativeWatch(f.config, watchId);
      if (!terminal) throw new Error('Expected a terminal canonical watch.');
      const empty = {...terminal.envelope, state: {...terminal.envelope.state, work: []}};
      yield* writeNativeWatch(f.config, empty, terminal.revision);
      const terminalBytes = yield* f.fs.readFileString(watchFile);
      for (const operation of ['relay', 'ack', 'disposition'] as const) {
        const result = object(
          yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation,
            watchDeliveryRef,
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef,
            deliveryRef,
          }),
        );
        expect(result.status).toBe('terminal-empty');
        expect(yield* f.fs.readFileString(watchFile)).toBe(terminalBytes);
      }
    }).pipe(run, provideTestLayer(cliTestLayer)),
  );

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
  effectIt.effect('records a canonical snapshot and review with exact replay after source drift', () =>
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
        guidance: 'Choose local, commit, or pr to match the approved plan.',
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
