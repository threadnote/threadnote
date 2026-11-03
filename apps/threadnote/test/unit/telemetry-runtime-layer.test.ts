import {SecureRandom} from 'effect/crypto';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {StandaloneBrokerLayer, telemetryLayerForHomeForTest} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {enabledTelemetryConfiguration, writeTelemetryConfiguration} from '@threadnote/threadnote/telemetry/config';
import {
  TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE,
  TELEMETRY_CHILD_ENVIRONMENT_VARIABLE,
  TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE,
  TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE,
  TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE,
  takePreparedAgentSessionEnvironment,
  withAgentSessionEnvironment,
} from '@threadnote/threadnote/telemetry/session';
import {provideTestLayer} from '../helpers/effect-layer.js';

const SALT = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';

describe('telemetry runtime layer', () => {
  effectIt.effect('builds the private OTLP layer from consent and consumes raw provider correlation input', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-runtime-layer-'});
      const endpoint = 'http://127.0.0.1:4318/v1/traces';
      yield* writeTelemetryConfiguration({agentContextHome: home}, enabledTelemetryConfiguration(endpoint, SALT));
      const environment: NodeJS.ProcessEnv = {
        ...baseSystem.environment(),
        [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
        [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'private-conversation-token',
      };
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => environment,
        setEnvironmentVariable: (name, value) => {
          environment[name] = value;
        },
      });
      const base = Layer.merge(Layer.succeed(SystemInfo, testSystem), BunServices.layer);

      yield* Layer.build(telemetryLayerForHomeForTest(home, 'broker', true).pipe(Layer.provide(base)));

      expect(environment[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]).toMatch(/^tns_[\da-f]{32}$/u);
      expect(environment[TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]).toMatch(/^tng_[\da-f]{32}$/u);
      expect(environment[TELEMETRY_CHILD_ENVIRONMENT_VARIABLE]).toBe('mcp-broker-runtime');
      expect(environment[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]).not.toContain('private-conversation-token');

      const prepared = takePreparedAgentSessionEnvironment(environment, 'mcp-broker-runtime');
      expect(prepared).toMatchObject({
        consentGeneration: expect.stringMatching(/^tng_[\da-f]{32}$/u),
        id: expect.stringMatching(/^tns_[\da-f]{32}$/u),
      });
      expect(withAgentSessionEnvironment(environment, prepared!, 'mcp-server')).toMatchObject({
        [TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]: prepared?.id,
        [TELEMETRY_CHILD_ENVIRONMENT_VARIABLE]: 'mcp-server',
        [TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]: prepared?.consentGeneration,
      });
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('strips provider correlation input even when telemetry is disabled', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-runtime-disabled-'});
      const environment: NodeJS.ProcessEnv = {
        ...baseSystem.environment(),
        [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
        [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'private-conversation-token',
      };
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => environment,
        setEnvironmentVariable: (name, value) => {
          environment[name] = value;
        },
      });
      const base = Layer.merge(Layer.succeed(SystemInfo, testSystem), BunServices.layer);

      yield* Layer.build(telemetryLayerForHomeForTest(home, 'broker').pipe(Layer.provide(base)));

      expect(environment[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]).toBeUndefined();
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('bounds a stalled disabled broker configuration read and prepares no child session', () =>
    Effect.gen(function* () {
      const crypto = yield* SecureRandom.SecureRandom;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-runtime-stalled-'});
      const readStarted = yield* Deferred.make<void>();
      const stalledFileSystem = FileSystem.FileSystem.of({
        ...fs,
        exists: () => Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const environment: NodeJS.ProcessEnv = {
        ...baseSystem.environment(),
        [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
        [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'private-conversation-token',
      };
      const testSystem = SystemInfo.of({...baseSystem, environment: () => environment});
      const dependencies = Layer.mergeAll(
        Layer.succeed(SecureRandom.SecureRandom, crypto),
        Layer.succeed(FileSystem.FileSystem, stalledFileSystem),
        Layer.succeed(Path.Path, path),
        Layer.succeed(SystemInfo, testSystem),
      );
      const build = yield* Layer.build(
        telemetryLayerForHomeForTest(home, 'broker', true).pipe(Layer.provide(dependencies)),
      ).pipe(Effect.forkChild({startImmediately: true}));

      yield* Deferred.await(readStarted);
      yield* TestClock.adjust('250 millis');
      expect(yield* Fiber.join(build)).toBeDefined();
      expect(takePreparedAgentSessionEnvironment(environment, 'mcp-broker-runtime')).toBeUndefined();
      expect(environment[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]).toBeUndefined();
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('fails open when enabled broker session entropy defects', () =>
    Effect.gen(function* () {
      const crypto = yield* SecureRandom.SecureRandom;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-runtime-rng-defect-'});
      yield* writeTelemetryConfiguration(
        {agentContextHome: home},
        enabledTelemetryConfiguration('http://127.0.0.1:4318/v1/traces', SALT),
      );
      const environment: NodeJS.ProcessEnv = {
        ...baseSystem.environment(),
        [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
        [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'private-conversation-token',
      };
      const testSystem = SystemInfo.of({...baseSystem, environment: () => environment});
      const defectiveCrypto = SecureRandom.SecureRandom.of({
        ...crypto,
        randomBytes: () => Effect.die(new Error('telemetry entropy defect')),
      });
      const dependencies = Layer.mergeAll(
        Layer.succeed(SecureRandom.SecureRandom, defectiveCrypto),
        Layer.succeed(FileSystem.FileSystem, fs),
        Layer.succeed(Path.Path, path),
        Layer.succeed(SystemInfo, testSystem),
      );

      const context = yield* Layer.build(
        telemetryLayerForHomeForTest(home, 'broker', true).pipe(Layer.provide(dependencies)),
      );

      expect(context).toBeDefined();
      expect(takePreparedAgentSessionEnvironment(environment, 'mcp-broker-runtime')).toBeUndefined();
      expect(environment[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]).toBeUndefined();
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('fails open to the no-op layer when telemetry setup defects', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-runtime-defect-'});
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => {
          throw new Error('telemetry environment defect');
        },
      });
      const base = Layer.merge(Layer.succeed(SystemInfo, testSystem), BunServices.layer);

      const context = yield* Layer.build(telemetryLayerForHomeForTest(home, 'invocation').pipe(Layer.provide(base)));
      expect(context).toBeDefined();
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );
});
