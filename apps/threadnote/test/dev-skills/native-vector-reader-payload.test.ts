import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Cause, Context, Effect, Exit, FileSystem, Layer, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import * as BunServices from '@effect/platform-bun/BunServices';
import {
  nativeVectorReaderBuildEnvironmentSha256,
  loadNativeVectorReader,
  verifyNativeVectorReaderPayload,
} from '@threadnote/recall/vector/native-reader-payload';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {platformPathFor, SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import {auditNativeReaderBinary} from '../../../../scripts/native-vector-reader-payload.js';
import {ScriptCommandExecutorLayer} from '../../../../scripts/effect/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

describe('Windows native binary audit output', () => {
  const fixture = Effect.fn(function* (
    options: {
      readonly dependencies?: string;
      readonly exports?: string;
      readonly largeExports?: boolean;
    } = {},
  ) {
    const native = yield* SystemInfo;
    const system = SystemInfo.of({...native, platform: 'win32'});
    const context = yield* Layer.build(
      ScriptCommandExecutorLayer.pipe(Layer.provide(Layer.succeed(SystemInfo, system))),
    );
    const actual = Context.get(context, CommandExecutor);
    const command = CommandExecutor.of({
      ...actual,
      execute: (executable, args, bounds) => {
        expect(executable).toBe('dumpbin');
        expect(bounds).toEqual({timeoutMs: 30_000, maxOutputBytes: 512 * 1024});
        expect(args).toContain('/HEADERS');
        expect(args).toContain('/DEPENDENTS');
        const program = `
process.stdout.write('FILE HEADER VALUES\\r\\n  AA64 machine (ARM64)\\r\\n  Image has the following dependencies:\\r\\n');
process.stdout.write(${JSON.stringify(options.dependencies ?? '  KERNEL32.dll\r\n')});
if (${args.includes('/EXPORTS')}) {
  process.stdout.write('  ordinal hint RVA      name\\r\\n');
  if (${options.largeExports === true}) {
    for (let index = 0; index < 12000; index++)
      process.stdout.write('    '+(index+1)+' '+index.toString(16)+' 00011000 ?allocate@tensor@ggml@@YAPEAX_KPEBD@Z'+index+'\\r\\n');
  } else process.stdout.write(${JSON.stringify(options.exports ?? '    1 0 00011000 napi_register_module_v1\r\n')});
}
`;
        return actual.execute(process.execPath, ['-e', program], bounds);
      },
    });
    return (inference = true, target = 'bun-windows-arm64') =>
      auditNativeReaderBinary('fixture.dll', target, {inference}).pipe(
        Effect.provideService(SystemInfo, system),
        Effect.provideService(CommandExecutor, command),
      );
  });
  effectIt.layer(Layer.merge(BunServices.layer, TestSystemInfoLayer))(layerIt => {
    layerIt.effect('audits inference dependencies without collecting a large unused C++ export table', () =>
      Effect.gen(function* () {
        const audit = yield* fixture({largeExports: true});
        expect(yield* audit()).toMatch(/^[a-f0-9]{64}$/u);
        const vector = yield* audit(false).pipe(Effect.exit);
        expect(Exit.isFailure(vector) && Cause.pretty(vector.cause)).toContain('CommandOutputLimitExceeded');
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('retains SQLite, private reader exports and the existing Windows CRT policies', () =>
      Effect.gen(function* () {
        const sqlite = yield* fixture({dependencies: '  sqlite3.dll\r\n'});
        const dependency = yield* sqlite().pipe(Effect.exit);
        expect(Exit.isFailure(dependency) && Cause.pretty(dependency.cause)).toContain('external SQLite');

        const crt = yield* fixture({dependencies: '  VCRUNTIME140.dll\r\n'});
        const arm = yield* crt().pipe(Effect.exit);
        expect(Exit.isFailure(arm) && Cause.pretty(arm.cause)).toContain('pinned static CRT');
        // The locked x64 inference distribution retains its existing upstream dynamic CRT allowance.
        expect(yield* crt(true, 'bun-windows-x64-baseline')).toMatch(/^[a-f0-9]{64}$/u);

        const leaked = yield* fixture({exports: '    2 1 00011000 sqlite3_open\r\n'});
        const symbols = yield* leaked(false).pipe(Effect.exit);
        expect(Exit.isFailure(symbols) && Cause.pretty(symbols.cause)).toContain('private SQLite symbols');
        const valid = yield* fixture();
        expect(yield* valid(false)).toMatch(/^[a-f0-9]{64}$/u);
      }).pipe(TestClock.withLive),
    );
  });
});

describe('Linux native binary audit failures', () => {
  // GCC12 config/libgcc-glibc.ver assigns frame registration helpers GLIBC_2.0 in libgcc itself.
  const libgccMusl = `
ELF Header:
  Machine: AArch64
Dynamic section at offset 0x0 contains 2 entries:
 0x0000000000000001 (NEEDED) Shared library: [libgcc_s.so.1]
 0x0000000000000001 (NEEDED) Shared library: [libc.musl-aarch64.so.1]
Version symbols section '.gnu.version' contains 4 entries:
 Addr: 0x0000000000000400  Offset: 0x000400  Link: 3 (.dynsym)
  000:   0 (*local*)   1 (*global*)   2 (GCC_3.0)   3 (GLIBC_2.0)
Version needs section '.gnu.version_r' contains 1 entry:
 Addr: 0x0000000000000500  Offset: 0x000500  Link: 4 (.dynstr)
  000000: Version: 1  File: libgcc_s.so.1  Cnt: 2
  0x0010:   Name: GCC_3.0  Flags: none  Version: 2
  0x0020:   Name: GLIBC_2.0  Flags: none  Version: 3
`;
  const fixture = Effect.fn(function* (elf: string, symbols = '000000000001 T napi_register_module_v1\n') {
    const native = yield* SystemInfo;
    const system = SystemInfo.of({...native, platform: 'linux'});
    const binary = '/private/do-not-publish/reader.node';
    const command = CommandExecutor.of({
      execute: (executable, args, bounds) =>
        Effect.sync(() => {
          expect(bounds).toEqual({timeoutMs: 30_000, maxOutputBytes: 512 * 1024});
          expect(args).toEqual(
            executable === 'readelf'
              ? ['--file-header', '--dynamic', '--version-info', binary]
              : ['-D', '--defined-only', binary],
          );
          expect(['readelf', 'nm']).toContain(executable);
          return {exitCode: 0, stdout: executable === 'readelf' ? elf : symbols, stderr: ''};
        }),
      executeStreaming: () => Effect.die('Unexpected streaming binary audit'),
    });
    return (target = 'bun-linux-arm64-musl', inference = false) =>
      auditNativeReaderBinary(binary, target, {inference}).pipe(
        Effect.provideService(SystemInfo, system),
        Effect.provideService(CommandExecutor, command),
      );
  });
  const diagnostic = (exit: Exit.Exit<unknown, unknown>) => {
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '';
    const encoded = /Bounded audit: (\{[^\n]+\})/u.exec(message)?.[1] ?? '{}';
    expect(encoded.length).toBeLessThanOrEqual(4096);
    expect(message).not.toContain('/private/do-not-publish');
    expect(message).not.toContain('unrelated audit noise');
    const value: unknown = JSON.parse(encoded);
    return value;
  };
  effectIt.layer(TestSystemInfoLayer)(layerIt => {
    layerIt.effect('accepts the pinned ARM musl libgcc compatibility namespace with complete ownership', () =>
      Effect.gen(function* () {
        const audit = yield* fixture(libgccMusl);
        for (const inference of [false, true])
          expect(yield* audit('bun-linux-arm64-musl', inference)).toMatch(/^[a-f0-9]{64}$/u);
        const otherTarget = yield* audit('bun-linux-x64-baseline-musl').pipe(Effect.exit);
        expect(Exit.isFailure(otherTarget)).toBe(true);
      }),
    );
    layerIt.effect('rejects GNU libc, unowned or ambiguous versions rather than trusting a namespace alone', () =>
      Effect.gen(function* () {
        const substitute = (before: string, after: string) => EffectString.replaceAll(before, after)(libgccMusl);
        const invalid = [
          substitute('libc.musl-aarch64.so.1', 'libc.so.6'),
          substitute('libgcc_s.so.1', 'libother.so.1'),
          substitute('GLIBC_2.0', 'GLIBC_2.17'),
          substitute('GLIBC_2.0', 'GLIBC_PRIVATE'),
          substitute('File: libgcc_s.so.1', 'File: libc.musl-aarch64.so.1'),
          substitute('Cnt: 2', 'Cnt: 3'),
          substitute('Version: 3', 'Version: 2'),
          substitute('3 (GLIBC_2.0)', '4 (GLIBC_2.0)'),
          substitute('File: libgcc_s.so.1', 'Unparsed owner: libgcc_s.so.1'),
          substitute("Version needs section '.gnu.version_r'", 'Unknown requirement section'),
          substitute('Shared library: [libgcc_s.so.1]', 'Shared library: [/untrusted/libgcc_s.so.1]'),
          `${libgccMusl}\nUnclassified GLIBC_2.0\n`,
          `${libgccMusl}\nVersion definition section '.gnu.version_d' contains 1 entry:\n 0x1: Name: GLIBC_2.0\n`,
          EffectString.replace('contains 1 entry:', 'contains 2 entries:')(libgccMusl) +
            '  0x0030: Version: 1  File: libc.musl-aarch64.so.1  Cnt: 1\n' +
            '  0x0040:   Name: GLIBC_2.0  Flags: none  Version: 4\n',
        ];
        for (const elf of invalid) {
          const audit = yield* fixture(elf);
          const exit = yield* audit().pipe(Effect.exit);
          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain('GNU libc symbol dependencies');
        }
        const exportedLookalike = yield* fixture(libgccMusl, '00000001 A GLIBC_2.0\n');
        expect(Exit.isFailure(yield* exportedLookalike().pipe(Effect.exit))).toBe(true);
      }),
    );
    layerIt.effect('retains musl rejection and reports capped required versions and library identities', () =>
      Effect.gen(function* () {
        const versions = EffectArray.makeBy(40, index => `GLIBC_2.${index + 17}`);
        const elf =
          'unrelated audit noise /private/do-not-publish/reader.node\n' +
          EffectString.repeat(20)(' 0x1 (NEEDED) Shared library: [libc.so.6]\n') +
          ' 0x1 (NEEDED) Shared library: [/private/do-not-publish/libsecret.so]\n' +
          "Version needs section '.gnu.version_r' contains 1 entry:\n" +
          ' 0x0: Version: 1 File: libc.so.6 Cnt: 40\n' +
          ' 0x0: Version: 1 File: /private/do-not-publish/libsecret.so Cnt: 0\n' +
          EffectArray.join(
            EffectArray.map(versions, name => ` 0x1: Name: ${name} Flags: none Version: 2`),
            '\n',
          );
        const audit = yield* fixture(elf);
        for (const inference of [false, true]) {
          const exit = yield* audit('bun-linux-arm64-musl', inference).pipe(Effect.exit);
          expect(diagnostic(exit)).toMatchObject({
            target: 'bun-linux-arm64-musl',
            domain: inference ? 'inference' : 'vector-reader',
            matchedVersions: {count: 40, values: EffectArray.take(versions, 8)},
            requiredVersions: {count: 40, values: EffectArray.take(versions, 8)},
            definedVersions: {count: 0, values: []},
            definedSymbolVersions: {count: 0, values: []},
            neededLibraries: {count: 1, values: ['libc.so.6']},
            versionNeedFiles: {count: 1, values: ['libc.so.6']},
          });
        }
      }),
    );
    layerIt.effect(
      'distinguishes definitions and defined symbols while retaining the existing conservative rejection',
      () =>
        Effect.gen(function* () {
          const audit = yield* fixture(
            "Version definition section '.gnu.version_d' contains 1 entry:\n 0x1: Name: GLIBC_2.17\n",
            '00000001 A GLIBC_2.18\n',
          );
          const exit = yield* audit().pipe(Effect.exit);
          expect(diagnostic(exit)).toMatchObject({
            requiredVersions: {count: 0, values: []},
            definedVersions: {count: 1, values: ['GLIBC_2.17']},
            definedSymbolVersions: {count: 1, values: ['GLIBC_2.18']},
          });
          const musl = yield* fixture(' 0x1 (NEEDED) Shared library: [libc.musl-aarch64.so.1]\n');
          expect(yield* musl()).toMatch(/^[a-f0-9]{64}$/u);
          const gnuFloor = yield* fixture('Name: GLIBC_2.17\n');
          expect(yield* gnuFloor('bun-linux-arm64')).toMatch(/^[a-f0-9]{64}$/u);
          const newer = yield* fixture('Name: GLIBC_2.18\n');
          const floor = yield* newer('bun-linux-arm64').pipe(Effect.exit);
          expect(Exit.isFailure(floor) && Cause.pretty(floor.cause)).toContain('glibc 2.17 floor');
        }),
    );
  });
});

describe('native reader filesystem payload boundary', () => {
  it('requires explicit developer bootstrap before source reads', async () => {
    await expect(
      loadNativeVectorReader({
        platform: 'darwin',
        architecture: 'arm64',
        executablePath: '/usr/bin/bun',
        environment: () => ({}),
      }),
    ).rejects.toThrow('native:bootstrap');
  });
  it('rejects missing advertised source artifacts', async () => {
    await expect(
      loadNativeVectorReader({
        platform: 'darwin',
        architecture: 'arm64',
        executablePath: '/usr/bin/bun',
        environment: () => ({THREADNOTE_NATIVE_VECTOR_READER_MANIFEST: '/nonexistent/threadnote-native-manifest.json'}),
      }),
    ).rejects.toThrow('manifest is missing');
  });
  effectIt.layer(BunServices.layer)(layerIt => {
    layerIt.effect('verifies final bytes and fails a modified advertised binary', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-payload-'});
        const path = platformPathFor(process.platform);
        const manifestPath = path.join(directory, 'manifest.json');
        const binary = path.join(directory, 'threadnote-vector-reader.node');
        yield* fs.writeFileString(binary, 'test-native-bytes');
        const manifest = {
          schemaVersion: 1,
          binary: 'threadnote-vector-reader.node',
          binarySha256: sha256HexSync('test-native-bytes'),
          bunTarget: 'bun-darwin-arm64',
          development: true,
          buildEnvironment: {compiler: 'fixture'},
          sourceRoot: '/test-checkout',
          buildInfo: {
            protocolVersion: 2,
            napiVersion: 6,
            crateVersion: '0.1.0',
            sqliteVersion: '3.54.1',
            sqliteSourceId: 'id',
            target: 'aarch64-apple-darwin',
            rustVersion: '1.89.0',
            buildEnvironmentSha256: nativeVectorReaderBuildEnvironmentSha256({compiler: 'fixture'}),
            crtStatic: false,
            deploymentTarget: '13.0',
            sourceCommit: EffectString.repeat(40)('a'),
            sourceTree: EffectString.repeat(40)('b'),
            lockSha256: EffectString.repeat(64)('c'),
            toolchainSha256: EffectString.repeat(64)('c'),
            sourceSha256: EffectString.repeat(64)('d'),
          },
        };
        yield* fs.writeFileString(manifestPath, JSON.stringify(manifest));
        expect(yield* Effect.promise(() => verifyNativeVectorReaderPayload(manifestPath))).toEqual(manifest);
        yield* fs.writeFileString(binary, 'signed-or-corrupted-different-bytes');
        yield* Effect.promise(() =>
          expect(verifyNativeVectorReaderPayload(manifestPath)).rejects.toThrow('digest mismatch'),
        );
      }),
    );
  });
});
