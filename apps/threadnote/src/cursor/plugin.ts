import {Effect, FileSystem, Path, Predicate, Schema} from 'effect';
import {USER_INSTRUCTIONS_END_MARKER, USER_INSTRUCTIONS_START_MARKER} from '../constants.js';
import {SystemInfo} from '@threadnote/platform/system';
import type {DoctorCheck} from '../types.js';
import {errorMessage} from '@threadnote/platform/errors';
import {findExecutable, readFileIfExists} from '../utils.js';
import {expandPath} from '@threadnote/platform/paths';
import {toolRoot} from '@threadnote/workspace/installation';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

class CursorPluginError extends Schema.TaggedError<CursorPluginError, {readonly brand: unique symbol}>()(
  'CursorPluginError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

const CURSOR_PLUGIN_NAME = 'threadnote';
const CURSOR_PLUGIN_MANIFEST = '.cursor-plugin/plugin.json';
const CURSOR_PLUGIN_RULE = 'rules/threadnote.mdc';

interface CursorPluginManifest {
  readonly name: string;
  readonly version: string;
}

interface CursorAvailabilityOptions {
  readonly cursorInstalled?: boolean;
}

export const cursorPluginDoctorChecks = Effect.fn('cursorPlugin.doctorChecks')(function* (
  options: CursorAvailabilityOptions = {},
) {
  const cursorInstalled = options.cursorInstalled ?? (yield* isCursorInstalled());
  if (!cursorInstalled) return [];
  return [yield* cursorPluginDoctorCheck()];
});

export const isCursorInstalled = Effect.fn('cursorPlugin.isCursorInstalled')(function* () {
  if (yield* findExecutable(['cursor', 'cursor-agent'])) return true;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const environment = system.environment();
  const homeRelativeToTemporary = path.relative(system.tempDirectory, system.homeDirectory);
  const homeIsTemporary =
    homeRelativeToTemporary === '' ||
    (homeRelativeToTemporary !== '..' &&
      !Effect2.pipe(homeRelativeToTemporary, EffectString.startsWith(`..${path.sep}`)) &&
      !path.isAbsolute(homeRelativeToTemporary));
  const includeSystemMarkers = !homeIsTemporary;
  const markers: string[] = [];
  if (system.platform === 'darwin') {
    markers.push(
      path.join(system.homeDirectory, 'Applications', 'Cursor.app'),
      path.join(system.homeDirectory, 'Library', 'Application Support', 'Cursor'),
    );
    if (includeSystemMarkers) markers.push('/Applications/Cursor.app');
  } else if (system.platform === 'win32') {
    markers.push(
      path.join(system.homeDirectory, 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe'),
      path.join(system.homeDirectory, 'AppData', 'Roaming', 'Cursor'),
    );
    if (includeSystemMarkers) {
      for (const root of [environment.LOCALAPPDATA, environment.ProgramFiles, environment['ProgramFiles(x86)']]) {
        if (!root) continue;
        markers.push(path.join(root, 'Programs', 'cursor', 'Cursor.exe'), path.join(root, 'Cursor', 'Cursor.exe'));
      }
      if (environment.APPDATA) markers.push(path.join(environment.APPDATA, 'Cursor'));
    }
  } else if (system.platform === 'linux') {
    const configHome =
      includeSystemMarkers && environment.XDG_CONFIG_HOME
        ? environment.XDG_CONFIG_HOME
        : path.join(system.homeDirectory, '.config');
    markers.push(
      path.join(configHome, 'Cursor'),
      path.join(system.homeDirectory, '.local', 'share', 'applications', 'cursor.desktop'),
    );
    if (includeSystemMarkers) {
      markers.push('/usr/share/applications/cursor.desktop', '/opt/Cursor/cursor', '/opt/cursor/cursor');
    }
  }
  for (const marker of markers) {
    if (yield* fs.exists(marker)) return true;
  }
  return false;
});

export const isCursorMarketplacePluginInstalled = Effect.fn('cursorPlugin.isMarketplaceInstalled')(function* () {
  const root = yield* findCursorMarketplacePluginRoot();
  if (root === undefined) return false;
  return (yield* inspectCursorPluginRoot(root)).status !== 'fail';
});

const cursorPluginDoctorCheck = Effect.fn('cursorPlugin.doctorCheck')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const localRoot = yield* expandPath(`~/.cursor/plugins/local/${CURSOR_PLUGIN_NAME}`);
  if (yield* fs.exists(localRoot)) {
    return {
      detail: `unsupported local installation at ${localRoot}; remove it while Cursor is closed, then install Threadnote through the Cursor Marketplace or your team marketplace`,
      name: 'Cursor plugin',
      status: 'fail',
    } satisfies DoctorCheck;
  }

  const marketplaceRoot = yield* findCursorMarketplacePluginRoot();
  if (marketplaceRoot !== undefined) return yield* inspectCursorPluginRoot(marketplaceRoot);

  return {
    detail:
      'not installed through Cursor; install Threadnote from the Cursor Marketplace or ask your team administrator to add or allow it',
    name: 'Cursor plugin',
    status: 'warn',
  } satisfies DoctorCheck;
});

const findCursorMarketplacePluginRoot = Effect.fn('cursorPlugin.findMarketplaceRoot')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cacheRoot = yield* expandPath('~/.cursor/plugins/cache');
  if (!(yield* fs.exists(cacheRoot))) return undefined;
  const candidates: Array<{readonly manifest: CursorPluginManifest; readonly root: string}> = [];
  const entries = (yield* fs.readDirectory(cacheRoot, {recursive: true})).sort();
  for (const entry of entries) {
    if (!Effect2.pipe(normalizePath(entry), EffectString.endsWith(CURSOR_PLUGIN_MANIFEST))) continue;
    const manifestPath = path.join(cacheRoot, entry);
    const manifest = yield* readCursorPluginManifest(manifestPath).pipe(Effect.orElseSucceed(() => undefined));
    if (manifest?.name !== CURSOR_PLUGIN_NAME) continue;
    candidates.push({manifest, root: path.dirname(path.dirname(manifestPath))});
  }
  candidates.sort((left, right) => compareSemver(right.manifest.version, left.manifest.version));
  return candidates[0]?.root;
});

const inspectCursorPluginRoot = Effect.fn('cursorPlugin.inspectRoot')(function* (pluginRoot: string) {
  const path = yield* Path.Path;
  const manifestPath = path.join(pluginRoot, CURSOR_PLUGIN_MANIFEST);
  const manifest = yield* readCursorPluginManifest(manifestPath).pipe(
    Effect.mapError(cause => CursorPluginError.make({message: `${manifestPath}: ${errorMessage(cause)}`})),
  );
  if (manifest.name !== CURSOR_PLUGIN_NAME) {
    return {
      detail: `${manifestPath} declares plugin ${JSON.stringify(manifest.name)} instead of ${CURSOR_PLUGIN_NAME}`,
      name: 'Cursor plugin',
      status: 'fail',
    } satisfies DoctorCheck;
  }

  const rulePath = path.join(pluginRoot, CURSOR_PLUGIN_RULE);
  const rule = yield* readFileIfExists(rulePath);
  if (rule === undefined) {
    return {
      detail: `${rulePath} missing; reinstall the plugin through the Cursor Marketplace`,
      name: 'Cursor plugin',
      status: 'fail',
    } satisfies DoctorCheck;
  }
  const ruleProblem = cursorRuleProblem(rule);
  if (ruleProblem) {
    return {
      detail: `${rulePath} ${ruleProblem}; reinstall the plugin through the Cursor Marketplace`,
      name: 'Cursor plugin',
      status: 'fail',
    } satisfies DoctorCheck;
  }

  const bundledRoot = path.join(yield* toolRoot(), 'cursor-plugin');
  const bundledManifest = yield* readCursorPluginManifest(path.join(bundledRoot, CURSOR_PLUGIN_MANIFEST));
  const bundledRule = yield* readFileIfExists(path.join(bundledRoot, CURSOR_PLUGIN_RULE));
  if (bundledRule === undefined) {
    return yield* CursorPluginError.make({
      message: 'The standalone release is missing its bundled Cursor plugin rule.',
    });
  }
  const comparison = compareSemver(manifest.version, bundledManifest.version);
  if (comparison < 0) {
    return {
      detail: `${pluginRoot}; v${manifest.version} is older than bundled v${bundledManifest.version}; update it through the Cursor Marketplace`,
      name: 'Cursor plugin',
      status: 'warn',
    } satisfies DoctorCheck;
  }
  if (comparison === 0 && normalizeNewlines(rule) !== normalizeNewlines(bundledRule)) {
    return {
      detail: `${rulePath} differs from bundled v${bundledManifest.version}; reinstall it through the Cursor Marketplace`,
      name: 'Cursor plugin',
      status: 'fail',
    } satisfies DoctorCheck;
  }
  return {
    detail: `${pluginRoot}; v${manifest.version}; always-applied rule verified`,
    name: 'Cursor plugin',
    status: 'ok',
  } satisfies DoctorCheck;
});

const readCursorPluginManifest = Effect.fn('cursorPlugin.readManifest')(function* (manifestPath: string) {
  const raw = yield* readFileIfExists(manifestPath);
  if (raw === undefined) return yield* CursorPluginError.make({message: 'manifest is missing'});
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: cause => CursorPluginError.make({cause, message: 'manifest is not valid JSON'}),
  });
  if (
    !Predicate.isObject(parsed) ||
    typeof parsed.name !== 'string' ||
    typeof parsed.version !== 'string' ||
    !isSemver(parsed.version)
  ) {
    return yield* CursorPluginError.make({message: 'manifest must declare string name and semantic version fields'});
  }
  return {name: parsed.name, version: parsed.version};
});

function cursorRuleProblem(content: string): string | undefined {
  const normalized = normalizeNewlines(content);
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)?.[1];
  if (!frontmatter) return 'has no valid MDC frontmatter';
  if (!/^description:\s*\S.+$/m.test(frontmatter)) return 'has no non-empty description';
  if (!/^alwaysApply:\s*true\s*$/m.test(frontmatter)) return 'is not marked alwaysApply: true';
  const start = Effect2.pipe(
    normalized,
    EffectString.indexOf(USER_INSTRUCTIONS_START_MARKER),
    Effect2.Option.getOrElse(() => -1),
  );
  const end = Effect2.pipe(
    normalized,
    EffectString.indexOf(USER_INSTRUCTIONS_END_MARKER),
    Effect2.Option.getOrElse(() => -1),
  );
  if (start === -1 || end < start) return 'does not contain the complete Threadnote instruction block';
  return undefined;
}

function compareSemver(left: string, right: string): number {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  const [leftCore, leftPrerelease] = left.split('-', 2);
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  const [rightCore, rightPrerelease] = right.split('-', 2);
  const leftParts = EffectArray.map(Effect2.pipe(leftCore, EffectString.split('.')), Number);
  const rightParts = EffectArray.map(Effect2.pipe(rightCore, EffectString.split('.')), Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  if (leftPrerelease === rightPrerelease) return 0;
  if (leftPrerelease === undefined) return 1;
  if (rightPrerelease === undefined) return -1;
  return Effect2.pipe(leftPrerelease, EffectString.localeCompare(rightPrerelease));
}

function isSemver(value: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function normalizeNewlines(value: string): string {
  return Effect2.pipe(value, EffectString.replaceAll('\r\n', '\n'));
}

function normalizePath(value: string): string {
  return Effect2.pipe(value, EffectString.replaceAll('\\', '/'));
}
