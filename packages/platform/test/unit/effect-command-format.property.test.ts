import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {formatCommandDisplay, formatShellCommand} from '@threadnote/platform/command';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const windowsPathSegment = fc
  .array(fc.constantFrom('a', 'B', '3', ' ', '_', '-'), {maxLength: 20, minLength: 1})
  .map(characters => Effect.pipe(EffectArray.join(characters, ''), EffectString.trim) || 'repo');

const windowsPath = fc
  .tuple(fc.constantFrom('C', 'D', 'E'), fc.array(windowsPathSegment, {maxLength: 5, minLength: 2}))
  .map(([drive, segments]) => `${drive}:\\${EffectArray.join(segments, '\\')}`);

describe.each([
  {name: 'runnable shell', format: formatShellCommand, configArgument: 'core.symlinks=false'},
  {name: 'diagnostic display', format: formatCommandDisplay, configArgument: "'core.symlinks=false'"},
])('$name git command formatting', ({format, configArgument}) => {
  it('uses role-specific placeholders for Windows share paths, including paths with spaces', () => {
    const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
    const repository = 'C:\\Users\\alice\\Customer Repo';
    const worktree = 'C:\\Users\\alice\\.threadnote\\share\\worktrees\\team';
    const gitdir = 'C:\\Users\\alice\\.threadnote\\share\\gitdirs\\team.git';

    expect(format(git, ['-C', worktree, 'status', '--short', '--branch'])).toBe(
      "'<git>' -C '<worktree>' status --short --branch",
    );
    expect(
      format(git, [
        'clone',
        '-c',
        'core.symlinks=false',
        `--separate-git-dir=${gitdir}`,
        '--',
        'https://example.com/team.git',
        worktree,
      ]),
    ).toBe(
      `'<git>' clone -c ${configArgument} '--separate-git-dir=<gitdir>' -- https://example.com/team.git '<worktree>'`,
    );
    expect(format(git, ['clone', '--', repository])).toBe("'<git>' clone -- '<repository>'");
    expect(format(git, ['clone', '--', repository, worktree])).toBe("'<git>' clone -- '<repository>' '<worktree>'");
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
          expect(format(git, [option, path, 'status'])).toBe(`'<git>' ${option} '<${role}>' status`);
        }
        for (const {option, role} of attachedOptions) {
          expect(format(git, [`${option}=${path}`, 'status'])).toBe(`'<git>' '${option}=<${role}>' status`);
        }
      }),
      {numRuns: 100},
    );
  });

  it('preserves clone operand roles without leaking generated Windows paths', () => {
    fc.assert(
      fc.property(windowsPath, windowsPath, windowsPath, (gitRoot, repository, worktree) => {
        const git = `${gitRoot}\\git.exe`;
        const sourceOnly = format(git, ['clone', '--', repository]);
        const sourceAndDestination = format(git, ['clone', '--', repository, worktree]);

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
    expect(format('git', ['show', '--', '--git-dir=C:\\Users\\alice\\repo'])).toBe(
      "git show -- '--git-dir=<local-path>'",
    );
    expect(format('git', ['show', 'clone', '--', 'C:\\Users\\alice\\repo'])).toBe("git show clone -- '<local-path>'");
  });
});

describe('diagnostic command display', () => {
  it('escapes terminal controls while runnable commands retain literal arguments', () => {
    expect(formatCommandDisplay('tool', ["a'b", 'line\nnext', '\u001b[31m', '\u2028'])).toBe(
      "tool 'a'\\''b' 'line\\nnext' '\\u001b[31m' '\\u2028'",
    );
    expect(formatShellCommand('tool', ['line\nnext'])).toBe("tool 'line\nnext'");
    expect(formatShellCommand('codex', ['mcp', 'login', 'threadnote-org', '--scopes', 'openid,offline_access'])).toBe(
      "codex mcp login threadnote-org --scopes 'openid,offline_access'",
    );
  });

  it('scrubs generated credentials and paths before quoting without mutating argv', () => {
    const suffix = fc
      .array(fc.constantFrom('a', 'B', '3', '_'), {minLength: 20, maxLength: 40})
      .map(parts => EffectArray.join(parts, ''));
    const argument = fc
      .array(fc.constantFrom('a', ' ', "'", '"', ';', '$', '\\', '\t', '\n', '\r', '\u001b', '\u2028'), {maxLength: 40})
      .map(parts => EffectArray.join(parts, ''));
    fc.assert(
      fc.property(suffix, windowsPath, argument, (secret, path, value) => {
        const token = `ghp_${secret}`;
        const password = `credential_${secret}`;
        const args = Object.freeze([`--token=${token}`, `https://synthetic:${password}@example.com/repo`, path, value]);
        const before = [...args];
        const display = formatCommandDisplay('tool', args);
        expect(display).not.toContain(token);
        expect(display).not.toContain(password);
        expect(display).not.toContain(path);
        // oxlint-disable-next-line no-control-regex -- Diagnostics must not contain terminal controls or Unicode line separators.
        expect(display).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
        expect(args).toEqual(before);
        expect(formatCommandDisplay('tool', args)).toBe(display);
      }),
      {numRuns: 100},
    );
  });
});

describe('split credential arguments in diagnostics', () => {
  it.each(['--token=', 'password='])('redacts a value following %s', key => {
    expect(formatCommandDisplay('tool', [key, 'synthetic-value'])).not.toContain('synthetic-value');
  });

  it('redacts generated values whose credential assignment spans argv without mutating it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('--token=', 'password=', 'Authorization:', '--api-key='),
        fc.array(fc.constantFrom('a', 'B', '3', ' ', "'", '"', ';', '$', '\\', '\n'), {maxLength: 30}),
        (key, suffix) => {
          const secret = `synthetic_${EffectArray.join(suffix, '')}`;
          const args = Object.freeze([key, secret]);
          expect(formatCommandDisplay('tool', args)).not.toContain(secret);
          expect(args).toEqual([key, secret]);
        },
      ),
      {numRuns: 100},
    );
  });
});
