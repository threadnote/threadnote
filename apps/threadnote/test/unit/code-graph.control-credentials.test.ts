import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path, Redacted} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {CommandExecutor} from '@threadnote/platform/command';

import {makeGraphControlCredentialLoader} from '@threadnote/graph/sharing/control/credentials';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const layer = Layer.merge(BunServices.layer, TestSystemInfoLayer);

const scope = {
  coordinatorUrl: 'https://graph.example.test/team.v1',
  organization: 'acme',
  profileDigest: sha256Digest('profile'),
  repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
};
const binding = {
  audience: 'https://graph.example.test',
  coordinatorUrl: scope.coordinatorUrl,
  helper: 'fixture',
  issuer: 'https://login.example.test/',
  organization: scope.organization,
};

const fixture = Effect.fn('test.controlCredentials.fixture')(function* (
  options: {
    readonly configured?: boolean;
    readonly denied?: boolean;
    readonly helper?: string;
    readonly response?: (now: number, calls: number) => unknown;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-control-credentials-'});
  const directory = path.join(home, 'graph-sharing');
  const config = path.join(directory, 'control-credentials.json');
  yield* fs.makeDirectory(directory);
  if (options.configured !== false)
    yield* fs.writeFileString(
      config,
      JSON.stringify({bindings: [{...binding, helper: options.helper ?? binding.helper}], schemaVersion: 1}),
    );
  let calls = 0;
  const loader = yield* makeGraphControlCredentialLoader(home, scope, 'graph:contribute').pipe(
    Effect.provideService(CommandExecutor, {
      execute: (executable, args, options_) =>
        Effect.gen(function* () {
          calls++;
          expect(executable).toBe(`threadnote-credential-${options.helper ?? 'fixture'}`);
          expect(args).toEqual(['get']);
          expect(options_?.timeoutMs).toBe(
            options.helper === 'auth0-m2m' || options.helper === 'oauth-m2m' ? 10000 : 5000,
          );
          expect(options_?.maxOutputBytes).toBe(32768);
          expect(JSON.parse(new TextDecoder().decode(options_?.input))).toEqual({
            ...scope,
            audience: binding.audience,
            issuer: binding.issuer,
            interactive: false,
            schemaVersion: 1,
            scopes: ['graph:contribute'],
          });
          const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
          return {
            exitCode: options.denied ? 1 : 0,
            stderr: 'synthetic-private-helper-detail',
            stdout: JSON.stringify(
              options.response?.(now, calls) ?? {
                accessToken: 'synthetic.token.' + calls,
                audience: binding.audience,
                expiresAt: now + 600,
                issuer: binding.issuer,
                schemaVersion: 1,
                subject: 'synthetic-principal',
              },
            ),
          };
        }),
      executeStreaming: () => Effect.succeed({exitCode: 1, stdout: '', stderr: ''}),
    }),
  );
  return {loader, calls: () => calls, config};
});

describe('graph control credential discovery', () => {
  effectIt.effect('allows the packaged OAuth helpers a bounded token and cold-JWKS acquisition window', () =>
    Effect.gen(function* () {
      for (const helper of ['auth0-m2m', 'oauth-m2m']) {
        const f = yield* fixture({helper});
        expect((yield* f.loader.load).expiresAt).toBeGreaterThan((yield* Clock.currentTimeMillis) / 1000);
        expect(f.calls()).toBe(1);
      }
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('spawns legacy and generic user OAuth helpers with refresh headroom', () =>
    Effect.gen(function* () {
      for (const helper of ['auth0', 'oauth'] as const) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: `graph-${helper}-helper-binding-`});
        const directory = path.join(home, 'graph-sharing');
        yield* fs.makeDirectory(directory);
        yield* fs.writeFileString(
          path.join(directory, 'control-credentials.json'),
          JSON.stringify({bindings: [{...binding, helper}], schemaVersion: 1}),
        );
        const loader = yield* makeGraphControlCredentialLoader(home, scope, 'graph:contribute').pipe(
          Effect.provideService(CommandExecutor, {
            execute: (executable, args, options) =>
              Effect.gen(function* () {
                expect(executable).toBe(process.execPath);
                expect(args).toEqual([
                  new URL('../../src/standalone.ts', import.meta.url).pathname,
                  `__graph-${helper}-helper`,
                  'get',
                ]);
                expect(options?.timeoutMs).toBe(25_000);
                expect(options?.env?.THREADNOTE_HOME).toBe(home);
                return {
                  exitCode: 0,
                  stderr: '',
                  stdout: JSON.stringify({
                    accessToken: 'synthetic.token',
                    audience: binding.audience,
                    expiresAt: Math.floor((yield* Clock.currentTimeMillis) / 1000) + 300,
                    issuer: binding.issuer,
                    schemaVersion: 1,
                    subject: 'oauth|synthetic',
                  }),
                };
              }),
            executeStreaming: () => Effect.succeed({exitCode: 1, stdout: '', stderr: ''}),
          }),
        );
        expect((yield* loader.load).expiresAt).toBeGreaterThan(0);
      }
    }).pipe(provideTestLayer(layer)),
  );

  fcEffectProp(
    effectIt,
    'never returns expired credentials after arbitrary idle gaps',
    {gaps: FC.array(FC.integer({min: 0, max: 720_000}), {minLength: 1, maxLength: 8})},
    ({gaps}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let previous = yield* f.loader.load;
        for (const gap of gaps) {
          yield* TestClock.adjust(gap);
          const now = (yield* Clock.currentTimeMillis) / 1000;
          const next = yield* f.loader.load;
          expect(next.expiresAt).toBeGreaterThan(now);
          expect(next.identity).toBe(previous.identity);
          if (previous.expiresAt <= now) expect(next).not.toBe(previous);
          previous = next;
        }
      }).pipe(provideTestLayer(layer)),
    {fastCheck: {numRuns: 35}},
  );

  effectIt.effect('caches a scoped credential across parallel calls and coordinates invalidation', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const wave = () => Effect.forEach(Array.from({length: 8}), () => f.loader.load, {concurrency: 8});
      const first = yield* wave();
      expect(f.calls()).toBe(1);
      expect(new Set(EffectArray.map(first, item => item.identity)).size).toBe(1);
      expect(Redacted.value(first[0].authorization)).toBe('Bearer synthetic.token.1');
      expect(JSON.stringify(first)).not.toContain('synthetic.token');
      f.loader.invalidate(first[0]);
      const second = yield* wave();
      expect(f.calls()).toBe(2);
      f.loader.invalidate(first[1]);
      expect(yield* f.loader.load).toBe(second[0]);
      yield* TestClock.adjust(300_001);
      yield* wave();
      expect(f.calls()).toBe(3);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('does not invoke a helper without an exact approved local binding', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* fixture({configured: false});
      expect((yield* Effect.result(f.loader.load))._tag).toBe('Failure');
      for (const changed of [
        {...binding, coordinatorUrl: 'https://graph.example.test/other'},
        {...binding, organization: 'another'},
        {...binding, helper: '../untrusted'},
        {...binding, coordinatorUrl: 'https://graph.example.test/team/../team'},
        {...binding, issuer: 'http://login.example.test/'},
        {...binding, secret: 'must-not-store-tokens'},
      ]) {
        yield* fs.writeFileString(f.config, JSON.stringify({bindings: [changed], schemaVersion: 1}));
        expect((yield* Effect.result(f.loader.load))._tag).toBe('Failure');
      }
      expect(f.calls()).toBe(0);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rechecks local revocation before serving a cached token', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* fixture();
      yield* f.loader.load;
      yield* fs.writeFileString(f.config, JSON.stringify({bindings: [], schemaVersion: 1}));
      expect((yield* Effect.result(f.loader.load))._tag).toBe('Failure');
      expect(f.calls()).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('binds identity changes to a different enrollment authority', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        response: (now, calls) => ({
          accessToken: 'synthetic-token',
          audience: binding.audience,
          expiresAt: now + 600,
          issuer: binding.issuer,
          schemaVersion: 1,
          subject: 'principal-' + calls,
        }),
      });
      const first = yield* f.loader.load;
      f.loader.invalidate(first);
      const second = yield* f.loader.load;
      expect(first.principalId).not.toBe(second.principalId);
      expect(first.identity).not.toBe(second.identity);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rejects malformed, expired and foreign helper output without exposing its contents', () =>
    Effect.gen(function* () {
      for (const override of [
        {expiresAt: 0},
        {audience: 'https://other.example.test'},
        {issuer: 'https://other.example.test/'},
        {accessToken: 'synthetic-private-helper-detail\r\nheader: bad'},
        {unknown: true},
      ]) {
        const f = yield* fixture({
          response: now => ({
            accessToken: 'synthetic-private-helper-detail',
            audience: binding.audience,
            expiresAt: now + 600,
            issuer: binding.issuer,
            schemaVersion: 1,
            subject: 'principal',
            ...override,
          }),
        });
        const result = yield* Effect.result(f.loader.load);
        expect(result._tag).toBe('Failure');
        expect(JSON.stringify(result)).not.toContain('synthetic-private-helper-detail');
      }
      const denied = yield* fixture({denied: true});
      const failure = yield* Effect.result(denied.loader.load);
      expect(failure._tag).toBe('Failure');
      expect(JSON.stringify(failure)).not.toContain('synthetic-private-helper-detail');
    }).pipe(provideTestLayer(layer)),
  );
});
