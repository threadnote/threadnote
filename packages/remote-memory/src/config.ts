import {Array as EffectArray} from 'effect';
import {remoteMemoryError} from './errors.js';
import {requireGitMemoryBinding, type GitMemoryBinding} from './git/binding.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {pipe as effectPipe} from 'effect';
import {Option as EffectOption} from 'effect';

export type RemoteMemoryCanonicalStore = 'git' | 'postgres';

export interface RemoteMemoryServiceConfig {
  readonly accessTokenAudience: string;
  readonly accessTokenClientIdClaim?: 'azp' | 'client_id' | 'cid' | 'azp-or-client_id';
  readonly accessTokenIssuer: string;
  readonly accessTokenJwksUrl: URL;
  readonly autoMigrate: boolean;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly attestationAudience: string;
  readonly canonicalStore: RemoteMemoryCanonicalStore;
  readonly cursorIssuer: string;
  readonly cursorJwksUrl: URL;
  readonly databaseUrl: string;
  readonly gitBranch: string;
  readonly gitCloneUrl?: string;
  readonly gitBinding?: GitMemoryBinding;
  readonly gitPush: boolean;
  readonly gitRemote: string;
  readonly gitWorktree?: string;
  readonly host: string;
  readonly legacyClientIdCompatibilityUntil?: string;
  readonly globallyEnabled: boolean;
  readonly maxBodyBytes: number;
  readonly port: number;
  readonly publicBaseUrl: URL;
  readonly readRequestsPerMinute: number;
  readonly requestTimeoutMilliseconds: number;
  readonly writeRequestsPerMinute: number;
}

export function remoteMemoryConfigFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): RemoteMemoryServiceConfig {
  const publicBaseUrl = httpsUrl(required(environment, 'THREADNOTE_REMOTE_PUBLIC_URL'), 'THREADNOTE_REMOTE_PUBLIC_URL');
  if (publicBaseUrl.pathname !== '/' || publicBaseUrl.search || publicBaseUrl.hash) {
    throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_PUBLIC_URL must be an origin without a path.');
  }
  const accessTokenIssuer = required(environment, 'THREADNOTE_REMOTE_OAUTH_ISSUER');
  assertIssuerUrl(httpsUrl(accessTokenIssuer, 'THREADNOTE_REMOTE_OAUTH_ISSUER'));
  const cursorIssuerUrl = httpsUrl(
    Effect.pipe(environment.THREADNOTE_REMOTE_CURSOR_ISSUER, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) || 'https://api.cursor.com',
    'THREADNOTE_REMOTE_CURSOR_ISSUER',
  );
  assertIssuerUrl(cursorIssuerUrl);
  const cursorIssuer = Effect.pipe(cursorIssuerUrl.toString(), EffectString.replace(/\/$/u, ''));
  const databaseUrl = databaseConnectionUrl(required(environment, 'THREADNOTE_REMOTE_DATABASE_URL'));
  const localService = publicBaseUrl.hostname === 'localhost' || publicBaseUrl.hostname === '127.0.0.1';
  const autoMigrate = booleanValue(environment.THREADNOTE_REMOTE_AUTO_MIGRATE, localService);
  if (autoMigrate && !localService) {
    throw remoteMemoryError(
      'invalid_request',
      'THREADNOTE_REMOTE_AUTO_MIGRATE is only allowed for localhost development.',
    );
  }
  const allowedHosts = EffectArray.map(
    csv(environment.THREADNOTE_REMOTE_ALLOWED_HOSTS, [publicBaseUrl.host]),
    validateHostValue,
  );
  const allowedOrigins = EffectArray.map(
    csv(environment.THREADNOTE_REMOTE_ALLOWED_ORIGINS, ['https://cursor.com']),
    value => validateOriginValue(value, localService),
  );
  const accessTokenAudience = audienceValue(
    Effect.pipe(environment.THREADNOTE_REMOTE_OAUTH_AUDIENCE, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) || new URL('/mcp', publicBaseUrl).toString(),
    'THREADNOTE_REMOTE_OAUTH_AUDIENCE',
  );
  const accessTokenClientIdClaim = clientIdClaimValue(environment.THREADNOTE_REMOTE_OAUTH_CLIENT_ID_CLAIM);
  const legacyClientIdCompatibilityUntil = legacyClientIdCompatibilityTimestamp(
    environment.THREADNOTE_REMOTE_OAUTH_LEGACY_CLIENT_ID_COMPATIBILITY_UNTIL,
    accessTokenClientIdClaim,
  );
  const attestationAudience = audienceValue(
    Effect.pipe(environment.THREADNOTE_REMOTE_CURSOR_AUDIENCE, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) || new URL('/attest/cursor', publicBaseUrl).toString(),
    'THREADNOTE_REMOTE_CURSOR_AUDIENCE',
  );
  if (accessTokenAudience !== new URL('/mcp', publicBaseUrl).toString()) {
    throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_OAUTH_AUDIENCE must equal the public MCP URL.');
  }
  if (attestationAudience !== new URL('/attest/cursor', publicBaseUrl).toString()) {
    throw remoteMemoryError(
      'invalid_request',
      'THREADNOTE_REMOTE_CURSOR_AUDIENCE must equal the public Cursor attestation audience.',
    );
  }
  const accessTokenJwksUrl = httpsUrl(
    Effect.pipe(environment.THREADNOTE_REMOTE_OAUTH_JWKS_URL, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) ||
      new URL(
        '/.well-known/jwks.json',
        `${Effect.pipe(accessTokenIssuer, EffectString.replace(/\/$/, ''))}/`,
      ).toString(),
    'THREADNOTE_REMOTE_OAUTH_JWKS_URL',
  );
  const cursorJwksUrl = httpsUrl(
    Effect.pipe(environment.THREADNOTE_REMOTE_CURSOR_JWKS_URL, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) ||
      (cursorIssuer === 'https://api.cursor.com'
        ? 'https://api.cursor.com/keys'
        : new URL(
            '/.well-known/jwks.json',
            `${Effect.pipe(cursorIssuer, EffectString.replace(/\/$/, ''))}/`,
          ).toString()),
    'THREADNOTE_REMOTE_CURSOR_JWKS_URL',
  );
  if (accessTokenJwksUrl.origin !== new URL(accessTokenIssuer).origin) {
    throw remoteMemoryError('invalid_request', 'The OAuth JWKS URL must use the configured issuer origin.');
  }
  if (cursorJwksUrl.origin !== new URL(cursorIssuer).origin) {
    throw remoteMemoryError('invalid_request', 'The Cursor JWKS URL must use the configured Cursor issuer origin.');
  }
  if (cursorIssuer === 'https://api.cursor.com' && cursorJwksUrl.toString() !== 'https://api.cursor.com/keys') {
    throw remoteMemoryError('invalid_request', "The Cursor JWKS URL must use Cursor's published /keys endpoint.");
  }
  const canonicalStore = canonicalStoreValue(environment.THREADNOTE_REMOTE_CANONICAL_STORE);
  const gitWorktree = Effect.pipe(environment.THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  if (canonicalStore === 'git') {
    if (!gitWorktree) {
      throw remoteMemoryError(
        'invalid_request',
        'THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE is required when THREADNOTE_REMOTE_CANONICAL_STORE=git.',
      );
    }
    if (!isAbsoluteWorktree(gitWorktree)) {
      throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE must be an absolute path.');
    }
  }
  return {
    accessTokenAudience,
    ...(accessTokenClientIdClaim === undefined ? {} : {accessTokenClientIdClaim}),
    accessTokenIssuer,
    accessTokenJwksUrl,
    autoMigrate,
    allowedHosts,
    allowedOrigins,
    attestationAudience,
    canonicalStore,
    cursorIssuer,
    cursorJwksUrl,
    databaseUrl,
    ...(canonicalStore === 'git'
      ? {
          gitBinding: requireGitMemoryBinding({
            tenantId:
              Effect.pipe(environment.THREADNOTE_REMOTE_MEMORY_GIT_TENANT_ID, effectOptionalString =>
                effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
              ) ?? '',
            shareId:
              Effect.pipe(environment.THREADNOTE_REMOTE_MEMORY_GIT_SHARE_ID, effectOptionalString =>
                effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
              ) ?? '',
          }),
        }
      : {}),
    gitBranch: gitRefName(
      Effect.pipe(environment.THREADNOTE_REMOTE_MEMORY_GIT_BRANCH, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      ) || 'main',
      'THREADNOTE_REMOTE_MEMORY_GIT_BRANCH',
    ),
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves narrowing for the URL value.
    ...(environment.THREADNOTE_REMOTE_MEMORY_GIT_CLONE_URL?.trim()
      ? {
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The optional-chain guard narrows this value.
          gitCloneUrl: gitCloneUrl(environment.THREADNOTE_REMOTE_MEMORY_GIT_CLONE_URL.trim(), localService),
        }
      : {}),
    gitPush: booleanValue(environment.THREADNOTE_REMOTE_MEMORY_GIT_PUSH, true),
    gitRemote: gitRefName(
      Effect.pipe(environment.THREADNOTE_REMOTE_MEMORY_GIT_REMOTE, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      ) || 'origin',
      'THREADNOTE_REMOTE_MEMORY_GIT_REMOTE',
    ),
    ...(gitWorktree ? {gitWorktree} : {}),
    globallyEnabled: booleanValue(environment.THREADNOTE_REMOTE_ENABLED, false),
    host:
      Effect.pipe(environment.THREADNOTE_REMOTE_HOST, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      ) || '127.0.0.1',
    ...(legacyClientIdCompatibilityUntil === undefined ? {} : {legacyClientIdCompatibilityUntil}),
    maxBodyBytes: boundedInteger(environment.THREADNOTE_REMOTE_MAX_BODY_BYTES, 256 * 1024, 1024, 1024 * 1024),
    port: boundedInteger(environment.THREADNOTE_REMOTE_PORT, 8787, 1, 65_535),
    publicBaseUrl,
    readRequestsPerMinute: boundedInteger(environment.THREADNOTE_REMOTE_READ_REQUESTS_PER_MINUTE, 300, 1, 100_000),
    requestTimeoutMilliseconds: boundedInteger(environment.THREADNOTE_REMOTE_REQUEST_TIMEOUT_MS, 10_000, 100, 120_000),
    writeRequestsPerMinute: boundedInteger(environment.THREADNOTE_REMOTE_WRITE_REQUESTS_PER_MINUTE, 60, 1, 100_000),
  };
}

function gitCloneUrl(value: string, localService: boolean): string {
  const invalid = () =>
    remoteMemoryError('invalid_request', 'The Git clone URL must use credential-free SSH or HTTPS.');
  if (/[^\x21-\x7e]|\\/u.test(value)) throw invalid();
  if (localService && Effect.pipe(value, EffectString.startsWith('/'))) return value;
  if (/^[A-Za-z0-9_-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/u.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    !['ssh:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === 'https:' && url.username) ||
    !/^\/[A-Za-z0-9._~/-]+$/u.test(url.pathname)
  )
    throw invalid();
  return value;
}

export function redactedRemoteMemoryConfig(config: RemoteMemoryServiceConfig): Readonly<Record<string, unknown>> {
  return {
    accessTokenAudience: config.accessTokenAudience,
    ...(config.accessTokenClientIdClaim === undefined
      ? {}
      : {accessTokenClientIdClaim: config.accessTokenClientIdClaim}),
    accessTokenIssuer: config.accessTokenIssuer,
    autoMigrate: config.autoMigrate,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    attestationAudience: config.attestationAudience,
    canonicalStore: config.canonicalStore,
    cursorIssuer: config.cursorIssuer,
    gitBranch: config.gitBranch,
    gitPush: config.gitPush,
    gitRemote: config.gitRemote,
    ...(config.gitWorktree ? {gitWorktree: config.gitWorktree} : {}),
    globallyEnabled: config.globallyEnabled,
    host: config.host,
    ...(config.legacyClientIdCompatibilityUntil === undefined
      ? {}
      : {legacyClientIdCompatibilityUntil: config.legacyClientIdCompatibilityUntil}),
    maxBodyBytes: config.maxBodyBytes,
    port: config.port,
    publicBaseUrl: config.publicBaseUrl.toString(),
    readRequestsPerMinute: config.readRequestsPerMinute,
    requestTimeoutMilliseconds: config.requestTimeoutMilliseconds,
    writeRequestsPerMinute: config.writeRequestsPerMinute,
  };
}

function required(environment: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = Effect.pipe(environment[key], effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  if (!value) throw remoteMemoryError('invalid_request', `${key} is required.`);
  return value;
}

function httpsUrl(value: string, key: string): URL {
  const url = configuredUrl(value, undefined, key);
  if (url.protocol !== 'https:' && !(isLoopbackHostname(url.hostname) && url.protocol === 'http:')) {
    throw remoteMemoryError('invalid_request', `${key} must use HTTPS outside localhost.`);
  }
  if (url.username || url.password || url.hash) {
    throw remoteMemoryError('invalid_request', `${key} must be credential-free and cannot contain a fragment.`);
  }
  return url;
}

function audienceValue(value: string, key: string): string {
  const url = httpsUrl(value, key);
  if (url.search || url.hash) throw remoteMemoryError('invalid_request', `${key} cannot contain a query or fragment.`);
  return url.toString();
}

function databaseConnectionUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_DATABASE_URL must be an absolute PostgreSQL URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_DATABASE_URL must use PostgreSQL.');
  }
  const localDatabase =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === 'remote-memory-db';
  const sslMode = url.searchParams.get('sslmode');
  if (!localDatabase && sslMode !== 'verify-full') {
    throw remoteMemoryError(
      'invalid_request',
      'THREADNOTE_REMOTE_DATABASE_URL must use sslmode=verify-full outside a local database network.',
    );
  }
  return value;
}

function assertIssuerUrl(url: URL): void {
  if (url.search || url.hash)
    throw remoteMemoryError('invalid_request', 'Issuer URLs cannot contain a query or fragment.');
}

function configuredUrl(value: string | undefined, fallback: URL | undefined, key: string): URL {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining narrows `value` for URL construction.
  if (!value?.trim()) {
    if (fallback) return fallback;
    throw remoteMemoryError('invalid_request', `${key} is required.`);
  }
  try {
    return new URL(value);
  } catch (cause) {
    throw remoteMemoryError('invalid_request', `${key} must be an absolute URL.`, {
      cause: cause instanceof Error ? cause.name : 'invalid URL',
    });
  }
}

function csv(value: string | undefined, fallback: readonly string[]): readonly string[] {
  const values = effectPipe(
    EffectOption.fromNullishOr(
      EffectOption.getOrUndefined(
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional-chain short-circuiting through split/map/filter.
        EffectOption.map(EffectOption.fromNullishOr(value?.split(',')), mapReceiver =>
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional-chain short-circuiting through split/map/filter.
          EffectArray.map(mapReceiver, item => item.trim()),
        ),
      ),
    ),
    EffectOption.map(values => EffectArray.filter(values, (value, index) => index in values && Boolean(value))),
    EffectOption.getOrUndefined,
  );
  return values && values.length > 0 ? [...new Set(values)] : fallback;
}

function validateHostValue(value: string): string {
  const normalized = Effect.pipe(value, EffectString.toLowerCase);
  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch {
    throw remoteMemoryError('invalid_request', 'Allowed Host entries must be exact host[:port] values.');
  }
  const labels = Effect.pipe(parsed.hostname, EffectString.startsWith('['))
    ? []
    : Effect.pipe(parsed.hostname, EffectString.split('.'));
  if (
    parsed.host !== normalized ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    EffectArray.some(labels, label => !label || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    throw remoteMemoryError('invalid_request', 'Allowed Host entries must be exact host[:port] values.');
  }
  return parsed.host;
}

function validateOriginValue(value: string, localService: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw remoteMemoryError('invalid_request', 'Allowed Origin entries must be absolute origins.');
  }
  const loopbackHttp = isLoopbackHostname(url.hostname) && url.protocol === 'http:';
  if (
    (url.protocol !== 'https:' && !(localService && loopbackHttp)) ||
    url.origin !== Effect.pipe(value, EffectString.replace(/\/$/u, '')) ||
    url.username ||
    url.password
  ) {
    throw remoteMemoryError(
      'invalid_request',
      'Allowed Origin entries must be credential-free HTTPS origins, or loopback HTTP on a loopback public URL.',
    );
  }
  return url.origin;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (
    !Effect.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    )
  )
    return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw remoteMemoryError('invalid_request', `Expected an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (
    !Effect.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    )
  )
    return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw remoteMemoryError('invalid_request', 'Expected true or false.');
}

function clientIdClaimValue(value: string | undefined): 'azp' | 'client_id' | 'cid' | 'azp-or-client_id' | undefined {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining narrows `value` for Date.parse and comparison.
  if (!value?.trim()) return undefined;
  if (value === 'azp' || value === 'client_id' || value === 'cid' || value === 'azp-or-client_id') return value;
  throw remoteMemoryError(
    'invalid_request',
    'THREADNOTE_REMOTE_OAUTH_CLIENT_ID_CLAIM must be azp, client_id, cid, or azp-or-client_id.',
  );
}

function legacyClientIdCompatibilityTimestamp(
  value: string | undefined,
  clientIdClaim: RemoteMemoryServiceConfig['accessTokenClientIdClaim'],
): string | undefined {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional-chain narrowing for Date.parse and comparison.
  if (!value?.trim()) return undefined;
  if (clientIdClaim === undefined) {
    throw remoteMemoryError(
      'invalid_request',
      'THREADNOTE_REMOTE_OAUTH_LEGACY_CLIENT_ID_COMPATIBILITY_UNTIL requires a client-id claim mapping.',
    );
  }
  const milliseconds = Date.parse(value);
  const now = Date.now();
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value ||
    milliseconds <= now ||
    milliseconds - now > 31 * 24 * 60 * 60 * 1000
  ) {
    throw remoteMemoryError(
      'invalid_request',
      'THREADNOTE_REMOTE_OAUTH_LEGACY_CLIENT_ID_COMPATIBILITY_UNTIL must be an exact future ISO timestamp within 31 days.',
    );
  }
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

function isAbsoluteWorktree(path: string): boolean {
  return Effect.pipe(path, EffectString.startsWith('/')) || /^[A-Za-z]:[\\/]/u.test(path);
}

function gitRefName(value: string, key: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
    Effect.pipe(value, EffectString.startsWith('-')) ||
    Effect.pipe(value, EffectString.includes(':')) ||
    Effect.pipe(value, EffectString.includes('..'))
  ) {
    throw remoteMemoryError('invalid_request', `${key} must be a safe git refname.`);
  }
  return value;
}

function canonicalStoreValue(value: string | undefined): RemoteMemoryCanonicalStore {
  if (
    !Effect.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    )
  )
    return 'postgres';
  if (value === 'git' || value === 'postgres') return value;
  throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_CANONICAL_STORE must be git or postgres.');
}
