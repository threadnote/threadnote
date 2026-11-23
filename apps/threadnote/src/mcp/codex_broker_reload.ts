import {Array as EffectArray, Console, Effect, FileSystem, Option, Path} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {parseJsonConfigObject, isJsonObject, type JsonObject} from '@threadnote/platform/json';
import {fromPromise} from '@threadnote/platform/errors';
import {runtimeLstat, SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  activeInstalledRelease,
  installedActiveReleaseObservationPath,
  withStandaloneInstallationLock,
} from '../installations.js';
import {mcpAdapterCommand} from './adapter-command.js';
import {
  CODEX_MCP_RELEASE_ENV,
  hasActiveMcpLauncher,
  reconcileRegisteredCodexMcp,
  verifyRegisteredCodexMcp,
  type CodexMcpConfigurationTarget,
} from './codex_broker_rotation.js';

type Owner = Pick<RuntimeConfig, 'agentContextHome'>;

export interface CodexOwnerRefreshOptions {
  readonly socket: string;
  readonly threadId: string;
  readonly dryRun?: boolean;
}

const pending = (reason: string) => ({state: 'pending', reason}) as const;
const unverified = (reason: string) => ({state: 'unverified', reason}) as const;
const protocolUnavailable = 'the selected socket did not provide the supported Codex app-server protocol';
const generationChanged = 'the active release, launcher, or registered Codex settings changed during verification';
const maxMessageLength = 4 * 1024 * 1024;
const maxLoadedThreadPages = 8;

export function codexOwnerRefreshInputError(options: CodexOwnerRefreshOptions): string | undefined {
  // The native Unix WebSocket URL does not decode escaped filesystem paths.
  if (!/^\/[A-Za-z0-9_./~-]+$/u.test(options.socket)) {
    return 'Use an absolute Codex Unix socket path containing URL-safe characters.';
  }
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(options.threadId)) return 'Provide a valid loaded Codex chat ID.';
  return undefined;
}

export const runCodexOwnerRefresh = Effect.fn('mcp.codexOwnerRefresh')(
  function* (config: Owner, options: CodexOwnerRefreshOptions) {
    const inputError = codexOwnerRefreshInputError(options);
    if (inputError !== undefined) return pending(inputError);
    if (options.dryRun === true) return {state: 'dry-run'} as const;
    const system = yield* SystemInfo;
    if (system.platform === 'win32' || system.userId === undefined) {
      return pending('a private Unix control socket cannot be verified on this platform');
    }
    const socketIdentity = yield* privateSocketIdentity(options.socket);
    if (!socketIdentity) {
      return pending('select the physical Codex Unix socket in its private user-owned directory');
    }

    const bindingEffect = withStandaloneInstallationLock(
      Effect.gen(function* () {
        const release = yield* activeInstalledRelease();
        if (!release || !(yield* hasActiveMcpLauncher(release.releaseRoot))) {
          return pending('run threadnote repair to restore the active MCP launcher');
        }
        const reconciled = yield* reconcileRegisteredCodexMcp(config, release.version, {
          requireActiveMcpLauncher: true,
        });
        if (reconciled.state === 'skipped' || reconciled.state === 'deferred') return pending(reconciled.reason);
        const generation = yield* activePointerIdentity();
        return generation === undefined
          ? pending(generationChanged)
          : ({state: 'valid', reconciled, generation} as const);
      }),
    );
    const binding = yield* Effect.orElseSucceed(bindingEffect, () =>
      pending('the active release and registered Codex settings could not be verified'),
    );
    if (binding.state === 'pending') return binding;

    yield* Console.log(
      binding.reconciled.state === 'saved'
        ? 'Saved the active release marker in the registered Codex configuration.'
        : 'The registered Codex configuration already has the active release marker.',
    );
    return yield* requestReload(config, binding.reconciled, options, socketIdentity, binding.generation);
  },
  Effect.tap(result => {
    if (result.state === 'dry-run') {
      return Console.log('Would verify the selected Codex owner and request a reload of its MCP configuration.');
    }
    if (result.state === 'requested') {
      return Console.log('Codex MCP reload accepted. Broker rotation remains unverified.');
    }
    return Console.warn(
      `Codex MCP refresh ${result.state}: ${result.reason}. Refresh or restart the owning Codex app to reconnect.`,
    );
  }),
);

const privateSocketIdentity = Effect.fn('mcp.codexPrivateSocket')(function* (socket: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const {userId} = yield* SystemInfo;
  return yield* Effect.gen(function* () {
    const parent = path.dirname(socket);
    // macOS may reject realpath on a socket. Resolve the directory and verify the
    // socket itself by lstat so symbolic links never qualify.
    if (path.normalize(socket) !== socket || (yield* fs.realPath(parent)) !== parent) return undefined;
    const identity = yield* fromPromise('stat Codex socket', () => runtimeLstat(socket));
    if (
      userId === undefined ||
      !('uid' in identity) ||
      identity.uid !== BigInt(userId) ||
      (identity.mode & 0o170000n) !== 0o140000n
    ) {
      return undefined;
    }

    for (let directory = parent; ; directory = path.dirname(directory)) {
      const info = yield* fs.stat(directory);
      const owner = Option.getOrUndefined(info.uid);
      if (info.type !== 'Directory') return undefined;
      if (directory === parent) {
        if (owner !== userId || (info.mode & 0o077) !== 0) return undefined;
      } else if ((owner !== 0 && owner !== userId) || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) {
        return undefined;
      }
      if (directory === path.dirname(directory)) break;
    }
    return `${identity.dev}:${identity.ino}:${identity.ctimeNs}`;
  }).pipe(Effect.orElseSucceed(() => undefined));
});

const activePointerIdentity = Effect.fn('mcp.codexActivePointerIdentity')(function* () {
  const pointer = yield* installedActiveReleaseObservationPath();
  const info = yield* fromPromise('stat active release pointer', () => runtimeLstat(pointer));
  return info.isFile() ? `${info.dev}:${info.ino}:${info.ctimeNs}:${info.mtimeNs}` : undefined;
});

const requestReload = Effect.fn('mcp.requestCodexOwnerReload')(function* (
  config: Owner,
  target: CodexMcpConfigurationTarget,
  options: CodexOwnerRefreshOptions,
  socketIdentity: string,
  generation: string,
) {
  const path = yield* Path.Path;
  let submitted = false;
  const stillCurrent = Effect.gen(function* () {
    if ((yield* activePointerIdentity()) !== generation || !(yield* verifyRegisteredCodexMcp(config, target))) {
      return false;
    }
    const active = yield* activeInstalledRelease();
    return (
      active?.version === target.release &&
      (yield* hasActiveMcpLauncher(active.releaseRoot)) &&
      (yield* activePointerIdentity()) === generation
    );
  }).pipe(Effect.orElseSucceed(() => false));

  return yield* Effect.gen(function* () {
    const socket = yield* Effect.acquireRelease(
      Effect.try({try: () => new WebSocket(`ws+unix://${options.socket}`), catch: () => undefined}),
      connection => Effect.sync(() => connection.close()),
    );
    yield* waitForSocket(socket);
    const rpc = makeRpc(socket);
    const initialized = yield* rpc('initialize', {clientInfo: {name: 'threadnote', version: '1'}});
    if (typeof initialized.userAgent !== 'string') return pending(protocolUnavailable);
    socket.send(JSON.stringify({method: 'initialized'}));

    let cursor: string | undefined;
    let witnessed = false;
    for (let page = 0; page < maxLoadedThreadPages; page += 1) {
      const loaded: JsonObject = yield* rpc('thread/loaded/list', {cursor, limit: 100});
      if (!EffectArray.isArray(loaded.data) || !EffectArray.every(loaded.data, id => typeof id === 'string')) break;
      witnessed = loaded.data.includes(options.threadId);
      if (witnessed || typeof loaded.nextCursor !== 'string' || loaded.nextCursor === cursor) break;
      cursor = loaded.nextCursor;
    }
    if (!witnessed) return pending('the selected owner could not verify the supplied loaded chat');
    const {thread} = yield* rpc('thread/read', {threadId: options.threadId, includeTurns: false});
    if (
      !isJsonObject(thread) ||
      thread.id !== options.threadId ||
      typeof thread.cwd !== 'string' ||
      !path.isAbsolute(thread.cwd) ||
      thread.cwd.length > 4096 ||
      EffectString.includes('\0')(thread.cwd)
    ) {
      return pending('the selected owner could not verify the loaded chat’s working directory');
    }
    const command = yield* mcpAdapterCommand();
    const configuration = yield* rpc('config/read', {cwd: thread.cwd, includeLayers: true});
    if (!configurationMatches(configuration, path.join(target.hostRoot, 'config.toml'), config, target, command)) {
      return pending(
        'the loaded chat’s effective configuration does not match the registered Codex home and Threadnote entry',
      );
    }
    if ((yield* privateSocketIdentity(options.socket)) !== socketIdentity) {
      return pending('the selected Codex socket changed during verification');
    }
    if (!(yield* stillCurrent)) return pending(generationChanged);

    const reply = yield* rpc('config/mcpServer/reload', undefined, () => {
      submitted = true;
    });
    if (!(yield* stillCurrent)) return unverified(generationChanged);
    return EffectRecord.keys(reply).length === 0
      ? ({state: 'requested'} as const)
      : unverified('the owner did not provide a recognized reload acknowledgement');
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption('5 seconds'),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
    Effect.map(
      result =>
        result ??
        (submitted
          ? unverified('the request may have reached the owner, but no reload acknowledgement was verified')
          : pending(protocolUnavailable)),
    ),
  );
});

function configurationMatches(
  response: JsonObject,
  expectedConfigPath: string,
  owner: Owner,
  target: CodexMcpConfigurationTarget,
  command: readonly string[],
): boolean {
  if (!EffectArray.isArray(response.layers) || !isJsonObject(response.config)) return false;
  const userLayers = EffectArray.flatMap(response.layers, layer =>
    isJsonObject(layer) && isJsonObject(layer.name) && layer.name.type === 'user' ? [layer] : [],
  );
  const [user] = userLayers;
  if (
    userLayers.length !== 1 ||
    !user ||
    !isJsonObject(user.name) ||
    user.name.file !== expectedConfigPath ||
    user.name.profile != null ||
    user.disabledReason != null
  )
    return false;

  const servers = response.config.mcp_servers;
  const entry = isJsonObject(servers) ? servers[target.name] : undefined;
  if (
    !isJsonObject(entry) ||
    (entry.enabled !== undefined && entry.enabled !== true) ||
    entry.url != null ||
    entry.command !== command[0] ||
    !isJsonObject(entry.env)
  )
    return false;
  const args = entry.args ?? [];
  return (
    EffectArray.isArray(args) &&
    args.length === command.length - 1 &&
    EffectArray.every(args, (arg, index) => arg === command[index + 1]) &&
    entry.env.THREADNOTE_HOME === owner.agentContextHome &&
    entry.env[CODEX_MCP_RELEASE_ENV] === target.release
  );
}

function waitForSocket(socket: WebSocket) {
  return Effect.callback<void, undefined>(resume => {
    if (socket.readyState === WebSocket.OPEN) return resume(Effect.void);
    if (socket.readyState !== WebSocket.CONNECTING) return resume(Effect.fail(undefined));
    const cleanup = () => {
      socket.removeEventListener('open', open);
      socket.removeEventListener('error', failure);
      socket.removeEventListener('close', failure);
    };
    const open = () => {
      cleanup();
      resume(Effect.void);
    };
    const failure = () => {
      cleanup();
      resume(Effect.fail(undefined));
    };
    socket.addEventListener('open', open);
    socket.addEventListener('error', failure);
    socket.addEventListener('close', failure);
    return Effect.sync(cleanup);
  });
}

function makeRpc(socket: WebSocket) {
  let nextId = 0;
  return (method: string, params?: JsonObject, onSubmit?: () => void) =>
    Effect.callback<JsonObject, undefined>(resume => {
      if (socket.readyState !== WebSocket.OPEN) return resume(Effect.fail(undefined));
      const id = ++nextId;
      const cleanup = () => {
        socket.removeEventListener('message', receive);
        socket.removeEventListener('error', failure);
        socket.removeEventListener('close', failure);
      };
      const failure = () => {
        cleanup();
        resume(Effect.fail(undefined));
      };
      const receive = (event: MessageEvent<unknown>) => {
        if (typeof event.data !== 'string' || event.data.length > maxMessageLength) return failure();
        const response = parseJsonConfigObject(event.data);
        if (response?.id !== id) return;
        if (response.error !== undefined || !isJsonObject(response.result)) return failure();
        cleanup();
        resume(Effect.succeed(response.result));
      };
      socket.addEventListener('message', receive);
      socket.addEventListener('error', failure);
      socket.addEventListener('close', failure);
      try {
        onSubmit?.();
        socket.send(JSON.stringify({id, method, params}));
      } catch {
        failure();
      }
      return Effect.sync(cleanup);
    });
}
