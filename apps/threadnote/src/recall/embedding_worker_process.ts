import {SecureRandom} from 'effect/crypto';
import {Clock, Effect, Exit, FileSystem, Layer, Path, Schema, type Result} from 'effect';
import {
  inspectBackgroundWorkerControl,
  createBackgroundWorkerFixtureDrain,
  drainBackgroundWorkerFixture,
  BACKGROUND_WORKER_LOCK_STALE_MILLISECONDS,
  makeBackgroundWorkerLifecycle,
  wakeBackgroundWorker,
  type BackgroundWorkerFixtureDrain,
} from '@threadnote/inference/background/worker-control';
import {CommandExecutor, runDetachedCommandEffect} from '@threadnote/platform/command';
import {fromPromise} from '@threadnote/platform/errors';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runtimeOpenTextDirectoryNameReader, SystemInfo} from '@threadnote/platform/system';
import {
  RecallEmbeddingWakePort,
  readRecallEmbeddingScope,
  type RecallEmbeddingScope,
} from '@threadnote/recall/background/demand';
import {
  RecallLexicalDemandUnavailable,
  readRecallLexicalScope,
  RECALL_LEXICAL_DEMAND_DIRECTORY,
} from '@threadnote/recall/background/lexical-demand';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {
  makeRecallEmbeddingWorker,
  runRecallLexicalWorkerUnit,
  RecallEmbeddingWorkerControlUnavailable,
  type RecallEmbeddingWorkerUnitResult,
} from './embedding_worker.js';
import {RECALL_EMBEDDING_WORKER_ARGUMENT, RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION} from '../worker_protocol.js';
import * as EffectString from 'effect/String';

export const recallEmbeddingWorkerPaths = (path: Path.Path, home: string) => ({
  receiptPath: path.join(home, 'locks', 'recall', 'embedding-worker-v1.json'),
  lockPath: path.join(home, 'locks', 'recall', 'embedding-worker.lock'),
});
export function recallEmbeddingWorkerInvocation(
  executable: string,
  entrypoint: string,
  home: string,
  version: string,
  nonce: string,
) {
  const name = EffectString.toLowerCase(
    EffectString.split('/')(EffectString.replaceAll('\\', '/')(executable)).at(-1) ?? '',
  );
  return {
    executable,
    arguments: [
      ...(name === 'bun' || name === 'bun.exe' ? [entrypoint] : []),
      RECALL_EMBEDDING_WORKER_ARGUMENT,
      '--home',
      home,
      '--protocol',
      String(RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION),
      '--version',
      version,
      '--launch-nonce',
      nonce,
    ],
  };
}
const controlOptions = Effect.fn('recall.workerControlOptions')(function* (home: string, version: string) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const command = yield* CommandExecutor;
  return {
    home,
    ...recallEmbeddingWorkerPaths(path, home),
    version,
    protocol: RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION,
    launch: (nonce: string) => {
      const invocation = recallEmbeddingWorkerInvocation(
        system.executablePath,
        system.developmentEntrypoint,
        home,
        version,
        nonce,
      );
      return runDetachedCommandEffect(invocation.executable, invocation.arguments, {
        env: {...system.environment(), THREADNOTE_HOME: home},
      }).pipe(Effect.provideService(CommandExecutor, command));
    },
  };
});
export const wakeRecallEmbeddingWorker = Effect.fn('recall.wakeEmbeddingWorker')(function* (home: string) {
  const canonical = yield* (yield* FileSystem.FileSystem).realPath(home);
  return yield* wakeBackgroundWorker(yield* controlOptions(canonical, yield* getThreadnoteVersion()));
});

export const recallEmbeddingWorkerControlState = Effect.fn('recall.workerControlState')(function* (home: string) {
  const path = yield* Path.Path;
  return yield* inspectBackgroundWorkerControl({
    home,
    ...recallEmbeddingWorkerPaths(path, home),
    version: yield* getThreadnoteVersion(),
    protocol: RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION,
    launch: () => Effect.succeed(false),
  });
});

export type RecallEmbeddingWorkerFixtureDrain = BackgroundWorkerFixtureDrain;
export interface RecallEmbeddingWorkerFixtureRuntime {
  readonly executablePath: string;
  readonly developmentEntrypoint?: string;
  readonly version: string;
}

/** Private fixture setup before any producer; external harnesses pin their candidate runtime explicitly. */
export const createRecallEmbeddingWorkerFixtureDrain = Effect.fn('recall.createWorkerFixtureDrain')(function* (
  home: string,
  fixtureRoot: string,
  expectedRuntime?: RecallEmbeddingWorkerFixtureRuntime,
) {
  const system = yield* SystemInfo;
  const runtime = expectedRuntime ?? {
    executablePath: system.executablePath,
    version: yield* getThreadnoteVersion(),
    ...(/(?:^|[\\/])bun(?:\.exe)?$/iu.test(system.executablePath)
      ? {developmentEntrypoint: system.developmentEntrypoint}
      : {}),
  };
  const canonical = yield* (yield* FileSystem.FileSystem).realPath(home);
  return yield* createBackgroundWorkerFixtureDrain(yield* controlOptions(canonical, runtime.version), {
    fixtureRoot,
    expectedExecutablePath: runtime.executablePath,
    ...(runtime.developmentEntrypoint === undefined ? {} : {expectedEntrypoint: runtime.developmentEntrypoint}),
  });
});

/**
 * UNIX epoch milliseconds from the same Effect Clock.currentTimeMillis as the original fixture lifetime.
 * Capture once before the body/producer shutdown; retries reuse it without extending the caller budget.
 * Never pass Python monotonic seconds or a native-read monotonic bigint deadline directly.
 */
export const drainRecallEmbeddingWorkerFixture = drainBackgroundWorkerFixture;

/** A physical page is at most64 names, including malformed/completed entries. */
const openCatalog = Effect.fn('recall.openEmbeddingCatalog')(function* (
  home: string,
  kind: string = 'embedding-demand-v1',
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = path.join(home, 'recall', kind);
  if (!(yield* fs.exists(root))) return undefined;
  return yield* fromPromise('recall.openEmbeddingCatalog', () =>
    runtimeOpenTextDirectoryNameReader(root, {entryKind: 'file'}),
  );
});

const readCatalogEntry = Effect.fn('recall.readCatalogEntry')(function* (home: string, filename: string, kind: string) {
  if (kind === RECALL_LEXICAL_DEMAND_DIRECTORY) {
    const scope = yield* readRecallLexicalScope(home, filename).pipe(Effect.orElseSucceed(() => undefined));
    return scope ? {kind: 'lexical' as const, scope} : undefined;
  }
  const scope = yield* readRecallEmbeddingScope(home, filename).pipe(Effect.orElseSucceed(() => undefined));
  return scope ? {kind: 'embedding' as const, scope} : undefined;
});

export const recallEmbeddingWorkerHomeProgram = Effect.fn('recall.embeddingWorkerHome')(function* (
  home: string,
  nonce: string,
  options: {
    readonly onUnitResult?: (
      scope: RecallEmbeddingScope,
      result: Result.Result<RecallEmbeddingWorkerUnitResult, unknown>,
    ) => Effect.Effect<void>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const canonical = yield* fs.realPath(home);
  const control = yield* controlOptions(canonical, yield* getThreadnoteVersion());
  const lifecycle = yield* makeBackgroundWorkerLifecycle(control, nonce);
  const identity = yield* system.processStartIdentity(system.processId);
  if (!identity) return;
  const owner = {
    token: yield* (yield* SecureRandom.SecureRandom).uuidV4(),
    processId: system.processId,
    processStartIdentity: identity,
  };
  if (!(yield* lifecycle.register(owner))) return;
  const unit = yield* makeRecallEmbeddingWorker();
  return yield* withExclusiveFileLock(
    fs,
    control.lockPath,
    {
      createParentDirectory: false,
      retryIntervalMilliseconds: 1,
      staleAfterMilliseconds: BACKGROUND_WORKER_LOCK_STALE_MILLISECONDS,
      waitTimeoutMilliseconds: 0,
    },
    Effect.gen(function* () {
      if (!(yield* lifecycle.activate(owner))) return;
      yield* fs.writeFileString(
        control.receiptPath,
        JSON.stringify({...owner, protocol: control.protocol, version: control.version}),
        {mode: 0o600},
      );
      let idleSince = yield* Clock.currentTimeMillis;
      for (;;) {
        if (yield* lifecycle.shouldDrain) return;
        yield* lifecycle.beforeScan;
        let pending = false;
        let progressed = false;
        for (const kind of [RECALL_LEXICAL_DEMAND_DIRECTORY, 'embedding-demand-v1']) {
          yield* Effect.acquireUseRelease(
            openCatalog(canonical, kind),
            directory =>
              Effect.gen(function* () {
                if (!directory) return;
                for (;;) {
                  const page = yield* fromPromise('recall.readEmbeddingCatalogPage', () => directory.readPage(64));
                  for (const filename of page.names) {
                    if (yield* lifecycle.shouldDrain) return;
                    const entry = yield* readCatalogEntry(canonical, filename, kind);
                    if (!entry) continue;
                    const scope = entry.scope;
                    const result = yield* (
                      entry.kind === 'lexical' ? runRecallLexicalWorkerUnit(entry.scope) : unit(entry.scope)
                    ).pipe(Effect.result);
                    yield* options.onUnitResult?.(scope, result) ?? Effect.void;
                    if (result._tag === 'Failure') {
                      // Retry metadata is the sole attempt budget. Stop this process if it cannot be saved.
                      if (
                        Schema.is(RecallEmbeddingWorkerControlUnavailable)(result.failure) ||
                        Schema.is(RecallLexicalDemandUnavailable)(result.failure)
                      )
                        return yield* result.failure;
                      continue; // Unreadable catalog entries stay recorded without executing work.
                    }
                    if (result.success.state === 'deferred' || result.success.state === 'checkpointed') pending = true;
                    if (result.success.state === 'checkpointed') progressed = true;
                  }
                  if (page.done) return;
                }
              }),
            directory =>
              directory
                ? fromPromise('recall.closeEmbeddingCatalog', () => directory.close()).pipe(Effect.ignore)
                : Effect.void,
          );
          if (yield* lifecycle.shouldDrain) return;
        }
        const now = yield* Clock.currentTimeMillis;
        if (pending) idleSince = now;
        if (now - idleSince >= 2000) return;
        yield* Effect.sleep(progressed ? 50 : 1000);
      }
    }),
  ).pipe(
    Effect.onExit(exit => lifecycle.afterRelease(Exit.isSuccess(exit))),
    Effect.catchIf(isFileLockTimeout, () => Effect.void),
  );
});

/** Startup probes only already-recorded demand and never creates work or cold indexes. */
export const resumeExistingRecallEmbeddingDemand = Effect.fn('recall.resumeExistingEmbeddingDemand')(function* (
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(home))) return;
  const canonical = yield* fs.realPath(home);
  for (const kind of [RECALL_LEXICAL_DEMAND_DIRECTORY, 'embedding-demand-v1']) {
    const pending = yield* Effect.acquireUseRelease(
      openCatalog(canonical, kind),
      directory =>
        Effect.gen(function* () {
          if (!directory) return false;
          for (;;) {
            const page = yield* fromPromise('recall.probeEmbeddingCatalogPage', () => directory.readPage(64));
            for (const name of page.names) if (yield* readCatalogEntry(canonical, name, kind)) return true;
            if (page.done) return false;
          }
        }),
      directory =>
        directory
          ? fromPromise('recall.closeEmbeddingCatalog', () => directory.close()).pipe(Effect.ignore)
          : Effect.void,
    );
    if (pending) {
      yield* wakeRecallEmbeddingWorker(canonical);
      return;
    }
  }
});

export const recallEmbeddingWakeLayer = Layer.effect(
  RecallEmbeddingWakePort,
  Effect.gen(function* () {
    const services = yield* Effect.context<Effect.Services<ReturnType<typeof wakeRecallEmbeddingWorker>>>();
    return (home: string) =>
      wakeRecallEmbeddingWorker(home).pipe(Effect.provide(services), Effect.asVoid, Effect.ignore);
  }),
);
