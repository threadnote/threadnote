import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import * as EffectString from 'effect/String';
import {
  MUSL_NATIVE_SOURCE,
  muslNativeArchitecture,
  validateMuslBuildMetadata,
  validateMuslCmakeCache,
  validateMuslElfReport,
  expectedNativeRuntimeBuildType,
  verifyMuslTrackedSource,
  muslLinkedArtifact,
  validateMuslBuildInventory,
} from '../../../../scripts/build.js';
import {javascriptStringLiteral, optionalNativePackageFallbackModule} from '../../../../scripts/effect/javascript.js';

describe('build-time JavaScript string serialization', () => {
  it('preserves the value without emitting script-breaking characters', () => {
    const value = '</script> "quoted" \\\nline\u2028separator\u2029paragraph';
    const literal = javascriptStringLiteral(value);

    expect(literal).not.toMatch(/[<>\u2028\u2029]/);
    expect(JSON.parse(literal)).toBe(value);
  });

  it('executes the optional native package fallback with a self-contained error', async () => {
    const source = optionalNativePackageFallbackModule();
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const fallback: unknown = await import(moduleUrl);
    if (!isNativePackageFallback(fallback)) throw new Error('Optional native package fallback was invalid.');

    expect(() => fallback.getBinsDir()).toThrowError(
      new Error('Optional native package is not included in this Threadnote artifact.'),
    );
  });
});

function isNativePackageFallback(value: unknown): value is {readonly getBinsDir: () => unknown} {
  return typeof value === 'object' && value !== null && 'getBinsDir' in value && typeof value.getBinsDir === 'function';
}

describe('pinned musl source payload admission', () => {
  const metadata = (arch: string) => ({
    buildOptions: {
      platform: 'linux',
      arch,
      gpu: false,
      customCmakeOptions: {},
      llamaCpp: {repo: 'ggml-org/llama.cpp', release: 'v0.7.0'},
    },
  });
  const cache =
    'CMAKE_GENERATOR:INTERNAL=Unix Makefiles\nGGML_NATIVE:BOOL=OFF\nGGML_CPU_ALL_VARIANTS:BOOL=ON\nGGML_BACKEND_DL:BOOL=ON\nGGML_OPENMP:BOOL=OFF\n';
  const elf = (arch: string) =>
    `Class: ELF64\nData: 2's complement, little endian\nMachine: ${arch === 'x64' ? 'Advanced Micro Devices X86-64' : 'AArch64'}\n(NEEDED) Shared library: [libc.musl-${arch === 'x64' ? 'x86_64' : 'aarch64'}.so.1]\n(RUNPATH) Library runpath: [$ORIGIN]\n`;
  const provenance = (arch: string) => ({
    target: `bun-linux-${arch}-musl`,
    nativeRuntimeSource: {
      kind: 'source-built',
      buildType: 'localBuild',
      ...MUSL_NATIVE_SOURCE,
      architecture: arch,
      libc: 'musl',
      sourceTree: {tree: EffectString.repeat(40)('c'), disposition: 'bundled-base'},
      files: {'llama-addon.node': EffectString.repeat(64)('a'), '_nlcBuildMetadata.json': EffectString.repeat(64)('b')},
    },
  });
  it('keeps real local-build provenance distinct from every nonmusl prebuilt branch', () => {
    for (const arch of ['x64', 'arm64'] as const) {
      expect(muslNativeArchitecture(`bun-linux-${arch}-musl`)).toBe(arch);
      expect(expectedNativeRuntimeBuildType(provenance(arch))).toBe('localBuild');
      expect(() => validateMuslBuildMetadata(metadata(arch), arch)).not.toThrow();
      expect(validateMuslElfReport(elf(arch), arch, ['llama-addon.node'])).toEqual([
        `libc.musl-${arch === 'x64' ? 'x86_64' : 'aarch64'}.so.1`,
      ]);
    }
    expect(muslNativeArchitecture('bun-linux-x64-baseline-musl')).toBe('x64');
    for (const target of ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-arm64', 'bun-windows-x64']) {
      expect(muslNativeArchitecture(target)).toBeUndefined();
      expect(expectedNativeRuntimeBuildType({target})).toBe('prebuilt');
    }
    expect(() => muslNativeArchitecture('bun-linux-riscv64-musl')).toThrow();
    expect(() =>
      expectedNativeRuntimeBuildType({target: 'bun-linux-x64-musl', nativeRuntimePackage: '@node-llama-cpp/linux-x64'}),
    ).toThrow();
    expect(() => validateMuslCmakeCache(cache)).not.toThrow();
  });
  it('rejects independently corrupted source/platform/options and portable flags', () => {
    for (const changes of [
      {platform: 'darwin'},
      {arch: 'arm64'},
      {gpu: 'vulkan'},
      {customCmakeOptions: {GGML_NATIVE: 'ON'}},
      {llamaCpp: {repo: 'unreviewed/fork', release: 'latest'}},
    ])
      expect(() =>
        validateMuslBuildMetadata({buildOptions: {...metadata('x64').buildOptions, ...changes}}, 'x64'),
      ).toThrow();
    for (const key of ['GGML_NATIVE', 'GGML_CPU_ALL_VARIANTS', 'GGML_BACKEND_DL', 'GGML_OPENMP'])
      expect(() =>
        validateMuslCmakeCache(EffectString.replace(new RegExp(`^${key}:[^\\n]+\\n`, 'mu'), '')(cache)),
      ).toThrow();
    for (const [report, check] of [
      [elf('arm64'), 'machine'],
      [elf('x64') + 'GLIBC_2.38', 'glibc'],
      [elf('x64') + '(NEEDED) Shared library: [libunshipped.so]\n', 'needed'],
      [EffectString.replace('$ORIGIN', '/workspace/node_modules')(elf('x64')), 'search-path'],
      [EffectString.replace('ELF64', 'ELF32')(elf('x64')), 'class'],
      [EffectString.replace('little endian', 'big endian')(elf('x64')), 'data'],
      [EffectString.repeat(262145)('x'), 'size'],
    ])
      expect(() =>
        validateMuslElfReport(report, 'x64', ['llama-addon.node'], {name: 'llama-addon.node', bytes: 123}),
      ).toThrow(`"check":"${check}"`);
  });
  it('bounds rejection evidence to admitted names and closed ELF facts without exposing report paths', () => {
    const report =
      elf('arm64') +
      '(NEEDED) Shared library: [/private/build/secret.so]\n' +
      '(RPATH) Library rpath: [/private/build/secret]\nGLIBC_2.38';
    const reject = (name: string) => {
      try {
        validateMuslElfReport(report, 'x64', ['llama-addon.node'], {name, bytes: 123});
        throw new Error('Expected ELF refusal.');
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return error.message;
      }
    };
    const message = reject('llama-addon.node');
    expect(message).toContain('Incompatible musl ELF payload.');
    expect(message).toContain('"check":"machine"');
    expect(message).toContain('"member":"llama-addon.node"');
    expect(message).toContain('"memberBytes":123');
    expect(message).toContain(`"reportBytes":${Buffer.byteLength(report, 'utf8')}`);
    expect(message).toContain('"class":"ELF64","data":"little-endian","machine":"arm64"');
    expect(message).toContain('"needed":["libc.musl-aarch64.so.1","unrecognized"]');
    expect(message).toContain('"rpath":["external"],"runpath":["$ORIGIN"]');
    expect(message).toContain('"forbidden":["GLIBC_"]');
    expect(message).not.toContain('/private');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThan(2048);
    expect(reject('/private/unadmitted.node')).toContain('"member":"unavailable","memberBytes":null');
    const excessive = elf('x64') + EffectString.repeat(100)('(NEEDED) Shared library: [libunshipped.so]\n');
    expect(() => validateMuslElfReport(excessive, 'x64', ['llama-addon.node'])).toThrow(
      '"needed":["libc.musl-x86_64.so.1","libunshipped.so"',
    );
    try {
      validateMuslElfReport(excessive, 'x64', []);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThan(2048);
    }
  });
  it('admits only independently generated CMake dynamic targets, not an extra valid musl library', () => {
    const linked = ['llama-addon.node', 'libggml-base.so', 'libggml-cpu-x64.so'];
    expect(muslLinkedArtifact('/usr/bin/c++ -shared -o ../../bin/libggml-cpu-x64.so object.o')).toEqual({
      output: '../../bin/libggml-cpu-x64.so',
      name: 'libggml-cpu-x64.so',
    });
    expect(muslLinkedArtifact('/usr/bin/ar qc libcommon.a object.o')).toBeUndefined();
    expect(() => muslLinkedArtifact('/usr/bin/c++ -o one.so -o two.so')).toThrow();
    const inventory = ['_nlcBuildMetadata.json', ...linked];
    expect(() => validateMuslBuildInventory(inventory, linked)).not.toThrow();
    expect(() => validateMuslElfReport(elf('x64'), 'x64', inventory)).not.toThrow();
    expect(() => validateMuslBuildInventory([...inventory, 'libunrelated.so'], linked)).toThrow();
    expect(() => validateMuslBuildInventory(inventory, linked.slice(0, 2))).toThrow();
    expect(inventory).toEqual(['_nlcBuildMetadata.json', ...linked]);
  });
  it('never grants a musl local runtime after any source-identity field is changed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'packageVersion',
          'repository',
          'tag',
          'commit',
          'bundleSha256',
          'upstreamPatchSha256',
          'architecture',
          'libc',
          'kind',
          'buildType',
        ),
        fc.string({maxLength: 80}),
        (key, value) => {
          const original = provenance('x64');
          if (Reflect.get(original.nativeRuntimeSource, key) === value) return;
          const changed = {...original, nativeRuntimeSource: {...original.nativeRuntimeSource, [key]: value}};
          expect(() => expectedNativeRuntimeBuildType(changed)).toThrow();
          expect(original.nativeRuntimeSource.commit).toBe('1729d2ec2c4846df7754f4ce8f90f75f8a30ca3b');
        },
      ),
      {numRuns: 32},
    );
  });
});

effectIt.effect('verifies only the base or exact packaged patch without mutating the original Git index or HEAD', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-musl-source-proof-test-'}));
    const source = path.join(root, 'source'),
      hooks = path.join(root, 'hooks');
    yield* fs.makeDirectory(source);
    yield* fs.makeDirectory(hooks);
    const git = (args: readonly string[]) =>
      Effect.sync(() => {
        const result = Bun.spawnSync({
          cmd: ['git', '-C', source, '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args],
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (result.exitCode !== 0) throw new Error('Git fixture setup failed');
        return new TextDecoder().decode(result.stdout);
      });
    yield* git(['init', '--quiet']);
    const file = path.join(source, 'value.txt');
    yield* fs.writeFileString(file, 'base\n');
    yield* git(['add', 'value.txt']);
    yield* git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'base',
    ]);
    const commit = EffectString.trim(yield* git(['rev-parse', 'HEAD']));
    const index = yield* fs.readFile(path.join(source, '.git', 'index'));
    yield* fs.writeFileString(file, 'patched\n');
    const patch = path.join(root, 'packaged.diff');
    yield* fs.writeFileString(patch, yield* git(['diff', '--binary']));
    yield* fs.writeFileString(file, 'base\n');
    const base = yield* verifyMuslTrackedSource(source, patch, commit);
    expect(base.disposition).toBe('bundled-base');
    yield* fs.writeFileString(file, 'patched\n');
    const patched = yield* verifyMuslTrackedSource(source, patch, commit);
    expect(patched.disposition).toBe('packaged-PR22566');
    expect(patched.tree).not.toBe(base.tree);
    yield* fs.writeFileString(file, 'patched\nextra\n');
    expect((yield* verifyMuslTrackedSource(source, patch, commit).pipe(Effect.result))._tag).toBe('Failure');
    yield* fs.writeFileString(file, 'base\n');
    yield* fs.writeFileString(path.join(source, 'unowned.txt'), 'extra');
    expect((yield* verifyMuslTrackedSource(source, patch, commit).pipe(Effect.result))._tag).toBe('Failure');
    expect(yield* fs.readFile(path.join(source, '.git', 'index'))).toEqual(index);
    expect(EffectString.trim(yield* git(['rev-parse', 'HEAD']))).toBe(commit);
    expect(yield* fs.readFileString(file)).toBe('base\n');
    // No request is sent: Git refuses this transport before attempting the unreachable URL.
    const denied = yield* Effect.sync(() =>
      Bun.spawnSync({
        cmd: ['git', 'clone', 'https://127.0.0.1:9/forbidden', path.join(root, 'never-cloned')],
        env: {
          ...process.env,
          GIT_ALLOW_PROTOCOL: 'file',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: path.join(root, 'absent-config'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    expect(denied.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(denied.stderr)).toContain("transport 'https' not allowed");
    const workflow = yield* fs.readFileString(path.join(process.cwd(), '.github/workflows/native-release-smoke.yml'));
    expect(workflow).toContain(
      'GIT_ALLOW_PROTOCOL=file node node_modules/node-llama-cpp/dist/cli/cli.js source download',
    );
  }).pipe(provideTestLayer(BunServices.layer)),
);
