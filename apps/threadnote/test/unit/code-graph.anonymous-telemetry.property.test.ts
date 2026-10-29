import {Array as EffectArray, Option as EffectOption} from 'effect';
import {systemRuntimeBoundaries} from '../helpers/system-runtime-boundaries.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {succeedUndefined} from '@threadnote/platform/optional';
import fc from 'fast-check';
import {Cause, Effect, Exit, Tracer} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {
  codeGraphAnonymousTelemetryComponent,
  codeGraphAnonymousTelemetryFields,
  emitCodeGraphBackgroundFailure,
  makeCodeGraphAnonymousTelemetryReporter,
  makeCodeGraphBuildAnonymousTelemetryReporter,
  withCodeGraphBuildAnonymousTelemetry,
} from '@threadnote/threadnote/code_graph/anonymous_telemetry';
import type {CodeGraphInventory} from '@threadnote/graph/inventory';
import {
  CodeGraphStorePermissionError,
  type CodeGraphIndexSummary,
  type CodeGraphInventoryFile,
  type CodeGraphProgress,
} from '@threadnote/graph/types';
import {anonymousTelemetryTestLayer} from '@threadnote/threadnote/effect/telemetry';
import type {SystemInfoShape} from '@threadnote/platform/system';
import {
  anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure,
  anonymousTelemetryDiagnosticFromError,
} from '@threadnote/threadnote/telemetry/diagnostic';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph anonymous telemetry', () => {
  it('maps graph phases to the closed anonymous progress vocabulary', () => {
    expect(codeGraphAnonymousTelemetryFields({phase: 'registering'})).toEqual({phase: 'graph.registering'});
    expect(
      codeGraphAnonymousTelemetryFields({
        activity: {
          batchCompleted: 1,
          batchTotal: 1,
          elapsedMilliseconds: 250,
          sourceBytes: 0,
          stage: 'restoring-indexes',
          stageElapsedMilliseconds: 250,
        },
        completed: 1,
        phase: 'materializing',
        reused: 0,
        total: 1,
        unit: 'files',
      }),
    ).toEqual({completed: 1, phase: 'graph.materializing', total: 1});
    expect(
      codeGraphAnonymousTelemetryFields({
        activity: {elapsedMilliseconds: 250, generations: 2, keys: 400, stage: 'loading-cache'},
        phase: 'registering',
      }),
    ).toEqual({elapsedMilliseconds: 250, phase: 'graph.registering', stage: 'loading-cache'});
    expect(codeGraphAnonymousTelemetryFields({phase: 'waiting', reason: 'database-writer'})).toEqual({
      phase: 'graph.waiting',
      waitingReason: 'database-writer',
    });
    expect(
      codeGraphAnonymousTelemetryFields({
        completed: 3,
        pagesCompleted: 2,
        phase: 'reclaiming',
        rowsDeleted: 100,
        total: 8,
        unit: 'snapshots',
      }),
    ).toEqual({completed: 3, phase: 'graph.reclaiming', total: 8});
    expect(
      codeGraphAnonymousTelemetryFields({
        edges: 100,
        phase: 'resolving',
        resolved: 90,
        subphase: 'complete',
        symbols: 20,
      }),
    ).toEqual({completed: 90, phase: 'graph.resolving', subphase: 'complete', total: 100});
    expect(
      codeGraphAnonymousTelemetryFields({
        activity: {
          elapsedMilliseconds: 400,
          rows: 2_000,
          stage: 'copying-edges',
          stageElapsedMilliseconds: 100,
          state: 'progress',
          transactionMilliseconds: 80,
        },
        phase: 'activating',
        snapshotId: 'private-snapshot-id',
        subphase: 'writing-and-checkpointing',
      }),
    ).toEqual({
      elapsedMilliseconds: 400,
      phase: 'graph.activating',
      stage: 'copying-edges',
      stageElapsedMilliseconds: 100,
      subphase: 'writing-and-checkpointing',
      transactionMilliseconds: 80,
    });
  });

  it('derives only the closed graph component label from process context', () => {
    expect(codeGraphAnonymousTelemetryComponent({})).toBe('cli');
    expect(codeGraphAnonymousTelemetryComponent({THREADNOTE_MCP_BROKER_CHILD: '1'})).toBe('mcp');
    expect(codeGraphAnonymousTelemetryComponent({THREADNOTE_MCP_BROKER_CHILD: '/Users/private'})).toBe('cli');
  });

  it('is noninterfering with path, language, classifier, role, and other per-file metadata', () => {
    fc.assert(
      fc.property(
        fc.record({
          completed: fc.nat({max: 1_000_000}),
          degradedFiles: fc.nat({max: 1_000_000}),
          factsBytesCompleted: fc.nat({max: Number.MAX_SAFE_INTEGER}),
          sourceBytesCompleted: fc.nat({max: Number.MAX_SAFE_INTEGER}),
          sourceBytesTotal: fc.nat({max: Number.MAX_SAFE_INTEGER}),
          total: fc.nat({max: 1_000_000}),
          workUnitsCompleted: fc.nat({max: Number.MAX_SAFE_INTEGER}),
          workUnitsTotal: fc.nat({max: Number.MAX_SAFE_INTEGER}),
        }),
        fc.record({
          classifier: fc.string(),
          language: fc.string(),
          path: fc.string(),
          role: fc.string(),
        }),
        fc.record({
          classifier: fc.string(),
          language: fc.string(),
          path: fc.string(),
          role: fc.string(),
        }),
        (counters, firstPrivate, secondPrivate) => {
          const first = scanningProgress(counters, firstPrivate);
          const second = scanningProgress(counters, secondPrivate);
          const projected = codeGraphAnonymousTelemetryFields(first);

          expect(projected).toEqual(codeGraphAnonymousTelemetryFields(second));
          // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
          expect(Object.keys(projected)).not.toEqual(
            expect.arrayContaining(['classifier', 'degraded', 'language', 'path', 'role', 'sizeBucket']),
          );
        },
      ),
      {numRuns: 64},
    );
  });

  fcEffectProp(
    effectIt,
    'emits quantity counters as closed power-of-two labels, never raw counts',
    {
      counters: fc.record({
        completed: fc.nat({max: 1_000_000}),
        degradedFiles: fc.nat({max: 1_000_000}),
        factsBytesCompleted: fc.nat({max: Number.MAX_SAFE_INTEGER}),
        sourceBytesCompleted: fc.nat({max: Number.MAX_SAFE_INTEGER}),
        sourceBytesTotal: fc.nat({max: Number.MAX_SAFE_INTEGER}),
        total: fc.nat({max: 1_000_000}),
        workUnitsCompleted: fc.nat({max: Number.MAX_SAFE_INTEGER}),
        workUnitsTotal: fc.nat({max: Number.MAX_SAFE_INTEGER}),
      }),
    },
    ({counters}) => {
      const capture = capturingTracer();
      const report = makeCodeGraphAnonymousTelemetryReporter('mcp');
      return Effect.gen(function* () {
        yield* report(
          scanningProgress(counters, {
            classifier: 'private-classifier',
            language: 'private-language',
            path: '/Users/private/secret-repository.ts',
            role: 'private-role',
          }),
        );
        const attributes = EffectRecord.fromEntries(capture.spans[0].span.attributes);
        expect(attributes).toMatchObject({
          'threadnote.work.completed_bucket': expectedQuantityBucket(counters.completed),
          'threadnote.work.degraded_files_bucket': expectedQuantityBucket(counters.degradedFiles),
          'threadnote.work.facts_bytes_completed_bucket': expectedQuantityBucket(counters.factsBytesCompleted),
          'threadnote.work.source_bytes_completed_bucket': expectedQuantityBucket(counters.sourceBytesCompleted),
          'threadnote.work.source_bytes_total_bucket': expectedQuantityBucket(counters.sourceBytesTotal),
          'threadnote.work.total_bucket': expectedQuantityBucket(counters.total),
          'threadnote.work.units_completed_bucket': expectedQuantityBucket(counters.workUnitsCompleted),
          'threadnote.work.units_total_bucket': expectedQuantityBucket(counters.workUnitsTotal),
        });
        for (const [key, value] of EffectRecord.toEntries(attributes)) {
          if (
            !Effect2.pipe(key, EffectString.endsWith('_bucket')) ||
            !Effect2.pipe(key, EffectString.startsWith('threadnote.work.'))
          )
            continue;
          expect(typeof value).toBe('string');
          expect(value).toMatch(/^0$|^2\^\d+$/u);
        }
      }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
    },
    {fastCheck: {numRuns: 64}},
  );

  effectIt.effect('emits on phase changes and once per minute with bucketed path-free graph progress', () => {
    const capture = capturingTracer();
    const report = makeCodeGraphAnonymousTelemetryReporter('mcp');
    const scanning = scanningProgress(
      {
        completed: 9,
        degradedFiles: 123,
        factsBytesCompleted: 129,
        sourceBytesCompleted: 65,
        sourceBytesTotal: 513,
        total: 17,
        workUnitsCompleted: 33,
        workUnitsTotal: 257,
      },
      {
        classifier: 'private-classifier',
        language: 'private-language',
        path: '/Users/private/secret-repository.ts',
        role: 'private-role',
      },
    );

    return Effect.gen(function* () {
      yield* report(scanning);
      yield* report(scanning);
      yield* TestClock.adjust('59 seconds');
      yield* report(scanning);
      expect(capture.spans).toHaveLength(1);

      yield* TestClock.adjust('1 second');
      yield* report(scanning);
      yield* report({phase: 'waiting', reason: 'repository-lock'});

      expect(capture.spans).toHaveLength(3);
      const first = EffectRecord.fromEntries(capture.spans[0].span.attributes);
      expect(first).toMatchObject({
        'threadnote.component': 'mcp',
        'threadnote.event': 'checkpoint',
        'threadnote.graph.degradation_reason': 'rss',
        'threadnote.operation': 'graph-build',
        'threadnote.phase': 'graph.scanning',
        'threadnote.stage': 'extracting',
        'threadnote.work.completed_bucket': '2^3',
        'threadnote.work.degraded_files_bucket': '2^6',
        'threadnote.work.facts_bytes_completed_bucket': '2^7',
        'threadnote.work.source_bytes_completed_bucket': '2^6',
        'threadnote.work.source_bytes_total_bucket': '2^9',
        'threadnote.work.total_bucket': '2^4',
        'threadnote.work.units_completed_bucket': '2^5',
        'threadnote.work.units_total_bucket': '2^8',
      });
      const serialized = JSON.stringify(first);
      expect(serialized).not.toContain('/Users/private');
      expect(serialized).not.toContain('private-classifier');
      expect(serialized).not.toContain('private-language');
      expect(serialized).not.toContain('private-role');

      expect(EffectRecord.fromEntries(capture.spans[2].span.attributes)).toMatchObject({
        'threadnote.phase': 'graph.waiting',
        'threadnote.waiting_reason': 'repository-lock',
      });
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('emits one short-build terminal surface from replacement phase evidence', () => {
    const capture = capturingTracer();

    return Effect.gen(function* () {
      const reporter = yield* makeCodeGraphBuildAnonymousTelemetryReporter('mcp');
      yield* reporter.observeOverlay(true);
      yield* reporter.observeInventory(dirtyTelemetryInventory());
      yield* reporter.progress(
        scanningProgress(
          {
            completed: 2,
            factsBytesCompleted: 128,
            sourceBytesCompleted: 128,
            sourceBytesTotal: 128,
            total: 2,
            workUnitsCompleted: 2,
            workUnitsTotal: 2,
          },
          {classifier: 'private', language: 'private', path: '/private/first.ts', role: 'private'},
        ),
      );
      yield* reporter.progress(
        scanningProgress(
          {
            completed: 2,
            factsBytesCompleted: 64,
            sourceBytesCompleted: 64,
            sourceBytesTotal: 64,
            total: 2,
            workUnitsCompleted: 2,
            workUnitsTotal: 2,
          },
          {classifier: 'private', language: 'private', path: '/private/second.ts', role: 'private'},
        ),
      );
      yield* reporter.progress(materializingTelemetryProgress(2_048, 4_096));
      yield* reporter.progress(materializingTelemetryProgress(512, 1_024));
      yield* reporter.observeExtractedFactBytes(32);
      yield* TestClock.adjust('123 millis');

      const summary = dirtyFallbackSummary();
      yield* reporter.terminal(Exit.succeed(summary));
      yield* reporter.terminal(Exit.succeed(summary));

      const lifecycle = EffectArray.filter(
        EffectArray.map(capture.spans, captured => EffectRecord.fromEntries(captured.span.attributes)),
        attributes => attributes['threadnote.event'] === 'lifecycle',
      );
      expect(lifecycle).toHaveLength(1);
      expect(lifecycle[0]).toMatchObject({
        'threadnote.component': 'mcp',
        'threadnote.duration_ms': 123,
        'threadnote.event': 'lifecycle',
        'threadnote.graph.build_kind': 'dirty',
        'threadnote.graph.cached_fact_replay_bytes_bucket': '2^9',
        'threadnote.graph.changed_fact_bytes_bucket': '2^5',
        'threadnote.graph.changed_files_bucket': '2^1',
        'threadnote.graph.deleted_files_bucket': '2^0',
        'threadnote.graph.delta_files_bucket': '2^1',
        'threadnote.graph.efficiency_class': 'small-delta-full',
        'threadnote.graph.extracted_files_bucket': '2^1',
        'threadnote.graph.fact_replay_amplification_bucket': '2^4',
        'threadnote.graph.fallback_reason': 'resolution-surface-changed',
        'threadnote.graph.final_fact_bytes_bucket': '2^10',
        'threadnote.graph.materialization_mode': 'full',
        'threadnote.graph.resolution_closure': 'full',
        'threadnote.graph.reused_files_bucket': '2^5',
        'threadnote.graph.rewrite_amplification_bucket': '2^1',
        'threadnote.graph.staged_files_bucket': '2^3',
        'threadnote.graph.total_files_bucket': '2^6',
        'threadnote.operation': 'graph-build',
        'threadnote.outcome': 'success',
      });
      expect(JSON.stringify(lifecycle)).not.toContain('/private');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('emits one failure terminal without a false success surface', () => {
    const capture = capturingTracer();
    const failure = CodeGraphStorePermissionError.of('private failure at /Users/private/graph.sqlite', {
      operation: 'stage code graph facts',
    });

    return Effect.gen(function* () {
      const reporter = yield* makeCodeGraphBuildAnonymousTelemetryReporter('cli');
      yield* TestClock.adjust('321 millis');
      const exit = yield* Effect.exit(withCodeGraphBuildAnonymousTelemetry(reporter, Effect.fail(failure)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure);
      yield* reporter.terminal(Exit.fail(failure));

      const lifecycle = EffectArray.filter(
        EffectArray.map(capture.spans, captured => EffectRecord.fromEntries(captured.span.attributes)),
        attributes => attributes['threadnote.event'] === 'lifecycle',
      );
      expect(lifecycle).toHaveLength(1);
      expect(lifecycle[0]).toMatchObject({
        'error.type': 'CodeGraphStorePermissionError',
        'threadnote.component': 'cli',
        'threadnote.duration_ms': 321,
        'threadnote.event': 'lifecycle',
        'threadnote.operation': 'graph-build',
        'threadnote.outcome': 'failure',
      });
      expect(lifecycle[0]).not.toHaveProperty('threadnote.graph.build_kind');
      expect(JSON.stringify(lifecycle)).not.toContain('/Users/private');
      expect(JSON.stringify(lifecycle)).not.toContain('private failure');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('emits interruption without inventing an error type', () => {
    const capture = capturingTracer();

    return Effect.gen(function* () {
      const reporter = yield* makeCodeGraphBuildAnonymousTelemetryReporter('mcp');
      yield* TestClock.adjust('87 millis');
      const exit = yield* Effect.exit(withCodeGraphBuildAnonymousTelemetry(reporter, Effect.interrupt));
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);

      const lifecycle = EffectArray.filter(
        EffectArray.map(capture.spans, captured => EffectRecord.fromEntries(captured.span.attributes)),
        attributes => attributes['threadnote.event'] === 'lifecycle',
      );
      expect(lifecycle).toHaveLength(1);
      expect(lifecycle[0]).toMatchObject({
        'threadnote.component': 'mcp',
        'threadnote.duration_ms': 87,
        'threadnote.event': 'lifecycle',
        'threadnote.operation': 'graph-build',
        'threadnote.outcome': 'interrupted',
      });
      expect(lifecycle[0]).not.toHaveProperty('error.type');
      expect(lifecycle[0]).not.toHaveProperty('threadnote.graph.build_kind');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('drops nested clean-base metrics before an incremental overlay terminal', () => {
    const capture = capturingTracer();

    return Effect.gen(function* () {
      const reporter = yield* makeCodeGraphBuildAnonymousTelemetryReporter('cli');
      yield* reporter.observeOverlay(true);
      yield* reporter.progress(materializingTelemetryProgress(4_096, 8_192));
      yield* reporter.progress({phase: 'activating', snapshotId: 'clean-base', subphase: 'complete'});
      yield* reporter.progress({
        completed: 0,
        phase: 'materializing',
        reused: 62,
        total: 2,
        unit: 'files',
      });
      const base = dirtyFallbackSummary();
      yield* reporter.terminal(
        Exit.succeed({
          ...base,
          materialization: {
            mode: 'incremental-overlay',
            resolutionClosure: 'changed',
            stagedFiles: 2,
            totalFiles: 64,
          },
        }),
      );

      const terminal = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          EffectArray.map(capture.spans, captured => EffectRecord.fromEntries(captured.span.attributes)),
          attributes => attributes['threadnote.event'] === 'lifecycle',
        ),
      );
      expect(terminal).toMatchObject({
        'threadnote.graph.cached_fact_replay_bytes_bucket': '0',
        'threadnote.graph.efficiency_class': 'incremental',
        'threadnote.graph.final_fact_bytes_bucket': '0',
        'threadnote.graph.materialization_mode': 'incremental-overlay',
      });
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('emits closed terminal events for detached refresh and maintenance failures', () => {
    const capture = capturingTracer();

    return Effect.gen(function* () {
      yield* emitCodeGraphBackgroundFailure(
        'mcp',
        'graph-refresh',
        anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure({
          code: 'busy',
          operation: 'refresh code graph',
          recovery: 'defer',
          retryable: true,
        }),
      );
      yield* emitCodeGraphBackgroundFailure(
        'cli',
        'graph-maintenance',
        anonymousTelemetryDiagnosticFromError(
          CodeGraphStorePermissionError.of('private failure at /Users/private/graph.sqlite', {
            operation: 'run routine code graph maintenance',
          }),
        ),
      );

      const attributes = EffectArray.map(capture.spans, captured => EffectRecord.fromEntries(captured.span.attributes));
      expect(attributes).toEqual([
        expect.objectContaining({
          'error.type': 'CodeGraphStoreError',
          'threadnote.component': 'mcp',
          'threadnote.event': 'lifecycle',
          'threadnote.failure.code': 'busy',
          'threadnote.failure.domain': 'code-graph-storage',
          'threadnote.failure.operation': 'refresh-code-graph',
          'threadnote.failure.recovery': 'defer',
          'threadnote.failure.retryable': true,
          'threadnote.operation': 'graph-refresh',
          'threadnote.outcome': 'failure',
        }),
        expect.objectContaining({
          'error.type': 'CodeGraphStorePermissionError',
          'threadnote.component': 'cli',
          'threadnote.event': 'lifecycle',
          'threadnote.failure.code': 'permission',
          'threadnote.failure.domain': 'code-graph-storage',
          'threadnote.failure.operation': 'run-routine-code-graph-maintenance',
          'threadnote.failure.recovery': 'fix-permissions',
          'threadnote.failure.retryable': false,
          'threadnote.operation': 'graph-maintenance',
          'threadnote.outcome': 'failure',
        }),
      ]);
      expect(JSON.stringify(attributes)).not.toContain('/Users/private');
      expect(JSON.stringify(attributes)).not.toContain('private failure');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });
});

function expectedQuantityBucket(value: number): string {
  if (value <= 0) return '0';
  return `2^${Math.min(52, Math.floor(Math.log2(value)))}`;
}

function scanningProgress(
  counters: {
    readonly completed: number;
    readonly degradedFiles?: number;
    readonly factsBytesCompleted: number;
    readonly sourceBytesCompleted: number;
    readonly sourceBytesTotal: number;
    readonly total: number;
    readonly workUnitsCompleted: number;
    readonly workUnitsTotal: number;
  },
  privateFields: {
    readonly classifier: string;
    readonly language: string;
    readonly path: string;
    readonly role: string;
  },
): Extract<CodeGraphProgress, {readonly phase: 'scanning'}> {
  return {
    accepted: counters.completed,
    activity: {
      batchCompleted: counters.completed,
      batchTotal: counters.total,
      bytes: counters.sourceBytesCompleted,
      classifier: privateFields.classifier,
      degraded: true,
      degradationReason: 'rss',
      factsBytes: counters.factsBytesCompleted,
      language: privateFields.language,
      path: privateFields.path,
      role: privateFields.role,
      sizeBucket: '>1MiB',
      stage: 'extracting',
    },
    completed: counters.completed,
    excluded: 1,
    metrics: {
      ...(counters.degradedFiles === undefined ? {} : {degradedFiles: counters.degradedFiles}),
      factsBytesCompleted: counters.factsBytesCompleted,
      sourceBytesCompleted: counters.sourceBytesCompleted,
      sourceBytesTotal: counters.sourceBytesTotal,
      workUnitsCompleted: counters.workUnitsCompleted,
      workUnitsTotal: counters.workUnitsTotal,
    },
    phase: 'scanning',
    skipped: 2,
    total: counters.total,
    unit: 'files',
  };
}

function materializingTelemetryProgress(
  cachedFactBytesTotal: number,
  factsBytesTotal: number,
): Extract<CodeGraphProgress, {readonly phase: 'materializing'}> {
  return {
    completed: 2,
    metrics: {
      batchesCompleted: 1,
      batchesTotal: 1,
      cachedFactBytesCompleted: cachedFactBytesTotal,
      cachedFactReplayBytesCompleted: cachedFactBytesTotal,
      cachedFactBytesTotal,
      changedFactBytesCompleted: 32,
      factsBytesCompleted: factsBytesTotal,
      factsBytesTotal,
      fallbackReason: 'resolution-surface-changed',
      mode: 'full',
      sourceBytesCompleted: 64,
      sourceBytesTotal: 64,
    },
    phase: 'materializing',
    reused: 62,
    total: 2,
    unit: 'files',
  };
}

function dirtyTelemetryInventory(): CodeGraphInventory {
  const committedFiles = [
    telemetryInventoryFile('src/changed.ts', 'old', 'commit'),
    telemetryInventoryFile('src/deleted.ts', 'deleted', 'commit'),
    telemetryInventoryFile('src/same.ts', 'same', 'commit'),
  ];
  return {
    committedFiles,
    committedParsedFiles: 0,
    dirty: true,
    files: [
      telemetryInventoryFile('src/changed.ts', 'new', 'worktree'),
      telemetryInventoryFile('src/added.ts', 'added', 'worktree'),
      telemetryInventoryFile('src/same.ts', 'same', 'commit'),
    ],
    parsedFiles: 2,
    skipped: 0,
  };
}

function telemetryInventoryFile(
  path: string,
  contentHash: string,
  source: CodeGraphInventoryFile['source'],
): CodeGraphInventoryFile {
  return {
    blobId: contentHash,
    contentHash,
    language: 'typescript',
    mode: '100644',
    path,
    size: 32,
    source,
  };
}

function dirtyFallbackSummary(): CodeGraphIndexSummary {
  return {
    diagnostics: [],
    durationMs: 234,
    identity: {
      caseMode: 'sensitive',
      checkoutId: 'checkout',
      displayName: 'private-repository',
      gitCommonDirectory: '/private/.git',
      headCommit: Effect2.pipe('a', EffectString.repeat(40)),
      objectFormat: 'sha1',
      repoRoot: '/private/repository',
      repositoryId: 'repository',
      worktreeId: 'worktree',
    },
    materialization: {
      fallbackReason: 'resolution-surface-changed',
      mode: 'full',
      stagedFiles: 8,
      totalFiles: 64,
    },
    reusedFiles: 62,
    skippedFiles: 0,
    snapshot: {
      commit: Effect2.pipe('a', EffectString.repeat(40)),
      dirty: true,
      edgeCount: 1,
      extractorSet: 'private-extractor-set',
      fileCount: 64,
      id: 'private-snapshot',
      repositoryId: 'private-repository',
      state: 'ready',
      symbolCount: 1,
      worktreeId: 'private-worktree',
    },
  };
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
