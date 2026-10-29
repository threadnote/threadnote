import {Array as EffectArray} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface OAuthM2MProviderConfig {
  readonly tokenUrl: string;
  readonly jwksUrl: string;
  readonly clientAuthentication: 'client_secret_basic' | 'client_secret_post';
  readonly clientIdClaim: 'azp' | 'client_id' | 'cid' | 'azp-or-client_id';
  readonly audienceParameter?: string;
}

export function oauthCredentialEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = {...environment};
  for (const [name, value] of EffectRecord.toEntries(environment)) {
    if (!/^THREADNOTE_AUTH0_(GRAPH|REGISTRY|PUBLISHER)_M2M_/u.test(name) || value === undefined) continue;
    const generic = Effect.pipe(name, EffectString.replace('THREADNOTE_AUTH0_', 'THREADNOTE_OAUTH_'));
    if (result[generic] !== undefined && result[generic] !== value)
      throw new Error('OAuth credential configuration is invalid.');
    result[generic] = value;
  }
  return result;
}

export function canonicalOAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 512 &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.href === value || (url.pathname === '/' && url.origin === value))
    );
  } catch {
    return false;
  }
}

export function sameOriginOAuthEndpoint(value: string, issuer: string): boolean {
  return canonicalOAuthUrl(value) && canonicalOAuthUrl(issuer) && new URL(value).origin === new URL(issuer).origin;
}

export function parseOAuthM2MProviderConfig(
  environment: NodeJS.ProcessEnv,
  role: 'GRAPH' | 'REGISTRY',
): OAuthM2MProviderConfig {
  const env = oauthCredentialEnvironment(environment);
  const prefix = `THREADNOTE_OAUTH_${role}_M2M_`;
  const issuer = env[`${prefix}ISSUER`];
  const legacy =
    environment[`THREADNOTE_AUTH0_${role}_M2M_ISSUER`] !== undefined && environment[`${prefix}ISSUER`] === undefined;
  if (!issuer || !canonicalOAuthUrl(issuer) || (legacy && new URL(issuer).pathname !== '/'))
    throw new Error('OAuth credential configuration is invalid.');
  const tokenUrl = env[`${prefix}TOKEN_URL`] ?? (legacy ? new URL('oauth/token', issuer).href : undefined);
  const jwksUrl = env[`${prefix}JWKS_URL`] ?? (legacy ? new URL('.well-known/jwks.json', issuer).href : undefined);
  const clientAuthentication = env[`${prefix}CLIENT_AUTHENTICATION`] ?? (legacy ? 'client_secret_post' : undefined);
  const clientIdClaim = env[`${prefix}CLIENT_ID_CLAIM`] ?? (legacy ? 'azp-or-client_id' : undefined);
  const audienceParameter = env[`${prefix}AUDIENCE_PARAMETER`] ?? (legacy ? env[`${prefix}AUDIENCE`] : undefined);
  if (
    !tokenUrl ||
    !jwksUrl ||
    !sameOriginOAuthEndpoint(tokenUrl, issuer) ||
    !sameOriginOAuthEndpoint(jwksUrl, issuer) ||
    (clientAuthentication !== 'client_secret_basic' && clientAuthentication !== 'client_secret_post') ||
    (clientIdClaim !== 'azp' &&
      clientIdClaim !== 'client_id' &&
      clientIdClaim !== 'cid' &&
      clientIdClaim !== 'azp-or-client_id') ||
    (audienceParameter !== undefined &&
      (!audienceParameter ||
        audienceParameter.length > 512 ||
        EffectArray.some(
          [...audienceParameter],
          character =>
            Effect.pipe(
              character,
              EffectString.charCodeAt(0),
              Effect.Option.getOrElse(() => NaN),
            ) <= 32 ||
            Effect.pipe(
              character,
              EffectString.charCodeAt(0),
              Effect.Option.getOrElse(() => NaN),
            ) === 127,
        )))
  )
    throw new Error('OAuth credential configuration is invalid.');
  return {
    tokenUrl,
    jwksUrl,
    clientAuthentication,
    clientIdClaim,
    ...(audienceParameter === undefined ? {} : {audienceParameter}),
  };
}
