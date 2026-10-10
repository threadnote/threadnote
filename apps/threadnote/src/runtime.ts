import {Effect, FileSystem, Path, PlatformError} from 'effect';
import {DEFAULT_ACCOUNT, DEFAULT_AGENT_ID, USER_MANIFEST_NAME} from './constants.js';
import {CodexCloudError, readCodexCloudProfile, sameCloudIdentity} from './codex/profile.js';
import {readCursorCloudIdentityProfile} from './cursor/profile.js';
import {expandPath} from '@threadnote/platform/paths';
import {toolRoot} from '@threadnote/workspace/installation';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';

export interface RuntimeOptions {
  readonly home?: string;
  readonly manifest?: string;
}

const EMPTY_USER_MANIFEST = 'version: 1\nprojects: []\n';

export const getRuntimeConfig = Effect.fn('runtime.getRuntimeConfig')(function* (
  options: RuntimeOptions = {},
  manifestOverride?: string,
) {
  const system = yield* SystemInfo;
  const path = yield* Path.Path;
  const environment = system.environment();
  const threadnoteHome = yield* expandPath(options.home ?? environment.THREADNOTE_HOME ?? '~/.threadnote');
  const cursorCloudProfile = yield* readCursorCloudIdentityProfile(threadnoteHome);
  const codexCloudProfile = yield* readCodexCloudProfile(threadnoteHome);
  if (cursorCloudProfile && codexCloudProfile && !sameCloudIdentity(cursorCloudProfile, codexCloudProfile)) {
    return yield* CodexCloudError.make({
      message:
        'Cursor and Codex Cloud profiles have conflicting identities. Use a separate THREADNOTE_HOME for each identity.',
    });
  }
  const cloudProfile = cursorCloudProfile ?? codexCloudProfile;
  const cloudSource = cursorCloudProfile ? ('cursor-cloud-profile' as const) : ('codex-cloud-profile' as const);
  const configuredManifest = manifestOverride ?? options.manifest ?? environment.THREADNOTE_MANIFEST;
  const selectedManifest = configuredManifest ?? (yield* defaultManifestPath(threadnoteHome));
  const manifestPath = yield* expandPath(selectedManifest);
  const manifestSource =
    configuredManifest !== undefined
      ? ('configured' as const)
      : selectedManifest === path.join(threadnoteHome, USER_MANIFEST_NAME)
        ? ('user' as const)
        : ('bundled-example' as const);
  const environmentAgentId = environment.THREADNOTE_AGENT_ID;
  const environmentUser = environment.THREADNOTE_USER;
  return {
    account: environment.THREADNOTE_ACCOUNT ?? cloudProfile?.account ?? DEFAULT_ACCOUNT,
    agentContextHome: threadnoteHome,
    agentId: environmentAgentId ?? cloudProfile?.agentId ?? DEFAULT_AGENT_ID,
    agentIdSource: environmentAgentId ? ('environment' as const) : cloudProfile ? cloudSource : ('system' as const),
    manifestPath,
    manifestSource,
    user: environmentUser ?? cloudProfile?.user ?? system.userName,
    userSource: environmentUser ? ('environment' as const) : cloudProfile ? cloudSource : ('system' as const),
  };
});

export const defaultManifestPath = Effect.fn('runtime.defaultManifestPath')(function* (agentContextHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const userManifest = pathService.join(agentContextHome, USER_MANIFEST_NAME);
  return (yield* fs.exists(userManifest)) ? userManifest : yield* builtInExampleManifestPath();
});

export const builtInExampleManifestPath = Effect.fn('runtime.builtInExampleManifestPath')(function* () {
  const pathService = yield* Path.Path;
  return pathService.join(yield* toolRoot(), 'config', 'seed-manifest.example.yaml');
});

/**
 * Select a user-owned manifest for project, graph-scope, and workset management.
 * The bundled example is a read-only compatibility fallback and must never be
 * used as a mutation target.
 */
export const ensureUserManifestRuntimeConfig = Effect.fn('runtime.ensureUserManifestRuntimeConfig')(function* (
  config: RuntimeConfig,
) {
  if (config.manifestSource !== 'bundled-example') return config;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(config.agentContextHome, USER_MANIFEST_NAME);
  yield* fs.makeDirectory(path.dirname(manifestPath), {recursive: true});
  yield* fs.writeFileString(manifestPath, EMPTY_USER_MANIFEST, {flag: 'wx', mode: 0o600}).pipe(
    Effect.catchIf(
      error => error instanceof PlatformError.PlatformError && error.reason._tag === 'AlreadyExists',
      () => Effect.void,
    ),
  );
  return {...config, manifestPath, manifestSource: 'user' as const};
});
