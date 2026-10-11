import {dlopen} from 'bun:ffi';
import {Clock, Console, Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {createRemoteAccessTokenVerifier, type AccessTokenClaims} from '@threadnote/protocol/access-token';
import {fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {toolRoot} from '@threadnote/workspace/installation';
import {readBoundedPrivateBytes, writePrivateJsonFile} from '../atomic.js';
import {GraphControlCredentialConfiguration} from '../control/credentials.js';
import {configureRegistryReaderDockerHelper} from './user_registry_docker.js';
import {sha256Digest} from '../digest.js';
import {graphSharingFailure, graphSharingUnavailable} from '../errors.js';
import {graphSharingLayout} from '../layout.js';

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Config = Schema.Struct({
  audience: Text,
  clientId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,128}$/u)),
  coordinatorUrl: Text,
  issuer: Text,
  organization: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u)),
  schemaVersion: Schema.Literal(1),
  subject: Schema.optionalKey(Text),
});
const Configs = Schema.Struct({
  bindings: Schema.Array(Config).check(Schema.isMaxLength(32)),
  schemaVersion: Schema.Literal(1),
});
const Credential = Schema.Struct({
  accessToken: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~+/-]+=*$/u), Schema.isMaxLength(16_384)),
  audience: Text,
  clientId: Text,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  issuer: Text,
  refreshToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  schemaVersion: Schema.Literal(1),
  scopes: Schema.Array(Text).check(Schema.isMaxLength(32)),
  subject: Text,
});
export const Auth0HelperInput = Schema.Struct({
  audience: Text,
  coordinatorUrl: Text,
  interactive: Schema.Literal(false),
  issuer: Text,
  organization: Config.fields.organization,
  profileDigest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u)),
  repositoryId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  schemaVersion: Schema.Literal(1),
  scopes: Schema.Array(Schema.Literals(['graph:read', 'graph:contribute'])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1),
  ),
});
const STRICT = {onExcessProperty: 'error'} as const;
const SCOPES = ['graph:read', 'graph:contribute'] as const;
const REGISTRY_SCOPES = ['registry:read'] as const;
type CredentialTarget = 'graph' | 'registry';
type Auth0Config = typeof Config.Type;
type StoredCredential = typeof Credential.Type;

export interface Auth0UserBackend {
  readonly read: (account: string) => Effect.Effect<string | undefined, unknown>;
  readonly write: (account: string, value: string) => Effect.Effect<void, unknown>;
  readonly remove: (account: string) => Effect.Effect<void, unknown>;
  readonly post: (
    config: Auth0Config,
    endpoint: 'device' | 'token',
    form: Readonly<Record<string, string>>,
  ) => Effect.Effect<{readonly status: number; readonly body: unknown}, unknown>;
  readonly verify: (config: Auth0Config, accessToken: string) => Effect.Effect<AccessTokenClaims, unknown>;
}

export const configureGraphAuth0User = Effect.fn('codeGraph.sharing.configureAuth0User')(function* (
  config: RuntimeConfig,
  input: Omit<Auth0Config, 'schemaVersion'>,
) {
  const validated = yield* Schema.decodeEffect(
    Config,
    STRICT,
  )({...input, schemaVersion: 1}).pipe(
    Effect.mapError(() => graphSharingFailure('Graph Auth0 configuration is invalid.')),
  );
  if (!validUrl(validated.coordinatorUrl) || !validUrl(validated.audience) || !validIssuer(validated.issuer))
    return yield* graphSharingFailure('Graph Auth0 URLs must be exact canonical HTTPS URLs.');
  if (
    (yield* readConfigs(config.agentContextHome, 'registry')).some(binding => binding.audience === validated.audience)
  )
    return yield* graphSharingFailure('Graph Auth0 audience must differ from the registry audience.');
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = graphSharingLayout(path, config.agentContextHome).root;
  const bindingPath = path.join(root, 'control-credentials.json');
  const existingAuth0 = yield* readConfigs(config.agentContextHome);
  let bindings: (typeof GraphControlCredentialConfiguration.Type)['bindings'] = [];
  if (yield* fs.exists(bindingPath)) {
    const bytes = yield* readBoundedPrivateBytes(bindingPath, 65_536);
    const existing = yield* Schema.decodeEffect(
      Schema.fromJsonString(GraphControlCredentialConfiguration),
      STRICT,
    )(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError(() => graphSharingFailure('Existing graph credential bindings are invalid.')),
    );
    bindings = existing.bindings;
  }
  const match = bindings.find(
    binding => binding.coordinatorUrl === validated.coordinatorUrl && binding.organization === validated.organization,
  );
  if (match !== undefined && match.helper !== 'auth0')
    return yield* graphSharingFailure('The graph credential binding already uses another helper.');
  const next = bindings.filter(
    binding => binding.coordinatorUrl !== validated.coordinatorUrl || binding.organization !== validated.organization,
  );
  if (next.length >= 32) return yield* graphSharingFailure('Graph credential binding capacity is full.');
  const nextAuth0 = existingAuth0.filter(
    binding => binding.coordinatorUrl !== validated.coordinatorUrl || binding.organization !== validated.organization,
  );
  if (nextAuth0.length >= 32) return yield* graphSharingFailure('Graph Auth0 configuration capacity is full.');
  yield* writePrivateJsonFile(path.join(root, 'auth0-user.json'), {
    bindings: [...nextAuth0, validated],
    schemaVersion: 1,
  });
  yield* writePrivateJsonFile(bindingPath, {
    bindings: [
      ...next,
      {
        audience: validated.audience,
        coordinatorUrl: validated.coordinatorUrl,
        helper: 'auth0',
        issuer: validated.issuer,
        organization: validated.organization,
      },
    ],
    schemaVersion: 1,
  });
  return {configured: true};
});

/** A registry login is a separate audience and Keychain account from graph control. */
export const configureRegistryAuth0User = Effect.fn('codeGraph.sharing.configureRegistryAuth0User')(function* (
  config: RuntimeConfig,
  input: {
    readonly audience: string;
    readonly clientId: string;
    readonly issuer: string;
    readonly organization: string;
    readonly origin: string;
    readonly subject: string;
  },
) {
  const validated = yield* Schema.decodeEffect(
    Config,
    STRICT,
  )({
    audience: input.audience,
    clientId: input.clientId,
    coordinatorUrl: input.origin,
    issuer: input.issuer,
    organization: input.organization,
    schemaVersion: 1,
    subject: input.subject,
  }).pipe(Effect.mapError(() => graphSharingFailure('Registry Auth0 configuration is invalid.')));
  if (
    !validIssuer(validated.issuer) ||
    !validUrl(validated.coordinatorUrl) ||
    new URL(validated.coordinatorUrl).origin !== validated.coordinatorUrl ||
    validated.audience !== validated.coordinatorUrl ||
    !/^[A-Za-z0-9._|@:/+-]{1,512}$/u.test(validated.subject ?? '')
  )
    return yield* graphSharingFailure('Registry Auth0 authority must use an exact HTTPS origin and subject.');
  if ((yield* readConfigs(config.agentContextHome)).some(binding => binding.audience === validated.audience))
    return yield* graphSharingFailure('Registry Auth0 audience must differ from graph control.');
  const existing = yield* readConfigs(config.agentContextHome, 'registry');
  if (
    existing.some(
      binding => binding.coordinatorUrl === validated.coordinatorUrl && binding.organization !== validated.organization,
    )
  )
    return yield* graphSharingFailure('Registry Auth0 origin is already bound to another organization.');
  const next = existing.filter(binding => binding.coordinatorUrl !== validated.coordinatorUrl);
  if (next.length >= 32) return yield* graphSharingFailure('Registry Auth0 configuration capacity is full.');
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const destination = path.join(graphSharingLayout(path, config.agentContextHome).root, 'auth0-user-registry.json');
  if (Option.isSome(yield* fs.readLink(destination).pipe(Effect.option)))
    return yield* graphSharingFailure('Registry Auth0 binding must not be a symbolic link.');
  const crypto = yield* Crypto.Crypto;
  const staged = `${destination}.${yield* crypto.randomUUIDv4()}.pending`;
  yield* writePrivateJsonFile(staged, {bindings: [...next, validated], schemaVersion: 1});
  // Stage the binding first; Docker conflicts leave it unpublished, and a retry can reuse an installed helper.
  yield* Effect.gen(function* () {
    yield* configureRegistryReaderDockerHelper(validated.coordinatorUrl);
    yield* fs
      .rename(staged, destination)
      .pipe(
        Effect.mapError(() =>
          graphSharingFailure(
            'Registry Auth0 binding could not be saved. Docker helper may be configured; retry setup.',
          ),
        ),
      );
  }).pipe(Effect.ensuring(fs.remove(staged, {force: true}).pipe(Effect.ignore)));
  return {configured: true};
});

export const loginRegistryAuth0User = Effect.fn('codeGraph.sharing.loginRegistryAuth0User')(
  (
    home: string,
    backendOverride?: Auth0UserBackend,
    selector?: {readonly coordinatorUrl: string; readonly organization: string},
  ) => loginGraphAuth0User(home, backendOverride, selector, 'registry'),
);

export const logoutRegistryAuth0User = Effect.fn('codeGraph.sharing.logoutRegistryAuth0User')(
  (
    home: string,
    backendOverride?: Auth0UserBackend,
    selector?: {readonly coordinatorUrl: string; readonly organization: string},
  ) => logoutGraphAuth0User(home, backendOverride, selector, 'registry'),
);

export const loginGraphAuth0User = Effect.fn('codeGraph.sharing.loginAuth0User')(function* (
  home: string,
  backendOverride?: Auth0UserBackend,
  selector?: {readonly coordinatorUrl: string; readonly organization: string},
  target: CredentialTarget = 'graph',
) {
  const config = yield* readConfig(home, selector, target);
  const scopes = target === 'registry' ? REGISTRY_SCOPES : SCOPES;
  const backend: Auth0UserBackend = backendOverride ?? (yield* makeBackend());
  const response = yield* backend
    .post(config, 'device', {
      audience: config.audience,
      client_id: config.clientId,
      scope: `offline_access ${scopes.join(' ')}`,
    })
    .pipe(Effect.mapError(() => graphSharingUnavailable('Auth0 device authorization is unavailable.')));
  const device = parseDeviceResponse(response, config.issuer);
  if (device === undefined) return yield* graphSharingFailure('Auth0 device authorization response is invalid.');
  yield* Console.log(`Open ${device.verificationUri} and enter code ${device.userCode}`);
  const started = yield* Clock.currentTimeMillis;
  let interval = device.interval * 1000;
  for (;;) {
    yield* Effect.sleep(interval);
    if ((yield* Clock.currentTimeMillis) - started >= device.expiresIn * 1000)
      return yield* graphSharingUnavailable('Auth0 device authorization expired; run login again.');
    const result = yield* backend
      .post(config, 'token', {
        client_id: config.clientId,
        device_code: device.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
      .pipe(Effect.mapError(() => graphSharingUnavailable('Auth0 device authorization is unavailable.')));
    if (result.status === 200) {
      const credential = yield* verifiedCredential(config, result.body, backend, target);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lockPath = auth0LockPath(path, home, config);
      yield* withExclusiveFileLock(
        fs,
        lockPath,
        lockOptions,
        backend.write(account(home, config), JSON.stringify(credential)),
      );
      return {authenticated: true, subject: credential.subject};
    }
    const error = isRecord(result.body) ? result.body.error : undefined;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval = Math.min(interval + 5_000, 30_000);
      continue;
    }
    return yield* graphSharingUnavailable('Auth0 device authorization was denied or expired.');
  }
});

export const getGraphAuth0UserCredential = Effect.fn('codeGraph.sharing.getAuth0UserCredential')(function* (
  home: string,
  rawInput: unknown,
  backendOverride?: Auth0UserBackend,
) {
  const input = yield* Schema.decodeUnknownEffect(
    Auth0HelperInput,
    STRICT,
  )(rawInput).pipe(Effect.mapError(() => graphSharingFailure('Graph Auth0 helper request is invalid.')));
  const config = yield* readConfig(home, {coordinatorUrl: input.coordinatorUrl, organization: input.organization});
  if (
    input.issuer !== config.issuer ||
    input.audience !== config.audience ||
    input.coordinatorUrl !== config.coordinatorUrl ||
    input.organization !== config.organization
  )
    return yield* graphSharingFailure('Graph Auth0 helper request is outside configured authority.');
  return yield* getStoredAuth0UserCredential(home, config, input.scopes[0], 'graph', backendOverride);
});

export const getRegistryAuth0UserCredential = Effect.fn('codeGraph.sharing.getRegistryAuth0UserCredential')(function* (
  home: string,
  server: string,
  backendOverride?: Auth0UserBackend,
) {
  const configs = yield* readConfigs(home, 'registry');
  const config = configs.find(item => new URL(item.coordinatorUrl).host === server);
  if (config === undefined || server !== new URL(config.coordinatorUrl).host)
    return yield* graphSharingFailure('Registry Auth0 helper request is outside configured authority.');
  return yield* getStoredAuth0UserCredential(home, config, 'registry:read', 'registry', backendOverride);
});

const getStoredAuth0UserCredential = Effect.fn('codeGraph.sharing.getStoredAuth0UserCredential')(function* (
  home: string,
  config: Auth0Config,
  scope: string,
  target: CredentialTarget,
  backendOverride?: Auth0UserBackend,
) {
  const backend: Auth0UserBackend = backendOverride ?? (yield* makeBackend());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = auth0LockPath(path, home, config);
  const credential = yield* withExclusiveFileLock(
    fs,
    lockPath,
    lockOptions,
    Effect.gen(function* () {
      const stored = yield* backend
        .read(account(home, config))
        .pipe(Effect.mapError(() => graphSharingUnavailable('Auth0 Keychain credentials are unavailable.')));
      if (stored === undefined) return yield* graphSharingUnavailable('Auth0 login is required.');
      const parsed = yield* Effect.try({
        try: () => JSON.parse(stored) as unknown,
        catch: () => graphSharingFailure('Auth0 Keychain credentials are invalid.'),
      });
      if (isRecord(parsed) && parsed.state === 'refreshing')
        return yield* graphSharingUnavailable('Auth0 refresh was interrupted; run login again.');
      const current = yield* Schema.decodeUnknownEffect(
        Credential,
        STRICT,
      )(parsed).pipe(Effect.mapError(() => graphSharingFailure('Auth0 Keychain credentials are invalid.')));
      if (
        current.issuer !== config.issuer ||
        current.audience !== config.audience ||
        current.clientId !== config.clientId ||
        (config.subject !== undefined && current.subject !== config.subject)
      )
        return yield* graphSharingFailure('Auth0 Keychain credentials have different authority.');
      if (
        !current.scopes.includes(scope) ||
        (target === 'registry' && current.scopes.some(item => item.startsWith('registry:') && item !== scope))
      )
        return yield* graphSharingFailure('Auth0 token lacks the requested scope.');
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      if (current.expiresAt > now + 60 && (target === 'graph' || current.expiresAt <= now + 600)) return current;
      yield* backend
        .write(account(home, config), JSON.stringify({schemaVersion: 1, state: 'refreshing'}))
        .pipe(Effect.mapError(() => graphSharingUnavailable('Auth0 Keychain update failed; run login again.')));
      const response = yield* backend
        .post(config, 'token', {
          client_id: config.clientId,
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
        })
        .pipe(Effect.mapError(() => graphSharingUnavailable('Auth0 refresh is unavailable.')));
      if (response.status !== 200) return yield* graphSharingUnavailable('Auth0 session expired; run login again.');
      const next = yield* verifiedCredential(config, response.body, backend, target, current);
      if (!next.scopes.includes(scope))
        return yield* graphSharingFailure('Refreshed Auth0 token lacks the requested graph scope.');
      yield* backend
        .write(account(home, config), JSON.stringify(next))
        .pipe(Effect.mapError(() => graphSharingUnavailable('Auth0 Keychain update failed; run login again.')));
      return next;
    }),
  ).pipe(Effect.catchIf(isFileLockTimeout, () => graphSharingUnavailable('Auth0 refresh is busy.')));
  return {
    accessToken: credential.accessToken,
    audience: credential.audience,
    expiresAt: credential.expiresAt,
    issuer: credential.issuer,
    schemaVersion: 1 as const,
    subject: credential.subject,
  };
});

export const logoutGraphAuth0User = Effect.fn('codeGraph.sharing.logoutAuth0User')(function* (
  home: string,
  backendOverride?: Auth0UserBackend,
  selector?: {readonly coordinatorUrl: string; readonly organization: string},
  target: CredentialTarget = 'graph',
) {
  const config = yield* readConfig(home, selector, target);
  const backend: Auth0UserBackend = backendOverride ?? (yield* makeBackend());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* withExclusiveFileLock(
    fs,
    auth0LockPath(path, home, config),
    lockOptions,
    backend
      .remove(account(home, config))
      .pipe(Effect.mapError(() => graphSharingUnavailable('Auth0 Keychain credentials are unavailable.'))),
  );
});

const lockOptions = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 60_000,
  waitTimeoutMilliseconds: 3_000,
} as const;

function account(home: string, config: Auth0Config): string {
  return sha256Digest(
    JSON.stringify([home, config.issuer, config.audience, config.clientId, config.coordinatorUrl, config.organization]),
  ).slice(7);
}

function auth0LockPath(path: Path.Path, home: string, config: Auth0Config): string {
  return path.join(graphSharingLayout(path, home).root, `auth0-user.${account(home, config)}.lock`);
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      url.search === '' &&
      /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?\/?$/u.test(url.pathname) &&
      (url.href === value || (url.pathname === '/' && url.href === value + '/'))
    );
  } catch {
    return false;
  }
}

function validIssuer(value: string): boolean {
  if (!validUrl(value)) return false;
  const url = new URL(value);
  return url.pathname === '/' && url.href === value;
}

const readConfigs = Effect.fn('codeGraph.sharing.readAuth0UserConfigs')(function* (
  home: string,
  target: CredentialTarget = 'graph',
) {
  const label = target === 'registry' ? 'Registry Auth0' : 'Graph Auth0';
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filename = path.join(
    graphSharingLayout(path, home).root,
    target === 'graph' ? 'auth0-user.json' : 'auth0-user-registry.json',
  );
  if (!(yield* fs.exists(filename))) return [] as ReadonlyArray<Auth0Config>;
  const bytes = yield* readBoundedPrivateBytes(filename, 65_536);
  const configs = yield* Schema.decodeEffect(
    Schema.fromJsonString(Configs),
    STRICT,
  )(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError(() => graphSharingFailure(`${label} configuration is invalid.`)),
  );
  if (
    configs.bindings.some(
      config =>
        !validUrl(config.coordinatorUrl) ||
        !validUrl(config.audience) ||
        !validIssuer(config.issuer) ||
        (target === 'registry' &&
          (new URL(config.coordinatorUrl).origin !== config.coordinatorUrl ||
            config.audience !== config.coordinatorUrl ||
            config.subject === undefined)),
    ) ||
    new Set(configs.bindings.map(config => JSON.stringify([config.coordinatorUrl, config.organization]))).size !==
      configs.bindings.length ||
    (target === 'registry' &&
      new Set(configs.bindings.map(config => config.coordinatorUrl)).size !== configs.bindings.length)
  )
    return yield* graphSharingFailure(`${label} configuration has invalid URLs.`);
  return configs.bindings;
});

const readConfig = Effect.fn('codeGraph.sharing.readAuth0UserConfig')(function* (
  home: string,
  selector?: {readonly coordinatorUrl: string; readonly organization: string},
  target: CredentialTarget = 'graph',
) {
  const bindings = yield* readConfigs(home, target);
  const label = target === 'registry' ? 'Registry Auth0' : 'Graph Auth0';
  if (bindings.length === 0) return yield* graphSharingUnavailable(`${label} setup is required.`);
  if (selector === undefined) {
    if (bindings.length !== 1)
      return yield* graphSharingFailure(
        target === 'registry'
          ? 'Select a registry with --origin and --organization.'
          : 'Select a graph organization with --coordinator and --organization.',
      );
    return bindings[0];
  }
  const selected = bindings.find(
    config => config.coordinatorUrl === selector.coordinatorUrl && config.organization === selector.organization,
  );
  if (selected === undefined) return yield* graphSharingFailure(`${label} organization is not configured.`);
  return selected;
});

function parseDeviceResponse(response: {readonly status: number; readonly body: unknown}, issuer: string) {
  if (response.status !== 200 || !isRecord(response.body)) return undefined;
  const body = response.body;
  if (
    !boundedText(body.device_code, 2_048) ||
    !boundedText(body.user_code, 128) ||
    !boundedText(body.verification_uri, 512) ||
    !Number.isSafeInteger(body.expires_in) ||
    Number(body.expires_in) < 30 ||
    Number(body.expires_in) > 900
  )
    return undefined;
  const interval = body.interval === undefined ? 5 : body.interval;
  if (!Number.isSafeInteger(interval) || Number(interval) < 1 || Number(interval) > 30) return undefined;
  try {
    const uri = new URL(body.verification_uri);
    if (uri.protocol !== 'https:' || uri.origin !== new URL(issuer).origin || uri.username || uri.password || uri.hash)
      return undefined;
  } catch {
    return undefined;
  }
  return {
    deviceCode: body.device_code,
    expiresIn: Number(body.expires_in),
    interval: Number(interval),
    userCode: body.user_code,
    verificationUri: body.verification_uri,
  };
}

const verifiedCredential = Effect.fn('codeGraph.sharing.verifyAuth0Credential')(function* (
  config: Auth0Config,
  raw: unknown,
  backend: Auth0UserBackend,
  target: CredentialTarget,
  previous?: StoredCredential,
) {
  if (!isRecord(raw) || raw.token_type !== 'Bearer' || !boundedText(raw.access_token, 16_384))
    return yield* graphSharingFailure('Auth0 did not return a usable graph credential.');
  const refreshToken = raw.refresh_token === undefined ? previous?.refreshToken : raw.refresh_token;
  if (!boundedText(refreshToken, 16_384))
    return yield* graphSharingFailure('Auth0 did not return a usable graph credential.');
  const claims = yield* backend
    .verify(config, raw.access_token)
    .pipe(Effect.mapError(() => graphSharingFailure('Auth0 access token could not be verified.')));
  if (
    claims.issuer !== config.issuer ||
    claims.subject.length > 512 ||
    (previous !== undefined && claims.subject !== previous.subject) ||
    (config.subject !== undefined && claims.subject !== config.subject) ||
    !(target === 'registry' ? REGISTRY_SCOPES : SCOPES).every(scope => claims.scopes.has(scope)) ||
    (target === 'registry' &&
      [...claims.scopes].some(scope => scope.startsWith('registry:') && scope !== 'registry:read'))
  )
    return yield* graphSharingFailure('Auth0 token lacks the configured identity or scopes.');
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  if (claims.expiresAt <= now + 60) return yield* graphSharingFailure('Auth0 token expires too soon.');
  if (target === 'registry' && claims.expiresAt > now + 600)
    return yield* graphSharingFailure('Auth0 registry token lifetime exceeds the configured limit.');
  return {
    accessToken: raw.access_token,
    audience: config.audience,
    clientId: config.clientId,
    expiresAt: claims.expiresAt,
    issuer: config.issuer,
    refreshToken,
    schemaVersion: 1 as const,
    scopes: [...claims.scopes],
    subject: claims.subject,
  } satisfies StoredCredential;
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n]/u.test(value);
}

const makeBackend = Effect.fn('codeGraph.sharing.makeAuth0UserBackend')(function* () {
  const system = yield* SystemInfo;
  if (system.platform !== 'darwin') return yield* graphSharingUnavailable('Auth0 login requires macOS Keychain.');
  const path = yield* Path.Path;
  const root = yield* toolRoot();
  const libraryPath = path.join(
    root,
    typeof THREADNOTE_STANDALONE !== 'undefined' && THREADNOTE_STANDALONE ? 'runtime' : 'dist/runtime',
    'graph-keychain.dylib',
  );
  const library = yield* Effect.try({
    try: () =>
      dlopen(libraryPath, {
        tn_graph_keychain_get: {args: ['buffer', 'u32', 'buffer', 'u32', 'buffer'], returns: 'i32'},
        tn_graph_keychain_put: {args: ['buffer', 'u32', 'buffer', 'u32'], returns: 'i32'},
        tn_graph_keychain_delete: {args: ['buffer', 'u32'], returns: 'i32'},
      }),
    catch: () => graphSharingUnavailable('Auth0 Keychain library is unavailable.'),
  });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const backend: Auth0UserBackend = {
    read: account =>
      Effect.try({
        try: () => {
          const accountBytes = encoder.encode(account);
          const output = new Uint8Array(65_536);
          const length = new Uint32Array(1);
          const status = library.symbols.tn_graph_keychain_get(
            accountBytes,
            accountBytes.length,
            output,
            output.length,
            length,
          );
          if (status === -25_300) return undefined;
          if (status !== 0 || length[0] > output.length) throw new Error('keychain-read');
          return decoder.decode(output.subarray(0, length[0]));
        },
        catch: () => graphSharingUnavailable('Auth0 Keychain read failed.'),
      }),
    write: (account, value) =>
      Effect.try({
        try: () => {
          const accountBytes = encoder.encode(account);
          const valueBytes = encoder.encode(value);
          if (
            library.symbols.tn_graph_keychain_put(accountBytes, accountBytes.length, valueBytes, valueBytes.length) !==
            0
          )
            throw new Error('keychain-write');
        },
        catch: () => graphSharingUnavailable('Auth0 Keychain update failed.'),
      }),
    remove: account =>
      Effect.try({
        try: () => {
          const accountBytes = encoder.encode(account);
          if (library.symbols.tn_graph_keychain_delete(accountBytes, accountBytes.length) !== 0)
            throw new Error('keychain-delete');
        },
        catch: () => graphSharingUnavailable('Auth0 Keychain removal failed.'),
      }),
    post: (config, endpoint, form) => postAuth0(config, endpoint, form),
    verify: (config, accessToken) =>
      fromPromiseInterruptibleAwaiting(
        () =>
          createRemoteAccessTokenVerifier({
            audience: config.audience,
            issuer: config.issuer,
            jwksUrl: new URL('.well-known/jwks.json', config.issuer),
          })(accessToken),
        () => graphSharingFailure('Auth0 access token could not be verified.'),
      ),
  };
  return backend;
});

function postAuth0(config: Auth0Config, endpoint: 'device' | 'token', form: Readonly<Record<string, string>>) {
  return fromPromiseInterruptibleAwaiting(
    async signal => {
      const url = new URL(endpoint === 'device' ? 'oauth/device/code' : 'oauth/token', config.issuer);
      const response = await fetch(url, {
        body: new URLSearchParams(form),
        cache: 'no-store',
        credentials: 'omit',
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('missing-body');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.length;
        if (bytes > 32_768) throw new Error('oversized-body');
        chunks.push(item.value);
      }
      const body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
      return {status: response.status, body};
    },
    () => graphSharingUnavailable('Auth0 token endpoint is unavailable.'),
  );
}
