import {SecureRandom} from 'effect/crypto';
import {
  Array as EffectArray,
  Cause,
  Clock,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  String as EffectString,
} from 'effect';
import {readExclusiveFileLockOwner, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';
import {runtimeReadBoundedStableRegularFile, SystemInfo} from '@threadnote/platform/system';
import {fromPromise} from '@threadnote/platform/errors';

const integer = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: Number.MAX_SAFE_INTEGER}));
const nonceSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u));
const ownerSchema = Schema.Struct({
  token: nonceSchema,
  processId: Schema.Int.check(Schema.isGreaterThan(0)),
  processStartIdentity: Schema.String.check(Schema.isMaxLength(1024), Schema.isMinLength(1)),
});
const staleReceiptSchema = Schema.Struct({
  ...ownerSchema.fields,
  // A receipt can outlive several failed launches from later runtime versions.
  runtimeVersion: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
const stateSchema = Schema.Struct({
  version: Schema.Literals([1]),
  protocol: Schema.Int.check(Schema.isGreaterThan(0)),
  runtimeVersion: Schema.String.check(Schema.isMaxLength(256)),
  wakeSequence: integer,
  starting: Schema.optionalKey(Schema.Struct({nonce: nonceSchema, expiresAt: integer})),
  active: Schema.optionalKey(Schema.Struct({nonce: nonceSchema, owner: ownerSchema})),
  staleReceipt: Schema.optionalKey(staleReceiptSchema),
  staleLock: Schema.optionalKey(ownerSchema),
});
type State = typeof stateSchema.Type;
export type BackgroundWorkerOwner = typeof ownerSchema.Type;
export interface BackgroundWorkerControlOptions {
  readonly home: string;
  readonly lockPath: string;
  readonly receiptPath: string;
  readonly protocol: number;
  readonly version: string;
  /** Detached spawn acknowledgement only; never worker readiness or completion. */
  readonly launch: (nonce: string) => Effect.Effect<boolean, unknown>;
}
export type BackgroundWorkerWakeResult =
  | {readonly state: 'started' | 'starting' | 'active'}
  | {
      readonly state: 'deferred';
      readonly reason: 'legacy-owner' | 'owner-lock-fresh' | 'control-unavailable' | 'spawn-unconfirmed';
    };
export const BACKGROUND_WORKER_LOCK_STALE_MILLISECONDS = 120_000;
export interface BackgroundWorkerLifecycle {
  readonly activate: (owner: BackgroundWorkerOwner) => Effect.Effect<boolean, unknown>;
  /** Called before each complete domain-catalog scan, never after it. */
  readonly beforeScan: Effect.Effect<void, unknown>;
  /** Must run after the actual home-worker lock has released. */
  readonly afterRelease: (normalExit: boolean) => Effect.Effect<void, unknown>;
}
export class BackgroundWorkerControlUnavailable extends Schema.TaggedError<
  BackgroundWorkerControlUnavailable,
  {readonly brand: unique symbol}
>()('BackgroundWorkerControlUnavailable', {message: Schema.String}) {}
const unavailable = () =>
  BackgroundWorkerControlUnavailable.make({message: 'Background worker control is unavailable.'});
const controlPath = (options: BackgroundWorkerControlOptions) => options.receiptPath + '.launch-v2.json';
const STARTING_MILLISECONDS = 15_000;

const readRegular = Effect.fn('backgroundWorker.readRegular')(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filename))) return undefined;
  const bytes = yield* fromPromise('backgroundWorker.readRegular', () =>
    runtimeReadBoundedStableRegularFile(filename, 8192),
  );
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
});
const readState = Effect.fn('backgroundWorker.readState')(function* (options: BackgroundWorkerControlOptions) {
  const text = yield* readRegular(controlPath(options));
  if (text === undefined) return undefined;
  const state = yield* Schema.decodeEffect(Schema.fromJsonString(stateSchema), {onExcessProperty: 'error'})(text);
  if (state.active && state.starting) return yield* unavailable();
  return state;
});
const writeState = Effect.fn('backgroundWorker.writeState')(function* (
  options: BackgroundWorkerControlOptions,
  state: State,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(stateSchema))(state);
  const temporary = controlPath(options) + '.' + (yield* (yield* SecureRandom.SecureRandom).uuidV4()) + '.tmp';
  yield* Effect.acquireUseRelease(
    fs.writeFileString(temporary, encoded + '\n', {mode: 0o600, flag: 'wx'}),
    () => syncWritableFile(fs, temporary).pipe(Effect.andThen(fs.rename(temporary, controlPath(options)))),
    () => fs.remove(temporary, {force: true}).pipe(Effect.ignore),
  );
  yield* syncDirectoryBestEffort(fs, path.dirname(controlPath(options)));
});

function guarded<A, E, R>(
  options: BackgroundWorkerControlOptions,
  program: Effect.Effect<A, E, R>,
  waitTimeoutMilliseconds = 100,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Resolve the existing home first; a late child must never resurrect an uninstalled home.
    const home = yield* fs.stat(options.home);
    if (home.type !== 'Directory') return yield* unavailable();
    const relative = path.relative(options.home, path.dirname(options.receiptPath));
    const components = EffectArray.filter(EffectString.split(/[\\/]/u)(relative), Boolean);
    if (
      path.isAbsolute(relative) ||
      EffectArray.some(components, component => component === '..') ||
      components.length > 8
    )
      return yield* unavailable();
    let directory = options.home;
    for (const component of components) {
      directory = path.join(directory, component);
      // Non-recursive creation cannot recreate an ancestor concurrently removed by uninstall.
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
      options.receiptPath + '.launch-v2.lock',
      {
        createParentDirectory: false,
        retryIntervalMilliseconds: 10,
        staleAfterMilliseconds: 5000,
        waitTimeoutMilliseconds,
        useCanonicalProcessStartIdentity: true,
      },
      program,
    );
  });
}
const alive = Effect.fn('backgroundWorker.alive')(function* (owner: {
  processId: number;
  processStartIdentity?: string;
}) {
  const system = yield* SystemInfo;
  if (!system.isProcessRunning(owner.processId)) return false;
  if (!owner.processStartIdentity) return true;
  const identity = yield* system.processStartIdentity(owner.processId);
  // Unknown identity retains the owner; a positive mismatch proves PID reuse.
  return identity === undefined || identity === owner.processStartIdentity;
});
const blockingOwner = Effect.fn('backgroundWorker.blockingOwner')(function* (
  options: BackgroundWorkerControlOptions,
  deadState?: State,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const dead: BackgroundWorkerOwner[] = [];
  for (const owner of [deadState?.active?.owner, deadState?.staleReceipt, deadState?.staleLock])
    if (owner && !(yield* alive(owner))) dead.push(owner);
  const recovery: {staleReceipt?: typeof staleReceiptSchema.Type; staleLock?: BackgroundWorkerOwner} = {};
  const text = yield* readRegular(options.receiptPath);
  if (text !== undefined) {
    const receipt = yield* Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          processId: Schema.Int.check(Schema.isGreaterThan(0)),
          processStartIdentity: Schema.optionalKey(Schema.String),
          token: Schema.optionalKey(Schema.String),
          protocol: Schema.optionalKey(Schema.Int),
          version: Schema.optionalKey(Schema.String),
        }),
      ),
    )(text);
    const matchingOwner = Option.getOrUndefined(
      EffectArray.findFirst(
        dead,
        owner =>
          (owner === deadState?.active?.owner || owner === deadState?.staleReceipt) &&
          receipt.token === owner.token &&
          receipt.processId === owner.processId &&
          receipt.processStartIdentity === owner.processStartIdentity &&
          receipt.protocol === deadState?.protocol &&
          receipt.version ===
            (owner === deadState?.staleReceipt
              ? (deadState?.staleReceipt?.runtimeVersion ?? deadState?.runtimeVersion)
              : deadState?.runtimeVersion),
      ),
    );
    if (matchingOwner) recovery.staleReceipt = {...matchingOwner, runtimeVersion: receipt.version};
    if (system.isProcessRunning(receipt.processId) && !recovery.staleReceipt) return {reason: 'legacy-owner' as const};
  }
  if (!(yield* fs.exists(options.lockPath))) return recovery;
  const owner = yield* readExclusiveFileLockOwner(fs, options.lockPath);
  // Legacy lock metadata does not identify its process-identity channel.
  if (Option.isNone(owner)) return {reason: 'legacy-owner' as const};
  const lock = owner.value;
  if (
    EffectArray.some(
      dead,
      deadOwner =>
        (deadOwner === deadState?.active?.owner ||
          (deadOwner === deadState?.staleLock && lock.token === deadOwner.token)) &&
        lock.processId === deadOwner.processId &&
        lock.processStartIdentity === deadOwner.processStartIdentity,
    ) &&
    lock.processStartIdentity !== undefined
  )
    recovery.staleLock = {...lock, processStartIdentity: lock.processStartIdentity};
  if (!system.isProcessRunning(lock.processId)) return recovery;
  if (recovery.staleLock) {
    const modifiedAt = Option.getOrUndefined((yield* fs.stat(options.lockPath)).mtime)?.getTime();
    // Let the child perform ordinary stale-lock recovery; do not repeatedly spawn against a fresh lock.
    if (
      modifiedAt !== undefined &&
      (yield* Clock.currentTimeMillis) - modifiedAt > BACKGROUND_WORKER_LOCK_STALE_MILLISECONDS
    )
      return recovery;
    return {reason: 'owner-lock-fresh' as const};
  }
  return {reason: 'legacy-owner' as const};
});
const compatible = (options: BackgroundWorkerControlOptions, state: State) =>
  state.protocol === options.protocol && state.runtimeVersion === options.version;

const launch = Effect.fn('backgroundWorker.launch')(function* (
  options: BackgroundWorkerControlOptions,
  state: State,
  recovery: {readonly staleReceipt?: typeof staleReceiptSchema.Type; readonly staleLock?: BackgroundWorkerOwner} = {},
) {
  const nonce = yield* (yield* SecureRandom.SecureRandom).uuidV4();
  const starting: State = {
    version: 1,
    protocol: options.protocol,
    runtimeVersion: options.version,
    wakeSequence: state.wakeSequence,
    starting: {nonce, expiresAt: (yield* Clock.currentTimeMillis) + STARTING_MILLISECONDS},
    ...recovery,
  };
  // Publish authorization before spawn. A delayed child must claim this exact unexpired nonce.
  yield* writeState(options, starting);
  const started = yield* options.launch(nonce).pipe(
    Effect.timeoutOption('250 millis'),
    Effect.orElseSucceed(() => Option.none<boolean>()),
  );
  return Option.isSome(started) && started.value
    ? {state: 'started' as const}
    : {state: 'deferred' as const, reason: 'spawn-unconfirmed' as const};
});

/** Advances only launch metadata. Canonical/demand persistence must finish before this wake. */
export const wakeBackgroundWorker = Effect.fn('backgroundWorker.wake')(function* (
  options: BackgroundWorkerControlOptions,
) {
  return yield* guarded(
    options,
    Effect.gen(function* () {
      const previous = yield* readState(options);
      if (previous && previous.protocol !== options.protocol)
        return {state: 'deferred' as const, reason: 'legacy-owner' as const};
      const state: State = {
        ...(previous ?? {version: 1, protocol: options.protocol, runtimeVersion: options.version, wakeSequence: 0}),
        wakeSequence: (previous?.wakeSequence ?? 0) + 1,
      };
      // A different runtime may recover only after the existing owner/nonce and file fences clear.
      if (!previous || compatible(options, previous)) yield* writeState(options, state);
      if (state.active && (yield* alive(state.active.owner)))
        return compatible(options, state)
          ? {state: 'active' as const}
          : {state: 'deferred' as const, reason: 'legacy-owner' as const};
      if (state.starting && state.starting.expiresAt > (yield* Clock.currentTimeMillis))
        return compatible(options, state)
          ? {state: 'starting' as const}
          : {state: 'deferred' as const, reason: 'legacy-owner' as const};
      const blocker = yield* blockingOwner(options, state);
      if ('reason' in blocker) return {state: 'deferred' as const, reason: blocker.reason};
      return yield* launch(options, state, blocker);
    }),
  ).pipe(
    Effect.catchCauseIf(
      cause => !Cause.hasInterrupts(cause),
      () => Effect.succeed({state: 'deferred' as const, reason: 'control-unavailable' as const}),
    ),
  );
});

/** Read-only diagnostics do not grant ownership, wake a worker or create files. */
export const inspectBackgroundWorkerControl = Effect.fn('backgroundWorker.inspect')(
  function* (options: BackgroundWorkerControlOptions) {
    const state = yield* readState(options);
    if (state && state.protocol !== options.protocol) return {state: 'legacy-owner' as const};
    if (state?.active && (yield* alive(state.active.owner))) {
      const system = yield* SystemInfo;
      const exact =
        (yield* system.processStartIdentity(state.active.owner.processId)) === state.active.owner.processStartIdentity;
      return {state: compatible(options, state) && exact ? ('active' as const) : ('legacy-owner' as const)};
    }
    if (state?.starting && state.starting.expiresAt > (yield* Clock.currentTimeMillis))
      return {state: compatible(options, state) ? ('starting' as const) : ('legacy-owner' as const)};
    const blocker = yield* blockingOwner(options, state);
    return {state: 'reason' in blocker ? blocker.reason : ('queued' as const)};
  },
  Effect.catchCauseIf(
    cause => !Cause.hasInterrupts(cause),
    () => Effect.succeed({state: 'unavailable' as const}),
  ),
);

/** The caller owns the actual home lock before claiming launch authority. */
export const makeBackgroundWorkerLifecycle = Effect.fn('backgroundWorker.lifecycle')(function* (
  options: BackgroundWorkerControlOptions,
  nonce: string,
) {
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom | SystemInfo>();
  const workerGuarded = <A, E, R>(program: Effect.Effect<A, E, R>) => guarded(options, program, 1000);
  let claimed = false;
  let observedSequence: number | undefined;
  const activate = (owner: BackgroundWorkerOwner) =>
    workerGuarded(
      Effect.gen(function* () {
        const state = yield* readState(options);
        if (
          !state ||
          !compatible(options, state) ||
          state.starting?.nonce !== nonce ||
          state.starting.expiresAt <= (yield* Clock.currentTimeMillis)
        )
          return false;
        const {starting: _starting, ...rest} = state;
        yield* writeState(options, {...rest, active: {nonce, owner}});
        claimed = true;
        return true;
      }),
    ).pipe(Effect.provide(services));
  const beforeScan = workerGuarded(
    Effect.gen(function* () {
      const state = yield* readState(options);
      if (!claimed || state?.active?.nonce !== nonce || !compatible(options, state)) return yield* unavailable();
      observedSequence = state.wakeSequence;
    }),
  ).pipe(Effect.provide(services));
  const afterRelease = (normalExit: boolean) =>
    workerGuarded(
      Effect.gen(function* () {
        if (!claimed) return;
        const fs = yield* FileSystem.FileSystem;
        const state = yield* readState(options);
        if (state?.active?.nonce !== nonce || !compatible(options, state)) return;
        // Refuse a premature finalizer; producers must never observe a free slot before home-lock release.
        if (yield* fs.exists(options.lockPath)) return yield* unavailable();
        const text = yield* readRegular(options.receiptPath);
        if (text !== undefined) {
          const receipt = yield* Schema.decodeEffect(Schema.fromJsonString(ownerSchema))(text);
          if (
            receipt.token !== state.active.owner.token ||
            receipt.processId !== state.active.owner.processId ||
            receipt.processStartIdentity !== state.active.owner.processStartIdentity
          )
            return yield* unavailable();
          yield* fs.remove(options.receiptPath);
        }
        const {active: _active, staleReceipt: _receipt, staleLock: _lock, ...rest} = state;
        yield* writeState(options, rest);
        // Failures/crashes recover on the next supported wake/startup, not an unbounded respawn loop.
        if (normalExit && observedSequence !== undefined && state.wakeSequence > observedSequence)
          yield* launch(options, rest);
        claimed = false;
      }),
    ).pipe(Effect.provide(services));
  return {activate, beforeScan, afterRelease} satisfies BackgroundWorkerLifecycle;
});
