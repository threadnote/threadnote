import {cryptoLayer} from '@threadnote/platform/crypto';
import {SecureRandom} from 'effect/crypto';
import {runtimeEntrypointLayer} from './runtime-entrypoint.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {resolveTelemetryConfiguration} from '../telemetry/config.js';
import {
  resolveAgentSession,
  retainCurrentAgentSessionEnvironment,
  takeTelemetrySessionEnvironment,
  telemetryChildEnvironmentPolicyLayer,
} from '../telemetry/session.js';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {anonymousTelemetryLayer} from './telemetry.js';

export const systemLayer = SystemInfo.layer.pipe(
  Layer.provide(telemetryChildEnvironmentPolicyLayer),
  Layer.provide(runtimeEntrypointLayer),
);

export const commandLayer = CommandExecutor.layer.pipe(
  Layer.provide(telemetryChildEnvironmentPolicyLayer),
  Layer.provide(systemLayer),
);

export const StandaloneBrokerLayer = Layer.mergeAll(
  systemLayer,
  Layer.merge(BunServices.layer, cryptoLayer),
  commandLayer.pipe(Layer.provide(Layer.merge(BunServices.layer, cryptoLayer))),
);

export function standaloneBrokerLayerForHome(home: string) {
  return telemetryLayerForHome(home, 'broker', true).pipe(Layer.provideMerge(StandaloneBrokerLayer));
}

export function telemetryLayerForHome(
  home: string,
  fallbackScope: 'broker' | 'invocation',
  bridgeToBrokerProgram = false,
) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const environment = system.environment();
      const sessionEnvironment = takeTelemetrySessionEnvironment(environment);
      if (fallbackScope === 'broker' && !bridgeToBrokerProgram) {
        environment.THREADNOTE_MCP_BROKER_CHILD = '1';
      }
      const crypto = yield* SecureRandom.SecureRandom;
      const configuration = yield* boundedTelemetryConfiguration(home);
      if (configuration === undefined) return anonymousTelemetryLayer();
      const randomBytes = yield* crypto.randomBytes(16).pipe(
        Effect.map(bytes => bytes as Uint8Array | undefined),
        Effect.catchCause(() => succeedUndefined),
      );
      if (randomBytes === undefined) return anonymousTelemetryLayer();
      const session = resolveAgentSession({
        configuration,
        environment: sessionEnvironment,
        fallbackScope,
        randomBytes,
      });
      // Provider inputs and inherited child markers were consumed above even
      // when consent is absent. Retain only an opaque current-process alias;
      // generic subprocess launchers scrub it, while declared Threadnote child
      // plans attach a fresh child-kind marker explicitly.
      retainCurrentAgentSessionEnvironment(
        environment,
        session,
        bridgeToBrokerProgram && configuration !== undefined ? 'mcp-broker-runtime' : undefined,
      );
      const serviceVersion = yield* getThreadnoteVersion().pipe(Effect.orElseSucceed(() => 'unknown'));
      const consentIdentity = `${configuration.endpoint}\0${configuration.sessionSalt}`;
      const runtimeContext = yield* Effect.context<Layer.Success<typeof StandaloneBrokerLayer>>();
      const isEnabled = boundedTelemetryConfiguration(home).pipe(
        Effect.map(current =>
          current === undefined ? false : `${current.endpoint}\0${current.sessionSalt}` === consentIdentity,
        ),
        Effect.provideContext(runtimeContext),
      );
      return anonymousTelemetryLayer({
        correlationScope: session.correlationScope,
        endpoint: configuration.endpoint,
        isEnabled,
        serviceVersion,
        sessionId: session.id,
        // A fresh public TLS connection routinely needs more than 250ms. Keep
        // the opt-in CLI budget below the MCP-oriented three-second window,
        // while allowing short invocations to finish one anonymous export.
        shutdownTimeout: fallbackScope === 'invocation' ? '2 seconds' : '3 seconds',
      });
    }).pipe(Effect.catchCause(() => Effect.succeed(anonymousTelemetryLayer()))),
  ).pipe(Layer.catchCause(() => anonymousTelemetryLayer()));
}

const TELEMETRY_CONFIGURATION_READ_TIMEOUT = '250 millis';

function boundedTelemetryConfiguration(home: string) {
  return resolveTelemetryConfiguration({agentContextHome: home}).pipe(
    Effect.timeoutOrElse({
      duration: TELEMETRY_CONFIGURATION_READ_TIMEOUT,
      orElse: () => succeedUndefined,
    }),
    Effect.catchCause(() => succeedUndefined),
  );
}

/** @internal Runtime-boundary regression coverage. */
export const telemetryLayerForHomeForTest = telemetryLayerForHome;
