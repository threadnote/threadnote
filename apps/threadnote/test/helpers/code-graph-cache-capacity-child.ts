import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from './system-layer.js';
import {provideTestLayer} from './effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Crypto, Effect, FileSystem, Layer, Path} from 'effect';
import {codeGraphPersistentCapacityDemand} from '@threadnote/graph/disk/capacity';
import {withCodeGraphDiskReservation} from '@threadnote/graph/disk/reservation';
import {CodeGraphStore, type CodeGraphDirectPersistentCapacityProtector} from '@threadnote/graph/store';
import {
  CodeGraphStoreError,
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  isCodeGraphStoreError,
} from '@threadnote/graph/types';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const EXTRACTOR_SET = 'cache-os-extractor-v1';
const DERIVATION_IDENTITY = 'cache-os-derivation-v1';

const [
  mode,
  action,
  databasePath,
  ledgerRoot,
  ledgerLockPath,
  writerLockPath,
  availableText,
  filesystemKey,
  childIdText,
  readyRoot = '-',
  startReleasePath = '-',
  receiptReadyRoot = '-',
  transactionReleasePath = '-',
  committedMarkerPath = '-',
] = process.argv.slice(2);

const validPath = (value: string | undefined) =>
  value !== undefined && value.length > 0 && !Effect2.pipe(value, EffectString.includes('\0'));
if (
  (mode !== 'facts' && mode !== 'shards') ||
  (action !== 'concurrent' && action !== 'crash' && action !== 'retry') ||
  !validPath(databasePath) ||
  !validPath(ledgerRoot) ||
  !validPath(ledgerLockPath) ||
  !validPath(writerLockPath) ||
  !/^[1-9][0-9]*$/u.test(availableText ?? '') ||
  !/^[0-9a-f]{64}$/u.test(filesystemKey ?? '') ||
  !/^[0-9]+$/u.test(childIdText ?? '') ||
  (action === 'concurrent' &&
    (!EffectArray.every(
      [readyRoot, startReleasePath, receiptReadyRoot, transactionReleasePath],
      value => value !== '-' && validPath(value),
    ) ||
      committedMarkerPath !== '-')) ||
  (action === 'crash' && (!validPath(committedMarkerPath) || committedMarkerPath === '-')) ||
  (action === 'retry' && committedMarkerPath !== '-')
) {
  process.stderr.write('invalid cache-capacity child arguments\n');
  process.exit(2);
}

const childId = Number(childIdText);
const availableBytes = Number(availableText);
const file = cacheFile(childId);
const facts = emptyFacts(file.path);
const platformLayer = Layer.merge(BunServices.layer, TestSystemInfoLayer);
const childLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(platformLayer));

const waitForPath = (target: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    while (!(yield* fs.exists(target))) yield* Effect.sleep(5);
  });

const writeMarker = (target: string, value: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(target, value, {flag: 'wx', mode: 0o600});
  });

const program = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const store = yield* CodeGraphStore;
  if (action === 'concurrent') {
    yield* writeMarker(path.join(readyRoot, `${childId}.ready`), 'ready');
    yield* waitForPath(startReleasePath);
  }

  const protector: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) =>
    withCodeGraphDiskReservation(
      {
        boundary,
        ledgerLockPath,
        ledgerRoot,
        maintenance: Effect.void,
        observe: Effect.succeed({
          demand: codeGraphPersistentCapacityDemand({
            boundary,
            lexicalFormatVersion: 1,
            pageSize: 4_096,
            walAutoCheckpointPages: 1_000,
          }),
          durableAvailableBytes: availableBytes,
          durableFilesystemKey: filesystemKey,
          freelistBytes: 0,
          temporaryAvailableBytes: availableBytes,
          temporaryFilesystemKey: filesystemKey,
        }),
      },
      action === 'concurrent'
        ? Effect.gen(function* () {
            yield* writeMarker(path.join(receiptReadyRoot, `${childId}.receipt`), 'receipt');
            yield* waitForPath(transactionReleasePath);
            return yield* transaction;
          })
        : action === 'crash'
          ? Effect.gen(function* () {
              yield* transaction;
              yield* writeMarker(committedMarkerPath, 'committed');
              process.stdout.write(`${JSON.stringify({event: 'committed', processId: process.pid})}\n`);
              // A pending Effect alone does not retain a Bun process. Keep one
              // bounded live timer handle until the parent exercises SIGKILL.
              for (;;) yield* Effect.sleep(60_000);
            })
          : transaction,
    ).pipe(
      Effect.mapError(cause =>
        isCodeGraphStoreError(cause) ? cause : CodeGraphStoreError.of('Cache child reservation coordination failed.'),
      ),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SystemInfo, system),
    );

  const cache =
    mode === 'facts'
      ? store.cacheFacts(databasePath, [file], [facts], EXTRACTOR_SET, protector)
      : store.cacheMaterializedFileShards(databasePath, [file], [facts], EXTRACTOR_SET, DERIVATION_IDENTITY, protector);
  yield* store.withSession(databasePath, cache, {writerLockPath});
  process.stdout.write(`${JSON.stringify({event: 'complete', processId: process.pid})}\n`);
}).pipe(provideTestLayer(childLayer));

Effect.runPromise(program).catch(cause => {
  process.stderr.write(`cache-capacity child failed: ${cause instanceof Error ? cause.name : 'unknown'}\n`);
  process.exitCode = 1;
});

function cacheFile(index: number): CodeGraphInventoryFile {
  const suffix = Effect2.pipe(index.toString(), EffectString.padStart(6, '0'));
  return {
    blobId: Effect2.pipe((index + 1).toString(16), EffectString.padStart(40, '0')),
    contentHash: Effect2.pipe((index + 1).toString(16), EffectString.padStart(64, '0')),
    language: 'typescript',
    mode: '100644',
    path: `src/os-child/file-${suffix}.ts`,
    size: 1,
    source: 'commit',
  };
}

function emptyFacts(path: string): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, symbols: []};
}
