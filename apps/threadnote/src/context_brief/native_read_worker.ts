import {Array as EffectArray, Cause, Effect, Option, Schema, Stdio, Stream} from 'effect';
import * as EffectString from 'effect/String';
import {
  CommandCleanupUnconfirmed,
  CommandExecutor,
  CommandSpawnFailed,
  type CommandOptions,
} from '@threadnote/platform/command';
import {makeReadDeadline, readDeadlineRemaining} from '@threadnote/platform/read_deadline';
import {CodeGraphScopeRoutingError} from '@threadnote/graph/scope/routing';
import {retrieveContextBriefGraphEvidence} from '@threadnote/context/graph/evidence';
import {retrieveContextBriefSourceEvidence} from '@threadnote/context/graph/source_evidence';
import {validateContextBriefMemoryCitations} from '@threadnote/context/citation_validation';
import {
  selectVerifiedProcedureEvidence,
  type VerifiedProcedureCoverageGap,
} from '@threadnote/context/procedure/selection';
import {applicationLayerWithCommands} from '../effect/runtime.js';
import {retrieveContextBriefCodeLinkedMemoryEvidence} from './memory_evidence.js';
import {loadPublishedProcedureCandidates} from '../procedure/repository.js';
import {
  CONTEXT_BRIEF_NATIVE_READ_INPUT_BYTES,
  CONTEXT_BRIEF_NATIVE_READ_OUTPUT_BYTES,
  contextBriefNativeReadBinding,
  contextBriefNativeReadRequestSchema,
  contextBriefNativeReadResponseSchema,
  ContextBriefNativeReadFailed,
  type ContextBriefNativeReadRequest,
  type ContextBriefNativeReadResponse,
} from './native_read_boundary.js';
import type {ReadDeadline} from '@threadnote/platform/read_deadline';

/** Every nested Git command stays inside the parent's owned process group. */
export function nativeContextReadCommands(
  inner: ReturnType<typeof CommandExecutor.of>,
  deadline: ReadDeadline,
  observeCleanupFailure: () => void = () => {},
) {
  const unavailable = () =>
    CommandSpawnFailed.make({
      args: [],
      executable: '<context-read>',
      message: 'Command unavailable in a bounded context read.',
      cause: undefined,
    });
  const prepare = Effect.fn('contextBrief.prepareOwnedCommand')(function* (
    executable: string,
    args: readonly string[],
    options?: CommandOptions,
  ) {
    const remaining = yield* readDeadlineRemaining(deadline);
    if (remaining <= 0) return yield* unavailable();
    const name = EffectString.toLowerCase(
      EffectString.split('/')(EffectString.replaceAll('\\', '/')(executable)).at(-1) ?? '',
    );
    if (name !== 'git' && name !== 'git.exe') return yield* unavailable();
    // Cached status may try to start a persistent fsmonitor. Read requests cannot own that daemon.
    if (args.includes('fsmonitor--daemon')) return yield* unavailable();
    const safeArgs = EffectArray.map(args, (arg, index) =>
      index > 0 && args[index - 1] === '-c' && EffectString.startsWith('core.fsmonitor=')(arg)
        ? 'core.fsmonitor=false'
        : arg,
    );
    return {
      args: ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...safeArgs],
      options: {
        ...options,
        detached: false,
        forceKillAfterMilliseconds: 0,
        sensitiveOutput: true,
        verifyOwnedProcessExit: 'leader' as const,
        timeoutMs: Math.max(
          1,
          Math.min(options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : remaining, remaining),
        ),
      },
    };
  });
  const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.onError(cause => {
        if (Option.isSome(Cause.findErrorOption(cause).pipe(Option.filter(Schema.is(CommandCleanupUnconfirmed)))))
          observeCleanupFailure();
        return Effect.void;
      }),
    );
  return CommandExecutor.of({
    execute: (executable, args, options) =>
      Effect.gen(function* () {
        const owned = yield* prepare(executable, args, options);
        return yield* observe(inner.execute(executable, owned.args, owned.options));
      }),
    ...(inner.executeBytes === undefined
      ? {}
      : {
          executeBytes: (executable: string, args: readonly string[], options?: CommandOptions) =>
            Effect.gen(function* () {
              const owned = yield* prepare(executable, args, options);
              return yield* observe(inner.executeBytes!(executable, owned.args, owned.options));
            }),
        }),
    executeStreaming: () => Effect.die('Streaming commands are unavailable in bounded context reads.'),
    spawnDetached: () => Effect.succeed(false),
  });
}

export const serveContextBriefNativeRead = Effect.fn('contextBrief.serveNativeRead')(function* (
  request: ContextBriefNativeReadRequest,
) {
  const deadline = yield* makeReadDeadline(request.remainingMilliseconds);
  const budget = {
    remaining: request.operation === 'graph' ? request.counters.remaining : 0,
    primaryRemaining: request.operation === 'graph' ? request.counters.primaryRemaining : 0,
    deadline,
  };
  let cleanupUnconfirmed = false;
  const program = Effect.gen(function* () {
    const fields = {
      protocol: 1 as const,
      binding: contextBriefNativeReadBinding(request),
      commandsJoined: true as const,
    };
    switch (request.operation) {
      case 'graph':
        return {
          ...fields,
          ok: true as const,
          operation: request.operation,
          value: yield* retrieveContextBriefGraphEvidence(
            request.config,
            request.plan,
            retrieveContextBriefSourceEvidence,
            budget,
          ),
          counters: {remaining: budget.remaining, primaryRemaining: budget.primaryRemaining},
        };
      case 'linked':
        return {
          ...fields,
          ok: true as const,
          operation: request.operation,
          value: yield* retrieveContextBriefCodeLinkedMemoryEvidence(request.config, request.plan, {
            allowedUriScopes: request.allowedUriScopes,
          }),
        };
      case 'citations':
        return {
          ...fields,
          ok: true as const,
          operation: request.operation,
          value: yield* validateContextBriefMemoryCitations(
            request.config,
            request.scope,
            request.candidates,
            request.fence,
          ),
        };
      case 'procedures': {
        const repository = yield* loadPublishedProcedureCandidates(request.config);
        const selected = selectVerifiedProcedureEvidence({
          candidates: repository.candidates,
          cohort: request.config.user,
          surface: request.surface ?? request.config.agentId,
          task: request.task,
        });
        return {
          ...fields,
          ok: true as const,
          operation: request.operation,
          value: {
            gaps: [...new Set<VerifiedProcedureCoverageGap>([...repository.gaps, ...selected.gaps])].sort(),
            procedures: selected.procedures,
          },
        };
      }
    }
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- One-shot application worker entry point: capture owned commands before graph services are built.
    Effect.provide(
      applicationLayerWithCommands(inner =>
        nativeContextReadCommands(inner, deadline, () => {
          cleanupUnconfirmed = true;
        }),
      ),
    ),
  );
  const result = yield* program.pipe(Effect.result);
  if (cleanupUnconfirmed) return yield* ContextBriefNativeReadFailed.make({reason: 'cleanup-unconfirmed'});
  const expired = (yield* readDeadlineRemaining(deadline)) <= 0;
  if (!expired && result._tag === 'Success') return result.success satisfies ContextBriefNativeReadResponse;
  const routing =
    result._tag === 'Failure' && Schema.is(CodeGraphScopeRoutingError)(result.failure) ? result.failure : undefined;
  return {
    protocol: 1 as const,
    binding: contextBriefNativeReadBinding(request),
    commandsJoined: true as const,
    operation: request.operation,
    ok: false as const,
    failure: expired ? ('budget-exhausted' as const) : ('worker-failed' as const),
    ...(routing === undefined
      ? {}
      : {routing: {message: routing.message, ...(routing.projects === undefined ? {} : {projects: routing.projects})}}),
  } satisfies ContextBriefNativeReadResponse;
});

const readRequest = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const state = yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => ({chunks: [] as string[], bytes: 0}),
      (state, chunk) => {
        const bytes = state.bytes + new TextEncoder().encode(chunk).byteLength;
        if (bytes > CONTEXT_BRIEF_NATIVE_READ_INPUT_BYTES)
          return Effect.fail(ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'}));
        state.chunks.push(chunk);
        return Effect.succeed({chunks: state.chunks, bytes});
      },
    ),
  );
  return yield* Schema.decodeEffect(Schema.fromJsonString(contextBriefNativeReadRequestSchema), {
    onExcessProperty: 'error',
  })(EffectArray.join(state.chunks, ''));
});

export const contextBriefNativeReadWorkerProgram = Effect.gen(function* () {
  const request = yield* readRequest;
  const response = yield* serveContextBriefNativeRead(request);
  yield* Schema.decodeEffect(contextBriefNativeReadResponseSchema)(response);
  const bytes = new TextEncoder().encode(`${JSON.stringify(response)}\n`);
  if (bytes.byteLength > CONTEXT_BRIEF_NATIVE_READ_OUTPUT_BYTES)
    return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
  yield* Stream.run(Stream.make(bytes), (yield* Stdio.Stdio).stdout({endOnDone: false}));
}).pipe(Effect.catchCause(() => Effect.fail(ContextBriefNativeReadFailed.make({reason: 'worker-failed'}))));
