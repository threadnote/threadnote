import {Console, Effect, FileSystem, Option, Path, PlatformError, Result, Schema} from 'effect';
import {SHIM_MARKER} from './constants.js';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {DoctorCheck} from './types.js';
import {expandPath} from '@threadnote/platform/paths';
import {readFileIfExists, removePath, shellQuote} from './utils.js';
import {toolRoot} from '@threadnote/workspace/installation';

const THREADNOTE_COMMAND = 'threadnote';
const THREADNOTE_MCP_COMMAND = 'threadnote-mcp-server';
const THREADNOTE_AUTH0_CREDENTIAL_COMMAND = 'threadnote-credential-auth0-m2m';
const THREADNOTE_AUTH0_REGISTRY_CREDENTIAL_COMMAND = 'docker-credential-threadnote-auth0-m2m';
const THREADNOTE_AUTH0_PUBLISHER_REGISTRY_CREDENTIAL_COMMAND = 'docker-credential-threadnote-auth0-publisher-m2m';
const THREADNOTE_AUTH0_USER_REGISTRY_CREDENTIAL_COMMAND = 'docker-credential-threadnote-auth0-user';
const THREADNOTE_OAUTH_USER_REGISTRY_CREDENTIAL_COMMAND = 'docker-credential-threadnote-oauth-user';
class CommandShimConfigurationError extends Schema.TaggedError<CommandShimConfigurationError>()(
  'CommandShimConfigurationError',
  {message: Schema.String},
) {}
export type LauncherMode =
  | 'cli'
  | 'mcp'
  | 'credential-oauth-m2m'
  | 'credential-registry-oauth-m2m'
  | 'credential-registry-oauth-publisher-m2m'
  | 'credential-auth0-m2m'
  | 'credential-registry-auth0-m2m'
  | 'credential-registry-auth0-publisher-m2m'
  | 'credential-registry-oauth-user'
  | 'credential-registry-auth0-user';
const LAUNCHER_MODES: readonly LauncherMode[] = [
  'cli',
  'mcp',
  'credential-oauth-m2m',
  'credential-registry-oauth-m2m',
  'credential-registry-oauth-publisher-m2m',
  'credential-registry-oauth-user',
  'credential-auth0-m2m',
  'credential-registry-auth0-m2m',
  'credential-registry-auth0-publisher-m2m',
  'credential-registry-auth0-user',
];
const CORE_LAUNCHER_MODES: readonly LauncherMode[] = ['cli', 'mcp'];
const CONTROL_HELPER_MODES = new Map<string, LauncherMode>([
  ['oauth-m2m', 'credential-oauth-m2m'],
  ['auth0-m2m', 'credential-auth0-m2m'],
]);
const DOCKER_HELPER_MODES = new Map<string, LauncherMode>([
  ['threadnote-oauth-m2m', 'credential-registry-oauth-m2m'],
  ['threadnote-oauth-publisher-m2m', 'credential-registry-oauth-publisher-m2m'],
  ['threadnote-oauth-user', 'credential-registry-oauth-user'],
  ['threadnote-auth0-m2m', 'credential-registry-auth0-m2m'],
  ['threadnote-auth0-publisher-m2m', 'credential-registry-auth0-publisher-m2m'],
  ['threadnote-auth0-user', 'credential-registry-auth0-user'],
]);

export function configuredLauncherModes(controlConfig: unknown, dockerConfig: unknown): readonly LauncherMode[] {
  const selected = new Set<LauncherMode>(CORE_LAUNCHER_MODES);
  if (isRecord(controlConfig) && controlConfig.schemaVersion === 1 && Array.isArray(controlConfig.bindings)) {
    for (const binding of controlConfig.bindings) {
      if (!isRecord(binding) || typeof binding.helper !== 'string') continue;
      const mode = CONTROL_HELPER_MODES.get(binding.helper);
      if (mode !== undefined) selected.add(mode);
    }
  }
  if (isRecord(dockerConfig)) {
    const helpers = isRecord(dockerConfig.credHelpers) ? Object.values(dockerConfig.credHelpers) : [];
    for (const helper of [...helpers, dockerConfig.credsStore]) {
      if (typeof helper !== 'string') continue;
      const mode = DOCKER_HELPER_MODES.get(helper);
      if (mode !== undefined) selected.add(mode);
    }
  }
  return LAUNCHER_MODES.filter(mode => selected.has(mode));
}

export const requiredCommandLauncherModes = Effect.fn('commandShim.requiredModes')(function* (home?: string) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const threadnoteHome = home ?? (yield* expandPath(system.environment().THREADNOTE_HOME ?? '~/.threadnote'));
  const dockerDirectory = system.environment().DOCKER_CONFIG ?? path.join(system.homeDirectory, '.docker');
  if (!path.isAbsolute(dockerDirectory))
    return yield* CommandShimConfigurationError.make({
      message: 'Docker credential helper configuration directory must be absolute.',
    });
  const controlConfig = yield* readLauncherConfiguration(
    path.join(threadnoteHome, 'graph-sharing', 'control-credentials.json'),
    'control',
  );
  const dockerConfig = yield* readLauncherConfiguration(path.join(dockerDirectory, 'config.json'), 'docker');
  return configuredLauncherModes(controlConfig, dockerConfig);
});

export const plannedCommandLauncherMutations = Effect.fn('commandShim.plannedMutations')(function* (home?: string) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const required = new Set(yield* requiredCommandLauncherModes(home));
  const planned: {readonly mode: LauncherMode; readonly kind: CommandLauncherKind}[] = [];
  for (const mode of LAUNCHER_MODES) {
    for (const kind of managedCommandLauncherKinds(system.platform)) {
      const launcher = yield* managedCommandShimPath(mode, kind);
      if (Option.isSome(yield* fs.readLink(launcher).pipe(Effect.option))) continue;
      const info = yield* fs.stat(launcher).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type !== 'File') continue;
      const content = yield* readFileIfExists(launcher);
      if (Option.isSome(info) && content === undefined) continue;
      if (content !== undefined && !isManagedCommandShim(content)) continue;
      if (required.has(mode) || content !== undefined) planned.push({mode, kind});
    }
  }
  return planned;
});

const readLauncherConfiguration = Effect.fn('commandShim.readConfiguration')(function* (
  file: string,
  kind: 'control' | 'docker',
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.match({onFailure: Result.fail, onSuccess: Result.succeed}));
  if (Result.isFailure(info)) {
    if (PlatformError.isPlatformError(info.failure) && info.failure.reason._tag === 'NotFound') {
      const link = yield* fs.readLink(file).pipe(Effect.match({onFailure: Result.fail, onSuccess: Result.succeed}));
      if (
        Result.isFailure(link) &&
        PlatformError.isPlatformError(link.failure) &&
        link.failure.reason._tag === 'NotFound'
      )
        return undefined;
    }
    return yield* CommandShimConfigurationError.make({
      message: `${kind} credential helper configuration is unavailable: ${file}`,
    });
  }
  if (info.success.type !== 'File' || info.success.size > 65_536)
    return yield* CommandShimConfigurationError.make({
      message: `${kind} credential helper configuration is unreadable or exceeds 64 KiB: ${file}`,
    });
  const content = yield* fs.readFileString(file).pipe(
    Effect.mapError(() =>
      CommandShimConfigurationError.make({
        message: `${kind} credential helper configuration is unavailable: ${file}`,
      }),
    ),
  );
  const config = yield* Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: () =>
      CommandShimConfigurationError.make({message: `${kind} credential helper configuration is invalid: ${file}`}),
  });
  if (kind === 'control' ? !isControlConfiguration(config) : !isDockerConfiguration(config))
    return yield* CommandShimConfigurationError.make({
      message: `${kind} credential helper configuration is invalid: ${file}`,
    });
  return config;
});

function isControlConfiguration(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.bindings) &&
    value.bindings.every(binding => isRecord(binding) && typeof binding.helper === 'string')
  );
}

function isDockerConfiguration(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.credHelpers === undefined ||
      (isRecord(value.credHelpers) && Object.values(value.credHelpers).every(helper => typeof helper === 'string'))) &&
    (value.credsStore === undefined || typeof value.credsStore === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type CommandLauncherKind = 'cmd' | 'posix';

export function managedCommandLauncherKinds(platform: NodeJS.Platform): readonly CommandLauncherKind[] {
  return platform === 'win32' ? ['cmd', 'posix'] : ['posix'];
}

export function primaryCommandLauncherKind(platform: NodeJS.Platform): CommandLauncherKind {
  const [primary] = managedCommandLauncherKinds(platform);
  return primary ?? 'posix';
}

/** Omitting `kind` selects the platform-primary launcher (`.cmd` on Windows). Pass `'posix'` for Git Bash. */
export const commandLauncherPath = Effect.fn('commandShim.launcherPath')(
  (mode: LauncherMode = 'cli', kind?: CommandLauncherKind) => managedCommandShimPath(mode, kind),
);

export const commandShimCheck = Effect.fn('commandShim.check')(function* (home?: string) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const paths: string[] = [];
  for (const mode of yield* requiredCommandLauncherModes(home)) {
    for (const kind of managedCommandLauncherKinds(system.platform)) {
      const shimPath = yield* managedCommandShimPath(mode, kind);
      if (Option.isSome(yield* fs.readLink(shimPath).pipe(Effect.option))) {
        return {
          detail: `${shimPath} is a symbolic link; repair will not overwrite it`,
          name: 'threadnote launcher',
          status: 'warn',
        } satisfies DoctorCheck;
      }
      const content = yield* readFileIfExists(shimPath);
      if (content === undefined) {
        return {
          detail: `${shimPath} missing; repair will create it`,
          name: 'threadnote launcher',
          status: 'warn',
        } satisfies DoctorCheck;
      }
      if (!isManagedCommandShim(content)) {
        return {
          detail: `${shimPath} exists but is not managed by Threadnote; repair will not overwrite it`,
          name: 'threadnote launcher',
          status: 'warn',
        } satisfies DoctorCheck;
      }
      if (content !== (yield* renderCommandShim(undefined, mode, kind))) {
        return {
          detail: `${shimPath} points at a different standalone release; repair will rewrite it`,
          name: 'threadnote launcher',
          status: 'warn',
        } satisfies DoctorCheck;
      }
      paths.push(shimPath);
    }
  }
  return {detail: paths.join('; '), name: 'threadnote launcher', status: 'ok'} satisfies DoctorCheck;
});

export const installCommandShim = Effect.fn('commandShim.install')(function* (
  dryRun: boolean,
  releaseRoot?: string,
  home?: string,
) {
  const required = new Set(yield* requiredCommandLauncherModes(home));
  for (const mode of LAUNCHER_MODES) {
    if (required.has(mode)) yield* installLauncher(mode, dryRun, releaseRoot);
    else yield* removeUnusedLauncher(mode, dryRun);
  }
  yield* ensureDefaultWindowsBinDirectoryOnUserPath(dryRun);
});

const removeUnusedLauncher = Effect.fn('commandShim.removeUnusedLauncher')(function* (
  mode: LauncherMode,
  dryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  for (const kind of managedCommandLauncherKinds(system.platform)) {
    const shimPath = yield* managedCommandShimPath(mode, kind);
    if (Option.isSome(yield* fs.readLink(shimPath).pipe(Effect.option))) continue;
    const info = yield* fs.stat(shimPath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== 'File') continue;
    const content = yield* readFileIfExists(shimPath);
    if (content !== undefined && isManagedCommandShim(content)) {
      yield* removePath(shimPath, 'unused command launcher', dryRun);
    }
  }
});

const ensureDefaultWindowsBinDirectoryOnUserPath = Effect.fn('commandShim.ensureWindowsPath')(function* (
  dryRun: boolean,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (system.platform !== 'win32' || system.environment().THREADNOTE_BIN_DIR?.trim()) return;
  const binDirectory = path.dirname(yield* managedCommandShimPath('cli'));
  if (dryRun) {
    yield* Console.log(`Would ensure command directory is on the Windows user PATH: ${binDirectory}`);
    return;
  }
  const script = [
    '$entry=$env:THREADNOTE_PATH_ENTRY',
    "$current=[Environment]::GetEnvironmentVariable('Path','User')",
    "$entries=@($current -split ';' | Where-Object { $_ })",
    "if (-not ($entries | Where-Object { $_.TrimEnd('\\') -ieq $entry.TrimEnd('\\') })) {",
    "  [Environment]::SetEnvironmentVariable('Path', ((@($entry) + $entries) -join ';'), 'User')",
    '}',
  ].join('; ');
  yield* runCommandEffect('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: {...system.environment(), THREADNOTE_PATH_ENTRY: binDirectory},
  });
  yield* Console.log(`Ensured command directory is on the Windows user PATH: ${binDirectory}`);
});

const installLauncher = Effect.fn('commandShim.installLauncher')(function* (
  mode: LauncherMode,
  dryRun: boolean,
  releaseRoot?: string,
) {
  const system = yield* SystemInfo;
  for (const kind of managedCommandLauncherKinds(system.platform)) {
    yield* installLauncherFile(mode, kind, dryRun, releaseRoot);
  }
});

const installLauncherFile = Effect.fn('commandShim.installLauncherFile')(function* (
  mode: LauncherMode,
  kind: CommandLauncherKind,
  dryRun: boolean,
  releaseRoot?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const shimPath = yield* managedCommandShimPath(mode, kind);
  if (Option.isSome(yield* fs.readLink(shimPath).pipe(Effect.option))) {
    yield* Console.warn(`WARN not overwriting symbolic-link command launcher: ${shimPath}`);
    return;
  }
  const existingContent = yield* readFileIfExists(shimPath);
  if (existingContent === undefined && (yield* pathEntryExists(fs, shimPath))) {
    yield* Console.warn(`WARN not overwriting unreadable command launcher: ${shimPath}`);
    return;
  }
  if (existingContent !== undefined && !isManagedCommandShim(existingContent)) {
    yield* Console.warn(`WARN not overwriting unmanaged command launcher: ${shimPath}`);
    return;
  }
  const content = yield* renderCommandShim(releaseRoot, mode, kind);
  if (existingContent === content) {
    yield* Console.log(`Command launcher already current: ${shimPath}`);
    return;
  }
  if (dryRun) {
    yield* Console.log(`Would write command launcher: ${shimPath}`);
    return;
  }
  yield* fs.makeDirectory(path.dirname(shimPath), {recursive: true, mode: 0o700});
  const temporary = path.join(path.dirname(shimPath), `.${path.basename(shimPath)}.${system.processId}.tmp`);
  yield* Effect.gen(function* () {
    yield* fs.remove(temporary, {force: true});
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o755});
    yield* fs.chmod(temporary, 0o755);
    yield* fs.rename(temporary, shimPath);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  yield* Console.log(`Wrote command launcher: ${shimPath}`);
});

export const removeCommandShim = Effect.fn('commandShim.remove')(function* (dryRun: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  for (const mode of LAUNCHER_MODES) {
    for (const kind of managedCommandLauncherKinds(system.platform)) {
      const shimPath = yield* managedCommandShimPath(mode, kind);
      if (Option.isSome(yield* fs.readLink(shimPath).pipe(Effect.option))) {
        yield* Console.warn(`WARN not removing symbolic-link command launcher: ${shimPath}`);
        continue;
      }
      const content = yield* readFileIfExists(shimPath);
      if (content === undefined) {
        yield* Console.log(`Command launcher already absent: ${shimPath}`);
        continue;
      }
      if (!isManagedCommandShim(content)) {
        yield* Console.warn(`WARN not removing unmanaged command launcher: ${shimPath}`);
        continue;
      }
      yield* removePath(shimPath, 'command launcher', dryRun);
    }
  }
});

export const renderCommandShim = Effect.fn('commandShim.render')(function* (
  releaseRoot?: string,
  mode: LauncherMode = 'cli',
  kind?: CommandLauncherKind,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = releaseRoot ?? (yield* toolRoot());
  const executable = path.join(root, system.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
  const resolvedKind = kind ?? primaryCommandLauncherKind(system.platform);
  const modeArguments =
    mode === 'mcp'
      ? ['mcp-broker']
      : mode === 'credential-oauth-m2m'
        ? ['__credential-oauth-m2m']
        : mode === 'credential-registry-oauth-m2m'
          ? ['__credential-registry-oauth-m2m']
          : mode === 'credential-registry-oauth-publisher-m2m'
            ? ['__credential-registry-oauth-publisher-m2m']
            : mode === 'credential-auth0-m2m'
              ? ['__credential-auth0-m2m']
              : mode === 'credential-registry-auth0-m2m'
                ? ['__credential-registry-auth0-m2m']
                : mode === 'credential-registry-auth0-publisher-m2m'
                  ? ['__credential-registry-auth0-publisher-m2m']
                  : mode === 'credential-registry-oauth-user'
                    ? ['__credential-registry-oauth-user']
                    : mode === 'credential-registry-auth0-user'
                      ? ['__credential-registry-auth0-user']
                      : [];
  if (resolvedKind === 'cmd') {
    const command = [cmdQuote(executable), ...modeArguments, '%*'].join(' ');
    return [
      '@echo off',
      `rem ${SHIM_MARKER}`,
      'setlocal',
      'set "THREADNOTE_CALLER_CWD=%CD%"',
      command,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
  }
  const posixExecutable = system.platform === 'win32' ? executable.replaceAll('\\', '/') : executable;
  return [
    '#!/usr/bin/env sh',
    `# ${SHIM_MARKER}`,
    'set -eu',
    `THREADNOTE_ENTRY=${shellQuote(posixExecutable)}`,
    'if [ ! -x "$THREADNOTE_ENTRY" ]; then',
    '  echo "Threadnote standalone executable is missing: $THREADNOTE_ENTRY" >&2',
    '  echo "Reinstall Threadnote from a stable or beta GitHub release." >&2',
    '  exit 127',
    'fi',
    'THREADNOTE_CALLER_CWD="$PWD"',
    'export THREADNOTE_CALLER_CWD',
    `exec "$THREADNOTE_ENTRY"${modeArguments
      .map(shellQuote)
      .map(value => ` ${value}`)
      .join('')} "$@"`,
    '',
  ].join('\n');
});

function isManagedCommandShim(content: string): boolean {
  const marker = SHIM_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`^#![^\\r\\n]*\\r?\\n# ${marker}(?:\\r?\\n|$)`).test(content) ||
    new RegExp(`^@echo off\\r?\\nrem ${marker}(?:\\r?\\n|$)`, 'i').test(content)
  );
}

const managedCommandShimPath = Effect.fn('commandShim.path')(function* (
  mode: LauncherMode,
  kind?: CommandLauncherKind,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const environment = system.environment();
  const configured = environment.THREADNOTE_BIN_DIR?.trim();
  const localAppData = environment.LOCALAPPDATA;
  const binDirectory = configured
    ? yield* expandPath(configured)
    : system.platform === 'win32' && localAppData
      ? path.join(localAppData, 'Threadnote', 'bin')
      : yield* expandPath('~/.local/bin');
  const command =
    mode === 'mcp'
      ? THREADNOTE_MCP_COMMAND
      : mode === 'credential-oauth-m2m'
        ? 'threadnote-credential-oauth-m2m'
        : mode === 'credential-registry-oauth-m2m'
          ? 'docker-credential-threadnote-oauth-m2m'
          : mode === 'credential-registry-oauth-publisher-m2m'
            ? 'docker-credential-threadnote-oauth-publisher-m2m'
            : mode === 'credential-auth0-m2m'
              ? THREADNOTE_AUTH0_CREDENTIAL_COMMAND
              : mode === 'credential-registry-auth0-m2m'
                ? THREADNOTE_AUTH0_REGISTRY_CREDENTIAL_COMMAND
                : mode === 'credential-registry-auth0-publisher-m2m'
                  ? THREADNOTE_AUTH0_PUBLISHER_REGISTRY_CREDENTIAL_COMMAND
                  : mode === 'credential-registry-oauth-user'
                    ? THREADNOTE_OAUTH_USER_REGISTRY_CREDENTIAL_COMMAND
                    : mode === 'credential-registry-auth0-user'
                      ? THREADNOTE_AUTH0_USER_REGISTRY_CREDENTIAL_COMMAND
                      : THREADNOTE_COMMAND;
  const resolvedKind = kind ?? primaryCommandLauncherKind(system.platform);
  return path.join(binDirectory, resolvedKind === 'cmd' ? `${command}.cmd` : command);
});

function cmdQuote(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`;
}

function pathEntryExists(fs: FileSystem.FileSystem, target: string): Effect.Effect<boolean, never> {
  return Effect.all([fs.stat(target).pipe(Effect.option), fs.readLink(target).pipe(Effect.option)]).pipe(
    Effect.map(([info, link]) => Option.isSome(info) || Option.isSome(link)),
  );
}
