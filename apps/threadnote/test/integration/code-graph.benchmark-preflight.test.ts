import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  credentialsDisabledGitProofEnvironment,
  publicGitHubRepositoryEvidence,
  revalidateExternalBenchmarkPreflightState,
  validateBenchmarkRuntimeProvenance,
  verifyPublicRepositoryCommit,
} from '../../../../scripts/benchmark-code-graph.js';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CONTROL = JSON.stringify({
  expectedLanguage: 'typescript',
  expectedPath: 'src/index.ts',
  query: 'indexSymbol',
});
const BENCHMARK_CHILD_TIMEOUT_MS = 45_000;
// Five serial benchmark processes have reached 30 seconds under hosted-runner load. Keep a strict total deadline
// above that observed tail while each active child remains independently bounded and interruptible.
const BENCHMARK_PREFLIGHT_TEST_TIMEOUT_MS = 60_000;

describe('external code graph benchmark execution safety', () => {
  effectIt.effect('rejects source and external checkout drift before emitting preflight evidence', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-benchmark-preflight-drift-'});
          const sourceRepository = path.join(root, 'threadnote-source');
          const externalRepository = path.join(root, 'external-source');
          yield* fs.makeDirectory(sourceRepository, {recursive: true});
          yield* fs.writeFileString(path.join(sourceRepository, 'bun.lock'), 'fixture lock\n');
          yield* fs.writeFileString(path.join(sourceRepository, 'package.json'), '{}\n');
          yield* fs.writeFileString(path.join(sourceRepository, 'source.ts'), 'export const source = 1;\n');
          const sourceCommit = yield* initializeGitRepository(sourceRepository);
          yield* fs.makeDirectory(externalRepository, {recursive: true});
          yield* fs.writeFileString(path.join(externalRepository, 'external.ts'), 'export const external = 1;\n');
          const externalCommit = yield* initializeGitRepository(externalRepository);
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              CI: 'true',
              GITHUB_ACTIONS: 'true',
              GITHUB_REPOSITORY: 'Kashkovsky/threadnote',
              GITHUB_RUN_ID: '123',
              GITHUB_SHA: sourceCommit,
              GITHUB_WORKSPACE: sourceRepository,
              RUNNER_ARCH: process.arch === 'arm64' ? 'ARM64' : 'X64',
              RUNNER_ENVIRONMENT: 'github-hosted',
              RUNNER_OS: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
            }),
          });
          const initial = yield* validateBenchmarkRuntimeProvenance(sourceRepository).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );

          yield* fs.writeFileString(path.join(sourceRepository, 'source.ts'), 'export const source = 2;\n');
          const sourceFailure = yield* revalidateExternalBenchmarkPreflightState(
            sourceRepository,
            externalRepository,
            externalCommit,
            initial,
          ).pipe(Effect.provideService(SystemInfo, testSystem), Effect.flip);
          yield* fs.writeFileString(path.join(sourceRepository, 'source.ts'), 'export const source = 1;\n');

          yield* fs.writeFileString(path.join(externalRepository, 'external.ts'), 'export const external = 2;\n');
          const externalFailure = yield* revalidateExternalBenchmarkPreflightState(
            sourceRepository,
            externalRepository,
            externalCommit,
            initial,
          ).pipe(Effect.provideService(SystemInfo, testSystem), Effect.flip);
          return {externalFailure: String(externalFailure), initial, sourceFailure: String(sourceFailure)};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.initial.mode).toBe('github-actions-clean-source');
      expect(result.sourceFailure).toContain('clean Threadnote checkout');
      expect(result.externalFailure).toContain('External repository changed during the benchmark');
    }),
  );

  effectIt.effect('binds anonymous proof to the exact published commit and strips Git credential configuration', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-public-commit-proof-test-'});
          const repository = path.join(root, 'renamed-public-checkout');
          const proofRemote = path.join(root, 'published.git');
          yield* fs.makeDirectory(repository, {recursive: true});
          yield* fs.writeFileString(path.join(repository, 'source.ts'), 'export const published = true;\n');
          const publishedCommit = yield* initializeGitRepository(repository);
          yield* runCommandEffect('git', ['clone', '--quiet', '--bare', repository, proofRemote], {
            timeoutMs: 10_000,
          });

          const proofEnvironment = {
            ...process.env,
            GH_TOKEN: 'must-not-survive',
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'url.file:///private/rewrite/.insteadOf',
            GIT_CONFIG_KEY_1: 'http.https://github.com/.extraHeader',
            GIT_CONFIG_VALUE_0: 'https://github.com/',
            GIT_CONFIG_VALUE_1: 'Authorization: Bearer must-not-survive',
            GITHUB_TOKEN: 'must-not-survive',
            NODE_ENV: 'test',
            THREADNOTE_BENCHMARK_TEST_PUBLIC_REPOSITORY_REMOTE: proofRemote,
          };
          const sanitized = credentialsDisabledGitProofEnvironment(
            proofEnvironment,
            path.join(root, 'isolated-home'),
            path.join(root, 'empty.gitconfig'),
          );
          const publicRepository = publicGitHubRepositoryEvidence(
            'https://github.com/JetBrains/intellij-community.git',
          );
          const verification = yield* verifyPublicRepositoryCommit(publicRepository, publishedCommit, proofEnvironment);

          yield* fs.writeFileString(path.join(repository, 'source.ts'), 'export const unpublished = true;\n');
          yield* runCommandEffect('git', ['-C', repository, 'add', 'source.ts']);
          yield* runCommandEffect(
            'git',
            [
              '-C',
              repository,
              '-c',
              'user.name=Threadnote Benchmark',
              '-c',
              'user.email=benchmark@threadnote.invalid',
              'commit',
              '--quiet',
              '-m',
              'unpublished',
            ],
            {timeoutMs: 10_000},
          );
          const unpublishedCommit = Effect2.pipe(
            (yield* runCommandEffect('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout,
            EffectString.trim,
          );
          const unpublishedFailure = yield* verifyPublicRepositoryCommit(
            publicRepository,
            unpublishedCommit,
            proofEnvironment,
          ).pipe(Effect.flip);

          return {sanitized, unpublishedFailure: String(unpublishedFailure), verification};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.verification).toBe('anonymous-https-exact-commit-fetch');
      expect(result.unpublishedFailure).toContain('could not be fetched from the public repository');
      expect(result.sanitized).not.toHaveProperty('GH_TOKEN');
      expect(result.sanitized).not.toHaveProperty('GITHUB_TOKEN');
      expect(result.sanitized).not.toHaveProperty('GIT_CONFIG_COUNT');
      expect(result.sanitized).not.toHaveProperty('GIT_CONFIG_KEY_0');
      expect(result.sanitized).not.toHaveProperty('GIT_CONFIG_VALUE_0');
      expect(JSON.stringify(result.sanitized)).not.toContain('must-not-survive');
    }),
  );

  effectIt.effect.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'preflights every run, sees config-hidden dirt, and releases prospective homes',
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-benchmark-preflight-test-'});
            const repository = path.join(root, 'repository');
            const output = path.join(root, 'evidence.json');
            const home = path.join(root, 'primary-home');
            const referenceHome = path.join(root, 'reference-home');
            const script = path.resolve('scripts/benchmark-code-graph.ts');
            yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
            yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const indexSymbol = 1;\n');
            yield* runCommandEffect('git', ['init', '--quiet', repository]);
            yield* runCommandEffect('git', [
              '-C',
              repository,
              'remote',
              'add',
              'origin',
              'https://github.com/Example/benchmark-fixture.git',
            ]);
            yield* runCommandEffect('git', ['-C', repository, 'add', 'src/index.ts']);
            yield* runCommandEffect(
              'git',
              [
                '-C',
                repository,
                '-c',
                'user.name=Threadnote Benchmark',
                '-c',
                'user.email=benchmark@threadnote.invalid',
                'commit',
                '--quiet',
                '-m',
                'fixture',
              ],
              {timeoutMs: 10_000},
            );
            const publicProofRemote = path.join(root, 'public-proof.git');
            yield* runCommandEffect('git', ['clone', '--quiet', '--bare', repository, publicProofRemote], {
              timeoutMs: 10_000,
            });

            const sourceDirty =
              Effect2.pipe(
                (yield* runCommandEffect('git', [
                  '-C',
                  path.resolve('.'),
                  '-c',
                  'core.fsmonitor=false',
                  '-c',
                  'core.untrackedCache=false',
                  '-c',
                  'status.showUntrackedFiles=all',
                  'status',
                  '--porcelain=v1',
                  '--untracked-files=all',
                ])).stdout,
                EffectString.trim,
              ).length > 0;
            const common = [
              '--repository',
              repository,
              '--incremental-path',
              'src/index.ts',
              '--control',
              CONTROL,
              '--output',
              output,
              '--home',
              home,
              '--reference-home',
              referenceHome,
              '--retain-homes',
            ] as const;
            const first = yield* runBenchmark(
              script,
              [...common, '--minimum-free-gib', '1', '--preflight'],
              publicProofRemote,
            );
            const firstHomesReleased = !(yield* fs.exists(home)) && !(yield* fs.exists(referenceHome));
            const second = yield* runBenchmark(
              script,
              [...common, '--minimum-free-gib', '1', '--preflight'],
              publicProofRemote,
            );
            const secondHomesReleased = !(yield* fs.exists(home)) && !(yield* fs.exists(referenceHome));

            yield* runCommandEffect('git', ['-C', repository, 'config', 'status.showUntrackedFiles', 'no']);
            yield* fs.writeFileString(path.join(repository, 'hidden-untracked.txt'), 'must still be detected\n');
            const dirty = yield* runBenchmark(
              script,
              [...common, '--minimum-free-gib', '1', '--preflight'],
              publicProofRemote,
            );
            yield* fs.remove(path.join(repository, 'hidden-untracked.txt'));

            const lowDisk = yield* runBenchmark(
              script,
              [...common, '--minimum-free-gib', '8000000'],
              publicProofRemote,
            );
            const lowDiskHomesReleased = !(yield* fs.exists(home)) && !(yield* fs.exists(referenceHome));
            const actual = yield* runBenchmark(
              script,
              [...common, '--minimum-free-gib', '1', '--samples', '1', '--warmups', '0'],
              publicProofRemote,
            );
            const artifactExists = yield* fs.exists(output);

            return {
              actual,
              artifact: artifactExists ? JSON.parse(yield* fs.readFileString(output)) : undefined,
              artifactExists,
              dirty,
              first,
              firstHomesReleased,
              lowDisk,
              lowDiskHomesReleased,
              preflightArtifactExists: yield* fs.exists(`${output}.preflight.json`),
              second,
              secondHomesReleased,
              sourceDirty,
            };
          }),
        ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);

        expect(result.firstHomesReleased).toBe(true);
        expect(result.secondHomesReleased).toBe(true);
        expect(result.lowDiskHomesReleased).toBe(true);
        if (result.sourceDirty) {
          for (const attempt of [result.first, result.second, result.dirty, result.lowDisk, result.actual]) {
            expect(attempt.exitCode).not.toBe(0);
            expect(`${attempt.stderr}\n${attempt.stdout}`).toContain('clean Threadnote checkout');
          }
          expect(result.preflightArtifactExists).toBe(false);
          expect(result.actual.exitCode).not.toBe(0);
          expect(`${result.actual.stderr}\n${result.actual.stdout}`).not.toContain(
            'one-file reindex incremental-overlay materialization mode',
          );
          expect(result.artifactExists).toBe(false);
        } else {
          expect(result.first.exitCode).toBe(0);
          expect(result.second.exitCode).toBe(0);
          expect(result.preflightArtifactExists).toBe(true);
          expect(result.dirty.exitCode).not.toBe(0);
          expect(`${result.dirty.stderr}\n${result.dirty.stdout}`).toContain('requires a clean checkout');
          expect(result.lowDisk.exitCode).not.toBe(0);
          expect(`${result.lowDisk.stderr}\n${result.lowDisk.stdout}`).toContain(
            'External benchmark preflight requires at least 8000000 GiB',
          );
          expect(
            result.actual.exitCode,
            `benchmark stderr:\n${result.actual.stderr}\nbenchmark stdout:\n${result.actual.stdout}`,
          ).toBe(0);
          expect(result.artifactExists).toBe(true);
          expect(result.artifact?.metadata).toMatchObject({
            externalRepositoryName: 'Example/benchmark-fixture',
            externalRepositoryPublicVerification: 'anonymous-https-exact-commit-fetch',
            externalRepositoryUrl: 'https://github.com/Example/benchmark-fixture',
            managerRequestCancellationPassed: true,
            managerRequestLifecycleControl:
              'real Manager queries through the GraphWorkspace request gate: superseding aborts an in-flight request; a completed late response is rejected',
            managerSnapshotBindingPassed: true,
            managerStaleResponseRejectionPassed: true,
            oneFileReindexMaterializationMode: 'incremental-overlay',
            sameOverlayReferenceMaterializationMode: 'full',
            simultaneousWorktrees: 2,
            worktreeIsolationIndexedFiles: 2,
            worktreeIsolationPassed: true,
            worktreeIsolationTopology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
          });
          for (const name of [
            'external-query-cold-typescript-duration',
            'manager-catalog-cold',
            'manager-catalog-warm',
            'manager-overview-cold',
            'manager-overview-warm',
            'manager-detail-cold',
            'manager-layout-preparation-proxy',
            'manager-response-payload',
            'manager-bounded-query',
            'manager-bounded-query-payload',
            'concurrent-worktree-isolation-duration',
          ]) {
            expect(result.artifact?.measurements.some((measurement: {name: string}) => measurement.name === name)).toBe(
              true,
            );
          }
          expect(result.artifact?.metadata.structuralGraphDigestIncremental).toBe(
            result.artifact?.metadata.structuralGraphDigestSameOverlayReference,
          );
        }
      }),
    BENCHMARK_PREFLIGHT_TEST_TIMEOUT_MS,
  );
});

const initializeGitRepository = Effect.fn('benchmarkPreflightTest.initializeGitRepository')(function* (
  repository: string,
) {
  yield* runCommandEffect('git', ['init', '--quiet', repository]);
  yield* runCommandEffect('git', ['-C', repository, 'add', '.']);
  yield* runCommandEffect(
    'git',
    [
      '-C',
      repository,
      '-c',
      'user.name=Threadnote Benchmark',
      '-c',
      'user.email=benchmark@threadnote.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    {timeoutMs: 10_000},
  );
  return Effect2.pipe(
    (yield* runCommandEffect('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout,
    EffectString.trim,
  );
});

const runBenchmark = Effect.fn('benchmarkPreflightTest.runBenchmark')(function* (
  script: string,
  args: readonly string[],
  publicProofRemote: string,
) {
  const sourceCommit = Effect2.pipe(
    (yield* runCommandEffect('git', ['rev-parse', 'HEAD'], {timeoutMs: 10_000})).stdout,
    EffectString.trim,
  );
  return yield* runCommandEffect(process.execPath, [script, ...args], {
    allowFailure: true,
    env: {
      ...process.env,
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'Kashkovsky/threadnote',
      GITHUB_RUN_ID: '1',
      GITHUB_SHA: sourceCommit,
      GITHUB_WORKSPACE: process.cwd(),
      NODE_ENV: 'test',
      RUNNER_ARCH: process.arch === 'arm64' ? 'ARM64' : 'X64',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
      THREADNOTE_BENCHMARK_TEST_PUBLIC_REPOSITORY_REMOTE: publicProofRemote,
    },
    timeoutMs: BENCHMARK_CHILD_TIMEOUT_MS,
  });
});
