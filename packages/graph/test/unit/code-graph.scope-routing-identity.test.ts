import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Junctions keep directory-link fixtures unprivileged on Windows.
import {symlinkSync} from 'node:fs';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {resolveCodeGraphScopeRoute} from '@threadnote/graph/scope/routing';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import * as EffectString from 'effect/String';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'scope-routing-identity-'});
  const root = path.join(home, 'repo');
  const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
  const repository = (cwd: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(cwd, {recursive: true});
      yield* git(cwd, ['init', '--quiet', '--initial-branch=main']);
      yield* git(cwd, [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '--quiet',
        '-m',
        'fixture',
      ]);
    });
  yield* repository(root);
  const manifest = path.join(home, 'manifest.json');
  const configure = (projectPath: string) =>
    fs.writeFileString(
      manifest,
      JSON.stringify({
        version: 1,
        projects: [
          {
            name: 'fixture',
            path: projectPath,
            seed: [],
            uri: 'threadnote://resources/repos/fixture',
          },
        ],
      }),
    );
  return {fs, path, home, root, git, repository, manifest, configure};
});

const observe = (manifest: string, cwd: string) =>
  Effect.gen(function* () {
    const command = yield* CommandExecutor;
    const discoveries: string[] = [];
    let commands = 0;
    const record = (args: readonly string[]) => {
      commands += 1;
      if (args.includes('--abbrev-ref=loose')) discoveries.push(args[args.indexOf('-C') + 1]);
    };
    const counted = CommandExecutor.of({
      ...command,
      execute: (executable, args, options) => {
        record(args);
        return command.execute(executable, args, options);
      },
      executeBytes:
        command.executeBytes === undefined
          ? undefined
          : (executable, args, options) => {
              record(args);
              return command.executeBytes!(executable, args, options);
            },
    });
    const result = yield* resolveCodeGraphScopeRoute(manifest, cwd, 'fixture').pipe(
      Effect.provideService(CommandExecutor, counted),
      Effect.result,
    );
    return {result, discoveries, commands};
  });

describe('fresh scope routing identity observations', () => {
  effectIt.layer(citationPlatformLayer)(test => {
    test.effect('obtains one fresh identity for identical caller and project paths on every invocation', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.configure(f.root);
        const first = yield* observe(f.manifest, f.root);
        expect(first.result).toMatchObject({_tag: 'Success', success: {state: 'selected'}});
        expect(first.discoveries).toEqual([f.root]);
        expect(first.commands).toBe(3);
        yield* f.fs.rename(f.path.join(f.root, '.git'), f.path.join(f.home, 'saved-git'));
        const unavailable = yield* observe(f.manifest, f.root);
        expect(unavailable.result._tag).toBe('Failure');
        expect(unavailable.discoveries).toEqual([f.root]);
      }).pipe(TestClock.withLive),
    );

    test.effect.prop(
      'matches an independent checkout model and freshly reads each distinct existing path string',
      {
        relation: Schema.Literals(['same', 'subdirectory', 'nested-repository', 'foreign-repository']),
        suffix: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 9999})),
        ignoreCase: Schema.Boolean,
      },
      ({relation, suffix, ignoreCase}) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.git(f.root, ['config', 'core.ignorecase', String(ignoreCase)]);
          const project =
            relation === 'same'
              ? f.root
              : relation === 'foreign-repository'
                ? f.path.join(f.home, `foreign-${suffix}`)
                : f.path.join(f.root, `child-${suffix}`);
          if (relation === 'subdirectory') yield* f.fs.makeDirectory(project);
          if (relation === 'nested-repository' || relation === 'foreign-repository') yield* f.repository(project);
          yield* f.configure(project);
          const expected = relation === 'same' || relation === 'subdirectory';
          for (let invocation = 0; invocation < 2; invocation++) {
            const actual = yield* observe(f.manifest, f.root);
            expect(actual.result._tag).toBe(expected ? 'Success' : 'Failure');
            expect(actual.discoveries.slice().sort()).toEqual([...new Set([f.root, project])].sort());
            expect(actual.commands).toBe(relation === 'same' ? 3 : 6);
          }
        }).pipe(TestClock.withLive),
      {arbitrary: {runs: 16, seed: 411079}},
    );

    test.effect('keeps an unavailable distinct project root fail-closed', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const missing = f.path.join(f.home, 'missing');
        yield* f.configure(missing);
        const actual = yield* observe(f.manifest, f.root);
        expect(actual.result._tag).toBe('Failure');
        expect(actual.discoveries.slice().sort()).toEqual([f.root, missing].sort());
      }).pipe(TestClock.withLive),
    );

    test.effect('independently observes linked worktrees and different symlink spellings', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const linked = f.path.join(f.home, 'linked');
        yield* f.git(f.root, ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);
        const alias = f.path.join(f.home, 'alias');
        yield* Effect.sync(() => symlinkSync(f.root, alias, 'junction'));
        for (const project of [linked, alias]) {
          yield* f.configure(project);
          const actual = yield* observe(f.manifest, f.root);
          expect(actual.result._tag).toBe('Success');
          expect(actual.discoveries.slice().sort()).toEqual([f.root, project].sort());
        }
      }).pipe(TestClock.withLive),
    );

    test.effect('independently observes symlink/.. strings using native Git locality', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const target = f.path.join(f.home, 'other', 'target');
        yield* f.fs.makeDirectory(target, {recursive: true});
        yield* f.repository(f.path.join(f.home, 'other', 'repo'));
        const alias = f.path.join(f.home, 'alias');
        yield* Effect.sync(() => symlinkSync(target, alias, 'junction'));
        const project = `${alias}/../repo`;
        expect(f.path.resolve(project)).toBe(f.root);
        // Junction/.. lookup differs by platform; Git supplies the independent
        // locality oracle while both original path strings must still be read.
        const [callerGit, projectGit] = yield* Effect.all([
          f.git(f.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
          f.git(project, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        ]);
        const sameCheckout = EffectString.trim(callerGit.stdout) === EffectString.trim(projectGit.stdout);
        yield* f.configure(project);
        const actual = yield* observe(f.manifest, f.root);
        expect(actual.result._tag).toBe(sameCheckout ? 'Success' : 'Failure');
        expect(actual.discoveries.slice().sort()).toEqual([f.root, project].sort());
      }).pipe(TestClock.withLive),
    );
  });
});
