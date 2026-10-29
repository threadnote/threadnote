import {Clock, Effect, FileSystem, Path, Predicate} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runtimeTextDirectoryNamePage} from '@threadnote/platform/system';
import {codeGraphRetainedBaseReservationLockPath, codeGraphRetainedBaseReservationRoot} from './layout.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_GRAPH_RETAINED_BASE_HOME_MAXIMUM = 2;

interface RetainedBaseReservation {
  readonly expiresAt: number;
  readonly physicalSnapshotId: string;
  readonly version: 1;
}

const RECEIPT_NAME = /^v1-([0-9a-f]{64})\.json$/;
const RECEIPT_COUNT_MAXIMUM = 64;
const RECEIPT_BYTES_MAXIMUM = 1_024;

/**
 * Reserves one of the two home-global retained-base entries until the durable
 * SQL lease expires. The physical id deduplicates an alias and its base; this
 * ledger is deliberately separate from the live builder slots.
 */
export const reserveCodeGraphRetainedBase = Effect.fn('codeGraph.retainedBase.reserve')(function* (options: {
  readonly durationMilliseconds: number;
  readonly physicalSnapshotId: string;
  readonly threadnoteHome: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = codeGraphRetainedBaseReservationRoot(path, options.threadnoteHome);
  const lockPath = codeGraphRetainedBaseReservationLockPath(path, options.threadnoteHome);
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  return yield* withExclusiveFileLock(
    fs,
    lockPath,
    {
      heartbeatIntervalMilliseconds: 5_000,
      recoverReusedProcessIdImmediately: true,
      retryIntervalMilliseconds: 10,
      staleAfterMilliseconds: 15_000,
      useCanonicalProcessStartIdentity: true,
      waitTimeoutMilliseconds: 5_000,
    },
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const page = yield* runtimeTextDirectoryNamePage(root, RECEIPT_COUNT_MAXIMUM);
      if (page.overflow) return false;
      const active = new Map<string, {readonly path: string; readonly receipt: RetainedBaseReservation}>();
      for (const name of page.names) {
        const digest = RECEIPT_NAME.exec(name)?.[1];
        if (!digest) return false;
        const receiptPath = path.join(root, name);
        if ((yield* fs.readLink(receiptPath).pipe(Effect.option))._tag === 'Some') return false;
        const info = yield* fs.stat(receiptPath);
        if (info.type !== 'File' || Number(info.size) > RECEIPT_BYTES_MAXIMUM) return false;
        const receipt = parseReceipt(yield* fs.readFileString(receiptPath));
        if (!receipt || sha256HexSync(receipt.physicalSnapshotId) !== digest) return false;
        if (receipt.expiresAt <= now) {
          yield* fs.remove(receiptPath, {force: true});
          continue;
        }
        active.set(receipt.physicalSnapshotId, {path: receiptPath, receipt});
      }
      const existing = active.get(options.physicalSnapshotId);
      if (!existing && active.size >= CODE_GRAPH_RETAINED_BASE_HOME_MAXIMUM) return false;
      const expiresAt = now + Math.max(1, Math.floor(options.durationMilliseconds));
      if (existing && existing.receipt.expiresAt >= expiresAt) return true;
      const receiptPath = path.join(root, `v1-${sha256HexSync(options.physicalSnapshotId)}.json`);
      const temporaryPath = `${receiptPath}.${Effect2.pipe(sha256HexSync(`${now}\0${expiresAt}`), EffectString.slice(0, 16))}.tmp`;
      const serialized = JSON.stringify({expiresAt, physicalSnapshotId: options.physicalSnapshotId, version: 1});
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temporaryPath, {flag: 'wx', mode: 0o600});
          yield* file.writeAll(new TextEncoder().encode(serialized));
          yield* file.sync;
        }),
      ).pipe(
        Effect.andThen(fs.rename(temporaryPath, receiptPath)),
        Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)),
      );
      return true;
    }),
  );
});

function parseReceipt(serialized: string): RetainedBaseReservation | undefined {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Predicate.isObject(value)) return undefined;
    if (
      value.version !== 1 ||
      typeof value.physicalSnapshotId !== 'string' ||
      value.physicalSnapshotId.length < 1 ||
      value.physicalSnapshotId.length > 128 ||
      typeof value.expiresAt !== 'number' ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= 0
    ) {
      return undefined;
    }
    return {expiresAt: value.expiresAt, physicalSnapshotId: value.physicalSnapshotId, version: 1};
  } catch {
    return undefined;
  }
}
