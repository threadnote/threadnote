import {Array as EffectArray} from 'effect';
import {Console, Effect, FileSystem, Path, Predicate} from 'effect';
import {commandLauncherPath} from '../command-shim.js';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {LEGACY_OPENVIKING_HOME_DIRECTORY} from '@threadnote/store/layout';
import {findExecutableCandidates, readFileIfExists} from '../utils.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const LEGACY_THREADNOTE_PACKAGE = 'threadnote';
const OPENVIKING_PACKAGE = 'openviking';
const PACKAGE_MANAGER_TIMEOUT_MILLISECONDS = 30_000;
const LEGACY_LAUNCH_AGENT_LABEL = 'io.threadnote.openviking';
const LEGACY_THREADNOTE_HOME_MARKERS = [
  'threadnote',
  'openviking-server.pid',
  'local-ai-server.json',
  'seed-manifest.yaml',
] as const;

interface LegacyNpmInstallation {
  readonly cli?: string;
  readonly npm: string;
  readonly version: string;
}

interface LegacyOpenVikingInstallation {
  readonly executable: string;
  readonly manager: 'pip' | 'pipx' | 'uv';
}

export interface LegacyInstallationCleanupPlan {
  readonly legacyHome?: string;
  readonly launchAgentPath?: string;
  readonly npm: readonly LegacyNpmInstallation[];
  readonly openViking: readonly LegacyOpenVikingInstallation[];
}

export const planLegacyInstallationCleanup = Effect.fn('legacyInstallations.plan')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const legacyHome = path.join(system.homeDirectory, LEGACY_OPENVIKING_HOME_DIRECTORY);
  const legacyLauncher = yield* readFileIfExists(yield* commandLauncherPath());
  const associatedNpm = yield* npmFromLegacyLauncher(fs, path, system.platform, legacyLauncher);
  const npmExecutables = new Set(yield* findExecutableCandidates(['npm']));

  const npmInstallations: LegacyNpmInstallation[] = associatedNpm ? [associatedNpm] : [];
  for (const npm of npmExecutables) {
    if (EffectArray.some(npmInstallations, installation => installation.npm === npm)) continue;
    const discovered = yield* inspectNpmInstallation(fs, path, system.platform, npm);
    if (discovered) npmInstallations.push(discovered);
  }

  const launchAgentPath =
    system.platform === 'darwin'
      ? path.join(system.homeDirectory, 'Library', 'LaunchAgents', `${LEGACY_LAUNCH_AGENT_LABEL}.plist`)
      : undefined;
  const hasLaunchAgent = launchAgentPath ? yield* fs.exists(launchAgentPath) : false;
  const hasLegacyHomeMarker = yield* hasAnyLegacyHomeMarker(fs, path, legacyHome);
  const hasThreadnoteOwnedOpenViking = npmInstallations.length > 0 || hasLegacyHomeMarker || hasLaunchAgent;
  const openViking = hasThreadnoteOwnedOpenViking
    ? yield* discoverOpenVikingInstallations(fs, path, system.homeDirectory)
    : [];
  const legacyHomeExists = yield* fs.exists(legacyHome);

  return {
    ...(legacyHomeExists ? {legacyHome} : {}),
    ...(hasLaunchAgent ? {launchAgentPath} : {}),
    npm: deduplicateNpmInstallations(npmInstallations),
    openViking,
  } satisfies LegacyInstallationCleanupPlan;
});

export const applyLegacyInstallationCleanup = Effect.fn('legacyInstallations.apply')(function* (
  plan: LegacyInstallationCleanupPlan,
  dryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;

  for (const installation of plan.npm) {
    const environment = withExecutableDirectoryOnPath(path, system, installation.npm);
    if (installation.cli) {
      if (dryRun) {
        yield* Console.log(`Would stop the legacy Threadnote ${installation.version} runtime: ${installation.cli}`);
      } else {
        const stopped = yield* runCommandEffect(installation.cli, ['stop'], {
          allowFailure: true,
          env: environment,
          timeoutMs: PACKAGE_MANAGER_TIMEOUT_MILLISECONDS,
        });
        if (stopped.exitCode !== 0) {
          yield* Console.warn(
            `WARN legacy Threadnote ${installation.version} could not stop its runtime before cleanup.`,
          );
        }
      }
    }
  }

  if (plan.launchAgentPath) {
    if (dryRun) {
      yield* Console.log(`Would unload and remove legacy Threadnote LaunchAgent: ${plan.launchAgentPath}`);
    } else {
      if (system.userId === undefined) {
        yield* Console.warn(`WARN could not unload ${LEGACY_LAUNCH_AGENT_LABEL}: current user id is unavailable.`);
      } else {
        const target = `gui/${system.userId}/${LEGACY_LAUNCH_AGENT_LABEL}`;
        const result = yield* runCommandEffect('launchctl', ['bootout', target], {
          allowFailure: true,
          timeoutMs: PACKAGE_MANAGER_TIMEOUT_MILLISECONDS,
        });
        if (result.exitCode !== 0 && !/could not find service/i.test(`${result.stdout}\n${result.stderr}`)) {
          yield* Console.warn(`WARN launchctl could not unload ${LEGACY_LAUNCH_AGENT_LABEL}; removing its plist.`);
        }
      }
      yield* fs.remove(plan.launchAgentPath, {force: true});
      yield* Console.log(`Removed legacy Threadnote LaunchAgent: ${plan.launchAgentPath}`);
    }
  }

  for (const installation of plan.npm) {
    const environment = withExecutableDirectoryOnPath(path, system, installation.npm);
    if (dryRun) {
      yield* Console.log(`Would uninstall legacy global Threadnote ${installation.version} with npm.`);
      continue;
    }
    const result = yield* runCommandEffect(installation.npm, ['uninstall', '--global', LEGACY_THREADNOTE_PACKAGE], {
      allowFailure: true,
      env: environment,
      timeoutMs: PACKAGE_MANAGER_TIMEOUT_MILLISECONDS,
    });
    if (result.exitCode === 0) {
      yield* Console.log(`Removed legacy global Threadnote ${installation.version} installed with npm.`);
    } else {
      yield* Console.warn(
        `WARN npm could not remove legacy global Threadnote ${installation.version}; remove it manually with ` +
          `\`${installation.npm} uninstall --global ${LEGACY_THREADNOTE_PACKAGE}\`.`,
      );
    }
  }

  for (const installation of plan.openViking) {
    const args =
      installation.manager === 'uv'
        ? ['tool', 'uninstall', OPENVIKING_PACKAGE]
        : installation.manager === 'pipx'
          ? ['uninstall', OPENVIKING_PACKAGE]
          : ['-m', 'pip', 'uninstall', '--yes', OPENVIKING_PACKAGE];
    if (dryRun) {
      yield* Console.log(`Would uninstall the legacy OpenViking tool with ${installation.manager}.`);
      continue;
    }
    const result = yield* runCommandEffect(installation.executable, args, {
      allowFailure: true,
      timeoutMs: PACKAGE_MANAGER_TIMEOUT_MILLISECONDS,
    });
    if (result.exitCode === 0) {
      yield* Console.log(`Removed the legacy OpenViking tool installed with ${installation.manager}.`);
    } else {
      yield* Console.warn(
        `WARN ${installation.manager} could not remove the legacy OpenViking tool; its data was preserved.`,
      );
    }
  }

  if (plan.legacyHome) {
    yield* Console.log(`Preserved legacy memories and rollback data: ${plan.legacyHome}`);
  }
});

const inspectNpmInstallation = Effect.fn('legacyInstallations.inspectNpm')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  platform: NodeJS.Platform,
  npm: string,
) {
  const listed = yield* runCommandEffect(npm, ['ls', '--global', '--depth=0', '--json', LEGACY_THREADNOTE_PACKAGE], {
    allowFailure: true,
    timeoutMs: PACKAGE_MANAGER_TIMEOUT_MILLISECONDS,
  });
  const version = parseLegacyNpmVersion(listed.stdout);
  if (!version) return undefined;
  const prefixResult = yield* runCommandEffect(npm, ['prefix', '--global'], {
    allowFailure: true,
    timeoutMs: PACKAGE_MANAGER_TIMEOUT_MILLISECONDS,
  });
  const prefix = prefixResult.exitCode === 0 ? Effect2.pipe(prefixResult.stdout, EffectString.trim) : '';
  const cli = prefix ? yield* legacyNpmCli(fs, path, platform, prefix) : undefined;
  return {cli, npm, version} satisfies LegacyNpmInstallation;
});

const npmFromLegacyLauncher = Effect.fn('legacyInstallations.npmFromLauncher')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  platform: NodeJS.Platform,
  launcher: string | undefined,
) {
  const packageRoot = launcher ? legacyPackageRootFromLauncher(path, launcher) : undefined;
  if (!packageRoot) return undefined;
  const version = yield* legacyThreadnotePackageVersion(fs, path, packageRoot);
  if (!version) return undefined;
  const nodeModules = path.dirname(packageRoot);
  if (Effect2.pipe(path.basename(nodeModules), EffectString.toLowerCase) !== 'node_modules') return undefined;
  const parent = path.dirname(nodeModules);
  const prefix = platform === 'win32' || path.basename(parent) !== 'lib' ? parent : path.dirname(parent);
  const npmCandidates =
    platform === 'win32'
      ? [path.join(parent, 'npm.cmd'), path.join(parent, 'npm.exe'), path.join(parent, 'npm')]
      : [path.join(prefix, 'bin', 'npm')];
  for (const npm of npmCandidates) {
    if (yield* fs.exists(npm)) {
      const cli = yield* legacyNpmCli(fs, path, platform, prefix);
      return {cli, npm, version} satisfies LegacyNpmInstallation;
    }
  }
  return undefined;
});

function legacyPackageRootFromLauncher(path: Path.Path, launcher: string): string | undefined {
  if (!Effect2.pipe(launcher, EffectString.includes('Generated by threadnote'))) return undefined;
  const literal = Effect2.pipe(/^THREADNOTE_ROOT=([^\r\n]+)$/m.exec(launcher)?.[1], effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (!literal) return undefined;
  const value =
    Effect2.pipe(literal, EffectString.startsWith("'")) && Effect2.pipe(literal, EffectString.endsWith("'"))
      ? Effect2.pipe(literal, __effectPipeInput => {
          const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.slice(1, -1));
          const __effectPipeStage1 = Effect2.pipe(__effectPipeStage0, EffectString.replaceAll(`'"'"'`, "'"));
          return __effectPipeStage1;
        })
      : /^[A-Za-z]:[\\/][^$`"\r\n]+$|^\/[^$`"\r\n]+$/.test(literal)
        ? literal
        : undefined;
  return value && path.isAbsolute(value) ? path.resolve(value) : undefined;
}

const legacyThreadnotePackageVersion = Effect.fn('legacyInstallations.legacyPackageVersion')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  packageRoot: string,
) {
  const manifest = yield* fs
    .readFileString(path.join(packageRoot, 'package.json'))
    .pipe(Effect.orElseSucceed(() => ''));
  return parseLegacyPackageManifestVersion(manifest);
});

const legacyNpmCli = Effect.fn('legacyInstallations.npmCli')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  platform: NodeJS.Platform,
  prefix: string,
) {
  const candidates =
    platform === 'win32'
      ? [path.join(prefix, 'threadnote.cmd'), path.join(prefix, 'threadnote.exe'), path.join(prefix, 'threadnote')]
      : [path.join(prefix, 'bin', 'threadnote')];
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) return candidate;
  }
  return undefined;
});

const discoverOpenVikingInstallations = Effect.fn('legacyInstallations.discoverOpenViking')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  homeDirectory: string,
) {
  const installations: LegacyOpenVikingInstallation[] = [];
  for (const uv of yield* findExecutableCandidates(['uv'])) {
    const listed = yield* runCommandEffect(uv, ['tool', 'list'], {
      allowFailure: true,
      timeoutMs: PACKAGE_MANAGER_TIMEOUT_MILLISECONDS,
    });
    if (/^openviking\s+v?\d/m.test(listed.stdout)) {
      installations.push({executable: uv, manager: 'uv'});
    }
  }
  for (const pipx of yield* findExecutableCandidates(['pipx'])) {
    const listed = yield* runCommandEffect(pipx, ['list', '--json'], {
      allowFailure: true,
      timeoutMs: PACKAGE_MANAGER_TIMEOUT_MILLISECONDS,
    });
    if (pipxHasOpenViking(listed.stdout)) {
      installations.push({executable: pipx, manager: 'pipx'});
    }
  }
  for (const python of yield* findExecutableCandidates(['python3', 'python', 'py'])) {
    const shown = yield* runCommandEffect(python, ['-m', 'pip', 'show', OPENVIKING_PACKAGE], {
      allowFailure: true,
      timeoutMs: PACKAGE_MANAGER_TIMEOUT_MILLISECONDS,
    });
    const location = pipPackageLocation(shown.stdout);
    if (location && isWithinHome(path, homeDirectory, location)) {
      installations.push({executable: python, manager: 'pip'});
    }
  }
  return deduplicateOpenVikingInstallations(installations);
});

const hasAnyLegacyHomeMarker = Effect.fn('legacyInstallations.hasHomeMarker')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  legacyHome: string,
) {
  for (const marker of LEGACY_THREADNOTE_HOME_MARKERS) {
    if (yield* fs.exists(path.join(legacyHome, marker))) return true;
  }
  return false;
});

function parseLegacyNpmVersion(content: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Predicate.isObject(parsed)) return undefined;
    const dependencies = parsed.dependencies;
    if (!Predicate.isObject(dependencies)) return undefined;
    const dependency = dependencies[LEGACY_THREADNOTE_PACKAGE];
    if (!Predicate.isObject(dependency)) return undefined;
    const version = dependency.version;
    return typeof version === 'string' && isNodeBasedThreadnoteVersion(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

function parseLegacyPackageManifestVersion(content: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Predicate.isObject(parsed)) return undefined;
    return parsed.name === LEGACY_THREADNOTE_PACKAGE &&
      typeof parsed.version === 'string' &&
      isNodeBasedThreadnoteVersion(parsed.version)
      ? parsed.version
      : undefined;
  } catch {
    return undefined;
  }
}

function isNodeBasedThreadnoteVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

function pipxHasOpenViking(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Predicate.isObject(parsed)) return false;
    const venvs = parsed.venvs;
    return Predicate.isObject(venvs) && EffectRecord.has(venvs, OPENVIKING_PACKAGE);
  } catch {
    return false;
  }
}

function pipPackageLocation(content: string): string | undefined {
  return Effect2.pipe(/^Location:\s*(.+)\s*$/im.exec(content)?.[1], effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
}

function isWithinHome(path: Path.Path, homeDirectory: string, candidate: string): boolean {
  const home = path.resolve(homeDirectory);
  const resolved = path.resolve(candidate);
  const relative = path.relative(home, resolved);
  return relative !== '' && !Effect2.pipe(relative, EffectString.startsWith('..')) && !path.isAbsolute(relative);
}

function withExecutableDirectoryOnPath(
  path: Path.Path,
  system: SystemInfoShape,
  executable: string,
): NodeJS.ProcessEnv {
  const environment = system.environment();
  const currentPath = Effect2.pipe(environment.PATH, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  return {
    ...environment,
    PATH: currentPath ? `${path.dirname(executable)}${system.pathDelimiter}${currentPath}` : path.dirname(executable),
  };
}

function deduplicateNpmInstallations(
  installations: readonly LegacyNpmInstallation[],
): readonly LegacyNpmInstallation[] {
  return [...new Map(EffectArray.map(installations, installation => [installation.npm, installation])).values()];
}

function deduplicateOpenVikingInstallations(
  installations: readonly LegacyOpenVikingInstallation[],
): readonly LegacyOpenVikingInstallation[] {
  return [
    ...new Map(
      EffectArray.map(installations, installation => [
        `${installation.manager}:${installation.executable}`,
        installation,
      ]),
    ).values(),
  ];
}
