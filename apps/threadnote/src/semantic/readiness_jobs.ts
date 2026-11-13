import {Cause, Clock, Effect, Exit, Fiber, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {SecureRandom} from 'effect/crypto';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  hasReadCleanupUnconfirmed,
  makeReadDeadline,
  ReadDeadlineContext,
  readDeadlineRemaining,
  withinReadDeadline,
  type ReadDeadline,
} from '@threadnote/platform/read_deadline';
import type {Observation} from '@threadnote/semantic/contracts';
import {LspFault, SemanticWireStartup} from './lsp_transport.js';
import {SemanticSessionFault} from './provider.js';
import {runtimeAssertPrivateProviderPath, SystemInfo} from '@threadnote/platform/system';
import {sha256FileHex} from '@threadnote/platform/digest';
import {getThreadnoteVersion, isStandaloneThreadnoteBuild} from '@threadnote/workspace/runtime-version';
import {SemanticHostProfile, SemanticHostProfileFault} from './host_profile.js';
import {semanticCatalogKey} from './host_catalog.js';
import {readBounded} from './fingerprint.js';

/** The existing public standalone identity is shared with its selected-verification child. */
export const semanticCompiledRuntimeIdentity = Effect.gen(function* () {
  if (!isStandaloneThreadnoteBuild()) return yield* SemanticHostProfileFault.make({reason: 'incompatible'});
  const system = yield* SystemInfo;
  const fs = yield* FileSystem.FileSystem;
  const executable = yield* fs.realPath(system.executablePath);
  const stat = yield* fs.stat(executable);
  if (stat.type !== 'File' || Number(stat.size) > 512 * 1024 * 1024)
    return yield* SemanticHostProfileFault.make({reason: 'incompatible'});
  return sha256HexSync(
    JSON.stringify([
      'threadnote-agent-read-v1',
      yield* getThreadnoteVersion(),
      executable,
      yield* sha256FileHex(executable),
    ]),
  );
});
import {
  semanticReadinessLimits,
  SemanticVerificationReply,
  type SemanticReadinessSource,
  type SemanticReadinessStage,
  type SemanticReadinessProgress,
  type SemanticReadinessResult,
  type SemanticReadinessHandle,
} from './agent_query_protocol.js';

/** Coordinator-owned callbacks; public requests cannot supply progress or process authority. */
export interface SemanticStartupControl {
  readonly deadline: ReadDeadline;
  readonly remaining: Effect.Effect<number>;
  readonly stage: (stage: SemanticReadinessStage) => Effect.Effect<void>;
  readonly termination: (terminate: Effect.Effect<void>) => void;
  readonly cleanup: (disposition: 'drained' | 'unknown') => void;
  readonly cleanupUnknown: () => boolean;
}
/** A retained session owns the native callback; each authenticated attach binds its current startup observer. */
export function makeSemanticStartupBinding(initial?: SemanticStartupControl) {
  let control = initial;
  let terminate: Effect.Effect<void> | undefined;
  let unknown = false;
  return {
    wire: {
      termination: (owned: Effect.Effect<void>) => {
        terminate = owned;
        control?.termination(owned);
      },
      cleanup: (disposition: 'drained' | 'unknown') => {
        unknown ||= disposition === 'unknown';
        control?.cleanup(disposition);
      },
    },
    bind: (next?: SemanticStartupControl) => {
      control = next;
      if (terminate) next?.termination(terminate);
      if (unknown) next?.cleanup('unknown');
    },
    failed: <E>(cause: Cause.Cause<E>) =>
      Effect.sync(() => {
        if (hasReadCleanupUnconfirmed(cause)) {
          unknown = true;
          control?.cleanup('unknown');
        }
      }),
    cleanupUnknown: () => unknown || control?.cleanupUnknown() === true,
  };
}
interface Job {
  readonly source: SemanticReadinessSource;
  readonly content: string;
  readonly capability: string;
  readonly started: bigint;
  readonly expires: bigint;
  progress: SemanticReadinessProgress;
  cancelled: boolean;
  observation?: Observation;
  fiber?: Fiber.Fiber<void>;
  terminate?: Effect.Effect<void>;
  terminationRequested: boolean;
}
const terminal = (job: Job) => ['ready', 'failed', 'cancelled', 'stale'].includes(job.progress.state);
const refusal = (): SemanticReadinessResult => ({
  version: 1,
  status: 'unavailable',
  reason: 'Readiness job is unavailable for this scope',
});

export const verifyReadinessProfile = Effect.fn('semantic.readinessProfile')(function* (
  home: string,
  scope: {readonly worktree: string; readonly profile: string; readonly principal: string},
  catalog: string,
) {
  const path = yield* Path.Path;
  if (!/^[a-f0-9]{64}$/u.test(scope.principal)) return yield* LspFault.make({code: 'rejected'});
  const file = path.join(home, 'semantic', 'profiles', scope.principal + '.json');
  const proof = Effect.try({
    try: () => runtimeAssertPrivateProviderPath(file, {kind: 'file'}),
    catch: () => LspFault.make({code: 'rejected'}),
  });
  yield* proof;
  const bytes = yield* readBounded(file, 16384);
  const profile = yield* Schema.decodeEffect(Schema.fromJsonString(SemanticHostProfile), {onExcessProperty: 'error'})(
    new TextDecoder('utf-8', {fatal: true}).decode(bytes),
  );
  yield* proof;
  if (
    !profile.enabled ||
    profile.worktree !== scope.worktree ||
    sha256HexSync(bytes) !== scope.profile ||
    semanticCatalogKey(profile.catalog) !== catalog
  )
    return yield* LspFault.make({code: 'rejected'});
});

/** One volatile registry in the authenticated coordinator Scope, never a persisted workflow or write grant. */
export const makeSemanticReadinessJobs = Effect.fn('semantic.readinessJobs')(function* <R>(ports: {
  readonly worktree: string;
  readonly prepare: (
    source: SemanticReadinessSource,
    content: string,
    control: SemanticStartupControl,
  ) => Effect.Effect<Observation, unknown, R>;
  readonly current: (source: SemanticReadinessSource, observation: Observation) => Effect.Effect<boolean, unknown, R>;
  readonly close: (observation: Observation) => Effect.Effect<void, unknown, R>;
}) {
  const scope = yield* Effect.scope;
  const random = yield* SecureRandom.SecureRandom;
  const jobs = new Map<string, Job>();
  const terminatePending = (job: Job) =>
    Effect.suspend(() => {
      if (
        job.terminationRequested ||
        !job.terminate ||
        (terminal(job) && job.progress.cleanup !== 'pending' && job.progress.cleanup !== 'unknown')
      )
        return Effect.void;
      job.terminationRequested = true;
      return job.terminate;
    });
  const scheduleTermination = (job: Job, deadline: ReadDeadline) =>
    readDeadlineRemaining(deadline).pipe(
      Effect.flatMap(remaining => Effect.sleep(Math.min(remaining, semanticReadinessLimits.terminationMilliseconds))),
      Effect.andThen(terminatePending(job)),
      Effect.forkIn(scope),
    );
  const prune = (now: bigint) => {
    for (const [id, job] of jobs) if (terminal(job) && now >= job.expires) jobs.delete(id);
  };
  const snapshot = (job: Job) =>
    Clock.monotonicTimeNanos.pipe(
      Effect.map(now => ({
        version: 1 as const,
        status: 'ok' as const,
        progress: {
          ...job.progress,
          elapsedMilliseconds: Math.max(0, Math.floor(Number(now - job.started) / 1_000_000)),
        },
      })),
    );
  const find = (handle: typeof SemanticReadinessHandle.Type, profile: string, principal: string, worktree: string) => {
    const job = jobs.get(handle.id);
    return job &&
      job.capability === handle.capability &&
      job.source.profile === profile &&
      job.source.principal === principal &&
      job.source.worktree === worktree &&
      worktree === ports.worktree
      ? job
      : undefined;
  };
  const start = (source: SemanticReadinessSource, content: string, inheritedDeadline?: ReadDeadline) =>
    Effect.gen(function* () {
      const now = yield* Clock.monotonicTimeNanos;
      prune(now);
      if (source.worktree !== ports.worktree || jobs.size >= semanticReadinessLimits.maxJobs) return refusal();
      const id = sha256HexSync(yield* random.randomBytes(32));
      const capability = sha256HexSync(yield* random.randomBytes(32));
      const deadline = inheritedDeadline ?? (yield* makeReadDeadline(semanticReadinessLimits.startupMilliseconds));
      // Cleanup consumes the same startup budget; preparation never borrows its final two seconds.
      const workDeadline = {
        expiresAtNanos: deadline.expiresAtNanos - BigInt(semanticReadinessLimits.terminationMilliseconds) * 1_000_000n,
      };
      const job: Job = {
        source: structuredClone(source),
        content,
        capability,
        started: deadline.expiresAtNanos - BigInt(semanticReadinessLimits.startupMilliseconds) * 1_000_000n,
        expires: now + BigInt(semanticReadinessLimits.ttlMilliseconds) * 1_000_000n,
        cancelled: false,
        terminationRequested: false,
        progress: {
          state: 'accepted',
          stage: 'queued',
          sequence: 0,
          elapsedMilliseconds: 0,
          startupMilliseconds: 120000,
          queryMilliseconds: 10000,
          maxQueryMilliseconds: 45000,
          cleanup: 'not-started',
        },
      };
      // Entropy and deadline acquisition yield. The final capacity check and insertion are one synchronous admission.
      if (jobs.size >= semanticReadinessLimits.maxJobs) return refusal();
      jobs.set(id, job);
      const control: SemanticStartupControl = {
        deadline,
        remaining: readDeadlineRemaining(workDeadline),
        stage: stage =>
          Effect.sync(() => {
            if (!terminal(job) && !job.cancelled) {
              job.progress = {...job.progress, state: 'running', stage, sequence: job.progress.sequence + 1};
            }
          }),
        termination: terminate => {
          job.terminate = terminate;
          job.progress = {...job.progress, cleanup: 'pending'};
        },
        cleanup: disposition => {
          if (job.progress.cleanup !== 'unknown') job.progress = {...job.progress, cleanup: disposition};
        },
        cleanupUnknown: () => job.progress.cleanup === 'unknown',
      };
      const program = withinReadDeadline(
        workDeadline,
        Effect.gen(function* () {
          const observation = yield* ports.prepare(job.source, job.content, control);
          job.observation = observation;
          yield* control.stage('finalizing');
          if (!(yield* ports.current(job.source, observation))) return yield* Effect.fail('source' as const);
        }),
      ).pipe(
        Effect.onExit(exit =>
          Effect.gen(function* () {
            if ((job.cancelled || Exit.isFailure(exit)) && job.observation && job.terminate) {
              yield* ports
                .close(job.observation)
                .pipe(Effect.catchCause(() => Effect.sync(() => control.cleanup('unknown'))));
            }
            if (Exit.isFailure(exit) && hasReadCleanupUnconfirmed(exit.cause)) control.cleanup('unknown');
            const deadlineExpired = (yield* control.remaining) === 0;
            const errors = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
            const sourceChanged =
              job.progress.cleanup !== 'unknown' &&
              errors?._tag === 'Some' &&
              (errors.value === 'source' ||
                (Schema.is(SemanticSessionFault)(errors.value) && errors.value.reason === 'stale'));
            job.progress = {
              ...job.progress,
              state: job.cancelled ? 'cancelled' : Exit.isSuccess(exit) ? 'ready' : sourceChanged ? 'stale' : 'failed',
              sequence: job.progress.sequence + 1,
              cleanup:
                job.progress.cleanup === 'unknown'
                  ? 'unknown'
                  : !job.cancelled && Exit.isSuccess(exit)
                    ? 'retained'
                    : job.progress.cleanup === 'pending'
                      ? 'pending'
                      : 'drained',
              ...(job.cancelled
                ? {failureOrigin: 'cancelled' as const}
                : Exit.isFailure(exit)
                  ? {
                      failureOrigin: deadlineExpired
                        ? ('deadline' as const)
                        : sourceChanged
                          ? ('source' as const)
                          : ('prerequisite' as const),
                    }
                  : {}),
            };
            if (job.progress.cleanup === 'pending' || job.progress.cleanup === 'unknown')
              yield* scheduleTermination(job, deadline);
          }),
        ),
        Effect.provideService(ReadDeadlineContext, deadline),
        Effect.provideService(SemanticWireStartup, control),
        Effect.ignoreCause,
      );
      job.fiber = yield* program.pipe(Effect.forkIn(scope));
      yield* readDeadlineRemaining(deadline).pipe(
        Effect.flatMap(remaining => Effect.sleep(remaining)),
        Effect.andThen(terminatePending(job)),
        Effect.forkIn(scope),
      );
      return {...(yield* snapshot(job)), job: {id, capability}} satisfies SemanticReadinessResult;
    });
  const inspect = (
    handle: typeof SemanticReadinessHandle.Type,
    profile: string,
    principal: string,
    worktree: string,
    cancel: boolean,
  ) =>
    Effect.gen(function* () {
      prune(yield* Clock.monotonicTimeNanos);
      const job = find(handle, profile, principal, worktree);
      if (!job) return refusal();
      if (cancel && !terminal(job) && !job.cancelled) {
        job.cancelled = true;
        job.progress = {...job.progress, state: 'cancelling', sequence: job.progress.sequence + 1};
        // Neither acknowledgement nor status waits for an uninterruptible provider finalizer.
        yield* scheduleTermination(job, {
          expiresAtNanos: job.started + BigInt(semanticReadinessLimits.startupMilliseconds) * 1_000_000n,
        });
        if (job.fiber) yield* Fiber.interrupt(job.fiber).pipe(Effect.forkIn(scope));
      }
      if (
        !cancel &&
        job.progress.state === 'ready' &&
        job.observation &&
        !(yield* ports.current(job.source, job.observation))
      )
        job.progress = {...job.progress, state: 'stale', sequence: job.progress.sequence + 1, failureOrigin: 'source'};
      return yield* snapshot(job);
    });
  return {
    start,
    status: (handle: typeof SemanticReadinessHandle.Type, profile: string, principal: string, worktree: string) =>
      inspect(handle, profile, principal, worktree, false),
    cancel: (handle: typeof SemanticReadinessHandle.Type, profile: string, principal: string, worktree: string) =>
      inspect(handle, profile, principal, worktree, true),
    idle: Clock.monotonicTimeNanos.pipe(
      Effect.map(now => {
        prune(now);
        return jobs.size === 0;
      }),
    ),
  };
});

export const runSemanticSelectedVerification = Effect.fn('semantic.selectedVerificationWorker')(function* (
  file: string,
  id: string,
  expected: string,
  runtimeVersion: boolean,
  configurationOnly: boolean,
) {
  const system = yield* SystemInfo;
  const command = yield* CommandExecutor;
  const inherited = yield* Effect.serviceOption(ReadDeadlineContext);
  const milliseconds = Option.isSome(inherited) ? yield* readDeadlineRemaining(inherited.value, 2000) : 8000;
  if (milliseconds <= 0) return yield* LspFault.make({code: 'timeout'});
  const name = EffectString.toLowerCase(
    EffectString.split('/')(EffectString.replaceAll('\\', '/')(system.executablePath)).at(-1) ?? '',
  );
  const result = yield* command.execute(
    system.executablePath,
    [
      ...(name === 'bun' || name === 'bun.exe' ? [system.developmentEntrypoint] : []),
      '__semantic-coordinator',
      '--verify-config',
      file,
      '--provider',
      id,
      ...(runtimeVersion ? ['--runtime-version'] : []),
      ...(configurationOnly ? ['--configuration-only'] : []),
    ],
    {
      env: system.intendedChildEnvironment(system.environment(), 'semantic-coordinator'),
      timeoutMs: milliseconds,
      maxOutputBytes: 2048,
      sensitiveOutput: true,
      forceKillAfterMilliseconds: 0,
      detached: true,
      verifyOwnedProcessExit: 'group',
    },
  );
  const reply = yield* Schema.decodeEffect(Schema.fromJsonString(SemanticVerificationReply), {
    onExcessProperty: 'error',
  })(result.stdout);
  if (
    reply.provider !== id ||
    reply.candidate !== expected ||
    reply.runtimeVersion !== runtimeVersion ||
    reply.mode !== (configurationOnly ? 'configuration' : 'candidate') ||
    (!configurationOnly && reply.digest !== expected)
  )
    return yield* LspFault.make({code: 'rejected'});
  return reply.digest;
});
