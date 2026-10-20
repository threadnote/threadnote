import {Cause, Clock, Console, Crypto, Effect, FileSystem, Path, Schema} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {runDetachedCommandEffect} from '@threadnote/platform/command';
import {FileLockTimeout} from '@threadnote/platform/file/lock';
import {HttpStatusError} from '@threadnote/platform/http';
import {CORE_GENERATION_MODEL_ID} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {LocalModelStore, ModelStoreIoFailed, type LocalModelStoreError} from '@threadnote/inference/models/store';
import {InsufficientDiskSpace, ModelChecksumMismatch, ModelDownloadFailed} from '@threadnote/inference/engine/errors';
import {inspectModelSelection} from '@threadnote/inference/models/selection';
import {
  modelSetupFileIdentity,
  modelSetupJob,
  readModelSetup,
  sameModelSetupFile,
  sameModelSetupJob,
  updateModelSetup,
  type ModelSetupFence,
  type ModelSetupOwner,
  type ModelSetupPhase,
  type ModelSetupState,
} from '@threadnote/inference/models/setup';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {withStandaloneProcessLease} from '../process/standalone_lease.js';

export const MODEL_SETUP_WORKER_ARGUMENT = 'model-setup-worker';
const RESERVATION_MILLISECONDS = 30_000;
const WORKER_LIFETIME_MILLISECONDS = 30 * 60_000;
const PUBLIC_REASONS = new Set([
  'invalid-state',
  'state-unreadable',
  'environment-off',
  'unsupported-platform',
  'insufficient-memory',
  'unknown-memory',
  'resource-check-failed',
  'insufficient-disk',
  'unknown-disk',
  'checksum-mismatch',
  'authentication-required',
  'download-failed',
  'io-failed',
  'worker-start-failed',
  'worker-identity-unavailable',
  'worker-unresponsive',
  'worker-exited',
  'artifact-changed',
  'setup-failed',
  'worker-timeout',
  'model-busy',
]);

export class ModelSetupError extends Schema.TaggedError<ModelSetupError>()('ModelSetupError', {
  message: Schema.String,
}) {}
export function modelSetupPublicError(cause: unknown): ModelSetupError {
  return Schema.is(ModelSetupError)(cause)
    ? cause
    : ModelSetupError.make({
        message: 'Model setup could not access its private state. Check home permissions and retry.',
      });
}

class SetupCancelled extends Schema.TaggedError<SetupCancelled>()('SetupCancelled', {}) {}

export interface ModelSetupStatus {
  readonly version: 1;
  readonly modelId: string;
  readonly totalBytes: number;
  readonly policy: 'automatic' | 'off';
  readonly phase: ModelSetupPhase | 'not-requested';
  readonly bytes: number;
  readonly attempts: number;
  readonly artifactReady: boolean;
  readonly effectiveDefault: boolean;
  readonly environmentOff: boolean;
  readonly nextAttemptAt?: number;
  readonly reason?: string;
}

function baseStatus(manifest: LocalModelManifest, environmentOff: boolean): ModelSetupStatus {
  return {
    version: 1,
    modelId: manifest.id,
    totalBytes: manifest.size,
    policy: 'automatic',
    phase: 'not-requested',
    bytes: 0,
    attempts: 0,
    artifactReady: false,
    effectiveDefault: false,
    environmentOff,
  };
}

const receiptIsCurrent = Effect.fn('models.setup.receiptIsCurrent')(function* (
  home: string,
  manifest: LocalModelManifest,
  state: ModelSetupState,
) {
  if (
    state.phase !== 'ready' ||
    !state.receipt ||
    !sameModelSetupJob(state.job, modelSetupJob(home, manifest)) ||
    state.receipt.sha256 !== manifest.sha256 ||
    state.receipt.fileIdentity.size !== String(manifest.size)
  )
    return false;
  const store = yield* LocalModelStore;
  const current = yield* modelSetupFileIdentity(store.path(home, manifest)).pipe(Effect.orElseSucceed(() => undefined));
  return current !== undefined && sameModelSetupFile(current, state.receipt.fileIdentity);
});

/** Read-only, bounded public projection; no process launch, full digest verification, or native runtime. */
export const readModelSetupStatus = Effect.fn('models.setup.status')(function* (home: string) {
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(CORE_GENERATION_MODEL_ID);
  const system = yield* SystemInfo;
  const environmentOff = system.environment().THREADNOTE_MODEL_SETUP === 'off';
  const base = baseStatus(manifest, environmentOff);
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(home))) return base;
    const canonicalHome = yield* fs.realPath(home);
    const inspection = yield* readModelSetup(canonicalHome);
    if (inspection.status === 'missing') return base;
    if (inspection.status === 'malformed' || inspection.state.job.home !== canonicalHome) {
      return {...base, phase: 'action-required' as const, reason: 'invalid-state'};
    }
    const state = inspection.state;
    const artifactReady = yield* receiptIsCurrent(canonicalHome, manifest, state);
    const selection = yield* inspectModelSelection(canonicalHome);
    const unset =
      selection.status === 'missing' ||
      (selection.status === 'valid' && selection.selection.roles.generation === undefined);
    const reason = environmentOff
      ? 'environment-off'
      : state.phase === 'ready' && !artifactReady
        ? 'artifact-changed'
        : state.reason;
    return {
      ...base,
      policy: state.policy,
      phase: state.phase,
      bytes: state.bytes ?? (artifactReady ? manifest.size : 0),
      attempts: state.attempts,
      artifactReady,
      effectiveDefault: artifactReady && unset && state.policy === 'automatic' && !environmentOff,
      ...(state.nextAttemptAt === undefined ? {} : {nextAttemptAt: state.nextAttemptAt}),
      ...(reason === undefined ? {} : {reason: PUBLIC_REASONS.has(reason) ? reason : 'setup-failed'}),
    };
  }).pipe(Effect.orElseSucceed(() => ({...base, phase: 'action-required' as const, reason: 'state-unreadable'})));
});

export function modelSetupRetryDelay(attempt: number, jitter: number): number {
  const schedule = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];
  const base = schedule[Math.min(schedule.length - 1, Math.max(0, attempt - 1))];
  return Math.min(6 * 60 * 60_000, Math.round(base * (0.9 + 0.2 * Math.max(0, Math.min(1, jitter)))));
}

const MODEL_SETUP_WORKER_ENVIRONMENT = new Set(
  [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'USER',
    'USERNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'THREADNOTE_INSTALL_ROOT',
    'THREADNOTE_MODEL_SETUP',
  ].map(key => key.toLowerCase()),
);

export function modelSetupWorkerEnvironment(environment: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => MODEL_SETUP_WORKER_ENVIRONMENT.has(key.toLowerCase())),
    ),
    THREADNOTE_HOME: home,
  };
}

function automaticRuntimeAllowed(system: SystemInfoShape): boolean {
  const environment = system.environment();
  return (
    !environment.CI &&
    !environment.VITEST &&
    environment.NODE_ENV !== 'test' &&
    environment.THREADNOTE_TOOLSET !== 'cloud' &&
    !['bun', 'bun.exe', 'node', 'node.exe'].includes(
      system.executablePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '',
    )
  );
}

const eligibilityReason = Effect.fn('models.setup.eligibility')(function* (manifest: LocalModelManifest) {
  const system = yield* SystemInfo;
  if (
    !['darwin', 'linux', 'win32'].includes(system.platform) ||
    !['arm64', 'x64'].includes(system.architecture) ||
    (system.platform === 'win32' && system.architecture === 'arm64')
  )
    return 'unsupported-platform';
  const hardware = yield* system.hardwareInfo.pipe(Effect.result);
  if (hardware._tag === 'Failure') return 'resource-check-failed';
  const memory = hardware.success.effectiveMemoryBytes;
  return !Number.isFinite(memory) || memory <= 0
    ? 'unknown-memory'
    : memory < manifest.minimumRamBytes
      ? 'insufficient-memory'
      : undefined;
});

const ownerIsRunning = Effect.fn('models.setup.ownerIsRunning')(function* (owner: ModelSetupOwner) {
  const system = yield* SystemInfo;
  if (!system.isProcessRunning(owner.processId)) return false;
  const identity = yield* system.canonicalProcessStartIdentity?.(owner.processId) ?? succeedUndefined;
  if (identity === undefined) return undefined;
  return identity === owner.processStartIdentity;
});

const drainOwner = Effect.fn('models.setup.drainOwner')(function* (owner: ModelSetupOwner) {
  const system = yield* SystemInfo;
  if (owner.processId === system.processId)
    return yield* ModelSetupError.make({message: 'The setup worker cannot stop itself.'});
  const observed = yield* ownerIsRunning(owner);
  if (observed === false) return;
  if (observed === undefined)
    return yield* ModelSetupError.make({
      message: 'Cannot verify the setup worker identity; automatic setup remains off. Retry after it exits.',
    });
  // Every signal uses a fresh exact start identity. Reused or unknown PIDs are never signaled.
  const signal = (value: NodeJS.Signals) =>
    ownerIsRunning(owner).pipe(
      Effect.flatMap(matches =>
        matches === true
          ? Effect.try({
              try: () => system.signalProcess(owner.processId, value),
              catch: () => ModelSetupError.make({message: 'Could not stop the setup worker; retry after it exits.'}),
            })
          : Effect.void,
      ),
    );
  yield* signal('SIGTERM');
  const started = yield* Clock.currentTimeMillis;
  while ((yield* ownerIsRunning(owner)) === true && (yield* Clock.currentTimeMillis) - started < 5_000)
    yield* Effect.sleep(50);
  if ((yield* ownerIsRunning(owner)) === true) yield* signal('SIGKILL');
  const killed = yield* Clock.currentTimeMillis;
  while ((yield* ownerIsRunning(owner)) === true && (yield* Clock.currentTimeMillis) - killed < 1_000)
    yield* Effect.sleep(25);
  if ((yield* ownerIsRunning(owner)) !== false)
    return yield* ModelSetupError.make({message: 'Setup worker has not drained; no model or home files were removed.'});
});

const finishDrain = Effect.fn('models.setup.finishDrain')(function* (
  home: string,
  manifest: LocalModelManifest,
  state: ModelSetupState,
) {
  if (!state.drainingOwner) return;
  yield* drainOwner(state.drainingOwner);
  yield* updateModelSetup(home, manifest, {
    type: 'drained',
    intentEpoch: state.intentEpoch,
    owner: state.drainingOwner,
  });
});

export const stopModelSetup = Effect.fn('models.setup.stop')(function* (home: string) {
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(CORE_GENERATION_MODEL_ID);
  const mutation = yield* updateModelSetup(home, manifest, {type: 'policy', policy: 'off'});
  if (mutation.status !== 'valid')
    return yield* ModelSetupError.make({
      message: 'Cannot safely stop setup with invalid state; preserve the home and repair models/setup.json first.',
    });
  yield* finishDrain(home, manifest, mutation.state);
}, Effect.mapError(modelSetupPublicError));

export const requestModelSetup = Effect.fn('models.setup.request')(function* (
  home: string,
  options: {readonly retry?: boolean; readonly automatic?: boolean} = {},
) {
  const system = yield* SystemInfo;
  if (system.environment().THREADNOTE_MODEL_SETUP === 'off' || (options.automatic && !automaticRuntimeAllowed(system)))
    return yield* readModelSetupStatus(home);
  const fs = yield* FileSystem.FileSystem;
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(CORE_GENERATION_MODEL_ID);
  yield* fs.makeDirectory(home, {recursive: true, mode: 0o700});
  const canonicalHome = yield* fs.realPath(home);
  const job = modelSetupJob(canonicalHome, manifest);
  let mutation = yield* updateModelSetup(canonicalHome, manifest, {type: 'request', job});
  if (mutation.status !== 'valid' || mutation.state.policy === 'off') return yield* readModelSetupStatus(canonicalHome);
  let state = mutation.state;
  const now = yield* Clock.currentTimeMillis;
  if (state.owner) {
    const running = yield* ownerIsRunning(state.owner);
    if (running !== false) return yield* readModelSetupStatus(canonicalHome);
  }
  if (state.phase === 'ready' && (yield* receiptIsCurrent(canonicalHome, manifest, state)))
    return yield* readModelSetupStatus(canonicalHome);
  if (state.phase === 'retry-wait' && !options.retry && (state.nextAttemptAt ?? 0) > now)
    return yield* readModelSetupStatus(canonicalHome);
  if (state.phase === 'action-required' && !options.retry) return yield* readModelSetupStatus(canonicalHome);
  if (state.phase !== 'pending') {
    mutation = yield* updateModelSetup(canonicalHome, manifest, {
      type: 'request',
      job,
      restart: true,
      expectedEpoch: state.intentEpoch,
    });
    if (mutation.status !== 'valid') return yield* readModelSetupStatus(canonicalHome);
    state = mutation.state;
  }
  yield* finishDrain(canonicalHome, manifest, state);
  const reason = yield* eligibilityReason(manifest);
  if (reason) {
    yield* updateModelSetup(canonicalHome, manifest, {type: 'blocked', intentEpoch: state.intentEpoch, reason});
    return yield* readModelSetupStatus(canonicalHome);
  }
  const crypto = yield* Crypto.Crypto;
  const nonce = yield* crypto.randomUUIDv4();
  const reservationNow = yield* Clock.currentTimeMillis;
  const reservation = yield* updateModelSetup(canonicalHome, manifest, {
    type: 'reserve',
    job,
    nonce,
    now: reservationNow,
    expiresAt: reservationNow + RESERVATION_MILLISECONDS,
  });
  if (reservation.status !== 'valid' || reservation.state.reservation?.nonce !== nonce)
    return yield* readModelSetupStatus(canonicalHome);
  const executableName = system.executablePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  const args = [
    ...(executableName === 'bun' || executableName === 'bun.exe' ? [system.developmentEntrypoint] : []),
    MODEL_SETUP_WORKER_ARGUMENT,
    '--home',
    canonicalHome,
    '--epoch',
    String(reservation.state.intentEpoch),
    '--nonce',
    nonce,
  ];
  const started = yield* runDetachedCommandEffect(system.executablePath, args, {
    cwd: canonicalHome,
    env: modelSetupWorkerEnvironment(system.environment(), canonicalHome),
  }).pipe(Effect.orElseSucceed(() => false));
  if (!started)
    yield* updateModelSetup(canonicalHome, manifest, {
      type: 'blocked',
      intentEpoch: reservation.state.intentEpoch,
      nonce,
      reason: 'worker-start-failed',
      nextAttemptAt: now + 60_000,
    });
  return yield* readModelSetupStatus(canonicalHome);
}, Effect.mapError(modelSetupPublicError));

export const setModelSetupPolicy = Effect.fn('models.setup.policy')(function* (home: string, enabled: boolean) {
  if (!enabled) {
    yield* stopModelSetup(home);
    return yield* readModelSetupStatus(home);
  }
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(CORE_GENERATION_MODEL_ID);
  const mutation = yield* updateModelSetup(home, manifest, {type: 'policy', policy: 'automatic'});
  if (mutation.status === 'valid') yield* finishDrain(home, manifest, mutation.state);
  return yield* requestModelSetup(home, {retry: true});
}, Effect.mapError(modelSetupPublicError));

function failureReason(error: LocalModelStoreError | unknown): {readonly reason: string; readonly retryable: boolean} {
  if (Schema.is(ModelStoreIoFailed)(error) && Schema.is(FileLockTimeout)(error.cause))
    return {reason: 'model-busy', retryable: true};
  if (Cause.isTimeoutError(error)) return {reason: 'worker-timeout', retryable: true};
  if (typeof error === 'object' && error !== null && 'operation' in error && error.operation === 'unknown-disk-space')
    return {reason: 'unknown-disk', retryable: false};
  if (Schema.is(ModelChecksumMismatch)(error)) return {reason: 'checksum-mismatch', retryable: false};
  if (Schema.is(InsufficientDiskSpace)(error)) return {reason: 'insufficient-disk', retryable: false};
  if (Schema.is(ModelDownloadFailed)(error)) {
    if (Schema.is(HttpStatusError)(error.cause) && [401, 403, 404].includes(error.cause.status))
      return {reason: 'authentication-required', retryable: false};
    return {reason: 'download-failed', retryable: true};
  }
  return {reason: 'io-failed', retryable: false};
}

function owns(state: ModelSetupState, fence: ModelSetupFence): boolean {
  return (
    state.policy === 'automatic' &&
    state.intentEpoch === fence.intentEpoch &&
    sameModelSetupJob(state.job, fence.job) &&
    state.owner?.token === fence.owner.token &&
    state.owner.processId === fence.owner.processId &&
    state.owner.processStartIdentity === fence.owner.processStartIdentity
  );
}

const requireOwner = Effect.fn('models.setup.requireOwner')(function* (home: string, fence: ModelSetupFence) {
  const current = yield* readModelSetup(home);
  if (current.status !== 'valid' || !owns(current.state, fence)) return yield* SetupCancelled.make({});
  return current.state;
});

/** Reject queued/stale children before creating a lease, logger, application context, or home directory. */
export const runModelSetupWorker = Effect.fn('models.setup.worker')(function* (
  home: string,
  intentEpoch: number,
  nonce: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(home))) return;
  const canonicalHome = yield* fs.realPath(home);
  const current = yield* readModelSetup(canonicalHome);
  const now = yield* Clock.currentTimeMillis;
  if (
    current.status !== 'valid' ||
    current.state.policy !== 'automatic' ||
    current.state.phase !== 'pending' ||
    current.state.intentEpoch !== intentEpoch ||
    current.state.reservation?.nonce !== nonce ||
    current.state.reservation.expiresAt < now
  )
    return;
  const system = yield* SystemInfo;
  if (system.environment().THREADNOTE_MODEL_SETUP === 'off') return;
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(CORE_GENERATION_MODEL_ID);
  const job = modelSetupJob(canonicalHome, manifest);
  if (!sameModelSetupJob(current.state.job, job)) return;
  const identity = yield* system.canonicalProcessStartIdentity?.(system.processId) ?? succeedUndefined;
  if (!identity) {
    yield* updateModelSetup(canonicalHome, manifest, {
      type: 'blocked',
      intentEpoch,
      nonce,
      reason: 'worker-identity-unavailable',
    });
    return;
  }
  const owner = {token: nonce, processId: system.processId, processStartIdentity: identity};
  const claimed = yield* updateModelSetup(canonicalHome, manifest, {
    type: 'claim',
    intentEpoch,
    job,
    owner,
    nonce,
    now,
  });
  const fence = {intentEpoch, job, owner};
  if (claimed.status !== 'valid' || !owns(claimed.state, fence)) return;
  const store = yield* LocalModelStore;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto | SystemInfo>();
  const stage = (phase: 'downloading' | 'verifying' | 'publishing', bytes: number) =>
    Effect.gen(function* () {
      yield* requireOwner(canonicalHome, fence);
      const changed = yield* updateModelSetup(canonicalHome, manifest, {
        type: 'progress',
        fence,
        bytes,
        phase: phase === 'downloading' ? 'downloading' : 'verifying',
      });
      if (changed.status !== 'valid' || !owns(changed.state, fence)) return yield* SetupCancelled.make({});
    }).pipe(Effect.provide(services));
  const work = Effect.gen(function* () {
    yield* requireOwner(canonicalHome, fence);
    const reason = yield* eligibilityReason(manifest);
    if (reason) {
      yield* updateModelSetup(canonicalHome, manifest, {type: 'action-required', fence, reason});
      return;
    }
    const installed = yield* store.install(canonicalHome, manifest, {onStage: stage, requireKnownDiskSpace: true});
    yield* requireOwner(canonicalHome, fence);
    const fileIdentity = installed.fileIdentity;
    const currentIdentity = yield* modelSetupFileIdentity(installed.path);
    if (
      !installed.verified ||
      !fileIdentity ||
      !currentIdentity ||
      !sameModelSetupFile(fileIdentity, currentIdentity) ||
      fileIdentity.size !== String(manifest.size)
    )
      return yield* ModelSetupError.make({message: 'Could not bind verified artifact identity.'});
    yield* updateModelSetup(canonicalHome, manifest, {
      type: 'ready',
      fence,
      receipt: {sha256: manifest.sha256, fileIdentity},
    });
  });
  const monitor = Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(250);
      const state = yield* requireOwner(canonicalHome, fence);
      if (state.phase === 'downloading') {
        const status = yield* store.status(canonicalHome, manifest);
        yield* updateModelSetup(canonicalHome, manifest, {type: 'progress', fence, bytes: status.partialBytes});
      }
    }
  });
  const program = Effect.raceFirst(work, monitor).pipe(
    Effect.timeout(WORKER_LIFETIME_MILLISECONDS),
    Effect.catch(error =>
      Effect.gen(function* () {
        const currentOwner = yield* readModelSetup(canonicalHome);
        if (currentOwner.status !== 'valid' || !owns(currentOwner.state, fence)) return;
        const failure = failureReason(error);
        const timestamp = yield* Clock.currentTimeMillis;
        const random = yield* Crypto.Crypto;
        const entropy = yield* random.randomBytes(1);
        yield* updateModelSetup(
          canonicalHome,
          manifest,
          failure.retryable
            ? {
                type: 'retry-wait',
                fence,
                reason: failure.reason,
                nextAttemptAt: timestamp + modelSetupRetryDelay(currentOwner.state.attempts, entropy[0] / 255),
              }
            : {type: 'action-required', fence, reason: failure.reason},
        );
      }),
    ),
  );
  yield* withStandaloneProcessLease(program);
});

export function parseModelSetupWorkerArguments(
  arguments_: readonly string[],
): {readonly home: string; readonly intentEpoch: number; readonly nonce: string} | undefined {
  if (
    arguments_.length !== 6 ||
    arguments_[0] !== '--home' ||
    arguments_[2] !== '--epoch' ||
    arguments_[4] !== '--nonce'
  )
    return undefined;
  const [, home, , epoch, , nonce] = arguments_;
  const intentEpoch = Number(epoch);
  if (
    !home ||
    !/^(0|[1-9][0-9]*)$/.test(epoch) ||
    !Number.isSafeInteger(intentEpoch) ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(nonce)
  )
    return undefined;
  return {home, intentEpoch, nonce};
}

export function isModelSetupCommand(arguments_: readonly string[]): boolean {
  const positionals: string[] = [];
  for (let index = 0; index < arguments_.length && positionals.length < 2; index += 1) {
    const argument = arguments_[index];
    if (argument === '--home' || argument === '--manifest') {
      index += 1;
      continue;
    }
    if (!argument.startsWith('-')) positionals.push(argument);
  }
  return positionals[0] === 'models' && positionals[1] === 'setup';
}

export interface ModelSetupCommandOptions {
  readonly status?: boolean;
  readonly json?: boolean;
  readonly dryRun?: boolean;
  readonly auto?: string;
  readonly retry?: boolean;
}

export const runModelSetupCommand = Effect.fn('models.setup.command')(function* (
  config: RuntimeConfig,
  options: ModelSetupCommandOptions,
) {
  if (
    (options.status && (options.auto !== undefined || options.retry)) ||
    (options.auto !== undefined && options.retry) ||
    (options.auto !== undefined && options.auto !== 'on' && options.auto !== 'off')
  )
    return yield* ModelSetupError.make({message: 'Use one of --status, --auto on|off, or --retry.'});
  const status =
    options.status || options.dryRun
      ? yield* readModelSetupStatus(config.agentContextHome)
      : options.auto !== undefined
        ? yield* setModelSetupPolicy(config.agentContextHome, options.auto === 'on')
        : yield* requestModelSetup(config.agentContextHome, {retry: options.retry});
  yield* Console.log(
    options.json
      ? JSON.stringify(status)
      : `${options.dryRun ? 'Would request setup; current status: ' : ''}${status.modelId}: ${status.phase}${status.reason ? ` (${status.reason})` : ''}; automatic setup ${status.policy === 'off' ? 'off' : 'on'}.`,
  );
}, Effect.mapError(modelSetupPublicError));
