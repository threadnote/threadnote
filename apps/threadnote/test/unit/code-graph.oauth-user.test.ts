import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {generateKeyPair, SignJWT} from 'jose';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {
  configureGraphOAuthUser,
  configureRegistryOAuthUser,
  getGraphOAuthUserCredential,
  loginGraphOAuthUser,
  logoutGraphOAuthUser,
  type OAuthUserBackend,
} from '@threadnote/graph/sharing/oauth/user';
import {
  runGraphOAuthConfigureCommand,
  runRegistryOAuthConfigureCommand,
} from '@threadnote/threadnote/code_graph/sharing/commands';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {createAccessTokenVerifier} from '@threadnote/protocol/access-token';

import {CliOutput} from '@threadnote/threadnote/effect/cli/output';
import {SystemInfo} from '@threadnote/platform/system';

import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {runtimeConfigForTest} from '@threadnote/workspace/test/helpers/runtime-config';
import {Array as EffectArray} from 'effect';

const systemLayer = TestSystemInfoLayer;
const layer = Layer.merge(systemLayer, TestCommandExecutorLayer.pipe(Layer.provide(systemLayer))).pipe(
  Layer.provideMerge(BunServices.layer),
);
const noOpCliOutput = CliOutput.of({
  drain: Effect.void,
  enqueueError: () => undefined,
  enqueueOutput: () => undefined,
  flush: Effect.void,
  writeError: () => Effect.void,
  writeFinal: () => Effect.void,
});
const issuer = 'https://example.okta.test/oauth2/threadnote';
const graph = {
  audience: 'https://graph.example.test',
  clientId: 'oktaNativeClient123456',
  clientIdClaim: 'cid' as const,
  coordinatorUrl: 'https://graph.example.test/team',
  deviceAuthorizationUrl: `${issuer}/v1/device/authorize`,
  issuer,
  jwksUrl: `${issuer}/v1/keys`,
  organization: 'acme',
  tokenUrl: `${issuer}/v1/token`,
};
const request = {
  audience: graph.audience,
  coordinatorUrl: graph.coordinatorUrl,
  interactive: false,
  issuer,
  organization: graph.organization,
  profileDigest: sha256Digest('profile'),
  repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
  schemaVersion: 1,
  scopes: ['graph:contribute'],
} as const;

describe('provider-neutral OAuth user credentials', () => {
  effectIt.effect('uses explicit Okta endpoints and omits the provider audience request parameter', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-oauth-user-'});
        const runtime = runtimeConfigForTest({agentContextHome: home});
        yield* configureGraphOAuthUser(runtime, graph);
        const publicConfig = JSON.parse(yield* fs.readFileString(path.join(home, 'graph-sharing', 'oauth-user.json')));
        expect(publicConfig).toEqual({
          bindings: [{...graph, credentialAccountVersion: 'oauth-v2', schemaVersion: 2}],
          schemaVersion: 2,
        });
        expect(JSON.stringify(publicConfig)).not.toContain('secret');
        const binding = JSON.parse(
          yield* fs.readFileString(path.join(home, 'graph-sharing', 'control-credentials.json')),
        );
        expect(binding.bindings[0].helper).toBe('oauth');

        let saved: string | undefined;
        const seen: Array<{endpoint: 'device' | 'token'; form: Readonly<Record<string, string>>}> = [];
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const backend: OAuthUserBackend = {
          read: () => Effect.succeed(saved),
          write: (_account, value) => Effect.sync(() => void (saved = value)),
          remove: () => Effect.sync(() => void (saved = undefined)),
          post: (config, endpoint, form) =>
            Effect.sync(() => {
              seen.push({endpoint, form});
              expect(config.deviceAuthorizationUrl).toBe(`${issuer}/v1/device/authorize`);
              expect(config.tokenUrl).toBe(`${issuer}/v1/token`);
              expect(config.jwksUrl).toBe(`${issuer}/v1/keys`);
              return endpoint === 'device'
                ? {
                    status: 200,
                    body: {
                      device_code: 'opaque-device-code',
                      user_code: 'ABCD-EFGH',
                      verification_uri: 'https://example.okta.test/activate',
                      expires_in: 30,
                      interval: 1,
                    },
                  }
                : {
                    status: 200,
                    body: {
                      access_token: 'synthetic.okta.token',
                      refresh_token: 'opaque-refresh-token',
                      token_type: 'Bearer',
                    },
                  };
            }),
          verify: config =>
            Effect.succeed({
              clientId: config.clientId,
              expiresAt: now + 300,
              issuer: config.issuer,
              scopes: new Set(['graph:read', 'graph:contribute']),
              subject: '00u-pilot-user',
            }),
        };
        expect((yield* loginGraphOAuthUser(home, backend)).subject).toBe('00u-pilot-user');
        expect(seen[0]).toEqual({
          endpoint: 'device',
          form: {client_id: graph.clientId, scope: 'offline_access graph:read graph:contribute'},
        });
        expect(seen[1]?.form).toEqual({
          client_id: graph.clientId,
          device_code: 'opaque-device-code',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        expect((yield* getGraphOAuthUserCredential(home, request, backend)).accessToken).toBe('synthetic.okta.token');
      }),
    ).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect('migrates readable Auth0 v1 bindings into the generic v2 file when adding Okta', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-oauth-migration-'});
        const root = path.join(home, 'graph-sharing');
        yield* fs.makeDirectory(root);
        yield* fs.writeFileString(
          path.join(root, 'auth0-user.json'),
          JSON.stringify({
            bindings: [
              {
                audience: 'https://legacy-graph.example.test',
                clientId: 'legacyNativeClient1234',
                coordinatorUrl: 'https://legacy-graph.example.test/team',
                issuer: 'https://legacy.auth0.test/',
                organization: 'legacy',
                schemaVersion: 1,
              },
            ],
            schemaVersion: 1,
          }),
        );
        yield* configureGraphOAuthUser(runtimeConfigForTest({agentContextHome: home}), graph);
        const migrated = JSON.parse(yield* fs.readFileString(path.join(root, 'oauth-user.json')));
        expect(migrated.schemaVersion).toBe(2);
        expect(migrated.bindings).toHaveLength(2);
        expect(migrated.bindings[0]).toMatchObject({
          audienceParameter: 'https://legacy-graph.example.test',
          clientIdClaim: 'azp-or-client_id',
          credentialAccountVersion: 'legacy-auth0-v1',
          deviceAuthorizationUrl: 'https://legacy.auth0.test/oauth/device/code',
          jwksUrl: 'https://legacy.auth0.test/.well-known/jwks.json',
          tokenUrl: 'https://legacy.auth0.test/oauth/token',
        });
        const removed: string[] = [];
        const backend: OAuthUserBackend = {
          read: () => Effect.succeed('legacy-credential'),
          write: () => Effect.void,
          remove: account => Effect.sync(() => void removed.push(account)),
          post: () => Effect.die('unexpected request'),
          verify: () => Effect.die('unexpected verification'),
        };
        yield* logoutGraphOAuthUser(home, backend, {
          coordinatorUrl: 'https://legacy-graph.example.test/team',
          organization: 'legacy',
        });
        expect(removed).toEqual([
          Effect2.pipe(
            sha256Digest(
              JSON.stringify([
                home,
                'https://legacy.auth0.test/',
                'https://legacy-graph.example.test',
                'legacyNativeClient1234',
                'https://legacy-graph.example.test/team',
                'legacy',
              ]),
            ),
            EffectString.slice(7),
          ),
        ]);
      }),
    ).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('keeps flag-free graph and registry configure on the legacy Auth0 profile', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'oauth-legacy-command-'});
        const docker = yield* fs.makeTempDirectoryScoped({prefix: 'oauth-legacy-docker-'});
        const runtime = runtimeConfigForTest({agentContextHome: home});
        const legacyIssuer = 'https://legacy.auth0.test/';
        yield* runGraphOAuthConfigureCommand(runtime, {
          audience: 'https://legacy-graph.example.test',
          clientId: 'legacyNativeClient1234',
          coordinatorUrl: 'https://legacy-graph.example.test/team',
          issuer: legacyIssuer,
          json: false,
          organization: 'legacy',
        });
        yield* runRegistryOAuthConfigureCommand(runtime, {
          audience: 'https://legacy-registry.example.test',
          clientId: 'legacyNativeClient1234',
          issuer: legacyIssuer,
          json: false,
          organization: 'legacy',
          origin: 'https://legacy-registry.example.test',
          subject: 'auth0|registry-reader',
        }).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            environment: () => ({...system.environment(), DOCKER_CONFIG: docker}),
          }),
        );
        const root = path.join(home, 'graph-sharing');
        expect(yield* fs.exists(path.join(root, 'oauth-user.json'))).toBe(false);
        expect(yield* fs.exists(path.join(root, 'oauth-user-registry.json'))).toBe(false);
        expect(JSON.parse(yield* fs.readFileString(path.join(root, 'auth0-user.json'))).schemaVersion).toBe(1);
        expect(JSON.parse(yield* fs.readFileString(path.join(root, 'auth0-user-registry.json'))).schemaVersion).toBe(1);
        expect(
          JSON.parse(yield* fs.readFileString(path.join(root, 'control-credentials.json'))).bindings[0].helper,
        ).toBe('auth0');
        expect(JSON.parse(yield* fs.readFileString(path.join(docker, 'config.json'))).credHelpers).toEqual({
          'legacy-registry.example.test': 'threadnote-auth0-user',
        });
      }),
    ).pipe(Effect.provideService(CliOutput, noOpCliOutput), provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect('keeps the legacy Keychain account identity while reading an Auth0 v1 binding', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-oauth-legacy-account-'});
        const root = path.join(home, 'graph-sharing');
        const legacy = {
          audience: 'https://legacy-graph.example.test',
          clientId: 'legacyNativeClient1234',
          coordinatorUrl: 'https://legacy-graph.example.test/team',
          issuer: 'https://legacy.auth0.test/',
          organization: 'legacy',
        };
        yield* fs.makeDirectory(root);
        yield* fs.writeFileString(
          path.join(root, 'auth0-user.json'),
          JSON.stringify({bindings: [{...legacy, schemaVersion: 1}], schemaVersion: 1}),
        );
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        let selectedAccount = '';
        const backend: OAuthUserBackend = {
          read: account =>
            Effect.sync(() => {
              selectedAccount = account;
              return JSON.stringify({
                accessToken: 'legacy.token',
                audience: legacy.audience,
                clientId: legacy.clientId,
                expiresAt: now + 300,
                issuer: legacy.issuer,
                refreshToken: 'legacy-refresh',
                schemaVersion: 1,
                scopes: ['graph:read', 'graph:contribute'],
                subject: 'auth0|legacy',
              });
            }),
          write: () => Effect.void,
          remove: () => Effect.void,
          post: () => Effect.die('unexpected refresh'),
          verify: () => Effect.die('unexpected verification'),
        };
        const result = yield* getGraphOAuthUserCredential(
          home,
          {
            ...request,
            audience: legacy.audience,
            coordinatorUrl: legacy.coordinatorUrl,
            issuer: legacy.issuer,
            organization: legacy.organization,
          },
          backend,
        );
        expect(result.accessToken).toBe('legacy.token');
        expect(selectedAccount).toBe(
          Effect2.pipe(
            sha256Digest(
              JSON.stringify([
                home,
                legacy.issuer,
                legacy.audience,
                legacy.clientId,
                legacy.coordinatorUrl,
                legacy.organization,
              ]),
            ),
            EffectString.slice(7),
          ),
        );
      }),
    ).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rejects cross-origin provider endpoints before writing public configuration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-oauth-cross-origin-'});
        const result = yield* Effect.result(
          configureGraphOAuthUser(runtimeConfigForTest({agentContextHome: home}), {
            ...graph,
            tokenUrl: 'https://another.example.test/v1/token',
          }),
        );
        expect(result._tag).toBe('Failure');
        expect(yield* fs.exists(path.join(home, 'graph-sharing', 'oauth-user.json'))).toBe(false);
      }),
    ).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('configures the generic registry helper for an Okta reader identity', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'registry-oauth-user-'});
        const docker = yield* fs.makeTempDirectoryScoped({prefix: 'registry-oauth-docker-'});
        yield* configureRegistryOAuthUser(runtimeConfigForTest({agentContextHome: home}), {
          ...graph,
          audience: 'https://registry.example.test',
          origin: 'https://registry.example.test',
          subject: '00u-registry-reader',
        }).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            environment: () => ({...system.environment(), DOCKER_CONFIG: docker}),
          }),
        );
        const dockerConfig = JSON.parse(yield* fs.readFileString(path.join(docker, 'config.json')));
        expect(dockerConfig.credHelpers).toEqual({'registry.example.test': 'threadnote-oauth-user'});
        const publicConfig = JSON.parse(
          yield* fs.readFileString(path.join(home, 'graph-sharing', 'oauth-user-registry.json')),
        );
        expect(publicConfig.bindings[0]).toMatchObject({clientIdClaim: 'cid', issuer, schemaVersion: 2});
      }),
    ).pipe(provideTestLayer(layer), TestClock.withLive),
  );
});

describe('provider-neutral OAuth access-token claims', () => {
  effectIt('accepts equal scope and scp sets regardless of order while enforcing the Okta cid', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    const now = Math.floor(Date.now() / 1000);
    const verify = createAccessTokenVerifier(publicKey, {
      audience: graph.audience,
      clientId: graph.clientId,
      clientIdClaim: 'cid',
      issuer,
    });
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom('graph:read', 'graph:contribute', 'memory:read'), {
          minLength: 1,
          maxLength: 3,
        }),
        async scopes => {
          const token = await new SignJWT({
            aud: graph.audience,
            cid: graph.clientId,
            exp: now + 300,
            iat: now,
            iss: issuer,
            scope: EffectArray.join(scopes, ' '),
            scp: [...scopes].reverse(),
            sub: '00u-pilot-user',
          })
            .setProtectedHeader({alg: 'RS256'})
            .sign(privateKey);
          expect((await verify(token)).scopes).toEqual(new Set(scopes));
        },
      ),
      {numRuns: 12},
    );
  });

  effectIt('rejects a wrong cid and conflicting scope representations', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    const now = Math.floor(Date.now() / 1000);
    const verify = createAccessTokenVerifier(publicKey, {
      audience: graph.audience,
      clientId: graph.clientId,
      clientIdClaim: 'cid',
      issuer,
    });
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT({
        aud: graph.audience,
        cid: graph.clientId,
        exp: now + 300,
        iat: now,
        iss: issuer,
        scp: ['graph:read'],
        sub: '00u-pilot-user',
        ...claims,
      })
        .setProtectedHeader({alg: 'RS256'})
        .sign(privateKey);
    await expect(verify(await sign({cid: 'another-client'}))).rejects.toBeDefined();
    await expect(verify(await sign({scope: 'graph:contribute'}))).rejects.toBeDefined();
    await expect(verify(await sign({aud: [graph.audience, 'https://expanded.example.test']}))).rejects.toBeDefined();
  });
});
