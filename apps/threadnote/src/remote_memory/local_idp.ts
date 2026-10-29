import {exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK} from 'jose';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {randomUuidV4} from '../crypto/uuid.js';
import {
  COMPOSER_OAUTH_SCOPES,
  createLocalOAuthTokenVerifier,
  type OAuthTokenVerifier,
} from '@threadnote/remote-memory/oauth';
import {remoteMemoryError} from '@threadnote/remote-memory/errors';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

export const COMPOSER_OAUTH_CLIENT_ID = 'threadnote-composer';
export const LOCAL_COMPOSER_DEFAULT_LISTEN = '127.0.0.1:18788';
export const COMPOSER_OAUTH_REDIRECT_URIS = [
  'http://127.0.0.1:8787/callback',
  'http://localhost:8787/callback',
  'cursor://anysphere.cursor-mcp/oauth/callback',
] as const;
const AUTHORIZATION_CODE_TTL_SECONDS = 60;
const ACCESS_TOKEN_TTL_SECONDS = 300;
const MAX_OUTSTANDING_AUTHORIZATION_CODES = 32;
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export interface LocalIdp {
  readonly audience: string;
  readonly clientId: string;
  readonly handle: (request: Request) => Promise<Response | undefined>;
  readonly issuer: string;
  readonly issueAccessToken: (input?: {readonly scope?: string; readonly subject?: string}) => Promise<string>;
  readonly publicKey: CryptoKey;
  readonly publicJwk: JWK;
  readonly subject: string;
  readonly verifier: () => OAuthTokenVerifier;
}

export interface LocalIdpOptions {
  readonly audience: string;
  readonly issuer: string;
  readonly subject: string;
}

interface AuthorizationCode {
  readonly challenge: string;
  readonly expiresAt: number;
  readonly redirectUri: string;
  readonly scope: string;
  readonly subject: string;
}

export async function createLocalIdp(options: LocalIdpOptions): Promise<LocalIdp> {
  const issuer = canonicalizeIssuer(options.issuer);
  const audience = Effect.pipe(options.audience, EffectString.trim);
  const subject = Effect.pipe(options.subject, EffectString.trim);
  if (!audience || !subject) {
    throw remoteMemoryError('invalid_request', 'The local OAuth issuer requires an audience and subject.');
  }
  const {privateKey, publicKey} = await generateKeyPair('RS256', {extractable: true});
  const publicJwk = await exportJWK(publicKey);
  const kid = randomUuidV4();
  publicJwk.alg = 'RS256';
  publicJwk.kid = kid;
  publicJwk.use = 'sig';
  const codes = new Map<string, AuthorizationCode>();
  const verifier = createLocalOAuthTokenVerifier({audience, issuer, publicKey});
  const defaultScope = EffectArray.join(COMPOSER_OAUTH_SCOPES, ' ');

  const issueAccessToken = async (input?: {readonly scope?: string; readonly subject?: string}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      aud: audience,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
      iat: now,
      iss: issuer,
      nbf: now,
      scope:
        Effect.pipe(input?.scope, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
        ) || defaultScope,
      sub:
        Effect.pipe(input?.subject, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
        ) || subject,
    })
      .setProtectedHeader({alg: 'RS256', kid, typ: 'at+jwt'})
      .sign(privateKey);
  };

  return {
    audience,
    clientId: COMPOSER_OAUTH_CLIENT_ID,
    handle: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/.well-known/oauth-authorization-server') {
        if (request.method !== 'GET') return methodNotAllowed('GET');
        return jsonResponse(200, authorizationServerMetadata(issuer));
      }
      if (path === '/.well-known/jwks.json') {
        if (request.method !== 'GET') return methodNotAllowed('GET');
        return jsonResponse(200, {keys: [publicJwk]});
      }
      if (path === '/authorize') {
        if (request.method !== 'GET') return methodNotAllowed('GET');
        return authorize(request, codes, subject, defaultScope);
      }
      if (path === '/token') {
        if (request.method !== 'POST') return methodNotAllowed('POST');
        return token(request, codes, issueAccessToken);
      }
      if (path === '/register') {
        if (request.method !== 'POST') return methodNotAllowed('POST');
        return registerClient();
      }
      return undefined;
    },
    issuer,
    issueAccessToken,
    publicKey,
    publicJwk,
    subject,
    verifier: () => verifier,
  };
}

export function isLocalIdpPath(path: string): boolean {
  return (
    path === '/.well-known/oauth-authorization-server' ||
    path === '/.well-known/jwks.json' ||
    path === '/authorize' ||
    path === '/token' ||
    path === '/register'
  );
}

export function authorizationServerMetadata(issuer: string) {
  return {
    authorization_endpoint: `${issuer}/authorize`,
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code'],
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    scopes_supported: [...COMPOSER_OAUTH_SCOPES],
    token_endpoint: `${issuer}/token`,
    token_endpoint_auth_methods_supported: ['none'],
  } as const;
}

function authorize(
  request: Request,
  codes: Map<string, AuthorizationCode>,
  subject: string,
  defaultScope: string,
): Response {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id') ?? '';
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  const responseType = url.searchParams.get('response_type') ?? '';
  const challenge = url.searchParams.get('code_challenge') ?? '';
  const method = url.searchParams.get('code_challenge_method') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const scope =
    Effect.pipe(url.searchParams.get('scope'), effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) || defaultScope;
  if (clientId !== COMPOSER_OAUTH_CLIENT_ID) return oauthError(400, 'invalid_client');
  if (responseType !== 'code') return oauthError(400, 'unsupported_response_type');
  if (!isAllowedRedirect(redirectUri)) return oauthError(400, 'invalid_request', 'redirect_uri is not allowed');
  if (method !== 'S256' || !isPkceChallenge(challenge)) {
    return oauthError(400, 'invalid_request', 'PKCE S256 is required');
  }
  const now = Date.now();
  for (const [storedCode, stored] of codes) {
    if (stored.expiresAt <= now) codes.delete(storedCode);
  }
  if (codes.size >= MAX_OUTSTANDING_AUTHORIZATION_CODES) {
    const oldest = Effect.pipe([...codes.entries()], __effectReduceValues =>
      EffectArray.reduce(
        EffectArray.drop(__effectReduceValues, 1),
        Effect.Option.getOrElse(EffectArray.head(__effectReduceValues), () => {
          throw new TypeError('Reduce of empty array with no initial value');
        }),
        (current, candidate) => (candidate[1].expiresAt < current[1].expiresAt ? candidate : current),
      ),
    );
    codes.delete(oldest[0]);
  }
  const code = randomUrlSafe(32);
  codes.set(code, {
    challenge,
    expiresAt: now + AUTHORIZATION_CODE_TTL_SECONDS * 1000,
    redirectUri,
    scope,
    subject,
  });
  const location = new URL(redirectUri);
  location.searchParams.set('code', code);
  if (state) location.searchParams.set('state', state);
  return new Response(null, {headers: {location: location.toString()}, status: 302});
}

async function token(
  request: Request,
  codes: Map<string, AuthorizationCode>,
  issueAccessToken: (input?: {readonly scope?: string; readonly subject?: string}) => Promise<string>,
): Promise<Response> {
  const body = await request.text();
  if (Buffer.byteLength(body, 'utf8') > 16 * 1024) return oauthError(400, 'invalid_request');
  const params = new URLSearchParams(body);
  const grant = params.get('grant_type') ?? '';
  const clientId = params.get('client_id') ?? '';
  if (clientId !== COMPOSER_OAUTH_CLIENT_ID) return oauthError(401, 'invalid_client');
  if (grant !== 'authorization_code') return oauthError(400, 'unsupported_grant_type');
  const code = params.get('code') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const verifier = params.get('code_verifier') ?? '';
  const stored = codes.get(code);
  codes.delete(code);
  if (!stored || stored.expiresAt <= Date.now()) return oauthError(400, 'invalid_grant');
  if (stored.redirectUri !== redirectUri) return oauthError(400, 'invalid_grant');
  if (!isPkceVerifier(verifier) || !equalSecret(pkceS256Challenge(verifier), stored.challenge)) {
    return oauthError(400, 'invalid_grant');
  }
  const accessToken = await issueAccessToken({scope: stored.scope, subject: stored.subject});
  return jsonResponse(200, tokenResponse(accessToken, stored.scope));
}

function registerClient(): Response {
  return jsonResponse(201, {
    client_id: COMPOSER_OAUTH_CLIENT_ID,
    grant_types: ['authorization_code'],
    redirect_uris: [...COMPOSER_OAUTH_REDIRECT_URIS],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

function tokenResponse(accessToken: string, scope: string) {
  return {
    access_token: accessToken,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope,
    token_type: 'Bearer',
  };
}

function isAllowedRedirect(redirectUri: string): boolean {
  return (COMPOSER_OAUTH_REDIRECT_URIS as readonly string[]).includes(redirectUri);
}

function isPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/u.test(value);
}

function isPkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9-._~]{43,128}$/u.test(value);
}

export function pkceS256Challenge(verifier: string): string {
  return base64UrlEncode(hexToBytes(sha256HexSync(verifier)));
}

function randomUrlSafe(bytes: number): string {
  return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(Effect.pipe(hex, EffectString.slice(index * 2, index * 2 + 2)), 16);
  }
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return Effect.pipe(
    btoa(binary),
    EffectString.replaceAll('+', '-'),
    EffectString.replaceAll('/', '_'),
    EffectString.replaceAll('=', ''),
  );
}

function equalSecret(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |=
      Effect.pipe(
        left,
        EffectString.charCodeAt(index),
        Effect.Option.getOrElse(() => NaN),
      ) ^
      Effect.pipe(
        right,
        EffectString.charCodeAt(index),
        Effect.Option.getOrElse(() => NaN),
      );
  }
  return diff === 0;
}

function canonicalizeIssuer(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw remoteMemoryError('invalid_request', 'The local OAuth issuer must use HTTPS outside loopback.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw remoteMemoryError('invalid_request', 'The local OAuth issuer must be a credential-free origin.');
  }
  return Effect.pipe(url.toString(), EffectString.replace(/\/$/u, ''));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'cache-control': 'no-store',
      'content-type': JSON_CONTENT_TYPE,
    },
    status,
  });
}

function oauthError(status: number, error: string, description?: string): Response {
  return jsonResponse(status, description ? {error, error_description: description} : {error});
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, {headers: {allow}, status: 405});
}
