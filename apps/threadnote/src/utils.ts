import {Array as EffectArray} from 'effect';
export {
  InvalidRecallScoreThreshold,
  recallScoreThreshold,
  recallScoreThresholdPolicy,
  validatedRecallScoreThreshold,
} from '@threadnote/recall/threshold';
export type {RecallScoreThresholdPolicy} from '@threadnote/recall/threshold';
import {getInvocationCwd} from '@threadnote/platform/paths';
export {expandPath, getInvocationCwd} from '@threadnote/platform/paths';
export {toolRoot} from '@threadnote/workspace/installation';
import * as BunSocket from '@effect/platform-bun/BunSocket';
import {Console, Effect, FileSystem, Option, Path, Stdio, Stream} from 'effect';
import {failure, success, warning} from './cli_ui.js';
import {runCommandEffect, runStreamingCommandEffect, type CommandOptions} from '@threadnote/platform/command';
import {maybeRunEffect} from './effect/command-presentation.js';
import {getStatusEffect, getTextEffect} from '@threadnote/platform/http';
import {sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';

import {redactSensitiveText} from '@threadnote/platform/scrubber';

import {parseResourceId} from '@threadnote/store/resource-id';
import {isThreadnoteStorageLayoutReceipt} from '@threadnote/store/layout';
import type {CommandStatus} from './types.js';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {compareVersions} from './release/version/compare.js';
import {findWorkspaceComponentManifest} from './workspace_component.js';

import {UtilityOperationError} from '@threadnote/platform/errors';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export {formatShellCommand, shellQuote, withoutGitEnvironment} from '@threadnote/platform/command';
export {compareVersions} from './release/version/compare.js';

export {isJsonObject, parseJsonConfigObject} from '@threadnote/platform/json';

const parseUrlPath = Option.liftThrowable((content: string): string => new URL(content).pathname);

export function redactText(content: string): string {
  return redactSensitiveText(content);
}

export const walkFiles = Effect.fn('utils.walkFiles')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const files: string[] = [];
  const visit = (currentPath: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const pathStat = yield* fs.stat(currentPath).pipe(Effect.option);
      if (pathStat._tag === 'None' || pathStat.value.type === 'SymbolicLink') {
        return;
      }
      if (pathStat.value.type === 'File') {
        files.push(currentPath);
        return;
      }
      if (pathStat.value.type !== 'Directory') {
        return;
      }
      const entries = yield* fs.readDirectory(currentPath);
      for (const entry of entries) {
        yield* visit(pathService.join(currentPath, entry));
      }
    });
  yield* visit(root);
  return files;
});

export {escapeRegExp, getGlobBase, globToRegExp, hasGlob} from '@threadnote/platform/glob';

export const requiredExecutable = Effect.fn('utils.requiredExecutable')(function* (command: string) {
  const executable = yield* findExecutable([command]);
  if (!executable) {
    return yield* UtilityOperationError.make({message: `${command} was not found in PATH.`});
  }
  return executable;
});

export const findExecutable = Effect.fn('utils.findExecutable')(function* (commands: readonly string[]) {
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  for (const command of commands) {
    for (const candidate of executablePathCandidatesForCommand(command, pathService, system)) {
      if (yield* isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
});

export const findWorkingExecutable = Effect.fn('utils.findWorkingExecutable')(function* (
  commands: readonly string[],
  args: readonly string[] = ['--version'],
) {
  for (const executable of yield* findExecutableCandidates(commands)) {
    const result = yield* runCommandEffect(executable, args, {allowFailure: true, timeoutMs: 5000});
    if (result.exitCode === 0) {
      return executable;
    }
  }
  return undefined;
});

export const findExecutableCandidates = Effect.fn('utils.findExecutableCandidates')(function* (
  commands: readonly string[],
) {
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    for (const candidate of executablePathCandidatesForCommand(command, pathService, system)) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (yield* isExecutable(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
});

function executablePathCandidatesForCommand(
  command: string,
  pathService: Path.Path,
  system: SystemInfoShape,
): readonly string[] {
  return pathService.isAbsolute(command) ||
    Effect2.pipe(command, EffectString.includes('/')) ||
    Effect2.pipe(command, EffectString.includes('\\'))
    ? executableNames(command, system.platform, system.environment().PATHEXT)
    : executablePathCandidates(command, pathService, system);
}

function executablePathCandidates(command: string, pathService: Path.Path, system: SystemInfoShape): readonly string[] {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
  const pathDirectories = (system.environment().PATH ?? '').split(system.pathDelimiter);
  const names = executableNames(command, system.platform, system.environment().PATHEXT);
  return EffectArray.flatMap(pathDirectories, directory =>
    EffectArray.map(names, name => pathService.join(directory || '.', name)),
  );
}

export function executableNames(
  command: string,
  currentPlatform: NodeJS.Platform,
  pathExt = '.COM;.EXE;.BAT;.CMD',
): readonly string[] {
  if (currentPlatform !== 'win32') {
    return [command];
  }
  const extensions = EffectArray.filter(
    EffectArray.map(Effect2.pipe(pathExt, EffectString.split(';')), extension =>
      Effect2.pipe(extension, EffectString.trim),
    ),
    Boolean,
  );
  const lowerCommand = Effect2.pipe(command, EffectString.toLowerCase);
  if (
    EffectArray.some(extensions, extension =>
      Effect2.pipe(lowerCommand, EffectString.endsWith(Effect2.pipe(extension, EffectString.toLowerCase))),
    )
  ) {
    return [command];
  }
  return [...EffectArray.map(extensions, extension => `${command}${extension}`), command];
}

export const maybeRun = Effect.fn('utils.maybeRun')(function* (
  dryRun: boolean,
  executable: string,
  args: readonly string[],
  options: {readonly allowFailure?: boolean; readonly cwd?: string; readonly env?: NodeJS.ProcessEnv} = {},
) {
  return yield* maybeRunEffect(dryRun, executable, args, options);
});

export const runCommand = Effect.fn('utils.runCommand')(function* (
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
) {
  return yield* runCommandEffect(executable, args, options);
});

/**
 * Upper bound (ms) for an `ov reindex --wait true` call. `ov reindex` has no
 * `--timeout` flag, so without a client-side bound a stuck or poisoned semantic
 * queue makes the wait block until the 10-minute default command timeout — the
 * AGFS memory-reindex hang (a `context_type=memory` queue entry pointed at a
 * memory *file* fails on `ls`, re-enqueues forever, and starves the queue). A
 * healthy memory reindex finishes well under this bound; if it doesn't, the
 * queue is stuck and we bail rather than hang (the write already succeeded).
 * Override with THREADNOTE_REINDEX_TIMEOUT_MS.
 */
export const reindexWaitTimeoutMs = Effect.fn('utils.reindexWaitTimeoutMs')(function* () {
  const environment = (yield* SystemInfo).environment();
  return positiveIntegerFromEnv(environment, 'THREADNOTE_REINDEX_TIMEOUT_MS') ?? 120_000;
});

function positiveIntegerFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const value = environment[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export const gitValue = Effect.fn('utils.gitValue')(function* (args: readonly string[], cwd?: string) {
  const result = yield* runCommandEffect('git', args, {
    allowFailure: true,
    cwd: cwd ?? (yield* getInvocationCwd()),
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  return Effect2.pipe(result.stdout, EffectString.trim);
});

/**
 * Resolves the canonical repository name for `cwd`, returning undefined when it
 * is not inside a git repository.
 *
 * Prefer the git remote repository name so differently named clones of the same
 * repo resolve to the same project. From repos without remotes, fall back to the
 * primary worktree name: linked worktree paths (`git worktree add`, Conductor
 * workspaces, …) often use the branch/workspace name instead of the project.
 */
export const resolveRepoName = Effect.fn('utils.resolveRepoName')(function* (cwd?: string) {
  const resolvedCwd = cwd ?? (yield* getInvocationCwd());
  const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel'], resolvedCwd);
  if (!repoRoot) {
    return undefined;
  }
  const remoteName = yield* resolveGitRemoteRepoName(repoRoot);
  if (remoteName) {
    return remoteName;
  }
  return yield* resolveRepoFolderName(repoRoot);
});

export const resolveRepoFolderName = Effect.fn('utils.resolveRepoFolderName')(function* (cwd?: string) {
  const pathService = yield* Path.Path;
  const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel'], cwd ?? (yield* getInvocationCwd()));
  if (!repoRoot) {
    return undefined;
  }
  const commonDir = yield* gitValue(['rev-parse', '--git-common-dir'], repoRoot);
  if (commonDir) {
    const absoluteCommonDir = pathService.isAbsolute(commonDir) ? commonDir : pathService.resolve(repoRoot, commonDir);
    const primaryRoot =
      pathService.basename(absoluteCommonDir) === '.git' ? pathService.dirname(absoluteCommonDir) : absoluteCommonDir;
    const name = Effect2.pipe(pathService.basename(primaryRoot), EffectString.replace(/\.git$/, ''));
    if (name && name !== '.') {
      return name;
    }
  }
  return pathService.basename(repoRoot);
});

export const resolveGitRemoteRepoName = Effect.fn('utils.resolveGitRemoteRepoName')(function* (repoRoot: string) {
  const originUrl = yield* gitValue(['remote', 'get-url', 'origin'], repoRoot);
  const originName = originUrl ? gitRemoteRepoName(originUrl) : undefined;
  if (originName) {
    return originName;
  }
  const remotes = yield* gitValue(['remote'], repoRoot);
  const remote = Option.getOrUndefined(
    Option.map(
      Option.fromNullishOr(
        Option.getOrUndefined(
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional chaining through line splitting and filtering.
          Option.map(Option.fromNullishOr(remotes?.split(/\r?\n/)), __effectArrayReceiver =>
            // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional chaining through line splitting and filtering.
            EffectArray.map(__effectArrayReceiver, name => name.trim()),
          ),
        ),
      ),
      __effectArrayReceiver2 =>
        Option.getOrUndefined(EffectArray.findFirst(__effectArrayReceiver2, name => name.length > 0)),
    ),
  );
  if (!remote) {
    return undefined;
  }
  const remoteUrl = yield* gitValue(['remote', 'get-url', remote], repoRoot);
  return remoteUrl ? gitRemoteRepoName(remoteUrl) : undefined;
});

function gitRemoteRepoName(remoteUrl: string): string | undefined {
  const trimmed = Effect2.pipe(remoteUrl, EffectString.trim);
  if (!trimmed) {
    return undefined;
  }
  const parsedUrlPath = parseUrlPath(trimmed);
  let remotePath = Option.getOrUndefined(parsedUrlPath) ?? Effect2.pipe(trimmed, EffectString.replace(/[?#].*$/, ''));
  if (Option.isNone(parsedUrlPath)) {
    const scpLike = Effect2.pipe(
      trimmed,
      EffectString.match(/^[^@\s/]+@[^:\s]+:(.+)$/),
      Effect2.Option.getOrElse(() => null),
    );
    if (scpLike?.[1]) {
      remotePath = scpLike[1];
    }
  }
  const name = Effect2.pipe(
    EffectArray.filter(
      Effect2.pipe(remotePath, EffectString.replace(/[\\/]+$/, ''), EffectString.split(/[\\/:]/)),
      Boolean,
    ).pop(),
    effectOptionalString =>
      effectOptionalString == null
        ? undefined
        : Effect2.pipe(effectOptionalString, EffectString.replace(/\.git$/i, '')),
  );
  return name && name !== '.' && name !== '..' ? name : undefined;
}

export const runInteractive = Effect.fn('utils.runInteractive')(function* (
  executable: string,
  args: readonly string[],
  options: {readonly env?: NodeJS.ProcessEnv} = {},
) {
  return (yield* runStreamingCommandEffect(executable, args, options)).exitCode;
});

export const httpGetText = Effect.fn('utils.httpGetText')(function* (url: string, timeoutMs: number) {
  return (yield* getTextEffect(url, {timeoutMs})).body;
});

export const sleep = (ms: number) => Effect.sleep(ms);

/**
 * Returns a reconnect notice when a newer threadnote is installed on disk than
 * the version a long-lived process started from — undefined when they match,
 * the disk is older, or either version is unknown. Used by the MCP server to
 * tell callers their resident stdio server is running stale code.
 */
export function formatStaleVersionNotice(
  runningVersion: string | undefined,
  diskVersion: string | undefined,
): string | undefined {
  if (runningVersion === undefined || diskVersion === undefined) {
    return undefined;
  }
  if (compareVersions(diskVersion, runningVersion) <= 0) {
    return undefined;
  }
  return (
    `threadnote ${diskVersion} is installed but this MCP server is still running ${runningVersion}. ` +
    'Reconnect the threadnote MCP server (e.g. /mcp) to load the update.'
  );
}

export const readHttpStatus = Effect.fn('utils.readHttpStatus')((url: string, timeoutMs: number) =>
  getStatusEffect(url, {timeoutMs}).pipe(Effect.orElseSucceed(() => undefined)),
);

export const isTcpPortOpen = Effect.fn('utils.isTcpPortOpen')((host: string, port: number, timeoutMs: number) =>
  Effect.scoped(
    BunSocket.makeNet({host, port}).pipe(
      Effect.flatMap(socket => socket.reader),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
      Effect.timeoutOrElse({duration: timeoutMs, orElse: () => Effect.succeed(false)}),
    ),
  ),
);

export const getInputText = Effect.fn('utils.getInputText')(function* (
  optionText: string | undefined,
  useStdin: boolean,
) {
  if (optionText !== undefined) {
    return optionText;
  }
  if (!useStdin) {
    return '';
  }
  const stdio = yield* Stdio.Stdio;
  return yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.runFold(
      () => '',
      (output, chunk) => `${output}${chunk}`,
    ),
  );
});

export const ensureDirectory = Effect.fn('utils.ensureDirectory')(function* (path: string, dryRun: boolean) {
  if (dryRun) {
    yield* Console.log(`Would create directory: ${path}`);
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(path, {recursive: true});
});

export const exists = Effect.fn('utils.exists')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(path);
});

export const isExecutable = Effect.fn('utils.isExecutable')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const info = yield* fs.stat(path).pipe(Effect.option);
  return (
    info._tag === 'Some' &&
    info.value.type === 'File' &&
    (system.platform === 'win32' || (info.value.mode & 0o111) !== 0)
  );
});

export function suggestedShellRc(shellPath: string | undefined, currentPlatform: NodeJS.Platform): string {
  const shell = shellPath ?? '';
  if (Effect2.pipe(shell, EffectString.endsWith('/zsh'))) {
    return '~/.zshrc';
  }
  if (Effect2.pipe(shell, EffectString.endsWith('/bash'))) {
    return currentPlatform === 'darwin' ? '~/.bash_profile' : '~/.bashrc';
  }
  if (Effect2.pipe(shell, EffectString.endsWith('/fish'))) {
    return '~/.config/fish/config.fish';
  }
  return 'your shell rc';
}

export const isFile = Effect.fn('utils.isFile')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  return info._tag === 'Some' && info.value.type === 'File';
});

export const isDirectory = Effect.fn('utils.isDirectory')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  return info._tag === 'Some' && info.value.type === 'Directory';
});

export const readFileIfExists = Effect.fn('utils.readFileIfExists')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(Effect.option, Effect.map(Option.getOrUndefined));
});

export const removePathIfExists = Effect.fn('utils.removePathIfExists')(function* (
  path: string,
  label: string,
  dryRun: boolean,
) {
  if (!(yield* exists(path))) {
    yield* Console.log(`Already absent: ${path}`);
    return;
  }
  yield* removePath(path, label, dryRun);
});

export const removePath = Effect.fn('utils.removePath')(function* (path: string, label: string, dryRun: boolean) {
  if (dryRun) {
    yield* Console.log(`Would remove ${label}: ${path}`);
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(path, {force: true, recursive: true});
  yield* Console.log(`Removed ${label}: ${path}`);
});

export function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw UtilityOperationError.make({message: `Invalid port: ${value}`});
  }
  return parsed;
}

export function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw UtilityOperationError.make({message: `Invalid ${label}: ${value}`});
  }
  return parsed;
}

export function assertResourceUri(uri: string): void {
  parseResourceId(uri);
}

export function collectOption(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

export const assertSafeThreadnoteHomeForErase = Effect.fn('utils.assertSafeThreadnoteHomeForErase')(function* (
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  const resolvedPath = pathService.resolve(home);
  const resolvedUserHome = pathService.resolve(system.homeDirectory);
  const comparable = (value: string) =>
    system.platform === 'win32' ? Effect2.pipe(value, EffectString.toLowerCase) : value;
  if (
    comparable(resolvedPath) === comparable(pathService.parse(resolvedPath).root) ||
    comparable(resolvedPath) === comparable(resolvedUserHome) ||
    comparable(resolvedPath) === comparable(pathService.dirname(resolvedUserHome))
  ) {
    return yield* UtilityOperationError.make({message: `Refusing to erase unsafe THREADNOTE_HOME: ${resolvedPath}`});
  }
  if ((yield* fs.readLink(resolvedPath).pipe(Effect.option))._tag === 'Some') {
    return yield* UtilityOperationError.make({
      message: `Refusing to erase symbolic-link THREADNOTE_HOME: ${resolvedPath}`,
    });
  }
  const homeInfo = yield* fs.stat(resolvedPath).pipe(Effect.option);
  if (Option.isNone(homeInfo) || homeInfo.value.type !== 'Directory') {
    return yield* UtilityOperationError.make({
      message: `Refusing to erase invalid THREADNOTE_HOME directory: ${resolvedPath}`,
    });
  }
  const receiptPath = pathService.join(resolvedPath, 'layout.json');
  if ((yield* fs.readLink(receiptPath).pipe(Effect.option))._tag === 'Some') {
    return yield* UtilityOperationError.make({
      message: `Refusing to trust symbolic-link Threadnote layout receipt: ${receiptPath}`,
    });
  }
  const receiptInfo = yield* fs.stat(receiptPath).pipe(Effect.option);
  if (Option.isNone(receiptInfo) || receiptInfo.value.type !== 'File') {
    return yield* UtilityOperationError.make({
      message: `Refusing to erase unowned THREADNOTE_HOME without a valid layout receipt: ${resolvedPath}`,
    });
  }
  const receipt = yield* fs.readFileString(receiptPath).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: () =>
          UtilityOperationError.make({
            message: `Refusing to erase THREADNOTE_HOME with an invalid layout receipt: ${resolvedPath}`,
          }),
      }),
    ),
  );
  if (!isThreadnoteStorageLayoutReceipt(receipt)) {
    return yield* UtilityOperationError.make({
      message: `Refusing to erase THREADNOTE_HOME with an invalid or unsupported layout receipt: ${resolvedPath}`,
    });
  }
  return resolvedPath;
});

export const portablePath = Effect.fn('utils.portablePath')(function* (path: string) {
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  const home = system.homeDirectory;
  const resolvedPath = pathService.resolve(path);
  if (resolvedPath === home) {
    return '~';
  }
  if (Effect2.pipe(resolvedPath, EffectString.startsWith(`${home}${pathService.sep}`))) {
    return `~/${EffectArray.join(Effect2.pipe(resolvedPath, EffectString.slice(home.length + 1), EffectString.split(pathService.sep)), '/')}`;
  }
  return resolvedPath;
});

export function recallQueryRequestsWorkspaceContext(query: string): boolean {
  const normalized = Effect2.pipe(query, EffectString.toLowerCase);
  return /\b(?:this|current)\s+(?:app|branch|component|package|project|repo|repository|workspace|worktree)\b/.test(
    normalized,
  );
}

export function recallQueryRequestsBranchContext(query: string): boolean {
  return /\b(?:this|current)\s+branch\b/i.test(query);
}

export const enrichRecallQueryWithWorkspaceContext = Effect.fn('utils.enrichRecallQueryWithWorkspaceContext')(
  function* (
    query: string,
    options: {
      readonly cwd?: string;
      readonly includeComponent?: boolean;
      readonly includeProcessCwd?: boolean;
    } = {},
  ) {
    return yield* enrichRecallQueryWithWorkspaceTerms(query, options, {
      includeBranch: true,
      includeComponent: options.includeComponent !== false,
    });
  },
);

export const enrichRecallQueryWithWorkspaceProjectContext = Effect.fn(
  'utils.enrichRecallQueryWithWorkspaceProjectContext',
)(function* (query: string, options: {readonly cwd?: string; readonly includeProcessCwd?: boolean} = {}) {
  return yield* enrichRecallQueryWithWorkspaceTerms(query, options, {
    includeBranch: false,
    includeComponent: false,
  });
});

export const resolveWorkspaceRepoName = Effect.fn('utils.resolveWorkspaceRepoName')(function* (
  options: {readonly cwd?: string; readonly includeProcessCwd?: boolean} = {},
) {
  const pathService = yield* Path.Path;
  const cwd = options.cwd ?? (options.includeProcessCwd === false ? undefined : yield* getInvocationCwd());
  if (!cwd || !pathService.isAbsolute(cwd)) {
    return undefined;
  }
  return yield* resolveRepoName(cwd);
});

export const resolveWorkspaceBranch = Effect.fn('utils.resolveWorkspaceBranch')(function* (
  options: {readonly cwd?: string; readonly includeProcessCwd?: boolean} = {},
) {
  const pathService = yield* Path.Path;
  const cwd = options.cwd ?? (options.includeProcessCwd === false ? undefined : yield* getInvocationCwd());
  if (!cwd || !pathService.isAbsolute(cwd)) return undefined;
  const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel'], cwd);
  if (!repoRoot) return undefined;
  return (
    Effect2.pipe(yield* gitValue(['branch', '--show-current'], repoRoot), effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) || undefined
  );
});

export interface WorkspaceComponentContext {
  readonly repoRoot: string;
  /** POSIX, repo-relative root of the nearest nested package/app manifest. */
  readonly scope: string;
  readonly terms: readonly string[];
}

export const resolveWorkspaceComponentContext = Effect.fn('utils.resolveWorkspaceComponentContext')(function* (
  options: {readonly cwd?: string; readonly includeProcessCwd?: boolean} = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cwd = options.cwd ?? (options.includeProcessCwd === false ? undefined : yield* getInvocationCwd());
  if (!cwd || !pathService.isAbsolute(cwd)) return undefined;
  const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel'], cwd);
  if (!repoRoot) return undefined;
  return yield* nestedWorkspaceComponentContext(fs, pathService, cwd, repoRoot);
});

const enrichRecallQueryWithWorkspaceTerms = Effect.fn('utils.enrichRecallQueryWithWorkspaceTerms')(function* (
  query: string,
  options: {readonly cwd?: string; readonly includeProcessCwd?: boolean},
  policy: {
    readonly includeBranch: boolean;
    readonly includeComponent: boolean;
  },
) {
  const requested = recallQueryRequestsWorkspaceContext(query);
  if (!requested) {
    return query;
  }
  const workspace = yield* currentWorkspaceRecallTerms(options, policy);
  const additions = EffectArray.filter(
    workspace.terms,
    term =>
      !Effect2.pipe(query, __effectPipeInput => {
        const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.toLowerCase);
        const __effectPipeStage1 = Effect2.pipe(
          __effectPipeStage0,
          EffectString.includes(Effect2.pipe(term, EffectString.toLowerCase)),
        );
        return __effectPipeStage1;
      }),
  );
  return additions.length > 0 ? `${query} ${EffectArray.join(additions, ' ')}` : query;
});

const currentWorkspaceRecallTerms = Effect.fn('utils.currentWorkspaceRecallTerms')(function* (
  options: {
    readonly cwd?: string;
    readonly includeProcessCwd?: boolean;
  },
  policy: {readonly includeBranch: boolean; readonly includeComponent: boolean},
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  const cwd = options.cwd ?? (options.includeProcessCwd === false ? undefined : yield* getInvocationCwd());
  if (!cwd || !pathService.isAbsolute(cwd)) {
    return {terms: []};
  }
  const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel'], cwd);
  if (!repoRoot) {
    return {terms: []};
  }
  const branch = yield* gitValue(['branch', '--show-current'], repoRoot);
  const repoName = yield* resolveWorkspaceRepoName({cwd, includeProcessCwd: false});
  const parent = pathService.dirname(repoRoot);
  const componentContext = policy.includeComponent
    ? yield* nestedWorkspaceComponentContext(fs, pathService, cwd, repoRoot)
    : undefined;
  const componentTerms = componentContext?.terms ?? [];
  return {
    terms: uniqueUsefulWorkspaceTerms([
      {source: 'branch', value: policy.includeBranch ? branch : undefined},
      {source: 'path', value: repoName},
      {source: 'path', value: parent === system.homeDirectory ? undefined : pathService.basename(parent)},
      ...EffectArray.map(componentTerms, value => ({source: 'path' as const, value})),
    ]),
  };
});

const nestedWorkspaceComponentContext = Effect.fn('utils.nestedWorkspaceComponentContext')(function* (
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  cwd: string,
  repoRoot: string,
) {
  const resolvedRoot = yield* fs.realPath(repoRoot).pipe(Effect.orElseSucceed(() => pathService.resolve(repoRoot)));
  const cwdInfo = yield* fs.stat(cwd).pipe(Effect.option);
  const logicalCurrent = pathService.resolve(
    cwdInfo._tag === 'Some' && cwdInfo.value.type === 'File' ? pathService.dirname(cwd) : cwd,
  );
  let current = yield* fs.realPath(logicalCurrent).pipe(Effect.orElseSucceed(() => logicalCurrent));
  const relativeCwd = pathService.relative(resolvedRoot, current);
  if (Effect2.pipe(relativeCwd, EffectString.startsWith('..')) || pathService.isAbsolute(relativeCwd)) {
    return undefined;
  }
  while (current !== resolvedRoot) {
    const manifest = yield* findWorkspaceComponentManifest(fs, pathService, current);
    if (manifest) {
      const relativeRoot = toPosixPath(pathService.relative(resolvedRoot, current));
      const declaredName = manifest.declaredName;
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional-chain narrowing through the split and final at call.
      const unscopedName = declaredName?.startsWith('@') ? declaredName.split('/').at(-1) : undefined;
      return {
        repoRoot: resolvedRoot,
        scope: relativeRoot,
        terms: uniqueUsefulWorkspaceTerms([
          {source: 'path', value: declaredName},
          {source: 'path', value: unscopedName},
          {source: 'path', value: pathService.basename(current)},
          {source: 'path', value: relativeRoot},
        ]),
      } satisfies WorkspaceComponentContext;
    }
    const parent = pathService.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
});

export function uniqueUsefulWorkspaceTerms(
  values: readonly {readonly source: 'branch' | 'path'; readonly value: string | undefined}[],
): readonly string[] {
  const ignored = new Set([
    'apps',
    'components',
    'libs',
    'modules',
    'packages',
    'repos',
    'repositories',
    'services',
    'source',
    'src',
    'workspaces',
    'worktrees',
  ]);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const {source, value} of values) {
    const term = Effect2.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
    const normalized = Effect2.pipe(term, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
    );
    const tooShort = source === 'branch' ? false : (term?.length ?? 0) < 4;
    if (!term || !normalized || tooShort || ignored.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    terms.push(term);
  }
  return terms;
}

export function toPosixPath(path: string): string {
  return Effect2.pipe(path, EffectString.replaceAll('\\', '/'));
}

export function trimTrailingSlash(value: string): string {
  return Effect2.pipe(value, EffectString.endsWith('/')) ? Effect2.pipe(value, EffectString.slice(0, -1)) : value;
}

export function parentResourceUri(uri: string): string {
  const trimmedUri = trimTrailingSlash(uri);
  const slashIndex = Effect2.pipe(
    trimmedUri,
    EffectString.lastIndexOf('/'),
    Effect2.Option.getOrElse(() => -1),
  );
  return slashIndex <= 'threadnote://'.length
    ? trimmedUri
    : Effect2.pipe(trimmedUri, EffectString.slice(0, slashIndex));
}

export const sha256 = sha256Hex;

export {
  exactRecallTerms,
  grepOutputHasMatches,
  exactRecallScopeIntents,
  isSummarySidecarUri,
  isAgentArtifactPackUri,
  isExcludedRecallUri,
  memoryUriProjectSegment,
  memoryFrontmatterField,
  grepUrisFromJson,
  RECALL_CATEGORY_ORDER,
  parseRecallHits,
  mergeRecallHits,
  categoryForUri,
  applyExactMatchBoost,
  formatRecallHits,
  RECALL_LOW_CONFIDENCE_NOTE,
  RECALL_CATEGORY_RESERVE,
  recallIndexPreselectionLimit,
  buildRecallSections,
  exactMemoryScopeUris,
  collectExactMatches,
  formatExactMatchPointers,
} from '@threadnote/recall/results';
export type {ExactScopeIntent, ExactMatch, RecallCategory, RecallHit, RecallSections} from '@threadnote/recall/results';

export function safeTimestamp(): string {
  return Effect2.pipe(new Date().toISOString(), EffectString.replace(/[:.]/g, '-'));
}

export function firstLine(value: string): string {
  return (
    Effect2.pipe(Effect2.pipe(value, EffectString.split('\n'))[0], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) ?? ''
  );
}

export function formatStatus(status: CommandStatus): string {
  if (status === 'ok') {
    return success('OK  ');
  }
  if (status === 'warn') {
    return warning('WARN');
  }
  return failure('FAIL');
}

export const currentPackageVersion = Effect.fn('utils.currentPackageVersion')(function* () {
  return yield* getThreadnoteVersion();
});

export {errorMessage} from '@threadnote/platform/errors';
