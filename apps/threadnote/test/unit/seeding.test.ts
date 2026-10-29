import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {inheritedProcessEnvironment} from '@threadnote/testing/process-environment';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, PlatformError, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect} from 'vitest';
import {runInitManifest, runSeed, runSeedSkills, seedDependencyGraphs} from '@threadnote/threadnote/seeding';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import {captureConsole as captureEffectConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer, type ApplicationServices} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig, SeedManifest} from '@threadnote/workspace/config';
import {runCommand} from '@threadnote/threadnote/utils';

const seedStateFileSchema = Schema.StructWithRest(
  Schema.Struct({files: Schema.Record(Schema.String, Schema.Unknown)}),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const seedStateProjectFileSchema = Schema.StructWithRest(Schema.Struct({project: Schema.optional(Schema.String)}), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
const seedStateProjectSchema = Schema.StructWithRest(
  Schema.Struct({files: Schema.Record(Schema.String, seedStateProjectFileSchema)}),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const GIT_ENV_KEYS = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;

const run = <A, E>(effect: Effect.Effect<A, E, ApplicationServices>) => effect.pipe(provideTestLayer(ApplicationLayer));

const captureConsole = <E>(effect: Effect.Effect<void, E, ApplicationServices>) =>
  effect.pipe(
    captureEffectConsole,
    run,
    Effect.map(result => result.output),
  );

describe('runSeed', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect('previews native resource imports without external runtime arguments', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      yield* Effect.promise(() => writeFile(join(repo, 'README.md'), '# Sample\n', 'utf8'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed:',
              '      - README.md',
              '',
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeed(config, {dryRun: true}));

      expect(output).toContain('Would seed resource:');
      expect(output).toContain('threadnote://resources/repos/sample-repo/README.md');
      expect(output).not.toContain('--wait');
      expect(output).not.toContain('--reason');
      expect(output).not.toContain('Project guidance for');
    }),
  );

  effectIt.effect('rejects a manually configured seed pattern that escapes the project root', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const parent = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-parent-')));
      const repo = join(parent, 'repo');
      homes.push(contextHome, parent);
      yield* Effect.promise(() => mkdir(repo, {recursive: true}));
      yield* Effect.promise(() => writeFile(join(parent, 'secret.md'), '# must stay outside\n', 'utf8'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed: [../secret.md]',
              '',
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const error = yield* run(runSeed(config, {dryRun: true})).pipe(Effect.flip);
      expect(error).toMatchObject({
        message: '1 project(s) failed after the remaining projects were processed: sample-repo',
      });
    }),
  );

  effectIt.effect('does not follow exact seed paths through symbolic links', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      const outside = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-outside-')));
      homes.push(contextHome, repo, outside);
      yield* Effect.promise(() => mkdir(join(repo, 'docs'), {recursive: true}));
      yield* Effect.promise(() => writeFile(join(repo, 'README.md'), '# Safe root file\n', 'utf8'));
      yield* Effect.promise(() => writeFile(join(repo, 'docs', 'inside.md'), '# Safe internal file\n', 'utf8'));
      yield* Effect.promise(() => writeFile(join(outside, 'secret.md'), '# must stay outside\n', 'utf8'));
      yield* Effect.promise(() => symlink(outside, join(repo, 'linked'), 'dir'));
      yield* Effect.promise(() => symlink(join(repo, 'docs', 'inside.md'), join(repo, 'inside-link.md')));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed: [README.md, linked/secret.md, inside-link.md]',
              '',
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeed(config, {dryRun: true}));

      expect(output).toContain('sample-repo/README.md');
      expect(output).not.toContain('sample-repo/linked/secret.md');
      expect(output).not.toContain('sample-repo/inside-link.md');
      expect(output).toContain('Seed complete: 1 candidate(s)');
    }),
  );

  effectIt.effect('does not follow glob seed paths through symbolic links', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      const outside = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-outside-')));
      homes.push(contextHome, repo, outside);
      yield* Effect.promise(() => mkdir(join(repo, 'docs'), {recursive: true}));
      yield* Effect.promise(() => writeFile(join(repo, 'docs', 'guide.md'), '# Safe internal file\n', 'utf8'));
      yield* Effect.promise(() => writeFile(join(outside, 'secret.md'), '# must stay outside\n', 'utf8'));
      yield* Effect.promise(() => symlink(outside, join(repo, 'linked'), 'dir'));
      yield* Effect.promise(() => symlink(join(repo, 'docs'), join(repo, 'inside-linked'), 'dir'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed: ["docs/**/*.md", "linked/**/*.md", "inside-linked/**/*.md"]',
              '',
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeed(config, {dryRun: true}));

      expect(output).toContain('sample-repo/docs/guide.md');
      expect(output).not.toContain('sample-repo/linked/secret.md');
      expect(output).not.toContain('sample-repo/inside-linked/guide.md');
      expect(output).toContain('Seed complete: 1 candidate(s)');
    }),
  );

  effectIt.effect('rejects a seed ancestor swapped to a symbolic link before descriptor open', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      const outside = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-outside-')));
      homes.push(contextHome, repo, outside);
      const sourceDirectory = join(repo, 'docs');
      const source = join(sourceDirectory, 'README.md');
      const outsideSource = join(outside, 'README.md');
      yield* Effect.promise(() => mkdir(sourceDirectory, {recursive: true}));
      yield* Effect.promise(() => writeFile(source, '# Safe original\n', 'utf8'));
      yield* Effect.promise(() => writeFile(outsideSource, '# outside secret\n', 'utf8'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed: [docs/README.md]',
              '',
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };
      const storedPath = join(contextHome, 'data', 'local', 'resources', 'repos', 'sample-repo', 'docs', 'README.md');
      const statePath = join(contextHome, 'seed-state.json');
      yield* captureConsole(runSeed(config, {}));
      const stateBefore = JSON.parse(yield* Effect.promise(() => readFile(statePath, 'utf8'))) as unknown;
      let swapped = false;

      const error = yield* run(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const canonicalSource = yield* fileSystem.realPath(source);
          const canonicalSourceDirectory = yield* fileSystem.realPath(sourceDirectory);
          const originalSourceDirectory = `${canonicalSourceDirectory}.original`;
          const racingFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            open: (target, options) => {
              if (String(target) !== canonicalSource || swapped) {
                return fileSystem.open(target, options);
              }
              swapped = true;
              return fileSystem
                .rename(canonicalSourceDirectory, originalSourceDirectory)
                .pipe(
                  Effect.andThen(fileSystem.symlink(outside, canonicalSourceDirectory)),
                  Effect.andThen(fileSystem.open(target, options)),
                );
            },
          });
          return yield* runSeed(config, {}).pipe(
            Effect.provideService(FileSystem.FileSystem, racingFileSystem),
            Effect.flip,
          );
        }),
      );

      expect(swapped).toBe(true);
      expect(error).toMatchObject({
        message: '1 project(s) failed after the remaining projects were processed: sample-repo',
      });
      const preserved = yield* Effect.promise(() => readFile(storedPath, 'utf8'));
      expect(preserved).toContain('Safe original');
      expect(preserved).not.toContain('outside secret');
      expect(JSON.parse(yield* Effect.promise(() => readFile(statePath, 'utf8')))).toEqual(stateBefore);
    }),
  );

  effectIt.effect('preserves seeded resources when filesystem observation is denied', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      const source = join(repo, 'README.md');
      yield* Effect.promise(() => writeFile(source, '# Preserve on observation error\n', 'utf8'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed: [README.md]',
              '',
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };
      const storedPath = join(contextHome, 'data', 'local', 'resources', 'repos', 'sample-repo', 'README.md');
      const statePath = join(contextHome, 'seed-state.json');
      yield* captureConsole(runSeed(config, {}));
      const stateBefore = JSON.parse(yield* Effect.promise(() => readFile(statePath, 'utf8'))) as unknown;
      let deniedObservations = 0;

      const error = yield* run(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const deniedFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            stat: target => {
              if (String(target) !== source) {
                return fileSystem.stat(target);
              }
              deniedObservations += 1;
              return Effect.fail(
                PlatformError.systemError({
                  _tag: 'PermissionDenied',
                  description: 'injected seed observation failure',
                  method: 'stat',
                  module: 'FileSystem',
                  pathOrDescriptor: source,
                }),
              );
            },
          });
          return yield* runSeed(config, {}).pipe(
            Effect.provideService(FileSystem.FileSystem, deniedFileSystem),
            Effect.flip,
          );
        }),
      );

      expect(deniedObservations).toBeGreaterThan(0);
      expect(error).toMatchObject({
        message: '1 project(s) failed after the remaining projects were processed: sample-repo',
      });
      expect(yield* Effect.promise(() => readFile(storedPath, 'utf8'))).toContain('Preserve on observation error');
      expect(JSON.parse(yield* Effect.promise(() => readFile(statePath, 'utf8')))).toEqual(stateBefore);
    }),
  );

  effectIt.effect('does not skip same-size files changed within the recorded millisecond', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      const readmePath = join(repo, 'README.md');
      yield* Effect.promise(() => writeFile(readmePath, '# Sample\n', 'utf8'));
      const fractionalSeconds = 1_700_000_000.123456;
      yield* Effect.promise(() => utimes(readmePath, fractionalSeconds, fractionalSeconds));
      const readmeStat = yield* Effect.promise(() => stat(readmePath));
      const recordedMtimeMs = readmeStat.mtime.getTime();
      expect(readmeStat.mtimeMs).not.toBe(recordedMtimeMs);

      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed:',
              '      - README.md',
              '',
            ],
            '\n',
          ),
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(contextHome, 'seed-state.json'),
          JSON.stringify({
            files: {
              'threadnote://resources/repos/sample-repo/README.md': {
                mtimeMs: recordedMtimeMs,
                size: readmeStat.size,
              },
            },
            version: 1,
          }),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeed(config, {dryRun: true}));

      expect(output).toContain('Would seed resource:');
      expect(output).toContain(
        'Seed complete: 1 candidate(s), 0 unchanged, 0 stale removed, 0 skipped for safety, 0 project(s) failed.',
      );
    }),
  );

  effectIt.effect('uses the publish scrubber patterns when skipping seed files', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      yield* Effect.promise(() =>
        writeFile(join(repo, 'README.md'), 'dsn=postgres://user:password@db.example.com:5432/app\n', 'utf8'),
      );
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed:',
              '      - README.md',
              '',
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeed(config, {dryRun: true}));

      expect(output).toContain('SKIP sample-repo/README.md: possible secret (database URI)');
      expect(output).toContain(
        'Seed complete: 0 candidate(s), 0 unchanged, 0 stale removed, 1 skipped for safety, 0 project(s) failed.',
      );
      expect(output).toContain('Seed safety summary: 1 file(s) were not seeded.');
    }),
  );

  effectIt.effect('redacts macOS, Git-Bash, WSL, and Windows local paths in seeded text', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      yield* Effect.promise(() =>
        writeFile(
          join(repo, 'CLAUDE.md'),
          EffectArray.join(
            [
              'Local checkout: /Users/jane/work/project',
              'Git-Bash commands use /c/Users/jane/work/project',
              'WSL commands use /mnt/c/Users/jane/work/project',
              'Windows tools use C:/Users/jane/work/project',
              '',
            ],
            '\n',
          ),
          'utf8',
        ),
      );
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed: [CLAUDE.md]',
              '',
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeed(config, {}));
      const seeded = yield* Effect.promise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'sample-repo', 'CLAUDE.md'), 'utf8'),
      );

      expect(output).not.toContain('SKIP');
      expect(seeded).toBe(
        EffectArray.join(
          [
            'Local checkout: <local-path>',
            'Git-Bash commands use <local-path>',
            'WSL commands use <local-path>',
            'Windows tools use <local-path>',
            '',
          ],
          '\n',
        ),
      );
    }),
  );

  effectIt.effect(
    'prunes ignored and implicit hidden directories while retaining explicitly seeded guidance roots',
    () =>
      Effect.gen(function* () {
        const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
        const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
        homes.push(contextHome, repo);
        yield* Effect.promise(() => mkdir(join(repo, 'node_modules', 'pkg'), {recursive: true}));
        yield* Effect.promise(() => mkdir(join(repo, '.nx', 'cache'), {recursive: true}));
        yield* Effect.promise(() => mkdir(join(repo, '.private'), {recursive: true}));
        yield* Effect.promise(() => mkdir(join(repo, '.claude', 'commands'), {recursive: true}));
        yield* Effect.promise(() => writeFile(join(repo, 'README.md'), '# Root\n', 'utf8'));
        yield* Effect.promise(() =>
          writeFile(join(repo, 'node_modules', 'pkg', 'README.md'), '# Dependency\n', 'utf8'),
        );
        yield* Effect.promise(() => writeFile(join(repo, '.nx', 'cache', 'result.md'), '# Cache\n', 'utf8'));
        yield* Effect.promise(() => writeFile(join(repo, '.private', 'notes.md'), '# Private hidden folder\n', 'utf8'));
        yield* Effect.promise(() =>
          writeFile(join(repo, '.claude', 'commands', 'review.md'), '# Explicit guidance\n', 'utf8'),
        );
        const manifestPath = join(contextHome, 'seed-manifest.yaml');
        yield* Effect.promise(() =>
          writeFile(
            manifestPath,
            EffectArray.join(
              [
                'version: 1',
                'projects:',
                '  - name: sample-repo',
                `    path: ${repo}`,
                '    uri: threadnote://resources/repos/sample-repo',
                '    seed:',
                '      - "**/*.md"',
                '      - ".claude/**/*.md"',
                '',
              ],
              '\n',
            ),
          ),
        );
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: contextHome,
          agentId: 'threadnote',
          manifestPath,
          user: 'denys',
        };

        const output = yield* captureConsole(runSeed(config, {dryRun: true}));

        expect(output).toContain('sample-repo/README.md');
        expect(output).toContain('sample-repo/.claude/commands/review.md');
        expect(output).not.toContain('node_modules');
        expect(output).not.toContain('/.nx/');
        expect(output).not.toContain('/.private/');
      }),
  );

  effectIt.effect('continues seeding later projects and reports an aggregate failure when one project fails', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const failingRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-failing-repo-')));
      const healthyRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-healthy-repo-')));
      homes.push(contextHome, failingRepo, healthyRepo);
      yield* Effect.promise(() => writeFile(join(failingRepo, 'bad?.md'), '# Failing project\n', 'utf8'));
      yield* Effect.promise(() => writeFile(join(healthyRepo, 'README.md'), '# Healthy project\n', 'utf8'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: failing',
              `    path: ${failingRepo}`,
              '    uri: threadnote://resources/repos/failing',
              '    seed: ["*.md"]',
              '  - name: healthy',
              `    path: ${healthyRepo}`,
              '    uri: threadnote://resources/repos/healthy',
              '    seed: [README.md]',
              '',
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const failure = yield* run(runSeed(config, {})).pipe(Effect.flip);
      expect(String(failure)).toContain('1 project(s) failed');
      const healthy = yield* Effect.promise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'healthy', 'README.md'), 'utf8'),
      );
      expect(healthy).toContain('Healthy project');
    }),
  );

  effectIt.effect('removes stale canonical resources when a seeded file is deleted or renamed', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      const source = join(repo, 'README.md');
      const renamed = join(repo, 'GUIDE.md');
      yield* Effect.promise(() => writeFile(source, '# Sample\n', 'utf8'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed:',
              '      - "*.md"',
              '',
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      yield* captureConsole(runSeed(config, {}));
      yield* Effect.promise(() => rename(source, renamed));
      const output = yield* captureConsole(runSeed(config, {}));

      const removed = yield* Effect.tryPromise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'sample-repo', 'README.md')),
      ).pipe(Effect.flip);
      expect(removed).toBeDefined();
      const guide = yield* Effect.promise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'sample-repo', 'GUIDE.md'), 'utf8'),
      );
      expect(guide).toContain('Sample');
      expect(output).toContain('1 stale removed');
    }),
  );

  effectIt.effect('transfers seed-state ownership when a manifest project is renamed', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      const source = join(repo, 'README.md');
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      const writeManifest = (name: string) =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              `  - name: ${name}`,
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/stable-uri',
              '    seed: [README.md]',
              '',
            ],
            '\n',
          ),
        );
      yield* Effect.promise(() => writeFile(source, '# Project\n\nrename ownership anchor'));
      yield* Effect.promise(() => writeManifest('old-project-name'));
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };
      yield* captureConsole(runSeed(config, {}));

      yield* Effect.promise(() => writeManifest('new-project-name'));
      yield* Effect.promise(() => rm(source));
      const output = yield* captureConsole(runSeed(config, {}));

      const removed = yield* Effect.tryPromise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'stable-uri', 'README.md')),
      ).pipe(Effect.flip);
      expect(removed).toBeDefined();
      const state = yield* Schema.decodeUnknownEffect(seedStateFileSchema)(
        JSON.parse(yield* Effect.promise(() => readFile(join(contextHome, 'seed-state.json'), 'utf8'))),
      );
      expect(state.files['threadnote://resources/repos/stable-uri/README.md']).toBeUndefined();
      expect(output).toContain('1 stale removed');
    }),
  );

  effectIt.effect('keeps child-project resources when seed URI roots are nested', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const parentRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-parent-')));
      const childRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-child-')));
      homes.push(contextHome, parentRepo, childRepo);
      yield* Effect.promise(() => writeFile(join(parentRepo, 'parent.md'), '# Parent\n', 'utf8'));
      yield* Effect.promise(() => writeFile(join(childRepo, 'child.md'), '# Child\n', 'utf8'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: child',
              `    path: ${childRepo}`,
              '    uri: threadnote://resources/repos/platform/service',
              '    seed: ["*.md"]',
              '  - name: parent',
              `    path: ${parentRepo}`,
              '    uri: threadnote://resources/repos/platform',
              '    seed: ["*.md"]',
              '',
            ],
            '\n',
          ),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      yield* captureConsole(runSeed(config, {}));

      const child = yield* Effect.promise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'platform', 'service', 'child.md'), 'utf8'),
      );
      expect(child).toContain('Child');
      const state = yield* Schema.decodeUnknownEffect(seedStateProjectSchema)(
        JSON.parse(yield* Effect.promise(() => readFile(join(contextHome, 'seed-state.json'), 'utf8'))),
      );
      expect(state.files['threadnote://resources/repos/platform/service/child.md']?.project).toBe('child');
    }),
  );
});

describe('seed-skills', () => {
  const homes: string[] = [];
  const originalHome = process.env.HOME;

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect('discovers global Cursor skills and repo-local Claude command markdown files', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-skills-home-')));
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-skills-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-skills-repo-')));
      homes.push(home, contextHome, repo);
      inheritedProcessEnvironment().HOME = home;

      yield* Effect.promise(() => mkdir(join(home, '.claude', 'commands'), {recursive: true}));
      yield* Effect.promise(() =>
        writeFile(join(home, '.claude', 'commands', 'weekly.md'), '# Weekly\n\nSummarize the week.\n'),
      );
      yield* Effect.promise(() => mkdir(join(home, '.cursor', 'skills', 'reviewer'), {recursive: true}));
      yield* Effect.promise(() =>
        writeFile(join(home, '.cursor', 'skills', 'reviewer', 'SKILL.md'), '# Cursor Reviewer\n\nReview diffs.\n'),
      );
      yield* Effect.promise(() => mkdir(join(repo, '.claude', 'commands'), {recursive: true}));
      yield* Effect.promise(() =>
        writeFile(join(repo, '.claude', 'commands', 'review-pr.md'), '# Review PR\n\nReview the current PR.\n'),
      );
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed: []',
              '',
            ],
            '\n',
          ),
        ),
      );

      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeedSkills(config, {dryRun: true}));

      expect(output).toContain(`Command claude-commands-global: ${join(home, '.claude', 'commands', 'weekly.md')}`);
      expect(output).toContain(`Skill cursor-global: ${join(home, '.cursor', 'skills', 'reviewer', 'SKILL.md')}`);
      expect(output).toContain(
        `Command repo-local:sample-repo:claude-commands: ${join(repo, '.claude', 'commands', 'review-pr.md')}`,
      );
      expect(output).toMatch(/threadnote:\/\/resources\/agent-skills\/claude-commands-global\/weekly-[a-f0-9]{12}\.md/);
      expect(output).toMatch(
        /threadnote:\/\/resources\/agent-skills\/repo-local-sample-repo-claude-commands\/review-pr-[a-f0-9]{12}\.md/,
      );
      expect(output).not.toContain('--reason');
      expect(output).not.toContain('Agent command catalog item from claude-commands-global: weekly.md');
      expect(output).toContain('Skill seed complete: 3 unique catalog item(s).');
    }),
  );
});

describe('init-manifest', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect('preserves worksets while adding a repo', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-init-manifest-context-')));
      const existingRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-existing-repo-')));
      const newRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-new-repo-')));
      homes.push(contextHome, existingRepo, newRepo);
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              '  - name: existing-repo',
              `    path: ${existingRepo}`,
              '    uri: threadnote://resources/repos/existing-repo',
              '    seed: [README.md]',
              '    graph:',
              '      roots: [apps/existing]',
              '      closure: dependencies',
              '      include: [tools/generated]',
              'worksets:',
              '  - name: platform',
              '    description: existing grouped repos',
              '    projects: [existing-repo, missing-repo]',
              '',
            ],
            '\n',
          ),
        ),
      );

      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      yield* captureConsole(runInitManifest(config, {path: manifestPath, repo: [newRepo]}));

      const manifest = yield* run(readSeedManifest(manifestPath));
      expect(manifest.projects).toHaveLength(2);
      expect(manifest.projects[0]?.name).toBe('existing-repo');
      expect(manifest.projects[0]?.graph).toEqual({
        closure: 'dependencies',
        include: ['tools/generated'],
        roots: ['apps/existing'],
      });
      expect(manifest.projects[1]?.path).toContain('threadnote-new-repo-');
      expect(manifest.worksets).toEqual([
        {
          description: 'existing grouped repos',
          name: 'platform',
          projects: ['existing-repo', 'missing-repo'],
        },
      ]);
    }),
  );

  effectIt.effect('uses the git remote repo name for new manifest projects', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-init-manifest-context-')));
      const repo = join(contextHome, 'easy-to-type');
      const previousGitEnv = new Map(EffectArray.map(GIT_ENV_KEYS, key => [key, inheritedProcessEnvironment()[key]]));
      homes.push(contextHome);
      for (const key of GIT_ENV_KEYS) {
        delete inheritedProcessEnvironment()[key];
      }
      try {
        yield* Effect.promise(() => mkdir(repo));
        yield* run(runCommand('git', ['init'], {cwd: repo}));
        yield* run(
          runCommand('git', ['remote', 'add', 'origin', 'git@github.com:Kashkovsky/threadnote.git'], {cwd: repo}),
        );
        const manifestPath = join(contextHome, 'seed-manifest.yaml');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: contextHome,
          agentId: 'threadnote',
          manifestPath,
          user: 'denys',
        };

        yield* captureConsole(runInitManifest(config, {path: manifestPath, repo: [repo]}));

        const manifest = yield* run(readSeedManifest(manifestPath));
        expect(manifest.projects[0]?.name).toBe('threadnote');
        expect(manifest.projects[0]?.uri).toBe('threadnote://resources/repos/threadnote');
      } finally {
        for (const key of GIT_ENV_KEYS) {
          const value = previousGitEnv.get(key);
          if (value === undefined) {
            delete inheritedProcessEnvironment()[key];
          } else {
            inheritedProcessEnvironment()[key] = value;
          }
        }
      }
    }).pipe(TestClock.withLive),
  );
});

describe('seedDependencyGraphs', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect('writes dependency facts directly to the native resource store', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-graph-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-graph-repo-')));
      homes.push(contextHome, repo);
      yield* Effect.promise(() => writeFile(join(repo, 'package.json'), JSON.stringify({name: '@acme/pkg'}), 'utf8'));
      const manifest: SeedManifest = {
        projects: [
          {
            name: '../bad',
            path: repo,
            seed: [],
            uri: 'threadnote://resources/repos/bad',
          },
        ],
        version: 1,
      };
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath: join(contextHome, 'seed-manifest.yaml'),
        user: 'denys',
      };

      yield* captureConsole(seedDependencyGraphs(config, 'threadnote-native', manifest, manifest.projects, false));

      const graph = yield* Effect.promise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'bad', '.graph.md'), 'utf8'),
      );
      expect(graph).toContain('# ../bad — dependency facts');
      const misplaced = yield* Effect.tryPromise(() => readFile(join(contextHome, 'bad.graph.md'), 'utf8')).pipe(
        Effect.flip,
      );
      expect(misplaced).toBeDefined();
    }),
  );
});
