import {Effect, FileSystem, Stdio, Stream, Schema} from 'effect';
import {fromPromise} from '@threadnote/platform/errors';
import {SystemInfo} from '@threadnote/platform/system';
import {
  CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS,
  scanCodeGraphGitWorktreeRegistry,
  scanCodeGraphGitWorktreeRegistryBatch,
  scanCodeGraphWorktreeAuthorityWorkerRequest,
  validCodeGraphGitWorktreeRegistryRequest,
  validCodeGraphGitWorktreeRegistryBatchRequest,
  validCodeGraphWorktreeAuthorityWorkerRequest,
} from './registration.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class GitWorktreeRegistrationError extends Schema.TaggedError<
  GitWorktreeRegistrationError,
  {readonly brand: unique symbol}
>()('GitWorktreeRegistrationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const UTF8 = new TextEncoder();

/** One-shot, path-private helper. It always emits one bounded, path-free response. */
export const gitWorktreeRegistrationWorkerProgram = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const response = yield* readBoundedStandardInput(
    stdio,
    CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.authorityWorkerInputBytes,
  ).pipe(
    Effect.flatMap(workerResponse),
    Effect.orElseSucceed(() => ({reason: 'invalid', state: 'unknown'}) as const),
  );
  yield* Stream.run(Stream.make(UTF8.encode(`${JSON.stringify(response)}\n`)), stdio.stdout({endOnDone: false}));
});

const workerResponse = Effect.fn('codeGraph.gitWorktreeRegistrationWorkerResponse')(function* (input: Uint8Array) {
  const decoded = yield* Effect.try({
    try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(input),
    catch: () => GitWorktreeRegistrationError.make({message: 'invalid'}),
  });
  if (
    !Effect2.pipe(decoded, EffectString.endsWith('\n')) ||
    Effect2.pipe(decoded, __effectPipeInput => {
      const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.slice(0, -1));
      const __effectPipeStage1 = Effect2.pipe(__effectPipeStage0, EffectString.includes('\n'));
      return __effectPipeStage1;
    })
  ) {
    return yield* GitWorktreeRegistrationError.make({message: 'invalid'});
  }
  const request = yield* Effect.try({
    try: (): unknown => JSON.parse(Effect2.pipe(decoded, EffectString.slice(0, -1))),
    catch: () => GitWorktreeRegistrationError.make({message: 'invalid'}),
  });
  if (validCodeGraphWorktreeAuthorityWorkerRequest(request)) {
    yield* blockAuthorityLstatForTest();
    return yield* fromPromise('scan worktree authority', () => scanCodeGraphWorktreeAuthorityWorkerRequest(request));
  }
  if (validCodeGraphGitWorktreeRegistryBatchRequest(request)) {
    return yield* fromPromise('scan Git worktree registry', () => scanCodeGraphGitWorktreeRegistryBatch(request));
  }
  if (validCodeGraphGitWorktreeRegistryRequest(request)) {
    return yield* fromPromise('scan Git worktree registration batch', () => scanCodeGraphGitWorktreeRegistry(request));
  }
  return yield* GitWorktreeRegistrationError.make({message: 'invalid'});
});

const readBoundedStandardInput = Effect.fn('codeGraph.readGitWorktreeRegistrationWorkerInput')(function* (
  stdio: Stdio.Stdio,
  limit: number,
) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  yield* stdio.stdin.pipe(
    Stream.runForEach(chunk => {
      total += chunk.byteLength;
      if (total > limit) return Effect.fail(GitWorktreeRegistrationError.make({message: 'invalid'}));
      chunks.push(chunk);
      return Effect.void;
    }),
  );
  const input = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return input;
});

const blockAuthorityLstatForTest = Effect.fn('codeGraph.blockAuthorityLstatForTest')(function* () {
  const system = yield* SystemInfo;
  const environment = system.environment();
  if (environment.THREADNOTE_CODE_GRAPH_TEST_BLOCK_WORKTREE_LSTAT !== '1') return;
  const pidFile = environment.THREADNOTE_CODE_GRAPH_TEST_WORKTREE_LSTAT_PID_FILE;
  if (pidFile) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(pidFile, `${String(system.processId)}\n`, {mode: 0o600});
  }
  return yield* Effect.never;
});
