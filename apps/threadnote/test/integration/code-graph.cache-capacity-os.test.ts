import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  codeGraphFileBlobCapacityBytes,
  codeGraphMaterializedShardCapacityBytes,
} from '@threadnote/graph/cache_capacity';
import {
  codeGraphDiskCapacityReservationProjection,
  codeGraphPersistentCapacityDemand,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '@threadnote/graph/disk/capacity';
import {
  parseCodeGraphDiskReservationReceipt,
  type CodeGraphDiskReservationReceipt,
} from '@threadnote/graph/disk/reservation';
import {CodeGraphStore, materializedFileShardIdentity} from '@threadnote/graph/store';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '@threadnote/graph/types';
import {parseCodeGraphFileFacts} from '@threadnote/graph/fact/validation';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const EXTRACTOR_SET = 'cache-os-extractor-v1';
const DERIVATION_IDENTITY = 'cache-os-derivation-v1';
const FILESYSTEM_KEY = Effect2.pipe('e', EffectString.repeat(64));
const CHILD_COUNT = 8;
type CacheMode = 'facts' | 'shards';
type CacheChildAction = 'concurrent' | 'crash' | 'retry';

interface CacheChildProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly kill: (signal?: NodeJS.Signals | number) => void;
}

interface CacheChildOptions {
  readonly action: CacheChildAction;
  readonly availableBytes: number;
  readonly childId: number;
  readonly committedMarkerPath?: string;
  readonly databasePath: string;
  readonly ledgerLockPath: string;
  readonly ledgerRoot: string;
  readonly mode: CacheMode;
  readonly readyRoot?: string;
  readonly receiptReadyRoot?: string;
  readonly startReleasePath?: string;
  readonly transactionReleasePath?: string;
  readonly writerLockPath: string;
}

describe('code graph cache capacity OS coordination', () => {
  effectIt.effect(
    'holds eight modeled receipts outside the writer gate and converges distinct cache rows',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectory({prefix: 'threadnote-cache-capacity-os-concurrent-'});
          yield* Effect.gen(function* () {
            for (const mode of ['facts', 'shards'] as const) {
              const modeRoot = path.join(root, mode);
              const databasePath = path.join(modeRoot, 'graph.sqlite');
              const ledgerRoot = path.join(modeRoot, 'reservations');
              const ledgerLockPath = path.join(modeRoot, 'reservation.lock');
              const writerLockPath = path.join(modeRoot, 'writer.lock');
              const readyRoot = path.join(modeRoot, 'ready');
              const receiptReadyRoot = path.join(modeRoot, 'receipt-ready');
              const startReleasePath = path.join(modeRoot, 'start.release');
              const transactionReleasePath = path.join(modeRoot, 'transaction.release');
              yield* fs.makeDirectory(readyRoot, {recursive: true});
              yield* fs.makeDirectory(receiptReadyRoot, {recursive: true});
              yield* store.initialize(databasePath);

              const receiptBytes = expectedReceiptBytes(mode, 0);
              const availableBytes = receiptBytes * CHILD_COUNT;
              expect(receiptBytes * CHILD_COUNT).toBeLessThanOrEqual(availableBytes);
              expect(availableBytes).toBeLessThan(receiptBytes * (CHILD_COUNT + 1));

              const options = Array.from({length: CHILD_COUNT}, (_, childId) => ({
                action: 'concurrent' as const,
                availableBytes,
                childId,
                databasePath,
                ledgerLockPath,
                ledgerRoot,
                mode,
                readyRoot,
                receiptReadyRoot,
                startReleasePath,
                transactionReleasePath,
                writerLockPath,
              }));
              yield* Effect.acquireUseRelease(
                Effect.forEach(options, startCacheChild, {concurrency: CHILD_COUNT}),
                children =>
                  Effect.gen(function* () {
                    yield* waitForMarkers(
                      EffectArray.map(options, option => path.join(readyRoot, `${option.childId}.ready`)),
                      'initial',
                    );
                    yield* fs.writeFileString(startReleasePath, 'release', {flag: 'wx', mode: 0o600});
                    yield* waitForMarkers(
                      EffectArray.map(options, option => path.join(receiptReadyRoot, `${option.childId}.receipt`)),
                      'receipt',
                    );

                    const heldReceipts = yield* readCacheReceipts(fs, ledgerRoot);
                    expect(heldReceipts).toHaveLength(CHILD_COUNT);
                    expect(
                      EffectArray.every(heldReceipts, receipt => receipt.operation === operationForMode(mode)),
                    ).toBe(true);
                    expect(EffectArray.every(heldReceipts, receipt => receipt.filesystems.length === 1)).toBe(true);
                    expect(
                      EffectArray.reduce(
                        Array.from(heldReceipts),
                        0,
                        (sum, receipt) => sum + (receipt.filesystems[0]?.bytes ?? 0),
                      ),
                    ).toBe(availableBytes);
                    expect(
                      EffectArray.every(
                        heldReceipts,
                        receipt =>
                          receipt.filesystems[0]?.bytes === receiptBytes &&
                          receipt.filesystems[0]?.key === FILESYSTEM_KEY,
                      ),
                    ).toBe(true);
                    expect(readCacheMapping(databasePath, mode)).toEqual([]);

                    yield* fs.writeFileString(transactionReleasePath, 'release', {flag: 'wx', mode: 0o600});
                    const results = yield* Effect.forEach(children, collectCacheChild, {concurrency: CHILD_COUNT});
                    expect(EffectArray.map(results, result => result.exitCode)).toEqual(Array(CHILD_COUNT).fill(0));
                    expect(EffectArray.every(results, result => result.stderr.length === 0)).toBe(true);
                    expect(readCacheMapping(databasePath, mode)).toEqual(
                      EffectArray.map(options, option => expectedCacheMapping(option.childId)),
                    );
                    expect(yield* readCacheReceipts(fs, ledgerRoot)).toEqual([]);
                  }),
                children => Effect.forEach(children, terminateCacheChild, {discard: true}),
              );
            }
          }).pipe(Effect.ensuring(fs.remove(root, {force: true, recursive: true}).pipe(Effect.ignore)));
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    60_000,
  );

  effectIt.effect(
    'reaps a killed post-commit receipt and idempotently retries both cache modes',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectory({prefix: 'threadnote-cache-capacity-os-crash-'});
          yield* Effect.gen(function* () {
            for (const mode of ['facts', 'shards'] as const) {
              const childId = 900;
              const modeRoot = path.join(root, mode);
              const databasePath = path.join(modeRoot, 'graph.sqlite');
              const ledgerRoot = path.join(modeRoot, 'reservations');
              const ledgerLockPath = path.join(modeRoot, 'reservation.lock');
              const writerLockPath = path.join(modeRoot, 'writer.lock');
              const committedMarkerPath = path.join(modeRoot, 'committed.marker');
              yield* fs.makeDirectory(modeRoot, {recursive: true});
              yield* store.initialize(databasePath);

              const receiptBytes = expectedReceiptBytes(mode, childId);
              const availableBytes = receiptBytes + Math.floor(receiptBytes / 2);
              expect(receiptBytes).toBeLessThanOrEqual(availableBytes);
              expect(availableBytes).toBeLessThan(receiptBytes * 2);
              const common = {
                availableBytes,
                childId,
                databasePath,
                ledgerLockPath,
                ledgerRoot,
                mode,
                writerLockPath,
              } as const;

              yield* Effect.acquireUseRelease(
                startCacheChild({...common, action: 'crash', committedMarkerPath}),
                holder =>
                  Effect.gen(function* () {
                    yield* waitForMarkers([committedMarkerPath], 'commit');
                    expect(holder.exitCode).toBeNull();
                    expect(readCacheMapping(databasePath, mode)).toEqual([expectedCacheMapping(childId)]);
                    const liveReceipts = yield* readCacheReceipts(fs, ledgerRoot);
                    expect(liveReceipts).toHaveLength(1);
                    expect(liveReceipts[0]?.operation).toBe(operationForMode(mode));
                    expect(liveReceipts[0]?.filesystems).toEqual([{bytes: receiptBytes, key: FILESYSTEM_KEY}]);

                    holder.kill('SIGKILL');
                    yield* Effect.promise(() => holder.exited);
                    expect(yield* readCacheReceipts(fs, ledgerRoot)).toHaveLength(1);

                    const successor = yield* runCacheChild({...common, action: 'retry'});
                    expect(successor.exitCode).toBe(0);
                    expect(successor.stderr).toBe('');
                    expect(readCacheMapping(databasePath, mode)).toEqual([expectedCacheMapping(childId)]);
                    expect(yield* readCacheReceipts(fs, ledgerRoot)).toEqual([]);
                  }),
                terminateCacheChild,
              );
            }
          }).pipe(Effect.ensuring(fs.remove(root, {force: true, recursive: true}).pipe(Effect.ignore)));
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    60_000,
  );
});

function startCacheChild(options: CacheChildOptions): Effect.Effect<CacheChildProcess, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return Bun.spawn({
      cmd: [
        process.execPath,
        'run',
        path.join(process.cwd(), 'apps', 'threadnote', 'test', 'helpers', 'code-graph-cache-capacity-child.ts'),
        options.mode,
        options.action,
        options.databasePath,
        options.ledgerRoot,
        options.ledgerLockPath,
        options.writerLockPath,
        String(options.availableBytes),
        FILESYSTEM_KEY,
        String(options.childId),
        options.readyRoot ?? '-',
        options.startReleasePath ?? '-',
        options.receiptReadyRoot ?? '-',
        options.transactionReleasePath ?? '-',
        options.committedMarkerPath ?? '-',
      ],
      stderr: 'pipe',
      stdout: 'pipe',
    });
  });
}

function runCacheChild(options: CacheChildOptions) {
  return Effect.acquireUseRelease(startCacheChild(options), collectCacheChild, terminateCacheChild);
}

function collectCacheChild(child: CacheChildProcess) {
  return Effect.gen(function* () {
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        Effect.promise(() => child.exited),
        readBoundedChildStream(child.stdout, 4_096),
        readBoundedChildStream(child.stderr, 4_096),
      ] as const,
      {concurrency: 3},
    );
    return {exitCode, stderr: Effect2.pipe(stderr, EffectString.trim), stdout: Effect2.pipe(stdout, EffectString.trim)};
  });
}

function terminateCacheChild(child: CacheChildProcess): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (child.exitCode === null) child.kill('SIGKILL');
    yield* Effect.promise(() => child.exited);
  });
}

function waitForMarkers(targets: readonly string[], label: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const deadline = (yield* Clock.currentTimeMillis) + 15_000;
    while (true) {
      const present = yield* Effect.forEach(targets, target => fs.exists(target), {concurrency: CHILD_COUNT});
      if (EffectArray.every(present, Boolean)) return;
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* TestError.make({message: `Cache child missed the ${label} barrier.`});
      yield* Effect.sleep(10);
    }
  });
}

function readCacheReceipts(fs: FileSystem.FileSystem, ledgerRoot: string) {
  return fs.readDirectory(ledgerRoot).pipe(
    Effect.flatMap(entries =>
      Effect.forEach(
        EffectArray.filter(
          entries,
          (name, index) => index in entries && Effect2.pipe(name, EffectString.endsWith('.json')),
        ).sort(),
        name =>
          fs.readFileString(`${ledgerRoot}/${name}`).pipe(
            Effect.flatMap(content => {
              const parsed = parseCodeGraphDiskReservationReceipt(name, content);
              return parsed
                ? Effect.succeed(parsed)
                : Effect.fail(TestError.make({message: 'Cache child emitted an invalid reservation receipt.'}));
            }),
          ),
        {concurrency: CHILD_COUNT},
      ),
    ),
    Effect.catchIf(
      error => !(error instanceof Error && error.message === 'Cache child emitted an invalid reservation receipt.'),
      () => Effect.succeed([] as readonly CodeGraphDiskReservationReceipt[]),
    ),
  );
}

function readBoundedChildStream(stream: ReadableStream<Uint8Array>, maximumBytes: number) {
  return Effect.acquireUseRelease(
    Effect.sync(() => stream.getReader()),
    reader =>
      Effect.tryPromise({
        try: async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          let output = '';
          while (true) {
            const next = await reader.read();
            if (next.done) return output + decoder.decode();
            bytes += next.value.byteLength;
            if (bytes > maximumBytes) throw TestError.make({message: 'Cache child output exceeded its byte bound.'});
            output += decoder.decode(next.value, {stream: true});
          }
        },
        catch: cause => TestError.make({message: 'Could not read bounded cache child output.', cause}),
      }),
    reader => Effect.sync(() => reader.releaseLock()),
  );
}

function expectedReceiptBytes(mode: CacheMode, childId: number): number {
  const boundary = expectedBoundary(mode, childId);
  const demand = codeGraphPersistentCapacityDemand({
    boundary,
    lexicalFormatVersion: 1,
    pageSize: 4_096,
    walAutoCheckpointPages: 1_000,
  });
  const projection = codeGraphDiskCapacityReservationProjection({
    demand,
    durableFilesystemKey: FILESYSTEM_KEY,
    freelistBytes: 0,
    temporaryFilesystemKey: FILESYSTEM_KEY,
  });
  if (projection.state !== 'measured' || projection.filesystems.length !== 1) {
    throw TestError.make({message: 'Cache child capacity projection was not measurable.'});
  }
  return projection.filesystems[0].bytes;
}

function expectedBoundary(mode: CacheMode, childId: number): CodeGraphDirectPersistentCapacityBoundary {
  const file = cacheFile(childId);
  const factsJson = JSON.stringify(emptyFacts(file.path));
  const timestamp = '1970-01-01T00:00:00.000Z';
  return {
    finalFactBytes:
      mode === 'facts'
        ? codeGraphFileBlobCapacityBytes({
            contentHash: file.contentHash,
            createdAt: timestamp,
            extractorSet: EXTRACTOR_SET,
            factsJson,
            path: file.path,
          })
        : codeGraphMaterializedShardCapacityBytes({
            contentHash: file.contentHash,
            createdAt: timestamp,
            derivationIdentity: DERIVATION_IDENTITY,
            extractorSet: EXTRACTOR_SET,
            factsJson,
            id: materializedFileShardIdentity(file.contentHash, EXTRACTOR_SET, DERIVATION_IDENTITY, file.path),
            lastUsedAt: timestamp,
            path: file.path,
          }),
    operation: operationForMode(mode),
    rowCount: 1,
  };
}

function operationForMode(mode: CacheMode) {
  return mode === 'facts'
    ? ('cache code graph file facts' as const)
    : ('cache materialized code graph file shards' as const);
}

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

function expectedCacheMapping(index: number) {
  const facts = emptyFacts(cacheFile(index).path);
  return {facts, pathHint: facts.path};
}

function readCacheMapping(databasePath: string, mode: CacheMode) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  const table = mode === 'facts' ? 'file_blobs' : 'materialized_file_shards';
  try {
    return EffectArray.map(
      database
        .query<
          {
            readonly facts_json: string;
            readonly path_hint: string;
          },
          SQLQueryBindings[]
        >(`SELECT path_hint, facts_json FROM ${table} ORDER BY path_hint`)
        .all(),
      row => ({facts: parseCodeGraphFileFacts(JSON.parse(row.facts_json)), pathHint: row.path_hint}),
    );
  } finally {
    database.close(false);
  }
}
