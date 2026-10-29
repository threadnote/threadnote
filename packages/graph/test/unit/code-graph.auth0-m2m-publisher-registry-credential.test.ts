import {generateKeyPair, SignJWT} from 'jose';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  getAuth0M2MPublisherRegistryCredential,
  parseAuth0M2MPublisherRegistryCredentialConfig,
  runAuth0M2MPublisherRegistryCredentialHelper,
} from '@threadnote/graph/sharing/auth0/m2m_registry_credential';
import * as EffectRecord from 'effect/Record';

const now = Math.floor(Date.now() / 1000);
const origin = 'https://registry.threadnote.test';
const issuer = 'https://threadnote-org.eu.auth0.com/';
const environment = {
  THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_ID: 'syntheticGraphClientId123',
  THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET: 'separate-graph-secret',
  THREADNOTE_AUTH0_GRAPH_M2M_SUBJECT: 'syntheticGraphClientId123@clients',
  THREADNOTE_AUTH0_REGISTRY_M2M_AUDIENCE: origin,
  THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_ID: 'syntheticWorkerClientId123',
  THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_SECRET: 'separate-worker-secret',
  THREADNOTE_AUTH0_REGISTRY_M2M_ISSUER: issuer,
  THREADNOTE_AUTH0_REGISTRY_M2M_ORIGIN: origin,
  THREADNOTE_AUTH0_REGISTRY_M2M_SUBJECT: 'syntheticWorkerClientId123@clients',
  THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_ID: 'syntheticPublisherClient123',
  THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_SECRET: 'separate-publisher-secret',
  THREADNOTE_AUTH0_PUBLISHER_M2M_SUBJECT: 'syntheticPublisherClient123@clients',
};

describe('Auth0 M2M Zot publisher Docker helper', () => {
  it('requests only registry:publisher using a distinct publisher client and the exact worker Zot audience', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    const token = await signedToken(privateKey);
    const credential = await getAuth0M2MPublisherRegistryCredential('registry.threadnote.test', environment, {
      key: async () => publicKey,
      now: () => now * 1000,
      fetch: async (url, init) => {
        expect(String(url)).toBe(`${issuer}oauth/token`);
        expect(EffectRecord.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
          audience: origin,
          client_id: environment.THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_ID,
          client_secret: environment.THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_SECRET,
          grant_type: 'client_credentials',
          scope: 'registry:publisher',
        });
        return Response.json({access_token: token, expires_in: 600, scope: 'registry:publisher', token_type: 'Bearer'});
      },
    });
    expect(credential).toEqual({Username: 'zot', Secret: token, ServerURL: origin});
  });

  it('rejects reused worker or graph identity and invalid publisher configuration', () => {
    for (const override of [
      {THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_ID: environment.THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_ID},
      {THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_SECRET: environment.THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_SECRET},
      {THREADNOTE_AUTH0_PUBLISHER_M2M_SUBJECT: environment.THREADNOTE_AUTH0_REGISTRY_M2M_SUBJECT},
      {THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_ID: environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_ID},
      {THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_SECRET: environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET},
      {THREADNOTE_AUTH0_PUBLISHER_M2M_SUBJECT: environment.THREADNOTE_AUTH0_GRAPH_M2M_SUBJECT},
      {THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_SECRET: undefined},
      {THREADNOTE_AUTH0_PUBLISHER_M2M_SUBJECT: 'bad\nsubject'},
      {THREADNOTE_AUTH0_REGISTRY_M2M_AUDIENCE: `${origin}/`},
    ])
      expect(() => parseAuth0M2MPublisherRegistryCredentialConfig({...environment, ...override})).toThrow(
        'OAuth registry credential unavailable.',
      );
  });

  it('rejects worker role, wrong host, client, subject, and overlong lifetime', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    for (const claims of [
      {scope: 'registry:worker'},
      {aud: 'https://other.threadnote.test'},
      {azp: environment.THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_ID},
      {sub: environment.THREADNOTE_AUTH0_REGISTRY_M2M_SUBJECT},
      {exp: now + 601},
    ]) {
      const token = await signedToken(privateKey, claims);
      await expect(
        getAuth0M2MPublisherRegistryCredential('registry.threadnote.test', environment, {
          key: async () => publicKey,
          now: () => now * 1000,
          fetch: async () => Response.json({access_token: token, expires_in: 600, token_type: 'Bearer'}),
        }),
      ).rejects.toThrow('OAuth registry credential unavailable.');
    }
  });

  it('never requests Auth0 for any nonempty mutation of the configured registry host', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({minLength: 1, maxLength: 30}), async suffix => {
        let called = false;
        await expect(
          getAuth0M2MPublisherRegistryCredential(`registry.threadnote.test${suffix}`, environment, {
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

  it('keeps stdout empty for unsupported Docker commands and malformed get input', async () => {
    for (const [arguments_, input] of [
      [['store'], 'registry.threadnote.test\n'],
      [['get'], 'https://registry.threadnote.test\n'],
      [['get'], 'registry.threadnote.test\nother\n'],
    ] as const) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runAuth0M2MPublisherRegistryCredentialHelper(arguments_, environment, {
        stdin: (async function* () {
          yield input;
        })(),
        writeStderr: text => stderr.push(text),
        writeStdout: text => stdout.push(text),
      });
      expect(code).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual(['OAuth registry credential unavailable.\n']);
    }
  });
});

async function signedToken(privateKey: CryptoKey, claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    aud: origin,
    azp: environment.THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_ID,
    gty: 'client-credentials',
    iss: issuer,
    scope: 'registry:publisher',
    sub: environment.THREADNOTE_AUTH0_PUBLISHER_M2M_SUBJECT,
    ...claims,
  })
    .setProtectedHeader({alg: 'RS256'})
    .setIssuedAt(now)
    .setExpirationTime(typeof claims.exp === 'number' ? claims.exp : now + 600)
    .sign(privateKey);
}
