import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer, Path, Schema} from 'effect';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {
  BackgroundWorkerFixtureDrainUnavailable,
  createBackgroundWorkerFixtureDrain,
  drainBackgroundWorkerFixture,
  type BackgroundWorkerControlOptions,
  type BackgroundWorkerFixtureDrain,
} from '@threadnote/inference/background/worker-control';
import {codeGraphEmbeddingWorkerReceiptPath, codeGraphEmbeddingWorkerLockPath} from '@threadnote/graph/layout';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {recallEmbeddingWorkerPaths} from '../../src/recall/embedding_worker_process.js';
import {
  CODE_GRAPH_EMBEDDING_WORKER_PROTOCOL_VERSION,
  RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION,
} from '../../src/worker_protocol.js';
import {TestSystemInfoLayer} from './system-layer.js';

/** Only the two domains using BackgroundWorkerLifecycle; never coordinator or unknown-handle proof. */
export const localBinsWorkerOptions = (
  path: Path.Path,
  home: string,
  version: string,
): readonly BackgroundWorkerControlOptions[] => [
  {
    home,
    ...recallEmbeddingWorkerPaths(path, home),
    version,
    protocol: RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION,
    launch: () => Effect.succeed(false),
  },
  {
    home,
    receiptPath: codeGraphEmbeddingWorkerReceiptPath(path, home),
    lockPath: codeGraphEmbeddingWorkerLockPath(path, home),
    version,
    protocol: CODE_GRAPH_EMBEDDING_WORKER_PROTOCOL_VERSION,
    launch: () => Effect.succeed(false),
  },
];

export type LocalBinsPositiveHome = 'main' | 'report-preview' | 'migration-current' | 'migration-partial-share';
type LocalBinsWorkerDomain = 'recall' | 'graph';
export interface LocalBinsWorkerDrain {
  readonly positiveHome: LocalBinsPositiveHome;
  readonly domain: LocalBinsWorkerDomain;
  readonly capability: BackgroundWorkerFixtureDrain;
}
class LocalBinsWorkerDrainUnavailable extends Schema.TaggedError<
  LocalBinsWorkerDrainUnavailable,
  {readonly brand: unique symbol}
>()('LocalBinsWorkerDrainUnavailable', {
  positiveHome: Schema.Literals(['main', 'report-preview', 'migration-current', 'migration-partial-share']),
  domain: Schema.Literals(['recall', 'graph']),
  stage: Schema.Literals(['enrollment', 'drain']),
  reason: Schema.Literals(['ownership', 'identity-unknown', 'control-unavailable', 'deadline']),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}
const boundaryFailure = (
  positiveHome: LocalBinsPositiveHome,
  domain: LocalBinsWorkerDomain,
  stage: 'enrollment' | 'drain',
  cause: unknown,
) => {
  const reason = Schema.is(BackgroundWorkerFixtureDrainUnavailable)(cause) ? cause.reason : 'control-unavailable';
  const diagnostic = Schema.is(BackgroundWorkerFixtureDrainUnavailable)(cause) ? cause.diagnostic : undefined;
  return LocalBinsWorkerDrainUnavailable.make({
    positiveHome,
    domain,
    stage,
    reason,
    cause,
    message: `Local-bins ${positiveHome} ${domain} ${stage} failed: ${reason}${
      diagnostic === undefined ? '' : ` [operation=${diagnostic.operation} cause=${diagnostic.causeCategory}]`
    }.`,
  });
};

/** Call only on an already-created positive fixture home, before its first producer. */
export const createLocalBinsWorkerDrains = (
  home: string,
  fixtureRoot: string,
  executablePath: string,
  positiveHome: LocalBinsPositiveHome,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const version = yield* getThreadnoteVersion();
    return yield* Effect.forEach(localBinsWorkerOptions(path, home, version), (options, index) => {
      const domain = index === 0 ? 'recall' : 'graph';
      return createBackgroundWorkerFixtureDrain(options, {fixtureRoot, expectedExecutablePath: executablePath}).pipe(
        Effect.mapBoth({
          onFailure: cause => boundaryFailure(positiveHome, domain, 'enrollment', cause),
          onSuccess: (capability): LocalBinsWorkerDrain => ({positiveHome, domain, capability}),
        }),
      );
    });
  });

export const drainLocalBinsWorkers = (
  capabilities: readonly LocalBinsWorkerDrain[],
  originalDeadlineEpochMilliseconds: number,
) =>
  Effect.forEach(
    capabilities,
    ({capability, positiveHome, domain}) =>
      drainBackgroundWorkerFixture(capability, originalDeadlineEpochMilliseconds).pipe(
        Effect.mapError(cause => boundaryFailure(positiveHome, domain, 'drain', cause)),
      ),
    {concurrency: 'unbounded'},
  );

export const localBinsWorkerDrainLayer = Layer.mergeAll(BunServices.layer, cryptoLayer, TestSystemInfoLayer);
/** Promise boundary for the installed-CLI E2E harness; no application layer or child launch. */
export const runLocalBinsWorkerDrain = <A, E>(
  program: Effect.Effect<A, E, Layer.Success<typeof localBinsWorkerDrainLayer>>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Layer.build(localBinsWorkerDrainLayer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))),
    ),
  );

/** Run all cleanup stages, retaining fixture files unless coordinator and workers are proven drained. */
export const runLocalBinsE2eCleanup = async (
  stopCoordinator: () => Promise<void>,
  drainWorkers: () => Promise<unknown>,
  removeFixtureRoot: () => Promise<void>,
): Promise<void> => {
  let coordinatorFailure: unknown;
  let coordinatorFailed = false;
  try {
    await stopCoordinator();
  } catch (cause) {
    coordinatorFailed = true;
    coordinatorFailure = cause;
  }

  let workerDrainFailure: unknown;
  let workerDrainFailed = false;
  try {
    await drainWorkers();
  } catch (cause) {
    workerDrainFailed = true;
    workerDrainFailure = cause;
  }

  if (coordinatorFailed) throw coordinatorFailure;
  if (workerDrainFailed) throw workerDrainFailure;
  await removeFixtureRoot();
};
