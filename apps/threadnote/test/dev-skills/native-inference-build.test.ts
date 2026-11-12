import {CommandExecutor, CommandFailed, CommandTimedOut, type CommandOptions} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {
  assembleNativeInference,
  copyNativeInferenceCompilerRuntimes,
  muslWorkflowRuntimeArguments,
  MUSL_WORKFLOW_BWRAP_SHIM,
  nativeContainerFailureReport,
  nativeInferenceBuildEnvironment,
  GNU_INFERENCE_COMPILER_BOOTSTRAP,
  muslToolchainFetchScript,
  MUSL_BUILD_DEPENDENCY_INSTALL,
  buildNativeInferenceDriver,
  nativeInferenceBuildDriverSource,
  nativeContainerCheckoutRoot,
  probeMuslArmVariants,
  muslArmVariantSource,
  MUSL_ARM_BASE_VARIANTS,
} from '../../../../scripts/assemble-native-inference.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  String as EffectString,
} from 'effect';
import {TestClock} from 'effect/testing';
import {ScriptCommandExecutorLayer} from '../../../../scripts/effect/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {
  NATIVE_INFERENCE_LLAMA_COMMIT,
  publishNativeInferenceOverlay,
  stageNativeInferenceOverlay,
  verifyNativeInferenceOverlay,
} from '../../../../scripts/native-inference-payload.js';

describe('native inference overlay filesystem boundary', () => {
  it('adapts only the two pinned SME registrations and binds the exact original, adapted source and patch', () => {
    const baseline = EffectArray.map(
      MUSL_ARM_BASE_VARIANTS,
      name => `            ggml_add_cpu_backend_variant(${name})`,
    );
    const first =
      '            ggml_add_cpu_backend_variant(armv9.2_1    DOTPROD FP16_VECTOR_ARITHMETIC SVE MATMUL_INT8 SME)';
    const second =
      '            ggml_add_cpu_backend_variant(armv9.2_2    DOTPROD FP16_VECTOR_ARITHMETIC SVE MATMUL_INT8 SVE2 SME)';
    const original = EffectArray.join(
      ['unrelated upstream context', ...baseline, first, second, 'unchanged suffix'],
      '\n',
    );
    const all = muslArmVariantSource(original, [...MUSL_ARM_BASE_VARIANTS, 'armv9.2_1', 'armv9.2_2']);
    expect(all.adapted).toBe(original);
    const adapted = muslArmVariantSource(original, [...MUSL_ARM_BASE_VARIANTS, 'armv9.2_2']);
    expect(adapted.adapted).not.toContain(first);
    expect(adapted.adapted).toContain(second);
    for (const call of baseline) expect(adapted.adapted).toContain(call);
    expect(adapted.adapted).toContain('unchanged suffix');
    expect(JSON.parse(adapted.patch)).toEqual({path: 'ggml/src/CMakeLists.txt', original, adapted: adapted.adapted});
    expect(adapted.identity).toEqual({
      originalSha256: sha256HexSync(original),
      adaptedSha256: sha256HexSync(adapted.adapted),
      patchSha256: sha256HexSync(adapted.patch),
    });
    expect(adapted.identity.adaptedSha256).not.toBe(all.identity.adaptedSha256);
    expect(() => muslArmVariantSource(EffectString.replace(first, 'changed source context')(original), [])).toThrow(
      'context changed',
    );
  });
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

  it('grants namespace setup capabilities to the outer musl harness and forwards only its archive/profile', () => {
    const arguments_ = muslWorkflowRuntimeArguments({
      THREADNOTE_RELEASE_ARCHIVE: 'artifacts/threadnote-linux-arm64-musl.tar.gz',
      THREADNOTE_RELEASE_PROFILE: 'all',
      GH_TOKEN: 'must-not-forward',
    });
    expect(arguments_).toEqual([
      '--cap-add',
      'SYS_ADMIN',
      '--cap-add',
      'NET_ADMIN',
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

  effectIt.layer(Layer.merge(BunServices.layer, TestSystemInfoLayer))(it => {
    it.effect('binds compiler-resolved runtime copies and enrolls only the captured ARM musl libgcc provider', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'compiler-runtime-copy-'});
        const compilerRoot = path.join(root, 'compiler');
        const destination = path.join(root, 'Release');
        yield* fs.makeDirectory(compilerRoot);
        yield* fs.makeDirectory(destination);
        yield* fs.writeFileString(path.join(compilerRoot, 'libstdc++.so.6'), 'compiler C++ runtime bytes');
        yield* fs.writeFileString(path.join(compilerRoot, 'libgcc_s.so.1'), 'compiler libgcc bytes');
        const environment = {PATH: '/selected/compiler/bin', CAPTURE_FIXTURE: 'preserved'};
        const command = CommandExecutor.of({
          execute: (compiler, args, bounds) => {
            expect(compiler).toBe('/selected/compiler/c++');
            expect(bounds).toEqual({env: environment, timeoutMs: 10_000, maxOutputBytes: 16_384});
            const library = args[0] === '-print-file-name=libstdc++.so.6' ? 'libstdc++.so.6' : 'libgcc_s.so.1';
            expect(args).toEqual([`-print-file-name=${library}`]);
            return Effect.succeed({exitCode: 0, stdout: path.join(compilerRoot, library) + '\n', stderr: ''});
          },
          executeStreaming: () => Effect.die('Unexpected streaming compiler lookup'),
        });
        const capture = (bunTarget: string) =>
          copyNativeInferenceCompilerRuntimes({
            compiler: '/selected/compiler/c++',
            environment,
            destination,
            bunTarget,
          }).pipe(Effect.provideService(CommandExecutor, command));
        const copies = yield* capture('bun-linux-arm64-musl');
        const sourcePath = yield* fs.realPath(path.join(compilerRoot, 'libgcc_s.so.1'));
        const sha256 = sha256HexSync('compiler libgcc bytes');
        expect(copies[0]?.compilerLibgccProvider).toBeUndefined();
        expect(copies[1]).toMatchObject({
          library: 'libgcc_s.so.1',
          sourcePath,
          sha256,
          compilerLibgccProvider: {sourcePath, sha256},
        });
        expect(yield* fs.readFileString(path.join(destination, 'libgcc_s.so.1'))).toBe('compiler libgcc bytes');
        expect(yield* fs.readFileString(path.join(destination, 'libstdc++.so.6'))).toBe('compiler C++ runtime bytes');
        expect(
          EffectArray.every(yield* capture('bun-linux-arm64'), copy => copy.compilerLibgccProvider === undefined),
        ).toBe(true);
        const unresolved = yield* copyNativeInferenceCompilerRuntimes({
          compiler: '/selected/compiler/c++',
          environment,
          destination,
          bunTarget: 'bun-linux-arm64-musl',
        }).pipe(
          Effect.provideService(
            CommandExecutor,
            CommandExecutor.of({
              execute: () => Effect.succeed({exitCode: 0, stdout: 'libgcc_s.so.1\n', stderr: ''}),
              executeStreaming: () => Effect.die('Unexpected streaming compiler lookup'),
            }),
          ),
          Effect.exit,
        );
        expect(Exit.isFailure(unresolved) && Cause.pretty(unresolved.cause)).toContain(
          'pinned compiler did not resolve',
        );
      }),
    );
    it.effect(
      'probes each optional SME variant with selected target C/C++ compilers and discloses only rejected variants',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const scratch = yield* fs.makeTempDirectoryScoped({prefix: 'musl-arm-probe-'});
          for (const rejected of [[], ['armv9.2_1'], ['armv9.2_1', 'armv9.2_2']]) {
            const calls: string[] = [];
            const env = {CC: '/selected/target-cc', CXX: '/selected/target-c++', PATH: '/preserved'};
            const policy = yield* probeMuslArmVariants({scratch, env}).pipe(
              Effect.provideService(
                CommandExecutor,
                CommandExecutor.of({
                  execute: (compiler, args, options = {}) =>
                    Effect.gen(function* () {
                      calls.push(compiler);
                      expect(options).toMatchObject({cwd: scratch, env, timeoutMs: 10_000, maxOutputBytes: 16_384});
                      expect(args[1]).toBe('-c');
                      expect(args[3]).toBe('-o');
                      const input = args[2];
                      if (input === undefined) return yield* Effect.die('Missing compile-only input');
                      const body = yield* fs.readFileString(input).pipe(Effect.orDie);
                      expect(body).toContain('int threadnote_compiler_probe(void)');
                      if (EffectString.includes('armv9.2')(input)) {
                        expect(body).toContain('#ifndef __ARM_FEATURE_SME');
                        expect(args[0]).toMatch(/^-march=armv9\.2-a\+dotprod\+fp16\+sve\+i8mm(?:\+sve2)?\+sme$/u);
                      } else expect(args[0]).toBe('-march=armv8-a');
                      if (
                        compiler === env.CXX &&
                        EffectArray.some(rejected, variant => EffectString.includes(variant)(input))
                      )
                        return yield* CommandFailed.make({
                          executable: compiler,
                          args: [...args],
                          exitCode: 1,
                          message: 'target compiler rejected feature',
                          stdout: '',
                          stderr: 'unsupported target feature',
                        });
                      return {exitCode: 0, stdout: '', stderr: ''};
                    }),
                  executeStreaming: () => Effect.die('Unexpected streaming capability probe'),
                }),
              ),
            );
            expect(calls).toEqual([env.CC, env.CXX, env.CC, env.CXX, env.CC, env.CXX]);
            expect(policy).toMatchObject({
              requested: 'GGML_CPU_ALL_VARIANTS=ON',
              effective: 'compiler-supported-linux-arm-variants',
            });
            expect(policy.included).toEqual([
              ...MUSL_ARM_BASE_VARIANTS,
              ...EffectArray.filter(['armv9.2_1', 'armv9.2_2'], variant => !rejected.includes(variant)),
            ]);
            expect(EffectArray.map(policy.omitted, entry => entry.variant)).toEqual(rejected);
            expect(
              policy.probes[0] && EffectArray.every(policy.probes[0].languages, language => language.supported),
            ).toBe(true);
            for (const probe of policy.probes)
              for (const language of probe.languages) expect(language.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
          }
        }),
    );

    it.effect('fails a baseline compiler error instead of retrying with fewer variants', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const scratch = yield* fs.makeTempDirectoryScoped({prefix: 'musl-arm-baseline-'});
        let calls = 0;
        const error = CommandFailed.make({
          executable: 'cc',
          args: [],
          exitCode: 1,
          message: 'broken baseline compiler',
          stdout: '',
          stderr: 'broken sysroot',
        });
        const result = yield* probeMuslArmVariants({scratch, env: {}}).pipe(
          Effect.provideService(
            CommandExecutor,
            CommandExecutor.of({
              execute: () => {
                calls++;
                return Effect.fail(error);
              },
              executeStreaming: () => Effect.die('Unexpected streaming capability probe'),
            }),
          ),
          Effect.result,
        );
        expect(result).toMatchObject({_tag: 'Failure', failure: error});
        expect(calls).toBe(1);
      }),
    );

    it.effect.skipIf(process.platform === 'win32')(
      'registers only the physical checkout for Git ownership checks and retains dirty/source identity evidence',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({prefix: 'native container git '});
          const repo = path.join(directory, 'physical repo');
          const alias = path.join(directory, 'checkout alias');
          yield* fs.makeDirectory(repo);
          yield* fs.symlink(repo, alias);
          const root = yield* nativeContainerCheckoutRoot(`${alias}/`);
          expect(root).toBe(path.resolve(yield* fs.realPath(repo)));
          const env = {
            ...Bun.env,
            GIT_CONFIG_GLOBAL: path.join(directory, 'gitconfig'),
            GIT_CONFIG_SYSTEM: '/dev/null',
          };
          const git = (args: readonly string[], foreign = false) =>
            Bun.spawnSync({
              cmd: ['git', ...args],
              env: {...env, GIT_TEST_ASSUME_DIFFERENT_OWNER: foreign ? '1' : '0'},
              stdout: 'pipe',
              stderr: 'pipe',
            });
          expect(git(['init', '--quiet', repo]).exitCode).toBe(0);
          yield* fs.writeFileString(path.join(repo, 'input.txt'), 'committed');
          expect(git(['-C', repo, 'add', '.']).exitCode).toBe(0);
          expect(
            git([
              '-C',
              repo,
              '-c',
              'user.name=Fixture',
              '-c',
              'user.email=fixture@example.invalid',
              'commit',
              '--quiet',
              '-m',
              'fixture',
            ]).exitCode,
          ).toBe(0);
          const rejected = git(['-C', root, 'status', '--porcelain'], true);
          expect(rejected.exitCode).not.toBe(0);
          expect(rejected.stderr.toString()).toContain('dubious ownership');
          expect(git(['config', '--global', '--add', 'safe.directory', root]).exitCode).toBe(0);
          expect(EffectString.trim(git(['config', '--global', '--get-all', 'safe.directory']).stdout.toString())).toBe(
            root,
          );
          const clean = git(['-C', root, 'status', '--porcelain'], true);
          expect(clean.exitCode, clean.stderr.toString()).toBe(0);
          expect(clean.stdout.toString()).toBe('');
          const identity = git(['-C', root, 'rev-parse', 'HEAD', 'HEAD^{tree}'], true).stdout.toString();
          yield* fs.writeFileString(path.join(repo, 'input.txt'), 'dirty');
          const dirty = git(['-C', root, 'status', '--porcelain'], true);
          expect(dirty.exitCode, dirty.stderr.toString()).toBe(0);
          expect(dirty.stdout.toString()).toContain('M input.txt');
          expect(git(['-C', root, 'rev-parse', 'HEAD', 'HEAD^{tree}'], true).stdout.toString()).toBe(identity);
        }),
    );

    it.effect('bounds live compiler progress while retaining final diagnostics and actual failure exit', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scratch = yield* fs.makeTempDirectoryScoped({prefix: 'native-build-output-'});
        const driver = path.join(scratch, 'build.mjs');
        const context = yield* Layer.build(ScriptCommandExecutorLayer);
        const command = Context.get(context, CommandExecutor);
        const body = `
for (let index = 0; index < 80; index++) {
  process.stdout.write('o'.repeat(65536));
  process.stderr.write('e'.repeat(65536));
}
await new Promise(resolve => process.stderr.write('final compiler diagnostic\\n', resolve));
process.stdout.write('final build progress\\n');
`;
        yield* fs.writeFileString(driver, body);
        const overflow = yield* buildNativeInferenceDriver({driver, scratch, env: {...Bun.env}}).pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.exit,
        );
        expect(Exit.isFailure(overflow) && Cause.pretty(overflow.cause)).toContain('CommandOutputLimitExceeded');
        for (const code of [0, 7]) {
          yield* fs.writeFileString(driver, nativeInferenceBuildDriverSource(body + `\nprocess.exitCode = ${code};`));
          const result = yield* buildNativeInferenceDriver({driver, scratch, env: {...Bun.env}}).pipe(
            Effect.provideService(CommandExecutor, command),
            Effect.catchTag('CommandFailed', error => Effect.succeed(error)),
          );
          expect(result.exitCode).toBe(code);
          if (code !== 0) expect(result).toMatchObject({_tag: 'CommandFailed'});
          expect(result.stdout).toContain('retained final 524288 of');
          expect(result.stderr).toContain('retained final 524288 of');
          expect(result.stdout).toContain('final build progress');
          expect(result.stderr).toContain('final compiler diagnostic');
          expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThan(1_049_000);
        }
      }).pipe(TestClock.withLive),
    );

    it.effect('confirms Windows inference leader exit and keeps POSIX groups and original driver bounds', () =>
      Effect.gen(function* () {
        const base = yield* SystemInfo;
        for (const platform of ['win32', 'linux', 'darwin'] as const) {
          const observed: CommandOptions[] = [];
          const env = {NATIVE_BUILD_FIXTURE: 'preserved'};
          const result = yield* buildNativeInferenceDriver({driver: 'build.mjs', scratch: 'scratch', env}).pipe(
            Effect.provideService(SystemInfo, SystemInfo.of({...base, platform})),
            Effect.provideService(
              CommandExecutor,
              CommandExecutor.of({
                execute: (executable, args, options = {}) => {
                  expect(executable).toBe(process.execPath);
                  expect(args).toEqual(['build.mjs']);
                  observed.push(options);
                  return Effect.succeed({exitCode: 0, stdout: 'compiled', stderr: ''});
                },
                executeStreaming: () => Effect.die('Unexpected streaming build'),
              }),
            ),
          );
          expect(result).toEqual({exitCode: 0, stdout: 'compiled', stderr: ''});
          expect(observed).toEqual([
            {
              cwd: 'scratch',
              timeoutMs: 30 * 60_000,
              maxOutputBytes: 4 * 1024 * 1024,
              detached: true,
              verifyOwnedProcessExit: platform === 'win32' ? 'leader' : 'group',
              env,
            },
          ]);
        }
      }),
    );

    it.effect.skipIf(process.platform === 'win32')(
      'scopes the musl devtool prepare exemption and refuses changed product install contracts',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({prefix: 'musl dependency prepare '});
          const workspace = path.join(directory, 'packages', 'fixture');
          yield* fs.makeDirectory(workspace, {recursive: true});
          const manifest = {
            scripts: {prepare: 'bun --bun husky && bun --bun effect-tsgo patch --no-typescript --oxlint'},
            trustedDependencies: [],
            workspaces: ['packages/*'],
          };
          const rootManifest = path.join(directory, 'package.json');
          const workspaceManifest = path.join(workspace, 'package.json');
          const calls = path.join(directory, 'calls');
          const literal = (value: string) => "'" + EffectString.replaceAll("'", "'\"'\"'")(value) + "'";
          const bun = path.join(directory, 'bun');
          yield* fs.writeFileString(
            bun,
            `#!/bin/sh
if [ "$1" = -e ]; then exec ${literal(process.execPath)} "$@"; fi
printf '%s\\n' "$*" >> ${literal(calls)}
if [ "$1" = --bun ] && [ "$2" = husky ]; then [ "$HUSKY" = 0 ] || exit 41; fi
`,
          );
          yield* fs.chmod(bun, 0o755);
          const run = () =>
            Bun.spawnSync({
              cmd: ['sh', '-ec', MUSL_BUILD_DEPENDENCY_INSTALL],
              cwd: directory,
              env: {...Bun.env, PATH: `${directory}:${Bun.env.PATH ?? ''}`},
              stdout: 'pipe',
              stderr: 'pipe',
            });
          yield* fs.writeFileString(rootManifest, JSON.stringify(manifest));
          yield* fs.writeFileString(workspaceManifest, '{}');
          const installed = run();
          expect(installed.exitCode, installed.stderr.toString()).toBe(0);
          expect(EffectString.trim(yield* fs.readFileString(calls))).toBe(
            EffectArray.join(
              [
                'install --frozen-lockfile --ignore-scripts',
                '--bun husky',
                '--bun effect-tsgo patch --no-typescript --oxlint --skip-missing',
              ],
              '\n',
            ),
          );
          yield* fs.remove(calls);
          for (const changed of [
            {...manifest, trustedDependencies: ['requires-postinstall']},
            {...manifest, scripts: {...manifest.scripts, postinstall: 'required-product-setup'}},
          ]) {
            yield* fs.writeFileString(rootManifest, JSON.stringify(changed));
            expect(run().exitCode).not.toBe(0);
            expect(yield* fs.exists(calls)).toBe(false);
          }
          yield* fs.writeFileString(rootManifest, JSON.stringify(manifest));
          yield* fs.writeFileString(
            workspaceManifest,
            JSON.stringify({scripts: {postinstall: 'required-workspace-setup'}}),
          );
          expect(run().exitCode).not.toBe(0);
          expect(yield* fs.exists(calls)).toBe(false);
        }),
    );

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
