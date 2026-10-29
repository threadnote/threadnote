import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {
  configureGraphOAuthUser,
  configureRegistryOAuthUser,
  getRegistryOAuthUserCredential,
  loginGraphOAuthUser,
  loginRegistryOAuthUser,
  logoutRegistryOAuthUser,
  type OAuthUserBackend,
} from '@threadnote/graph/sharing/oauth/user';
import {runOAuthUserRegistryCredentialHelper} from '@threadnote/graph/sharing/oauth/user_registry_credential';
import {withOAuthRegistryReaderHelper} from '@threadnote/graph/sharing/oauth/user_registry_docker';

import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {runtimeConfigForTest} from '@threadnote/workspace/test/helpers/runtime-config';
import {Option as EffectOption} from 'effect';

const systemLayer = TestSystemInfoLayer;
const layer = Layer.merge(systemLayer, TestCommandExecutorLayer.pipe(Layer.provide(systemLayer))).pipe(
  Layer.provideMerge(BunServices.layer),
);
const registry = {
  audience: 'https://registry.example.test',
  clientId: 'publicNativeClient123456',
  issuer: 'https://example.eu.auth0.com/',
  organization: 'acme',
  origin: 'https://registry.example.test',
  subject: 'auth0|reader',
};
type Auth0UserBackend = OAuthUserBackend;
const legacyProvider = (issuer: string, audience: string) => ({
  audienceParameter: audience,
  clientIdClaim: 'azp-or-client_id' as const,
  deviceAuthorizationUrl: new URL('oauth/device/code', issuer).href,
  jwksUrl: new URL('.well-known/jwks.json', issuer).href,
  tokenUrl: new URL('oauth/token', issuer).href,
});
const configureGraphAuth0User = (
  runtime: RuntimeConfig,
  input: {
    readonly audience: string;
    readonly clientId: string;
    readonly coordinatorUrl: string;
    readonly issuer: string;
    readonly organization: string;
  },
) =>
  configureGraphOAuthUser(
    runtime,
    {...input, ...legacyProvider(input.issuer, input.audience)},
    {profile: 'legacy-auth0'},
  );
const configureRegistryAuth0User = (runtime: RuntimeConfig, input: typeof registry) =>
  configureRegistryOAuthUser(
    runtime,
    {...input, ...legacyProvider(input.issuer, input.audience)},
    {profile: 'legacy-auth0'},
  );
const getRegistryAuth0UserCredential = getRegistryOAuthUserCredential;
const loginGraphAuth0User = loginGraphOAuthUser;
const loginRegistryAuth0User = loginRegistryOAuthUser;
const logoutRegistryAuth0User = logoutRegistryOAuthUser;
const runAuth0UserRegistryCredentialHelper = runOAuthUserRegistryCredentialHelper;
const withRegistryReaderHelper = (config: unknown, host: string) =>
  withOAuthRegistryReaderHelper(config, host, 'threadnote-auth0-user');

const fixture = Effect.fn('test.auth0Registry.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'registry-auth0-user-'});
  const docker = yield* fs.makeTempDirectoryScoped({prefix: 'registry-docker-'});
  const dockerConfigPath = path.join(docker, 'config.json');
  yield* fs.writeFileString(
    dockerConfigPath,
    JSON.stringify({auths: {other: {auth: 'keep'}}, credHelpers: {other: 'existing'}}),
  );
  const runtime = runtimeConfigForTest({agentContextHome: home});
  const configure = (input = registry) =>
    configureRegistryAuth0User(runtime, input).pipe(
      Effect.provideService(SystemInfo, {
        ...system,
        environment: () => ({...system.environment(), DOCKER_CONFIG: docker}),
      }),
    );
  const values = new Map<string, string>();
  const accounts: string[] = [];
  let reads = 0;
  let refreshes = 0;
  let subject = registry.subject;
  let scope = new Set(['registry:read']);
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  let expiresAt = now + 300;
  const backend: Auth0UserBackend = {
    read: account =>
      Effect.sync(() => {
        reads++;
        accounts.push(account);
        return values.get(account);
      }),
    write: (account, value) =>
      Effect.sync(() => {
        accounts.push(account);
        values.set(account, value);
      }),
    remove: account =>
      Effect.sync(() => {
        values.delete(account);
      }),
    post: (config, endpoint, form) =>
      Effect.sync(() => {
        expect(config.audience).toBe(registry.audience);
        expect(config.clientId).toBe(registry.clientId);
        expect(EffectRecord.keys(form)).not.toContain('client_secret');
        if (endpoint === 'device') {
          expect(form.audience).toBe(registry.audience);
          expect(form.scope).toBe('offline_access registry:read');
          return {
            status: 200,
            body: {
              device_code: 'opaque-device-code',
              user_code: 'ABCD-EFGH',
              verification_uri: 'https://example.eu.auth0.com/activate',
              expires_in: 30,
              interval: 1,
            },
          };
        }
        if (form.grant_type === 'refresh_token') refreshes++;
        return {
          status: 200,
          body: {access_token: 'synthetic.registry.token', refresh_token: 'opaque-refresh', token_type: 'Bearer'},
        };
      }),
    verify: () =>
      Effect.succeed({clientId: registry.clientId, expiresAt, issuer: registry.issuer, scopes: scope, subject}),
  };
  return {
    accounts,
    backend,
    configure,
    dockerConfigPath,
    home,
    reads: () => reads,
    refreshes: () => refreshes,
    setExpiresAt: (value: number) => {
      expiresAt = value;
    },
    setScope: (value: Set<string>) => {
      scope = value;
    },
    setSubject: (value: string) => {
      subject = value;
    },
    values,
  };
});

describe('Auth0 user Zot registry reader', () => {
  fcEffectProp(
    effectIt,
    'adds only the selected host helper and preserves unrelated Docker config entries',
    {hosts: FC.uniqueArray(FC.stringMatching(/^[a-z]{1,8}\.test$/u), {minLength: 1, maxLength: 8})},
    ({hosts}) =>
      Effect.sync(() => {
        const existing = EffectRecord.fromEntries(EffectArray.map(hosts, (host, index) => [host, `helper-${index}`]));
        const config = {auths: {unrelated: {auth: 'opaque'}}, credHelpers: existing, credsStore: 'native'};
        const result = withRegistryReaderHelper(config, 'registry.example.test');
        expect(result).toEqual({
          ...config,
          credHelpers: {...existing, 'registry.example.test': 'threadnote-auth0-user'},
        });
        expect(withRegistryReaderHelper(result, 'registry.example.test')).toEqual(result);
        expect(config.credHelpers).toEqual(existing);
      }),
    {fastCheck: {numRuns: 32}},
  );

  effectIt.effect('leaves both bindings unchanged when Docker already assigns the exact host to another helper', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const before = JSON.stringify({
        auths: {other: {auth: 'keep'}},
        credHelpers: {other: 'existing', 'registry.example.test': 'another-helper'},
      });
      yield* fs.writeFileString(f.dockerConfigPath, before);
      expect((yield* Effect.result(f.configure()))._tag).toBe('Failure');
      expect(yield* fs.readFileString(f.dockerConfigPath)).toBe(before);
      expect(yield* fs.exists(path.join(f.home, 'graph-sharing', 'auth0-user-registry.json'))).toBe(false);
      expect(
        EffectArray.filter(
          yield* fs.readDirectory(path.join(f.home, 'graph-sharing')),
          __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.pending')))(__effectArrayValue),
        ),
      ).toEqual([]);
      yield* fs.writeFileString(
        f.dockerConfigPath,
        JSON.stringify({auths: {other: {auth: 'keep'}}, credHelpers: {other: 'existing'}}),
      );
      yield* f.configure();
      const configured = yield* fs.readFileString(f.dockerConfigPath);
      yield* f.configure();
      expect(yield* fs.readFileString(f.dockerConfigPath)).toBe(configured);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect('rejects a linked Auth0 binding before changing the Docker helper', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.join(f.home, 'graph-sharing');
      yield* fs.makeDirectory(root);
      const external = path.join(f.home, 'external.json');
      yield* fs.writeFileString(external, 'keep');
      yield* fs.symlink(external, path.join(root, 'auth0-user-registry.json'));
      const dockerBefore = yield* fs.readFileString(f.dockerConfigPath);
      expect((yield* Effect.result(f.configure()))._tag).toBe('Failure');
      expect(yield* fs.readFileString(f.dockerConfigPath)).toBe(dockerBefore);
      expect(yield* fs.readFileString(external)).toBe('keep');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('configures a separate audience, logs in, serves the exact Docker host, and logs out', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* configureGraphAuth0User(runtimeConfigForTest({agentContextHome: f.home}), {
        audience: 'https://graph.example.test',
        clientId: registry.clientId,
        coordinatorUrl: 'https://graph.example.test',
        issuer: registry.issuer,
        organization: registry.organization,
      });
      yield* f.configure();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = JSON.parse(yield* fs.readFileString(f.dockerConfigPath));
      expect(docker).toEqual({
        auths: {other: {auth: 'keep'}},
        credHelpers: {other: 'existing', 'registry.example.test': 'threadnote-auth0-user'},
      });
      const publicConfig = yield* fs.readFileString(path.join(f.home, 'graph-sharing', 'auth0-user-registry.json'));
      expect(publicConfig).not.toContain('refresh_token');
      expect(publicConfig).not.toContain('client_secret');
      yield* loginRegistryAuth0User(f.home, f.backend);
      expect((yield* getRegistryAuth0UserCredential(f.home, 'registry.example.test', f.backend)).subject).toBe(
        registry.subject,
      );
      expect(f.values.size).toBe(1);
      const requests: string[] = [];
      const outputs: string[] = [];
      const system = yield* SystemInfo;
      const helper = (input: string) =>
        runAuth0UserRegistryCredentialHelper(
          ['get'],
          {
            stdin: (async function* () {
              yield input;
            })(),
            writeStderr: text => requests.push(text),
            writeStdout: text => outputs.push(text),
          },
          f.backend,
        ).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            environment: () => ({THREADNOTE_HOME: f.home}),
          }),
        );
      expect(yield* helper('registry.example.test\n')).toBe(0);
      expect(JSON.parse(outputs[0])).toEqual({
        Secret: 'synthetic.registry.token',
        ServerURL: registry.origin,
        Username: 'zot',
      });
      const readsBeforeDenials = f.reads();
      expect(yield* helper('other.example.test\n')).toBe(1);
      expect(yield* helper('https://registry.example.test\n')).toBe(1);
      expect(f.reads()).toBe(readsBeforeDenials);
      expect(outputs).toHaveLength(1);
      expect(requests).toEqual([
        'OAuth registry credential unavailable.\n',
        'OAuth registry credential unavailable.\n',
      ]);
      yield* logoutRegistryAuth0User(f.home, f.backend);
      expect(f.values.size).toBe(0);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect('keeps graph and registry Keychain accounts apart and fails closed after a denied refresh', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const graph = {
        audience: 'https://graph.example.test',
        clientId: registry.clientId,
        coordinatorUrl: 'https://graph.example.test',
        issuer: registry.issuer,
        organization: registry.organization,
      };
      yield* configureGraphAuth0User(runtimeConfigForTest({agentContextHome: f.home}), graph);
      yield* f.configure();
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const graphBackend: Auth0UserBackend = {
        ...f.backend,
        post: (config, endpoint, form) =>
          Effect.sync(() => {
            expect(config.audience).toBe(graph.audience);
            if (endpoint === 'device') {
              expect(form.scope).toBe('offline_access graph:read graph:contribute');
              return {
                status: 200,
                body: {
                  device_code: 'opaque-graph-device-code',
                  user_code: 'GRAPH-CODE',
                  verification_uri: 'https://example.eu.auth0.com/activate',
                  expires_in: 30,
                  interval: 1,
                },
              };
            }
            return {
              status: 200,
              body: {
                access_token: 'synthetic.graph.token',
                refresh_token: 'opaque-graph-refresh',
                token_type: 'Bearer',
              },
            };
          }),
        verify: () =>
          Effect.succeed({
            clientId: graph.clientId,
            expiresAt: now + 300,
            issuer: graph.issuer,
            scopes: new Set(['graph:read', 'graph:contribute']),
            subject: registry.subject,
          }),
      };
      yield* loginGraphAuth0User(f.home, graphBackend);
      yield* loginRegistryAuth0User(f.home, f.backend);
      expect(f.values.size).toBe(2);
      expect(new Set(f.values.keys()).size).toBe(2);
      const entry = EffectOption.getOrUndefined(
        EffectArray.findFirst([...f.values.entries()], ([, value]) => JSON.parse(value).audience === registry.audience),
      );
      expect(entry).toBeDefined();
      const [registryAccount, stored] = entry!;
      f.values.set(registryAccount, JSON.stringify({...JSON.parse(stored), expiresAt: now + 5}));
      expect((yield* getRegistryAuth0UserCredential(f.home, 'registry.example.test', f.backend)).accessToken).toBe(
        'synthetic.registry.token',
      );
      expect(f.refreshes()).toBe(1);
      const refreshed = f.values.get(registryAccount);
      f.values.set(registryAccount, JSON.stringify({...JSON.parse(refreshed!), expiresAt: now + 5}));
      f.setExpiresAt(now + 5);
      const system = yield* SystemInfo;
      const output: string[] = [];
      const errors: string[] = [];
      const code = yield* runAuth0UserRegistryCredentialHelper(
        ['get'],
        {
          stdin: (async function* () {
            yield 'registry.example.test\n';
          })(),
          writeStderr: text => errors.push(text),
          writeStdout: text => output.push(text),
        },
        f.backend,
      ).pipe(Effect.provideService(SystemInfo, {...system, environment: () => ({THREADNOTE_HOME: f.home})}));
      expect(code).toBe(1);
      expect(output).toEqual([]);
      expect(errors).toEqual(['OAuth registry credential unavailable.\n']);
      expect(f.refreshes()).toBe(2);
      yield* logoutRegistryAuth0User(f.home, f.backend);
      expect(f.values.size).toBe(1);
      expect(JSON.parse([...f.values.values()][0]).audience).toBe(graph.audience);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect('rejects audience reuse, mismatched subject, and elevated registry scopes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* configureGraphAuth0User(runtimeConfigForTest({agentContextHome: f.home}), {
        audience: registry.audience,
        clientId: registry.clientId,
        coordinatorUrl: 'https://graph.example.test',
        issuer: registry.issuer,
        organization: registry.organization,
      });
      expect((yield* Effect.result(f.configure()))._tag).toBe('Failure');
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.exists(path.join(f.home, 'graph-sharing', 'auth0-user-registry.json'))).toBe(false);
      const another = yield* fixture();
      yield* another.configure();
      expect(
        (yield* Effect.result(
          configureGraphAuth0User(runtimeConfigForTest({agentContextHome: another.home}), {
            audience: registry.audience,
            clientId: registry.clientId,
            coordinatorUrl: 'https://graph.example.test',
            issuer: registry.issuer,
            organization: registry.organization,
          }),
        ))._tag,
      ).toBe('Failure');
      another.setSubject('auth0|other');
      expect((yield* Effect.result(loginRegistryAuth0User(another.home, another.backend)))._tag).toBe('Failure');
      expect(another.values.size).toBe(0);
      another.setSubject(registry.subject);
      another.setScope(new Set(['registry:read', 'registry:publisher']));
      expect((yield* Effect.result(loginRegistryAuth0User(another.home, another.backend)))._tag).toBe('Failure');
      expect(another.values.size).toBe(0);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );
});
