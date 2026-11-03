import {SecureRandom} from 'effect/crypto';
import {Cause, Context, Effect, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {runtimeReadBoundedStableRegularFile, SystemInfo} from '@threadnote/platform/system';
import {fromPromise} from '@threadnote/platform/errors';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';

export interface RecallEmbeddingScope {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

/** Production composition supplies this optional port; focused static layers stay spawn-free. */
export const RecallEmbeddingWakePort = Context.Reference<((home: string) => Effect.Effect<void>) | undefined>(
  '@threadnote/recall/background/WakePort',
  {defaultValue: () => undefined},
);
const observationSchema = Schema.Struct({
  revision: Schema.String,
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  state: Schema.Literals([
    'queued',
    'deferred-cpu',
    'deferred-foreground',
    'preparing',
    'running',
    'blocked',
    'corrupt',
  ]),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  failures: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 8})),
  notBefore: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({minimum: 0, maximum: Number.MAX_SAFE_INTEGER}))),
  owner: Schema.optionalKey(Schema.Struct({processId: Schema.Int, processStartIdentity: Schema.String})),
  progress: Schema.optionalKey(
    Schema.Struct({
      phase: Schema.Literals(['metadata', 'resolve', 'hydrate', 'embed', 'retire', 'ready']),
      completed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      reusedDocuments: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
export type RecallEmbeddingObservation = typeof observationSchema.Type;

const desiredSchema = Schema.Struct({
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
  manifestPath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
});
const legacyDemandSchema = Schema.Struct({
  version: Schema.Literals([1]),
  account: Schema.String.check(Schema.isMaxLength(256)),
  user: Schema.String.check(Schema.isMaxLength(256)),
  desired: Schema.optionalKey(desiredSchema),
});
const demandSchema = Schema.Struct({
  version: Schema.Literals([2]),
  account: Schema.String.check(Schema.isMaxLength(256)),
  user: Schema.String.check(Schema.isMaxLength(256)),
  observation: Schema.optionalKey(observationSchema),
  desired: Schema.optionalKey(
    Schema.Struct({
      ...desiredSchema.fields,
      revision: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
    }),
  ),
});
export type RecallEmbeddingDemand = typeof demandSchema.Type;
export class RecallEmbeddingDemandUnavailable extends Schema.TaggedError<
  RecallEmbeddingDemandUnavailable,
  {readonly brand: unique symbol}
>()('RecallEmbeddingDemandUnavailable', {message: Schema.String}) {}
const unavailable = () => RecallEmbeddingDemandUnavailable.make({message: 'Recall embedding demand requires repair.'});

export function recallEmbeddingDemandKey(scope: Pick<RecallEmbeddingScope, 'account' | 'user'>): string {
  return sha256HexSync(JSON.stringify([scope.account, scope.user]));
}

const locations = (path: Path.Path, scope: RecallEmbeddingScope) => {
  const directory = path.join(scope.agentContextHome, 'recall', 'embedding-demand-v1');
  const key = recallEmbeddingDemandKey(scope);
  return {directory, state: path.join(directory, key + '.json'), guard: path.join(directory, key + '.lock')};
};

const readDemandFile = Effect.fn('recall.readEmbeddingDemandFile')(function* (filename: string) {
  const text = yield* fromPromise('recall.readEmbeddingDemandFile', () =>
    runtimeReadBoundedStableRegularFile(filename, 8192),
  ).pipe(
    Effect.retry({
      times: 2,
      while: error =>
        Schema.is(
          Schema.Struct({
            _tag: Schema.Literals(['SystemOperationError']),
            message: Schema.Literals(['Target changed while opening.', 'Target changed during bounded read.']),
          }),
        )(error.cause),
    }),
  );
  const decoded = yield* Effect.try({
    try: () => new TextDecoder('utf-8', {fatal: true}).decode(text),
    catch: unavailable,
  });
  const state = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Union([legacyDemandSchema, demandSchema])))(
    decoded,
  );
  const normalized: RecallEmbeddingDemand =
    state.version === 1
      ? {
          version: 2,
          account: state.account,
          user: state.user,
          ...(state.desired ? {desired: {...state.desired, revision: state.desired.token}} : {}),
        }
      : state;
  return normalized;
}, Effect.mapError(unavailable));

/** Absence means no demand. Malformed existing state never becomes an empty queue. */
export const readRecallEmbeddingDemand = Effect.fn('recall.readEmbeddingDemand')(function* (
  scope: RecallEmbeddingScope,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const location = locations(path, scope);
  if (!(yield* fs.exists(location.state))) return undefined;
  const state = yield* readDemandFile(location.state);
  if (state.account !== scope.account || state.user !== scope.user) return yield* unavailable();
  return state;
}, Effect.mapError(unavailable));

/** One bounded physical catalog entry, with no memory-body reads or registry. */
export const readRecallEmbeddingScope = Effect.fn('recall.readEmbeddingScope')(function* (
  home: string,
  filename: string,
) {
  if (!/^[a-f0-9]{64}\.json$/u.test(filename)) return undefined;
  const path = yield* Path.Path;
  const state = yield* readDemandFile(path.join(home, 'recall', 'embedding-demand-v1', filename));
  if (
    filename !== recallEmbeddingDemandKey(state) + '.json' ||
    !state.account ||
    !state.user ||
    /[\\/]/u.test(state.account) ||
    /[\\/]/u.test(state.user) ||
    EffectString.includes('\0')(state.account) ||
    EffectString.includes('\0')(state.user) ||
    state.account === '.' ||
    state.account === '..' ||
    state.user === '.' ||
    state.user === '..' ||
    (state.desired?.manifestPath !== undefined && !path.isAbsolute(state.desired.manifestPath))
  )
    return yield* unavailable();
  return state.desired
    ? {
        account: state.account,
        user: state.user,
        agentContextHome: home,
        ...(state.desired.manifestPath === undefined ? {} : {manifestPath: state.desired.manifestPath}),
      }
    : undefined;
});

const updateDemand = <A>(
  scope: RecallEmbeddingScope,
  update: (state: RecallEmbeddingDemand) => {readonly state: RecallEmbeddingDemand; readonly value: A},
  resetInvalid = false,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* SecureRandom.SecureRandom;
    // A worker must not resurrect an uninstalled home. No recursive mkdir crosses this boundary.
    const home = yield* fs.stat(scope.agentContextHome);
    if (home.type !== 'Directory') return yield* unavailable();
    const location = locations(path, scope);
    for (const directory of [path.join(scope.agentContextHome, 'recall'), location.directory]) {
      yield* fs
        .makeDirectory(directory, {mode: 0o700})
        .pipe(
          Effect.catchTag('PlatformError', error =>
            error.reason._tag === 'AlreadyExists' ? Effect.void : Effect.fail(error),
          ),
        );
    }
    return yield* withExclusiveFileLock(
      fs,
      location.guard,
      {
        createParentDirectory: false,
        retryIntervalMilliseconds: 10,
        staleAfterMilliseconds: 5000,
        waitTimeoutMilliseconds: 1000,
        useCanonicalProcessStartIdentity: true,
      },
      Effect.gen(function* () {
        const previous = yield* readRecallEmbeddingDemand(scope).pipe(
          Effect.catchTag('RecallEmbeddingDemandUnavailable', error => {
            if (!resetInvalid) return Effect.fail(error);
            return Effect.gen(function* () {
              const stat = yield* fs.stat(location.state);
              if (
                stat.type !== 'File' ||
                Number(stat.size) > 8192 ||
                Option.isSome(yield* fs.readLink(location.state).pipe(Effect.option))
              )
                return yield* error;
              yield* fs.readFileString(location.state);
              yield* fs.rename(location.state, location.state + '.invalid-' + (yield* crypto.uuidV4()));
              yield* syncDirectoryBestEffort(fs, location.directory);
              return undefined;
            });
          }),
        );
        const result = update(previous ?? {version: 2, account: scope.account, user: scope.user});
        if (previous !== undefined && result.state === previous) return result.value;
        const encoded = JSON.stringify(result.state) + '\n';
        // Validate before any replacement, including caller supplied account/path sizes.
        yield* Schema.decodeEffect(Schema.fromJsonString(demandSchema))(encoded);
        const temporary = path.join(location.directory, (yield* crypto.uuidV4()) + '.tmp');
        yield* Effect.acquireUseRelease(
          fs.writeFileString(temporary, encoded, {mode: 0o600, flag: 'wx'}).pipe(Effect.as(temporary)),
          temporary => syncWritableFile(fs, temporary).pipe(Effect.andThen(fs.rename(temporary, location.state))),
          temporary => fs.remove(temporary, {force: true}).pipe(Effect.ignore),
        );
        yield* syncDirectoryBestEffort(fs, location.directory);
        return result.value;
      }),
    );
  }).pipe(Effect.mapError(unavailable));

/** Signals reconciliation, never a trusted corpus/model target or a document body. */
const enqueueRecallEmbeddings = Effect.fn('recall.enqueueEmbeddings')(function* (
  scope: RecallEmbeddingScope,
  coalesce: boolean,
  resetInvalid: boolean,
) {
  const crypto = yield* SecureRandom.SecureRandom;
  const revision = yield* crypto.uuidV4();
  const selected = yield* updateDemand(
    scope,
    state => {
      const sameConfiguration = coalesce && state.desired?.manifestPath === scope.manifestPath;
      // A same-generation hint cannot prove model/authorization equivalence.
      // Every admitted enqueue is a distinct event; only configuration coalesces.
      const selectedToken = sameConfiguration && state.desired ? state.desired.token : revision;
      const {observation: _observation, ...rest} = state;
      return {
        state: {
          ...rest,
          desired: {
            token: selectedToken,
            revision,
            ...(scope.manifestPath === undefined ? {} : {manifestPath: scope.manifestPath}),
          },
        },
        value: selectedToken,
      };
    },
    resetInvalid,
  );
  const wake = yield* RecallEmbeddingWakePort;
  if (wake)
    yield* wake(scope.agentContextHome).pipe(
      Effect.catchCauseIf(
        cause => !Cause.hasInterrupts(cause),
        () => Effect.void,
      ),
    );
  return selected;
});

export const requestRecallEmbeddings = (scope: RecallEmbeddingScope, coalesce = false) =>
  enqueueRecallEmbeddings(scope, coalesce, false);
/** Explicit operator repair preserves the rejected control file before rebuilding demand. */
export const repairRecallEmbeddingDemand = (scope: RecallEmbeddingScope) => enqueueRecallEmbeddings(scope, false, true);

/** Completion must observe the same event, including when configuration coalesces its token. */
export const completeRecallEmbeddingDemand = (scope: RecallEmbeddingScope, token: string, revision: string) =>
  updateDemand(scope, state => {
    if (state.desired?.token !== token || state.desired.revision !== revision) return {state, value: false};
    const {desired: _desired, observation: _observation, ...rest} = state;
    return {state: rest, value: true};
  });

/** Observations never complete demand or select a corpus/model target. */
export const observeRecallEmbeddingDemand = (
  scope: RecallEmbeddingScope,
  event: {token: string; revision: string},
  observation: Omit<RecallEmbeddingObservation, 'revision'>,
) =>
  updateDemand(scope, state => {
    if (state.desired?.token !== event.token || state.desired.revision !== event.revision) return {state, value: false};
    const next = {...observation, revision: event.revision};
    return JSON.stringify(state.observation) === JSON.stringify(next)
      ? {state, value: true}
      : {state: {...state, observation: next}, value: true};
  });

export const recallEmbeddingObservedState = Effect.fn('recall.embeddingObservedState')(function* (
  scope: RecallEmbeddingScope,
  model?: string,
) {
  const demand = yield* readRecallEmbeddingDemand(scope);
  if (!demand?.desired) return {state: 'none' as const};
  const observed = demand.observation;
  if (!observed || observed.revision !== demand.desired.revision || (model !== undefined && observed.model !== model))
    return {state: 'queued' as const};
  if (
    observed.state === 'preparing' ||
    observed.state === 'running' ||
    observed.state === 'deferred-cpu' ||
    observed.state === 'deferred-foreground'
  ) {
    const system = yield* SystemInfo;
    const owner = observed.owner;
    if (
      !owner ||
      !system.isProcessRunning(owner.processId) ||
      (yield* system.processStartIdentity(owner.processId)) !== owner.processStartIdentity
    )
      return {state: 'queued' as const, reason: 'worker-not-current'};
  }
  return {state: observed.state, ...(observed.reason === undefined ? {} : {reason: observed.reason})};
});

export const deferRecallEmbeddings = (scope: RecallEmbeddingScope) =>
  requestRecallEmbeddings(scope, true).pipe(
    Effect.as({
      state: 'deferred' as const,
      repair: 'Document embeddings are queued until spare CPU capacity and no foreground Threadnote work.',
    }),
    Effect.catchCauseIf(
      cause => !Cause.hasInterrupts(cause),
      () =>
        Effect.succeed({
          state: 'deferred' as const,
          repair: 'Recall embedding demand could not be persisted; run `threadnote repair`.',
        }),
    ),
  );
