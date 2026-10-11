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
import {configureOAuthRegistryReaderDockerHelper} from './user_registry_docker.js';
import {sha256Digest} from '../digest.js';
import {graphSharingFailure, graphSharingUnavailable} from '../errors.js';
import {graphSharingLayout} from '../layout.js';
import {canonicalOAuthUrl, sameOriginOAuthEndpoint} from './m2m_config.js';

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const ClientId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,128}$/u));
const ClientIdClaim = Schema.Literals(['azp', 'client_id', 'cid', 'azp-or-client_id']);
const CredentialAccountVersion = Schema.Literals(['legacy-auth0-v1', 'oauth-v2']);
const Config = Schema.Struct({
  audience: Text,
  audienceParameter: Schema.optionalKey(Text),
  clientId: ClientId,
  clientIdClaim: ClientIdClaim,
  coordinatorUrl: Text,
  credentialAccountVersion: CredentialAccountVersion,
  deviceAuthorizationUrl: Text,
  issuer: Text,
  jwksUrl: Text,
  organization: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u)),
  previousCredentialAccountVersion: Schema.optionalKey(Schema.Literal('legacy-auth0-v1')),
  schemaVersion: Schema.Literal(2),
  subject: Schema.optionalKey(Text),
  tokenUrl: Text,
});
const Configs = Schema.Struct({
  bindings: Schema.Array(Config).check(Schema.isMaxLength(32)),
  schemaVersion: Schema.Literal(2),
});
const LegacyConfig = Schema.Struct({
  audience: Text,
  clientId: ClientId,
  coordinatorUrl: Text,
  issuer: Text,
  organization: Config.fields.organization,
  schemaVersion: Schema.Literal(1),
  subject: Schema.optionalKey(Text),
});
const LegacyConfigs = Schema.Struct({
  bindings: Schema.Array(LegacyConfig).check(Schema.isMaxLength(32)),
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
export const OAuthUserHelperInput = Schema.Struct({
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
type OAuthUserConfig = typeof Config.Type;
type StoredCredential = typeof Credential.Type;

export interface OAuthUserConfigureOptions {
  readonly profile?: 'generic' | 'legacy-auth0';
}

export interface OAuthUserConfigureInput {
  readonly audience: string;
  readonly audienceParameter?: string;
  readonly clientId: string;
  readonly clientIdClaim: 'azp' | 'client_id' | 'cid' | 'azp-or-client_id';
  readonly coordinatorUrl: string;
  readonly deviceAuthorizationUrl: string;
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly organization: string;
  readonly subject?: string;
  readonly tokenUrl: string;
}

export interface OAuthUserBackend {
  readonly read: (account: string) => Effect.Effect<string | undefined, unknown>;
  readonly write: (account: string, value: string) => Effect.Effect<void, unknown>;
  readonly remove: (account: string) => Effect.Effect<void, unknown>;
  readonly post: (
    config: OAuthUserConfig,
    endpoint: 'device' | 'token',
    form: Readonly<Record<string, string>>,
  ) => Effect.Effect<{readonly status: number; readonly body: unknown}, unknown>;
  readonly verify: (config: OAuthUserConfig, accessToken: string) => Effect.Effect<AccessTokenClaims, unknown>;
}

export const configureGraphOAuthUser = Effect.fn('codeGraph.sharing.configureOAuthUser')(function* (
  config: RuntimeConfig,
  input: OAuthUserConfigureInput,
  options: OAuthUserConfigureOptions = {},
) {
  const validated = yield* Schema.decodeEffect(
    Config,
    STRICT,
  )({...input, credentialAccountVersion: 'oauth-v2', schemaVersion: 2}).pipe(
    Effect.mapError(() => graphSharingFailure('Graph OAuth configuration is invalid.')),
  );
  if (
    !validProviderConfig(validated) ||
    !canonicalOAuthUrl(validated.coordinatorUrl) ||
    !canonicalOAuthUrl(validated.audience)
  )
    return yield* graphSharingFailure('Graph OAuth URLs must be exact canonical HTTPS URLs.');
  if (options.profile === 'legacy-auth0' && !isLegacyAuth0Profile(validated))
    return yield* graphSharingFailure('Legacy Auth0 setup requires the legacy provider profile.');
  if (
    (yield* readConfigs(config.agentContextHome, 'registry')).some(binding => binding.audience === validated.audience)
  )
    return yield* graphSharingFailure('Graph OAuth audience must differ from the registry audience.');
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = graphSharingLayout(path, config.agentContextHome).root;
  const genericConfigPath = path.join(root, 'oauth-user.json');
  if (options.profile === 'legacy-auth0' && (yield* fs.exists(genericConfigPath)))
    return yield* graphSharingFailure('Generic OAuth setup already exists; supply explicit provider endpoint flags.');
  const bindingPath = path.join(root, 'control-credentials.json');
  const existingOAuth = yield* readConfigs(config.agentContextHome);
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
  const helper = options.profile === 'legacy-auth0' ? 'auth0' : 'oauth';
  if (
    match !== undefined &&
    (options.profile === 'legacy-auth0'
      ? match.helper !== 'auth0'
      : match.helper !== 'auth0' && match.helper !== 'oauth')
  )
    return yield* graphSharingFailure('The graph credential binding already uses another helper.');
  const next = bindings.filter(
    binding => binding.coordinatorUrl !== validated.coordinatorUrl || binding.organization !== validated.organization,
  );
  if (next.length >= 32) return yield* graphSharingFailure('Graph credential binding capacity is full.');
  const nextOAuth = existingOAuth.filter(
    binding => binding.coordinatorUrl !== validated.coordinatorUrl || binding.organization !== validated.organization,
  );
  if (nextOAuth.length >= 32) return yield* graphSharingFailure('Graph OAuth configuration capacity is full.');
  const replaced = existingOAuth.find(
    binding => binding.coordinatorUrl === validated.coordinatorUrl && binding.organization === validated.organization,
  );
  if (options.profile === 'legacy-auth0') {
    yield* writePrivateJsonFile(path.join(root, 'auth0-user.json'), {
      bindings: [...nextOAuth.map(legacyStoredConfig), legacyStoredConfig(validated)],
      schemaVersion: 1,
    });
  } else {
    const persisted =
      replaced?.credentialAccountVersion === 'legacy-auth0-v1' ||
      replaced?.previousCredentialAccountVersion === 'legacy-auth0-v1'
        ? {...validated, previousCredentialAccountVersion: 'legacy-auth0-v1' as const}
        : validated;
    yield* writePrivateJsonFile(genericConfigPath, {
      bindings: [...nextOAuth, persisted],
      schemaVersion: 2,
    });
  }
  yield* writePrivateJsonFile(bindingPath, {
    bindings: [
      ...next,
      {
        audience: validated.audience,
        coordinatorUrl: validated.coordinatorUrl,
        helper,
        issuer: validated.issuer,
        organization: validated.organization,
      },
    ],
    schemaVersion: 1,
  });
  return {configured: true};
});

/** A registry login is a separate audience and Keychain account from graph control. */
export const configureRegistryOAuthUser = Effect.fn('codeGraph.sharing.configureRegistryOAuthUser')(function* (
  config: RuntimeConfig,
  input: Omit<OAuthUserConfigureInput, 'coordinatorUrl'> & {readonly origin: string; readonly subject: string},
  options: OAuthUserConfigureOptions = {},
) {
  const validated = yield* Schema.decodeEffect(
    Config,
    STRICT,
  )({
    audience: input.audience,
    ...(input.audienceParameter === undefined ? {} : {audienceParameter: input.audienceParameter}),
    clientId: input.clientId,
    clientIdClaim: input.clientIdClaim,
    coordinatorUrl: input.origin,
    credentialAccountVersion: 'oauth-v2',
    deviceAuthorizationUrl: input.deviceAuthorizationUrl,
    issuer: input.issuer,
    jwksUrl: input.jwksUrl,
    organization: input.organization,
    schemaVersion: 2,
    subject: input.subject,
    tokenUrl: input.tokenUrl,
  }).pipe(Effect.mapError(() => graphSharingFailure('Registry OAuth configuration is invalid.')));
  if (
    !validProviderConfig(validated) ||
    !canonicalOAuthUrl(validated.coordinatorUrl) ||
    new URL(validated.coordinatorUrl).origin !== validated.coordinatorUrl ||
    validated.audience !== validated.coordinatorUrl ||
    !/^[A-Za-z0-9._|@:/+-]{1,512}$/u.test(validated.subject ?? '')
  )
    return yield* graphSharingFailure('Registry OAuth authority must use an exact HTTPS origin and subject.');
  if (options.profile === 'legacy-auth0' && !isLegacyAuth0Profile(validated))
    return yield* graphSharingFailure('Legacy Auth0 setup requires the legacy provider profile.');
  if ((yield* readConfigs(config.agentContextHome)).some(binding => binding.audience === validated.audience))
    return yield* graphSharingFailure('Registry OAuth audience must differ from graph control.');
  const existing = yield* readConfigs(config.agentContextHome, 'registry');
  if (
    existing.some(
      binding => binding.coordinatorUrl === validated.coordinatorUrl && binding.organization !== validated.organization,
    )
  )
    return yield* graphSharingFailure('Registry OAuth origin is already bound to another organization.');
  const next = existing.filter(binding => binding.coordinatorUrl !== validated.coordinatorUrl);
  if (next.length >= 32) return yield* graphSharingFailure('Registry OAuth configuration capacity is full.');
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = graphSharingLayout(path, config.agentContextHome).root;
  const genericDestination = path.join(root, 'oauth-user-registry.json');
  if (options.profile === 'legacy-auth0' && (yield* fs.exists(genericDestination)))
    return yield* graphSharingFailure('Generic OAuth setup already exists; supply explicit provider endpoint flags.');
  const destination = path.join(
    root,
    options.profile === 'legacy-auth0' ? 'auth0-user-registry.json' : 'oauth-user-registry.json',
  );
  if (Option.isSome(yield* fs.readLink(destination).pipe(Effect.option)))
    return yield* graphSharingFailure('Registry OAuth binding must not be a symbolic link.');
  const crypto = yield* Crypto.Crypto;
  const staged = `${destination}.${yield* crypto.randomUUIDv4()}.pending`;
  const replaced = existing.find(binding => binding.coordinatorUrl === validated.coordinatorUrl);
  const persisted =
    options.profile !== 'legacy-auth0' &&
    (replaced?.credentialAccountVersion === 'legacy-auth0-v1' ||
      replaced?.previousCredentialAccountVersion === 'legacy-auth0-v1')
      ? {...validated, previousCredentialAccountVersion: 'legacy-auth0-v1' as const}
      : validated;
  yield* writePrivateJsonFile(
    staged,
    options.profile === 'legacy-auth0'
      ? {bindings: [...next.map(legacyStoredConfig), legacyStoredConfig(validated)], schemaVersion: 1}
      : {bindings: [...next, persisted], schemaVersion: 2},
  );
  // Stage the binding first; Docker conflicts leave it unpublished, and a retry can reuse an installed helper.
  yield* Effect.gen(function* () {
    yield* configureOAuthRegistryReaderDockerHelper(
      validated.coordinatorUrl,
      options.profile === 'legacy-auth0' ? 'threadnote-auth0-user' : 'threadnote-oauth-user',
    );
    yield* fs
      .rename(staged, destination)
      .pipe(
        Effect.mapError(() =>
          graphSharingFailure(
            'Registry OAuth binding could not be saved. Docker helper may be configured; retry setup.',
          ),
        ),
      );
  }).pipe(Effect.ensuring(fs.remove(staged, {force: true}).pipe(Effect.ignore)));
  return {configured: true};
});

export const loginRegistryOAuthUser = Effect.fn('codeGraph.sharing.loginRegistryOAuthUser')(
  (
    home: string,
    backendOverride?: OAuthUserBackend,
    selector?: {readonly coordinatorUrl: string; readonly organization: string},
  ) => loginGraphOAuthUser(home, backendOverride, selector, 'registry'),
);

export const logoutRegistryOAuthUser = Effect.fn('codeGraph.sharing.logoutRegistryOAuthUser')(
  (
    home: string,
    backendOverride?: OAuthUserBackend,
    selector?: {readonly coordinatorUrl: string; readonly organization: string},
  ) => logoutGraphOAuthUser(home, backendOverride, selector, 'registry'),
);

export const loginGraphOAuthUser = Effect.fn('codeGraph.sharing.loginOAuthUser')(function* (
  home: string,
  backendOverride?: OAuthUserBackend,
  selector?: {readonly coordinatorUrl: string; readonly organization: string},
  target: CredentialTarget = 'graph',
) {
  const config = yield* readConfig(home, selector, target);
  const scopes = target === 'registry' ? REGISTRY_SCOPES : SCOPES;
  const backend: OAuthUserBackend = backendOverride ?? (yield* makeBackend());
  const deviceForm: Record<string, string> = {
    client_id: config.clientId,
    scope: `offline_access ${scopes.join(' ')}`,
  };
  if (config.audienceParameter !== undefined) deviceForm.audience = config.audienceParameter;
  const response = yield* backend
    .post(config, 'device', deviceForm)
    .pipe(Effect.mapError(() => graphSharingUnavailable('OAuth device authorization is unavailable.')));
  const device = parseDeviceResponse(response, config.issuer);
  if (device === undefined) return yield* graphSharingFailure('OAuth device authorization response is invalid.');
  yield* Console.log(`Open ${device.verificationUri} and enter code ${device.userCode}`);
  const started = yield* Clock.currentTimeMillis;
  let interval = device.interval * 1000;
  for (;;) {
    yield* Effect.sleep(interval);
    if ((yield* Clock.currentTimeMillis) - started >= device.expiresIn * 1000)
      return yield* graphSharingUnavailable('OAuth device authorization expired; run login again.');
    const result = yield* backend
      .post(config, 'token', {
        client_id: config.clientId,
        device_code: device.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
      .pipe(Effect.mapError(() => graphSharingUnavailable('OAuth device authorization is unavailable.')));
    if (result.status === 200) {
      const credential = yield* verifiedCredential(config, result.body, backend, target);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lockPath = oauthUserLockPath(path, home, config);
      yield* withExclusiveFileLock(
        fs,
        lockPath,
        lockOptions,
        backend.write(account(home, config), JSON.stringify(credential)),
      );
      if (config.previousCredentialAccountVersion === 'legacy-auth0-v1')
        yield* removeCredentialAccount(home, config, 'legacy-auth0-v1', backend);
      return {authenticated: true, subject: credential.subject};
    }
    const error = isRecord(result.body) ? result.body.error : undefined;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval = Math.min(interval + 5_000, 30_000);
      continue;
    }
    return yield* graphSharingUnavailable('OAuth device authorization was denied or expired.');
  }
});

export const getGraphOAuthUserCredential = Effect.fn('codeGraph.sharing.getOAuthUserCredential')(function* (
  home: string,
  rawInput: unknown,
  backendOverride?: OAuthUserBackend,
) {
  const input = yield* Schema.decodeUnknownEffect(
    OAuthUserHelperInput,
    STRICT,
  )(rawInput).pipe(Effect.mapError(() => graphSharingFailure('Graph OAuth helper request is invalid.')));
  const config = yield* readConfig(home, {coordinatorUrl: input.coordinatorUrl, organization: input.organization});
  if (
    input.issuer !== config.issuer ||
    input.audience !== config.audience ||
    input.coordinatorUrl !== config.coordinatorUrl ||
    input.organization !== config.organization
  )
    return yield* graphSharingFailure('Graph OAuth helper request is outside configured authority.');
  return yield* getStoredOAuthUserCredential(home, config, input.scopes[0], 'graph', backendOverride);
});

export const getRegistryOAuthUserCredential = Effect.fn('codeGraph.sharing.getRegistryOAuthUserCredential')(function* (
  home: string,
  server: string,
  backendOverride?: OAuthUserBackend,
) {
  const configs = yield* readConfigs(home, 'registry');
  const config = configs.find(item => new URL(item.coordinatorUrl).host === server);
  if (config === undefined || server !== new URL(config.coordinatorUrl).host)
    return yield* graphSharingFailure('Registry OAuth helper request is outside configured authority.');
  return yield* getStoredOAuthUserCredential(home, config, 'registry:read', 'registry', backendOverride);
});

const getStoredOAuthUserCredential = Effect.fn('codeGraph.sharing.getStoredOAuthUserCredential')(function* (
  home: string,
  config: OAuthUserConfig,
  scope: string,
  target: CredentialTarget,
  backendOverride?: OAuthUserBackend,
) {
  const backend: OAuthUserBackend = backendOverride ?? (yield* makeBackend());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = oauthUserLockPath(path, home, config);
  const credential = yield* withExclusiveFileLock(
    fs,
    lockPath,
    lockOptions,
    Effect.gen(function* () {
      const stored = yield* backend
        .read(account(home, config))
        .pipe(Effect.mapError(() => graphSharingUnavailable('OAuth Keychain credentials are unavailable.')));
      if (stored === undefined) return yield* graphSharingUnavailable('OAuth login is required.');
      const parsed = yield* Effect.try({
        try: () => JSON.parse(stored) as unknown,
        catch: () => graphSharingFailure('OAuth Keychain credentials are invalid.'),
      });
      if (isRecord(parsed) && parsed.state === 'refreshing')
        return yield* graphSharingUnavailable('OAuth refresh was interrupted; run login again.');
      const current = yield* Schema.decodeUnknownEffect(
        Credential,
        STRICT,
      )(parsed).pipe(Effect.mapError(() => graphSharingFailure('OAuth Keychain credentials are invalid.')));
      if (
        current.issuer !== config.issuer ||
        current.audience !== config.audience ||
        current.clientId !== config.clientId ||
        (config.subject !== undefined && current.subject !== config.subject)
      )
        return yield* graphSharingFailure('OAuth Keychain credentials have different authority.');
      if (
        !current.scopes.includes(scope) ||
        (target === 'registry' && current.scopes.some(item => item.startsWith('registry:') && item !== scope))
      )
        return yield* graphSharingFailure('OAuth token lacks the requested scope.');
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      if (current.expiresAt > now + 60 && (target === 'graph' || current.expiresAt <= now + 600)) return current;
      yield* backend
        .write(account(home, config), JSON.stringify({schemaVersion: 1, state: 'refreshing'}))
        .pipe(Effect.mapError(() => graphSharingUnavailable('OAuth Keychain update failed; run login again.')));
      const response = yield* backend
        .post(config, 'token', {
          client_id: config.clientId,
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
        })
        .pipe(Effect.mapError(() => graphSharingUnavailable('OAuth refresh is unavailable.')));
      if (response.status !== 200) return yield* graphSharingUnavailable('OAuth session expired; run login again.');
      const next = yield* verifiedCredential(config, response.body, backend, target, current);
      if (!next.scopes.includes(scope))
        return yield* graphSharingFailure('Refreshed OAuth token lacks the requested graph scope.');
      yield* backend
        .write(account(home, config), JSON.stringify(next))
        .pipe(Effect.mapError(() => graphSharingUnavailable('OAuth Keychain update failed; run login again.')));
      return next;
    }),
  ).pipe(Effect.catchIf(isFileLockTimeout, () => graphSharingUnavailable('OAuth refresh is busy.')));
  return {
    accessToken: credential.accessToken,
    audience: credential.audience,
    expiresAt: credential.expiresAt,
    issuer: credential.issuer,
    schemaVersion: 1 as const,
    subject: credential.subject,
  };
});

export const logoutGraphOAuthUser = Effect.fn('codeGraph.sharing.logoutOAuthUser')(function* (
  home: string,
  backendOverride?: OAuthUserBackend,
  selector?: {readonly coordinatorUrl: string; readonly organization: string},
  target: CredentialTarget = 'graph',
) {
  const config = yield* readConfig(home, selector, target);
  const backend: OAuthUserBackend = backendOverride ?? (yield* makeBackend());
  yield* removeCredentialAccount(home, config, config.credentialAccountVersion, backend);
  if (config.previousCredentialAccountVersion === 'legacy-auth0-v1')
    yield* removeCredentialAccount(home, config, 'legacy-auth0-v1', backend);
});

const lockOptions = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 60_000,
  waitTimeoutMilliseconds: 3_000,
} as const;

function account(
  home: string,
  config: OAuthUserConfig,
  version: typeof CredentialAccountVersion.Type = config.credentialAccountVersion,
): string {
  if (version === 'legacy-auth0-v1')
    return sha256Digest(
      JSON.stringify([
        home,
        config.issuer,
        config.audience,
        config.clientId,
        config.coordinatorUrl,
        config.organization,
      ]),
    ).slice(7);
  return sha256Digest(
    JSON.stringify([
      home,
      config.issuer,
      config.audience,
      config.clientId,
      config.clientIdClaim,
      config.deviceAuthorizationUrl,
      config.tokenUrl,
      config.jwksUrl,
      config.audienceParameter ?? null,
      config.coordinatorUrl,
      config.organization,
    ]),
  ).slice(7);
}

function oauthUserLockPath(
  path: Path.Path,
  home: string,
  config: OAuthUserConfig,
  version: typeof CredentialAccountVersion.Type = config.credentialAccountVersion,
): string {
  return path.join(
    graphSharingLayout(path, home).root,
    `${version === 'legacy-auth0-v1' ? 'auth0-user' : 'oauth-user'}.${account(home, config, version)}.lock`,
  );
}

const removeCredentialAccount = Effect.fn('codeGraph.sharing.removeOAuthCredentialAccount')(function* (
  home: string,
  config: OAuthUserConfig,
  version: typeof CredentialAccountVersion.Type,
  backend: OAuthUserBackend,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = account(home, config, version);
  yield* withExclusiveFileLock(
    fs,
    oauthUserLockPath(path, home, config, version),
    lockOptions,
    backend.read(key).pipe(
      Effect.mapError(() => graphSharingUnavailable('OAuth Keychain credentials are unavailable.')),
      Effect.flatMap(stored =>
        stored === undefined
          ? Effect.void
          : backend
              .remove(key)
              .pipe(Effect.mapError(() => graphSharingUnavailable('OAuth Keychain credentials are unavailable.'))),
      ),
    ),
  );
});

function validProviderConfig(config: OAuthUserConfig): boolean {
  return (
    canonicalOAuthUrl(config.issuer) &&
    sameOriginOAuthEndpoint(config.deviceAuthorizationUrl, config.issuer) &&
    sameOriginOAuthEndpoint(config.tokenUrl, config.issuer) &&
    sameOriginOAuthEndpoint(config.jwksUrl, config.issuer) &&
    (config.audienceParameter === undefined ||
      (config.audienceParameter.length <= 512 &&
        ![...config.audienceParameter].some(
          character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
        )))
  );
}

function legacyProviderConfig(config: typeof LegacyConfig.Type): OAuthUserConfig {
  return {
    audience: config.audience,
    audienceParameter: config.audience,
    clientId: config.clientId,
    clientIdClaim: 'azp-or-client_id',
    coordinatorUrl: config.coordinatorUrl,
    credentialAccountVersion: 'legacy-auth0-v1',
    deviceAuthorizationUrl: new URL('oauth/device/code', config.issuer).href,
    issuer: config.issuer,
    jwksUrl: new URL('.well-known/jwks.json', config.issuer).href,
    organization: config.organization,
    schemaVersion: 2,
    ...(config.subject === undefined ? {} : {subject: config.subject}),
    tokenUrl: new URL('oauth/token', config.issuer).href,
  };
}

function legacyStoredConfig(config: OAuthUserConfig): typeof LegacyConfig.Type {
  return {
    audience: config.audience,
    clientId: config.clientId,
    coordinatorUrl: config.coordinatorUrl,
    issuer: config.issuer,
    organization: config.organization,
    schemaVersion: 1,
    ...(config.subject === undefined ? {} : {subject: config.subject}),
  };
}

function isLegacyAuth0Profile(config: OAuthUserConfig): boolean {
  return (
    new URL(config.issuer).pathname === '/' &&
    new URL(config.issuer).href === config.issuer &&
    config.audienceParameter === config.audience &&
    config.clientIdClaim === 'azp-or-client_id' &&
    config.deviceAuthorizationUrl === new URL('oauth/device/code', config.issuer).href &&
    config.tokenUrl === new URL('oauth/token', config.issuer).href &&
    config.jwksUrl === new URL('.well-known/jwks.json', config.issuer).href
  );
}

const readConfigs = Effect.fn('codeGraph.sharing.readOAuthUserConfigs')(function* (
  home: string,
  target: CredentialTarget = 'graph',
) {
  const label = target === 'registry' ? 'Registry OAuth' : 'Graph OAuth';
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = graphSharingLayout(path, home).root;
  const filename = path.join(root, target === 'graph' ? 'oauth-user.json' : 'oauth-user-registry.json');
  const legacyFilename = path.join(root, target === 'graph' ? 'auth0-user.json' : 'auth0-user-registry.json');
  if (!(yield* fs.exists(filename)) && !(yield* fs.exists(legacyFilename))) return [] as ReadonlyArray<OAuthUserConfig>;
  const usingLegacy = !(yield* fs.exists(filename));
  const selectedFilename = usingLegacy ? legacyFilename : filename;
  const bytes = yield* readBoundedPrivateBytes(selectedFilename, 65_536);
  const decoded = yield* Schema.decodeEffect(
    Schema.fromJsonString(usingLegacy ? LegacyConfigs : Configs),
    STRICT,
  )(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError(() => graphSharingFailure(`${label} configuration is invalid.`)),
  );
  const bindings: ReadonlyArray<OAuthUserConfig> = usingLegacy
    ? (decoded.bindings as ReadonlyArray<typeof LegacyConfig.Type>).map(legacyProviderConfig)
    : (decoded.bindings as ReadonlyArray<OAuthUserConfig>);
  if (
    bindings.some(
      config =>
        !canonicalOAuthUrl(config.coordinatorUrl) ||
        !canonicalOAuthUrl(config.audience) ||
        !validProviderConfig(config) ||
        (usingLegacy && (new URL(config.issuer).pathname !== '/' || new URL(config.issuer).href !== config.issuer)) ||
        (target === 'registry' &&
          (new URL(config.coordinatorUrl).origin !== config.coordinatorUrl ||
            config.audience !== config.coordinatorUrl ||
            config.subject === undefined)),
    ) ||
    new Set(bindings.map(config => JSON.stringify([config.coordinatorUrl, config.organization]))).size !==
      bindings.length ||
    (target === 'registry' && new Set(bindings.map(config => config.coordinatorUrl)).size !== bindings.length)
  )
    return yield* graphSharingFailure(`${label} configuration has invalid URLs.`);
  return bindings;
});

const readConfig = Effect.fn('codeGraph.sharing.readOAuthUserConfig')(function* (
  home: string,
  selector?: {readonly coordinatorUrl: string; readonly organization: string},
  target: CredentialTarget = 'graph',
) {
  const bindings = yield* readConfigs(home, target);
  const label = target === 'registry' ? 'Registry OAuth' : 'Graph OAuth';
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

const verifiedCredential = Effect.fn('codeGraph.sharing.verifyOAuthCredential')(function* (
  config: OAuthUserConfig,
  raw: unknown,
  backend: OAuthUserBackend,
  target: CredentialTarget,
  previous?: StoredCredential,
) {
  if (
    !isRecord(raw) ||
    typeof raw.token_type !== 'string' ||
    raw.token_type.toLowerCase() !== 'bearer' ||
    !boundedText(raw.access_token, 16_384)
  )
    return yield* graphSharingFailure('OAuth did not return a usable graph credential.');
  const refreshToken = raw.refresh_token === undefined ? previous?.refreshToken : raw.refresh_token;
  if (!boundedText(refreshToken, 16_384))
    return yield* graphSharingFailure('OAuth did not return a usable graph credential.');
  const claims = yield* backend
    .verify(config, raw.access_token)
    .pipe(Effect.mapError(() => graphSharingFailure('OAuth access token could not be verified.')));
  if (
    claims.issuer !== config.issuer ||
    claims.clientId !== config.clientId ||
    claims.subject.length > 512 ||
    (previous !== undefined && claims.subject !== previous.subject) ||
    (config.subject !== undefined && claims.subject !== config.subject) ||
    !(target === 'registry' ? REGISTRY_SCOPES : SCOPES).every(scope => claims.scopes.has(scope)) ||
    (target === 'registry' &&
      [...claims.scopes].some(scope => scope.startsWith('registry:') && scope !== 'registry:read'))
  )
    return yield* graphSharingFailure('OAuth token lacks the configured identity or scopes.');
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  if (claims.expiresAt <= now + 60) return yield* graphSharingFailure('OAuth token expires too soon.');
  if (target === 'registry' && claims.expiresAt > now + 600)
    return yield* graphSharingFailure('OAuth registry token lifetime exceeds the configured limit.');
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

const makeBackend = Effect.fn('codeGraph.sharing.makeOAuthUserBackend')(function* () {
  const system = yield* SystemInfo;
  if (system.platform !== 'darwin') return yield* graphSharingUnavailable('OAuth login requires macOS Keychain.');
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
    catch: () => graphSharingUnavailable('OAuth Keychain library is unavailable.'),
  });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const backend: OAuthUserBackend = {
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
        catch: () => graphSharingUnavailable('OAuth Keychain read failed.'),
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
        catch: () => graphSharingUnavailable('OAuth Keychain update failed.'),
      }),
    remove: account =>
      Effect.try({
        try: () => {
          const accountBytes = encoder.encode(account);
          if (library.symbols.tn_graph_keychain_delete(accountBytes, accountBytes.length) !== 0)
            throw new Error('keychain-delete');
        },
        catch: () => graphSharingUnavailable('OAuth Keychain removal failed.'),
      }),
    post: (config, endpoint, form) => postOAuth(config, endpoint, form),
    verify: (config, accessToken) =>
      fromPromiseInterruptibleAwaiting(
        () =>
          createRemoteAccessTokenVerifier({
            audience: config.audience,
            clientId: config.clientId,
            clientIdClaim: config.clientIdClaim,
            issuer: config.issuer,
            jwksUrl: new URL(config.jwksUrl),
          })(accessToken),
        () => graphSharingFailure('OAuth access token could not be verified.'),
      ),
  };
  return backend;
});

function postOAuth(config: OAuthUserConfig, endpoint: 'device' | 'token', form: Readonly<Record<string, string>>) {
  return fromPromiseInterruptibleAwaiting(
    async signal => {
      const url = new URL(endpoint === 'device' ? config.deviceAuthorizationUrl : config.tokenUrl);
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
    () => graphSharingUnavailable('OAuth token endpoint is unavailable.'),
  );
}
