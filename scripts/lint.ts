import {Array, Schema, String} from 'effect';
import {ScriptError} from './effect/errors.js';

export const LINT_TARGETS = ['config/lint', 'scripts', 'packages', 'apps', 'tools', 'infra'] as const;

export const STRICT_LINT_ARGUMENTS = [
  '--config',
  '.oxlintrc.strict.json',
  '--threads=1',
  '--deny-warnings',
  '--report-unused-disable-directives-severity=error',
  '--ignore-pattern',
  'apps/threadnote/test/evaluation/fixtures/**/repository/**',
] as const;

const UNSAFE_TYPE_ASSERTION_RULE = 'typescript/no-unsafe-type-assertion';
const TYPE_SCRIPT_SOURCE = /\.(?:cts|mts|ts|tsx)$/u;

export function changedTypeScriptLines(diff: string): ReadonlyMap<string, ReadonlySet<number>> {
  const changed = new Map<string, Set<number>>();
  let path: string | undefined;
  let line = 0;
  for (const diffLine of diff.split('\n')) {
    if (String.startsWith('+++ ')(diffLine)) {
      const header = String.slice(4)(diffLine);
      const filename = String.startsWith('"')(header)
        ? Schema.decodeSync(Schema.fromJsonString(Schema.String))(header)
        : header;
      path = String.startsWith('b/')(filename) ? String.slice(2)(filename) : undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(diffLine);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!path || !TYPE_SCRIPT_SOURCE.test(path) || line === 0) continue;
    if (diffLine.startsWith('+')) {
      const lines = changed.get(path) ?? new Set<number>();
      lines.add(line);
      changed.set(path, lines);
      line += 1;
    } else if (!diffLine.startsWith('-')) {
      line += 1;
    }
  }
  return changed;
}

async function gitOutput(arguments_: readonly string[]): Promise<string | undefined> {
  const child = Bun.spawn({cmd: ['git', ...arguments_], stderr: 'ignore', stdout: 'pipe'});
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return exitCode === 0 ? stdout : undefined;
}

export const INCREMENTAL_LINT_RULES = new Set([
  'effecttsgo(map-map-error-to-map-both)',
  'effecttsgo(prefer-effect-array)',
  'effecttsgo(prefer-effect-record)',
  'effecttsgo(prefer-effect-string)',
  'effecttsgo(prefer-schema-tagged-error)',
  'effecttsgo(schema-class-missing-brand)',
  'typescript(no-unsafe-type-assertion)',
]);

const LintDiagnostic = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  filename: Schema.String,
  message: Schema.String,
  severity: Schema.String,
  labels: Schema.Array(Schema.Struct({span: Schema.Struct({line: Schema.Int, column: Schema.Int})})),
});
type LintDiagnostic = typeof LintDiagnostic.Type;

/** Existing violations of the incremental rules remain visible to editors; added lines must pass. */
export function lintDiagnosticApplies(
  diagnostic: Pick<LintDiagnostic, 'code' | 'filename' | 'labels'>,
  changed: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  return (
    diagnostic.code === undefined ||
    !INCREMENTAL_LINT_RULES.has(diagnostic.code) ||
    changed.get(diagnostic.filename)?.size === 0 ||
    Array.some(diagnostic.labels, label => changed.get(diagnostic.filename)?.has(label.span.line) === true)
  );
}

async function changedSourceLines(): Promise<ReadonlyMap<string, ReadonlySet<number>>> {
  const base = await gitOutput(['merge-base', 'HEAD', `origin/${process.env.GITHUB_BASE_REF ?? 'main'}`]);
  if (!base) throw ScriptError.make({message: 'Cannot resolve the lint base; fetch the target branch before linting.'});
  const [diff, untracked] = await Promise.all([
    gitOutput([
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-ext-diff',
      '--unified=0',
      String.trim(base),
      '--',
      ...LINT_TARGETS,
    ]),
    gitOutput(['ls-files', '-z', '--others', '--exclude-standard', '--', ...LINT_TARGETS]),
  ]);
  if (diff === undefined || untracked === undefined) throw ScriptError.make({message: 'Cannot read the lint diff.'});
  const changed = new Map(changedTypeScriptLines(diff));
  for (const path of String.split(untracked, '\0')) {
    if (!TYPE_SCRIPT_SOURCE.test(path)) continue;
    // A missing map entry denotes an unchanged file; the empty set marks a wholly new file.
    changed.set(path, new Set());
  }
  return changed;
}

async function runOxlint(arguments_: readonly string[]): Promise<number> {
  const changed = await changedSourceLines();
  // Oxlint's native reporter truncates large writes to Bun pipes; a regular file retains the complete report.
  const reportFile = Bun.file(new URL(`../.context/lint-${Bun.randomUUIDv7()}.json`, import.meta.url));
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    await Bun.write(reportFile, '');
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        'node_modules/oxlint/bin/oxlint',
        ...arguments_,
        '-D',
        UNSAFE_TYPE_ASSERTION_RULE,
        '--format',
        'json',
        ...(Array.contains(process.argv, '--fix') ? ['--fix'] : []),
      ],
      stderr: 'pipe',
      stdout: reportFile,
    });
    [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    stdout = await reportFile.text();
  } finally {
    await reportFile.delete();
  }
  if (stderr.length > 0) {
    process.stderr.write(stderr);
    return exitCode || 1;
  }
  const report = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({diagnostics: Schema.Array(LintDiagnostic)})))(
    stdout,
  );
  const diagnostics = Array.filter(report.diagnostics, diagnostic => lintDiagnosticApplies(diagnostic, changed));
  for (const diagnostic of diagnostics) {
    const position = diagnostic.labels[0]?.span;
    process.stderr.write(
      `${diagnostic.filename}:${position?.line ?? 1}:${position?.column ?? 1}: ${diagnostic.message} [${diagnostic.severity}/${diagnostic.code ?? 'unknown'}]\n`,
    );
  }
  return diagnostics.length > 0 ? 1 : exitCode !== 0 && report.diagnostics.length === 0 ? exitCode : 0;
}

/** One full pass; only the six newly adopted rules and unsafe assertions are limited to added lines. */
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
