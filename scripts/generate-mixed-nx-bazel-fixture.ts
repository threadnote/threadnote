import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {BunRuntime} from '@effect/platform-bun';
import {Effect, FileSystem, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const MIXED_NX_BAZEL_FIXTURE_SOURCES = [
  {
    commit: '2d15c7faa570629657112857a079803897e8e43d',
    id: 'nx',
    repository: 'https://github.com/nrwl/nx.git',
    target: '.',
  },
  {
    commit: '0960bdd0f542a73a4a6fa3183d68ef5766cce285',
    id: 'rules-js',
    repository: 'https://github.com/aspect-build/rules_js.git',
    target: 'apps/rules-js',
  },
  {
    commit: '8925a4ee491aebaf6a1a74880c73dfb20e0a4ba1',
    id: 'angular',
    repository: 'https://github.com/angular/angular.git',
    sparsePaths: ['MODULE.bazel', 'WORKSPACE', 'BUILD.bazel', 'package.json', 'adev/src/app', 'packages/examples'],
    target: 'apps/angular',
  },
] as const;

export interface MixedNxBazelFixtureArguments {
  readonly output: string;
}

export function parseMixedNxBazelFixtureArguments(args: readonly string[]): MixedNxBazelFixtureArguments {
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') output = args[++index];
    else throw ScriptError.make({message: `Unknown mixed-monorepo fixture option: ${argument}`});
  }
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!output?.trim()) throw ScriptError.make({message: '--output requires a path.'});
  return {output};
}

export const generateMixedNxBazelFixture = Effect.fn('mixedNxBazelFixture.generate')(function* (
  args: readonly string[] = process.argv.slice(2),
) {
  const options = parseMixedNxBazelFixtureArguments(args);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = path.resolve(options.output);
  if (yield* fs.exists(output)) throw ScriptError.make({message: `Fixture output already exists: ${output}`});

  const [nx, rulesJs, angular] = MIXED_NX_BAZEL_FIXTURE_SOURCES;
  yield* cloneExact(nx.repository, nx.commit, output);
  yield* fs.remove(path.join(output, '.git'), {force: true, recursive: true});

  const rulesTarget = path.join(output, rulesJs.target);
  yield* fs.makeDirectory(path.dirname(rulesTarget), {recursive: true});
  yield* cloneExact(rulesJs.repository, rulesJs.commit, rulesTarget);
  yield* fs.remove(path.join(rulesTarget, '.git'), {force: true, recursive: true});

  const angularTarget = path.join(output, angular.target);
  yield* cloneExact(angular.repository, angular.commit, angularTarget, angular.sparsePaths);
  yield* fs.remove(path.join(angularTarget, '.git'), {force: true, recursive: true});

  yield* fs.writeFileString(
    path.join(output, 'threadnote-mixed-monorepo-fixture.json'),
    `${JSON.stringify({sources: MIXED_NX_BAZEL_FIXTURE_SOURCES, version: 1}, undefined, 2)}\n`,
  );
  yield* runGit(output, ['init', '--quiet']);
  yield* runGit(output, ['add', '.'], 15 * 60_000);
  yield* runGit(
    output,
    [
      '-c',
      'user.name=Threadnote Evaluation',
      '-c',
      'user.email=evaluation@threadnote.local',
      'commit',
      '--quiet',
      '-m',
      'pinned mixed Nx and Bazel fixture',
    ],
    15 * 60_000,
  );
  return output;
});

const cloneExact = Effect.fn('mixedNxBazelFixture.cloneExact')(function* (
  repository: string,
  commit: string,
  target: string,
  sparsePaths?: readonly string[],
) {
  yield* runCommandEffect(
    'git',
    [
      'clone',
      '--quiet',
      '--filter=blob:none',
      '--no-checkout',
      ...(sparsePaths ? ['--sparse'] : []),
      repository,
      target,
    ],
    {maxOutputBytes: 64 * 1_024, timeoutMs: 10 * 60_000},
  );
  if (sparsePaths) yield* runGit(target, ['sparse-checkout', 'set', '--no-cone', ...sparsePaths]);
  yield* runGit(target, ['checkout', '--quiet', commit], 10 * 60_000);
  const resolved = Effect2.pipe((yield* runGit(target, ['rev-parse', 'HEAD'])).stdout, EffectString.trim);
  if (resolved !== commit)
    throw ScriptError.make({message: `Fixture source resolved ${resolved} instead of ${commit}.`});
});

const runGit = (cwd: string, args: readonly string[], timeoutMs = 60_000) =>
  runCommandEffect('git', ['-C', cwd, ...args], {maxOutputBytes: 64 * 1_024, timeoutMs});

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(generateMixedNxBazelFixture(), ApplicationLayer));
