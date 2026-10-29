import {Effect, Schema, Stdio, Stream} from 'effect';
import {CommandExecutor, type CommandExecutionError} from '@threadnote/platform/command';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {CODE_GRAPH_DEEP_DIAGNOSTICS_WORKER_ARGUMENT} from '@threadnote/graph/worker_protocol';
import {type CodeGraphDatabaseHealth} from './store/models.js';
import {diagnoseCodeGraphDatabaseReadOnly} from './store/health.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

class CodeGraphDeepDiagnosticsError extends Schema.TaggedError<
  CodeGraphDeepDiagnosticsError,
  {readonly brand: unique symbol}
>()('CodeGraphDeepDiagnosticsError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const CODE_GRAPH_DEEP_DIAGNOSTICS_PROTOCOL = 1;
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const CodeGraphDatabaseHealthSchema = Schema.Struct({
  activeSnapshots: NonNegativeInteger,
  buildingSnapshots: NonNegativeInteger,
  cachedFileBlobs: NonNegativeInteger,
  failedSnapshots: NonNegativeInteger,
  foreignKeyViolations: NonNegativeInteger,
  integrity: Schema.Union([
    Schema.Literal('corrupt'),
    Schema.Literal('incompatible'),
    Schema.Literal('migration-pending'),
    Schema.Literal('ok'),
  ]),
  persistentExtensionSchemaRevision: Schema.optionalKey(Schema.Int),
  readySnapshots: NonNegativeInteger,
  schemaVersion: Schema.optionalKey(Schema.Int),
  snapshotFileCitationBaseIndexes: Schema.Union([
    Schema.Literal('current'),
    Schema.Literal('incompatible'),
    Schema.Literal('missing'),
  ]),
  snapshotFileCitationSchema: Schema.Union([
    Schema.Literal('column-only'),
    Schema.Literal('column-only-with-authority'),
    Schema.Literal('column-only-with-predecessor-authority'),
    Schema.Literal('current'),
    Schema.Literal('incompatible'),
    Schema.Literal('released-absent'),
    Schema.Literal('released-absent-with-predecessor-authority'),
    Schema.Literal('released-absent-with-authority'),
    Schema.Literal('table-absent'),
  ]),
});
const isCodeGraphDatabaseHealth = Schema.is(CodeGraphDatabaseHealthSchema);
const CODE_GRAPH_DEEP_DIAGNOSTICS_INPUT_BYTES_MAXIMUM = 64 * 1_024;
const CODE_GRAPH_DEEP_DIAGNOSTICS_OUTPUT_BYTES_MAXIMUM = 4 * 1_024;

interface CodeGraphDeepDiagnosticsRequest {
  readonly databasePath: string;
  readonly protocol: 1;
}

type CodeGraphDeepDiagnosticsResponse =
  | {readonly health: CodeGraphDatabaseHealth; readonly ok: true; readonly protocol: 1}
  | {readonly ok: false; readonly protocol: 1};

/**
 * Run SQLite's synchronous full integrity scan outside the lock-owning process.
 * Interrupting the caller closes the Effect child scope, which terminates this
 * worker before the parent releases its maintenance and writer locks.
 */
export const diagnoseCodeGraphDatabaseDeepIsolated: (
  threadnoteHome: string,
  databasePath: string,
) => Effect.Effect<CodeGraphDatabaseHealth, Error | CommandExecutionError, CommandExecutor | SystemInfo> = Effect.fn(
  'codeGraph.diagnoseDatabaseDeepIsolated',
)(function* (threadnoteHome: string, databasePath: string) {
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const invocation = deepDiagnosticsWorkerInvocation(system);
  const request = {
    databasePath,
    protocol: CODE_GRAPH_DEEP_DIAGNOSTICS_PROTOCOL,
  } satisfies CodeGraphDeepDiagnosticsRequest;
  const result = yield* command.execute(invocation.executable, invocation.arguments, {
    env: deepDiagnosticsWorkerEnvironment(system.environment(), threadnoteHome),
    input: new TextEncoder().encode(`${JSON.stringify(request)}\n`),
    maxOutputBytes: CODE_GRAPH_DEEP_DIAGNOSTICS_OUTPUT_BYTES_MAXIMUM,
    timeoutMs: 0,
  });
  const response = decodeDeepDiagnosticsResponse(result.stdout);
  if (response === undefined || !response.ok) {
    return yield* CodeGraphDeepDiagnosticsError.make({message: 'Isolated code graph deep diagnostics failed.'});
  }
  return response.health;
});

export function diagnoseCodeGraphDatabase(
  threadnoteHome: string,
  databasePath: string,
  deep: boolean,
): Effect.Effect<CodeGraphDatabaseHealth, unknown, CommandExecutor | SystemInfo> {
  if (deep) return diagnoseCodeGraphDatabaseDeepIsolated(threadnoteHome, databasePath);
  return diagnoseCodeGraphDatabaseReadOnly(databasePath, false).pipe(
    Effect.map(health => health as CodeGraphDatabaseHealth),
  );
}

/** @internal Preserve only host variables required to bootstrap the same-privilege worker. */
export function deepDiagnosticsWorkerEnvironment(source: NodeJS.ProcessEnv, threadnoteHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    THREADNOTE_CODE_GRAPH_DEEP_DIAGNOSTICS_WORKER: '1',
    THREADNOTE_HOME: threadnoteHome,
  };
  for (const key of [
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'PATH',
    'PATHEXT',
    'ComSpec',
    'COMSPEC',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
  ] as const) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/** Internal standalone mode. It deliberately runs without BunRuntime signal handlers. */
export const codeGraphDeepDiagnosticsWorkerProgram: Effect.Effect<void, never, Stdio.Stdio> = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const content = yield* readBoundedWorkerInput(stdio);
  const request = decodeDeepDiagnosticsRequest(content);
  const response =
    request === undefined
      ? ({ok: false, protocol: CODE_GRAPH_DEEP_DIAGNOSTICS_PROTOCOL} as const)
      : yield* diagnoseCodeGraphDatabaseReadOnly(request.databasePath, true).pipe(
          Effect.match({
            onFailure: () => ({ok: false, protocol: CODE_GRAPH_DEEP_DIAGNOSTICS_PROTOCOL}) as const,
            onSuccess: health =>
              ({
                health,
                ok: true,
                protocol: CODE_GRAPH_DEEP_DIAGNOSTICS_PROTOCOL,
              }) as const satisfies CodeGraphDeepDiagnosticsResponse,
          }),
        );
  yield* Stream.run(
    Stream.make(new TextEncoder().encode(`${JSON.stringify(response)}\n`)),
    stdio.stdout({endOnDone: false}),
  );
}).pipe(Effect.ignore);

function readBoundedWorkerInput(stdio: Stdio.Stdio): Effect.Effect<string, Error> {
  const encoder = new TextEncoder();
  return stdio.stdin.pipe(
    Stream.decodeText,
    Stream.runFoldEffect(
      () => ({chunks: [] as string[], size: 0}),
      (state, chunk) => {
        const size = state.size + encoder.encode(chunk).byteLength;
        if (size > CODE_GRAPH_DEEP_DIAGNOSTICS_INPUT_BYTES_MAXIMUM) {
          return Effect.fail(
            CodeGraphDeepDiagnosticsError.make({
              message: 'Code graph deep diagnostics request exceeded its input limit.',
            }),
          );
        }
        state.chunks.push(chunk);
        return Effect.succeed({chunks: state.chunks, size});
      },
    ),
    Effect.map(state => EffectArray.join(state.chunks, '')),
  );
}

function decodeDeepDiagnosticsRequest(content: string): CodeGraphDeepDiagnosticsRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(Effect2.pipe(content, EffectString.trim));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('protocol' in parsed) ||
      parsed.protocol !== CODE_GRAPH_DEEP_DIAGNOSTICS_PROTOCOL ||
      !('databasePath' in parsed) ||
      typeof parsed.databasePath !== 'string' ||
      parsed.databasePath.length === 0 ||
      Effect2.pipe(parsed.databasePath, EffectString.includes('\0'))
    ) {
      return undefined;
    }
    return {databasePath: parsed.databasePath, protocol: CODE_GRAPH_DEEP_DIAGNOSTICS_PROTOCOL};
  } catch {
    return undefined;
  }
}

function decodeDeepDiagnosticsResponse(content: string): CodeGraphDeepDiagnosticsResponse | undefined {
  try {
    const parsed: unknown = JSON.parse(Effect2.pipe(content, EffectString.trim));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('protocol' in parsed) ||
      parsed.protocol !== CODE_GRAPH_DEEP_DIAGNOSTICS_PROTOCOL ||
      !('ok' in parsed) ||
      typeof parsed.ok !== 'boolean'
    ) {
      return undefined;
    }
    if (!parsed.ok) return {ok: false, protocol: CODE_GRAPH_DEEP_DIAGNOSTICS_PROTOCOL};
    if (!('health' in parsed)) return undefined;
    const health = decodeDatabaseHealth(parsed.health);
    return health === undefined ? undefined : {health, ok: true, protocol: CODE_GRAPH_DEEP_DIAGNOSTICS_PROTOCOL};
  } catch {
    return undefined;
  }
}

function decodeDatabaseHealth(value: unknown): CodeGraphDatabaseHealth | undefined {
  return isCodeGraphDatabaseHealth(value) ? value : undefined;
}

function deepDiagnosticsWorkerInvocation(system: SystemInfoShape): {
  readonly arguments: readonly string[];
  readonly executable: string;
} {
  const executableName = Effect2.pipe(
    Effect2.pipe(system.executablePath, EffectString.replaceAll('\\', '/'), EffectString.split('/')).at(-1),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
  );
  if (executableName !== 'bun' && executableName !== 'bun.exe') {
    return {arguments: [CODE_GRAPH_DEEP_DIAGNOSTICS_WORKER_ARGUMENT], executable: system.executablePath};
  }
  const currentScript = system.processArguments[1];
  const standaloneScript =
    currentScript && /(?:^|[/\\])(?:standalone\.(?:js|ts)|threadnote\.cjs)$/iu.test(currentScript)
      ? currentScript
      : system.developmentEntrypoint;
  return {
    arguments: [standaloneScript, CODE_GRAPH_DEEP_DIAGNOSTICS_WORKER_ARGUMENT],
    executable: system.executablePath,
  };
}
