import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {formatShellCommand} from '@threadnote/platform/command';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const windowsPathSegment = fc
  .array(fc.constantFrom('a', 'B', '3', ' ', '_', '-'), {maxLength: 20, minLength: 1})
  .map(characters => Effect.pipe(EffectArray.join(characters, ''), EffectString.trim) || 'repo');

const windowsPath = fc
  .tuple(fc.constantFrom('C', 'D', 'E'), fc.array(windowsPathSegment, {maxLength: 5, minLength: 2}))
  .map(([drive, segments]) => `${drive}:\\${EffectArray.join(segments, '\\')}`);

describe('git command formatting', () => {
  it('uses role-specific placeholders for Windows share paths, including paths with spaces', () => {
    const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
    const repository = 'C:\\Users\\alice\\Customer Repo';
    const worktree = 'C:\\Users\\alice\\.threadnote\\share\\worktrees\\team';
    const gitdir = 'C:\\Users\\alice\\.threadnote\\share\\gitdirs\\team.git';

    expect(formatShellCommand(git, ['-C', worktree, 'status', '--short', '--branch'])).toBe(
      "'<git>' -C '<worktree>' status --short --branch",
    );
    expect(
      formatShellCommand(git, [
        'clone',
        '-c',
        'core.symlinks=false',
        `--separate-git-dir=${gitdir}`,
        '--',
        'https://example.com/team.git',
        worktree,
      ]),
    ).toBe(
      "'<git>' clone -c core.symlinks=false '--separate-git-dir=<gitdir>' -- https://example.com/team.git '<worktree>'",
    );
    expect(formatShellCommand(git, ['clone', '--', repository])).toBe("'<git>' clone -- '<repository>'");
    expect(formatShellCommand(git, ['clone', '--', repository, worktree])).toBe(
      "'<git>' clone -- '<repository>' '<worktree>'",
    );
  });

  it('formats every recognized git path option without leaking its Windows path', () => {
    const separatedOptions = [
      {option: '-C', role: 'worktree'},
      {option: '--git-dir', role: 'gitdir'},
      {option: '--separate-git-dir', role: 'gitdir'},
      {option: '--work-tree', role: 'worktree'},
    ] as const;
    const attachedOptions = EffectArray.filter(separatedOptions, ({option}) =>
      Effect.pipe(option, EffectString.startsWith('--')),
    );

    fc.assert(
      fc.property(windowsPath, windowsPath, (gitRoot, path) => {
        const git = `${gitRoot}\\git.exe`;
        for (const {option, role} of separatedOptions) {
          expect(formatShellCommand(git, [option, path, 'status'])).toBe(`'<git>' ${option} '<${role}>' status`);
        }
        for (const {option, role} of attachedOptions) {
          expect(formatShellCommand(git, [`${option}=${path}`, 'status'])).toBe(`'<git>' '${option}=<${role}>' status`);
        }
      }),
      {numRuns: 100},
    );
  });

  it('preserves clone operand roles without leaking generated Windows paths', () => {
    fc.assert(
      fc.property(windowsPath, windowsPath, windowsPath, (gitRoot, repository, worktree) => {
        const git = `${gitRoot}\\git.exe`;
        const sourceOnly = formatShellCommand(git, ['clone', '--', repository]);
        const sourceAndDestination = formatShellCommand(git, ['clone', '--', repository, worktree]);

        expect(sourceOnly).toBe("'<git>' clone -- '<repository>'");
        expect(sourceAndDestination).toBe("'<git>' clone -- '<repository>' '<worktree>'");
        for (const path of [git, repository, worktree]) {
          expect(sourceOnly).not.toContain(path);
          expect(sourceAndDestination).not.toContain(path);
        }
        expect(sourceOnly).not.toContain('<local-path>');
        expect(sourceAndDestination).not.toContain('<local-path>');
      }),
      {numRuns: 100},
    );
  });

  it('does not assign option roles to operands after the separator', () => {
    expect(formatShellCommand('git', ['show', '--', '--git-dir=C:\\Users\\alice\\repo'])).toBe(
      "git show -- '--git-dir=<local-path>'",
    );
    expect(formatShellCommand('git', ['show', 'clone', '--', 'C:\\Users\\alice\\repo'])).toBe(
      "git show clone -- '<local-path>'",
    );
  });
});
