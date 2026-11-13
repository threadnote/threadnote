import {Array as EffectArray, Effect, FileSystem, Path, Schema} from 'effect';
import {runtimeReadBoundedRegularFileAttempt} from '@threadnote/platform/system';
import {BackgroundWorkerFixtureDrainUnavailable} from '@threadnote/inference/background/worker-control';

export const SMOKE_EVIDENCE_FILENAME = 'failure.json';
export const SMOKE_EVIDENCE_MAX_BYTES = 16_384;
const MAX_INPUT_BYTES = 65_536;
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
    });
    if (new TextEncoder().encode(encoded).length > SMOKE_EVIDENCE_MAX_BYTES) return;
    yield* fs.makeDirectory(options.outputDirectory, {recursive: true});
    yield* fs.writeFileString(path.join(options.outputDirectory, SMOKE_EVIDENCE_FILENAME), encoded);
  },
  effect => effect.pipe(Effect.interruptible, Effect.timeoutOption(500), Effect.ignoreCause),
);
