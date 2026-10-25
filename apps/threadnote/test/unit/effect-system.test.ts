import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp, fcProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {BunFileSystem} from '@effect/platform-bun';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from '@threadnote/testing/node-fs';
import {cpus, release, tmpdir, totalmem} from '@threadnote/testing/node-os';
import {join, posix as posixPath, win32 as windowsPath} from '@threadnote/testing/node-path';
import {succeedUndefined} from '@threadnote/platform/optional';
import {Clock, Deferred, Effect, FileSystem, Fiber, Option} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {describe, expect, it, vi} from 'vitest';
import {withoutTelemetrySessionEnvironment} from '@threadnote/threadnote/telemetry/session';
import {
  effectiveLinuxMemoryBytes,
  linuxCgroupMemoryFiles,
  parseLinuxCgroupMemoryLimitBytes,
} from '@threadnote/platform/linux_cgroup';
import {
  availableDiskBytesFromStatfs,
  fileSystemModeIsPrivate,
  legacyAvailableDiskBytes,
  makePersistentWindowsAvailableDiskBytes,
  parseCanonicalProcessStartIdentityOutput,
  parsePosixAvailableDiskBytes,
  parseLinuxProcessStartIdentity,
  parseProcessStartIdentityOutput,
  parseWindowsAvailableDiskBytes,
  platformPathFor,
  processResourceUsageMaxRssBytes,
  probeAvailableDiskBytes,
  probeRuntimeAvailableDiskBytes,
  readOpenedFileSystemIdentity,
  readPathFileSystemIdentity,
  resolveFileSystemIdentity,
  windowsDiskCapacityWorkerInvocation,
  probeWindowsProcessStartIdentity,
  readCanonicalProcessStartIdentity,
  readProcessStartIdentity,
  resolveHomeDirectory,
  runtimeHostHardwareInfo,
  runtimeLstat,
  runtimeOperatingSystemRelease,
  runtimeStat,
  runtimeTextDirectoryNames,
  makeCachedProcessStartIdentityResolver,
  SystemInfo,
  type WindowsDiskCapacityWorkerProcess,
} from '@threadnote/platform/system';
import {serveWindowsDiskCapacityWorker, windowsAvailableDiskBytesFromNative} from '@threadnote/platform/windows_system';

describe('SystemInfo structural path adapter', () => {
  it.each([
    {bunVersion: '1.3.14', expected: 544_440, platform: 'darwin', runtime: 'bun'},
    {bunVersion: '1.4.2', expected: 557_506_560, platform: 'darwin', runtime: 'bun'},
    {expected: 557_506_560, platform: 'freebsd', runtime: 'bun'},
    {expected: 557_506_560, platform: 'linux', runtime: 'bun'},
    {expected: 557_506_560, platform: 'win32', runtime: 'bun'},
    {expected: 557_506_560, platform: 'darwin', runtime: 'node'},
    {expected: 557_506_560, platform: 'freebsd', runtime: 'node'},
    {expected: 557_506_560, platform: 'linux', runtime: 'node'},
    {expected: 557_506_560, platform: 'win32', runtime: 'node'},
  ] satisfies ReadonlyArray<{
    readonly expected: number;
    readonly platform: NodeJS.Platform;
    readonly runtime: 'bun' | 'node';
    readonly bunVersion?: string;
  }>)('normalizes $runtime process maxRSS on $platform to bytes', ({bunVersion, expected, platform, runtime}) => {
    expect(processResourceUsageMaxRssBytes(544_440, platform, runtime, bunVersion)).toBe(expected);
  });

  fcEffectProp(
    effectIt,
    'enforces group and other privacy bits only on platforms with POSIX modes',
    {
      mode: FC.integer({max: 0o777, min: 0}),
      platform: FC.constantFrom('darwin' as const, 'linux' as const, 'win32' as const),
    },
    ({mode, platform}) =>
      Effect.sync(() => {
        expect(fileSystemModeIsPrivate(platform, mode)).toBe(platform === 'win32' || (mode & 0o077) === 0);
      }),
    {fastCheck: {numRuns: 100}},
  );

  fcEffectProp(
    effectIt,
    'uses observed safe filesystem identities and otherwise requires an exact identity',
    {
      dev: FC.constantFrom(0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1),
      exact: FC.option(
        FC.record({
          dev: FC.bigInt({max: (1n << 64n) - 1n, min: 0n}),
          ino: FC.bigInt({max: (1n << 96n) - 1n, min: 0n}),
        }),
        {nil: undefined},
      ),
      ino: FC.option(FC.constantFrom(0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1), {nil: undefined}),
    },
    ({dev, exact, ino}) =>
      Effect.sync(() => {
        const observed = ino === undefined ? Option.none<number>() : Option.some(ino);
        const expected =
          Number.isSafeInteger(dev) && ino !== undefined && Number.isSafeInteger(ino)
            ? {dev: BigInt(dev), ino: BigInt(ino)}
            : exact;
        expect(Option.getOrUndefined(resolveFileSystemIdentity(dev, observed, exact))).toEqual(expected);
      }),
    {fastCheck: {numRuns: 100}},
  );

  effectIt.effect('uses native identities only for matching types and usable descriptors', () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-filesystem-identity-'))),
        root =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const target = join(root, 'target');
            yield* fs.writeFileString(target, 'threadnote');
            const info = yield* fs.stat(target);
            const withoutInode = {...info, ino: Option.none<number>()};
            const exact = yield* Effect.sync(() => lstatSync(target, {bigint: true}));
            const expected = {dev: exact.dev, ino: exact.ino};

            expect(yield* readPathFileSystemIdentity(target, withoutInode, 'File')).toEqual(Option.some(expected));
            yield* Effect.acquireUseRelease(
              Effect.sync(() => openSync(target, 'r')),
              fd =>
                readOpenedFileSystemIdentity({fd} as unknown as FileSystem.File, withoutInode, 'File').pipe(
                  Effect.tap(identity => Effect.sync(() => expect(identity).toEqual(Option.some(expected)))),
                ),
              fd => Effect.sync(() => closeSync(fd)),
            );
            expect(yield* readPathFileSystemIdentity(target, withoutInode, 'Directory')).toEqual(Option.none());
            expect(yield* readPathFileSystemIdentity(join(root, 'missing'), withoutInode, 'File')).toEqual(
              Option.none(),
            );
            expect(
              yield* readOpenedFileSystemIdentity({fd: -1} as unknown as FileSystem.File, withoutInode, 'File'),
            ).toEqual(Option.none());
            expect(yield* readOpenedFileSystemIdentity({} as FileSystem.File, withoutInode, 'File')).toEqual(
              Option.none(),
            );
            expect(
              yield* readOpenedFileSystemIdentity({fd: 0} as unknown as FileSystem.File, withoutInode, 'Directory'),
            ).toEqual(Option.none());
            expect(
              yield* readOpenedFileSystemIdentity(
                {fd: Number.MAX_SAFE_INTEGER} as unknown as FileSystem.File,
                withoutInode,
                'File',
              ),
            ).toEqual(Option.none());
          }),
        root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
      ),
    ).pipe(provideTestLayer(BunFileSystem.layer)),
  );

  it('streams every UTF-8 directory name across native read buffers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-runtime-directory-stream-'));
    const expected = Array.from({length: 97}, (_unused, index) => `entry-${String(index).padStart(3, '0')}-λ`);
    try {
      for (const name of expected) writeFileSync(join(root, name), 'threadnote');
      const observed: string[] = [];
      for await (const name of runtimeTextDirectoryNames(root)) observed.push(name);

      expect(observed.sort()).toEqual(expected.sort());
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('retains the host kernel release for benchmark provenance', () => {
    expect(runtimeOperatingSystemRelease).toBe(release());
  });

  it('retains the exact host CPU and memory facts for benchmark provenance', () => {
    const expectedCpus = cpus();

    expect(runtimeHostHardwareInfo()).toEqual({
      cpuModel: expectedCpus[0]?.model ?? 'unknown',
      logicalCpuCount: expectedCpus.length,
      memoryBytes: totalmem(),
    });
  });

  fcEffectProp(
    effectIt,
    'matches the platform path contract across drives, UNC roots, separators, dots, and trailing separators',
    {
      child: FC.stringMatching(/^[A-Za-z0-9._-]{0,12}$/),
      platform: FC.constantFrom('linux' as const, 'win32' as const),
      prefix: FC.constantFrom('', '/', '//', '\\', 'C:\\', 'c:/', '\\\\server\\share\\', '//server/share/'),
      segments: FC.array(FC.constantFrom('.', '..', 'a', 'B', 'space name', 'é', '_'), {
        maxLength: 8,
      }),
      separator: FC.constantFrom('/', '\\', '//', '\\\\'),
      trailing: FC.constantFrom('', '/', '\\'),
    },
    ({child, platform, prefix, segments, separator, trailing}) =>
      Effect.sync(() => {
        const candidate = `${prefix}${segments.join(separator)}${trailing}`;
        const actual = platformPathFor(platform);
        const expected = platform === 'win32' ? windowsPath : posixPath;

        expect(actual.normalize(candidate)).toBe(expected.normalize(candidate));
        expect(actual.isAbsolute(candidate)).toBe(expected.isAbsolute(candidate));
        expect(actual.basename(candidate)).toBe(expected.basename(candidate));
        expect(actual.dirname(candidate)).toBe(expected.dirname(candidate));
        expect(actual.join(candidate, child)).toBe(expected.join(candidate, child));
        expect(actual.relative(candidate, actual.join(candidate, child))).toBe(
          expected.relative(candidate, expected.join(candidate, child)),
        );
        expect(actual.resolve(candidate, child)).toBe(expected.resolve(candidate, child));
        expect(actual.sep).toBe(expected.sep);
      }),
    {fastCheck: {numRuns: 200}},
  );

  it.skipIf(process.platform === 'win32')('distinguishes link identity from exact followed file identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-runtime-stat-'));
    try {
      const target = join(root, 'target');
      const link = join(root, 'link');
      writeFileSync(target, 'threadnote');
      symlinkSync(target, link);

      const [targetInfo, linkInfo, followedInfo] = await Promise.all([
        runtimeLstat(target),
        runtimeLstat(link),
        runtimeStat(link),
      ]);

      expect(linkInfo.isSymbolicLink()).toBe(true);
      expect(followedInfo.isFile()).toBe(true);
      expect(typeof followedInfo.dev).toBe('bigint');
      expect(typeof followedInfo.ino).toBe('bigint');
      expect(followedInfo.dev).toBe(targetInfo.dev);
      expect(followedInfo.ino).toBe(targetInfo.ino);
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it.skipIf(process.platform !== 'linux')('follows a deleted open file through its proc descriptor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-runtime-fd-stat-'));
    const target = join(root, 'deleted-open-file');
    writeFileSync(target, 'retained bytes');
    const descriptor = openSync(target, 'r');
    try {
      const expected = await runtimeStat(target);
      unlinkSync(target);
      const observed = await runtimeStat(`/proc/${process.pid}/fd/${descriptor}`);

      expect(observed.isFile()).toBe(true);
      expect(observed.size).toBe(expected.size);
      expect(observed.dev).toBe(expected.dev);
      expect(observed.ino).toBe(expected.ino);
    } finally {
      closeSync(descriptor);
      rmSync(root, {force: true, recursive: true});
    }
  });
});

describe('SystemInfo home directory resolution', () => {
  it('ignores empty Windows home variables', () => {
    expect(
      resolveHomeDirectory(
        {
          HOME: '',
          HOMEDRIVE: 'C:',
          HOMEPATH: '\\Users\\threadnote',
          USERPROFILE: '   ',
        },
        'win32',
      ),
    ).toBe('C:\\Users\\threadnote');
  });

  it('uses a non-empty POSIX HOME before compatibility variables', () => {
    expect(resolveHomeDirectory({HOME: '/home/threadnote', USERPROFILE: '/fallback'}, 'linux')).toBe(
      '/home/threadnote',
    );
  });

  it('fails explicitly when no home directory is available', () => {
    expect(() => resolveHomeDirectory({HOME: '', USERPROFILE: ''}, 'linux')).toThrow(
      'Could not determine the current user home directory',
    );
  });
});

describe('SystemInfo disk capacity parsing', () => {
  it('parses POSIX df output in 1024-byte blocks', () => {
    expect(
      parsePosixAvailableDiskBytes(
        'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 100000 12000 88000 12% /tmp\n',
      ),
    ).toBe(88_000 * 1024);
  });

  it('parses Windows free bytes and rejects invalid output', () => {
    expect(parseWindowsAvailableDiskBytes('987654321\r\n')).toBe(987_654_321);
    expect(parseWindowsAvailableDiskBytes('not-a-size')).toBeUndefined();
  });

  fcEffectProp(
    effectIt,
    'converts native Windows free bytes monotonically and saturates at the safe-integer limit',
    {
      higher: FC.bigInt({max: 18_446_744_073_709_551_615n, min: 0n}),
      lower: FC.bigInt({max: 18_446_744_073_709_551_615n, min: 0n}),
    },
    ({higher, lower}) =>
      Effect.sync(() => {
        const minimum = windowsAvailableDiskBytesFromNative(higher < lower ? higher : lower);
        const maximum = windowsAvailableDiskBytesFromNative(higher < lower ? lower : higher);
        if (minimum === undefined || maximum === undefined) {
          throw TestError.make({message: 'Valid native Windows capacities must produce safe integers.'});
        }
        expect(minimum).toBeLessThanOrEqual(maximum);
        expect(maximum).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
        expect(Number.isSafeInteger(minimum)).toBe(true);
        expect(Number.isSafeInteger(maximum)).toBe(true);
      }),
    {fastCheck: {numRuns: 100}},
  );

  it('rejects malformed native Windows capacity observations', () => {
    for (const malformed of [-1n, -1, 0, Number.MAX_SAFE_INTEGER, '1', null, undefined]) {
      expect(windowsAvailableDiskBytesFromNative(malformed)).toBeUndefined();
    }
    expect(windowsAvailableDiskBytesFromNative(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('re-invokes Windows capacity workers through installed and development entrypoints', () => {
    expect(
      windowsDiskCapacityWorkerInvocation(
        'C:\\Threadnote\\threadnote.exe',
        ['threadnote.exe'],
        'C:\\repo\\src\\standalone.ts',
      ),
    ).toEqual({
      arguments: ['--threadnote-windows-disk-capacity-worker'],
      executable: 'C:\\Threadnote\\threadnote.exe',
    });
    expect(
      windowsDiskCapacityWorkerInvocation(
        'C:\\Bun\\bun.exe',
        ['C:\\Bun\\bun.exe', 'C:\\repo\\src\\standalone.ts', 'graph'],
        'C:\\repo\\src\\standalone.ts',
      ),
    ).toEqual({
      arguments: ['C:\\repo\\src\\standalone.ts', '--threadnote-windows-disk-capacity-worker'],
      executable: 'C:\\Bun\\bun.exe',
    });
    expect(
      windowsDiskCapacityWorkerInvocation(
        'C:\\Bun\\bun.exe',
        ['C:\\Bun\\bun.exe', 'C:\\repo\\scripts\\benchmark-code-graph.ts'],
        'C:\\repo\\src\\standalone.ts',
      ),
    ).toEqual({
      arguments: ['C:\\repo\\src\\standalone.ts', '--threadnote-windows-disk-capacity-worker'],
      executable: 'C:\\Bun\\bun.exe',
    });
  });

  effectIt.effect('serves one fresh native Windows capacity observation per serial request', () =>
    Effect.gen(function* () {
      const observedPaths: string[] = [];
      const responses: string[] = [];
      yield* serveWindowsDiskCapacityWorker(
        {
          input: (async function* () {
            yield [
              JSON.stringify({id: '1', path: 'C:\\first', protocol: 1}),
              JSON.stringify({id: '2', path: 'D:\\second', protocol: 1}),
              '',
            ].join('\n');
          })(),
          writeLine: line => {
            responses.push(line);
            return Promise.resolve();
          },
        },
        path =>
          Effect.sync(() => {
            observedPaths.push(path);
            return observedPaths.length * 4_096;
          }),
      );

      expect(observedPaths).toEqual(['C:\\first', 'D:\\second']);
      expect(responses).toEqual([
        JSON.stringify({availableBytes: 4_096, id: '1', protocol: 1}),
        JSON.stringify({availableBytes: 8_192, id: '2', protocol: 1}),
      ]);
    }),
  );

  effectIt.effect('reuses one capacity worker while observing every request and closes it with the layer scope', () =>
    Effect.gen(function* () {
      let closedInputs = 0;
      let requests = 0;
      let spawns = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const windows = yield* makePersistentWindowsAvailableDiskBytes({
            developmentEntrypoint: '/repo/apps/threadnote/src/standalone.ts',
            sanitizeExternal: withoutTelemetrySessionEnvironment,
            spawnWorker: () => {
              spawns += 1;
              return scriptedWindowsCapacityWorker(
                line => {
                  requests += 1;
                  return windowsCapacityResponse(line, requests * 4_096);
                },
                () => {
                  closedInputs += 1;
                },
              );
            },
          });

          expect(yield* windows('C:\\first', {}, 1_000)).toBe(4_096);
          expect(yield* windows('C:\\second', {}, 1_000)).toBe(8_192);
          expect(spawns).toBe(1);
          expect(requests).toBe(2);
        }),
      );
      expect(closedInputs).toBe(1);
    }),
  );

  effectIt.effect('falls back after an invalid worker response and restarts on the next capacity boundary', () =>
    Effect.gen(function* () {
      let fallbackInvocations = 0;
      let killedWorkers = 0;
      let spawns = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const windows = yield* makePersistentWindowsAvailableDiskBytes({
            developmentEntrypoint: '/repo/apps/threadnote/src/standalone.ts',
            sanitizeExternal: withoutTelemetrySessionEnvironment,
            spawnWorker: () => {
              spawns += 1;
              return scriptedWindowsCapacityWorker(
                line => (spawns === 1 ? '{}' : windowsCapacityResponse(line, 32_768)),
                () => {
                  killedWorkers += 1;
                },
              );
            },
          });
          const adapters = {
            fallback: () =>
              Effect.sync(() => {
                fallbackInvocations += 1;
                return 16_384;
              }),
            statfs: () => Effect.die(TestError.make({message: 'Windows ARM64 must not use statfs.'})),
            windows,
          } satisfies Parameters<typeof probeRuntimeAvailableDiskBytes>[4];

          expect(yield* probeRuntimeAvailableDiskBytes('C:\\first', 'win32', 'arm64', {}, adapters, 1_000)).toBe(
            16_384,
          );
          expect(yield* probeRuntimeAvailableDiskBytes('C:\\second', 'win32', 'arm64', {}, adapters, 1_000)).toBe(
            32_768,
          );
        }),
      );

      expect(spawns).toBe(2);
      expect(fallbackInvocations).toBe(1);
      expect(killedWorkers).toBe(2);
    }),
  );

  effectIt.effect('kills a blocked Windows capacity worker and uses the bounded fallback', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        if (process.platform === 'win32') return;
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const root = mkdtempSync(join(tmpdir(), 'threadnote-windows-disk-worker-'));
            const processIdPath = join(root, 'process.pid');
            const workerPath = join(root, 'worker.ts');
            writeFileSync(
              workerPath,
              `await Bun.write(${JSON.stringify(processIdPath)}, String(process.pid));\nfor await (const _chunk of process.stdin) await Bun.sleep(30_000);\n`,
            );
            return {processIdPath, root, workerPath};
          }),
          fixture =>
            Effect.scoped(
              Effect.gen(function* () {
                let fallbackInvocations = 0;
                const windows = yield* makePersistentWindowsAvailableDiskBytes({
                  developmentEntrypoint: '/repo/apps/threadnote/src/standalone.ts',
                  invocation: {arguments: [fixture.workerPath], executable: process.execPath},
                  sanitizeExternal: withoutTelemetrySessionEnvironment,
                });
                const startedAt = yield* Clock.currentTimeMillis;
                const fiber = yield* probeRuntimeAvailableDiskBytes(
                  'C:\\blocked-worker-fixture',
                  'win32',
                  'arm64',
                  process.env,
                  {
                    fallback: () =>
                      Effect.sync(() => {
                        fallbackInvocations += 1;
                        return 16_384;
                      }),
                    statfs: () => Effect.die(TestError.make({message: 'Windows ARM64 must not use statfs.'})),
                    windows,
                  },
                  750,
                ).pipe(Effect.forkChild({startImmediately: true}));
                const processId = yield* waitForRecordedProcessId(fixture.processIdPath, PROCESS_START_WAIT_MS);

                expect(yield* Fiber.join(fiber)).toBe(16_384);
                expect(fallbackInvocations).toBe(1);
                expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(2_000);
                yield* waitForProcessExit(processId, 2_000);
              }),
            ),
          fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
        );
      }),
    ),
  );

  effectIt.effect('uses an absolute POSIX disk probe when PATH is unavailable', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        if (process.platform === 'win32') return;
        const available = yield* legacyAvailableDiskBytes(
          process.cwd(),
          process.platform,
          {PATH: ''},
          withoutTelemetrySessionEnvironment,
        );

        expect(available).toBeDefined();
        expect(available).toBeGreaterThan(0);
      }),
    ),
  );

  fcEffectProp(
    effectIt,
    'converts native statfs values to a conservative safe integer monotonically',
    {
      availableBlocks: FC.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
      blockSize: FC.integer({max: 1_048_576, min: 1}),
      fewerAvailableBlocks: FC.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
    },
    ({availableBlocks, blockSize, fewerAvailableBlocks}) =>
      Effect.sync(() => {
        const lowerBlocks = Math.min(availableBlocks, fewerAvailableBlocks);
        const higherBlocks = Math.max(availableBlocks, fewerAvailableBlocks);
        const exactBytes = BigInt(higherBlocks) * BigInt(blockSize);
        const expected = Number(
          exactBytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : exactBytes,
        );
        const lower = availableDiskBytesFromStatfs({bavail: BigInt(lowerBlocks), bsize: BigInt(blockSize)});
        const higher = availableDiskBytesFromStatfs({bavail: BigInt(higherBlocks), bsize: BigInt(blockSize)});
        if (lower === undefined || higher === undefined) {
          throw TestError.make({message: 'Valid native statfs values must produce a safe capacity.'});
        }

        expect(higher).toBe(expected);
        expect(lower).toBeLessThanOrEqual(higher);
        expect(Number.isSafeInteger(lower)).toBe(true);
        expect(Number.isSafeInteger(higher)).toBe(true);
      }),
    {fastCheck: {numRuns: 100}},
  );

  effectIt.effect('uses native asynchronous statistics on supported POSIX platforms without falling back', () =>
    Effect.gen(function* () {
      for (const platform of ['darwin', 'linux'] as const) {
        let fallbackInvocations = 0;
        let nativeInvocations = 0;
        const available = yield* probeAvailableDiskBytes(
          '/private/native-statfs-fixture',
          platform,
          {},
          {
            fallback: () =>
              Effect.sync(() => {
                fallbackInvocations += 1;
                return 1;
              }),
            statfs: () =>
              Effect.sync(() => {
                nativeInvocations += 1;
                return {bavail: 256n, bsize: 4096n};
              }),
          },
        );

        expect(available).toBe(1_048_576);
        expect(nativeInvocations).toBe(1);
        expect(fallbackInvocations).toBe(0);
      }
    }),
  );

  effectIt.effect('routes macOS Intel capacity probes through the bounded fallback', () =>
    Effect.gen(function* () {
      let fallbackInvocations = 0;
      let nativeInvocations = 0;
      const available = yield* probeRuntimeAvailableDiskBytes(
        '/private/darwin-x64-statfs-fixture',
        'darwin',
        'x64',
        {},
        {
          fallback: () =>
            Effect.sync(() => {
              fallbackInvocations += 1;
              return 8_192;
            }),
          statfs: () =>
            Effect.sync(() => {
              nativeInvocations += 1;
              return {bavail: 1n, bsize: 1n};
            }),
        },
      );

      expect(available).toBe(8_192);
      expect(fallbackInvocations).toBe(1);
      expect(nativeInvocations).toBe(0);
    }),
  );

  effectIt.effect('uses native Windows ARM64 capacity without launching the fallback', () =>
    Effect.gen(function* () {
      let fallbackInvocations = 0;
      let statfsInvocations = 0;
      let windowsInvocations = 0;
      const available = yield* probeRuntimeAvailableDiskBytes(
        'C:\\threadnote-arm64-capacity-fixture',
        'win32',
        'arm64',
        {},
        {
          fallback: () =>
            Effect.sync(() => {
              fallbackInvocations += 1;
              return 16_384;
            }),
          statfs: () =>
            Effect.sync(() => {
              statfsInvocations += 1;
              return {bavail: 1n, bsize: 1n};
            }),
          windows: () =>
            Effect.sync(() => {
              windowsInvocations += 1;
              return 32_768;
            }),
        },
      );

      expect(available).toBe(32_768);
      expect(fallbackInvocations).toBe(0);
      expect(statfsInvocations).toBe(0);
      expect(windowsInvocations).toBe(1);
    }),
  );

  effectIt.effect('falls back when the native Windows ARM64 capacity probe is unavailable or fails', () =>
    Effect.gen(function* () {
      for (const native of [
        () => succeedUndefined,
        () => Effect.fail(TestError.make({message: 'Native Windows capacity failed.'})),
      ]) {
        let fallbackInvocations = 0;
        let statfsInvocations = 0;
        const available = yield* probeRuntimeAvailableDiskBytes(
          'C:\\threadnote-arm64-capacity-fixture',
          'win32',
          'arm64',
          {},
          {
            fallback: () =>
              Effect.sync(() => {
                fallbackInvocations += 1;
                return 16_384;
              }),
            statfs: () =>
              Effect.sync(() => {
                statfsInvocations += 1;
                return {bavail: 1n, bsize: 1n};
              }),
            windows: native,
          },
        );

        expect(available).toBe(16_384);
        expect(fallbackInvocations).toBe(1);
        expect(statfsInvocations).toBe(0);
      }
    }),
  );

  effectIt.effect('shares one Windows ARM64 deadline between the native query and fallback', () =>
    Effect.gen(function* () {
      let fallbackInterruptions = 0;
      const fiber = yield* probeRuntimeAvailableDiskBytes(
        'C:\\threadnote-arm64-capacity-deadline',
        'win32',
        'arm64',
        {},
        {
          fallback: () =>
            Effect.sleep(60).pipe(
              Effect.as(16_384),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  fallbackInterruptions += 1;
                }),
              ),
            ),
          statfs: () => Effect.die(TestError.make({message: 'Windows ARM64 must not use statfs.'})),
          windows: () => Effect.sleep(60).pipe(Effect.as(undefined)),
        },
        100,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(60);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(40);

      expect(yield* Fiber.join(fiber)).toBeUndefined();
      expect(fallbackInterruptions).toBe(1);
    }),
  );

  effectIt.effect('retains the native statfs route on Windows x64', () =>
    Effect.gen(function* () {
      let fallbackInvocations = 0;
      let statfsInvocations = 0;
      let windowsInvocations = 0;
      const available = yield* probeRuntimeAvailableDiskBytes(
        'C:\\threadnote-x64-capacity-fixture',
        'win32',
        'x64',
        {},
        {
          fallback: () =>
            Effect.sync(() => {
              fallbackInvocations += 1;
              return 16_384;
            }),
          statfs: () =>
            Effect.sync(() => {
              statfsInvocations += 1;
              return {bavail: 8n, bsize: 4_096n};
            }),
          windows: () =>
            Effect.sync(() => {
              windowsInvocations += 1;
              return 65_536;
            }),
        },
      );

      expect(available).toBe(32_768);
      expect(fallbackInvocations).toBe(0);
      expect(statfsInvocations).toBe(1);
      expect(windowsInvocations).toBe(0);
    }),
  );

  effectIt.effect('falls back only for structured native-statfs unavailability', () =>
    Effect.gen(function* () {
      const unavailableCodes = ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'ERR_NOT_IMPLEMENTED', 'ERR_METHOD_NOT_IMPLEMENTED'];
      let fallbackInvocations = 0;
      for (const code of unavailableCodes) {
        const available = yield* probeAvailableDiskBytes(
          '/private/unavailable-statfs-fixture',
          'linux',
          {},
          {
            fallback: () =>
              Effect.sync(() => {
                fallbackInvocations += 1;
                return 42;
              }),
            statfs: () => Effect.fail(Object.assign(TestError.make({message: 'Native statfs unavailable.'}), {code})),
          },
        );
        expect(available).toBe(42);
      }

      for (const code of ['EACCES', 'EIO', 'ENOENT']) {
        const available = yield* probeAvailableDiskBytes(
          '/private/ordinary-statfs-failure',
          'linux',
          {},
          {
            fallback: () =>
              Effect.sync(() => {
                fallbackInvocations += 1;
                return 99;
              }),
            statfs: () =>
              Effect.fail(
                Object.assign(TestError.make({message: `/private/ordinary-statfs-failure: ${code}`}), {code}),
              ),
          },
        );
        expect(available).toBeUndefined();
      }

      expect(fallbackInvocations).toBe(unavailableCodes.length);
    }),
  );

  effectIt.effect('bounds a stalled native probe without launching the fallback', () =>
    Effect.gen(function* () {
      let fallbackInvocations = 0;
      let nativeInvocations = 0;
      const fiber = yield* probeAvailableDiskBytes(
        '/private/stalled-statfs-fixture',
        'linux',
        {},
        {
          fallback: () =>
            Effect.sync(() => {
              fallbackInvocations += 1;
              return 99;
            }),
          statfs: () =>
            Effect.sync(() => {
              nativeInvocations += 1;
            }).pipe(Effect.andThen(Effect.never)),
        },
        25,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* TestClock.adjust(25);

      expect(yield* Fiber.join(fiber)).toBeUndefined();
      expect(nativeInvocations).toBe(1);
      expect(fallbackInvocations).toBe(0);
    }),
  );

  effectIt.effect('shares one total deadline between unavailable native detection and fallback work', () =>
    Effect.gen(function* () {
      let fallbackInterruptions = 0;
      let fallbackInvocations = 0;
      let nativeInvocations = 0;
      const fiber = yield* probeAvailableDiskBytes(
        '/private/total-statfs-deadline-fixture',
        'linux',
        {},
        {
          fallback: () =>
            Effect.sync(() => {
              fallbackInvocations += 1;
            }).pipe(
              Effect.andThen(Effect.sleep(60)),
              Effect.as(99),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  fallbackInterruptions += 1;
                }),
              ),
            ),
          statfs: () =>
            Effect.sync(() => {
              nativeInvocations += 1;
            }).pipe(
              Effect.andThen(Effect.sleep(60)),
              Effect.andThen(
                Effect.fail(Object.assign(TestError.make({message: 'Native statfs unavailable.'}), {code: 'ENOSYS'})),
              ),
            ),
        },
        100,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* TestClock.adjust(60);
      yield* Effect.yieldNow;
      expect(nativeInvocations).toBe(1);
      expect(fallbackInvocations).toBe(1);

      yield* TestClock.adjust(40);

      expect(yield* Fiber.join(fiber)).toBeUndefined();
      expect(fallbackInterruptions).toBe(1);
    }),
  );

  effectIt.effect('preempts and kills the real asynchronous fallback at the shared deadline', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        if (process.platform === 'win32') return;
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const root = mkdtempSync(join(tmpdir(), 'threadnote-disk-fallback-'));
            const processIdPath = join(root, 'process.pid');
            writeFileSync(
              join(root, 'df'),
              '#!/bin/sh\nprintf \'%s\' "$$" > "$THREADNOTE_DISK_PROBE_PID"\nexec /bin/sleep 30\n',
              {mode: 0o700},
            );
            return {processIdPath, root};
          }),
          fixture =>
            Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis;
              const fiber = yield* probeAvailableDiskBytes(
                '/private/blocked-fallback-fixture',
                process.platform,
                {...process.env, PATH: fixture.root, THREADNOTE_DISK_PROBE_PID: fixture.processIdPath},
                {
                  fallback: (path, platform, environment) =>
                    legacyAvailableDiskBytes(
                      path,
                      platform,
                      environment,
                      withoutTelemetrySessionEnvironment,
                      join(fixture.root, 'df'),
                    ),
                  statfs: () =>
                    Effect.fail(
                      Object.assign(TestError.make({message: 'Native statfs unavailable.'}), {code: 'ENOSYS'}),
                    ),
                },
                750,
              ).pipe(Effect.forkChild({startImmediately: true}));
              const processId = yield* waitForRecordedProcessId(fixture.processIdPath, PROCESS_START_WAIT_MS);

              expect(yield* Fiber.join(fiber)).toBeUndefined();
              expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(2_000);
              yield* waitForProcessExit(processId, 2_000);
            }),
          fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
        );
      }),
    ),
  );

  effectIt.effect('uses only the selected adapter across a bounded supported-host probe load', () =>
    Effect.acquireUseRelease(
      Effect.sync(() => ({spawn: vi.spyOn(Bun, 'spawn'), spawnSync: vi.spyOn(Bun, 'spawnSync')})),
      spies =>
        Effect.gen(function* () {
          if (process.platform !== 'darwin' && process.platform !== 'linux') return;
          const system = yield* SystemInfo;
          const capacities = yield* Effect.all(
            Array.from({length: 128}, () => system.availableDiskBytes(process.cwd())),
            {concurrency: 16},
          );

          expect(capacities).toHaveLength(128);
          expect(capacities.every(value => value !== undefined && Number.isSafeInteger(value) && value >= 0)).toBe(
            true,
          );
          if (process.platform === 'darwin' && process.arch === 'x64') {
            expect(spies.spawn).toHaveBeenCalledTimes(128);
            for (const [options] of spies.spawn.mock.calls) {
              expect(options).toMatchObject({cmd: ['/bin/df', '-Pk', process.cwd()]});
            }
          } else {
            expect(spies.spawn).not.toHaveBeenCalled();
          }
          expect(spies.spawnSync).not.toHaveBeenCalled();
        }).pipe(provideTestLayer(TestSystemInfoLayer)),
      spies =>
        Effect.sync(() => {
          spies.spawn.mockRestore();
          spies.spawnSync.mockRestore();
        }),
    ),
  );
});

function windowsCapacityResponse(request: string, availableBytes: number): string {
  const id = /"id":"([1-9][0-9]{0,31})"/u.exec(request)?.[1];
  if (id === undefined) throw TestError.make({message: 'Expected a bounded Windows capacity request identity.'});
  return JSON.stringify({availableBytes, id, protocol: 1});
}

function scriptedWindowsCapacityWorker(
  respond: (line: string) => string,
  onClose: () => void,
): WindowsDiskCapacityWorkerProcess {
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const writer = output.writable.getWriter();
  const encoder = new TextEncoder();
  let resolveExit = (_code: number) => {};
  const exited = new Promise<number>(resolve => {
    resolveExit = resolve;
  });
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    onClose();
    resolveExit(0);
    void writer.close().catch(() => undefined);
  };
  return {
    closeInput: () => {
      finish();
      return Promise.resolve();
    },
    exited,
    kill: finish,
    stdout: output.readable,
    write: async line => {
      if (closed) throw TestError.make({message: 'Cannot write to a closed scripted Windows capacity worker.'});
      await writer.write(encoder.encode(`${respond(line)}\n`));
    },
  };
}

const PROCESS_START_WAIT_MS = 5_000;

function waitForRecordedProcessId(path: string, timeoutMilliseconds: number) {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMilliseconds;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (existsSync(path)) {
        const processId = Number(readFileSync(path, 'utf8').trim());
        if (Number.isSafeInteger(processId) && processId > 0) return processId;
      }
      yield* Effect.sleep(10);
    }
    return yield* TestError.make({message: 'Timed out waiting for the fallback process to start.'});
  });
}

function waitForProcessExit(processId: number, timeoutMilliseconds: number) {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMilliseconds;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (!isProcessRunning(processId)) return;
      yield* Effect.sleep(10);
    }
    return yield* TestError.make({message: 'Timed out waiting for the fallback process to exit.'});
  });
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Linux cgroup effective memory', () => {
  fcProp(
    effectIt,
    'resolves every normalized cgroup ancestor exactly once from current group to mount root',
    {
      segments: FC.array(FC.stringMatching(/^[a-z][a-z0-9:_-]{0,12}$/), {maxLength: 8, minLength: 1}),
    },
    ({segments}) => {
      const relative = segments.join('/');
      const files = linuxCgroupMemoryFiles(
        `0::/tenant/${relative}\n`,
        '29 23 0:26 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
      );
      const expected = Array.from({length: segments.length + 1}, (_, index) => {
        const ancestor = segments.slice(0, segments.length - index).join('/');
        return {path: `/sys/fs/cgroup/${ancestor ? `${ancestor}/` : ''}memory.max`, version: 2 as const};
      });

      expect(files).toEqual(expected);
      expect(new Set(files.map(file => file.path)).size).toBe(files.length);
      expect(files.every(file => file.path.startsWith('/sys/fs/cgroup/') && !file.path.includes('..'))).toBe(true);
    },
    {fastCheck: {numRuns: 100}},
  );

  it('resolves cgroup v2 current and visible ancestor limits with colon-bearing paths', () => {
    const files = linuxCgroupMemoryFiles(
      '0::/tenant.slice/job:blue/task\n',
      '29 23 0:26 /tenant.slice /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n',
    );

    expect(files).toEqual([
      {path: '/sys/fs/cgroup/job:blue/task/memory.max', version: 2},
      {path: '/sys/fs/cgroup/job:blue/memory.max', version: 2},
      {path: '/sys/fs/cgroup/memory.max', version: 2},
    ]);
  });

  it('maps a cgroup namespace root to a non-root mount and decodes escaped mount paths', () => {
    const files = linuxCgroupMemoryFiles(
      '0::/\n',
      '31 23 0:28 /docker/hidden /sys/fs/cgroup\\040memory rw - cgroup2 cgroup rw\n',
    );

    expect(files).toEqual([{path: '/sys/fs/cgroup memory/memory.max', version: 2}]);
  });

  it('resolves hybrid v1 and v2 memory hierarchies while ignoring unrelated mounts', () => {
    const files = linuxCgroupMemoryFiles(
      ['0::/unified/work', '5:cpu,memory:/legacy/team/work', '7:cpu:/cpu-only/work'].join('\n'),
      [
        '20 18 0:20 /unified /sys/fs/cgroup/unified rw - cgroup2 cgroup rw',
        '21 18 0:21 /legacy/team /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory',
        '22 18 0:22 /cpu-only /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu',
      ].join('\n'),
    );

    expect(files).toEqual([
      {path: '/sys/fs/cgroup/unified/work/memory.max', version: 2},
      {path: '/sys/fs/cgroup/unified/memory.max', version: 2},
      {path: '/sys/fs/cgroup/memory/work/memory.limit_in_bytes', version: 1},
      {path: '/sys/fs/cgroup/memory/memory.limit_in_bytes', version: 1},
    ]);
  });

  it('rejects unsafe or malformed membership paths and deduplicates repeated controllers', () => {
    const mount = '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n';
    expect(linuxCgroupMemoryFiles('0::/safe/../escape\n', mount)).toEqual([]);
    expect(linuxCgroupMemoryFiles('malformed\n', mount)).toEqual([]);
    expect(linuxCgroupMemoryFiles('0::/safe\n0::/safe\n', mount)).toEqual([
      {path: '/sys/fs/cgroup/safe/memory.max', version: 2},
      {path: '/sys/fs/cgroup/memory.max', version: 2},
    ]);
  });

  it('parses finite limits exactly and treats unlimited sentinels as non-constraining', () => {
    const gib = 1_024 * 1_024 * 1_024;
    expect(parseLinuxCgroupMemoryLimitBytes('8589934592\n')).toBe(8_589_934_592n);
    expect(parseLinuxCgroupMemoryLimitBytes('max')).toBeUndefined();
    expect(parseLinuxCgroupMemoryLimitBytes('-1')).toBeUndefined();
    expect(parseLinuxCgroupMemoryLimitBytes('0')).toBeUndefined();
    expect(parseLinuxCgroupMemoryLimitBytes('8 GiB')).toBeUndefined();
    expect(parseLinuxCgroupMemoryLimitBytes('9223372036854771712')).toBeUndefined();
    expect(effectiveLinuxMemoryBytes(64 * gib, ['max', '9223372036854771712', String(16 * gib), String(8 * gib)])).toBe(
      8 * gib,
    );
    expect(effectiveLinuxMemoryBytes(64 * gib, ['max', '-1', '9223372036854771712'])).toBe(64 * gib);
  });
});

describe('SystemInfo process identity', () => {
  it('parses Linux stat fields after a command name containing spaces and parentheses', () => {
    const fieldsThroughProcessStart = ['S', ...Array.from({length: 18}, (_, index) => String(index + 1)), '987654'];
    expect(parseLinuxProcessStartIdentity(`123 (threadnote) worker) ${fieldsThroughProcessStart.join(' ')}\n`)).toBe(
      'linux:987654',
    );
    expect(parseLinuxProcessStartIdentity('malformed stat')).toBeUndefined();
    expect(
      parseLinuxProcessStartIdentity(
        `123 (threadnote) ${['S', ...Array.from({length: 18}, () => '0'), 'not-a-tick'].join(' ')}`,
      ),
    ).toBeUndefined();
  });

  it('preserves the legacy macOS and Windows process-start formats', () => {
    expect(parseProcessStartIdentityOutput('darwin', ' Tue Jul 28 18:57:16 2026\n')).toBe(
      'darwin:Tue Jul 28 18:57:16 2026',
    );
    expect(parseProcessStartIdentityOutput('darwin', ' sob sie  8 23:04:27 2026\n')).toBe(
      'darwin:sob sie  8 23:04:27 2026',
    );
    expect(parseProcessStartIdentityOutput('win32', '638893834360000000\r\n')).toBe('win32:638893834360000000');
    expect(parseProcessStartIdentityOutput('linux', '123')).toBeUndefined();
    expect(parseProcessStartIdentityOutput('darwin', '   ')).toBeUndefined();
  });

  it('normalizes canonical Darwin output to a versioned format', () => {
    expect(parseCanonicalProcessStartIdentityOutput('darwin', ' Tue Jul 28 18:57:16 2026\n')).toBe(
      'darwin-v2:Tue Jul 28 18:57:16 2026',
    );
    expect(parseCanonicalProcessStartIdentityOutput('darwin', 'Sat Aug  8 23:04:27 2026    \n')).toBe(
      'darwin-v2:Sat Aug  8 23:04:27 2026',
    );
    expect(parseCanonicalProcessStartIdentityOutput('win32', '638893834360000000\r\n')).toBe(
      'win32:638893834360000000',
    );
  });

  it('rejects localized, path-bearing, control-bearing, or unbounded process-start output', () => {
    for (const output of [
      'sob sie  8 23:04:27 2026',
      'Sat Aug  8 23:04:27 /private/tmp',
      'Sat Aug  8 23:04:27 2026\nextra',
      '\tSat Aug  8 23:04:27 2026',
      '\u001bSat Aug  8 23:04:27 2026',
      'Sat Aug 32 23:04:27 2026',
      'Sat Aug  8 24:04:27 2026',
      `Sat Aug  8 23:04:27 ${'2'.repeat(64)}`,
    ]) {
      expect(parseCanonicalProcessStartIdentityOutput('darwin', output)).toBeUndefined();
    }
    for (const output of [
      '0638893834360000000',
      '638893834360000000/path',
      '638893834360000000\nextra',
      '\t638893834360000000',
      '1'.repeat(21),
    ]) {
      expect(parseCanonicalProcessStartIdentityOutput('win32', output)).toBeUndefined();
    }
  });

  fcProp(
    effectIt,
    'emits only bounded path-free canonical process-start identities',
    {
      output: FC.string({maxLength: 96}),
      platform: FC.constantFrom('darwin' as const, 'win32' as const),
    },
    ({output, platform}) => {
      const identity = parseCanonicalProcessStartIdentityOutput(platform, output);
      if (identity === undefined) return;

      expect(identity.length).toBeLessThanOrEqual(34);
      expect(
        Array.from(identity).every(character => {
          const codePoint = character.codePointAt(0);
          return (
            character !== '/' && character !== '\\' && codePoint !== undefined && codePoint >= 32 && codePoint !== 127
          );
        }),
      ).toBe(true);
    },
    {fastCheck: {numRuns: 200}},
  );

  fcEffectProp(
    effectIt,
    'keeps the native Windows identity fast path and falls back only when it is unavailable',
    {
      nativeAvailable: FC.boolean(),
      processId: FC.integer({max: 2_147_483_647, min: 1}),
      ticks: FC.bigInt({max: 9_999_999_999_999_999_999n, min: 0n}),
    },
    ({nativeAvailable, processId, ticks}) =>
      Effect.gen(function* () {
        let fallbackInvocations = 0;
        let nativeInvocations = 0;
        const nativeIdentity = `win32:${ticks}`;
        const fallbackIdentity = `win32:${ticks + 1n}`;
        const identity = yield* probeWindowsProcessStartIdentity(
          processId,
          {},
          {
            fallback: candidate =>
              Effect.sync(() => {
                expect(candidate).toBe(processId);
                fallbackInvocations += 1;
                return fallbackIdentity;
              }),
            native: candidate =>
              Effect.sync(() => {
                expect(candidate).toBe(processId);
                nativeInvocations += 1;
                return nativeAvailable ? nativeIdentity : undefined;
              }),
          },
        );

        expect(identity).toBe(nativeAvailable ? nativeIdentity : fallbackIdentity);
        expect(nativeInvocations).toBe(1);
        expect(fallbackInvocations).toBe(nativeAvailable ? 0 : 1);
      }),
    {fastCheck: {numRuns: 100}},
  );

  effectIt.effect('bounds and fails closed when Windows process identity adapters fail or stall', () =>
    Effect.gen(function* () {
      const failed = yield* probeWindowsProcessStartIdentity(
        42,
        {},
        {
          fallback: () => Effect.fail(TestError.make({message: 'fallback failed'})),
          native: () => succeedUndefined,
        },
        25,
      );
      expect(failed).toBeUndefined();

      let fallbackInterrupted = 0;
      const stalled = yield* probeWindowsProcessStartIdentity(
        42,
        {},
        {
          fallback: () =>
            Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  fallbackInterrupted += 1;
                }),
              ),
            ),
          native: () => succeedUndefined,
        },
        25,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* TestClock.adjust(25);

      expect(yield* Fiber.join(stalled)).toBeUndefined();
      expect(fallbackInterrupted).toBe(1);
    }),
  );

  effectIt.effect('preserves hostile Darwin legacy observations while canonicalizing the explicit v2 channel', () =>
    process.platform === 'win32'
      ? Effect.void
      : Effect.acquireUseRelease(
          Effect.sync(() => {
            const root = mkdtempSync(join(tmpdir(), 'threadnote-process-identity-channel-'));
            writeFileSync(
              join(root, 'ps'),
              '#!/bin/sh\nif [ "$THREADNOTE_PROCESS_IDENTITY_MODE" = legacy ]; then\n  [ "$LC_ALL" = pl_PL.UTF-8 ] || exit 70\n  [ "$LANG" = pl_PL.UTF-8 ] || exit 71\n  [ "$TZ" = Pacific/Kiritimati ] || exit 72\n  printf \'sob sie  8 23:04:27 2026\\n\'\nelse\n  [ "$LC_ALL" = C ] || exit 73\n  [ "$LANG" = C ] || exit 74\n  [ "$TZ" = UTC ] || exit 75\n  printf \'Sat Aug  8 23:04:27 2026    \\n\'\nfi\n',
              {mode: 0o700},
            );
            return root;
          }),
          root =>
            Effect.gen(function* () {
              const hostileEnvironment = {
                ...process.env,
                LANG: 'pl_PL.UTF-8',
                LC_ALL: 'pl_PL.UTF-8',
                PATH: '',
                TZ: 'Pacific/Kiritimati',
              };
              const command = join(root, 'ps');

              expect(
                yield* readProcessStartIdentity(
                  10_000,
                  'darwin',
                  {...hostileEnvironment, THREADNOTE_PROCESS_IDENTITY_MODE: 'legacy'},
                  withoutTelemetrySessionEnvironment,
                  1_000,
                  command,
                ),
              ).toBe('darwin:sob sie  8 23:04:27 2026');
              expect(
                yield* readCanonicalProcessStartIdentity(
                  10_000,
                  'darwin',
                  {...hostileEnvironment, THREADNOTE_PROCESS_IDENTITY_MODE: 'canonical'},
                  withoutTelemetrySessionEnvironment,
                  1_000,
                  command,
                ),
              ).toBe('darwin-v2:Sat Aug  8 23:04:27 2026');
            }),
          root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
        ),
  );

  effectIt.effect('bounds concurrent Darwin probes and kills every timed-out or interrupted ps child', () =>
    process.platform === 'win32'
      ? Effect.void
      : TestClock.withLive(
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const root = mkdtempSync(join(tmpdir(), 'threadnote-process-identity-'));
              writeFileSync(
                join(root, 'ps'),
                '#!/bin/sh\n[ "$LC_ALL" = C ] || exit 70\n[ "$LANG" = C ] || exit 71\n[ "$TZ" = UTC ] || exit 72\nprintf \'%s\\n\' "$$" >> "$THREADNOTE_PROCESS_IDENTITY_PIDS"\nexec /bin/sleep 30\n',
                {mode: 0o700},
              );
              return {root};
            }),
            fixture =>
              Effect.gen(function* () {
                const timedOutProcessIdsPath = join(fixture.root, 'timed-out-pids');
                const timedOutEnvironment = {
                  ...process.env,
                  LANG: 'pl_PL.UTF-8',
                  LC_ALL: 'pl_PL.UTF-8',
                  PATH: '',
                  THREADNOTE_PROCESS_IDENTITY_PIDS: timedOutProcessIdsPath,
                  TZ: 'Pacific/Kiritimati',
                };
                const timedOutStartedAt = yield* Clock.currentTimeMillis;
                const identities = yield* Effect.all(
                  Array.from({length: 4}, (_, index) =>
                    readCanonicalProcessStartIdentity(
                      10_000 + index,
                      'darwin',
                      timedOutEnvironment,
                      withoutTelemetrySessionEnvironment,
                      350,
                      join(fixture.root, 'ps'),
                    ),
                  ),
                  {concurrency: 'unbounded'},
                );
                const timedOutElapsed = (yield* Clock.currentTimeMillis) - timedOutStartedAt;
                const timedOutProcessIds = yield* waitForRecordedProcessIds(timedOutProcessIdsPath, 4, 1_000);

                expect(identities).toEqual([undefined, undefined, undefined, undefined]);
                expect(timedOutElapsed).toBeLessThan(2_000);
                expect(new Set(timedOutProcessIds).size).toBe(4);
                yield* Effect.forEach(timedOutProcessIds, processId => waitForProcessExit(processId, 2_000), {
                  concurrency: 'unbounded',
                });

                const interruptedProcessIdsPath = join(fixture.root, 'interrupted-pids');
                const interruptedEnvironment = {
                  ...process.env,
                  LANG: 'pl_PL.UTF-8',
                  LC_ALL: 'pl_PL.UTF-8',
                  PATH: '',
                  THREADNOTE_PROCESS_IDENTITY_PIDS: interruptedProcessIdsPath,
                  TZ: 'Pacific/Kiritimati',
                };
                const interrupted = yield* Effect.all(
                  Array.from({length: 4}, (_, index) =>
                    readCanonicalProcessStartIdentity(
                      20_000 + index,
                      'darwin',
                      interruptedEnvironment,
                      withoutTelemetrySessionEnvironment,
                      30_000,
                      join(fixture.root, 'ps'),
                    ),
                  ),
                  {concurrency: 'unbounded'},
                ).pipe(Effect.forkChild({startImmediately: true}));
                const interruptedProcessIds = yield* waitForRecordedProcessIds(interruptedProcessIdsPath, 4, 1_000);
                const interruptedAt = yield* Clock.currentTimeMillis;

                yield* Fiber.interrupt(interrupted);

                expect((yield* Clock.currentTimeMillis) - interruptedAt).toBeLessThan(2_000);
                expect(new Set(interruptedProcessIds).size).toBe(4);
                yield* Effect.forEach(interruptedProcessIds, processId => waitForProcessExit(processId, 2_000), {
                  concurrency: 'unbounded',
                });
              }),
            fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
          ),
        ),
  );

  effectIt.effect('caches legacy and canonical own-process identities independently', () =>
    Effect.gen(function* () {
      let legacyProbeCount = 0;
      let canonicalProbeCount = 0;
      const legacy = yield* makeCachedProcessStartIdentityResolver(42, () =>
        Effect.sync(() => {
          legacyProbeCount += 1;
          return 'darwin:legacy-observation';
        }),
      );
      const canonical = yield* makeCachedProcessStartIdentityResolver(42, () =>
        Effect.sync(() => {
          canonicalProbeCount += 1;
          return 'darwin-v2:canonical-observation';
        }),
      );

      expect(yield* legacy(42)).toBe('darwin:legacy-observation');
      expect(yield* legacy(42)).toBe('darwin:legacy-observation');
      expect(legacyProbeCount).toBe(1);
      expect(canonicalProbeCount).toBe(0);

      expect(yield* canonical(42)).toBe('darwin-v2:canonical-observation');
      expect(yield* canonical(42)).toBe('darwin-v2:canonical-observation');
      expect(legacyProbeCount).toBe(1);
      expect(canonicalProbeCount).toBe(1);
    }),
  );

  effectIt.effect('shares and caches an exact five-second unavailable own-process probe', () =>
    Effect.gen(function* () {
      let probeCount = 0;
      const resolve = yield* makeCachedProcessStartIdentityResolver(42, () =>
        Effect.sync(() => {
          probeCount += 1;
        }).pipe(Effect.andThen(Effect.sleep(5_000)), Effect.as(undefined)),
      );
      const fiber = yield* Effect.all(
        Array.from({length: 32}, () => resolve(42)),
        {
          concurrency: 'unbounded',
        },
      ).pipe(Effect.forkChild({startImmediately: true}));
      yield* Effect.yieldNow;

      expect(probeCount).toBe(1);
      yield* TestClock.adjust(4_999);
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(fiber)).toEqual(Array.from({length: 32}, () => undefined));
      expect(probeCount).toBe(1);
      expect(yield* resolve(42)).toBeUndefined();
      expect(probeCount).toBe(1);
    }),
  );

  effectIt.effect('re-elects one owner after interruption so pending callers converge on the retry', () =>
    Effect.gen(function* () {
      const firstProbeStarted = yield* Deferred.make<void>();
      let probeCount = 0;
      const resolve = yield* makeCachedProcessStartIdentityResolver(42, () =>
        Effect.suspend(() => {
          probeCount += 1;
          return probeCount === 1
            ? Deferred.succeed(firstProbeStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed('fixture-process-start');
        }),
      );
      const firstOwner = yield* resolve(42).pipe(Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(firstProbeStarted);
      const waiters = yield* Effect.forEach(Array.from({length: 31}), () =>
        resolve(42).pipe(Effect.forkChild({startImmediately: true})),
      );

      yield* Fiber.interrupt(firstOwner);

      expect(yield* Effect.forEach(waiters, Fiber.join)).toEqual(
        Array.from({length: 31}, () => 'fixture-process-start'),
      );
      expect(yield* resolve(42)).toBe('fixture-process-start');
      expect(probeCount).toBe(2);
    }),
  );

  effectIt.effect('cannot strand pending callers when interrupted immediately after ownership acquisition', () =>
    Effect.gen(function* () {
      const firstOwnerClaimed = yield* Deferred.make<void>();
      const releaseFirstOwner = yield* Deferred.make<void>();
      let ownerClaimCount = 0;
      let probeCount = 0;
      const resolve = yield* makeCachedProcessStartIdentityResolver(
        42,
        () =>
          Effect.sync(() => {
            probeCount += 1;
            return 'fixture-process-start';
          }),
        Effect.suspend(() => {
          ownerClaimCount += 1;
          return ownerClaimCount === 1
            ? Deferred.succeed(firstOwnerClaimed, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstOwner)),
                Effect.asVoid,
              )
            : Effect.void;
        }),
      );
      const firstOwner = yield* resolve(42).pipe(Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(firstOwnerClaimed);
      const waiters = yield* Effect.forEach(Array.from({length: 31}), () =>
        resolve(42).pipe(Effect.forkChild({startImmediately: true})),
      );
      const interruption = yield* Fiber.interrupt(firstOwner).pipe(Effect.forkChild({startImmediately: true}));
      yield* Effect.yieldNow;

      yield* Deferred.succeed(releaseFirstOwner, undefined);
      yield* Fiber.join(interruption);

      expect(yield* Effect.forEach(waiters, Fiber.join)).toEqual(
        Array.from({length: 31}, () => 'fixture-process-start'),
      );
      expect(yield* resolve(42)).toBe('fixture-process-start');
      expect(ownerClaimCount).toBe(2);
      expect(probeCount).toBe(1);
    }),
  );

  effectIt.effect('reports a stable identity for the current process on the host adapter', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const canonicalProcessStartIdentity = system.canonicalProcessStartIdentity;
      if (canonicalProcessStartIdentity === undefined) {
        return yield* TestError.make({message: 'The production SystemInfo layer must provide the canonical channel.'});
      }
      const identities = [
        yield* system.processStartIdentity(system.processId),
        yield* system.processStartIdentity(system.processId),
      ] as const;
      const canonicalIdentities = [
        yield* canonicalProcessStartIdentity(system.processId),
        yield* canonicalProcessStartIdentity(system.processId),
      ] as const;

      expect(identities[0]).toBeTruthy();
      expect(identities[1]).toBe(identities[0]);
      expect(canonicalIdentities[0]).toBeTruthy();
      expect(canonicalIdentities[1]).toBe(canonicalIdentities[0]);
      if (system.platform === 'darwin') {
        expect(identities[0]).toMatch(/^darwin:/);
        expect(canonicalIdentities[0]).toMatch(/^darwin-v2:/);
      } else {
        expect(canonicalIdentities[0]).toBe(identities[0]);
      }
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );
});

function waitForRecordedProcessIds(path: string, expectedCount: number, timeoutMilliseconds: number) {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMilliseconds;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (existsSync(path)) {
        const processIds = readFileSync(path, 'utf8')
          .split(/\r?\n/)
          .map(value => Number(value.trim()))
          .filter(processId => Number.isSafeInteger(processId) && processId > 0);
        if (processIds.length >= expectedCount) return processIds.slice(0, expectedCount);
      }
      yield* Effect.sleep(10);
    }
    return yield* TestError.make({message: `Timed out waiting for ${expectedCount} process identity probes to start.`});
  });
}

describe('SystemInfo benchmark metadata', () => {
  effectIt.effect('reports process peak RSS in bytes', () =>
    Effect.gen(function* () {
      const memory = (yield* SystemInfo).memoryUsage();
      const peakRss = memory.peakRss ?? 0;

      expect(peakRss).toBeGreaterThan(1_048_576);
      expect(peakRss).toBeGreaterThanOrEqual(memory.rss);
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  effectIt.effect('reports real CPU, memory, and operating-system values', () =>
    Effect.gen(function* () {
      const hardware = yield* (yield* SystemInfo).hardwareInfo;

      expect(hardware.cpuModel.trim().length).toBeGreaterThan(0);
      expect(hardware.memoryBytes).toBeGreaterThan(0);
      expect(hardware.effectiveMemoryBytes).toBeGreaterThan(0);
      expect(hardware.effectiveMemoryBytes).toBeLessThanOrEqual(hardware.memoryBytes);
      expect(hardware.operatingSystem.trim().length).toBeGreaterThan(0);
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );
});
