import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {
  CommandExecutor,
  CommandOutputLimitExceeded,
  CommandSpawnFailed,
  CommandTimedOut,
} from '@threadnote/platform/command';
import {startRepositoryWorktreeObservation} from '@threadnote/graph/repository';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const modes = [
  'clean',
  'dirty',
  'head',
  'root',
  'common',
  'missing',
  'duplicate',
  'unborn',
  'unborn-limit',
  'limit',
  'timeout',
  'spawn',
] as const;
type Mode = (typeof modes)[number];
const scenario = (mode: Mode, objectFormat: 'sha1' | 'sha256') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const command = yield* CommandExecutor;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-worktree-observation-'});
    const repoRoot = yield* fs.realPath(root);
    const common = path.join(repoRoot, '.git');
    const other = path.join(repoRoot, 'other');
    yield* fs.makeDirectory(common);
    yield* fs.makeDirectory(other);
    const head = Effect2.pipe(
      Effect2.pipe(mode, EffectString.startsWith('unborn')) ? '0' : 'a',
      EffectString.repeat(objectFormat === 'sha1' ? 40 : 64),
    );
    const identity = {
      caseMode: 'sensitive',
      checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
      displayName: 'fixture',
      gitCommonDirectory: common,
      headCommit: head,
      objectFormat,
      repoRoot,
      repositoryId: Effect2.pipe('r', EffectString.repeat(64)),
      worktreeId: Effect2.pipe('w', EffectString.repeat(64)),
    } satisfies RepositoryIdentity;
    const before = structuredClone(identity);
    const prefix = '00:00:00.000000 trace.c:1 setup: ';
    const setup = `${prefix}git_common_dir: ${mode === 'common' ? other : common}\n${prefix}worktree: ${mode === 'root' ? other : repoRoot}\n`;
    const observed = CommandExecutor.of({
      ...command,
      execute: (_executable, args) => {
        expect(args).toContain('--no-optional-locks');
        expect(args).toContain('--porcelain=v2');
        const fields = {executable: 'git', args, message: 'Synthetic optional probe failure'};
        if (Effect2.pipe(mode, EffectString.endsWith('limit')))
          return CommandOutputLimitExceeded.make({...fields, maxOutputBytes: 65_536});
        if (mode === 'timeout') return CommandTimedOut.make({...fields, timeoutMs: 10_000});
        if (mode === 'spawn') return CommandSpawnFailed.make({...fields, cause: new Error('synthetic')});
        return Effect.succeed({
          exitCode: 0,
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
          stdout: `# branch.oid ${Effect2.pipe(mode, EffectString.startsWith('unborn')) ? '(initial)' : mode === 'head' ? 'b'.repeat(head.length) : head}\0# branch.head main\0${mode === 'dirty' ? '? changed.ts\0' : ''}`,
          stderr: mode === 'missing' ? '' : mode === 'duplicate' ? setup + setup : setup,
        });
      },
    });
    const observedResult = yield* Effect.gen(function* () {
      const bind = yield* startRepositoryWorktreeObservation(repoRoot);
      return yield* bind(identity).pipe(Effect.result);
    }).pipe(Effect.provideService(CommandExecutor, observed));
    const unavailable = ['unborn', 'unborn-limit', 'limit', 'timeout', 'spawn'].includes(mode);
    if (mode === 'clean' || mode === 'dirty' || unavailable) {
      expect(observedResult._tag).toBe('Success');
      if (observedResult._tag === 'Success')
        expect(observedResult.success).toBe(unavailable ? undefined : mode === 'dirty');
    } else expect(observedResult._tag).toBe('Failure');
    expect(identity).toEqual(before);
  });

describe('scoped repository worktree observation', () => {
  effectIt.layer(citationPlatformLayer)(it => {
    for (const mode of modes) it.effect(`binds or rejects ${mode} observations`, () => scenario(mode, 'sha1'));
    fcEffectProp(
      it,
      'binds only matching HEAD and canonical routing without mutating the identity',
      {
        mode: fc.constantFrom(...modes),
        objectFormat: fc.constantFrom('sha1' as const, 'sha256' as const),
      },
      ({mode, objectFormat}) => scenario(mode, objectFormat),
      {fastCheck: {numRuns: 32}},
    );
  });
});
