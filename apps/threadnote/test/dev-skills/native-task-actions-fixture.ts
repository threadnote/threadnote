import {Array as EffectArray, Effect, FileSystem, Layer, Path, Stdio, Terminal, Tracer} from 'effect';
import * as Clock from 'effect/Clock';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {ChildProcessSpawner} from 'effect/process';
import {SecureRandom} from 'effect/crypto';
import {expect} from 'vitest';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import {CommandExecutor} from '@threadnote/platform/command';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {runNativeTaskAction as runNativeTaskActionCore} from '../../src/workflow_automation/task_actions.js';
import {readNativeWatch, writeNativeWatch} from '../../src/workflow_automation/watch_store.js';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {runNativeJobWorker} from '../../src/workflow_automation/native_jobs.js';
import {readNativeCloseoutJournal} from '../../src/workflow_automation/closeout_store.js';
import {decodeJournal} from '../../src/workflow_automation/closeout_request_schema.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';
import {fixture as sourceFixture, object, windowsCycleFixtureTimeout} from './native-cycle-lifecycle-fixture.js';

export const windowsRealGitFixtureTimeout = windowsCycleFixtureTimeout ?? {timeout: 60_000};

export const cliTestLayer = Layer.mergeAll(
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

// Lifecycle cases use a declared same-repository remote and deterministic provider boundary.
// Provider identity rejection and missing-authority cases call the core action explicitly below.
export const fixture = (...args: Parameters<typeof sourceFixture>) =>
  Effect.gen(function* () {
    const f = yield* sourceFixture(...args);
    if (
      (args[1] ?? 'pr') === 'pr' &&
      !EffectArray.contains(EffectString.split(EffectString.trim((yield* f.git(['remote'])).stdout), '\n'), 'origin')
    )
      yield* f.git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
    return f;
  });
export const runNativeTaskAction = (...args: Parameters<typeof runNativeTaskActionCore>) =>
  Effect.gen(function* () {
    const [config, input] = args;
    const request = input !== null && typeof input === 'object' ? object(input) : undefined;
    const delivering = request?.command === 'deliver-pr';
    const completing = request?.command === 'watch-pr' && request.operation === 'complete';
    const starting = request?.command === 'watch-pr' && request.operation === 'start';
    if (!request || (!delivering && !completing && !starting)) return yield* runNativeTaskActionCore(...args);
    const delivery =
      typeof request.deliveryRef === 'string' ? decodeNativeTaskActionRef(request.deliveryRef)?.delivery : undefined;
    const pr = delivering ? object(request.pr) : delivery?.pr;
    if (!pr || typeof pr.url !== 'string') return yield* runNativeTaskActionCore(...args);
    const phaseId =
      typeof request.validationRef === 'string' ? decodeNativeTaskActionRef(request.validationRef)?.phaseId : undefined;
    const watchId = phaseId
      ? `pr-${EffectString.slice(0, 48)(sha256HexSync(`${request.runId}\n${phaseId}`))}`
      : undefined;
    const legacyWatch = completing && watchId ? yield* readNativeWatch(config, watchId) : undefined;
    const watch =
      completing && watchId
        ? legacyWatch?.envelope.state.pr === pr.url
          ? legacyWatch
          : yield* readNativeWatch(config, `${watchId}-${EffectString.slice(0, 48)(sha256HexSync(pr.url))}`)
        : undefined;
    const merged = completing ? watch?.envelope.state.prState === 'merged' : pr.state === 'merged';
    const executor = yield* CommandExecutor;
    const simulated = CommandExecutor.of({
      ...executor,
      execute: (executable, commandArgs, options) => {
        if (
          executable === 'gh' &&
          commandArgs.includes('--jq') &&
          EffectArray.some(commandArgs, arg => EffectString.includes('headSha: .head.sha')(arg))
        )
          return Effect.succeed({
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              number: Number(EffectString.split(String(pr.url), '/').at(-1)),
              url: pr.url,
              baseRepository: 'example/repo',
              headRepository: 'example/repo',
              baseBranch: pr.baseBranch,
              headBranch: pr.branch,
              headSha: pr.headSha,
              state: merged ? 'closed' : 'open',
              merged,
            }),
          });
        return executor.execute(executable, commandArgs, options);
      },
    });
    return yield* runNativeTaskActionCore(
      config,
      delivering
        ? {
            ...request,
            userAuthority: request.userAuthority ?? 'The private fixture user approved delivery of this exact PR.',
          }
        : request,
    ).pipe(Effect.provideService(CommandExecutor, simulated));
  });

export const packet = {
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

export const proposal = {
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
export const completeDuringJournalRead = (f: Effect.Success<ReturnType<typeof fixture>>, finishJobId: string) =>
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
export const inspectTaskOnce = <A, E, R>(program: Effect.Effect<A, E, R>) =>
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

export const attemptSimulatedTaskWatch = (
  f: Effect.Success<ReturnType<typeof fixture>>,
  runId: string,
  phaseId: string,
  validationRef: string,
  deliveryRef: string,
  prUrl: string,
  expectedWatchId?: string,
  onCollectorSpawn: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const identity =
      (expectedWatchId === undefined ? undefined : EffectString.slice(3)(expectedWatchId)) ??
      EffectString.slice(0, 48)(sha256HexSync(`${runId}\n${phaseId}`));
    const watchId = `pr-${identity}`;
    const consumerId = `task-${identity}`;
    const wakeupId = consumerId;
    const wakeup = {
      host: 'codex' as const,
      executable: '/usr/bin/codex',
      threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    };
    const commands = yield* CommandExecutor;
    // The simulated provider reports the commit checked out at start, as a pushed PR head would.
    const providerHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
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
              headRepository: EffectArray.some(args, arg => EffectString.includes('headSha: .head.sha')(arg))
                ? `${owner}/${repo}`
                : `fixture-fork/${repo}`,
              headSha: providerHead,
              state: 'open',
              merged: false,
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
          yield* onCollectorSpawn;
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

export const startSimulatedTaskWatch = (
  f: Effect.Success<ReturnType<typeof fixture>>,
  runId: string,
  phaseId: string,
  validationRef: string,
  deliveryRef: string,
  prUrl: string,
  expectedWatchId?: string,
) =>
  Effect.gen(function* () {
    const attempt = yield* attemptSimulatedTaskWatch(
      f,
      runId,
      phaseId,
      validationRef,
      deliveryRef,
      prUrl,
      expectedWatchId,
    );
    if (!attempt.result.ok) return yield* attempt.result.failure;
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

export const recoverHistoricalTaskWatch = (f: Effect.Success<ReturnType<typeof fixture>>, runId: string) =>
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

export const writeSimulatedTaskWatch = (
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
    const sequence = startedWatch.envelope.state.events[0]?.sequence ?? startedWatch.envelope.state.nextSequence;
    const idHash = sha256HexSync(
      `${identity.watchId}\n${terminal ? 'terminal' : 'active'}${sequence > 1 ? `\n${sequence}` : ''}`,
    );
    const receiptId = `${EffectString.slice(0, 8)(idHash)}-${EffectString.slice(8, 12)(idHash)}-4${EffectString.slice(13, 16)(idHash)}-8${EffectString.slice(17, 20)(idHash)}-${EffectString.slice(20, 32)(idHash)}`;
    const attemptHash = sha256HexSync(
      `${identity.watchId}\n${terminal ? 'attempt-terminal' : 'attempt-active'}${sequence > 1 ? `\n${sequence}` : ''}`,
    );
    const attemptId = `${EffectString.slice(0, 8)(attemptHash)}-${EffectString.slice(8, 12)(attemptHash)}-4${EffectString.slice(13, 16)(attemptHash)}-8${EffectString.slice(17, 20)(attemptHash)}-${EffectString.slice(20, 32)(attemptHash)}`;
    const event = {
      sequence,
      id: identity.watchId + ':' + sequence,
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
        nextSequence: sequence + 1,
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
        notifiedThrough: Math.max(notification.notifiedThrough, startedWatch.envelope.state.acknowledged),
        lastConsumerAt: now,
        outbox: {
          key: `${identity.watchId}:${sequence}:${sequence}`,
          first: sequence,
          last: sequence,
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

export const publishOpenHistoricalPhase = (
  f: Effect.Success<ReturnType<typeof fixture>>,
  phaseId: string,
  baseBranch: string,
  prNumber: number,
  beginPhase = true,
  followup?: {readonly watchId: string; readonly source: string; readonly ambiguousRecovery?: boolean},
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
    yield* f.fs.writeFileString(
      f.path.join(f.repo, 'source.ts'),
      `export const fixture = "${followup?.source ?? phaseId}";\n`,
    );
    yield* f.git(['add', 'source.ts']);
    yield* f.git(['commit', '-m', `Phase ${phaseId}`]);
    const snapshot = object(
      yield* runNativeTaskAction(f.config, {
        command: 'record-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        workRef: String(work.workRef),
        ...(followup ? {reason: 'The approved followup changes its reviewed source.'} : {}),
      }),
    );
    const snapshotRef = String(snapshot.snapshotRef);
    yield* runNativeTaskAction(f.config, {
      command: 'record-review',
      runId: 'native-run',
      callerCwd: f.repo,
      snapshotRef,
      report: {
        mode: followup ? 'incremental' : 'full',
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
        pr: {
          url: prUrl,
          headSha,
          branch: `feature/${phaseId}`,
          baseBranch: baseBranch === 'origin/main' ? 'main' : baseBranch,
          state: 'open' as const,
        },
        publication: {exemption: 'small-fix', reason: `Private ${phaseId} pagination fixture authority.`},
      }),
    );
    if (followup?.ambiguousRecovery) {
      const before = yield* f.fs.readFileString(f.statePath());
      const ids = [
        EffectArray.join(EffectArray.take(EffectString.split(followup.watchId, '-'), 2), '-'),
        followup.watchId,
      ];
      const beforeWatches = yield* Effect.forEach(ids, id =>
        f.fs.readFileString(f.path.join(f.home, 'workflow-automations', 'native-watch-v1', id + '.json')),
      );
      for (const operation of ['inspect', 'stop'] as const) {
        expect(
          yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation,
            runId: 'native-run',
            callerCwd: f.repo,
            phaseId,
          }).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'watch-identity-conflict'}});
      }
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      expect(
        yield* Effect.forEach(ids, id =>
          f.fs.readFileString(f.path.join(f.home, 'workflow-automations', 'native-watch-v1', id + '.json')),
        ),
      ).toEqual(beforeWatches);
    }
    const watch = yield* startSimulatedTaskWatch(
      f,
      'native-run',
      phaseId,
      String(validation.validationRef),
      String(delivery.deliveryRef),
      prUrl,
      followup?.watchId,
    );
    yield* writeSimulatedTaskWatch(f, watch.startedWatch, watch, prUrl, headSha, false);
    if (prNumber === 31) {
      const provisional = decodeNativeTaskActionRef(String(delivery.deliveryRef));
      if (!provisional?.delivery) throw new Error('Expected the provisional receipt.');
      const {userAuthority: _authority, providerIdentity: _identity, ...legacy} = provisional.delivery;
      const legacyRef = encodeNativeTaskActionRef({
        ...provisional,
        delivery: legacy,
        payloadDigest: sha256HexSync(stableJson(legacy)),
      });
      const beforeLegacy = yield* f.fs.readFileString(f.statePath());
      expect(
        yield* runNativeTaskActionCore(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: String(validation.validationRef),
          deliveryRef: legacyRef,
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'stale-delivery-ref'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeLegacy);
    }
    yield* runNativeTaskAction(f.config, {
      command: 'watch-pr',
      operation: 'complete',
      runId: 'native-run',
      callerCwd: f.repo,
      validationRef: String(validation.validationRef),
      deliveryRef: String(delivery.deliveryRef),
    });
    return {...watch, validationRef: String(validation.validationRef), deliveryRef: String(delivery.deliveryRef)};
  });
