import {systemRuntimeBoundaries} from '../helpers/system-runtime-boundaries.js';
import {it as effectIt} from '@effect/vitest';
import {succeedUndefined} from '@threadnote/platform/optional';
import fc from 'fast-check';
import {Effect, Exit, Tracer} from 'effect';
import {describe, expect, it} from 'vitest';
import {anonymousTelemetryTestLayer, withAnonymousTelemetry} from '@threadnote/threadnote/effect/telemetry';
import type {SystemInfoShape} from '@threadnote/platform/system';
import {
  codeAnchorFinalizationTelemetryFields,
  telemetryQuantityBucket,
  withCodeAnchorFinalizationAnonymousTelemetry,
} from '@threadnote/threadnote/telemetry/code_anchor_finalization';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectRecord from 'effect/Record';

describe('deferred code-anchor finalization anonymous telemetry', () => {
  it('projects only a closed result and monotone power-of-two work buckets', () => {
    fc.assert(
      fc.property(
        fc.integer({max: 1_024, min: 1}),
        fc.constantFrom('conflict', 'failed', 'finalized', 'pending'),
        fc.integer({max: 60_000, min: 0}),
        fc.string({minLength: 1}),
        (scannedCount, result, elapsedMilliseconds, privateUri) => {
          const privateSentinel = `threadnote://private/${privateUri}/private-memory`;
          const receipt = {
            conflictCount: result === 'conflict' ? scannedCount : 0,
            failedCount: result === 'failed' ? scannedCount : 0,
            finalizedCount: result === 'finalized' ? scannedCount : 0,
            items: [{memoryUri: privateSentinel}],
            pendingCount: result === 'pending' ? scannedCount : 0,
            scannedCount,
          };
          const fields = codeAnchorFinalizationTelemetryFields(receipt, elapsedMilliseconds);
          expect(fields).toMatchObject({
            codeAnchorFinalizationConflictBucket: telemetryQuantityBucket(result === 'conflict' ? scannedCount : 0),
            codeAnchorFinalizationFailedBucket: telemetryQuantityBucket(result === 'failed' ? scannedCount : 0),
            codeAnchorFinalizationFinalizedBucket: telemetryQuantityBucket(result === 'finalized' ? scannedCount : 0),
            codeAnchorFinalizationLatencyMillisecondsBucket: telemetryQuantityBucket(elapsedMilliseconds),
            codeAnchorFinalizationPendingBucket: telemetryQuantityBucket(result === 'pending' ? scannedCount : 0),
            codeAnchorFinalizationResult: result,
            codeAnchorFinalizationScannedBucket: telemetryQuantityBucket(scannedCount),
          });
          expect(JSON.stringify(fields)).not.toContain(privateSentinel);
        },
      ),
      {numRuns: 100},
    );
  });

  it('abstains on invalid or internally inconsistent exact observations', () => {
    const receipt = {
      conflictCount: 0,
      failedCount: 0,
      finalizedCount: 1,
      pendingCount: 0,
      scannedCount: 1,
    } as const;
    expect(codeAnchorFinalizationTelemetryFields(receipt, 12)).toMatchObject({
      codeAnchorFinalizationResult: 'finalized',
    });
    expect(codeAnchorFinalizationTelemetryFields({...receipt, scannedCount: 0}, 12)).toBeUndefined();
    expect(codeAnchorFinalizationTelemetryFields({...receipt, pendingCount: 1}, 12)).toBeUndefined();
    expect(codeAnchorFinalizationTelemetryFields({...receipt, finalizedCount: -1}, 12)).toBeUndefined();
    expect(codeAnchorFinalizationTelemetryFields(receipt, 1.5)).toBeUndefined();
  });

  effectIt.effect('emits one explicit checkpoint and does not retain result fields on the invocation', () => {
    const capture = capturingTracer();
    return Effect.gen(function* () {
      const receipt = yield* withAnonymousTelemetry(
        {component: 'mcp', operation: 'finalize_code_refs'},
        withCodeAnchorFinalizationAnonymousTelemetry(
          'explicit',
          Effect.succeed({
            conflictCount: 0,
            failedCount: 0,
            finalizedCount: 3,
            pendingCount: 0,
            scannedCount: 3,
          }),
        ),
      );
      expect(receipt.finalizedCount).toBe(3);
      expect(capture.spans).toHaveLength(2);
      expect(spanAttributes(capture.spans[0])).toMatchObject({
        'threadnote.code_anchor_finalization.conflict_bucket': '0',
        'threadnote.code_anchor_finalization.failed_bucket': '0',
        'threadnote.code_anchor_finalization.finalized_bucket': '2^1',
        'threadnote.code_anchor_finalization.pending_bucket': '0',
        'threadnote.code_anchor_finalization.result': 'finalized',
        'threadnote.code_anchor_finalization.scanned_bucket': '2^1',
        'threadnote.code_anchor_finalization.trigger': 'explicit',
        'threadnote.event': 'checkpoint',
        'threadnote.operation': 'finalize_code_refs',
        'threadnote.phase': 'memory.code-anchor-finalization',
        'threadnote.phase.outcome': 'success',
      });
      const completion = spanAttributes(capture.spans[1]);
      expect(completion).toMatchObject({
        'threadnote.event': 'completion',
        'threadnote.operation': 'finalize_code_refs',
        'threadnote.outcome': 'success',
      });
      expect(completion).not.toHaveProperty('threadnote.code_anchor_finalization.result');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });
});

interface CapturedSpan {
  readonly span: Tracer.NativeSpan;
}

function capturingTracer(): {readonly spans: CapturedSpan[]; readonly tracer: Tracer.Tracer} {
  const spans: CapturedSpan[] = [];
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

function spanAttributes(captured: CapturedSpan): Record<string, unknown> {
  return EffectRecord.fromEntries(captured.span.attributes);
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
  };
}
