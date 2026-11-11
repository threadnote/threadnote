import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Effect, Layer, Clock, String as EffectString} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {SystemInfo} from '@threadnote/platform/system';
import {ScriptSystemInfoLayer} from '../../../../scripts/effect/system-layer.js';
import {
  aggregateProcessTree,
  samplerProcessTelemetryContract,
  parseCodeGraphBenchmarkSamplerArtifact,
} from '../../../../scripts/code-graph-benchmark-sampler.js';
import {
  makeWindowsProcessTreeSampler,
  parseWindowsProcessTreeResponse,
  windowsSamplerFrames,
} from '../../../../scripts/windows-process-tree-sampler.js';

const entry = (processId: number, parentProcessId: number, rssBytes = '100') => ({
  processId,
  parentProcessId,
  rssBytes,
  cpuTicks: '20000',
  startIdentity: `win32:${100000 + processId}`,
});
const response = (entries: readonly unknown[]) => ({protocol: 1, kind: 'sample', id: '1', ok: true, entries});
describe('Windows process-tree collector', () => {
  it('decodes exact working sets and recursively excludes the complete instrumentation subtree', () => {
    const entries = parseWindowsProcessTreeResponse(
      response([entry(1, 0), entry(2, 1), entry(3, 2), entry(4, 1), entry(5, 4)]),
      '1',
    )!;
    const sample = aggregateProcessTree(entries, 1, 'win32:100001', [4])!;
    expect(sample.processIds).toEqual([1, 2, 3]);
    expect(sample.rssBytes).toBe(300);
    expect(sample.rootRssBytes).toBe(100);
    expect(sample.processes.get('2:win32:100002')?.cpuMilliseconds).toBe(2);
    expect(aggregateProcessTree(entries, 1, 'win32:reused')).toBeUndefined();
    expect(aggregateProcessTree(entries, 1, undefined, [1])).toBeUndefined();
  });
  it('bounds protocol frames and slow or closed streams', async () => {
    const frame = windowsSamplerFrames(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"protocol":1}\n'));
          controller.close();
        },
      }),
    );
    expect(await frame.read(100)).toEqual({protocol: 1});
    await expect(frame.read(100)).rejects.toThrow('ended');
    const oversize = windowsSamplerFrames(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(EffectString.repeat(1024 * 1024 + 1)('x')));
          controller.close();
        },
      }),
    );
    await expect(oversize.read(100)).rejects.toThrow('limit');
    const slow = windowsSamplerFrames(new ReadableStream());
    await expect(slow.read(10)).rejects.toThrow('timed out');
    await slow.close();
  });
  it('retains a failed inspection instead of a parent-only or zero-byte tree', () => {
    expect(
      parseWindowsProcessTreeResponse(
        {protocol: 1, kind: 'sample', id: '1', ok: false, reason: 'process-inspection-failed'},
        '1',
      ),
    ).toBeUndefined();
    for (const value of [
      response([]),
      response([entry(1, 0, '9007199254740992')]),
      response([entry(1, 0), entry(1, 0)]),
      {...response([entry(1, 0)]), id: '2'},
    ])
      expect(() => parseWindowsProcessTreeResponse(value, '1')).toThrow();
  });
  it('parses Windows capability v5 without relabeling historical unsupported receipts', () => {
    const phase = {
      samples: 1,
      databasePeakBytes: 0,
      journalPeakBytes: 0,
      shmPeakBytes: 0,
      temporaryPeakBytes: 0,
      temporaryLinkedPeakBytes: 0,
      walPeakBytes: 0,
      processSamples: 1,
      processSampleAttempts: 1,
      processSampleFailures: 0,
      processSampleGapPeakMilliseconds: 0,
      processPeakCount: 2,
      rssPeakBytes: 200,
      cpuMilliseconds: 1,
    };
    const artifact = {
      version: 5,
      platform: 'win32',
      intervalMilliseconds: 25,
      samples: 1,
      phases: {query: phase},
      processTelemetry: samplerProcessTelemetryContract('win32', 'win32:100', 250, true),
      temporaryTelemetry: {
        availability: 'unavailable',
        reason: 'unsupported-platform',
        source: 'directory-walk',
        scope: 'temporary-root-linked-files-only',
      },
    };
    expect(parseCodeGraphBenchmarkSamplerArtifact(artifact).processTelemetry).toEqual(artifact.processTelemetry);
    expect(() => parseCodeGraphBenchmarkSamplerArtifact({...artifact, version: 4})).toThrow();
    expect(
      parseCodeGraphBenchmarkSamplerArtifact({
        ...artifact,
        version: 4,
        processTelemetry: samplerProcessTelemetryContract('win32', undefined),
        phases: {
          query: {
            samples: 1,
            databasePeakBytes: 0,
            journalPeakBytes: 0,
            shmPeakBytes: 0,
            temporaryPeakBytes: 0,
            temporaryLinkedPeakBytes: 0,
            walPeakBytes: 0,
          },
        },
      }).processTelemetry.availability,
    ).toBe('unavailable');
  });
  it('keeps direct-reader observers unsupported unless the scoped Windows collector is present', () => {
    expect(samplerProcessTelemetryContract('win32', undefined)).toMatchObject({
      availability: 'unavailable',
      reason: 'unsupported-platform',
    });
    expect(samplerProcessTelemetryContract('win32', 'win32:100', 250, true)).toEqual({
      availability: 'available',
      parentIdentityValidation: 'windows-process-creation-ticks',
      sampleIntervalMilliseconds: 250,
      scope: 'recursive-process-tree',
      source: 'windows-cim-dotnet',
    });
  });
  effectIt.effect.skipIf(process.platform !== 'win32')(
    'observes a real child and grandchild and disposes the persistent helper',
    () =>
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        const grandchildProgram =
          'const held = new Uint8Array(48*1024*1024); held.fill(1); setInterval(() => held[0], 1000);';
        const childProgram = `const child = Bun.spawn([process.execPath, '--eval', ${JSON.stringify(grandchildProgram)}], {stdout:'ignore', stderr:'ignore'}); console.log(JSON.stringify({grandchild: child.pid})); setInterval(() => {}, 1000);`;
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => Bun.spawn([process.execPath, '--eval', childProgram], {stdout: 'pipe', stderr: 'ignore'})),
          child =>
            Effect.promise(async () => {
              child.kill();
              await child.exited;
            }),
        );
        const chunk = yield* Effect.promise(async () => {
          const reader = child.stdout.getReader();
          const chunk = await reader.read();
          reader.releaseLock();
          return chunk.value;
        });
        const grandchildId: number = JSON.parse(new TextDecoder().decode(chunk)).grandchild;
        const grandchildIdentity = yield* system.processStartIdentity(grandchildId);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if ((yield* system.processStartIdentity(grandchildId)) === grandchildIdentity)
              system.signalProcess(grandchildId, 'SIGTERM');
            const started = yield* Clock.currentTimeMillis;
            while (system.isProcessRunning(grandchildId) && (yield* Clock.currentTimeMillis) - started < 1000)
              yield* Effect.sleep(10);
            expect(system.isProcessRunning(grandchildId)).toBe(false);
          }),
        );
        let helperId = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const collector = yield* makeWindowsProcessTreeSampler();
            helperId = collector.identity.processId;
            yield* Effect.sleep(250);
            const entries = yield* collector.sample(system.processId);
            expect(entries).toBeDefined();
            const sample = aggregateProcessTree(entries!, system.processId, undefined, [helperId])!;
            expect(sample.processIds).toContain(child.pid);
            expect(sample.processIds).toContain(grandchildId);
            expect(sample.processIds).not.toContain(helperId);
            expect(sample.rssBytes).toBeGreaterThan(sample.rootRssBytes + 32 * 1024 * 1024);
          }),
        );
        expect(system.isProcessRunning(helperId)).toBe(false);
      }).pipe(TestClock.withLive, provideTestLayer(Layer.mergeAll(BunServices.layer, ScriptSystemInfoLayer))),
  );
});
