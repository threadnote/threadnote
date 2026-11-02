import {
  Array as EffectArray,
  Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Schema,
} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';
import {SystemInfo, type SystemCpuTimes} from '@threadnote/platform/system';

export const BACKGROUND_INFERENCE_THREADS = 1;
export const BACKGROUND_INFERENCE_ENV = 'THREADNOTE_BACKGROUND_INFERENCE';
export const BACKGROUND_INFERENCE_INPUT_LIMIT = 1;
export const BACKGROUND_INFERENCE_REQUEST_MILLISECONDS = 10_000;
export const BACKGROUND_INFERENCE_BATCH_MILLISECONDS = 15_000;
export const BACKGROUND_INFERENCE_QUIET_MILLISECONDS = 1_000;
export const BACKGROUND_INFERENCE_FOREGROUND_AGE_MILLISECONDS = 30_000;
const MINIMUM_CAPACITY_YIELD_MILLISECONDS = 100;
const LEASE_MILLISECONDS = 30_000;
const HEARTBEAT_MILLISECONDS = 5_000;
const SAMPLE_MINIMUM_MILLISECONDS = 500;
const SAMPLE_MAXIMUM_MILLISECONDS = 10_000;
const MAXIMUM_STATE_BYTES = 65_536;
const MAXIMUM_PROCESS_OWNERS = 128;

const domainSchema = Schema.Literals(['recall', 'graph']);
export type BackgroundInferenceDomain = typeof domainSchema.Type;
const timestamp = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: Number.MAX_SAFE_INTEGER}));
const ownerSchema = Schema.Struct({
  processId: Schema.Int.check(Schema.isGreaterThan(0)),
  identityKind: Schema.Literals(['canonical', 'runtime']),
  startIdentity: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
});
const leaseSchema = Schema.Struct({
  owner: ownerSchema,
  expiresAt: timestamp,
  // Older v1 readers strip this optional tag but still conservatively block on the lease.
  purpose: Schema.optionalKey(Schema.Literals(['idle-execution'])),
  nativeFree: Schema.optionalKey(Schema.Literal(true)),
  spareCapacityStartedAt: Schema.optionalKey(timestamp),
});
export const backgroundBatchAuthoritySchema = Schema.Struct({
  home: Schema.String.check(Schema.isMaxLength(4096)),
  domain: domainSchema,
  owner: ownerSchema,
  capacityMode: Schema.optionalKey(Schema.Literal('spare-cpu-v2')),
});
export type BackgroundBatchAuthority = typeof backgroundBatchAuthoritySchema.Type;
export const CurrentBackgroundBatchAuthority = Context.Reference<BackgroundBatchAuthority | undefined>(
  '@threadnote/inference/background/CurrentBatchAuthority',
  {defaultValue: () => undefined},
);
export class BackgroundInferenceDeferred extends Schema.TaggedError<
  BackgroundInferenceDeferred,
  {readonly brand: unique symbol}
>()('BackgroundInferenceDeferred', {message: Schema.String}) {}
const executionDeferred = () =>
  BackgroundInferenceDeferred.make({message: 'Background execution authority is no longer eligible.'});
export const backgroundInferenceAdmissionStateSchema = Schema.Struct({
  version: Schema.Literals([1]),
  foreground: Schema.Array(leaseSchema).check(Schema.isMaxLength(128)),
  pending: Schema.Array(Schema.Struct({domain: domainSchema, requestedAt: timestamp, expiresAt: timestamp})).check(
    Schema.isMaxLength(2),
  ),
  active: Schema.optionalKey(Schema.Struct({...leaseSchema.fields, domain: domainSchema})),
  lastGranted: Schema.optionalKey(domainSchema),
  quietUntil: timestamp,
  foregroundBusySince: Schema.optionalKey(timestamp),
  spareCapacityNotBefore: Schema.optionalKey(timestamp),
});
export type BackgroundInferenceOwner = typeof ownerSchema.Type;
export type BackgroundInferenceAdmissionState = typeof backgroundInferenceAdmissionStateSchema.Type;
export type BackgroundInferenceDeferral =
  | 'cpu-busy'
  | 'cpu-unknown'
  | 'foreground'
  | 'foreground-quiet'
  | 'inference-active'
  | 'fair-turn'
  | 'identity-unavailable'
  | 'admission-unavailable'
  | 'batch-deadline';
export type BackgroundInferenceResult<A> =
  | {readonly state: 'completed'; readonly value: A}
  | {readonly state: 'deferred'; readonly reason: BackgroundInferenceDeferral};
export type CpuCapacity =
  | {readonly state: 'unknown'}
  | {readonly state: 'busy' | 'idle'; readonly utilization: number; readonly spareCpus: number};
export interface CpuCapacitySample extends SystemCpuTimes {
  readonly atMilliseconds: number;
}

export function classifyBackgroundCpuCapacity(
  before: CpuCapacitySample | undefined,
  after: CpuCapacitySample | undefined,
): CpuCapacity {
  if (
    !before ||
    !after ||
    before.logicalCpus !== after.logicalCpus ||
    !Number.isInteger(after.logicalCpus) ||
    after.logicalCpus < 1
  )
    return {state: 'unknown'};
  const elapsed = after.atMilliseconds - before.atMilliseconds;
  const total = after.totalMilliseconds - before.totalMilliseconds;
  const idle = after.idleMilliseconds - before.idleMilliseconds;
  if (
    !EffectArray.every([elapsed, total, idle], Number.isFinite) ||
    elapsed < SAMPLE_MINIMUM_MILLISECONDS ||
    elapsed > SAMPLE_MAXIMUM_MILLISECONDS ||
    total <= 0 ||
    idle < 0 ||
    idle > total
  )
    return {state: 'unknown'};
  const utilization = 1 - idle / total;
  const spareCpus = (idle / total) * after.logicalCpus;
  const minimumSpare = Math.min(BACKGROUND_INFERENCE_THREADS + 1, after.logicalCpus * 0.75);
  return {state: utilization <= 0.6 && spareCpus >= minimumSpare ? 'idle' : 'busy', utilization, spareCpus};
}

export const emptyBackgroundInferenceAdmission = (): BackgroundInferenceAdmissionState => ({
  version: 1,
  foreground: [],
  pending: [],
  quietUntil: 0,
});

const capacityCooldown = (
  state: BackgroundInferenceAdmissionState,
  removed: readonly {readonly spareCapacityStartedAt?: number}[],
  now: number,
) => {
  let until = state.spareCapacityNotBefore;
  for (const lease of removed) {
    if (lease.spareCapacityStartedAt === undefined) continue;
    const elapsed = Math.max(MINIMUM_CAPACITY_YIELD_MILLISECONDS, now - lease.spareCapacityStartedAt);
    until = Math.max(until ?? 0, now + Math.min(BACKGROUND_INFERENCE_BATCH_MILLISECONDS, elapsed));
  }
  return until;
};

/** Expiration alone never proves a computing or foreground owner dead. */
export function pruneBackgroundInferenceOwners(
  state: BackgroundInferenceAdmissionState,
  deadTokens: ReadonlySet<string>,
  now: number,
): BackgroundInferenceAdmissionState {
  const {active, ...rest} = state;
  const cooldown = capacityCooldown(
    state,
    EffectArray.filter([...state.foreground, ...(active ? [active] : [])], lease => deadTokens.has(lease.owner.token)),
    now,
  );
  return {
    ...rest,
    foreground: EffectArray.filter(state.foreground, lease => !deadTokens.has(lease.owner.token)),
    // Tickets grant no work authority; dropping an expired ticket cannot lose domain demand.
    pending: EffectArray.filter(state.pending, ticket => ticket.expiresAt > now),
    ...(active && !deadTokens.has(active.owner.token) ? {active} : {}),
    ...(cooldown === undefined ? {} : {spareCapacityNotBefore: cooldown}),
  };
}

export function registerBackgroundForegroundLease(
  state: BackgroundInferenceAdmissionState,
  owner: BackgroundInferenceOwner,
  now: number,
  nativeFree = false,
): BackgroundInferenceAdmissionState {
  if (state.foreground.length >= 128) throw new Error('Foreground inference admission capacity unavailable.');
  return {
    ...state,
    foreground: [
      ...state.foreground,
      {owner, expiresAt: now + LEASE_MILLISECONDS, ...(nativeFree ? {nativeFree: true as const} : {})},
    ],
  };
}

/** The atomic grant is the start of one bounded batch, before any domain claim. */
export function planBackgroundInferenceBatch(
  state: BackgroundInferenceAdmissionState,
  domain: BackgroundInferenceDomain,
  owner: BackgroundInferenceOwner,
  now: number,
  capacity: CpuCapacity,
): {
  readonly state: BackgroundInferenceAdmissionState;
  readonly admitted: boolean;
  readonly reason?: BackgroundInferenceDeferral;
} {
  const old = EffectArray.findFirst(state.pending, ticket => ticket.domain === domain);
  const pending = [
    ...EffectArray.filter(state.pending, ticket => ticket.domain !== domain),
    ...(owner.startIdentity && capacity.state === 'idle'
      ? [{domain, requestedAt: Option.isSome(old) ? old.value.requestedAt : now, expiresAt: now + LEASE_MILLISECONDS}]
      : []),
  ];
  const contended =
    EffectArray.some(state.foreground, lease => lease.purpose !== 'idle-execution') || state.quietUntil > now;
  const {foregroundBusySince, ...withoutAge} = state;
  const since = contended ? (foregroundBusySince ?? now) : undefined;
  const next = {...withoutAge, pending, ...(since === undefined ? {} : {foregroundBusySince: since})};
  const deny = (reason: BackgroundInferenceDeferral) => ({state: next, admitted: false, reason});
  if (!owner.startIdentity) return deny('identity-unavailable');
  if (EffectArray.some(state.foreground, lease => lease.purpose === 'idle-execution')) return deny('foreground');
  // Unknown/inference-bearing owners never opt into overlap, even after aging.
  if (
    EffectArray.some(
      state.foreground,
      lease => lease.nativeFree !== true || !lease.owner.startIdentity || lease.expiresAt <= now,
    )
  )
    return deny('foreground');
  const spareCapacity = since !== undefined && now >= since + BACKGROUND_INFERENCE_FOREGROUND_AGE_MILLISECONDS;
  if (contended && !spareCapacity) return deny(state.foreground.length ? 'foreground' : 'foreground-quiet');
  if (state.active) return deny('inference-active');
  if (capacity.state !== 'idle') return deny(capacity.state === 'busy' ? 'cpu-busy' : 'cpu-unknown');
  if (spareCapacity && capacity.spareCpus < BACKGROUND_INFERENCE_THREADS + 1) return deny('cpu-busy');
  if ((state.spareCapacityNotBefore ?? 0) > now) return deny('foreground-quiet');
  if (state.foreground.length >= 128) return deny('admission-unavailable');
  const ordered = [...pending].sort(
    (left, right) =>
      left.requestedAt - right.requestedAt || (left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0),
  );
  const other = EffectArray.findFirst(ordered, ticket => ticket.domain !== state.lastGranted);
  const selected = Option.isSome(other) ? other.value.domain : ordered[0].domain;
  if (selected !== domain) return deny('fair-turn');
  return {
    state: {
      ...next,
      pending: EffectArray.filter(pending, ticket => ticket.domain !== domain),
      active: {
        domain,
        owner,
        expiresAt: now + LEASE_MILLISECONDS,
        ...(spareCapacity ? {spareCapacityStartedAt: now} : {}),
      },
      lastGranted: domain,
    },
    admitted: true,
  };
}

export function releaseBackgroundInferenceLease(
  state: BackgroundInferenceAdmissionState,
  token: string,
  now: number,
): BackgroundInferenceAdmissionState {
  const foreground = EffectArray.filter(state.foreground, lease => lease.owner.token !== token);
  const {active, ...rest} = state;
  const cooldown = capacityCooldown(
    state,
    EffectArray.filter([...state.foreground, ...(active ? [active] : [])], lease => lease.owner.token === token),
    now,
  );
  return {
    ...rest,
    foreground,
    quietUntil: EffectArray.some(
      state.foreground,
      lease => lease.owner.token === token && lease.purpose !== 'idle-execution',
    )
      ? Math.max(state.quietUntil, now + BACKGROUND_INFERENCE_QUIET_MILLISECONDS)
      : state.quietUntil,
    ...(active?.owner.token === token ? {} : active ? {active} : {}),
    ...(cooldown === undefined ? {} : {spareCapacityNotBefore: cooldown}),
  };
}

export class BackgroundInferenceAdmissionUnavailable extends Schema.TaggedError<
  BackgroundInferenceAdmissionUnavailable,
  {readonly brand: unique symbol}
>()('BackgroundInferenceAdmissionUnavailable', {message: Schema.String}) {}

export interface BackgroundInferenceAdmissionShape {
  readonly withForeground: <A, E, R>(
    home: string,
    program: Effect.Effect<A, E, R>,
    options?: {readonly existingHomeOnly?: boolean; readonly nativeFree?: boolean},
  ) => Effect.Effect<A, E | BackgroundInferenceAdmissionUnavailable, R>;
  readonly withExecution: <A, E, R>(
    authority: BackgroundBatchAuthority,
    program: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | BackgroundInferenceDeferred | BackgroundInferenceAdmissionUnavailable, R>;
  readonly runBatch: <A, E, R>(
    home: string,
    domain: BackgroundInferenceDomain,
    program: Effect.Effect<A, E, R>,
  ) => Effect.Effect<BackgroundInferenceResult<A>, E | BackgroundInferenceAdmissionUnavailable, R>;
}

const unavailable = () =>
  BackgroundInferenceAdmissionUnavailable.make({
    message: 'Background inference admission is unavailable; preserve queued work.',
  });

/** Metadata critical sections never contain inference, transport retries, or waits for idle. */
export const makeBackgroundInferenceAdmission = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const crypto = yield* Crypto.Crypto;
  const canonical = yield* (system.canonicalProcessStartIdentity?.(system.processId) ?? Effect.void).pipe(
    Effect.timeoutOption('1 second'),
    Effect.map(Option.getOrUndefined),
  );
  const startIdentity =
    canonical ??
    (yield* system
      .processStartIdentity(system.processId)
      .pipe(Effect.timeoutOption('1 second'), Effect.map(Option.getOrUndefined)));
  const identityKind = canonical === undefined ? ('runtime' as const) : ('canonical' as const);
  let ownerReservations = 0;
  const owner = Effect.suspend(() => {
    // Reserve before the first asynchronous boundary, including while acquiring
    // or retaining an uncertain lease. Concurrent failures cannot exceed this bound.
    if (ownerReservations >= MAXIMUM_PROCESS_OWNERS) return unavailable();
    ownerReservations++;
    return crypto.randomUUIDv4().pipe(
      Effect.mapBoth({
        onSuccess: token => ({
          processId: system.processId,
          identityKind,
          ...(startIdentity === undefined ? {} : {startIdentity}),
          token,
        }),
        onFailure: unavailable,
      }),
      Effect.onError(() => Effect.sync(() => ownerReservations--)),
    );
  }).pipe(Effect.uninterruptible);
  const locations = (home: string) => {
    const directory = path.join(home, 'locks', 'inference-idle-v1');
    return {
      directory,
      guard: path.join(directory, 'guard.lock'),
      state: path.join(directory, 'state.json'),
      initialized: path.join(directory, 'initialized'),
    };
  };
  const readControl = (filename: string, maximum: number) =>
    Effect.gen(function* () {
      const stat = yield* fs.stat(filename);
      if (
        stat.type !== 'File' ||
        Number(stat.size) > maximum ||
        Option.isSome(yield* fs.readLink(filename).pipe(Effect.option))
      )
        return yield* unavailable();
      return yield* fs.readFileString(filename);
    });
  const readState = (location: ReturnType<typeof locations>, initialize: boolean) =>
    Effect.gen(function* () {
      const initialized = yield* fs.exists(location.initialized);
      if (initialized && (yield* readControl(location.initialized, 16)) !== '1\n') return yield* unavailable();
      if (!(yield* fs.exists(location.state))) {
        if (initialized || !initialize) return yield* unavailable();
        return emptyBackgroundInferenceAdmission();
      }
      const text = yield* readControl(location.state, MAXIMUM_STATE_BYTES);
      const json: unknown = yield* Effect.try({
        try: () => JSON.parse(text),
        catch: unavailable,
      });
      const state = yield* Schema.decodeUnknownEffect(backgroundInferenceAdmissionStateSchema)(json);
      if (
        new Set(EffectArray.map(state.foreground, lease => lease.owner.token)).size !== state.foreground.length ||
        new Set(EffectArray.map(state.pending, ticket => ticket.domain)).size !== state.pending.length ||
        (!initialized && state.active)
      )
        return yield* unavailable();
      return state;
    }).pipe(Effect.mapError(unavailable));
  const writeState = (location: ReturnType<typeof locations>, state: BackgroundInferenceAdmissionState) =>
    Effect.gen(function* () {
      const text = JSON.stringify(state) + '\n';
      if (new TextEncoder().encode(text).byteLength > MAXIMUM_STATE_BYTES) return yield* unavailable();
      const temporary = path.join(location.directory, (yield* crypto.randomUUIDv4()) + '.tmp');
      yield* Effect.acquireUseRelease(
        fs.writeFileString(temporary, text, {mode: 0o600, flag: 'wx'}).pipe(Effect.as(temporary)),
        temporary => syncWritableFile(fs, temporary).pipe(Effect.andThen(fs.rename(temporary, location.state))),
        temporary => fs.remove(temporary, {force: true}).pipe(Effect.ignore),
      );
      if (!(yield* fs.exists(location.initialized))) {
        yield* fs.writeFileString(location.initialized, '1\n', {mode: 0o600, flag: 'wx'});
        yield* syncWritableFile(fs, location.initialized);
      }
      yield* syncDirectoryBestEffort(fs, location.directory);
    });
  const retired = new Map<string, string>();
  const cleanup = yield* Queue.sliding<void>(1);
  const transact = <A>(
    home: string,
    update: (
      state: BackgroundInferenceAdmissionState,
      now: number,
    ) => {readonly state: BackgroundInferenceAdmissionState; readonly value: A},
    initialize = false,
    createHome = initialize,
  ) =>
    Effect.gen(function* () {
      const location = locations(home);
      if (initialize) {
        if (createHome) yield* fs.makeDirectory(home, {recursive: true, mode: 0o700});
        for (const directory of [path.join(home, 'locks'), location.directory]) {
          yield* fs
            .makeDirectory(directory, {mode: 0o700})
            .pipe(
              Effect.catchTag('PlatformError', error =>
                error.reason._tag === 'AlreadyExists' ? Effect.void : Effect.fail(error),
              ),
            );
        }
      }
      return yield* withExclusiveFileLock(
        fs,
        location.guard,
        {
          createParentDirectory: false,
          retryIntervalMilliseconds: 10,
          staleAfterMilliseconds: 5_000,
          waitTimeoutMilliseconds: 1_000,
          useCanonicalProcessStartIdentity: true,
        },
        Effect.gen(function* () {
          let state = yield* readState(location, initialize);
          const now = yield* Clock.currentTimeMillis;
          const retiring: string[] = [];
          for (const [token, retiredHome] of retired) {
            if (retiredHome === home) {
              state = releaseBackgroundInferenceLease(state, token, now);
              retiring.push(token);
            }
          }
          const dead = new Set(
            EffectArray.map(
              EffectArray.filter(state.foreground, lease => !system.isProcessRunning(lease.owner.processId)),
              lease => lease.owner.token,
            ),
          );
          if (state.active && !system.isProcessRunning(state.active.owner.processId))
            dead.add(state.active.owner.token);
          const result = yield* Effect.try({
            try: () => update(pruneBackgroundInferenceOwners(state, dead, now), now),
            catch: unavailable,
          });
          yield* writeState(location, result.state);
          // Only tokens in this committed snapshot are proven released. Later
          // releases retain their reservations for the next transaction.
          for (const token of retiring) if (retired.delete(token)) ownerReservations--;
          return result.value;
        }),
      ).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(Path.Path, path),
        Effect.provideService(SystemInfo, system),
      );
    }).pipe(Effect.mapError(unavailable));
  const release = (home: string, token: string) =>
    Effect.sync(() => retired.set(token, home)).pipe(
      Effect.andThen(
        transact(home, (state, now) => ({state: releaseBackgroundInferenceLease(state, token, now), value: undefined})),
      ),
      Effect.onError(() => Queue.offer(cleanup, undefined)),
      Effect.ignore,
    );
  // Sleep only while failed owned cleanup remains. Idle services perform no
  // periodic I/O, and failed metadata cleanup never holds up foreground work.
  yield* Effect.gen(function* () {
    while (true) {
      yield* Queue.take(cleanup);
      let delay = 250;
      while (retired.size > 0) {
        yield* Effect.sleep(delay);
        for (const home of new Set(retired.values())) {
          yield* transact(home, state => ({state, value: undefined})).pipe(Effect.ignore);
        }
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }).pipe(Effect.forkScoped);
  const heartbeat = (home: string, token: string) =>
    Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(HEARTBEAT_MILLISECONDS);
        yield* transact(home, (state, now) => ({
          state: {
            ...state,
            foreground: EffectArray.map(state.foreground, lease =>
              lease.owner.token === token ? {...lease, expiresAt: now + LEASE_MILLISECONDS} : lease,
            ),
            ...(state.active?.owner.token === token
              ? {active: {...state.active, expiresAt: now + LEASE_MILLISECONDS}}
              : {}),
          },
          value: undefined,
        })).pipe(Effect.ignore);
      }
    });
  let previousCpu: CpuCapacitySample | undefined;
  let nextCpu: CpuCapacitySample | undefined;
  const observeCpuSample = Effect.gen(function* () {
    const observation = system.cpuTimes
      ? system.cpuTimes.pipe(Effect.map(Option.fromUndefinedOr))
      : Effect.succeed(Option.none<SystemCpuTimes>());
    const counters = yield* observation.pipe(
      Effect.catchCauseIf(
        cause => !Cause.hasInterrupts(cause),
        () => Effect.succeed(Option.none<SystemCpuTimes>()),
      ),
    );
    const now = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;
    return Option.isSome(counters) ? {...counters.value, atMilliseconds: now} : undefined;
  });
  const sampleCpu = Effect.gen(function* () {
    const current = yield* observeCpuSample;
    const now = current?.atMilliseconds ?? Number(yield* Clock.monotonicTimeNanos) / 1_000_000;
    // Keep two staggered anchors. Every decision still uses a fresh OS sample
    // over >=500ms, without imposing a new500ms pause after each short unit.
    if (nextCpu && now - nextCpu.atMilliseconds >= SAMPLE_MINIMUM_MILLISECONDS) {
      previousCpu = nextCpu;
      nextCpu = undefined;
    }
    const capacity = classifyBackgroundCpuCapacity(previousCpu, current);
    if (
      !previousCpu ||
      !current ||
      (capacity.state === 'unknown' && now - previousCpu.atMilliseconds >= SAMPLE_MINIMUM_MILLISECONDS) ||
      now - previousCpu.atMilliseconds > SAMPLE_MAXIMUM_MILLISECONDS ||
      previousCpu.logicalCpus !== current.logicalCpus ||
      current.totalMilliseconds < previousCpu.totalMilliseconds ||
      current.idleMilliseconds < previousCpu.idleMilliseconds
    ) {
      previousCpu = current;
      nextCpu = undefined;
    } else if (!nextCpu && now - previousCpu.atMilliseconds >= SAMPLE_MINIMUM_MILLISECONDS) nextCpu = current;
    return capacity;
  });
  const deadOwners = (home: string) =>
    Effect.gen(function* () {
      const state = yield* readState(locations(home), false);
      const now = yield* Clock.currentTimeMillis;
      const leases = [...state.foreground, ...(state.active ? [state.active] : [])];
      const observed = yield* Effect.forEach(
        leases,
        lease =>
          Effect.gen(function* () {
            if (!system.isProcessRunning(lease.owner.processId)) return lease.owner.token;
            if (lease.expiresAt > now || !lease.owner.startIdentity) return undefined;
            const identity =
              lease.owner.identityKind === 'canonical'
                ? system.canonicalProcessStartIdentity?.(lease.owner.processId)
                : system.processStartIdentity(lease.owner.processId);
            if (!identity) return undefined;
            const current = yield* identity.pipe(Effect.timeoutOption('100 millis'), Effect.map(Option.getOrUndefined));
            return current !== undefined && current !== lease.owner.startIdentity ? lease.owner.token : undefined;
          }),
        {concurrency: 4},
      );
      return new Set(EffectArray.filter(observed, (token): token is string => token !== undefined));
    });
  const service: BackgroundInferenceAdmissionShape = {
    withExecution: (authority, program) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          if (!path.isAbsolute(authority.home)) return yield* executionDeferred();
          const parent = authority.owner;
          if (!parent.startIdentity || !system.isProcessRunning(parent.processId)) return yield* executionDeferred();
          const capacityMode = authority.capacityMode === 'spare-cpu-v2';
          if (capacityMode) {
            const before = yield* observeCpuSample;
            if (!before) return yield* executionDeferred();
            yield* Effect.sleep(SAMPLE_MINIMUM_MILLISECONDS);
            const capacity = classifyBackgroundCpuCapacity(before, yield* observeCpuSample);
            if (capacity.state !== 'idle' || capacity.spareCpus < BACKGROUND_INFERENCE_THREADS + 1)
              return yield* executionDeferred();
          }
          const probe =
            parent.identityKind === 'canonical'
              ? system.canonicalProcessStartIdentity?.(parent.processId)
              : system.processStartIdentity(parent.processId);
          if (!probe) return yield* executionDeferred();
          const identity = yield* probe.pipe(Effect.timeoutOption('100 millis'), Effect.map(Option.getOrUndefined));
          if (identity !== parent.startIdentity) return yield* executionDeferred();
          const lease = yield* owner;
          if (!lease.startIdentity) {
            ownerReservations--;
            return yield* executionDeferred();
          }
          const granted = yield* transact(authority.home, (state, now) => {
            const active = state.active;
            const admitted =
              active?.domain === authority.domain &&
              active.owner.token === parent.token &&
              active.owner.processId === parent.processId &&
              active.owner.identityKind === parent.identityKind &&
              active.owner.startIdentity === parent.startIdentity &&
              system.isProcessRunning(parent.processId) &&
              (active.spareCapacityStartedAt !== undefined) === capacityMode &&
              state.foreground.length < 128 &&
              (capacityMode
                ? active.spareCapacityStartedAt! <= now &&
                  EffectArray.every(
                    state.foreground,
                    lease =>
                      lease.nativeFree === true &&
                      !!lease.owner.startIdentity &&
                      lease.expiresAt > now &&
                      lease.purpose !== 'idle-execution',
                  )
                : state.foreground.length === 0);
            return admitted
              ? {
                  state: {
                    ...state,
                    foreground: [
                      ...state.foreground,
                      {
                        owner: lease,
                        expiresAt: now + LEASE_MILLISECONDS,
                        purpose: 'idle-execution' as const,
                        ...(capacityMode ? {spareCapacityStartedAt: now} : {}),
                      },
                    ],
                  },
                  value: true,
                }
              : {state, value: false};
          }).pipe(Effect.onError(() => release(authority.home, lease.token)));
          if (!granted) {
            ownerReservations--;
            return yield* executionDeferred();
          }
          return lease;
        }),
        lease => Effect.scoped(heartbeat(authority.home, lease.token).pipe(Effect.forkScoped, Effect.andThen(program))),
        lease => release(authority.home, lease.token),
      ),
    withForeground: (home, program, options) =>
      Effect.acquireUseRelease(
        owner.pipe(
          Effect.flatMap(lease =>
            transact(
              home,
              (state, now) => ({
                state: registerBackgroundForegroundLease(state, lease, now, options?.nativeFree),
                value: lease,
              }),
              true,
              options?.existingHomeOnly !== true,
            ).pipe(Effect.onError(() => release(home, lease.token))),
          ),
        ),
        lease => Effect.scoped(heartbeat(home, lease.token).pipe(Effect.forkScoped, Effect.andThen(program))),
        lease => release(home, lease.token),
      ),
    runBatch: <A, E, R>(
      home: string,
      domain: BackgroundInferenceDomain,
      program: Effect.Effect<A, E, R>,
    ): Effect.Effect<BackgroundInferenceResult<A>, E | BackgroundInferenceAdmissionUnavailable, R> =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          if (!(yield* fs.exists(locations(home).initialized).pipe(Effect.mapError(unavailable)))) {
            yield* transact(home, state => ({state, value: undefined}), true, false);
          }
          const dead = yield* deadOwners(home);
          const capacity = yield* sampleCpu;
          const lease = yield* owner;
          return yield* transact(home, (state, now) => {
            const next = planBackgroundInferenceBatch(
              pruneBackgroundInferenceOwners(state, dead, now),
              domain,
              lease,
              now,
              capacity,
            );
            return {state: next.state, value: {lease, ...next}};
          }).pipe(Effect.onError(() => release(home, lease.token)));
        }).pipe(
          Effect.catchCauseIf(
            cause => !Cause.hasInterrupts(cause),
            () =>
              Effect.succeed({admitted: false as const, reason: 'admission-unavailable' as const, lease: undefined}),
          ),
        ),
        (admission): Effect.Effect<BackgroundInferenceResult<A>, E, R> =>
          admission.admitted
            ? Effect.scoped(
                heartbeat(home, admission.lease.token).pipe(
                  Effect.forkScoped,
                  Effect.andThen(
                    program.pipe(
                      Effect.provideService(CurrentBackgroundBatchAuthority, {
                        home,
                        domain,
                        owner: admission.lease,
                        ...(admission.state.active?.spareCapacityStartedAt === undefined
                          ? {}
                          : {capacityMode: 'spare-cpu-v2' as const}),
                      }),
                    ),
                  ),
                  Effect.timeoutOption(BACKGROUND_INFERENCE_BATCH_MILLISECONDS),
                  Effect.map(result =>
                    Option.isSome(result)
                      ? {state: 'completed' as const, value: result.value}
                      : {state: 'deferred' as const, reason: 'batch-deadline' as const},
                  ),
                ),
              )
            : Effect.succeed({state: 'deferred' as const, reason: admission.reason ?? 'admission-unavailable'}),
        admission =>
          admission.lease === undefined
            ? Effect.void
            : admission.admitted
              ? release(home, admission.lease.token)
              : Effect.sync(() => ownerReservations--),
      ),
  };
  return service;
});

export class BackgroundInferenceAdmission extends Context.Service<
  BackgroundInferenceAdmission,
  BackgroundInferenceAdmissionShape
>()('@threadnote/inference/background/admission/BackgroundInferenceAdmission') {
  static readonly layer = Layer.effect(this, makeBackgroundInferenceAdmission);
}
