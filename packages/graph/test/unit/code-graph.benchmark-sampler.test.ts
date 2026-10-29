import {TestError} from '@threadnote/testing/test-error';
import {mkdtemp, open, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {fileURLToPath} from '@threadnote/testing/node-url';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  aggregateProcessTree,
  benchmarkSamplerProcessTreeExclusions,
  createRssDiagnosticRun,
  createRssDiagnosticTokenizer,
  isOpenTemporaryFilePath,
  mergeTemporaryFileSnapshots,
  observeTemporaryOpenInspection,
  parseCodeGraphBenchmarkSamplerArtifact,
  parseCodeGraphBenchmarkSamplerArguments,
  parseCodeGraphBenchmarkSamplerCheckpoint,
  parseDarwinProcessList,
  parseDarwinOpenFileList,
  parseLinuxProcessIo,
  parseLinuxProcessStat,
  parseProcessCpuTime,
  processTreeDelta,
  recordRssPeakDiagnostic,
  rssDiagnosticAcquisition,
  samplerArtifact,
  samplerParentExited,
  samplerProcessTelemetryContract,
  samplerTemporaryTelemetryContract,
  temporaryFileObservationFromStats,
} from '../../../../scripts/code-graph-benchmark-sampler.js';

import {parseCodeGraphBenchmarkArguments} from '../../../../scripts/benchmark-code-graph.js';

const validArtifact = {
  intervalMilliseconds: 25,
  phases: {
    scanning: {
      cpuMilliseconds: 12.5,
      databasePeakBytes: 4_096,
      rssPeakBytes: 8_192,
      samples: 3,
      shmPeakBytes: 32_768,
      temporaryPeakBytes: 0,
      walPeakBytes: 16_384,
    },
  },
  platform: 'linux',
  processTelemetry: {
    availability: 'available',
    parentIdentityValidation: 'linux-proc-starttime',
    source: 'linux-proc',
  },
  samples: 3,
  version: 2,
} as const;

const unavailableArtifact = {
  ...validArtifact,
  phases: {
    scanning: {
      databasePeakBytes: 4_096,
      samples: 3,
      shmPeakBytes: 32_768,
      temporaryPeakBytes: 0,
      walPeakBytes: 16_384,
    },
  },
  platform: 'darwin',
  processTelemetry: {
    availability: 'unavailable',
    parentIdentityValidation: 'process-liveness-only',
    reason: 'unsupported-platform',
    source: 'none',
  },
} as const;

describe('code graph benchmark sampler artifact', () => {
  it('accepts finite non-negative phase telemetry', () => {
    expect(parseCodeGraphBenchmarkSamplerArtifact(validArtifact)).toEqual(validArtifact);
    expect(
      parseCodeGraphBenchmarkSamplerArtifact({
        ...validArtifact,
        phases: {scanning: {...validArtifact.phases.scanning, journalPeakBytes: 4_096}},
      }).phases.scanning.journalPeakBytes,
    ).toBe(4_096);
    expect(() =>
      parseCodeGraphBenchmarkSamplerArtifact({
        ...validArtifact,
        phases: {scanning: {...validArtifact.phases.scanning, journalPeakBytes: -1}},
      }),
    ).toThrow('invalid');
  });

  it('accepts recursive Linux process-tree and I/O telemetry', () => {
    const artifact = {
      ...validArtifact,
      phases: {
        scanning: {
          ...validArtifact.phases.scanning,
          ioReadBytes: 65_536,
          ioWriteBytes: 131_072,
          processPeakCount: 5,
          processSamples: 2,
        },
      },
      processTelemetry: {
        availability: 'available',
        ioCounters: 'linux-proc-read-write-bytes',
        parentIdentityValidation: 'linux-proc-starttime',
        sampleIntervalMilliseconds: 25,
        scope: 'recursive-process-tree',
        source: 'linux-proc',
      },
      version: 3,
    } as const;

    expect(parseCodeGraphBenchmarkSamplerArtifact(artifact)).toEqual(artifact);
  });

  it('accepts v4 linked-and-open temporary-file telemetry', () => {
    const artifact = {
      ...validArtifact,
      phases: {
        scanning: {
          ...validArtifact.phases.scanning,
          ioReadBytes: 65_536,
          ioWriteBytes: 131_072,
          processPeakCount: 5,
          processSampleAttempts: 2,
          processSampleFailures: 0,
          processSampleGapPeakMilliseconds: 25,
          processSamples: 2,
          temporaryOpenAttempts: 2,
          temporaryOpenFailures: 0,
          temporaryLinkedPeakBytes: 1_024,
          temporaryOpenPeakBytes: 4_096,
          temporaryOpenSamples: 2,
          temporaryPeakBytes: 5_120,
        },
      },
      processTelemetry: {
        availability: 'available',
        ioCounters: 'linux-proc-read-write-bytes',
        parentIdentityValidation: 'linux-proc-starttime',
        sampleIntervalMilliseconds: 25,
        scope: 'recursive-process-tree',
        source: 'linux-proc',
      },
      temporaryTelemetry: {
        availability: 'available',
        maximumOpenFileDescriptors: 65_536,
        maximumProcesses: 4_096,
        openFileSampleIntervalMilliseconds: 25,
        scope: 'temporary-root-linked-plus-process-tree-open-files',
        source: 'linux-proc-fd',
      },
      version: 4,
    } as const;

    expect(parseCodeGraphBenchmarkSamplerArtifact(artifact)).toEqual(artifact);
  });

  it('rejects inconsistent process-sampling diagnostics while reading legacy v4 artifacts', () => {
    const legacy = {
      ...validArtifact,
      phases: {
        scanning: {
          ...validArtifact.phases.scanning,
          ioReadBytes: 0,
          ioWriteBytes: 0,
          processPeakCount: 1,
          processSamples: 2,
          temporaryLinkedPeakBytes: 0,
          temporaryOpenAttempts: 1,
          temporaryOpenFailures: 0,
          temporaryOpenPeakBytes: 0,
          temporaryOpenSamples: 1,
        },
      },
      processTelemetry: {
        availability: 'available',
        ioCounters: 'linux-proc-read-write-bytes',
        parentIdentityValidation: 'linux-proc-starttime',
        sampleIntervalMilliseconds: 25,
        scope: 'recursive-process-tree',
        source: 'linux-proc',
      },
      temporaryTelemetry: {
        availability: 'available',
        maximumOpenFileDescriptors: 65_536,
        maximumProcesses: 4_096,
        openFileSampleIntervalMilliseconds: 25,
        scope: 'temporary-root-linked-plus-process-tree-open-files',
        source: 'linux-proc-fd',
      },
      version: 4,
    } as const;

    expect(parseCodeGraphBenchmarkSamplerArtifact(legacy)).toEqual(legacy);
    expect(() =>
      parseCodeGraphBenchmarkSamplerArtifact({
        ...legacy,
        phases: {
          scanning: {
            ...legacy.phases.scanning,
            processSampleAttempts: 2,
            processSampleFailures: 1,
            processSampleGapPeakMilliseconds: 25,
          },
        },
      }),
    ).toThrow(/sampler phase/i);
  });

  it('omits process measurements when the platform cannot provide them', () => {
    const parsed = parseCodeGraphBenchmarkSamplerArtifact(unavailableArtifact);

    expect(parsed.processTelemetry).toEqual({
      availability: 'unavailable',
      parentIdentityValidation: 'process-liveness-only',
      reason: 'unsupported-platform',
      source: 'none',
    });
    expect(parsed.phases.scanning).not.toHaveProperty('cpuMilliseconds');
    expect(parsed.phases.scanning).not.toHaveProperty('rssPeakBytes');
  });

  it.each([
    {...validArtifact, intervalMilliseconds: 1},
    {...validArtifact, samples: 0},
    {...validArtifact, samples: 4},
    {...validArtifact, phases: {'': validArtifact.phases.scanning}},
    {
      ...validArtifact,
      phases: {scanning: {...validArtifact.phases.scanning, cpuMilliseconds: Number.NaN}},
    },
    {
      ...validArtifact,
      phases: {scanning: {...validArtifact.phases.scanning, databasePeakBytes: 0.5}},
    },
    {
      ...validArtifact,
      phases: {scanning: {...validArtifact.phases.scanning, samples: 1.5}},
    },
    {
      ...unavailableArtifact,
      phases: {
        scanning: {...unavailableArtifact.phases.scanning, cpuMilliseconds: 0, rssPeakBytes: 0},
      },
    },
    {...validArtifact, version: 4},
    {
      ...validArtifact,
      temporaryTelemetry: {
        availability: 'available',
        maximumOpenFileDescriptors: 65_536,
        maximumProcesses: 4_096,
        openFileSampleIntervalMilliseconds: 25,
        scope: 'temporary-root-linked-plus-process-tree-open-files',
        source: 'linux-proc-fd',
      },
    },
    {
      ...validArtifact,
      platform: 'darwin',
    },
    {
      ...unavailableArtifact,
      platform: 'linux',
    },
  ])('rejects malformed telemetry %#', artifact => {
    expect(() => parseCodeGraphBenchmarkSamplerArtifact(artifact)).toThrow(/sampler/i);
  });

  it('exposes the platform-specific process telemetry contract', () => {
    expect(samplerProcessTelemetryContract('linux', '4096')).toEqual({
      availability: 'available',
      ioCounters: 'linux-proc-read-write-bytes',
      parentIdentityValidation: 'linux-proc-starttime',
      sampleIntervalMilliseconds: 25,
      scope: 'recursive-process-tree',
      source: 'linux-proc',
    });
    expect(samplerProcessTelemetryContract('linux', undefined)).toEqual({
      availability: 'unavailable',
      parentIdentityValidation: 'process-liveness-only',
      reason: 'parent-inspection-unavailable',
      source: 'none',
    });
    expect(samplerProcessTelemetryContract('darwin', 'Sat Aug 1 12:00:00 2026', 250)).toEqual({
      availability: 'available',
      parentIdentityValidation: 'darwin-ps-lstart',
      sampleIntervalMilliseconds: 250,
      scope: 'recursive-process-tree',
      source: 'darwin-ps',
    });
    expect(samplerProcessTelemetryContract('darwin', undefined)).toEqual({
      availability: 'unavailable',
      parentIdentityValidation: 'process-liveness-only',
      reason: 'parent-inspection-unavailable',
      source: 'none',
    });
    expect(samplerProcessTelemetryContract('win32', 'ignored')).toEqual({
      availability: 'unavailable',
      parentIdentityValidation: 'process-liveness-only',
      reason: 'unsupported-platform',
      source: 'none',
    });
  });

  it('exposes open temporary-file telemetry only when platform inspection succeeds', () => {
    const empty = {bytes: 0, files: new Map<string, number>()};
    expect(samplerTemporaryTelemetryContract('linux', empty)).toEqual({
      availability: 'available',
      maximumOpenFileDescriptors: 65_536,
      maximumProcesses: 4_096,
      openFileSampleIntervalMilliseconds: 25,
      scope: 'temporary-root-linked-plus-process-tree-open-files',
      source: 'linux-proc-fd',
    });
    expect(samplerTemporaryTelemetryContract('darwin', empty, 1_000)).toEqual({
      availability: 'available',
      maximumOpenFileDescriptors: 65_536,
      maximumProcesses: 4_096,
      openFileSampleIntervalMilliseconds: 1_000,
      projectionByteLimit: 8_388_608,
      scope: 'temporary-root-linked-plus-process-tree-open-files',
      source: 'darwin-lsof',
    });
    expect(samplerTemporaryTelemetryContract('linux', undefined)).toEqual({
      availability: 'unavailable',
      reason: 'open-file-inspection-unavailable',
      scope: 'temporary-root-linked-files-only',
      source: 'directory-walk',
    });
    expect(samplerTemporaryTelemetryContract('win32', undefined)).toEqual({
      availability: 'unavailable',
      reason: 'unsupported-platform',
      scope: 'temporary-root-linked-files-only',
      source: 'directory-walk',
    });
  });

  it('records an initial empty open-file success followed by inspection loss', () => {
    const initial = observeTemporaryOpenInspection(
      {
        temporaryOpenAttempts: 0,
        temporaryOpenFailures: 0,
        temporaryOpenPeakBytes: 0,
        temporaryOpenSamples: 0,
      },
      {bytes: 0, files: new Map()},
    );
    const afterFailure = observeTemporaryOpenInspection(
      {
        temporaryOpenAttempts: initial.attempts,
        temporaryOpenFailures: initial.failures,
        temporaryOpenPeakBytes: initial.peakBytes,
        temporaryOpenSamples: initial.samples,
      },
      undefined,
    );

    expect(initial).toEqual({attempts: 1, failures: 0, peakBytes: 0, samples: 1});
    expect(afterFailure).toEqual({attempts: 2, failures: 1, peakBytes: 0, samples: 1});
  });

  it('parses Linux start-time identity independently from process names containing parentheses', () => {
    const fields = Array.from({length: 20}, () => '0');
    fields[0] = 'S';
    fields[11] = '123';
    fields[12] = '45';
    fields[19] = '987654321';

    expect(parseLinuxProcessStat(`42 (worker ) name) ${fields.join(' ')}`)).toEqual({
      parentProcessId: 0,
      startIdentity: '987654321',
      systemTicks: 45,
      userTicks: 123,
    });
    expect(parseLinuxProcessStat('42 (truncated) S')).toBeUndefined();
  });

  it('parses Linux physical I/O counters without confusing logical character counters', () => {
    expect(parseLinuxProcessIo('rchar: 999999\nwchar: 888888\nread_bytes: 4096\nwrite_bytes: 8192\n')).toEqual({
      readBytes: 4096,
      writeBytes: 8192,
    });
    expect(parseLinuxProcessIo('read_bytes: 4096\n')).toBeUndefined();
  });

  it('parses the privacy-safe Darwin ps projection', () => {
    expect(
      parseDarwinProcessList(
        '  42  10 Sat Aug  1 12:00:00 2026       1:02.50  1024\n' +
          '  43  42 Sat Aug  1 12:00:01 2026   1-02:03:04.25  2048\ncommand text is deliberately not accepted\n',
      ),
    ).toEqual([
      {
        cpuMilliseconds: 62_500,
        parentProcessId: 10,
        processId: 42,
        rssBytes: 1_048_576,
        startIdentity: 'Sat Aug 1 12:00:00 2026',
      },
      {
        cpuMilliseconds: 93_784_250,
        parentProcessId: 42,
        processId: 43,
        rssBytes: 2_097_152,
        startIdentity: 'Sat Aug 1 12:00:01 2026',
      },
    ]);
  });

  it.each([
    ['0:00.00', 0],
    ['59:59.99', 3_599_990],
    ['60:00.00', 3_600_000],
    ['78:13.45', 4_693_450],
    ['1:02:03.45', 3_723_450],
    ['1-02:03:04.25', 93_784_250],
  ])('parses Darwin cumulative CPU time %s beyond one hour', (value, expected) => {
    expect(parseProcessCpuTime(value)).toBe(expected);
  });

  it.each(['1-60:00', '1:60:00', '1:00:60', '-1:00', 'not-a-time', '999999999999999:00'])(
    'rejects malformed Darwin cumulative CPU time %s',
    value => {
      expect(parseProcessCpuTime(value)).toBeUndefined();
    },
  );

  it('preserves arbitrary valid unbounded Darwin minute counters', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 0, max: 1_000_000}),
        fc.integer({min: 0, max: 59}),
        fc.integer({min: 0, max: 99}),
        (minutes, seconds, centiseconds) => {
          const encoded = `${minutes}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
          expect(parseProcessCpuTime(encoded)).toBe(minutes * 60_000 + seconds * 1_000 + centiseconds * 10);
        },
      ),
      {numRuns: 500},
    );
  });

  it('aggregates Darwin open SQLite scratch by identity without retaining paths', () => {
    const output =
      'p42\0\nf10\0tREG\0D0x10\0s4096\0i100\0n/private/tmp/bench/etilqs_a1\0' +
      '\nf11\0tREG\0D0x10\0s4096\0i100\0n/private/tmp/bench/etilqs_a1\0' +
      '\nf12\0tREG\0D0x10\0s2048\0i101\0n/private/tmp/bench/linked.tmp\0' +
      '\nf13\0tREG\0D0x10\0s9999\0i102\0n/private/tmp/unrelated.txt\0' +
      '\np99\0\nf14\0tREG\0D0x10\0s9999\0i103\0n/private/tmp/bench/other.tmp\0';

    const snapshot = parseDarwinOpenFileList(output, [42], 42, '/private/tmp/bench');
    expect(snapshot).toEqual({
      bytes: 6_144,
      files: new Map([
        ['16:100', 4_096],
        ['16:101', 2_048],
      ]),
    });
    expect(JSON.stringify(snapshot)).not.toContain('/private/tmp');
    expect(parseDarwinOpenFileList(output, [99], 99, '/private/tmp/bench')?.bytes).toBe(9_999);
    expect(parseDarwinOpenFileList(output, [42], 41, '/private/tmp/bench')).toBeUndefined();
  });

  it('recognizes root-scoped files and SQLite etilqs files without path-prefix confusion', () => {
    expect(isOpenTemporaryFilePath('/private/tmp/bench/etilqs_abc', '/private/tmp/bench')).toBe(true);
    expect(isOpenTemporaryFilePath('/private/tmp/bench/file.tmp (deleted)', '/private/tmp/bench')).toBe(true);
    expect(isOpenTemporaryFilePath('/elsewhere/etilqs_abc', '/private/tmp/bench')).toBe(true);
    expect(isOpenTemporaryFilePath('/private/tmp/benchmark/file.tmp', '/private/tmp/bench')).toBe(false);
    expect(isOpenTemporaryFilePath('relative/etilqs_abc', '/private/tmp/bench')).toBe(false);
  });

  it('deduplicates linked and open snapshots by device and inode', () => {
    expect(
      mergeTemporaryFileSnapshots(
        {bytes: 10, files: new Map([['1:1', 10]])},
        {
          bytes: 25,
          files: new Map([
            ['1:1', 10],
            ['1:2', 15],
          ]),
        },
      ),
    ).toEqual({
      bytes: 25,
      files: new Map([
        ['1:1', 10],
        ['1:2', 15],
      ]),
    });
  });

  it('preserves bigint device and inode identities beyond the safe-integer range', () => {
    fc.assert(
      fc.property(
        fc.bigInt({min: BigInt(Number.MAX_SAFE_INTEGER) + 1n, max: (1n << 96n) - 1n}),
        fc.bigInt({min: BigInt(Number.MAX_SAFE_INTEGER) + 1n, max: (1n << 96n) - 1n}),
        fc.bigInt({min: 0n, max: BigInt(Number.MAX_SAFE_INTEGER)}),
        (dev, ino, size) => {
          expect(temporaryFileObservationFromStats({dev, ino, isFile: () => true, size})).toEqual({
            bytes: Number(size),
            identity: `${dev}:${ino}`,
          });
        },
      ),
      {numRuns: 200},
    );
    expect(
      temporaryFileObservationFromStats({
        dev: 1n,
        ino: 2n,
        isFile: () => true,
        size: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
    ).toBeUndefined();
  });

  it('aggregates only recursive descendants and validates the root identity', () => {
    const entries = [
      processEntry(10, 1, 'root', 100, 1_000, 10, 20),
      processEntry(11, 10, 'child', 50, 2_000, 30, 40),
      processEntry(12, 11, 'grandchild', 25, 3_000, 50, 60),
      processEntry(99, 1, 'unrelated', 9_999, 9_999, 9_999, 9_999),
    ];

    const sample = aggregateProcessTree(entries, 10, 'root');
    expect(sample?.rssBytes).toBe(6_000);
    expect(sample?.rootRssBytes).toBe(1_000);
    expect([...sample!.processes.keys()]).toEqual(['10:root', '11:child', '12:grandchild']);
    expect(aggregateProcessTree(entries, 10, 'reused-root')).toBeUndefined();
    expect([...aggregateProcessTree(entries, 10, 'root', [11])!.processes.keys()]).toEqual(['10:root']);
  });

  it('excludes a verified observer root and its complete subtree from process and RSS evidence', () => {
    const sample = aggregateProcessTree(
      [
        processEntry(10, 1, 'root', 100, 1_000, 10, 20),
        processEntry(11, 10, 'workload', 50, 2_000, 30, 40),
        processEntry(12, 11, 'workload-child', 25, 3_000, 50, 60),
        processEntry(20, 10, 'observer', 5_000, 4_000, 70, 80),
        processEntry(21, 20, 'observer-child', 6_000, 5_000, 90, 100),
        processEntry(30, 10, 'second-observer', 7_000, 6_000, 110, 120),
      ],
      10,
      'root',
      [20, 30],
    );

    expect(sample).toMatchObject({processIds: [10, 11, 12], rootRssBytes: 1_000, rssBytes: 6_000});
    expect([...sample!.processes.keys()]).toEqual(['10:root', '11:workload', '12:workload-child']);
  });

  it('excludes sampler instrumentation only when it belongs to the observed tree', () => {
    const sample = aggregateProcessTree(
      [processEntry(10, 1, 'root', 100, 1_000, 10, 20), processEntry(11, 10, 'sampler', 50, 2_000, 30, 40)],
      10,
      'root',
    );
    expect(benchmarkSamplerProcessTreeExclusions(sample, 11)).toEqual([11]);
    expect(benchmarkSamplerProcessTreeExclusions(sample, 99)).toEqual([]);
    expect(benchmarkSamplerProcessTreeExclusions(undefined, 11)).toEqual([]);
  });

  it('fails closed when an exclusion is invalid, duplicated, the root, or not a descendant', () => {
    const entries = [
      processEntry(10, 1, 'root', 100, 1_000, 10, 20),
      processEntry(11, 10, 'observer', 50, 2_000, 30, 40),
      processEntry(99, 1, 'unrelated', 25, 3_000, 50, 60),
    ];

    for (const exclusions of [[0], [-1], [Number.MAX_SAFE_INTEGER + 1], [11, 11], [10], [99], [404]]) {
      expect(aggregateProcessTree(entries, 10, 'root', exclusions)).toBeUndefined();
    }
  });

  it('keeps workload accounting invariant under arbitrary excluded observer subtrees', () => {
    fc.assert(
      fc.property(
        fc.integer({max: 1_000_000, min: 0}),
        fc.integer({max: 1_000_000, min: 0}),
        fc.integer({max: 1_000_000, min: 0}),
        fc.integer({max: 1_000_000, min: 0}),
        (rootRss, workloadRss, observerRss, observerChildRss) => {
          const sample = aggregateProcessTree(
            [
              processEntry(10, 1, 'root', 100, rootRss, 10, 20),
              processEntry(11, 10, 'workload', 50, workloadRss, 30, 40),
              processEntry(20, 10, 'observer', 5_000, observerRss, 70, 80),
              processEntry(21, 20, 'observer-child', 6_000, observerChildRss, 90, 100),
            ],
            10,
            'root',
            [20],
          );

          expect(sample?.processIds).toEqual([10, 11]);
          expect(sample?.rootRssBytes).toBe(rootRss);
          expect(sample?.rssBytes).toBe(rootRss + workloadRss);
          expect([...sample!.processes.keys()]).toEqual(['10:root', '11:workload']);
        },
      ),
      {numRuns: 200},
    );
  });

  it('does not subtract disappeared descendants and counts a reused child PID as a new identity', () => {
    const previous = aggregateProcessTree(
      [
        processEntry(10, 1, 'root', 100, 1_000, 100, 200),
        processEntry(11, 10, 'old-child', 50, 2_000, 50, 60),
        processEntry(12, 11, 'disappears', 25, 3_000, 25, 30),
      ],
      10,
    );
    const current = aggregateProcessTree(
      [processEntry(10, 1, 'root', 110, 1_500, 110, 220), processEntry(11, 10, 'new-child', 7, 4_000, 8, 9)],
      10,
    );

    expect(processTreeDelta(previous, current!)).toEqual({
      cpuMilliseconds: 17,
      ioReadBytes: 18,
      ioWriteBytes: 29,
    });
    expect(current?.rssBytes).toBe(5_500);
  });

  it('treats a reused live PID as an exited parent', () => {
    expect(samplerParentExited('100', '100', true)).toBe(false);
    expect(samplerParentExited('100', undefined, true)).toBe(false);
    expect(samplerParentExited('100', '101', true)).toBe(true);
    expect(samplerParentExited('100', '100', false)).toBe(true);
  });

  it.skipIf(!['darwin', 'linux'].includes(process.platform))(
    'captures a live recursive process tree without command metadata',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-benchmark-process-tree-'));
      const parentReady = join(root, 'parent-ready');
      const parentStop = join(root, 'parent-stop');
      const samplerStop = join(root, 'sampler-stop');
      let parent: ReturnType<typeof Bun.spawn> | undefined;
      let sampler: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const phase = join(root, 'phase');
        const output = join(root, 'output.json');
        const checkpoint = join(root, 'checkpoint.json');
        const ready = join(root, 'ready.json');
        await writeFile(phase, 'scanning');
        const childProgram = `while (!(await Bun.file(${JSON.stringify(parentStop)}).exists())) await Bun.sleep(10);`;
        const parentProgram = [
          `const child=Bun.spawn([process.execPath,'-e',${JSON.stringify(childProgram)}]);`,
          `await Bun.write(${JSON.stringify(parentReady)},'ready');`,
          'await child.exited;',
        ].join('');
        parent = Bun.spawn({
          cmd: [process.execPath, '-e', parentProgram],
          stderr: 'ignore',
          stdout: 'ignore',
        });
        await waitForText(parentReady, 5_000);
        sampler = Bun.spawn({
          cmd: [
            process.execPath,
            fileURLToPath(new URL('../../../../scripts/code-graph-benchmark-sampler.ts', import.meta.url)),
            '--pid',
            String(parent.pid),
            '--database',
            join(root, 'graph.sqlite'),
            '--temp-root',
            root,
            '--phase',
            phase,
            '--stop',
            samplerStop,
            '--output',
            output,
            '--checkpoint-output',
            checkpoint,
            '--ready',
            ready,
            '--interval-ms',
            '10',
            '--checkpoint-ms',
            '20',
          ],
          stderr: 'pipe',
          stdout: 'ignore',
        });
        await waitForText(ready, 5_000);
        await writeFile(samplerStop, 'complete');
        expect(await sampler.exited).toBe(0);
        const artifact = parseCodeGraphBenchmarkSamplerArtifact(JSON.parse(await readFile(output, 'utf8')));
        expect(artifact.processTelemetry).toMatchObject({
          availability: 'available',
          scope: 'recursive-process-tree',
        });
        expect(
          Math.max(...Object.values(artifact.phases).map(sample => sample.processPeakCount ?? 0)),
        ).toBeGreaterThanOrEqual(2);
        expect(
          Object.values(artifact.phases).reduce((total, sample) => total + (sample.processSampleAttempts ?? 0), 0),
        ).toBeGreaterThanOrEqual(1);
        expect(
          Object.values(artifact.phases).reduce((total, sample) => total + (sample.processSampleFailures ?? 0), 0),
        ).toBe(0);
        expect(JSON.stringify(artifact)).not.toContain('command');
        await writeFile(parentStop, 'complete');
        await parent.exited;
      } finally {
        await writeFile(samplerStop, 'complete').catch(() => undefined);
        if (sampler) await sampler.exited;
        await writeFile(parentStop, 'complete').catch(() => undefined);
        if (parent) await parent.exited;
        await rm(root, {force: true, recursive: true});
      }
    },
    10_000,
  );

  it.skipIf(!['darwin', 'linux'].includes(process.platform))(
    'captures an unlinked SQLite-style temporary file without retaining its path',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-benchmark-unlinked-temp-'));
      const temporaryFile = join(root, 'etilqs_deadbeef');
      const handle = await open(temporaryFile, 'w+');
      try {
        await handle.truncate(1_048_576);
        await rm(temporaryFile);
        const phase = join(root, 'phase');
        const output = join(root, 'output.json');
        const checkpoint = join(root, 'checkpoint.json');
        const ready = join(root, 'ready.json');
        const stop = join(root, 'stop');
        await writeFile(phase, 'materializing');
        const sampler = Bun.spawn({
          cmd: [
            process.execPath,
            fileURLToPath(new URL('../../../../scripts/code-graph-benchmark-sampler.ts', import.meta.url)),
            '--pid',
            String(process.pid),
            '--database',
            join(root, 'graph.sqlite'),
            '--temp-root',
            root,
            '--phase',
            phase,
            '--stop',
            stop,
            '--output',
            output,
            '--checkpoint-output',
            checkpoint,
            '--ready',
            ready,
            '--interval-ms',
            '10',
            '--checkpoint-ms',
            '20',
          ],
          stderr: 'pipe',
          stdout: 'ignore',
        });
        await waitForText(ready, 5_000);
        await writeFile(stop, 'complete');
        expect(await sampler.exited).toBe(0);
        const artifactText = await readFile(output, 'utf8');
        const artifact = parseCodeGraphBenchmarkSamplerArtifact(JSON.parse(artifactText));
        expect(artifact).toMatchObject({
          temporaryTelemetry: {availability: 'available'},
          version: 4,
        });
        expect(artifact.phases.materializing.temporaryOpenPeakBytes).toBeGreaterThanOrEqual(1_048_576);
        expect(artifact.phases.materializing.temporaryPeakBytes).toBeGreaterThanOrEqual(1_048_576);
        expect(artifact.phases.materializing.temporaryOpenAttempts).toBeGreaterThanOrEqual(1);
        expect(artifact.phases.materializing.temporaryOpenFailures).toBe(0);
        expect(artifact.phases.materializing.temporaryOpenSamples).toBe(
          artifact.phases.materializing.temporaryOpenAttempts,
        );
        expect(artifact.phases.materializing.journalPeakBytes).toBeGreaterThanOrEqual(0);
        expect(artifactText).not.toContain(root);
        expect(artifactText).not.toContain('etilqs_deadbeef');
      } finally {
        await handle.close();
        await rm(root, {force: true, recursive: true});
      }
    },
    10_000,
  );

  it('writes its last observation and exits when the sampled parent is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-benchmark-sampler-'));
    try {
      const phase = join(root, 'phase');
      const output = join(root, 'output.json');
      const checkpoint = join(root, 'checkpoint.json');
      const ready = join(root, 'ready.json');
      await writeFile(phase, 'scanning');
      const sampler = Bun.spawn({
        cmd: [
          process.execPath,
          fileURLToPath(new URL('../../../../scripts/code-graph-benchmark-sampler.ts', import.meta.url)),
          '--pid',
          '2147483647',
          '--database',
          join(root, 'graph.sqlite'),
          '--temp-root',
          root,
          '--phase',
          phase,
          '--stop',
          join(root, 'stop'),
          '--output',
          output,
          '--checkpoint-output',
          checkpoint,
          '--ready',
          ready,
          '--interval-ms',
          '10',
          '--checkpoint-ms',
          '10',
        ],
        stderr: 'pipe',
        stdout: 'ignore',
      });
      expect(await sampler.exited).toBe(0);
      const artifact = parseCodeGraphBenchmarkSamplerArtifact(JSON.parse(await readFile(output, 'utf8')));
      expect(artifact).toMatchObject({
        phases: {scanning: {samples: 1}},
        processTelemetry: {
          availability: 'unavailable',
          parentIdentityValidation: 'process-liveness-only',
          reason:
            process.platform === 'linux' || process.platform === 'darwin'
              ? 'parent-inspection-unavailable'
              : 'unsupported-platform',
          source: 'none',
        },
        samples: 1,
        version: 4,
      });
      expect(artifact.phases.scanning).not.toHaveProperty('cpuMilliseconds');
      expect(artifact.phases.scanning).not.toHaveProperty('rssPeakBytes');
      expect(parseCodeGraphBenchmarkSamplerCheckpoint(JSON.parse(await readFile(checkpoint, 'utf8')))).toMatchObject({
        sampler: {samples: 1, version: 4},
        state: 'parent-exited',
        version: 4,
      });
      expect(JSON.parse(await readFile(ready, 'utf8'))).toEqual({checkpointVersion: 4, version: 1});
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('retains an uploadable checkpoint when a real sampled process crashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-benchmark-sampler-crash-'));
    const parentReady = join(root, 'parent-ready');
    const crash = join(root, 'crash');
    const stop = join(root, 'stop');
    let parent: ReturnType<typeof Bun.spawn> | undefined;
    let sampler: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const phase = join(root, 'phase');
      const output = join(root, 'output.json');
      const checkpoint = join(root, 'artifacts', 'production-large.cold.sampler.json');
      const ready = join(root, 'ready.json');
      await writeFile(phase, 'scanning');
      const parentProgram = [
        `await Bun.write(${JSON.stringify(parentReady)},'ready');`,
        `while (!(await Bun.file(${JSON.stringify(crash)}).exists())) await Bun.sleep(10);`,
        'process.exit(17);',
      ].join('');
      parent = Bun.spawn({
        cmd: [process.execPath, '-e', parentProgram],
        stderr: 'ignore',
        stdout: 'ignore',
      });
      await waitForText(parentReady, 5_000);
      sampler = Bun.spawn({
        cmd: [
          process.execPath,
          fileURLToPath(new URL('../../../../scripts/code-graph-benchmark-sampler.ts', import.meta.url)),
          '--pid',
          String(parent.pid),
          '--database',
          join(root, 'graph.sqlite'),
          '--temp-root',
          root,
          '--phase',
          phase,
          '--stop',
          stop,
          '--output',
          output,
          '--checkpoint-output',
          checkpoint,
          '--ready',
          ready,
          '--interval-ms',
          '10',
          '--checkpoint-ms',
          '20',
        ],
        stderr: 'pipe',
        stdout: 'ignore',
      });

      expect(JSON.parse(await waitForText(ready, 5_000))).toEqual({checkpointVersion: 4, version: 1});
      expect(parseCodeGraphBenchmarkSamplerCheckpoint(JSON.parse(await readFile(checkpoint, 'utf8')))).toMatchObject({
        state: 'running',
        version: 4,
      });
      await writeFile(crash, '');
      expect(await parent.exited).toBe(17);
      expect(await sampler.exited).toBe(0);
      expect(parseCodeGraphBenchmarkSamplerCheckpoint(JSON.parse(await readFile(checkpoint, 'utf8')))).toMatchObject({
        sampler: {phases: {scanning: expect.objectContaining({samples: expect.any(Number)})}},
        state: 'parent-exited',
        version: 4,
      });
    } finally {
      await writeFile(crash, '').catch(() => undefined);
      if (parent) await parent.exited;
      await writeFile(stop, 'aborted').catch(() => undefined);
      if (sampler) await sampler.exited;
      await rm(root, {force: true, recursive: true});
    }
  }, 15_000);
});

describe('optional RSS peak diagnostics', () => {
  const tokenize = createRssDiagnosticTokenizer(new Uint8Array(32).fill(7));
  const unknownInitial = {provenance: 'cached-initial-unknown'} as const;
  const sampleFor = (rssBytes: number) =>
    aggregateProcessTree([processEntry(10, 1, 'root-secret', 3, rssBytes, 1, 2)], 10, 'root-secret', [], tokenize)!;
  const phaseFor = (rssBytes: number, processCount: number) => ({
    cpuMilliseconds: 0,
    databasePeakBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    journalPeakBytes: 0,
    processPeakCount: processCount,
    processSampleAttempts: 1,
    processSampleFailures: 0,
    processSampleGapPeakMilliseconds: 0,
    processSamples: 1,
    rssPeakBytes: rssBytes,
    samples: 1,
    shmPeakBytes: 0,
    temporaryLinkedPeakBytes: 0,
    temporaryOpenAttempts: 0,
    temporaryOpenFailures: 0,
    temporaryOpenPeakBytes: 0,
    temporaryOpenSamples: 0,
    temporaryPeakBytes: 0,
    walPeakBytes: 0,
  });
  const artifactFor = (sample = sampleFor(3)) =>
    samplerArtifact(
      25,
      new Map([['scanning:progress', phaseFor(sample.rssBytes, sample.processes.size)]]),
      'linux',
      samplerProcessTelemetryContract('linux', 'root-secret'),
      samplerTemporaryTelemetryContract('linux', undefined),
      1,
      recordRssPeakDiagnostic(undefined, sample, unknownInitial),
    );

  it('does no secret, HMAC, or diagnostic clock work when disabled', () => {
    let secretCalls = 0;
    let clockCalls = 0;
    const sources = {
      randomKey: () => {
        secretCalls += 1;
        return new Uint8Array(32).fill(7);
      },
      now: () => {
        clockCalls += 1;
        return BigInt(clockCalls * 1_000);
      },
    };
    const disabled = createRssDiagnosticRun(false, sources);
    expect(disabled).toBeUndefined();
    expect([secretCalls, clockCalls]).toEqual([0, 0]);
    const entries = [processEntry(10, 1, 'root-secret', 3, 7, 1, 2)];
    const legacy = aggregateProcessTree(entries, 10);
    expect(JSON.stringify(aggregateProcessTree(entries, 10, undefined, [], disabled?.tokenize))).toBe(
      JSON.stringify(legacy),
    );
    expect(legacy).not.toHaveProperty('rssContributors');
    const enabled = createRssDiagnosticRun(true, sources)!;
    expect(enabled.offsetMicroseconds()).toBe(1);
    expect([secretCalls, clockCalls]).toEqual([1, 2]);
    expect(enabled.tokenize(10, 'root-secret')).toBe(tokenize(10, 'root-secret'));
  });

  it('keeps fixed default v4 JSON bytes and default benchmark option shape', () => {
    const actual = samplerArtifact(
      25,
      new Map([['scanning:progress', phaseFor(3, 1)]]),
      'linux',
      samplerProcessTelemetryContract('linux', 'root-secret'),
      samplerTemporaryTelemetryContract('linux', undefined),
      1,
    );
    const legacyJson =
      '{"intervalMilliseconds":25,"phases":{"scanning:progress":{"cpuMilliseconds":0,"ioReadBytes":0,"ioWriteBytes":0,"processPeakCount":1,"processSampleAttempts":1,"processSampleFailures":0,"processSampleGapPeakMilliseconds":0,"processSamples":1,"rssPeakBytes":3,"temporaryLinkedPeakBytes":0,"databasePeakBytes":0,"journalPeakBytes":0,"samples":1,"shmPeakBytes":0,"temporaryPeakBytes":0,"walPeakBytes":0}},"platform":"linux","processTelemetry":{"availability":"available","ioCounters":"linux-proc-read-write-bytes","parentIdentityValidation":"linux-proc-starttime","sampleIntervalMilliseconds":25,"scope":"recursive-process-tree","source":"linux-proc"},"samples":1,"temporaryTelemetry":{"availability":"unavailable","reason":"open-file-inspection-unavailable","scope":"temporary-root-linked-files-only","source":"directory-walk"},"version":4}';
    expect(JSON.stringify(actual)).toBe(legacyJson);
    expect(JSON.stringify(parseCodeGraphBenchmarkSamplerArtifact(JSON.parse(legacyJson)))).toBe(legacyJson);
    const defaults = parseCodeGraphBenchmarkArguments([]);
    expect(defaults).not.toHaveProperty('rssPeakDiagnostics');
    const {rssPeakDiagnostics, ...enabled} = parseCodeGraphBenchmarkArguments(['--rss-peak-diagnostics']);
    expect(rssPeakDiagnostics).toBe(true);
    expect(JSON.stringify(enabled)).toBe(JSON.stringify(defaults));
    const samplerArgs = [
      '--pid',
      '10',
      '--database',
      '/tmp/db',
      '--temp-root',
      '/tmp/temp',
      '--phase',
      '/tmp/phase',
      '--stop',
      '/tmp/stop',
      '--output',
      '/tmp/output',
      '--checkpoint-output',
      '/tmp/checkpoint',
      '--ready',
      '/tmp/ready',
      '--interval-ms',
      '25',
      '--checkpoint-ms',
      '1000',
    ];
    const parsed = parseCodeGraphBenchmarkSamplerArguments(samplerArgs);
    expect(parsed).not.toHaveProperty('rssPeakDiagnostics');
    expect(parseCodeGraphBenchmarkSamplerArguments([...samplerArgs, '--rss-peak-diagnostics', 'false'])).toEqual(
      parsed,
    );
    expect(
      parseCodeGraphBenchmarkSamplerArguments([...samplerArgs, '--rss-peak-diagnostics', 'true']).rssPeakDiagnostics,
    ).toBe(true);
    expect(() => parseCodeGraphBenchmarkSamplerArguments([...samplerArgs, '--rss-peak-diagnostics', 'yes'])).toThrow();
  });

  it('uses keyed opaque identities without a history registry or raw identifiers', () => {
    expect(tokenize(10, 'root-secret')).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenize(10, 'root-secret')).toBe(tokenize(10, 'root-secret'));
    expect(tokenize(10, 'root-secret')).not.toBe(tokenize(10, 'reused-secret'));
    expect(tokenize(10, 'root-secret')).not.toBe(
      createRssDiagnosticTokenizer(new Uint8Array(32).fill(8))(10, 'root-secret'),
    );
    const projection = sampleFor(3).rssContributors!;
    expect(projection.contributors[0]).toEqual({
      token: tokenize(10, 'root-secret'),
      parentToken: null,
      role: 'root',
      rssBytes: 3,
    });
    expect(JSON.stringify(projection)).not.toContain('root-secret');
    expect(JSON.stringify(projection)).not.toContain('processId');
  });

  it('conserves admitted accounting and top16 ordering under bounded tree permutations', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({rss: fc.integer({min: 0, max: 1_000_000}), parent: fc.nat(), order: fc.integer()}), {
          minLength: 1,
          maxLength: 48,
        }),
        nodes => {
          const entries = nodes.map((node, index) =>
            processEntry(
              100 + index,
              index === 0 ? 1 : 100 + (node.parent % index),
              `identity-${index}`,
              index,
              node.rss,
              index,
              index,
            ),
          );
          // Independent parent-chain model: node 1 and every node whose ancestry contains it are excluded.
          const admitted = entries.filter(entry => {
            let index = entry.processId - 100;
            while (index > 0) {
              if (index === 1) return false;
              index = entries[index].parentProcessId - 100;
            }
            return true;
          });
          const excluded = entries.length > 1 ? [101] : [];
          const before = JSON.stringify(entries);
          const shuffled = [...entries].sort((a, b) => nodes[a.processId - 100].order - nodes[b.processId - 100].order);
          const observed = aggregateProcessTree(shuffled, 100, 'identity-0', excluded, tokenize)!;
          const legacy = aggregateProcessTree(shuffled, 100, 'identity-0', excluded)!;
          const {rssContributors: projection, ...unchanged} = observed;
          expect(unchanged).toEqual(legacy);
          const model = admitted
            .map(entry => ({
              token: tokenize(entry.processId, entry.startIdentity),
              parentToken:
                entry.processId === 100
                  ? null
                  : tokenize(entry.parentProcessId, entries[entry.parentProcessId - 100].startIdentity),
              role: entry.processId === 100 ? 'root' : 'descendant',
              rssBytes: entry.rssBytes,
            }))
            .sort((a, b) => b.rssBytes - a.rssBytes || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
          expect(projection?.contributors).toEqual(model.slice(0, 16));
          expect(projection).toMatchObject({
            admittedAccountingComplete: true,
            processCount: admitted.length,
            omittedProcessCount: Math.max(0, admitted.length - 16),
            omittedRssBytes: model.slice(16).reduce((sum, entry) => sum + entry.rssBytes, 0),
            rssBytes: admitted.reduce((sum, entry) => sum + entry.rssBytes, 0),
          });
          expect(aggregateProcessTree(entries, 100, 'identity-0', excluded, tokenize)?.rssContributors).toEqual(
            projection,
          );
          expect(JSON.stringify(entries)).toBe(before);
        },
      ),
      {numRuns: 120},
    );
  });

  it('allows omitted parents and root, orders zero ties by token, and preserves saturated metrics', () => {
    const entries = [
      processEntry(10, 1, 'root-secret', 0, 0, 0, 0),
      ...Array.from({length: 20}, (_, i) => processEntry(11 + i, 10, `child-${i}`, 0, 100, 0, 0)),
    ];
    const sample = aggregateProcessTree(entries, 10, undefined, [], tokenize)!;
    expect(sample.rssContributors?.contributors).toHaveLength(16);
    expect(
      sample.rssContributors?.contributors.every(
        entry => entry.role === 'descendant' && entry.parentToken === tokenize(10, 'root-secret'),
      ),
    ).toBe(true);
    expect(sample.rssContributors?.omittedRssBytes).toBe(400);
    expect(parseCodeGraphBenchmarkSamplerArtifact(artifactFor(sample))).toBeDefined();
    const zeros = entries.map(entry => ({...entry, rssBytes: 0}));
    const zeroProjection = aggregateProcessTree(zeros, 10, undefined, [], tokenize)!.rssContributors!;
    expect(zeroProjection.contributors.map(entry => entry.token)).toEqual(
      entries
        .map(entry => tokenize(entry.processId, entry.startIdentity))
        .sort()
        .slice(0, 16),
    );
    const max = Number.MAX_SAFE_INTEGER;
    const saturated = aggregateProcessTree(
      [processEntry(10, 1, 'root-secret', 0, max, 0, 0), processEntry(11, 10, 'child', 0, 1, 0, 0)],
      10,
      undefined,
      [],
      tokenize,
    )!;
    expect(saturated.rssBytes).toBe(max);
    expect(saturated.rssContributors).toMatchObject({admittedAccountingComplete: false, omittedRssBytes: null});
    expect(parseCodeGraphBenchmarkSamplerArtifact(artifactFor(saturated))).toBeDefined();
    expect(sampleFor(max).rssContributors).toMatchObject({admittedAccountingComplete: true, omittedRssBytes: 0});
  });

  it('records first valid zero, keeps startup unknown and ties, and replaces only with a higher admitted sample', () => {
    const ticks = [0n, 120_000n, 480_000n];
    const run = createRssDiagnosticRun(true, {randomKey: () => new Uint8Array(32), now: () => ticks.shift()!})!;
    const window = rssDiagnosticAcquisition(
      run.offsetMicroseconds(),
      run.offsetMicroseconds(),
      'scanning:progress',
      'materializing:progress',
    );
    expect(recordRssPeakDiagnostic(undefined, undefined, window)).toBeUndefined();
    expect(recordRssPeakDiagnostic(undefined, sampleFor(9), undefined)).toBeUndefined();
    const first = recordRssPeakDiagnostic(undefined, sampleFor(0), unknownInitial)!;
    expect(first).toMatchObject({rssBytes: 0, acquisition: {provenance: 'cached-initial-unknown'}});
    expect(recordRssPeakDiagnostic(first, sampleFor(0), window)).toBe(first);
    expect(recordRssPeakDiagnostic(first, undefined, window)).toBe(first);
    const next = recordRssPeakDiagnostic(first, sampleFor(5), window)!;
    expect(next.acquisition).toEqual({
      provenance: 'monotonic-window',
      startOffsetMicroseconds: 120,
      endOffsetMicroseconds: 480,
      phaseBefore: 'scanning:progress',
      phaseAfter: 'materializing:progress',
      transition: 'observed-between-phase-observations',
    });
    expect(recordRssPeakDiagnostic(next, sampleFor(4), window)).toBe(next);
    expect(
      recordRssPeakDiagnostic(next, aggregateProcessTree([processEntry(10, 1, 'root-secret', 0, 9, 0, 0)], 10), window),
    ).toBe(next);
    expect(rssDiagnosticAcquisition(3, 7, 'scanning:progress', 'scanning:progress')).toMatchObject({
      transition: 'unknown',
    });
    expect(rssDiagnosticAcquisition(3, 7, '/private/customer/path', 'scanning:progress')).toMatchObject({
      phaseBefore: null,
      transition: 'unknown',
    });
    expect(rssDiagnosticAcquisition(3, 7, 'unexpected-label', 'other-label')).toMatchObject({
      phaseBefore: null,
      phaseAfter: null,
      transition: 'unknown',
    });
  });

  it('strictly rejects malformed optional diagnostics and inconsistent accounting or provenance', () => {
    const valid = artifactFor();
    expect(parseCodeGraphBenchmarkSamplerArtifact(valid)).toEqual(valid);
    const exactMax = artifactFor(sampleFor(Number.MAX_SAFE_INTEGER));
    expect(() =>
      parseCodeGraphBenchmarkSamplerArtifact({
        ...exactMax,
        rssPeakDiagnostic: {
          ...exactMax.rssPeakDiagnostic,
          admittedAccountingComplete: false,
          omittedRssBytes: null,
        },
      }),
    ).toThrow();
    const tree = aggregateProcessTree(
      [
        processEntry(10, 1, 'root-secret', 0, 1, 0, 0),
        processEntry(11, 10, 'child', 0, 2, 0, 0),
        processEntry(12, 11, 'grandchild', 0, 3, 0, 0),
      ],
      10,
      undefined,
      [],
      tokenize,
    )!;
    const treeArtifact = artifactFor(tree);
    const treePeak = treeArtifact.rssPeakDiagnostic!;
    expect(() =>
      parseCodeGraphBenchmarkSamplerArtifact({
        ...treeArtifact,
        rssPeakDiagnostic: {
          ...treePeak,
          contributors: [...treePeak.contributors].reverse(),
        },
      }),
    ).toThrow();
    expect(() =>
      parseCodeGraphBenchmarkSamplerArtifact({
        ...treeArtifact,
        rssPeakDiagnostic: {
          ...treePeak,
          contributors: treePeak.contributors.map(entry =>
            entry.role === 'descendant' ? {...entry, parentToken: 'a'.repeat(64)} : entry,
          ),
        },
      }),
    ).toThrow();
    const peak = valid.rssPeakDiagnostic!;
    const contributor = peak.contributors[0];
    const window = rssDiagnosticAcquisition(5, 8, 'scanning:progress', 'materializing:progress');
    const badPeaks = [
      null,
      {...peak, extra: 'leak'},
      {...peak, processCount: 0},
      {...peak, processCount: 17},
      {...peak, rssBytes: 4},
      {...peak, omittedRssBytes: 1},
      {...peak, omittedProcessCount: 1},
      {...peak, admittedAccountingComplete: false, omittedRssBytes: null},
      {...peak, admittedAccountingComplete: 'true'},
      {...peak, contributors: []},
      {...peak, contributors: Array(17).fill(contributor)},
      {...peak, contributors: [{...contributor, token: '10:root-secret'}]},
      {...peak, contributors: [{...contributor, role: 'worker'}]},
      {...peak, contributors: [{...contributor, role: 'descendant', parentToken: 'a'.repeat(64)}]},
      {...peak, contributors: [{...contributor, parentToken: contributor.token}]},
      {...peak, contributors: [{...contributor, rssBytes: -1}]},
      {...peak, contributors: [{...contributor, executable: '/bin/secret'}]},
      {...peak, acquisition: {...unknownInitial, startOffsetMicroseconds: 1}},
      {...peak, acquisition: {...window, startOffsetMicroseconds: 9}},
      {...peak, acquisition: {...window, endOffsetMicroseconds: Infinity}},
      {...peak, acquisition: {...window, phaseAfter: '/private/path'}},
      {...peak, acquisition: {...window, phaseAfter: 'scanning:progress'}},
      {...peak, acquisition: {...window, transition: 'unknown'}},
      {...peak, acquisition: {...window, processReadStart: 6}},
    ];
    for (const rssPeakDiagnostic of badPeaks) {
      expect(() => parseCodeGraphBenchmarkSamplerArtifact({...valid, rssPeakDiagnostic})).toThrow();
    }
    expect(() => parseCodeGraphBenchmarkSamplerArtifact({...validArtifact, rssPeakDiagnostic: peak})).toThrow();
    expect(() =>
      parseCodeGraphBenchmarkSamplerArtifact({
        ...valid,
        processTelemetry: {
          availability: 'unavailable',
          parentIdentityValidation: 'process-liveness-only',
          reason: 'parent-inspection-unavailable',
          source: 'none',
        },
      }),
    ).toThrow();
  });

  it.skipIf(!['darwin', 'linux'].includes(process.platform))(
    'plumbs explicit diagnostics through disposable sampler checkpoints',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-rss-diagnostic-'));
      const stop = join(root, 'stop');
      let sampler: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const phase = join(root, 'phase');
        const output = join(root, 'output.json');
        const checkpoint = join(root, 'checkpoint.json');
        const ready = join(root, 'ready.json');
        await writeFile(phase, 'scanning:progress');
        await writeFile(stop, 'complete');
        sampler = Bun.spawn({
          cmd: [
            process.execPath,
            fileURLToPath(new URL('../../../../scripts/code-graph-benchmark-sampler.ts', import.meta.url)),
            '--pid',
            String(process.pid),
            '--database',
            join(root, 'db'),
            '--temp-root',
            root,
            '--phase',
            phase,
            '--stop',
            stop,
            '--output',
            output,
            '--checkpoint-output',
            checkpoint,
            '--ready',
            ready,
            '--interval-ms',
            '10',
            '--checkpoint-ms',
            '20',
            '--rss-peak-diagnostics',
            'true',
          ],
          stderr: 'pipe',
          stdout: 'ignore',
        });
        await waitForText(ready, 5_000);
        const first = parseCodeGraphBenchmarkSamplerCheckpoint(JSON.parse(await readFile(checkpoint, 'utf8')));
        expect(first.sampler.rssPeakDiagnostic?.acquisition).toEqual(unknownInitial);
        await writeFile(stop, 'complete');
        expect(await sampler.exited).toBe(0);
        const text = await readFile(output, 'utf8');
        const artifact = parseCodeGraphBenchmarkSamplerArtifact(JSON.parse(text));
        expect(artifact.rssPeakDiagnostic?.contributors.length).toBeGreaterThanOrEqual(1);
        expect(artifact.rssPeakDiagnostic?.contributors.length).toBeLessThanOrEqual(16);
        expect(text).not.toContain(root);
        expect(JSON.stringify(artifact.rssPeakDiagnostic)).not.toContain('processId');
        expect(JSON.parse(await readFile(ready, 'utf8'))).toEqual({checkpointVersion: 4, version: 1});
      } finally {
        await writeFile(stop, 'complete').catch(() => undefined);
        if (sampler) await sampler.exited;
        await rm(root, {force: true, recursive: true});
      }
    },
    10_000,
  );
});

async function waitForText(file: string, timeoutMilliseconds = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMilliseconds;
  do {
    try {
      return await readFile(file, 'utf8');
    } catch {
      await Bun.sleep(5);
    }
  } while (Date.now() < deadline);
  throw TestError.make({message: `Timed out waiting for ${file}.`});
}

function processEntry(
  processId: number,
  parentProcessId: number,
  startIdentity: string,
  cpuMilliseconds: number,
  rssBytes: number,
  ioReadBytes: number,
  ioWriteBytes: number,
) {
  return {
    cpuMilliseconds,
    ioReadBytes,
    ioWriteBytes,
    parentProcessId,
    processId,
    rssBytes,
    startIdentity,
  };
}
