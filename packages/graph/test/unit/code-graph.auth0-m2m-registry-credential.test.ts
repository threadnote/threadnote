import {generateKeyPair, SignJWT} from 'jose';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  getAuth0M2MRegistryCredential,
  parseAuth0M2MRegistryCredentialConfig,
} from '@threadnote/graph/sharing/auth0/m2m_registry_credential';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const now = Math.floor(Date.now() / 1000);
const origin = 'https://registry.threadnote.test';
const issuer = 'https://threadnote-org.eu.auth0.com/';
const environment = {
  THREADNOTE_AUTH0_GRAPH_M2M_AUDIENCE: 'https://graph.threadnote.test/',
  THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_ID: 'syntheticGraphClientId123',
  THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET: 'separate-graph-secret',
  THREADNOTE_AUTH0_REGISTRY_M2M_AUDIENCE: origin,
  THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_ID: 'syntheticRegistryClientId123',
  THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_SECRET: 'synthetic-registry-secret',
  THREADNOTE_AUTH0_REGISTRY_M2M_ISSUER: issuer,
  THREADNOTE_AUTH0_REGISTRY_M2M_ORIGIN: origin,
  THREADNOTE_AUTH0_REGISTRY_M2M_SUBJECT: 'syntheticRegistryClientId123@clients',
};

describe('Auth0 M2M Zot registry Docker helper', () => {
  it('uses a separate exact registry audience and returns Docker get credentials for Zot', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    let calls = 0;
    const credential = await getAuth0M2MRegistryCredential('registry.threadnote.test', environment, {
      key: async () => publicKey,
      now: () => now * 1000,
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe(`${issuer}oauth/token`);
        const form = new URLSearchParams(String(init?.body));
        expect(EffectRecord.fromEntries(form)).toEqual({
          audience: origin,
          client_id: environment.THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_ID,
          client_secret: environment.THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_SECRET,
          grant_type: 'client_credentials',
          scope: 'registry:worker',
        });
        expect(init?.redirect).toBe('error');
        return Response.json({access_token: token, expires_in: 600, scope: 'registry:worker', token_type: 'Bearer'});
      },
    });
    expect(calls).toBe(1);
    expect(credential).toEqual({Username: 'zot', Secret: token, ServerURL: origin});
    expect(JSON.stringify({...credential, Secret: '[redacted]'})).not.toContain(
      environment.THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_SECRET,
    );
  });

  it('rejects server and audience swaps before any Auth0 request', async () => {
    for (const server of [
      'graph.threadnote.test',
      'registry.threadnote.test:443',
      'https://registry.threadnote.test',
      'registry.threadnote.test/path',
      'registry.threadnote.test\nother',
    ]) {
      let called = false;
      await expect(
        getAuth0M2MRegistryCredential(server, environment, {
          fetch: async () => {
            called = true;
            return new Response(null);
          },
        }),
      ).rejects.toThrow('OAuth registry credential unavailable.');
      expect(called).toBe(false);
    }
  });

  it('rejects reused graph client credentials, foreign audience, and invalid origin configuration', () => {
    for (const override of [
      {THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_SECRET: environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET},
      {THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_ID: environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_ID},
      {THREADNOTE_AUTH0_REGISTRY_M2M_AUDIENCE: environment.THREADNOTE_AUTH0_GRAPH_M2M_AUDIENCE},
      {THREADNOTE_AUTH0_REGISTRY_M2M_AUDIENCE: `${origin}/`},
      {THREADNOTE_AUTH0_REGISTRY_M2M_ORIGIN: `${origin}/`},
      {THREADNOTE_AUTH0_REGISTRY_M2M_ORIGIN: 'http://registry.threadnote.test'},
      {THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_SECRET: undefined},
      {THREADNOTE_AUTH0_REGISTRY_M2M_SUBJECT: 'bad\nsubject'},
    ])
      expect(() => parseAuth0M2MRegistryCredentialConfig({...environment, ...override})).toThrow(
        'OAuth registry credential unavailable.',
      );
  });

  it('rejects a signed graph token or wrong registry role, client, and lifetime', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    for (const override of [
      {aud: environment.THREADNOTE_AUTH0_GRAPH_M2M_AUDIENCE},
      {scope: 'graph:contribute'},
      {scope: 'registry:worker registry:publisher'},
      {sub: 'other@clients'},
      {azp: environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_ID},
      {exp: now + 30},
    ]) {
      const token = await signedToken(privateKey, override);
      await expect(
        getAuth0M2MRegistryCredential('registry.threadnote.test', environment, {
          key: async () => publicKey,
          now: () => now * 1000,
          fetch: async () => Response.json({access_token: token, expires_in: 600, token_type: 'Bearer'}),
        }),
      ).rejects.toThrow('OAuth registry credential unavailable.');
    }
  });

  it('rejects a signed JWT that exceeds the downstream Docker Secret bound', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    const token = await signedToken(privateKey, {diagnostic_padding: Effect.pipe('x', EffectString.repeat(9000))});
    expect(token.length).toBeGreaterThan(8192);
    expect(token.length).toBeLessThan(16384);
    await expect(
      getAuth0M2MRegistryCredential('registry.threadnote.test', environment, {
        key: async () => publicKey,
        now: () => now * 1000,
        fetch: async () => Response.json({access_token: token, expires_in: 600, token_type: 'Bearer'}),
      }),
    ).rejects.toThrow('OAuth registry credential unavailable.');
  });

  it('never sends a secret for any nonempty mutation of the configured host', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({minLength: 1, maxLength: 30}), async suffix => {
        let called = false;
        await expect(
          getAuth0M2MRegistryCredential(`registry.threadnote.test${suffix}`, environment, {
            fetch: async () => {
              called = true;
              return new Response(null);
            },
          }),
        ).rejects.toThrow('OAuth registry credential unavailable.');
        expect(called).toBe(false);
      }),
      {numRuns: 100},
    );
  });
});

async function signedToken(privateKey: CryptoKey, claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    aud: origin,
    azp: environment.THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_ID,
    gty: 'client-credentials',
    iss: issuer,
    scope: 'registry:worker',
    sub: environment.THREADNOTE_AUTH0_REGISTRY_M2M_SUBJECT,
    ...claims,
  })
    .setProtectedHeader({alg: 'RS256'})
    .setIssuedAt(now)
    .setExpirationTime(typeof claims.exp === 'number' ? claims.exp : now + 600)
    .sign(privateKey);
}
