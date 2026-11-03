import {SecureRandom} from 'effect/crypto';
import {Array as EffectArray, Clock, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {runtimeReadBoundedStableRegularFile} from '@threadnote/platform/system';
import {fromPromise} from '@threadnote/platform/errors';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {RecallEmbeddingWakePort} from './demand.js';

const maintenanceWorkSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(['synchronize']),
    sources: Schema.Boolean,
    teams: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(16))),
  }),
  Schema.Struct({
    kind: Schema.Literals(['anchors']),
    callerCwd: Schema.String.check(Schema.isMaxLength(4096)),
    repositoryId: Schema.String.check(Schema.isMaxLength(256)),
    worktreeId: Schema.String.check(Schema.isMaxLength(256)),
    codeRefs: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(8)),
  }),
]);
export type RecallReadMaintenanceWork = typeof maintenanceWorkSchema.Type;

export interface RecallLexicalScope {
  readonly account: string;
  readonly agentContextHome: string;
  readonly user: string;
  readonly manifestPath?: string;
  readonly includeInactive: boolean;
  readonly work?: RecallReadMaintenanceWork;
}
const demandSchema = Schema.Struct({
  // Older workers must reject new reconciliation intent rather than drop it.
  version: Schema.Literals([1, 2]),
  account: Schema.String.check(Schema.isMaxLength(256)),
  user: Schema.String.check(Schema.isMaxLength(256)),
  includeInactive: Schema.Boolean,
  reconcile: Schema.optionalKey(Schema.Boolean),
  work: Schema.optionalKey(maintenanceWorkSchema),
  manifestPath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  revision: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u))),
  completedAt: Schema.optionalKey(Schema.Finite),
  notBefore: Schema.optionalKey(Schema.Finite),
  sourceGeneration: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  failures: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 8})),
});
export type RecallLexicalDemand = typeof demandSchema.Type;
export const recallLexicalDemandKey = (scope: Omit<RecallLexicalScope, 'agentContextHome'>) =>
  sha256HexSync(
    JSON.stringify([
      scope.account,
      scope.user,
      scope.includeInactive,
      scope.manifestPath ?? null,
      ...(scope.work
        ? [
            scope.work.kind === 'anchors'
              ? [scope.work.kind, scope.work.repositoryId, scope.work.worktreeId]
              : [
                  scope.work.kind,
                  scope.work.sources,
                  scope.work.teams === undefined ? null : [...scope.work.teams].sort(),
                ],
          ]
        : []),
    ]),
  );
export const RECALL_LEXICAL_DEMAND_DIRECTORY = 'lexical-demand-v1';
export class RecallLexicalDemandUnavailable extends Schema.TaggedError<
  RecallLexicalDemandUnavailable,
  {readonly brand: unique symbol}
>()('RecallLexicalDemandUnavailable', {message: Schema.String}) {}
const unavailable = () =>
  RecallLexicalDemandUnavailable.make({message: 'Lexical maintenance demand could not be persisted.'});
const location = (path: Path.Path, scope: RecallLexicalScope) => {
  const directory = path.join(scope.agentContextHome, 'recall', RECALL_LEXICAL_DEMAND_DIRECTORY);
  const key = recallLexicalDemandKey(scope);
  return {directory, state: path.join(directory, key + '.json'), lock: path.join(directory, key + '.lock')};
};
const readFile = (filename: string) =>
  fromPromise('recall.readLexicalDemand', () => runtimeReadBoundedStableRegularFile(filename, 8192)).pipe(
    Effect.flatMap(bytes =>
      Effect.try({try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes), catch: unavailable}),
    ),
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(demandSchema))),
    Effect.mapError(unavailable),
  );
const validScope = (path: Path.Path, scope: Omit<RecallLexicalScope, 'agentContextHome'>) =>
  EffectArray.every(
    [scope.account, scope.user],
    value => value.length > 0 && value !== '.' && value !== '..' && !/[\\/\0]/u.test(value),
  ) &&
  (scope.manifestPath === undefined || path.isAbsolute(scope.manifestPath)) &&
  (scope.work?.kind !== 'anchors' || path.isAbsolute(scope.work.callerCwd));

export const readRecallLexicalDemand = Effect.fn('recall.readLexicalDemand')(function* (scope: RecallLexicalScope) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  if (!validScope(path, scope)) return yield* unavailable();
  const file = location(path, scope).state;
  if (!(yield* fs.exists(file))) return undefined;
  const state = yield* readFile(file);
  if (recallLexicalDemandKey(state) !== recallLexicalDemandKey(scope)) return yield* unavailable();
  return state;
});
export const readRecallLexicalScope = Effect.fn('recall.readLexicalScope')(function* (home: string, filename: string) {
  if (!/^[a-f0-9]{64}\.json$/u.test(filename)) return undefined;
  const path = yield* Path.Path;
  const state = yield* readFile(path.join(home, 'recall', RECALL_LEXICAL_DEMAND_DIRECTORY, filename));
  if (!validScope(path, state) || filename !== recallLexicalDemandKey(state) + '.json') return yield* unavailable();
  return state.revision && state.failures < 8 ? {...state, agentContextHome: home} : undefined;
});
const update = <A>(
  scope: RecallLexicalScope,
  f: (state: RecallLexicalDemand) => {state: RecallLexicalDemand; value: A},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* SecureRandom.SecureRandom;
    if (!validScope(path, scope) || (yield* fs.stat(scope.agentContextHome)).type !== 'Directory')
      return yield* unavailable();
    const files = location(path, scope);
    // Never recreate a deleted/uninstalled home.
    for (const directory of [path.join(scope.agentContextHome, 'recall'), files.directory]) {
      yield* fs
        .makeDirectory(directory, {mode: 0o700})
        .pipe(
          Effect.catchTag('PlatformError', error =>
            error.reason._tag === 'AlreadyExists' ? Effect.void : Effect.fail(error),
          ),
        );
      if (
        (yield* fs.stat(directory)).type !== 'Directory' ||
        Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))
      )
        return yield* unavailable();
    }
    return yield* withExclusiveFileLock(
      fs,
      files.lock,
      {
        createParentDirectory: false,
        retryIntervalMilliseconds: 5,
        staleAfterMilliseconds: 5000,
        waitTimeoutMilliseconds: 50,
        useCanonicalProcessStartIdentity: true,
      },
      Effect.gen(function* () {
        const previous = yield* readRecallLexicalDemand(scope);
        const result = f(
          previous ?? {
            version: 2,
            account: scope.account,
            user: scope.user,
            includeInactive: scope.includeInactive,
            ...(scope.work ? {work: scope.work} : {}),
            ...(scope.manifestPath === undefined ? {} : {manifestPath: scope.manifestPath}),
            failures: 0,
          },
        );
        if (result.state === previous) return result.value;
        const encoded = JSON.stringify({...result.state, version: 2}) + '\n';
        yield* Schema.decodeEffect(Schema.fromJsonString(demandSchema))(encoded);
        if (new TextEncoder().encode(encoded).byteLength > 8192) return yield* unavailable();
        const temporary = path.join(files.directory, (yield* crypto.uuidV4()) + '.tmp');
        yield* Effect.acquireUseRelease(
          fs.writeFileString(temporary, encoded, {mode: 0o600, flag: 'wx'}).pipe(Effect.as(temporary)),
          file => syncWritableFile(fs, file).pipe(Effect.andThen(fs.rename(file, files.state))),
          file => fs.remove(file, {force: true}).pipe(Effect.ignore),
        );
        yield* syncDirectoryBestEffort(fs, files.directory);
        return result.value;
      }),
    );
  }).pipe(Effect.mapError(unavailable));

/** Coalesce configuration, but fence completion against every later enqueue event. */
export const requestRecallLexicalRefresh = Effect.fn('recall.requestLexicalRefresh')(function* (
  scope: RecallLexicalScope,
  options: {readonly reconcile?: boolean} = {},
) {
  const revision = yield* (yield* SecureRandom.SecureRandom).uuidV4();
  const sourceGeneration = yield* readCanonicalMutationGeneration(
    yield* FileSystem.FileSystem,
    yield* Path.Path,
    scope.agentContextHome,
    scope.account,
  );
  const now = yield* Clock.currentTimeMillis;
  const selected = yield* update(scope, state => {
    const reconcile = (state.revision !== undefined && state.reconcile === true) || options.reconcile === true;
    const escalated = reconcile && state.reconcile !== true;
    return scope.work?.kind === 'synchronize' &&
      !reconcile &&
      !state.revision &&
      state.completedAt !== undefined &&
      state.completedAt <= now &&
      now - state.completedAt < 60_000
      ? {state, value: 'current'}
      : state.failures >= 8 &&
          state.sourceGeneration === sourceGeneration &&
          state.notBefore !== undefined &&
          state.notBefore > now
        ? {
            state: escalated ? {...state, revision, reconcile: true} : state,
            value: undefined,
          }
        : {
            state: {
              ...state,
              ...(scope.work ? {work: scope.work} : {}),
              revision,
              reconcile,
              sourceGeneration,
              failures: state.sourceGeneration === sourceGeneration && state.failures < 8 ? state.failures : 0,
              notBefore:
                state.sourceGeneration === sourceGeneration && state.failures < 8 ? state.notBefore : undefined,
            },
            value: revision,
          };
  });
  if (selected === undefined) return yield* unavailable();
  if (selected === 'current') return selected;
  const wake = yield* RecallEmbeddingWakePort;
  if (wake) yield* wake(scope.agentContextHome).pipe(Effect.ignore);
  return selected;
});
export const completeRecallLexicalRefresh = Effect.fn('recall.completeLexicalRefresh')(function* (
  scope: RecallLexicalScope,
  revision: string,
) {
  const completedAt = yield* Clock.currentTimeMillis;
  return yield* update(scope, state => {
    if (state.revision !== revision) return {state, value: false};
    const {revision: _revision, notBefore: _notBefore, reconcile: _reconcile, ...rest} = state;
    return {
      state: {...rest, failures: 0, completedAt},
      value: true,
    };
  });
});
export const failRecallLexicalRefresh = Effect.fn('recall.failLexicalRefresh')(function* (
  scope: RecallLexicalScope,
  revision: string,
  terminal = false,
) {
  const now = yield* Clock.currentTimeMillis;
  return yield* update(scope, state => {
    if (state.revision !== revision) return {state, value: false};
    const failures = terminal ? 8 : Math.min(8, state.failures + 1);
    return {
      state: {...state, failures, notBefore: now + (failures >= 8 ? 60_000 : Math.min(30_000, 1000 * 2 ** failures))},
      value: true,
    };
  });
});
export const deferRecallLexicalRefresh = Effect.fn('recall.deferLexicalRefresh')(function* (
  scope: RecallLexicalScope,
  revision: string,
  delay: number,
) {
  const now = yield* Clock.currentTimeMillis;
  return yield* update(scope, state =>
    state.revision !== revision ? {state, value: false} : {state: {...state, notBefore: now + delay}, value: true},
  );
});
