import {Context, Effect, Array as EffectArray, String as EffectString, Predicate} from 'effect';

import {TestClock} from 'effect/testing';

import {expect} from 'vitest';

import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';

import {decodeNativeAuthoringDocument} from '@threadnote/workflow-automations/authoring';

import {CodeGraphQueryService} from '@threadnote/graph/query';

import {CodeGraphIndexer} from '@threadnote/graph/indexer';

import {captureNativeCycleSource as captureSource} from '../../src/workflow_automation/cycle_git.js';

import {nativeFixture, provideNative} from './native-automation-fixture.js';

import {CycleDiagnostics, cycleDiagnostics} from './native-cycle-diagnostics.js';

import * as EffectRecord from 'effect/Record';

import * as Effect2 from 'effect';
export const windowsCycleFixtureTimeout = process.platform === 'win32' ? {timeout: 120_000} : undefined;
export const object = (value: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(value)) throw new Error('Expected object response');
  return value;
};
const diagnosticOutputEnabled = process.env.THREADNOTE_NATIVE_CYCLE_DIAGNOSTICS === '1';
type GraphStage = 'status-before' | 'index' | 'status-after';
const graphDiagnostics = () => {
  const origin = performance.now();
  const elapsed = () => Math.min(2_147_483_647, Math.max(0, Math.round(performance.now() - origin)));
  const events: {
    stage: GraphStage;
    event: 'entry' | 'exit';
    atMs: number;
    durationMs?: number;
    outcome?: 'Success' | 'Failure';
  }[] = [];
  let dropped = 0;
  const append = (event: (typeof events)[number]) => {
    events.push(event);
    if (events.length > 32) {
      events.shift();
      dropped = Math.min(2_147_483_647, dropped + 1);
    }
  };
  const observe = <A, E, R>(stage: GraphStage, program: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const atMs = elapsed();
      append({stage, event: 'entry', atMs});
      return program.pipe(
        Effect.onExit(exit =>
          Effect.sync(() =>
            append({stage, event: 'exit', atMs: elapsed(), durationMs: elapsed() - atMs, outcome: exit._tag}),
          ),
        ),
      );
    });
  return {
    prepare: <A, E, R>(program: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        const indexer = yield* CodeGraphIndexer;
        let indexStarted = false;
        return yield* program.pipe(
          Effect.provideService(
            CodeGraphQueryService,
            CodeGraphQueryService.of({
              ...query,
              status: (...args) => observe(indexStarted ? 'status-after' : 'status-before', query.status(...args)),
            }),
          ),
          Effect.provideService(
            CodeGraphIndexer,
            CodeGraphIndexer.of({
              ...indexer,
              index: (...args) =>
                Effect.suspend(() => {
                  indexStarted = true;
                  return observe('index', indexer.index(...args));
                }),
            }),
          ),
        );
      }),
    report: (outcome: 'Success' | 'Failure') => {
      try {
        process.stderr.write(
          'NATIVE_CYCLE_GRAPH_DIAGNOSTICS ' + JSON.stringify({version: 1, outcome, dropped, events}) + '\n',
        );
      } catch {
        // Preserve the original outcome if diagnostic output is unavailable.
      }
    },
  };
};
class GraphDiagnostics extends Context.Service<GraphDiagnostics, ReturnType<typeof graphDiagnostics>>()(
  '@threadnote/threadnote/test/dev-skills/native-cycle-lifecycle-fixture/GraphDiagnostics',
) {}
export const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const diagnostics = cycleDiagnostics();
    const graph = graphDiagnostics();
    return Effect.gen(function* () {
      const commands = yield* CommandExecutor;
      return yield* effect.pipe(
        Effect.provideService(CycleDiagnostics, diagnostics),
        Effect.provideService(GraphDiagnostics, graph),
        Effect.provideService(
          CommandExecutor,
          CommandExecutor.of({
            ...commands,
            execute: (executable, args, options) =>
              diagnostics.command('execute', executable, args, commands.execute(executable, args, options)),
            ...(commands.executeBytes
              ? {
                  executeBytes: (executable, args, options) =>
                    diagnostics.command(
                      'executeBytes',
                      executable,
                      args,
                      commands.executeBytes!(executable, args, options),
                    ),
                }
              : {}),
          }),
        ),
      );
    }).pipe(
      TestClock.withLive,
      provideNative,
      Effect.onExit(exit =>
        Effect.sync(() => {
          if (exit._tag === 'Failure' || diagnosticOutputEnabled) {
            diagnostics.report(exit._tag);
            graph.report(exit._tag);
          }
        }),
      ),
    );
  });
export const captureNativeCycleSource = (...args: Parameters<typeof captureSource>) =>
  Effect.gen(function* () {
    const diagnostics = yield* CycleDiagnostics;
    return yield* diagnostics.action('source-capture', captureSource(...args));
  });
export const fixture = Effect.fn('test.nativeCycle.fixture')(function* (
  phaseIds: readonly string[] = ['one', 'two'],
  delivery: 'pr' | 'local' = 'pr',
  preservedWork = false,
  stackOnly = false,
  stacked = true,
  initialBindings?: Record<string, {branch: string; baseBranch: string}>,
) {
  const diagnostics = yield* CycleDiagnostics;
  const graph = yield* GraphDiagnostics;
  const original = yield* diagnostics.action('provisioning', nativeFixture());
  const f = {
    ...original,
    init: (...args: Parameters<typeof original.init>) => diagnostics.action('init', original.init(...args)),
    call: (input: unknown) => {
      const request = Predicate.isObject(input) ? input : {};
      const program = original.call(input);
      return diagnostics.action(
        request.command ?? request.action,
        request.action === 'graph-ready' || request.command === 'packet' ? graph.prepare(program) : program,
      );
    },
  };
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', f.repo, ...args]);
  yield* git(['config', 'user.email', 'fixture@example.invalid']);
  yield* git(['config', 'user.name', 'Private fixture']);
  yield* git(['add', 'source.ts']);
  yield* git(['commit', '-m', 'Fixture']);
  yield* git(['checkout', '-b', 'feature/' + phaseIds[0]]);
  yield* f.init();
  const document = decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'plan',
    id: 'feature',
    project: 'fixture',
    title: 'Cycle fixture',
    objective: 'Deliver each safe phase and continue without waiting for merge.',
    requirements: [{id: 'req', behavior: 'Each phase is delivered before the next starts.'}],
    context: {codeRefs: [], evidenceRefs: [], note: 'Private source-free test.'},
    source: null,
    sourceFreeReason: 'Private synthetic state-machine integration fixture.',
    current: {
      summary: 'Work is pending.',
      components: ['Caller'],
      contracts: [],
      diagram: 'flowchart TD\n  Caller --> Draft',
    },
    target: {
      summary: 'Work is delivered.',
      components: ['Caller', 'Delivery'],
      contracts: ['Retain proof.'],
      diagram: 'flowchart TD\n  Caller --> Delivery',
    },
    phases: EffectArray.map(phaseIds, id => ({
      id,
      title: id,
      outcome: 'Phase works.',
      dependsOn: id === 'two' && !stackOnly ? ['one'] : [],
      affectedPaths: ['source.ts'],
      newPaths: [],
      contracts: ['Preserve unrelated source.'],
      acceptance: [
        {
          id: 'accept-' + id,
          criterion: id + ' works',
          verification: 'Exercise the private flow.',
          requirementIds: ['req'],
        },
      ],
      safeBoundary: 'Private independently working phase.',
    })),
    decisions: [
      {
        id: 'delivery',
        question: 'How should the next phase begin?',
        selection: 'no-better-alternative',
        selected: 'Continue after current PR and owned watch handoff.',
        alternatives: [],
        rationale: 'Pending CI is independent of local phase acceptance.',
        affectedPhases: ['one', 'two'],
        authority: 'orchestrator',
      },
    ],
    openQuestions: [],
    review: {required: false, reason: 'Private synthetic fixture.'},
  });
  if (document.kind !== 'plan') throw new Error('Expected a native plan fixture.');
  const saved = object(
    object(yield* f.call({...f.base('authoring'), command: 'save', document, ready: true, expectedRevision: null}))
      .authoring,
  );
  const exported = object(
    object(
      yield* f.call({
        ...f.base('authoring'),
        command: 'export-dev-cycle',
        uri: object(saved.root).uri,
        delivery,
        bindings:
          initialBindings ??
          EffectRecord.fromEntries(
            EffectArray.map(phaseIds, id => [
              id,
              {branch: 'feature/' + id, baseBranch: id === 'two' && stacked ? 'feature/one' : 'main'},
            ]),
          ),
      }),
    ).authoring,
  );
  const call = (input: unknown) =>
    f.call(input).pipe(Effect.map(result => ('cycle' in result ? result.cycle : result)));
  const inspect = () => call({...f.base('cycle'), command: 'inspect'}).pipe(Effect.map(object));
  const mutate = (command: string, fields: Record<string, unknown> = {}) =>
    Effect.gen(function* () {
      const before = yield* inspect();
      return object(yield* call({...f.base('cycle'), command, expectedRevision: before.revision, ...fields}));
    });
  if (preservedWork) {
    yield* f.fs.writeFileString(f.path.join(f.repo, 'user-note.txt'), 'Existing staged user work.\n');
    yield* git(['add', 'user-note.txt']);
  }
  yield* mutate('init', {plan: exported});
  const revise = (changes: Partial<typeof document>, bindings?: Record<string, {branch: string; baseBranch: string}>) =>
    Effect.gen(function* () {
      const root = object(object(exported.source).root);
      const saved = object(
        object(
          yield* f.call({
            ...f.base('authoring'),
            command: 'save',
            document: {...document, ...changes},
            ready: true,
            uri: root.uri,
            expectedRevision: root.revision,
          }),
        ).authoring,
      );
      return object(
        object(
          yield* f.call({
            ...f.base('authoring'),
            command: 'export-dev-cycle',
            uri: object(saved.root).uri,
            delivery,
            bindings:
              bindings ??
              initialBindings ??
              EffectRecord.fromEntries(
                EffectArray.map(phaseIds, id => [
                  id,
                  {branch: 'feature/' + id, baseBranch: id === 'two' && stacked ? 'feature/one' : 'main'},
                ]),
              ),
          }),
        ).authoring,
      );
    });
  return {...f, call, git, mutate, inspect, exported, document, revise};
});
export const reviewed = Effect.fn('test.nativeCycle.reviewed')(function* () {
  const f = yield* fixture();
  yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "phase one";\n');
  const captured = yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'one-review-1'});
  const snapshot = object(object(captured.snapshot).snapshot);
  const report = {
    snapshotId: snapshot.snapshotId,
    phaseHash: snapshot.phaseHash,
    snapshotTree: snapshot.tree,
    status: 'complete',
    mode: 'full',
    selected: ['correctness', 'simplicity'],
    lanes: [
      {name: 'correctness', status: 'complete'},
      {name: 'simplicity', status: 'complete'},
    ],
    findings: [],
  };
  return {...f, snapshot, report};
});
export const completeLocalPhase = Effect.fn('test.nativeCycle.completeLocalPhase')(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  id: string,
  revision = id,
  previous?: string,
) {
  yield* f.mutate('begin-phase', {phaseId: id});
  yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), `export const fixture = "${revision}";\n`);
  const captured = yield* f.mutate('snapshot', {
    phaseId: id,
    snapshotId: revision + '-review',
    ...(previous
      ? {
          previous,
          acceptedHead: Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim),
          reason: 'The phase commit is an inspected descendant of the previous review head.',
        }
      : {}),
  });
  const snapshot = object(object(captured.snapshot).snapshot);
  const review = yield* f.mutate('validate-review', {
    snapshotId: snapshot.snapshotId,
    attemptId: revision + '-attempt',
    report: {
      snapshotId: snapshot.snapshotId,
      phaseHash: snapshot.phaseHash,
      snapshotTree: snapshot.tree,
      status: 'complete',
      mode: snapshot.previous ? 'incremental' : 'full',
      selected: ['correctness', 'simplicity'],
      lanes: [
        {name: 'correctness', status: 'complete'},
        {name: 'simplicity', status: 'complete'},
      ],
      findings: [],
    },
  });
  expect(review.status).toBe('ok');
  yield* f.mutate('ready', {
    phaseId: id,
    snapshotId: snapshot.snapshotId,
    validation: {
      snapshotTree: snapshot.tree,
      reviewTree: snapshot.tree,
      status: 'passed',
      productState: 'working',
      checks: [{command: 'private flow', result: 'passed', evidence: 'Actual scoped source fixture.'}],
      acceptance: [{criterion: id + ' works', result: 'passed', evidence: 'Source readback.'}],
    },
  });
  yield* f.git(['add', 'source.ts']);
  yield* f.git(['commit', '-m', id]);
  const head = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
  yield* f.mutate('record-delivery', {
    phaseId: id,
    delivery: {
      phaseId: id,
      phaseHash: snapshot.phaseHash,
      delivery: 'local',
      headSha: head,
      validatedTree: snapshot.tree,
    },
  });
});
