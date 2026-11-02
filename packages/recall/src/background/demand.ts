import {Cause, Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';

export interface RecallEmbeddingScope {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

const desiredSchema = Schema.Struct({
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
  manifestPath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
});
const demandSchema = Schema.Struct({
  version: Schema.Literals([1]),
  account: Schema.String.check(Schema.isMaxLength(256)),
  user: Schema.String.check(Schema.isMaxLength(256)),
  desired: Schema.optionalKey(desiredSchema),
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

/** Absence means no demand. Malformed existing state never becomes an empty queue. */
export const readRecallEmbeddingDemand = Effect.fn('recall.readEmbeddingDemand')(function* (
  scope: RecallEmbeddingScope,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const location = locations(path, scope);
  if (!(yield* fs.exists(location.state))) return undefined;
  const stat = yield* fs.stat(location.state);
  if (
    stat.type !== 'File' ||
    Number(stat.size) > 8192 ||
    Option.isSome(yield* fs.readLink(location.state).pipe(Effect.option))
  )
    return yield* unavailable();
  const state = yield* Schema.decodeEffect(Schema.fromJsonString(demandSchema))(
    yield* fs.readFileString(location.state),
  );
  if (state.account !== scope.account || state.user !== scope.user) return yield* unavailable();
  return state;
}, Effect.mapError(unavailable));

const updateDemand = <A>(
  scope: RecallEmbeddingScope,
  update: (state: RecallEmbeddingDemand) => {readonly state: RecallEmbeddingDemand; readonly value: A},
  resetInvalid = false,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
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
              yield* fs.rename(location.state, location.state + '.invalid-' + (yield* crypto.randomUUIDv4()));
              yield* syncDirectoryBestEffort(fs, location.directory);
              return undefined;
            });
          }),
        );
        const result = update(previous ?? {version: 1, account: scope.account, user: scope.user});
        if (previous !== undefined && result.state === previous) return result.value;
        const encoded = JSON.stringify(result.state) + '\n';
        // Validate before any replacement, including caller supplied account/path sizes.
        yield* Schema.decodeEffect(Schema.fromJsonString(demandSchema))(encoded);
        const temporary = path.join(location.directory, (yield* crypto.randomUUIDv4()) + '.tmp');
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
  const token = yield* (yield* Crypto.Crypto).randomUUIDv4();
  return yield* updateDemand(
    scope,
    state =>
      coalesce && state.desired && state.desired.manifestPath === scope.manifestPath
        ? {state, value: state.desired.token}
        : {
            state: {
              ...state,
              desired: {token, ...(scope.manifestPath === undefined ? {} : {manifestPath: scope.manifestPath})},
            },
            value: token,
          },
    resetInvalid,
  );
});

export const requestRecallEmbeddings = (scope: RecallEmbeddingScope, coalesce = false) =>
  enqueueRecallEmbeddings(scope, coalesce, false);
/** Explicit operator repair preserves the rejected control file before rebuilding demand. */
export const repairRecallEmbeddingDemand = (scope: RecallEmbeddingScope) => enqueueRecallEmbeddings(scope, false, true);

/** A completion for an obsolete token cannot erase a later save, including after restart. */
export const completeRecallEmbeddingDemand = (scope: RecallEmbeddingScope, token: string) =>
  updateDemand(scope, state => {
    if (state.desired?.token !== token) return {state, value: false};
    const {desired: _desired, ...rest} = state;
    return {state: rest, value: true};
  });

export const deferRecallEmbeddings = (scope: RecallEmbeddingScope) =>
  requestRecallEmbeddings(scope).pipe(
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
