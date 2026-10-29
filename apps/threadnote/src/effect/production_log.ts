import {Array as EffectArray} from 'effect';
import {
  Cause,
  Clock,
  Console,
  Context,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Predicate,
  Result,
  Semaphore,
} from 'effect';
import {credentialScrubberBlocker} from '@threadnote/platform/scrubber';
import {LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION, THREADNOTE_STORAGE_LAYOUT_VERSION} from '@threadnote/store/layout';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const PRODUCTION_LOG_FILE_NAME = 'threadnote.log';
export const PRODUCTION_LOG_MAX_BYTES = 1024 * 1024;
export const PRODUCTION_LOG_ROTATED_FILE_COUNT = 5;

const PRODUCTION_LOG_DIRECTORY_NAME = 'logs';
const PRODUCTION_LOG_LAYOUT_RECEIPT_NAME = 'layout.json';
const PRODUCTION_LOG_LOCK_DIRECTORY_NAME = 'locks';
const PRODUCTION_LOG_LOCK_FILE_NAME = 'production-log.lock';
const PRODUCTION_LOG_SCHEMA_VERSION = 1;
const PRODUCTION_LOG_DIRECTORY_MODE = 0o700;
const PRODUCTION_LOG_FILE_MODE = 0o600;
const PRODUCTION_LOG_LOCK_RETRY_MILLISECONDS = 25;
const PRODUCTION_LOG_LOCK_STALE_MILLISECONDS = 30_000;
const PRODUCTION_LOG_LOCK_WAIT_MILLISECONDS = 2_000;
const PRODUCTION_LOG_PROCESS_WAIT_MILLISECONDS = PRODUCTION_LOG_LOCK_WAIT_MILLISECONDS + 500;
// Eight standalone Windows processes can occupy the low-volume log lock beyond five seconds under hosted-runner
// scheduling. Keep the queue bounded while preserving both lifecycle entries for commands that already completed.
const PRODUCTION_LOG_WINDOWS_LOCK_WAIT_MILLISECONDS = 10_000;
// Windows can briefly report a sharing/access violation while a lock-file delete settles. Retry that distinct error
// for at most 4 * 25 ms; permanent access failures remain best-effort without consuming the ten-second queue bound.
const PRODUCTION_LOG_WINDOWS_SHARING_VIOLATION_RETRY_LIMIT = 4;
const PRODUCTION_LOG_RUNTIME_NAME = 'bun';
const PRODUCTION_LOG_UNKNOWN_ERROR_TYPE = 'UnknownError';
const PRODUCTION_LOG_REPORTED_ERROR_TYPE = 'ReportedError';
const PRODUCTION_LOG_DIAGNOSTIC_LABEL_MAX_CHARACTERS = 80;
const PRODUCTION_LOG_ERROR_CAUSE_MAX_DEPTH = 4;
const PRODUCTION_LOG_IDENTIFIER_MAX_CHARACTERS = 100;
const PRODUCTION_LOG_PHASE_TIMING_MAX_COUNT = 32;
const PRODUCTION_LOG_SUPPORT_FILE_READ_MAX_BYTES = 256 * 1024;
const PRODUCTION_LOG_SUPPORT_UTF8_BYTES_PER_CHARACTER = 4;
const PRODUCTION_LOG_SUPPORT_LINE_SLACK_BYTES = 4 * 1024;
const SAFE_DIAGNOSTIC_LABEL = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const PRODUCTION_LOG_LOCK_OPTIONS = {
  retryIntervalMilliseconds: PRODUCTION_LOG_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: PRODUCTION_LOG_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: PRODUCTION_LOG_LOCK_WAIT_MILLISECONDS,
} as const;
const processProductionLogGates = new Map<string, {readonly semaphore: Semaphore.Semaphore; users: number}>();

export const PRODUCTION_LOG_PHASES = [
  'recall.shared-sync',
  'recall.obsidian-sync',
  'recall.workspace-context',
  'recall.semantic-retrieval',
  'recall.lexical-ranking',
] as const;

export type ProductionLogPhase = (typeof PRODUCTION_LOG_PHASES)[number];
export type ProductionLogPhaseOutcome = 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable';

export interface ProductionLogPhaseTiming {
  readonly durationMilliseconds: number;
  readonly errorType?: string;
  readonly outcome: ProductionLogPhaseOutcome;
  readonly phase: ProductionLogPhase;
}

interface ProductionLogPhaseRecorderShape {
  readonly time: <A, E, R>(
    phase: ProductionLogPhase,
    effect: Effect.Effect<A, E, R>,
    successOutcome?: (value: A) => ProductionLogPhaseOutcome,
  ) => Effect.Effect<A, E, R>;
}

class ProductionLogPhaseRecorder extends Context.Service<ProductionLogPhaseRecorder, ProductionLogPhaseRecorderShape>()(
  '@threadnote/threadnote/effect/production_log/ProductionLogPhaseRecorder',
) {}

/**
 * Removes invocation-local phase instrumentation from a context captured for
 * later application-service provision. Without this boundary, a long-lived
 * outer invocation can overwrite the recorder of a nested logged invocation.
 */
export function omitProductionLogPhaseRecorder<R>(
  context: Context.Context<R>,
): Context.Context<Exclude<R, ProductionLogPhaseRecorder>> {
  return Context.omit(ProductionLogPhaseRecorder)(context);
}

export interface ProductionLogPolicy {
  readonly maxBytes: number;
  readonly rotatedFileCount: number;
}

export interface ProductionLogInvocationOptions<A = unknown> {
  readonly component: 'cli' | 'mcp';
  readonly operation: string;
  readonly reportedFailure?: (value: A) => boolean;
  readonly reportedFailureType?: string;
  readonly writeTimeoutMilliseconds?: number;
}

export interface ProductionLogSupportExcerpt {
  readonly content: string;
  readonly discardedEntries: number;
  readonly includedEntries: number;
  readonly omittedEntries: number;
}

interface ProductionLogEntry {
  readonly architecture: string;
  readonly component: 'cli' | 'mcp';
  readonly durationMilliseconds?: number;
  readonly errorType?: string;
  readonly event: 'invocation.finished' | 'invocation.started';
  readonly invocationId: string;
  readonly level: 'error' | 'info' | 'warn';
  readonly operation: string;
  readonly outcome?: 'failure' | 'interrupted' | 'success';
  readonly phaseTimings?: readonly ProductionLogPhaseTiming[];
  readonly platform: string;
  readonly processId: number;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly schemaVersion: typeof PRODUCTION_LOG_SCHEMA_VERSION;
  readonly timestamp: string;
  readonly version: string;
}

const DEFAULT_PRODUCTION_LOG_POLICY: ProductionLogPolicy = {
  maxBytes: PRODUCTION_LOG_MAX_BYTES,
  rotatedFileCount: PRODUCTION_LOG_ROTATED_FILE_COUNT,
};

/**
 * Adds privacy-safe lifecycle diagnostics around an Effect without changing its
 * result. The writer is best-effort: logging failures never fail or rerun the
 * wrapped application Effect.
 */
export function withProductionLogging<A, E, R>(
  home: string,
  options: ProductionLogInvocationOptions<A>,
  effect: Effect.Effect<A, E, R>,
  policy: ProductionLogPolicy = DEFAULT_PRODUCTION_LOG_POLICY,
) {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const system = yield* SystemInfo;
    const crypto = yield* Crypto.Crypto;
    const invocationId = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.orElseSucceed(() => `${system.processId}-${startedAt}`));
    const version = yield* getThreadnoteVersion().pipe(Effect.orElseSucceed(() => 'unknown'));
    const operation = safeDiagnosticLabel(options.operation, 'unknown');
    const base = {
      architecture: system.architecture,
      component: options.component,
      invocationId,
      operation,
      platform: system.platform,
      processId: system.processId,
      runtime: PRODUCTION_LOG_RUNTIME_NAME,
      runtimeVersion: system.runtimeVersion,
      schemaVersion: PRODUCTION_LOG_SCHEMA_VERSION,
      version,
    } as const;
    const phaseTimings: ProductionLogPhaseTiming[] = [];

    const startedEntry = {
      ...base,
      event: 'invocation.started',
      level: 'info',
      timestamp: timestamp(startedAt),
    } satisfies ProductionLogEntry;

    yield* boundedInvocationLogWrite(
      appendProductionLogs(home, [startedEntry], policy),
      options.writeTimeoutMilliseconds,
    );

    const phaseRecorder = ProductionLogPhaseRecorder.of({
      time: <PhaseValue, PhaseError, PhaseRequirements>(
        phase: ProductionLogPhase,
        phaseEffect: Effect.Effect<PhaseValue, PhaseError, PhaseRequirements>,
        successOutcome?: (value: PhaseValue) => ProductionLogPhaseOutcome,
      ) =>
        Effect.gen(function* () {
          const phaseStartedAt = yield* Clock.currentTimeMillis;
          return yield* phaseEffect.pipe(
            Effect.onExit(exit =>
              Effect.gen(function* () {
                const phaseFinishedAt = yield* Clock.currentTimeMillis;
                const timing = phaseTimingFromExit(
                  phase,
                  exit,
                  successOutcome,
                  Math.max(0, phaseFinishedAt - phaseStartedAt),
                );
                yield* Effect.sync(() => {
                  if (phaseTimings.length < PRODUCTION_LOG_PHASE_TIMING_MAX_COUNT) {
                    phaseTimings.push(timing);
                  }
                });
              }),
            ),
          );
        }),
    });

    return yield* effect.pipe(
      Effect.provideService(ProductionLogPhaseRecorder, phaseRecorder),
      Effect.onExit(exit =>
        Effect.gen(function* () {
          const finishedAt = yield* Clock.currentTimeMillis;
          const completion = completionFromExit(exit, options);
          const finishedEntry = {
            ...base,
            ...completion,
            durationMilliseconds: Math.max(0, finishedAt - startedAt),
            event: 'invocation.finished',
            ...(phaseTimings.length === 0 ? {} : {phaseTimings: [...phaseTimings]}),
            timestamp: timestamp(finishedAt),
          } satisfies ProductionLogEntry;
          yield* boundedInvocationLogWrite(
            appendProductionLogs(home, [finishedEntry], policy),
            options.writeTimeoutMilliseconds,
          );
        }),
      ),
    );
  });
}

/**
 * Records a bounded, typed phase duration when an invocation logger is in
 * scope. Timings are batched into the existing invocation-finished write so
 * instrumentation does not add production-log lock pressure. Outside a logged
 * invocation this preserves the original Effect exactly.
 */
export function withProductionPhaseTiming<A, E, R>(
  phase: ProductionLogPhase,
  effect: Effect.Effect<A, E, R>,
  successOutcome?: (value: A) => ProductionLogPhaseOutcome,
): Effect.Effect<A, E, R> {
  return Effect.serviceOption(ProductionLogPhaseRecorder).pipe(
    Effect.flatMap(recorder =>
      Option.match(recorder, {
        onNone: () => effect,
        onSome: service => service.time(phase, effect, successOutcome),
      }),
    ),
  );
}

export const runProductionLogs = Effect.fn('productionLog.runProductionLogs')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const activePath = path.join(config.agentContextHome, PRODUCTION_LOG_DIRECTORY_NAME, PRODUCTION_LOG_FILE_NAME);
  const paths = [
    activePath,
    ...Array.from({length: PRODUCTION_LOG_ROTATED_FILE_COUNT}, (_, index) => `${activePath}.${index + 1}`),
  ];
  const existing: Array<{readonly path: string; readonly size: bigint}> = [];
  for (const candidate of paths) {
    if ((yield* productionLogPathEntryKind(fs, candidate)) === 'file') {
      const info = yield* fs.stat(candidate);
      existing.push({path: candidate, size: info.size});
    }
  }

  yield* Console.log(`Threadnote logs: ${path.dirname(activePath)}`);
  if (existing.length === 0) {
    yield* Console.log('No production log files have been written yet.');
  } else {
    for (const file of existing) {
      yield* Console.log(`- ${file.path} (${file.size.toString()} bytes)`);
    }
  }
  yield* Console.log(
    `Retention: ${PRODUCTION_LOG_MAX_BYTES} bytes per file, ${PRODUCTION_LOG_ROTATED_FILE_COUNT} rotated files.`,
  );
  yield* Console.log(
    'Logs contain operational metadata and typed failures, never command arguments, memory content, recall results, or MCP payloads. Review files before sharing.',
  );
});

export const productionLogSupportExcerpt = Effect.fn('productionLog.productionLogSupportExcerpt')(function* (
  home: string,
  maximumCharacters: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* isOwnedThreadnoteHome(fs, path, home))) {
    return {content: '', discardedEntries: 0, includedEntries: 0, omittedEntries: 0};
  }
  const activePath = path.join(home, PRODUCTION_LOG_DIRECTORY_NAME, PRODUCTION_LOG_FILE_NAME);
  const chronologicalPaths = [
    ...Array.from(
      {length: PRODUCTION_LOG_ROTATED_FILE_COUNT},
      (_, index) => `${activePath}.${PRODUCTION_LOG_ROTATED_FILE_COUNT - index}`,
    ),
    activePath,
  ];
  const characterBudget = Math.max(0, Math.floor(maximumCharacters));
  if (characterBudget === 0) {
    return {content: '', discardedEntries: 0, includedEntries: 0, omittedEntries: 0};
  }
  const maximumReadBytes = Math.min(
    PRODUCTION_LOG_SUPPORT_FILE_READ_MAX_BYTES,
    characterBudget * PRODUCTION_LOG_SUPPORT_UTF8_BYTES_PER_CHARACTER + PRODUCTION_LOG_SUPPORT_LINE_SLACK_BYTES,
  );
  const lockPath = path.join(home, PRODUCTION_LOG_LOCK_DIRECTORY_NAME, PRODUCTION_LOG_LOCK_FILE_NAME);
  const snapshots = yield* withProcessProductionLogPermit(
    lockPath,
    withExclusiveFileLock(
      fs,
      lockPath,
      PRODUCTION_LOG_LOCK_OPTIONS,
      Effect.forEach(chronologicalPaths, candidate => boundedProductionLogRead(fs, candidate, maximumReadBytes)),
    ),
  ).pipe(
    Effect.timeout(PRODUCTION_LOG_PROCESS_WAIT_MILLISECONDS),
    Effect.orElseSucceed(() => []),
  );
  const serializedEntries: string[] = [];
  let discardedEntries = 0;
  let truncatedFiles = 0;
  for (const snapshot of snapshots) {
    if (snapshot.rejected) {
      discardedEntries += 1;
      continue;
    }
    if (snapshot.truncated) {
      truncatedFiles += 1;
    }
    for (const line of Effect2.pipe(snapshot.content, EffectString.split('\n'))) {
      if (Effect2.pipe(line, EffectString.trim).length === 0) {
        continue;
      }
      const parsed = parseProductionLogEntry(line);
      if (parsed === undefined || credentialScrubberBlocker(JSON.stringify(parsed)) !== undefined) {
        discardedEntries += 1;
      } else {
        serializedEntries.push(JSON.stringify(parsed));
      }
    }
  }

  const includedNewestFirst: string[] = [];
  let includedCharacters = 0;
  for (let index = serializedEntries.length - 1; index >= 0; index -= 1) {
    const serialized = serializedEntries[index];
    const nextCharacters = serialized.length + (includedNewestFirst.length === 0 ? 0 : 1);
    if (includedCharacters + nextCharacters > characterBudget) {
      break;
    }
    includedNewestFirst.push(serialized);
    includedCharacters += nextCharacters;
  }
  const included = includedNewestFirst.reverse();
  return {
    content: EffectArray.join(included, '\n'),
    discardedEntries,
    includedEntries: included.length,
    omittedEntries: serializedEntries.length - included.length + truncatedFiles,
  } satisfies ProductionLogSupportExcerpt;
});

function appendProductionLogs(
  home: string,
  entries: readonly ProductionLogEntry[],
  policy: ProductionLogPolicy,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | SystemInfo | Crypto.Crypto> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    if (!(yield* isOwnedThreadnoteHome(fs, path, home))) {
      return;
    }

    const logsRoot = path.join(home, PRODUCTION_LOG_DIRECTORY_NAME);
    const activePath = path.join(logsRoot, PRODUCTION_LOG_FILE_NAME);
    const lockPath = path.join(home, PRODUCTION_LOG_LOCK_DIRECTORY_NAME, PRODUCTION_LOG_LOCK_FILE_NAME);
    const lockOptions =
      system.platform === 'win32'
        ? {
            ...PRODUCTION_LOG_LOCK_OPTIONS,
            waitTimeoutMilliseconds: PRODUCTION_LOG_WINDOWS_LOCK_WAIT_MILLISECONDS,
            windowsSharingViolationRetryLimit: PRODUCTION_LOG_WINDOWS_SHARING_VIOLATION_RETRY_LIMIT,
          }
        : PRODUCTION_LOG_LOCK_OPTIONS;
    const serialized =
      EffectArray.join(
        EffectArray.map(entries, entry => JSON.stringify(entry)),
        '\n',
      ) + '\n';
    const serializedBytes = BigInt(new TextEncoder().encode(serialized).byteLength);
    yield* withProcessProductionLogPermit(
      lockPath,
      withExclusiveFileLock(
        fs,
        lockPath,
        lockOptions,
        Effect.gen(function* () {
          if (!(yield* isOwnedThreadnoteHome(fs, path, home))) {
            return;
          }
          const logsRootKind = yield* productionLogPathEntryKind(fs, logsRoot);
          if (logsRootKind === 'symlink' || (logsRootKind !== 'missing' && logsRootKind !== 'directory')) {
            return;
          }
          yield* fs.makeDirectory(logsRoot, {mode: PRODUCTION_LOG_DIRECTORY_MODE, recursive: true});
          if ((yield* productionLogPathEntryKind(fs, logsRoot)) !== 'directory') {
            return;
          }
          yield* writeProductionLogBatch(
            fs,
            activePath,
            serialized,
            serializedBytes,
            policy,
            system.platform !== 'win32',
          );
          yield* fs.chmod(logsRoot, PRODUCTION_LOG_DIRECTORY_MODE);
        }),
      ),
    ).pipe(Effect.timeout(lockOptions.waitTimeoutMilliseconds + 500));
  }).pipe(Effect.ignore);
}

function boundedInvocationLogWrite(
  write: Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | SystemInfo | Crypto.Crypto>,
  timeoutMilliseconds: number | undefined,
) {
  return timeoutMilliseconds === undefined ? write : write.pipe(Effect.timeout(timeoutMilliseconds), Effect.ignore);
}

function writeProductionLogBatch(
  fs: FileSystem.FileSystem,
  activePath: string,
  serialized: string,
  serializedBytes: bigint,
  policy: ProductionLogPolicy,
  enforcePosixFileMode: boolean,
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const suffix = yield* crypto.randomUUIDv4();
    const activeTemporaryPath = `${activePath}.temporary-${suffix}`;
    const disposition = yield* appendToExistingProductionLog(
      fs,
      activePath,
      serialized,
      serializedBytes,
      policy,
      enforcePosixFileMode,
    );
    if (disposition === 'appended' || disposition === 'rejected') {
      return;
    }
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(activeTemporaryPath, serialized, {
        flag: 'wx',
        mode: PRODUCTION_LOG_FILE_MODE,
      });
      yield* fs.chmod(activeTemporaryPath, PRODUCTION_LOG_FILE_MODE);
      if (disposition === 'rotate') {
        yield* rotateProductionLogs(fs, activePath, policy.rotatedFileCount);
      }
      yield* replaceProductionLogEntry(fs, activeTemporaryPath, activePath);
    }).pipe(Effect.ensuring(fs.remove(activeTemporaryPath, {force: true}).pipe(Effect.ignore)));
  });
}

function appendToExistingProductionLog(
  fs: FileSystem.FileSystem,
  activePath: string,
  serialized: string,
  serializedBytes: bigint,
  policy: ProductionLogPolicy,
  enforcePosixFileMode: boolean,
) {
  return Effect.gen(function* () {
    const activeKind = yield* productionLogPathEntryKind(fs, activePath);
    if (activeKind === 'missing' || activeKind === 'symlink') {
      return 'replace' as const;
    }
    if (activeKind !== 'file') {
      return 'rejected' as const;
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const pathInfo = yield* fs.stat(activePath);
        const file = yield* fs.open(activePath, {flag: 'a', mode: PRODUCTION_LOG_FILE_MODE});
        const fileInfo = yield* file.stat;
        if (
          (yield* productionLogPathEntryKind(fs, activePath)) !== 'file' ||
          !sameProductionLogFile(pathInfo, yield* fs.stat(activePath), fileInfo)
        ) {
          return 'replace' as const;
        }
        if (enforcePosixFileMode && (fileInfo.mode & 0o777) !== PRODUCTION_LOG_FILE_MODE) {
          return 'replace' as const;
        }
        if (fileInfo.size > 0n && fileInfo.size + serializedBytes > BigInt(policy.maxBytes)) {
          return 'rotate' as const;
        }
        yield* file.writeAll(new TextEncoder().encode(serialized));
        return 'appended' as const;
      }),
    );
  });
}

function withProcessProductionLogPermit<A, E, R>(
  lockPath: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const gate = yield* Effect.sync(() => {
      const existing = processProductionLogGates.get(lockPath);
      if (existing !== undefined) {
        existing.users += 1;
        return existing;
      }
      const created = {semaphore: Semaphore.makeUnsafe(1), users: 1};
      processProductionLogGates.set(lockPath, created);
      return created;
    });
    return yield* gate.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          gate.users -= 1;
          if (gate.users === 0 && processProductionLogGates.get(lockPath) === gate) {
            processProductionLogGates.delete(lockPath);
          }
        }),
      ),
    );
  });
}

function boundedProductionLogRead(fs: FileSystem.FileSystem, filePath: string, maximumBytes: number) {
  return Effect.scoped(
    Effect.gen(function* () {
      if ((yield* productionLogPathEntryKind(fs, filePath)) === 'missing') {
        return {content: '', rejected: false, truncated: false};
      }
      if ((yield* productionLogPathEntryKind(fs, filePath)) !== 'file') {
        return {content: '', rejected: true, truncated: false};
      }
      const pathInfo = yield* fs.stat(filePath);
      if (pathInfo.type !== 'File') {
        return {content: '', rejected: true, truncated: false};
      }
      const file = yield* fs.open(filePath, {flag: 'r'});
      const fileInfo = yield* file.stat;
      if (fileInfo.type !== 'File') {
        return {content: '', rejected: true, truncated: false};
      }
      if (
        (yield* productionLogPathEntryKind(fs, filePath)) !== 'file' ||
        !sameProductionLogFile(pathInfo, yield* fs.stat(filePath), fileInfo)
      ) {
        return {content: '', rejected: true, truncated: false};
      }
      const maximumSize = BigInt(maximumBytes);
      const offset = fileInfo.size > maximumSize ? fileInfo.size - maximumSize : 0n;
      if (offset > 0n) {
        yield* file.seek(offset, 'start');
      }
      const bytes = Option.getOrElse(yield* file.readAlloc(maximumBytes), () => new Uint8Array());
      let content = new TextDecoder().decode(bytes);
      if (offset > 0n) {
        const firstNewline = Effect2.pipe(
          content,
          EffectString.indexOf('\n'),
          Effect2.Option.getOrElse(() => -1),
        );
        content = firstNewline < 0 ? '' : Effect2.pipe(content, EffectString.slice(firstNewline + 1));
      }
      return {content, rejected: false, truncated: offset > 0n};
    }),
  ).pipe(Effect.orElseSucceed(() => ({content: '', rejected: true, truncated: false})));
}

function rotateProductionLogs(
  fs: FileSystem.FileSystem,
  activePath: string,
  rotatedFileCount: number,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (rotatedFileCount <= 0) {
      return;
    }
    yield* fs.remove(`${activePath}.${rotatedFileCount}`, {force: true});
    for (let targetIndex = rotatedFileCount; targetIndex > 1; targetIndex -= 1) {
      const source = `${activePath}.${targetIndex - 1}`;
      const sourceKind = yield* productionLogPathEntryKind(fs, source);
      if (sourceKind === 'symlink') {
        yield* fs.remove(source, {force: true});
      } else if (sourceKind === 'file') {
        const target = `${activePath}.${targetIndex}`;
        yield* fs.rename(source, target);
        if ((yield* productionLogPathEntryKind(fs, target)) !== 'file') {
          yield* fs.remove(target, {force: true});
        } else {
          yield* fs.chmod(target, PRODUCTION_LOG_FILE_MODE);
        }
      } else if (sourceKind !== 'missing') {
        return;
      }
    }
    const activeKind = yield* productionLogPathEntryKind(fs, activePath);
    if (activeKind === 'symlink') {
      yield* fs.remove(activePath, {force: true});
    } else if (activeKind === 'file') {
      const target = `${activePath}.1`;
      yield* fs.rename(activePath, target);
      if ((yield* productionLogPathEntryKind(fs, target)) !== 'file') {
        yield* fs.remove(target, {force: true});
      } else {
        yield* fs.chmod(target, PRODUCTION_LOG_FILE_MODE);
      }
    }
  });
}

function replaceProductionLogEntry(fs: FileSystem.FileSystem, source: string, target: string) {
  return Effect.gen(function* () {
    const targetKind = yield* productionLogPathEntryKind(fs, target);
    if (targetKind === 'file' || targetKind === 'symlink') {
      yield* fs.remove(target, {force: true});
    } else if (targetKind !== 'missing') {
      return;
    }
    yield* fs.rename(source, target);
  });
}

function productionLogPathEntryKind(fs: FileSystem.FileSystem, filePath: string) {
  return fs.readLink(filePath).pipe(
    Effect.as('symlink' as const),
    Effect.catchIf(
      error => error instanceof PlatformError.PlatformError && error.reason._tag === 'NotFound',
      () => Effect.succeed('missing' as const),
      () =>
        fs.stat(filePath).pipe(
          Effect.map(info =>
            info.type === 'File'
              ? ('file' as const)
              : info.type === 'Directory'
                ? ('directory' as const)
                : ('other' as const),
          ),
          Effect.catchIf(
            statError => statError instanceof PlatformError.PlatformError && statError.reason._tag === 'NotFound',
            () => Effect.succeed('missing' as const),
          ),
        ),
    ),
  );
}

function sameProductionLogFile(
  before: FileSystem.File.Info,
  current: FileSystem.File.Info,
  opened: FileSystem.File.Info,
): boolean {
  const beforeInode = Option.getOrUndefined(before.ino);
  const currentInode = Option.getOrUndefined(current.ino);
  const openedInode = Option.getOrUndefined(opened.ino);
  return (
    before.type === 'File' &&
    current.type === 'File' &&
    opened.type === 'File' &&
    before.dev === current.dev &&
    current.dev === opened.dev &&
    (beforeInode === undefined ||
      currentInode === undefined ||
      openedInode === undefined ||
      (beforeInode === currentInode && currentInode === openedInode))
  );
}

function isOwnedThreadnoteHome(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return fs.readFileString(path.join(home, PRODUCTION_LOG_LAYOUT_RECEIPT_NAME)).pipe(
    Effect.map(content => {
      const parsed = Result.try(() => JSON.parse(content) as unknown);
      if (Result.isFailure(parsed) || !Predicate.isObject(parsed.success) || EffectArray.isArray(parsed.success)) {
        return false;
      }
      const receipt = parsed.success;
      return (
        receipt.createdBy === 'threadnote' &&
        (receipt.version === THREADNOTE_STORAGE_LAYOUT_VERSION ||
          receipt.version === LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION)
      );
    }),
    Effect.orElseSucceed(() => false),
  );
}

function completionFromExit<A, E>(
  exit: Exit.Exit<A, E>,
  options: ProductionLogInvocationOptions<A>,
): Pick<ProductionLogEntry, 'errorType' | 'level' | 'outcome'> {
  if (Exit.isSuccess(exit)) {
    const reportedFailure = Result.try(() => options.reportedFailure?.(exit.value) === true);
    if (Result.isSuccess(reportedFailure) && reportedFailure.success) {
      return {
        errorType: safeDiagnosticLabel(options.reportedFailureType, PRODUCTION_LOG_REPORTED_ERROR_TYPE),
        level: 'error',
        outcome: 'failure',
      };
    }
    return {level: 'info', outcome: 'success'};
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {level: 'warn', outcome: 'interrupted'};
  }
  const diagnostic = Result.try(() => diagnosticErrorType(Cause.squash(exit.cause)));
  return {
    errorType: Result.isSuccess(diagnostic) ? diagnostic.success : PRODUCTION_LOG_UNKNOWN_ERROR_TYPE,
    level: 'error',
    outcome: 'failure',
  };
}

function phaseTimingFromExit<A, E>(
  phase: ProductionLogPhase,
  exit: Exit.Exit<A, E>,
  successOutcome: ((value: A) => ProductionLogPhaseOutcome) | undefined,
  durationMilliseconds: number,
): ProductionLogPhaseTiming {
  if (Exit.isSuccess(exit)) {
    const classified = Result.try(() => successOutcome?.(exit.value) ?? 'success');
    const outcome = Result.isSuccess(classified) ? classified.success : 'success';
    return {durationMilliseconds, outcome, phase};
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {durationMilliseconds, outcome: 'interrupted', phase};
  }
  const diagnostic = Result.try(() => diagnosticErrorType(Cause.squash(exit.cause)));
  return {
    durationMilliseconds,
    errorType: Result.isSuccess(diagnostic) ? diagnostic.success : PRODUCTION_LOG_UNKNOWN_ERROR_TYPE,
    outcome: 'failure',
    phase,
  };
}

/** Privacy-safe bounded failure type shared by local and anonymous diagnostics. */
export function diagnosticErrorType(error: unknown, depth = 0): string {
  if (
    depth < PRODUCTION_LOG_ERROR_CAUSE_MAX_DEPTH &&
    typeof error === 'object' &&
    error !== null &&
    'cause' in error &&
    error.cause !== error
  ) {
    const nested = diagnosticErrorType(error.cause, depth + 1);
    if (nested !== PRODUCTION_LOG_UNKNOWN_ERROR_TYPE) {
      return nested;
    }
  }
  if (typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string') {
    return safeDiagnosticLabel(error._tag, PRODUCTION_LOG_UNKNOWN_ERROR_TYPE);
  }
  return error instanceof Error
    ? safeDiagnosticLabel(error.name, PRODUCTION_LOG_UNKNOWN_ERROR_TYPE)
    : PRODUCTION_LOG_UNKNOWN_ERROR_TYPE;
}

function safeDiagnosticLabel(value: string | undefined, fallback: string): string {
  return value !== undefined &&
    value.length <= PRODUCTION_LOG_DIAGNOSTIC_LABEL_MAX_CHARACTERS &&
    SAFE_DIAGNOSTIC_LABEL.test(value) &&
    credentialScrubberBlocker(value) === undefined
    ? value
    : fallback;
}

function parseProductionLogEntry(line: string): ProductionLogEntry | undefined {
  const parsed = Result.try(() => JSON.parse(line) as unknown);
  if (Result.isFailure(parsed) || !Predicate.isObject(parsed.success)) {
    return undefined;
  }
  const value = parsed.success;
  const component = oneOf(value.component, ['cli', 'mcp'] as const);
  const event = oneOf(value.event, ['invocation.finished', 'invocation.started'] as const);
  const level = oneOf(value.level, ['error', 'info', 'warn'] as const);
  const outcome = optionalOneOf(value.outcome, ['failure', 'interrupted', 'success'] as const);
  const phaseTimings = parseProductionLogPhaseTimings(value.phaseTimings);
  const architecture = safeParsedLabel(value.architecture);
  const invocationId = safeParsedIdentifier(value.invocationId);
  const operation = safeParsedLabel(value.operation);
  const platform = safeParsedLabel(value.platform);
  const runtime = safeParsedLabel(value.runtime);
  const runtimeVersion = safeParsedVersion(value.runtimeVersion);
  const version = safeParsedVersion(value.version);
  const timestampValue = safeParsedTimestamp(value.timestamp);
  const processId = safeNonNegativeInteger(value.processId);
  const durationMilliseconds =
    value.durationMilliseconds === undefined ? undefined : safeNonNegativeInteger(value.durationMilliseconds);
  const errorType = optionalSafeParsedLabel(value.errorType);
  if (
    value.schemaVersion !== PRODUCTION_LOG_SCHEMA_VERSION ||
    component === undefined ||
    event === undefined ||
    level === undefined ||
    outcome === false ||
    phaseTimings === false ||
    architecture === undefined ||
    invocationId === undefined ||
    operation === undefined ||
    platform === undefined ||
    runtime === undefined ||
    runtimeVersion === undefined ||
    version === undefined ||
    timestampValue === undefined ||
    processId === false ||
    durationMilliseconds === false ||
    errorType === false ||
    (event === 'invocation.started' && phaseTimings !== undefined)
  ) {
    return undefined;
  }
  return {
    architecture,
    component,
    ...(durationMilliseconds === undefined ? {} : {durationMilliseconds}),
    ...(errorType === undefined ? {} : {errorType}),
    event,
    invocationId,
    level,
    operation,
    ...(outcome === undefined ? {} : {outcome}),
    ...(phaseTimings === undefined ? {} : {phaseTimings}),
    platform,
    processId,
    runtime,
    runtimeVersion,
    schemaVersion: PRODUCTION_LOG_SCHEMA_VERSION,
    timestamp: timestampValue,
    version,
  };
}

function parseProductionLogPhaseTimings(value: unknown): readonly ProductionLogPhaseTiming[] | undefined | false {
  if (value === undefined) return undefined;
  if (!EffectArray.isArray(value) || value.length > PRODUCTION_LOG_PHASE_TIMING_MAX_COUNT) return false;
  const timings: ProductionLogPhaseTiming[] = [];
  for (const entry of value) {
    if (!Predicate.isObject(entry)) return false;
    const record = entry;
    const durationMilliseconds = safeNonNegativeInteger(record.durationMilliseconds);
    const errorType = optionalSafeParsedLabel(record.errorType);
    const outcome = oneOf(record.outcome, ['failure', 'interrupted', 'success', 'timed-out', 'unavailable'] as const);
    const phase = oneOf(record.phase, PRODUCTION_LOG_PHASES);
    if (durationMilliseconds === false || errorType === false || outcome === undefined || phase === undefined) {
      return false;
    }
    timings.push({
      durationMilliseconds,
      ...(errorType === undefined ? {} : {errorType}),
      outcome,
      phase,
    });
  }
  return timings;
}

function safeParsedLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const safe = safeDiagnosticLabel(value, '');
  return safe.length > 0 ? safe : undefined;
}

function safeParsedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= PRODUCTION_LOG_IDENTIFIER_MAX_CHARACTERS &&
    /^[A-Za-z0-9-]+$/.test(value)
    ? value
    : undefined;
}

function safeParsedVersion(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= PRODUCTION_LOG_DIAGNOSTIC_LABEL_MAX_CHARACTERS &&
    /^[A-Za-z0-9.+_-]+$/.test(value)
    ? value
    : undefined;
}

function safeParsedTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    ? value
    : undefined;
}

function safeNonNegativeInteger(value: unknown): number | false {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : false;
}

function optionalSafeParsedLabel(value: unknown): string | undefined | false {
  return value === undefined ? undefined : (safeParsedLabel(value) ?? false);
}

function oneOf<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value : undefined;
}

function optionalOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] | undefined | false {
  return value === undefined ? undefined : (oneOf(value, values) ?? false);
}

function timestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
