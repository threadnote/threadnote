import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Clock, Crypto, Effect, FileSystem, Path, PlatformError, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

type Config = Pick<RuntimeConfig, 'account' | 'agentContextHome'>;
const HOUR = 3_600_000;
const LEASE = 120_000;
const RETRY = 300_000;
const CAPACITY = 128;
const IDENTITY_CAPACITY = 16;
/** Private owner directory for bounded live metadata observation; this does not create or read queue state. */
export const draftQueueObservationDirectory = Effect.fn('draftQueue.observationDirectory')(function* (config: Config) {
  const home = yield* (yield* FileSystem.FileSystem).realPath(config.agentContextHome);
  return (yield* Path.Path).join(home, 'threadnote', 'draft-queue', 'v1', sha256HexSync(config.account));
});
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const millis = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const workSchema = Schema.Struct({
  identity: hash,
  targetKey: hash,
  targetUri: text,
  materialRevision: hash,
  backend: Schema.Literals(['local-ai', 'effect-ai']),
  modelId: text,
  providerIdentity: hash,
  purpose: Schema.Literals(['automatic', 'topic']),
  foreground: Schema.Boolean,
  expectedContentHash: hash,
  policyRevision: Schema.optionalKey(hash),
  regenerate: Schema.optionalKey(Schema.Boolean),
  dedupeIdentity: Schema.optionalKey(hash),
  sourceCwd: Schema.optionalKey(text),
  caseId: Schema.optionalKey(text),
});
export type DraftQueueWork = typeof workSchema.Type;
const claimSchema = Schema.Struct({token: text, work: workSchema, leaseUntil: millis});
export type DraftQueueClaim = typeof claimSchema.Type;
const identitySchema = Schema.Struct({
  identity: hash,
  state: Schema.Literals(['completed', 'failed', 'waiting']),
  nextEligibleAt: Schema.optionalKey(millis),
  retryCount: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isBetween({minimum: 0, maximum: 1}))),
});
const checkpointSchema = Schema.Struct({
  targetKey: hash,
  targetUri: text,
  materialRevision: hash,
  decision: Schema.optionalKey(Schema.Literals(['reject', 'defer'])),
  decisionMaterialRevision: Schema.optionalKey(hash),
  identity: Schema.optionalKey(hash),
  state: Schema.optionalKey(Schema.Literals(['completed', 'failed', 'waiting'])),
  reason: Schema.optionalKey(text),
  nextEligibleAt: Schema.optionalKey(millis),
  identityHistory: Schema.optionalKey(Schema.Array(identitySchema).check(Schema.isMaxLength(IDENTITY_CAPACITY))),
  retryCount: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isBetween({minimum: 0, maximum: 1}))),
});
export type DraftQueueTarget = typeof checkpointSchema.Type;
const grantSchema = Schema.Struct({
  providerIdentity: hash,
  unitsPerHour: Schema.Number.check(Schema.isInt(), Schema.isBetween({minimum: 1, maximum: 4})),
});
const policySchema = Schema.Struct({
  paused: Schema.Boolean,
  provider: Schema.Literals(['local-ai', 'effect-ai']),
  remoteGrant: Schema.optionalKey(grantSchema),
});
type Policy = typeof policySchema.Type;
const reservationSchema = Schema.Struct({at: millis, identity: hash, providerIdentity: hash, token: text});
const activeSchema = Schema.Struct({
  ...claimSchema.fields,
  dispatched: Schema.Boolean,
  published: Schema.optionalKey(Schema.Literal(true)),
  policyRevision: hash,
});
const stateSchema = Schema.Struct({
  version: Schema.Literal(1),
  policy: policySchema,
  queued: Schema.Array(workSchema).check(Schema.isMaxLength(CAPACITY)),
  active: Schema.optionalKey(activeSchema),
  backgroundReservations: Schema.Array(reservationSchema).check(Schema.isMaxLength(4)),
  pending: Schema.Array(checkpointSchema).check(Schema.isMaxLength(2)),
  discoveryCursor: Schema.optionalKey(text),
});
type State = {-readonly [K in keyof typeof stateSchema.Type]: (typeof stateSchema.Type)[K]};
export class DraftQueueError extends Schema.TaggedError<DraftQueueError, {readonly brand: unique symbol}>()(
  'DraftQueueError',
  {
    reason: Schema.Literals(['storage', 'invalid-input', 'stale-claim']),
    message: Schema.String,
  },
) {}
const invalid = () => DraftQueueError.make({reason: 'invalid-input', message: 'Invalid private draft queue input.'});
const stale = () =>
  DraftQueueError.make({reason: 'stale-claim', message: 'The draft queue lease is no longer current.'});
const check = <A>(schema: Schema.ConstraintDecoder<A, never>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, {onExcessProperty: 'error'}).pipe(Effect.mapError(invalid));

interface Transaction {
  state: State;
  now: number;
  read: (key: string) => Effect.Effect<DraftQueueTarget | undefined, unknown>;
  put: (checkpoint: DraftQueueTarget) => void;
}

// Every state/checkpoint change has a replayable write-ahead record. In particular a
// crash between the quota reservation and checkpoint publication cannot refund use.
function transaction<A, E, R>(config: Config, use: (tx: Transaction) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(config.agentContextHome);
    let root = home;
    for (const segment of ['threadnote', 'draft-queue', 'v1', sha256HexSync(config.account)]) {
      root = path.join(root, segment);
      if (!(yield* fs.exists(root)))
        yield* fs.makeDirectory(root, {mode: 0o700}).pipe(
          Effect.catchIf(
            error => error instanceof PlatformError.PlatformError && error.reason._tag === 'AlreadyExists',
            () => Effect.void,
          ),
        );
      if ((yield* fs.stat(root)).type !== 'Directory' || (yield* fs.readLink(root).pipe(Effect.option))._tag === 'Some')
        return yield* invalid();
      yield* fs.chmod(root, 0o700);
    }
    const statePath = path.join(root, 'queue.json');
    const targetPath = (key: string) => path.join(root, `target-${key}.json`);
    const read = <A>(file: string, schema: Schema.ConstraintDecoder<A, never>) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(file))) return undefined;
        if ((yield* fs.readLink(file).pipe(Effect.option))._tag === 'Some') return yield* invalid();
        const info = yield* fs.stat(file);
        if (info.type !== 'File' || Number(info.size) > 10_000_000) return yield* invalid();
        const json = yield* fs.readFileString(file);
        const value: unknown = yield* Effect.try({try: () => JSON.parse(json), catch: invalid});
        return yield* check(schema, value);
      });
    const write = (file: string, value: unknown) =>
      Effect.gen(function* () {
        const temporary = `${file}.${yield* (yield* Crypto.Crypto).randomUUIDv4()}.tmp`;
        yield* Effect.gen(function* () {
          yield* fs.writeFileString(temporary, `${JSON.stringify(value)}\n`, {flag: 'wx', mode: 0o600});
          yield* syncWritableFile(fs, temporary);
          yield* fs.rename(temporary, file);
          yield* syncDirectoryBestEffort(fs, root);
        }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
      });
    return yield* withExclusiveFileLock(
      fs,
      path.join(root, 'queue.lock'),
      {
        retryIntervalMilliseconds: 10,
        staleAfterMilliseconds: 30_000,
        waitTimeoutMilliseconds: 5_000,
        useCanonicalProcessStartIdentity: true,
      },
      Effect.uninterruptible(
        Effect.gen(function* () {
          const saved = yield* read(statePath, stateSchema);
          const original = saved === undefined ? undefined : JSON.stringify(saved);
          const state: State = saved ?? {
            version: 1,
            policy: {paused: false, provider: 'local-ai'},
            queued: [],
            backgroundReservations: [],
            pending: [],
          };
          if (
            new Set(EffectArray.map(state.queued, w => w.targetKey)).size !== state.queued.length ||
            new Set(EffectArray.map(state.backgroundReservations, r => r.token)).size !==
              state.backgroundReservations.length ||
            new Set(EffectArray.map(state.pending, cp => cp.targetKey)).size !== state.pending.length ||
            (state.active?.published && !state.active.dispatched)
          )
            return yield* invalid();
          for (const cp of state.pending) yield* write(targetPath(cp.targetKey), cp);
          state.pending = [];
          const staged = new Map<string, DraftQueueTarget>();
          const tx: Transaction = {
            state,
            now: yield* Clock.currentTimeMillis,
            read: key => (staged.has(key) ? Effect.succeed(staged.get(key)) : read(targetPath(key), checkpointSchema)),
            put: cp => {
              staged.set(cp.targetKey, cp);
            },
          };
          state.backgroundReservations = EffectArray.filter(state.backgroundReservations, r => r.at > tx.now - HOUR);
          yield* recover(tx);
          const result = yield* use(tx);
          state.pending = [...staged.values()];
          // Read-side fences still recover under the lock. Unchanged reads need
          // no publication; initialization, recovery and checkpoint WAL still do.
          if (staged.size === 0 && original === JSON.stringify(state)) return result;
          yield* write(statePath, state);
          if (
            new Set(EffectArray.map(state.queued, w => w.targetKey)).size !== state.queued.length ||
            new Set(EffectArray.map(state.backgroundReservations, r => r.token)).size !==
              state.backgroundReservations.length ||
            new Set(EffectArray.map(state.pending, cp => cp.targetKey)).size !== state.pending.length
          )
            return yield* invalid();
          for (const cp of state.pending) yield* write(targetPath(cp.targetKey), cp);
          if (state.pending.length) {
            state.pending = [];
            yield* write(statePath, state);
          }
          return result;
        }),
      ),
    );
  }).pipe(
    Effect.mapError(error =>
      Schema.is(DraftQueueError)(error)
        ? error
        : DraftQueueError.make({
            reason: 'storage',
            message: 'The private draft queue is unavailable; its existing state has been preserved.',
          }),
    ),
  );
}

const suppressed = (cp: DraftQueueTarget | undefined, work: DraftQueueWork) =>
  cp?.decision !== undefined && (cp.decisionMaterialRevision ?? cp.materialRevision) === work.materialRevision;
const current = (cp: DraftQueueTarget | undefined, work: DraftQueueWork) =>
  cp?.identity === work.identity && cp.materialRevision === work.materialRevision;
function checkpoint(work: DraftQueueWork, old?: DraftQueueTarget): DraftQueueTarget {
  const remembered =
    old?.materialRevision === work.materialRevision
      ? EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(old.identityHistory), __effectArrayReceiver =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(__effectArrayReceiver, entry => entry.identity === work.identity),
            ),
          ),
        )
      : undefined;
  return {
    targetKey: work.targetKey,
    targetUri: work.targetUri,
    materialRevision: work.materialRevision,
    identity: work.identity,
    retryCount: current(old, work) ? (old?.retryCount ?? 0) : (remembered?.retryCount ?? 0),
    ...(remembered?.state === 'waiting' ? {state: 'waiting' as const, nextEligibleAt: remembered.nextEligibleAt} : {}),
    ...(old?.materialRevision === work.materialRevision && old.identityHistory
      ? {identityHistory: old.identityHistory}
      : {}),
    ...(old?.decision
      ? {decision: old.decision, decisionMaterialRevision: old.decisionMaterialRevision ?? old.materialRevision}
      : {}),
  };
}
// Keep terminal identities and retry fences for the current material independently of the latest
// provider choice. At capacity new autonomous work waits instead of evicting proof.
function terminalState(cp: DraftQueueTarget | undefined, work: DraftQueueWork) {
  if (cp?.materialRevision !== work.materialRevision) return undefined;
  if (current(cp, work) && (cp.state === 'completed' || cp.state === 'failed')) return cp.state;
  const state = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(cp.identityHistory), __effectArrayReceiver =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(__effectArrayReceiver, entry => entry.identity === work.identity),
      ),
    ),
  )?.state;
  return state === 'waiting' ? undefined : state;
}
function identityCheckpoint(
  cp: DraftQueueTarget | undefined,
  work: DraftQueueWork,
  state: 'completed' | 'failed' | 'waiting',
  nextEligibleAt?: number,
) {
  if (!cp || cp.materialRevision !== work.materialRevision) return cp;
  const history = [...(cp.identityHistory ?? [])];
  for (const identity of new Set([
    work.identity,
    ...(state === 'completed' && work.dedupeIdentity ? [work.dedupeIdentity] : []),
  ])) {
    const index = EffectOption.getOrElse(
      EffectArray.findFirstIndex(history, entry => entry.identity === identity),
      () => -1,
    );
    const entry = {
      identity,
      state,
      retryCount: cp.retryCount ?? 0,
      ...(nextEligibleAt === undefined ? {} : {nextEligibleAt}),
    };
    // A later explicit regeneration failure cannot erase proof of the base success.
    if (index >= 0 && history[index].state !== 'completed') history[index] = entry;
    else if (index < 0 && history.length < IDENTITY_CAPACITY) history.push(entry);
  }
  return {...cp, identityHistory: history};
}
function historyAtCapacity(cp: DraftQueueTarget | undefined, work: DraftQueueWork) {
  return (
    cp?.materialRevision === work.materialRevision &&
    (cp.identityHistory?.length ?? 0) >= IDENTITY_CAPACITY &&
    !EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(cp.identityHistory), __effectArrayReceiver =>
        EffectArray.some(__effectArrayReceiver, entry => entry.identity === work.identity),
      ),
    ) &&
    !(work.foreground && work.regenerate === true)
  );
}
function refund(tx: Transaction, token: string) {
  tx.state.backgroundReservations = EffectArray.filter(tx.state.backgroundReservations, r => r.token !== token);
}
function recover(tx: Transaction) {
  return Effect.gen(function* () {
    const active = tx.state.active;
    if (!active || active.leaseUntil > tx.now) return;
    const cp = yield* tx.read(active.work.targetKey);
    if (!active.dispatched) refund(tx, active.token);
    if (active.dispatched) {
      const state = active.published ? 'completed' : 'failed';
      const recorded = identityCheckpoint(cp, active.work, state);
      if (recorded)
        tx.put(
          current(cp, active.work)
            ? {
                ...recorded,
                state,
                ...(active.published
                  ? {reason: undefined, nextEligibleAt: undefined}
                  : {reason: 'dispatch-outcome-unknown'}),
              }
            : recorded,
        );
    } else if (current(cp, active.work) && !suppressed(cp, active.work)) {
      if (!EffectArray.some(tx.state.queued, w => w.targetKey === active.work.targetKey)) {
        if (tx.state.queued.length < CAPACITY) tx.state.queued = [active.work, ...tx.state.queued];
        else tx.put({...checkpoint(active.work, cp), state: 'waiting', reason: 'queue-capacity'});
      }
    }
    delete tx.state.active;
  });
}
function waitReason(tx: Transaction, work: DraftQueueWork, cp?: DraftQueueTarget) {
  if (suppressed(cp, work)) return 'material-decision';
  if (historyAtCapacity(cp, work)) return 'identity-history-capacity';
  if (cp?.nextEligibleAt !== undefined && current(cp, work) && cp.nextEligibleAt > tx.now) return 'retry-delay';
  if (work.foreground) return undefined;
  if (tx.state.policy.paused) return 'background-paused';
  if (tx.state.policy.provider !== work.backend) return 'provider-policy-drift';
  if (work.backend === 'effect-ai') {
    const grant = tx.state.policy.remoteGrant;
    if (!grant || grant.providerIdentity !== work.providerIdentity) return 'remote-grant-required';
    if (
      EffectArray.filter(tx.state.backgroundReservations, r => r.providerIdentity === work.providerIdentity).length >=
      grant.unitsPerHour
    )
      return 'remote-budget';
  }
  if (!work.policyRevision || work.policyRevision !== sha256HexSync(JSON.stringify(tx.state.policy)))
    return 'policy-revision-drift';
  if (tx.state.backgroundReservations.length >= 4) return 'hourly-budget';
  return undefined;
}
export function enqueueDraftWork(config: Config, input: DraftQueueWork) {
  return check(workSchema, input).pipe(
    Effect.flatMap(work =>
      transaction(config, tx =>
        Effect.gen(function* () {
          const cp = yield* tx.read(work.targetKey);
          if (suppressed(cp, work)) return {state: 'suppressed', reason: 'material-decision'} as const;
          if (
            (work.regenerate && (!work.foreground || work.purpose !== 'topic')) ||
            (work.dedupeIdentity && work.regenerate !== true)
          )
            return yield* invalid();
          const terminal = terminalState(cp, work);
          if (terminal === 'completed' || (terminal === 'failed' && !work.foreground))
            return {state: 'suppressed', reason: terminal} as const;
          if (tx.state.active?.work.identity === work.identity) return {state: 'waiting', reason: 'active'} as const;
          const index = EffectOption.getOrElse(
            EffectArray.findFirstIndex(tx.state.queued, w => w.targetKey === work.targetKey),
            () => -1,
          );
          if (index < 0 && tx.state.queued.length >= CAPACITY)
            return {state: 'waiting', reason: 'queue-capacity'} as const;
          const queued = [...tx.state.queued];
          const previous = queued[index];
          const next = {
            ...work,
            foreground: work.foreground || (previous?.identity === work.identity && previous.foreground),
          };
          if (index < 0) queued.push(next);
          else queued[index] = next;
          tx.state.queued = queued;
          // An availability wakeup or provider drift never clears the user's decision.
          tx.put(
            cp && current(cp, work) && cp.state !== 'failed'
              ? {...cp, targetUri: work.targetUri}
              : checkpoint(work, cp),
          );
          const reason = waitReason(tx, next, cp);
          return reason ? ({state: 'waiting', reason} as const) : ({state: 'queued'} as const);
        }),
      ),
    ),
  );
}

export function claimDraftWork(
  config: Config,
  options?: {identity?: string; allPaused?: boolean; providerIdentity?: string},
) {
  return transaction(config, tx =>
    Effect.gen(function* () {
      const waiting = (reason: string, nextEligibleAt?: number) =>
        ({state: 'waiting', reason, ...(nextEligibleAt === undefined ? {} : {nextEligibleAt})}) as const;
      if (options?.allPaused) return waiting('all-maintenance-paused');
      if (tx.state.active) return waiting('active', tx.state.active.leaseUntil);
      const ordered = [
        ...EffectArrayPipe(tx.state.queued, __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (w, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && w.foreground,
          ),
        ),
        ...EffectArray.filter(tx.state.queued, w => !w.foreground),
      ];
      let firstReason = 'empty';
      let nextEligibleAt: number | undefined;
      for (const work of ordered) {
        const cp = yield* tx.read(work.targetKey);
        const reason =
          !work.foreground && options?.providerIdentity && work.providerIdentity !== options.providerIdentity
            ? 'provider-identity-drift'
            : waitReason(tx, work, cp);
        if (reason) {
          if (firstReason === 'empty') firstReason = reason;
          const next =
            reason === 'retry-delay'
              ? cp?.nextEligibleAt
              : reason === 'hourly-budget' || reason === 'remote-budget'
                ? (tx.state.backgroundReservations[0]?.at ?? tx.now) + HOUR
                : undefined;
          if (next !== undefined) nextEligibleAt = Math.min(nextEligibleAt ?? next, next);
          continue;
        }
        if (options?.identity && options.identity !== work.identity) return waiting('foreground-priority');
        const token = yield* (yield* Crypto.Crypto).randomUUIDv4();
        const claim = {token, work, leaseUntil: tx.now + LEASE};
        tx.state.active = {...claim, dispatched: false, policyRevision: sha256HexSync(JSON.stringify(tx.state.policy))};
        tx.state.queued = EffectArray.filter(tx.state.queued, w => w.targetKey !== work.targetKey);
        if (!work.foreground)
          tx.state.backgroundReservations = [
            ...tx.state.backgroundReservations,
            {
              at: tx.now,
              identity: work.identity,
              providerIdentity: work.providerIdentity,
              token,
            },
          ];
        return {state: 'claimed', claim} as const;
      }
      return waiting(firstReason, nextEligibleAt);
    }),
  );
}
function verify(tx: Transaction, claim: DraftQueueClaim) {
  return Effect.gen(function* () {
    const active = tx.state.active;
    const cp = yield* tx.read(claim.work.targetKey);
    if (
      !active ||
      active.token !== claim.token ||
      active.work.identity !== claim.work.identity ||
      JSON.stringify(active.work) !== JSON.stringify(claim.work) ||
      active.leaseUntil !== claim.leaseUntil ||
      active.leaseUntil <= tx.now ||
      active.published ||
      (!active.work.foreground && active.work.policyRevision !== sha256HexSync(JSON.stringify(tx.state.policy))) ||
      !current(cp, active.work) ||
      suppressed(cp, active.work)
    )
      return yield* stale();
    return active;
  });
}
export function verifyDraftWorkClaim(config: Config, claim: DraftQueueClaim) {
  return transaction(config, tx => verify(tx, claim).pipe(Effect.asVoid));
}
export function markDraftWorkDispatched(config: Config, claim: DraftQueueClaim) {
  return transaction(config, tx =>
    verify(tx, claim).pipe(
      Effect.map(active => {
        tx.state.active = {...active, dispatched: true};
      }),
    ),
  );
}

/** Caller holds the review lock; only its already-validated private save belongs inside this fence. */
export function publishDraftWorkReview<A, E, R>(
  config: Config,
  claim: DraftQueueClaim,
  publish: Effect.Effect<A, E, R>,
) {
  return transaction(config, tx =>
    Effect.gen(function* () {
      const active = yield* verify(tx, claim);
      if (!active.dispatched) return yield* stale();
      const result = yield* publish;
      // Policy changes after this committed publication cannot turn it into a failed draft.
      tx.state.active = {...active, published: true};
      return result;
    }),
  );
}
export function finishDraftWork(
  config: Config,
  claim: DraftQueueClaim,
  outcome: {
    state: 'completed' | 'failed' | 'waiting';
    reason?: string;
    transient?: boolean;
    provenUnused?: boolean;
  },
) {
  return transaction(config, tx =>
    Effect.gen(function* () {
      const active = tx.state.active;
      if (
        !active ||
        active.token !== claim.token ||
        JSON.stringify(active.work) !== JSON.stringify(claim.work) ||
        active.leaseUntil !== claim.leaseUntil
      )
        return false;
      const work = active.work;
      const dispatched =
        active.dispatched && !(outcome.state === 'waiting' && outcome.provenUnused && !active.published);
      const completed = active.published || outcome.state === 'completed';
      const cp = yield* tx.read(work.targetKey);
      delete tx.state.active;
      if (!dispatched) refund(tx, active.token);
      if (!current(cp, work) || suppressed(cp, work)) {
        // An in-flight superseded provider may have consumed its unit. Preserve
        // that identity without replacing the newer work or the user's decision.
        if (dispatched) {
          const recorded = identityCheckpoint(cp, work, 'failed');
          if (recorded) tx.put(recorded);
        }
        return false;
      }
      if (
        !active.published &&
        !work.foreground &&
        work.policyRevision !== sha256HexSync(JSON.stringify(tx.state.policy))
      ) {
        const base = checkpoint(work, cp);
        tx.put(
          dispatched
            ? {...identityCheckpoint(base, work, 'failed')!, state: 'failed', reason: 'policy-drift'}
            : {...base, state: 'waiting', reason: 'policy-drift'},
        );
        return false;
      }
      const base = checkpoint(work, cp);
      const retry =
        !completed && outcome.state === 'failed' && outcome.transient === true && (base.retryCount ?? 0) === 0;
      const waiting = !completed && outcome.state === 'waiting' && !dispatched;
      if (retry || waiting) {
        const waitingCheckpoint = {
          ...identityCheckpoint(
            {...base, retryCount: retry ? 1 : (base.retryCount ?? 0)},
            work,
            'waiting',
            tx.now + RETRY,
          )!,
          state: 'waiting' as const,
          reason: outcome.reason ?? (retry ? 'transient' : 'availability'),
          nextEligibleAt: tx.now + RETRY,
          retryCount: retry ? 1 : (base.retryCount ?? 0),
        };
        tx.put(waitingCheckpoint);
        if (!EffectArray.some(tx.state.queued, w => w.targetKey === work.targetKey)) {
          if (tx.state.queued.length < CAPACITY) tx.state.queued = [...tx.state.queued, work];
          else
            tx.put({
              ...waitingCheckpoint,
              state: 'waiting',
              reason: 'queue-capacity',
              nextEligibleAt: tx.now + RETRY,
              retryCount: retry ? 1 : (base.retryCount ?? 0),
            });
        }
      } else
        tx.put({
          ...identityCheckpoint(base, work, completed ? 'completed' : 'failed')!,
          state: completed ? 'completed' : 'failed',
          nextEligibleAt: undefined,
          ...(outcome.reason && !active.published
            ? {reason: Effect2.pipe(outcome.reason, EffectString.slice(0, 4096))}
            : {}),
        });
      return true;
    }),
  );
}
export function recordDraftQueueDecision(
  config: Config,
  input: {
    targetKey: string;
    targetUri: string;
    materialRevision: string;
    action: 'reject' | 'defer' | 'resume';
  },
) {
  return check(
    Schema.Struct({
      targetKey: hash,
      targetUri: text,
      materialRevision: hash,
      action: Schema.Literals(['reject', 'defer', 'resume']),
    }),
    input,
  ).pipe(
    Effect.flatMap(decision =>
      transaction(config, tx =>
        Effect.gen(function* () {
          const old = yield* tx.read(decision.targetKey);
          if (decision.action === 'resume') {
            if (
              old?.decision === 'defer' &&
              (old.decisionMaterialRevision ?? old.materialRevision) === decision.materialRevision
            ) {
              const {decision: _decision, decisionMaterialRevision: _material, ...rest} = old;
              tx.put(rest);
            }
            return;
          }
          tx.put({
            ...old,
            targetKey: decision.targetKey,
            targetUri: decision.targetUri,
            materialRevision: old?.materialRevision ?? decision.materialRevision,
            decision: decision.action,
            decisionMaterialRevision: decision.materialRevision,
          });
          tx.state.queued = EffectArray.filter(
            tx.state.queued,
            w => w.targetKey !== decision.targetKey || w.materialRevision !== decision.materialRevision,
          );
        }),
      ),
    ),
  );
}
export function readDraftQueueTarget(config: Config, targetKey: string) {
  return check(hash, targetKey).pipe(Effect.flatMap(key => transaction(config, tx => tx.read(key))));
}
function status(tx: Transaction) {
  return Effect.gen(function* () {
    const {state} = tx;
    const times = state.active ? [state.active.leaseUntil] : [];
    const waiting: {targetKey: string; identity: string; reason: string}[] = [];
    for (const work of state.queued) {
      const cp = yield* tx.read(work.targetKey);
      const reason = waitReason(tx, work, cp);
      if (reason) waiting.push({targetKey: work.targetKey, identity: work.identity, reason});
      if (reason === 'retry-delay' && cp?.nextEligibleAt !== undefined) times.push(cp.nextEligibleAt);
      if (reason === 'hourly-budget' || reason === 'remote-budget') {
        const reservations =
          reason === 'remote-budget'
            ? EffectArray.filter(state.backgroundReservations, r => r.providerIdentity === work.providerIdentity)
            : state.backgroundReservations;
        if (reservations.length) times.push(Math.min(...EffectArray.map(reservations, r => r.at)) + HOUR);
      }
    }
    return {
      version: 1 as const,
      policy: state.policy,
      policyRevision: sha256HexSync(JSON.stringify(state.policy)),
      queued: state.queued,
      waiting,
      ...(state.active
        ? {active: {token: state.active.token, work: state.active.work, leaseUntil: state.active.leaseUntil}}
        : {}),
      backgroundReservations: EffectArray.map(
        state.backgroundReservations,
        ({token: _token, ...reservation}) => reservation,
      ),
      ...(times.length ? {nextEligibleAt: Math.min(...times)} : {}),
    };
  });
}
export function readDraftQueueStatus(config: Config) {
  return transaction(config, tx => status(tx));
}
export function setDraftQueuePolicy(
  config: Config,
  input: {paused?: boolean; provider?: Policy['provider']; remoteGrant?: Policy['remoteGrant'] | null},
) {
  return check(
    Schema.Struct({
      paused: Schema.optionalKey(Schema.Boolean),
      provider: Schema.optionalKey(Schema.Literals(['local-ai', 'effect-ai'])),
      remoteGrant: Schema.optionalKey(Schema.NullOr(grantSchema)),
    }),
    input,
  ).pipe(
    Effect.flatMap(policy =>
      transaction(config, tx =>
        Effect.gen(function* () {
          tx.state.policy = {
            paused: policy.paused ?? tx.state.policy.paused,
            provider: policy.provider ?? (policy.remoteGrant ? 'effect-ai' : tx.state.policy.provider),
            ...(policy.remoteGrant === null
              ? {}
              : policy.remoteGrant
                ? {remoteGrant: policy.remoteGrant}
                : tx.state.policy.remoteGrant
                  ? {remoteGrant: tx.state.policy.remoteGrant}
                  : {}),
          };
          return yield* status(tx);
        }),
      ),
    ),
  );
}
export function selectDraftQueueTargets(config: Config, uris: readonly string[], limit = 4) {
  return check(Schema.Array(text), uris).pipe(
    Effect.flatMap(validUris =>
      transaction(config, tx =>
        Effect.sync(() => {
          const ordered = [...new Set(validUris)].sort();
          const count = Number.isFinite(limit) ? Math.min(4, Math.max(0, Math.floor(limit))) : 4;
          const split = tx.state.discoveryCursor
            ? EffectOption.getOrElse(
                EffectArray.findFirstIndex(ordered, uri => uri > tx.state.discoveryCursor!),
                () => -1,
              )
            : 0;
          const offset = split < 0 ? 0 : split;
          const chosen = [...ordered.slice(offset), ...ordered.slice(0, offset)].slice(0, count);
          if (chosen.length) tx.state.discoveryCursor = chosen.at(-1);
          return chosen;
        }),
      ),
    ),
  );
}
