import {exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK, type JWTPayload} from 'jose';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createOAuthTokenVerifier} from '@threadnote/remote-memory/oauth';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const ISSUER = 'https://identity.example.test/tenant';
const AUDIENCE = 'https://memory.example.test/mcp';

interface SigningKey {
  readonly algorithm: 'ES256' | 'RS256';
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

let rsa: SigningKey;
let ec: SigningKey;
let jwksServer: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  rsa = await signingKey('RS256', 'rsa-1');
  ec = await signingKey('ES256', 'ec-1');
  jwksServer = Bun.serve({
    fetch(request) {
      if (new URL(request.url).pathname !== '/jwks') return new Response('not found', {status: 404});
      return Response.json({keys: [rsa.publicJwk, ec.publicJwk]});
    },
    hostname: '127.0.0.1',
    port: 0,
  });
});

afterAll(async () => {
  await jwksServer.stop(true);
});

function verifier(issuer = ISSUER, clientIdClaim?: 'azp' | 'client_id' | 'cid' | 'azp-or-client_id') {
  return createOAuthTokenVerifier({
    audience: AUDIENCE,
    ...(clientIdClaim === undefined ? {} : {clientIdClaim}),
    issuer,
    jwksUrl: new URL('/jwks', jwksServer.url),
  });
}

async function signingKey(algorithm: 'ES256' | 'RS256', kid: string): Promise<SigningKey> {
  const {privateKey, publicKey} = await generateKeyPair(algorithm, {extractable: true});
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = algorithm;
  publicJwk.kid = kid;
  publicJwk.use = 'sig';
  return {algorithm, kid, privateKey, publicJwk};
}

async function accessToken(overrides: Readonly<Record<string, unknown>> = {}, key: SigningKey = rsa): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    aud: AUDIENCE,
    exp: now + 300,
    iat: now,
    iss: ISSUER,
    nbf: now - 1,
    scope: 'memory:read memory:write:handoff',
    sub: 'oauth-subject',
    ...overrides,
  };
  return new SignJWT(payload)
    .setProtectedHeader({alg: key.algorithm, kid: key.kid, typ: 'at+jwt'})
    .sign(key.privateKey);
}

async function expectUnauthorized(token: string): Promise<void> {
  await expect(verifier().verify(token)).rejects.toMatchObject({
    code: 'unauthorized',
    message: expect.stringMatching(/access token|time claims/u),
    status: 401,
  });
}

describe('remote memory OAuth access tokens', () => {
  it('verifies a bounded RS256 token and returns only stable identity and scopes', async () => {
    const token = await accessToken();

    const claims = await verifier().verify(token);

    expect(claims).toEqual({
      issuer: ISSUER,
      scopes: new Set(['memory:read', 'memory:write:handoff']),
      subject: 'oauth-subject',
    });
    expect(JSON.stringify(claims)).not.toContain(token);
  });

  it('accepts a string-array scp claim and discards non-string entries', async () => {
    const token = await accessToken({scope: undefined, scp: ['memory:read', 7, '', 'memory:admin']});

    expect((await verifier().verify(token)).scopes).toEqual(new Set(['memory:read', 'memory:admin']));
  });

  it('accepts a bounded access token without the optional not-before claim', async () => {
    const token = await accessToken({nbf: undefined});

    expect(await verifier().verify(token)).toMatchObject({issuer: ISSUER, subject: 'oauth-subject'});
  });

  it('extracts the configured Okta client claim for exact server-side identity binding', async () => {
    const token = await accessToken({cid: 'okta-client-reader'});

    expect(await verifier(ISSUER, 'cid').verify(token)).toMatchObject({clientId: 'okta-client-reader'});
    await expect(verifier(ISSUER, 'cid').verify(await accessToken())).rejects.toMatchObject({code: 'unauthorized'});
  });

  it.each([false, true])('matches the exact issuer identifier with trailing slash=%s', async trailingSlash => {
    const issuer = `https://threadnote-org.eu.auth0.com${trailingSlash ? '/' : ''}`;
    const otherIssuer = `https://threadnote-org.eu.auth0.com${trailingSlash ? '' : '/'}`;
    const token = await accessToken({iss: issuer, nbf: undefined});

    expect((await verifier(issuer).verify(token)).issuer).toBe(issuer);
    await expect(verifier(otherIssuer).verify(token)).rejects.toMatchObject({code: 'unauthorized'});
  });

  it.each([null, 'invalid', 0, -1, 0.5])('rejects a malformed optional not-before claim %#', async nbf => {
    await expectUnauthorized(await accessToken({nbf}));
  });

  it.each([
    ['wrong issuer', {iss: 'https://attacker.example.test'}],
    ['wrong audience', {aud: 'https://other.example.test/mcp'}],
    ['missing subject', {sub: undefined}],
    ['missing issued-at', {iat: undefined}],
    ['missing expiry', {exp: undefined}],
  ])('rejects %s', async (_label, overrides) => {
    await expectUnauthorized(await accessToken(overrides));
  });

  it('rejects an expired token and a token whose not-before is in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectUnauthorized(await accessToken({exp: now - 30, iat: now - 330, nbf: now - 331}));
    await expectUnauthorized(await accessToken({exp: now + 600, iat: now, nbf: now + 30}));
  });

  it('rejects excessive or internally inconsistent token lifetimes', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectUnauthorized(await accessToken({exp: now + 606, iat: now, nbf: now}));
    await expectUnauthorized(await accessToken({exp: now, iat: now, nbf: now}));
    await expectUnauthorized(await accessToken({exp: now + 300, iat: now, nbf: now + 6}));
  });

  it('rejects a correctly signed token using a non-RS256 algorithm', async () => {
    await expectUnauthorized(await accessToken({}, ec));
  });

  it.each([
    'not-a-jwt',
    'a.b.c',
    '',
    `${Effect.pipe('x', EffectString.repeat(32))}.${Effect.pipe('y', EffectString.repeat(32))}.${Effect.pipe('z', EffectString.repeat(32))}`,
  ])('maps malformed JWT input to one bounded public error %#', async token => {
    await expectUnauthorized(token);
  });

  it('does not disclose token or JWKS detail when signature verification fails', async () => {
    const unrelated = await signingKey('RS256', 'rsa-1');
    const token = await accessToken({}, unrelated);

    let caught: unknown;
    try {
      await verifier().verify(token);
    } catch (cause) {
      caught = cause;
    }
    const serialized = JSON.stringify(caught);
    expect(caught).toMatchObject({code: 'unauthorized', status: 401});
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('JWKS');
    expect(serialized.length).toBeLessThan(300);
  });
});
