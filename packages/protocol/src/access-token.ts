import {Array as EffectArray} from 'effect';
import {createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey} from 'jose';
import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const ACCESS_TOKEN_ERRORS = {
  invalidBearer: 'The bearer access token is invalid.',
  invalidLifetime: 'The access token lifetime is invalid.',
  invalidTime: 'The access token time claims are invalid.',
  missingBearer: 'A bearer access token is required.',
  missingIdentity: 'The access token is missing its issuer or subject.',
  unverifiable: 'The access token could not be verified.',
} as const;

export class AccessTokenError extends Schema.TaggedError<AccessTokenError, {readonly brand: unique symbol}>()(
  'AccessTokenError',
  {
    message: Schema.String,
    reason: Schema.Literals([
      'invalidBearer',
      'invalidLifetime',
      'invalidTime',
      'missingBearer',
      'missingIdentity',
      'unverifiable',
    ]),
  },
) {
  static of(reason: keyof typeof ACCESS_TOKEN_ERRORS) {
    return AccessTokenError.make({message: ACCESS_TOKEN_ERRORS[reason], reason});
  }
}

export interface AccessTokenClaims {
  readonly clientId?: string;
  readonly expiresAt: number;
  readonly issuer: string;
  readonly scopes: ReadonlySet<string>;
  readonly subject: string;
}

export interface AccessTokenConfig {
  readonly audience: string;
  readonly clientId?: string;
  readonly clientIdClaim?: 'azp' | 'client_id' | 'cid' | 'azp-or-client_id';
  readonly issuer: string;
}

export function parseBearerAccessToken(authorization: string | null | undefined): string {
  if (!authorization) throw AccessTokenError.of('missingBearer');
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match?.[1] || Buffer.byteLength(match[1], 'utf8') > 16 * 1024) {
    throw AccessTokenError.of('invalidBearer');
  }
  return match[1];
}

export function createRemoteAccessTokenVerifier(config: AccessTokenConfig & {readonly jwksUrl: URL}) {
  return createAccessTokenVerifier(
    createRemoteJWKSet(config.jwksUrl, {cacheMaxAge: 5 * 60_000, timeoutDuration: 3000}),
    config,
  );
}

export function createAccessTokenVerifier(key: CryptoKey | JWTVerifyGetKey, config: AccessTokenConfig) {
  return async (token: string): Promise<AccessTokenClaims> => {
    let payload: JWTPayload;
    try {
      ({payload} = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        audience: config.audience,
        clockTolerance: 5,
        issuer: config.issuer,
        maxTokenAge: '10 minutes',
        requiredClaims: ['sub', 'iat', 'exp'],
      }));
    } catch {
      throw AccessTokenError.of('unverifiable');
    }
    if (!exactAudience(payload.aud, config.audience)) throw AccessTokenError.of('unverifiable');
    if (!payload.iss || !payload.sub) throw AccessTokenError.of('missingIdentity');
    const issuedAt = numericDate(payload.iat);
    const expiresAt = numericDate(payload.exp);
    const notBefore = payload.nbf === undefined ? issuedAt : numericDate(payload.nbf);
    if (expiresAt <= issuedAt || expiresAt - issuedAt > 605 || notBefore > issuedAt + 5) {
      throw AccessTokenError.of('invalidLifetime');
    }
    const scopes = config.clientIdClaim === undefined ? legacyTokenScopes(payload) : tokenScopes(payload);
    const clientId = configuredClientId(payload, config);
    return {
      ...(clientId === undefined ? {} : {clientId}),
      expiresAt,
      issuer: payload.iss,
      scopes,
      subject: payload.sub,
    };
  };
}

function exactAudience(audience: JWTPayload['aud'], expected: string): boolean {
  return audience === expected || (EffectArray.isArray(audience) && audience.length === 1 && audience[0] === expected);
}

function configuredClientId(payload: JWTPayload, config: AccessTokenConfig): string | undefined {
  if (config.clientId === undefined && config.clientIdClaim === undefined) return undefined;
  if (config.clientIdClaim === undefined) throw AccessTokenError.of('unverifiable');
  let clientId: unknown;
  if (config.clientIdClaim === 'azp-or-client_id') {
    if (payload.azp !== undefined && payload.client_id !== undefined && payload.azp !== payload.client_id)
      throw AccessTokenError.of('unverifiable');
    clientId = payload.azp ?? payload.client_id;
  } else {
    clientId = payload[config.clientIdClaim];
  }
  if (
    typeof clientId !== 'string' ||
    clientId.length === 0 ||
    (config.clientId !== undefined && clientId !== config.clientId)
  )
    throw AccessTokenError.of('unverifiable');
  return clientId;
}

function legacyTokenScopes(payload: JWTPayload): ReadonlySet<string> {
  const rawScopes =
    typeof payload.scope === 'string' ? Effect.pipe(payload.scope, EffectString.split(/\s+/)) : payload.scp;
  return new Set(
    EffectArray.isArray(rawScopes)
      ? EffectArray.filter(rawScopes, (item): item is string => typeof item === 'string' && item.length > 0)
      : [],
  );
}

function tokenScopes(payload: JWTPayload): ReadonlySet<string> {
  const scope = payload.scope === undefined ? undefined : scopeList(payload.scope);
  const scp = payload.scp === undefined ? undefined : scopeList(payload.scp);
  if (payload.scope !== undefined && scope === undefined) throw AccessTokenError.of('unverifiable');
  if (payload.scp !== undefined && scp === undefined) throw AccessTokenError.of('unverifiable');
  if (scope !== undefined && scp !== undefined && !sameSet(scope, scp)) throw AccessTokenError.of('unverifiable');
  return new Set(scope ?? scp ?? []);
}

const isScopeList = (value: unknown): value is readonly string[] =>
  EffectArray.isArray(value) &&
  EffectArray.every(value, (item): item is string => typeof item === 'string' && item.length > 0 && !/\s/u.test(item));

function scopeList(value: unknown): string[] | undefined {
  const result =
    typeof value === 'string'
      ? EffectArray.filter(Effect.pipe(value, EffectString.split(/\s+/)), Boolean)
      : isScopeList(value)
        ? [...value]
        : undefined;
  if (result === undefined || new Set(result).size !== result.length) return undefined;
  return result;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && EffectArray.every(left, item => right.includes(item));
}

function numericDate(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw AccessTokenError.of('invalidTime');
  return Number(value);
}
