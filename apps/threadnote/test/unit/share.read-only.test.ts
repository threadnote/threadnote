import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, FileSystem, Path, Schema} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {beforeEach, describe, expect, vi} from 'vitest';
import {
  runShareList,
  runShareInit,
  runSharePublish,
  runSharePublishArtifact,
  runSharePublishBundle,
  runShareSetAccess,
  runShareStatus,
  runShareSync,
  runShareUnpublish,
} from '@threadnote/threadnote/effect/share';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {CommandResult} from '@threadnote/platform/command';
import type {ShareRuntime} from '@threadnote/threadnote/types';
import * as utils from '@threadnote/threadnote/utils';

vi.mock('@threadnote/threadnote/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/utils')>();
  return {
    ...actual,
    maybeRun: vi.fn().mockReturnValue(succeedUndefined),
    requiredExecutable: vi.fn().mockReturnValue(Effect.succeed('git')),
    runCommand: vi.fn(),
  };
});

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stderr: '', stdout});

describe('read-only shared teams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(utils.requiredExecutable).mockReturnValue(Effect.succeed('git'));
    vi.mocked(utils.maybeRun).mockReturnValue(succeedUndefined);
    vi.mocked(utils.runCommand).mockImplementation((_executable, args) => {
      if (args.includes('--porcelain')) return Effect.succeed(ok());
      if (args.includes('rev-list')) return Effect.succeed(ok('0\n'));
      if (args.includes('rev-parse')) return Effect.succeed(ok('abc123\n'));
      return Effect.succeed(ok());
    });
  });

  effectIt.effect('initializes a persistent read-only checkout without housekeeping commits', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-share-read-only-init-'});
        const config: ShareRuntime = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          user: 'tester',
        };
        yield* fs.makeDirectory(path.join(home, 'share', 'worktrees', 'reference'), {recursive: true});

        yield* runShareInit(config, 'git@example.com:team/memories.git', {
          readOnly: true,
          team: 'reference',
        });

        const stored = yield* Schema.decodeUnknownEffect(
          Schema.Struct({teams: Schema.Struct({reference: Schema.Struct({access: Schema.String})})}),
        )(JSON.parse(yield* fs.readFileString(path.join(home, 'share', 'teams.json'))));
        expect(stored.teams.reference.access).toBe('read-only');
        expect(vi.mocked(utils.runCommand)).not.toHaveBeenCalled();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('persists and displays access while clean sync fetches without committing or pushing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* readOnlyFixture();
        const legacyList = yield* captureConsole(runShareList(fixture.config, {}));
        expect(legacyList.output).toContain('access: read-write');

        yield* runShareSetAccess(fixture.config, {mode: 'read-only'});
        const stored = yield* Schema.decodeUnknownEffect(
          Schema.Struct({teams: Schema.Struct({reference: Schema.Struct({access: Schema.String})})}),
        )(JSON.parse(yield* fixture.fs.readFileString(fixture.teamsPath)));
        expect(stored.teams.reference.access).toBe('read-only');

        const [list, status, sync] = yield* Effect.all(
          [
            captureConsole(runShareList(fixture.config, {})),
            captureConsole(runShareStatus(fixture.config, {team: 'reference'})),
            captureConsole(runShareSync(fixture.config, {team: 'reference'})),
          ],
          {concurrency: 1},
        );
        expect(list.output).toContain('access: read-only');
        expect(status.output).toContain('Access: read-only');
        expect(sync.output).toContain('push disabled');
        const gitArguments = EffectArray.map(vi.mocked(utils.runCommand).mock.calls, ([, args]) => args);
        expect(EffectArray.some(gitArguments, args => args.includes('commit'))).toBe(false);
        expect(EffectArray.some(gitArguments, args => args.includes('push'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects every publication surface before reading its source', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* readOnlyFixture('read-only');
        const failures = yield* Effect.all(
          [
            failureText(
              runSharePublish(fixture.config, 'threadnote://user/tester/memories/durable/projects/app/note.md', {
                dryRun: true,
                team: 'reference',
              }),
            ),
            failureText(
              runShareUnpublish(
                fixture.config,
                'threadnote://user/tester/memories/shared/reference/durable/projects/app/note.md',
                {dryRun: true, team: 'reference'},
              ),
            ),
            failureText(
              runSharePublishArtifact(fixture.config, '/source/does-not-need-to-exist/SKILL.md', {
                dryRun: true,
                team: 'reference',
              }),
            ),
            failureText(
              runSharePublishBundle(fixture.config, '/source/does-not-need-to-exist/threadnote-bundle.json', {
                dryRun: true,
                team: 'reference',
              }),
            ),
          ],
          {concurrency: 1},
        );
        expect(failures).toEqual([
          expect.stringContaining('read-only; cannot publish memories'),
          expect.stringContaining('read-only; cannot unpublish memories'),
          expect.stringContaining('read-only; cannot publish agent artifacts'),
          expect.stringContaining('read-only; cannot publish agent artifact bundles'),
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses dirty state instead of auto-committing a read-only worktree', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* readOnlyFixture('read-only');
        vi.mocked(utils.runCommand).mockImplementation((_executable, args) =>
          Effect.succeed(args.includes('--porcelain') ? ok(' M durable/projects/app/note.md\n') : ok('0\n')),
        );

        const failure = yield* failureText(runShareSync(fixture.config, {team: 'reference'}));

        expect(String(failure)).toContain('will not auto-commit read-only teams');
        const gitArguments = EffectArray.map(vi.mocked(utils.runCommand).mock.calls, ([, args]) => args);
        expect(EffectArray.some(gitArguments, args => args.includes('commit'))).toBe(false);
        expect(EffectArray.some(gitArguments, args => args.includes('push'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const readOnlyFixture = Effect.fn('test.shareReadOnlyFixture')(function* (access?: 'read-only') {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-share-read-only-'});
  const worktree = path.join(home, 'share', 'worktrees', 'reference');
  const gitdir = path.join(home, 'share', 'teams', 'reference.gitdir');
  const teamsPath = path.join(home, 'share', 'teams.json');
  yield* fs.makeDirectory(worktree, {recursive: true});
  yield* fs.makeDirectory(gitdir, {recursive: true});
  yield* fs.writeFileString(
    teamsPath,
    `${JSON.stringify(
      {
        defaultTeam: 'reference',
        teams: {
          reference: {
            ...(access === undefined ? {} : {access}),
            addedAt: '2026-08-10T00:00:00.000Z',
            gitdir,
            name: 'reference',
            remote: 'git@example.com:team/memories.git',
            worktree,
          },
        },
        version: 1,
      },
      undefined,
      2,
    )}\n`,
  );
  const config: ShareRuntime = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    user: 'tester',
  };
  return {config, fs, teamsPath};
});

function failureText<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<string, never, R> {
  return Effect.exit(effect).pipe(
    Effect.map(exit => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : 'Operation unexpectedly succeeded.')),
  );
}
