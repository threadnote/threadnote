import {Array as EffectArray} from 'effect';
import {Console, Effect, FileSystem, Path} from 'effect';
import {parse, stringify} from 'smol-toml';
import {runCommandEffect} from '@threadnote/platform/command';
import {fromPromise} from '@threadnote/platform/errors';
import {runtimeLstat, SystemInfo, type RuntimeBigIntStats} from '@threadnote/platform/system';
import {expandPath} from '@threadnote/platform/paths';
import {findWorkingExecutable, formatShellCommand, isJsonObject} from '../utils.js';
import {
  ComposerAttachError,
  composerOAuthScopes,
  composerOAuthScopesMatch,
  THREADNOTE_ORG_MCP_NAME,
  type ComposerShareBinding,
} from './composer_attach.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODEX_ORG_MINIMUM_VERIFIED_VERSION = '0.153.4';

export function supportsCodexOrgOAuth(versionOutput: string): boolean {
  const match = /^codex(?:-cli)? (\d+)\.(\d+)\.(\d+)\s*$/u.exec(Effect2.pipe(versionOutput, EffectString.trim));
  if (!match) return false;
  const [major, minor, patch] = EffectArray.map(match.slice(1), Number);
  return major > 0 || minor > 153 || (minor === 153 && patch >= 4);
}

function parseConfig(content: string): Record<string, unknown> {
  try {
    return parse(content, {integersAsBigInt: 'asNeeded'});
  } catch {
    throw ComposerAttachError.make({
      message: 'Codex config cannot be safely extended as TOML; preserve it and configure threadnote-org manually.',
    });
  }
}

export function renderCodexOrgMcpConfig(content: string, attach: ComposerShareBinding): string {
  if (!attach.clientId) {
    throw ComposerAttachError.make({
      message: 'Codex organization attach requires an explicitly registered --composer-client-id.',
    });
  }
  const parsed = parseConfig(content);
  if (parsed.mcp_servers !== undefined && !isJsonObject(parsed.mcp_servers)) {
    throw ComposerAttachError.make({message: 'Codex mcp_servers is not a table; preserving the existing config.'});
  }
  const scopes = composerOAuthScopes(attach.additionalScopes);
  if (EffectArray.some(scopes, scope => Effect2.pipe(scope, EffectString.includes(',')))) {
    throw ComposerAttachError.make({
      message:
        'Codex native login cannot preserve a comma inside one OAuth scope token; remove that scope or configure the client manually.',
    });
  }
  const current = isJsonObject(parsed.mcp_servers) ? parsed.mcp_servers[THREADNOTE_ORG_MCP_NAME] : undefined;
  if (current !== undefined) {
    if (
      !isJsonObject(current) ||
      current.url !== attach.url ||
      !isJsonObject(current.http_headers) ||
      EffectRecord.keys(current.http_headers).length !== 1 ||
      current.http_headers['threadnote-share-id'] !== attach.shareId ||
      !isJsonObject(current.oauth) ||
      current.oauth.client_id !== attach.clientId ||
      EffectArray.some(
        EffectRecord.keys(current.oauth),
        key => !['client_id', 'callback_url', 'callback_port'].includes(key),
      ) ||
      !EffectArray.isArray(current.scopes) ||
      !EffectArray.every(current.scopes, scope => typeof scope === 'string') ||
      !composerOAuthScopesMatch(current.scopes, scopes) ||
      EffectArray.some(
        ['command', 'args', 'env', 'bearer_token', 'bearer_token_env_var', 'env_http_headers', 'oauth_resource'],
        key => key in current,
      ) ||
      (attach.callback &&
        (current.oauth.callback_url !== attach.callback.url || current.oauth.callback_port !== attach.callback.port))
    ) {
      throw ComposerAttachError.make({
        message:
          'Existing Codex threadnote-org configuration conflicts with the requested binding, scopes, or callback; preserving it. Resolve the entry manually and retry.',
      });
    }
    return content;
  }
  if (!attach.callback) {
    throw ComposerAttachError.make({
      message:
        'New Codex organization attach requires --composer-callback-url and --composer-callback-port matching the provider registration.',
    });
  }
  const addition = stringify({
    mcp_servers: {
      [THREADNOTE_ORG_MCP_NAME]: {
        url: attach.url,
        http_headers: {'threadnote-share-id': attach.shareId},
        scopes,
        oauth: {client_id: attach.clientId, callback_url: attach.callback.url, callback_port: attach.callback.port},
      },
    },
  });
  const proposed = `${content}${Effect2.pipe(content, EffectString.endsWith('\n')) || !content ? '' : '\n'}\n${addition}`;
  parseConfig(proposed);
  return proposed;
}

interface CodexConfiguration {
  readonly content: string;
  readonly info: RuntimeBigIntStats;
}

const readCodexConfiguration = Effect.fn('mcp.readCodexConfiguration')(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fromPromise('mcp.lstatCodexConfiguration', () => runtimeLstat(configPath)).pipe(
    Effect.catch(({cause}) =>
      typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'
        ? Effect.void
        : Effect.fail(
            ComposerAttachError.make({
              message: 'Cannot inspect Codex config; preserving it. Resolve filesystem access before retrying.',
            }),
          ),
    ),
  );
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) {
    return yield* ComposerAttachError.make({
      message:
        'Codex config must be a regular file; symbolic links and other file types are preserved. Configure the organization entry manually in the intended target.',
    });
  }
  if (info.size > 4n * 1024n * 1024n) {
    return yield* ComposerAttachError.make({
      message: 'Codex config exceeds the 4 MiB attach limit; configure the organization entry manually.',
    });
  }
  const content = yield* fs.readFileString(configPath).pipe(
    Effect.mapError(() =>
      ComposerAttachError.make({
        message: 'Cannot read Codex config; preserving it. Resolve filesystem access before retrying.',
      }),
    ),
  );
  return {content, info} satisfies CodexConfiguration;
});

function sameCodexConfiguration(
  before: CodexConfiguration | undefined,
  after: CodexConfiguration | undefined,
): boolean {
  if (!before || !after) return before === after;
  return (
    before.content === after.content &&
    before.info.dev === after.info.dev &&
    before.info.ino === after.info.ino &&
    before.info.mode === after.info.mode &&
    before.info.size === after.info.size &&
    before.info.mtimeNs === after.info.mtimeNs &&
    before.info.ctimeNs === after.info.ctimeNs
  );
}

export const runCodexOrgMcpInstall = Effect.fn('mcp.runCodexOrgInstall')(function* (
  attach: ComposerShareBinding,
  apply: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const codexHome = system.environment().CODEX_HOME;
  const configPath = path.join(
    codexHome ? yield* expandPath(codexHome) : path.join(system.homeDirectory, '.codex'),
    'config.toml',
  );
  const current = yield* readCodexConfiguration(configPath);
  const proposed = yield* Effect.try({
    try: () => renderCodexOrgMcpConfig(current?.content ?? '', attach),
    catch: cause =>
      ComposerAttachError.make({
        message: cause instanceof Error ? cause.message : 'Unable to validate Codex organization config.',
      }),
  });
  const login = formatShellCommand('codex', [
    'mcp',
    'login',
    THREADNOTE_ORG_MCP_NAME,
    '--scopes',
    EffectArray.join(composerOAuthScopes(attach.additionalScopes), ','),
  ]);
  if (!apply) {
    yield* Console.log(
      `Dry run. Re-run with --apply to add threadnote-org to ${configPath}. Requires Codex ${CODEX_ORG_MINIMUM_VERIFIED_VERSION} or later.\nInitial login: ${login}`,
    );
    yield* Console.log(
      proposed === current?.content
        ? 'Already configured; the existing entry will be preserved.'
        : Effect2.pipe(proposed, EffectString.slice((current?.content ?? '').length)),
    );
    return;
  }
  const executable = yield* findWorkingExecutable(['codex']);
  const version = executable
    ? yield* runCommandEffect(executable, ['--version'], {timeoutMs: 5000, maxOutputBytes: 4096})
    : undefined;
  if (!version || !supportsCodexOrgOAuth(version.stdout)) {
    return yield* ComposerAttachError.make({
      message: `Organization OAuth requires a working Codex CLI ${CODEX_ORG_MINIMUM_VERIFIED_VERSION} or later in PATH; update Codex and retry. No config was changed.`,
    });
  }
  if (proposed !== current?.content) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(configPath), {recursive: true});
        const lockPath = path.join(path.dirname(configPath), '.threadnote-org-attach.lock');
        yield* Effect.acquireRelease(
          fs.makeDirectory(lockPath).pipe(
            Effect.mapError(() =>
              ComposerAttachError.make({
                message:
                  'Codex organization attach lock is unavailable. Finish any other attach; if it crashed, inspect and remove the stale .threadnote-org-attach.lock directory before retrying.',
              }),
            ),
          ),
          () => fs.remove(lockPath, {recursive: true}).pipe(Effect.orDie),
        );
        const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
          directory: path.dirname(configPath),
          prefix: '.threadnote-org-',
        });
        const temporaryPath = path.join(temporaryDirectory, 'config.toml');
        const mode = current ? Number(current.info.mode & 0o777n) : 0o600;
        yield* fs.writeFileString(temporaryPath, proposed, {mode});
        yield* fs.chmod(temporaryPath, mode);
        if (!sameCodexConfiguration(current, yield* readCodexConfiguration(configPath))) {
          return yield* ComposerAttachError.make({
            message: 'Codex config changed during attach; preserving the concurrent edit. Retry the command.',
          });
        }
        yield* fs.rename(temporaryPath, configPath);
      }),
    );
    yield* Console.log(`Added Codex threadnote-org: ${configPath}`);
  } else {
    yield* Console.log(`Already configured: ${configPath}`);
  }
  yield* Console.log(
    `Initial login: ${login}\nNative Codex manages OAuth credentials. Verify reconnect and refresh with your provider.`,
  );
});
