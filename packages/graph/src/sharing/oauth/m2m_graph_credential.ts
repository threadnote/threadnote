import {Array as EffectArray} from 'effect';
import {createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey} from 'jose';
import {
  canonicalOAuthUrl,
  oauthCredentialEnvironment,
  parseOAuthM2MProviderConfig,
  type OAuthM2MProviderConfig,
} from './m2m_config.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const MAX_INPUT_BYTES = 8192;
const MAX_RESPONSE_BYTES = 32768;
const MAX_TOKEN_BYTES = 16384;
// The graph listener enforces a 605-second JWT lifetime ceiling.
const MAX_TOKEN_LIFETIME_SECONDS = 600;
const CLOCK_TOLERANCE_SECONDS = 5;
const PROFILE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REPOSITORY_ID = /^[a-f0-9]{64}$/u;
const ORGANIZATION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/u;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const GRAPH_SCOPES = new Set(['graph:read', 'graph:contribute']);

export interface OAuthM2MGraphCredentialRequest {
  readonly audience: string;
  readonly coordinatorUrl: string;
  readonly interactive: false;
  readonly issuer: string;
  readonly organization: string;
  readonly profileDigest: string;
  readonly repositoryId: string;
  readonly schemaVersion: 1;
  readonly scopes: readonly ['graph:read' | 'graph:contribute'];
}

interface OAuthM2MGraphCredentialConfig extends OAuthM2MProviderConfig {
  readonly audience: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly coordinatorUrl: string;
  readonly issuer: string;
  readonly organization: string;
  readonly profileDigest: string;
  readonly repositoryId: string;
  readonly scopes: ReadonlySet<string>;
  readonly subject: string;
}

export interface OAuthM2MTokenDependencies {
  readonly fetch: (url: URL, init: RequestInit) => Promise<Response>;
  readonly key: JWTVerifyGetKey;
  readonly now: () => number;
}

export interface OAuthM2MTokenAuthority extends OAuthM2MProviderConfig {
  readonly allowedScopes?: ReadonlySet<string>;
  readonly audience: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuer: string;
  readonly scope: string;
  readonly subject: string;
}

export interface OAuthM2MHelperIO {
  readonly stdin: AsyncIterable<Uint8Array | string>;
  readonly writeStderr: (text: string) => void;
  readonly writeStdout: (text: string) => void;
}

/** No diagnostic or error from this boundary may contain the secret, token, or OAuth response. */
function credentialFailure(): Error {
  return new Error('OAuth graph credential unavailable.');
}

export function parseOAuthM2MGraphCredentialRequest(value: unknown): OAuthM2MGraphCredentialRequest {
  if (
    !isObjectWithKeys(value, [
      'audience',
      'coordinatorUrl',
      'interactive',
      'issuer',
      'organization',
      'profileDigest',
      'repositoryId',
      'schemaVersion',
      'scopes',
    ])
  )
    throw credentialFailure();
  if (
    typeof value.audience !== 'string' ||
    !canonicalOAuthUrl(value.audience) ||
    typeof value.coordinatorUrl !== 'string' ||
    !canonicalOAuthUrl(value.coordinatorUrl) ||
    typeof value.issuer !== 'string' ||
    !canonicalOAuthUrl(value.issuer) ||
    typeof value.organization !== 'string' ||
    !ORGANIZATION.test(value.organization) ||
    typeof value.profileDigest !== 'string' ||
    !PROFILE_DIGEST.test(value.profileDigest) ||
    typeof value.repositoryId !== 'string' ||
    !REPOSITORY_ID.test(value.repositoryId) ||
    value.interactive !== false ||
    value.schemaVersion !== 1 ||
    !EffectArray.isArray(value.scopes) ||
    value.scopes.length !== 1 ||
    (value.scopes[0] !== 'graph:read' && value.scopes[0] !== 'graph:contribute')
  )
    throw credentialFailure();
  return {
    audience: value.audience,
    coordinatorUrl: value.coordinatorUrl,
    interactive: value.interactive,
    issuer: value.issuer,
    organization: value.organization,
    profileDigest: value.profileDigest,
    repositoryId: value.repositoryId,
    schemaVersion: value.schemaVersion,
    scopes: [value.scopes[0]],
  };
}

export function parseOAuthM2MGraphCredentialConfig(environment: NodeJS.ProcessEnv): OAuthM2MGraphCredentialConfig {
  let provider: OAuthM2MProviderConfig;
  try {
    provider = parseOAuthM2MProviderConfig(environment, 'GRAPH');
    environment = oauthCredentialEnvironment(environment);
  } catch {
    throw credentialFailure();
  }
  const audience = environment.THREADNOTE_OAUTH_GRAPH_M2M_AUDIENCE;
  const clientId = environment.THREADNOTE_OAUTH_GRAPH_M2M_CLIENT_ID;
  const clientSecret = environment.THREADNOTE_OAUTH_GRAPH_M2M_CLIENT_SECRET;
  const coordinatorUrl = environment.THREADNOTE_OAUTH_GRAPH_M2M_COORDINATOR_URL;
  const issuer = environment.THREADNOTE_OAUTH_GRAPH_M2M_ISSUER;
  const organization = environment.THREADNOTE_OAUTH_GRAPH_M2M_ORGANIZATION;
  const profileDigest = environment.THREADNOTE_OAUTH_GRAPH_M2M_PROFILE_DIGEST;
  const repositoryId = environment.THREADNOTE_OAUTH_GRAPH_M2M_REPOSITORY_ID;
  const rawScopes = environment.THREADNOTE_OAUTH_GRAPH_M2M_SCOPES;
  const subject = environment.THREADNOTE_OAUTH_GRAPH_M2M_SUBJECT;
  const scopes = new Set(
    Effect.pipe(rawScopes, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.split(' ')),
    ),
  );
  if (
    !audience ||
    !canonicalOAuthUrl(audience) ||
    !coordinatorUrl ||
    !canonicalOAuthUrl(coordinatorUrl) ||
    !issuer ||
    !canonicalOAuthUrl(issuer) ||
    !organization ||
    !ORGANIZATION.test(organization) ||
    !profileDigest ||
    !PROFILE_DIGEST.test(profileDigest) ||
    !repositoryId ||
    !REPOSITORY_ID.test(repositoryId) ||
    !clientId ||
    !CLIENT_ID.test(clientId) ||
    !clientSecret ||
    clientSecret.length > 4096 ||
    !subject ||
    !validSubject(subject) ||
    !rawScopes ||
    EffectArray.some([...scopes], scope => !GRAPH_SCOPES.has(scope)) ||
    scopes.size === 0 ||
    rawScopes !== EffectArray.join([...scopes], ' ')
  )
    throw credentialFailure();
  return {
    ...provider,
    audience,
    clientId,
    clientSecret,
    coordinatorUrl,
    issuer,
    organization,
    profileDigest,
    repositoryId,
    scopes,
    subject,
  };
}

export async function getOAuthM2MGraphCredential(
  rawRequest: unknown,
  environment: NodeJS.ProcessEnv,
  dependencies?: Partial<OAuthM2MTokenDependencies>,
): Promise<{
  readonly accessToken: string;
  readonly audience: string;
  readonly expiresAt: number;
  readonly issuer: string;
  readonly schemaVersion: 1;
  readonly subject: string;
}> {
  const request = parseOAuthM2MGraphCredentialRequest(rawRequest);
  const config = parseOAuthM2MGraphCredentialConfig(environment);
  if (
    request.audience !== config.audience ||
    request.coordinatorUrl !== config.coordinatorUrl ||
    request.issuer !== config.issuer ||
    request.organization !== config.organization ||
    request.profileDigest !== config.profileDigest ||
    request.repositoryId !== config.repositoryId ||
    !config.scopes.has(request.scopes[0])
  )
    throw credentialFailure();

  const token = await requestVerifiedOAuthM2MToken(
    {...config, allowedScopes: config.scopes, scope: request.scopes[0]},
    dependencies,
  );
  return {
    accessToken: token.accessToken,
    audience: config.audience,
    expiresAt: token.expiresAt,
    issuer: config.issuer,
    schemaVersion: 1,
    subject: config.subject,
  };
}

/** Shared verifier for distinct control and registry M2M clients; callers own exact local binding checks. */
export async function requestVerifiedOAuthM2MToken(
  config: OAuthM2MTokenAuthority,
  dependencies?: Partial<OAuthM2MTokenDependencies>,
): Promise<{readonly accessToken: string; readonly expiresAt: number}> {
  const fetch_ = dependencies?.fetch ?? fetch;
  const now = dependencies?.now ?? Date.now;
  const key =
    dependencies?.key ??
    createRemoteJWKSet(new URL(config.jwksUrl), {
      cacheMaxAge: 5 * 60_000,
      timeoutDuration: 3000,
    });
  const startedAt = Math.floor(now() / 1000);
  try {
    const bodyParameters = new URLSearchParams({grant_type: 'client_credentials', scope: config.scope});
    if (config.audienceParameter !== undefined) bodyParameters.set('audience', config.audienceParameter);
    const headers: Record<string, string> = {'content-type': 'application/x-www-form-urlencoded'};
    if (config.clientAuthentication === 'client_secret_basic') {
      const encode = (value: string) => Effect.pipe(new URLSearchParams({value}).toString(), EffectString.slice(6));
      headers.authorization = `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(config.clientSecret)}`).toString('base64')}`;
    } else {
      bodyParameters.set('client_id', config.clientId);
      bodyParameters.set('client_secret', config.clientSecret);
    }
    const response = await fetch_(new URL(config.tokenUrl), {
      method: 'POST',
      headers,
      body: bodyParameters,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200) throw credentialFailure();
    const body = parseTokenResponse(await boundedResponse(response, MAX_RESPONSE_BYTES));
    if (
      Effect.pipe(body.token_type, EffectString.toLowerCase) !== 'bearer' ||
      body.expires_in < 1 ||
      body.expires_in > MAX_TOKEN_LIFETIME_SECONDS
    )
      throw credentialFailure();
    const {payload} = await jwtVerify(body.access_token, key, {
      algorithms: ['RS256'],
      audience: config.audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      issuer: config.issuer,
      currentDate: new Date(now()),
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    const receivedAt = Math.floor(now() / 1000);
    validateClaims(payload, config, startedAt, receivedAt, body.expires_in);
    if (body.scope !== undefined && !hasMatchingAuthorizedScopes(body.scope, tokenScopes(payload), config))
      throw credentialFailure();
    return {
      accessToken: body.access_token,
      expiresAt: payload.exp!,
    };
  } catch {
    throw credentialFailure();
  }
}

function parseTokenResponse(value: string): {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw credentialFailure();
  }
  if (
    !isObjectWithKeys(parsed, ['access_token', 'expires_in', 'token_type']) &&
    !isObjectWithKeys(parsed, ['access_token', 'expires_in', 'scope', 'token_type'])
  )
    throw credentialFailure();
  if (
    typeof parsed.access_token !== 'string' ||
    parsed.access_token.length > MAX_TOKEN_BYTES ||
    !BEARER_TOKEN.test(parsed.access_token) ||
    typeof parsed.expires_in !== 'number' ||
    !Number.isSafeInteger(parsed.expires_in) ||
    typeof parsed.token_type !== 'string' ||
    (parsed.scope !== undefined && (typeof parsed.scope !== 'string' || parsed.scope.length > 512))
  )
    throw credentialFailure();
  return {
    access_token: parsed.access_token,
    expires_in: parsed.expires_in,
    token_type: parsed.token_type,
    ...(parsed.scope === undefined ? {} : {scope: parsed.scope}),
  };
}

function validateClaims(
  payload: JWTPayload,
  config: OAuthM2MTokenAuthority,
  startedAt: number,
  receivedAt: number,
  expiresIn: number,
): void {
  const audience = payload.aud;
  const client =
    config.clientIdClaim === 'azp-or-client_id' ? (payload.azp ?? payload.client_id) : payload[config.clientIdClaim];
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  const notBefore = payload.nbf ?? issuedAt;
  if (
    payload.iss !== config.issuer ||
    payload.sub !== config.subject ||
    client !== config.clientId ||
    (typeof audience !== 'string'
      ? !EffectArray.isArray(audience) || audience.length !== 1 || audience[0] !== config.audience
      : audience !== config.audience) ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(notBefore) ||
    issuedAt! > receivedAt + CLOCK_TOLERANCE_SECONDS ||
    notBefore! > receivedAt + CLOCK_TOLERANCE_SECONDS ||
    issuedAt! < startedAt - CLOCK_TOLERANCE_SECONDS ||
    expiresAt! <= receivedAt + 30 ||
    expiresAt! - issuedAt! > MAX_TOKEN_LIFETIME_SECONDS ||
    expiresAt! <= issuedAt! ||
    Math.abs(expiresAt! - startedAt - expiresIn) > CLOCK_TOLERANCE_SECONDS + (receivedAt - startedAt) ||
    !hasAuthorizedScopes(tokenScopes(payload), config.scope, config.allowedScopes) ||
    (payload.gty !== undefined && payload.gty !== 'client-credentials')
  )
    throw credentialFailure();
}

const isScopeList = (value: unknown): value is readonly string[] =>
  EffectArray.isArray(value) &&
  EffectArray.every(value, (item): item is string => typeof item === 'string' && !/\s/u.test(item));

function scopeList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return Effect.pipe(value, EffectString.split(' '));
  if (isScopeList(value)) return [...value];
  return undefined;
}

function tokenScopes(payload: JWTPayload): unknown {
  if (payload.scope !== undefined && payload.scp !== undefined) {
    const scope = typeof payload.scope === 'string' ? scopeList(payload.scope) : undefined;
    const scp = EffectArray.isArray(payload.scp) ? scopeList(payload.scp) : undefined;
    if (
      !scope ||
      !scp ||
      new Set(scope).size !== scope.length ||
      new Set(scp).size !== scp.length ||
      scope.length !== scp.length ||
      EffectArray.some(scope, item => !scp.includes(item))
    )
      return undefined;
  }
  if (payload.scope !== undefined) return typeof payload.scope === 'string' ? payload.scope : undefined;
  return EffectArray.isArray(payload.scp) ? payload.scp : undefined;
}

function hasAuthorizedScopes(claim: unknown, requested: string, configured: ReadonlySet<string> | undefined): boolean {
  const granted = scopeList(claim);
  if (!granted) return false;
  const allowed = configured ?? new Set([requested]);
  return (
    granted.length > 0 &&
    granted.length <= allowed.size &&
    new Set(granted).size === granted.length &&
    granted.includes(requested) &&
    EffectArray.every(granted, scope => allowed.has(scope))
  );
}

function hasMatchingAuthorizedScopes(response: string, token: unknown, config: OAuthM2MTokenAuthority): boolean {
  if (!hasAuthorizedScopes(response, config.scope, config.allowedScopes) || !scopeList(token)) return false;
  const responseScopes = Effect.pipe(response, EffectString.split(' '));
  const tokenScopes = new Set(scopeList(token));
  return (
    responseScopes.length === tokenScopes.size && EffectArray.every(responseScopes, scope => tokenScopes.has(scope))
  );
}

async function boundedResponse(response: Response, limit: number): Promise<string> {
  if (!response.body) throw credentialFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw credentialFailure();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

function isObjectWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !EffectArray.isArray(value) &&
    EffectRecord.keys(value).length === keys.length &&
    // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
    EffectArray.every(keys, key => Object.hasOwn(value, key))
  );
}

function validSubject(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    EffectArray.every(
      [...value],
      character =>
        Effect.pipe(
          character,
          EffectString.charCodeAt(0),
          Effect.Option.getOrElse(() => NaN),
        ) > 32 &&
        Effect.pipe(
          character,
          EffectString.charCodeAt(0),
          Effect.Option.getOrElse(() => NaN),
        ) !== 127,
    )
  );
}

/** Hidden standalone entrypoint used only through the managed credential helper launcher. */
export async function runOAuthM2MGraphCredentialHelper(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: OAuthM2MHelperIO,
): Promise<number> {
  try {
    if (arguments_.length !== 1 || arguments_[0] !== 'get') throw credentialFailure();
    let length = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of io.stdin) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      length += bytes.length;
      if (length > MAX_INPUT_BYTES) throw credentialFailure();
      chunks.push(bytes);
    }
    const input = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      input.set(chunk, offset);
      offset += chunk.length;
    }
    const request = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(input)) as unknown;
    io.writeStdout(`${JSON.stringify(await getOAuthM2MGraphCredential(request, environment))}\n`);
    return 0;
  } catch {
    io.writeStderr('OAuth graph credential unavailable.\n');
    return 1;
  }
}
