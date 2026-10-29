import {Array as EffectArray} from 'effect';
import {Crypto, Effect, FileSystem, Option, Path, Result, Schema} from 'effect';
import {
  type ModelArtifactFileIdentity as ModelSetupFileIdentity,
  validModelArtifactFileIdentity as validFileIdentity,
} from './artifact_identity.js';
export {
  modelArtifactFileIdentity as modelSetupFileIdentity,
  sameModelArtifactFile as sameModelSetupFile,
} from './artifact_identity.js';
export type {ModelArtifactFileIdentity as ModelSetupFileIdentity} from './artifact_identity.js';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {LocalModelManifest} from './catalog.js';

export const MODEL_SETUP_VERSION = 1 as const;
const phases = ['pending', 'downloading', 'verifying', 'ready', 'retry-wait', 'action-required', 'off'] as const;
export type ModelSetupPhase = (typeof phases)[number];
export type ModelSetupPolicy = 'automatic' | 'off';

/** The caller binds home to its canonical, resolved data home, never its working directory. */
export interface ModelSetupJob {
  readonly home: string;
  readonly modelId: string;
  readonly revision: string;
  readonly sha256: string;
}

export interface ModelSetupReservation {
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface ModelSetupOwner {
  readonly token: string;
  readonly processId: number;
  readonly processStartIdentity: string;
}

export interface ModelSetupReceipt {
  readonly sha256: string;
  readonly fileIdentity: ModelSetupFileIdentity;
}

export interface ModelSetupState {
  readonly version: typeof MODEL_SETUP_VERSION;
  readonly policy: ModelSetupPolicy;
  readonly intentEpoch: number;
  readonly job: ModelSetupJob;
  readonly phase: ModelSetupPhase;
  readonly attempts: number;
  readonly owner?: ModelSetupOwner;
  readonly reservation?: ModelSetupReservation;
  readonly drainingOwner?: ModelSetupOwner;
  readonly receipt?: ModelSetupReceipt;
  readonly bytes?: number;
  /** Bounded reason code only; never raw process/network output or paths. */
  readonly reason?: string;
  readonly nextAttemptAt?: number;
}

export type ModelSetupInspection =
  | {readonly status: 'missing'}
  | {readonly status: 'malformed'; readonly phase: 'action-required'; readonly reason: 'invalid-state'}
  | {readonly status: 'valid'; readonly state: ModelSetupState};

export type ModelSetupMutation =
  | Exclude<ModelSetupInspection, {readonly status: 'valid'}>
  | {readonly status: 'valid'; readonly state: ModelSetupState; readonly supersededOwner?: ModelSetupOwner};

function mutationResult(state: ModelSetupState, supersededOwner?: ModelSetupOwner): ModelSetupMutation {
  return {status: 'valid', state, ...(supersededOwner ? {supersededOwner} : {})};
}

const OwnerSchema = Schema.Struct({token: Schema.String, processId: Schema.Int, processStartIdentity: Schema.String});

const StateSchema = Schema.Struct({
  version: Schema.Literal(MODEL_SETUP_VERSION),
  policy: Schema.Literals(['automatic', 'off']),
  intentEpoch: Schema.Int,
  job: Schema.Struct({home: Schema.String, modelId: Schema.String, revision: Schema.String, sha256: Schema.String}),
  phase: Schema.Literals(phases),
  attempts: Schema.Int,
  reservation: Schema.optionalKey(Schema.Struct({nonce: Schema.String, expiresAt: Schema.Int})),
  owner: Schema.optionalKey(OwnerSchema),
  drainingOwner: Schema.optionalKey(OwnerSchema),
  receipt: Schema.optionalKey(
    Schema.Struct({
      sha256: Schema.String,
      fileIdentity: Schema.Struct({
        size: Schema.String,
        device: Schema.String,
        inode: Schema.String,
        modifiedAtNs: Schema.String,
        changedAtNs: Schema.String,
      }),
    }),
  ),
  bytes: Schema.optionalKey(Schema.Int),
  reason: Schema.optionalKey(Schema.String),
  nextAttemptAt: Schema.optionalKey(Schema.Int),
});

const malformed = {status: 'malformed', phase: 'action-required', reason: 'invalid-state'} as const;

export function parseModelSetup(raw: string): ModelSetupInspection {
  const parsed = Result.try(() => Schema.decodeUnknownSync(StateSchema, {onExcessProperty: 'error'})(JSON.parse(raw)));
  if (Result.isFailure(parsed)) return malformed;
  const state = parsed.success;
  const running = state.phase === 'downloading' || state.phase === 'verifying';
  if (
    !Number.isSafeInteger(state.intentEpoch) ||
    state.intentEpoch < 0 ||
    !Number.isSafeInteger(state.attempts) ||
    state.attempts < 0 ||
    !state.job.home ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(state.job.modelId) ||
    !/^[a-f0-9]{40}$/.test(state.job.revision) ||
    !/^[a-f0-9]{64}$/.test(state.job.sha256) ||
    (state.policy === 'off') !== (state.phase === 'off') ||
    running !== (state.owner !== undefined) ||
    (state.reservation !== undefined &&
      (state.phase !== 'pending' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(state.reservation.nonce) ||
        !Number.isSafeInteger(state.reservation.expiresAt) ||
        state.reservation.expiresAt < 0)) ||
    (state.phase === 'ready') !== (state.receipt !== undefined) ||
    (state.phase === 'retry-wait') !== (state.nextAttemptAt !== undefined) ||
    (state.phase === 'retry-wait' || state.phase === 'action-required') !== (state.reason !== undefined) ||
    (state.reason !== undefined && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(state.reason)) ||
    (state.bytes !== undefined && (!Number.isSafeInteger(state.bytes) || state.bytes < 0)) ||
    (state.nextAttemptAt !== undefined && (!Number.isSafeInteger(state.nextAttemptAt) || state.nextAttemptAt < 0)) ||
    EffectArray.some(
      [state.owner, state.drainingOwner],
      owner =>
        owner !== undefined &&
        (!owner.token ||
          owner.token.length > 256 ||
          !Number.isSafeInteger(owner.processId) ||
          owner.processId <= 0 ||
          !owner.processStartIdentity ||
          owner.processStartIdentity.length > 256),
    ) ||
    (state.receipt !== undefined &&
      (state.receipt.sha256 !== state.job.sha256 || !validFileIdentity(state.receipt.fileIdentity)))
  )
    return malformed;
  return {status: 'valid', state};
}

export function modelSetupJob(home: string, manifest: LocalModelManifest): ModelSetupJob {
  return {home, modelId: manifest.id, revision: manifest.revision, sha256: manifest.sha256};
}

export function sameModelSetupJob(left: ModelSetupJob, right: ModelSetupJob): boolean {
  return (
    left.home === right.home &&
    left.modelId === right.modelId &&
    left.revision === right.revision &&
    left.sha256 === right.sha256
  );
}

export function initialModelSetupState(job: ModelSetupJob): ModelSetupState {
  return {version: MODEL_SETUP_VERSION, policy: 'automatic', intentEpoch: 0, job, phase: 'pending', attempts: 0};
}

export interface ModelSetupFence {
  readonly intentEpoch: number;
  readonly job: ModelSetupJob;
  readonly owner: ModelSetupOwner;
}

export type ModelSetupCommand =
  | {readonly type: 'policy'; readonly policy: ModelSetupPolicy}
  | {readonly type: 'request'; readonly job: ModelSetupJob; readonly restart?: boolean; readonly expectedEpoch?: number}
  | {readonly type: 'drained'; readonly intentEpoch: number; readonly owner: ModelSetupOwner}
  | {
      readonly type: 'reserve';
      readonly job: ModelSetupJob;
      readonly nonce: string;
      readonly now: number;
      readonly expiresAt: number;
    }
  | {
      readonly type: 'blocked';
      readonly intentEpoch: number;
      readonly reason: string;
      readonly nonce?: string;
      readonly nextAttemptAt?: number;
    }
  | {
      readonly type: 'claim';
      readonly intentEpoch: number;
      readonly job: ModelSetupJob;
      readonly owner: ModelSetupOwner;
      readonly nonce?: string;
      readonly now?: number;
    }
  | {
      readonly type: 'progress';
      readonly fence: ModelSetupFence;
      readonly bytes: number;
      readonly phase?: 'downloading' | 'verifying';
    }
  | {readonly type: 'verifying'; readonly fence: ModelSetupFence}
  | {readonly type: 'ready'; readonly fence: ModelSetupFence; readonly receipt: ModelSetupReceipt}
  | {
      readonly type: 'retry-wait';
      readonly fence: ModelSetupFence;
      readonly reason: string;
      readonly nextAttemptAt: number;
    }
  | {readonly type: 'action-required'; readonly fence: ModelSetupFence; readonly reason: string};

/** Pure intent/fence transitions. A restart supersedes an owner before any expensive work begins. */
export function transitionModelSetup(state: ModelSetupState, command: ModelSetupCommand): ModelSetupState {
  const next = transition(state, command);
  return next === state || parseModelSetup(JSON.stringify(next)).status === 'valid' ? next : state;
}

function transition(state: ModelSetupState, command: ModelSetupCommand): ModelSetupState {
  if (command.type === 'policy') {
    if (state.policy === command.policy) return state;
    return {
      ...initialModelSetupState(state.job),
      policy: command.policy,
      intentEpoch: nextEpoch(state.intentEpoch),
      phase: command.policy === 'off' ? 'off' : 'pending',
      ...((state.owner ?? state.drainingOwner) ? {drainingOwner: state.owner ?? state.drainingOwner} : {}),
    };
  }
  if (command.type === 'drained') {
    if (
      state.intentEpoch !== command.intentEpoch ||
      state.drainingOwner?.token !== command.owner.token ||
      state.drainingOwner.processId !== command.owner.processId ||
      state.drainingOwner.processStartIdentity !== command.owner.processStartIdentity
    )
      return state;
    const {drainingOwner: _drainingOwner, ...drained} = state;
    return drained;
  }
  if (state.policy === 'off') return state;
  if (command.type === 'request') {
    if (command.expectedEpoch !== undefined && command.expectedEpoch !== state.intentEpoch) return state;
    const sameJob = sameModelSetupJob(state.job, command.job);
    if (sameJob && !command.restart) return state;
    return {
      ...initialModelSetupState(command.job),
      intentEpoch: nextEpoch(state.intentEpoch),
      attempts: sameJob ? state.attempts : 0,
      ...((state.owner ?? state.drainingOwner) ? {drainingOwner: state.owner ?? state.drainingOwner} : {}),
    };
  }
  if (command.type === 'reserve') {
    if (
      state.phase !== 'pending' ||
      state.drainingOwner ||
      !sameModelSetupJob(state.job, command.job) ||
      (state.reservation && state.reservation.expiresAt > command.now) ||
      command.expiresAt <= command.now
    )
      return state;
    return {
      ...state,
      intentEpoch: nextEpoch(state.intentEpoch),
      reservation: {nonce: command.nonce, expiresAt: command.expiresAt},
    };
  }
  if (command.type === 'blocked') {
    if (
      state.phase !== 'pending' ||
      state.intentEpoch !== command.intentEpoch ||
      (state.reservation && state.reservation.nonce !== command.nonce)
    )
      return state;
    const {reservation: _reservation, ...unreserved} = state;
    return {
      ...unreserved,
      phase: command.nextAttemptAt === undefined ? 'action-required' : 'retry-wait',
      reason: command.reason,
      ...(command.nextAttemptAt === undefined ? {} : {nextAttemptAt: command.nextAttemptAt}),
    };
  }
  if (command.type === 'claim') {
    if (
      state.phase !== 'pending' ||
      state.drainingOwner !== undefined ||
      state.intentEpoch !== command.intentEpoch ||
      !sameModelSetupJob(state.job, command.job) ||
      (state.reservation !== undefined &&
        (state.reservation.nonce !== command.nonce ||
          command.now === undefined ||
          command.now > state.reservation.expiresAt))
    )
      return state;
    const {reservation: _reservation, ...unreserved} = state;
    return {...unreserved, phase: 'downloading', owner: command.owner, attempts: state.attempts + 1};
  }
  const fence = command.fence;
  if (
    !state.owner ||
    state.intentEpoch !== fence.intentEpoch ||
    !sameModelSetupJob(state.job, fence.job) ||
    state.owner.token !== fence.owner.token ||
    state.owner.processId !== fence.owner.processId ||
    state.owner.processStartIdentity !== fence.owner.processStartIdentity
  )
    return state;
  if (command.type === 'progress') return {...state, bytes: command.bytes, phase: command.phase ?? state.phase};
  if (command.type === 'verifying') return state.phase === 'downloading' ? {...state, phase: 'verifying'} : state;
  if (command.type === 'ready' && (state.phase !== 'verifying' || command.receipt.sha256 !== state.job.sha256))
    return state;
  const {owner: _owner, ...unowned} = state;
  if (command.type === 'ready') return {...unowned, phase: 'ready', receipt: command.receipt};
  if (command.type === 'retry-wait')
    return {...unowned, phase: 'retry-wait', reason: command.reason, nextAttemptAt: command.nextAttemptAt};
  if (command.type === 'action-required') return {...unowned, phase: 'action-required', reason: command.reason};
  return state;
}

function nextEpoch(epoch: number): number {
  if (epoch >= Number.MAX_SAFE_INTEGER) throw new Error('Model setup intent epoch exhausted.');
  return epoch + 1;
}

export const readModelSetup = Effect.fn('models.readSetup')(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(home, 'models', 'setup.json');
  if (!(yield* fs.exists(file))) return {status: 'missing'} as const;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return malformed;
  const info = yield* fs.stat(file);
  if (info.type !== 'File' || Number(info.size) > 16_384) return malformed;
  return parseModelSetup(yield* fs.readFileString(file));
});

export class ModelSetupStateInvalid extends Schema.TaggedError<
  ModelSetupStateInvalid,
  {readonly brand: unique symbol}
>()('ModelSetupStateInvalid', {
  message: Schema.String,
}) {}

export class ModelSetupConflict extends Schema.TaggedError<ModelSetupConflict, {readonly brand: unique symbol}>()(
  'ModelSetupConflict',
  {
    message: Schema.String,
  },
) {
  static stale(): ModelSetupConflict {
    return ModelSetupConflict.make({message: 'Model setup changed. Refresh its status and try again.'});
  }
}

/** Only bounded state transitions run under this lock: no callback, store lock, network, or hashing. */
export const updateModelSetup = Effect.fn('models.updateSetup')(function* (
  home: string,
  manifest: LocalModelManifest,
  command: ModelSetupCommand,
  options: {readonly expectedEpoch?: number} = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const directory = path.join(home, 'models');
  const initializes =
    (options.expectedEpoch === undefined || options.expectedEpoch === 0) &&
    (command.type === 'policy' || (command.type === 'request' && command.expectedEpoch === undefined));
  if (!(yield* fs.exists(directory))) {
    if (options.expectedEpoch !== undefined && options.expectedEpoch !== 0) return yield* ModelSetupConflict.stale();
    if (!initializes) return {status: 'missing'} as const;
  }
  if (initializes) {
    yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    yield* fs.chmod(directory, 0o700);
  }
  const canonicalHome = yield* fs.realPath(home);
  return yield* withExclusiveFileLock(
    fs,
    path.join(directory, 'setup.lock'),
    {
      createParentDirectory: initializes,
      retryIntervalMilliseconds: 10,
      staleAfterMilliseconds: 30_000,
      waitTimeoutMilliseconds: 1_000,
      useCanonicalProcessStartIdentity: true,
    },
    Effect.gen(function* () {
      const current = yield* readModelSetup(canonicalHome);
      if (current.status === 'malformed') return current;
      if (current.status === 'missing') {
        if (options.expectedEpoch !== undefined && options.expectedEpoch !== 0)
          return yield* ModelSetupConflict.stale();
        if (!initializes) return current;
      }
      const state =
        current.status === 'valid' ? current.state : initialModelSetupState(modelSetupJob(canonicalHome, manifest));
      if (options.expectedEpoch !== undefined && options.expectedEpoch !== state.intentEpoch)
        return yield* ModelSetupConflict.stale();
      // A copied receipt must never authorize a different data home.
      if (state.job.home !== canonicalHome || ('job' in command && command.job.home !== canonicalHome))
        return malformed;
      const next = yield* Effect.try({
        try: () => transitionModelSetup(state, command),
        catch: () => ModelSetupStateInvalid.make({message: 'Cannot advance model setup intent.'}),
      });
      const raw = `${JSON.stringify(next, undefined, 2)}\n`;
      if (parseModelSetup(raw).status !== 'valid') {
        return yield* ModelSetupStateInvalid.make({message: 'Invalid model setup transition.'});
      }
      if (current.status === 'valid' && next === state) return mutationResult(state);
      const temporary = path.join(directory, `.setup.${yield* crypto.randomUUIDv4()}.tmp`);
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(temporary, raw, {mode: 0o600});
        yield* syncWritableFile(fs, temporary);
        yield* fs.rename(temporary, path.join(directory, 'setup.json'));
        yield* syncDirectoryBestEffort(fs, directory);
      }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
      // Return the atomically displaced process identity to the coordinator for safe stop/drain.
      const supersededOwner =
        (command.type === 'policy' || command.type === 'request') && next !== state ? state.owner : undefined;
      return mutationResult(next, supersededOwner);
    }),
  );
});
