import {execFile} from '@threadnote/testing/node-child-process';
import {Predicate} from 'effect';
import {promisify} from '@threadnote/testing/node-util';
import {describe, expect, it} from 'vitest';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const execFilePromise = promisify(execFile);

describe('Code Memory Link evidence runner entrypoints', () => {
  it.each([
    ['scripts/describe-code-memory-link-client.ts', [], '--client-command requires a value'],
    ['scripts/run-code-memory-link-calibration-client.ts', [], '--candidate-commit requires a value'],
    ['scripts/run-code-memory-link-agent-trial.ts', [], '--assignment requires a value'],
    [
      'scripts/run-code-memory-link-agent-trial.ts',
      ['--assignment', 'fixture.json', '--approval-commit', Effect.pipe('a', EffectString.repeat(40))],
      '--attempts requires a value',
    ],
    ['scripts/run-code-memory-link-dogfood.ts', [], '--approval-commit requires a value'],
    ['scripts/retain-code-memory-link-evidence.ts', [], '--candidate-commit requires a value'],
    ['scripts/verify-code-memory-link-release.ts', [], '--release-descriptor'],
  ])('loads %s before rejecting missing arguments', async (script, args, expected) => {
    const failure = await execFilePromise(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: {...process.env, NO_COLOR: '1'},
      timeout: 30_000,
    }).catch(cause => {
      if (!Predicate.isObject(cause)) return {};
      return {
        stderr: Predicate.hasProperty(cause, 'stderr') && typeof cause.stderr === 'string' ? cause.stderr : undefined,
        stdout: Predicate.hasProperty(cause, 'stdout') && typeof cause.stdout === 'string' ? cause.stdout : undefined,
      };
    });
    const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;

    expect(output).toContain(expected);
    expect(output).not.toContain('SyntaxError');
    expect(output).not.toContain('Export named');
  });
});
