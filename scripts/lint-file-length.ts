import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, scriptError, ScriptError} from './effect/errors.js';
import {BunRuntime} from '@effect/platform-bun';
import {Console, Effect, Result} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';

export const PRODUCTION_FILE_LINE_LIMIT = 2_000;
export const PRODUCTION_CODE_ROOTS = ['packages', 'apps/website/src', 'apps/threadnote/src'] as const;
export const FILE_LENGTH_OXLINT_CONFIG = Bun.fileURLToPath(new URL('../.oxlintrc.max-lines.json', import.meta.url));

const CODE_FILE_PATTERN = /\.(?:c|m)?(?:js|jsx|ts|tsx)$/u;
const TEST_FILE_PATTERN = /\.(?:spec|test)\.(?:c|m)?(?:js|jsx|ts|tsx)$/u;
const TEST_DIRECTORY_NAMES = new Set(['__tests__', 'test', 'tests']);

export interface OxlintFileLengthRequest {
  readonly configPath: string;
  readonly files: readonly string[];
  readonly repositoryRoot: string;
}

export interface RunProductionFileLengthLintOptions {
  readonly execute?: (request: OxlintFileLengthRequest) => number;
  readonly repositoryRoot: string;
  readonly roots?: readonly string[];
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeRepositoryPath(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return normalized;
}

function normalizedProductionRoots(roots: readonly string[]): readonly string[] {
  const normalized = roots.map(root => normalizeRepositoryPath(root));
  if (normalized.some(root => root === undefined)) {
    throw ScriptError.make({message: 'Production lint roots must be repository paths.'});
  }
  const validRoots = normalized as string[];
  for (const root of validRoots) {
    if (!(PRODUCTION_CODE_ROOTS as readonly string[]).includes(root)) {
      throw ScriptError.make({message: `Unsupported production lint root: ${root}`});
    }
  }
  return [...new Set(validRoots)].sort(comparePaths);
}

export function isProductionCodePath(path: string, roots: readonly string[] = PRODUCTION_CODE_ROOTS): boolean {
  const normalized = normalizeRepositoryPath(path);
  if (!normalized || !CODE_FILE_PATTERN.test(normalized) || TEST_FILE_PATTERN.test(normalized)) return false;
  if (normalized.split('/').some(segment => TEST_DIRECTORY_NAMES.has(segment))) return false;
  return roots.some(root => normalized === root || normalized.startsWith(`${root}/`));
}

/** Return every unique production source path, independent of Git change state or iteration order. */
export function productionCodeFiles(
  files: Iterable<string>,
  roots: readonly string[] = PRODUCTION_CODE_ROOTS,
): readonly string[] {
  const productionFiles = new Set<string>();
  for (const file of files) {
    const normalized = normalizeRepositoryPath(file);
    if (normalized && isProductionCodePath(normalized, roots)) productionFiles.add(normalized);
  }
  return [...productionFiles].sort(comparePaths);
}

function decodeNullSeparated(output: Uint8Array | undefined): readonly string[] {
  return output ? new TextDecoder().decode(output).split('\0').filter(Boolean) : [];
}

function gitPaths(repositoryRoot: string, arguments_: readonly string[]): readonly string[] {
  const result = Bun.spawnSync({
    cmd: ['git', ...arguments_],
    cwd: repositoryRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr ? new TextDecoder().decode(result.stderr).trim() : '';
    throw ScriptError.make({message: `git ${arguments_.join(' ')} failed${detail ? `: ${detail}` : '.'}`});
  }
  return decodeNullSeparated(result.stdout);
}

export function collectProductionCodeFiles(
  repositoryRoot: string,
  roots: readonly string[] = PRODUCTION_CODE_ROOTS,
): readonly string[] {
  const normalizedRoots = normalizedProductionRoots(roots);
  const pathspec = ['--', ...normalizedRoots];
  const deletedFiles = new Set(gitPaths(repositoryRoot, ['ls-files', '--deleted', '-z', ...pathspec]));
  const files = gitPaths(repositoryRoot, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    ...pathspec,
  ]).filter(path => !deletedFiles.has(path));
  return productionCodeFiles(files, normalizedRoots);
}

function executeOxlint(request: OxlintFileLengthRequest): number {
  if (request.files.length === 0) return 0;
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      '--bun',
      'oxlint',
      `--config=${request.configPath}`,
      '--disable-nested-config',
      '--disable-unicorn-plugin',
      '--disable-oxc-plugin',
      '--disable-typescript-plugin',
      '--no-error-on-unmatched-pattern',
      '--threads=1',
      '--deny-warnings',
      // The full lint pass checks directives against their enabled rules.
      ...request.files,
    ],
    cwd: request.repositoryRoot,
    stderr: 'inherit',
    stdout: 'inherit',
  });
  return result.exitCode;
}

export function runProductionFileLengthLint(options: RunProductionFileLengthLintOptions): number {
  const files = collectProductionCodeFiles(options.repositoryRoot, options.roots);
  return (options.execute ?? executeOxlint)({
    configPath: FILE_LENGTH_OXLINT_CONFIG,
    files,
    repositoryRoot: options.repositoryRoot,
  });
}

function parseArguments(arguments_: readonly string[]): readonly string[] {
  if (arguments_.some(argument => argument.startsWith('-'))) {
    throw ScriptError.make({message: 'Production file lint accepts only optional production roots.'});
  }
  return normalizedProductionRoots(arguments_.length === 0 ? PRODUCTION_CODE_ROOTS : arguments_);
}

if (import.meta.main) {
  BunRuntime.runMain(
    provideScriptLayer(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        const outcome = yield* Effect.try({
          try: () =>
            runProductionFileLengthLint({
              repositoryRoot: Bun.fileURLToPath(new URL('..', import.meta.url)),
              roots: parseArguments(Bun.argv.slice(2)),
            }),
          catch: cause => scriptError(cause, 'Could not evaluate the production file-length policy.'),
        }).pipe(Effect.result);
        if (Result.isFailure(outcome)) {
          yield* Console.error(`Production file length lint failed: ${outcome.failure.message}`);
          system.setExitCode(2);
          return;
        }
        system.setExitCode(outcome.success);
      }),
      ScriptSystemInfoLayer,
    ),
  );
}
