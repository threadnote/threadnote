import {Array as EffectArray, Cause, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {runtimeReadBoundedRegularFileAttempt, SystemInfo} from '@threadnote/platform/system';
import {BackgroundWorkerFixtureDrainUnavailable} from '@threadnote/inference/background/worker-control';
import {readBoundedProcessRegistrationNames} from '@threadnote/threadnote/process/diagnostics';
import {observeProcessInstanceIdentity} from '@threadnote/threadnote/process/process_identity';

export const SMOKE_EVIDENCE_FILENAME = 'failure.json';
export const SMOKE_EVIDENCE_MAX_BYTES = 16_384;
const MAX_INPUT_BYTES = 65_536;
const MAX_REGISTRATION_FILES = 16;
const MAX_REGISTRATION_BYTES = 16_384;
export const smokeEvidenceStageSchema = Schema.Literals([
  'setup',
  'version',
  'install-dry-run',
  'models-runtime',
  'remember',
  'recall',
  'repair',
  'doctor',
  'graph-index',
  'graph-query',
  'graph-explain',
  'graph-path',
  'graph-impact',
  'large-output',
  'mcp',
  'producer-close',
  'worker-drain',
  'remove',
  'complete',
]);
export type SmokeEvidenceStage = typeof smokeEvidenceStageSchema.Type;
export interface SmokeEvidenceProgress {
  stage: SmokeEvidenceStage;
  completed: boolean;
  elapsedMilliseconds: number;
  bodyStage?: SmokeEvidenceStage;
  bodyCompleted?: boolean;
  drainFailure?: BackgroundWorkerFixtureDrainUnavailable;
}
const ownerSchema = Schema.Struct({processId: Schema.Int.check(Schema.isGreaterThan(0))});
const controlSchema = Schema.Struct({
  protocol: Schema.Int,
  runtimeVersion: Schema.String,
  starting: Schema.optionalKey(Schema.Unknown),
  active: Schema.optionalKey(Schema.Unknown),
  fixture: Schema.optionalKey(
    Schema.Struct({
      phase: Schema.Literals(['open', 'closing']),
      launches: Schema.Array(Schema.Struct({owner: Schema.optionalKey(ownerSchema)})).check(Schema.isMaxLength(32)),
    }),
  ),
});
const receiptSchema = Schema.Struct({protocol: Schema.Int, version: Schema.String, ...ownerSchema.fields});
const lockSchema = ownerSchema;
const registrationSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  processId: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: Number.MAX_SAFE_INTEGER})),
  parentProcessId: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: Number.MAX_SAFE_INTEGER})),
  role: Schema.Literal('cli'),
  currentOperation: Schema.Literal('recall-embedding'),
  processStartIdentity: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
});
const version = (value: string) =>
  /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[a-z0-9.]{1,32})?$/u.test(value) ? value : undefined;

const readSummary = Effect.fn('smoke.readFailureSummary')(
  function* (filename: string, kind: 'control' | 'receipt' | 'lock') {
    const attempt = yield* Effect.tryPromise({
      try: signal => runtimeReadBoundedRegularFileAttempt(filename, MAX_INPUT_BYTES, {signal, replacement: 'reject'}),
      catch: () => 'unavailable' as const,
    });
    if (attempt.status !== 'read') return {status: attempt.status};
    const input: unknown = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(attempt.bytes)),
      catch: () => 'unavailable' as const,
    });
    if (kind === 'control') {
      const state = yield* Schema.decodeUnknownEffect(controlSchema)(input);
      const launches = state.fixture?.launches ?? [];
      return {
        status: 'read',
        protocol: state.protocol,
        version: version(state.runtimeVersion),
        starting: state.starting !== undefined,
        active: state.active !== undefined,
        fixturePhase: state.fixture?.phase,
        launchCount: launches.length,
        ownerlessCount: EffectArray.filter(launches, launch => launch.owner === undefined).length,
        registeredCount: EffectArray.filter(launches, launch => launch.owner !== undefined).length,
        owners: EffectArray.map(launches, launch => ({
          registered: launch.owner !== undefined,
          processId: launch.owner?.processId,
        })),
      };
    }
    if (kind === 'receipt') {
      const state = yield* Schema.decodeUnknownEffect(receiptSchema)(input);
      return {status: 'read', protocol: state.protocol, version: version(state.version), processId: state.processId};
    }
    const state = yield* Schema.decodeUnknownEffect(lockSchema)(input);
    return {status: 'read', processId: state.processId};
  },
  effect => effect.pipe(Effect.orElseSucceed(() => ({status: 'unavailable' as const}))),
);

// Runtime registrations are informational only: no nonce association, absence or exit proof is inferred.
const readFixtureRuntimeProcesses = Effect.fn('smoke.readFixtureRuntimeProcesses')(
  function* (home: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* Effect.serviceOption(SystemInfo);
    const directory = path.join(home, 'runtime', 'processes');
    for (const component of [home, path.join(home, 'runtime'), directory]) {
      const entry = yield* fs.lstat(component).pipe(Effect.result);
      if (entry._tag === 'Failure')
        return {status: entry.failure.reason._tag === 'NotFound' ? ('missing' as const) : ('unavailable' as const)};
      if (entry.success.type !== 'Directory') return {status: 'unavailable' as const};
    }
    const scan = yield* readBoundedProcessRegistrationNames(directory);
    const rows = yield* Effect.forEach(
      scan.names.slice(0, MAX_REGISTRATION_FILES),
      name =>
        Effect.gen(function* () {
          const attempt = yield* Effect.tryPromise({
            try: signal =>
              runtimeReadBoundedRegularFileAttempt(path.join(directory, name), MAX_REGISTRATION_BYTES, {
                signal,
                replacement: 'reject',
              }),
            catch: () => undefined,
          });
          if (attempt?.status !== 'read') return undefined;
          const input = yield* Effect.try(() => JSON.parse(new TextDecoder().decode(attempt.bytes)));
          const decoded = Schema.decodeUnknownOption(registrationSchema)(input);
          if (Option.isNone(decoded) || name !== `${decoded.value.processId}.json`) return undefined;
          const row = decoded.value;
          const live = yield* Effect.try(() =>
            Option.isSome(system) ? system.value.isProcessRunning(row.processId) : undefined,
          ).pipe(Effect.orElseSucceed(() => undefined));
          const identity =
            live === true && Option.isSome(system)
              ? yield* observeProcessInstanceIdentity(system.value, row.processId).pipe(
                  Effect.orElseSucceed(() => undefined),
                )
              : undefined;
          return {
            processId: row.processId,
            parentProcessId: row.parentProcessId,
            role: row.role,
            currentOperation: row.currentOperation,
            live: live ?? 'unknown',
            birthMatch:
              identity !== undefined && row.processStartIdentity !== undefined
                ? identity === row.processStartIdentity
                : 'unknown',
          };
        }).pipe(Effect.orElseSucceed(() => undefined)),
      {concurrency: 4},
    );
    return {
      status: 'read' as const,
      truncated: scan.truncated || scan.names.length > MAX_REGISTRATION_FILES,
      registrations: EffectArray.filter(rows, row => row !== undefined),
    };
  },
  effect =>
    effect.pipe(
      Effect.timeoutOption(200),
      Effect.map(result => ({
        ...(Option.isSome(result) ? result.value : {status: 'unavailable' as const}),
        informationalOnly: true,
      })),
      Effect.catchCauseIf(
        cause => !Cause.hasInterrupts(cause),
        () => Effect.succeed({status: 'unavailable' as const, informationalOnly: true}),
      ),
    ),
);

/** Failure-only, known-file projection. Never copies input objects or exception messages. */
export const writeSmokeFailureEvidence = Effect.fn('smoke.writeFailureEvidence')(
  function* (options: {
    readonly home: string;
    readonly outputDirectory: string;
    readonly progress: SmokeEvidenceProgress;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const receipt = path.join(options.home, 'locks', 'recall', 'embedding-worker-v1.json');
    const control = yield* readSummary(receipt + '.launch-v2.json', 'control');
    const workerReceipt = yield* readSummary(receipt, 'receipt');
    const lock = yield* readSummary(path.join(options.home, 'locks', 'recall', 'embedding-worker.lock'), 'lock');
    const runtimeProcesses = yield* readFixtureRuntimeProcesses(options.home);
    const progress = options.progress;
    const stage = yield* Schema.decodeEffect(smokeEvidenceStageSchema)(progress.stage);
    const drainFailure = progress.drainFailure;
    const encoded = JSON.stringify({
      version: 1,
      stage,
      body:
        progress.bodyStage === undefined
          ? undefined
          : {
              stage: yield* Schema.decodeEffect(smokeEvidenceStageSchema)(progress.bodyStage),
              completed: progress.bodyCompleted === true,
            },
      completed: progress.completed === true,
      elapsedMilliseconds: Number.isFinite(progress.elapsedMilliseconds)
        ? Math.max(0, Math.min(3_600_000, Math.floor(progress.elapsedMilliseconds)))
        : null,
      drain:
        drainFailure === undefined
          ? undefined
          : {
              reason: drainFailure.reason,
              operation: drainFailure.diagnostic?.operation,
              causeCategory: drainFailure.diagnostic?.causeCategory,
            },
      control,
      receipt: workerReceipt,
      lock,
      runtimeProcesses,
    });
    if (new TextEncoder().encode(encoded).length > SMOKE_EVIDENCE_MAX_BYTES) return;
    yield* fs.makeDirectory(options.outputDirectory, {recursive: true});
    yield* fs.writeFileString(path.join(options.outputDirectory, SMOKE_EVIDENCE_FILENAME), encoded);
  },
  effect => effect.pipe(Effect.interruptible, Effect.timeoutOption(500), Effect.ignoreCause),
);
