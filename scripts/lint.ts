import {Array} from 'effect';
import {ScriptError} from './effect/errors.js';

export const LINT_TARGETS = ['config/lint', 'scripts', 'packages', 'apps', 'tools', 'infra'] as const;

export const STRICT_LINT_ARGUMENTS = [
  '--config',
  '.oxlintrc.strict.json',
  '--threads=1',
  '--deny-warnings',
  '--report-unused-disable-directives-severity=error',
  '-D',
  'typescript/no-unsafe-type-assertion',
  '--ignore-pattern',
  'apps/threadnote/test/evaluation/fixtures/**/repository/**',
] as const;

function runOxlint(arguments_: readonly string[]): Promise<number> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'node_modules/oxlint/bin/oxlint',
      ...arguments_,
      ...(Array.contains(process.argv, '--fix') ? ['--fix'] : []),
    ],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return child.exited;
}

/** Every configured rule applies to every file in the repository lint targets. */
export async function lint(
  execute: (arguments_: readonly string[]) => number | Promise<number> = runOxlint,
): Promise<number> {
  return execute([...STRICT_LINT_ARGUMENTS, ...LINT_TARGETS]);
}

if (import.meta.main) {
  try {
    process.exitCode = await lint();
  } catch (cause) {
    throw ScriptError.make({message: 'Could not run the repository lint policy.', cause});
  }
}
