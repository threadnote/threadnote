import {CommandExecutor, CommandFailed, CommandTimedOut} from '@threadnote/platform/command';
import {
  assembleNativeInference,
  muslWorkflowRuntimeArguments,
  MUSL_WORKFLOW_BWRAP_SHIM,
  nativeContainerFailureReport,
  nativeInferenceBuildEnvironment,
  GNU_INFERENCE_COMPILER_BOOTSTRAP,
  muslToolchainFetchScript,
} from '../../../../scripts/assemble-native-inference.js';
import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, String as EffectString} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {
  NATIVE_INFERENCE_LLAMA_COMMIT,
  publishNativeInferenceOverlay,
  stageNativeInferenceOverlay,
  verifyNativeInferenceOverlay,
} from '../../../../scripts/native-inference-payload.js';

describe('native inference overlay filesystem boundary', () => {
  it('selects the pinned GNU compiler only for inference without changing vector build inputs', () => {
    const environment = {
      CC: '/original/gcc',
      CXX: '/original/g++',
      THREADNOTE_NATIVE_INFERENCE_CC: '/opt/clang/bin/clang',
      THREADNOTE_NATIVE_INFERENCE_CXX: '/opt/clang/bin/clang++',
    };
    expect(nativeInferenceBuildEnvironment(environment)).toMatchObject({
      CC: '/opt/clang/bin/clang',
      CXX: '/opt/clang/bin/clang++',
    });
    expect(environment.CC).toBe('/original/gcc');
    expect(environment.CXX).toBe('/original/g++');
    expect(nativeInferenceBuildEnvironment({CC: '/native/cc'})).toEqual({CC: '/native/cc'});
  });

  it('retains build stdout even when Docker pull diagnostics occupy stderr', () => {
    const error = CommandFailed.make({
      args: ['run'],
      executable: 'docker',
      exitCode: 7,
      message: 'Docker failed: pull progress',
      stdout: 'actual native build failure',
      stderr: 'image pull progress\nNative GNU container failed at requested-command (exit 7)',
    });
    expect(nativeContainerFailureReport(error)).toEqual({
      version: 1,
      failure: 'CommandFailed',
      exitCode: 7,
      stdout: error.stdout,
      stderr: error.stderr,
    });
    expect(error.exitCode).toBe(7);
    const timeout = CommandTimedOut.make({
      args: ['run'],
      executable: 'docker',
      timeoutMs: 1000,
      message: 'container timed out',
    });
    expect(nativeContainerFailureReport(timeout)).toEqual({
      version: 1,
      failure: 'CommandTimedOut',
      message: timeout.message,
    });
  });

  it('runs the extracted musl harness with only its explicit archive/profile environment', () => {
    const arguments_ = muslWorkflowRuntimeArguments({
      THREADNOTE_RELEASE_ARCHIVE: 'artifacts/threadnote-linux-arm64-musl.tar.gz',
      THREADNOTE_RELEASE_PROFILE: 'all',
      GH_TOKEN: 'must-not-forward',
    });
    expect(arguments_).toEqual([
      '--cap-add',
      'SYS_ADMIN',
      '--security-opt',
      'apparmor=unconfined',
      '--env',
      'THREADNOTE_RELEASE_ARCHIVE=artifacts/threadnote-linux-arm64-musl.tar.gz',
      '--env',
      'THREADNOTE_RELEASE_PROFILE=all',
    ]);
    expect(arguments_).not.toContain('--privileged');
    for (const environment of [
      {},
      {THREADNOTE_RELEASE_ARCHIVE: 'artifacts/threadnote-linux-x64.tar.gz', THREADNOTE_RELEASE_PROFILE: 'all'},
      {THREADNOTE_RELEASE_ARCHIVE: 'artifacts/threadnote-linux-x64-musl.tar.gz'},
    ])
      expect(() => muslWorkflowRuntimeArguments(environment)).toThrow('extracted release archive and profile');
  });

  effectIt.layer(BunServices.layer)(it => {
    it.effect.skipIf(process.platform === 'win32')(
      'passes exact APK constraints through world, restores it, and pins the compiler helper arguments',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({prefix: 'native toolchain shell '});
          const literal = (value: string) => "'" + EffectString.replaceAll("'", "'\"'\"'")(value) + "'";
          const world = path.join(directory, 'world');
          const backup = path.join(directory, 'original-world');
          const observed = path.join(directory, 'solver-world');
          const apk = path.join(directory, 'apk');
          const compiler = path.join(directory, 'manylinux-install-clang');
          const compilerBin = path.join(directory, 'clang bin');
          yield* fs.makeDirectory(compilerBin);
          const originalAr = path.join(directory, 'ar');
          const compilerAr = path.join(compilerBin, 'ar');
          yield* fs.writeFileString(world, 'alpine-baselayout\nbusybox\n');
          yield* fs.writeFileString(apk, `#!/bin/sh\ncp ${literal(world)} ${literal(observed)}\nprintf '%s\\0' "$@"\n`);
          yield* fs.writeFileString(compiler, `#!/bin/sh\nprintf '%s\\0' "$@"\n`);
          yield* fs.writeFileString(originalAr, '#!/bin/sh\nexit 0\n');
          yield* fs.writeFileString(compilerAr, '#!/bin/sh\nexit 99\n');
          for (const executable of [apk, compiler, originalAr, compilerAr]) yield* fs.chmod(executable, 0o755);
          const script = EffectString.replaceAll(
            '/etc/apk/world',
            literal(world),
          )(EffectString.replaceAll('/tmp/threadnote-original-world', literal(backup))(muslToolchainFetchScript(true)));
          const env = {...Bun.env, PATH: `${directory}:${Bun.env.PATH ?? ''}`};
          const fetched = Bun.spawnSync({cmd: ['sh', '-ec', script], env, stdout: 'pipe', stderr: 'pipe'});
          expect(fetched.exitCode, fetched.stderr.toString()).toBe(0);
          expect(EffectString.split(fetched.stdout.toString(), '\0').slice(0, -1)).toEqual([
            '--cache-dir',
            '/tmp/threadnote-index',
            'fetch',
            '--world',
            '--recursive',
            '--output',
            '/tmp/threadnote-apks',
          ]);
          expect(yield* fs.readFileString(world)).toBe('alpine-baselayout\nbusybox\n');
          const constraints = EffectString.split('\n')(yield* fs.readFileString(observed));
          expect(constraints).toEqual(
            expect.arrayContaining([
              'alpine-baselayout',
              'busybox',
              'build-base=0.5-r3',
              'cmake=3.24.4-r0',
              'ripgrep=13.0.0-r1',
              'bubblewrap=0.7.0-r0',
            ]),
          );
          const isolatedBootstrap = EffectString.replace(
            'threadnote_inference_compiler_bin=/opt/clang/bin',
            `threadnote_inference_compiler_bin=${literal(compilerBin)}`,
          )(GNU_INFERENCE_COMPILER_BOOTSTRAP);
          const originalPath = `${directory}::${Bun.env.PATH ?? ''}`;
          const installed = Bun.spawnSync({
            cmd: [
              'sh',
              '-ec',
              `${isolatedBootstrap}printf '%s\\0' "$PATH" "$(command -v ar)" "$THREADNOTE_NATIVE_INFERENCE_CC" "$THREADNOTE_NATIVE_INFERENCE_CXX"`,
            ],
            env: {...env, PATH: `${compilerBin}:${originalPath}`},
            stdout: 'pipe',
            stderr: 'pipe',
          });
          expect(installed.exitCode, installed.stderr.toString()).toBe(0);
          expect(EffectString.split(installed.stdout.toString(), '\0').slice(0, -1)).toEqual([
            '-v',
            'v20.1.8.0',
            '-c',
            'a0e42b3a3b8c752e1382d697b98d00bff256a99dc04146de2eb2fb1c0bd908be',
            originalPath,
            originalAr,
            '/opt/clang/bin/clang',
            '/opt/clang/bin/clang++',
          ]);
        }),
    );

    it.effect.skipIf(process.platform === 'win32')(
      'drops all capabilities before forwarding the fixed namespace arguments without shell expansion',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-bwrap-boundary-'});
          const binary = path.join(directory, 'fake bwrap');
          const shim = path.join(directory, 'bwrap');
          yield* fs.writeFileString(binary, `#!/bin/sh\nprintf '%s\\0' "$@"\n`);
          yield* fs.chmod(binary, 0o755);
          expect(MUSL_WORKFLOW_BWRAP_SHIM).toBe('#!/bin/sh\nexec /usr/bin/bwrap --cap-drop ALL "$@"\n');
          const literal = "'" + EffectString.replaceAll("'", "'\"'\"'")(binary) + "'";
          yield* fs.writeFileString(shim, EffectString.replace('/usr/bin/bwrap', literal)(MUSL_WORKFLOW_BWRAP_SHIM));
          const arguments_ = [
            '--unshare-net',
            '--ro-bind',
            '/path with spaces',
            '/path with spaces',
            'bun',
            '-e',
            'literal "$HOME"',
          ];
          const result = Bun.spawnSync({cmd: ['sh', shim, ...arguments_], stdout: 'pipe', stderr: 'pipe'});
          expect(result.exitCode, result.stderr.toString()).toBe(0);
          expect(EffectString.split(result.stdout.toString(), '\0').slice(0, -1)).toEqual([
            '--cap-drop',
            'ALL',
            ...arguments_,
          ]);
        }),
    );

    it.effect('rejects cross-platform inference assembly before invoking build tools', () =>
      Effect.gen(function* () {
        const result = yield* assembleNativeInference({
          root: '/nonexistent',
          distributionRoot: '/nonexistent',
          bunTarget: 'unsupported',
        }).pipe(
          Effect.provideService(
            CommandExecutor,
            CommandExecutor.of({
              execute: () => Effect.die('Unexpected cross-target tool invocation'),
              executeStreaming: () => Effect.die('Unexpected cross-target streaming invocation'),
            }),
          ),
          Effect.exit,
        );
        expect(result._tag).toBe('Failure');
      }),
    );
    it.effect('binds a reusable closure and rejects altered or extra payload files', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-inference-overlay-'});
        const source = path.join(root, 'source');
        const destination = path.join(root, 'destination');
        yield* fs.makeDirectory(path.join(source, 'runtime', 'native'), {recursive: true});
        yield* fs.writeFileString(path.join(source, 'runtime', 'node-llama-cpp.js'), 'export const runtime = true;');
        yield* fs.writeFileString(path.join(source, 'runtime', 'native', 'llama.node'), 'fixture-native-bytes');
        const descriptor = yield* publishNativeInferenceOverlay(source, {
          bunVersion: '1.4.4',
          bunTarget: 'bun-darwin-arm64',
          packageVersion: '3.22.2',
          llamaCommit: NATIVE_INFERENCE_LLAMA_COMMIT,
          sourceInputDigest: EffectString.repeat(64)('a'),
          origin: 'locked-prebuilt',
          toolchain: {bun: '1.4.4'},
        });
        expect(yield* stageNativeInferenceOverlay(source, destination)).toEqual(descriptor);
        yield* fs.writeFileString(path.join(destination, 'runtime', 'native', 'extra.node'), 'unlisted');
        expect((yield* verifyNativeInferenceOverlay(destination).pipe(Effect.exit))._tag).toBe('Failure');
        yield* fs.writeFileString(path.join(source, 'runtime', 'native', 'llama.node'), 'changed');
        expect((yield* stageNativeInferenceOverlay(source, destination).pipe(Effect.exit))._tag).toBe('Failure');
      }),
    );
  });
});
