import {Array as EffectArray} from 'effect';
import {exportJWK, generateKeyPair, SignJWT} from 'jose';
import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {getOAuthM2MGraphCredential} from '@threadnote/graph/sharing/oauth/m2m_graph_credential';
import {
  getOAuthM2MRegistryCredential,
  getOAuthM2MPublisherRegistryCredential,
} from '@threadnote/graph/sharing/oauth/m2m_registry_credential';
import {createAccessTokenVerifier} from '@threadnote/protocol/access-token';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const now = Math.floor(Date.now() / 1000);
const issuer = 'https://example.okta.test/oauth2/threadnote';
const registryIssuer = 'https://registry-id.example.okta.test/oauth2/threadnote-registry';
const request = {
  audience: 'https://graph.threadnote.test',
  coordinatorUrl: 'https://graph.threadnote.test/org',
  interactive: false,
  issuer,
  organization: 'threadnote',
  profileDigest: `sha256:${Effect.pipe('a', EffectString.repeat(64))}`,
  repositoryId: Effect.pipe('b', EffectString.repeat(64)),
  schemaVersion: 1,
  scopes: ['graph:contribute'],
} as const;
const environment: NodeJS.ProcessEnv = {
  THREADNOTE_OAUTH_GRAPH_M2M_AUDIENCE: request.audience,
  THREADNOTE_OAUTH_GRAPH_M2M_CLIENT_ID: 'syntheticGraphClient',
  THREADNOTE_OAUTH_GRAPH_M2M_CLIENT_SECRET: 'synthetic:+ secret',
  THREADNOTE_OAUTH_GRAPH_M2M_COORDINATOR_URL: request.coordinatorUrl,
  THREADNOTE_OAUTH_GRAPH_M2M_ISSUER: issuer,
  THREADNOTE_OAUTH_GRAPH_M2M_TOKEN_URL: `${issuer}/v1/token`,
  THREADNOTE_OAUTH_GRAPH_M2M_JWKS_URL: `${issuer}/v1/keys`,
  THREADNOTE_OAUTH_GRAPH_M2M_CLIENT_AUTHENTICATION: 'client_secret_basic',
  THREADNOTE_OAUTH_GRAPH_M2M_CLIENT_ID_CLAIM: 'cid',
  THREADNOTE_OAUTH_GRAPH_M2M_ORGANIZATION: request.organization,
  THREADNOTE_OAUTH_GRAPH_M2M_PROFILE_DIGEST: request.profileDigest,
  THREADNOTE_OAUTH_GRAPH_M2M_REPOSITORY_ID: request.repositoryId,
  THREADNOTE_OAUTH_GRAPH_M2M_SCOPES: 'graph:read graph:contribute',
  THREADNOTE_OAUTH_GRAPH_M2M_SUBJECT: 'syntheticGraphClient',
};
const registryEnvironment: NodeJS.ProcessEnv = {
  ...environment,
  THREADNOTE_OAUTH_REGISTRY_M2M_AUDIENCE: 'https://registry.threadnote.test',
  THREADNOTE_OAUTH_REGISTRY_M2M_ORIGIN: 'https://registry.threadnote.test',
  THREADNOTE_OAUTH_REGISTRY_M2M_ISSUER: registryIssuer,
  THREADNOTE_OAUTH_REGISTRY_M2M_TOKEN_URL: `${registryIssuer}/v1/token`,
  THREADNOTE_OAUTH_REGISTRY_M2M_JWKS_URL: `${registryIssuer}/v1/keys`,
  THREADNOTE_OAUTH_REGISTRY_M2M_CLIENT_AUTHENTICATION: 'client_secret_basic',
  THREADNOTE_OAUTH_REGISTRY_M2M_CLIENT_ID_CLAIM: 'cid',
  THREADNOTE_OAUTH_REGISTRY_M2M_CLIENT_ID: 'syntheticWorkerClient',
  THREADNOTE_OAUTH_REGISTRY_M2M_CLIENT_SECRET: 'synthetic-worker-secret',
  THREADNOTE_OAUTH_REGISTRY_M2M_SUBJECT: 'syntheticWorkerClient',
  THREADNOTE_OAUTH_PUBLISHER_M2M_CLIENT_ID: 'syntheticPublisherClient',
  THREADNOTE_OAUTH_PUBLISHER_M2M_CLIENT_SECRET: 'synthetic-publisher-secret',
  THREADNOTE_OAUTH_PUBLISHER_M2M_SUBJECT: 'syntheticPublisherClient',
};

async function token(privateKey: CryptoKey, claims: Record<string, unknown> = {}) {
  return new SignJWT({
    aud: request.audience,
    iss: issuer,
    sub: 'syntheticGraphClient',
    cid: 'syntheticGraphClient',
    scp: ['graph:contribute'],
    iat: now,
    exp: now + 300,
    ...claims,
  })
    .setProtectedHeader({alg: 'RS256'})
    .sign(privateKey);
}

function response(accessToken: string) {
  return Response.json({access_token: accessToken, expires_in: 300, token_type: 'Bearer', scope: 'graph:contribute'});
}

describe('OAuth client credentials for an Okta custom authorization server', () => {
  it('uses the exact token endpoint and encoded Basic credentials without an audience form parameter', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    const signed = await token(privateKey);
    const credential = await getOAuthM2MGraphCredential(request, environment, {
      key: async () => publicKey,
      now: () => now * 1000,
      fetch: async (url, init) => {
        expect(url.href).toBe(`${issuer}/v1/token`);
        expect(new Headers(init.headers).get('authorization')).toBe(
          `Basic ${Buffer.from('syntheticGraphClient:synthetic%3A%2B+secret').toString('base64')}`,
        );
        expect(EffectRecord.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
          grant_type: 'client_credentials',
          scope: 'graph:contribute',
        });
        expect(init.redirect).toBe('error');
        return response(signed);
      },
    });
    expect(credential.expiresAt).toBe(now + 300);
    const verified = await createAccessTokenVerifier(publicKey, {issuer, audience: request.audience})(
      credential.accessToken,
    );
    expect(verified.scopes).toEqual(new Set(['graph:contribute']));
  });

  it('verifies the signature using the explicit JWKS endpoint without deriving a root Auth0 path', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    const signed = await token(privateKey);
    const jwk = await exportJWK(publicKey);
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      urls.push(String(url));
      return Response.json({keys: [{...jwk, alg: 'RS256', use: 'sig'}]});
    });
    try {
      const credential = await getOAuthM2MGraphCredential(request, environment, {
        now: () => now * 1000,
        fetch: async () => response(signed),
      });
      expect(credential.accessToken).toBe(signed);
      expect(urls).toEqual([`${issuer}/v1/keys`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('supports explicit post authentication and audience request parameter independently of expected audience', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    await getOAuthM2MGraphCredential(
      request,
      {
        ...environment,
        THREADNOTE_OAUTH_GRAPH_M2M_CLIENT_AUTHENTICATION: 'client_secret_post',
        THREADNOTE_OAUTH_GRAPH_M2M_AUDIENCE_PARAMETER: request.audience,
      },
      {
        key: async () => publicKey,
        now: () => now * 1000,
        fetch: async (_url, init) => {
          expect(new Headers(init.headers).has('authorization')).toBe(false);
          expect(EffectRecord.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
            grant_type: 'client_credentials',
            scope: 'graph:contribute',
            audience: request.audience,
            client_id: 'syntheticGraphClient',
            client_secret: 'synthetic:+ secret',
          });
          return response(await token(privateKey));
        },
      },
    );
  });

  it('rejects missing, cross-origin, credential-bearing or noncanonical endpoints and ambiguous aliases before HTTP', async () => {
    const changes: readonly Partial<
      Record<'CLIENT_ID_CLAIM' | 'CLIENT_AUTHENTICATION' | 'TOKEN_URL' | 'JWKS_URL', string | undefined>
    >[] = [
      {TOKEN_URL: undefined},
      {JWKS_URL: undefined},
      {TOKEN_URL: 'https://foreign.example/v1/token'},
      {JWKS_URL: 'https://foreign.example/keys'},
      {TOKEN_URL: `${issuer}/v1/token?secret=value`},
      {TOKEN_URL: 'https://user:password@example.okta.test/token'},
      {TOKEN_URL: 'http://example.okta.test/token'},
      {CLIENT_AUTHENTICATION: 'none'},
      {CLIENT_ID_CLAIM: 'sub'},
    ];
    for (const changed of changes) {
      const ownChanges: Readonly<Record<string, string | undefined>> = {...changed};
      let called = false;
      const env = {
        ...environment,
        // The typed spread keeps only own keys, including explicit undefined overrides.
        ...EffectRecord.fromEntries(
          EffectArray.map(
            EffectArray.map(
              EffectArray.filter(['CLIENT_ID_CLAIM', 'CLIENT_AUTHENTICATION', 'TOKEN_URL', 'JWKS_URL'] as const, name =>
                EffectRecord.has(ownChanges, name),
              ),
              name => [name, changed[name]] as const,
            ),
            ([name, value]) => [`THREADNOTE_OAUTH_GRAPH_M2M_${name}`, value] as const,
          ),
        ),
      };
      await expect(
        getOAuthM2MGraphCredential(request, env, {
          fetch: async () => {
            called = true;
            return response('unused');
          },
        }),
      ).rejects.toThrow('OAuth graph credential unavailable.');
      expect(called).toBe(false);
    }
    await expect(
      getOAuthM2MGraphCredential(request, {...environment, THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET: 'conflicting'}),
    ).rejects.toThrow('OAuth graph credential unavailable.');
  });

  it('rejects mismatched identity, expanded authority and invalid lifetimes in signed Okta-shaped JWTs', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    for (const claims of [
      {iss: `${issuer}/`},
      {aud: [request.audience, 'https://other.example']},
      {sub: 'other'},
      {cid: 'other'},
      {cid: undefined, azp: 'syntheticGraphClient'},
      {scp: ['graph:write']},
      {scp: ['graph:contribute', 'graph:write']},
      {scp: ['graph:contribute', 'graph:contribute']},
      {scp: 'graph:contribute'},
      {scope: 'graph:read'},
      {scope: ['graph:contribute']},
      {exp: now + 601},
      {iat: now - 300, exp: now + 301},
      {nbf: now + 30},
    ]) {
      const signed = await token(privateKey, claims);
      await expect(
        getOAuthM2MGraphCredential(request, environment, {
          key: async () => publicKey,
          now: () => now * 1000,
          fetch: async () => response(signed),
        }),
      ).rejects.toThrow('OAuth graph credential unavailable.');
    }
  });

  it('accepts exactly distinct allowed scp sets containing the requested scope, regardless of order', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('graph:read', 'graph:contribute', 'other', ''), {maxLength: 4}),
        async scopes => {
          const signed = await token(privateKey, {scp: scopes});
          const result = getOAuthM2MGraphCredential(request, environment, {
            key: async () => publicKey,
            now: () => now * 1000,
            fetch: async () =>
              Response.json({
                access_token: signed,
                expires_in: 300,
                token_type: 'Bearer',
                scope: EffectArray.join([...scopes].reverse(), ' '),
              }),
          });
          const valid =
            scopes.includes('graph:contribute') &&
            new Set(scopes).size === scopes.length &&
            EffectArray.every(scopes, scope => ['graph:read', 'graph:contribute'].includes(scope));
          if (valid) expect((await result).accessToken).toBe(signed);
          else await expect(result).rejects.toThrow('OAuth graph credential unavailable.');
        },
      ),
      {numRuns: 40},
    );
  });

  it('keeps worker and publisher registry roles distinct with Okta cid/scp claims', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    for (const role of ['worker', 'publisher'] as const) {
      const clientId = role === 'worker' ? 'syntheticWorkerClient' : 'syntheticPublisherClient';
      const signed = await token(privateKey, {
        aud: 'https://registry.threadnote.test',
        cid: clientId,
        iss: registryIssuer,
        sub: clientId,
        scp: [`registry:${role}`],
      });
      const get = role === 'worker' ? getOAuthM2MRegistryCredential : getOAuthM2MPublisherRegistryCredential;
      const result = await get('registry.threadnote.test', registryEnvironment, {
        key: async () => publicKey,
        now: () => now * 1000,
        fetch: async (url, init) => {
          expect(url.href).toBe(`${registryIssuer}/v1/token`);
          expect(new URLSearchParams(String(init.body)).get('scope')).toBe(`registry:${role}`);
          return Response.json({access_token: signed, expires_in: 300, token_type: 'Bearer'});
        },
      });
      expect(result).toEqual({Username: 'zot', Secret: signed, ServerURL: 'https://registry.threadnote.test'});
    }
    await expect(
      getOAuthM2MPublisherRegistryCredential('registry.threadnote.test', {
        ...registryEnvironment,
        THREADNOTE_OAUTH_PUBLISHER_M2M_CLIENT_ID: 'syntheticWorkerClient',
      }),
    ).rejects.toThrow('OAuth registry credential unavailable.');
  });

  it('uses the registry authority JWKS rather than the graph authority', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    const signed = await token(privateKey, {
      aud: 'https://registry.threadnote.test',
      cid: 'syntheticWorkerClient',
      iss: registryIssuer,
      sub: 'syntheticWorkerClient',
      scp: ['registry:worker'],
    });
    const jwk = await exportJWK(publicKey);
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      urls.push(String(url));
      return Response.json({keys: [{...jwk, alg: 'RS256', use: 'sig'}]});
    });
    try {
      await getOAuthM2MRegistryCredential('registry.threadnote.test', registryEnvironment, {
        now: () => now * 1000,
        fetch: async url => {
          expect(url.href).toBe(`${registryIssuer}/v1/token`);
          return Response.json({access_token: signed, expires_in: 300, token_type: 'Bearer'});
        },
      });
      expect(urls).toEqual([`${registryIssuer}/v1/keys`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
