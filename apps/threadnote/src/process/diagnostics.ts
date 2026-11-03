import {
  BackgroundInferenceAdmission,
  type BackgroundInferenceAdmissionUnavailable,
} from '@threadnote/inference/background/admission';
import {SecureRandom} from 'effect/crypto';
import {Array as EffectArray} from 'effect';
import {Clock, Console, DateTime, Effect, Fiber, FileSystem, Option, Path, Schema, Semaphore} from 'effect';
import {writeFinalCliOutput} from '../effect/cli/output.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  runtimeTextDirectoryNamePage,
  SystemInfo,
  processCpuObservation,
  type ProcessCpuObservation,
  type TimedProcessResourceCounters,
  type ProcessResourceCounters,
} from '@threadnote/platform/system';
import {readLiveStandaloneProcessLeases} from './standalone_lease.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {orderThreadnoteProcessesByAttention} from './attention.js';
import {observeProcessInstanceIdentity, processInstanceIdentityMatches} from './process_identity.js';
import {createMissingProcessFile, linkMissingProcessFile} from './owned_file.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {succeedUndefined} from '@threadnote/platform/optional';

const PROCESS_DIAGNOSTICS_SCHEMA_VERSION = 1;
const PROCESS_DIAGNOSTICS_LIMIT = 100;
const PROCESS_DIAGNOSTICS_SCAN_LIMIT = 256;
const PROCESS_REGISTRATION_LIMIT_BYTES = 16 * 1024;
const PROCESS_REGISTRATION_RECONCILE_MILLISECONDS = 30_000;
const PROCESS_REGISTRATION_REPAIR_WARNING_LIMIT = 3;
const SAFE_OPERATION = /^[a-z][a-z0-9-]{0,47}$/;

/** Stream the private registration directory, retaining at most the scan cap. */
export const readBoundedProcessRegistrationNames = Effect.fn('processDiagnostics.boundedNames')(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(directory))) return {names: [] as string[], truncated: false};
  const page = yield* runtimeTextDirectoryNamePage(directory, PROCESS_DIAGNOSTICS_SCAN_LIMIT).pipe(Effect.orDie);
  const names = page.names;
  return {
    names: EffectArray.filter(
      names,
      (name, __effectArrayIndex) => __effectArrayIndex in names && /^[1-9]\d*\.json$/.test(name),
    ).sort(),
    truncated: page.overflow,
  };
});

export type ThreadnoteProcessRole =
  | 'cli'
  | 'graph-builder'
  | 'graph-embedding-worker'
  | 'graph-compaction-worker'
  | 'graph-diagnostics-worker'
  | 'graph-parser-worker'
  | 'graph-query-worker'
  | 'graph-waiter'
  | 'integration-sync-worker'
  | 'legacy'
  | 'local-model-worker'
  | 'manager'
  | 'mcp'
  | 'mcp-broker';
export type RegisteredThreadnoteProcessRole = Exclude<ThreadnoteProcessRole, 'legacy'>;

export interface ThreadnoteProcessClientInfo {
  readonly name: string;
  readonly version?: string;
}
export type ThreadnoteProcessWorkspace =
  | {readonly state: 'active' | 'last'; readonly path: string; readonly observedAt: string}
  | {readonly state: 'multiple'; readonly observedAt: string};
export type ThreadnoteProcessBranch =
  | {readonly state: 'branch'; readonly name: string}
  | {readonly state: 'detached'; readonly commit: string}
  | {readonly state: 'unavailable'};
export interface ThreadnoteProcessDisplayContext {
  readonly launchDirectory?: string;
  readonly processDirectory?: string;
  readonly workspace?: ThreadnoteProcessWorkspace;
  readonly client?: ThreadnoteProcessClientInfo;
  readonly owner?: {readonly processId: number; readonly role: RegisteredThreadnoteProcessRole};
  readonly branch?: ThreadnoteProcessBranch;
}

interface ProcessRegistrationFile {
  readonly baseRole: RegisteredThreadnoteProcessRole;
  readonly currentOperation?: string;
  readonly parentProcessId: number;
  readonly parentProcessStartIdentity?: string;
  readonly displayContext?: ThreadnoteProcessDisplayContext;
  readonly processId: number;
  readonly processStartIdentity?: string;
  readonly role: RegisteredThreadnoteProcessRole;
  readonly schemaVersion: typeof PROCESS_DIAGNOSTICS_SCHEMA_VERSION;
  readonly startedAt: string;
  readonly token: string;
  readonly updatedAt: string;
}

export interface ThreadnoteProcessDiagnostic {
  readonly activityRole?: RegisteredThreadnoteProcessRole;
  readonly ageMilliseconds: number;
  readonly currentOperation?: string;
  readonly cpu?: ProcessCpuObservation;
  readonly displayContext?: ThreadnoteProcessDisplayContext;
  readonly parentProcessId: number;
  readonly parentRole?: ThreadnoteProcessRole;
  readonly processId: number;
  readonly releaseVersion?: string;
  readonly role: ThreadnoteProcessRole;
  readonly rssBytes?: number;
  readonly startedAt: string;
}

export interface ThreadnoteProcessDiagnostics {
  readonly processes: readonly ThreadnoteProcessDiagnostic[];
  readonly schemaVersion: typeof PROCESS_DIAGNOSTICS_SCHEMA_VERSION;
  readonly truncated: boolean;
}

export interface ManageableThreadnoteProcessDiagnostic extends ThreadnoteProcessDiagnostic {
  readonly processRef?: string;
  readonly terminationBlockedReason?: 'current-manager' | 'identity-unverified' | 'legacy-process';
  readonly terminable: boolean;
}

export interface ManageableThreadnoteProcessDiagnostics {
  readonly processes: readonly ManageableThreadnoteProcessDiagnostic[];
  readonly schemaVersion: typeof PROCESS_DIAGNOSTICS_SCHEMA_VERSION;
  readonly truncated: boolean;
}

export type ThreadnoteProcessTerminationErrorCode =
  | 'current-manager'
  | 'invalid-process-target'
  | 'process-not-found'
  | 'process-permission-denied'
  | 'process-signal-failed'
  | 'process-stale';

export class ThreadnoteProcessTerminationError extends Schema.TaggedError<
  ThreadnoteProcessTerminationError,
  {readonly brand: unique symbol}
>()('ThreadnoteProcessTerminationError', {
  code: Schema.String,
  message: Schema.String,
}) {
  static of(code: ThreadnoteProcessTerminationErrorCode, message: string): ThreadnoteProcessTerminationError {
    return ThreadnoteProcessTerminationError.make({code, message});
  }
}

export interface ThreadnoteProcessTerminationResult {
  readonly processId: number;
  readonly state: 'signaled' | 'terminated';
}

export interface ThreadnoteProcessTerminationTarget {
  readonly processId: number;
  readonly processRef: string;
}

export interface ThreadnoteProcessTerminationOptions {
  readonly gracefulWaitMilliseconds?: number;
  readonly forceWaitMilliseconds?: number;
}

interface ActiveProcessRegistration {
  readonly baseOperation?: string;
  readonly baseRole: RegisteredThreadnoteProcessRole;
  readonly directory: string;
  readonly file: string;
  readonly fileSystem: FileSystem.FileSystem;
  idleWriteFiber?: Fiber.Fiber<void>;
  ownershipLost: boolean;
  repairFailures: number;
  repairFailureReported: boolean;
  readonly parentProcessId: number;
  readonly parentProcessStartIdentity?: string;
  readonly launchDirectory?: string;
  client?: ThreadnoteProcessClientInfo;
  lastWorkspace?: Extract<ThreadnoteProcessWorkspace, {readonly path: string}>;
  readonly processId: number;
  readonly processStartIdentity?: string;
  queuedStateKey?: string;
  readonly originalTitle: string;
  readonly path: Path.Path;
  readonly startedAt: string;
  readonly token: string;
  readonly writeSemaphore: Semaphore.Semaphore;
}

interface ProcessActivity {
  readonly operation: string;
  readonly role: RegisteredThreadnoteProcessRole;
  readonly sequence: number;
  readonly workingDirectory?: string;
  readonly startedAt: string;
}

let registration = Option.none<ActiveProcessRegistration>();
const activities = new Map<symbol, ProcessActivity>();
let activitySequence = 0;

export interface ThreadnoteProcessActivityOptions {
  /** Keep a completed activity visible briefly so adjacent identical work can be coalesced. */
  readonly idleTransitionDelayMilliseconds?: number;
  readonly workingDirectory?: string;
}

export const threadnoteHomeForProcess = Effect.fn('processDiagnostics.home')(function* (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const inline = Effect2.pipe(
    Option.getOrUndefined(
      EffectArray.findFirst(
        arguments_,
        __effectArrayValue =>
          !!(argument => Effect2.pipe(argument, EffectString.startsWith('--home=')))(__effectArrayValue),
      ),
    ),
    effectOptionalString =>
      effectOptionalString == null
        ? undefined
        : Effect2.pipe(effectOptionalString, EffectString.slice('--home='.length)),
  );
  const flagIndex = Option.getOrElse(
    EffectArray.findFirstIndex(arguments_, argument => argument === '--home'),
    () => -1,
  );
  const configured = inline || (flagIndex >= 0 ? arguments_[flagIndex + 1] : undefined) || environment.THREADNOTE_HOME;
  const candidate = configured || path.join(system.homeDirectory, '.threadnote');
  if (candidate === '~') return system.homeDirectory;
  if (
    Effect2.pipe(candidate, EffectString.startsWith('~/')) ||
    Effect2.pipe(candidate, EffectString.startsWith('~\\'))
  ) {
    return path.join(system.homeDirectory, Effect2.pipe(candidate, EffectString.slice(2)));
  }
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(environment.THREADNOTE_CALLER_CWD ?? system.currentDirectory(), candidate);
});

export function withThreadnoteProcessRegistration<A, E, R>(
  home: string,
  baseRole: RegisteredThreadnoteProcessRole,
  effect: Effect.Effect<A, E, R>,
  baseOperation?: string,
): Effect.Effect<
  A,
  E | BackgroundInferenceAdmissionUnavailable,
  R | SystemInfo | FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
> {
  return Effect.acquireUseRelease(
    registerThreadnoteProcess(home, baseRole, baseOperation),
    active =>
      Effect.scoped(
        Effect.gen(function* () {
          if (Option.isSome(active)) {
            yield* Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep(PROCESS_REGISTRATION_RECONCILE_MILLISECONDS);
                yield* writeCurrentRegistration(true).pipe(Effect.ignore);
              }
            }).pipe(Effect.forkScoped({startImmediately: true}));
          }
          const admission = yield* Effect.serviceOption(BackgroundInferenceAdmission);
          return yield* baseRole === 'cli' &&
          baseOperation !== 'workflow-watch-collector' &&
          baseOperation !== 'recall-embedding' &&
          Option.isSome(admission)
            ? admission.value.withForeground(home, effect)
            : effect;
        }),
      ),
    active => unregisterThreadnoteProcess(active),
  );
}

/**
 * Register a worker whose top-level runner deliberately retains the host's
 * default signal behavior. Registration itself installs no signal handlers.
 */
export function withSignalTransparentThreadnoteWorkerRegistration<A, E, R>(
  home: string,
  role: Extract<
    RegisteredThreadnoteProcessRole,
    'graph-compaction-worker' | 'graph-diagnostics-worker' | 'graph-query-worker'
  >,
  operation: string,
  effect: Effect.Effect<A, E, R>,
) {
  return withThreadnoteProcessRegistration(home, role, effect, operation);
}

export function withThreadnoteProcessActivity<A, E, R>(
  role: RegisteredThreadnoteProcessRole,
  operation: string,
  effect: Effect.Effect<A, E, R>,
  options: ThreadnoteProcessActivityOptions = {},
): Effect.Effect<A, E, R> {
  const safeOperation = SAFE_OPERATION.test(operation) ? operation : 'unknown';
  const idleTransitionDelayMilliseconds = positiveSafeInteger(options.idleTransitionDelayMilliseconds);
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      yield* cancelIdleRegistrationWrite();
      const token = Symbol(role);
      activities.set(token, {
        operation: safeOperation,
        role,
        sequence: ++activitySequence,
        workingDirectory: safeDisplayPath(options.workingDirectory),
        startedAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* writeCurrentRegistration().pipe(Effect.ignore);
      return token;
    }),
    () => effect,
    token =>
      Effect.gen(function* () {
        const completed = activities.get(token);
        if (completed?.workingDirectory && Option.isSome(registration))
          registration.value.lastWorkspace = {
            state: 'last',
            path: completed.workingDirectory,
            observedAt: DateTime.formatIso(yield* DateTime.now),
          };
        activities.delete(token);
        if (idleTransitionDelayMilliseconds === 0) {
          yield* writeCurrentRegistration().pipe(Effect.ignore);
        } else {
          yield* scheduleIdleRegistrationWrite(idleTransitionDelayMilliseconds);
        }
      }),
  );
}

export function sanitizeThreadnoteProcessClientInfo(value: unknown): ThreadnoteProcessClientInfo | undefined {
  if (typeof value !== 'object' || value === null || !('name' in value)) return undefined;
  const name = safeDisplayText(value.name, 128);
  if (!name || name === 'unknown') return undefined;
  const version = 'version' in value ? safeDisplayText(value.version, 128) : undefined;
  return {name, ...(version ? {version} : {})};
}

export const setThreadnoteProcessClientInfo = Effect.fn('processDiagnostics.clientInfo')(function* (value: unknown) {
  if (Option.isNone(registration)) return;
  const client = sanitizeThreadnoteProcessClientInfo(value);
  if (!client) return;
  registration.value.client = client;
  yield* writeCurrentRegistration().pipe(Effect.ignore);
});

export function withThreadnoteProcessRequestContext<A, E, R>(
  input: {
    readonly callerCwd?: unknown;
    readonly clientInfo?: unknown;
    readonly transport: 'stdio' | 'http';
    readonly operation: string;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    if (input.transport !== 'stdio' || Option.isNone(registration) || registration.value.baseRole !== 'mcp')
      return yield* effect;
    yield* setThreadnoteProcessClientInfo(input.clientInfo);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const candidate = safeDisplayPath(input.callerCwd);
    const workingDirectory =
      candidate && path.isAbsolute(candidate)
        ? yield* fs.realPath(candidate).pipe(
            Effect.flatMap(real =>
              fs.stat(real).pipe(Effect.map(info => (info.type === 'Directory' ? safeDisplayPath(real) : undefined))),
            ),
            Effect.timeoutOrElse({duration: 100, orElse: () => succeedUndefined}),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
    return yield* withThreadnoteProcessActivity(
      'mcp',
      Effect2.pipe(input.operation, EffectString.replaceAll('_', '-')),
      effect,
      {workingDirectory},
    );
  });
}

const readThreadnoteProcessSnapshot = Effect.fn('processDiagnostics.readSnapshot')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  selection: 'attention' | 'chronological' = 'chronological',
  resources = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;

  // Standalone release leases are acquired immediately before runtime process
  // registration. Observe leases first so a process that finishes registering
  // during this snapshot is classified from its registry row instead of being
  // reported transiently as a pre-registry release.
  const releaseLeaseDiagnostics = yield* readLiveStandaloneProcessLeases().pipe(
    Effect.orElseSucceed(() => ({leases: [] as const, truncated: false})),
  );
  const releaseLeases = releaseLeaseDiagnostics.leases;

  const directory = processDiagnosticsDirectory(path, config.agentContextHome);
  // Bound enumeration before allocating names. A larger registry is reported
  // as truncated so live sampling can decline complete coverage.
  const scan = yield* readBoundedProcessRegistrationNames(directory).pipe(
    Effect.catchCause(() => Effect.succeed({names: [] as string[], truncated: true})),
  );
  const candidateNames = scan.names;
  const files = yield* Effect.forEach(
    candidateNames,
    name =>
      readRegistrationFile(fs, path.join(directory, name)).pipe(
        Effect.map(value => ({file: path.join(directory, name), value})),
      ),
    {concurrency: 8},
  );
  const live: ProcessRegistrationFile[] = [];
  const observedIdentities = new Map<number, string | undefined>();
  for (const candidate of files) {
    if (Option.isNone(candidate.value)) {
      yield* removeRegistrationFile(fs, candidate.file);
      continue;
    }
    const value = candidate.value.value;
    const running = system.isProcessRunning(value.processId);
    const identity = running ? yield* observeProcessInstanceIdentity(system, value.processId) : undefined;
    const identityMatches = processInstanceIdentityMatches(value.processStartIdentity, identity);
    if (!running || !identityMatches) {
      yield* removeRegistrationFile(fs, candidate.file);
      continue;
    }
    const kept =
      identity !== undefined && value.processStartIdentity !== undefined && value.processStartIdentity !== identity
        ? {...value, processStartIdentity: identity}
        : value;
    if (kept !== value) {
      yield* fs
        .writeFileString(candidate.file, `${JSON.stringify(kept, undefined, 2)}\n`, {mode: 0o600})
        .pipe(Effect.ignore);
    }
    live.push(kept);
    observedIdentities.set(kept.processId, identity);
  }

  // Standalone releases before the runtime registry still retain a private,
  // PID/start-identity-bound lease so updates do not delete their executable.
  // Merge only that bounded installation evidence; never inspect or expose
  // arbitrary process command lines, which may contain memory text or paths.
  const releaseLeaseByProcess = new Map(EffectArray.map(releaseLeases, lease => [lease.processId, lease] as const));
  const registeredProcessIds = new Set(EffectArray.map(live, value => value.processId));
  const now = yield* Clock.currentTimeMillis;
  const legacy = EffectArray.map(
    EffectArray.filter(releaseLeases, lease => !registeredProcessIds.has(lease.processId)),
    lease => {
      const startedAt = Option.getOrElse(lease.startedAt, () => new Date(now).toISOString());
      return {
        ageMilliseconds: Math.max(0, now - Date.parse(startedAt)),
        parentProcessId: Option.getOrElse(lease.parentProcessId, () => 0),
        processId: lease.processId,
        releaseVersion: lease.version,
        role: 'legacy' as const,
        startedAt,
      };
    },
  );

  // ROLE stays the registered identity of the process. A nested activity is
  // reported separately so a dedicated graph build is still obvious without an
  // MCP or CLI process appearing to be a graph daemon it never was.
  const roleByProcess = new Map(EffectArray.map(live, value => [value.processId, value.baseRole] as const));
  const registrationByProcess = new Map(EffectArray.map(live, value => [value.processId, value] as const));
  const current = EffectArray.map(
    live.sort(
      (left, right) =>
        Effect2.pipe(left.startedAt, EffectString.localeCompare(right.startedAt)) || left.processId - right.processId,
    ),
    value => ({
      ...(value.role === value.baseRole ? {} : {activityRole: value.role}),
      ageMilliseconds: Math.max(0, now - Date.parse(value.startedAt)),
      ...(value.currentOperation === undefined ? {} : {currentOperation: value.currentOperation}),
      displayContext: inheritedDisplayContext(value, registrationByProcess, observedIdentities),
      parentProcessId: value.parentProcessId,
      ...(roleByProcess.get(value.parentProcessId) === undefined
        ? {}
        : {parentRole: roleByProcess.get(value.parentProcessId)}),
      processId: value.processId,
      ...(releaseLeaseByProcess.get(value.processId) === undefined
        ? {}
        : {releaseVersion: releaseLeaseByProcess.get(value.processId)!.version}),
      role: value.baseRole,
      startedAt: value.startedAt,
    }),
  );
  const candidates = [...current, ...legacy].sort(
    (left, right) =>
      Effect2.pipe(left.startedAt, EffectString.localeCompare(right.startedAt)) || left.processId - right.processId,
  );
  // Bound the OS memory query to the same privacy-safe rows the command can
  // return. A damaged private lease tree must not turn diagnostics into an
  // unbounded command line or PowerShell query.
  const selected = (selection === 'attention' ? orderThreadnoteProcessesByAttention(candidates) : candidates).slice(
    0,
    PROCESS_DIAGNOSTICS_LIMIT,
  );
  const identities = new Map(EffectArray.map(live, value => [value.processId, value.processStartIdentity] as const));
  const resourceByProcess = resources
    ? yield* sampleProcessResources(system, config.agentContextHome, selected, identities)
    : new Map<number, ResourceDisplay>();
  if (
    EffectArray.some(selected, value => value.processId === system.processId) &&
    resources &&
    resourceByProcess.get(system.processId)?.rssBytes === undefined
  ) {
    const rssBytes = system.memoryUsage().rss;
    if (Number.isSafeInteger(rssBytes) && rssBytes >= 0)
      resourceByProcess.set(system.processId, {...resourceByProcess.get(system.processId), rssBytes});
  }
  const contextual = EffectArray.map(selected, (value): ThreadnoteProcessDiagnostic => {
    const {workingDirectory, ...metrics} = resourceByProcess.get(value.processId) ?? {};
    const context = 'displayContext' in value ? value.displayContext : undefined;
    return {
      ...value,
      ...metrics,
      ...(workingDirectory ? {displayContext: {...context, processDirectory: workingDirectory}} : {}),
    };
  });
  const branchByPath = resources ? yield* readDisplayBranches(contextual) : new Map<string, ThreadnoteProcessBranch>();
  const sorted = EffectArray.map(contextual, value => ({
    ...value,
    ...('displayContext' in value && value.displayContext
      ? {
          displayContext: {
            ...value.displayContext,
            branch: branchByPath.get(displayWorkspacePath(value.displayContext) ?? ''),
          },
        }
      : {}),
  }));
  const diagnostics = {
    processes: sorted,
    schemaVersion: PROCESS_DIAGNOSTICS_SCHEMA_VERSION,
    truncated:
      releaseLeaseDiagnostics.truncated || live.length + legacy.length > PROCESS_DIAGNOSTICS_LIMIT || scan.truncated,
  } satisfies ThreadnoteProcessDiagnostics;
  return {diagnostics, registrations: new Map(EffectArray.map(live, value => [value.processId, value] as const))};
});

export const readThreadnoteProcessDiagnostics = Effect.fn('processDiagnostics.read')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  return (yield* readThreadnoteProcessSnapshot(config)).diagnostics;
});

/**
 * Adds an opaque, instance-bound control reference only when the private
 * registration and the host's process-start identity agree. The registration
 * token and start identity never leave this module.
 */
export const readManageableThreadnoteProcessDiagnostics = Effect.fn('processDiagnostics.readManageable')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  options: {readonly resources?: boolean} = {},
) {
  const system = yield* SystemInfo;
  const snapshot = yield* readThreadnoteProcessSnapshot(config, 'attention', options.resources ?? true);
  const diagnostics = snapshot.diagnostics;
  const processes: ManageableThreadnoteProcessDiagnostic[] = yield* Effect.forEach(
    diagnostics.processes,
    process =>
      Effect.gen(function* () {
        if (process.role === 'legacy') {
          return {
            ...process,
            terminable: false,
            terminationBlockedReason: 'legacy-process' as const,
          };
        }
        const value = snapshot.registrations.get(process.processId);
        const verified = value === undefined ? false : yield* registrationMatchesRunningProcess(system, value);
        if (!verified || value === undefined) {
          return {
            ...process,
            terminable: false,
            terminationBlockedReason: 'identity-unverified' as const,
          };
        }
        if (process.processId === system.processId) {
          return {
            ...process,
            terminable: false,
            terminationBlockedReason: 'current-manager' as const,
          };
        }
        return {
          ...process,
          processRef: processReference(value),
          terminable: true,
        };
      }),
    {concurrency: 8},
  );
  return {...diagnostics, processes} satisfies ManageableThreadnoteProcessDiagnostics;
});

/** Terminate only the exact registered process instance selected by the caller. */
export const terminateThreadnoteProcess = Effect.fn('processDiagnostics.terminate')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  target: ThreadnoteProcessTerminationTarget,
  options: ThreadnoteProcessTerminationOptions = {},
) {
  const system = yield* SystemInfo;
  if (!Number.isSafeInteger(target.processId) || target.processId <= 0 || !isProcessReference(target.processRef)) {
    return yield* ThreadnoteProcessTerminationError.of('invalid-process-target', 'The process target is invalid.');
  }
  if (target.processId === system.processId) {
    return yield* ThreadnoteProcessTerminationError.of(
      'current-manager',
      'The current Manager process cannot terminate itself.',
    );
  }

  const first = yield* resolveTerminationTarget(config, target);
  yield* signalVerifiedProcess(system, first, 'SIGTERM');
  const gracefulWaitMilliseconds = boundedTerminationWait(options.gracefulWaitMilliseconds, 2_000);
  if (yield* waitForProcessExit(system, first, gracefulWaitMilliseconds)) {
    return {processId: target.processId, state: 'terminated'} satisfies ThreadnoteProcessTerminationResult;
  }

  // Re-read the private registration and the OS start identity immediately
  // before escalation. A replacement that reused the PID must never receive
  // the second signal.
  const second = yield* resolveTerminationTarget(config, target);
  yield* signalVerifiedProcess(system, second, 'SIGKILL');
  const forceWaitMilliseconds = boundedTerminationWait(options.forceWaitMilliseconds, 1_000);
  return {
    processId: target.processId,
    state: (yield* waitForProcessExit(system, second, forceWaitMilliseconds)) ? 'terminated' : 'signaled',
  } satisfies ThreadnoteProcessTerminationResult;
});

export const runProcessDiagnostics = Effect.fn('processDiagnostics.run')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  options: {readonly json?: boolean},
) {
  const system = yield* SystemInfo;
  let observed = yield* readThreadnoteProcessDiagnostics(config);
  if (
    system.processResourceCounters &&
    EffectArray.some(
      observed.processes,
      value => value.processId !== system.processId && value.cpu?.state === 'sampling',
    )
  ) {
    yield* Effect.sleep(500);
    observed = yield* readThreadnoteProcessDiagnostics(config);
  }
  const diagnostics: ThreadnoteProcessDiagnostics = {
    ...observed,
    processes: EffectArray.filter(observed.processes, process => process.processId !== system.processId),
  };
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(diagnostics));
    return;
  }
  if (diagnostics.processes.length === 0) {
    yield* Console.log('No live Threadnote processes found.');
    return;
  }
  yield* Console.log(renderProcessDiagnosticsTable(diagnostics.processes));
  if (EffectArray.some(diagnostics.processes, process => process.role === 'legacy')) {
    yield* Console.log(
      'Legacy entries predate runtime registration; restart their owning agent sessions to retire old releases safely.',
    );
  }
  if (diagnostics.truncated) yield* Console.log(`Showing the first ${PROCESS_DIAGNOSTICS_LIMIT} live processes.`);
});

export function renderProcessDiagnosticsTable(processes: readonly ThreadnoteProcessDiagnostic[]): string {
  const rows = [
    ['PID', 'PPID', 'ROLE', 'VERSION', 'AGE', 'CPU', 'RSS', 'OPERATION'],
    ...EffectArray.map(processes, process => [
      String(process.processId),
      process.parentProcessId === 0 ? '-' : String(process.parentProcessId),
      process.activityRole === undefined ? process.role : `${process.role} (${process.activityRole})`,
      process.releaseVersion ?? '-',
      formatDuration(process.ageMilliseconds),
      process.cpu?.state === 'sampled'
        ? `${process.cpu.percent.toFixed(1)}%`
        : process.cpu?.state === 'sampling'
          ? 'sampling'
          : 'unavailable',
      process.rssBytes === undefined ? 'unknown' : formatBytes(process.rssBytes),
      process.currentOperation ?? '-',
    ]),
  ];
  const widths = EffectArray.map(rows[0], (_, column) => Math.max(...EffectArray.map(rows, row => row[column].length)));
  return EffectArray.join(
    EffectArray.map(rows, row =>
      EffectArray.join(
        EffectArray.map(row, (value, column) =>
          column === row.length - 1 ? value : Effect2.pipe(value, EffectString.padEnd(widths[column] + 2)),
        ),
        '',
      ),
    ),
    '\n',
  );
}

export const legacyProcessDoctorCheck = Effect.fn('processDiagnostics.doctorCheck')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const diagnostics = yield* readThreadnoteProcessDiagnostics(config);
  const legacy = EffectArray.filter(diagnostics.processes, process => process.role === 'legacy');
  if (legacy.length === 0) {
    return {
      detail: 'no unregistered standalone processes detected',
      name: 'standalone process lifecycle',
      status: 'ok' as const,
    };
  }
  const versions = EffectArray.join(
    [
      ...new Set(EffectArray.flatMap(legacy, process => (process.releaseVersion ? [process.releaseVersion] : []))),
    ].sort(),
    ', ',
  );
  return {
    detail:
      `${legacy.length} live pre-registry process(es)${versions ? ` from ${versions}` : ''}; ` +
      'restart their owning agent sessions to retire old releases safely',
    name: 'standalone process lifecycle',
    status: 'warn' as const,
  };
});

function registerThreadnoteProcess(home: string, baseRole: RegisteredThreadnoteProcessRole, baseOperation?: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const crypto = yield* SecureRandom.SecureRandom;
    const writeSemaphore = yield* Semaphore.make(1);
    const directory = processDiagnosticsDirectory(path, home);
    const launchCandidate =
      safeDisplayPath(system.environment().THREADNOTE_CALLER_CWD) ?? safeDisplayPath(system.currentDirectory());
    const launchDirectory =
      launchCandidate && path.isAbsolute(launchCandidate)
        ? yield* fs.realPath(launchCandidate).pipe(
            Effect.flatMap(real =>
              fs.stat(real).pipe(Effect.map(info => (info.type === 'Directory' ? safeDisplayPath(real) : undefined))),
            ),
            Effect.timeoutOrElse({duration: 100, orElse: () => succeedUndefined}),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
    const active: ActiveProcessRegistration = {
      ...(baseOperation !== undefined && SAFE_OPERATION.test(baseOperation) ? {baseOperation} : {}),
      baseRole,
      directory,
      file: path.join(directory, `${system.processId}.json`),
      fileSystem: fs,
      parentProcessId: process.ppid,
      parentProcessStartIdentity: yield* observeProcessInstanceIdentity(system, process.ppid).pipe(
        Effect.timeoutOrElse({duration: 100, orElse: () => succeedUndefined}),
      ),
      launchDirectory,
      processId: system.processId,
      processStartIdentity: yield* observeProcessInstanceIdentity(system, system.processId),
      originalTitle: process.title,
      ownershipLost: false,
      repairFailures: 0,
      repairFailureReported: false,
      path,
      startedAt: DateTime.formatIso(yield* DateTime.now),
      token: yield* crypto.uuidV4(),
      writeSemaphore,
    };
    registration = Option.some(active);
    setBestEffortProcessTitle(baseRole);
    yield* reclaimStaleRegistration(active);
    yield* writeCurrentRegistration().pipe(Effect.ignore);
    return active;
  }).pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        registration = Option.none();
        activities.clear();
        return undefined;
      }),
    ),
    Effect.map(active => Option.fromUndefinedOr(active)),
  );
}

function unregisterThreadnoteProcess(active: Option.Option<ActiveProcessRegistration>) {
  return Effect.gen(function* () {
    if (Option.isNone(active)) return;
    yield* cancelIdleRegistrationWrite(active.value);
    if (Option.isSome(registration) && registration.value.token === active.value.token) registration = Option.none();
    activities.clear();
    setBestEffortProcessTitleValue(active.value.originalTitle);
    yield* active.value.writeSemaphore.withPermit(
      Effect.gen(function* () {
        if (active.value.ownershipLost) return;
        const current = yield* readRegistrationFile(active.value.fileSystem, active.value.file);
        if (Option.isSome(current) && current.value.token === active.value.token) {
          yield* active.value.fileSystem.remove(active.value.file, {force: true});
        }
      }),
    );
  }).pipe(Effect.ignore);
}

function writeCurrentRegistration(missingOnly = false): Effect.Effect<void, unknown> {
  return Effect.suspend(() => {
    if (Option.isNone(registration)) return Effect.void;
    const active = registration.value;
    return active.writeSemaphore.withPermit(
      Effect.gen(function* () {
        if (active.ownershipLost || Option.isNone(registration) || registration.value.token !== active.token) return;
        const exists = yield* active.fileSystem.exists(active.file);
        if (exists) {
          const stored = yield* readRegistrationFileStrict(active.fileSystem, active.file);
          if (Option.isNone(stored) || stored.value.token !== active.token) {
            active.ownershipLost = true;
            return;
          }
          active.repairFailures = 0;
          if (missingOnly) return;
        }
        const current = currentProcessActivity();
        const role = current?.role ?? active.baseRole;
        setBestEffortProcessTitle(role);
        const currentOperation = current?.operation ?? active.baseOperation;
        const displayContext = currentDisplayContext(active);
        const stateKey = `${role}\0${currentOperation ?? ''}\0${JSON.stringify(displayContext)}`;
        if (active.queuedStateKey === stateKey && exists) return;
        const value: ProcessRegistrationFile = {
          baseRole: active.baseRole,
          ...(currentOperation === undefined ? {} : {currentOperation}),
          parentProcessId: active.parentProcessId,
          parentProcessStartIdentity: active.parentProcessStartIdentity,
          displayContext,
          processId: active.processId,
          processStartIdentity: active.processStartIdentity,
          role,
          schemaVersion: PROCESS_DIAGNOSTICS_SCHEMA_VERSION,
          startedAt: active.startedAt,
          token: active.token,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        active.queuedStateKey = stateKey;
        const written = yield* writeRegistrationFile(active, value, !exists).pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              if (active.queuedStateKey === stateKey) active.queuedStateKey = undefined;
              if (
                exists ||
                ++active.repairFailures < PROCESS_REGISTRATION_REPAIR_WARNING_LIMIT ||
                active.repairFailureReported
              )
                return;
              active.repairFailureReported = true;
              yield* Console.error(
                `Threadnote could not restore its process registration after ${PROCESS_REGISTRATION_REPAIR_WARNING_LIMIT} consecutive attempts; diagnostics may omit this process. ` +
                  'Repair will continue. Check filesystem write access and atomic hard-link support.',
              );
            }),
          ),
        );
        if (!written) active.ownershipLost = true;
        else active.repairFailures = 0;
      }),
    );
  });
}

function scheduleIdleRegistrationWrite(delayMilliseconds: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (Option.isNone(registration)) return;
    const active = registration.value;
    yield* cancelIdleRegistrationWrite(active);
    active.idleWriteFiber = yield* Effect.sleep(delayMilliseconds).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          active.idleWriteFiber = undefined;
          if (Option.isNone(registration) || registration.value.token !== active.token) return Effect.void;
          return writeCurrentRegistration().pipe(Effect.ignore);
        }),
      ),
      Effect.forkDetach({startImmediately: true}),
    );
  });
}

function cancelIdleRegistrationWrite(active = Option.getOrUndefined(registration)): Effect.Effect<void> {
  if (!active || active.idleWriteFiber === undefined) return Effect.void;
  const fiber = active.idleWriteFiber;
  active.idleWriteFiber = undefined;
  return Fiber.interrupt(fiber).pipe(Effect.asVoid);
}

function currentProcessActivity(): ProcessActivity | undefined {
  return [...activities.values()].sort(
    (left, right) => activityPriority(right.role) - activityPriority(left.role) || right.sequence - left.sequence,
  )[0];
}

function activityPriority(role: ProcessActivity['role']): number {
  return role === 'graph-builder' ? 3 : role === 'graph-waiter' ? 2 : 1;
}

function writeRegistrationFile(active: ActiveProcessRegistration, value: ProcessRegistrationFile, missing: boolean) {
  const temporary = active.path.join(active.directory, `.${active.processId}.${active.token}.tmp`);
  return Effect.gen(function* () {
    yield* active.fileSystem.makeDirectory(active.directory, {recursive: true, mode: 0o700});
    let content = `${JSON.stringify(value, undefined, 2)}\n`;
    // JSON escaping and duplicated paths must never make our own row unreadable.
    if (new TextEncoder().encode(content).byteLength > PROCESS_REGISTRATION_LIMIT_BYTES) {
      content = `${JSON.stringify({...value, displayContext: {...value.displayContext, launchDirectory: undefined}}, undefined, 2)}\n`;
    }
    if (new TextEncoder().encode(content).byteLength > PROCESS_REGISTRATION_LIMIT_BYTES) {
      content = `${JSON.stringify({...value, displayContext: undefined}, undefined, 2)}\n`;
    }
    if (missing) return yield* createMissingProcessFile(active.fileSystem, active.file, temporary, content);
    yield* active.fileSystem.remove(temporary, {force: true});
    yield* active.fileSystem.writeFileString(temporary, content, {mode: 0o600});
    const current = yield* readRegistrationFileStrict(active.fileSystem, active.file);
    if (Option.isNone(current) || current.value.token !== active.token) return false;
    yield* active.fileSystem.rename(temporary, active.file);
    return true;
  }).pipe(
    Effect.ensuring(missing ? Effect.void : active.fileSystem.remove(temporary, {force: true}).pipe(Effect.ignore)),
  );
}

function reclaimStaleRegistration(active: ActiveProcessRegistration) {
  const quarantine = active.path.join(active.directory, `.${active.processId}.${active.token}.reclaim`);
  let moved = false;
  let restoreQuarantine = true;
  return Effect.gen(function* () {
    const previous = yield* readRegistrationFileStrict(active.fileSystem, active.file);
    if (
      Option.isNone(previous) ||
      previous.value.processId !== active.processId ||
      processInstanceIdentityMatches(previous.value.processStartIdentity, active.processStartIdentity)
    ) {
      active.ownershipLost = true;
      return;
    }
    yield* active.fileSystem.remove(quarantine, {force: true});
    yield* Effect.uninterruptible(
      active.fileSystem.rename(active.file, quarantine).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            moved = true;
          }),
        ),
      ),
    );
    const captured = yield* readRegistrationFileStrict(active.fileSystem, quarantine);
    if (
      Option.isNone(captured) ||
      captured.value.processId !== previous.value.processId ||
      captured.value.processStartIdentity !== previous.value.processStartIdentity ||
      captured.value.token !== previous.value.token
    ) {
      active.ownershipLost = true;
      return;
    }
    restoreQuarantine = false;
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (!moved || !(yield* active.fileSystem.exists(quarantine))) return;
        if (restoreQuarantine && !(yield* active.fileSystem.exists(active.file))) {
          yield* linkMissingProcessFile(active.fileSystem, quarantine, active.file).pipe(Effect.ignore);
        }
        if (!restoreQuarantine || (yield* active.fileSystem.exists(active.file))) {
          yield* active.fileSystem.remove(quarantine, {force: true});
        }
      }).pipe(Effect.ignore),
    ),
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () =>
        Effect.sync(() => {
          if (moved) active.ownershipLost = true;
        }),
    ),
  );
}

function processDiagnosticsDirectory(path: Path.Path, home: string): string {
  return path.join(home, 'runtime', 'processes');
}

function readRegistrationFile(
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<Option.Option<ProcessRegistrationFile>> {
  return readRegistrationFileStrict(fs, file).pipe(Effect.orElseSucceed(() => Option.none()));
}

function readRegistrationFileStrict(fs: FileSystem.FileSystem, file: string) {
  return Effect.gen(function* () {
    if (Number((yield* fs.stat(file)).size) > PROCESS_REGISTRATION_LIMIT_BYTES)
      return Option.none<ProcessRegistrationFile>();
    const source = yield* fs.readFileString(file);
    return parseRegistrationFile(source);
  });
}

function parseRegistrationFile(source: string): Option.Option<ProcessRegistrationFile> {
  try {
    const value: unknown = JSON.parse(source);
    if (!isProcessRegistrationFile(value)) return Option.none();
    return Option.some({
      ...value,
      parentProcessStartIdentity: safeDisplayText(value.parentProcessStartIdentity, 256),
      displayContext: sanitizeDisplayContext(value.displayContext),
    });
  } catch {
    return Option.none();
  }
}

function isProcessRegistrationFile(value: unknown): value is ProcessRegistrationFile {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) return false;
  const candidate = value as Partial<ProcessRegistrationFile>;
  return (
    candidate.schemaVersion === PROCESS_DIAGNOSTICS_SCHEMA_VERSION &&
    isRegisteredThreadnoteProcessRole(candidate.baseRole) &&
    isRegisteredThreadnoteProcessRole(candidate.role) &&
    Number.isSafeInteger(candidate.processId) &&
    (candidate.processId ?? 0) > 0 &&
    Number.isSafeInteger(candidate.parentProcessId) &&
    (candidate.parentProcessId ?? -1) >= 0 &&
    typeof candidate.startedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.startedAt)) &&
    typeof candidate.updatedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.updatedAt)) &&
    typeof candidate.token === 'string' &&
    candidate.token.length >= 16 &&
    (candidate.currentOperation === undefined || SAFE_OPERATION.test(candidate.currentOperation)) &&
    (candidate.processStartIdentity === undefined || typeof candidate.processStartIdentity === 'string')
  );
}

function isRegisteredThreadnoteProcessRole(value: unknown): value is RegisteredThreadnoteProcessRole {
  return (
    value === 'cli' ||
    value === 'graph-builder' ||
    value === 'graph-embedding-worker' ||
    value === 'graph-compaction-worker' ||
    value === 'graph-diagnostics-worker' ||
    value === 'graph-parser-worker' ||
    value === 'graph-query-worker' ||
    value === 'graph-waiter' ||
    value === 'integration-sync-worker' ||
    value === 'local-model-worker' ||
    value === 'manager' ||
    value === 'mcp' ||
    value === 'mcp-broker'
  );
}

function safeDisplayText(value: unknown, maxBytes: number): string | undefined {
  return typeof value === 'string' &&
    Effect2.pipe(value, EffectString.trim).length > 0 &&
    !/[^\u0020-\u007e\u00a0-\u{10ffff}]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= maxBytes
    ? value
    : undefined;
}

function safeDisplayPath(value: unknown): string | undefined {
  const text = safeDisplayText(value, 4096);
  return text && /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/u.test(text) ? text : undefined;
}

function sanitizeDisplayContext(value: unknown): ThreadnoteProcessDisplayContext | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const launchDirectory = 'launchDirectory' in value ? safeDisplayPath(value.launchDirectory) : undefined;
  const client = 'client' in value ? sanitizeThreadnoteProcessClientInfo(value.client) : undefined;
  let workspace: ThreadnoteProcessWorkspace | undefined;
  const raw = 'workspace' in value ? value.workspace : undefined;
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'state' in raw &&
    'observedAt' in raw &&
    typeof raw.observedAt === 'string' &&
    Number.isFinite(Date.parse(raw.observedAt))
  ) {
    if (raw.state === 'multiple') workspace = {state: 'multiple', observedAt: raw.observedAt};
    else if ((raw.state === 'active' || raw.state === 'last') && 'path' in raw) {
      const path = safeDisplayPath(raw.path);
      if (path) workspace = {state: raw.state, path, observedAt: raw.observedAt};
    }
  }
  return launchDirectory || client || workspace ? {launchDirectory, client, workspace} : undefined;
}

function currentDisplayContext(active: ActiveProcessRegistration): ThreadnoteProcessDisplayContext {
  const work = EffectArray.filter([...activities.values()], value => value.workingDirectory !== undefined).sort(
    (a, b) => b.sequence - a.sequence,
  );
  const latest = work[0];
  const distinct = new Set(EffectArray.map(work, value => value.workingDirectory));
  const workspace: ThreadnoteProcessWorkspace | undefined = latest
    ? distinct.size > 1
      ? {state: 'multiple', observedAt: latest.startedAt}
      : {state: 'active', path: latest.workingDirectory!, observedAt: latest.startedAt}
    : active.lastWorkspace;
  return {launchDirectory: active.launchDirectory, client: active.client, workspace};
}

function inheritedDisplayContext(
  value: ProcessRegistrationFile,
  registrations: ReadonlyMap<number, ProcessRegistrationFile>,
  identities: ReadonlyMap<number, string | undefined>,
): ThreadnoteProcessDisplayContext | undefined {
  let context = value.displayContext;
  if (!value.processStartIdentity || identities.get(value.processId) !== value.processStartIdentity) return context;
  let child = value;
  const seen = new Set([value.processId]);
  for (let depth = 0; depth < 8; depth++) {
    const parent = registrations.get(child.parentProcessId);
    if (
      !parent ||
      seen.has(parent.processId) ||
      !child.parentProcessStartIdentity ||
      child.parentProcessStartIdentity !== parent.processStartIdentity ||
      identities.get(parent.processId) !== parent.processStartIdentity
    )
      break;
    seen.add(parent.processId);
    const inherited = parent.displayContext;
    if (inherited && ((!context?.client && inherited.client) || (!context?.workspace && inherited.workspace))) {
      context = {
        ...context,
        client: context?.client ?? inherited.client,
        workspace: context?.workspace ?? inherited.workspace,
        owner: {processId: parent.processId, role: parent.baseRole},
      };
    }
    child = parent;
  }
  return context;
}

function displayWorkspacePath(context: ThreadnoteProcessDisplayContext): string | undefined {
  return context.workspace?.state === 'multiple'
    ? undefined
    : (context.workspace?.path ?? context.processDirectory ?? context.launchDirectory);
}

const displayBranchCaches = new WeakMap<
  CommandExecutor['Service'],
  Map<string, {at: number; value: ThreadnoteProcessBranch}>
>();
const displayBranchGate = Semaphore.makeUnsafe(1);
function readDisplayBranches(
  processes: readonly {readonly processId: number; readonly displayContext?: ThreadnoteProcessDisplayContext}[],
) {
  return Effect.gen(function* () {
    const command = yield* Effect.serviceOption(CommandExecutor);
    if (Option.isNone(command)) return new Map<string, ThreadnoteProcessBranch>();
    const executor = command.value;
    const paths = [
      ...new Set(
        EffectArray.filter(
          EffectArray.flatMap(processes, value =>
            value.displayContext ? [displayWorkspacePath(value.displayContext)] : [],
          ),
          (value): value is string => value !== undefined,
        ),
      ),
    ].slice(0, 32);
    return yield* displayBranchGate
      .withPermit(
        Effect.gen(function* () {
          let cache = displayBranchCaches.get(executor);
          if (!cache) {
            cache = new Map();
            displayBranchCaches.set(executor, cache);
          }
          const entries = cache;
          const now = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;
          const results = yield* Effect.forEach(
            paths,
            path =>
              Effect.gen(function* () {
                const previous = entries.get(path);
                if (previous && now - previous.at >= 0 && now - previous.at < 2_000)
                  return [path, previous.value] as const;
                const options = {cwd: path, timeoutMs: 250, maxOutputBytes: 1024, allowFailure: true};
                const named = yield* executor
                  .execute('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], options)
                  .pipe(Effect.orElseSucceed(() => undefined));
                const name =
                  named?.exitCode === 0
                    ? safeDisplayText(Effect2.pipe(named.stdout, EffectString.trim), 256)
                    : undefined;
                let value: ThreadnoteProcessBranch = {state: 'unavailable'};
                if (name) value = {state: 'branch', name};
                else if (named?.exitCode === 1) {
                  const detached = yield* executor
                    .execute('git', ['rev-parse', '--short=12', 'HEAD'], options)
                    .pipe(Effect.orElseSucceed(() => undefined));
                  const commit = detached ? Effect2.pipe(detached.stdout, EffectString.trim) : undefined;
                  if (detached?.exitCode === 0 && commit && /^[0-9a-f]{7,64}$/u.test(commit))
                    value = {state: 'detached', commit};
                }
                if (entries.size >= 32 && !entries.has(path)) entries.delete(entries.keys().next().value!);
                entries.set(path, {at: now, value});
                return [path, value] as const;
              }),
            {concurrency: 4},
          );
          return new Map(results);
        }),
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: 1_000,
          orElse: () => Effect.succeed(new Map<string, ThreadnoteProcessBranch>()),
        }),
      );
  });
}

function processReference(value: ProcessRegistrationFile): string {
  return `tnp_${sha256HexSync(
    `${PROCESS_DIAGNOSTICS_SCHEMA_VERSION}\0${value.processId}\0${value.processStartIdentity ?? ''}\0${value.token}`,
  )}`;
}

function isProcessReference(value: string): boolean {
  return /^tnp_[0-9a-f]{64}$/.test(value);
}

function registrationMatchesRunningProcess(system: SystemInfo['Service'], value: ProcessRegistrationFile) {
  return Effect.gen(function* () {
    if (!system.isProcessRunning(value.processId) || value.processStartIdentity === undefined) return false;
    const identity = yield* observeProcessInstanceIdentity(system, value.processId);
    return identity === value.processStartIdentity;
  });
}

function resolveTerminationTarget(
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  target: ThreadnoteProcessTerminationTarget,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const candidate = yield* readRegistrationFile(
      fs,
      path.join(processDiagnosticsDirectory(path, config.agentContextHome), `${target.processId}.json`),
    );
    const value = Option.getOrUndefined(candidate);
    if (!system.isProcessRunning(target.processId)) {
      return yield* ThreadnoteProcessTerminationError.of(
        'process-not-found',
        'The selected Threadnote process has exited.',
      );
    }
    if (
      value === undefined ||
      value.processId !== target.processId ||
      value.processStartIdentity === undefined ||
      processReference(value) !== target.processRef ||
      !(yield* registrationMatchesRunningProcess(system, value))
    ) {
      return yield* ThreadnoteProcessTerminationError.of(
        'process-stale',
        'The selected process instance changed. Refresh the process list and try again.',
      );
    }
    return value;
  });
}

function signalVerifiedProcess(
  system: SystemInfo['Service'],
  registration: ProcessRegistrationFile,
  signal: NodeJS.Signals,
) {
  return Effect.gen(function* () {
    if (!system.isProcessRunning(registration.processId) || registration.processStartIdentity === undefined) {
      return yield* ThreadnoteProcessTerminationError.of(
        'process-stale',
        'The selected process instance changed. Refresh the process list and try again.',
      );
    }
    const identity = yield* observeProcessInstanceIdentity(system, registration.processId);
    if (identity !== registration.processStartIdentity) {
      return yield* ThreadnoteProcessTerminationError.of(
        'process-stale',
        'The selected process instance changed. Refresh the process list and try again.',
      );
    }
    yield* Effect.try({
      try: () => system.signalProcess(registration.processId, signal),
      catch: cause => {
        const code =
          typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
            ? cause.code
            : undefined;
        if (code === 'ESRCH') {
          return ThreadnoteProcessTerminationError.of(
            'process-not-found',
            'The selected Threadnote process has exited.',
          );
        }
        if (code === 'EPERM' || code === 'EACCES') {
          return ThreadnoteProcessTerminationError.of(
            'process-permission-denied',
            'Permission was denied while terminating the selected Threadnote process.',
          );
        }
        return ThreadnoteProcessTerminationError.of(
          'process-signal-failed',
          'The selected Threadnote process could not be terminated.',
        );
      },
    });
  });
}

function waitForProcessExit(
  system: SystemInfo['Service'],
  registration: ProcessRegistrationFile,
  waitMilliseconds: number,
) {
  return Effect.gen(function* () {
    const iterations = Math.ceil(waitMilliseconds / 50);
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (!(yield* processInstanceIsRunning(system, registration))) return true;
      yield* Effect.sleep(50);
    }
    return !(yield* processInstanceIsRunning(system, registration));
  });
}

function processInstanceIsRunning(system: SystemInfo['Service'], registration: ProcessRegistrationFile) {
  if (!system.isProcessRunning(registration.processId) || registration.processStartIdentity === undefined) {
    return Effect.succeed(false);
  }
  return observeProcessInstanceIdentity(system, registration.processId).pipe(
    Effect.map(identity => identity === registration.processStartIdentity),
  );
}

function boundedTerminationWait(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 10_000) : fallback;
}

function removeRegistrationFile(fs: FileSystem.FileSystem, file: string) {
  return fs.remove(file, {force: true}).pipe(Effect.ignore);
}

type ResourceDisplay = {
  readonly cpu?: ProcessCpuObservation;
  readonly rssBytes?: number;
  readonly workingDirectory?: string;
};
type ResourceSampleCache = {
  readonly gate: Semaphore.Semaphore;
  previous: ReadonlyMap<number, TimedProcessResourceCounters>;
  result: Map<number, ResourceDisplay>;
  signature: string;
  observedAt: number;
};
const resourceSampleCaches = new WeakMap<SystemInfo['Service'], Map<string, ResourceSampleCache>>();

function sampleProcessResources(
  system: SystemInfo['Service'],
  home: string,
  processes: readonly {readonly processId: number}[],
  identities: ReadonlyMap<number, string | undefined>,
) {
  return Effect.suspend(() => {
    let homes = resourceSampleCaches.get(system);
    if (!homes) {
      homes = new Map();
      resourceSampleCaches.set(system, homes);
    }
    let cache = homes.get(home);
    if (!cache) {
      cache = {
        gate: Semaphore.makeUnsafe(1),
        previous: new Map(),
        result: new Map(),
        signature: '',
        observedAt: -Infinity,
      };
      if (homes.size >= 4) {
        const oldest = homes.keys().next().value;
        if (oldest !== undefined) homes.delete(oldest);
      }
      homes.set(home, cache);
    }
    const currentCache = cache;
    return currentCache.gate.withPermit(
      Effect.gen(function* () {
        const monotonicMilliseconds = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;
        const signature = EffectArray.join(
          EffectArray.map(processes, value => `${value.processId}:${identities.get(value.processId) ?? ''}`),
          ',',
        );
        if (
          signature === currentCache.signature &&
          monotonicMilliseconds - currentCache.observedAt >= 0 &&
          monotonicMilliseconds - currentCache.observedAt < 250
        )
          return new Map(currentCache.result);
        const sampledAt = DateTime.formatIso(yield* DateTime.now);
        const ids = EffectArray.map(processes, value => value.processId);
        const probe: Effect.Effect<ReadonlyMap<number, ProcessResourceCounters>> =
          system.processResourceCounters?.(ids) ?? Effect.succeed(new Map());
        const counters = yield* probe.pipe(
          Effect.timeoutOrElse({duration: 1_500, orElse: () => Effect.succeed(new Map())}),
          Effect.orElseSucceed(() => new Map()),
        );
        const observedAt = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;
        const previous = new Map<number, TimedProcessResourceCounters>();
        const result = new Map<number, ResourceDisplay>();
        for (const {processId} of processes) {
          const value = counters.get(processId);
          // Counter identity is collected with the counters, closing the PID-reuse gap between OS probes.
          const verified =
            value !== undefined && identities.get(processId) === value.processStartIdentity
              ? {...value, monotonicMilliseconds: observedAt}
              : undefined;
          const cpu = processCpuObservation(currentCache.previous.get(processId), verified, sampledAt);
          const workingDirectory = verified ? safeDisplayPath(verified.workingDirectory) : undefined;
          result.set(processId, {
            cpu,
            ...(value?.rssBytes === undefined ? {} : {rssBytes: value.rssBytes}),
            ...(workingDirectory ? {workingDirectory} : {}),
          });
          if (verified) previous.set(processId, verified);
        }
        currentCache.previous = previous;
        currentCache.result = result;
        currentCache.signature = signature;
        currentCache.observedAt = observedAt;
        return new Map(result);
      }),
    );
  });
}

function setBestEffortProcessTitle(role: ThreadnoteProcessRole): void {
  setBestEffortProcessTitleValue(`threadnote:${role}`);
}

function setBestEffortProcessTitleValue(title: string): void {
  try {
    process.title = title;
  } catch {
    // Bun and the host OS may not expose mutable process titles. The private
    // runtime registry remains authoritative for Threadnote diagnostics.
  }
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h${minutes}m` : minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function positiveSafeInteger(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
