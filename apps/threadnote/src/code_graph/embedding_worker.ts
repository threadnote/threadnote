import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {CommandExecutor, runDetachedCommandEffect} from '@threadnote/platform/command';
import {makeBackgroundWorkerLifecycle, wakeBackgroundWorker} from '@threadnote/inference/background/worker-control';
import {CodeGraphEmbeddingWorkerProcess} from '@threadnote/graph/runtime_ports';
import {runtimeOpenTextDirectoryNameReader, SystemInfo} from '@threadnote/platform/system';
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
  nonce?: string,
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
      ...(nonce === undefined ? [] : ['--launch-nonce', nonce]),
    ],
  };
}

const graphWorkerControlOptions = Effect.fn('codeGraph.workerControlOptions')(function* (
  home: string,
  version: string,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const command = yield* CommandExecutor;
  return {
    home,
    receiptPath: codeGraphEmbeddingWorkerReceiptPath(path, home),
    lockPath: codeGraphEmbeddingWorkerLockPath(path, home),
    protocol: CODE_GRAPH_EMBEDDING_WORKER_PROTOCOL_VERSION,
    version,
    launch: (nonce: string) => {
      const invocation = codeGraphEmbeddingWorkerInvocation(
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

/** Retains one directory handle; each page advances at most 64 names without home-sized arrays. */
export const codeGraphEmbeddingWorkerProgram = Effect.fn('codeGraph.embeddingWorkerProgram')(function* (
  home: string,
  nonce: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const version = yield* getThreadnoteVersion();
  const canonical = yield* fs.realPath(home);
  const lifecycle = yield* makeBackgroundWorkerLifecycle(yield* graphWorkerControlOptions(canonical, version), nonce);
  let directory: Awaited<ReturnType<typeof runtimeOpenTextDirectoryNameReader>> | undefined;
  let sequence = 0;
  const close = fromPromise('codeGraph.embeddingWorker.closeCatalog', async () => {
    await directory?.close().catch(() => {});
    directory = undefined;
  }).pipe(Effect.ignore);
  return yield* runCodeGraphEmbeddingWorker(canonical, {
    version,
    lifecycle,
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

/** Durable launch/exit metadata only; no foreground wait for worker readiness or model work. */
export const wakeCodeGraphEmbeddingWorker = Effect.fn('codeGraph.wakeEmbeddingWorker')(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const canonical = yield* fs.realPath(home);
  const version = yield* getThreadnoteVersion();
  const result = yield* wakeBackgroundWorker(yield* graphWorkerControlOptions(canonical, version));
  return result.state !== 'deferred';
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
