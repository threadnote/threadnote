import {Array as EffectArray} from 'effect';
import {Clock, Effect, FileSystem, Layer, Option, Path, Schema} from 'effect';
import {runDetachedCommandEffect} from '@threadnote/platform/command';
import {CodeGraphEmbeddingWorkerProcess} from '@threadnote/graph/runtime_ports';
import {runtimeOpenTextDirectoryNameReader, SystemInfo} from '@threadnote/platform/system';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {fromPromise} from '@threadnote/platform/errors';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {
  codeGraphRepositoriesRoot,
  codeGraphEmbeddingWorkerReceiptPath,
  codeGraphEmbeddingWorkerLockPath,
} from '@threadnote/graph/layout';
import {runCodeGraphEmbeddingWorker} from '@threadnote/graph/vector/worker';
import {
  CODE_GRAPH_EMBEDDING_WORKER_ARGUMENT,
  CODE_GRAPH_EMBEDDING_WORKER_PROTOCOL_VERSION,
} from '../worker_protocol.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class CodeGraphEmbeddingWorkerProcessError extends Schema.TaggedError<
  CodeGraphEmbeddingWorkerProcessError,
  {readonly brand: unique symbol}
>()('CodeGraphEmbeddingWorkerProcessError', {message: Schema.String}) {}

export function codeGraphEmbeddingWorkerInvocation(
  executablePath: string,
  developmentEntrypoint: string,
  home: string,
  version: string,
) {
  const executableName = Effect2.pipe(
    Effect2.pipe(executablePath, EffectString.replaceAll('\\', '/'), EffectString.split('/')).at(-1),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
  );
  return {
    executable: executablePath,
    arguments: [
      ...(executableName === 'bun' || executableName === 'bun.exe' ? [developmentEntrypoint] : []),
      CODE_GRAPH_EMBEDDING_WORKER_ARGUMENT,
      '--home',
      home,
      '--protocol',
      String(CODE_GRAPH_EMBEDDING_WORKER_PROTOCOL_VERSION),
      '--version',
      version,
    ],
  };
}

/** Retains one directory handle; each page advances at most 64 names without home-sized arrays. */
export const codeGraphEmbeddingWorkerProgram = Effect.fn('codeGraph.embeddingWorkerProgram')(function* (home: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const version = yield* getThreadnoteVersion();
  const canonical = yield* fs.realPath(home);
  let directory: Awaited<ReturnType<typeof runtimeOpenTextDirectoryNameReader>> | undefined;
  let sequence = 0;
  const close = fromPromise('codeGraph.embeddingWorker.closeCatalog', async () => {
    await directory?.close().catch(() => {});
    directory = undefined;
  }).pipe(Effect.ignore);
  return yield* runCodeGraphEmbeddingWorker(canonical, {
    version,
    catalogPage: after =>
      fromPromise('codeGraph.embeddingWorker.readCatalogPage', async () => {
        if (after === undefined) {
          await directory?.close().catch(() => {});
          directory = await runtimeOpenTextDirectoryNameReader(codeGraphRepositoriesRoot(path, canonical)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return undefined;
              throw error;
            },
          );
        }
        if (!directory) return {checkoutIds: []};
        const page = await directory.readPage(64);
        const names = page.names;
        const checkoutIds = EffectArray.filter(
          names,
          (name, __effectArrayIndex) => __effectArrayIndex in names && /^[a-f0-9]{64}$/.test(name),
        );
        if (page.done) {
          directory = undefined;
          return {checkoutIds};
        }
        return {checkoutIds, after: String(++sequence)};
      }).pipe(
        Effect.mapError(() =>
          CodeGraphEmbeddingWorkerProcessError.make({message: 'Embedding worker process operation failed.'}),
        ),
      ),
  }).pipe(Effect.ensuring(close));
});

/** Wakes recorded demand only. Worker itself never creates queue rows. */
export const wakeCodeGraphEmbeddingWorker = Effect.fn('codeGraph.wakeEmbeddingWorker')(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const canonical = yield* fs.realPath(home);
  const version = yield* getThreadnoteVersion();
  const receipt = codeGraphEmbeddingWorkerReceiptPath(path, canonical);
  const observe = Effect.gen(function* () {
    if (!(yield* fs.exists(receipt))) return false;
    if (Option.isSome(yield* fs.readLink(receipt).pipe(Effect.option))) return false;
    if ((yield* fs.stat(receipt)).size > 4096) return false;
    const content = yield* fs.readFileString(receipt);
    const ReceiptSchema = Schema.Struct({
      processId: Schema.optionalKey(Schema.Int),
      processStartIdentity: Schema.optionalKey(Schema.String),
      protocol: Schema.optionalKey(Schema.Int),
      version: Schema.optionalKey(Schema.String),
    });
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(content),
      catch: () => CodeGraphEmbeddingWorkerProcessError.make({message: 'Embedding worker process operation failed.'}),
    });
    if (
      !Schema.is(ReceiptSchema)(parsed) ||
      typeof parsed.processId !== 'number' ||
      typeof parsed.processStartIdentity !== 'string'
    )
      return false;
    return (
      parsed.protocol === CODE_GRAPH_EMBEDDING_WORKER_PROTOCOL_VERSION &&
      parsed.version === version &&
      system.isProcessRunning(parsed.processId) &&
      (yield* system.processStartIdentity(parsed.processId)) === parsed.processStartIdentity
    );
  }).pipe(Effect.orElseSucceed(() => false));
  return yield* withExclusiveFileLock(
    fs,
    `${codeGraphEmbeddingWorkerLockPath(path, canonical)}.spawn`,
    {
      retryIntervalMilliseconds: 10,
      staleAfterMilliseconds: 120_000,
      waitTimeoutMilliseconds: 3000,
    },
    Effect.gen(function* () {
      if (yield* observe) return true;
      const invocation = codeGraphEmbeddingWorkerInvocation(
        system.executablePath,
        system.developmentEntrypoint,
        canonical,
        version,
      );
      const started = yield* runDetachedCommandEffect(invocation.executable, invocation.arguments, {
        env: {...system.environment(), THREADNOTE_HOME: canonical},
      });
      if (!started) return false;
      const deadline = (yield* Clock.currentTimeMillis) + 3000;
      do {
        if (yield* observe) return true;
        yield* Effect.sleep('50 millis');
      } while ((yield* Clock.currentTimeMillis) < deadline);
      return false;
    }),
  );
});

export const codeGraphEmbeddingWorkerProcessLayer = Layer.effect(
  CodeGraphEmbeddingWorkerProcess,
  Effect.gen(function* () {
    const services = yield* Effect.context<Effect.Services<ReturnType<typeof wakeCodeGraphEmbeddingWorker>>>();
    return CodeGraphEmbeddingWorkerProcess.of({
      wake: home => wakeCodeGraphEmbeddingWorker(home).pipe(Effect.provide(services)),
    });
  }),
);
