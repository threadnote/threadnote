import {Array as EffectArray} from 'effect';
import {systemRuntimeBoundaries} from '../helpers/system-runtime-boundaries.js';
import {it as effectIt} from '@effect/vitest';
import {succeedUndefined} from '@threadnote/platform/optional';
import fc from 'fast-check';
import {Cause, Deferred, Effect, Exit, Fiber, Tracer} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {
  codeGraphAnalyzeAnonymousTelemetryRequestKind,
  codeGraphInspectAnonymousTelemetryRequestKind,
  codeGraphQueryAnonymousTelemetryFields,
  codeGraphQueryAnonymousTelemetryQuantityBucket,
  codeGraphQueryAnonymousTelemetrySnapshotSelection,
  makeCodeGraphQueryAnonymousTelemetryReporter,
  type CodeGraphQueryAnonymousTelemetryProjection,
  type CodeGraphQueryAnonymousTelemetrySnapshotSurface,
} from '@threadnote/threadnote/code_graph/query/anonymous_telemetry';
import type {CodeGraphSnapshot, CodeGraphStatus} from '@threadnote/graph/types';
import {anonymousTelemetryTestLayer, withAnonymousTelemetry} from '@threadnote/threadnote/effect/telemetry';
import type {SystemInfoShape} from '@threadnote/platform/system';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph query anonymous telemetry', () => {
  it('maps only the reviewed MCP operation vocabulary', () => {
    expect(
      EffectArray.map(
        ['query', 'node', 'neighbors', 'explain', 'path', 'impact', 'topology'] as const,
        codeGraphInspectAnonymousTelemetryRequestKind,
      ),
    ).toEqual([
      'inspect.query',
      'inspect.node',
      'inspect.neighbors',
      'inspect.explain',
      'inspect.path',
      'inspect.impact',
      'inspect.topology',
    ]);
    const analyzeOperations = [
      'stats',
      'communities',
      'community',
      'groups',
      'hubs',
      'surprises',
      'confidence',
      'full',
    ] as const;
    expect(EffectArray.map(analyzeOperations, codeGraphAnalyzeAnonymousTelemetryRequestKind)).toEqual([
      'analyze.stats',
      'analyze.communities',
      'analyze.community',
      'analyze.groups',
      'analyze.hubs',
      'analyze.surprises',
      'analyze.confidence',
      'analyze.full',
    ]);
  });

  it('projects only closed request and published-snapshot fields', () => {
    fc.assert(
      fc.property(
        fc.record({
          edgeCount: fc.nat({max: 1_000_000_000}),
          fileCount: fc.nat({max: 1_000_000_000}),
          symbolCount: fc.nat({max: 1_000_000_000}),
        }),
        fc.string().map(value => `private-repository:${value}`),
        fc.string().map(value => `private-query:${value}`),
        fc.string().map(value => `private-symbol:${value}`),
        (counts, repository, query, symbol) => {
          const privateCounts = {...counts, id: symbol};
          const privateQueryFields = {query, repository, symbol};
          const projected = codeGraphQueryAnonymousTelemetryFields({
            phase: 'graph.query.execute',
            requestKind: 'inspect.query',
            requestScope: 'local',
            snapshot: {
              freshness: 'deferred',
              selection: 'active',
              snapshot: privateCounts,
            },
            ...privateQueryFields,
          } satisfies CodeGraphQueryAnonymousTelemetryProjection);

          expect(projected).toEqual({
            phase: 'graph.query.execute',
            requestKind: 'inspect.query',
            requestScope: 'local',
            snapshotEdgesBucket: codeGraphQueryAnonymousTelemetryQuantityBucket(counts.edgeCount),
            snapshotFilesBucket: codeGraphQueryAnonymousTelemetryQuantityBucket(counts.fileCount),
            snapshotFreshness: 'deferred',
            snapshotSelection: 'active',
            snapshotSymbolsBucket: codeGraphQueryAnonymousTelemetryQuantityBucket(counts.symbolCount),
          });
          const serialized = JSON.stringify(projected);
          expect(serialized).not.toContain(repository);
          expect(serialized).not.toContain(query);
          expect(serialized).not.toContain(symbol);
        },
      ),
      {numRuns: 100},
    );
  });

  it('projects only the closed stage disposition and never snapshot or private fields', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'query-repository-identity' as const,
          'query-serialization' as const,
          'query-strict-reobservation' as const,
          'query-worktree-observation' as const,
        ),
        fc.constantFrom('fallback' as const, 'skipped' as const),
        fc.string().map(value => `private-stage-input:${value}`),
        (stage, subphase, privateValue) => {
          const privateStageFields = {privateValue};
          const projected = codeGraphQueryAnonymousTelemetryFields({
            phase: 'graph.query.execute',
            requestKind: 'inspect.path',
            requestScope: 'local',
            snapshot: selectedSnapshot(),
            stage,
            subphase,
            ...privateStageFields,
          } satisfies CodeGraphQueryAnonymousTelemetryProjection);

          expect(projected).toEqual({
            phase: 'graph.query.execute',
            requestKind: 'inspect.path',
            requestScope: 'local',
            stage,
            subphase,
          });
          expect(JSON.stringify(projected)).not.toContain(privateValue);
          expect(projected).not.toHaveProperty('snapshotSelection');
        },
      ),
      {numRuns: 100},
    );
  });

  it('uses monotone 0-or-power-of-two buckets and rejects invalid counts', () => {
    fc.assert(
      fc.property(
        fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
        fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
        (first, second) => {
          const lower = Math.min(first, second);
          const upper = Math.max(first, second);
          expect(bucketOrdinal(codeGraphQueryAnonymousTelemetryQuantityBucket(lower))).toBeLessThanOrEqual(
            bucketOrdinal(codeGraphQueryAnonymousTelemetryQuantityBucket(upper)),
          );
        },
      ),
      {numRuns: 100},
    );
    expect(codeGraphQueryAnonymousTelemetryQuantityBucket(0)).toBe('0');
    expect(codeGraphQueryAnonymousTelemetryQuantityBucket(1)).toBe('2^0');
    expect(codeGraphQueryAnonymousTelemetryQuantityBucket(7)).toBe('2^2');
    expect(codeGraphQueryAnonymousTelemetryQuantityBucket(8)).toBe('2^3');
    expect(codeGraphQueryAnonymousTelemetryQuantityBucket(-1)).toBeUndefined();
    expect(codeGraphQueryAnonymousTelemetryQuantityBucket(1.5)).toBeUndefined();
    expect(codeGraphQueryAnonymousTelemetryQuantityBucket(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('forbids local snapshot fields on status and every snapshot field on worksets', () => {
    const snapshot = selectedSnapshot();
    expect(
      codeGraphQueryAnonymousTelemetryFields({
        phase: 'graph.query.status',
        requestKind: 'inspect.query',
        requestScope: 'local',
        snapshot,
      }),
    ).toEqual({phase: 'graph.query.status', requestKind: 'inspect.query', requestScope: 'local'});
    expect(
      codeGraphQueryAnonymousTelemetryFields({
        phase: 'graph.query.execute',
        requestKind: 'inspect.query',
        requestScope: 'workset',
        snapshot,
      }),
    ).toEqual({phase: 'graph.query.execute', requestKind: 'inspect.query', requestScope: 'workset'});
  });

  it('classifies a newly published post-refresh snapshot as promoted', () => {
    expect(
      codeGraphQueryAnonymousTelemetrySnapshotSelection(statusWithSnapshot('before'), statusWithSnapshot('after')),
    ).toBe('promoted');
    expect(
      codeGraphQueryAnonymousTelemetrySnapshotSelection(statusWithSnapshot('active'), statusWithSnapshot('active')),
    ).toBe('active');
    expect(codeGraphQueryAnonymousTelemetrySnapshotSelection(statusWithSnapshot('before'), statusWithSnapshot())).toBe(
      'none',
    );
  });

  effectIt.effect('emits status, snapshot, execute, and completion with the legal local surface', () => {
    const capture = capturingTracer();
    const reporter = makeCodeGraphQueryAnonymousTelemetryReporter({
      requestKind: 'inspect.query',
      requestScope: 'local',
    });
    const snapshot = selectedSnapshot();

    return Effect.gen(function* () {
      const result = yield* withAnonymousTelemetry(
        {component: 'mcp', operation: 'inspect_code_graph'},
        Effect.gen(function* () {
          yield* reporter.annotate;
          yield* reporter.status(TestClock.adjust('5 millis'));
          yield* reporter.snapshot(TestClock.adjust('7 millis').pipe(Effect.as(snapshot)), value => value);
          return yield* reporter.execute(TestClock.adjust('11 millis').pipe(Effect.as('done')), snapshot);
        }),
      );

      expect(result).toBe('done');
      expect(capture.spans).toHaveLength(4);
      const status = spanAttributes(capture.spans[0]);
      expect(status).toMatchObject({
        'threadnote.event': 'checkpoint',
        'threadnote.graph.request_kind': 'inspect.query',
        'threadnote.graph.request_scope': 'local',
        'threadnote.operation': 'inspect_code_graph',
        'threadnote.phase': 'graph.query.status',
        'threadnote.phase.outcome': 'success',
      });
      expect(status).not.toHaveProperty('threadnote.graph.snapshot_selection');

      for (const attributes of [spanAttributes(capture.spans[1]), spanAttributes(capture.spans[2])]) {
        expect(attributes).toMatchObject({
          'threadnote.graph.request_kind': 'inspect.query',
          'threadnote.graph.request_scope': 'local',
          'threadnote.graph.snapshot_edges_bucket': '2^8',
          'threadnote.graph.snapshot_files_bucket': '2^6',
          'threadnote.graph.snapshot_freshness': 'deferred',
          'threadnote.graph.snapshot_selection': 'active',
          'threadnote.graph.snapshot_symbols_bucket': '2^7',
        });
      }
      expect(spanAttributes(capture.spans[1])).toMatchObject({'threadnote.phase': 'graph.query.snapshot'});
      expect(spanAttributes(capture.spans[2])).toMatchObject({'threadnote.phase': 'graph.query.execute'});
      expect(spanAttributes(capture.spans[3])).toMatchObject({
        'threadnote.event': 'completion',
        'threadnote.graph.request_kind': 'inspect.query',
        'threadnote.graph.request_scope': 'local',
        'threadnote.graph.snapshot_edges_bucket': '2^8',
        'threadnote.graph.snapshot_files_bucket': '2^6',
        'threadnote.graph.snapshot_freshness': 'deferred',
        'threadnote.graph.snapshot_selection': 'active',
        'threadnote.graph.snapshot_symbols_bucket': '2^7',
        'threadnote.operation': 'inspect_code_graph',
        'threadnote.outcome': 'success',
      });
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('emits executed, fallback, and skipped stages without changing results or terminal fields', () => {
    const capture = capturingTracer();
    const reporter = makeCodeGraphQueryAnonymousTelemetryReporter({
      requestKind: 'inspect.path',
      requestScope: 'local',
    });

    return Effect.gen(function* () {
      const result = yield* withAnonymousTelemetry(
        {component: 'mcp', operation: 'inspect_code_graph'},
        Effect.gen(function* () {
          yield* reporter.annotate;
          const identity = yield* reporter.stage(
            'graph.query.status',
            'query-repository-identity',
            TestClock.adjust('3 millis').pipe(Effect.as('same-result')),
          );
          yield* reporter.stage(
            'graph.query.execute',
            'query-worktree-observation',
            TestClock.adjust('5 millis'),
            'fallback',
          );
          yield* reporter.skip('graph.query.execute', 'query-strict-reobservation');
          yield* reporter.stage('graph.query.execute', 'query-serialization', TestClock.adjust('7 millis'));
          return identity;
        }),
      );

      expect(result).toBe('same-result');
      expect(capture.spans).toHaveLength(5);
      expect(EffectArray.map(capture.spans.slice(0, 4), span => spanAttributes(span))).toEqual([
        expect.objectContaining({
          'threadnote.phase': 'graph.query.status',
          'threadnote.phase.outcome': 'success',
          'threadnote.stage': 'query-repository-identity',
        }),
        expect.objectContaining({
          'threadnote.phase': 'graph.query.execute',
          'threadnote.phase.outcome': 'success',
          'threadnote.stage': 'query-worktree-observation',
          'threadnote.subphase': 'fallback',
        }),
        expect.objectContaining({
          'threadnote.phase': 'graph.query.execute',
          'threadnote.phase.outcome': 'success',
          'threadnote.stage': 'query-strict-reobservation',
          'threadnote.subphase': 'skipped',
        }),
        expect.objectContaining({
          'threadnote.phase': 'graph.query.execute',
          'threadnote.phase.outcome': 'success',
          'threadnote.stage': 'query-serialization',
        }),
      ]);
      for (const span of capture.spans.slice(0, 4)) {
        expect(spanAttributes(span)).not.toHaveProperty('threadnote.graph.snapshot_selection');
      }
      const completion = spanAttributes(capture.spans[4]);
      expect(completion).not.toHaveProperty('threadnote.phase');
      expect(completion).not.toHaveProperty('threadnote.stage');
      expect(completion).not.toHaveProperty('threadnote.subphase');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('emits the measured duration and outcome of an isolated query stage', () => {
    const capture = capturingTracer();
    const reporter = makeCodeGraphQueryAnonymousTelemetryReporter({
      requestKind: 'inspect.query',
      requestScope: 'local',
    });

    return Effect.gen(function* () {
      yield* withAnonymousTelemetry(
        {component: 'mcp', operation: 'inspect_code_graph'},
        reporter.observedStage({
          disposition: 'fallback',
          durationMilliseconds: 17,
          outcome: 'failure',
          phase: 'graph.query.execute',
          stage: 'query-worktree-observation',
        }),
      );

      expect(capture.spans).toHaveLength(2);
      expect(spanAttributes(capture.spans[0])).toMatchObject({
        'threadnote.duration_ms': 17,
        'threadnote.event': 'checkpoint',
        'threadnote.graph.request_kind': 'inspect.query',
        'threadnote.graph.request_scope': 'local',
        'threadnote.operation': 'inspect_code_graph',
        'threadnote.outcome': 'failure',
        'threadnote.phase': 'graph.query.execute',
        'threadnote.phase.elapsed_ms': 17,
        'threadnote.phase.outcome': 'failure',
        'threadnote.stage': 'query-worktree-observation',
        'threadnote.subphase': 'fallback',
      });
      expect(spanAttributes(capture.spans[1])).toMatchObject({
        'threadnote.event': 'completion',
        'threadnote.outcome': 'success',
      });
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('preserves stage failure and excludes result-derived snapshot fields', () => {
    const capture = capturingTracer();
    const reporter = makeCodeGraphQueryAnonymousTelemetryReporter({
      requestKind: 'inspect.path',
      requestScope: 'local',
    });
    const original = TestError.make({message: 'private failure /Users/private/repository'});

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        withAnonymousTelemetry(
          {component: 'mcp', operation: 'inspect_code_graph'},
          reporter.execute(Effect.fail(original), () => selectedSnapshot()),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(original);
      expect(capture.spans).toHaveLength(2);
      const checkpoint = spanAttributes(capture.spans[0]);
      expect(checkpoint).toMatchObject({
        'threadnote.graph.request_kind': 'inspect.path',
        'threadnote.graph.request_scope': 'local',
        'threadnote.phase': 'graph.query.execute',
        'threadnote.phase.outcome': 'failure',
      });
      expect(checkpoint).not.toHaveProperty('threadnote.graph.snapshot_selection');
      expect(JSON.stringify(checkpoint)).not.toContain('/Users/private');
      expect(spanAttributes(capture.spans[1])).toMatchObject({
        'threadnote.event': 'completion',
        'threadnote.outcome': 'failure',
      });
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('keeps pre-execute status evidence off the terminal recorder', () => {
    const capture = capturingTracer();
    const reporter = makeCodeGraphQueryAnonymousTelemetryReporter({
      requestKind: 'analyze.stats',
      requestScope: 'local',
    });

    return Effect.gen(function* () {
      yield* withAnonymousTelemetry(
        {component: 'mcp', operation: 'analyze_code_graph'},
        reporter.annotate.pipe(Effect.andThen(reporter.status(Effect.succeed('unavailable')))),
      );
      expect(capture.spans).toHaveLength(2);
      expect(spanAttributes(capture.spans[0])).toMatchObject({
        'threadnote.phase': 'graph.query.status',
        'threadnote.phase.outcome': 'success',
      });
      const completion = spanAttributes(capture.spans[1]);
      expect(completion).toMatchObject({
        'threadnote.event': 'completion',
        'threadnote.graph.request_kind': 'analyze.stats',
        'threadnote.graph.request_scope': 'local',
      });
      expect(completion).not.toHaveProperty('threadnote.phase');
      expect(completion).not.toHaveProperty('threadnote.phase.outcome');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('preserves stage interruption and emits no detached query checkpoint', () => {
    const capture = capturingTracer();
    const reporter = makeCodeGraphQueryAnonymousTelemetryReporter({
      requestKind: 'inspect.impact',
      requestScope: 'local',
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fiber = yield* withAnonymousTelemetry(
          {component: 'mcp', operation: 'inspect_code_graph'},
          reporter.stage(
            'graph.query.execute',
            'query-strict-reobservation',
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ).pipe(
          provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})),
          Effect.forkScoped,
        );

        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(capture.spans).toHaveLength(2);
        expect(spanAttributes(capture.spans[0])).toMatchObject({
          'threadnote.event': 'checkpoint',
          'threadnote.phase': 'graph.query.execute',
          'threadnote.phase.outcome': 'interrupted',
          'threadnote.stage': 'query-strict-reobservation',
        });
        expect(spanAttributes(capture.spans[1])).toMatchObject({
          'threadnote.event': 'completion',
          'threadnote.outcome': 'interrupted',
        });
        yield* Effect.yieldNow;
        expect(capture.spans).toHaveLength(2);
      }),
    );
  });

  effectIt.effect('emits a phase-less request-scoped liveness checkpoint after 30 seconds', () => {
    const capture = capturingTracer();
    const reporter = makeCodeGraphQueryAnonymousTelemetryReporter({
      requestKind: 'analyze.full',
      requestScope: 'local',
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fiber = yield* withAnonymousTelemetry(
          {component: 'mcp', operation: 'analyze_code_graph'},
          reporter.annotate.pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
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
          'threadnote.graph.request_kind': 'analyze.full',
          'threadnote.graph.request_scope': 'local',
          'threadnote.operation': 'analyze_code_graph',
          'threadnote.operation.elapsed_ms': 30_000,
        });
        expect(spanAttributes(capture.spans[0])).not.toHaveProperty('threadnote.phase');
        expect(spanAttributes(capture.spans[0])).not.toHaveProperty('threadnote.graph.snapshot_selection');

        yield* Fiber.interrupt(fiber);
        yield* Fiber.await(fiber);
      }),
    );
  });

  effectIt.effect('is noninterfering and emits nothing when telemetry is disabled', () => {
    const capture = capturingTracer();
    const reporter = makeCodeGraphQueryAnonymousTelemetryReporter({
      requestKind: 'inspect.node',
      requestScope: 'local',
    });

    return Effect.gen(function* () {
      const result = yield* withAnonymousTelemetry(
        {component: 'mcp', operation: 'inspect_code_graph'},
        reporter.execute(Effect.succeed('done'), selectedSnapshot()),
      );
      expect(result).toBe('done');
      expect(capture.spans).toEqual([]);
    }).pipe(
      provideTestLayer(
        anonymousTelemetryTestLayer({
          isEnabled: Effect.succeed(false),
          system: systemInfoStub(),
          tracer: capture.tracer,
        }),
      ),
    );
  });
});

function selectedSnapshot(): CodeGraphQueryAnonymousTelemetrySnapshotSurface {
  return {
    freshness: 'deferred',
    selection: 'active',
    snapshot: {edgeCount: 256, fileCount: 64, symbolCount: 128},
  };
}

function statusWithSnapshot(id?: string): CodeGraphStatus {
  const identity = {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
    displayName: 'private repository',
    gitCommonDirectory: '/private/not-serialized/.git',
    headCommit: Effect2.pipe('b', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot: '/private/not-serialized',
    repositoryId: Effect2.pipe('c', EffectString.repeat(64)),
    worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
  } satisfies CodeGraphStatus['identity'];
  const readySnapshot =
    id === undefined
      ? undefined
      : ({
          commit: Effect2.pipe('b', EffectString.repeat(40)),
          dirty: false,
          edgeCount: 1,
          extractorSet: 'fixture-extractor-v1',
          fileCount: 1,
          id,
          repositoryId: identity.repositoryId,
          state: 'ready',
          symbolCount: 1,
          worktreeId: identity.worktreeId,
        } satisfies CodeGraphSnapshot);
  return {
    databasePath: '/private/not-serialized.sqlite',
    freshness: id === undefined ? 'stale' : 'current',
    identity,
    languagePacks: [],
    ...(readySnapshot === undefined ? {} : {readySnapshot}),
    stale: id === undefined,
  };
}

function bucketOrdinal(bucket: ReturnType<typeof codeGraphQueryAnonymousTelemetryQuantityBucket>): number {
  if (bucket === undefined) return Number.NEGATIVE_INFINITY;
  if (bucket === '0') return -1;
  return Number(Effect2.pipe(bucket, EffectString.slice(2)));
}

function spanAttributes(span: {readonly span: Tracer.NativeSpan}): Record<string, unknown> {
  return EffectRecord.fromEntries(span.span.attributes);
}

function capturingTracer(): {
  readonly spans: readonly {readonly span: Tracer.NativeSpan}[];
  readonly tracer: Tracer.Tracer;
} {
  const spans: Array<{readonly span: Tracer.NativeSpan}> = [];
  return {
    spans,
    tracer: Tracer.make({
      span(options) {
        return new (class extends Tracer.NativeSpan {
          override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
            super.end(endTime, exit);
            spans.push({span: this});
          }
        })(options);
      },
    }),
  };
}

function systemInfoStub(): SystemInfoShape {
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
    memoryUsage: () => ({external: 0, heapUsed: 0, rss: 0}),
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
  };
}
