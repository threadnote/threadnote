import {Cause, Effect, Logger, Queue, Schema} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {activeInstalledRelease} from '../installations.js';
import {McpBrokerError, runMcpBroker, type McpBrokerChild, type McpBrokerFailureEvent} from '../mcp/broker.js';
import type {StandaloneActiveRelease} from '../process/standalone_lease.js';
import {
  takePreparedAgentSessionEnvironment,
  withAgentSessionEnvironment,
  withoutTelemetrySessionEnvironment,
  type PreparedAgentSession,
} from '../telemetry/session.js';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {emitAnonymousTelemetryEvent, withAnonymousTelemetry} from './telemetry.js';
import {triggerAutoUpdateIfEnabled} from '../release/auto_update.js';

const AUTO_UPDATE_CHECK_INTERVAL_MILLISECONDS = 15 * 60 * 1_000;

interface ActiveReleaseRequest {
  readonly reject: (cause: unknown) => void;
  readonly resolve: (release: StandaloneActiveRelease | undefined) => void;
}

/** Runtime boundary for the stable MCP broker's stdio and child process. */
const mcpBrokerProgram = Effect.gen(function* () {
  const system = yield* SystemInfo;
  const agentSession = yield* Effect.sync(() =>
    takePreparedAgentSessionEnvironment(system.environment(), 'mcp-broker-runtime'),
  ).pipe(Effect.catchCause(() => succeedUndefined));
  const brokerFailureEvents = yield* Queue.dropping<McpBrokerFailureEvent>(64);
  yield* Effect.forkScoped(
    Effect.forever(Queue.take(brokerFailureEvents).pipe(Effect.flatMap(emitMcpBrokerFailureEvent), Effect.ignoreCause)),
  );
  yield* triggerAutoUpdateIfEnabled(agentSession).pipe(Effect.ignore);
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(AUTO_UPDATE_CHECK_INTERVAL_MILLISECONDS).pipe(
        Effect.andThen(triggerAutoUpdateIfEnabled(agentSession)),
        Effect.ignore,
      ),
    ),
  );
  const activeReleaseRequests = yield* Queue.unbounded<ActiveReleaseRequest>();
  yield* Effect.forkScoped(
    Effect.forever(
      Queue.take(activeReleaseRequests).pipe(
        Effect.flatMap(request =>
          activeInstalledRelease().pipe(
            Effect.matchCauseEffect({
              onFailure: cause =>
                Effect.sync(() => request.reject(McpBrokerError.make({message: Cause.pretty(cause)}))),
              onSuccess: release => Effect.sync(() => request.resolve(release)),
            }),
          ),
        ),
      ),
    ),
  );
  yield* Effect.tryPromise({
    try: () =>
      runMcpBroker({
        input: Bun.stdin.stream() as AsyncIterable<Uint8Array>,
        onFailure: event => {
          Queue.offerUnsafe(brokerFailureEvents, event);
        },
        readActiveRelease: () => {
          const {promise, reject, resolve} = Promise.withResolvers<StandaloneActiveRelease | undefined>();
          if (!Queue.offerUnsafe(activeReleaseRequests, {reject, resolve})) {
            reject(McpBrokerError.make({message: 'Threadnote MCP broker active-release reader is unavailable.'}));
          }
          return promise;
        },
        spawn: release => spawnMcpRuntime(release, system, agentSession),
        writeOutput: writeBrokerOutput,
      }),
    catch: cause =>
      Schema.is(McpBrokerError)(cause)
        ? cause
        : McpBrokerError.make({message: cause instanceof Error ? cause.message : String(cause)}),
  });
});

export const mcpBrokerEffect = withAnonymousTelemetry(
  {component: 'mcp', operation: 'mcp-broker'},
  mcpBrokerProgram,
).pipe(
  // The broker's stdout is the client's JSON-RPC transport. Keep Effect logs
  // on stderr so future diagnostics can never interleave with protocol output
  // (the broker already drops non-JSON child lines, but its own logs bypass
  // that guard).
  Effect.provideService(Logger.LogToStderr, true),
);

/** @internal Emits one closed, privacy-safe broker recovery observation. */
export function emitMcpBrokerFailureEvent(event: McpBrokerFailureEvent): Effect.Effect<void> {
  return emitAnonymousTelemetryEvent({
    component: 'mcp',
    errorType: 'McpBrokerError',
    event: 'lifecycle',
    operation: mcpBrokerFailureOperation(event),
    outcome: 'failure',
  });
}

function mcpBrokerFailureOperation(event: McpBrokerFailureEvent): string {
  switch (`${event.area}:${event.reason}`) {
    case 'child:exit':
      return 'mcp-broker.child.exit';
    case 'child:spawn':
      return 'mcp-broker.child.spawn';
    case 'child:write':
      return 'mcp-broker.child.write';
    case 'promotion:protocol':
      return 'mcp-broker.promotion.protocol';
    case 'promotion:timeout':
      return 'mcp-broker.promotion.timeout';
    default:
      return 'mcp-broker.unknown';
  }
}

function spawnMcpRuntime(
  release: StandaloneActiveRelease,
  system: SystemInfoShape,
  agentSession: PreparedAgentSession | undefined,
): McpBrokerChild {
  const separator = release.releaseRoot.endsWith('/') || release.releaseRoot.endsWith('\\') ? '' : '/';
  const executable = `${release.releaseRoot}${separator}${system.platform === 'win32' ? 'threadnote.exe' : 'threadnote'}`;
  const child = Bun.spawn({
    cmd: [executable, 'mcp-server'],
    env: {
      ...(agentSession === undefined
        ? withoutTelemetrySessionEnvironment(system.environment())
        : withAgentSessionEnvironment(system.environment(), agentSession, 'mcp-server')),
      THREADNOTE_MCP_BROKER_CHILD: '1',
    },
    stdin: 'pipe',
    stderr: 'inherit',
    stdout: 'pipe',
  });
  return {
    exited: child.exited,
    input: child.stdin,
    kill: signal => child.kill(signal),
    output: child.stdout as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>,
    processId: child.pid,
  };
}

function writeBrokerOutput(line: string): Promise<void> {
  const {promise, reject, resolve} = Promise.withResolvers<void>();
  process.stdout.write(`${line}\n`, error => (error ? reject(error) : resolve()));
  return promise;
}
