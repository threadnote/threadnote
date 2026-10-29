import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {readTeamsFile} from '../share/index.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {findExecutable, runCommand} from '../utils.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const shareSummaries = Effect.fn('manager.shareSummaries')(function* (config: RuntimeConfig) {
  const teamsFile = yield* readTeamsFile(config);
  const git = yield* findExecutable(['git']);
  const entries = yield* Effect.forEach(
    EffectRecord.values(teamsFile.teams),
    Effect.fn('manager.callback')(function* (team) {
      if (!git) {
        return {...team, default: teamsFile.defaultTeam === team.name, warning: 'git not found'};
      }
      const status = yield* runCommand(git, ['-C', team.worktree, 'status', '--short', '--branch'], {
        allowFailure: true,
      });
      const ahead = yield* gitCount(git, team.worktree, '@{u}..HEAD');
      const behind = yield* gitCount(git, team.worktree, 'HEAD..@{u}');
      return {
        ...team,
        ahead,
        behind,
        default: teamsFile.defaultTeam === team.name,
        dirty: EffectArray.some(
          Effect2.pipe(status.stdout, EffectString.split('\n')),
          line =>
            Effect2.pipe(line, EffectString.trim).length > 0 && !Effect2.pipe(line, EffectString.startsWith('##')),
        ),
        status: Effect2.pipe(status.stdout, EffectString.trim),
        warning:
          status.exitCode === 0
            ? undefined
            : Effect2.pipe(status.stderr, EffectString.trim) || Effect2.pipe(status.stdout, EffectString.trim),
      };
    }),
  );
  return entries.sort((left, right) => Effect2.pipe(left.name, EffectString.localeCompare(right.name)));
});

export const gitCount = Effect.fn('manager.gitCount')(function* (git: string, worktree: string, range: string) {
  const result = yield* runCommand(git, ['-C', worktree, 'rev-list', '--count', range], {allowFailure: true});
  if (result.exitCode !== 0) {
    return undefined;
  }
  return Number.parseInt(Effect2.pipe(result.stdout, EffectString.trim), 10) || 0;
});
