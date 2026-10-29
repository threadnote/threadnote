import {Array as EffectArray} from 'effect';
import {systemRuntimeBoundaries} from '../helpers/system-runtime-boundaries.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {succeedUndefined} from '@threadnote/platform/optional';
import fc from 'fast-check';
import {Cause, Deferred, Effect, Exit, Fiber, Tracer} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {completeAutoUpdateWorkerExit} from '@threadnote/threadnote/release/auto_update';
import {CodeGraphStoreError} from '@threadnote/graph/types';
import {FileLockTimeout} from '@threadnote/platform/file/lock';
import {HttpRequestFailed} from '@threadnote/platform/http';
import {
  anonymousTelemetryTestLayer,
  emitAnonymousTelemetryEvent,
  recordAnonymousTelemetryFields,
  withAnonymousTelemetry,
  withAnonymousTelemetryPhase,
  type AnonymousTelemetryFields,
} from '@threadnote/threadnote/effect/telemetry';
import type {SystemInfoShape} from '@threadnote/platform/system';
import {
  attachAnonymousTelemetryDiagnostic,
  attachAnonymousTelemetryError,
  attachAnonymousTelemetryReportedOutcome,
  readAnonymousTelemetryReportedOutcome,
} from '@threadnote/threadnote/telemetry/diagnostic';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface CapturedSpan {
  readonly root: boolean;
  readonly span: Tracer.NativeSpan;
}

describe('anonymous telemetry runtime', () => {
  effectIt.effect('classifies automatic-update failures while preserving their original Exit', () => {
    const capture = capturingTracer();
    const failures = [
      HttpRequestFailed.make({
        cause: new Error('private network failure'),
        message: 'private request failure',
        method: 'GET',
        url: 'https://private.example/release.tar.gz',
      }),
      FileLockTimeout.of('/private/threadnote-install.lock'),
    ] as const;

    return Effect.gen(function* () {
      for (const failure of failures) {
        const exit = yield* Effect.exit(
          withAnonymousTelemetry(
            {component: 'cli', operation: 'auto-update-worker'},
            completeAutoUpdateWorkerExit(Exit.fail(failure)),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure);
      }

      expect(capture.spans).toHaveLength(2);
      expect(EffectArray.map(capture.spans, span => spanAttributes(span))).toEqual([
        expect.objectContaining({
          'error.type': 'HttpRequestFailed',
          'threadnote.auto_update.result': 'failed',
          'threadnote.operation': 'auto-update-worker',
          'threadnote.outcome': 'failure',
        }),
        expect.objectContaining({
          'error.type': 'FileLockTimeout',
          'threadnote.auto_update.result': 'failed',
          'threadnote.operation': 'auto-update-worker',
          'threadnote.outcome': 'failure',
        }),
      ]);
      expect(JSON.stringify(EffectArray.map(capture.spans, span => spanAttributes(span)))).not.toContain('private');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('executes once, preserves a failure Exit, and emits only a successful sanitized envelope', () => {
    const capture = capturingTracer();
    const privateFailure = TestError.make({message: 'secret at /Users/private/repository/store.sqlite'});
    let executions = 0;

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        withAnonymousTelemetry(
          {component: 'cli', operation: 'graph-query'},
          Effect.sync(() => {
            executions += 1;
          }).pipe(Effect.andThen(Effect.fail(privateFailure))),
        ),
      );

      expect(executions).toBe(1);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(privateFailure);
      expect(capture.spans).toHaveLength(1);

      const captured = capture.spans[0];
      const attributes = spanAttributes(captured);
      expect(captured.root).toBe(true);
      expect(captured.span.name).toBe('threadnote.anonymous-diagnostic');
      expect(endedSpanExit(captured)).toSatisfy(Exit.isSuccess);
      expect(attributes).toMatchObject({
        'error.type': 'UnknownError',
        'threadnote.component': 'cli',
        'threadnote.event': 'completion',
        'threadnote.operation': 'graph-query',
        'threadnote.outcome': 'failure',
        'threadnote.runtime.architecture': 'arm64',
        'threadnote.runtime.platform': 'darwin',
      });
      expect(JSON.stringify(attributes)).not.toContain('secret');
      expect(JSON.stringify(attributes)).not.toContain('/Users/private');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect(
    'never exports a mutable error name and cannot replace the original Exit while classifying it',
    () => {
      const capture = capturingTracer();
      const secret = new Error('private');
      secret.name = 'SecretCustomerAcme';
      const trapped = new Proxy(secret, {
        get(target, property, receiver) {
          if (typeof property === 'symbol') throw new Error('symbol trap');
          return Reflect.get(target, property, receiver);
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          withAnonymousTelemetry({component: 'cli', operation: 'recall'}, Effect.fail(trapped)),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(trapped);
        expect(spanAttributes(capture.spans[0])).toMatchObject({'error.type': 'UnknownError'});
        expect(JSON.stringify(spanAttributes(capture.spans[0]))).not.toContain('SecretCustomerAcme');
        expect(JSON.stringify(spanAttributes(capture.spans[0]))).not.toContain('symbol trap');
      }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
    },
  );

  effectIt.effect('cannot replace an application result when diagnostic field accessors throw', () => {
    const capture = capturingTracer();
    const result = {content: [], isError: true};
    const diagnostic = new Proxy(
      {errorType: 'Error'},
      {
        get(target, property, receiver) {
          if (property === 'domain') throw new Error('private diagnostic trap');
          return Reflect.get(target, property, receiver);
        },
      },
    );
    attachAnonymousTelemetryDiagnostic(result, diagnostic);

    return Effect.gen(function* () {
      // Attach through an object whose own diagnostic cannot be projected. The
      // reporter must return the exact application value either way.
      const returned = yield* withAnonymousTelemetry(
        {
          component: 'mcp',
          operation: 'inspect-code-graph',
          reportedFailure: value => value.isError,
          reportedFailureType: 'McpToolError',
        },
        Effect.succeed(result),
      );

      expect(returned).toBe(result);
      expect(JSON.stringify(spanAttributes(capture.spans[0]))).not.toContain('private diagnostic trap');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('classifies an MCP error result without exporting its result text or private cause', () => {
    const capture = capturingTracer();
    const result = attachAnonymousTelemetryError(
      {content: [{text: 'private user-facing result containing repo content', type: 'text'}], isError: true},
      CodeGraphStoreError.of('native failure at /private/repository/graph.sqlite', {
        code: 'transient-io',
        operation: 'load code graph adjacency',
        recovery: 'retry-read-only',
        retryable: true,
      }),
    );

    return Effect.gen(function* () {
      const returned = yield* withAnonymousTelemetry(
        {
          component: 'mcp',
          operation: 'inspect-code-graph',
          reportedFailure: value => value.isError,
          reportedFailureType: 'McpToolError',
        },
        Effect.succeed(result),
      );

      expect(returned).toBe(result);
      expect(capture.spans).toHaveLength(1);
      const attributes = spanAttributes(capture.spans[0]);
      expect(attributes).toMatchObject({
        'error.type': 'CodeGraphStoreError',
        'threadnote.component': 'mcp',
        'threadnote.failure.code': 'transient-io',
        'threadnote.failure.domain': 'code-graph-storage',
        'threadnote.failure.operation': 'load-code-graph-adjacency',
        'threadnote.failure.recovery': 'retry-read-only',
        'threadnote.failure.retryable': true,
        'threadnote.operation': 'inspect-code-graph',
        'threadnote.outcome': 'failure',
      });
      expect(endedSpanExit(capture.spans[0])).toSatisfy(Exit.isSuccess);
      const serialized = JSON.stringify(attributes);
      expect(serialized).not.toContain('private user-facing result');
      expect(serialized).not.toContain('/private/repository');
      expect(serialized).not.toContain('native failure');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('preserves closed reported timeout and availability outcomes', () => {
    const capture = capturingTracer();
    const cases = ['timed-out', 'unavailable', 'failure'] as const;

    return Effect.gen(function* () {
      for (const outcome of cases) {
        const result = attachAnonymousTelemetryReportedOutcome(
          {content: [{type: 'text', text: 'private user-facing retry detail'}]},
          outcome,
        );
        const returned = yield* withAnonymousTelemetry(
          {
            component: 'mcp',
            operation: 'inspect-code-graph',
            reportedOutcome: readAnonymousTelemetryReportedOutcome,
          },
          Effect.succeed(result),
        );
        expect(returned).toBe(result);
      }

      expect(EffectArray.map(capture.spans, span => spanAttributes(span)['threadnote.outcome'])).toEqual(cases);
      expect(JSON.stringify(EffectArray.map(capture.spans, spanAttributes))).not.toContain(
        'private user-facing retry detail',
      );
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('preserves closed reported outcomes attached to failed carriers', () => {
    const capture = capturingTracer();
    const cases = ['timed-out', 'unavailable', 'failure'] as const;

    return Effect.gen(function* () {
      for (const outcome of cases) {
        const error = attachAnonymousTelemetryReportedOutcome(
          TestError.make({message: 'private target detail at /Users/private/repository'}),
          outcome,
        );
        const exit = yield* Effect.exit(
          withAnonymousTelemetry({component: 'cli', operation: 'graph.remove-view'}, Effect.fail(error)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(error);
      }

      expect(EffectArray.map(capture.spans, span => spanAttributes(span)['threadnote.outcome'])).toEqual(cases);
      expect(EffectArray.map(capture.spans, span => spanAttributes(span)['error.type'])).toEqual(
        EffectArray.map(cases, () => 'UnknownError'),
      );
      expect(JSON.stringify(EffectArray.map(capture.spans, spanAttributes))).not.toContain('private');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('buckets start/end memory and never exports exact byte counts', () => {
    const capture = capturingTracer();
    const mebibytes = 1_024 * 1_024;
    let memoryCalls = 0;
    const samples = [
      {external: 10 * mebibytes, heapUsed: 70 * mebibytes, peakRss: 130 * mebibytes, rss: 40 * mebibytes},
      {
        external: 100 * mebibytes,
        heapUsed: 300 * mebibytes,
        peakRss: 1_300 * mebibytes,
        rss: 600 * mebibytes,
      },
    ] as const;
    const system = systemInfoStub({
      memoryUsage: () => samples[Math.min(memoryCalls++, samples.length - 1)],
    });

    return Effect.gen(function* () {
      expect(yield* withAnonymousTelemetry({component: 'cli', operation: 'recall'}, Effect.succeed('ok'))).toBe('ok');

      expect(memoryCalls).toBe(2);
      const attributes = spanAttributes(capture.spans[0]);
      expect(attributes).toMatchObject({
        'threadnote.memory.external.end_bucket': '64-128MiB',
        'threadnote.memory.external.start_bucket': '<32MiB',
        'threadnote.memory.heap.end_bucket': '256-512MiB',
        'threadnote.memory.heap.start_bucket': '64-128MiB',
        'threadnote.memory.peak_rss.end_bucket': '1-2GiB',
        'threadnote.memory.peak_rss.start_bucket': '128-256MiB',
        'threadnote.memory.rss.end_bucket': '512MiB-1GiB',
        'threadnote.memory.rss.start_bucket': '32-64MiB',
      });
      for (const value of EffectRecord.values(attributes)) {
        expect(EffectArray.flatMap(samples, sample => EffectRecord.values(sample))).not.toContain(value);
      }
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system, tracer: capture.tracer})));
  });

  effectIt.effect('bounds runtime version metadata before it reaches the private span', () => {
    const capture = capturingTracer();
    const system = systemInfoStub({runtimeVersion: `4.${Effect2.pipe('1', EffectString.repeat(120))}`});

    return Effect.gen(function* () {
      yield* withAnonymousTelemetry({component: 'cli', operation: 'version'}, Effect.void);

      expect(spanAttributes(capture.spans[0])).toMatchObject({
        'threadnote.runtime.version': 'unknown',
      });
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system, tracer: capture.tracer})));
  });

  effectIt.effect('fails closed when the per-event consent gate is disabled', () => {
    const capture = capturingTracer();
    let executions = 0;
    let memoryCalls = 0;
    const system = systemInfoStub({
      memoryUsage: () => {
        memoryCalls += 1;
        return {external: 1, heapUsed: 1, rss: 1};
      },
    });

    return Effect.gen(function* () {
      const value = yield* withAnonymousTelemetry(
        {component: 'mcp', operation: 'recall-context'},
        Effect.sync(() => {
          executions += 1;
          return 42;
        }),
      );

      expect(value).toBe(42);
      expect(executions).toBe(1);
      expect(memoryCalls).toBe(0);
      expect(capture.spans).toEqual([]);
    }).pipe(
      provideTestLayer(
        anonymousTelemetryTestLayer({
          isEnabled: Effect.succeed(false),
          system,
          tracer: capture.tracer,
        }),
      ),
    );
  });

  effectIt.effect('runs the application once when invocation id generation defects', () => {
    const capture = capturingTracer();
    let executions = 0;

    return Effect.gen(function* () {
      const value = yield* withAnonymousTelemetry(
        {component: 'cli', operation: 'recall'},
        Effect.sync(() => {
          executions += 1;
          return 'ok';
        }),
      );

      expect(value).toBe('ok');
      expect(executions).toBe(1);
      expect(capture.spans).toHaveLength(1);
      expect(spanAttributes(capture.spans[0])).not.toHaveProperty('threadnote.invocation.id');
    }).pipe(
      provideTestLayer(
        anonymousTelemetryTestLayer({
          invocationId: () => {
            throw new Error('entropy defect');
          },
          system: systemInfoStub(),
          tracer: capture.tracer,
        }),
      ),
    );
  });

  effectIt.effect('inherits one invocation id across explicit checkpoints and completion', () => {
    const capture = capturingTracer();

    return Effect.gen(function* () {
      yield* withAnonymousTelemetry(
        {component: 'cli', operation: 'graph-build'},
        emitAnonymousTelemetryEvent({component: 'cli', event: 'checkpoint', operation: 'graph-build'}),
      );

      const ids = EffectArray.map(capture.spans, span => spanAttributes(span)['threadnote.invocation.id']);
      expect(ids).toHaveLength(2);
      expect(ids[0]).toMatch(/^tni_[\da-f]{24}$/u);
      expect(ids[1]).toBe(ids[0]);
      expect(spanAttributes(capture.spans[0])).toMatchObject({
        'threadnote.event': 'checkpoint',
        'threadnote.memory.rss.current_bucket': '<32MiB',
      });
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('exports closed automatic-update results and repair state on the worker completion', () => {
    const capture = capturingTracer();
    const cases: ReadonlyArray<AnonymousTelemetryFields> = [
      {autoUpdateResult: 'busy'},
      {autoUpdateResult: 'current'},
      {autoUpdateResult: 'disabled'},
      {autoUpdateResult: 'failed'},
      {autoUpdateRepairRequired: false, autoUpdateResult: 'updated'},
      {autoUpdateRepairRequired: true, autoUpdateResult: 'updated'},
    ];

    return Effect.gen(function* () {
      for (const fields of cases) {
        yield* withAnonymousTelemetry(
          {component: 'cli', operation: 'auto-update-worker'},
          recordAnonymousTelemetryFields(fields),
        );
      }

      expect(capture.spans).toHaveLength(cases.length);
      expect(
        EffectArray.map(capture.spans, span => {
          const attributes = spanAttributes(span);
          return {
            repairRequired: attributes['threadnote.auto_update.repair_required'],
            result: attributes['threadnote.auto_update.result'],
          };
        }),
      ).toEqual([
        {repairRequired: undefined, result: 'busy'},
        {repairRequired: undefined, result: 'current'},
        {repairRequired: undefined, result: 'disabled'},
        {repairRequired: undefined, result: 'failed'},
        {repairRequired: false, result: 'updated'},
        {repairRequired: true, result: 'updated'},
      ]);
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  fcEffectProp(
    effectIt,
    'drops arbitrary automatic-update result values and their repair flag from telemetry',
    {
      result: fc
        .string({maxLength: 80})
        .filter(value => !['busy', 'current', 'disabled', 'failed', 'updated'].includes(value)),
    },
    ({result}) => {
      const capture = capturingTracer();
      return Effect.gen(function* () {
        yield* withAnonymousTelemetry(
          {component: 'cli', operation: 'auto-update-worker'},
          recordAnonymousTelemetryFields({
            autoUpdateRepairRequired: true,
            // @ts-expect-error -- Deliberately test an out-of-vocabulary result is omitted from telemetry.
            autoUpdateResult: result,
          }),
        );

        const attributes = spanAttributes(capture.spans[0]);
        expect(attributes).not.toHaveProperty('threadnote.auto_update.result');
        expect(attributes).not.toHaveProperty('threadnote.auto_update.repair_required');
      }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
    },
    {fastCheck: {numRuns: 50}},
  );

  effectIt.effect('records phase timing on both the checkpoint and final operation envelope', () => {
    const capture = capturingTracer();

    return Effect.gen(function* () {
      const value = yield* withAnonymousTelemetry(
        {component: 'mcp', operation: 'recall-context'},
        withAnonymousTelemetryPhase(
          'recall.semantic-retrieval',
          TestClock.adjust('234 millis').pipe(Effect.as('found')),
        ),
      );

      expect(value).toBe('found');
      expect(capture.spans).toHaveLength(2);
      const checkpoint = spanAttributes(capture.spans[0]);
      const completion = spanAttributes(capture.spans[1]);
      expect(checkpoint).toMatchObject({
        'threadnote.event': 'checkpoint',
        'threadnote.operation': 'recall-context',
        'threadnote.outcome': 'success',
        'threadnote.phase': 'recall.semantic-retrieval',
        'threadnote.phase.elapsed_ms': 234,
        'threadnote.phase.outcome': 'success',
      });
      expect(completion).toMatchObject({
        'threadnote.event': 'completion',
        'threadnote.operation': 'recall-context',
        'threadnote.phase': 'recall.semantic-retrieval',
        'threadnote.phase.elapsed_ms': 234,
        'threadnote.phase.outcome': 'success',
      });
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('keeps phase and stage timings correlated when phases change', () => {
    const capture = capturingTracer();

    return Effect.gen(function* () {
      yield* withAnonymousTelemetry(
        {component: 'mcp', operation: 'recall-context'},
        Effect.gen(function* () {
          yield* recordAnonymousTelemetryFields({
            elapsedMilliseconds: 5_000,
            phase: 'recall.shared-sync',
            stage: 'reading',
            stageElapsedMilliseconds: 4_000,
          });
          yield* recordAnonymousTelemetryFields({
            elapsedMilliseconds: 100,
            phase: 'recall.lexical-ranking',
            stage: 'persisting',
            stageElapsedMilliseconds: 50,
          });
        }),
      );

      const completion = spanAttributes(capture.spans[0]);
      expect(completion).toMatchObject({
        'threadnote.phase': 'recall.lexical-ranking',
        'threadnote.phase.elapsed_ms': 100,
        'threadnote.phase.stage_elapsed_ms': 50,
        'threadnote.stage': 'persisting',
      });
      expect(completion['threadnote.invocation.id']).toMatch(/^tni_[\da-f]{24}$/u);
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('leaves phase failures unchanged when no telemetry invocation is active', () => {
    const original = new Proxy(new Error('original'), {
      get(target, property, receiver) {
        if (property === '_tag' || property === 'cause') throw new Error('private phase trap');
        return Reflect.get(target, property, receiver);
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(withAnonymousTelemetryPhase('recall.shared-sync', Effect.fail(original)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(original);
    });
  });

  effectIt.effect('emits a liveness checkpoint and preserves interruption', () => {
    const capture = capturingTracer();

    return Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fiber = yield* withAnonymousTelemetry(
          {component: 'mcp', operation: 'graph-build'},
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(
          provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})),
          Effect.forkScoped,
        );

        yield* Deferred.await(started);
        yield* TestClock.adjust('30 seconds');
        yield* Effect.yieldNow;

        expect(capture.spans).toHaveLength(1);
        expect(spanAttributes(capture.spans[0])).toMatchObject({
          'threadnote.event': 'checkpoint',
          'threadnote.operation': 'graph-build',
          'threadnote.operation.elapsed_ms': 30_000,
        });

        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(capture.spans).toHaveLength(2);
        expect(spanAttributes(capture.spans[1])).toMatchObject({
          'threadnote.event': 'completion',
          'threadnote.operation': 'graph-build',
          'threadnote.outcome': 'interrupted',
        });
        expect(endedSpanExit(capture.spans[1])).toSatisfy(Exit.isSuccess);
      }),
    );
  });
});

function capturingTracer(): {readonly spans: CapturedSpan[]; readonly tracer: Tracer.Tracer} {
  const spans: CapturedSpan[] = [];
  return {
    spans,
    tracer: Tracer.make({
      span(options) {
        return new (class extends Tracer.NativeSpan {
          override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
            super.end(endTime, exit);
            spans.push({root: options.root, span: this});
          }
        })(options);
      },
    }),
  };
}

function endedSpanExit(captured: CapturedSpan): Exit.Exit<unknown, unknown> {
  const {status} = captured.span;
  if (status._tag !== 'Ended') throw new Error('Expected telemetry span to be ended.');
  return status.exit;
}

function spanAttributes(captured: CapturedSpan): Record<string, unknown> {
  return EffectRecord.fromEntries(captured.span.attributes);
}

function systemInfoStub(overrides: Partial<SystemInfoShape> = {}): SystemInfoShape {
  return {
    ...systemRuntimeBoundaries,
    architecture: 'arm64',
    availableDiskBytes: () => succeedUndefined,
    currentDirectory: () => '/',
    environment: () => ({}),
    executablePath: '/opt/threadnote/bin/threadnote',
    hardwareInfo: Effect.succeed({
      cpuModel: 'test',
      effectiveMemoryBytes: 1,
      memoryBytes: 1,
      operatingSystem: 'test',
    }),
    homeDirectory: '/home/test',
    isProcessRunning: () => false,
    memoryUsage: () => ({external: 0, heapUsed: 0, peakRss: 0, rss: 0}),
    pathDelimiter: ':',
    platform: 'darwin',
    processArguments: ['/opt/threadnote/bin/threadnote'],
    processId: 1,
    processStartIdentity: () => succeedUndefined,
    readLine: () => () => undefined,
    runtimeVersion: 'test',
    setEnvironmentVariable: () => undefined,
    setExitCode: () => undefined,
    signalProcess: () => undefined,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    tempDirectory: '/tmp',
    userName: 'test',
    ...overrides,
  };
}
